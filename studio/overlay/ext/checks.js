(function (S) {
  "use strict";
  // "Check my changes" (studio/PHASE1-DESIGN.md 8.4, 8.5): runs the SAME content rule engine as the CI guard
  // (studio/content-rules/, bundled before this file) on the draft in the browser and lists what it finds in plain words.
  // Content-level checks only (words, links, pictures): the panel never calls itself an accessibility audit.
  // The pure parts (copy, grouping, gating, ignoring) are exported for the tests and for studio/guards/check-content-rules.js.

  var HEADER = "Check my changes";
  var SUBLINE = "These checks look at your words, links and pictures. They are not a full accessibility audit.";
  var BLOCK_MESSAGE = "Fix these first; they would stop your change from going live.";
  var NO_FACTS = "Link and picture-size checks are off: this preview does not know which pages and pictures the site has.";
  var GROUPS = [
    { id: "block", title: "Fix before sending", sev: "block" },
    { id: "warn", title: "Worth a look", sev: "warn" },
    { id: "info", title: "For your information", sev: "info" },
  ];

  // A block can never be ignored (CI would still stop it); warnings and notes can, on this device, for this draft only.
  function canIgnore(f) { return !!f && f.severity !== "block"; }

  // report = the engine's Report for the draft; baseReport = the same for the live content (or null)
  function summarize(report, baseReport, ignored) {
    var baseKeys = {};
    ((baseReport && baseReport.findings) || []).forEach(function (f) { baseKeys[f.key] = 1; });
    var ign = ignored || {};
    var rows = ((report && report.findings) || []).map(function (f) {
      return { finding: f, existing: baseKeys[f.key] === 1, ignored: canIgnore(f) && ign[f.key] === 1 };
    });
    // a problem already on the live site is not this person's doing and never stops them (CI holds it in its baseline)
    var blockers = rows.filter(function (r) { return r.finding.severity === "block" && !r.existing; });
    return { rows: rows, blockers: blockers, open: rows.filter(function (r) { return !r.ignored; }) };
  }
  function gate(summary) { return summary.blockers.length ? { blocked: true, message: BLOCK_MESSAGE, count: summary.blockers.length } : { blocked: false, message: "", count: 0 }; }
  function plural(n, one, many) { return n + " " + (n === 1 ? one : many); }
  function statusLine(summary) {
    var open = summary.open;
    var fix = open.filter(function (r) { return r.finding.severity === "block" && !r.existing; }).length;
    var look = open.filter(function (r) { return r.finding.severity !== "block" || r.existing; }).length;
    if (!fix && !look) return "Nothing to fix. Your words, links and pictures look fine.";
    if (fix && look) return plural(fix, "thing to fix", "things to fix") + " before sending, and " + plural(look, "to look at", "to look at") + ".";
    if (fix) return plural(fix, "thing to fix", "things to fix") + " before sending.";
    return plural(look, "thing worth a look", "things worth a look") + ". None of them stops you from sending.";
  }
  function ignoreKeyFor(draftId) { return "covered.studio.v1.ignore:" + (draftId || "new"); }
  function readIgnored(storage, draftId) {
    var out = {};
    try { var v = JSON.parse(storage.get(ignoreKeyFor(draftId)) || "[]"); if (Array.isArray(v)) v.slice(0, 300).forEach(function (k) { if (typeof k === "string" && k.length < 400) out[k] = 1; }); } catch (e) { /* none */ }
    return out;
  }
  function writeIgnored(storage, draftId, map) {
    try { storage.set(ignoreKeyFor(draftId), JSON.stringify(Object.keys(map).slice(0, 300))); return true; } catch (e) { return false; }
  }

  var api = { HEADER: HEADER, SUBLINE: SUBLINE, BLOCK_MESSAGE: BLOCK_MESSAGE, NO_FACTS: NO_FACTS, GROUPS: GROUPS, canIgnore: canIgnore, summarize: summarize, gate: gate, statusLine: statusLine, ignoreKeyFor: ignoreKeyFor, readIgnored: readIgnored, writeIgnored: writeIgnored };
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (!S) return;
  S.ext = S.ext || {};
  S.ext.checks = api;

  S.ready(function (studio) {
    var ui = studio.ui;
    var h = ui.h;
    var U = studio.util;
    var Engine = window.CoveredContentRules;
    if (!Engine || typeof Engine.run !== "function") return; // bundle without the engine: no panel, no gate

    function plain(x) { return JSON.parse(JSON.stringify(x)); }
    function facts() {
      var c = studio.contentJson;
      var f = c && c.facts ? plain(c.facts) : null;
      if (!f) return null;
      f.images = f.images || {};
      // pictures chosen in this browser and not saved yet count too
      try { studio.staging.uploads().forEach(function (u) { if (u && u.name) f.images[u.name] = { bytes: u.size || 0, width: 0, height: 0 }; }); } catch (e) { /* none */ }
      return f;
    }
    function inputFor(docs, fct) { return { files: docs, schema: studio.schema.raw, facts: fct || {}, roles: S.fieldRoles || {} }; }
    function workingDocs() { var w = studio.staging._working(); var o = {}; Object.keys(w).forEach(function (k) { o[k] = plain(w[k]); }); return o; }
    function baseDocs() { var b = studio.staging._base(); var o = {}; Object.keys(b).forEach(function (k) { o[k] = plain(b[k]); }); return o; }
    var baseReportCache = null;
    function baseReport() {
      if (!baseReportCache) { try { baseReportCache = Engine.run(inputFor(baseDocs(), facts())); } catch (e) { baseReportCache = { findings: [] }; } }
      return baseReportCache;
    }
    function draftId() { try { return studio.drafts.remembered() || "new"; } catch (e) { return "new"; } }
    function check() {
      var fct = facts();
      var report = Engine.run(inputFor(workingDocs(), fct));
      return { report: report, summary: summarize(report, baseReport(), readIgnored(U_local(), draftId())), hasFacts: !!fct };
    }
    function U_local() { return S.util.local; }
    api.check = check;

    // ---- the gate: "Send for review" is refused while a block finding the draft added exists. Saving is never blocked.
    function gateSubmit() {
      var res = check();
      var g = gate(res.summary);
      if (!g.blocked) return null;
      var err = new Error(g.message);
      err.userMessage = g.message;
      err.code = "checks_block";
      return err;
    }
    api.gateSubmit = gateSubmit;

    function jump(f) {
      var ref = f.data && f.data.ref;
      var base = ref && S.panelFields && S.panelFields.baseRef ? S.panelFields.baseRef(studio, ref) : null;
      if (!base) { ui.toast("That part of the page is not there any more. Check again.", { kind: "info" }); return; }
      ui.editRef(base);
    }

    ui.registerPanel({
      id: "checks", title: HEADER, short: "Check", glyph: "✓", order: 12, minRole: "editor",
      render: function (container) {
        var root = h("div", { class: "ck" });
        var live = h("p", { class: "ck-status", role: "status", "aria-live": "polite", "data-ck-status": "1" });
        var list = h("div", { class: "ck-list" });
        var showIgnored = false;
        container.appendChild(h("p", { class: "ck-sub" }, SUBLINE));
        container.appendChild(h("button", { type: "button", class: "btn btn-small", "data-ck-run": "1", on: { click: function () { paint(true); } } }, "Check again"));
        container.appendChild(live);
        container.appendChild(list);

        function item(r, act) {
          var f = r.finding;
          return h("li", { class: "ck-item ck-" + f.severity, "data-ck-key": f.key },
            h("p", { class: "ck-msg" }, f.message),
            f.hint ? h("p", { class: "hint" }, f.hint) : null,
            r.existing ? h("p", { class: "hint ck-existing" }, "Already on the live site") : null,
            h("div", { class: "ck-acts" },
              f.fix && !act.unignore ? h("button", { type: "button", class: "btn btn-small", "data-ck-fix": "1", on: { click: function () { jump(f); } } }, "Fix") : null,
              canIgnore(f) && !act.unignore ? h("button", { type: "button", class: "btn btn-small", "data-ck-ignore": "1", on: { click: function () { setIgnored(f.key, true); } } }, "Ignore") : null,
              act.unignore ? h("button", { type: "button", class: "btn btn-small", "data-ck-unignore": "1", on: { click: function () { setIgnored(f.key, false); } } }, "Stop ignoring") : null));
        }
        function setIgnored(key, on) {
          var m = readIgnored(U_local(), draftId());
          if (on) m[key] = 1; else delete m[key];
          writeIgnored(U_local(), draftId(), m);
          paint(false);
        }
        function paint(announce) {
          var res;
          try { res = check(); } catch (e) { S.dom.clear(list); list.appendChild(h("p", { class: "error" }, "The check could not run. Reload the page and try again.")); return; }
          var sum = res.summary;
          S.dom.clear(list);
          if (!res.hasFacts) list.appendChild(h("p", { class: "hint", "data-ck-nofacts": "1" }, NO_FACTS));
          GROUPS.forEach(function (g) {
            var rows = sum.open.filter(function (r) { return g.sev === "block" ? r.finding.severity === "block" : r.finding.severity === g.sev; });
            if (!rows.length) return;
            list.appendChild(h("section", { class: "ck-group", "aria-label": g.title }, h("h3", { class: "ck-h" }, g.title + " (" + rows.length + ")"), h("ul", { class: "ck-ul" }, rows.map(function (r) { return item(r, {}); }))));
          });
          var hidden = sum.rows.filter(function (r) { return r.ignored; });
          if (hidden.length) {
            list.appendChild(h("details", { class: "ck-ignored", open: showIgnored, on: { toggle: function (ev) { showIgnored = !!ev.target.open; } } }, h("summary", null, "Ignored on this device (" + hidden.length + ")"), h("ul", { class: "ck-ul" }, hidden.map(function (r) { return item(r, { unignore: true }); }))));
          }
          live.textContent = statusLine(sum);
          if (announce) S.dom.announce(live.textContent);
        }
        var off = studio.on("staged:change", U.debounce(function () { if (container.isConnected) paint(false); }, 300));
        paint(false);
        container.appendChild(root);
        return function () { if (typeof off === "function") off(); };
      },
    });
    ui.registerCommand({ id: "checks.open", title: HEADER, keywords: ["check", "problems", "links", "alt text", "descriptions", "review", "mistakes"], group: "Go", when: function () { return !!studio.me && studio.mode === "edit"; }, run: function () { ui.openPanel("checks"); } });

    // Wrap submit once: every caller (command, palette, Changes panel, AI panel) goes through studio.drafts.submit.
    if (studio.drafts && typeof studio.drafts.submit === "function" && !studio.drafts.submit.__checksGate) {
      var raw = studio.drafts.submit;
      var gated = function () {
        var err = null;
        try { err = gateSubmit(); } catch (e) { err = null; } // a broken check must never lock people out; CI still stops it
        if (err) { ui.openPanel("checks"); return Promise.reject(err); }
        return raw.apply(studio.drafts, arguments);
      };
      gated.__checksGate = true;
      studio.drafts.submit = gated;
    }
  });
})(window.__CoveredStudioBoot);
