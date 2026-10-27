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
/* Per-account privacy for personal data kept in this browser.
 * These keys are transparently stored per signed-in account ("key::email"), so the
 * next person who signs in on the same computer can't see your saved jobs,
 * applications, AI-apply profile or posted jobs. Signed-out visitors share a
 * separate "guest" space. Runs before any page script reads these keys. */
(function () {
  if (window.__ttpPrivateStore) return; window.__ttpPrivateStore = true;
  var PRIVATE = { ttp_saved: 1, ttp_applied: 1, ttp_applications: 1, ttp_job_meta: 1, ttp_ai_profile: 1, ttp_ai_queue: 1,
                  ttp_my_jobs: 1, ttp_local_jobs: 1, ttp_schedule_requests: 1, ttp_pending_contacts: 1, ttp_submissions: 1 };
  var P = Storage.prototype, get = P.getItem, set = P.setItem, rem = P.removeItem;
  function who() {
    try {
      var raw = get.call(sessionStorage, 'ttp_session') || get.call(localStorage, 'ttp_session');
      var s = raw ? JSON.parse(raw) : null;
      if (s && s.token && s.token !== 'guest' && s.role === 'recruiter' && s.username) return 'recruiter:' + String(s.username).toLowerCase();   // recruiters share a group email
      if (s && s.token && s.token !== 'guest' && s.email) return String(s.email).toLowerCase();
    } catch (e) {}
    return 'guest';
  }
  function ns(k) { return PRIVATE[k] ? k + '::' + who() : k; }
  P.getItem = function (k) { return get.call(this, ns(k)); };
  P.setItem = function (k, v) { return set.call(this, ns(k), v); };
  P.removeItem = function (k) { return rem.call(this, ns(k)); };
  // Old, shared copies had no owner — move them out of sight instead of handing them to whoever signs in next
  try {
    Object.keys(PRIVATE).forEach(function (k) {
      var v = get.call(localStorage, k);
      if (v != null) { set.call(localStorage, k + '::unclaimed', v); rem.call(localStorage, k); }
    });
  } catch (e) {}
})();

