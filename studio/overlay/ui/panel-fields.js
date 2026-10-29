/* COVERED Studio overlay - ui/panel-fields.js
   The Fields panel: a searchable form of EVERY schema field of the files behind the current page - including
   the ones that are not visible on it (labels for screen readers, search-engine text). Values are changed with
   real form controls, checked against the schema as you type, and staged when you leave the field. */
(function (S) {
  "use strict";
  var U = S.util;
  var h = S.dom.h;
  var MAX_ROWS = 60;

  function render(container, studio) {
    var sc = studio.schemaClient;
    var offs = [];
    var files = [];
    S.inspect.markers().forEach(function (m) { if (files.indexOf(m.file) < 0) files.push(m.file); });
    if (files.indexOf("site") < 0 && studio.staging.files().indexOf("site") >= 0) files.push("site");
    if (!files.length) files = studio.staging.files().slice(0, 12);
    var want = S.panelFields.pending || null;
    S.panelFields.pending = null;
    if (want) { var wf = U.parseRef(want); if (wf && files.indexOf(wf.file) < 0 && studio.staging.files().indexOf(wf.file) >= 0) files.unshift(wf.file); }
    var cur = want && U.parseRef(want) ? U.parseRef(want).file : files[0];
    var query = "";
    var showAll = !!want;

    var fileSel = h("select", { id: "ff-file", "aria-label": "Which content" }, files.map(function (f) { return h("option", { value: f }, sc.stripEmoji((sc.fileSchema(f) || {}).label || f)); }));
    var search = h("input", { id: "ff-q", type: "search", placeholder: "Search by name or text", autocomplete: "off", "aria-label": "Search fields" });
    var listEl = h("div", { class: "fields" });
    container.appendChild(h("div", { class: "field" }, h("label", { for: "ff-file" }, "Content"), fileSel));
    container.appendChild(h("div", { class: "field" }, h("label", { for: "ff-q" }, "Find a field"), search));
    container.appendChild(listEl);

    function siblingRef(ref, name) {
      var p = U.parseRef(ref);
      var segs = p.segs.slice(0, -1).concat(name);
      var r = sc.resolve(p.file, segs, studio.staging._base()[p.file]);
      return r ? U.formatRef(p.file, segs) : null;
    }
    function rowControl(row, ref) {
      var f = row.field;
      var w = f.widget || "string";
      var val = studio.staging.get(ref);
      var id = "fld-" + ref.replace(/[^A-Za-z0-9]/g, "-");
      var err = h("ul", { class: "errors", role: "alert" });
      function showErr(v) {
        S.dom.clear(err);
        S.validateClient.validate(f, v, { limits: sc.limits, reservedIds: sc.raw.reservedIds || [] }).forEach(function (p) { err.appendChild(h("li", null, p.message)); });
      }
      var control;
      var extra = null;
      if (w === "boolean") {
        control = h("input", { id: id, type: "checkbox", checked: val === true });
        control.addEventListener("change", function () { studio.staging.set(ref, control.checked); });
      } else if (w === "select" && !f.multiple) {
        control = h("select", { id: id }, (f.options || []).map(function (o) { return h("option", { value: typeof o === "object" ? o.value : o }, typeof o === "object" ? o.label : o); }));
        control.value = val == null ? "" : String(val);
        control.addEventListener("change", function () { studio.staging.set(ref, control.value); });
      } else if (w === "number") {
        control = h("input", { id: id, type: "number", value: val == null ? "" : val, step: f.valueType === "int" ? "1" : "any" });
        control.addEventListener("input", function () { showErr(control.value === "" ? "" : Number(control.value)); });
        control.addEventListener("change", function () { if (control.value !== "") studio.staging.set(ref, Number(control.value)); });
      } else if (w === "image") {
        control = h("input", { id: id, type: "text", value: val == null ? "" : val, readonly: true });
        extra = h("button", { type: "button", class: "btn btn-small", on: { click: function () {
          S.editors.open({ el: document.createElement("div"), ref: ref, kind: "image", file: row.file, segs: U.parseRef(ref).segs, field: f, label: row.label, alt: siblingRef(ref, "alt"), decorative: siblingRef(ref, "decorative") }, studio);
        } } }, "Replace picture…");
      } else if (w === "text" || w === "markdown") {
        control = h("textarea", { id: id, rows: 3, value: val == null ? "" : val, spellcheck: "true" });
        control.addEventListener("input", function () { showErr(control.value.replace(/\r\n/g, "\n")); });
        control.addEventListener("change", function () { studio.staging.set(ref, control.value.replace(/\r\n/g, "\n")); showErr(control.value); });
      } else if (w === "hidden") {
        return null;
      } else {
        control = h("input", { id: id, type: "text", value: val == null ? "" : val, autocomplete: "off", spellcheck: w === "color" ? "false" : "true" });
        control.addEventListener("input", function () { showErr(control.value); });
        control.addEventListener("change", function () { studio.staging.set(ref, control.value.replace(/[\n\r]+/g, " ")); showErr(control.value); });
      }
      var wrap = h("div", { class: "frow" }, h("label", { for: id }, row.label), control, extra, f.hint ? h("details", { class: "hint-d" }, h("summary", null, "About this field"), h("p", { class: "hint" }, f.hint)) : null, err);
      if (typeof val === "string" || typeof val === "number") showErr(val);
      return wrap;
    }

    function paint() {
      S.dom.clear(listEl);
      var doc = studio.staging._working()[cur];
      var rows = sc.leaves(cur, doc, 4000).map(function (r) {
        var segs = r.segs;
        var ref = U.formatRef(cur, segs);
        var label = sc.labelFor(cur, segs, doc);
        return { ref: ref, label: label, field: r.field, file: cur, text: (label + " " + (typeof r.value === "string" ? r.value : "")).toLowerCase() };
      });
      // refs here are built from the WORKING order; the staging store wants base coordinates -> translate through tags
      var q = query.trim().toLowerCase();
      if (q) rows = rows.filter(function (r) { return r.text.indexOf(q) >= 0; });
      var total = rows.length;
      if (!q && !showAll) rows = rows.slice(0, MAX_ROWS);
      if (!rows.length) listEl.appendChild(h("p", { class: "empty" }, q ? "No field matches “" + query + "”." : "Nothing to edit here."));
      rows.forEach(function (r) {
        var base = toBaseRef(r.ref);
        if (!base) return;
        var el = rowControl({ field: r.field, label: r.label, file: cur }, base);
        if (el) listEl.appendChild(el);
      });
      if (!q && !showAll && total > MAX_ROWS) listEl.appendChild(h("button", { type: "button", class: "btn", on: { click: function () { showAll = true; paint(); } } }, "Show all " + total + " fields"));
      S.dom.announce(total + " field" + (total === 1 ? "" : "s") + " shown");
    }
    // a ref made from positions in the working copy -> the same ref in base coordinates
    function toBaseRef(ref) {
      var p = U.parseRef(ref);
      var cursor = studio.staging._working()[p.file];
      var out = [];
      for (var i = 0; i < p.segs.length; i += 1) {
        if (cursor === undefined || cursor === null) return null;
        if (Array.isArray(cursor)) {
          var item = cursor[Number(p.segs[i])];
          out.push(item !== null && typeof item === "object" && item[S.TAG] !== undefined ? String(item[S.TAG]) : p.segs[i]);
          cursor = item;
        } else { out.push(p.segs[i]); cursor = cursor[p.segs[i]]; }
      }
      return U.formatRef(p.file, out);
    }

    fileSel.value = cur;
    fileSel.addEventListener("change", function () { cur = fileSel.value; showAll = false; paint(); });
    search.addEventListener("input", U.debounce(function () { query = search.value; paint(); }, 150));
    offs.push(studio.on("staged:change", function () {
      var a = container.getRootNode().activeElement;
      if (a && container.contains(a) && a !== search && a.tagName !== "SELECT") return; // do not rebuild under someone's cursor
      paint();
    }));
    paint();
    if (want) {
      var target = listEl.querySelector("#fld-" + want.replace(/[^A-Za-z0-9]/g, "-"));
      if (target) { target.focus(); target.scrollIntoView({ block: "center" }); }
    }
    return function () { offs.forEach(function (o) { o(); }); };
  }
  S.panelFields = { render: render };
})(window.__CoveredStudioBoot);
