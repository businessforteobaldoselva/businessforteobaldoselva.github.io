(function (S) {
  "use strict";
  // "Describe a change" panel (studio/AI-DESIGN.md 14). Browser only; logic lives in ext/ai-view.js (pure, tested). Written
  // against window.CoveredStudio only: server calls go through studio.api, server and model text reaches the page only as
  // text nodes (h() children), and a suggestion is a PROPOSAL until saved as a draft through the normal server pipeline.
  S.ready(function (studio) {
    var V = S.ext && S.ext.aiView;
    if (!V) return;
    var ui = studio.ui;
    var C = V.COPY;
    var inst = null;

    function el(tag, props) {
      var kids = [];
      for (var i = 2; i < arguments.length; i++) {
        var k = arguments[i];
        if (Array.isArray(k)) kids.push.apply(kids, k.filter(function (x) { return x != null && x !== false; }));
        else if (k != null && k !== false) kids.push(k);
      }
      return ui.h.apply(ui, [tag, props || null].concat(kids));
    }
    function uuid() { return studio.util.uuid(); }
    function isEditor() { return !!studio.me; }

    // the host may lack a part (older build, other panel): ask, and fall back instead of failing
    function safe(fn, fallback) { try { var r = fn(); return r == null ? fallback : r; } catch (e) { return fallback; } }
    function labelOf(ref) { return V.oneLine(safe(function () { return studio.schema.label(ref); }, ref), 80); }
    function selectedRef() { return safe(function () { var m = studio.inspect.selected(); return m && m.ref; }, null); }
    function currentPage() { return safe(function () { return V.pageKey(window.location.pathname, Object.keys(studio.content.files() || {})); }, null); }
    function currentDraftId() { return safe(function () { var d = studio.drafts.current(); return d && d.id && d.state !== "merged" && d.state !== "closed" ? d.id : null; }, null); }
    function markerFor(ref) { return ref ? safe(function () { return studio.inspect.markerForRef(ref); }, null) : null; }
    // only an absolute http(s) address without a password becomes a link; anything else is not shown as one
    function httpUrl(url) {
      try {
        var x = new URL(url);
        return (x.protocol === "https:" || x.protocol === "http:") && !x.username && !x.password ? x.href : null;
      } catch (e) { return null; }
    }
    function previewLink(url) {
      var u = httpUrl(url);
      if (!u) return null;
      return u.indexOf("?") >= 0 ? u + "&studio=1" : u.replace(/\/+$/, "") + "/?studio=1";
    }

    function render(container) {
      var first = inst && inst.pendingMode ? inst.pendingMode : null;
      var sel = selectedRef();
      var state = V.initialState({ signedIn: isEditor(), refs: sel ? [sel] : [] });
      if (first && V.MODES.indexOf(first) >= 0) state.mode = first;
      var alive = true;
      var reqSeq = 0;
      var tick = null;
      var startedAt = 0;
      var focusNext = false;
      var showRetry = false;
      var root = el("div", { class: "csx-ai" });
      var live = el("div", { class: "csx-visually-hidden", role: "status", "aria-live": "polite" });
      container.appendChild(root);
      container.appendChild(live);

      function say(msg) {
        live.textContent = "";
        setTimeout(function () { if (alive) live.textContent = V.clean(msg, 400); }, 30);
      }
      function leave(label, act, o) { return btn(label, function () { focusNext = true; dispatch(act); }, o || { quiet: true }); }
      function refocus() { var t = root.querySelector("#csx-ai-instr"); if (t) t.focus(); }
      function stopTimers() { clearInterval(tick); tick = null; }
      function dispatch(a, quiet) {
        state = V.reduce(state, a);
        if (!quiet) paint();
      }

      // calls
      function loadStatus() {
        dispatch({ type: "statusLoading" });
        return studio.api.get("/v1/ai/status").then(function (st) {
          if (!alive) return;
          dispatch({ type: "status", status: st && typeof st === "object" ? st : { enabled: false, reason: "disabled" } });
        }, function (e) {
          if (!alive) return;
          if (e && e.code === "unauthorized") dispatch({ type: "auth", signedIn: false });
          else dispatch({ type: "statusFail" });
        });
      }

      function propose(extra) {
        extra = extra || {};
        var key = extra.reuseKey && state.key ? state.key : uuid();
        dispatch({ type: "submit", key: key, retryOf: extra.retryOf || null, feedback: extra.feedback, instruction: extra.instruction }, true);
        if (state.phase !== "working") { paint(); return; }
        showRetry = false;
        startedAt = Date.now();
        focusNext = true;
        paint();
        var body = V.buildProposeBody(state, key, { page: currentPage(), draftId: currentDraftId() });
        var seq = ++reqSeq;
        say(C.working0);
        tick = setInterval(function () {
          var msg = V.workingMessage(Math.round((Date.now() - startedAt) / 1000));
          var node = root.querySelector("[data-working-line]");
          if (alive && state.phase === "working" && node && node.textContent !== msg) { node.textContent = msg; say(msg); }
        }, 1000);
        // the answer of a request that was cancelled or whose panel was closed is ignored
        function answer(a) { if (!alive || seq !== reqSeq) return false; stopTimers(); focusNext = true; dispatch(a); return true; }
        studio.api.post("/v1/ai/propose", body).then(function (res) {
          if (answer({ type: "result", proposal: res && res.proposal })) announceResult();
        }, function (err) {
          if (answer({ type: "fail", error: err })) say(state.error ? state.error.message : V.offCopy(V.offReasonOf(state)));
        });
      }
      function cancel() {
        reqSeq += 1;
        stopTimers();
        focusNext = true;
        dispatch({ type: "cancel" });
        say(C.cancelled);
      }
      function announceResult() {
        var v = state.view;
        var n = v && v.changes.length;
        say(!v ? "" : v.kind === "needs_code" ? C.needsCodeTitle : v.kind === "clarify" ? C.clarifyTitle + ": " + (v.question || "") : v.kind === "tone" && !v.findings.length ? C.toneNone : n ? n + (n === 1 ? " change" : " changes") + " suggested. Review them below before saving." : C.empty);
      }

      function save() {
        if (state.phase !== "result") return;
        var key = uuid();
        dispatch({ type: "save", key: key }, true);
        if (state.phase !== "saving") return;
        focusNext = false;
        paint();
        say("Saving…");
        var body = V.buildAcceptBody(state, key);
        studio.api.post("/v1/ai/accept", body).then(function (res) {
          if (!alive) return;
          focusNext = true;
          var d = res && res.draft;
          safe(function () { if (d) studio.drafts.setCurrent(d); studio.drafts.refresh().catch(function () { /* shown in Changes */ }); });
          dispatch({ type: "saved", saved: { draft: d || null, accepted: res && res.ai ? res.ai.accepted : body.accept.length, total: res && res.ai ? res.ai.total : state.view.changes.length } });
          ui.toast(C.savedToast, { kind: "success" });
          say(C.savedTitle + ". " + C.savedLine);
        }, function (err) {
          if (!alive) return;
          focusNext = true;
          dispatch({ type: "fail", error: err });
          say(state.error ? state.error.message : C.generic);
        });
      }

      // small parts
      function heading(text, level) {
        return el(level || "h3", { class: "csx-ai-h", tabindex: "-1", "data-focus": "1" }, text);
      }
      function para(text, cls) { return el("p", { class: cls || "csx-ai-p" }, text); }
      function btn(label, onClick, o) {
        o = o || {};
        return el("button", { type: "button", class: "csx-btn" + (o.quiet ? " csx-btn-quiet" : "") + (o.big ? " csx-ai-big" : ""), disabled: !!o.disabled, "aria-label": o.aria, "data-act": o.act, on: { click: onClick } }, label);
      }
      function badge(text, cls) { return el("span", { class: "csx-badge csx-ai-badge " + (cls || "") }, text); }
      function errorBlock(info) {
        if (!info) return null;
        return el("div", { class: "csx-error csx-ai-error", role: "alert", "data-error": info.code },
          el("p", null, info.message),
          info.requestId ? el("p", { class: "csx-muted csx-ai-ref" }, "Reference: " + info.requestId) : null);
      }

      // rendered values
      function sideBody(plan, runs, note, after, delta) {
        if (!plan) return el("p", { class: "csx-muted csx-ai-text" }, note || C.notShown);
        if (runs && plan.type === "text") {
          return el("p", { class: "csx-ai-text" }, runs.map(function (r) {
            if (r.t === "same") return el("span", null, r.s);
            return el("span", { class: r.t === "ins" ? "csx-ai-ins" : "csx-ai-del" }, el("span", { class: "csx-visually-hidden" }, r.sr), r.s);
          }));
        }
        switch (plan.type) {
          case "text":
            return el("div", null,
              plan.text ? el("p", { class: "csx-ai-text" }, plan.text) : el("p", { class: "csx-muted csx-ai-text" }, C.emptyValue),
              plan.truncated ? el("p", { class: "csx-muted" }, "(shortened here)") : null,
              after && state.view && state.view.mode === "meta_description" && delta.kind !== "toggle" ? metaLine(plan.text) : null);
          case "fields":
            return el("ul", { class: "csx-ai-fields" }, plan.fields.map(function (f) {
              return el("li", null, el("strong", null, f.label ? f.label + ": " : ""), f.text);
            }));
          default:
            return el("p", { class: "csx-ai-text" + (plan.type === "link" ? " csx-ai-linktext" : "") }, plan.type === "color" ? el("strong", null, plan.text) : plan.text || "");
        }
      }
      function metaLine(text) {
        var g = V.metaGuidance((text || "").length);
        return el("p", { class: "csx-muted csx-ai-meta", "data-meta": g.ok ? "ok" : "check" }, g.text);
      }
      function deltaBlock(d, cid, idx) {
        var m = markerFor(d.ref);
        return el("div", { class: "csx-ai-delta", role: "group", "aria-label": d.label },
          el("h4", { class: "csx-ai-label" }, d.label),
          el("div", { class: "csx-ai-sides" },
            el("div", { class: "csx-ai-side csx-ai-before" }, el("h5", { class: "csx-ai-sidehead" }, "Before"), sideBody(d.before, d.beforeRuns, d.beforeNote, false, d)),
            el("div", { class: "csx-ai-side csx-ai-after" }, el("h5", { class: "csx-ai-sidehead" }, "After"), sideBody(d.after, d.afterRuns, d.afterNote, true, d))),
          m ? el("button", { type: "button", class: "csx-link csx-ai-show", "aria-label": "Show on the page: " + d.label, on: { click: function () { try { studio.inspect.select(m, { scroll: true }); } catch (e) { /* the element may be gone */ } } } }, "Show on the page") : null);
      }

      // change card
      function changeCard(c, o) {
        o = o || {};
        var view = state.view;
        var titleId = "csx-ai-t-" + c.id;
        var cbId = "csx-ai-cb-" + c.id;
        var probs = state.problems && state.problems.byChange[c.id];
        var needs = c.requires.map(function (r) { for (var i = 0; i < view.changes.length; i++) if (view.changes[i].id === r) return view.changes[i].title; return r; });
        var cb = el("input", { type: "checkbox", id: cbId, checked: !!state.checked[c.id], "data-change": c.id, "aria-describedby": titleId + "-help", on: { change: function (ev) { onToggle(c.id, ev.target.checked); } } });
        return el("div", { class: "csx-ai-card" + (probs ? " csx-ai-card-bad" : ""), role: "group", "aria-labelledby": titleId, "data-card": c.id, tabindex: probs ? "-1" : null, "data-invalid": probs ? "1" : null },
          el("div", { class: "csx-ai-cardhead" },
            el("label", { class: "csx-ai-check", for: cbId },
              cb, el("span", { class: "csx-ai-incl" }, o.useLabel || "Include"), " ",
              el("strong", { id: titleId }, c.title))),
          el("div", { class: "csx-ai-badges", id: titleId + "-help" },
            c.outsideAsk ? el("p", { class: "csx-ai-flag" }, badge(V.FLAGS.outsideAsk.badge, "csx-ai-warn"), " ", V.FLAGS.outsideAsk.help) : null,
            c.sensitive ? el("p", { class: "csx-ai-flag" }, badge(V.FLAGS.sensitive.badge, "csx-ai-warn"), " ", V.FLAGS.sensitive.help) : null,
            needs.length ? el("p", { class: "csx-muted csx-ai-needs" }, "Goes together with: ", needs.join(", ")) : null),
          c.deltas.map(function (d, i) { return deltaBlock(d, c.id, i); }),
          probs ? el("ul", { class: "csx-ai-probs", role: "alert" }, probs.map(function (t) { return el("li", null, t); })) : null);
      }

      // selection + footer sync (no repaint)
      function onToggle(id, on) {
        dispatch({ type: "toggle", id: id, on: on }, true);
        syncSelection();
        if (state.note) say(state.note);
      }
      function syncSelection() {
        if (!state.view) return;
        Array.prototype.forEach.call(root.querySelectorAll("input[data-change]"), function (cb) { cb.checked = !!state.checked[cb.getAttribute("data-change")]; });
        var n = V.selectedIds(state.view, state.checked).length;
        var total = state.view.changes.length;
        var count = root.querySelector("[data-count]");
        if (count) count.textContent = V.countText(n, total);
        var saveBtn = root.querySelector("[data-act='save']");
        if (saveBtn) { saveBtn.textContent = V.saveLabel(n); saveBtn.disabled = n === 0; }
        var note = root.querySelector("[data-also]");
        if (note) note.textContent = state.note || "";
      }

      function footer() {
        var v = state.view;
        var n = V.selectedIds(v, state.checked).length;
        var total = v.changes.length;
        var saving = state.phase === "saving";
        return el("div", { class: "csx-ai-foot" },
          el("p", { class: "csx-ai-count", role: "status", "aria-live": "polite", "data-count": "1" }, V.countText(n, total)),
          el("p", { class: "csx-muted csx-ai-also", "data-also": "1" }, state.note || ""),
          el("div", { class: "csx-ai-footbtns" },
            el("button", { type: "button", class: "csx-btn csx-ai-big", "data-act": "save", disabled: n === 0 || saving, on: { click: save } }, saving ? "Saving…" : V.saveLabel(n)),
            btn("Select all", function () { dispatch({ type: "selectAll" }, true); syncSelection(); say(V.countText(V.selectedIds(state.view, state.checked).length, total)); }, { quiet: true, disabled: saving }),
            btn("Select none", function () { dispatch({ type: "selectNone" }, true); syncSelection(); say(V.countText(0, total)); }, { quiet: true, disabled: saving }),
            btn("Discard", function () { focusNext = true; dispatch({ type: "discard" }); say("Discarded. Nothing was changed."); }, { quiet: true, disabled: saving })),
          para(C.safety, "csx-muted csx-ai-safety"),
          anotherTry());
      }
      function anotherTry() {
        if (!showRetry) return btn("Ask for another try", function () { showRetry = true; paint(); var f = root.querySelector("#csx-ai-fb"); if (f) f.focus(); }, { quiet: true, act: "retry-open" });
        var fb = el("textarea", { id: "csx-ai-fb", rows: "2", maxlength: String(V.LIMITS.feedback), spellcheck: "true", value: state.feedback, on: { input: function (ev) { dispatch({ type: "feedback", text: ev.target.value }, true); } } });
        return el("div", { class: "csx-ai-retry" },
          el("label", { for: "csx-ai-fb" }, "What should be different? (optional)"),
          fb,
          btn("Try again", function () { retry(state.feedback); }, { act: "retry-go" }));
      }
      function retry(feedback) {
        var id = state.proposal && state.proposal.id;
        propose({ retryOf: id, feedback: feedback || "" });
      }

      // screens
      function warningsBlock(v) {
        if (!v.warnings.length) return null;
        return v.warnings.map(function (w) {
          return el("div", { class: "csx-ai-note csx-ai-warnbox", role: "note" },
            el("p", null, w.message || "Look at this suggestion carefully."),
            w.refs.length ? el("p", { class: "csx-muted" }, "Where: ", w.refs.map(labelOf).join(", ")) : null);
        });
      }
      function skippedBlock(v) {
        if (!v.skipped.length) return null;
        return el("div", { class: "csx-ai-skipped", role: "group", "aria-label": C.leftOut },
          el("h4", { class: "csx-ai-label" }, C.leftOut),
          para(C.leftOutHelp, "csx-muted"),
          el("ul", null, v.skipped.map(function (s) { return el("li", null, el("strong", null, s.title), s.reason ? ": " + s.reason : ""); })));
      }

      function screenPatch(v) {
        return el("div", { class: "csx-ai-result", "data-kind": v.kind },
          heading(v.changes.length ? "Suggested changes" : C.empty),
          v.summary ? para(v.summary, "csx-ai-summary") : null,
          warningsBlock(v),
          state.error && state.phase === "result" ? errorBlock(state.error) : null,
          state.problems && state.problems.general.length ? el("ul", { class: "csx-ai-probs", role: "alert" }, state.problems.general.map(function (t) { return el("li", null, t); })) : null,
          v.changes.length ? v.changes.map(function (c) { return changeCard(c); }) : para(C.emptyHelp, "csx-muted"),
          skippedBlock(v),
          v.changes.length ? footer() : el("div", { class: "csx-ai-foot" }, leave("Discard", { type: "discard" }), anotherTry()));
      }

      function screenTone(v) {
        var byId = {};
        v.changes.forEach(function (c) { byId[c.id] = c; });
        var used = {};
        var items = v.findings.map(function (f) {
          var c = f.changeId ? byId[f.changeId] : null;
          if (c) used[c.id] = true;
          return el("div", { class: "csx-ai-finding", role: "group", "aria-label": f.label || "Finding" },
            f.label ? el("h4", { class: "csx-ai-label" }, f.label) : null,
            el("p", { class: "csx-ai-quote", "data-quote": "1" }, f.quote),
            para(f.issue, "csx-ai-issue"),
            f.suggestion && !c ? para("Suggestion: " + f.suggestion, "csx-ai-suggest") : null,
            c ? changeCard(c, { useLabel: "Use this wording" }) : null);
        });
        var rest = v.changes.filter(function (c) { return !used[c.id]; }).map(function (c) { return changeCard(c, { useLabel: "Use this wording" }); });
        return el("div", { class: "csx-ai-result", "data-kind": "tone" },
          heading("Tone check"),
          el("p", { class: "csx-ai-verdict", "data-overall": v.overall }, el("strong", null, v.overallText), v.summary ? " – " + v.summary : ""),
          v.findings.length ? items : para(C.toneNone, "csx-ai-p"),
          rest,
          warningsBlock(v),
          state.error && state.phase === "result" ? errorBlock(state.error) : null,
          v.changes.length ? footer() : el("div", { class: "csx-ai-foot" }, leave("Done", { type: "discard" })));
      }

      function screenNeedsCode(v) {
        var nc = v.needsCode || { title: "", body: "", where: "", priority: "Whenever", reason: "" };
        var text = V.requestText(nc);
        var ask = V.askClaudeUrl(studio.previewConfig && studio.previewConfig.askClaudeUrl, window.location.origin);
        var copyNote = null;
        function copy() {
          var done = function (okay) {
            var msg = okay ? C.needsCodeCopied : C.needsCodeCopyFail;
            say(msg);
            var n = root.querySelector("[data-copy-note]");
            if (n) n.textContent = msg;
            if (!okay) { var ta = root.querySelector("textarea[data-req='body']"); if (ta) { ta.focus(); ta.select(); } }
          };
          try {
            if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
            else done(false);
          } catch (e) { done(false); }
        }
        function field(id, label, value, rows) {
          return el("div", { class: "csx-ai-reqfield" },
            el("label", { for: id }, label),
            el("textarea", { id: id, rows: String(rows), readonly: true, value: value, "data-req": id.replace("csx-ai-req-", "") }));
        }
        return el("div", { class: "csx-ai-result csx-ai-needscode", "data-kind": "needs_code" },
          heading(C.needsCodeTitle),
          v.summary ? para(v.summary, "csx-ai-summary") : null,
          nc.reason ? para(nc.reason, "csx-ai-p") : null,
          para(C.needsCodeLine, "csx-muted"),
          el("div", { class: "csx-ai-req" },
            field("csx-ai-req-title", "Title", nc.title, 2),
            field("csx-ai-req-body", "What you want", nc.body, 5),
            field("csx-ai-req-where", "Where on the site", nc.where, 1),
            para("How soon: " + nc.priority, "csx-muted")),
          el("div", { class: "csx-ai-footbtns" },
            btn("Copy request", copy, { act: "copy" }),
            ask ? el("a", { class: "csx-btn csx-btn-quiet csx-ai-link", href: ask, target: "_blank", rel: "noopener noreferrer" }, "Open Ask Claude") : null,
            leave("Done", { type: "discard" })),
          el("p", { class: "csx-muted", "data-copy-note": "1" }, copyNote || ""));
      }

      function screenClarify(v) {
        var ans = el("textarea", { id: "csx-ai-answer", rows: "3", maxlength: String(V.LIMITS.feedback), spellcheck: "true", value: "", on: { input: function (ev) { dispatch({ type: "feedback", text: ev.target.value }, true); } } });
        return el("div", { class: "csx-ai-result", "data-kind": "clarify" },
          heading(C.clarifyTitle),
          para(v.question || v.summary || "", "csx-ai-question"),
          el("label", { for: "csx-ai-answer" }, "Your answer"),
          ans,
          el("div", { class: "csx-ai-footbtns" },
            btn("Send answer", function () { retry((ans.value || "").trim()); }, { act: "answer" }),
            leave("Discard", { type: "discard" })));
      }

      function screenWorking() {
        return el("div", { class: "csx-ai-working", "data-phase": "working" },
          heading("Working on it"),
          el("p", { class: "csx-ai-p", "data-working-line": "1" }, V.workingMessage(0)),
          el("div", { class: "csx-ai-footbtns" }, el("button", { type: "button", class: "csx-btn csx-btn-quiet", "data-act": "cancel", on: { click: cancel } }, "Cancel")));
      }

      function screenSaved() {
        var sv = state.saved || {};
        var d = sv.draft || null;
        var pv = d && previewLink(d.previewUrl);
        var me = studio.me;
        var canSend = d && d.state === "draft" && me;
        return el("div", { class: "csx-ai-result csx-ai-saved", "data-phase": "saved" },
          heading(C.savedTitle),
          para(C.savedLine, "csx-ai-p"),
          sv.total ? para(sv.accepted + (sv.accepted === 1 ? " change" : " changes") + " saved" + (sv.total > sv.accepted ? " (" + (sv.total - sv.accepted) + " left out)." : "."), "csx-muted") : null,
          el("div", { class: "csx-ai-footbtns" },
            btn("Open Changes", function () { try { ui.openPanel("changes"); } catch (e) { /* optional panel */ } }, { act: "open-changes" }),
            canSend ? btn("Send for review", function () {
              studio.drafts.submit().then(function () { ui.toast("Sent for review.", { kind: "success" }); say("Sent for review."); }, function (e) { ui.toast((e && (e.userMessage || e.message)) || C.generic, { kind: "error" }); });
            }, { quiet: true, act: "send-review" }) : null,
            leave("Describe another change", { type: "reset", clearInstruction: true }, { quiet: true, act: "another" })),
          el("p", { class: "csx-ai-links" },
            pv ? el("a", { href: pv, target: "_blank", rel: "noopener noreferrer", class: "csx-link" }, "Preview") : null,
            pv && httpUrl(d && d.url) ? " · " : null,
            httpUrl(d && d.url) ? el("a", { href: httpUrl(d.url), target: "_blank", rel: "noopener noreferrer", class: "csx-link" }, "Open the pull request") : null),
          para(C.undoLine, "csx-muted"));
      }

      function screenError() {
        var info = state.error || V.errorInfo({ code: "internal" });
        var actions = info.actions || [];
        return el("div", { class: "csx-ai-errorscreen", "data-phase": "error" },
          heading("That did not work"),
          errorBlock(info),
          el("div", { class: "csx-ai-footbtns" },
            actions.indexOf("retry") >= 0 ? btn("Try again", function () { propose({ reuseKey: info.code === "offline" }); }, { act: "try-again" }) : null,
            actions.indexOf("askAgain") >= 0 ? btn("Ask again", function () { propose({ instruction: state.lastInstruction }); }, { act: "ask-again" }) : null,
            actions.indexOf("signin") >= 0 ? btn("Sign in", function () { ui.openPanel("account"); }, { act: "sign-in" }) : null,
            actions.indexOf("back") >= 0 || !actions.length ? leave("Back", { type: "reset" }, { quiet: true, act: "back" }) : null));
      }

      function screenOff() {
        var reason = V.offReasonOf(state);
        return el("div", { class: "csx-ai-off", "data-phase": "off", "data-reason": reason },
          heading(reason === "budget_exhausted" ? "AI help is resting for today" : "AI help is not available"),
          para(V.offCopy(reason), "csx-ai-p"),
          reason === "unreachable" ? btn("Check again", function () { focusNext = true; loadStatus(); }, { act: "recheck" }) : null);
      }

      function screenIdle() {
        var info = V.MODE_INFO[state.mode];
        var refs = state.refs;
        var can = V.canSubmit(state);
        var hint = V.submitHint(state);
        var ta = el("textarea", {
          id: "csx-ai-instr", rows: state.mode === "edit" ? "5" : "3", maxlength: String(V.LIMITS.instruction), spellcheck: "true", placeholder: info.placeholder, value: state.instruction,
          "aria-describedby": "csx-ai-count csx-ai-hint", "data-focus": "1",
          on: {
            input: function (ev) {
              dispatch({ type: "instruction", text: ev.target.value }, true);
              var cnt = root.querySelector("#csx-ai-count");
              if (cnt) cnt.textContent = V.counterText(ev.target.value.length);
              syncSubmit();
            },
            keydown: function (ev) { if ((ev.ctrlKey || ev.metaKey) && ev.key === "Enter") { ev.preventDefault(); if (V.canSubmit(state)) propose(); } },
          },
        });
        function syncSubmit() {
          var go = root.querySelector("[data-act='submit']");
          var h = root.querySelector("#csx-ai-hint");
          var ok = V.canSubmit(state);
          if (go) go.disabled = !ok;
          if (h) h.textContent = V.submitHint(state);
        }
        var modeBtns = V.MODES.map(function (m) {
          return el("button", { type: "button", class: "csx-ai-mode", "aria-pressed": state.mode === m ? "true" : "false", "data-mode": m, on: { click: function () { focusNext = false; dispatch({ type: "mode", mode: m }); refocus(); } } }, V.MODE_INFO[m].tab);
        });
        return el("div", { class: "csx-ai-idle", "data-phase": "idle" },
          heading(info.tab),
          para(state.note || C.intro, state.note ? "csx-muted" : "csx-intro"),
          el("div", { class: "csx-ai-modes", role: "group", "aria-label": "What would you like to do?" }, modeBtns),
          para(info.help, "csx-muted"),
          refs.length ? el("div", { class: "csx-ai-chips", role: "group", "aria-label": "What this is about" },
            el("span", { class: "csx-ai-about" }, "About: "),
            refs.map(function (r) {
              var lab = labelOf(r);
              return el("span", { class: "csx-ai-chip" }, el("span", null, lab),
                el("button", { type: "button", class: "csx-ai-x", "aria-label": "Remove " + lab + " from this request", on: { click: function () { focusNext = false; dispatch({ type: "removeRef", ref: r }); refocus(); } } }, "×"));
            })) : null,
          state.mode === "alt_text" && !refs.length ? el("label", { class: "csx-ai-check csx-ai-scope" }, el("input", { type: "checkbox", checked: state.scopeMissing, on: { change: function (ev) { dispatch({ type: "scope", missing: ev.target.checked }, true); } } }), " Find pictures that have no description or a weak one") : null,
          el("label", { for: "csx-ai-instr", class: "csx-ai-lab" }, info.label),
          ta,
          el("p", { class: "csx-muted csx-ai-counter", id: "csx-ai-count" }, V.counterText((state.instruction || "").length)),
          state.mode === "edit" ? el("div", { class: "csx-ai-examples", role: "group", "aria-label": "Examples" },
            el("span", { class: "csx-muted" }, "Or try: "),
            V.EXAMPLES.map(function (t) { return el("button", { type: "button", class: "csx-ai-ex", on: { click: function () { focusNext = false; dispatch({ type: "instruction", text: t }); refocus(); } } }, t); })) : null,
          el("p", { class: "csx-muted csx-ai-hint", id: "csx-ai-hint", role: "status" }, hint),
          el("div", { class: "csx-ai-footbtns" }, el("button", { type: "button", class: "csx-btn csx-ai-big", "data-act": "submit", disabled: !can, on: { click: function () { propose(); } } }, info.button)));
      }

      function paint() {
        if (!alive) return;
        var body;
        var p = state.phase;
        if (p === "signedOut") body = el("div", { "data-phase": "signedOut" }, heading("Sign in first"), para(C.signedOut, "csx-ai-p"), btn("Open Account", function () { ui.openPanel("account"); }, { act: "account" }));
        else if (p === "loadingStatus") body = el("div", { "data-phase": "loading" }, heading("One moment"), el("p", { class: "csx-muted", role: "status" }, C.loading));
        else if (p === "off") body = screenOff();
        else if (p === "idle") body = screenIdle();
        else if (p === "working") body = screenWorking();
        else if (p === "saved") body = screenSaved();
        else if (p === "error") body = screenError();
        else if ((p === "result" || p === "saving") && state.view) {
          var v = state.view;
          body = v.kind === "needs_code" ? screenNeedsCode(v) : v.kind === "clarify" ? screenClarify(v) : v.kind === "tone" ? screenTone(v) : screenPatch(v);
        } else body = el("p", { class: "csx-muted" }, C.generic);
        root.setAttribute("aria-busy", p === "working" || p === "saving" || p === "loadingStatus" ? "true" : "false");
        while (root.firstChild) root.removeChild(root.firstChild);
        root.appendChild(body);
        if (focusNext) {
          var f = (state.problems && root.querySelector("[data-invalid]")) || root.querySelector("[data-focus]");
          if (f && f.focus) f.focus();
        }
        focusNext = false;
      }

      // wiring
      var offSel = studio.on("selection", function (d) {
        if (state.phase === "idle" && d && d.ref) { dispatch({ type: "replaceRef", ref: d.ref }); }
      });
      var offAuth = studio.on("auth:change", function () {
        dispatch({ type: "auth", signedIn: isEditor() });
        if (isEditor()) loadStatus();
      });

      inst = {
        pendingMode: null,
        setMode: function (mode, refs) {
          if (state.phase === "result" || state.phase === "error" || state.phase === "saved") { focusNext = false; dispatch({ type: "reset" }); }
          if (state.phase === "idle") {
            dispatch({ type: "mode", mode: mode });
            if (refs && refs.length) dispatch({ type: "refs", refs: refs }, true);
            focusNext = true;
            paint();
            var t = root.querySelector("#csx-ai-instr");
            if (t) t.focus();
          } else inst.pendingMode = mode;
        },
        refresh: function () { if (state.phase === "idle" || state.phase === "off" || state.phase === "loadingStatus") loadStatus(); },
        destroy: function () {
          alive = false;
          stopTimers();
          reqSeq += 1;
          if (typeof offSel === "function") offSel();
          if (typeof offAuth === "function") offAuth();
          if (live.parentNode) live.parentNode.removeChild(live);
          if (root.parentNode) root.parentNode.removeChild(root);
        },
      };
      inst.pendingMode = null;
      if (state.phase === "signedOut") paint(); else { paint(); loadStatus(); }
      return function () { if (inst) inst.destroy(); inst = null; };
    }

    var holder = { pendingMode: null };
    function open(mode) {
      var sel = selectedRef();
      if (inst && inst.setMode) {
        inst.setMode(mode, sel ? [sel] : null);
        ui.openPanel("ai");
        return;
      }
      holder.pendingMode = mode;
      inst = holder;
      ui.openPanel("ai");
    }

    ui.registerPanel({
      id: "ai",
      title: C.title,
      glyph: "✦",
      order: 15,
      minRole: "editor",
      render: function (container) {
        var dispose = render(container);
        return dispose;
      },
    });

    var when = function () { return !!studio.me && studio.mode === "edit"; };
    ui.registerCommand({ id: "ai.describe", title: "Describe a change", keywords: ["ai", "describe", "ask", "suggest", "rewrite", "translate", "shorter", "warmer", "change"], group: "AI help", when: when, run: function () { open("edit"); } });
    ui.registerCommand({ id: "ai.alt", title: "Suggest alt text for this picture", keywords: ["alt", "alt text", "description", "picture", "image", "accessibility"], group: "AI help", when: when, run: function () { open("alt_text"); } });
    ui.registerCommand({ id: "ai.meta", title: "Suggest a meta description", keywords: ["meta", "description", "seo", "search", "google"], group: "AI help", when: when, run: function () { open("meta_description"); } });
    ui.registerCommand({ id: "ai.tone", title: "Check the tone of this page", keywords: ["tone", "voice", "brand", "wording", "check"], group: "AI help", when: when, run: function () { open("tone_check"); } });
  });
})(window.__CoveredStudioBoot);
