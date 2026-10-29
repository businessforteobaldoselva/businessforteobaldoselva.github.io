/* COVERED Studio overlay - core/dom.js
   h(tag, props, ...children) is the ONLY element factory of the overlay. Tags and properties come from
   allow-lists; handlers are attached with addEventListener (props.on), never as attributes; strings become
   text nodes (so editor and server text can never be parsed as HTML); href/src go through safeHref(). */
(function (S) {
  "use strict";
  var TAGS = {};
  ("div span p a button input textarea select option label form fieldset legend ul ol li h1 h2 h3 h4 h5 h6 strong em code pre " +
   "table thead tbody tr th td img canvas small br hr details summary section header footer nav main aside figure figcaption kbd mark")
    .split(" ").forEach(function (t) { TAGS[t] = true; });
  var PROPS = {};
  ("class id type value placeholder title role tabindex hidden disabled checked min max rows for name href target rel src alt width height open " +
   "selected multiple maxlength accept step autocomplete spellcheck colspan readonly required draggable")
    .split(" ").forEach(function (p) { PROPS[p] = true; });
  var BOOL = { hidden: 1, disabled: 1, checked: 1, open: 1, selected: 1, multiple: 1, readonly: 1, required: 1, draggable: 1 };

  function h(tag, props) {
    if (!TAGS[tag]) throw new Error("studio: tag not allowed: " + tag);
    var el = document.createElement(tag);
    props = props || {};
    Object.keys(props).forEach(function (k) {
      var v = props[k];
      if (v === undefined || v === null || v === false) return;
      if (k === "on") {
        Object.keys(v).forEach(function (ev) { el.addEventListener(ev, v[ev]); });
      } else if (k === "class") {
        el.setAttribute("class", String(v));
      } else if (k === "href" || k === "src") {
        var safe = S.util.safeHref(v, true);
        if (safe === null) return;
        el.setAttribute(k, safe);
      } else if (k.indexOf("aria-") === 0 || k.indexOf("data-") === 0 || PROPS[k]) {
        if (k.indexOf("data-") === 0 && !/^data-[a-z0-9-]+$/.test(k)) return;
        if (k.indexOf("aria-") === 0 && !/^aria-[a-z-]+$/.test(k)) return;
        if (BOOL[k]) { if (v) el.setAttribute(k, ""); } else el.setAttribute(k, String(v));
        if (k === "value" && (tag === "input" || tag === "textarea" || tag === "select")) el.value = String(v);
        if (k === "checked" && v) el.checked = true;
      }
    });
    for (var i = 2; i < arguments.length; i += 1) append(el, arguments[i]);
    return el;
  }
  function append(el, c) {
    if (c === null || c === undefined || c === false || c === true) return;
    if (Array.isArray(c)) { c.forEach(function (x) { append(el, x); }); return; }
    if (typeof c === "string" || typeof c === "number") { el.appendChild(document.createTextNode(String(c))); return; }
    if (c && c.nodeType) el.appendChild(c);
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }

  // Visually hidden live region (created by the shell) - one announce() for everything.
  var live = null;
  function setLive(el) { live = el; }
  function announce(msg) {
    if (!live) return;
    live.textContent = "";
    setTimeout(function () { if (live) live.textContent = S.util.visible(msg); }, 30);
  }

  var FOCUSABLE = "a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex='-1'])";
  function focusables(root) {
    return Array.prototype.filter.call(root.querySelectorAll(FOCUSABLE), function (n) { return !n.hidden && n.getAttribute("aria-hidden") !== "true"; });
  }
  // Keeps Tab inside `el`; returns a release function that gives the focus back.
  function focusTrap(el) {
    var root = el.getRootNode && el.getRootNode();
    var before = root && root.activeElement ? root.activeElement : document.activeElement;
    function onKey(e) {
      if (e.key !== "Tab") return;
      var f = focusables(el);
      if (!f.length) { e.preventDefault(); return; }
      var first = f[0];
      var last = f[f.length - 1];
      var active = (el.getRootNode && el.getRootNode().activeElement) || document.activeElement;
      if (e.shiftKey && (active === first || !el.contains(active))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (active === last || !el.contains(active))) { e.preventDefault(); first.focus(); }
    }
    el.addEventListener("keydown", onKey);
    return function release() {
      el.removeEventListener("keydown", onKey);
      if (before && before.focus && document.contains(before) || (before && before.isConnected)) { try { before.focus(); } catch (e) { /* ignore */ } }
    };
  }

  S.dom = { h: h, clear: clear, announce: announce, setLive: setLive, focusTrap: focusTrap, focusables: focusables };
})(window.__CoveredStudioBoot);
