(function (S) {
  "use strict";
  // Edit-mode legend (studio/PHASE1-DESIGN.md 9.1): a chip in the dock that says how many things can be edited on THIS page
  // ("14 editable things here") and opens a small legend (what each kind of thing is, how to move around).
  // The count is the number of DISTINCT refs among markers of the leaf kinds below, counted once per ref; wrappers (item, section)
  // are not counted. The pure parts are exported for tests and for the guard (studio/guards/check-content-rules.js).

  var LEAF = { text: 1, longtext: 1, markdown: 1, image: 1, link: 1, color: 1, toggle: 1 };
  var KINDS = [
    { id: "text", label: "Text", words: ["text", "longtext", "markdown"], hint: "Click it, type, press Enter." },
    { id: "image", label: "Picture", words: ["image"], hint: "Click it to choose a new photo and describe it." },
    { id: "link", label: "Link", words: ["link"], hint: "Click it to change where it goes." },
    { id: "color", label: "Colour", words: ["color"], hint: "Click it to pick another colour." },
    { id: "toggle", label: "Switch", words: ["toggle"], hint: "Click it to turn something on or off." },
    { id: "section", label: "Section", words: [], hint: "Select a section to hide, show or move it." },
  ];
  var MOVES = [
    ["]", "next thing you can edit"],
    ["[", "previous thing you can edit"],
    ["Enter", "edit the selected thing"],
    ["Esc", "let go, one step at a time"],
  ];

  function plural(n) { return n === 1 ? "1 editable thing here" : n + " editable things here"; }
  // markers: [{ ref, kind }] -> number of distinct refs of leaf kinds
  function countEditable(markers) {
    var seen = {};
    var n = 0;
    (markers || []).forEach(function (m) {
      if (!m || typeof m.ref !== "string" || !LEAF[m.kind] || seen[m.ref]) return;
      seen[m.ref] = 1;
      n += 1;
    });
    return n;
  }
  function countByKind(markers) {
    var seen = {};
    var by = {};
    (markers || []).forEach(function (m) {
      if (!m || typeof m.ref !== "string" || !LEAF[m.kind] || seen[m.ref]) return;
      seen[m.ref] = 1;
      by[m.kind] = (by[m.kind] || 0) + 1;
    });
    return by;
  }
  function chipText(n) { return n === 0 ? "Nothing editable here" : plural(n); }
  function sentence(n) { return n === 0 ? "Nothing on this page can be edited here; use All fields." : plural(n) + "."; }

  var api = { LEAF: LEAF, KINDS: KINDS, MOVES: MOVES, countEditable: countEditable, countByKind: countByKind, chipText: chipText, sentence: sentence };
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (!S) return;
  S.ext = S.ext || {};
  S.ext.legend = api;

  S.ready(function (studio) {
    var ui = studio.ui;
    var h = ui.h;
    var chip = null;

    function markers() { try { return studio.inspect.markers(); } catch (e) { return []; } }
    function count() { return countEditable(markers().map(function (m) { return { ref: m.ref, kind: m.kind }; })); }
    api.count = count;
    api.liveSentence = function () { return sentence(count()); };

    ui.registerDockItem({
      id: "legend", order: 20,
      build: function () {
        var n = count();
        chip = h("button", { type: "button", class: "dock-btn dock-chip", "data-legend-chip": "1", "aria-expanded": ui.currentPanel && ui.currentPanel() === "legend" ? "true" : "false", "aria-label": n === 0 ? "Nothing on this page can be edited here. Open the legend." : n + (n === 1 ? " editable thing" : " editable things") + " on this page. Open the legend.", on: { click: function () { ui.togglePanel("legend"); } } },
          h("span", { class: "dock-glyph", "aria-hidden": "true" }, "▣"), h("span", { class: "dock-text", "data-legend-count": String(n) }, chipText(n)));
        return chip;
      },
    });

    ui.registerPanel({
      id: "legend", title: "What you can edit here", glyph: "▣", order: 5, noDock: true,
      render: function (container) {
        var markersNow = markers().map(function (m) { return { ref: m.ref, kind: m.kind }; });
        var by = countByKind(markersNow);
        var sections = markers().filter(function (m) { return m.kind === "section"; }).length;
        var n = countEditable(markersNow);
        var rows = KINDS.map(function (k) {
          var c = k.id === "section" ? sections : k.words.reduce(function (a, w) { return a + (by[w] || 0); }, 0);
          return h("li", { class: "lg-row" }, h("span", { class: "lg-dot lg-" + k.id, "aria-hidden": "true" }), h("span", { class: "lg-text" }, h("strong", null, k.label + (c ? " (" + c + ")" : "")), " ", h("span", { class: "lg-hint" }, k.hint)));
        });
        var wrap = h("div", { class: "lg" },
          h("p", { class: "lg-count", "data-legend-total": String(n), role: "status" }, n === 0 ? "Nothing on this page can be edited here. Use All fields to change the rest." : n === 1 ? "You can edit 1 thing on this page." : "You can edit " + n + " things on this page."),
          h("p", { class: "hint" }, "Hover or move to a part of the page and it gets an outline with its name. Click it to change it."),
          h("ul", { class: "lg-list" }, rows),
          h("h3", { class: "lg-h" }, "Moving around with the keyboard"),
          h("ul", { class: "lg-keys" }, MOVES.map(function (m) { return h("li", null, h("kbd", null, m[0]), " ", m[1]); })),
          h("p", { class: "hint" }, "Parts that are not on the page itself (search and sharing text, link addresses, picture descriptions) are in All fields."),
          h("button", { type: "button", class: "btn", on: { click: function () { ui.openPanel("fields"); } } }, "Open All fields"));
        container.appendChild(wrap);
      },
    });

    studio.on("panel:open", function (d) { if (d.id === "legend" && chip) chip.setAttribute("aria-expanded", "true"); });
    studio.on("panel:close", function (d) {
      if (d.id !== "legend") return;
      if (ui.rebuildDock) ui.rebuildDock();
      if (chip && chip.isConnected) { try { chip.focus(); } catch (e) { /* ignore */ } }
    });
  });
})(window.__CoveredStudioBoot);
