/**
 * TechTalent Portal — Local Storage Server
 * Runs on your PC and stores all data in E:\ResumePortal\data\
 *
 * Start: node server.js
 * Port:  4747
 */

const http    = require('http');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const { startAutoRefresh, readCache } = require('./job_aggregator');

// Load .env file if present (keeps secrets out of source code)
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  fs.readFileSync(envFile, 'utf8').split('\n').forEach(line => {
    const [k, ...v] = line.trim().split('=');
    if (k && !k.startsWith('#') && v.length) process.env[k.trim()] = v.join('=').trim();
  });
}

// ── Config ───────────────────────────────────────────────────────────────────
const PORT     = 4747;
const DATA_DIR = process.env.DATA_DIR || path.join('E:\\', 'ResumePortal', 'data');
const PDF_DIR  = path.join(DATA_DIR, 'pdfs');

// ── LinkedIn OAuth credentials ───────────────────────────────────────────────
const LINKEDIN_CLIENT_ID     = process.env.LINKEDIN_CLIENT_ID     || 'YOUR_LINKEDIN_CLIENT_ID';
const LINKEDIN_CLIENT_SECRET = process.env.LINKEDIN_CLIENT_SECRET || 'YOUR_LINKEDIN_CLIENT_SECRET';
const PORTAL_URL             = process.env.PORTAL_URL             || 'https://purnappc8.github.io/resume-portal/login.html';

// ── Admin session tokens (in-memory; cleared on restart) ────────────────────
const ADMIN_TOKENS = new Set();
function genToken() { return crypto.randomBytes(24).toString('hex'); }
function isAdminToken(req) {
  const tok = (req.headers['x-admin-token'] || '').trim();
  return tok && ADMIN_TOKENS.has(tok);
}
function requireAdmin(req, res) {
  if (!isAdminToken(req)) { json(res, 401, { error: 'Unauthorized' }); return false; }
  return true;
}

// Ensure data directories exist
[DATA_DIR, PDF_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ── Helper: read/write JSON files ────────────────────────────────────────────
function readJson(file, fallback = []) {
  const p = path.join(DATA_DIR, file);
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return fallback; }
}
function writeJson(file, data) {
  fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data, null, 2));
}
function hashPass(pass) {
  return crypto.createHash('sha256').update(pass + 'ttp-salt-2026').digest('hex');
}

// ── Parse multipart (for PDF upload) ────────────────────────────────────────
function parseMultipart(body, boundary) {
  const result = {};
  const parts   = body.split('--' + boundary);
  parts.forEach(part => {
    if (!part.includes('Content-Disposition')) return;
    const [headers, ...rest] = part.split('\r\n\r\n');
    const content = rest.join('\r\n\r\n').replace(/\r\n$/, '');
    const nameMatch = headers.match(/name="([^"]+)"/);
    const fileMatch = headers.match(/filename="([^"]+)"/);
    if (!nameMatch) return;
    const name = nameMatch[1];
    if (fileMatch) {
      result[name] = { filename: fileMatch[1], data: Buffer.from(content, 'binary') };
    } else {
      result[name] = content;
    }
  });
  return result;
}

// ── Parse body ───────────────────────────────────────────────────────────────
function getBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ── CORS headers ─────────────────────────────────────────────────────────────
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-Admin-Token');
}

