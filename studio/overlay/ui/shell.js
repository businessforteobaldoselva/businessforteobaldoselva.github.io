/* COVERED Studio overlay - ui/shell.js
   The chrome: ONE host element with an open shadow root (so the site's CSS cannot touch the overlay and the
   overlay's CSS cannot touch the site), the dock (Edit pill + panel buttons), the panel / bottom sheet,
   dialogs, toasts, the live region, and the panel + command registries of window.CoveredStudio.ui.
   All text goes in through h() (text nodes). Styles come from a constructable stylesheet (no <style> element). */
(function (S) {
  "use strict";
  var h = S.dom.h;
  var clear = S.dom.clear;
  var ROLE_RANK = { editor: 1, approver: 2, admin: 3 };

  function create(css) {
    var host = document.createElement("div");
    host.id = "covered-studio";
    host.setAttribute("data-studio-ui", "");
    var root = host.attachShadow({ mode: "open" });
    var sheetOk = false;
    try {
      var sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      root.adoptedStyleSheets = [sheet];
      sheetOk = true;
      // the two attributes the overlay puts on site elements, styled from the page side
      var pageSheet = new CSSStyleSheet();
      pageSheet.replaceSync(
        "[data-studio-hidden]{opacity:.38!important;outline:2px dashed #5a5a5a!important;outline-offset:-2px}" +
        "[data-studio-removed]{opacity:.25!important;text-decoration:line-through}" +
        "[data-studio-dirty]{outline:2px solid #1f6f3f!important;outline-offset:2px}" +
        "html[data-studio-editing] [data-cms]{cursor:pointer}" +
        "[data-studio-editing-now]{outline:2px solid #1d4ed8!important;outline-offset:3px;cursor:text!important}"
      );
      document.adoptedStyleSheets = document.adoptedStyleSheets.concat([pageSheet]);
    } catch (e) { sheetOk = false; }

    var layer = h("div", { class: "layer", "aria-hidden": "true" });
    var live = h("div", { class: "sr-only", role: "status", "aria-live": "polite" });
    S.dom.setLive(live);
    var toasts = h("div", { class: "toasts" });
    var dialogs = h("div", { class: "dialogs" });
    var panelTitle = h("h2", { class: "panel-title", tabindex: "-1" });
    var panelBody = h("div", { class: "panel-body" });
    var closeBtn = h("button", { type: "button", class: "icon-btn", "aria-label": "Close panel", on: { click: function () { closePanel(); } } }, "×");
    var panel = h("aside", { class: "panel", role: "complementary", "aria-label": "Studio", hidden: true }, h("div", { class: "grab", "aria-hidden": "true" }), h("div", { class: "panel-head" }, panelTitle, closeBtn), panelBody);
    var dock = h("div", { class: "dock", role: "toolbar", "aria-label": "Studio" });
    var wrap = h("div", { class: "wrap" }, layer, live, toasts, panel, dock, dialogs);
    root.appendChild(wrap);
    if (!sheetOk) wrap.setAttribute("data-unstyled", "");

    var panels = [];
    var commands = [];
    var emptyStates = {};
    var openId = null;
    var cleanup = null;
    var studioRef = null;
    var editBtn = null;
    var badge = null;
    var panelBtns = {};

    function role() { var me = S.state.me; return me ? ROLE_RANK[me.role] || 0 : 0; }

    function registerPanel(def) {
      if (!def || !def.id || typeof def.render !== "function") return;
      panels = panels.filter(function (p) { return p.id !== def.id; });
      panels.push(def);
      panels.sort(function (a, b) { return (a.order || 50) - (b.order || 50); });
      buildDock();
    }
    function registerCommand(def) {
      if (!def || !def.id || typeof def.run !== "function") return;
      commands = commands.filter(function (c) { return c.id !== def.id; });
      commands.push(def);
    }
    function visiblePanels() {
      return panels.filter(function (p) { return !p.minRole || role() >= (ROLE_RANK[p.minRole] || 0); });
    }

    function openPanel(id) {
      var def = panels.filter(function (p) { return p.id === id; })[0];
      if (!def) return;
      if (openId === id) return;
      if (openId) closePanel(true);
      openId = id;
      panelTitle.textContent = def.title;
      panel.setAttribute("aria-label", def.title);
      clear(panelBody);
      panel.hidden = false;
      wrap.setAttribute("data-panel-open", "");
      try { cleanup = def.render(panelBody, studioRef) || null; } catch (e) { panelBody.appendChild(h("p", { class: "error" }, "This panel could not be shown.")); if (typeof console !== "undefined") console.error(e); }
      if (def.onShow) { try { def.onShow(); } catch (e) { /* ignore */ } }
      Object.keys(panelBtns).forEach(function (k) { panelBtns[k].setAttribute("aria-expanded", k === id ? "true" : "false"); });
      panelTitle.focus();
      S.events.emit("panel:open", { id: id });
    }
    function closePanel(silent) {
      if (!openId) return;
      var def = panels.filter(function (p) { return p.id === openId; })[0];
      var id = openId;
      if (typeof cleanup === "function") { try { cleanup(); } catch (e) { /* ignore */ } }
      cleanup = null;
      if (def && def.onHide) { try { def.onHide(); } catch (e) { /* ignore */ } }
      openId = null;
      panel.hidden = true;
      clear(panelBody);
      wrap.removeAttribute("data-panel-open");
      Object.keys(panelBtns).forEach(function (k) { panelBtns[k].setAttribute("aria-expanded", "false"); });
      if (!silent) {
        var b = panelBtns[id];
        if (b) b.focus();
      }
      S.events.emit("panel:close", { id: id });
    }
    function togglePanel(id) { if (openId === id) closePanel(); else openPanel(id); }
    function refreshPanel() {
      if (!openId) return;
      var id = openId;
      closePanel(true);
      openPanel(id);
    }

    // ---- dock ----
    function buildDock() {
      clear(dock);
      panelBtns = {};
      badge = h("span", { class: "badge", hidden: true }, "0");
      editBtn = h("button", { type: "button", class: "pill", "data-tour": "pill", "aria-pressed": S.state.mode === "edit" ? "true" : "false", "aria-label": "Edit this page", on: { click: function () { if (studioRef) studioRef.toggleEdit(); } } },
        h("span", { class: "pill-label" }, S.state.mode === "edit" ? "Editing" : "Edit"), badge);
      dock.appendChild(editBtn);
      if (S.state.mode === "edit") {
        visiblePanels().forEach(function (p) {
          var b = h("button", { type: "button", class: "dock-btn", "data-panel-id": p.id, "data-tour": "panel-" + p.id, "aria-expanded": openId === p.id ? "true" : "false", "aria-label": p.title, title: p.title, on: { click: function () { togglePanel(p.id); } } },
            h("span", { class: "dock-glyph", "aria-hidden": "true" }, p.glyph || p.title.charAt(0)), h("span", { class: "dock-text" }, p.title));
          panelBtns[p.id] = b;
          dock.appendChild(b);
        });
      }
      setBadge(S.state._count || 0);
    }
    function setBadge(n) {
      S.state._count = n;
      if (!badge) return;
      badge.textContent = String(n);
      badge.hidden = !(n > 0);
      if (editBtn) editBtn.setAttribute("aria-label", "Edit this page" + (n > 0 ? ", " + n + " unsaved change" + (n === 1 ? "" : "s") : ""));
    }

    // ---- toasts ----
    function toast(message, o) {
      o = o || {};
      var kind = o.kind || "info";
      var t = h("div", { class: "toast toast-" + kind });
      t.appendChild(h("span", { class: "toast-text" }, message));
      var timer = null;
      function gone() { clearTimeout(timer); if (t.parentNode) t.parentNode.removeChild(t); }
      if (o.actionLabel && o.onAction) t.appendChild(h("button", { type: "button", class: "btn btn-small", on: { click: function () { try { o.onAction(); } finally { gone(); } } } }, o.actionLabel));
      t.appendChild(h("button", { type: "button", class: "icon-btn", "aria-label": "Dismiss message", on: { click: gone } }, "×"));
      toasts.appendChild(t);
      S.dom.announce(message);
      timer = setTimeout(gone, kind === "error" ? 12000 : 6000);
      return gone;
    }

    // ---- dialogs (modal; centred on desktop, bottom sheet on phones) ----
    var dialogStack = [];
    function dialog(o) {
      var titleId = "dlg-" + S.util.uuid().slice(0, 8);
      var back = h("div", { class: "backdrop" });
      var body = h("div", { class: "dialog-body" });
      var foot = h("div", { class: "dialog-foot" });
      var dlg = h("div", { class: "dialog", role: "dialog", "aria-modal": "true", "aria-labelledby": titleId },
        h("div", { class: "grab", "aria-hidden": "true" }),
        h("h2", { id: titleId, class: "dialog-title" }, o.title || ""), body, foot);
      var wrapper = h("div", { class: "dialog-wrap" }, back, dlg);
      var release = null;
      function close(result) {
        if (!wrapper.parentNode) return;
        dialogStack = dialogStack.filter(function (d) { return d !== api; });
        wrapper.parentNode.removeChild(wrapper);
        if (release) release();
        if (o.onClose) o.onClose(result);
      }
      var api = { el: dlg, body: body, foot: foot, close: close, wrapper: wrapper };
      back.addEventListener("click", function () { close(null); });
      dlg.addEventListener("keydown", function (e) {
        if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); close(null); }
      });
      dialogs.appendChild(wrapper);
      dialogStack.push(api);
      release = S.dom.focusTrap(dlg);
      if (o.build) o.build(body, foot, api);
      var first = S.dom.focusables(body)[0] || S.dom.focusables(foot)[0];
      if (first) first.focus(); else dlg.setAttribute("tabindex", "-1"), dlg.focus();
      return api;
    }
    function confirm(o) {
      return new Promise(function (resolve) {
        var done = false;
        dialog({
          title: o.title,
          onClose: function (r) { if (!done) resolve(false); done = true; },
          build: function (body, foot, api) {
            body.appendChild(h("p", null, o.body || ""));
            foot.appendChild(h("button", { type: "button", class: "btn", on: { click: function () { api.close(false); } } }, o.cancelLabel || "Cancel"));
            foot.appendChild(h("button", { type: "button", class: "btn " + (o.danger ? "btn-danger" : "btn-primary"), on: { click: function () { done = true; api.close(true); resolve(true); } } }, o.confirmLabel || "OK"));
          },
        });
      });
    }
    function hasDialog() { return dialogStack.length > 0; }

    // ---- keyboard on phones: keep sheets above the on-screen keyboard ----
    function trackViewport() {
      var vv = window.visualViewport;
      if (!vv) return;
      var upd = function () {
        var kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
        host.style.setProperty("--s-kb", Math.round(kb) + "px");
        host.style.setProperty("--s-vvh", Math.round(vv.height) + "px");
      };
      vv.addEventListener("resize", upd);
      vv.addEventListener("scroll", upd);
      upd();
    }

    function mount(studio) {
      studioRef = studio;
      document.body.appendChild(host);
      buildDock();
      trackViewport();
    }

    return {
      host: host, root: root, layer: layer, wrap: wrap, mount: mount, buildDock: buildDock, setBadge: setBadge,
      registerPanel: registerPanel, registerCommand: registerCommand, openPanel: openPanel, closePanel: closePanel, togglePanel: togglePanel, refreshPanel: refreshPanel,
      toast: toast, dialog: dialog, confirm: confirm, hasDialog: hasDialog, panels: function () { return panels; }, commands: function () { return commands; },
      registerEmptyState: function (id, fn) { emptyStates[id] = fn; }, emptyState: function (id) { return emptyStates[id] || null; },
      currentPanel: function () { return openId; }, panelBody: panelBody, sheetOk: sheetOk,
    };
  }
  S.shell = { create: create };
})(window.__CoveredStudioBoot);
