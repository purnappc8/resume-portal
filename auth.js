/**
 * TechTalent Portal — Auth Guard + Nav Updater
 * Include this script in any page.
 * Usage: <script src="auth.js"></script>
 *
 * Public pages (no forced login):
 *   index.html, jobs.html, profile.html, login.html, submit.html, resume-builder.html
 * Protected pages: dashboard.html, post-job.html, and anything else
 */
(function () {
  'use strict';

  const KEY = 'ttp_session';
  const API = 'http://localhost:4747';

  function getSession() {
    try {
      const raw = sessionStorage.getItem(KEY) || localStorage.getItem(KEY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  function setSession(data, remember) {
    const json = JSON.stringify(data);
    try {
      sessionStorage.setItem(KEY, json);
      if (remember) localStorage.setItem(KEY, json);
    } catch {}
  }

  function clearSession() {
    try {
      sessionStorage.removeItem(KEY);
      localStorage.removeItem(KEY);
    } catch {}
  }

  function requireLogin() {
    const here = encodeURIComponent(location.pathname + location.search);
    location.replace('login.html?next=' + here);
  }

  // ── Update nav based on session ──────────────────────────────────────────
  // Supports two nav patterns:
  //  A) #navLoggedOut + #navLoggedIn + #navUserName  (index.html modal style)
  //  B) #navUser single link                          (resume-builder etc.)
  function updateNav() {
    const sess = getSession();
    const loggedOut = document.getElementById('navLoggedOut');
    const loggedIn  = document.getElementById('navLoggedIn');
    const userName  = document.getElementById('navUserName');
    const navUser   = document.getElementById('navUser');

    if (loggedOut && loggedIn) {
      // Pattern A
      if (sess && sess.token) {
        loggedOut.style.display = 'none';
        loggedIn.style.display  = 'flex';
        if (userName) userName.textContent = (sess.name || sess.email || 'User').split(' ')[0];
      } else {
        loggedOut.style.display = 'flex';
        loggedIn.style.display  = 'none';
      }
    } else if (navUser) {
      // Pattern B
      if (sess && sess.token) {
        navUser.textContent = (sess.name || sess.email || 'User').split(' ')[0];
        navUser.href = 'dashboard.html';
        navUser.style.fontWeight = '700';
        navUser.style.color = '#fff';
      } else {
        navUser.textContent = 'Sign In';
        navUser.href = 'login.html?next=' + encodeURIComponent(location.pathname.split('/').pop() || 'index.html');
      }
    }
  }

  // Expose globally
  window.TTP_AUTH = { getSession, setSession, clearSession, updateNav, API };

  // Global logout used by inline onclick handlers
  window.ttpLogout = function () {
    clearSession();
    location.href = 'index.html';
  };

  // ── Guard protected pages ────────────────────────────────────────────────
  const page = location.pathname.split('/').pop() || 'index.html';
  const PUBLIC = [
    'index.html', 'jobs.html', 'profile.html', 'login.html',
    'submit.html', 'resume-builder.html', ''
  ];
  if (!PUBLIC.includes(page)) {
    const sess = getSession();
    if (!sess || !sess.token) {
      requireLogin();
      return;
    }
  }

  // ── Update nav once DOM is ready ─────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', updateNav);
  } else {
    updateNav();
  }

})();
