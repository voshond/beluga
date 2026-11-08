/**
 * What runs inside a preview's frame besides the component (served by preview/server.ts): it
 * draws the component with the props the chat sends (React inside the project's wrapper and
 * Storybook decorators, or Vue and Svelte through their entry's adapter), tells the chat how tall
 * it is (open menus and dialogs included) and which callbacks fired, and swaps in a new build when
 * the file changes, keeping the props. The tools (pinned states, the accessibility check, a
 * picture) are another script, loaded the first time one is used. Plain browser JavaScript, as text.
 *
 * Messages, all `{ beluga: … }`, only to and from the page that framed it:
 * - in:  { beluga: 'props', props, variants?: { name, values }, gallery?: [{ name, label, props }] }
 *        { beluga: 'canvas', dark } · { beluga: 'pin', states: ['hover', …] } · { beluga: 'audit' }
 *        { beluga: 'highlight', id } · { beluga: 'snapshot' }
 * - out: { beluga: 'ready' } · { beluga: 'size', height } · { beluga: 'event', name, detail }
 *        { beluga: 'drawn' } · { beluga: 'error', message, stack } · { beluga: 'rebuilt', v }
 *        { beluga: 'stale', problem } · { beluga: 'lost' } · { beluga: 'audit', issues }
 *        { beluga: 'snapshot', png } (or { beluga: 'snapshot', failed })
 */

export const RUNTIME_CSS = `
:root { color-scheme: light; }
:root[data-beluga-canvas='dark'] { color-scheme: dark; }
html, body { margin: 0; background: transparent; }
body { font: 14px/1.45 -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif; color: #2e2a3d; }
:root[data-beluga-canvas='dark'] body { color: #ece9f6; }
#stage { box-sizing: border-box; padding: 20px; min-height: 0; display: flow-root; }
#stage[data-variants] { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 16px; }
#stage[data-gallery] { display: flex; flex-direction: column; gap: 22px; }
.beluga-cell { display: flex; flex-direction: column; gap: 8px; align-items: flex-start; min-width: 0; }
.beluga-cell > .beluga-tag { font: 500 11px/1 -apple-system, system-ui, sans-serif; color: #8a84a3; letter-spacing: .01em; }
.beluga-flash { outline: 2px solid #e98a9a !important; outline-offset: 2px !important; transition: outline-color .2s; }
`;

