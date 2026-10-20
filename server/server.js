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

// ── Config ───────────────────────────────────────────────────────────────────
const PORT     = 4747;
const DATA_DIR = process.env.DATA_DIR || path.join('E:\\', 'ResumePortal', 'data');
const PDF_DIR  = path.join(DATA_DIR, 'pdfs');

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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
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

  // ── GET /jobs ─────────────────────────────────────────────────────────────
  if (req.method === 'GET' && url === '/jobs') {
    return json(res, 200, readJson('jobs.json'));
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
    console.log(`  → New user: ${user.name} (${user.email})`);
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

    if (pdfBuf && pdfName) {
      const safeName = profile.id + '_' + pdfName.replace(/[^a-zA-Z0-9._-]/g, '_');
      fs.writeFileSync(path.join(PDF_DIR, safeName), pdfBuf);
      profile.pdf = 'pdfs/' + safeName;
      console.log(`  → PDF saved: ${safeName}`);
    }

    const profiles = readJson('profiles.json', []);
    const existing = profiles.findIndex(p => p.email === profile.email);
    if (existing >= 0) profiles[existing] = { ...profiles[existing], ...profile };
    else profiles.push(profile);
    writeJson('profiles.json', profiles);
    console.log(`  → Profile saved: ${profile.name}`);
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
    console.log(`  → Application: ${entry.jobTitle} via ${entry.source}`);
    return json(res, 201, { ok: true });
  }

  // ── POST /contact ─────────────────────────────────────────────────────────
  if (req.method === 'POST' && url === '/contact') {
    const contacts = readJson('contacts.json', []);
    contacts.push({ id: Date.now().toString(36), ...data });
    writeJson('contacts.json', contacts);
    console.log(`  → Contact from: ${data.from?.name} → ${data.target}`);
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
    jobs.unshift(job);          // newest first
    writeJson('jobs.json', jobs);
    console.log(`  → Job posted: ${job.title} by ${job.company}`);
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
    console.log(`  → Job deleted: ${jobId}`);
    return json(res, 200, { ok: true });
  }

  // ── 404 ───────────────────────────────────────────────────────────────────
  json(res, 404, { error: 'Not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║   TechTalent Portal — Local Storage Server      ║');
  console.log(`║   Running at: http://localhost:${PORT}             ║`);
  console.log(`║   Data folder: ${DATA_DIR.padEnd(34)}║`);
  console.log('╚══════════════════════════════════════════════════╝\n');
  console.log('Endpoints:');
  console.log('  GET  /profiles        — All public profiles');
  console.log('  GET  /jobs            — Job listings');
  console.log('  GET  /applications    — Application history');
  console.log('  POST /signup          — Register new user');
  console.log('  POST /login           — Login');
  console.log('  POST /submit          — Submit resume/profile');
  console.log('  POST /applied         — Track job application');
  console.log('  POST /jobs            — Post a new job listing');
  console.log('  DELETE /jobs/:id      — Remove a job listing');
  console.log('  POST /contact         — Recruiter contact form');
  console.log('  GET  /stats           — Portal statistics\n');
  console.log('Press Ctrl+C to stop.\n');

  // Log current data counts
  try {
    const p=readJson('profiles.json',[]).length;
    const u=readJson('users.json',[]).length;
    const a=readJson('applications.json',[]).length;
    console.log(`Current data: ${p} profiles, ${u} users, ${a} applications\n`);
  } catch {}
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n❌ Port ${PORT} is already in use. Close the other process and retry.\n`);
  } else {
    console.error('Server error:', err);
  }
  process.exit(1);
});
