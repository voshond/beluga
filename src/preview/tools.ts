/**
 * A preview frame's tools (runtime.ts loads them the first time one is used, so nothing of them
 * runs before): states pinned on (hover, focus, active, as if the pointer were there), an
 * accessibility check in plain words with each issue found on the page, and a picture of the
 * preview as a PNG. Plain browser JavaScript, as text.
 */

export const TOOLS_JS = String.raw`(function () {
  'use strict';
  var STATES = ['hover', 'focus', 'focus-visible', 'focus-within', 'active'];
  var pinned = [];

  // ---- pinned states: every :hover rule copied as a class, the class put on everything drawn.
  function rulesOf(list, wrap, out) {
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      if (r.selectorText !== undefined && r.style) out.push({ rule: r, wrap: wrap });
      else if (r.cssRules && r.conditionText !== undefined) rulesOf(r.cssRules, wrap.concat(['@' + (r.constructor.name === 'CSSSupportsRule' ? 'supports' : 'media') + ' ' + r.conditionText]), out);
      else if (r.cssRules && r.name !== undefined && r.constructor.name === 'CSSLayerBlockRule') rulesOf(r.cssRules, wrap.concat(['@layer ' + r.name]), out);
      else if (r.cssRules) rulesOf(r.cssRules, wrap, out);
    }
  }
  function pinStyles(states) {
    var old = document.getElementById('beluga-pins');
    if (old) old.remove();
    if (!states.length) return;
    var found = [];
    for (var i = 0; i < document.styleSheets.length; i++) {
      try { rulesOf(document.styleSheets[i].cssRules, [], found); } catch (e) { /* not ours to read */ }
    }
    // Longest first, so :focus-visible is never read as :focus.
    var re = new RegExp(':(' + states.slice().sort(function (a, b) { return b.length - a.length; }).join('|') + ')(?![\\w-])', 'g');
    var text = '';
    found.forEach(function (f) {
      var sel = f.rule.selectorText;
      if (!re.test(sel)) return;
      re.lastIndex = 0;
      var pinnedSel = sel.replace(re, function (_m, s) { return '.beluga-pin-' + s; });
      var body = pinnedSel + '{' + f.rule.style.cssText + '}';
      for (var w = f.wrap.length - 1; w >= 0; w--) body = f.wrap[w] + '{' + body + '}';
      text += body + '\n';
    });
    var style = document.createElement('style');
    style.id = 'beluga-pins';
    style.textContent = text;
    document.head.appendChild(style);
  }
  function pinClasses(stage) {
    var all = stage.querySelectorAll('#root *');
    for (var i = 0; i < all.length; i++) {
      STATES.forEach(function (s) { all[i].classList.toggle('beluga-pin-' + s, pinned.indexOf(s) >= 0); });
    }
  }
  function pin(states, ctx) {
    // Focus pinned is every kind of it: :focus, :focus-visible (keyboard focus, as shadcn styles it) and :focus-within.
    var wanted = [];
    states.forEach(function (s) { (s === 'focus' ? ['focus', 'focus-visible', 'focus-within'] : [s]).forEach(function (x) { if (wanted.indexOf(x) < 0) wanted.push(x); }); });
    pinned = wanted.filter(function (s) { return STATES.indexOf(s) >= 0; });
    pinStyles(pinned);
    pinClasses(ctx.stage);
  }

  // ---- the accessibility check: what people using a screen reader or with low vision would miss.
  function rgb(text) {
    var m = /rgba?\(([^)]+)\)/.exec(text || '');
    if (!m) return null;
    var p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  }
  function lum(c) {
    function ch(v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
    return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
  }
  function backgroundOf(el) {
    for (var n = el; n && n.nodeType === 1; n = n.parentElement) {
      var cs = getComputedStyle(n);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') return null;
      var c = rgb(cs.backgroundColor);
      if (c && c.a > 0.95) return c;
    }
    return document.documentElement.getAttribute('data-beluga-canvas') === 'dark' ? { r: 30, g: 28, b: 38, a: 1 } : { r: 255, g: 255, b: 255, a: 1 };
  }
  function nameOf(el) {
    if (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.getAttribute('title')) return true;
    if ((el.textContent || '').trim()) return true;
    var imgs = el.querySelectorAll('img[alt]:not([alt=""]), svg title, [aria-label]');
    return imgs.length > 0;
  }
  function labelled(el) {
    if (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.getAttribute('title')) return true;
    if (el.closest('label')) return true;
    if (el.id && document.querySelector('label[for="' + CSS.escape(el.id) + '"]')) return true;
    return false;
  }
  function what(el) {
    var t = (el.textContent || '').trim().replace(/\s+/g, ' ');
    var tag = el.tagName.toLowerCase();
    return t ? '“' + (t.length > 28 ? t.slice(0, 27) + '…' : t) + '”' : 'a ' + (tag === 'a' ? 'link' : tag === 'img' ? 'picture' : tag);
  }
  function audit(ctx) {
    var issues = [];
    var n = 0;
    function add(el, title, detail) {
      if (issues.length >= 40) return;
      var id = 'i' + (++n);
      el.setAttribute('data-beluga-issue', id);
      issues.push({ id: id, title: title, detail: detail });
    }
    var root = ctx.stage;
    root.querySelectorAll('[data-beluga-issue]').forEach(function (el) { el.removeAttribute('data-beluga-issue'); });
    root.querySelectorAll('img').forEach(function (img) {
      if (!img.hasAttribute('alt')) add(img, 'A picture has no description', 'Screen readers can’t say what it shows. Give it alt text, or alt="" when it’s only decoration.');
    });
    root.querySelectorAll('button, a[href], [role="button"], [role="link"]').forEach(function (el) {
      if (!nameOf(el)) add(el, 'A ' + (el.tagName === 'A' ? 'link' : 'button') + ' has no name', 'Screen readers can only call it “button”. Give it words, or an aria-label.');
    });
    root.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]), select, textarea').forEach(function (el) {
      if (!labelled(el)) add(el, 'A field has no label', el.getAttribute('placeholder') ? 'Its placeholder goes away as you type. Give it a label people and screen readers keep.' : 'Nothing says what goes in it. Give it a label.');
    });
    var last = 0;
    root.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach(function (h) {
      var level = Number(h.tagName[1]);
      if (last && level > last + 1) add(h, 'A heading skips a level', what(h) + ' is a level ' + level + ' heading right after a level ' + last + '. Screen reader users jump by heading level.');
      last = level;
    });
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    var seen = new Set();
    while (walker.nextNode()) {
      var node = walker.currentNode;
      var el = node.parentElement;
      if (!el || seen.has(el) || !node.textContent.trim()) continue;
      seen.add(el);
      var cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue;
      var fg = rgb(cs.color);
      var bg = backgroundOf(el);
      if (!fg || !bg) continue;
      var a = lum(fg), b = lum(bg);
      var ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      var size = parseFloat(cs.fontSize);
      var large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
      var need = large ? 3 : 4.5;
      if (ratio < need) add(el, 'Text is hard to read', what(el) + ' has a contrast of ' + ratio.toFixed(1) + ':1 with what’s behind it; it needs ' + need + ':1.');
    }
    ctx.post({ beluga: 'audit', issues: issues });
  }
  function highlight(id, ctx) {
    var el = ctx.stage.querySelector('[data-beluga-issue="' + id + '"]');
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.add('beluga-flash');
    setTimeout(function () { el.classList.remove('beluga-flash'); }, 1600);
  }

  // ---- a picture: the drawing, its styles written in, as SVG, onto a canvas, as PNG.
  function toDataUrl(blob) {
    return new Promise(function (resolve) { var r = new FileReader(); r.onload = function () { resolve(r.result); }; r.onerror = function () { resolve(''); }; r.readAsDataURL(blob); });
  }
  function inlined(source, clone) {
    var cs = getComputedStyle(source);
    var text = '';
    for (var i = 0; i < cs.length; i++) text += cs[i] + ':' + cs.getPropertyValue(cs[i]) + ';';
    clone.setAttribute('style', text);
    var a = source.children, b = clone.children;
    for (var j = 0; j < a.length && j < b.length; j++) inlined(a[j], b[j]);
  }
  function snapshot(ctx) {
    var stage = ctx.stage;
    var rect = stage.getBoundingClientRect();
    var width = Math.ceil(rect.width), height = Math.ceil(Math.max(rect.height, 40));
    var clone = stage.cloneNode(true);
    inlined(stage, clone);
    // Canvases (charts, shaders) as their pictures; images as data, so the SVG holds everything.
    var canvases = stage.querySelectorAll('canvas'), copies = clone.querySelectorAll('canvas');
    for (var i = 0; i < canvases.length; i++) {
      try {
        var img = document.createElement('img');
        img.src = canvases[i].toDataURL('image/png');
        img.setAttribute('style', copies[i].getAttribute('style') || '');
        copies[i].replaceWith(img);
      } catch (e) { /* a canvas it can't read */ }
    }
    var imgs = Array.prototype.slice.call(clone.querySelectorAll('img'));
    Promise.all(imgs.map(function (img) {
      var src = img.getAttribute('src') || '';
      if (!src || src.indexOf('data:') === 0) return null;
      return fetch(new URL(src, location.href).href).then(function (r) { return r.blob(); }).then(toDataUrl).then(function (d) { if (d) img.setAttribute('src', d); }).catch(function () {});
    })).then(function () {
      var html = new XMLSerializer().serializeToString(clone);
      var bg = document.documentElement.getAttribute('data-beluga-canvas') === 'dark' ? '#1e1c26' : '#ffffff';
      var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '"><foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml" style="background:' + bg + ';width:' + width + 'px;height:' + height + 'px">' + html + '</div></foreignObject></svg>';
      var image = new Image();
      image.onload = function () {
        try {
          var scale = Math.min(2, window.devicePixelRatio || 1) || 1;
          var canvas = document.createElement('canvas');
          canvas.width = width * scale; canvas.height = height * scale;
          var g = canvas.getContext('2d');
          g.scale(scale, scale);
          g.drawImage(image, 0, 0);
          ctx.post({ beluga: 'snapshot', png: canvas.toDataURL('image/png') });
        } catch (e) { ctx.post({ beluga: 'snapshot', failed: String(e && e.message || e) }); }
      };
      image.onerror = function () { ctx.post({ beluga: 'snapshot', failed: 'The drawing could not be turned into a picture' }); };
      image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    });
  }

  var last = null;
  window.__belugaTools = {
    handle: function (msg, ctx) {
      last = ctx;
      if (msg.beluga === 'pin') pin(msg.states || [], ctx);
      else if (msg.beluga === 'audit') audit(ctx);
      else if (msg.beluga === 'highlight') highlight(msg.id, ctx);
      else if (msg.beluga === 'snapshot') snapshot(ctx);
    },
    // A new build: pinned states put back on what it drew.
    rebuilt: function () { if (last && pinned.length) setTimeout(function () { pin(pinned, last); }, 0); }
  };
})();`;
