/* COVERED Studio overlay - ui/panel-fields.js
   The "All fields" drawer (studio/PHASE1-DESIGN.md 9.2): a searchable list of EVERY schema field of the files behind the current
   page - first the ones that have a marker on this page, then "Not visible on the page" (search and sharing text, link addresses,
   picture descriptions, labels for screen readers). Each row shows its name and the current value (shortened); opening a row
   gives a real form control, checked against the schema as you type and staged when you leave the field. A switch widens the
   list from "On this page" to "Everything". */
(function (S) {
  "use strict";
  var U = S.util;
  var h = S.dom.h;
  var MAX_ROWS = 60;

  function render(container, studio) {
    var sc = studio.schemaClient;
    var offs = [];
    var pageFiles = [];
    S.inspect.markers().forEach(function (m) { if (pageFiles.indexOf(m.file) < 0) pageFiles.push(m.file); });
    if (pageFiles.indexOf("site") < 0 && studio.staging.files().indexOf("site") >= 0) pageFiles.push("site");
    if (!pageFiles.length) pageFiles = studio.staging.files().slice(0, 12);
    var want = S.panelFields.pending || null;
    S.panelFields.pending = null;
    var scope = "page";
    if (want) { var wf = U.parseRef(want); if (wf && pageFiles.indexOf(wf.file) < 0 && studio.staging.files().indexOf(wf.file) >= 0) scope = "all"; }
    var query = "";
    var open = {};            // base ref -> true while its form control is shown
    var extra = {};           // group id -> true once "Show all N" was pressed
    if (want) open[want] = true;

    var search = h("input", { id: "ff-q", type: "search", placeholder: "Search by name or text", autocomplete: "off", "aria-label": "Search all fields" });
    var scopeBtns = {};
    function scopeBtn(id, label) {
      var b = h("button", { type: "button", class: "btn btn-small ff-scope", "data-scope": id, "aria-pressed": scope === id ? "true" : "false", on: { click: function () { scope = id; Object.keys(scopeBtns).forEach(function (k) { scopeBtns[k].setAttribute("aria-pressed", k === scope ? "true" : "false"); }); extra = {}; paint(); } } }, label);
      scopeBtns[id] = b;
      return b;
    }
    var listEl = h("div", { class: "fields" });
    if (S.ext && S.ext.legend && S.ext.legend.liveSentence && studio.ui.panels().some(function (p) { return p.id === "legend"; })) {
      container.appendChild(h("p", { class: "hint ff-count", "data-fields-count": "1" }, S.ext.legend.liveSentence() + " ", h("button", { type: "button", class: "btn btn-small", on: { click: function () { studio.ui.openPanel("legend"); } } }, "What can I edit here?"), " ", h("button", { type: "button", class: "btn btn-small", on: { click: function () { studio.ui.openPanel("checks"); } } }, "Check my changes")));
    }
    container.appendChild(h("div", { class: "ff-scopes", role: "group", "aria-label": "Which fields" }, scopeBtn("page", "On this page"), scopeBtn("all", "Everything")));
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
      var extraEl = null;
      if (w === "boolean") {
        control = h("input", { id: id, type: "checkbox", checked: val === true, "aria-label": row.label });
        control.addEventListener("change", function () { studio.staging.set(ref, control.checked); });
      } else if (w === "select" && !f.multiple) {
        control = h("select", { id: id, "aria-label": row.label }, (f.options || []).map(function (o) { return h("option", { value: typeof o === "object" ? o.value : o }, typeof o === "object" ? o.label : o); }));
        control.value = val == null ? "" : String(val);
        control.addEventListener("change", function () { studio.staging.set(ref, control.value); });
      } else if (w === "number") {
        control = h("input", { id: id, type: "number", value: val == null ? "" : val, step: f.valueType === "int" ? "1" : "any", "aria-label": row.label });
        control.addEventListener("input", function () { showErr(control.value === "" ? "" : Number(control.value)); });
        control.addEventListener("change", function () { if (control.value !== "") studio.staging.set(ref, Number(control.value)); });
      } else if (w === "image") {
        control = h("input", { id: id, type: "text", value: val == null ? "" : val, readonly: true, "aria-label": row.label });
        extraEl = h("button", { type: "button", class: "btn btn-small", on: { click: function () {
          S.editors.open({ el: document.createElement("div"), ref: ref, kind: "image", file: row.file, segs: U.parseRef(ref).segs, field: f, label: row.label, alt: siblingRef(ref, "alt"), decorative: siblingRef(ref, "decorative") }, studio);
        } } }, "Replace picture…");
      } else if (w === "text" || w === "markdown") {
        control = h("textarea", { id: id, rows: 3, value: val == null ? "" : val, spellcheck: "true", "aria-label": row.label });
        control.addEventListener("input", function () { showErr(control.value.replace(/\r\n/g, "\n")); });
        control.addEventListener("change", function () { studio.staging.set(ref, control.value.replace(/\r\n/g, "\n")); showErr(control.value); });
      } else if (w === "hidden") {
        return null;
      } else {
        control = h("input", { id: id, type: "text", value: val == null ? "" : val, autocomplete: "off", spellcheck: w === "color" ? "false" : "true", "aria-label": row.label });
        control.addEventListener("input", function () { showErr(control.value); });
        control.addEventListener("change", function () { studio.staging.set(ref, control.value.replace(/[\n\r]+/g, " ")); showErr(control.value); });
      }
      var wrap = h("div", { class: "frow-body" }, control, extraEl, f.hint ? h("details", { class: "hint-d" }, h("summary", null, "About this field"), h("p", { class: "hint" }, f.hint)) : null, err);
      if (typeof val === "string" || typeof val === "number") showErr(val);
      return { el: wrap, control: control };
    }

    // a ref made from positions in the working copy -> the same ref in base coordinates
    function toBaseRef(ref) { return S.panelFields.baseRef(studio, ref); }
    function shortValue(field, v) {
      if (v === undefined || v === null || v === "") return "(empty)";
      if (typeof v === "boolean") return v ? "On" : "Off";
      if (field.widget === "image") return U.truncate(String(v).replace(/^.*\//, ""), 40);
      return U.truncate(String(v).replace(/\s+/g, " "), 70);
    }
    // refs that have a marker on this page (a marker may also stand for its alt text, link address and hide switch)
    function markedRefs() {
      var set = {};
      S.inspect.markers().forEach(function (m) { [m.ref, m.alt, m.decorative, m.href, m.hide].forEach(function (r) { if (r) set[r] = true; }); });
      return set;
    }
    function allRows() {
      var marked = markedRefs();
      var files = scope === "all" ? studio.staging.files() : pageFiles;
      var rows = [];
      files.forEach(function (file) {
        var doc = studio.staging._working()[file];
        sc.leaves(file, doc, 4000).forEach(function (r) {
          if (r.field.widget === "hidden") return;
          var ref = toBaseRef(U.formatRef(file, r.segs));
          if (!ref) return;
          var label = sc.labelFor(file, r.segs, doc);
          var value = studio.staging.get(ref);
          rows.push({ ref: ref, file: file, label: label, field: r.field, value: value, marked: !!marked[ref], text: (label + " " + (typeof r.value === "string" ? r.value : "")).toLowerCase() });
        });
      });
      return rows;
    }

    function rowEl(r) {
      var isOpen = !!open[r.ref];
      var sum = h("button", { type: "button", class: "frow-sum", "aria-expanded": isOpen ? "true" : "false", "data-field-ref": r.ref, on: { click: function () { open[r.ref] = !open[r.ref]; paintKeep(r.ref); } } },
        h("span", { class: "frow-label" }, r.label), h("span", { class: "frow-val" }, shortValue(r.field, r.value)));
      var wrap = h("div", { class: "frow" + (isOpen ? " frow-open" : "") }, sum);
      if (isOpen) { var c = rowControl(r, r.ref); if (c) { wrap.appendChild(c.el); wrap._control = c.control; } }
      return wrap;
    }
    function group(id, title, rows, q) {
      if (!rows.length) return null;
      var cap = q || extra[id] ? rows.length : MAX_ROWS;
      var shown = rows.filter(function (r, i) { return i < cap || open[r.ref]; }); // a row somebody opened (or was sent to) is never hidden by the cap
      var sec = h("section", { class: "ff-group", "aria-labelledby": "ffg-" + id },
        h("h3", { id: "ffg-" + id, class: "ff-group-title" }, title + " (" + rows.length + ")"),
        shown.map(rowEl));
      if (rows.length > cap) sec.appendChild(h("button", { type: "button", class: "btn", on: { click: function () { extra[id] = true; paint(); } } }, "Show all " + rows.length + " fields"));
      return sec;
    }

    function paint() {
      S.dom.clear(listEl);
      var q = query.trim().toLowerCase();
      var rows = allRows();
      if (q) rows = rows.filter(function (r) { return r.text.indexOf(q) >= 0; });
      var on = rows.filter(function (r) { return r.marked; });
      var off = rows.filter(function (r) { return !r.marked; });
      if (!rows.length) listEl.appendChild(h("p", { class: "empty" }, q ? "No field matches “" + query + "”." : "Nothing to edit here."));
      [group("page", "On this page", on, q), group("hidden", "Not visible on the page", off, q)].forEach(function (g) { if (g) listEl.appendChild(g); });
      S.dom.announce(rows.length + " field" + (rows.length === 1 ? "" : "s") + " shown");
      Promise.resolve().then(focusPending); // after the shell has put the focus on the panel title
    }
    // opening or closing one row keeps the person's place
    function paintKeep(ref) {
      paint();
      var b = listEl.querySelector('[data-field-ref="' + ref.replace(/"/g, "") + '"]');
      if (b) { var ctl = b.parentNode._control; if (open[ref] && ctl) ctl.focus(); else b.focus(); }
    }
    var pendingFocus = want;
    function focusPending() {
      if (!pendingFocus) return;
      var b = listEl.querySelector('[data-field-ref="' + pendingFocus.replace(/"/g, "") + '"]');
      pendingFocus = null;
      if (b && b.parentNode._control) { b.parentNode._control.focus(); b.parentNode._control.scrollIntoView({ block: "center" }); }
    }

    search.addEventListener("input", U.debounce(function () { query = search.value; paint(); }, 150));
    offs.push(studio.on("staged:change", function () {
      var a = container.getRootNode().activeElement;
      if (a && container.contains(a) && a !== search && a.tagName !== "SELECT" && a.className !== "frow-sum") return; // do not rebuild under someone's cursor
      paint();
    }));
    paint();
    return function () { offs.forEach(function (o) { o(); }); };
  }
  // a ref made from positions in the working copy -> the same ref in base coordinates (also used by "Check my changes")
  function baseRef(studio, ref) {
    var p = U.parseRef(ref);
    if (!p) return null;
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
  S.panelFields = { render: render, baseRef: baseRef };
})(window.__CoveredStudioBoot);
