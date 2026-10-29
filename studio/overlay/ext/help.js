(function (S) {
  "use strict";
  // Help panel ("?"): plain-English how-to, shortcut table, what the words mean, what THIS person can do, build info.
  // Static text only; the few dynamic values (role, contact address, build info) go in as text nodes.

  var SHORTCUTS = [
    ["Ctrl/Cmd + K", "Search everything you can do"],
    ["E", "Switch between browsing and editing"],
    ["Enter", "Edit the selected thing"],
    ["] and [", "Next / previous thing you can edit"],
    ["Alt + Up / Down", "Move the selected section or item"],
    ["Ctrl/Cmd + S", "Save your changes as a draft"],
    ["Ctrl/Cmd + Z", "Undo your last change (Shift to redo)"],
    ["Esc", "Close what is open, one step at a time"],
    ["?", "Open this help"],
  ];

  var WORDS = [
    ["Draft", "Your changes, saved safely on the side. The live website does not change while something is a draft."],
    ["Review", "Once you send a draft for review, an approver looks at it. They see exactly what you changed."],
    ["Publish", "An approver presses Publish and the changes go live on the website. You cannot publish your own draft."],
    ["Restore", "Undo a change that has already gone live. It makes a new draft, which an approver publishes like any other."],
  ];

  var HOWTO = [
    "Press E (or the Edit button), then click any text or picture on the page.",
    "Type your change and press Enter. For a picture, choose a new photo and add a short description for people who cannot see it.",
    "Press Save draft. Then Send for review when you are happy.",
    "An approver publishes it. Made a mistake after it went live? Open History and press Restore.",
  ];

  function capabilityLines(me) {
    var role = me && me.role;
    var lines = [];
    if (!role) return ["Sign in to see what you can do."];
    lines.push("Change text, pictures, links and colours, and save them as a draft.");
    lines.push("Hide, show and reorder sections.");
    lines.push("Undo a change that has gone live (it becomes a new draft).");
    if (role === "approver" || role === "admin") lines.push("Publish a draft that someone else wrote, once the checks are green.");
    else lines.push("Publishing is done by an approver. Send your draft for review and they will take it from there.");
    if (role === "admin") lines.push("Manage who can use Studio, and what they can do.");
    return lines;
  }

  var api = { SHORTCUTS: SHORTCUTS, WORDS: WORDS, HOWTO: HOWTO, capabilityLines: capabilityLines };
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (!S) return;
  S.ext = S.ext || {};
  S.ext.help = api;

  S.ready(function (studio) {
    var ui = studio.ui;
    function el(tag, props) {
      var kids = [];
      for (var i = 2; i < arguments.length; i++) {
        var k = arguments[i];
        if (Array.isArray(k)) kids.push.apply(kids, k.filter(function (x) { return x != null && x !== false; }));
        else if (k != null && k !== false) kids.push(k);
      }
      return ui.h.apply(ui, [tag, props || null].concat(kids));
    }

    function contactEmail() {
      try {
        var f = studio.content.files();
        var v = f && f.site && f.site.data && f.site.data.contactEmail;
        return typeof v === "string" && v.length < 120 ? v : "";
      } catch (e) { return ""; }
    }
    function buildInfo() {
      var c = studio.config || {};
      var b = c.build || {};
      var parts = [];
      parts.push("Version " + (studio.version || 1));
      if (b.sha) parts.push("build " + String(b.sha).slice(0, 7));
      if (b.branch) parts.push("branch " + b.branch);
      try { var sh = studio.schema && studio.schema.raw && studio.schema.raw.configSha256; if (sh) parts.push("rules " + String(sh).slice(0, 8)); } catch (e) { /* optional */ }
      return parts.join(" · ");
    }

    function render(container) {
      var root = el("div", { class: "csx-help" });
      function section(title, children) { return el("div", { class: "csx-help-sec", role: "group", "aria-label": title }, el("h3", { class: "csx-day-title" }, title), children); }
      function paint() {
        while (root.firstChild) root.removeChild(root.firstChild);
        var mail = contactEmail();
        var who = studio.me ? studio.me.role : null;
        root.appendChild(el("p", { class: "csx-intro" }, "Studio lets you change the website without touching any code. Nothing you do goes live until someone else approves it."));
        root.appendChild(section("Quick start", el("ol", { class: "csx-steps" }, HOWTO.map(function (t) { return el("li", null, t); }))));
        root.appendChild(section("What these words mean", el("ul", { class: "csx-words" }, WORDS.map(function (w) { return el("li", null, el("strong", null, w[0] + ": "), w[1]); }))));
        root.appendChild(section(who ? "What you can do (" + who + ")" : "What you can do", el("ul", { class: "csx-lines" }, capabilityLines(studio.me).map(function (t) { return el("li", null, t); }))));
        root.appendChild(section("Keyboard shortcuts", el("ul", { class: "csx-keys" }, SHORTCUTS.map(function (s) { return el("li", null, el("span", { class: "csx-key" }, s[0]), " ", el("span", null, s[1])); }))));
        root.appendChild(section("Take the tour again", el("button", { type: "button", class: "csx-btn", "data-help-tour": "1", on: { click: function () { ui.closePanel(); if (S.ext.tour && S.ext.tour.start) S.ext.tour.start({ force: true }); } } }, "Replay the tour")));
        root.appendChild(section("Something not working?", el("p", null,
          mail ? ["Tell us at ", el("strong", null, mail), " and say what you were doing. "] : "Tell the person who set Studio up and say what you were doing. ",
          "If a save is refused, the message next to the field says what to fix.")));
        root.appendChild(el("p", { class: "csx-muted csx-build" }, buildInfo()));
      }
      paint();
      container.appendChild(root);
      var off = studio.on("auth:change", paint);
      return function () { if (typeof off === "function") off(); if (root.parentNode) root.parentNode.removeChild(root); };
    }

    ui.registerPanel({ id: "help", title: "Help", glyph: "?", order: 90, render: render });
    ui.registerCommand({ id: "help.open", title: "Open Help", keywords: ["help", "how", "guide", "shortcuts", "keys", "what is a draft", "explain"], group: "Go", shortcut: "?", run: function () { ui.openPanel("help"); } });

    // "?" opens Help when no field is focused.
    document.addEventListener("keydown", function (ev) {
      if (ev.key !== "?" || ev.ctrlKey || ev.metaKey || ev.altKey) return;
      var path = ev.composedPath ? ev.composedPath() : [ev.target];
      for (var i = 0; i < path.length; i++) {
        var n = path[i];
        if (n && n.nodeType === 1) {
          var t = (n.tagName || "").toLowerCase();
          if (t === "input" || t === "textarea" || t === "select" || n.isContentEditable) return;
        }
      }
      ev.preventDefault();
      ui.togglePanel("help");
    });
  });
})(typeof window !== "undefined" ? window.__CoveredStudioBoot : null);
