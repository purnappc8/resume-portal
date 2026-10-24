/**
 * TechTalent Portal — job search service (Cloudflare Worker)
 *
 * Browse Jobs calls  GET /search?q=salesforce+developer&loc=india&type=contract
 * and this worker asks Jooble, Adzuna and (optionally) JSearch at the same time,
 * then returns one combined, de-duplicated list. API keys live only here, as
 * Cloudflare secrets — never in the website code.
 *
 * Secrets (Cloudflare → Workers → this worker → Settings → Variables and Secrets):
 *   JOOBLE_KEY        Jooble API key
 *   ADZUNA_APP_ID     Adzuna App ID
 *   ADZUNA_APP_KEY    Adzuna App Key
 *   RAPIDAPI_KEY      RapidAPI key with JSearch subscribed (optional)
 * Any source without a key is simply skipped.
 *
 * Results are cached for 6 hours per search, so repeated searches don't use quota.
 *   GET /health → which sources are configured (true/false only, never the keys)
 */

const ALLOWED_ORIGINS = [
  'https://purnappc8.github.io',
  'http://localhost:8812', 'http://127.0.0.1:8812', 'http://localhost:4747'
];
const CACHE_SECONDS = 6 * 60 * 60;
const PROVIDER_TIMEOUT_MS = 8000;
const MAX_RESULTS = 40;