export const RUNTIME_JS = String.raw`(function () {
  'use strict';
  var MARK = '$beluga';
  var parentWin = window.parent;
  var stage = document.getElementById('stage');
  var state = { api: null, root: null, custom: [], props: {}, variants: null, gallery: null, key: 0, failed: false };
  // Libraries that read process.env (NODE_ENV) in a browser.
  if (typeof window.process === 'undefined') window.process = { env: { NODE_ENV: 'production' } };
  // Every preview starts clean, and leaves nothing behind for the next: what a component keeps in
  // the browser (storage, databases, cookies) is cleared as the page loads.
  try { localStorage.clear(); sessionStorage.clear(); } catch (e) { /* not allowed here */ }
  try {
    if (indexedDB && indexedDB.databases) indexedDB.databases().then(function (dbs) { dbs.forEach(function (d) { if (d.name) indexedDB.deleteDatabase(d.name); }); }).catch(function () {});
  } catch (e) { /* none */ }
  document.cookie.split(';').forEach(function (c) { var n = c.split('=')[0].trim(); if (n) document.cookie = n + '=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/'; });

  function post(msg) {
    msg.beluga = msg.beluga || 'note';
    try { parentWin.postMessage(msg, '*'); } catch (e) { /* the chat went away */ }
  }

  function summarize(value, depth) {
    depth = depth || 0;
    if (value === null || value === undefined) return String(value);
    var t = typeof value;
    if (t === 'string') return value.length > 60 ? JSON.stringify(value.slice(0, 57) + '…') : JSON.stringify(value);
    if (t === 'number' || t === 'boolean') return String(value);
    if (t === 'function') return 'a function';
    // A React or DOM event: its kind is what's worth saying.
    if (value && (value.nativeEvent || (typeof Event !== 'undefined' && value instanceof Event))) {
      var target = value.target && value.target.value !== undefined && value.target.value !== '' ? ' “' + String(value.target.value).slice(0, 40) + '”' : '';
      return (value.type || 'event') + target;
    }
    if (Array.isArray(value)) return depth > 0 ? '[' + value.length + ']' : '[' + value.slice(0, 3).map(function (v) { return summarize(v, depth + 1); }).join(', ') + (value.length > 3 ? ', …' : '') + ']';
    if (t === 'object') {
      var keys = Object.keys(value);
      if (depth > 0) return '{…}';
      return '{ ' + keys.slice(0, 3).map(function (k) { return k + ': ' + summarize(value[k], depth + 1); }).join(', ') + (keys.length > 3 ? ', …' : '') + ' }';
    }
    return t;
  }

  function revive(value) {
    if (Array.isArray(value)) return value.map(revive);
    if (value && typeof value === 'object') {
      if (value[MARK] === 'fn') {
        var name = value.name;
        return function () {
          var args = Array.prototype.slice.call(arguments);
          post({ beluga: 'event', name: name, detail: args.map(function (a) { return summarize(a); }).join(', ') });
        };
      }
      if (value[MARK] === 'date') return new Date(value.iso);
      var out = {};
      Object.keys(value).forEach(function (k) { out[k] = revive(value[k]); });
      return out;
    }
    return value;
  }

  function pickComponent(mod, pick) {
    if (pick && pick !== 'default' && mod[pick]) return mod[pick];
    if (mod.default) return mod.default;
    var names = Object.keys(mod).filter(function (k) { return /^[A-Z]/.test(k) && (typeof mod[k] === 'function' || (mod[k] && typeof mod[k] === 'object' && mod[k].$$typeof)); });
    return names.length ? mod[names[0]] : null;
  }

  function fail(error, extra) {
    state.failed = true;
    post({ beluga: 'error', message: String((error && error.message) || error), stack: String((error && error.stack) || '') + (extra ? '\n' + extra : '') });
  }

  function makeBoundary(React) {
    function Boundary(props) {
      React.Component.call(this, props);
      this.state = { failed: false };
    }
    Boundary.prototype = Object.create(React.Component.prototype);
    Boundary.prototype.constructor = Boundary;
    Boundary.getDerivedStateFromError = function () { return { failed: true }; };
    Boundary.prototype.componentDidCatch = function (error, info) { fail(error, info && info.componentStack); };
    Boundary.prototype.componentDidMount = function () { post({ beluga: 'drawn' }); };
    Boundary.prototype.componentDidUpdate = function () { if (!this.state.failed) post({ beluga: 'drawn' }); };
    Boundary.prototype.render = function () { return this.state.failed ? null : this.props.children; };
    return Boundary;
  }

  /** One element, inside the project's Storybook decorators and its preview wrapper. */
  function wrapped(React, api, element, args) {
    var decorators = api.decorators || [];
    var story = function () { return element; };
    for (var i = 0; i < decorators.length; i++) {
      (function (dec, inner) {
        story = function () { return dec(inner, { args: args, parameters: {}, globals: {}, argTypes: {}, viewMode: 'story', id: 'beluga-preview' }); };
      })(decorators[i], story);
    }
    var tree = React.createElement(story);
    return api.Wrapper ? React.createElement(api.Wrapper, null, tree) : tree;
  }

  /** What to draw: the props once, once per variant, or every component of the file (Show All). */
  function cells(props) {
    if (state.gallery && state.gallery.length) {
      return state.gallery.map(function (g) { return { label: g.label, pick: g.name, props: revive(g.props) }; });
    }
    if (state.variants && state.variants.values && state.variants.values.length) {
      var name = state.variants.name;
      return state.variants.values.map(function (v) { var p = Object.assign({}, props); p[name] = v; return { label: name + ': ' + String(v), props: p }; });
    }
    return null;
  }

  function layout(list) {
    if (list && state.gallery) { stage.setAttribute('data-gallery', ''); stage.removeAttribute('data-variants'); }
    else if (list) { stage.setAttribute('data-variants', ''); stage.removeAttribute('data-gallery'); }
    else { stage.removeAttribute('data-variants'); stage.removeAttribute('data-gallery'); }
  }

  function drawReact(api, props) {
    var React = api.React;
    var Boundary = api.Boundary || (api.Boundary = makeBoundary(React));
    var list = cells(props);
    layout(list);
    var tree;
    if (list) {
      tree = React.createElement(React.Fragment, null, list.map(function (c, i) {
        var C = pickComponent(api.Mod, c.pick || api.pick);
        return React.createElement('div', { className: 'beluga-cell', key: i },
          React.createElement('span', { className: 'beluga-tag' }, c.label),
          C ? wrapped(React, api, React.createElement(C, c.props), c.props) : null);
      }));
    } else {
      var Component = pickComponent(api.Mod, api.pick);
      if (!Component) return fail(new Error('No component to draw'));
      tree = wrapped(React, api, React.createElement(Component, props), props);
    }
    if (!state.root) state.root = api.ReactDOM.createRoot(document.getElementById('root'));
    state.root.render(React.createElement(Boundary, { key: state.key }, tree));
  }

  /** Vue and Svelte: the entry's adapter draws each cell into a box of its own. */
  function drawCustom(api, props) {
    var list = cells(props);
    var want = list || [{ props: props }];
    var root = document.getElementById('root');
    var same = state.custom.length === want.length && !list;
    try {
      if (same) {
        state.custom[0].handle.update(props);
      } else {
        state.custom.forEach(function (c) { try { c.handle.unmount(); } catch (e) { /* gone */ } });
        state.custom = [];
        root.textContent = '';
        layout(list);
        want.forEach(function (c) {
          var cell = document.createElement('div');
          var box = document.createElement('div');
          if (list) {
            cell.className = 'beluga-cell';
            var tag = document.createElement('span');
            tag.className = 'beluga-tag';
            tag.textContent = c.label;
            cell.appendChild(tag);
          }
          cell.appendChild(box);
          root.appendChild(list ? cell : box);
          state.custom.push({ handle: api.render(box, pickComponent(api.Mod, null), c.props, fail) });
        });
      }
      state.failed = false;
      post({ beluga: 'drawn' });
    } catch (e) { fail(e); }
  }

  function draw() {
    var api = state.api;
    if (!api) return;
    var props = revive(state.props);
    if (api.kind === 'custom') drawCustom(api, props);
    else drawReact(api, props);
    measureSoon();
    // Pinned states go back on what was drawn again (a redraw may set class names anew).
    if (window.__belugaTools) setTimeout(window.__belugaTools.rebuilt, 30);
  }

  // How tall: the stage, and anything open over it (a menu or dialog put at the page's end, or fixed).
  var lastHeight = -1;
  function measure() {
    var h = stage.getBoundingClientRect().bottom;
    var kids = document.body.children;
    for (var i = 0; i < kids.length; i++) {
      var el = kids[i];
      if (el === stage || el.tagName === 'SCRIPT' || el.tagName === 'STYLE') continue;
      var r = el.getBoundingClientRect();
      if (r.height > 0) h = Math.max(h, r.bottom + 16);
    }
    var floating = stage.querySelectorAll('[role="dialog"],[role="menu"],[role="listbox"],[role="tooltip"],[aria-modal="true"]');
    for (var j = 0; j < floating.length; j++) {
      var f = floating[j].getBoundingClientRect();
      if (f.height > 0) h = Math.max(h, f.bottom + 16);
    }
    h = Math.ceil(h);
    if (h !== lastHeight) {
      lastHeight = h;
      post({ beluga: 'size', height: h });
    }
  }
  var pending = 0;
  function measureSoon() {
    if (pending) return;
    pending = requestAnimationFrame(function () { pending = 0; measure(); });
  }
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(measureSoon).observe(stage);
  // Menus and dialogs added at the page's end (portals) count too.
  if (typeof MutationObserver !== 'undefined') new MutationObserver(measureSoon).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'open', 'data-state', 'hidden'] });

  // The tools, loaded the first time one is used (nothing of them runs before).
  var tools = null;
  var waiting = [];
  function withTools(run) {
    if (window.__belugaTools) return run(window.__belugaTools);
    waiting.push(run);
    if (tools) return;
    tools = document.createElement('script');
    tools.src = 'tools.js';
    tools.onload = function () { var w = waiting; waiting = []; w.forEach(function (f) { f(window.__belugaTools); }); };
    document.body.appendChild(tools);
  }

  window.addEventListener('message', function (e) {
    if (e.source !== parentWin || !e.data || typeof e.data !== 'object') return;
    var msg = e.data;
    if (msg.beluga === 'props') {
      state.props = msg.props || {};
      state.variants = msg.variants || null;
      state.gallery = msg.gallery || null;
      // Props change in place (the component keeps its state); after a failure the boundary starts over.
      if (state.failed) { state.failed = false; state.key++; }
      draw();
    } else if (msg.beluga === 'canvas') {
      var root = document.documentElement;
      root.setAttribute('data-beluga-canvas', msg.dark ? 'dark' : 'light');
      // Tailwind's and most apps' dark switch.
      root.classList.toggle('dark', Boolean(msg.dark));
      root.setAttribute('data-theme', msg.dark ? 'dark' : 'light');
      measureSoon();
    } else if (msg.beluga === 'pin' || msg.beluga === 'audit' || msg.beluga === 'highlight' || msg.beluga === 'snapshot') {
      if (msg.beluga === 'pin' && !(msg.states && msg.states.length) && !window.__belugaTools) return;
      withTools(function (t) { t.handle(msg, { stage: stage, post: post }); });
    }
  });

  window.addEventListener('error', function (e) { fail(e.error || new Error(String(e.message || 'Script error'))); });
  window.addEventListener('unhandledrejection', function (e) { fail(e.reason); });

  try {
    var initial = document.getElementById('beluga-props');
    if (initial) state.props = JSON.parse(initial.textContent || '{}');
  } catch (e) { /* the chat sends them too */ }

  window.__belugaPreview = {
    mount: function (api) {
      // A new build: the old tree goes, the same props draw the new one.
      if (state.root && state.api && state.api.ReactDOM !== api.ReactDOM) {
        try { state.root.unmount(); } catch (e) { /* gone already */ }
        state.root = null;
      }
      if (state.custom.length) {
        state.custom.forEach(function (c) { try { c.handle.unmount(); } catch (e) { /* gone */ } });
        state.custom = [];
      }
      state.api = api;
      state.failed = false;
      state.key++;
      draw();
    },
    // What a framework stand-in did (a link followed, a router push): shown like a callback.
    note: function (what, detail) { post({ beluga: 'event', name: what, detail: detail ? JSON.stringify(String(detail)) : '' }); }
  };

  var version = Number(document.documentElement.getAttribute('data-v') || '1');
  function swap(v) {
    var css = document.getElementById('bundle-css');
    if (css) css.setAttribute('href', 'bundle.css?v=' + v);
    var script = document.createElement('script');
    script.src = 'bundle.js?v=' + v;
    script.onload = function () { post({ beluga: 'rebuilt', v: v }); script.remove(); };
    document.body.appendChild(script);
  }
  if (typeof EventSource !== 'undefined') {
    var events = new EventSource('events');
    events.onmessage = function (e) {
      var msg;
      try { msg = JSON.parse(e.data); } catch (err) { return; }
      if (msg.problem) { post({ beluga: 'stale', problem: msg.problem }); return; }
      if (msg.v && msg.v !== version) { version = msg.v; swap(msg.v); }
    };
    // Closed for good (the preview was let go while nobody looked): the chat opens it again.
    events.onerror = function () { if (events.readyState === 2) post({ beluga: 'lost' }); };
  }
  post({ beluga: 'ready' });
})();`;

/** For a web page (an .html file): reload when its files change, and say how it's going. */
export const RELOAD_JS = String.raw`(function () {
  if (typeof EventSource === 'undefined') return;
  var version = null;
  var events = new EventSource(document.currentScript.getAttribute('data-events'));
  events.onmessage = function (e) {
    var msg;
    try { msg = JSON.parse(e.data); } catch (err) { return; }
    if (version !== null && msg.v !== version) location.reload();
    version = msg.v;
  };
})();`;
