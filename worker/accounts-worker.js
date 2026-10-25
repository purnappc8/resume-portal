/**
 * TechTalent Portal — recruiter accounts (Cloudflare Worker + D1 + Brevo email)
 *
 * Rules
 *  • An organization registers with its GROUP email (e.g. hiring@acme.com) on its own
 *    company domain — free mail providers are refused. Nothing works until someone
 *    confirms from that group mailbox.
 *  • Each organization has a seat limit (default 5): active + pending recruiters.
 *  • Every recruiter has their own username + password; their account email is the
 *    organization's group email.
 *  • A new recruiter's request is emailed ONLY to the group email, with Approve /
 *    Decline. They can't sign in until approved.
 *  • Passwords: PBKDF2-SHA256 (100k), per-user salt. 5 wrong passwords → 15 min lock.
 *  • Links in emails open a confirmation page; the action happens on the button
 *    press (POST), so mail scanners that pre-open links can't approve anyone.
 *
 * Bindings / secrets (Cloudflare → Worker → Settings):
 *   DB              D1 database (run accounts-schema.sql once)
 *   BREVO_API_KEY   Brevo transactional email key (secret)
 *   MAIL_FROM       sender address verified in Brevo (variable)
 *   MAIL_FROM_NAME  optional, default "TechTalent Portal"
 *   SITE_URL        optional, default https://purnappc8.github.io/resume-portal/
 *   SEAT_LIMIT      optional default seats per organization (5)
 *
 * Candidates: profiles are stored here with the email kept PRIVATE. A profile is
 * published only after the candidate confirms by email. Messages from signed-in
 * recruiters are emailed to that candidate only (reply-to = the recruiter's group
 * email) and appear in the candidate's inbox (email sign-in link, no password).
 */

const ALLOWED_ORIGINS = ['https://purnappc8.github.io', 'http://localhost:8812', 'http://127.0.0.1:8812'];
const FREE_MAIL = new Set(['gmail.com','googlemail.com','yahoo.com','yahoo.co.in','yahoo.co.uk','ymail.com','rocketmail.com','hotmail.com','hotmail.co.uk','outlook.com','outlook.in','live.com','live.in','msn.com','aol.com','icloud.com','me.com','mac.com','proton.me','protonmail.com','pm.me','gmx.com','gmx.de','gmx.net','web.de','mail.com','zoho.com','zohomail.in','yandex.com','yandex.ru','rediffmail.com','tutanota.com','tuta.io','hey.com','fastmail.com','qq.com','163.com','126.com','sina.com','naver.com','duck.com','mailinator.com','tempmail.com','10minutemail.com','guerrillamail.com']);
const DAY = 864e5;
const SESSION_DAYS = 7, LINK_DAYS = 7, MAX_FAILS = 5, LOCK_MIN = 15;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Vary': 'Origin'
    };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const site = (env.SITE_URL || 'https://purnappc8.github.io/resume-portal/').replace(/\/?$/, '/');
    try {
      const p = url.pathname, m = request.method;
      if (p === '/health') return json({ ok: true, database: !!env.DB, email: !!(env.BREVO_API_KEY && env.MAIL_FROM) }, 200, cors);
      if (!env.DB) return json({ error: 'Accounts are not set up yet.' }, 503, cors);

      // Pages opened from email links (confirmation step, then POST)
      if (m === 'GET' && ['/org/verify', '/approve', '/decline'].includes(p)) return confirmPage(p, url.searchParams.get('t') || '', env);
      if (m === 'POST' && ['/org/verify', '/approve', '/decline'].includes(p)) {
        const form = await request.formData().catch(() => null);
        const t = form ? String(form.get('t') || '') : '';
        const status = p === '/org/verify' ? await verifyOrg(t, env, url) : await decide(t, p === '/approve', env, url);
        return Response.redirect(`${site}recruiter.html?status=${encodeURIComponent(status)}`, 303);
      }

      if (m === 'POST' && p === '/org/register') return json(await registerOrg(await body(request), env, url), 200, cors);

      // ── Candidates ──
      if (m === 'GET' && ['/candidate/confirm', '/candidate/signin'].includes(p)) return candidatePage(p, url.searchParams.get('t') || '', env);
      if (m === 'POST' && p === '/candidate/confirm') {
        const form = await request.formData().catch(() => null);
        const status = await confirmCandidate(form ? String(form.get('t') || '') : '', env);
        return Response.redirect(`${site}submit.html?status=${encodeURIComponent(status)}`, 303);
      }
      if (m === 'POST' && p === '/candidate/signin') {
        const form = await request.formData().catch(() => null);
        const r = await candidateSignin(form ? String(form.get('t') || '') : '', env);
        // Session token travels in the URL fragment (#), which browsers never send to servers or logs
        return Response.redirect(r ? `${site}inbox.html#ctok=${r.token}&cexp=${encodeURIComponent(r.expiresAt)}` : `${site}login.html?status=link-invalid#candidate`, 303);
      }
      if (m === 'POST' && p === '/candidates') return json(await submitCandidate(await body(request, 12000), env, url), 200, cors);
      if (m === 'GET' && p === '/candidates') return json(await listCandidates(env), 200, cors);   // no caching: hiding/deleting a profile takes effect at once
      if (m === 'GET' && /^\/candidates\/cand_[a-f0-9]{24}$/.test(p)) return json(await oneCandidate(p.split('/')[2], env), 200, cors);
      if (m === 'POST' && p === '/candidate/login') return json(await candidateLoginLink(await body(request), env, url), 200, cors);
      if (m === 'GET' && p === '/candidate/messages') return json(await candidateMessages(request, env), 200, cors);
      if (m === 'POST' && p === '/candidate/messages/read') return json(await candidateMarkRead(request, await body(request), env), 200, cors);
      if (m === 'POST' && p === '/candidate/visibility') return json(await candidateVisibility(request, await body(request), env), 200, cors);
      if (m === 'POST' && p === '/candidate/delete') return json(await candidateDelete(request, env), 200, cors);
      if (m === 'POST' && p === '/candidate/logout') return json(await candidateLogout(request, env), 200, cors);
      // ── Recruiter → candidate messages ──
      if (m === 'POST' && p === '/messages') return json(await sendCandidateMessage(request, await body(request, 8000), env, site), 200, cors);
      if (m === 'POST' && p === '/join') return json(await join(await body(request), env, url), 200, cors);
      if (m === 'POST' && p === '/login') return json(await login(await body(request), env), 200, cors);
      if (m === 'GET' && p === '/me') return json(await me(request, env), 200, cors);
      if (m === 'POST' && p === '/logout') return json(await logout(request, env), 200, cors);
      return json({ error: 'Not found' }, 404, cors);
    } catch (e) {
      if (e && e.userError) return json({ error: e.message, code: e.code }, e.status || 400, cors);
      console.error(e);
      return json({ error: 'Something went wrong. Please try again.' }, 500, cors);
    }
  }
};

