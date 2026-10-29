(function (S) {
  "use strict";
  // History panel (studio/DESIGN.md 11): merged changes, who/when/what in plain English, Restore opens a revert draft.
  // Written against window.CoveredStudio only. All server/editor text reaches the DOM through h() children (text nodes).
  // The pure part (view model) is exported for node tests; the DOM part runs only inside S.ready.

  // ------------------------------------------------------------------ pure view model
  var MIN = 60 * 1000;
  var HOUR = 60 * MIN;
  var DAY = 24 * HOUR;
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  var WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  var RESTORE_ROLES = { editor: 1, approver: 1, admin: 1 };

  function truncate(s, n) {
    s = String(s == null ? "" : s);
    return s.length > n ? s.slice(0, Math.max(0, n - 1)).replace(/\s+$/, "") + "…" : s;
  }
  function startOfDay(ms) {
    var d = new Date(ms);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  }
  function plural(n, one, many) { return n + " " + (n === 1 ? one : many); }

  function relativeTime(iso, nowMs) {
    var t = Date.parse(iso);
    if (isNaN(t)) return "";
    var diff = nowMs - t;
    if (diff < 0) diff = 0;
    if (diff < MIN) return "just now";
    if (diff < HOUR) return plural(Math.floor(diff / MIN), "minute", "minutes") + " ago";
    if (diff < DAY && startOfDay(t) === startOfDay(nowMs)) return plural(Math.floor(diff / HOUR), "hour", "hours") + " ago";
    var days = Math.round((startOfDay(nowMs) - startOfDay(t)) / DAY);
    if (days === 1) return "yesterday";
    if (days < 7) return days + " days ago";
    var d = new Date(t);
    return d.getDate() + " " + MONTHS[d.getMonth()] + (d.getFullYear() !== new Date(nowMs).getFullYear() ? " " + d.getFullYear() : "");
  }

  function exactTime(iso) {
    var t = Date.parse(iso);
    if (isNaN(t)) return "";
    var d = new Date(t);
    var p = function (n) { return (n < 10 ? "0" : "") + n; };
    return d.getDate() + " " + MONTHS_LONG[d.getMonth()] + " " + d.getFullYear() + ", " + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  function dayLabel(iso, nowMs) {
    var t = Date.parse(iso);
    if (isNaN(t)) return "Earlier";
    var days = Math.round((startOfDay(nowMs) - startOfDay(t)) / DAY);
    if (days <= 0) return "Today";
    if (days === 1) return "Yesterday";
    var d = new Date(t);
    return WEEKDAYS[d.getDay()] + " " + d.getDate() + " " + MONTHS_LONG[d.getMonth()] + (d.getFullYear() !== new Date(nowMs).getFullYear() ? " " + d.getFullYear() : "");
  }

  function humanize(stem) {
    var s = String(stem).replace(/[-_]+/g, " ").trim();
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : "";
  }

  // "src/_data/hero.json" -> "Hero"; "src/pages/about.md" -> "About page"; "images/x.jpg" -> "Picture x.jpg".
  function fileText(path, labelFor) {
    path = String(path);
    var m = /^src\/_data\/([a-z0-9-]+)\.json$/.exec(path);
    if (m) return (labelFor && labelFor(path, m[1])) || humanize(m[1]);
    m = /^src\/pages\/([a-z0-9-]+)\.md$/.exec(path);
    if (m) return ((labelFor && labelFor(path, "pages:" + m[1])) || humanize(m[1])) + " page";
    m = /^images\/(.+)$/.exec(path);
    if (m) return "Picture " + m[1];
    return path;
  }

  function summarizeFiles(files, labelFor) {
    var seen = {};
    var out = [];
    (files || []).forEach(function (f) {
      var t = fileText(f, labelFor);
      if (!seen[t]) { seen[t] = 1; out.push(t); }
    });
    return out;
  }

  var VIA = { studio: "Studio", decap: "the content editor", github: "GitHub" };

  function canRestoreRole(role) { return Object.prototype.hasOwnProperty.call(RESTORE_ROLES, role); }

  // items: HistoryItem[] (DESIGN 7.4). Returns { empty, groups: [{ label, rows: [Row] }] }.
  function buildViewModel(items, opts) {
    var o = opts || {};
    var now = o.now == null ? Date.now() : o.now;
    var maxTitle = o.maxTitle || 90;
    var preview = o.previewChanges || 3;
    var groups = [];
    var byLabel = {};
    (items || []).forEach(function (it) {
      var label = dayLabel(it.mergedAt, now);
      var g = byLabel[label];
      if (!g) { g = byLabel[label] = { label: label, rows: [] }; groups.push(g); }
      var lines = [];
      if (Array.isArray(it.changes) && it.changes.length) {
        lines = it.changes.map(function (c) { return String(c && c.summary ? (c.label ? c.label + ": " : "") + c.summary : (c && c.label) || ""); }).filter(Boolean);
      } else {
        var names = summarizeFiles(it.files, o.fileLabel);
        if (names.length) lines = ["Changed: " + names.join(", ")];
      }
      var author = it.author || {};
      var via = VIA[author.via] || "";
      g.rows.push({
        number: it.number,
        title: truncate(it.title || "Untitled change", maxTitle),
        authorText: (author.name || "Someone") + (via ? " via " + via : ""),
        timeText: relativeTime(it.mergedAt, now),
        exactTime: exactTime(it.mergedAt),
        iso: it.mergedAt,
        lines: lines.slice(0, preview),
        moreLines: lines.slice(preview),
        url: it.url || null,
        canRestore: !!it.restorable && canRestoreRole(o.role),
        restoreHint: !it.restorable ? "This change cannot be undone automatically." : !canRestoreRole(o.role) ? "You need an editor account to undo changes." : "",
        revertBadge: it.revertOf ? "Undo of #" + it.revertOf : "",
        mergedBy: it.mergedBy || "",
      });
    });
    return { empty: groups.length === 0, groups: groups };
  }

  var api = {
    truncate: truncate, relativeTime: relativeTime, exactTime: exactTime, dayLabel: dayLabel, fileText: fileText,
    summarizeFiles: summarizeFiles, buildViewModel: buildViewModel, canRestoreRole: canRestoreRole,
  };
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (!S) return;

  // ------------------------------------------------------------------ DOM part
  S.ext = S.ext || {};
  S.ext.history = api;

  function uuid() {
    try { if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID(); } catch (e) { /* fall through */ }
    var b = new Uint8Array(16);
    window.crypto.getRandomValues(b);
    b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    var hex = Array.prototype.map.call(b, function (x) { return (x < 16 ? "0" : "") + x.toString(16); }).join("");
    return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" + hex.slice(16, 20) + "-" + hex.slice(20);
  }

  S.ready(function (studio) {
    var ui = studio.ui;
    var PAGE = 20;

    // Record commands registered by anyone, so the palette can list them (it falls back to this when the host has no listing).
    S.ext.commands = S.ext.commands || [];
    if (typeof ui.registerCommand === "function" && !ui.registerCommand.__csxWrapped) {
      var orig = ui.registerCommand;
      var wrapped = function (cmd) {
        if (cmd && cmd.id && !S.ext.commands.some(function (c) { return c.id === cmd.id; })) S.ext.commands.push(cmd);
        return orig.apply(ui, arguments);
      };
      wrapped.__csxWrapped = true;
      ui.registerCommand = wrapped;
    }

    function el(tag, props) {
      var kids = [];
      for (var i = 2; i < arguments.length; i++) {
        var k = arguments[i];
        if (Array.isArray(k)) kids.push.apply(kids, k.filter(function (x) { return x != null && x !== false; }));
        else if (k != null && k !== false) kids.push(k);
      }
      return ui.h.apply(ui, [tag, props || null].concat(kids));
    }

    function fileLabel(path, key) {
      try {
        var raw = studio.schema && studio.schema.raw;
        if (raw && key.indexOf("pages:") !== 0 && raw.files && raw.files[key] && raw.files[key].label) return raw.files[key].label;
      } catch (e) { /* use the default */ }
      return null;
    }

    function render(container) {
      var state = { items: [], next: null, loading: false, error: null, loaded: false, busy: null, result: null, expanded: {} };
      var alive = true;
      var live = el("div", { class: "csx-visually-hidden", role: "status", "aria-live": "polite" });
      var root = el("div", { class: "csx-history" });
      container.appendChild(root);
      container.appendChild(live);
      function say(msg) { live.textContent = msg; }

      function load(more) {
        if (state.loading) return Promise.resolve();
        state.loading = true;
        state.error = null;
        paint();
        var q = "/v1/history?limit=" + PAGE + (more && state.next ? "&cursor=" + encodeURIComponent(state.next) : "");
        return studio.api.get(q).then(function (res) {
          var items = (res && res.items) || [];
          state.items = more ? state.items.concat(items) : items;
          state.next = (res && res.next) || null;
          state.loaded = true;
        }).catch(function (e) {
          state.error = (e && e.message) || "History could not be loaded.";
        }).then(function () {
          state.loading = false;
          if (alive) { paint(); say(state.error ? "History could not be loaded." : "History loaded."); }
        });
      }

      function restore(row, onConflict) {
        state.busy = row.number;
        paint();
        return studio.api.post("/v1/history/" + row.number + "/restore", { onConflict: onConflict, idempotencyKey: uuid() }).then(function (res) {
          state.busy = null;
          state.result = { ok: true, row: row, draft: res && res.draft, skipped: (res && res.skipped) || [] };
          paint();
          say("A draft that undoes this change was created.");
          if (res && res.draft) {
            try { if (studio.drafts && studio.drafts.setCurrent) studio.drafts.setCurrent(res.draft.id); } catch (e) { /* ignore */ }
            try { if (studio.drafts && studio.drafts.refresh) studio.drafts.refresh(); } catch (e) { /* ignore */ }
          }
          studio.emit("history:restored", { draft: res && res.draft });
          ui.toast("Draft created. Nothing is live until an approver publishes it.", { kind: "success" });
          try { ui.openPanel("changes"); } catch (e) { /* the host may not have a Changes panel */ }
        }).catch(function (e) {
          state.busy = null;
          if (e && e.status === 409 && e.code === "conflict" && onConflict === "abort") {
            var n = e.details && e.details.items ? e.details.items.length : 0;
            return ui.confirm({
              title: "Some parts have changed since",
              body: (n ? plural(n, "part has", "parts have") : "Some parts have") + " been edited again since this change. You can undo only the parts that are still the same. The newer edits stay as they are.",
              confirmLabel: "Undo the rest",
            }).then(function (yes) { if (yes) return restore(row, "skip"); paint(); });
          }
          state.result = { ok: false, message: (e && e.message) || "Could not create the draft." };
          paint();
          say(state.result.message);
          studio.emit("error", { error: e });
        });
      }

      function onRestore(row) {
        ui.confirm({
          title: "Undo this change?",
          body: "This opens a draft that undoes these changes. Nothing goes live until an approver publishes it.",
          confirmLabel: "Create undo draft",
        }).then(function (yes) { if (yes) restore(row, "abort"); });
      }

      function rowEl(row) {
        var titleId = "csx-h-" + row.number;
        var open = !!state.expanded[row.number];
        var lines = row.lines.concat(open ? row.moreLines : []);
        return el("div", { class: "csx-row", role: "group", "aria-labelledby": titleId, "data-pr": String(row.number) },
          el("h4", { class: "csx-row-title", id: titleId }, row.title, row.revertBadge ? el("span", { class: "csx-badge" }, row.revertBadge) : null),
          el("p", { class: "csx-meta" }, row.authorText, " · ", el("span", { class: "csx-time", title: row.exactTime }, row.timeText)),
          lines.length ? el("ul", { class: "csx-lines" }, lines.map(function (l) { return el("li", null, l); })) : null,
          row.moreLines.length ? el("button", { type: "button", class: "csx-link", "aria-expanded": open ? "true" : "false", on: { click: function () { state.expanded[row.number] = !open; paint(); focusRow(row.number, ".csx-link"); } } },
            open ? "Show fewer" : "Show " + row.moreLines.length + " more") : null,
          el("div", { class: "csx-actions" },
            row.url ? el("a", { href: row.url, target: "_blank", rel: "noopener noreferrer", class: "csx-link" }, "View on GitHub") : null,
            row.canRestore
              ? el("button", { type: "button", class: "csx-btn", disabled: state.busy != null, "data-restore": String(row.number), "aria-label": "Restore: undo " + row.title, on: { click: function () { onRestore(row); } } }, state.busy === row.number ? "Creating draft…" : "Restore")
              : el("span", { class: "csx-muted" }, row.restoreHint)));
      }

      function focusRow(n, sel) {
        var r = root.querySelector('[data-pr="' + n + '"] ' + sel);
        if (r && r.focus) r.focus();
      }

      function paint() {
        if (!alive) return;
        var role = studio.me && studio.me.role;
        var vm = buildViewModel(state.items, { now: Date.now(), role: role, fileLabel: fileLabel });
        root.setAttribute("aria-busy", state.loading ? "true" : "false");
        var kids = [];
        kids.push(el("div", { class: "csx-head" },
          el("p", { class: "csx-intro" }, "Everything that has gone live, newest first. You can undo a change: that makes a new draft for an approver to publish."),
          el("button", { type: "button", class: "csx-btn csx-btn-quiet", disabled: state.loading, on: { click: function () { load(false); } } }, "Refresh")));
        if (state.result) {
          if (state.result.ok) {
            kids.push(el("div", { class: "csx-result", role: "status", "data-result": "ok" },
              el("strong", null, "Undo draft created. "),
              "It is waiting for review",
              state.result.skipped && state.result.skipped.length ? " (" + plural(state.result.skipped.length, "part was", "parts were") + " left as they are because they changed since)" : "",
              ". ",
              state.result.draft && state.result.draft.url ? el("a", { href: state.result.draft.url, target: "_blank", rel: "noopener noreferrer", class: "csx-link" }, "Open pull request #" + state.result.draft.number) : null));
          } else {
            kids.push(el("div", { class: "csx-result csx-error", role: "alert", "data-result": "error" }, state.result.message));
          }
        }
        if (state.error) {
          kids.push(el("div", { class: "csx-error", role: "alert" }, el("p", null, state.error), el("button", { type: "button", class: "csx-btn", on: { click: function () { load(false); } } }, "Try again")));
        } else if (state.loading && !state.loaded) {
          kids.push(el("p", { class: "csx-muted", role: "status" }, "Loading history…"));
        } else if (vm.empty) {
          kids.push(el("div", { class: "csx-empty" }, el("p", null, el("strong", null, "Nothing has been published through Studio yet.")), el("p", { class: "csx-muted" }, "When a draft is published it shows up here, with who changed what, so you can always undo it.")));
        } else {
          vm.groups.forEach(function (g) {
            kids.push(el("div", { class: "csx-day", role: "group", "aria-label": g.label }, el("h3", { class: "csx-day-title" }, g.label), g.rows.map(rowEl)));
          });
          if (state.next) kids.push(el("button", { type: "button", class: "csx-btn csx-more", disabled: state.loading, on: { click: function () { load(true); } } }, state.loading ? "Loading…" : "Show earlier"));
        }
        var active = root.contains && root.getRootNode && root.getRootNode().activeElement;
        var key = active && active.getAttribute && (active.getAttribute("data-restore") || null);
        while (root.firstChild) root.removeChild(root.firstChild);
        kids.forEach(function (k) { root.appendChild(k); });
        if (key) { var again = root.querySelector('[data-restore="' + key + '"]'); if (again && !again.disabled) again.focus(); }
      }

      paint();
      load(false);
      return {
        refresh: function () { return load(false); },
        destroy: function () { alive = false; if (live.parentNode) live.parentNode.removeChild(live); if (root.parentNode) root.parentNode.removeChild(root); },
      };
    }

    var instance = null;
    ui.registerPanel({
      id: "history",
      title: "History",
      glyph: "↺",
      order: 40,
      render: function (container) {
        instance = render(container);
        return function () { if (instance) instance.destroy(); instance = null; };
      },
      onShow: function () { if (instance && instance.refresh) instance.refresh(); },
    });

    ui.registerCommand({
      id: "history.open", title: "Open History", keywords: ["history", "undo", "restore", "revert", "past", "changes", "published"], group: "Go",
      run: function () { ui.openPanel("history"); },
    });

    if (typeof ui.registerEmptyState === "function") {
      ui.registerEmptyState("changes", function () {
        return el("div", { class: "csx-empty" },
          el("p", null, el("strong", null, "No changes yet.")),
          el("p", { class: "csx-muted" }, "Click any text or picture on the page to change it. Your changes are kept here until you save them as a draft."));
      });
    }
  });
})(typeof window !== "undefined" ? window.__CoveredStudioBoot : null);
