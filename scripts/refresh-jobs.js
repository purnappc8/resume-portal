#!/usr/bin/env node
/**
 * refresh-jobs.js — builds feed/jobs.json for the public Browse Jobs page.
 * Runs on GitHub Actions every 3 hours (see .github/workflows/refresh-jobs.yml),
 * so the live site gets fresh jobs without the PC server running.
 *
 *  • Pulls IT jobs from Remote OK, Remotive and Arbeitnow (free public feeds).
 *  • Keeps only tech roles, with real job type, level and posting date.
 *  • Closed jobs: a job that its feed no longer lists is moved to `closed`.
 *  • Feed outage: if a feed errors or returns nothing, its previous jobs are kept
 *    (an outage is not a closure).
 *  • Jobs older than 30 days are dropped.
 *  • Built-in jobs written into jobs.html get their link checked once a day;
 *    a 404/410 marks them closed.
 *
 * Feed terms we follow:
 *  - Remotive: link back + name Remotive; fetch at most 4×/day; never gate jobs
 *    behind sign-up. We fetch it only if the last fetch was ≥ 5.5 h ago.
 *  - Remote OK: link back (followed link) + name "Remote OK"; no logo.
 *
 * Usage: node scripts/refresh-jobs.js [--out feed/jobs.json] [--no-link-check]
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.resolve(ROOT, argValue('--out') || 'feed/jobs.json');
const LINK_CHECK = !process.argv.includes('--no-link-check');

const MAX_AGE_DAYS = 30;          // drop jobs older than this
const KEEP_CLOSED_DAYS = 21;      // remember closed jobs this long (for saved/applied lists)
// Per feed: cap = max jobs kept; minGapH = don't fetch more often than this;
// complete = we receive the feed's whole list, so a job missing from it has closed.
// For partial feeds (we only take the newest slice) a missing job is NOT treated as
// closed — it stays until its expiry date or until it is 30 days old.
const FEED_CONFIG = {
  'Remote OK': { cap: 120, complete: true },
  Remotive:    { cap: 120, complete: true,  minGapH: 5.5 },   // asks for ≤ 4 fetches a day
  Arbeitnow:   { cap: 150, complete: false },
  Himalayas:   { cap: 900, complete: false, minGapH: 23 },    // data refreshes daily; asks not to poll more
  Jobicy:      { cap: 150, complete: false, minGapH: 5.5 }
};
// Himalayas keyword searches (global, plus India-specific) — run once a day
// [query, pages of 20]. Plain "salesforce" mostly finds sales roles, so use specific Salesforce roles.
const HIMALAYAS_QUERIES = [['salesforce developer', 3], ['salesforce administrator', 2], ['salesforce consultant', 2], ['salesforce architect', 2],
  ['java', 2], ['python', 2], ['react', 2], ['node.js', 2], ['devops', 2], ['aws', 2], ['azure', 2], ['data engineer', 2], ['data scientist', 2],
  ['machine learning', 2], ['sap', 2], ['qa automation', 2], ['.net', 2], ['android', 1], ['ios', 1], ['golang', 1], ['security engineer', 2],
  ['servicenow', 1], ['full stack', 2], ['cloud engineer', 2]];
const HIMALAYAS_INDIA = [['salesforce developer', 2], ['salesforce consultant', 1], ['java', 2], ['python', 2], ['devops', 2], ['react', 1],
  ['data engineer', 2], ['sap', 1], ['qa', 1], ['full stack', 1], ['cloud', 1], ['.net', 1]];
const LINK_CHECK_GAP_H = 20;      // check built-in job links about once a day
const UA = 'TechTalentPortal/1.0 (+https://purnappc8.github.io/resume-portal/)';
const DAY = 864e5, HOUR = 36e5;

function argValue(name) { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; }
function log(...a) { console.log('[refresh-jobs]', ...a); }

// ── Classification helpers ────────────────────────────────────────────────
// A job must look like a tech role by its title…
const IT_TITLE = /\b(developer|engineer(ing)?|programmer|(software|solutions?|cloud|data|enterprise|salesforce|technical|security|systems?|platform|integration|it|aws|azure) architect|devops|devsecops|sre|site reliability|salesforce|sfdc|apex|lwc|cpq|servicenow|sap\b|abap|data (scientist|analyst|engineer)|analytics engineer|machine learning|\bml\b|\bai\b|llm|nlp|qa\b|test(er|ing)? (engineer|automation|analyst)|automation (engineer|tester)|full[- ]?stack|front[- ]?end|back[- ]?end|web dev|mobile|ios|android|flutter|react|angular|vue|node|python|java\b|golang|\bgo developer|rust|\.net|c#|php|ruby|scala|kotlin|swift|cloud|aws|azure|gcp|kubernetes|platform|infrastructure|security|cyber|penetration|sysadmin|system administrator|network engineer|database|dba|bi developer|power bi|tableau|etl|crm (developer|consultant|admin)|technical lead|tech lead|cto)\b/i;
// …and not be a non-tech role that happens to mention tech words
const NON_IT = /\b(sales (development|representative|executive|manager)|account (executive|manager)|business development|marketing|recruit(er|ing)|talent acquisition|customer (success|support|service)|copywriter|content writer|social media|hr\b|human resources|accountant|bookkeep|nurse|driver|teacher|tutor|real estate|insurance agent|call cent(er|re)|video annotation|ai trainer|data entry|translator)\b/i;

const TECH = [
  ['Salesforce', /\b(salesforce|sfdc|sales cloud|service cloud|marketing cloud|pardot|agentforce)\b/i],
  ['Apex', /\bapex\b/i], ['LWC', /\b(lwc|lightning web)\b/i], ['CPQ', /\bcpq\b/i],
  ['Java', /\bjava\b(?!script)|spring boot/i], ['Python', /\b(python|django|flask|fastapi)\b/i],
  ['JavaScript', /\bjavascript\b/i], ['TypeScript', /\btypescript\b/i],
  ['React', /\breact(\.js|js)?\b(?! native)/i], ['React Native', /\breact native\b/i],
  ['Angular', /\bangular\b/i], ['Vue', /\bvue(\.js)?\b/i], ['Node.js', /\bnode(\.js|js)?\b/i],
  ['.NET', /(\.net\b|\bdotnet\b|\bc#)/i], ['Go', /\b(golang|go developer|go engineer)\b/i],
  ['PHP', /\b(php|laravel)\b/i], ['Ruby', /\b(ruby|rails)\b/i], ['Rust', /\brust\b/i],
  ['AWS', /\b(aws|amazon web services)\b/i], ['Azure', /\bazure\b/i], ['GCP', /\b(gcp|google cloud)\b/i],
  ['DevOps', /\b(devops|ci\/cd|cicd|jenkins|gitlab ci|github actions)\b/i],
  ['Kubernetes', /\b(kubernetes|k8s)\b/i], ['Docker', /\bdocker\b/i], ['Terraform', /\bterraform\b/i],
  ['AI/ML', /\b(machine learning|\bml\b|llm|nlp|pytorch|tensorflow|generative ai|\bai\b)\b/i],
  ['Data', /\b(data engineer|data scien|databricks|spark|snowflake|etl|airflow|dbt)\b/i],
  ['SQL', /\b(sql|postgres|mysql|oracle db)\b/i], ['SAP', /\bsap\b/i], ['ServiceNow', /\bservicenow\b/i],
  ['iOS', /\b(ios|swiftui|swift)\b/i], ['Android', /\b(android|kotlin)\b/i], ['Flutter', /\bflutter\b/i],
  ['QA', /\b(qa|quality assurance|selenium|cypress|playwright|test automation)\b/i],
  ['Security', /\b(security|cyber|soc analyst|penetration|pentest)\b/i]
];
function techTags(text) { return TECH.filter(([, re]) => re.test(text)).map(([t]) => t).slice(0, 8); }
function level(title) {
  if (/\b(senior|sr\.?|lead|principal|staff|head of|architect|director|cto)\b/i.test(title)) return 'Senior';
  if (/\b(junior|jr\.?|entry|graduate|intern|trainee|werkstudent|associate)\b/i.test(title)) return 'Junior';
  return 'Mid';
}
function jobType(raw, title) {
  const t = (String(raw || '') + ' ' + title).toLowerCase();
  if (/freelance/.test(t)) return 'Freelance';
  if (/contract|contractor|temporary|fixed[- ]term/.test(t)) return 'Contract';
  if (/part[ _-]?time|teilzeit/.test(t)) return 'Part-time';
  if (/intern|werkstudent/.test(t)) return 'Internship';
  return 'Full-time';
}
function clean(s, max) { return String(s || '').replace(/<[^>]*>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, max); }
function money(min, max) {
  const k = n => '$' + Math.round(n / 1000) + 'K';
  if (min > 0 && max > 0 && max >= min) return min === max ? k(min) : `${k(min)}–${k(max)}`;
  if (min > 0) return k(min) + '+';
  return '';
}
function isTech(title, tags) { return IT_TITLE.test(title) && !NON_IT.test(title) && tags.length >= 0; }
function make(o) {
  const title = clean(o.title, 140), company = clean(o.company, 90);
  const text = `${title} ${(o.tags || []).join(' ')} ${o.desc || ''}`;
  return {
    id: `live_${o.source.replace(/\W/g, '')}_${String(o.id).replace(/[^\w-]/g, '').slice(0, 40)}`,
    title, company: company || 'Company not listed',
    location: clean(o.location, 80) || 'Remote',
    type: jobType(o.type, title),
    exp: level(title),
    tech: techTags(text),
    salary: clean(o.salary, 40),
    source: o.source,
    url: o.url,
    postedAt: o.postedAt,
    ...(o.expiresAt ? { expiresAt: o.expiresAt } : {}),
    live: true
  };
}
async function getJSON(url, timeoutMs = 20000) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// ── Feeds ─────────────────────────────────────────────────────────────────
const FEEDS = {
  'Remote OK': async () => {
    const d = await getJSON('https://remoteok.com/api');
    return d.filter(j => j && j.id && j.position).map(j => ({
      id: j.id, title: j.position, company: j.company, location: j.location || 'Remote',
      tags: j.tags || [], desc: clean(j.description, 400), type: (j.tags || []).join(' '),
      salary: money(+j.salary_min || 0, +j.salary_max || 0),
      url: j.url, postedAt: j.date || (j.epoch ? new Date(j.epoch * 1000).toISOString() : null), source: 'Remote OK'
    }));
  },
  Remotive: async () => {
    const out = [];
    for (const cat of ['software-dev', 'devops', 'data', 'qa']) {
      const d = await getJSON(`https://remotive.com/api/remote-jobs?category=${cat}&limit=60`);
      (d.jobs || []).forEach(j => out.push({
        id: j.id, title: j.title, company: j.company_name, location: j.candidate_required_location || 'Remote',
        tags: j.tags || [], desc: '', type: j.job_type, salary: j.salary || '',
        url: j.url, postedAt: j.publication_date ? new Date(j.publication_date + (/Z|[+-]\d\d:?\d\d$/.test(j.publication_date) ? '' : 'Z')).toISOString() : null, source: 'Remotive'
      }));
    }
    return out;
  },
  Arbeitnow: async () => {
    const out = [];
    for (let page = 1; page <= 3; page++) {
      const d = await getJSON(`https://www.arbeitnow.com/api/job-board-api?page=${page}`);
      (d.data || []).forEach(j => out.push({
        id: j.slug, title: j.title, company: j.company_name,
        location: (j.location || '') + (j.remote ? ' (Remote)' : ''),
        tags: j.tags || [], desc: clean(j.description, 400), type: (j.job_types || []).join(' '),
        salary: '', url: j.url, postedAt: j.created_at ? new Date(j.created_at * 1000).toISOString() : null, source: 'Arbeitnow'
      }));
      if (!d.links || !d.links.next) break;
    }
    return out;
  },
  Himalayas: async () => {
    const out = [];
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const run = async (q, country, pages) => {
      for (let page = 1; page <= pages; page++) {
        const p = new URLSearchParams({ q, limit: '20', page: String(page), sort: 'recent' });
        if (country) p.set('country', country);
        let d;
        try { d = await getJSON(`https://himalayas.app/jobs/api/search?${p}`); } catch (e) { if (/429/.test(e.message)) return 'limited'; throw e; }
        (d.jobs || []).forEach(j => {
          const cur = j.currency && j.currency !== 'USD' ? j.currency + ' ' : '$';
          const pay = j.minSalary || j.maxSalary ? money(+j.minSalary || 0, +j.maxSalary || 0).split('$').join(cur) + (j.salaryPeriod && j.salaryPeriod !== 'annual' ? '/' + j.salaryPeriod : '') : '';
          const where = j.locationRestrictions || [];
          out.push({
            id: (j.guid || '').split('/').slice(-3).join('-') || j.title, title: j.title, company: j.companyName,
            location: 'Remote — ' + (where.slice(0, 3).join(', ') || 'Worldwide') + (where.length > 3 ? ' +' : ''),
            tags: [...(j.categories || []), ...(j.seniority || [])].slice(0, 10), desc: clean(j.excerpt, 300), type: j.employmentType,
            salary: pay, url: j.guid || j.applicationLink, postedAt: j.pubDate ? new Date(j.pubDate * 1000).toISOString() : null,
            expiresAt: j.expiryDate ? new Date(j.expiryDate * 1000).toISOString() : null, source: 'Himalayas'
          });
        });
        if ((d.jobs || []).length < 20) break;
        await sleep(400);
      }
    };
    for (const [q, pages] of HIMALAYAS_QUERIES) if (await run(q, '', pages) === 'limited') break;
    for (const [q, pages] of HIMALAYAS_INDIA) if (await run(q, 'India', pages) === 'limited') break;
    return out;
  },
  Jobicy: async () => {
    const out = [];
    for (const industry of ['dev', 'data-science', 'engineering']) {
      const d = await getJSON(`https://jobicy.com/api/v2/remote-jobs?count=50&industry=${industry}`);
      (d.jobs || []).forEach(j => {
        const cur = j.salaryCurrency && j.salaryCurrency !== 'USD' ? j.salaryCurrency + ' ' : '$';
        out.push({
          id: j.id, title: j.jobTitle, company: j.companyName, location: 'Remote — ' + (j.jobGeo || 'Anywhere'),
          tags: [].concat(j.jobIndustry || [], j.jobLevel || []), desc: clean(j.jobExcerpt, 300), type: [].concat(j.jobType || []).join(' '),
          salary: j.annualSalaryMin || j.annualSalaryMax ? money(+j.annualSalaryMin || 0, +j.annualSalaryMax || 0).split('$').join(cur) : '',
          url: j.url, postedAt: j.pubDate ? new Date(j.pubDate).toISOString() : null, source: 'Jobicy'
        });
      });
    }
    return out;
  }
};

// ── Built-in jobs (written into jobs.html) ────────────────────────────────
function builtInJobs() {
  try {
    const html = fs.readFileSync(path.join(ROOT, 'jobs.html'), 'utf8');
    const block = html.slice(html.indexOf('const SEED_JOBS'), html.indexOf('];', html.indexOf('const SEED_JOBS')));
    const out = [];
    const re = /\{\s*id:'([^']+)'[^}]*?url:'([^']+)'/g; let m;
    while ((m = re.exec(block))) out.push({ id: m[1], url: m[2] });
    return out;
  } catch (e) { log('could not read built-in jobs:', e.message); return []; }
}
async function linkStatus(url) {
  try {
    const r = await fetch(url, { method: 'GET', redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TechTalentPortal link check)' }, signal: AbortSignal.timeout(12000) });
    return { code: r.status, final: r.url };
  } catch (e) { return { code: 0, error: e.name }; }
}

// ── Main ──────────────────────────────────────────────────────────────────
(async () => {
  const now = Date.now();
  let prev = { jobs: [], closed: [], sources: {}, builtIn: {} };
  try { prev = Object.assign(prev, JSON.parse(fs.readFileSync(OUT, 'utf8'))); } catch { log('no previous file — first run'); }
  // Earlier versions treated partial feeds as complete and wrongly marked still-open jobs
  // "No longer listed". Drop those markers so nobody sees an open job as closed.
  prev.closed = (prev.closed || []).filter(c => !(FEED_CONFIG[c.source] && !FEED_CONFIG[c.source].complete && /^No longer listed/.test(c.reason || '')));

  const sources = {}, open = [];
  for (const [name, fetcher] of Object.entries(FEEDS)) {
    const last = prev.sources[name] || {};
    const prevJobs = prev.jobs.filter(j => j.source === name);
    const cfg = FEED_CONFIG[name] || { cap: 100, complete: false };
    const stillValid = j => (!j.postedAt || now - Date.parse(j.postedAt) <= MAX_AGE_DAYS * DAY) && (!j.expiresAt || Date.parse(j.expiresAt) > now);
    if (cfg.minGapH && last.fetchedAt && now - Date.parse(last.fetchedAt) < cfg.minGapH * HOUR) {
      const prevKept = prevJobs.filter(stillValid);
      sources[name] = { ...last, status: 'reused', count: prevKept.length, note: `fetched at most every ${cfg.minGapH} h (source's request)` };
      open.push(...prevKept);
      log(`${name}: reused ${prevJobs.length} (fetched ${((now - Date.parse(last.fetchedAt)) / HOUR).toFixed(1)}h ago)`);
      continue;
    }
    try {
      if (argValue('--simulate-fail') === name) throw new Error('simulated outage');
      const raw = await fetcher();
      const jobs = raw.map(make).filter(j => j.url && isTech(j.title, j.tech))
        .filter(j => !j.postedAt || now - Date.parse(j.postedAt) <= MAX_AGE_DAYS * DAY)
        .sort((a, b) => Date.parse(b.postedAt || 0) - Date.parse(a.postedAt || 0))
        .filter(j => !j.expiresAt || Date.parse(j.expiresAt) > now)
        .slice(0, cfg.cap);
      if (!jobs.length) throw new Error(`no tech jobs in ${raw.length} results`);
      const nowIds = new Set(jobs.map(j => j.id));
      const closeIt = (j, reason) => prev.closed.push({ id: j.id, title: j.title, company: j.company, source: j.source, url: j.url, closedAt: new Date(now).toISOString(), reason });
      let merged = jobs;
      if (cfg.complete) {
        // Whole feed received: a job that disappeared has closed
        prevJobs.filter(j => !nowIds.has(j.id)).forEach(j => closeIt(j, stillValid(j) ? 'No longer listed by ' + name : 'Older than 30 days'));
      } else {
        // Partial feed: keep earlier jobs until they expire or turn 30 days old
        const carried = prevJobs.filter(j => !nowIds.has(j.id));
        carried.filter(j => !stillValid(j)).forEach(j => closeIt(j, j.expiresAt && Date.parse(j.expiresAt) <= now ? 'Listing expired' : 'Older than 30 days'));
        merged = [...jobs, ...carried.filter(stillValid)]
          .sort((a, b) => Date.parse(b.postedAt || 0) - Date.parse(a.postedAt || 0)).slice(0, Math.round(cfg.cap * 1.5));
      }
      sources[name] = { status: 'ok', fetchedAt: new Date(now).toISOString(), count: merged.length, scanned: raw.length };
      open.push(...merged);
      log(`${name}: ${jobs.length} tech jobs (scanned ${raw.length})`);
    } catch (e) {
      // Outage ≠ closure: keep what we had
      const kept = prevJobs.filter(j => !j.postedAt || now - Date.parse(j.postedAt) <= MAX_AGE_DAYS * DAY);
      sources[name] = { ...last, status: 'failed', error: String(e.message).slice(0, 120), failedAt: new Date(now).toISOString(), count: kept.length };
      open.push(...kept);
      log(`${name}: FAILED (${e.message}) — kept ${kept.length} previous jobs`);
    }
  }

  // Dedupe across feeds (same job posted on two boards)
  const seen = new Set();
  const jobs = open.filter(j => {
    const k1 = j.url.split('?')[0].toLowerCase(), k2 = (j.title + '|' + j.company).toLowerCase();
    if (seen.has(k1) || seen.has(k2)) return false;
    seen.add(k1); seen.add(k2); return true;
  }).sort((a, b) => Date.parse(b.postedAt || 0) - Date.parse(a.postedAt || 0));

  // Built-in job link checks (about once a day)
  const builtIn = prev.builtIn || {};
  if (LINK_CHECK) {
    for (const b of builtInJobs()) {
      const st = builtIn[b.id];
      if (st && st.status === 'closed') continue;
      if (st && st.checkedAt && now - Date.parse(st.checkedAt) < LINK_CHECK_GAP_H * HOUR) continue;
      const r = await linkStatus(b.url);
      const closed = r.code === 404 || r.code === 410;
      builtIn[b.id] = { status: closed ? 'closed' : 'open', code: r.code, checkedAt: new Date(now).toISOString(), ...(closed ? { closedAt: new Date(now).toISOString(), reason: `Link returns ${r.code}` } : {}) };
      if (closed) log(`built-in ${b.id}: closed (${r.code})`);
    }
  }

  // Keep closed records for a while; never list a job as both open and closed
  const openIds = new Set(jobs.map(j => j.id));
  const closedSeen = new Set();
  const closed = prev.closed
    .filter(c => !openIds.has(c.id) && now - Date.parse(c.closedAt) <= KEEP_CLOSED_DAYS * DAY)
    .filter(c => (closedSeen.has(c.id) ? false : closedSeen.add(c.id)));

  const out = {
    updatedAt: new Date(now).toISOString(),
    refreshEveryHours: 3,
    attribution: 'Jobs from Remote OK (remoteok.com), Remotive (remotive.com), Arbeitnow (arbeitnow.com), Himalayas (himalayas.app) and Jobicy (jobicy.com). Each job links to its original listing.',
    sources, jobs, closed, builtIn
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
  log(`wrote ${jobs.length} open, ${closed.length} closed → ${path.relative(ROOT, OUT)}`);
  if (!jobs.length) process.exitCode = 1;
})().catch(e => { console.error(e); process.exit(1); });
