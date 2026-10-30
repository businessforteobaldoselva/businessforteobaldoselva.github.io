/* COVERED Studio overlay - main.js
   Boot. Does nothing at all unless this visit asked for Studio (?studio=1, remembered for the tab in
   sessionStorage, or #studio): a normal visitor of a preview sees the unmodified site. Builds window.CoveredStudio
   (DESIGN 10.2), loads the page's content snapshot and the API's public config, and starts the UI. */
(function (S) {
  "use strict";
  var U = S.util;

  function activated() {
    var search = location.search || "";
    if (/[?&]studio=0(&|$)/.test(search)) { U.session.del("covered.studio.on"); return false; }
    if (/[?&]studio=1(&|$)/.test(search)) { U.session.set("covered.studio.on", "1"); return true; }
    if (location.hash === "#studio") { U.session.set("covered.studio.on", "1"); return true; }
    return U.session.get("covered.studio.on") === "1";
  }
  // https://... or http://localhost[:port] / 127.0.0.1[:port] only
  function okOrigin(u) {
    try {
      var x = new URL(u);
      if (x.username || x.password) return false;
      if (x.protocol === "https:") return true;
      return x.protocol === "http:" && (x.hostname === "localhost" || x.hostname === "127.0.0.1");
    } catch (e) { return false; }
  }

  if (!activated()) return;
  if (S.studio) return; // already booted

  var tag = document.currentScript || document.querySelector("script[data-studio]");
  var data = function (k) { return tag && tag.getAttribute ? tag.getAttribute(k) : null; };
  var apiBase = data("data-api") && okOrigin(data("data-api")) ? data("data-api").replace(/\/+$/, "") : "";
  var appUrl = data("data-app") && okOrigin(data("data-app")) ? data("data-app").replace(/\/+$/, "") : "";
  var contentUrl = data("data-content") && /^\/[A-Za-z0-9._\/-]+$/.test(data("data-content")) ? data("data-content") : "/studio/content.json";
  S.state.config = { apiBase: apiBase, appUrl: appUrl, contentUrl: contentUrl, build: { sha: null, branch: null, prNumber: null }, dev: false };

  var shell = S.shell.create((S.css || []).join("\n"));
  var sc = S.schemaClient.create(S.schema);
  var studio = null;
  var staging = null;
  var drafts = null;
  var content = null;

  // ---- window.CoveredStudio -------------------------------------------------
  function refParts(ref) { return U.parseRef(ref); }
  studio = {
    version: 1,
    config: S.state.config,
    on: S.events.on,
    emit: S.events.emit,
    api: S.api,
    schemaClient: sc,
    inspect: S.inspect,
    schema: {
      raw: S.schema,
      resolve: function (ref) { var p = refParts(ref); return p && staging ? sc.resolve(p.file, p.segs, staging._base()[p.file]) : null; },
      label: function (ref) { var p = refParts(ref); return p && staging ? sc.labelFor(p.file, p.segs, staging._base()[p.file]) : String(ref); },
      fields: function (ref) { var p = refParts(ref); var r = p && staging ? sc.resolve(p.file, p.segs, staging._base()[p.file]) : null; return r ? sc.childrenOf(r.field, staging.get(ref)) : []; },
    },
    content: {
      get: function (ref) { return staging ? staging.get(ref) : undefined; },
      base: function (ref) { return staging ? staging.base(ref) : undefined; },
      files: function () { return staging ? staging.files() : []; },
    },
    util: { debounce: U.debounce, uuid: U.uuid, truncate: U.truncate },
    setMode: setMode,
    toggleEdit: function () { if (S.state.mode === "edit") setMode("browse"); else if (!S.state.me) shell.openPanel("account"); else setMode("edit"); },
  };
  Object.defineProperty(studio, "me", { get: function () { return S.state.me; }, enumerable: true });
  Object.defineProperty(studio, "mode", { get: function () { return S.state.mode; }, enumerable: true });
  Object.defineProperty(studio, "previewConfig", { get: function () { return S.state.previewConfig; } });
  Object.defineProperty(studio, "contentJson", { get: function () { return content; } });
  Object.defineProperty(studio, "staging", { get: function () { return staging; }, enumerable: true });
  Object.defineProperty(studio, "drafts", { get: function () { return drafts; }, enumerable: true });

  studio.ui = {
    h: S.dom.h,
    registerPanel: shell.registerPanel,
    openPanel: shell.openPanel,
    closePanel: shell.closePanel,
    togglePanel: shell.togglePanel,
    registerCommand: shell.registerCommand,
    registerEmptyState: shell.registerEmptyState,
    emptyState: shell.emptyState,
    toast: shell.toast,
    confirm: shell.confirm,
    dialog: shell.dialog,
    focusTrap: S.dom.focusTrap,
    hostWrap: shell.wrap,
    root: shell.root,
    listCommands: shell.commands,
    commands: shell.commands,
    panels: shell.panels,
    runCommand: function (id) {
      var c = shell.commands().filter(function (x) { return x.id === id; })[0];
      if (c && (!c.when || c.when(studio))) c.run(studio);
    },
    editRef: function (ref) {
      var m = S.inspect.markerForRef(ref);
      if (!m && /\.enabled$/.test(ref)) m = S.inspect.markerForRef(ref.replace(/\.enabled$/, ""));
      if (m) {
        if (S.state.mode !== "edit") setMode("edit");
        S.inspect.select(m, { scroll: true });
        if (/^(text|longtext|markdown|link|color|image)$/.test(m.kind)) S.inspect.openEditor(m);
        return;
      }
      S.panelFields.pending = ref;
      shell.closePanel(true);
      shell.openPanel("fields");
    },
  };

  // ---- modes ------------------------------------------------------------------
  function setMode(mode) {
    if (mode === S.state.mode) return;
    if (mode === "edit" && !S.state.me) { studio.toggleEdit(); return; }
    if (mode !== "edit" && S.editors.isEditing()) S.editors.finishInline(false);
    S.state.mode = mode;
    if (mode === "edit") document.documentElement.setAttribute("data-studio-editing", ""); else document.documentElement.removeAttribute("data-studio-editing");
    U.session.set("covered.studio.mode", mode);
    shell.buildDock();
    if (mode !== "edit") shell.closePanel(true);
    S.events.emit("mode:change", { mode: mode });
    S.dom.announce(mode === "edit" ? "Edit mode on. Click any text or picture to change it." : "Edit mode off. The page works normally.");
  }

  // ---- commands + panels --------------------------------------------------------
  function registerBuiltins() {
    shell.registerPanel({ id: "changes", title: "Changes", glyph: "✎", order: 10, render: S.panelChanges.render, onShow: function () { if (drafts) drafts.startPolling(); }, onHide: function () { if (drafts) drafts.stopPolling(); } });
    shell.registerPanel({ id: "sections", title: "Sections", glyph: "☰", order: 20, render: S.panelSections.render });
    shell.registerPanel({ id: "fields", title: "Fields", glyph: "▤", order: 30, render: S.panelFields.render });
    shell.registerPanel({ id: "account", title: "Account", glyph: "☺", order: 90, render: S.panelAccount.render });
    var isEdit = function () { return S.state.mode === "edit" && !!S.state.me; };
    shell.registerCommand({ id: "save", title: "Save draft", keywords: ["save", "draft", "store"], group: "Draft", shortcut: "Ctrl+S", when: function () { return isEdit() && staging.count() > 0; }, run: function () { shell.openPanel("changes"); drafts.save({}).then(function () { shell.toast("Saved as a draft.", { kind: "success" }); }, function (e) { shell.toast(e.userMessage || e.message, { kind: "error" }); }); } });
    shell.registerCommand({ id: "submit", title: "Send for review", keywords: ["review", "submit"], group: "Draft", when: function () { var d = drafts.current(); return isEdit() && d && d.state === "draft"; }, run: function () { drafts.submit().then(function () { shell.toast("Sent for review.", { kind: "success" }); }, function (e) { shell.toast(e.userMessage || e.message, { kind: "error" }); }); } });
    shell.registerCommand({ id: "publish", title: "Publish", keywords: ["publish", "live", "merge"], group: "Draft", when: function () { var d = drafts.current(); return isEdit() && d && S.state.me.capabilities && S.state.me.capabilities.publish && d.canPublish !== false; }, run: function () { shell.openPanel("changes"); } });
    shell.registerCommand({ id: "discard-all", title: "Discard all changes", keywords: ["discard", "undo", "throw"], group: "Draft", when: function () { return isEdit() && staging.count() > 0; }, run: function () { shell.openPanel("changes"); } });
    shell.registerCommand({ id: "toggle-edit", title: "Toggle edit mode", keywords: ["edit", "browse"], group: "Studio", shortcut: "E", run: function () { studio.toggleEdit(); } });
    shell.registerCommand({ id: "open-changes", title: "Open Changes", keywords: ["changes", "review"], group: "Panels", when: isEdit, run: function () { shell.openPanel("changes"); } });
    shell.registerCommand({ id: "open-sections", title: "Open Sections", keywords: ["sections", "hide", "reorder"], group: "Panels", when: isEdit, run: function () { shell.openPanel("sections"); } });
    shell.registerCommand({ id: "open-fields", title: "Open Fields", keywords: ["fields", "form"], group: "Panels", when: isEdit, run: function () { shell.openPanel("fields"); } });
    shell.registerCommand({ id: "sign-out", title: "Sign out", keywords: ["logout"], group: "Account", when: function () { return !!S.state.me; }, run: function () { S.auth.signOut(); setMode("browse"); } });
  }

  // ---- storage key per person + draft -------------------------------------------
  function attachStorage() {
    var me = S.state.me;
    if (!me || !staging) return Promise.resolve();
    var host = apiBase ? new URL(apiBase).host : "none";
    var d = drafts.remembered();
    var key = "covered.studio.v1:" + host + ":" + me.user.id + ":" + (d || "new:" + (content.build && content.build.sha || "x"));
    staging.setStoreKey(key);
    return staging.load().then(function (r) {
      if (r.dropped && r.dropped.length) shell.toast(r.dropped.length + " unsaved picture change" + (r.dropped.length === 1 ? " was" : "s were") + " lost when the page reloaded.", { kind: "error" });
      else if (r.restored) shell.toast("Restored " + r.restored + " unsaved change" + (r.restored === 1 ? "" : "s") + " from this device.", { kind: "info" });
      S.inspect.sync();
    });
  }

  function start(c, pc) {
    content = c;
    S.state.content = c;
    S.state.previewConfig = pc;
    S.state.config.build = Object.assign({ sha: null, branch: null, prNumber: null }, c.build || {});
    S.state.config.dev = !!(pc && pc.auth && pc.auth.mode === "dev");
    staging = S.stagingLib.create({
      files: c.files, schemaClient: sc, storage: U.local, processImage: S.images.process,
      emit: function (ev, d) { if (ev === "staged:change") shell.setBadge(d.count); S.events.emit(ev, d); },
    });
    drafts = S.draftsLib.create({ staging: staging, api: S.api, events: S.events, content: c, isWatching: function () { return shell.currentPanel() === "changes"; } });
    S.inspect.init(studio, shell);
    registerBuiltins();
    S.events.on("auth:change", function (d) {
      shell.buildDock();
      if (d.me) attachStorage().then(function () { if (drafts.remembered()) drafts.refresh().catch(function () { /* draft may be gone */ }); });
    });
    S.events.on("auth:expired", function () { S.auth.signOut(); shell.openPanel("account"); });
    window.addEventListener("online", function () {
      if (drafts.status().offline) shell.toast("You're back online.", { kind: "info", actionLabel: "Send now", onAction: function () { drafts.save({ retry: true }).catch(function () { /* shown in the panel */ }); } });
    });
    // When the browser cannot keep edits on this device (private window, full or blocked storage) say so, and ask before leaving.
    var keepWarning = null;
    S.events.on("storage:state", function (d) {
      if (!d.kept && !keepWarning) keepWarning = shell.toast("Your changes can't be kept on this device, so save a draft before you leave this page.", { kind: "error", sticky: true });
      else if (d.kept && keepWarning) { keepWarning(); keepWarning = null; }
    });
    window.addEventListener("beforeunload", function (e) {
      staging.flush();
      if (staging.unsafeToLeave()) { e.preventDefault(); e.returnValue = ""; return ""; }
    });
    shell.mount(studio);
    window.CoveredStudio = studio;
    S._flushReady(studio);
    S.events.emit("ready", {});
    // remembered dev person: sign straight back in after a reload
    var remembered = S.state.config.dev ? S.auth.rememberedDevUser() : null;
    if (remembered) {
      S.auth.signInDev(remembered).then(function () { if (U.session.get("covered.studio.mode") === "edit") setMode("edit"); }, function () { /* show the panel instead */ });
    }
  }

  S.api.configure({ base: apiBase, getToken: S.auth.getToken });
  if (!S.schema || !S.schema.files) {
    shell.mount(studio);
    shell.toast("Studio is missing its editing rules (the preview was built without them).", { kind: "error" });
    return;
  }
  Promise.all([
    U.fetchOwnJson(contentUrl),
    apiBase ? S.api.get("/v1/preview-config", { noAuth: true }).catch(function () { return null; }) : Promise.resolve(null),
  ]).then(function (r) {
    start(r[0], r[1]);
    if (apiBase && !r[1]) shell.toast("Can't reach the Studio service right now. You can look around, but not save.", { kind: "error" });
  }, function () {
    shell.mount(studio);
    shell.toast("Studio could not load this page's content. Reload the preview.", { kind: "error" });
  });
})(window.__CoveredStudioBoot);