// ── Response helpers ──────────────────────────────────────────────────────────
function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// ── Server ────────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = req.url.split('?')[0];
  const qs  = Object.fromEntries(new URL('http://x'+req.url).searchParams);
  const body = await getBody(req);
  let data = {};
  const ct = req.headers['content-type'] || '';
  if (ct.includes('application/json')) {
    try { data = JSON.parse(body.toString()); } catch {}
  }

  console.log(`${new Date().toISOString().slice(11,19)} ${req.method} ${url}`);

  // ── GET /profiles ─────────────────────────────────────────────────────────
  if (req.method === 'GET' && url === '/profiles') {
    const profiles = readJson('profiles.json');
    // Hide email/phone for public listing
    const safe = profiles.map(({ email, phone, pass, ...p }) => p);
    return json(res, 200, safe);
  }

  // -- GET /jobs: merge portal-posted + live aggregated jobs
  if (req.method === 'GET' && url === '/jobs') {
    const portalJobs = readJson('jobs.json', []);
    const liveJobs   = readCache(DATA_DIR);
    const seen = new Set();
    const merged = [...portalJobs, ...liveJobs].filter(j => {
      const key = (j.url || j.id || '').split('?')[0];
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return json(res, 200, merged);
  }

  // -- GET /jobs/refresh: trigger on-demand re-fetch
  if (req.method === 'GET' && url === '/jobs/refresh') {
    const { aggregate } = require('./job_aggregator');
    aggregate(DATA_DIR).catch(e => console.error('[JobAgg]', e.message));
    return json(res, 202, { ok: true, message: 'Refresh started' });
  }

  // ── GET /applications ─────────────────────────────────────────────────────
  if (req.method === 'GET' && url === '/applications') {
    const all = readJson('applications.json');
    const mine = qs.email ? all.filter(a => a.userEmail === qs.email) : all;
    return json(res, 200, mine);
  }

  // ── GET /contacts ─────────────────────────────────────────────────────────
  if (req.method === 'GET' && url === '/contacts') {
    return json(res, 200, readJson('contacts.json'));
  }

  // ── GET /users (admin) ────────────────────────────────────────────────────
  if (req.method === 'GET' && url === '/users') {
    const users = readJson('users.json').map(({ pass, ...u }) => u);
    return json(res, 200, users);
  }

  // ── POST /signup ──────────────────────────────────────────────────────────
  if (req.method === 'POST' && url === '/signup') {
    const users = readJson('users.json', []);
    if (users.find(u => u.email === data.email)) {
      return json(res, 409, { error: 'Email already registered.' });
    }
    const user = {
      id: Date.now().toString(36),
      name: data.name,
      email: data.email,
      pass: hashPass(data.pass || ''),
      role: data.role || 'candidate',
      createdAt: data.createdAt || new Date().toISOString()
    };
    users.push(user);
    writeJson('users.json', users);
    console.log(`  -> New user: ${user.name} (${user.email})`);
    const { pass: _, ...safe } = user;
    return json(res, 201, { user: safe });
  }

  // ── POST /login ───────────────────────────────────────────────────────────
  if (req.method === 'POST' && url === '/login') {
    const users = readJson('users.json', []);
    const user  = users.find(u => u.email === data.email && u.pass === hashPass(data.pass || ''));
    if (!user) return json(res, 401, { error: 'Invalid email or password.' });
    const { pass: _, ...safe } = user;
    return json(res, 200, { user: safe });
  }

  // ── POST /submit (resume + PDF) ───────────────────────────────────────────
  if (req.method === 'POST' && url === '/submit') {
    let profile, pdfBuf, pdfName;

    if (ct.includes('multipart/form-data')) {
      const boundary = ct.split('boundary=')[1];
      const parts = parseMultipart(body.toString('binary'), boundary);
      profile = JSON.parse(parts.profile || '{}');
      if (parts.pdf) { pdfBuf = parts.pdf.data; pdfName = parts.pdf.filename; }
    } else {
      profile = data;
    }

    if (!profile || typeof profile !== 'object') return json(res, 400, { error: 'Invalid submission.' });
    const req_ = ['name', 'email', 'role', 'location', 'summary'];
    if (req_.some(k => typeof profile[k] !== 'string' || !profile[k].trim())) {
      return json(res, 400, { error: 'Please fill all required fields (name, email, role, location, summary).' });
    }
    profile.email = profile.email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profile.email) || profile.email.length > 254) {
      return json(res, 400, { error: 'Please enter a valid email address.' });
    }
    if (pdfBuf && (pdfBuf.length > 5 * 1024 * 1024 || !/\.pdf$/i.test(pdfName || ''))) {
      return json(res, 400, { error: 'Resume must be a PDF up to 5MB.' });
    }
    profile.id = String(profile.id || Date.now().toString(36)).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || Date.now().toString(36);
    profile.guest = profile.guest === true;
    delete profile.pass;

    const profiles = readJson('profiles.json', []);
    const existing = profiles.findIndex(p => (p.email || '').toLowerCase() === profile.email);
    if (existing >= 0 && profile.guest && profiles[existing].guest === false) {
      return json(res, 409, { error: 'A profile with this email already exists. Please sign in to update it.' });
    }

    if (pdfBuf && pdfName) {
      const safeName = profile.id + '_' + pdfName.replace(/[^a-zA-Z0-9._-]/g, '_');
      fs.writeFileSync(path.join(PDF_DIR, safeName), pdfBuf);
      profile.pdf = 'pdfs/' + safeName;
      console.log(`  -> PDF saved: ${safeName}`);
    }

    if (existing >= 0) profiles[existing] = { ...profiles[existing], ...profile };
    else profiles.push(profile);
    writeJson('profiles.json', profiles);
    console.log(`  -> Profile saved: ${profile.name}`);
    return json(res, 201, { ok: true, id: profile.id });
  }

  // ── POST /applied ─────────────────────────────────────────────────────────
  if (req.method === 'POST' && url === '/applied') {
    const apps = readJson('applications.json', []);
    const entry = {
      id: Date.now().toString(36),
      jobId:     data.jobId,
      jobTitle:  data.jobTitle,
      source:    data.source,
      url:       data.url,
      userEmail: data.user ? JSON.parse(data.user || '{}').email : 'anonymous',
      userName:  data.user ? JSON.parse(data.user || '{}').name  : 'Anonymous',
      appliedAt: data.appliedAt || new Date().toISOString(),
      status:    'Applied'
    };
    apps.push(entry);
    writeJson('applications.json', apps);
    console.log(`  -> Application: ${entry.jobTitle} via ${entry.source}`);
    return json(res, 201, { ok: true });
  }

  // ── POST /contact ─────────────────────────────────────────────────────────
  if (req.method === 'POST' && url === '/contact') {
    const contacts = readJson('contacts.json', []);
    contacts.push({ id: Date.now().toString(36), ...data });
    writeJson('contacts.json', contacts);
    console.log(`  -> Contact from: ${data.from?.name} -> ${data.target}`);
    return json(res, 201, { ok: true });
  }

  // ── GET /stats ────────────────────────────────────────────────────────────
  if (req.method === 'GET' && url === '/stats') {
    return json(res, 200, {
      profiles:     readJson('profiles.json', []).length,
      users:        readJson('users.json',    []).length,
      applications: readJson('applications.json', []).length,
      contacts:     readJson('contacts.json',  []).length,
    });
  }

  // ── POST /jobs (employer posts a job) ────────────────────────────────────
  if (req.method === 'POST' && url === '/jobs') {
    if (!data.title || !data.company) return json(res, 400, { error: 'title and company are required.' });
    const jobs = readJson('jobs.json', []);
    const job = {
      id:          data.id || 'portal_' + Date.now().toString(36),
      title:       data.title,
      company:     data.company,
      location:    data.location    || 'Remote',
      type:        data.type        || 'Freelance',
      salary:      data.salary      || '',
      experience:  data.experience  || '',
      skills:      data.skills      || [],
      description: data.description || '',
      email:       data.email       || '',
      applyUrl:    data.applyUrl    || '',
      source:      'TechTalent Portal',
      postedBy:    data.postedBy    || 'anonymous',
      postedAt:    data.postedAt    || new Date().toISOString()
    };
    jobs.unshift(job);
    writeJson('jobs.json', jobs);
    console.log(`  -> Job posted: ${job.title} by ${job.company}`);
    return json(res, 201, { ok: true, id: job.id });
  }

  // ── DELETE /jobs/:id ───────────────────────────────────────────────────────
  if (req.method === 'DELETE' && url.startsWith('/jobs/')) {
    const jobId = url.split('/jobs/')[1];
    const jobs  = readJson('jobs.json', []);
    const idx   = jobs.findIndex(j => j.id === jobId);
    if (idx < 0) return json(res, 404, { error: 'Job not found.' });
    jobs.splice(idx, 1);
    writeJson('jobs.json', jobs);
    console.log(`  -> Job deleted: ${jobId}`);
    return json(res, 200, { ok: true });
  }

  // ── GET /auth/linkedin ────────────────────────────────────────────────────
  if (req.method === 'GET' && url === '/auth/linkedin') {
    if (LINKEDIN_CLIENT_ID === 'YOUR_LINKEDIN_CLIENT_ID') {
      res.writeHead(200, {'Content-Type':'text/html'});
      return res.end(`<h2>LinkedIn not configured</h2>
        <p>Edit <code>server.js</code> and set <b>LINKEDIN_CLIENT_ID</b> and <b>LINKEDIN_CLIENT_SECRET</b>.</p>
        <p><a href="https://www.linkedin.com/developers/apps/new">Create LinkedIn App ></a></p>`);
    }
    const state = crypto.randomBytes(16).toString('hex');
    const redirectUri = `http://localhost:${PORT}/auth/linkedin/callback`;
    const liUrl = 'https://www.linkedin.com/oauth/v2/authorization?' + new URLSearchParams({
      response_type: 'code',
      client_id:     LINKEDIN_CLIENT_ID,
      redirect_uri:  redirectUri,
      state,
      scope:         'openid profile email'
    });
    const pending = readJson('li_pending.json', {});
    pending[state] = { next: qs.next || PORTAL_URL, ts: Date.now() };
    writeJson('li_pending.json', pending);
    res.writeHead(302, { Location: liUrl });
    return res.end();
  }

  // ── GET /auth/linkedin/callback ───────────────────────────────────────────
  if (req.method === 'GET' && url === '/auth/linkedin/callback') {
    const { code, state, error } = qs;
    const pending = readJson('li_pending.json', {});
    const entry = pending[state];

    Object.keys(pending).forEach(k => { if (Date.now() - pending[k].ts > 600000) delete pending[k]; });
    if (state) delete pending[state];
    writeJson('li_pending.json', pending);

    if (error || !code || !entry) {
      res.writeHead(302, { Location: `${PORTAL_URL}?li_error=${encodeURIComponent(error||'cancelled')}` });
      return res.end();
    }

    try {
      const redirectUri = `http://localhost:${PORT}/auth/linkedin/callback`;
      const tokenRes = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type:    'authorization_code',
          code,
          redirect_uri:  redirectUri,
          client_id:     LINKEDIN_CLIENT_ID,
          client_secret: LINKEDIN_CLIENT_SECRET
        })
      });
      const tokenData = await tokenRes.json();
      const accessToken = tokenData.access_token;
      if (!accessToken) throw new Error('No access token: ' + JSON.stringify(tokenData));

      const profileRes = await fetch('https://api.linkedin.com/v2/userinfo', {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      const profile = await profileRes.json();
      const liName   = profile.name || [profile.given_name, profile.family_name].filter(Boolean).join(' ') || 'LinkedIn User';
      const liEmail  = profile.email || '';
      const liAvatar = profile.picture || '';

      const users = readJson('users.json', []);
      let user = users.find(u => u.email === liEmail && liEmail);
      if (!user) {
        user = { id: 'li_' + Date.now().toString(36), name: liName, email: liEmail, linkedin: true, createdAt: new Date().toISOString() };
        users.push(user);
        writeJson('users.json', users);
      }
      console.log(`  -> LinkedIn login: ${liName} (${liEmail})`);

      const token = 'li_' + crypto.randomBytes(16).toString('hex');
      const dest = (entry.next || PORTAL_URL) + '#' + new URLSearchParams({
        li_token:  token,
        li_name:   liName,
        li_email:  liEmail,
        li_avatar: liAvatar
      });
      res.writeHead(302, { Location: dest });
      return res.end();
    } catch (err) {
      console.error('LinkedIn callback error:', err.message);
      res.writeHead(302, { Location: `${PORTAL_URL}?li_error=${encodeURIComponent('auth_failed')}` });
      return res.end();
    }
  }

  // ── ADMIN: POST /admin/auth ───────────────────────────────────────────────
  if (req.method === 'POST' && url === '/admin/auth') {
    const { password } = data;
    const expected = process.env.ADMIN_PASSWORD || 'ttp-admin-2026';
    if (password === expected) {
      const token = genToken();
      ADMIN_TOKENS.add(token);
      return json(res, 200, { token });
    }
    return json(res, 401, { error: 'Wrong password' });
  }

  // ── ADMIN: GET /admin/users ───────────────────────────────────────────────
  if (req.method === 'GET' && url === '/admin/users') {
    if (!requireAdmin(req, res)) return;
    const users = readJson('users.json', []).map(({ pass, ...u }) => u);
    return json(res, 200, users);
  }

  // ── ADMIN: GET /admin/profiles ────────────────────────────────────────────
  if (req.method === 'GET' && url === '/admin/profiles') {
    if (!requireAdmin(req, res)) return;
    return json(res, 200, readJson('profiles.json', []));
  }

  // ── ADMIN: GET /admin/applications ────────────────────────────────────────
  if (req.method === 'GET' && url === '/admin/applications') {
    if (!requireAdmin(req, res)) return;
    return json(res, 200, readJson('applications.json', []));
  }

  // ── ADMIN: GET /admin/jobs ────────────────────────────────────────────────
  if (req.method === 'GET' && url === '/admin/jobs') {
    if (!requireAdmin(req, res)) return;
    return json(res, 200, readJson('jobs.json', []));
  }

  // ── ADMIN: GET /admin/live-jobs ───────────────────────────────────────────
  if (req.method === 'GET' && url === '/admin/live-jobs') {
    if (!requireAdmin(req, res)) return;
    return json(res, 200, readCache(DATA_DIR));
  }

  // ── ADMIN: POST /admin/login-as ───────────────────────────────────────────
  if (req.method === 'POST' && url === '/admin/login-as') {
    if (!requireAdmin(req, res)) return;
    const { userId, email } = data;
    const users = readJson('users.json', []);
    const target = users.find(u => u.id === userId || u.email === email);
    if (!target) return json(res, 404, { error: 'User not found' });
    const token = genToken();
    ADMIN_TOKENS.add(token);
    const { pass: _, ...safe } = target;
    return json(res, 200, { token, ...safe });
  }

  // ── 404 ───────────────────────────────────────────────────────────────────
  json(res, 404, { error: 'Not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('\n====================================================');
  console.log('   TechTalent Portal -- Local Storage Server      ');
  console.log(`   Running at: http://localhost:${PORT}             `);
  console.log(`   Data folder: ${DATA_DIR}`);
  console.log('====================================================\n');
  console.log('Endpoints:');
  console.log('  GET  /profiles        -- All public profiles');
  console.log('  GET  /jobs            -- Job listings (portal + live)');
  console.log('  GET  /jobs/refresh    -- Trigger live job re-fetch');
  console.log('  GET  /applications    -- Application history');
  console.log('  POST /signup          -- Register new user');
  console.log('  POST /login           -- Login');
  console.log('  POST /submit          -- Submit resume/profile');
  console.log('  POST /applied         -- Track job application');
  console.log('  POST /jobs            -- Post a new job listing');
  console.log('  DELETE /jobs/:id      -- Remove a job listing');
  console.log('  POST /contact         -- Recruiter contact form');
  console.log('  GET  /stats           -- Portal statistics');
  console.log('  GET  /auth/linkedin   -- LinkedIn OAuth start');
  console.log('  POST /admin/auth      -- Admin login');
  console.log('  GET  /admin/users     -- Admin: list users');
  console.log('  GET  /admin/profiles  -- Admin: list profiles');
  console.log('  GET  /admin/applications -- Admin: list applications');
  console.log('  GET  /admin/jobs      -- Admin: list posted jobs');
  console.log('  GET  /admin/live-jobs -- Admin: live aggregated jobs');
  console.log('  POST /admin/login-as  -- Admin: impersonate user\n');
  if (LINKEDIN_CLIENT_ID === 'YOUR_LINKEDIN_CLIENT_ID') {
    console.log('LinkedIn login NOT configured. Set LINKEDIN_CLIENT_ID / LINKEDIN_CLIENT_SECRET in .env\n');
  } else {
    console.log('LinkedIn OAuth ready.\n');
  }
  console.log('Press Ctrl+C to stop.\n');

  try {
    const p=readJson('profiles.json',[]).length;
    const u=readJson('users.json',[]).length;
    const a=readJson('applications.json',[]).length;
    console.log(`Current data: ${p} profiles, ${u} users, ${a} applications\n`);
  } catch {}

  // Start background job aggregator (auto-fetches live jobs every 2h)
  startAutoRefresh(DATA_DIR);
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nPort ${PORT} is already in use. Close the other process and retry.\n`);
  } else {
    console.error('Server error:', err);
  }
  process.exit(1);
});
