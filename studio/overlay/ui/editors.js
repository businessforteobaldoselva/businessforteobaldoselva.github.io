/* COVERED Studio overlay - ui/editors.js
   The editors: in-place plain text (contenteditable="plaintext-only" with a paste/drop guard), and dialogs / bottom
   sheets with real form controls for longer text, formatted (markdown) text, links, colours and pictures.
   Everything a person types or pastes is plain text: it is read with textContent / .value and written with
   textContent / .value / attributes, never parsed as HTML. The markdown preview is built from DOM nodes. */
(function (S) {
  "use strict";
  var U = S.util;
  var h = S.dom.h;

  var inline = null; // the running inline edit

  function narrow() {
    try { return window.matchMedia("(max-width: 759px), (pointer: coarse)").matches; } catch (e) { return false; }
  }
  function plaintextOnlySupported() {
    try {
      var d = document.createElement("div");
      d.setAttribute("contenteditable", "plaintext-only");
      return d.contentEditable === "plaintext-only";
    } catch (e) { return false; }
  }
  function limitsOf(studio) { return studio.schemaClient.limits; }
  function check(studio, field, value) {
    return S.validateClient.validate(field, value, { limits: limitsOf(studio), reservedIds: studio.schemaClient.raw.reservedIds || [] });
  }
  function maxOf(studio, field) {
    var l = limitsOf(studio);
    var w = field && field.widget;
    var m = w === "markdown" ? l.markdown : l.string;
    return field && typeof field.max === "number" ? Math.min(m, field.max) : m;
  }
  function fieldHint(field) { return field && field.hint ? String(field.hint) : ""; }

  // ---------------------------------------------------------------- open
  function open(m, studio) {
    var value = studio.staging.get(m.ref);
    if (m.kind === "text" || m.kind === "longtext") {
      var rawBreaks = typeof value === "string" && /<br\s*\/?>/i.test(value);
      if (m.el.children.length === 0 && !rawBreaks && !narrow() && plaintextOnlySupported() && typeof value === "string") return startInline(m, studio);
      return textDialog(m, studio, value);
    }
    if (m.kind === "markdown") return markdownDialog(m, studio, value);
    if (m.kind === "link") return linkDialog(m, studio, value);
    if (m.kind === "color") return colorDialog(m, studio, value);
    if (m.kind === "image") return imageDialog(m, studio);
  }

  // ---------------------------------------------------------------- inline text
  function startInline(m, studio) {
    if (inline) finishInline(false);
    var el = m.el;
    var value = studio.staging.get(m.ref);
    var multi = m.kind === "longtext";
    var shell = studio.ui;
    var hint = h("div", { class: "inline-hint", "aria-hidden": "true" });
    shell.hostWrap.appendChild(hint);
    var st = { m: m, el: el, hint: hint, prevWS: el.style.whiteSpace, hadTab: el.getAttribute("tabindex"), hadLabel: el.getAttribute("aria-label"), start: value, done: false, studio: studio };
    inline = st;
    el.textContent = value;
    el.style.whiteSpace = "pre-wrap";
    el.setAttribute("contenteditable", "plaintext-only");
    el.setAttribute("spellcheck", "true");
    el.setAttribute("role", "textbox");
    if (multi) el.setAttribute("aria-multiline", "true");
    el.setAttribute("aria-label", "Editing " + m.label);
    if (st.hadTab === null) el.setAttribute("tabindex", "0");
    S.inspect.setEditing(el);

    function feedback() {
      var v = readValue(el, multi);
      var problems = check(studio, m.field, v);
      var max = maxOf(studio, m.field);
      var msg = v.length + " / " + max + " characters · " + (multi ? "Ctrl+Enter" : "Enter") + " to keep · Esc to cancel";
      if (problems.length) msg = problems[0].message + "  (" + msg + ")";
      hint.textContent = msg;
      hint.setAttribute("data-bad", problems.length ? "1" : "0");
      var r = el.getBoundingClientRect();
      hint.style.left = Math.max(6, Math.min(r.left, window.innerWidth - 300)) + "px";
      hint.style.top = Math.min(window.innerHeight - 40, r.bottom + 6) + "px";
      if (problems.length && st.lastMsg !== problems[0].message) S.dom.announce(problems[0].message);
      st.lastMsg = problems.length ? problems[0].message : null;
    }
    st.onInput = feedback;
    st.onKey = function (e) {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finishInline(true); }
      else if (e.key === "Enter" && (!multi || e.ctrlKey || e.metaKey)) { e.preventDefault(); e.stopPropagation(); finishInline(false); }
      else e.stopPropagation(); // site shortcuts must not fire while typing
    };
    st.onBlur = function () { setTimeout(function () { if (inline === st) finishInline(false); }, 0); };
    st.onPaste = function (e) {
      e.preventDefault();
      var text = e.clipboardData ? e.clipboardData.getData("text/plain") : "";
      insertPlain(text, multi);
      feedback();
    };
    st.onDrop = function (e) {
      e.preventDefault();
      var text = e.dataTransfer ? e.dataTransfer.getData("text/plain") : "";
      insertPlain(text, multi);
      feedback();
    };
    el.addEventListener("input", st.onInput);
    el.addEventListener("keydown", st.onKey);
    el.addEventListener("blur", st.onBlur);
    el.addEventListener("paste", st.onPaste);
    el.addEventListener("drop", st.onDrop);
    el.focus();
    var range = document.createRange();
    range.selectNodeContents(el);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    feedback();
    S.inspect.position();
  }
  function readValue(el, multi) {
    var v = el.textContent.replace(/\r\n/g, "\n");
    return multi ? v : v.replace(/[\n\r]+/g, " ");
  }
  function insertPlain(text, multi) {
    text = String(text).replace(/\r\n/g, "\n");
    if (!multi) text = text.replace(/[\n\r]+/g, " ");
    var sel = window.getSelection();
    if (!sel.rangeCount) return;
    var r = sel.getRangeAt(0);
    r.deleteContents();
    var node = document.createTextNode(text);
    r.insertNode(node);
    r.setStartAfter(node);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
  }
  function finishInline(cancel) {
    var st = inline;
    if (!st || st.done) return;
    st.done = true;
    inline = null;
    var el = st.el;
    var multi = st.m.kind === "longtext";
    var v = readValue(el, multi);
    el.removeEventListener("input", st.onInput);
    el.removeEventListener("keydown", st.onKey);
    el.removeEventListener("blur", st.onBlur);
    el.removeEventListener("paste", st.onPaste);
    el.removeEventListener("drop", st.onDrop);
    el.removeAttribute("contenteditable");
    el.removeAttribute("spellcheck");
    el.removeAttribute("role");
    el.removeAttribute("aria-multiline");
    if (st.hadLabel === null) el.removeAttribute("aria-label"); else el.setAttribute("aria-label", st.hadLabel);
    if (st.hadTab === null) el.removeAttribute("tabindex");
    el.style.whiteSpace = st.prevWS;
    if (!el.getAttribute("style")) el.removeAttribute("style");
    if (st.hint.parentNode) st.hint.parentNode.removeChild(st.hint);
    S.inspect.clearEditing(el);
    var studio = st.studio;
    if (!cancel && v !== st.start) {
      var res = studio.staging.set(st.m.ref, v);
      if (!res.ok) studio.ui.toast(res.message, { kind: "error" });
      else {
        var probs = check(studio, st.m.field, v);
        if (probs.length) studio.ui.toast("Kept as a draft change, but it can't be saved yet: " + probs[0].message, { kind: "error" });
      }
    }
    S.inspect.sync();
    S.inspect.position();
    if (window.getSelection) window.getSelection().removeAllRanges();
  }

  // ---------------------------------------------------------------- shared dialog bits
  function fieldBlock(label, control, hint, errorBox) {
    return h("div", { class: "field" }, h("label", { for: control.id }, label), control, hint ? h("p", { class: "hint" }, hint) : null, errorBox || null);
  }
  var idn = 0;
  function nid() { idn += 1; return "ed" + idn; }
  function counter(el, max) {
    var c = h("p", { class: "counter", "aria-live": "off" });
    var upd = function () { c.textContent = el.value.length + " / " + max + " characters"; c.setAttribute("data-bad", el.value.length > max ? "1" : "0"); };
    el.addEventListener("input", upd);
    upd();
    return c;
  }
  function errorList() { return h("ul", { class: "errors", role: "alert" }); }
  function showErrors(box, probs) {
    S.dom.clear(box);
    probs.forEach(function (p) { box.appendChild(h("li", null, p.message)); });
  }
  function footButtons(foot, api, applyFn, applyLabel) {
    var apply = h("button", { type: "button", class: "btn btn-primary", on: { click: function () { applyFn(); } } }, applyLabel || "Keep change");
    foot.appendChild(h("button", { type: "button", class: "btn", on: { click: function () { api.close(null); } } }, "Cancel"));
    foot.appendChild(apply);
    return apply;
  }
  function stage(studio, ref, value, api) {
    var res = studio.staging.set(ref, value);
    if (!res.ok) { studio.ui.toast(res.message, { kind: "error" }); return false; }
    api.close(true);
    return true;
  }

  // ---------------------------------------------------------------- plain text in a dialog
  function textDialog(m, studio, value) {
    var multi = m.kind === "longtext";
    var max = maxOf(studio, m.field);
    studio.ui.dialog({
      title: m.label,
      build: function (body, foot, api) {
        var id = nid();
        var control = multi || (typeof value === "string" && value.length > 90)
          ? h("textarea", { id: id, rows: multi ? 6 : 3, value: value == null ? "" : value, spellcheck: "true" })
          : h("input", { id: id, type: "text", value: value == null ? "" : value, spellcheck: "true" });
        var errs = errorList();
        var apply;
        var run = function () {
          var v = control.value.replace(/\r\n/g, "\n");
          if (!multi) v = v.replace(/[\n\r]+/g, " ");
          var probs = check(studio, m.field, v);
          showErrors(errs, probs);
          if (apply) apply.disabled = probs.length > 0;
          return probs;
        };
        control.addEventListener("input", run);
        control.addEventListener("keydown", function (e) {
          if (e.key === "Enter" && (!control.matches("textarea") || e.ctrlKey || e.metaKey)) { e.preventDefault(); apply.click(); }
        });
        body.appendChild(fieldBlock(m.label, control, fieldHint(m.field), null));
        body.appendChild(counter(control, max));
        body.appendChild(errs);
        apply = footButtons(foot, api, function () {
          if (run().length) return;
          var v = control.value.replace(/\r\n/g, "\n");
          stage(studio, m.ref, multi ? v : v.replace(/[\n\r]+/g, " "), api);
        });
        run();
        control.focus();
      },
    });
  }

  // ---------------------------------------------------------------- markdown (safe preview built from nodes)
  function inlineNodes(text) {
    var out = [];
    var re = /(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(_[^_\n]+_)|(`[^`\n]+`)|(\[[^\]\n]+\]\([^)\s]+\))/g;
    var last = 0;
    var mt;
    while ((mt = re.exec(text))) {
      if (mt.index > last) out.push(text.slice(last, mt.index));
      var t = mt[0];
      if (mt[1]) out.push(h("strong", null, inlineNodes(t.slice(2, -2))));
      else if (mt[2] || mt[3]) out.push(h("em", null, inlineNodes(t.slice(1, -1))));
      else if (mt[4]) out.push(h("code", null, t.slice(1, -1)));
      else {
        var lm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(t);
        var safe = lm ? U.safeHref(lm[2]) : null;
        out.push(safe ? h("a", { href: safe, target: "_blank", rel: "noopener noreferrer" }, lm[1]) : (lm ? lm[1] : t));
      }
      last = mt.index + t.length;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
  }
  function renderMarkdown(container, md) {
    S.dom.clear(container);
    var blocks = String(md).replace(/\r\n/g, "\n").split(/\n{2,}/);
    blocks.forEach(function (b) {
      if (!b.trim()) return;
      var lines = b.split("\n");
      if (lines.every(function (l) { return /^\s*[-*]\s+/.test(l); })) {
        container.appendChild(h("ul", null, lines.map(function (l) { return h("li", null, inlineNodes(l.replace(/^\s*[-*]\s+/, ""))); })));
      } else if (lines.every(function (l) { return /^\s*\d+[.)]\s+/.test(l); })) {
        container.appendChild(h("ol", null, lines.map(function (l) { return h("li", null, inlineNodes(l.replace(/^\s*\d+[.)]\s+/, ""))); })));
      } else if (/^#{1,6}\s+/.test(b)) {
        container.appendChild(h("h3", null, inlineNodes(b.replace(/^#{1,6}\s+/, "").replace(/\n/g, " "))));
      } else {
        var kids = [];
        lines.forEach(function (l, i) { if (i) kids.push(h("br")); kids.push(inlineNodes(l)); });
        container.appendChild(h("p", null, kids));
      }
    });
  }
  function markdownDialog(m, studio, value) {
    var max = maxOf(studio, m.field);
    studio.ui.dialog({
      title: m.label,
      build: function (body, foot, api) {
        var id = nid();
        var ta = h("textarea", { id: id, rows: 10, value: value == null ? "" : value, spellcheck: "true" });
        var errs = errorList();
        var prev = h("div", { class: "md-preview", "aria-label": "Preview", role: "region" });
        var apply;
        var run = function () {
          var probs = check(studio, m.field, ta.value);
          showErrors(errs, probs);
          renderMarkdown(prev, ta.value);
          if (apply) apply.disabled = probs.length > 0;
          return probs;
        };
        ta.addEventListener("input", S.util.debounce(run, 120));
        ta.addEventListener("input", function () { if (apply) apply.disabled = check(studio, m.field, ta.value).length > 0; });
        body.appendChild(fieldBlock(m.label, ta, "Plain text with simple formatting: **bold**, *italic*, - bullet lists, [link text](https://example.com). " + fieldHint(m.field), null));
        body.appendChild(counter(ta, max));
        body.appendChild(errs);
        body.appendChild(h("h3", { class: "sub" }, "Preview (roughly how it will look)"));
        body.appendChild(prev);
        apply = footButtons(foot, api, function () {
          if (run().length) return;
          stage(studio, m.ref, ta.value.replace(/\r\n/g, "\n"), api);
        });
        run();
        ta.focus();
      },
    });
  }

  // ---------------------------------------------------------------- link
  function linkKind(v) {
    v = String(v || "");
    if (/^mailto:/i.test(v)) return "email";
    if (/^https?:\/\//i.test(v)) return "web";
    if (/^\/#/.test(v)) return "section";
    if (v.charAt(0) === "#") return "here";
    return "page";
  }
  function linkDialog(m, studio, value) {
    studio.ui.dialog({
      title: m.label,
      build: function (body, foot, api) {
        var v = typeof value === "string" ? value : "";
        var kind = linkKind(v);
        var idT = nid();
        var idV = nid();
        var sel = h("select", { id: idT },
          h("option", { value: "page" }, "A page on this site"),
          h("option", { value: "section" }, "A section of the home page"),
          h("option", { value: "here" }, "A spot on this same page"),
          h("option", { value: "web" }, "Another website"),
          h("option", { value: "email" }, "An email address"));
        sel.value = kind;
        var input = h("input", { id: idV, type: "text", autocomplete: "off", spellcheck: "false" });
        var help = h("p", { class: "hint" });
        var out = h("p", { class: "linkout" });
        var errs = errorList();
        var apply;
        var texts = {
          page: ["Page address", "Starts with /, for example /about/", "/", function (s) { return s; }],
          section: ["Section name", "The short name of the section, for example faq. The link will be /#faq", "faq", function (s) { return "/#" + s.replace(/^\/?#/, ""); }],
          here: ["Spot on this page", "The short name of a spot on this page, for example contact. The link will be #contact", "contact", function (s) { return "#" + s.replace(/^#/, ""); }],
          web: ["Website address", "Starts with https://", "https://example.com", function (s) { return s; }],
          email: ["Email address", "For example hello@example.com. The link will be mailto:hello@example.com", "hello@example.com", function (s) { return "mailto:" + s.replace(/^mailto:/i, ""); }],
        };
        function strip(k, s) {
          if (k === "section") return s.replace(/^\/#/, "");
          if (k === "here") return s.replace(/^#/, "");
          if (k === "email") return s.replace(/^mailto:/i, "");
          return s;
        }
        var lab = h("label", { for: idV }, "");
        function currentValue() { var t = texts[sel.value]; var raw = input.value.trim(); return raw ? t[3](raw) : ""; }
        function render() {
          var t = texts[sel.value];
          lab.textContent = t[0];
          help.textContent = t[1];
          input.setAttribute("placeholder", t[2]);
          var val = currentValue();
          out.textContent = val ? "The link will be: " + val : "";
          var probs = val ? check(studio, m.field, val) : [{ message: "Type where the link should go." }];
          showErrors(errs, val || probs.length ? probs : []);
          if (apply) apply.disabled = probs.length > 0;
          return probs;
        }
        input.value = strip(kind, v);
        sel.addEventListener("change", function () { input.value = ""; render(); });
        input.addEventListener("input", render);
        input.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); apply.click(); } });
        body.appendChild(h("div", { class: "field" }, h("label", { for: idT }, "Where does it go?"), sel));
        body.appendChild(h("div", { class: "field" }, lab, input, help));
        body.appendChild(out);
        body.appendChild(errs);
        apply = footButtons(foot, api, function () {
          if (render().length) return;
          stage(studio, m.ref, currentValue(), api);
        });
        render();
        input.focus();
      },
    });
  }

  // ---------------------------------------------------------------- colour (with the CMS contrast maths)
  function cssvarFor(m) {
    if (m.cssvar) return m.cssvar;
    var CC = window.CoveredContrast;
    if (!CC || m.file !== "theme") return null;
    var last = m.segs[m.segs.length - 1];
    var names = Object.keys(CC.VARS || {});
    for (var i = 0; i < names.length; i += 1) if (CC.VARS[names[i]].key === last) return names[i];
    return null;
  }
  function contrastWarnings(studio, m, hex) {
    var CC = window.CoveredContrast;
    var cssvar = cssvarFor(m);
    if (!CC || !cssvar || !CC.VARS || !CC.VARS[cssvar]) return null;
    var themeNow = U.plain((studio.staging._working().theme) || {});
    themeNow[CC.VARS[cssvar].key] = hex;
    var values = CC.themeValues(themeNow, CC.VARS);
    var bad = [];
    CC.evaluateAll(CC.PAIRS, values).forEach(function (r) {
      var uses = [r.pair.fg].concat(r.pair.bg || []).some(function (l) { return String(l).split("@")[0] === cssvar; });
      if (uses && r.result.status === "fail") bad.push(r);
    });
    return bad;
  }
  function colorDialog(m, studio, value) {
    var cssvar = cssvarFor(m);
    studio.ui.dialog({
      title: m.label,
      onClose: function () { S.inspect.sync(); },
      build: function (body, foot, api) {
        var idC = nid();
        var idH = nid();
        var v = typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value) ? value : "#FFFFFF";
        var picker = h("input", { id: idC, type: "color", value: v.toLowerCase(), "aria-label": "Pick a colour" });
        var hex = h("input", { id: idH, type: "text", value: typeof value === "string" ? value : "", autocomplete: "off", spellcheck: "false", maxlength: "9" });
        var swatch = h("span", { class: "swatch", "aria-hidden": "true" });
        var errs = errorList();
        var contrast = h("div", { class: "contrast", role: "status" });
        var apply;
        function run() {
          var cand = hex.value.trim();
          var probs = check(studio, m.field, cand);
          showErrors(errs, probs);
          S.dom.clear(contrast);
          if (!probs.length) {
            swatch.style.background = cand;
            if (cssvar) document.documentElement.style.setProperty(cssvar, cand);
            var bad = contrastWarnings(studio, m, cand);
            if (bad === null) { /* contrast module not available */ }
            else if (!bad.length) contrast.appendChild(h("p", { class: "ok" }, "Text stays easy to read with this colour."));
            else {
              contrast.appendChild(h("p", { class: "warn" }, "Heads up: this colour makes some text hard to read (WCAG needs a higher contrast). You can still keep it, but please check."));
              contrast.appendChild(h("ul", null, bad.slice(0, 4).map(function (r) { return h("li", null, pairName(r.pair) + ": contrast " + CC_fmt(r) + ":1, needs " + r.result.need + ":1"); })));
            }
          }
          if (apply) apply.disabled = probs.length > 0;
          return probs;
        }
        function CC_fmt(r) { return window.CoveredContrast.fmt(r.result.ratio, r.result.need); }
        function nice(layer) {
          var name = String(layer).split("@")[0];
          var v = window.CoveredContrast.VARS && window.CoveredContrast.VARS[name];
          return v ? String(v.label).toLowerCase() : "a fixed colour";
        }
        function pairName(pair) { return nice(pair.fg) + " on " + nice((pair.bg || [])[pair.bg.length - 1]); }
        picker.addEventListener("input", function () { hex.value = picker.value.toUpperCase(); run(); });
        hex.addEventListener("input", function () { if (/^#[0-9a-fA-F]{6}$/.test(hex.value.trim())) picker.value = hex.value.trim().toLowerCase(); run(); });
        hex.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); apply.click(); } });
        body.appendChild(h("div", { class: "field row" }, h("label", { for: idC }, "Colour"), picker, swatch));
        body.appendChild(fieldBlock("Colour code", hex, "Six characters after #, for example #FFEFDA. " + fieldHint(m.field), null));
        body.appendChild(errs);
        body.appendChild(contrast);
        apply = footButtons(foot, api, function () {
          if (run().length) return;
          stage(studio, m.ref, hex.value.trim().toUpperCase(), api);
        });
        run();
        hex.focus();
      },
    });
  }

  // ---------------------------------------------------------------- picture
  function imageDialog(m, studio) {
    var imgEl = m.el.tagName === "IMG" ? m.el : m.el.querySelector("img");
    var rect = (imgEl || m.el).getBoundingClientRect();
    var aspect = rect.width > 20 && rect.height > 20 ? Math.min(4, Math.max(0.35, rect.width / rect.height)) : 4 / 3;
    var needsAlt = !!m.alt || !!m.decorative;
    studio.ui.dialog({
      title: "Replace picture – " + m.label,
      build: function (body, foot, api) {
        var idF = nid();
        var idA = nid();
        var idD = nid();
        var idZ = nid();
        var state = { file: null, bmp: null, fx: 0.5, fy: 0.5, zoom: 1 };
        var cur = studio.staging.get(m.ref);
        var fileIn = h("input", { id: idF, type: "file", accept: "image/jpeg,image/png,image/webp,image/gif,image/avif" });
        var msg = errorList();
        var needs = errorList();
        var W = 320;
        var canvas = h("canvas", { width: String(W), height: String(Math.round(W / aspect)), tabindex: "0", role: "img", "aria-label": "Preview of the picture as it will be cut to fit. Drag, or use the arrow keys, to choose which part stays." });
        var zoom = h("input", { id: idZ, type: "range", min: "1", max: "3", step: "0.05", value: "1" });
        var alt = h("textarea", { id: idA, rows: 2, spellcheck: "true" });
        var dec = h("input", { id: idD, type: "checkbox" });
        var apply;
        var curAlt = m.alt ? studio.staging.get(m.alt) : "";
        function paint() {
          var c = canvas.getContext("2d");
          c.fillStyle = "#ddd";
          c.fillRect(0, 0, canvas.width, canvas.height);
          if (!state.bmp) return;
          var r = S.images.cropRect(state.bmp.width, state.bmp.height, canvas.width / canvas.height, state.fx, state.fy, state.zoom);
          c.drawImage(state.bmp, r.x, r.y, r.w, r.h, 0, 0, canvas.width, canvas.height);
        }
        function ready() {
          var probs = [];
          if (!state.file) probs.push("Choose a picture file first.");
          if (needsAlt && !dec.checked && !alt.value.trim()) probs.push("Describe the picture in a few words, or tick “decorative picture”.");
          if (m.alt && alt.value.length > 500) probs.push("Keep the description under 500 characters.");
          S.dom.clear(needs);
          if (state.file) probs.forEach(function (p) { needs.appendChild(h("li", null, p)); });
          if (apply) apply.disabled = probs.length > 0;
          return probs;
        }
        fileIn.addEventListener("change", function () {
          var f = fileIn.files && fileIn.files[0];
          S.dom.clear(msg);
          if (!f) return;
          var c = S.images.checkFile(f);
          if (!c.ok) { msg.appendChild(h("li", null, c.message)); fileIn.value = ""; state.file = null; state.bmp = null; paint(); ready(); return; }
          S.images.decode(f).then(function (bmp) { state.file = f; state.bmp = bmp; state.fx = 0.5; state.fy = 0.5; paint(); ready(); S.dom.announce("Picture loaded"); },
            function () { msg.appendChild(h("li", null, "That picture could not be read. Try another file.")); state.file = null; ready(); });
        });
        zoom.addEventListener("input", function () { state.zoom = Number(zoom.value); paint(); });
        var drag = null;
        canvas.addEventListener("pointerdown", function (e) { drag = { x: e.clientX, y: e.clientY }; try { canvas.setPointerCapture(e.pointerId); } catch (x) { /* ignore */ } });
        canvas.addEventListener("pointerup", function () { drag = null; });
        canvas.addEventListener("pointermove", function (e) {
          if (!drag || !state.bmp) return;
          var r = S.images.cropRect(state.bmp.width, state.bmp.height, canvas.width / canvas.height, state.fx, state.fy, state.zoom);
          var scale = r.w / canvas.getBoundingClientRect().width;
          var dx = (e.clientX - drag.x) * scale;
          var dy = (e.clientY - drag.y) * scale;
          drag = { x: e.clientX, y: e.clientY };
          var rx = state.bmp.width - r.w;
          var ry = state.bmp.height - r.h;
          if (rx > 1) state.fx = Math.min(1, Math.max(0, state.fx - dx / rx));
          if (ry > 1) state.fy = Math.min(1, Math.max(0, state.fy - dy / ry));
          paint();
        });
        canvas.addEventListener("keydown", function (e) {
          var d = { ArrowLeft: [-0.05, 0], ArrowRight: [0.05, 0], ArrowUp: [0, -0.05], ArrowDown: [0, 0.05] }[e.key];
          if (!d) return;
          e.preventDefault();
          state.fx = Math.min(1, Math.max(0, state.fx + d[0]));
          state.fy = Math.min(1, Math.max(0, state.fy + d[1]));
          paint();
        });
        alt.addEventListener("input", ready);
        dec.addEventListener("change", function () { alt.disabled = dec.checked; ready(); });
        if (m.alt && typeof curAlt === "string") alt.value = "";

        body.appendChild(h("p", { class: "hint" }, "Now showing: " + U.truncate(U.visible(String(cur)), 60) + ". JPEG, PNG, WebP, GIF or AVIF. Studio shrinks it for you and removes hidden location data."));
        body.appendChild(fieldBlock("New picture", fileIn, null, null));
        body.appendChild(msg);
        body.appendChild(needs);
        body.appendChild(h("div", { class: "cropbox" }, canvas));
        body.appendChild(fieldBlock("Zoom", zoom, "Drag the picture (or use the arrow keys) to choose which part stays visible.", null));
        if (needsAlt) {
          body.appendChild(fieldBlock("Describe the picture", alt, "Say what is in it, in one short sentence, for people who can't see it. Required unless the picture is purely decorative.", null));
          if (m.decorative) body.appendChild(h("div", { class: "field row" }, dec, h("label", { for: idD }, "Decorative picture (no description needed)")));
        }
        apply = footButtons(foot, api, function () {
          if (ready().length) return;
          apply.disabled = true;
          apply.textContent = "Preparing…";
          S.images.process(state.file, { aspect: canvas.width / canvas.height, fx: state.fx, fy: state.fy, zoom: state.zoom }).then(function (img) {
            return studio.staging.setImage(m.ref, img.blob, { processed: true, name: img.name, alt: alt.value.trim(), altRef: m.alt, decorative: dec.checked, decorativeRef: m.decorative });
          }).then(function () { api.close(true); studio.ui.toast("Picture changed. It is part of your draft now.", { kind: "success" }); },
            function (err) { apply.disabled = false; apply.textContent = "Keep change"; S.dom.clear(msg); msg.appendChild(h("li", null, err && err.message ? err.message : "That picture could not be used.")); });
        }, "Use this picture");
        apply.disabled = true;
        paint();
        fileIn.focus();
      },
    });
  }

  S.editors = { open: open, finishInline: finishInline, renderMarkdown: renderMarkdown, linkKind: linkKind, startInline: startInline, isEditing: function () { return !!inline; } };
})(window.__CoveredStudioBoot);
