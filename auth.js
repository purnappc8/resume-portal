/**
 * TechTalent Portal -- Auth Guard + Nav Updater
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

  // -- Update nav based on session ---------------------------------------------
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

  // -- Guard protected pages --------------------------------------------------
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

  // -- Update nav once DOM is ready ------------------------------------------
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() {
      updateNav();
      injectImpersonationBanner();
    });
  } else {
    updateNav();
    injectImpersonationBanner();
  }

  // -- Impersonation banner (shown on all portal pages when admin is "Login As")
  function injectImpersonationBanner() {
    const imp = sessionStorage.getItem('ttp_impersonating');
    if (!imp) return;
    let impData = {};
    try { impData = JSON.parse(imp); } catch { return; }
    if (document.getElementById('_ttp_imp_banner')) return; // already injected

    const bar = document.createElement('div');
    bar.id = '_ttp_imp_banner';
    bar.style.cssText = [
      'position:fixed','top:0','left:0','right:0','z-index:9999',
      'background:linear-gradient(90deg,#6a1b9a,#1565c0)','color:#fff',
      'padding:8px 20px','display:flex','align-items:center','justify-content:center',
      'gap:16px','font-size:14px','font-weight:700',
      'box-shadow:0 2px 8px rgba(0,0,0,.35)',
      'font-family:Segoe UI,Arial,sans-serif'
    ].join(';');
    bar.innerHTML = '<span>👁 Admin View — Logged in as <b>' +
      (impData.name || impData.email || 'User') + '</b></span>' +
      '<button onclick="window._ttpExitImpersonation()" style="background:rgba(255,255,255,.2);border:1px solid rgba(255,255,255,.5);color:#fff;padding:4px 14px;border-radius:6px;cursor:pointer;font-weight:700;font-size:13px">' +
      '✕ Exit &amp; Return to Admin</button>';
    document.body.insertBefore(bar, document.body.firstChild);
    // Push body content down so banner doesn't overlap page header
    var cur = parseInt(document.body.style.paddingTop || '0', 10);
    document.body.style.paddingTop = (cur + 42) + 'px';
  }

  window._ttpExitImpersonation = function() {
    var orig = sessionStorage.getItem('ttp_admin_orig_session');
    if (orig) {
      sessionStorage.setItem('ttp_session', orig);
      localStorage.setItem('ttp_session', orig);
    }
    sessionStorage.removeItem('ttp_impersonating');
    sessionStorage.removeItem('ttp_admin_orig_session');
    window.location.href = 'admin.html';
  };

})();
