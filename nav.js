/* nav.js — one shared top menu for every page.
 *
 * Usage (replaces a page's own <nav>):
 *   <nav class="topnav" id="siteNav"></nav>
 *   <script src="nav.js"></script>
 *
 * The script runs synchronously right after the empty <nav>, so the menu exists
 * before any later page script runs. It owns the signed-in look (reads the shared
 * `ttp_session` written by login.html), Sign Out, and the notification bell.
 * Hidden stub elements keep older page code that still looks up its previous menu
 * ids (navAuthBtn, navUser, nav-login, …) from failing.
 */
(function () {
  var nav = document.getElementById('siteNav');
  if (!nav) return;

  // ── Session ────────────────────────────────────────────────────────────────
  function readSession() {
    try {
      var raw = sessionStorage.getItem('ttp_session') || localStorage.getItem('ttp_session');
      var s = raw ? JSON.parse(raw) : null;
      if (s && s.token && s.token !== 'guest') return s;
    } catch (e) {}
    try {
      var u = JSON.parse(localStorage.getItem('ttp_user') || 'null');
      if (u && (u.name || u.email)) return { token: 'legacy', name: u.name, email: u.email };
    } catch (e) {}
    return null;
  }
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var page = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
  var here = encodeURIComponent(page);
  var LINKS = [
    ['index.html', 'Browse Talent'],
    ['jobs.html', 'Browse Jobs'],
    ['resume-builder.html', 'Resume Builder'],
    ['submit.html', 'Post Resume'],
    ['post-job.html', 'Post a Job']
  ];

  // ── Styles (scoped to #siteNav so page CSS can't make menus differ) ─────────
  var css = '' +
    'main{min-width:0;}.main-wrap>*{min-width:0;}#siteNav{background:#0b2e59;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:0 32px;height:56px;position:sticky;top:0;z-index:200;font-family:"Segoe UI",Arial,sans-serif;box-sizing:border-box;}' +
    '#siteNav *{box-sizing:border-box;}' +
    '#siteNav .logo{color:#fff;font-size:1.2rem;font-weight:700;text-decoration:none;letter-spacing:.3px;white-space:nowrap;}' +
    '#siteNav .logo span{color:#7ec8f7;}' +
    '#siteNav .nav-links{display:flex;gap:4px;align-items:center;}' +
    '#siteNav .nav-links a{color:rgba(255,255,255,.8);text-decoration:none;padding:6px 14px;border-radius:4px;font-size:.9rem;white-space:nowrap;transition:background .15s;}' +
    '#siteNav .nav-links a:hover,#siteNav .nav-links a.active{background:rgba(255,255,255,.15);color:#fff;}' +
    '#siteNav .nav-auth{display:flex;gap:4px;align-items:center;}' +
    '#siteNav .nav-hi{color:rgba(255,255,255,.85);font-size:.9rem;padding:0 6px;white-space:nowrap;}' +
    '#siteNav .nav-hi b{color:#fff;}' +
    '#siteNav a.nav-signup{border:1px solid rgba(255,255,255,.5);border-radius:6px;}' +
    '#siteNav a.nav-signin{background:#1565c0;color:#fff;border-radius:6px;font-weight:600;}' +
    '#siteNav a.nav-signin:hover{background:#0d47a1;}' +
    '#siteNav .notif-wrap{position:relative;}' +
    '#siteNav .notif-btn{background:none;border:none;cursor:pointer;padding:6px 10px;color:rgba(255,255,255,.8);font-size:1.15rem;border-radius:4px;line-height:1;position:relative;}' +
    '#siteNav .notif-btn:hover{background:rgba(255,255,255,.15);}' +
    '#siteNav .notif-badge{position:absolute;top:2px;right:2px;background:#e53935;color:#fff;border-radius:50%;font-size:.62rem;font-weight:800;width:15px;height:15px;display:none;align-items:center;justify-content:center;pointer-events:none;}' +
    '#siteNav .notif-dropdown{position:absolute;top:calc(100% + 8px);right:0;width:340px;max-width:calc(100vw - 24px);background:#fff;border:1px solid #c5d5e8;border-radius:12px;box-shadow:0 8px 32px rgba(11,46,89,.18);z-index:300;display:none;max-height:420px;overflow-y:auto;color:#1a1a1a;}' +
    '#siteNav .notif-dropdown.open{display:block;}' +
    '#siteNav .notif-header{display:flex;justify-content:space-between;align-items:center;padding:14px 16px 10px;border-bottom:1px solid #c5d5e8;position:sticky;top:0;background:#fff;}' +
    '#siteNav .notif-header h3{font-size:.92rem;font-weight:700;color:#0b2e59;margin:0;}' +
    '#siteNav .notif-mark-all{background:none;border:none;color:#1565c0;font-size:.8rem;cursor:pointer;font-weight:600;}' +
    '#siteNav .notif-item{padding:12px 16px;border-bottom:1px solid #f0f4f8;font-size:.86rem;}' +
    '#siteNav .notif-item.unread{background:#f0f6ff;}' +
    '#siteNav .notif-item .n-title{font-weight:700;color:#0b2e59;}' +
    '#siteNav .notif-item .n-body{color:#555;margin-top:2px;}' +
    '#siteNav .notif-item .n-time{color:#999;font-size:.75rem;margin-top:4px;}' +
    '#siteNav .notif-empty{padding:28px 16px;text-align:center;color:#555;font-size:.9rem;}' +
    // Phones / narrow windows: logo on top, menu scrolls sideways instead of overflowing the page
    '@media (max-width:1100px){#siteNav{height:auto;flex-wrap:wrap;padding:10px 16px;gap:6px;}' +
    '#siteNav .nav-links{width:100%;overflow-x:auto;-webkit-overflow-scrolling:touch;scrollbar-width:none;padding-bottom:2px;}' +
    '#siteNav .nav-links::-webkit-scrollbar{display:none;}' +
    '#siteNav .notif-wrap{position:static;}#siteNav .notif-dropdown{right:12px;top:auto;margin-top:8px;position:fixed;}}';
  var style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  // ── Markup ────────────────────────────────────────────────────────────────
  var sess = readSession();
  var links = LINKS.map(function (l) {
    return '<a href="' + l[0] + '"' + (l[0] === page ? ' class="active" aria-current="page"' : '') + '>' + l[1] + '</a>';
  }).join('');

  nav.innerHTML =
    '<a href="index.html" class="logo">Tech<span>Talent</span> Portal</a>' +
    '<div class="nav-links">' + links +
      '<span class="nav-auth" id="navLoggedOut" style="display:' + (sess ? 'none' : 'flex') + '">' +
        '<a href="login.html?next=' + here + '#signup" class="nav-signup">Sign Up</a>' +
        '<a href="login.html?next=' + here + '" class="nav-signin">Sign In</a>' +
      '</span>' +
      '<span class="nav-auth" id="navLoggedIn" style="display:' + (sess ? 'flex' : 'none') + '">' +
        '<span class="nav-hi">Hi, <b id="navUserName">' + esc(sess ? String(sess.name || (sess.email || '').split('@')[0] || 'User').split(' ')[0] : 'User') + '</b></span>' +
        '<a href="dashboard.html"' + (page === 'dashboard.html' ? ' class="active" aria-current="page"' : '') + '>My Dashboard</a>' +
        '<a href="#" onclick="ttpNavSignOut();return false">Sign Out</a>' +
      '</span>' +
      '<div class="notif-wrap">' +
        '<button class="notif-btn" id="notifBtn" onclick="ttpNavToggleNotif(event)" title="Notifications" aria-label="Notifications">🔔<span class="notif-badge" id="notifBadge"></span></button>' +
        '<div class="notif-dropdown" id="notifDropdown">' +
          '<div class="notif-header"><h3>🔔 Notifications</h3><button class="notif-mark-all" onclick="ttpNavMarkAllRead()">Mark all read</button></div>' +
          '<div id="notifList"></div>' +
        '</div>' +
      '</div>' +
    '</div>' +
    // Stubs for ids older page scripts still reference (kept hidden)
    '<span hidden style="display:none !important" aria-hidden="true">' +
      '<a id="navAuthBtn"></a><a id="navUser"></a><a id="nav-login"></a><a id="nav-signup"></a>' +
      '<a id="nav-logout"></a><a id="nav-dashboard"></a><span id="nav-hi"></span><b id="nav-name"></b>' +
    '</span>';

  // ── Sign out (clears every session key the site has used) ──────────────────
  window.ttpNavSignOut = function () {
    ['ttp_session', 'ttp_user', 'ttp_impersonating'].forEach(function (k) {
      try { localStorage.removeItem(k); } catch (e) {}
      try { sessionStorage.removeItem(k); } catch (e) {}
    });
    location.href = 'index.html';
  };
  // Pages that still call their own logout get the same behaviour
  if (typeof window.ttpLogout !== 'function') window.ttpLogout = window.ttpNavSignOut;

  // ── Notifications (shared localStorage list, same as the homepage) ─────────
  var KEY = 'ttp_notifications';
  function getN() { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch (e) { return []; } }
  function badge() {
    var b = document.getElementById('notifBadge'); if (!b) return;
    var n = getN().filter(function (x) { return !x.read; }).length;
    b.textContent = n > 9 ? '9+' : n; b.style.display = n ? 'flex' : 'none';
  }
  function render() {
    var list = document.getElementById('notifList'); if (!list) return;
    var items = getN();
    if (!items.length) { list.innerHTML = '<div class="notif-empty">🔕 No notifications yet.<br><small>Contact messages and call requests will appear here.</small></div>'; return; }
    var icons = { contact: '✉️', schedule: '📅' };
    list.innerHTML = items.slice(0, 20).map(function (n) {
      return '<div class="notif-item ' + (n.read ? '' : 'unread') + '"><div class="n-title">' + (icons[n.type] || '🔔') + ' ' + esc(n.title) +
        '</div><div class="n-body">' + esc(n.body) + '</div><div class="n-time">' + new Date(n.ts).toLocaleString() + '</div></div>';
    }).join('');
  }
  window.ttpNavToggleNotif = function (e) {
    if (e) e.stopPropagation();
    var dd = document.getElementById('notifDropdown');
    var open = !dd.classList.contains('open');
    dd.classList.toggle('open', open);
    if (open) render();
  };
  window.ttpNavMarkAllRead = function () {
    try { localStorage.setItem(KEY, JSON.stringify(getN().map(function (n) { n.read = true; return n; }))); } catch (e) {}
    badge(); render();
  };
  document.addEventListener('click', function (e) {
    var dd = document.getElementById('notifDropdown');
    if (dd && !e.target.closest('.notif-wrap')) dd.classList.remove('open');
  });
  // Keep the badge in sync when another tab or page adds a notification
  window.addEventListener('storage', function (e) { if (e.key === KEY) badge(); });
  badge();
})();