/* Site settings shared by all pages */
window.TTP_CONFIG = window.TTP_CONFIG || {
  // Accounts service (worker/accounts-worker.js): recruiter accounts, candidate profiles,
  // private recruiter → candidate messages. Leave empty until it is deployed — while
  // empty, the site works as before (local profiles, no recruiter sign-in required).
  RECRUITER_API_URL: 'https://techtalent-accounts.purna-padishala.workers.dev'
};
window.ttpApi = function () { return (window.TTP_CONFIG.RECRUITER_API_URL || '').replace(/\/$/, ''); };
// Local testing only: ?recruiterApi=http://localhost:8788 (remembered for this tab)
if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) {
  try {
    var _o = new URLSearchParams(location.search).get('recruiterApi');
    if (_o) sessionStorage.setItem('ttp_test_recruiter_api', _o);
    window.TTP_CONFIG.RECRUITER_API_URL = sessionStorage.getItem('ttp_test_recruiter_api') || window.TTP_CONFIG.RECRUITER_API_URL;
  } catch (e) {}
}
/* Recruiters must be signed in to contact candidates — once recruiter accounts are live. */
window.ttpRecruiterGate = function (what) {
  if (!window.TTP_CONFIG.RECRUITER_API_URL) return true;
  try {
    var raw = sessionStorage.getItem('ttp_session') || localStorage.getItem('ttp_session');
    var s = raw ? JSON.parse(raw) : null;
    if (s && s.role === 'recruiter' && s.token && (!s.expiresAt || Date.parse(s.expiresAt) > Date.now())) return true;
  } catch (e) {}
  var back = encodeURIComponent((location.pathname.split('/').pop() || 'index.html') + location.search);
  if (confirm('Only verified recruiters can ' + (what || 'contact candidates') + '.\n\nSign in to your recruiter account, or ask your organization to add you?')) location.href = 'recruiter.html?next=' + back;
  return false;
};

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
    ['recruiter.html', 'Recruiters'],
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
        '<a href="inbox.html"' + (page === 'inbox.html' ? ' class="active" aria-current="page"' : '') + '>Inbox</a>' +
        '<a href="#" onclick="ttpNavSignOut();return false">Sign Out</a>' +
      '</span>' +
      '<div class="notif-wrap"' + (sess ? '' : ' hidden style="display:none"') + '>' +
        '<button class="notif-btn" id="notifBtn" onclick="ttpNavToggleNotif(event)" title="Inbox & notifications" aria-label="Inbox and notifications" aria-haspopup="true">🔔<span class="notif-badge" id="notifBadge"></span></button>' +
        '<div class="notif-dropdown" id="notifDropdown">' +
          '<div class="notif-header"><h3>🔔 Notifications</h3><button class="notif-mark-all" onclick="ttpNavMarkAllRead()">Mark all read</button></div>' +
          '<div id="notifList"></div>' +
          '<a href="inbox.html" class="notif-open-inbox" style="display:block;text-align:center;padding:12px;font-weight:700;color:#1565c0;text-decoration:none;border-top:1px solid #c5d5e8">Open inbox →</a>' +
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
    // End the server-side session too (recruiter or candidate), without waiting
    try {
      var cur = readSession(), api = window.ttpApi && window.ttpApi();
      if (api && cur && /^[a-f0-9]{48}$/.test(cur.token || '')) {
        var path = cur.role === 'candidate' ? '/candidate/logout' : cur.role === 'recruiter' ? '/logout' : '';
        if (path) fetch(api + path, { method: 'POST', headers: { Authorization: 'Bearer ' + cur.token }, keepalive: true }).catch(function () {});
      }
    } catch (e) {}
    ['ttp_session', 'ttp_user', 'ttp_impersonating', 'ttp_remote_unread'].forEach(function (k) {
      try { localStorage.removeItem(k); } catch (e) {}
      try { sessionStorage.removeItem(k); } catch (e) {}
    });
    location.href = 'index.html';
  };
  // Pages that still call their own logout get the same behaviour
  if (typeof window.ttpLogout !== 'function') window.ttpLogout = window.ttpNavSignOut;

  // ── Private mailbox: inbox + sent, stored per signed-in account ────────────
  // Nothing is stored for guests or signed-out visitors, and one account never sees
  // another account's messages in this browser.
  // (Messages from other members need cloud accounts; the inbox is ready for them.)
  try { localStorage.removeItem('ttp_notifications'); } catch (e) {}   // old shared list had no owner
  function owner() {
    var s = readSession();
    if (s && s.token && s.role === 'recruiter' && s.username) return 'recruiter:' + String(s.username).toLowerCase();
    return s && s.token && s.token !== 'legacy' && s.email ? String(s.email).toLowerCase() : null;
  }
  function mkey() { var o = owner(); return o ? 'ttp_mail:' + o : null; }
  function load() {
    var k = mkey(); if (!k) return null;
    try { var d = JSON.parse(localStorage.getItem(k) || 'null'); if (d && d.inbox && d.sent) return d; } catch (e) {}
    return { inbox: [], sent: [], seen: {} };
  }
  function save(d) { var k = mkey(); if (!k) return; try { localStorage.setItem(k, JSON.stringify(d)); } catch (e) {} }
  var ICONS = { contact: '✉️', schedule: '📅', application: '📤', job: '📋', profile: '👤', closed: '🔒', welcome: '👋', update: '🔔' };
  window.ttpMail = {
    owner: owner,
    icon: function (kind) { return ICONS[kind] || '🔔'; },
    // folder: 'inbox' | 'sent'; msg: {kind, subject, body, to, from, link, dedupe}
    add: function (folder, msg) {
      var d = load(); if (!d) return false;
      if (msg.dedupe) { if (d.seen[msg.dedupe]) return false; d.seen[msg.dedupe] = 1; }
      var item = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        kind: msg.kind || 'update', subject: String(msg.subject || '').slice(0, 200), body: String(msg.body || '').slice(0, 5000),
        to: String(msg.to || '').slice(0, 200), from: String(msg.from || (folder === 'sent' ? 'You' : 'TechTalent Portal')).slice(0, 200),
        link: msg.link || '', ts: new Date().toISOString(), read: folder === 'sent'
      };
      d[folder].unshift(item);
      if (d[folder].length > 200) d[folder].length = 200;
      save(d); badge(); return true;
    },
    list: function (folder) { var d = load(); return d ? d[folder] || [] : []; },
    update: function (folder, id, patch) { var d = load(); if (!d) return; d[folder].forEach(function (m) { if (m.id === id) Object.assign(m, patch); }); save(d); badge(); },
    remove: function (folder, id) { var d = load(); if (!d) return; d[folder] = d[folder].filter(function (m) { return m.id !== id; }); save(d); badge(); },
    markAllRead: function () { var d = load(); if (!d) return; d.inbox.forEach(function (m) { m.read = true; }); save(d); badge(); },
    // Remember that THIS account saved/applied to a job (for its closed-job alerts)
    track: function (jobId) { var d = load(); if (!d) return; d.seen['job:' + jobId] = 1; save(d); },
    tracks: function (jobId) { var d = load(); return !!(d && d.seen['job:' + jobId]); },
    unread: function () { return this.list('inbox').filter(function (m) { return !m.read; }).length; },
    refreshBadge: function () { badge(); }
  };

  function badge() {
    var b = document.getElementById('notifBadge'); if (!b) return;
    var n = owner() ? window.ttpMail.unread() + (parseInt(sessionStorage.getItem('ttp_remote_unread') || '0', 10) || 0) : 0;   // + recruiter messages (candidates)
    b.textContent = n > 9 ? '9+' : n; b.style.display = n ? 'flex' : 'none';
    var btn = document.getElementById('notifBtn');
    if (btn) btn.setAttribute('aria-label', n ? 'Inbox and notifications, ' + n + ' unread' : 'Inbox and notifications');
  }
  function render() {
    var list = document.getElementById('notifList'); if (!list) return;
    var items = window.ttpMail.list('inbox');
    if (!items.length) { list.innerHTML = '<div class="notif-empty">🔕 No notifications yet.<br><small>Updates about your applications, messages and jobs appear here.</small></div>'; return; }
    list.innerHTML = items.slice(0, 6).map(function (n) {
      return '<a href="inbox.html#' + esc(n.id) + '" class="notif-item ' + (n.read ? '' : 'unread') + '" style="display:block;text-decoration:none;color:inherit"><div class="n-title">' + window.ttpMail.icon(n.kind) + ' ' + esc(n.subject) +
        '</div><div class="n-body">' + esc(String(n.body).slice(0, 120)) + '</div><div class="n-time">' + new Date(n.ts).toLocaleString() + '</div></a>';
    }).join('');
  }
  window.ttpNavToggleNotif = function (e) {
    if (e) e.stopPropagation();
    var dd = document.getElementById('notifDropdown');
    var open = !dd.classList.contains('open');
    dd.classList.toggle('open', open);
    document.getElementById('notifBtn').setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) render();
  };
  window.ttpNavMarkAllRead = function () { window.ttpMail.markAllRead(); render(); };
  document.addEventListener('click', function (e) {
    var dd = document.getElementById('notifDropdown');
    if (dd && !e.target.closest('.notif-wrap')) dd.classList.remove('open');
  });
  window.addEventListener('storage', function (e) { if (e.key && e.key.indexOf('ttp_mail:') === 0) badge(); });

  // Alerts generated for you: saved/applied jobs that have since closed
  if (owner()) {
    try {
      var closed = JSON.parse(localStorage.getItem('ttp_closed_jobs') || '[]');
      var meta = JSON.parse(localStorage.getItem('ttp_job_meta') || '{}');
      closed.forEach(function (c) {
        if (!window.ttpMail.tracks(c.id)) return;   // only jobs this account saved/applied to
        var m = meta[c.id] || c;
        window.ttpMail.add('inbox', { kind: 'closed', dedupe: 'closed:' + c.id, subject: 'Job closed: ' + (m.title || 'a job you saved'),
          body: (m.company ? m.company + ' — ' : '') + (c.reason || 'This listing is no longer available.') + '\n\nIt has been removed from Browse Jobs. You can find similar roles there.', link: 'jobs.html' });
      });
      var sNow = readSession();
      window.ttpMail.add('inbox', { kind: 'welcome', dedupe: 'welcome', subject: 'Welcome to your inbox',
        body: 'Hi ' + String((sNow && sNow.name) || 'there').split(' ')[0] + ',\n\nThis inbox is private to your account. You\'ll find updates here about your applications, saved jobs that close, calls you schedule, and copies of messages you send (under Sent).\n\nMessages from recruiters and candidates will also arrive here once member accounts move to the cloud.' });
    } catch (e) {}
  }
  badge();
})();
