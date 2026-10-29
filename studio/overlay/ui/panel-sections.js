/* COVERED Studio overlay - ui/panel-sections.js
   Every homepage section, including the hidden ones: show / hide, move up / down, jump to it.
   Works the same on a phone - this is how "hide a section from a phone" is done (DESIGN D9). */
(function (S) {
  "use strict";
  var h = S.dom.h;

  function render(container, studio) {
    var offs = [];
    var LIST = "homepage.sections";

    function sectionName(entry) {
      var f = studio.schemaClient.resolve("homepage", ["sections", String(entry.tag)], studio.staging._base().homepage);
      var base = f ? studio.schemaClient.stripEmoji(f.field.label || f.field.name) : "Section";
      return base;
    }
    function paint() {
      var focusId = container.getRootNode().activeElement && container.getRootNode().activeElement.getAttribute ? container.getRootNode().activeElement.getAttribute("data-key") : null;
      S.dom.clear(container);
      container.appendChild(h("p", { class: "hint" }, "Hidden sections stay in the draft but disappear from the live site. Use Up and Down to change the running order of the home page."));
      var order = studio.staging.orderOf(LIST);
      if (!order.length) {
        container.appendChild(h("p", { class: "empty" }, "This site has no home page sections to arrange."));
        return;
      }
      var ul = h("ul", { class: "sections" });
      order.forEach(function (entry, i) {
        var ref = LIST + "." + entry.tag;
        var enabled = studio.staging.get(ref + ".enabled") !== false;
        var name = sectionName(entry);
        var cid = "sec-" + entry.tag;
        var chk = h("input", { id: cid, type: "checkbox", checked: enabled, "data-key": "chk" + entry.tag, on: { change: function () { studio.staging.set(ref + ".enabled", chk.checked); } } });
        var marker = studio.inspect.markerForRef(ref);
        var li = h("li", { class: enabled ? "" : "off" },
          h("span", { class: "pos", "aria-hidden": "true" }, String(i + 1)),
          h("span", { class: "grow" }, h("label", { for: cid }, name + (enabled ? "" : " (hidden)"), h("span", { class: "sr-only" }, " – shown on the live site"))),
          chk,
          h("span", { class: "btns" },
            h("button", { type: "button", class: "btn btn-small", "data-key": "up" + entry.tag, "aria-label": "Move " + name + " up", disabled: i === 0, on: { click: function () { studio.staging.move(LIST, i, i - 1); } } }, "Up"),
            h("button", { type: "button", class: "btn btn-small", "data-key": "dn" + entry.tag, "aria-label": "Move " + name + " down", disabled: i === order.length - 1, on: { click: function () { studio.staging.move(LIST, i, i + 1); } } }, "Down"),
            h("button", { type: "button", class: "btn btn-small", disabled: !marker, "aria-label": "Go to " + name + " on this page", on: { click: function () { studio.ui.editRef(ref); } } }, "Go to")));
        ul.appendChild(li);
      });
      container.appendChild(ul);
      if (focusId) {
        var again = container.querySelector("[data-key='" + focusId.replace(/[^A-Za-z0-9]/g, "") + "']");
        if (again && !again.disabled) again.focus();
      }
    }
    offs.push(studio.on("staged:change", paint));
    paint();
    return function () { offs.forEach(function (o) { o(); }); };
  }
  S.panelSections = { render: render };
})(window.__CoveredStudioBoot);
