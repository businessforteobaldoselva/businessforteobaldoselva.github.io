/* COVERED Studio - the content rules (Phase 1, studio/PHASE1-DESIGN.md section 8.4). Registered into the engine; the same file is
   bundled into the overlay ("Check my changes") and required by Node (the CI guard and the tests). Pure: no DOM, fs, network,
   eval, Date or randomness. Content-level checks only (words, links, pictures): never a claim about WCAG.
   ctx = { files, schema, facts, roles, ...helpers }: `roles` is studio/content-rules/field-roles.json (Node gets it from index.js,
   the overlay from the bundle). Every rule returns [ { file, path, message, hint?, fix?, data? } ]. */
(function (root, factory) {
  var engine = (typeof module === "object" && module && module.exports) ? require("./engine.js") : root.CoveredContentRules;
  factory(engine);
})(typeof self !== "undefined" ? self : this, function (engine) {
  "use strict";

  // ------------------------------------------------------------------ helpers
  function isObj(v) { return v !== null && typeof v === "object" && !Array.isArray(v); }
  function str(v) { return typeof v === "string" ? v : ""; }
  function ptr(segs) { return segs.length ? "/" + segs.join("/") : ""; }
  function clip(s, n) { s = String(s).replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; }
  function norm(s) { return String(s == null ? "" : s).toLowerCase().replace(/\s+/g, " ").trim(); }
  function words(s) { return norm(s).replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim(); }
  function stripEmoji(s) { return String(s || "").replace(/^[^\p{L}\p{N}]+/u, "").replace(/\s+/g, " ").replace(/\s*\([^)]*\)\s*$/, "").trim(); }
  function plural(n, one, many) { return n + " " + (n === 1 ? one : many); }
  function baseName(v) { var s = String(v || "").split("?")[0].split("#")[0]; return s.slice(s.lastIndexOf("/") + 1); }
  function stem(name) { return name.replace(/\.[A-Za-z0-9]+$/, "").toLowerCase(); }

  // roles: "file:field" (file "pages" for every page) or "*:field" -> role name, or { ignore } entries
  function roleOf(ctx, fileKey, name) {
    var r = ctx.roles || {};
    var fk = fileKey.indexOf("pages:") === 0 ? "pages" : fileKey;
    var m = r.map || {};
    var specific = fk + ":" + name;
    var generic = "*:" + name;
    return m[specific] || m[generic] || null;
  }

  function fileLabel(ctx, fileKey) {
    var s = ctx.schema || {};
    if (fileKey.indexOf("pages:") === 0) return "Page " + fileKey.slice(6);
    var f = s.files && s.files[fileKey];
    return stripEmoji((f && f.label) || fileKey);
  }

  // The fields of one list item: typed lists (`types`, key `typeKey` or "type"), `fields`, or a single `field`.
  function itemFields(listField, item) {
    if (listField.types) {
      var key = listField.typeKey || "type";
      for (var i = 0; i < listField.types.length; i++) if (item && listField.types[i].name === item[key]) return { fields: listField.types[i].fields || [], label: listField.types[i].label || listField.types[i].name };
      return null;
    }
    if (listField.fields) return { fields: listField.fields, label: listField.label_singular || listField.label || "Item" };
    return null;
  }

  // visit(leaf) for every leaf field (strings, pictures, links ...) of every file, in a stable order.
  // leaf = { file, segs, path, field, value, obj, objFields, labels }  (obj = the object that holds the value, objFields = its field list)
  function walk(ctx, visit) {
    var files = ctx.files || {};
    var schema = ctx.schema || {};
    Object.keys(files).sort().forEach(function (fileKey) {
      var data = files[fileKey];
      if (!isObj(data)) return;
      var fs = fileKey.indexOf("pages:") === 0 ? schema.pages : schema.files && schema.files[fileKey];
      if (!fs) return;
      var base = [fileLabel(ctx, fileKey)];
      function leaf(field, value, segs, obj, objFields, labels) {
        visit({ file: fileKey, segs: segs, path: ptr(segs), field: field, value: value, obj: obj, objFields: objFields, labels: labels });
      }
      function node(field, value, segs, obj, objFields, labels) {
        var w = field.widget || "string";
        var here = labels.concat(stripEmoji(field.label || field.name || ""));
        if (w === "object" && field.fields) {
          (field.fields || []).forEach(function (f) { node(f, isObj(value) ? value[f.name] : undefined, segs.concat(f.name), isObj(value) ? value : {}, field.fields, here); });
        } else if (w === "list") {
          if (!Array.isArray(value)) return;
          value.forEach(function (it, i) {
            var inf = itemFields(field, it);
            if (inf && isObj(it)) {
              var l = here.concat(stripEmoji(inf.label) + (field.types ? "" : " " + (i + 1)));
              inf.fields.forEach(function (f) { node(f, it[f.name], segs.concat(String(i), f.name), it, inf.fields, l); });
            } else if (!field.types && !field.fields && field.field) {
              node(Object.assign({}, field.field, { name: String(i) }), it, segs.concat(String(i)), null, null, here.concat(String(i + 1)));
            }
          });
        } else if (w === "hidden") {
          return;
        } else leaf(field, value, segs, obj, objFields, here);
      }
      (fs.fields || []).forEach(function (f) { node(f, data[f.name], [f.name], data, fs.fields, base); });
      if (fileKey.indexOf("pages:") === 0 && typeof data._body === "string") {
        leaf({ name: "_body", label: "Page body", widget: "markdown" }, data._body, ["_body"], data, [], base);
      }
    });
  }

  function labelOf(leaf) { return leaf.labels.filter(Boolean).join(" > "); }
  function refOf(leaf) { return leaf.file + "." + leaf.segs.join("."); }
  function dataFor(leaf, extra) { var d = { ref: refOf(leaf) }; if (extra) Object.keys(extra).forEach(function (k) { d[k] = extra[k]; }); return d; }
  function isImage(field) { return field && (field.widget === "image" || (field.x && field.x.rule === "image")); }
  function isLink(field) { var r = field && field.x && field.x.rule; return r === "url" || r === "redirect-to"; }
  function hasField(fields, name) { return (fields || []).some(function (f) { return f.name === name; }); }
  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  // ---- alt text pairs: a picture and the description (and "decorative" switch) next to it ----
  // `src` / `image` pair with `alt` / `decorative`; any other picture N pairs with `NAlt` / `NDecorative` (shareImage -> shareImageAlt).
  function altPair(leaf) {
    var n = leaf.field.name;
    var generic = n === "src" || n === "image";
    var altName = generic && hasField(leaf.objFields, "alt") ? "alt" : hasField(leaf.objFields, n + "Alt") ? n + "Alt" : null;
    if (!altName) return null;
    var decName = generic && hasField(leaf.objFields, "decorative") ? "decorative" : hasField(leaf.objFields, n + "Decorative") ? n + "Decorative" : null;
    return { altName: altName, decName: decName, alt: str(leaf.obj && leaf.obj[altName]).trim(), decorative: !!(decName && leaf.obj && leaf.obj[decName] === true) };
  }

  // ---- links: the label next to an address ----
  function labelSibling(leaf) {
    var n = leaf.field.name;
    var b = n.replace(/(Link|Url)$/, "");
    var cands = ["label", b + "Text", b + "Label", b + "Button"];
    for (var i = 0; i < cands.length; i++) if (hasField(leaf.objFields, cands[i]) && cands[i] !== n) return cands[i];
    return null;
  }

  // markdown links [text](address) and headings, ignoring fenced code
  function mdLines(text) {
    var out = [];
    var fence = false;
    String(text).split("\n").forEach(function (line, i) {
      if (/^\s*(```|~~~)/.test(line)) { fence = !fence; return; }
      if (!fence) out.push({ n: i + 1, line: line });
    });
    return out;
  }
  function mdLinks(text) {
    var out = [];
    mdLines(text).forEach(function (l) {
      var re = /\[([^\]\n]*)\]\(\s*<?([^)\s>]*)>?[^)]*\)/g;
      var m;
      while ((m = re.exec(l.line))) out.push({ text: m[1], href: m[2], n: l.n });
    });
    return out;
  }
  function isMarkdown(leaf) { return leaf.field.widget === "markdown" || leaf.field.name === "_body"; }

  var VAGUE = { "click here": 1, here: 1, "read more": 1, "learn more": 1, more: 1, link: 1, "this": 1, "find out more": 1 };

  function stats(ctx) { return ctx.facts || {}; }

  // ------------------------------------------------------------------ rules
  function register(id, severity, title, check) { engine.register({ id: id, severity: severity, title: title, check: check }); }

  register("alt-missing", "block", "A picture needs a description", function (ctx) {
    var out = [];
    walk(ctx, function (l) {
      if (!isImage(l.field) || !str(l.value).trim()) return;
      var p = altPair(l);
      if (!p || !p.decName || p.decorative || p.alt) return;
      out.push({ file: l.file, path: ptr(l.segs.slice(0, -1).concat(p.altName)),
        message: "The picture “" + clip(labelOf(l), 70) + "” has no description for people who cannot see it.",
        hint: "Describe what is in the picture in a short sentence, or tick “Decorative picture” if it only decorates the page.",
        fix: { kind: "edit-field" }, data: dataFor(l, { ref: l.file + "." + l.segs.slice(0, -1).concat(p.altName).join(".") }) });
    });
    return out;
  });

  register("alt-weak", "warn", "A picture description could say more", function (ctx) {
    var out = [];
    walk(ctx, function (l) {
      if (!isImage(l.field) || !str(l.value).trim()) return;
      var p = altPair(l);
      if (!p || p.decorative || !p.alt) return;
      var a = p.alt;
      var why = null;
      if (a.length < 5) why = "is very short";
      else if (a.length > 150) why = "is very long (" + a.length + " characters)";
      else if (words(a) === words(stem(baseName(l.value))) || words(a) === words(baseName(l.value))) why = "is just the file name";
      else if (/^(image|picture|photo|photograph) of\b/i.test(a)) why = "starts with “image of” or “picture of”, which screen readers already say";
      if (!why) return;
      out.push({ file: l.file, path: ptr(l.segs.slice(0, -1).concat(p.altName)),
        message: "The description of “" + clip(labelOf(l), 70) + "” " + why + ".",
        hint: "Aim for one clear sentence of 5 to 150 characters about what the picture shows.",
        fix: { kind: "edit-field" }, data: dataFor(l, { ref: l.file + "." + l.segs.slice(0, -1).concat(p.altName).join(".") }) });
    });
    return out;
  });

  function lengthRule(id, roleName, lo, hi, noun, what) {
    register(id, "warn", noun + " length", function (ctx) {
      var out = [];
      walk(ctx, function (l) {
        if (typeof l.value !== "string" || roleOf(ctx, l.file, l.field.name) !== roleName) return;
        var t = l.value.trim();
        if (!t) return;
        var n = t.length;
        if (n >= lo && n <= hi) return;
        out.push({ file: l.file, path: l.path,
          message: "The " + noun + " (“" + clip(labelOf(l), 60) + "”) is " + (n > hi ? "long" : "short") + ": " + plural(n, "character", "characters") + ".",
          hint: "Aim for " + lo + " to " + hi + " characters. " + what, fix: { kind: "shorten" }, data: dataFor(l, { length: n }) });
      });
      return out;
    });
  }
  lengthRule("title-length", "seoTitle", 15, 60, "search title", "Google cuts longer titles off with … and a very short one says little.");
  register("description-length", "warn", "Description length", function (ctx) {
    var out = [];
    walk(ctx, function (l) {
      if (typeof l.value !== "string") return;
      var role = roleOf(ctx, l.file, l.field.name);
      var lim = role === "seoDescription" ? [70, 160, "search description"] : role === "socialDescription" ? [40, 200, "social share description"] : null;
      if (!lim) return;
      var t = l.value.trim();
      if (!t) return;
      var n = t.length;
      if (n >= lim[0] && n <= lim[1]) return;
      out.push({ file: l.file, path: l.path,
        message: "The " + lim[2] + " (“" + clip(labelOf(l), 60) + "”) is " + (n > lim[1] ? "long" : "short") + ": " + plural(n, "character", "characters") + ".",
        hint: "Aim for " + lim[0] + " to " + lim[1] + " characters so it shows in full and says something useful.", fix: { kind: "shorten" }, data: dataFor(l, { length: n }) });
    });
    return out;
  });

  register("duplicate-text", "warn", "The same words used twice", function (ctx) {
    var out = [];
    var seen = {};
    var lists = {};
    walk(ctx, function (l) {
      if (typeof l.value !== "string" || !l.value.trim()) return;
      var role = roleOf(ctx, l.file, l.field.name);
      if (role === "seoTitle" || role === "seoDescription") {
        var k = role + "|" + words(l.value);
        if (seen[k]) {
          out.push({ file: l.file, path: l.path, message: "“" + clip(labelOf(l), 60) + "” is the same as " + seen[k] + ". Search engines like each page to have its own " + (role === "seoTitle" ? "title" : "description") + ".",
            hint: "Reword one of them.", fix: { kind: "edit-field" }, data: dataFor(l) });
        } else seen[k] = "“" + clip(labelOf(l), 60) + "”";
      }
      if (role === "heading" && l.segs.length >= 3) {
        // the same heading twice in one list: group by the list's path (segments before the item index)
        var lp = l.file + "|" + l.segs.slice(0, -2).join(".") + "|" + l.field.name;
        var kk = lp + "|" + words(l.value);
        if (lists[kk]) {
          out.push({ file: l.file, path: l.path, message: "Two items in “" + clip(l.labels[l.labels.length - 3] || l.labels[0], 50) + "” have the same " + (l.field.name === "q" ? "question" : "heading") + ": “" + clip(l.value, 60) + "”.",
            hint: "Reword one so a visitor can tell them apart.", fix: { kind: "edit-field" }, data: dataFor(l) });
        } else lists[kk] = true;
      }
    });
    return out;
  });

  register("vague-link-text", "warn", "A link says nothing about where it goes", function (ctx) {
    var out = [];
    walk(ctx, function (l) {
      if (typeof l.value !== "string") return;
      if (isLink(l.field) && l.obj) {
        var lab = labelSibling(l);
        if (lab) {
          var t = str(l.obj[lab]);
          if (VAGUE[words(t)]) out.push({ file: l.file, path: ptr(l.segs.slice(0, -1).concat(lab)), message: "The link “" + clip(t, 40) + "” does not say where it goes.",
            hint: "Say what the visitor will find, for example “See how it works”.", fix: { kind: "reword-link" }, data: dataFor(l, { ref: l.file + "." + l.segs.slice(0, -1).concat(lab).join(".") }) });
        }
      } else if (isMarkdown(l)) {
        mdLinks(l.value).forEach(function (k, idx) {
          if (VAGUE[words(k.text)]) out.push({ file: l.file, path: l.path + "#link" + (idx + 1), message: "A link in “" + clip(labelOf(l), 50) + "” says “" + clip(k.text, 30) + "”, which does not say where it goes.",
            hint: "Use words that describe the destination.", fix: { kind: "reword-link" }, data: dataFor(l) });
        });
      }
    });
    return out;
  });

  function internalProblem(href, here, ctx, extraAnchors) {
    var f = stats(ctx);
    var routes = f.routes;
    if (!Array.isArray(routes) || !routes.length) return null; // no facts: skip (the panel says so)
    var v = String(href || "").trim();
    var hashAt = v.indexOf("#");
    var hash = hashAt >= 0 ? v.slice(hashAt + 1) : "";
    var pathPart = (hashAt >= 0 ? v.slice(0, hashAt) : v).split("?")[0];
    if (pathPart === "" && hashAt >= 0) pathPart = here || "/";
    else if (pathPart.charAt(0) !== "/" || pathPart.charAt(1) === "/") return null; // external, mailto, relative: not our business
    var known = routes.concat(f.tools || []);
    var withSlash = pathPart.charAt(pathPart.length - 1) === "/" ? pathPart : pathPart + "/";
    var redirected = (f.redirectFrom || []).indexOf(pathPart) >= 0 || (f.redirectFrom || []).indexOf(withSlash) >= 0;
    var isFile = /\.[A-Za-z0-9]{2,5}$/.test(pathPart);
    var routeOk = known.indexOf(pathPart) >= 0 || known.indexOf(withSlash) >= 0;
    if (!routeOk && !isFile) {
      if (redirected) return { severity: "info", message: "This link goes through a redirect (" + clip(pathPart, 60) + "), so visitors take an extra hop.", hint: "Point it straight at the new page." };
      return { severity: "block", message: "This link points to " + clip(pathPart, 80) + ", but there is no page at that address.", hint: "Pick a page that exists, or fix the spelling." };
    }
    if (hash && !isFile) {
      var route = routeOk ? (known.indexOf(pathPart) >= 0 ? pathPart : withSlash) : pathPart;
      var anchors = (f.anchors && f.anchors[route]) || null;
      var all = (anchors || []).concat(extraAnchors || []);
      if (all.indexOf(hash) < 0) {
        if (!anchors && !(f.tools || []).length && !routeOk) return null;
        return { severity: anchors ? "block" : "info", message: "This link jumps to #" + clip(hash, 40) + ", but that part is not on " + (route === "/" ? "the home page" : clip(route, 40)) + ".", hint: "Pick a section that exists on that page." };
      }
    }
    return null;
  }

  register("broken-internal-link", "block", "A link goes nowhere", function (ctx) {
    var out = [];
    var extra = [];
    walk(ctx, function (l) { if (l.field.x && l.field.x.rule === "anchor" && str(l.value).trim()) extra.push(str(l.value).trim()); });
    walk(ctx, function (l) {
      if (typeof l.value !== "string") return;
      var here = l.file.indexOf("pages:") === 0 ? str(l.obj && l.obj.permalink) || str(ctx.files[l.file] && ctx.files[l.file].permalink) || "/" : "/";
      if (isLink(l.field) && l.value.trim()) {
        var p = internalProblem(l.value, here, ctx, extra);
        if (p) out.push({ file: l.file, path: l.path, severity: p.severity, message: p.message, hint: p.hint, fix: { kind: "edit-field" }, data: dataFor(l, { href: clip(l.value, 120) }) });
      } else if (isMarkdown(l)) {
        mdLinks(l.value).forEach(function (k, idx) {
          var p2 = internalProblem(k.href, here, ctx, extra);
          if (p2) out.push({ file: l.file, path: l.path + "#link" + (idx + 1), severity: p2.severity, message: "A link in “" + clip(labelOf(l), 50) + "”: " + p2.message, hint: p2.hint, fix: { kind: "edit-field" }, data: dataFor(l, { href: clip(k.href, 120) }) });
        });
      }
    });
    return out;
  });

  register("heading-skip", "warn", "Headings jump a level", function (ctx) {
    var out = [];
    walk(ctx, function (l) {
      if (typeof l.value !== "string" || !isMarkdown(l)) return;
      var prev = 1; // the page title is the H1
      var problem = null;
      mdLines(l.value).forEach(function (x) {
        var m = /^(#{1,6})\s+\S/.exec(x.line);
        if (!m || problem) return;
        var lvl = m[1].length;
        if (lvl === 1) problem = "uses a top-level heading (line " + x.n + "), but the page title is already the top-level heading";
        else if (lvl > prev + 1) problem = "jumps from a level " + prev + " heading to a level " + lvl + " heading (line " + x.n + ")";
        prev = lvl;
      });
      if (problem) out.push({ file: l.file, path: l.path, message: "The text “" + clip(labelOf(l), 60) + "” " + problem + ".",
        hint: "Use headings in order, one level at a time, so screen-reader users can scan the page.", fix: { kind: "edit-field" }, data: dataFor(l) });
    });
    return out;
  });

  register("image-heavy", "warn", "A picture is heavy", function (ctx) {
    var out = [];
    var imgs = stats(ctx).images;
    if (!imgs) return out;
    walk(ctx, function (l) {
      if (!isImage(l.field) || typeof l.value !== "string" || !l.value.trim()) return;
      var info = imgs[baseName(l.value)];
      if (!info) return;
      var kb = Math.round((info.bytes || 0) / 1024);
      var big = (info.bytes || 0) > 600 * 1024;
      var wide = (info.width || 0) > 3000;
      if (!big && !wide) return;
      out.push({ file: l.file, path: l.path, message: "The picture “" + clip(labelOf(l), 60) + "” is " + (big ? kb + " KB" : "") + (big && wide ? " and " : "") + (wide ? info.width + " pixels wide" : "") + ", which slows the page down.",
        hint: "Shrink it to under 600 KB and 3000 pixels wide before uploading.", fix: { kind: "pick-image" }, data: dataFor(l, { bytes: info.bytes || 0, width: info.width || 0 }) });
    });
    return out;
  });

  register("page-weight", "warn", "A page carries a lot of pictures", function (ctx) {
    var out = [];
    var f = stats(ctx);
    if (!f.pages || !f.images) return out;
    Object.keys(f.pages).sort().forEach(function (route) {
      var seen = {};
      var total = 0;
      ((f.pages[route] && f.pages[route].images) || []).forEach(function (n) { if (!seen[n] && f.images[n]) { seen[n] = 1; total += f.images[n].bytes || 0; } });
      if (total <= 3 * 1024 * 1024) return;
      out.push({ file: route, path: "", message: "The pictures on " + (route === "/" ? "the home page" : route) + " add up to about " + (Math.round(total / 104857.6) / 10) + " MB, which is a lot for a phone to download.",
        hint: "Use fewer or smaller pictures on that page.", fix: null, data: { route: route, bytes: total } });
    });
    return out;
  });

});
