(function (S) {
  "use strict";
  // Command palette (Ctrl/Cmd+K). ARIA combobox + listbox pattern: focus stays in the input, the active option is
  // announced through aria-activedescendant. Fuzzy scorer and generated commands are pure and tested in node.

  // ------------------------------------------------------------------ pure: search
  var STOP = { the: 1, a: 1, an: 1, to: 1, my: 1, of: 1, please: 1, for: 1, me: 1, i: 1, want: 1, can: 1, how: 1, do: 1 };
  // A founder's words -> the words our commands use. Each key expands to extra words tried in place of the key.
  var SYNONYMS = {
    change: ["edit"], update: ["edit"], modify: ["edit"], rewrite: ["edit"],
    logo: ["share picture", "brand", "image", "picture", "og"], picture: ["image", "photo"], photo: ["image", "picture"], image: ["picture", "photo"],
    headline: ["hero", "title", "heading"], title: ["heading", "headline"], heading: ["headline", "title"],
    contact: ["email", "address", "phone"], email: ["contact"], phone: ["contact"],
    remove: ["hide", "delete"], delete: ["hide", "remove"], disable: ["hide"], enable: ["show"], unhide: ["show"],
    publish: ["go live", "approve"], live: ["publish"], approve: ["publish"],
    undo: ["restore", "history", "revert"], revert: ["restore", "history", "undo"], past: ["history"],
    save: ["draft"], send: ["review", "submit"], submit: ["review", "send"],
    colour: ["color", "theme"], color: ["colour", "theme"],
    help: ["guide", "tour", "shortcuts"], logout: ["sign out"], signout: ["sign out"], "log out": ["sign out"],
  };

  function norm(s) { return String(s == null ? "" : s).toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim(); }
  function isBoundary(ch) { return !/[a-z0-9]/.test(ch); }

  function tokenScore(tok, text) {
    if (!tok || !text) return -1;
    var idx = text.indexOf(tok);
    if (idx >= 0) {
      var ws = idx === 0 || isBoundary(text.charAt(idx - 1));
      return ws ? 100 - Math.min(idx, 40) * 0.5 : 60 - Math.min(idx, 40) * 0.3;
    }
    if (tok.length < 3) return -1;
    var ti = 0, score = 0, last = -2, first = -1;
    for (var i = 0; i < text.length && ti < tok.length; i++) {
      if (text.charAt(i) === tok.charAt(ti)) {
        if (first < 0) first = i;
        score += (last === i - 1 ? 6 : 2) + (i === 0 || isBoundary(text.charAt(i - 1)) ? 4 : 0);
        last = i; ti++;
      }
    }
    if (ti < tok.length) return -1;
    if (last - first + 1 > tok.length * 2 + 2) return -1;
    return Math.min(40, 8 + score);
  }

  function tokens(query) {
    var out = norm(query).split(" ").filter(function (t) { return t && !STOP[t]; });
    return out;
  }

  function variants(tok) {
    var list = [tok];
    var syn = SYNONYMS[tok];
    if (syn) syn.forEach(function (s) { list.push(norm(s)); });
    return list;
  }

  // Score of one item for a query, or -1. item: { title, keywords[], group }
  function score(item, query) {
    var toks = tokens(query);
    if (!toks.length) return 0;
    var title = norm(item.title);
    var kw = norm((item.keywords || []).join(" "));
    var group = norm(item.group);
    var total = 0;
    for (var t = 0; t < toks.length; t++) {
      var best = -1;
      var vs = variants(toks[t]);
      for (var v = 0; v < vs.length; v++) {
        // a multi-word synonym ("share picture") matches as one phrase in the title/keywords
        var phrase = vs[v];
        var s1 = tokenScore(phrase, title);
        var s2 = tokenScore(phrase, kw);
        var s3 = tokenScore(phrase, group);
        var s = Math.max(s1, s2 >= 0 ? s2 * 0.7 : -1, s3 >= 0 ? s3 * 0.4 : -1);
        if (v > 0 && s >= 0) s *= 0.85; // a synonym is a little weaker than the word typed
        if (s > best) best = s;
      }
      if (best < 0) return -1;
      total += best;
    }
    var n = norm(query);
    if (title === n) total += 60 * toks.length;
    else if (title.indexOf(n) === 0) total += 30 * toks.length;
    return total / toks.length;
  }

  // items: array; returns up to `max` items best first. Ties keep the given order (stable).
  function search(items, query, max) {
    var limit = max || 8;
    var scored = [];
    for (var i = 0; i < items.length; i++) {
      var s = score(items[i], query);
      if (s >= 0) scored.push({ item: items[i], s: s, i: i });
    }
    scored.sort(function (a, b) { return b.s - a.s || a.i - b.i; });
    return scored.slice(0, limit).map(function (x) { return x.item; });
  }

  // ------------------------------------------------------------------ pure: generated commands
  function humanize(s) { s = String(s || "").replace(/[-_]+/g, " ").trim(); return s ? s.charAt(0).toUpperCase() + s.slice(1) : ""; }
  var EDITABLE = { text: 1, longtext: 1, markdown: 1, image: 1, link: 1, color: 1, toggle: 1 };
  var KIND_WORDS = { text: "text", longtext: "text paragraph", markdown: "text paragraph", image: "picture photo image", link: "link button url", color: "colour color", toggle: "switch" };

  // sections: homepage.sections array; labelFor(index, section) -> readable name
  function sectionCommands(sections, labelFor) {
    var out = [];
    (sections || []).forEach(function (sec, i) {
      if (!sec || typeof sec !== "object") return;
      var name = (labelFor && labelFor(i, sec)) || humanize(sec.type) || "Section " + (i + 1);
      var ref = "homepage.sections." + i;
      out.push({ id: "go.section." + i, title: "Go to " + name, keywords: ["section", "jump", "scroll", "find", String(sec.type || "")], group: "Sections", kind: "go-section", ref: ref, index: i });
      var on = sec.enabled !== false;
      out.push({ id: "toggle.section." + i, title: (on ? "Hide " : "Show ") + name, keywords: ["section", "switch", on ? "remove off" : "bring back on", String(sec.type || "")], group: "Sections", kind: "toggle-section", ref: ref + ".enabled", index: i });
    });
    return out;
  }

  // markers: [{ ref, kind }] collected from the page; labelFor(ref) -> field label
  function fieldCommands(markers, labelFor, max) {
    var seen = {};
    var out = [];
    (markers || []).forEach(function (m) {
      if (!m || !EDITABLE[m.kind] || seen[m.ref] || out.length >= (max || 80)) return;
      seen[m.ref] = 1;
      var label = (labelFor && labelFor(m.ref)) || m.ref;
      out.push({ id: "edit." + m.ref, title: "Edit " + label, keywords: ["change", "field", KIND_WORDS[m.kind] || "", m.ref.split(".").join(" ")], group: "Edit this page", kind: "edit-ref", ref: m.ref });
    });
    return out;
  }

  function mergeById(lists) {
    var seen = {};
    var out = [];
    lists.forEach(function (l) { (l || []).forEach(function (c) { if (c && c.id && !seen[c.id]) { seen[c.id] = 1; out.push(c); } }); });
    return out;
  }

  var api = { score: score, search: search, tokens: tokens, norm: norm, SYNONYMS: SYNONYMS, sectionCommands: sectionCommands, fieldCommands: fieldCommands, mergeById: mergeById, tokenScore: tokenScore };
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (!S) return;
  S.ext = S.ext || {};
  S.ext.palette = api;

  // ------------------------------------------------------------------ DOM
  S.ready(function (studio) {
    var ui = studio.ui;
    var layer = null;
    var open = null;
    var MAX = 8;

    function el(tag, props) {
      var kids = [];
      for (var i = 2; i < arguments.length; i++) {
        var k = arguments[i];
        if (Array.isArray(k)) kids.push.apply(kids, k.filter(function (x) { return x != null && x !== false; }));
        else if (k != null && k !== false) kids.push(k);
      }
      return ui.h.apply(ui, [tag, props || null].concat(kids));
    }
    // the palette lives inside the overlay's own shadow root (ext.css is part of the styles injected into it)
    function root() { return ui.root; }
    function can(name) { var c = studio.me && studio.me.capabilities; return !!(c && c[name]); }
    function callUi(name, a) { try { if (typeof ui[name] === "function") return ui[name](a); } catch (e) { /* ignore */ } }
    function setMode(m) {
      if (typeof studio.setMode === "function") studio.setMode(m);
      else studio.emit("mode:request", { mode: m });
    }
    function failToast(e) { ui.toast((e && e.message) || "That did not work.", { kind: "error" }); }

    // ---- static commands (palette-owned; ids are stable so other modules can override by id)
    function staticCommands() {
      return [
        { id: "draft.save", title: "Save draft", keywords: ["save", "keep", "store", "changes"], group: "Draft", shortcut: "Ctrl/Cmd+S", when: function (s) { return s.staging && s.staging.count() > 0; },
          run: function (s) { return s.staging.save({}).catch(failToast); } },
        { id: "draft.submit", title: "Send for review", keywords: ["review", "submit", "approve", "ask"], group: "Draft", when: function (s) { return !!(s.drafts && s.drafts.current()); },
          run: function (s) { return s.drafts.submit().catch(failToast); } },
        { id: "draft.publish", title: "Publish", keywords: ["go live", "approve", "release", "merge"], group: "Draft", when: function (s) { return can("publish") && !!(s.drafts && s.drafts.current()); },
          run: function (s) {
            return ui.confirm({ title: "Publish this draft?", body: "The changes go live on the website.", confirmLabel: "Publish" }).then(function (y) { return y ? s.drafts.publish() : null; }).catch(failToast);
          } },
        { id: "draft.discard-all", title: "Discard all changes", keywords: ["throw away", "reset", "cancel", "clear"], group: "Draft", when: function (s) { return s.staging && s.staging.count() > 0; },
          run: function (s) { return ui.confirm({ title: "Discard all changes?", body: "Everything you have changed since your last save is thrown away.", confirmLabel: "Discard", danger: true }).then(function (y) { if (y) s.staging.clear(); }); } },
        { id: "draft.switch", title: "Switch draft", keywords: ["other", "open", "pick", "drafts"], group: "Draft", mode: "drafts" },
        { id: "draft.copy-link", title: "Copy preview link", keywords: ["share", "url", "send", "link"], group: "Draft", when: function (s) { var d = s.drafts && s.drafts.current(); return !!(d && d.previewUrl); },
          run: function (s) {
            var d = s.drafts.current();
            try { return window.navigator.clipboard.writeText(d.previewUrl).then(function () { ui.toast("Preview link copied.", { kind: "success" }); }, failToast); } catch (e) { failToast(e); }
          } },
        { id: "mode.toggle", title: "Toggle edit mode", keywords: ["edit", "browse", "editing", "switch"], group: "View", shortcut: "E", run: function (s) { setMode(s.mode === "edit" ? "browse" : "edit"); } },
        { id: "panel.changes", title: "Open Changes", keywords: ["staged", "list", "review"], group: "Go", run: function () { callUi("openPanel", "changes"); } },
        { id: "panel.sections", title: "Open Sections", keywords: ["home page", "order", "hide", "show"], group: "Go", run: function () { callUi("openPanel", "sections"); } },
        { id: "panel.fields", title: "Open all fields", keywords: ["form", "search", "settings"], group: "Go", run: function () { callUi("openPanel", "fields"); } },
        { id: "account.signout", title: "Sign out", keywords: ["log out", "logout", "leave"], group: "Account",
          run: function (s) { if (s.auth && typeof s.auth.signOut === "function") s.auth.signOut(); else callUi("openPanel", "account"); } },
      ];
    }

    function homepageSections() {
      try { var f = studio.content.files(); return (f.homepage && f.homepage.data && f.homepage.data.sections) || []; } catch (e) { return []; }
    }
    function sectionLabel(i, sec) {
      try { var r = studio.schema.resolve("homepage.sections." + i); if (r && r.itemType && r.itemType.label) return r.itemType.label; } catch (e) { /* fall back */ }
      return humanize(sec.type);
    }
    function pageMarkers() {
      var out = [];
      try {
        var nodes = document.querySelectorAll("[data-cms][data-cms-kind]");
        for (var i = 0; i < nodes.length && out.length < 400; i++) out.push({ ref: nodes[i].getAttribute("data-cms"), kind: nodes[i].getAttribute("data-cms-kind") });
      } catch (e) { /* none */ }
      return out;
    }
    function fieldLabel(ref) { try { return studio.schema.label(ref); } catch (e) { return null; } }

    function generated() {
      var cmds = sectionCommands(homepageSections(), sectionLabel).concat(fieldCommands(pageMarkers(), fieldLabel));
      cmds.forEach(function (c) {
        if (c.kind === "go-section") c.run = function (s) {
          var node = document.querySelector('[data-cms="' + c.ref + '"][data-cms-kind="section"]');
          if (node && node.scrollIntoView) node.scrollIntoView({ block: "start", behavior: "smooth" });
          else callUi("openPanel", "sections");
        };
        else if (c.kind === "toggle-section") c.run = function (s) { return s.staging.toggle(c.ref); };
        else if (c.kind === "edit-ref") c.run = function (s) { return ui.editRef(c.ref); };
      });
      return cmds;
    }
    function registered() {
      var list = [];
      try { if (typeof ui.listCommands === "function") list = list.concat(ui.listCommands() || []); } catch (e) { /* ignore */ }
      return list.concat(S.ext.commands || []);
    }
    function allCommands() {
      // order = what you see with an empty query: draft actions first, then navigation
      return mergeById([staticCommands(), registered(), generated()]);
    }

    // ---- UI
    var uid = 0;
    function openPalette() {
      if (open) return;
      var returnTo = document.activeElement;
      var id = "csx-pal-" + ++uid;
      var items = [];
      var mode = "commands";
      var active = 0;
      var draftsList = null;

      var input = el("input", { type: "text", class: "csx-pal-input", role: "combobox", "aria-expanded": "true", "aria-controls": id + "-list", "aria-autocomplete": "list", "aria-label": "Search commands", placeholder: "Type what you want to do…", autocomplete: "off", spellcheck: "false" });
      var list = el("ul", { class: "csx-pal-list", id: id + "-list", role: "listbox", "aria-label": "Commands" });
      var status = el("div", { class: "csx-visually-hidden", role: "status", "aria-live": "polite" });
      var hint = el("div", { class: "csx-pal-hint" }, "Up and Down to choose, Enter to run, Esc to close");
      var dlg = el("div", { class: "csx-pal", role: "dialog", "aria-modal": "true", "aria-label": "Command palette" }, input, list, status, hint);
      var backdrop = el("div", { class: "csx-pal-backdrop", on: { mousedown: function (ev) { if (ev.target === backdrop) close(); } } }, dlg);
      var wrap = el("div", { class: "csx-pal-wrap", "data-studio-ui": "" }, backdrop);
      root().appendChild(wrap);

      function paint() {
        while (list.firstChild) list.removeChild(list.firstChild);
        items.forEach(function (it, i) {
          var sel = i === active;
          var li = el("li", { class: "csx-pal-item" + (sel ? " csx-sel" : ""), role: "option", id: id + "-o" + i, "aria-selected": sel ? "true" : "false", on: { mousemove: function () { if (active !== i) { active = i; mark(); } }, mousedown: function (ev) { ev.preventDefault(); run(it); } } },
            el("span", { class: "csx-pal-title" }, it.title),
            el("span", { class: "csx-pal-meta" }, it.shortcut ? el("span", { class: "csx-key" }, it.shortcut) : null, it.group ? el("span", { class: "csx-pal-group" }, it.group) : null));
          list.appendChild(li);
        });
        if (!items.length) list.appendChild(el("li", { class: "csx-pal-none", role: "presentation" }, "Nothing matches. Try a different word, like \"headline\" or \"history\"."));
        input.setAttribute("aria-expanded", items.length ? "true" : "false");
        if (items.length) input.setAttribute("aria-activedescendant", id + "-o" + active); else input.removeAttribute("aria-activedescendant");
        status.textContent = items.length ? items.length + (items.length === 1 ? " result" : " results") + ". " + items[active].title : "No results";
      }
      function mark() {
        var kids = list.children;
        for (var i = 0; i < kids.length; i++) {
          var sel = i === active;
          kids[i].setAttribute("aria-selected", sel ? "true" : "false");
          kids[i].className = "csx-pal-item" + (sel ? " csx-sel" : "");
        }
        input.setAttribute("aria-activedescendant", id + "-o" + active);
        status.textContent = items[active] ? items[active].title : "";
      }
      function refresh() {
        var q = input.value;
        if (mode === "drafts") {
          var pool = (draftsList || []).map(function (d) { return { id: "draft." + d.id, title: d.title || d.id, keywords: [d.state || "", d.author && d.author.name || ""], group: d.state || "draft", draft: d }; });
          items = search(pool, q, MAX);
        } else {
          var visible = allCommands().filter(function (c) { try { return !c.when || c.when(studio); } catch (e) { return false; } });
          items = search(visible, q, MAX);
        }
        active = 0;
        paint();
      }
      function run(it) {
        if (it.mode === "drafts") {
          mode = "drafts";
          input.value = "";
          input.setAttribute("aria-label", "Search drafts");
          input.setAttribute("placeholder", "Pick a draft…");
          draftsList = [];
          refresh();
          Promise.resolve(studio.drafts.list()).then(function (r) { draftsList = Array.isArray(r) ? r : (r && r.drafts) || []; if (open) refresh(); }, failToast);
          return;
        }
        close();
        try {
          if (it.draft) { studio.drafts.setCurrent(it.draft.id); return; }
          // editing needs a signed-in person: say so and open the sign-in panel instead of doing nothing
          if (!studio.me && (it.kind === "edit-ref" || it.kind === "toggle-section")) {
            ui.toast("Sign in to edit this page.", { kind: "info" });
            callUi("openPanel", "account");
            return;
          }
          var res = it.run(studio);
          if (res && typeof res.catch === "function") res.catch(failToast);
        } catch (e) { failToast(e); }
      }
      function close() {
        if (!open) return;
        document.removeEventListener("keydown", onKey, true);
        if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
        open = null;
        try { if (returnTo && returnTo.focus) returnTo.focus(); } catch (e) { /* ignore */ }
      }
      function onKey(ev) {
        if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); close(); }
        else if (ev.key === "ArrowDown") { ev.preventDefault(); if (items.length) { active = (active + 1) % items.length; mark(); } }
        else if (ev.key === "ArrowUp") { ev.preventDefault(); if (items.length) { active = (active - 1 + items.length) % items.length; mark(); } }
        else if (ev.key === "Home" && items.length) { ev.preventDefault(); active = 0; mark(); }
        else if (ev.key === "End" && items.length) { ev.preventDefault(); active = items.length - 1; mark(); }
        else if (ev.key === "Enter") { ev.preventDefault(); if (items[active]) run(items[active]); }
        else if (ev.key === "Tab") { ev.preventDefault(); input.focus(); }
      }
      input.addEventListener("input", refresh);
      document.addEventListener("keydown", onKey, true);
      open = { close: close };
      refresh();
      input.focus();
    }

    S.ext.palette.open = openPalette;
    S.ext.palette.close = function () { if (open) open.close(); };
    S.ext.palette.isOpen = function () { return !!open; };
    S.ext.palette.commands = allCommands;

    document.addEventListener("keydown", function (ev) {
      if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && !ev.shiftKey && (ev.key === "k" || ev.key === "K")) {
        ev.preventDefault();
        ev.stopPropagation();
        if (open) open.close(); else openPalette();
      }
    }, true);
  });
})(window.__CoveredStudioBoot);
