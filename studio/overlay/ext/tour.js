(function (S) {
  "use strict";
  // First-run tour (studio/DESIGN.md 11): 7 short steps, each anchored to a real control or to a real editable thing
  // on the page, with a centred card when the anchor is not there. Skippable, keyboard operable, replayable from Help
  // and the palette. Progress is remembered per user in localStorage (try/catch; works without storage).

  var STEPS = [
    { id: "welcome", title: "Welcome to Studio", body: "Change the website's words and pictures right on the page. Nothing goes live until someone has reviewed it, so you cannot break anything.", anchors: [] },
    { id: "text", title: "Click any text to change it", body: "Switch on Edit mode, then click a headline or a paragraph and type. Press Enter when you are done.", anchors: ['[data-cms-kind="text"]', '[data-cms-kind="longtext"]', '[data-cms-kind="markdown"]'], scroll: true },
    { id: "image", title: "Click a picture to swap it", body: "Choose a new photo and crop it. We will ask for a short description, so people using a screen reader know what is in it.", anchors: ['[data-cms-kind="image"]'], scroll: true },
    { id: "sections", title: "Hide or move a section", body: "The Sections list shows every part of the home page. Hide one, bring it back, or move it up and down. This works on a phone too.", anchors: ['[data-tour="panel-sections"]', '[data-panel-id="sections"]', '[data-panel="sections"]'] },
    { id: "save", title: "Your changes are kept as a draft", body: "Press Save draft to keep your work safely on the side. The live website stays exactly as it is until an approver publishes.", anchors: ['[data-tour="save"]', '[data-tour="panel-changes"]', '[data-panel-id="changes"]', '[data-panel="changes"]'] },
    { id: "history", title: "History: see what changed, and undo it", body: "Every change that has gone live is listed with who made it. If something is wrong, press Restore to prepare an undo.", anchors: ['[data-tour="panel-history"]', '[data-panel-id="history"]', '[data-panel="history"]'] },
    { id: "palette", title: "Press Ctrl/Cmd + K any time", body: "Type what you want to do, for example \"hide partners\" or \"change the logo\", and press Enter. You can also open Help with the ? key.", anchors: ['[data-tour="palette"]', '[data-tour="pill"]'] },
  ];

  var KEY_PREFIX = "covered.studio.v1.tour.";
  function storageKey(userId) { return KEY_PREFIX + String(userId || "anon").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64); }

  // first matching anchor that is currently visible; `find(sel)` returns an element (with getBoundingClientRect) or null.
  function resolveAnchor(step, find) {
    for (var i = 0; i < (step.anchors || []).length; i++) {
      var node = null;
      try { node = find(step.anchors[i]); } catch (e) { node = null; }
      if (node) {
        var r = node.getBoundingClientRect();
        if (r && r.width > 0 && r.height > 0) return { node: node, rect: r };
      }
    }
    return null;
  }

  // Card placement: below the target when it fits, else above, else centred. Always inside the viewport.
  function placeCard(rect, card, vp, margin) {
    var m = margin == null ? 12 : margin;
    var w = Math.min(card.w, vp.w - 2 * m);
    var clampX = function (x) { return Math.max(m, Math.min(x, vp.w - w - m)); };
    if (!rect) return { placement: "center", left: Math.max(m, Math.round((vp.w - w) / 2)), top: Math.max(m, Math.round((vp.h - card.h) / 2)), width: w };
    var below = rect.bottom + m;
    if (below + card.h <= vp.h - m) return { placement: "below", left: clampX(rect.left), top: Math.round(below), width: w };
    var above = rect.top - m - card.h;
    if (above >= m) return { placement: "above", left: clampX(rect.left), top: Math.round(above), width: w };
    return { placement: "center", left: Math.max(m, Math.round((vp.w - w) / 2)), top: Math.max(m, Math.round((vp.h - card.h) / 2)), width: w };
  }

  function nextIndex(i, dir, n) { return Math.max(0, Math.min(n - 1, i + dir)); }
  function progressText(i, n, title) { return "Step " + (i + 1) + " of " + n + ": " + title; }

  var api = { STEPS: STEPS, storageKey: storageKey, resolveAnchor: resolveAnchor, placeCard: placeCard, nextIndex: nextIndex, progressText: progressText };
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (!S) return;
  S.ext = S.ext || {};

  S.ready(function (studio) {
    var ui = studio.ui;
    var session = { seen: false };
    var active = null;

    function el(tag, props) {
      var kids = [];
      for (var i = 2; i < arguments.length; i++) {
        var k = arguments[i];
        if (Array.isArray(k)) kids.push.apply(kids, k.filter(function (x) { return x != null && x !== false; }));
        else if (k != null && k !== false) kids.push(k);
      }
      return ui.h.apply(ui, [tag, props || null].concat(kids));
    }

    // the tour lives inside the overlay's own shadow root (ext.css is part of the styles injected into it)
    function root() { return ui.root; }

    function find(sel) {
      var r = ui.root && ui.root.querySelector ? ui.root.querySelector(sel) : null;
      return r || document.querySelector(sel);
    }

    function getUserId() { return studio.me && studio.me.user ? studio.me.user.id : "anon"; }
    function seen() {
      if (session.seen) return true;
      return S.util.local.get(storageKey(getUserId())) === "done";
    }
    function markSeen() {
      session.seen = true;
      S.util.local.set(storageKey(getUserId()), "done"); // no storage: asked again next session
    }

    function reducedMotion() { try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) { return false; } }

    function stop(opts) {
      if (!active) return;
      var a = active;
      active = null;
      window.removeEventListener("resize", a.reflow);
      window.removeEventListener("scroll", a.reflow, true);
      document.removeEventListener("keydown", a.onKey, true);
      if (a.release) a.release();
      if (a.wrap.parentNode) a.wrap.parentNode.removeChild(a.wrap);
      if (!opts || opts.mark !== false) markSeen();
      try { if (a.returnTo && a.returnTo.focus) a.returnTo.focus(); } catch (e) { /* ignore */ }
      studio.emit("tour:end", {});
    }

    function start(opts) {
      if (active) return;
      var steps = STEPS;
      var i = 0;
      var returnTo = document.activeElement;
      var spot = el("div", { class: "csx-spot", "aria-hidden": "true" });
      var title = el("h3", { class: "csx-tour-title", id: "csx-tour-title", tabindex: "-1" });
      var body = el("p", { class: "csx-tour-body", id: "csx-tour-body" });
      var count = el("p", { class: "csx-tour-count" });
      var live = el("div", { class: "csx-visually-hidden", role: "status", "aria-live": "polite" });
      var back = el("button", { type: "button", class: "csx-btn csx-btn-quiet", on: { click: function () { go(-1); } } }, "Back");
      var next = el("button", { type: "button", class: "csx-btn", "data-tour-next": "1", on: { click: function () { go(1); } } }, "Next");
      var skip = el("button", { type: "button", class: "csx-link", "data-tour-skip": "1", on: { click: function () { stop(); } } }, "Skip tour");
      var card = el("div", { class: "csx-tour-card", role: "dialog", "aria-modal": "true", "aria-labelledby": "csx-tour-title", "aria-describedby": "csx-tour-body" },
        count, title, body, el("div", { class: "csx-tour-actions" }, skip, back, next));
      var wrap = el("div", { class: "csx-tour", "data-studio-ui": "" }, spot, card, live);
      root().appendChild(wrap);

      var a = (active = { wrap: wrap, returnTo: returnTo, release: null });

      function layout() {
        var step = steps[i];
        var hit = resolveAnchor(step, find);
        var vp = { w: window.innerWidth, h: window.innerHeight };
        if (hit) {
          var r = hit.rect;
          spot.style.display = "block";
          spot.style.top = Math.max(0, r.top - 6) + "px";
          spot.style.left = Math.max(0, r.left - 6) + "px";
          spot.style.width = r.width + 12 + "px";
          spot.style.height = r.height + 12 + "px";
        } else {
          spot.style.display = "none";
        }
        var pos = placeCard(hit ? hit.rect : null, { w: 340, h: card.offsetHeight || 190 }, vp, 12);
        card.setAttribute("data-placement", pos.placement);
        card.style.left = pos.left + "px";
        card.style.top = pos.top + "px";
        card.style.width = pos.width + "px";
      }
      var pending = false;
      a.reflow = function () {
        if (pending) return;
        pending = true;
        window.requestAnimationFrame(function () { pending = false; if (active === a) layout(); });
      };

      function show() {
        var step = steps[i];
        title.textContent = step.title;
        body.textContent = step.body;
        count.textContent = "Step " + (i + 1) + " of " + steps.length;
        back.disabled = i === 0;
        next.textContent = i === steps.length - 1 ? "Done" : "Next";
        live.textContent = progressText(i, steps.length, step.title);
        var hit = resolveAnchor(step, find);
        if (hit && step.scroll && hit.node.scrollIntoView) { try { hit.node.scrollIntoView({ block: "center", behavior: reducedMotion() ? "auto" : "smooth" }); } catch (e) { /* ignore */ } }
        layout();
        window.setTimeout(function () { if (active === a) layout(); }, reducedMotion() ? 0 : 350);
        next.focus();
      }

      function go(dir) {
        if (dir > 0 && i === steps.length - 1) { stop(); return; }
        i = nextIndex(i, dir, steps.length);
        show();
      }

      a.onKey = function (ev) {
        if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); stop(); }
        else if (ev.key === "ArrowRight") { ev.preventDefault(); go(1); }
        else if (ev.key === "ArrowLeft") { ev.preventDefault(); go(-1); }
        else if (ev.key === "Tab") {
          var items = [skip, back, next].filter(function (b) { return !b.disabled; });
          var cur = (root().activeElement) || document.activeElement;
          var idx = items.indexOf(cur);
          if (ev.shiftKey) { if (idx <= 0) { ev.preventDefault(); items[items.length - 1].focus(); } }
          else if (idx === items.length - 1 || idx === -1) { ev.preventDefault(); items[0].focus(); }
        }
      };
      document.addEventListener("keydown", a.onKey, true);
      window.addEventListener("resize", a.reflow);
      window.addEventListener("scroll", a.reflow, true);
      studio.emit("tour:start", {});
      show();
    }

    S.ext.tour = { start: function (o) { if (o && o.force) { session.seen = false; } start(o); }, stop: stop, isOpen: function () { return !!active; }, steps: STEPS };

    ui.registerCommand({ id: "tour.replay", title: "Replay the tour", keywords: ["tour", "onboarding", "welcome", "intro", "tutorial", "learn"], group: "Help", run: function () { S.ext.tour.start({ force: true }); } });

    // First run: once per user, a moment after sign-in, and never while a field is being edited.
    var armed = false;
    function maybeAuto() {
      if (armed || !studio.me || seen()) return;
      armed = true;
      window.setTimeout(function () { if (!seen() && !active) start(); }, 700);
    }
    maybeAuto();
    studio.on("auth:change", maybeAuto);
  });
})(window.__CoveredStudioBoot);
