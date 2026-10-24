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

// ── Helpers ─────────────────────────────────────────────────────────────────
function fail(message, code, status = 400) { const e = new Error(message); e.userError = true; e.code = code; e.status = status; throw e; }
function json(o, s, headers) { return new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers } }); }
async function body(req) { const t = await req.text(); if (t.length > 4000) fail('Request too large.', 'too_large', 413); try { return JSON.parse(t || '{}'); } catch { fail('Invalid request.', 'bad_json'); } }
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
async function sendMail(env, to, subject, html) {
  if (!env.BREVO_API_KEY || !env.MAIL_FROM) fail('Email isn\'t set up yet, so we can\'t send the confirmation. Please try again later.', 'email_not_configured', 503);
  const r = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': env.BREVO_API_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      sender: { email: env.MAIL_FROM, name: env.MAIL_FROM_NAME || 'TechTalent Portal' },
      to: [{ email: to }], subject,
      htmlContent: `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:15px;color:#1a1a1a;max-width:560px">${html}</div>`
    }),
    signal: AbortSignal.timeout(10000)
  });
  if (!r.ok) fail('We couldn\'t send the email right now. Please try again in a few minutes.', 'email_failed', 502);
}
