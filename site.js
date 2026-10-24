/* site.js — site-wide form safety and accessibility. Loaded on every page.
 *
 *  1. Input limits      maxlength on every text field (incl. ones added later by JS),
 *                       live character counter on long text areas, and caps on the
 *                       lists the site keeps in browser storage.
 *  2. Email checks      window.ttpValidEmail(v) — requires name@domain.tld; every
 *                       email field is also checked when you leave it.
 *  3. Double submits    buttons marked data-once ignore repeat clicks and show a
 *                       spinner until the request they started has finished.
 *  4. Keyboard & a11y   visible focus outline, skip link, clickable non-buttons made
 *                       reachable with Tab + Enter/Space, Escape closes dialogs and
 *                       focus moves into a dialog when it opens, icon-only controls
 *                       get labels, decorative emoji hidden from screen readers.
 *  5. Touch targets     44px minimum hit area on touch screens.
 */
(function () {
  'use strict';

  // ── 2. Email ──────────────────────────────────────────────────────────────
  var EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)*\.[A-Za-z]{2,}$/;
  window.ttpValidEmail = function (v) { return EMAIL_RE.test(String(v || '').trim()) && String(v).length <= 254; };

  // ── Styles ────────────────────────────────────────────────────────────────
  var css = [
    // Focus: a clear ring for keyboard users only (mouse clicks don't show it)
    ':focus-visible{outline:3px solid #1e88e5 !important;outline-offset:2px !important;border-radius:4px;transition-property:background-color,color,border-color,box-shadow,transform,opacity !important;}',
    'input:focus-visible,select:focus-visible,textarea:focus-visible{outline-offset:0 !important;}',
    '#siteNav :focus-visible{outline-color:#7ec8f7 !important;}',
    '.ttp-skip{position:absolute;left:8px;top:-60px;z-index:10000;background:#fff;color:#0b2e59;font-weight:700;padding:10px 16px;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.25);text-decoration:none;font-family:inherit;}',
    '.ttp-skip:focus{top:8px;}',
    // Invalid email
    'input[aria-invalid="true"]{border-color:#c62828 !important;background:#fff8f8 !important;}',
    '.ttp-field-err{color:#c62828;font-size:.8rem;font-weight:600;margin-top:4px;display:block;}',
    // Character counter
    '.ttp-count{display:block;text-align:right;font-size:.75rem;color:#777;margin-top:2px;}',
    '.ttp-count.near{color:#b45309;font-weight:700;}',
    // Busy buttons
    '[data-busy="1"]{cursor:wait !important;opacity:.75;pointer-events:none;}',
    '.ttp-spin{display:inline-block;width:1em;height:1em;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:ttpSpin .7s linear infinite;vertical-align:-2px;margin-right:6px;}',
    '@keyframes ttpSpin{to{transform:rotate(360deg)}}',
    '@media (prefers-reduced-motion:reduce){.ttp-spin{animation-duration:2s;}}',
    // 5. Touch targets (phones/tablets)
    '@media (pointer:coarse){',
    '  button,.btn,[role="button"],.source-pill,.tab-btn,.tab,.dash-tab,select,input:not([type=checkbox]):not([type=radio]):not([type=hidden]){min-height:44px;}',
    '  #siteNav .nav-links a,#siteNav .notif-btn{min-height:44px;display:inline-flex;align-items:center;}',
    '  .filter-item{min-height:44px;padding:6px 0 !important;}',
    '  input[type=checkbox],input[type=radio]{width:22px;height:22px;}',
    '  .card-actions a,.card-actions button,.job-actions a,.job-actions button{min-height:44px;display:inline-flex;align-items:center;}',
    '  .source-pills,.filter-pills{gap:10px !important;}',
    '  #siteNav .logo,footer a,.btn-pill,.ttp-skip,.otw-box a,.see-more,.copy-btn,.show-all,.linklike,.gs-link,.wr-apply,.wr-title{min-height:44px;display:inline-flex !important;align-items:center;}',
    '  footer a{padding:0 6px;}',
    '}'
  ].join('\n');
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  // ── 1. Input limits ───────────────────────────────────────────────────────
  var LIMITS = { email: 254, url: 300, tel: 20, password: 128, search: 120, text: 150 };
  var TEXTAREA_MAX = 3000;
  var LONG_TEXT = /summary|about|bio|description|desc|cover|message|msg|resume|skills|requirements|responsib|notes/i;
  function limitField(el) {
    if (el.dataset.ttpLimited) return;
    el.dataset.ttpLimited = '1';
    if (el.tagName === 'TEXTAREA') {
      if (!el.hasAttribute('maxlength')) el.setAttribute('maxlength', TEXTAREA_MAX);
      addCounter(el);
      return;
    }
    var t = (el.getAttribute('type') || 'text').toLowerCase();
    if (!(t in LIMITS)) return;
    if (!el.hasAttribute('maxlength')) {
      var max = LIMITS[t];
      if (t === 'text' && LONG_TEXT.test((el.id || '') + ' ' + (el.name || ''))) max = 500;
      el.setAttribute('maxlength', max);
    }
    if (t === 'email') watchEmail(el);
  }
  function addCounter(el) {
    var max = +el.getAttribute('maxlength'); if (!max) return;
    var c = document.createElement('span'); c.className = 'ttp-count'; c.setAttribute('aria-live', 'polite');
    el.insertAdjacentElement('afterend', c);
    function upd() {
      var n = el.value.length;
      c.textContent = n >= max * 0.8 ? n + ' / ' + max : '';
      c.classList.toggle('near', n >= max * 0.95);
    }
    el.addEventListener('input', upd); upd();
  }
  function watchEmail(el) {
    function check() {
      var v = el.value.trim();
      var bad = v !== '' && !window.ttpValidEmail(v);
      var msg = el.parentNode && el.parentNode.querySelector(':scope > .ttp-field-err');
      if (bad) {
        el.setAttribute('aria-invalid', 'true');
        if (!msg) {
          msg = document.createElement('span'); msg.className = 'ttp-field-err'; msg.setAttribute('role', 'alert');
          msg.id = (el.id || 'em' + Math.random().toString(36).slice(2)) + '-err';
          el.insertAdjacentElement('afterend', msg);
          el.setAttribute('aria-describedby', msg.id);
        }
        msg.textContent = 'Enter a full email address, like name@company.com';
      } else {
        el.removeAttribute('aria-invalid');
        if (msg) msg.remove();
      }
    }
    el.addEventListener('blur', check);
    el.addEventListener('input', function () { if (el.getAttribute('aria-invalid')) check(); });
  }

  // Cap lists kept in browser storage so they can't grow forever
  var CAPS = { ttp_pending_contacts: 100, ttp_applications: 200, ttp_submissions: 50, ttp_notifications: 50, ttp_ai_queue: 100, ttp_users: 200 };
  Object.keys(CAPS).forEach(function (k) {
    try {
      var a = JSON.parse(localStorage.getItem(k) || 'null');
      if (Array.isArray(a) && a.length > CAPS[k]) localStorage.setItem(k, JSON.stringify(k === 'ttp_users' ? a.slice(-CAPS[k]) : a.slice(0, CAPS[k])));
    } catch (e) {}
  });

  // ── 3. Double-submit protection ───────────────────────────────────────────
  // Count requests in flight so a busy button is released when its request ends.
  var pending = 0, lastFetchAt = 0;
  if (window.fetch && !window.fetch.ttpWrapped) {
    var origFetch = window.fetch.bind(window);
    window.fetch = function () {
      pending++; lastFetchAt = Date.now();
      return origFetch.apply(null, arguments).finally(function () { pending = Math.max(0, pending - 1); });
    };
    window.fetch.ttpWrapped = true;
  }
  function setBusy(btn) {
    btn.dataset.busy = '1';
    btn.setAttribute('aria-busy', 'true');
    btn.dataset.ttpHtml = btn.innerHTML;
    var clickedAt = Date.now();
    // Let the page's own click handler run first, then show the spinner
    setTimeout(function () {
      if (btn.dataset.busy === '1' && !btn.querySelector('.ttp-spin')) {
        var label = (btn.textContent || '').replace(/[^\w\s'’.-]/g, '').trim() || 'Working';
        if (!/…$/.test(label)) btn.innerHTML = '<span class="ttp-spin" aria-hidden="true"></span>' + label;
      }
    }, 0);
    (function waitDone() {
      var elapsed = Date.now() - clickedAt;
      var startedRequest = lastFetchAt >= clickedAt;
      // Done when: a request started and all requests finished (min 400ms),
      // or no request started at all (validation error etc.) after 700ms. Max 15s.
      if (elapsed > 15000 || (startedRequest && pending === 0 && elapsed > 400) || (!startedRequest && elapsed > 700)) {
        release(btn);
      } else setTimeout(waitDone, 120);
    })();
  }
  function release(btn) {
    if (btn.dataset.busy !== '1') return;
    delete btn.dataset.busy;
    btn.removeAttribute('aria-busy');
    // Only restore our own spinner label; leave the page's own text changes alone
    if (btn.querySelector('.ttp-spin') && btn.dataset.ttpHtml != null) btn.innerHTML = btn.dataset.ttpHtml;
    delete btn.dataset.ttpHtml;
  }
  document.addEventListener('click', function (e) {
    var btn = e.target.closest && e.target.closest('[data-once]');
    if (!btn) return;
    if (btn.dataset.busy === '1' || btn.disabled) { e.preventDefault(); e.stopImmediatePropagation(); return; }
    setBusy(btn);
  }, true);
  // Forms submitted with Enter: guard their submit button too
  document.addEventListener('submit', function (e) {
    var btn = e.target.querySelector('[data-once]');
    if (!btn) return;
    // Pressing Enter or clicking the button fires a click first, which already marked it
    // busy — that submit must go through. Block only a submit from anywhere else while busy.
    if (e.submitter === btn) return;
    if (btn.dataset.busy === '1') { e.preventDefault(); e.stopImmediatePropagation(); return; }
    setBusy(btn);
  }, true);

  // ── 4. Keyboard & screen readers ─────────────────────────────────────────
  var EMOJI_ONLY = /^[\s\p{Extended_Pictographic}‍️⃣#*0-9]*\p{Extended_Pictographic}[\s\p{Extended_Pictographic}‍️]*$/u;
  var SYMBOL_LABELS = { '×': 'Close', '✕': 'Close', '✖': 'Close', '⋯': 'More options', '☰': 'Menu' };
  var NATIVE = /^(A|BUTTON|INPUT|SELECT|TEXTAREA|LABEL|SUMMARY|OPTION)$/;

  function enhance(root) {
    if (!root || !root.querySelectorAll) return;
    // limits
    root.querySelectorAll('input,textarea').forEach(limitField);
    // clickable non-buttons → keyboard operable
    root.querySelectorAll('[onclick]').forEach(function (el) {
      if (NATIVE.test(el.tagName) || el.closest('.modal-overlay') === el || el.dataset.ttpKb) return;
      if (/^(DIV|SPAN|LI|TD|TR|P|IMG|SECTION|ARTICLE)$/.test(el.tagName)) {
        // Skip overlays/backdrops that close a dialog when clicked outside
        if (/overlay|backdrop/i.test(el.className)) return;
        // Wrappers around a field (e.g. a tag input) aren't buttons — the field inside gets focus
        if (el.querySelector('input,textarea,select,button,a[href]')) return;
        el.dataset.ttpKb = '1';
        if (!el.hasAttribute('role')) el.setAttribute('role', 'button');
        if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
      }
    });
    // controls with no readable name → give them one
    root.querySelectorAll('button,a,[role="button"]').forEach(function (el) {
      if (el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby')) return;
      var txt = (el.textContent || '').trim();
      if (txt && !EMOJI_ONLY.test(txt) && !(txt in SYMBOL_LABELS)) return;
      var name = el.getAttribute('title') || SYMBOL_LABELS[txt] ||
                 (el.querySelector('img[alt]') && el.querySelector('img[alt]').alt) || '';
      if (!name && el.tagName === 'A' && el.getAttribute('href')) name = el.getAttribute('href').replace(/\.html.*$/, '').replace(/[-_]/g, ' ');
      if (name) el.setAttribute('aria-label', name);
    });
    // purely decorative emoji (not inside a control) → hidden from screen readers
    root.querySelectorAll('span,div,i,p,h1,h2,h3').forEach(function (el) {
      if (el.children.length || el.hasAttribute('aria-hidden') || el.hasAttribute('role')) return;
      var t = (el.textContent || '').trim();
      if (t && EMOJI_ONLY.test(t) && !el.closest('button,a,[role="button"],label')) el.setAttribute('aria-hidden', 'true');
    });
    // images without alt
    root.querySelectorAll('img:not([alt])').forEach(function (img) { img.setAttribute('alt', ''); });
  }

  // Enter / Space on a role=button element acts like a click
  document.addEventListener('keydown', function (e) {
    var el = e.target;
    if ((e.key === 'Enter' || e.key === ' ') && el && el.dataset && el.dataset.ttpKb) {
      e.preventDefault(); el.click();
    }
  });

  // Dialogs: Escape closes the top-most open one; focus moves inside when one opens
  function openDialogs() {
    return Array.prototype.filter.call(document.querySelectorAll('.modal-overlay, [id$="Modal"], [id$="modal"]'), function (m) {
      var cs = getComputedStyle(m);
      return cs.display !== 'none' && cs.visibility !== 'hidden' && m.getClientRects().length;
    });
  }
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    var open = openDialogs(); if (!open.length) return;
    var m = open[open.length - 1];
    var closer = m.querySelector('.btn-cancel, [onclick*="close" i], [aria-label="Close"], .modal-close, .close');
    if (closer) closer.click();
    else { m.classList.remove('open'); m.style.display = 'none'; }
    if (lastOpener && document.contains(lastOpener)) try { lastOpener.focus(); } catch (err) {}
  });
  var lastOpener = null;
  document.addEventListener('focusin', function (e) { if (!e.target.closest('.modal-overlay,[id$="Modal"],[id$="modal"]')) lastOpener = e.target; });
  var wasOpen = new WeakSet();
  function focusNewDialogs() {
    openDialogs().forEach(function (m) {
      if (wasOpen.has(m)) return;
      wasOpen.add(m);
      if (!m.hasAttribute('role')) { m.setAttribute('role', 'dialog'); m.setAttribute('aria-modal', 'true'); }
      var h = m.querySelector('h2,h3');
      if (h && !m.hasAttribute('aria-labelledby')) { if (!h.id) h.id = 'dlg-' + Math.random().toString(36).slice(2, 8); m.setAttribute('aria-labelledby', h.id); }
      if (!m.contains(document.activeElement)) {
        var f = m.querySelector('input:not([type=hidden]):not([disabled]),textarea,select,button:not([disabled])');
        if (f) setTimeout(function () { try { f.focus({ preventScroll: true }); } catch (err) {} }, 30);
      }
    });
    document.querySelectorAll('.modal-overlay,[id$="Modal"],[id$="modal"]').forEach(function (m) {
      if (wasOpen.has(m) && openDialogs().indexOf(m) < 0) wasOpen.delete(m);
    });
  }
  // Keep Tab inside an open dialog
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Tab') return;
    var open = openDialogs(); if (!open.length) return;
    var m = open[open.length - 1];
    var f = Array.prototype.filter.call(m.querySelectorAll('a[href],button:not([disabled]),input:not([type=hidden]):not([disabled]),select,textarea,[tabindex]:not([tabindex="-1"])'),
      function (x) { return x.getClientRects().length; });
    if (!f.length) return;
    var first = f[0], last = f[f.length - 1];
    if (!m.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
    else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  // Skip link straight to the main content
  function addSkip() {
    if (document.querySelector('.ttp-skip')) return;
    var target = document.querySelector('main, #profiles-section, .main-wrap, .pf-wrap');
    if (!target) {   // otherwise: the first content block after the top menu
      var n = document.getElementById('siteNav');
      for (n = n && n.nextElementSibling; n; n = n.nextElementSibling) if (!/^(SCRIPT|STYLE|LINK)$/.test(n.tagName)) { target = n; break; }
    }
    if (!target) return;
    if (!target.id) target.id = 'main-content';
    if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
    var a = document.createElement('a'); a.className = 'ttp-skip'; a.href = '#' + target.id; a.textContent = 'Skip to main content';
    document.body.insertBefore(a, document.body.firstChild);
  }

  function init() {
    addSkip();
    enhance(document.body);
    var pendingRoots = new Set(), scheduled = false;
    new MutationObserver(function (muts) {
      muts.forEach(function (m) {
        if (m.type === 'childList') m.addedNodes.forEach(function (n) { if (n.nodeType === 1) pendingRoots.add(n.parentNode || n); });
      });
      if (!scheduled) {
        scheduled = true;
        requestAnimationFrame(function () {
          scheduled = false;
          pendingRoots.forEach(enhance); pendingRoots.clear();
          focusNewDialogs();
        });
      }
    }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
