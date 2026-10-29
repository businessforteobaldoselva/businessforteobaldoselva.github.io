/* Test stand-in for unit C's host: implements just the window.CoveredStudio surface of studio/DESIGN.md 10.2 that
   the ext/* modules use, with the same h() allow-lists, so the ext code is exercised against the contract
   (not against its own assumptions). Test code only; never shipped. */
(function () {
  "use strict";
  var params = new URLSearchParams(location.search);
  var queue = [];
  var Boot = (window.__CoveredStudioBoot = { ready: function (fn) { queue.push(fn); } });

  var TAGS = "div span p ul ol li h2 h3 h4 button a strong em label input select textarea section header footer nav".split(" ");
  var PROPS = "class id type value placeholder title role tabindex hidden disabled checked min max rows for name href target rel src alt width height open autocomplete spellcheck".split(" ");
  function safeHref(u) { return /^(https?:\/\/|\/|#|mailto:|blob:)/i.test(String(u)) ? String(u) : "#"; }
  function h(tag, props) {
    if (TAGS.indexOf(tag) < 0) throw new Error("h(): tag not allowed: " + tag);
    var node = document.createElement(tag);
    Object.keys(props || {}).forEach(function (k) {
      var v = props[k];
      if (k === "on") { Object.keys(v).forEach(function (ev) { node.addEventListener(ev, v[ev]); }); return; }
      if (v === false || v == null) return;
      if (!(PROPS.indexOf(k) >= 0 || /^aria-|^data-/.test(k))) throw new Error("h(): prop not allowed: " + k);
      if (k === "href" || k === "src") v = safeHref(v);
      if (k === "disabled" || k === "checked" || k === "hidden" || k === "open") { node[k] = !!v; return; }
      node.setAttribute(k, v === true ? "" : String(v));
    });
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c == null || c === false) continue;
      node.appendChild(typeof c === "object" && c.nodeType ? c : document.createTextNode(String(c)));
    }
    return node;
  }

  var listeners = {};
  function on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); return function () { listeners[ev] = (listeners[ev] || []).filter(function (f) { return f !== fn; }); }; }
  function emit(ev, detail) { window.__events.push([ev, detail || null]); (listeners[ev] || []).slice().forEach(function (f) { f(detail); }); }
  window.__events = [];
  window.__edits = [];
  window.__toasts = [];

  function StudioError(res, body) {
    var e = new Error((body && body.error && body.error.message) || "Request failed");
    e.status = res.status; e.code = body && body.error && body.error.code; e.details = (body && body.error && body.error.details) || {};
    return e;
  }
  function call(method, path, body) {
    return fetch(location.origin + "/api" + path, { method: method, headers: { "Content-Type": "application/json", Authorization: "Bearer dev:" + (params.get("role") || "approver") + ":molly@x.test" }, body: body ? JSON.stringify(body) : undefined })
      .then(function (res) { return res.json().then(function (j) { if (!res.ok) throw StudioError(res, j); return j; }); });
  }

  var host = h("div", { id: "covered-studio", "data-studio-ui": "" });
  document.body.appendChild(host);
  var root = host.attachShadow({ mode: "open" });
  var styleEl = document.createElement("style");
  root.appendChild(styleEl);
  var bar = h("div", { class: "stub-bar", role: "complementary", "aria-label": "Studio" });
  var panelBody = h("div", { class: "stub-body" });
  var panelHost = h("div", { class: "stub-panel", hidden: true }, panelBody);
  var toastHost = h("div", { role: "status", "aria-live": "polite", class: "stub-toasts" });
  root.appendChild(bar); root.appendChild(panelHost); root.appendChild(toastHost);

  var panels = {}; var order = []; var current = null; var cleanup = null; var empties = {};
  var commands = [];

  function closePanel() {
    if (!current) return;
    var p = panels[current]; if (p && p.onHide) p.onHide();
    if (cleanup) cleanup(); cleanup = null;
    while (panelBody.firstChild) panelBody.removeChild(panelBody.firstChild);
    panelHost.hidden = true; var id = current; current = null; emit("panel:close", { id: id });
  }
  function openPanel(id) {
    var p = panels[id]; if (!p) return;
    if (current) closePanel();
    current = id; panelHost.hidden = false;
    panelBody.setAttribute("aria-label", p.title);
    var r = p.render(panelBody, window.CoveredStudio); cleanup = typeof r === "function" ? r : null;
    if (p.onShow) p.onShow();
    emit("panel:open", { id: id });
  }

  var tm = window.matchMedia("(max-width: 759px)");
  var studio = (window.CoveredStudio = {
    version: 1,
    config: { apiBase: location.origin + "/api", appUrl: location.origin, contentUrl: "/studio/content.json", build: { sha: "0123456789abcdef0123456789abcdef01234567", branch: "main", prNumber: null }, dev: true },
    me: params.get("role") === "none" ? null : { user: { id: "u-" + (params.get("uid") || "molly"), email: "molly@x.test", name: "Molly" }, role: params.get("role") || "approver", capabilities: { draft: true, publish: (params.get("role") || "approver") !== "editor", people: params.get("role") === "admin" } },
    mode: "browse",
    on: on, emit: emit,
    api: { get: function (p) { return call("GET", p); }, post: function (p, b) { return call("POST", p, b); }, put: function (p, b) { return call("PUT", p, b); }, del: function (p) { return call("DELETE", p); } },
    schema: {
      raw: { configSha256: "abcdef0123456789", files: { hero: { label: "Hero" }, how: { label: "Our story" } } },
      resolve: function (ref) { var m = /^homepage\.sections\.(\d+)$/.exec(ref); return m ? { itemType: { label: ["Hero", "Partners"][+m[1]] || "Section" } } : null; },
      label: function (ref) { return ({ "hero.headlineMain": "Hero > Headline", "site.ogImage": "Share picture", "homepage.sections.1.enabled": "Partners > Show" })[ref] || null; },
      fields: function () { return []; },
    },
    content: { get: function () { return null; }, base: function () { return null; }, files: function () { return { homepage: { path: "src/_data/homepage.json", data: { sections: [{ type: "hero", enabled: true }, { type: "partners", enabled: true }] } }, site: { path: "src/_data/site.json", data: { contactEmail: "hello@covered.test" } } }; } },
    staging: { _n: 0, count: function () { return studio.staging._n; }, toggle: function (ref) { window.__edits.push(["toggle", ref]); studio.staging._n++; emit("staged:change", { count: studio.staging._n }); }, save: function () { window.__edits.push(["save"]); return Promise.resolve({}); }, clear: function () { studio.staging._n = 0; } },
    drafts: { _cur: null, current: function () { return studio.drafts._cur; }, list: function () { return Promise.resolve([{ id: "u1--summer", title: "Summer edits", state: "draft", author: { name: "Molly" } }, { id: "u1--faq", title: "FAQ tidy", state: "ready", author: { name: "Amelia" } }]); }, setCurrent: function (id) { studio.drafts._cur = { id: id, previewUrl: "https://deploy-preview-9--x.test" }; window.__edits.push(["setCurrent", id]); emit("draft:change", { draft: studio.drafts._cur }); }, refresh: function () { return Promise.resolve(); }, submit: function () { window.__edits.push(["submit"]); return Promise.resolve(); }, publish: function () { window.__edits.push(["publish"]); return Promise.resolve(); } },
    ui: {
      h: h, root: root,
      registerPanel: function (p) { panels[p.id] = p; order.push(p.id); order.sort(function (a, b) { return (panels[a].order || 0) - (panels[b].order || 0); });
        while (bar.firstChild) bar.removeChild(bar.firstChild);
        order.forEach(function (id) { bar.appendChild(h("button", { type: "button", "data-tour": "panel-" + id, "data-panel-id": id, "aria-label": panels[id].title, on: { click: function () { studio.ui.togglePanel(id); } } }, panels[id].glyph)); }); },
      openPanel: openPanel, closePanel: closePanel, togglePanel: function (id) { if (current === id) closePanel(); else openPanel(id); },
      registerCommand: function (c) { commands.push(c); }, listCommands: params.get("nolist") ? undefined : function () { return commands.slice(); },
      registerEmptyState: function (id, fn) { empties[id] = fn; },
      toast: function (m, o) { window.__toasts.push([m, o && o.kind]); toastHost.textContent = m; },
      confirm: function (o) {
        return new Promise(function (resolve) {
          var returnTo = root.activeElement || document.activeElement;
          var ok = h("button", { type: "button", "data-confirm": "yes", on: { click: function () { done(true); } } }, o.confirmLabel || "OK");
          var no = h("button", { type: "button", "data-confirm": "no", on: { click: function () { done(false); } } }, "Cancel");
          var d = h("div", { role: "dialog", "aria-modal": "true", "aria-label": o.title, class: "stub-confirm" }, h("h3", null, o.title), h("p", null, o.body), no, ok);
          d.addEventListener("keydown", function (e) { if (e.key === "Escape") { e.stopPropagation(); done(false); } });
          function done(v) { if (d.parentNode) d.parentNode.removeChild(d); if (returnTo && returnTo.focus) returnTo.focus(); resolve(v); }
          root.appendChild(d); ok.focus();
        });
      },
      editRef: function (ref) { window.__edits.push(["editRef", ref]); },
      focusTrap: function () { return function () {}; },
    },
    util: {},
  });
  window.__commands = commands;
  window.__setStyle = function (css) { styleEl.textContent = css + "\n.stub-bar{position:fixed;right:8px;bottom:8px;display:flex;gap:6px}.stub-panel{position:fixed;right:8px;top:8px;width:360px;max-height:80vh;overflow:auto;background:#fff;border:1px solid #888;padding:8px}.stub-panel[hidden]{display:none}.stub-confirm{position:fixed;left:30%;top:30%;background:#fff;border:2px solid #333;padding:12px;z-index:2147483200}@media (max-width:759px){.stub-panel{left:0;right:0;top:auto;bottom:0;width:auto}}"; };

  // run everything that registered itself with Boot.ready, once all ext scripts are loaded
  window.__startStub = function (css) {
    window.__setStyle(css);
    queue.splice(0).forEach(function (fn) { fn(studio); });
    Boot.ready = function (fn) { fn(studio); };
    window.__started = true;
    emit("ready", {});
    emit("auth:change", { me: studio.me });
  };
})();
