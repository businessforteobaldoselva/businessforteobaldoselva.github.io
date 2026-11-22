(function (S) {
  "use strict";
  // Status board panel (studio/PHASE1-DESIGN.md section 5): what is live, what waits for approval, what was restored, my drafts.
  // Written against window.CoveredStudio only. Every server and editor string reaches the DOM through h() children (text nodes).
  // The pure part (the view model) is exported for node tests; the DOM part runs only inside S.ready.

  // ------------------------------------------------------------------ pure view model
  var MIN = 60 * 1000;
  var HOUR = 60 * MIN;
  var DAY = 24 * HOUR;

  function plural(n, one, many) { return n + " " + (n === 1 ? one : many); }

  function since(iso, nowMs) {
    var t = Date.parse(iso);
    if (isNaN(t)) return "";
    var d = Math.max(0, nowMs - t);
    if (d < MIN) return "just now";
    if (d < HOUR) return plural(Math.floor(d / MIN), "minute", "minutes") + " ago";
    if (d < DAY) return plural(Math.floor(d / HOUR), "hour", "hours") + " ago";
    return plural(Math.floor(d / DAY), "day", "days") + " ago";
  }

  function rowOf(it, nowMs) {
    var bits = [it.mine ? "You" : it.author && it.author.name || "Someone", since(it.updatedAt, nowMs)];
    if (typeof it.changeCount === "number") bits.push(plural(it.changeCount, "change", "changes"));
    return {
      id: it.id, title: it.title || "Untitled draft", step: it.step, stepLabel: it.stepLabel, meta: bits.filter(Boolean).join(" · "),
      canReview: !!it.canReview, reviewLink: it.reviewLink || null, url: it.url || null, mine: !!it.mine,
    };
  }

  // board = GET /v1/board. Returns { live, groups: [{ id, title, empty, rows }], note }.
  function buildBoardModel(board, opts) {
    var now = opts && opts.now != null ? opts.now : Date.now();
    var b = board || {};
    var waiting = (b.waiting || []).map(function (i) { return rowOf(i, now); });
    var inWaiting = {};
    waiting.forEach(function (r) { inWaiting[r.id] = true; });
    var live = null;
    if (b.live) {
      live = {
        title: b.live.title, url: b.live.url || null, settling: !!b.live.settling,
        text: "Published " + since(b.live.mergedAt, now) + (b.live.by && b.live.by.name ? " by " + b.live.by.name : "") + ".",
        settlingText: "Published. The site updates in a few minutes.",
      };
    }
    return {
      live: live,
      groups: [
        { id: "waiting", title: "Waiting for approval", empty: "Nothing is waiting for approval.", rows: waiting },
        { id: "mine", title: "My drafts", empty: "You have no open drafts.", rows: (b.mine || []).filter(function (i) { return !inWaiting[i.id]; }).map(function (i) { return rowOf(i, now); }) },
        { id: "restored", title: "Restored recently", empty: "Nothing has been restored lately.", rows: (b.restored || []).map(function (i) { return rowOf(i, now); }) },
      ],
      note: b.othersWaiting > 0 ? plural(b.othersWaiting, "other draft is", "other drafts are") + " waiting for an approver." : "",
    };
  }

  var api = { since: since, buildBoardModel: buildBoardModel };
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (!S) return;

  // ------------------------------------------------------------------ DOM part
  S.ext = S.ext || {};
  S.ext.status = api;

  S.ready(function (studio) {
    var ui = studio.ui;
    var latest = null; // the last board that arrived: the palette reads it, nothing in it is fetched at search time

    function el(tag, props) {
      var kids = [];
      for (var i = 2; i < arguments.length; i++) {
        var k = arguments[i];
        if (Array.isArray(k)) kids.push.apply(kids, k.filter(function (x) { return x != null && x !== false; }));
        else if (k != null && k !== false) kids.push(k);
      }
      return ui.h.apply(ui, [tag, props || null].concat(kids));
    }
    function openReview(id) { if (S.reviewScreen) S.reviewScreen.open(id); }
    function copy(text) {
      var done = function () { ui.toast("Link copied.", { kind: "success" }); };
      var fail = function () { ui.toast("Could not copy the link. Open the draft and copy it from there.", { kind: "error" }); };
      try { navigator.clipboard.writeText(text).then(done, fail); } catch (e) { fail(); }
    }

    function render(container) {
      var state = { loading: false, error: null, board: null };
      var alive = true;
      var timer = null;
      var live = el("div", { class: "csx-visually-hidden", role: "status", "aria-live": "polite" });
      var root = el("div", { class: "csx-rv csx-status" });
      container.appendChild(root);
      container.appendChild(live);

      function load() {
        if (state.loading) return Promise.resolve();
        state.loading = true;
        state.error = null;
        paint();
        return studio.api.get("/v1/board").then(function (b) {
          state.board = b;
          latest = b;
        }, function (e) {
          state.error = (e && e.userMessage) || "The status board could not be loaded.";
        }).then(function () {
          state.loading = false;
          if (!alive) return;
          paint();
          live.textContent = state.error ? "The status board could not be loaded." : "Status updated.";
        });
      }

      function rowEl(r) {
        var tid = "csx-st-" + r.id;
        return el("div", { class: "csx-row", role: "group", "aria-labelledby": tid, "data-draft": r.id },
          el("h4", { class: "csx-row-title", id: tid }, r.title, el("span", { class: "csx-badge", "data-step": r.step }, r.stepLabel)),
          el("p", { class: "csx-meta" }, r.meta),
          el("div", { class: "csx-actions" },
            r.canReview ? el("button", { type: "button", class: "csx-btn", "aria-label": "Review: " + r.title, on: { click: function () { openReview(r.id); } } }, "Review") : null,
            r.reviewLink ? el("button", { type: "button", class: "csx-btn csx-btn-quiet", "aria-label": "Copy the review link for " + r.title, on: { click: function () { copy(r.reviewLink); } } }, "Copy link") : null,
            r.url ? el("a", { href: r.url, target: "_blank", rel: "noopener noreferrer", class: "csx-link" }, "View on GitHub") : null));
      }

      function paint() {
        if (!alive) return;
        var vm = buildBoardModel(state.board, { now: Date.now() });
        var kids = [el("div", { class: "csx-head" },
          el("p", { class: "csx-intro" }, "Where every change is, in one place."),
          el("button", { type: "button", class: "csx-btn csx-btn-quiet", disabled: state.loading, on: { click: function () { load(); } } }, state.loading ? "Loading…" : "Refresh"))];
        if (state.error) kids.push(el("div", { class: "csx-error", role: "alert" }, el("p", null, state.error), el("button", { type: "button", class: "csx-btn", on: { click: function () { load(); } } }, "Try again")));
        else if (!state.board) kids.push(el("p", { class: "csx-muted", role: "status" }, "Loading…"));
        else {
          kids.push(el("section", { "aria-label": "Live now" },
            el("h3", { class: "csx-day-title" }, "Live now"),
            vm.live ? el("div", { class: "csx-row" },
              el("p", { class: "csx-row-title" }, vm.live.title),
              el("p", { class: "csx-meta" }, vm.live.settling ? vm.live.settlingText : vm.live.text),
              vm.live.url ? el("a", { href: vm.live.url, target: "_blank", rel: "noopener noreferrer", class: "csx-link" }, "View on GitHub") : null)
              : el("p", { class: "csx-muted" }, "Nothing has been published through Studio yet.")));
          vm.groups.forEach(function (g) {
            kids.push(el("section", { "aria-label": g.title, "data-group": g.id },
              el("h3", { class: "csx-day-title" }, g.title),
              g.rows.length ? g.rows.map(rowEl) : el("p", { class: "csx-muted" }, g.empty)));
          });
          if (vm.note) kids.push(el("p", { class: "csx-muted", "data-note": "others" }, vm.note));
        }
        while (root.firstChild) root.removeChild(root.firstChild);
        kids.forEach(function (k) { root.appendChild(k); });
      }

      paint();
      load();
      timer = setInterval(function () { load(); }, 60000);
      return { refresh: load, destroy: function () { alive = false; clearInterval(timer); if (live.parentNode) live.parentNode.removeChild(live); if (root.parentNode) root.parentNode.removeChild(root); } };
    }

    var instance = null;
    ui.registerPanel({
      id: "status",
      title: "Status",
      glyph: "◉",
      order: 8,
      render: function (container) {
        instance = render(container);
        return function () { if (instance) instance.destroy(); instance = null; };
      },
    });

    ui.registerCommand({
      id: "status.open", title: "Open Status", keywords: ["status", "board", "waiting", "approval", "live", "drafts"], group: "Go",
      run: function () { ui.openPanel("status"); },
    });

    // Ctrl/Cmd+K: "Waiting for approval: <title>" jumps to the review screen. Sync and cheap: reads the last board only.
    ui.registerPaletteSource({
      id: "status.waiting",
      search: function (query) {
        if (!latest) return [];
        var words = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
        return (latest.waiting || []).filter(function (i) {
          var hay = ("waiting for approval review " + String(i.title)).toLowerCase();
          return i.canReview && words.every(function (w) { return hay.indexOf(w) >= 0; });
        }).slice(0, 5).map(function (i) { return { id: "status.waiting." + i.id, title: "Waiting for approval: " + i.title, hint: "Open the review screen", group: "Review", run: function () { openReview(i.id); } }; });
      },
    });

    // a person who can approve gets the board once after signing in, so the palette knows what waits
    studio.on("auth:change", function (d) {
      if (d && d.me && d.me.capabilities && d.me.capabilities.publish) studio.api.get("/v1/board").then(function (b) { latest = b; }, function () { /* the panel shows errors; the palette just stays empty */ });
      else if (!d || !d.me) latest = null;
    });
  });
})(window.__CoveredStudioBoot);
