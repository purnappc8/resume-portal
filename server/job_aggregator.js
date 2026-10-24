/**
 * TechTalent Portal — Job Aggregator
 * Pulls live IT/Salesforce freelance jobs from free public APIs with zero API keys.
 *
 * Sources:
 *   1. RemoteOK      – JSON API, no auth
 *   2. Remotive      – JSON API, no auth
 *   3. Arbeitnow     – JSON API, no auth
 *   4. Indeed RSS    – RSS/XML feed, no auth
 *
 * Auto-refreshes every REFRESH_INTERVAL ms.
 * Results cached to DATA_DIR/live_jobs.json.
 */

const fs   = require('fs');
const path = require('path');

const REFRESH_INTERVAL = 2 * 60 * 60 * 1000; // 2 hours

// Keywords to target for IT/Salesforce freelance roles
const SEARCH_TERMS = ['salesforce', 'apex', 'lwc', 'java', 'python', 'react', 'devops', 'aws', 'azure', 'node.js', 'cloud'];

function log(msg) { console.log(`[JobAgg] ${new Date().toLocaleTimeString()} — ${msg}`); }

// ── Normalise a raw job from any source into our portal schema ──────────────
function norm(id, title, company, location, type, exp, tech, salary, source, url, desc, postedDays) {
  return {
    id:         'live_' + source.replace(/\s/g,'_') + '_' + id,
    title:      (title  || '').slice(0,120),
    company:    (company|| 'Unknown').slice(0,80),
    location:   location || 'Remote',
    type:       type     || 'Contract',
    exp:        exp      || 'Mid',
    tech:       Array.isArray(tech) ? tech.slice(0,8) : [],
    salary:     salary   || '',
    source,
    url:        url      || '#',
    desc:       (desc    || '').slice(0,300),
    postedDays: typeof postedDays === 'number' ? postedDays : 0,
    live:       true,
    fetchedAt:  new Date().toISOString()
  };
}

// ── Extract tech tags from title/desc ───────────────────────────────────────
function extractTech(text) {
  const MAP = [
    ['Salesforce','salesforce','sfdc','sfmc','pardot','marketing cloud'],
    ['Apex','apex'],
    ['LWC','lwc','lightning web'],
    ['CPQ','cpq'],
    ['Java','java','spring boot','spring'],
    ['Python','python','django','flask','fastapi'],
    ['React','react','reactjs'],
    ['Node.js','node.js','nodejs'],
    ['AWS','aws','amazon web services'],
    ['Azure','azure','microsoft azure'],
    ['GCP','gcp','google cloud'],
    ['DevOps','devops','ci/cd','cicd','jenkins','gitlab'],
    ['Kubernetes','kubernetes','k8s'],
    ['Docker','docker','containeriz'],
    ['AI/ML','machine learning','ml model','llm','nlp','tensorflow','pytorch','artificial intelligence'],
    ['Data','data engineer','data science','databricks','spark','hadoop','sql','postgres','mysql'],
    ['.NET','dotnet','.net','c#'],
    ['SAP','sap'],
    ['iOS','ios','swift','swiftui'],
    ['Android','android','kotlin'],
    ['React Native','react native'],
    ['TypeScript','typescript'],
    ['Go','golang'],
    ['Rust','rust lang'],
  ];
  const t = (text||'').toLowerCase();
  return MAP.filter(([, ...kws]) => kws.some(kw => t.includes(kw))).map(([label]) => label);
}

