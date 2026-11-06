/**
 * TechTalent Portal — Location Utility
 * Collects browser geolocation, reverse-geocodes via Nominatim,
 * saves to localStorage, and POSTs a log entry to the server
 * for model-learning data.
 *
 * Usage: include this script on any page. It runs automatically.
 * Access results: window.TTP_LOCATION (populated after resolution)
 */

(function () {
  'use strict';

  const API        = 'http://localhost:4747';
  const CACHE_KEY  = 'ttp_user_location';
  const LOG_KEY    = 'ttp_location_log';
  const CACHE_TTL  = 30 * 60 * 1000; // 30 min — re-ask if stale

  // ── helpers ────────────────────────────────────────────────────────────────
  function getSession() {
    try { return JSON.parse(sessionStorage.getItem('ttp_session') || localStorage.getItem('ttp_session') || 'null'); } catch { return null; }
  }

  function loadCache() {
    try { return JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); } catch { return null; }
  }

  function saveCache(loc) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(loc)); } catch {}
  }

  // Append to local log array (for ML replay / offline)
  function appendLocalLog(entry) {
    try {
      const log = JSON.parse(localStorage.getItem(LOG_KEY) || '[]');
      log.push(entry);
      // keep last 500 entries
      if (log.length > 500) log.splice(0, log.length - 500);
      localStorage.setItem(LOG_KEY, JSON.stringify(log));
    } catch {}
  }

  // POST to server for persistent ML data
  async function postLog(entry) {
    try {
      await fetch(`${API}/location/log`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(entry),
        signal: AbortSignal.timeout(5000)
      });
    } catch {
      // offline — already saved locally above
    }
  }

  // Reverse-geocode using Nominatim (no API key, free)
  async function reverseGeocode(lat, lng) {
    try {
      const r = await fetch(
        `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&accept-language=en`,
        { headers: { 'User-Agent': 'TechTalentPortal/1.0' }, signal: AbortSignal.timeout(6000) }
      );
      if (!r.ok) return null;
      const d = await r.json();
      return {
        city:    d.address?.city || d.address?.town || d.address?.village || d.address?.county || '',
        state:   d.address?.state || '',
        country: d.address?.country || '',
        countryCode: (d.address?.country_code || '').toUpperCase(),
        display: d.display_name || '',
        raw:     d.address
      };
    } catch { return null; }
  }

  // ── main ───────────────────────────────────────────────────────────────────
  async function collectLocation() {
    // 1. Return cached location if still fresh
    const cached = loadCache();
    if (cached && cached.ts && (Date.now() - cached.ts) < CACHE_TTL) {
      window.TTP_LOCATION = cached;
      dispatchLocationReady(cached);
      return cached;
    }

    // 2. Check browser support
    if (!navigator.geolocation) return null;

    // 3. Ask for permission — returns a promise
    return new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        async (pos) => {
          const { latitude: lat, longitude: lng, accuracy } = pos.coords;
          const geo = await reverseGeocode(lat, lng);
          const sess = getSession();

          const loc = {
            lat, lng, accuracy,
            city:    geo?.city    || '',
            state:   geo?.state   || '',
            country: geo?.country || '',
            countryCode: geo?.countryCode || '',
            display: geo?.display || '',
            ts: Date.now()
          };

          saveCache(loc);
          window.TTP_LOCATION = loc;

          // Build log entry for ML
          const entry = {
            ...loc,
            userId:    sess?.id    || null,
            userEmail: sess?.email || null,
            userRole:  sess?.role  || null,
            page:      location.pathname.split('/').pop() || 'index.html',
            referrer:  document.referrer || null,
            ua:        navigator.userAgent,
            visitedAt: new Date().toISOString()
          };

          appendLocalLog(entry);
          postLog(entry);           // fire-and-forget
          dispatchLocationReady(loc);
          resolve(loc);
        },
        (err) => {
          // Permission denied or error — not fatal
          console.info('[TTP] Geolocation:', err.message);
          resolve(null);
        },
        { enableHighAccuracy: false, timeout: 10000, maximumAge: CACHE_TTL }
      );
    });
  }

  // Fire a custom event so pages can react
  function dispatchLocationReady(loc) {
    document.dispatchEvent(new CustomEvent('ttp:location-ready', { detail: loc }));
  }

  // ── kick off ───────────────────────────────────────────────────────────────
  // Run after DOM is ready (doesn't need to block rendering)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', collectLocation);
  } else {
    // slight delay so the page renders first
    setTimeout(collectLocation, 500);
  }

  // Expose for manual calls
  window.ttpCollectLocation = collectLocation;

})();
