(function (S) {
  "use strict";
  // The approver's review screen and the "Send for review" dialog (studio/PHASE1-DESIGN.md sections 6 and 7).
  //   * Review panel: the plain-English list of what will change, what to look at carefully, the safety checks, and ONE button,
  //     "Approve and publish", which calls the existing publish route with the head the person saw. Nothing else publishes.
  //   * Send dialog: choose who should look, then who was told; without a GitHub notification a ready-to-paste message,
  //     "Copy link" and "Email it" (a mailto: with no recipient: the person types it).
  //   * #review=<draftId> opens the screen once the person is signed in.
  // Written against window.CoveredStudio only. Server and editor text reaches the DOM through h() children (text nodes).
  // The pure part is exported for node tests; the DOM part runs only inside S.ready.

  // ------------------------------------------------------------------ pure part
  var ATTENTION = { link: "A link changes", image: "A picture changes", hidden: "Something is switched off", legal: "Contact or legal wording changes" };
  var CHECKS = { success: "All the safety checks passed.", pending: "The safety checks are still running.", failure: "A safety check failed.", none: "The safety checks have not started yet." };

  function plural(n, one, many) { return n + " " + (n === 1 ? one : many); }

  function row(it) {
    return {
      id: it.id, line: it.line, where: it.where, label: it.label, op: it.op, kind: it.kind, attention: it.attention,
      attentionText: ATTENTION[it.attention] || "",
      before: it.before ? it.before.text : null, beforeImage: it.before ? it.before.image : null, beforeCut: !!(it.before && it.before.truncated),
      after: it.after ? it.after.text : null, afterImage: it.after ? it.after.image : null, afterCut: !!(it.after && it.after.truncated),
      beforeNote: it.op === "add" ? "Not there before" : "", afterNote: it.op === "remove" ? "Taken away" : it.op === "move" ? "Same text, new position" : "",
    };
  }

  // review = GET /v1/drafts/:id/review. opts = { canPublish (the person's role may), since(iso) -> "5 minutes ago" }
  function buildReviewModel(review, opts) {
    var o = opts || {};
    var d = review.draft || {};
    var items = (review.items || []).map(row);
    var gates = review.gates || { checks: "none", canPublish: false, blockers: [] };
    var careful = items.filter(function (r) { return r.attention !== "none"; });
    var rest = items.filter(function (r) { return r.attention === "none"; });
    var bits = [d.author && d.author.name ? "By " + (d.isMine ? "you" : d.author.name) : "", o.since && d.updatedAt ? o.since(d.updatedAt) : ""].filter(Boolean);
    return {
      title: d.title || "Draft", byline: bits.join(" · "), summary: review.summary || "", headSha: review.headSha, published: d.state === "merged",
      checksText: CHECKS[gates.checks] || "", blockers: (gates.blockers || []).map(function (b) { return b.message; }),
      careful: careful, rest: rest, hasChanges: items.length > 0,
      canApprove: !!o.canPublish && gates.canPublish === true && d.state !== "merged",
      sideBySide: review.sideBySide ? { liveUrl: review.sideBySide.productionUrl, draftUrl: review.sideBySide.draftUrl } : null,
      url: d.url || null,
    };
  }

  // The message for someone who is not told by GitHub. Plain words, the title and one line about size, then the link.
  function buildShareText(o) {
    var n = o.count;
    return [
      "Hello" + (o.reviewerName ? " " + o.reviewerName : "") + ",",
      "",
      "I have changed the website and need someone to look it over before it goes live.",
      "",
      "Draft: " + o.title,
      typeof n === "number" ? plural(n, "change", "changes") : "",
      "",
      o.link ? "Please open this link, check the changes and press \"Approve and publish\":\n" + o.link : "Please open Studio, choose Status, then Review, check the changes and press \"Approve and publish\".",
    ].filter(function (l, i, a) { return !(l === "" && a[i - 1] === ""); }).join("\n");
  }

  function mailtoFor(title, body) { return "mailto:?subject=" + encodeURIComponent("Please review a website change: " + title) + "&body=" + encodeURIComponent(body); }

  var api = { buildReviewModel: buildReviewModel, buildShareText: buildShareText, mailtoFor: mailtoFor };
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (!S) return;

  // ------------------------------------------------------------------ DOM part
  S.ext = S.ext || {};
  S.ext.review = api;

  S.ready(function (studio) {
    var ui = studio.ui;
    var pendingId = null;
    var instance = null;

    function el(tag, props) {
      var kids = [];
      for (var i = 2; i < arguments.length; i++) {
        var k = arguments[i];
        if (Array.isArray(k)) kids.push.apply(kids, k.filter(function (x) { return x != null && x !== false; }));
        else if (k != null && k !== false) kids.push(k);
      }
      return ui.h.apply(ui, [tag, props || null].concat(kids));
    }
    function since(iso) { return S.ext.status ? S.ext.status.since(iso, Date.now()) : ""; }
    function canPublish() { var me = studio.me; return !!(me && me.capabilities && me.capabilities.publish); }

    // ---------------------------------------------------------------- the review panel
    function render(container) {
      var state = { id: pendingId, data: null, loading: false, error: null, approving: false, notice: "" };
      var alive = true;
      var title = el("h3", { class: "csx-rv-title", tabindex: "-1" }, "Review changes");
      var summary = el("p", { class: "csx-rv-summary", role: "status", "aria-live": "polite" });
      var root = el("div", { class: "csx-rv csx-review" });
      container.appendChild(root);

      function load(id) {
        if (id) state.id = id;
        if (!state.id || state.loading) { paint(); return Promise.resolve(); }
        state.loading = true;
        state.error = null;
        paint();
        return studio.api.get("/v1/drafts/" + encodeURIComponent(state.id) + "/review").then(function (r) {
          state.data = r;
        }, function (e) {
          state.data = null;
          state.error = e && e.code === "not_found" ? "That draft could not be found. It may have been published, discarded or belong to someone else." : (e && e.userMessage) || "The review screen could not be loaded.";
        }).then(function () {
          state.loading = false;
          if (!alive) return;
          paint();
          title.focus();
        });
      }

      function approve() {
        if (!state.data) return;
        ui.confirm({ title: "Publish to the live site?", body: "These changes go live as soon as the site rebuilds. Anyone can undo them later from History.", confirmLabel: "Approve and publish" }).then(function (yes) {
          if (!yes || !alive) return;
          state.approving = true;
          paint();
          studio.api.post("/v1/drafts/" + encodeURIComponent(state.id) + "/publish", { idempotencyKey: studio.util.uuid(), expectedHeadSha: state.data.headSha }).then(function () {
            state.approving = false;
            state.notice = "Published. The site updates in a few minutes.";
            ui.toast(state.notice, { kind: "success" });
            return load();
          }, function (e) {
            state.approving = false;
            if (e && (e.code === "not_ready" || e.code === "draft_moved")) {
              state.notice = "This draft changed while you were looking, or its checks changed. The list below is up to date: check it and approve again.";
              return load();
            }
            ui.toast((e && e.userMessage) || "Could not publish.", { kind: "error" });
            paint();
          });
        });
      }

      function value(label, text, image, note, cut) {
        return el("div", { class: "csx-rv-box" },
          el("strong", null, label),
          text !== null ? el("p", { class: "csx-rv-text" }, text === "" ? "(empty)" : text + (cut ? " … (cut short)" : "")) : el("p", { class: "csx-muted" }, note || "(nothing)"),
          image ? el("p", { class: "csx-muted" }, "Picture: " + image) : null);
      }
      function itemEl(r) {
        return el("li", { class: "csx-rv-item", "data-item": r.id },
          el("p", { class: "csx-rv-line" }, r.line, r.attentionText ? el("span", { class: "csx-badge", "data-attention": r.attention }, r.attentionText) : null),
          el("div", { class: "csx-rv-cmp" }, value("Live now", r.before, r.beforeImage, r.beforeNote, r.beforeCut), value("In this draft", r.after, r.afterImage, r.afterNote, r.afterCut)));
      }

      function paint() {
        if (!alive) return;
        var kids = [title, summary];
        if (!state.id) {
          kids.push(el("p", { class: "csx-muted" }, "Open a draft from the Status panel to see what it will change."));
          kids.push(el("button", { type: "button", class: "csx-btn", on: { click: function () { ui.openPanel("status"); } } }, "Go to Status"));
        } else if (state.error) {
          summary.textContent = "";
          kids.push(el("div", { class: "csx-error", role: "alert" }, el("p", null, state.error), el("button", { type: "button", class: "csx-btn", on: { click: function () { load(); } } }, "Try again")));
        } else if (!state.data) {
          kids.push(el("p", { class: "csx-muted", role: "status" }, "Loading…"));
        } else {
          var vm = buildReviewModel(state.data, { canPublish: canPublish(), since: since });
          title.textContent = vm.title;
          summary.textContent = vm.summary;
          if (vm.byline) kids.push(el("p", { class: "csx-meta" }, vm.byline));
          if (state.notice) kids.push(el("div", { class: "csx-result", role: "status", "data-notice": "1" }, state.notice));
          if (vm.published) kids.push(el("p", { class: "csx-result" }, "This draft has been published."));
          if (vm.sideBySide) kids.push(el("p", null, el("a", { href: vm.sideBySide.liveUrl, target: "_blank", rel: "noopener noreferrer", class: "csx-link" }, "See the live page"), " · ", el("a", { href: vm.sideBySide.draftUrl, target: "_blank", rel: "noopener noreferrer", class: "csx-link" }, "See this draft")));
          else kids.push(el("p", { class: "csx-muted" }, "A picture of the draft is not available yet. Read the list of changes below."));
          if (vm.careful.length) kids.push(el("section", { "aria-label": "Look at these carefully" }, el("h3", { class: "csx-day-title" }, "Look at these carefully"), el("ul", { class: "csx-rv-list" }, vm.careful.map(itemEl))));
          if (vm.rest.length) kids.push(el("section", { "aria-label": vm.careful.length ? "Other changes" : "Changes" }, el("h3", { class: "csx-day-title" }, vm.careful.length ? "Other changes" : "Changes"), el("ul", { class: "csx-rv-list" }, vm.rest.map(itemEl))));
          if (!vm.hasChanges) kids.push(el("p", { class: "csx-muted" }, "This draft does not change any website content."));
          kids.push(el("p", { class: "csx-rv-checks", "data-checks": state.data.gates.checks }, vm.checksText));
          if (vm.blockers.length) kids.push(el("ul", { class: "csx-rv-blockers", role: "status" }, vm.blockers.map(function (b) { return el("li", null, b); })));
          kids.push(el("div", { class: "csx-actions" },
            canPublish() && !vm.published ? el("button", { type: "button", class: "csx-btn", "data-approve": "1", disabled: !vm.canApprove || state.approving, on: { click: approve } }, state.approving ? "Publishing…" : "Approve and publish") : null,
            el("button", { type: "button", class: "csx-btn csx-btn-quiet", disabled: state.loading, on: { click: function () { state.notice = ""; load(); } } }, "Refresh"),
            vm.url ? el("a", { href: vm.url, target: "_blank", rel: "noopener noreferrer", class: "csx-link" }, "View on GitHub") : null));
          if (!canPublish()) kids.push(el("p", { class: "csx-muted" }, "An approver will look at this before it goes live."));
        }
        while (root.firstChild) root.removeChild(root.firstChild);
        kids.forEach(function (k) { root.appendChild(k); });
      }

      paint();
      if (state.id) load();
      return {
        load: load,
        destroy: function () { alive = false; if (root.parentNode) root.parentNode.removeChild(root); },
      };
    }

    ui.registerPanel({
      id: "review",
      title: "Review",
      glyph: "✔",
      order: 9,
      noDock: true, // opened from Status or a review link; keeps the phone dock on one row
      render: function (container) {
        instance = render(container);
        return function () { if (instance) instance.destroy(); instance = null; };
      },
    });

    // open the review screen for a draft, whether or not the panel is already showing
    S.reviewScreen = {
      open: function (id) {
        pendingId = String(id || "");
        if (instance) instance.load(pendingId); else ui.openPanel("review");
      },
    };

    // ---------------------------------------------------------------- the "Send for review" dialog
    function cancelled() { return Object.assign(new Error("Not sent for review."), { code: "cancelled", userMessage: "Not sent for review." }); }

    S.reviewDialog = {
      open: function (o) {
        var draft = o.draft;
        return new Promise(function (resolve, reject) {
          var sent = null;
          var dlg = null;
          var approvers = null;
          var choice = "";

          function finish() { if (sent) resolve(sent); else reject(cancelled()); }

          // a fresh wrapper (it carries the colour variables of review.css) for each step of the dialog
          function reset(body, foot) {
            while (body.firstChild) body.removeChild(body.firstChild);
            while (foot.firstChild) foot.removeChild(foot.firstChild);
            var box = el("div", { class: "csx-rv" });
            body.appendChild(box);
            return box;
          }

          function choose(body0, foot) {
            var body = reset(body0, foot);
            var list = approvers || [];
            if (list.length === 1 && choice === "") choice = list[0].id;
            body.appendChild(el("p", null, "Your changes are saved as a draft. Choose who should look at them before they go live."));
            var err = el("p", { class: "csx-error", role: "alert", hidden: true });
            if (list.length) {
              var group = el("div", { role: "radiogroup", "aria-label": "Who should review this?", class: "csx-rv-radios" });
              list.concat([{ id: "", displayName: "", none: true }]).forEach(function (a, i) {
                var rid = "csx-rv-r" + i;
                var input = el("input", { type: "radio", name: "csx-reviewer", id: rid, value: a.id, checked: choice === a.id, on: { change: function () { choice = a.id; } } });
                group.appendChild(el("label", { class: "csx-rv-radio", for: rid }, input,
                  el("span", null, a.none ? "No one in particular: I will share the link myself" : a.displayName + (a.notify === "github" ? " – we will notify them on GitHub" : " – not set up for GitHub notifications; you will get a message to send"))));
              });
              body.appendChild(group);
            } else body.appendChild(el("p", { class: "csx-muted" }, "No approvers are listed yet, so no one can be notified. After sending you can copy the link and pass it on."));
            body.appendChild(err);
            var send = el("button", { type: "button", class: "btn btn-primary", on: { click: function () {
              send.disabled = true;
              send.textContent = "Sending…";
              studio.drafts.submitRaw({ reviewerId: choice || null }).then(function (res) { sent = res; done(body, foot, res); }, function (e) {
                send.disabled = false;
                send.textContent = "Send for review";
                err.hidden = false;
                err.textContent = (e && e.userMessage) || "Could not send it for review.";
              });
            } } }, "Send for review");
            foot.appendChild(el("button", { type: "button", class: "btn", on: { click: function () { dlg.close(null); } } }, "Cancel"));
            foot.appendChild(send);
          }

          function done(body0, foot, res) {
            var body = reset(body0, foot);
            var msg = el("p", { class: "csx-rv-sent", role: "status", tabindex: "-1" }, res.message || "Sent for review.");
            body.appendChild(msg);
            var link = res.reviewLink || null;
            var text = buildShareText({ title: draft.title || "Draft", count: o.changes && o.changes.length ? o.changes.length : null, link: link, reviewerName: res.notified && res.notified.reviewer ? res.notified.reviewer.displayName : "" });
            var area = null;
            var say = el("p", { class: "csx-muted", role: "status", "aria-live": "polite" });
            if (res.notified && res.notified.via === "none") {
              area = el("textarea", { class: "csx-rv-share", rows: 8, readonly: true, "aria-label": "Message to send to the approver" });
              area.value = text;
              body.appendChild(area);
            }
            body.appendChild(say);
            function copy(what) {
              try {
                navigator.clipboard.writeText(what).then(function () { say.textContent = "Copied."; }, fallback);
              } catch (e) { fallback(); }
            }
            function fallback() {
              if (area) { area.focus(); area.select(); }
              say.textContent = "Could not copy automatically. Select the text and press Ctrl+C.";
            }
            if (link) foot.appendChild(el("button", { type: "button", class: "btn", on: { click: function () { copy(link); } } }, "Copy link"));
            if (area) foot.appendChild(el("a", { class: "btn", href: mailtoFor(draft.title || "Draft", text) }, "Email it"));
            foot.appendChild(el("button", { type: "button", class: "btn btn-primary", on: { click: function () { dlg.close(true); } } }, "Done"));
            msg.focus();
            studio.emit("review:sent", { draft: res.draft });
          }

          dlg = ui.dialog({
            title: "Send for review",
            onClose: function () { finish(); },
            build: function (body, foot) {
              body.appendChild(el("p", { class: "csx-muted", role: "status" }, "Loading…"));
              studio.api.get("/v1/people/approvers").then(function (r) { approvers = (r && r.approvers) || []; }, function () { approvers = []; }).then(function () { choose(body, foot); var f = body.querySelector("input,button"); if (f) f.focus(); });
            },
          });
        });
      },
    };

    // ---------------------------------------------------------------- deep link: #review=<draftId>
    var m = /[#&]review=([a-z0-9-]{1,80})(?:&|$)/.exec(String(location.hash || ""));
    var link = m ? m[1] : null;
    function tryLink() {
      if (!link) return;
      if (!studio.me) { ui.openPanel("account"); return; }
      var id = link;
      link = null;
      S.reviewScreen.open(id);
    }
    if (link) {
      studio.on("auth:change", function (d) { if (d && d.me) tryLink(); });
      if (studio.me) tryLink();
    }
  });
})(window.__CoveredStudioBoot);