// ── Source 1: RemoteOK JSON API ─────────────────────────────────────────────
async function fetchRemoteOK() {
  const results = [];
  try {
    // RemoteOK serves all remote tech jobs; filter client-side
    const r = await fetch('https://remoteok.com/api', {
      headers: { 'User-Agent': 'TechTalent-Portal/1.0' },
      signal: AbortSignal.timeout(10000)
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    const items = Array.isArray(data) ? data.slice(1) : []; // first item is metadata
    for (const j of items) {
      if (!j.position) continue;
      const titleLow = (j.position + ' ' + (j.tags||[]).join(' ')).toLowerCase();
      if (!SEARCH_TERMS.some(kw => titleLow.includes(kw))) continue;
      const days = j.date ? Math.floor((Date.now() - new Date(j.date*1000)) / 86400000) : 1;
      const tech = extractTech(j.position + ' ' + (j.tags||[]).join(' ') + ' ' + (j.description||''));
      results.push(norm(
        j.id || j.slug || String(j.epoch),
        j.position,
        j.company,
        j.location || 'Remote',
        'Contract',
        'Mid',
        tech.length ? tech : (j.tags || []).slice(0,5),
        j.salary || '',
        'RemoteOK',
        j.url || `https://remoteok.com/remote-jobs/${j.slug}`,
        (j.description||'').replace(/<[^>]+>/g,' ').slice(0,250),
        Math.max(0,days)
      ));
    }
    log(`RemoteOK: ${results.length} IT jobs`);
  } catch(e) { log(`RemoteOK error: ${e.message}`); }
  return results;
}

// ── Source 2: Remotive JSON API ─────────────────────────────────────────────
async function fetchRemotive() {
  const results = [];
  try {
    const cats = ['software-dev','devops-sysadmin','data','product'];
    for (const cat of cats) {
      const r = await fetch(`https://remotive.com/api/remote-jobs?category=${cat}&limit=50`, {
        signal: AbortSignal.timeout(10000)
      });
      if (!r.ok) continue;
      const data = await r.json();
      const jobs = (data.jobs || []);
      for (const j of jobs) {
        const blob = (j.title + ' ' + j.description).toLowerCase();
        if (!SEARCH_TERMS.some(kw => blob.includes(kw))) continue;
        const days = j.publication_date ? Math.floor((Date.now() - new Date(j.publication_date)) / 86400000) : 1;
        const tech = extractTech(j.title + ' ' + j.description + ' ' + (j.tags||[]).join(' '));
        results.push(norm(
          String(j.id),
          j.title,
          j.company_name,
          j.candidate_required_location || 'Remote',
          j.job_type || 'Contract',
          'Mid',
          tech,
          j.salary || '',
          'Remotive',
          j.url,
          (j.description||'').replace(/<[^>]+>/g,' ').slice(0,250),
          Math.max(0,days)
        ));
      }
    }
    log(`Remotive: ${results.length} IT jobs`);
  } catch(e) { log(`Remotive error: ${e.message}`); }
  return results;
}

// ── Source 3: Arbeitnow JSON API ────────────────────────────────────────────
async function fetchArbeitnow() {
  const results = [];
  try {
    const terms = ['salesforce','java developer','python developer','react developer','devops engineer','cloud engineer'];
    for (const q of terms) {
      const url = `https://www.arbeitnow.com/api/job-board-api?search=${encodeURIComponent(q)}&remote=true`;
      const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) continue;
      const data = await r.json();
      for (const j of (data.data || [])) {
        const days = j.created_at ? Math.floor((Date.now() - new Date(j.created_at*1000)) / 86400000) : 1;
        const tech = extractTech(j.title + ' ' + (j.description||'') + ' ' + (j.tags||[]).join(' '));
        results.push(norm(
          j.slug || String(j.created_at),
          j.title,
          j.company_name,
          j.location || (j.remote ? 'Remote' : ''),
          j.job_types && j.job_types.length ? j.job_types[0] : 'Contract',
          'Mid',
          tech.length ? tech : (j.tags||[]).slice(0,5),
          '',
          'Arbeitnow',
          j.url || 'https://www.arbeitnow.com',
          (j.description||'').replace(/<[^>]+>/g,' ').slice(0,250),
          Math.max(0,days)
        ));
      }
    }
    log(`Arbeitnow: ${results.length} IT jobs`);
  } catch(e) { log(`Arbeitnow error: ${e.message}`); }
  return results;
}

// ── Source 4: Indeed RSS ────────────────────────────────────────────────────
async function fetchIndeedRSS() {
  const results = [];
  const queries = [
    'salesforce+developer+freelance+remote',
    'salesforce+architect+remote+contract',
    'java+developer+remote+contract',
    'python+developer+remote+freelance',
    'devops+engineer+remote+contract',
    'react+developer+remote+contract',
    'aws+cloud+engineer+remote+contract',
  ];
  for (const q of queries) {
    try {
      const rssUrl = `https://www.indeed.com/rss?q=${q}&l=Remote&sort=date&limit=20`;
      const r = await fetch(rssUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TechTalentPortal/1.0)' },
        signal: AbortSignal.timeout(8000)
      });
      if (!r.ok) continue;
      const xml = await r.text();
      const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)];
      for (let i = 0; i < items.length; i++) {
        const m = items[i][1];
        const get = (tag) => {
          const t = m.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>|<${tag}[^>]*>([^<]*)</${tag}>`));
          return t ? (t[1]||t[2]||'').trim() : '';
        };
        const title   = get('title').replace(/&amp;/g,'&');
        const link    = get('link').replace(/&amp;/g,'&');
        const company = get('source');
        const pubDate = get('pubDate');
        const desc    = get('description').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').slice(0,250);
        if (!title) continue;
        const days = pubDate ? Math.max(0, Math.floor((Date.now()-new Date(pubDate))/86400000)) : 0;
        const tech = extractTech(title + ' ' + desc);
        results.push(norm(
          'ind_' + q.slice(0,8) + '_' + i,
          title,
          company || 'Via Indeed',
          'Remote',
          'Contract',
          'Mid',
          tech,
          '',
          'Indeed',
          link,
          desc,
          days
        ));
      }
    } catch(e) { log(`Indeed RSS (${q}): ${e.message}`); }
  }
  log(`Indeed RSS: ${results.length} jobs total`);
  return results;
}

// ── Source 5: The Muse API (no key needed for public jobs) ──────────────────
async function fetchTheMuse() {
  const results = [];
  try {
    const r = await fetch('https://www.themuse.com/api/public/jobs?level=mid%20level&level=senior%20level&category=software-engineer&page=0&descending=true', {
      signal: AbortSignal.timeout(8000)
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    for (const j of (data.results || [])) {
      const blob = (j.name + ' ' + (j.contents||'')).toLowerCase();
      if (!SEARCH_TERMS.some(kw => blob.includes(kw))) continue;
      const days = j.publication_date ? Math.floor((Date.now()-new Date(j.publication_date))/86400000) : 1;
      const tech = extractTech(j.name + ' ' + (j.contents||''));
      results.push(norm(
        String(j.id),
        j.name,
        (j.company && j.company.name) || 'Unknown',
        (j.locations || []).map(l=>l.name).join(', ') || 'Remote',
        'Full-time',
        'Mid',
        tech,
        '',
        'TheMuse',
        j.refs && j.refs.landing_page ? j.refs.landing_page : 'https://www.themuse.com/jobs',
        (j.contents||'').replace(/<[^>]+>/g,' ').slice(0,250),
        Math.max(0,days)
      ));
    }
    log(`TheMuse: ${results.length} IT jobs`);
  } catch(e) { log(`TheMuse error: ${e.message}`); }
  return results;
}

// ── Main aggregation loop ────────────────────────────────────────────────────
async function aggregate(dataDir) {
  log('Starting aggregation from all sources...');
  const [rok, rem, arb, ind, mus] = await Promise.allSettled([
    fetchRemoteOK(),
    fetchRemotive(),
    fetchArbeitnow(),
    fetchIndeedRSS(),
    fetchTheMuse()
  ]);

  const all = [
    ...(rok.status==='fulfilled' ? rok.value : []),
    ...(rem.status==='fulfilled' ? rem.value : []),
    ...(arb.status==='fulfilled' ? arb.value : []),
    ...(ind.status==='fulfilled' ? ind.value : []),
    ...(mus.status==='fulfilled' ? mus.value : []),
  ];

  // Dedup by URL
  const seen = new Set();
  const deduped = all.filter(j => {
    const key = (j.url||j.id).split('?')[0];
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Sort: freshest first
  deduped.sort((a,b) => (a.postedDays||0) - (b.postedDays||0));

  const out = path.join(dataDir, 'live_jobs.json');
  fs.writeFileSync(out, JSON.stringify(deduped, null, 2));
  log(`Done: ${deduped.length} unique jobs saved (RemoteOK:${rok.value?.length||0} Remotive:${rem.value?.length||0} Arbeitnow:${arb.value?.length||0} Indeed:${ind.value?.length||0} TheMuse:${mus.value?.length||0})`);
  return deduped;
}

function readCache(dataDir) {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'live_jobs.json'), 'utf8')); }
  catch { return []; }
}

function startAutoRefresh(dataDir) {
  // Run immediately on startup
  aggregate(dataDir).catch(e => log('Aggregate error: ' + e.message));
  // Then every 2 hours
  setInterval(() => {
    aggregate(dataDir).catch(e => log('Aggregate error: ' + e.message));
  }, REFRESH_INTERVAL);
  log(`Auto-refresh every ${REFRESH_INTERVAL/3600000}h scheduled.`);
}

module.exports = { startAutoRefresh, readCache, aggregate };