// Adzuna has country sites; map our location filter → Adzuna country code
const ADZUNA_COUNTRY = { india: 'in', us: 'us', uk: 'gb' };
const ADZUNA_SUPPORTED = new Set(['at','au','be','br','ca','ch','de','es','fr','gb','in','it','mx','nl','nz','pl','sg','us','za']);
const PLACE = { india: 'India', us: 'United States', uk: 'United Kingdom' };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin'
    };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'GET') return json({ error: 'Use GET' }, 405, cors);

    if (url.pathname === '/health') {
      return json({
        ok: true,
        sources: {
          jooble: !!env.JOOBLE_KEY,
          adzuna: !!(env.ADZUNA_APP_ID && env.ADZUNA_APP_KEY),
          jsearch: !!env.RAPIDAPI_KEY
        }
      }, 200, cors);
    }
    if (url.pathname !== '/search') return json({ error: 'Not found' }, 404, cors);

    // ── Validate input ──────────────────────────────────────────────────────
    const q = (url.searchParams.get('q') || '').replace(/\s+/g, ' ').trim().slice(0, 100);
    const loc = (url.searchParams.get('loc') || '').toLowerCase();
    const type = (url.searchParams.get('type') || '').toLowerCase();
    const page = Math.min(Math.max(parseInt(url.searchParams.get('page') || '1', 10) || 1, 1), 5);
    if (q.length < 2) return json({ error: 'Type at least 2 characters.' }, 400, cors);
    if (loc && !['india', 'us', 'uk', 'remote'].includes(loc)) return json({ error: 'Unknown location.' }, 400, cors);
    if (type && !['contract', 'freelance', 'part-time', 'full-time'].includes(type)) return json({ error: 'Unknown job type.' }, 400, cors);

    // Visitor's country decides Adzuna's site when no location is chosen
    const visitorCountry = String((request.cf && request.cf.country) || '').toLowerCase();
    const params = { q, loc, type, page, visitorCountry };

    // ── Cache (per normalised search) ───────────────────────────────────────
    const cacheKey = new Request(`https://cache.techtalent/search?${new URLSearchParams({ q: q.toLowerCase(), loc, type, page, vc: loc ? '' : visitorCountry })}`);
    const cache = typeof caches !== 'undefined' ? caches.default : null;
    if (cache) {
      const hit = await cache.match(cacheKey);
      if (hit) {
        const body = await hit.json();
        return json({ ...body, cached: true }, 200, cors);
      }
    }

    const tasks = [];
    if (env.JOOBLE_KEY) tasks.push(run('jooble', () => jooble(params, env)));
    if (env.ADZUNA_APP_ID && env.ADZUNA_APP_KEY) tasks.push(run('adzuna', () => adzuna(params, env)));
    if (env.RAPIDAPI_KEY && page === 1) tasks.push(run('jsearch', () => jsearch(params, env)));   // small quota: first page only
    if (!tasks.length) return json({ error: 'No job sources are configured yet.', results: [], sources: {} }, 503, cors);

    const settled = await Promise.all(tasks);
    const sources = {}; let all = [];
    for (const s of settled) {
      sources[s.name] = s.ok ? { ok: true, count: s.results.length } : { ok: false, error: s.error };
      if (s.ok) all = all.concat(s.results);
    }

    // De-duplicate the same job seen on several services
    const seen = new Set();
    const results = all.filter(j => {
      if (!j.title || !j.url) return false;
      const k = (j.title + '|' + j.company).toLowerCase().replace(/[^a-z0-9|]/g, '');
      if (seen.has(k)) return false;
      seen.add(k); return true;
    }).sort((a, b) => (Date.parse(b.postedAt || 0) || 0) - (Date.parse(a.postedAt || 0) || 0))
      .slice(0, MAX_RESULTS);

    const body = { query: { q, loc, type, page }, results, sources, fetchedAt: new Date().toISOString(), cached: false };
    // Cache only when at least one source answered
    if (cache && settled.some(s => s.ok)) {
      ctx.waitUntil(cache.put(cacheKey, new Response(JSON.stringify(body), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${CACHE_SECONDS}` }
      })));
    }
    return json(body, 200, cors);
  }
};

// ── Providers ───────────────────────────────────────────────────────────────
async function jooble({ q, loc, type, page }, env) {
  const keywords = [q, type === 'contract' || type === 'freelance' ? type : '', loc === 'remote' ? 'remote' : ''].filter(Boolean).join(' ');
  const r = await timed(`https://jooble.org/api/${encodeURIComponent(env.JOOBLE_KEY)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keywords, location: PLACE[loc] || '', page: String(page) })
  });
  const d = await r.json();
  return (d.jobs || []).map(j => norm({
    id: 'jooble_' + (j.id || j.link),
    title: j.title, company: j.company, location: j.location,
    type: j.type, salary: j.salary, url: j.link, postedAt: j.updated,
    via: j.source, provider: 'Jooble', snippet: j.snippet
  }));
}

async function adzuna({ q, loc, type, page, visitorCountry }, env) {
  let country = ADZUNA_COUNTRY[loc] || (ADZUNA_SUPPORTED.has(visitorCountry) ? visitorCountry : 'in');
  const p = new URLSearchParams({
    app_id: env.ADZUNA_APP_ID, app_key: env.ADZUNA_APP_KEY,
    results_per_page: '20', what: loc === 'remote' ? `${q} remote` : q,
    max_days_old: '30', sort_by: 'date', 'content-type': 'application/json'
  });
  if (type === 'contract' || type === 'freelance') p.set('contract', '1');
  if (type === 'part-time') p.set('part_time', '1');
  if (type === 'full-time') p.set('full_time', '1');
  const r = await timed(`https://api.adzuna.com/v1/api/jobs/${country}/search/${page}?${p}`);
  const d = await r.json();
  return (d.results || []).map(j => norm({
    id: 'adzuna_' + j.id,
    title: j.title, company: j.company && j.company.display_name,
    location: j.location && j.location.display_name,
    type: [j.contract_type, j.contract_time].filter(Boolean).join(' '),
    salary: money(j.salary_min, j.salary_max, country === 'in' ? '₹' : country === 'gb' ? '£' : '$', j.salary_is_predicted === '1'),
    url: j.redirect_url, postedAt: j.created, via: 'Adzuna', provider: 'Adzuna', snippet: j.description
  }));
}

async function jsearch({ q, loc, type }, env) {
  const p = new URLSearchParams({
    query: loc === 'remote' ? `${q} remote` : (PLACE[loc] ? `${q} in ${PLACE[loc]}` : q),
    page: '1', num_pages: '1', date_posted: 'month'
  });
  if (loc === 'remote') p.set('work_from_home', 'true');
  if (loc === 'india') p.set('country', 'in'); else if (loc === 'uk') p.set('country', 'gb'); else if (loc === 'us') p.set('country', 'us');
  if (type === 'contract' || type === 'freelance') p.set('employment_types', 'CONTRACTOR');
  if (type === 'part-time') p.set('employment_types', 'PARTTIME');
  if (type === 'full-time') p.set('employment_types', 'FULLTIME');
  const r = await timed(`https://jsearch.p.rapidapi.com/search?${p}`, {
    headers: { 'x-rapidapi-key': env.RAPIDAPI_KEY, 'x-rapidapi-host': 'jsearch.p.rapidapi.com' }
  });
  const d = await r.json();
  return (d.data || []).map(j => norm({
    id: 'jsearch_' + j.job_id,
    title: j.job_title, company: j.employer_name,
    location: j.job_location || [j.job_city, j.job_state, j.job_country].filter(Boolean).join(', ') || (j.job_is_remote ? 'Remote' : ''),
    type: j.job_employment_type,
    salary: money(j.job_min_salary, j.job_max_salary, ({ USD: '$', INR: '₹', GBP: '£', EUR: '€', CAD: 'C$', AUD: 'A$' })[j.job_salary_currency] || '', false, j.job_salary_period),
    url: j.job_apply_link, postedAt: j.job_posted_at_datetime_utc,
    via: j.job_publisher, provider: 'JSearch', remote: !!j.job_is_remote
  }));
}

// ── Helpers ─────────────────────────────────────────────────────────────────
async function run(name, fn) {
  try { return { name, ok: true, results: await fn() }; }
  catch (e) { return { name, ok: false, error: String(e && e.message || e).replace(/[?&](app_key|app_id)=[^&\s]+/g, '').slice(0, 120), results: [] }; }
}
async function timed(url, init = {}) {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r;
}
function clean(s, max) {
  return String(s == null ? '' : s).replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&amp;|&#\d+;|&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
function money(min, max, sym = '', predicted = false, period = '') {
  min = +min || 0; max = +max || 0;
  if (!min && !max) return '';
  const f = n => sym + (n >= 100000 ? (sym === '₹' ? (n / 100000).toFixed(1).replace(/\.0$/, '') + 'L' : Math.round(n / 1000) + 'K') : n >= 1000 ? Math.round(n / 1000) + 'K' : Math.round(n));
  const range = min && max && max !== min ? `${f(min)}–${f(max)}` : f(min || max);
  const per = period ? '/' + String(period).toLowerCase().replace('year', 'yr').replace('hour', 'hr').replace('month', 'mo') : '';
  return (predicted ? '~' : '') + range + per;
}
function jobType(t) {
  const s = String(t || '').toLowerCase();
  if (/freelance/.test(s)) return 'Freelance';
  if (/contract/.test(s)) return 'Contract';
  if (/part/.test(s)) return 'Part-time';
  if (/intern/.test(s)) return 'Internship';
  if (/full|permanent/.test(s)) return 'Full-time';
  return '';
}
function norm(o) {
  const url = String(o.url || '');
  return {
    id: clean(o.id, 120),
    title: clean(o.title, 140),
    company: clean(o.company, 90) || 'Company not listed',
    location: clean(o.location, 90) || (o.remote ? 'Remote' : ''),
    type: jobType(o.type),
    salary: clean(o.salary, 40),
    url: /^https?:\/\//i.test(url) ? url : '',      // only real web links
    postedAt: o.postedAt && !isNaN(Date.parse(o.postedAt)) ? new Date(o.postedAt).toISOString() : null,
    via: clean(o.via, 40),
    provider: o.provider,
    snippet: clean(o.snippet, 220)
  };
}
function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });
}
