/**
 * logger.js — Universal interaction + coordinate logger
 * Captures every user event with 1ms-resolution timestamps.
 * Batches and POSTs to the log server periodically or when buffer is full.
 *
 * Usage: <script src="logger.js"></script>  (before </body>)
 */

(function () {
  'use strict';

  // ── CONFIG ────────────────────────────────────────────────────────────────
  var SERVER_URL      = 'http://209.97.159.53/logs';
  var FLUSH_INTERVAL  = 5000;   // ms — send every 5 seconds
  var MAX_BUFFER      = 500;    // events — flush early if buffer hits this
  var MOUSEMOVE_THROTTLE = 1;   // ms — minimum gap between mousemove records
  var MAX_RETRY       = 4;      // retry attempts on failure
  var RETRY_BASE_MS   = 500;    // base delay for exponential backoff

  // ── STATE ─────────────────────────────────────────────────────────────────
  var buffer       = [];
  var sessionId    = generateId();
  var pageId       = document.title || window.location.pathname.split('/').pop();
  var t0           = Date.now();          // wall-clock anchor
  var p0           = performance.now();   // high-res anchor
  var lastMouseMove = -Infinity;
  var flushTimer   = null;
  var failedQueue  = [];  // batches that failed — will retry

  // ── HELPERS ───────────────────────────────────────────────────────────────
  function generateId() {
    return Math.random().toString(36).slice(2, 10) +
           Math.random().toString(36).slice(2, 10);
  }

  /** Returns wall-clock ms with sub-ms decimal precision */
  function now() {
    return Math.round((t0 + (performance.now() - p0)) * 1000) / 1000;
  }

  function isoNow() {
    var ms = now();
    return new Date(ms).toISOString();
  }

  /** Push one event record into the buffer */
  function record(type, data) {
    var entry = { t: isoNow(), ms: now(), session: sessionId, page: pageId, type: type };
    if (data) {
      for (var k in data) { if (data.hasOwnProperty(k)) entry[k] = data[k]; }
    }
    buffer.push(entry);
    if (buffer.length >= MAX_BUFFER) flushNow();
  }

  // ── SEND ──────────────────────────────────────────────────────────────────
  function flushNow() {
    if (buffer.length === 0) return;
    var batch = buffer.splice(0, buffer.length);
    sendBatch(batch, 0);
  }

  function sendBatch(batch, attempt) {
    var payload = JSON.stringify({ batch: batch });

    // Use sendBeacon on unload for best-effort delivery
    if (document._unloading && navigator.sendBeacon) {
      navigator.sendBeacon(SERVER_URL, new Blob([payload], { type: 'application/json' }));
      return;
    }

    var xhr = new XMLHttpRequest();
    xhr.open('POST', SERVER_URL, true);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.timeout = 8000;

    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) return;
      if (xhr.status >= 200 && xhr.status < 300) {
        // success — nothing to do
      } else {
        retryBatch(batch, attempt);
      }
    };

    xhr.ontimeout = xhr.onerror = function () {
      retryBatch(batch, attempt);
    };

    try { xhr.send(payload); } catch (e) { retryBatch(batch, attempt); }
  }

  function retryBatch(batch, attempt) {
    if (attempt >= MAX_RETRY) {
      // Give up — stash in failedQueue so we never lose the data silently
      failedQueue.push(batch);
      return;
    }
    var delay = RETRY_BASE_MS * Math.pow(2, attempt);
    setTimeout(function () { sendBatch(batch, attempt + 1); }, delay);
  }

  // ── PERIODIC FLUSH ────────────────────────────────────────────────────────
  flushTimer = setInterval(flushNow, FLUSH_INTERVAL);

  // ── PAGE LIFECYCLE ────────────────────────────────────────────────────────
  window.addEventListener('beforeunload', function () {
    document._unloading = true;
    record('page', { action: 'unload' });
    flushNow();
  });

  window.addEventListener('load', function () {
    record('page', { action: 'load', url: window.location.href,
                     referrer: document.referrer, w: window.innerWidth, h: window.innerHeight });
  });

  document.addEventListener('visibilitychange', function () {
    record('visibility', { state: document.visibilityState });
  });

  // ── MOUSE ─────────────────────────────────────────────────────────────────
  document.addEventListener('mousemove', function (e) {
    var t = performance.now();
    if (t - lastMouseMove < MOUSEMOVE_THROTTLE) return;
    lastMouseMove = t;
    record('mousemove', { x: e.clientX, y: e.clientY,
                          px: e.pageX,  py: e.pageY });
  }, { passive: true });

  document.addEventListener('mousedown', function (e) {
    record('mousedown', { x: e.clientX, y: e.clientY, button: e.button,
                          target: targetDesc(e.target) });
  });

  document.addEventListener('mouseup', function (e) {
    record('mouseup', { x: e.clientX, y: e.clientY, button: e.button,
                        target: targetDesc(e.target) });
  });

  document.addEventListener('click', function (e) {
    record('click', { x: e.clientX, y: e.clientY, button: e.button,
                      target: targetDesc(e.target) });
  });

  document.addEventListener('dblclick', function (e) {
    record('dblclick', { x: e.clientX, y: e.clientY, target: targetDesc(e.target) });
  });

  document.addEventListener('contextmenu', function (e) {
    record('contextmenu', { x: e.clientX, y: e.clientY, target: targetDesc(e.target) });
  });

  // ── KEYBOARD ──────────────────────────────────────────────────────────────
  document.addEventListener('keydown', function (e) {
    record('keydown', { key: e.key, code: e.code,
                        ctrl: e.ctrlKey, shift: e.shiftKey,
                        alt: e.altKey, meta: e.metaKey,
                        target: targetDesc(e.target) });
  });

  document.addEventListener('keyup', function (e) {
    record('keyup', { key: e.key, code: e.code, target: targetDesc(e.target) });
  });

  // ── SCROLL ────────────────────────────────────────────────────────────────
  document.addEventListener('scroll', function (e) {
    var el = e.target === document ? document.documentElement : e.target;
    record('scroll', { scrollX: window.scrollX, scrollY: window.scrollY,
                       elScrollTop: el.scrollTop || 0,
                       target: targetDesc(e.target) });
  }, { passive: true, capture: true });

  // ── INPUT / FORM ──────────────────────────────────────────────────────────
  document.addEventListener('input', function (e) {
    var el = e.target;
    var val = el.type === 'password' ? '***' : (el.value || '');
    record('input', { target: targetDesc(el), value: val.slice(0, 200) });
  }, true);

  document.addEventListener('change', function (e) {
    var el = e.target;
    var val = el.type === 'password' ? '***' : (el.value || '');
    record('change', { target: targetDesc(el), value: val.slice(0, 200) });
  }, true);

  document.addEventListener('focus', function (e) {
    record('focus', { target: targetDesc(e.target) });
  }, true);

  document.addEventListener('blur', function (e) {
    record('blur', { target: targetDesc(e.target) });
  }, true);

  // ── TOUCH ─────────────────────────────────────────────────────────────────
  document.addEventListener('touchstart', function (e) {
    var t = e.touches[0];
    if (t) record('touchstart', { x: t.clientX, y: t.clientY, count: e.touches.length });
  }, { passive: true });

  document.addEventListener('touchend', function (e) {
    var t = e.changedTouches[0];
    if (t) record('touchend', { x: t.clientX, y: t.clientY });
  }, { passive: true });

  // ── RESIZE ────────────────────────────────────────────────────────────────
  window.addEventListener('resize', function () {
    record('resize', { w: window.innerWidth, h: window.innerHeight });
  });

  // ── SELECTION ─────────────────────────────────────────────────────────────
  document.addEventListener('selectionchange', function () {
    var sel = window.getSelection();
    if (sel && sel.toString().length > 0) {
      record('selection', { text: sel.toString().slice(0, 200) });
    }
  });

  // ── CUSTOM APP EVENTS ─────────────────────────────────────────────────────
  // Expose globally so scenario scripts can log named events
  window.logEvent = function (type, data) {
    record(type, data || {});
  };

  // ── TARGET DESCRIPTOR ─────────────────────────────────────────────────────
  function targetDesc(el) {
    if (!el || el === document) return 'document';
    var parts = [el.tagName ? el.tagName.toLowerCase() : '?'];
    if (el.id)        parts.push('#' + el.id);
    if (el.className && typeof el.className === 'string') {
      parts.push('.' + el.className.trim().split(/\s+/).join('.'));
    }
    var txt = (el.textContent || el.value || '').trim().slice(0, 40);
    if (txt) parts.push('[' + txt + ']');
    return parts.join('');
  }

  // ── EXPOSE internals for download fallback ────────────────────────────────
  window._logger = {
    getBuffer:      function () { return buffer.slice(); },
    getFailedQueue: function () { return failedQueue.slice(); },
    flushNow:       flushNow,
    sessionId:      sessionId,
  };

})();
