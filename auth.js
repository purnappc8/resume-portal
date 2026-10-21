/**
 * TechTalent Portal — Auth Guard
 * Include this script in any page that requires login.
 * Usage: <script src="auth.js"></script>  (place in <head> or early <body>)
 * Pages that are always public: index.html, jobs.html, profile.html, login.html,
 * submit.html (candidates can post a resume as a guest; signing in is optional)
 */
(function () {
  'use strict';

  const KEY = 'ttp_session';
  const API = 'http://localhost:4747';

  // Returns the stored session object or null
  function getSession() {
    try {
      const raw = sessionStorage.getItem(KEY) || localStorage.getItem(KEY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  // Store session (optionally persist across tabs with localStorage)
  function setSession(data, remember) {
    const json = JSON.stringify(data);
    try {
      sessionStorage.setItem(KEY, json);
      if (remember) localStorage.setItem(KEY, json);
    } catch {}
  }

  // Clear session (logout)
  function clearSession() {
    try {
      sessionStorage.removeItem(KEY);
      localStorage.removeItem(KEY);
    } catch {}
  }

  // Redirect to login, preserving where the user wanted to go
  function requireLogin() {
    const here = encodeURIComponent(location.pathname + location.search);
    location.replace('login.html?next=' + here);
  }

  // Expose helpers globally
  window.TTP_AUTH = { getSession, setSession, clearSession, API };

  // ── GUARD: if this script runs on a protected page, block immediately ──
  const page = location.pathname.split('/').pop() || 'index.html';
  const PUBLIC = ['index.html', 'jobs.html', 'profile.html', 'login.html', 'submit.html', ''];
  if (!PUBLIC.includes(page)) {
    const sess = getSession();
    if (!sess || !sess.token) {
      requireLogin();
    }
  }
})();
