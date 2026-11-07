/**
 * location.js — TechTalent Portal shared location utility
 * Features:
 *   • Geolocation → Nominatim reverse-geocode
 *   • 30-min localStorage cache
 *   • Device fingerprint registration on first grant
 *   • watchPosition live tracking while page is open
 *   • localStorage log (max 500) + server POST /location/log
 *   • Fires CustomEvent 'ttp:location-ready' with resolved data
 */

const API = 'http://localhost:4747';
const CACHE_KEY     = 'ttp_user_location';
const LOG_KEY       = 'ttp_location_log';
const DEVICE_ID_KEY = 'ttp_device_id';
const CACHE_TTL     = 30 * 60 * 1000;   // 30 min

// ── Helpers ──────────────────────────────────────────────────────────────────
function getSession() {
  try { return JSON.parse(sessionStorage.getItem('ttp_session') || localStorage.getItem('ttp_session') || 'null'); } catch { return null; }
}

function getOrCreateDeviceId() {
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = 'dev_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}

function getCache() {
  try {
    const c = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    if (c && c.cachedAt && (Date.now() - c.cachedAt) < CACHE_TTL) return c;
  } catch {}
  return null;
}

function saveCache(loc) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify({ ...loc, cachedAt: Date.now() })); } catch {}
}

function appendLocalLog(entry) {
  try {
    const log = JSON.parse(localStorage.getItem(LOG_KEY) || '[]');
    log.push(entry);
    if (log.length > 500) log.splice(0, log.length - 500);
    localStorage.setItem(LOG_KEY, JSON.stringify(log));
  } catch {}
}

async function postLog(entry) {
  try {
    await fetch(API + '/location/log', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entry), signal: AbortSignal.timeout(5000)
    });
  } catch {}
}

async function reverseGeocode(lat, lng) {
  try {
    const r = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&accept-language=en`,
      { headers: { 'User-Agent': 'TechTalentPortal/1.0' }, signal: AbortSignal.timeout(6000) }
    );
    const d = await r.json();
    const a = d.address || {};
    return {
      city:        a.city || a.town || a.village || a.county || '',
      state:       a.state || '',
      country:     a.country || '',
      countryCode: (a.country_code || '').toUpperCase(),
      display:     d.display_name || '',
      raw:         a
    };
  } catch {
    return { city: '', state: '', country: '', countryCode: '', display: '', raw: {} };
  }
}

function buildEntry(lat, lng, accuracy, geo) {
  const sess = getSession();
  return {
    lat, lng, accuracy,
    city: geo.city, state: geo.state, country: geo.country,
    countryCode: geo.countryCode, display: geo.display,
    ts: new Date().toISOString(),
    userId:    sess?.id    || null,
    userEmail: sess?.email || null,
    userRole:  sess?.role  || null,
    deviceId:  getOrCreateDeviceId(),
    page:      location.pathname,
    referrer:  document.referrer,
    ua:        navigator.userAgent,
    visitedAt: new Date().toISOString()
  };
}

function dispatchLocationReady(loc) {
  window.TTP_LOCATION = loc;
  document.dispatchEvent(new CustomEvent('ttp:location-ready', { detail: loc }));
}

// ── Device Registration ───────────────────────────────────────────────────────
async function registerDevice(lat, lng, geo) {
  const deviceId = getOrCreateDeviceId();
  const registered = localStorage.getItem('ttp_device_registered_' + deviceId);
  const sess = getSession();
  try {
    await fetch(API + '/device/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceId,
        userId:      sess?.id    || null,
        userEmail:   sess?.email || null,
        userRole:    sess?.role  || null,
        ua:          navigator.userAgent,
        platform:    navigator.platform || '',
        screen:      `${screen.width}x${screen.height}`,
        timezone:    Intl.DateTimeFormat().resolvedOptions().timeZone,
        lang:        navigator.language,
        lat, lng,
        city:        geo.city,
        state:       geo.state,
        country:     geo.country,
        countryCode: geo.countryCode
      }),
      signal: AbortSignal.timeout(5000)
    });
    // Mark registered so we only send full fingerprint once per device,
    // but we still update lastSeen on every page load via postLog
    if (!registered) localStorage.setItem('ttp_device_registered_' + deviceId, '1');
  } catch {}
}

// ── Live tracking (watchPosition) ─────────────────────────────────────────────
let _watchId = null;
let _lastLivePush = 0;

function startLiveTracking() {
  if (!navigator.geolocation || _watchId !== null) return;
  _watchId = navigator.geolocation.watchPosition(
    async (pos) => {
      const { latitude: lat, longitude: lng, accuracy } = pos.coords;
      const now = Date.now();
      // throttle: push to server at most once every 2 minutes
      if (now - _lastLivePush < 30_000) return;
      _lastLivePush = now;
      // quick geocode only if we don't have a recent city
      const cached = getCache();
      const geo = cached?.city
        ? { city: cached.city, state: cached.state, country: cached.country, countryCode: cached.countryCode, display: cached.display }
        : await reverseGeocode(lat, lng);
      const entry = buildEntry(lat, lng, accuracy, geo);
      appendLocalLog(entry);
      postLog(entry);
      // Update window.TTP_LOCATION with fresh coords
      const loc = { lat, lng, accuracy, ...geo };
      window.TTP_LOCATION = loc;
      document.dispatchEvent(new CustomEvent('ttp:location-update', { detail: loc }));
    },
    (err) => { /* silently ignore — user may deny */ },
    { enableHighAccuracy: false, timeout: 15000, maximumAge: 60000 }
  );
}

function stopLiveTracking() {
  if (_watchId !== null) {
    navigator.geolocation.clearWatch(_watchId);
    _watchId = null;
  }
}

// ── Main collect function ─────────────────────────────────────────────────────
async function ttpCollectLocation() {
  if (!navigator.geolocation) return null;

  // Return cached if still fresh
  const cached = getCache();
  if (cached) {
    dispatchLocationReady(cached);
    startLiveTracking();
    return cached;
  }

  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { latitude: lat, longitude: lng, accuracy } = pos.coords;
        const geo = await reverseGeocode(lat, lng);
        const loc = { lat, lng, accuracy, ...geo };

        saveCache(loc);
        const entry = buildEntry(lat, lng, accuracy, geo);
        appendLocalLog(entry);
        postLog(entry);

        // Register device (sends full fingerprint)
        registerDevice(lat, lng, geo);

        dispatchLocationReady(loc);
        startLiveTracking();
        resolve(loc);
      },
      (err) => resolve(null),
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 }
    );
  });
}


// Send a final ping when user closes/navigates away
window.addEventListener('beforeunload', () => {
  if (!window.TTP_LOCATION) return;
  const loc = window.TTP_LOCATION;
  const sess = getSession();
  const entry = {
    ...loc,
    ts: new Date().toISOString(),
    event: 'page_unload',
    userId:    sess?.id    || null,
    userEmail: sess?.email || null,
    userRole:  sess?.role  || null,
    deviceId:  getOrCreateDeviceId(),
    page:      location.pathname
  };
  // Use sendBeacon so it fires even as page closes
  try {
    navigator.sendBeacon(API + '/location/log', JSON.stringify(entry));
  } catch {}
});

// Auto-collect silently on every page load
window.ttpCollectLocation = ttpCollectLocation;
(function autoCollect() {
  // Don't auto-prompt on first ever visit — only collect if already cached or user clicks
  const cached = getCache();
  if (cached) {
    dispatchLocationReady(cached);
    startLiveTracking();
  }
  // Always attempt after a small delay (browser may already have permission)
  setTimeout(() => ttpCollectLocation(), 1500);
})();