// ── Flows ───────────────────────────────────────────────────────────────────
async function registerOrg(b, env, url) {
  const orgName = text(b.orgName, 2, 80, 'Organization name');
  const groupEmail = groupMail(b.groupEmail);
  const domain = groupEmail.split('@')[1];
  const username = uname(b.username), name = text(b.name, 2, 60, 'Your name'), password = pass(b.password);
  if (await env.DB.prepare('SELECT 1 FROM orgs WHERE group_email = ?').bind(groupEmail).first())
    fail('This group email is already registered. Ask your team to approve you with "Join your organization".', 'org_exists', 409);
  if (await env.DB.prepare('SELECT 1 FROM recruiters WHERE username = ?').bind(username).first()) fail('That username is taken. Please choose another.', 'username_taken', 409);

  const orgId = id('org'), recId = id('rec'), now = iso();
  const { hash, salt } = await hashPassword(password);
  await env.DB.batch([
    env.DB.prepare('INSERT INTO orgs (id,name,domain,group_email,seat_limit,created_at) VALUES (?,?,?,?,?,?)').bind(orgId, orgName, domain, groupEmail, seatLimit(env), now),
    env.DB.prepare('INSERT INTO recruiters (id,org_id,username,display_name,pass_hash,pass_salt,status,created_at) VALUES (?,?,?,?,?,?,?,?)').bind(recId, orgId, username, name, hash, salt, 'pending', now)
  ]);
  const t = await newToken(env, 'org_verify', orgId, LINK_DAYS);
  const link = `${url.origin}/org/verify?t=${t}`;
  const undo = () => env.DB.batch([
    env.DB.prepare('DELETE FROM tokens WHERE ref_id = ?').bind(orgId),
    env.DB.prepare('DELETE FROM recruiters WHERE org_id = ?').bind(orgId),
    env.DB.prepare('DELETE FROM orgs WHERE id = ?').bind(orgId)
  ]);
  await sendMail(env, groupEmail, `Confirm ${orgName} on TechTalent Portal`,
    `<p>Hello,</p><p><b>${h(name)}</b> (username <b>${h(username)}</b>) registered <b>${h(orgName)}</b> on TechTalent Portal using this group mailbox.</p>
     <p>If that's right, confirm the organization. ${h(name)} becomes its first recruiter.</p>
     <p>${button(link, 'Confirm organization')}</p>
     <p style="color:#555;font-size:13px">Your organization can have up to ${seatLimit(env)} recruiters. Every new recruiter must be approved from this mailbox.<br>If you didn't expect this, ignore this email — nothing is activated without confirmation. The link expires in ${LINK_DAYS} days.</p>`).catch(async e => { await undo(); throw e; });
  return { ok: true, message: `Almost done — we emailed ${groupEmail}. Someone with access to that mailbox must click "Confirm organization" before you can sign in.` };
}

async function verifyOrg(t, env) {
  const tok = await useToken(env, t, 'org_verify');
  if (!tok) return 'link-invalid';
  const org = await env.DB.prepare('SELECT * FROM orgs WHERE id = ?').bind(tok.ref_id).first();
  if (!org) return 'link-invalid';
  const now = iso();
  await env.DB.batch([
    env.DB.prepare('UPDATE orgs SET verified_at = COALESCE(verified_at, ?) WHERE id = ?').bind(now, org.id),
    env.DB.prepare("UPDATE recruiters SET status = 'active', approved_at = ? WHERE org_id = ? AND status = 'pending' AND created_at = (SELECT MIN(created_at) FROM recruiters WHERE org_id = ?)").bind(now, org.id, org.id)
  ]);
  return 'org-verified';
}

