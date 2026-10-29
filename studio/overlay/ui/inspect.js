/* COVERED Studio overlay - ui/inspect.js
   Finds the [data-cms] markers of the page, outlines and labels them, selects them (click / tap / keyboard),
   shows the selection toolbar (edit, move up/down, hide/show, delete, parent, undo), and keeps the page in step
   with the staged values - always with textContent / attributes / custom properties, never with HTML.
   The site's own elements only ever get: staged text, a picture URL, an href, a custom property value, and the
   attributes data-studio-hidden / -removed / -dirty (styled from a constructable page stylesheet). */
(function (S) {
  "use strict";
  var U = S.util;
  var h = S.dom.h;

  var EDITABLE = { text: 1, longtext: 1, markdown: 1, image: 1, link: 1, color: 1 };
  var studio = null;
  var shell = null;
  var markers = [];
  var origs = new WeakMap();
  var hoverBox = null;
  var selBox = null;
  var annos = [];
  var toolbar = null;
  var selected = null; // marker
  var editingEl = null;
  var lastPointer = "mouse";
  var raf = 0;
  var reduce = false;

  function sc() { return studio.schemaClient; }
  function baseDoc(file) { return studio.staging.base ? (studio.staging._base()[file]) : null; }

  // ---------------------------------------------------------------- markers
  function scan() {
    markers = [];
    var nodes = document.querySelectorAll("[data-cms]");
    for (var i = 0; i < nodes.length; i += 1) {
      var el = nodes[i];
      var ref = el.getAttribute("data-cms");
      var p = U.parseRef(ref);
      if (!p || !studio.staging.files().length || studio.staging.files().indexOf(p.file) < 0) continue;
      var kind = el.getAttribute("data-cms-kind") || "text";
      var m = {
        el: el, ref: ref, kind: kind, file: p.file, segs: p.segs,
        alt: okRef(el.getAttribute("data-cms-alt")), decorative: okRef(el.getAttribute("data-cms-decorative")), href: okRef(el.getAttribute("data-cms-href")),
        hide: okRef(el.getAttribute("data-cms-hide")), cssvar: /^--[a-z0-9-]+$/.test(el.getAttribute("data-cms-cssvar") || "") ? el.getAttribute("data-cms-cssvar") : null,
      };
      var r = sc().resolve(p.file, p.segs, baseDoc(p.file));
      m.field = r ? r.field : null;
      m.label = sc().labelFor(p.file, p.segs, baseDoc(p.file));
      markers.push(m);
    }
    return markers;
  }
  function okRef(v) { return v && U.parseRef(v) ? v : null; }
  function markerOf(el) {
    var n = el;
    while (n && n !== document.documentElement) {
      if (n.nodeType === 1 && n.hasAttribute && n.hasAttribute("data-cms")) {
        for (var i = 0; i < markers.length; i += 1) if (markers[i].el === n) return markers[i];
      }
      n = n.parentNode;
    }
    return null;
  }
  function markerForRef(ref) {
    for (var i = 0; i < markers.length; i += 1) if (markers[i].ref === ref) return markers[i];
    return null;
  }
  function parentMarker(m) {
    var n = m.el.parentNode;
    while (n && n !== document.documentElement) {
      var pm = n.nodeType === 1 ? markerOf(n) : null;
      if (pm && (pm.kind === "section" || pm.kind === "item")) return pm;
      n = n.parentNode;
    }
    return null;
  }
  function isInHost(t) { return t && t.closest && t.closest("#covered-studio"); }

  // ---------------------------------------------------------------- live DOM sync
  function orig(m) {
    var o = origs.get(m.el);
    if (!o) { o = {}; origs.set(m.el, o); }
    return o;
  }
  function textBits(value) {
    var parts = String(value).split(/<br\s*\/?>/i);
    var out = [];
    parts.forEach(function (t, i) {
      if (i) out.push(document.createElement("br"));
      out.push(document.createTextNode(t));
    });
    return out;
  }
  function syncText(m, dirty) {
    var o = orig(m);
    if (m.el === editingEl) return;
    if (o.mode === undefined) {
      o.mode = m.el.children.length === 0 ? "simple" : "first";
      if (o.mode === "simple") o.nodes = Array.prototype.slice.call(m.el.childNodes);
      else {
        for (var i = 0; i < m.el.childNodes.length; i += 1) {
          var n = m.el.childNodes[i];
          if (n.nodeType === 3 && n.data.trim()) { o.node = n; o.data = n.data; break; }
        }
      }
    }
    var value = studio.staging.get(m.ref);
    if (typeof value !== "string") return;
    if (o.mode === "simple") {
      if (dirty) m.el.replaceChildren.apply(m.el, textBits(value));
      else if (o.nodes) m.el.replaceChildren.apply(m.el, o.nodes);
    } else if (o.node) {
      o.node.data = dirty ? value : o.data;
    }
  }
  function imageOf(el) { return el.tagName === "IMG" ? el : el.querySelector("img"); }
  function syncImage(m, dirty) {
    var img = imageOf(m.el);
    if (!img) return;
    var o = orig(m);
    if (o.src === undefined) {
      o.src = img.getAttribute("src");
      o.srcset = img.getAttribute("srcset");
      o.sizes = img.getAttribute("sizes");
      var pic = img.closest("picture");
      o.sources = pic ? Array.prototype.map.call(pic.querySelectorAll("source"), function (s) { return { el: s, srcset: s.getAttribute("srcset") }; }) : [];
    }
    if (dirty) {
      var value = studio.staging.get(m.ref);
      var up = studio.staging.uploadFor(value);
      var url = up && up.url ? up.url : typeof value === "string" ? (value.charAt(0) === "/" ? value : "/images/" + value) : null;
      var safe = url ? U.safeHref(url, true) : null;
      if (!safe) return;
      img.removeAttribute("srcset");
      img.removeAttribute("sizes");
      o.sources.forEach(function (s) { s.el.removeAttribute("srcset"); });
      img.setAttribute("src", safe);
    } else {
      if (o.src !== null) img.setAttribute("src", o.src);
      if (o.srcset !== null) img.setAttribute("srcset", o.srcset);
      if (o.sizes !== null) img.setAttribute("sizes", o.sizes);
      o.sources.forEach(function (s) { if (s.srcset !== null) s.el.setAttribute("srcset", s.srcset); });
    }
  }
  function syncLink(m, ref, dirty) {
    var a = m.el.tagName === "A" ? m.el : m.el.closest("a") || m.el.querySelector("a");
    if (!a) return;
    var o = orig(m);
    if (o.href === undefined) o.href = a.getAttribute("href");
    if (dirty) { var safe = U.safeHref(studio.staging.get(ref)); if (safe) a.setAttribute("href", safe); }
    else if (o.href !== null) a.setAttribute("href", o.href);
  }
  function setFlag(el, name, on) { if (on) el.setAttribute(name, ""); else el.removeAttribute(name); }

  function sync() {
    annos = [];
    markers.forEach(function (m) {
      var st = studio.staging;
      var dirty = st.isDirty(m.ref);
      if (m.kind === "text" || m.kind === "longtext") syncText(m, dirty);
      else if (m.kind === "image") syncImage(m, dirty);
      else if (m.kind === "link") syncLink(m, m.ref, dirty);
      else if (m.kind === "markdown") { setFlag(m.el, "data-studio-dirty", dirty); if (dirty) annos.push({ el: m.el, text: "Updated – shows after saving" }); }
      else if (m.kind === "color" && m.cssvar) {
        if (dirty) document.documentElement.style.setProperty(m.cssvar, String(st.get(m.ref)));
        else document.documentElement.style.removeProperty(m.cssvar);
      }
      if (m.href && m.kind !== "link") syncLink(m, m.href, st.isDirty(m.href));
      if (m.alt) { var img = imageOf(m.el); if (img && st.isDirty(m.alt)) img.setAttribute("alt", String(st.get(m.alt) || "")); }
      // visibility switches
      var hidden = false;
      if (m.kind === "toggle") hidden = st.get(m.ref) === false;
      else if (m.kind === "section") hidden = st.get(m.ref + ".enabled") === false;
      else if (m.hide) hidden = st.get(m.hide) === false;
      setFlag(m.el, "data-studio-hidden", hidden);
      if (hidden) annos.push({ el: m.el, text: "Hidden on the live site" });
      if (m.kind === "item" || m.kind === "section") {
        var gone = st.removedItem(m.ref);
        setFlag(m.el, "data-studio-removed", gone);
        if (gone) annos.push({ el: m.el, text: "Will be removed" });
      }
    });
    position();
  }

  // ---------------------------------------------------------------- boxes
  function box(cls) { return h("div", { class: "hl " + cls, hidden: true }, h("span", { class: "hl-chip" })); }
  function placeBox(b, m, text) {
    if (!m || !m.el.isConnected) { b.hidden = true; return; }
    var r = m.el.getBoundingClientRect();
    if (!r.width && !r.height) { b.hidden = true; return; }
    b.hidden = false;
    b.style.left = Math.max(0, r.left) + "px";
    b.style.top = Math.max(0, r.top) + "px";
    b.style.width = Math.min(r.width, window.innerWidth) + "px";
    b.style.height = r.height + "px";
    b.firstChild.textContent = text;
    b.setAttribute("data-flip", r.top < 28 ? "in" : "out");
  }
  var hovered = null;
  function position() {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(function () {
      if (S.state.mode !== "edit") { hoverBox.hidden = true; selBox.hidden = true; clearAnnos(); toolbar.hidden = true; return; }
      placeBox(hoverBox, hovered && hovered !== selected ? hovered : null, hovered ? kindName(hovered) + " · " + hovered.label : "");
      placeBox(selBox, selected, selected ? kindName(selected) + " · " + selected.label : "");
      drawAnnos();
      placeToolbar();
    });
  }
  var annoEls = [];
  function clearAnnos() { annoEls.forEach(function (e) { if (e.parentNode) e.parentNode.removeChild(e); }); annoEls = []; }
  function drawAnnos() {
    clearAnnos();
    annos.slice(0, 60).forEach(function (a) {
      if (!a.el.isConnected) return;
      var r = a.el.getBoundingClientRect();
      if (r.bottom < 0 || r.top > window.innerHeight || (!r.width && !r.height)) return;
      var chip = h("div", { class: "anno" }, a.text);
      chip.style.left = Math.max(4, r.left + 4) + "px";
      chip.style.top = Math.max(4, Math.min(window.innerHeight - 30, r.top + 4)) + "px";
      shell.layer.appendChild(chip);
      annoEls.push(chip);
    });
  }
  function kindName(m) {
    return { text: "Text", longtext: "Text", markdown: "Formatted text", image: "Picture", link: "Link", color: "Colour", toggle: "Switch", section: "Section", item: "Item" }[m.kind] || "Part";
  }

  // ---------------------------------------------------------------- selection + toolbar
  function listInfo(m) {
    // -> { listRef, tag } for a section or list item, else null
    if (m.kind === "section") return { listRef: "homepage.sections", tag: m.segs[m.segs.length - 1] };
    if (m.kind === "item") {
      var segs = m.segs.slice(0, -1);
      return { listRef: U.formatRef(m.file, segs), tag: m.segs[m.segs.length - 1] };
    }
    return null;
  }
  function position0(info) {
    var order = studio.staging.orderOf(info.listRef);
    for (var i = 0; i < order.length; i += 1) if (String(order[i].tag) === String(info.tag)) return { i: i, n: order.length };
    return null;
  }
  function moveSel(delta) {
    if (!selected) return;
    var info = listInfo(selected);
    var pos = info && position0(info);
    if (!pos) return;
    var to = pos.i + delta;
    var res = studio.staging.move(info.listRef, pos.i, to);
    if (!res.ok) { shell.toast(res.message, { kind: "info" }); return; }
    S.dom.announce((selected.label || "Item") + " moved " + (delta < 0 ? "up" : "down") + " to position " + (to + 1) + " of " + pos.n);
    buildToolbar();
    position();
  }
  function toggleVisible() {
    if (!selected) return;
    var m = selected;
    var ref = m.kind === "section" ? m.ref + ".enabled" : m.kind === "toggle" ? m.ref : m.hide;
    if (!ref) return;
    var res = studio.staging.toggle(ref);
    if (!res.ok) shell.toast(res.message, { kind: "error" });
    else S.dom.announce(studio.staging.get(ref) === false ? "Hidden on the live site" : "Shown on the live site");
    buildToolbar();
  }
  function removeSel() {
    if (!selected) return;
    var m = selected;
    studio.ui.confirm({ title: "Remove this item?", body: "It will be removed from the draft when you save. You can undo until then.", confirmLabel: "Remove", danger: true }).then(function (ok) {
      if (!ok) return;
      var res = studio.staging.remove(m.ref);
      if (!res.ok) shell.toast(res.message, { kind: "error" });
      else { S.dom.announce("Item removed"); select(null); }
    });
  }
  function canRemove(m) {
    if (m.kind !== "item") return false;
    var info = listInfo(m);
    var r = sc().resolve(m.file, m.segs.slice(0, -1), baseDoc(m.file));
    var rule = r && r.field && r.field.x && r.field.x.list;
    return !rule || rule.remove !== false;
  }

  function buildToolbar() {
    S.dom.clear(toolbar);
    if (!selected) { toolbar.hidden = true; return; }
    var m = selected;
    var st = studio.staging;
    var btn = function (label, cls, fn, disabled, extra) {
      return h("button", { type: "button", class: "btn btn-small " + (cls || ""), disabled: !!disabled, "aria-label": extra || label, on: { click: fn } }, label);
    };
    toolbar.appendChild(h("span", { class: "seltool-name" }, kindName(m) + ": " + U.truncate(m.label, 40)));
    if (EDITABLE[m.kind]) toolbar.appendChild(btn("Edit", "btn-primary", function () { openEditor(m); }, false, "Edit " + m.label));
    if (m.href) toolbar.appendChild(btn("Link", "", function () { S.editors.open(Object.assign({}, m, { kind: "link", ref: m.href, field: sc().resolve(m.file, U.parseRef(m.href).segs, baseDoc(m.file)).field, label: m.label + " (link)", _via: m }), studio); }, false, "Edit the link of " + m.label));
    var info = listInfo(m);
    if (info) {
      var pos = position0(info);
      toolbar.appendChild(btn("Up", "", function () { moveSel(-1); }, !pos || pos.i === 0, "Move up"));
      toolbar.appendChild(btn("Down", "", function () { moveSel(1); }, !pos || pos.i >= pos.n - 1, "Move down"));
    }
    if (m.kind === "section" || m.kind === "toggle" || m.hide) {
      var ref = m.kind === "section" ? m.ref + ".enabled" : m.kind === "toggle" ? m.ref : m.hide;
      var off = st.get(ref) === false;
      toolbar.appendChild(btn(off ? "Show" : "Hide", "", toggleVisible, false, off ? "Show on the live site" : "Hide from the live site"));
    }
    if (canRemove(m)) toolbar.appendChild(btn("Delete", "btn-danger", removeSel));
    var pm = parentMarker(m);
    if (pm) toolbar.appendChild(btn("Parent", "", function () { select(pm); }, false, "Select the " + kindName(pm).toLowerCase() + " around this"));
    toolbar.appendChild(btn("Undo", "", function () { st.undo(); }, !st.canUndo()));
    toolbar.hidden = false;
  }
  function placeToolbar() {
    if (!selected || !selected.el.isConnected) { toolbar.hidden = true; return; }
    var r = selected.el.getBoundingClientRect();
    toolbar.hidden = false;
    var w = toolbar.offsetWidth || 260;
    var hgt = toolbar.offsetHeight || 44;
    var top = r.top - hgt - 8;
    if (top < 6) top = Math.min(window.innerHeight - hgt - 70, r.bottom + 8);
    if (top < 6) top = 6;
    var left = Math.min(Math.max(6, r.left), Math.max(6, window.innerWidth - w - 6));
    toolbar.style.top = top + "px";
    toolbar.style.left = left + "px";
  }

  function select(m, opts) {
    opts = opts || {};
    if (editingEl && (!m || m.el !== editingEl)) S.editors.finishInline && S.editors.finishInline(true);
    selected = m || null;
    S.state.selected = m ? m.ref : null;
    buildToolbar();
    position();
    studio.emit("selection", { ref: m ? m.ref : null });
    if (m) S.dom.announce(kindName(m) + " selected: " + m.label + ". Press Enter to edit.");
    if (m && opts.scroll) m.el.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
  }
  function openEditor(m) {
    if (!m || !EDITABLE[m.kind]) { if (m && m.kind === "toggle") toggleVisible(); return; }
    S.editors.open(m, studio);
  }

  // ---------------------------------------------------------------- events
  function onPointerDown(e) { lastPointer = e.pointerType || "mouse"; }
  function onOver(e) {
    if (S.state.mode !== "edit" || isInHost(e.target)) return;
    var m = markerOf(e.target);
    if (m !== hovered) { hovered = m; position(); }
  }
  function onClick(e) {
    if (S.state.mode !== "edit") return;
    if (isInHost(e.target) || (e.composedPath && e.composedPath().some(function (n) { return n === shell.host; }))) return;
    if (editingEl && editingEl.contains(e.target)) return;
    var m = markerOf(e.target);
    var a = e.target.closest && e.target.closest("a");
    if (!m) { if (a || e.target.closest("form")) e.preventDefault(); return; }
    e.preventDefault();
    e.stopPropagation();
    var touch = lastPointer === "touch" || lastPointer === "pen";
    var again = selected && selected.el === m.el;
    select(m);
    if (!touch || again) openEditor(m);
  }
  function typingTarget(t) {
    if (!t) return false;
    if (t.isContentEditable) return true;
    var tag = t.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
  }
  function visibleMarkers() {
    return markers.filter(function (m) { var r = m.el.getBoundingClientRect(); return (r.width || r.height) && m.el.isConnected; });
  }
  function cycle(dir) {
    var list = visibleMarkers();
    if (!list.length) return;
    var i = selected ? list.findIndex(function (m) { return m.el === selected.el; }) : -1;
    i = i < 0 ? (dir > 0 ? 0 : list.length - 1) : (i + dir + list.length) % list.length;
    select(list[i], { scroll: true });
  }
  function onKey(e) {
    var inHost = e.composedPath && e.composedPath().indexOf(shell.host) >= 0;
    var typing = typingTarget(e.composedPath ? e.composedPath()[0] : e.target);
    var mod = e.ctrlKey || e.metaKey;
    if (e.key === "s" && mod) { if (S.state.mode === "edit") { e.preventDefault(); studio.ui.runCommand && studio.ui.runCommand("save"); } return; }
    if (e.key === "Escape") {
      if (shell.hasDialog()) return;
      if (editingEl) return; // the inline editor handles it
      if (shell.currentPanel()) { shell.closePanel(); e.preventDefault(); return; }
      if (selected) { select(null); e.preventDefault(); return; }
      if (S.state.mode === "edit") { studio.setMode("browse"); e.preventDefault(); }
      return;
    }
    if (typing || (inHost && !mod && e.key !== "?")) { if (!(mod && e.key.toLowerCase() === "z" && !typing)) return; }
    if (mod && e.key.toLowerCase() === "z" && !typing && S.state.mode === "edit") {
      e.preventDefault();
      if (e.shiftKey) studio.staging.redo(); else studio.staging.undo();
      return;
    }
    if (mod || e.altKey && !/^Arrow/.test(e.key)) return;
    if (e.key === "e" || e.key === "E") { if (!shell.hasDialog()) { e.preventDefault(); studio.toggleEdit(); } return; }
    if (S.state.mode !== "edit" || shell.hasDialog()) return;
    if (e.key === "]") { e.preventDefault(); cycle(1); }
    else if (e.key === "[") { e.preventDefault(); cycle(-1); }
    else if (e.key === "Enter" && selected) { e.preventDefault(); openEditor(selected); }
    else if (e.altKey && e.key === "ArrowUp") { e.preventDefault(); moveSel(-1); }
    else if (e.altKey && e.key === "ArrowDown") { e.preventDefault(); moveSel(1); }
    else if (e.key === "?") { e.preventDefault(); studio.ui.openPanel("help"); }
  }

  function init(st, sh) {
    studio = st;
    shell = sh;
    try { reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) { reduce = false; }
    hoverBox = box("hl-hover");
    selBox = box("hl-sel");
    toolbar = h("div", { class: "seltool", role: "toolbar", "aria-label": "Selected part of the page", hidden: true });
    shell.layer.appendChild(hoverBox);
    shell.layer.appendChild(selBox);
    shell.wrap.appendChild(toolbar);
    scan();
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("mouseover", onOver, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", position, true);
    window.addEventListener("resize", position);
    studio.on("staged:change", function () { sync(); if (selected) buildToolbar(); });
    studio.on("mode:change", function (d) {
      if (d.mode !== "edit") { hovered = null; select(null); sync(); }
      position();
    });
    sync();
  }

  S.inspect = {
    init: init, scan: scan, sync: sync, select: select, markers: function () { return markers; }, markerOf: markerOf, markerForRef: markerForRef,
    selected: function () { return selected; }, position: position, kindName: kindName, openEditor: openEditor,
    setEditing: function (el) { editingEl = el; if (el) el.setAttribute("data-studio-editing-now", ""); },
    clearEditing: function (el) { if (el) el.removeAttribute("data-studio-editing-now"); editingEl = null; },
    editingEl: function () { return editingEl; },
  };
})(window.__CoveredStudioBoot);