async function join(b, env, url) {
  const groupEmail = groupMail(b.groupEmail);
  const username = uname(b.username), name = text(b.name, 2, 60, 'Your name'), password = pass(b.password);
  const org = await env.DB.prepare('SELECT * FROM orgs WHERE group_email = ?').bind(groupEmail).first();
  if (!org) fail('No organization is registered with that group email yet. Use "Register organization" instead.', 'org_not_found', 404);
  if (!org.verified_at) fail('This organization hasn\'t been confirmed yet. Check the group mailbox for the confirmation email.', 'org_unverified', 409);
  if (await env.DB.prepare('SELECT 1 FROM recruiters WHERE username = ?').bind(username).first()) fail('That username is taken. Please choose another.', 'username_taken', 409);
  const used = await seatsUsed(env, org.id, true);
  if (used >= org.seat_limit) fail(`${org.name} has reached its limit of ${org.seat_limit} recruiters. Ask your team to free a seat first.`, 'seats_full', 409);

  const recId = id('rec'), { hash, salt } = await hashPassword(password);
  await env.DB.prepare('INSERT INTO recruiters (id,org_id,username,display_name,pass_hash,pass_salt,status,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .bind(recId, org.id, username, name, hash, salt, 'pending', iso()).run();
  const ta = await newToken(env, 'approve', recId, LINK_DAYS), td = await newToken(env, 'decline', recId, LINK_DAYS);
  const undo = () => env.DB.batch([env.DB.prepare('DELETE FROM tokens WHERE ref_id = ?').bind(recId), env.DB.prepare('DELETE FROM recruiters WHERE id = ?').bind(recId)]);
  await sendMail(env, org.group_email, `Approve ${name} as a recruiter for ${org.name}?`,
    `<p>Hello,</p><p><b>${h(name)}</b> wants to join <b>${h(org.name)}</b> on TechTalent Portal as a recruiter (username <b>${h(username)}</b>).</p>
     <p>Seats in use: ${used + 1} of ${org.seat_limit} (including this request).</p>
     <p>${button(`${url.origin}/approve?t=${ta}`, 'Approve')} &nbsp; ${button(`${url.origin}/decline?t=${td}`, 'Decline', '#6b7280')}</p>
     <p style="color:#555;font-size:13px">Only approve people you know. They'll contact candidates on behalf of your organization. Links expire in ${LINK_DAYS} days.</p>`).catch(async e => { await undo(); throw e; });
  return { ok: true, message: `Request sent. We emailed ${org.group_email} for approval — you can sign in once someone approves you.` };
}

async function decide(t, approve, env) {
  const tok = await useToken(env, t, approve ? 'approve' : 'decline');
  if (!tok) return 'link-invalid';
  const rec = await env.DB.prepare('SELECT r.*, o.seat_limit, o.name AS org_name, o.group_email FROM recruiters r JOIN orgs o ON o.id = r.org_id WHERE r.id = ?').bind(tok.ref_id).first();
  if (!rec || rec.status !== 'pending') return 'already-decided';
  // The other link of the pair can't be used any more
  await env.DB.prepare("UPDATE tokens SET used_at = ? WHERE ref_id = ? AND kind IN ('approve','decline') AND used_at IS NULL").bind(iso(), rec.id).run();
  if (!approve) {
    await env.DB.prepare("UPDATE recruiters SET status = 'declined' WHERE id = ?").bind(rec.id).run();
    return 'declined';
  }
  if (await seatsUsed(env, rec.org_id, false) >= rec.seat_limit) {
    await env.DB.prepare("UPDATE recruiters SET status = 'declined' WHERE id = ?").bind(rec.id).run();
    return 'seats-full';
  }
  await env.DB.prepare("UPDATE recruiters SET status = 'active', approved_at = ? WHERE id = ?").bind(iso(), rec.id).run();
  return 'approved';
}

async function login(b, env) {
  const username = String(b.username || '').trim().toLowerCase();
  const password = String(b.password || '');
  const bad = () => fail('Wrong username or password.', 'bad_login', 401);
  if (!username || !password || password.length > 200) bad();
  const rec = await env.DB.prepare('SELECT r.*, o.name AS org_name, o.group_email, o.seat_limit, o.verified_at FROM recruiters r JOIN orgs o ON o.id = r.org_id WHERE r.username = ?').bind(username).first();
  if (!rec) { await hashPassword(password); bad(); }   // same work either way (no username probing by timing)
  if (rec.locked_until && Date.parse(rec.locked_until) > Date.now())
    fail(`Too many wrong passwords. Try again in ${Math.max(1, Math.ceil((Date.parse(rec.locked_until) - Date.now()) / 6e4))} minute(s).`, 'locked', 429);
  const ok = await checkPassword(password, rec.pass_hash, rec.pass_salt);
  if (!ok) {
    const fails = (rec.failed_logins || 0) + 1;
    const lock = fails >= MAX_FAILS ? new Date(Date.now() + LOCK_MIN * 6e4).toISOString() : null;
    await env.DB.prepare('UPDATE recruiters SET failed_logins = ?, locked_until = ? WHERE id = ?').bind(lock ? 0 : fails, lock, rec.id).run();
    bad();
  }
  if (rec.status === 'pending') fail(rec.verified_at ? 'Your request is waiting for approval from your organization\'s group mailbox.' : 'Your organization isn\'t confirmed yet. Check the group mailbox for the confirmation email.', 'pending', 403);
  if (rec.status !== 'active') fail('This account isn\'t active. Ask your organization to approve a new request.', 'inactive', 403);
  await env.DB.prepare('UPDATE recruiters SET failed_logins = 0, locked_until = NULL WHERE id = ?').bind(rec.id).run();
  const token = await newToken(env, 'session', rec.id, SESSION_DAYS);
  return { ok: true, token, expiresAt: new Date(Date.now() + SESSION_DAYS * DAY).toISOString(), ...(await profile(env, rec)) };
}

async function me(request, env) {
  const rec = await sessionUser(request, env);
  return { ok: true, ...(await profile(env, rec, true)) };
}
async function logout(request, env) {
  const t = bearer(request);
  if (t) await env.DB.prepare("UPDATE tokens SET used_at = ? WHERE token_hash = ? AND kind = 'session'").bind(iso(), await sha256(t)).run();
  return { ok: true };
}
async function profile(env, rec, withTeam) {
  const out = {
    recruiter: { username: rec.username, name: rec.display_name, role: 'recruiter' },
    org: { name: rec.org_name, groupEmail: rec.group_email, seatLimit: rec.seat_limit, seatsUsed: await seatsUsed(env, rec.org_id, true) }
  };
  if (withTeam) {
    const r = await env.DB.prepare("SELECT username, display_name, status, approved_at, created_at FROM recruiters WHERE org_id = ? AND status IN ('active','pending') ORDER BY created_at").bind(rec.org_id).all();
    out.team = (r.results || []).map(x => ({ username: x.username, name: x.display_name, status: x.status, since: x.approved_at || x.created_at }));
  }
  return out;
}
async function sessionUser(request, env) {
  const t = bearer(request);
  if (!t) fail('Please sign in.', 'no_session', 401);
  const row = await env.DB.prepare("SELECT r.*, o.name AS org_name, o.group_email, o.seat_limit FROM tokens t JOIN recruiters r ON r.id = t.ref_id JOIN orgs o ON o.id = r.org_id WHERE t.token_hash = ? AND t.kind = 'session' AND t.used_at IS NULL AND t.expires_at > ?")
    .bind(await sha256(t), iso()).first();
  if (!row || row.status !== 'active') fail('Your session has ended. Please sign in again.', 'no_session', 401);
  return row;
}

// ── Email confirmation pages ────────────────────────────────────────────────
async function confirmPage(path, t, env) {
  const kind = path === '/org/verify' ? 'org_verify' : path === '/approve' ? 'approve' : 'decline';
  const row = /^[a-f0-9]{48}$/.test(t) ? await env.DB.prepare('SELECT * FROM tokens WHERE token_hash = ? AND kind = ?').bind(await sha256(t), kind).first() : null;
  let title, detail, action;
  if (!row || row.used_at || Date.parse(row.expires_at) < Date.now()) {
    title = 'This link has expired or was already used'; detail = 'Nothing was changed.';
  } else if (kind === 'org_verify') {
    const org = await env.DB.prepare('SELECT name, group_email FROM orgs WHERE id = ?').bind(row.ref_id).first();
    title = `Confirm ${org ? org.name : 'organization'}`; detail = `This activates the organization for ${org ? org.group_email : ''} and its first recruiter.`; action = 'Confirm organization';
  } else {
    const r = await env.DB.prepare('SELECT r.display_name, r.username, o.name FROM recruiters r JOIN orgs o ON o.id = r.org_id WHERE r.id = ?').bind(row.ref_id).first();
    title = `${kind === 'approve' ? 'Approve' : 'Decline'} ${r ? r.display_name : 'recruiter'}?`;
    detail = r ? `${r.display_name} (username ${r.username}) asked to recruit for ${r.name}.` : '';
    action = kind === 'approve' ? 'Approve recruiter' : 'Decline request';
  }
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${h(title)}</title>
  <style>body{font-family:Segoe UI,Arial,sans-serif;background:#f7f9fc;margin:0;padding:40px 16px;color:#1a1a1a}.c{max-width:460px;margin:auto;background:#fff;border:1px solid #c5d5e8;border-radius:14px;padding:28px}
  h1{font-size:1.25rem;color:#0b2e59;margin:0 0 10px}p{color:#555;line-height:1.5}button{background:#1565c0;color:#fff;border:0;border-radius:8px;padding:12px 20px;font-weight:700;font-size:1rem;cursor:pointer;min-height:44px}
  button.d{background:#6b7280}</style></head><body><div class="c"><h1>${h(title)}</h1><p>${h(detail)}</p>
  ${action ? `<form method="POST"><input type="hidden" name="t" value="${h(t)}"><button class="${kind === 'decline' ? 'd' : ''}">${h(action)}</button></form>` : ''}
  <p style="font-size:.8rem;margin-top:22px">TechTalent Portal</p></div></body></html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' } });
}

// ── Candidates ──────────────────────────────────────────────────────────────
// Public fields only — the email and phone are never returned by any public endpoint.
const MSG_PER_RECRUITER_DAY = 50, MSG_PER_PAIR_DAY = 3, RESEND_GAP_MIN = 10;
function publicProfile(b) {
  const list = (v, n, len) => (Array.isArray(v) ? v : String(v || '').split(','))
    .map(x => String(x).replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, n).map(x => x.slice(0, len));
  const linkedin = String(b.linkedin || '').trim();
  const name = text(b.name, 2, 60, 'Full name');
  return {
    name,
    initials: name.split(' ').map(x => x[0]).join('').slice(0, 2).toUpperCase(),
    role: text(b.role, 2, 80, 'Current role'),
    company: String(b.company || '').trim().slice(0, 80),
    location: text(b.location, 2, 80, 'Location'),
    exp: String(b.exp || '').trim().slice(0, 30),
    domain: String(b.domain || '').trim().slice(0, 60),
    tech: list(b.tech, 20, 40),
    summary: String(b.summary || '').trim().slice(0, 1500),
    availability: String(b.availability || '').trim().slice(0, 120),
    linkedin: /^(https?:\/\/)?([\w-]+\.)?linkedin\.com\/[\w\-/%.]+$/i.test(linkedin) ? (linkedin.startsWith('http') ? linkedin : 'https://' + linkedin) : '',
    open: true
  };
}
function plainEmail(v, label = 'Email') {
  v = String(v || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)*\.[a-z]{2,}$/.test(v) || v.length > 254) fail(`Enter a valid ${label.toLowerCase()}, like name@example.com.`, 'bad_email');
  return v;
}
async function recentlySent(env, refId, kind, days) {
  // A link of this kind was issued in the last RESEND_GAP_MIN minutes? (stops email bombing)
  const since = new Date(Date.now() + days * DAY - RESEND_GAP_MIN * 6e4).toISOString();
  return !!(await env.DB.prepare('SELECT 1 FROM tokens WHERE ref_id = ? AND kind = ? AND expires_at > ? AND used_at IS NULL').bind(refId, kind, since).first());
}

async function submitCandidate(b, env, url) {
  const email = plainEmail(b.email);
  const prof = publicProfile(b);
  const phone = String(b.phone || '').replace(/[^\d+\-() ]/g, '').slice(0, 20);
  const now = iso();
  let cand = await env.DB.prepare('SELECT * FROM candidates WHERE email = ?').bind(email).first();
  if (cand && await recentlySent(env, cand.id, 'cand_confirm', LINK_DAYS))
    return { ok: true, message: `We already sent a confirmation to ${email} a few minutes ago. Please check that inbox (and spam).` };
  if (!cand) {
    const idv = 'cand_' + hex(12);
    await env.DB.prepare('INSERT INTO candidates (id,email,phone,name,profile_json,pending_json,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .bind(idv, email, phone, prof.name, '{}', JSON.stringify(prof), 'pending', now, now).run();
    cand = { id: idv, status: 'pending' };
  } else {
    // Someone may be trying to change another person's profile — the change waits for the owner's confirmation
    await env.DB.prepare('UPDATE candidates SET pending_json = ?, phone = COALESCE(NULLIF(?, \'\'), phone), updated_at = ? WHERE id = ?').bind(JSON.stringify(prof), phone, now, cand.id).run();
  }
  const t = await newToken(env, 'cand_confirm', cand.id, LINK_DAYS);
  const isUpdate = cand.status !== 'pending';
  await sendMail(env, email, isUpdate ? 'Confirm the changes to your TechTalent profile' : 'Confirm your email to publish your TechTalent profile',
    `<p>Hi ${h(prof.name.split(' ')[0])},</p>
     <p>${isUpdate ? 'Someone (hopefully you) submitted changes to your profile on TechTalent Portal.' : 'Thanks for posting your profile on TechTalent Portal.'} Please confirm it's you:</p>
     <p>${button(`${url.origin}/candidate/confirm?t=${t}`, isUpdate ? 'Confirm changes' : 'Confirm & publish my profile')}</p>
     <p style="color:#555;font-size:13px">Your email address stays private — recruiters can't see it. When a verified recruiter contacts you, we'll email you here and you can reply directly to them.<br>
     If this wasn't you, ignore this email and nothing will change. The link expires in ${LINK_DAYS} days.</p>`);
  return { ok: true, message: `Check your inbox: we emailed ${email}. Click the link there to ${isUpdate ? 'confirm your changes' : 'publish your profile'}.` };
}

async function confirmCandidate(t, env) {
  const tok = await useToken(env, t, 'cand_confirm');
  if (!tok) return 'link-invalid';
  const c = await env.DB.prepare('SELECT * FROM candidates WHERE id = ?').bind(tok.ref_id).first();
  if (!c) return 'link-invalid';
  const now = iso();
  await env.DB.prepare("UPDATE candidates SET profile_json = COALESCE(pending_json, profile_json), name = COALESCE(json_extract(pending_json,'$.name'), name), pending_json = NULL, status = CASE WHEN status = 'hidden' THEN 'hidden' ELSE 'active' END, verified_at = COALESCE(verified_at, ?), updated_at = ? WHERE id = ?")
    .bind(now, now, c.id).run();
  return c.status === 'pending' ? 'profile-published' : 'profile-updated';
}

async function listCandidates(env) {
  const r = await env.DB.prepare("SELECT id, profile_json, verified_at, updated_at FROM candidates WHERE status = 'active' ORDER BY updated_at DESC LIMIT 500").all();
  return { ok: true, candidates: (r.results || []).map(row => ({ id: row.id, ...JSON.parse(row.profile_json || '{}'), verified: !!row.verified_at, updatedAt: row.updated_at, cloud: true })) };
}
async function oneCandidate(idv, env) {
  const row = await env.DB.prepare("SELECT id, profile_json, verified_at, updated_at FROM candidates WHERE id = ? AND status = 'active'").bind(idv).first();
  if (!row) fail('Profile not found.', 'not_found', 404);
  return { ok: true, candidate: { id: row.id, ...JSON.parse(row.profile_json || '{}'), verified: !!row.verified_at, updatedAt: row.updated_at, cloud: true } };
}

// Candidates sign in with an emailed link (no password to remember or leak)
async function candidateLoginLink(b, env, url) {
  const email = plainEmail(b.email);
  const generic = { ok: true, message: `If ${email} has a confirmed profile, we've emailed a sign-in link. It works for 30 minutes.` };
  const c = await env.DB.prepare("SELECT * FROM candidates WHERE email = ? AND status IN ('active','hidden')").bind(email).first();
  if (!c) { await sha256(email); return generic; }           // same response either way (no account probing)
  if (await recentlySent(env, c.id, 'cand_signin', 1 / 48)) return generic;
  const t = await newToken(env, 'cand_signin', c.id, 1 / 48);   // 30 minutes
  await sendMail(env, email, 'Your TechTalent sign-in link',
    `<p>Hi ${h(String(c.name).split(' ')[0])},</p><p>Use this link to open your TechTalent inbox:</p><p>${button(`${url.origin}/candidate/signin?t=${t}`, 'Sign in')}</p>
     <p style="color:#555;font-size:13px">The link works once, for 30 minutes. If you didn't ask for it, ignore this email.</p>`);
  return generic;
}
async function candidateSignin(t, env) {
  const tok = await useToken(env, t, 'cand_signin');
  if (!tok) return null;
  const token = await newToken(env, 'cand_session', tok.ref_id, SESSION_DAYS);
  return { token, expiresAt: new Date(Date.now() + SESSION_DAYS * DAY).toISOString() };
}
async function candidateUser(request, env) {
  const t = bearer(request);
  if (!t) fail('Please sign in.', 'no_session', 401);
  const row = await env.DB.prepare("SELECT c.* FROM tokens t JOIN candidates c ON c.id = t.ref_id WHERE t.token_hash = ? AND t.kind = 'cand_session' AND t.used_at IS NULL AND t.expires_at > ?").bind(await sha256(t), iso()).first();
  if (!row) fail('Your session has ended. Please sign in again.', 'no_session', 401);
  return row;
}
async function candidateMessages(request, env) {
  const c = await candidateUser(request, env);
  const r = await env.DB.prepare("SELECT m.id, m.kind, m.subject, m.body, m.created_at, m.read_at, r.display_name AS recruiter, o.name AS org, o.group_email FROM messages m JOIN recruiters r ON r.id = m.recruiter_id JOIN orgs o ON o.id = m.org_id WHERE m.candidate_id = ? ORDER BY m.created_at DESC LIMIT 200").bind(c.id).all();
  return {
    ok: true,
    me: { id: c.id, name: c.name, email: c.email, status: c.status },
    messages: (r.results || []).map(x => ({ id: x.id, kind: x.kind, subject: x.subject, body: x.body, at: x.created_at, read: !!x.read_at, from: `${x.recruiter} · ${x.org}`, replyTo: x.group_email }))
  };
}
async function candidateMarkRead(request, b, env) {
  const c = await candidateUser(request, env);
  await env.DB.prepare('UPDATE messages SET read_at = COALESCE(read_at, ?) WHERE id = ? AND candidate_id = ?').bind(iso(), String(b.id || ''), c.id).run();
  return { ok: true };
}
async function candidateVisibility(request, b, env) {
  const c = await candidateUser(request, env);
  await env.DB.prepare('UPDATE candidates SET status = ?, updated_at = ? WHERE id = ?').bind(b.visible ? 'active' : 'hidden', iso(), c.id).run();
  return { ok: true, visible: !!b.visible };
}
async function candidateDelete(request, env) {
  const c = await candidateUser(request, env);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM messages WHERE candidate_id = ?').bind(c.id),
    env.DB.prepare('DELETE FROM tokens WHERE ref_id = ?').bind(c.id),
    env.DB.prepare('DELETE FROM candidates WHERE id = ?').bind(c.id)
  ]);
  return { ok: true };
}
async function candidateLogout(request, env) {
  const t = bearer(request);
  if (t) await env.DB.prepare("UPDATE tokens SET used_at = ? WHERE token_hash = ? AND kind = 'cand_session'").bind(iso(), await sha256(t)).run();
  return { ok: true };
}

// ── Recruiter → candidate: delivered ONLY to that candidate's private address ──
async function sendCandidateMessage(request, b, env, site) {
  const rec = await sessionUser(request, env);                  // signed-in, approved recruiter only
  const candId = String(b.candidateId || '');
  if (!/^cand_[a-f0-9]{24}$/.test(candId)) fail('Unknown candidate.', 'bad_candidate');
  const kind = b.kind === 'call' ? 'call' : 'message';
  const subject = text(b.subject || (kind === 'call' ? 'Call request' : 'Opportunity'), 2, 140, 'Subject');
  const msg = text(b.body, 5, 3000, 'Message');
  const c = await env.DB.prepare("SELECT * FROM candidates WHERE id = ? AND status = 'active'").bind(candId).first();
  if (!c) fail('This candidate isn\'t available for messages.', 'not_available', 404);
  const dayAgo = new Date(Date.now() - DAY).toISOString();
  const mine = await env.DB.prepare('SELECT COUNT(*) AS n FROM messages WHERE recruiter_id = ? AND created_at > ?').bind(rec.id, dayAgo).first();
  if (mine.n >= MSG_PER_RECRUITER_DAY) fail(`Daily limit reached (${MSG_PER_RECRUITER_DAY} messages). Try again tomorrow.`, 'rate_limited', 429);
  const pair = await env.DB.prepare('SELECT COUNT(*) AS n FROM messages WHERE recruiter_id = ? AND candidate_id = ? AND created_at > ?').bind(rec.id, candId, dayAgo).first();
  if (pair.n >= MSG_PER_PAIR_DAY) fail(`You've already messaged ${c.name} ${MSG_PER_PAIR_DAY} times today. Please wait for a reply.`, 'rate_limited', 429);

  const idv = id('msg'), now = iso();
  await env.DB.prepare('INSERT INTO messages (id,candidate_id,recruiter_id,org_id,kind,subject,body,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .bind(idv, candId, rec.id, rec.org_id, kind, subject, msg, now).run();
  try {
    await sendMail(env, c.email, `${rec.org_name}: ${subject}`,
      `<p>Hi ${h(String(c.name).split(' ')[0])},</p>
       <p><b>${h(rec.display_name)}</b>, a verified recruiter at <b>${h(rec.org_name)}</b>, sent you a ${kind === 'call' ? 'call request' : 'message'} on TechTalent Portal:</p>
       <div style="border-left:4px solid #1565c0;background:#f3f7fd;padding:12px 16px;margin:14px 0;white-space:pre-wrap">${h(msg)}</div>
       <p><b>Reply to this email</b> to answer ${h(rec.org_name)} directly (${h(rec.group_email)}).</p>
       <p>${button(`${site}login.html#candidate`, 'Open my TechTalent inbox')}</p>
       <p style="color:#555;font-size:13px">Your email address is not shown to recruiters until you reply. Don't want messages? Sign in to your inbox and hide or delete your profile.</p>`,
      { email: rec.group_email, name: `${rec.display_name} (${rec.org_name})` });
  } catch (e) {
    await env.DB.prepare('DELETE FROM messages WHERE id = ?').bind(idv).run();   // not delivered → don't keep it
    throw e;
  }
  return { ok: true, id: idv, message: `Sent to ${c.name}. They'll get it by email and can reply to ${rec.group_email}.` };
}

async function candidatePage(path, t, env) {
  const kind = path === '/candidate/confirm' ? 'cand_confirm' : 'cand_signin';
  const row = /^[a-f0-9]{48}$/.test(t) ? await env.DB.prepare('SELECT * FROM tokens WHERE token_hash = ? AND kind = ?').bind(await sha256(t), kind).first() : null;
  const valid = row && !row.used_at && Date.parse(row.expires_at) >= Date.now();
  const title = !valid ? 'This link has expired or was already used' : kind === 'cand_confirm' ? 'Confirm your TechTalent profile' : 'Sign in to TechTalent';
  const detail = !valid ? (kind === 'cand_signin' ? 'Request a new sign-in link from the sign-in page.' : 'Nothing was changed.') : kind === 'cand_confirm' ? 'Your profile goes live (or your changes are applied) when you press the button.' : 'Press the button to open your inbox.';
  const action = valid ? (kind === 'cand_confirm' ? 'Confirm' : 'Open my inbox') : '';
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${h(title)}</title>
  <style>body{font-family:Segoe UI,Arial,sans-serif;background:#f7f9fc;margin:0;padding:40px 16px;color:#1a1a1a}.c{max-width:460px;margin:auto;background:#fff;border:1px solid #c5d5e8;border-radius:14px;padding:28px}
  h1{font-size:1.25rem;color:#0b2e59;margin:0 0 10px}p{color:#555;line-height:1.5}button{background:#1565c0;color:#fff;border:0;border-radius:8px;padding:12px 20px;font-weight:700;font-size:1rem;cursor:pointer;min-height:44px}</style></head>
  <body><div class="c"><h1>${h(title)}</h1><p>${h(detail)}</p>${action ? `<form method="POST"><input type="hidden" name="t" value="${h(t)}"><button>${h(action)}</button></form>` : ''}<p style="font-size:.8rem;margin-top:22px">TechTalent Portal</p></div></body></html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' } });
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function fail(message, code, status = 400) { const e = new Error(message); e.userError = true; e.code = code; e.status = status; throw e; }
function json(o, s, headers) { return new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers } }); }
async function body(req, max = 4000) { const t = await req.text(); if (t.length > max) fail('Request too large.', 'too_large', 413); try { return JSON.parse(t || '{}'); } catch { fail('Invalid request.', 'bad_json'); } }
function text(v, min, max, label) { v = String(v || '').replace(/\s+/g, ' ').trim(); if (v.length < min || v.length > max) fail(`${label} must be ${min}–${max} characters.`, 'bad_input'); return v; }
function uname(v) { v = String(v || '').trim().toLowerCase(); if (!/^[a-z0-9][a-z0-9._-]{2,29}$/.test(v)) fail('Username: 3–30 characters — letters, numbers, dot, dash or underscore.', 'bad_username'); return v; }
function pass(v) { v = String(v || ''); if (v.length < 10 || v.length > 128 || !/[A-Za-z]/.test(v) || !/\d/.test(v)) fail('Password: at least 10 characters, with letters and numbers.', 'weak_password'); return v; }
function groupMail(v) {
  v = String(v || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)*\.[a-z]{2,}$/.test(v) || v.length > 254) fail('Enter the group email, like hiring@yourcompany.com.', 'bad_email');
  if (FREE_MAIL.has(v.split('@')[1])) fail('Use your company\'s group email (e.g. hiring@yourcompany.com) — free email addresses can\'t register an organization.', 'free_email');
  return v;
}
function seatLimit(env) { const n = parseInt(env.SEAT_LIMIT || '5', 10); return n > 0 && n < 1000 ? n : 5; }
async function seatsUsed(env, orgId, includePending) {
  const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM recruiters WHERE org_id = ? AND status IN (${includePending ? "'active','pending'" : "'active'"})`).bind(orgId).first();
  return r ? r.n : 0;
}
function iso() { return new Date().toISOString(); }
function id(prefix) { return prefix + '_' + hex(12); }
function hex(n) { const a = new Uint8Array(n); crypto.getRandomValues(a); return [...a].map(b => b.toString(16).padStart(2, '0')).join(''); }
function b64(buf) { let s = ''; new Uint8Array(buf).forEach(b => s += String.fromCharCode(b)); return btoa(s); }
async function sha256(s) { return b64(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))); }
async function hashPassword(password, saltB64) {
  const salt = saltB64 ? Uint8Array.from(atob(saltB64), c => c.charCodeAt(0)) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, key, 256);
  return { hash: b64(bits), salt: b64(salt) };
}
async function checkPassword(password, hash, salt) {
  const h2 = (await hashPassword(password, salt)).hash;
  const a = new TextEncoder().encode(h2), b = new TextEncoder().encode(hash);
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];   // constant time
  return d === 0;
}
async function newToken(env, kind, refId, days) {
  const t = hex(24);
  await env.DB.prepare('INSERT INTO tokens (token_hash, kind, ref_id, expires_at) VALUES (?,?,?,?)').bind(await sha256(t), kind, refId, new Date(Date.now() + days * DAY).toISOString()).run();
  return t;
}
async function useToken(env, t, kind) {
  if (!/^[a-f0-9]{48}$/.test(t)) return null;
  const hsh = await sha256(t);
  const row = await env.DB.prepare('SELECT * FROM tokens WHERE token_hash = ? AND kind = ?').bind(hsh, kind).first();
  if (!row || row.used_at || Date.parse(row.expires_at) < Date.now()) return null;
  const r = await env.DB.prepare('UPDATE tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL').bind(iso(), hsh).run();
  if (r && r.meta && r.meta.changes === 0) return null;   // someone used it at the same moment
  return row;
}
function bearer(req) { const m = (req.headers.get('Authorization') || '').match(/^Bearer ([a-f0-9]{48})$/); return m ? m[1] : null; }
function h(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function button(href, label, bg = '#1565c0') { return `<a href="${h(href)}" style="display:inline-block;background:${bg};color:#fff;text-decoration:none;font-weight:700;padding:11px 20px;border-radius:8px">${h(label)}</a>`; }
async function sendMail(env, to, subject, html, replyTo) {
  if (!env.BREVO_API_KEY || !env.MAIL_FROM) fail('Email isn\'t set up yet, so we can\'t send the confirmation. Please try again later.', 'email_not_configured', 503);
  const r = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': env.BREVO_API_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      sender: { email: env.MAIL_FROM, name: env.MAIL_FROM_NAME || 'TechTalent Portal' },
      to: [{ email: to }], subject,
      ...(replyTo ? { replyTo: { email: replyTo.email, name: replyTo.name } } : {}),
      htmlContent: `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:15px;color:#1a1a1a;max-width:560px">${html}</div>`
    }),
    signal: AbortSignal.timeout(10000)
  });
  if (!r.ok) fail('We couldn\'t send the email right now. Please try again in a few minutes.', 'email_failed', 502);
}
