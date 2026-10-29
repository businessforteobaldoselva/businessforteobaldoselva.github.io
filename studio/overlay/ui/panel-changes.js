/* COVERED Studio overlay - ui/panel-changes.js
   The Changes panel: everything staged in plain English (old -> new) with per-line Undo, then Save draft,
   Send for review and Publish, plus the draft's status (checks, preview, pull request). */
(function (S) {
  "use strict";
  var U = S.util;
  var h = S.dom.h;

  var titleDraft = "";

  function stateWords(d) {
    if (!d) return "";
    return { draft: "Draft (not sent for review yet)", ready: "Sent for review", merged: "Published", closed: "Closed" }[d.state] || d.state;
  }
  function checksWords(c) {
    if (!c) return "";
    return { none: "No checks have run yet", pending: "Checks are running…", success: "All checks passed", failure: "A check failed" + (c.failing && c.failing.length ? ": " + c.failing.join(", ") : "") }[c.state] || "";
  }

  function render(container, studio) {
    var staging = studio.staging;
    var drafts = studio.drafts;
    var offs = [];
    var busy = false;

    function paint() {
      if (container.contains(container.getRootNode().activeElement) && container.getRootNode().activeElement && container.getRootNode().activeElement.tagName === "INPUT") return;
      S.dom.clear(container);
      var me = studio.me;
      var items = staging.list();
      var status = drafts.status();
      var draft = drafts.current();

      if (!me) {
        container.appendChild(h("p", null, "Sign in to save your changes as a draft."));
        container.appendChild(h("button", { type: "button", class: "btn btn-primary", on: { click: function () { studio.ui.openPanel("account"); } } }, "Go to sign in"));
      }

      // ---- offline / base moved banners
      if (status.offline) {
        container.appendChild(h("div", { class: "banner banner-warn", role: "status" }, h("p", null, "Saved on this device. It will be sent when you are back online."),
          h("button", { type: "button", class: "btn btn-small", on: { click: function () { doSave(true); } } }, "Try again now")));
      }
      if (status.baseMoved) {
        container.appendChild(h("div", { class: "banner banner-warn", role: "status" }, h("p", null, "The site or this draft changed while you were editing."),
          h("div", { class: "row-btns" },
            h("button", { type: "button", class: "btn btn-small", on: { click: function () { location.reload(); } } }, "Refresh the page"),
            draft ? h("button", { type: "button", class: "btn btn-small", on: { click: function () { drafts.rebase().then(function () { studio.ui.toast("Draft brought up to date.", { kind: "success" }); }, function (e) { studio.ui.toast(e.userMessage || "Could not update the draft.", { kind: "error" }); }); } } }, "Bring my draft up to date") : null)));
      }

      // ---- conflicts
      if (status.conflicts && status.conflicts.length) {
        var box = h("div", { class: "banner banner-bad", role: "alert" }, h("p", null, "Someone changed these since you started. Choose what to keep:"));
        status.conflicts.forEach(function (c) {
          var label = c.ref ? studio.schema.label(c.ref) : c.path;
          box.appendChild(h("div", { class: "conflict" },
            h("strong", null, label),
            h("p", null, "Theirs now: “" + U.truncate(U.visible(typeof c.theirs === "string" ? c.theirs : JSON.stringify(c.theirs)), 80) + "”"),
            h("div", { class: "row-btns" },
              h("button", { type: "button", class: "btn btn-small", on: { click: function () { drafts.keepMine(c); } } }, "Keep mine"),
              h("button", { type: "button", class: "btn btn-small", on: { click: function () { drafts.takeTheirs(c); } } }, "Take theirs"))));
        });
        container.appendChild(box);
      }

      // ---- staged list
      container.appendChild(h("h3", { class: "sub" }, items.length ? "Unsaved changes (" + items.length + ")" : "Unsaved changes"));
      if (!items.length) {
        var custom = studio.ui.emptyState && studio.ui.emptyState("changes");
        if (custom) { try { custom(container, studio); } catch (e) { /* ignore */ } }
        else container.appendChild(h("p", { class: "empty" }, "Nothing changed yet. Switch on Edit, then click any text or picture on the page to change it."));
      } else {
        var ul = h("ul", { class: "changes" });
        var srvProblems = {};
        (status.problems || []).forEach(function (p) { if (p.ref) (srvProblems[p.ref] = srvProblems[p.ref] || []).push(p.message); });
        items.forEach(function (c) {
          var probs = (c.problems || []).concat(srvProblems[c.ref] || []);
          var li = h("li", { class: probs.length ? "bad" : "" },
            h("strong", null, c.label),
            h("p", { class: "summary" }, c.summary),
            probs.length ? h("ul", { class: "errors" }, probs.map(function (t) { return h("li", null, t); })) : null,
            h("div", { class: "row-btns" },
              c.ref ? h("button", { type: "button", class: "btn btn-small", on: { click: function () { studio.ui.editRef(c.ref); } } }, "Show") : null,
              h("button", { type: "button", class: "btn btn-small", "aria-label": "Undo this change: " + c.summary, on: { click: function () { staging.discard(c.ref); } } }, "Undo this")));
          ul.appendChild(li);
        });
        container.appendChild(ul);
        if (staging.staleCount()) container.appendChild(h("p", { class: "hint warn" }, staging.staleCount() + " of these were made against an older version of the site. Check them before saving."));
        var unlinked = (status.problems || []).filter(function (p) { return !p.ref || !items.some(function (i) { return i.ref === p.ref; }); });
        if (unlinked.length) container.appendChild(h("ul", { class: "errors", role: "alert" }, unlinked.map(function (p) { return h("li", null, p.message); })));
      }

      container.appendChild(h("div", { class: "row-btns" },
        h("button", { type: "button", class: "btn btn-small", disabled: !staging.canUndo(), on: { click: function () { staging.undo(); } } }, "Undo"),
        h("button", { type: "button", class: "btn btn-small", disabled: !staging.canRedo(), on: { click: function () { staging.redo(); } } }, "Redo"),
        h("button", { type: "button", class: "btn btn-small btn-danger", disabled: !items.length, on: { click: function () { discardAll(); } } }, "Discard all")));

      // ---- save
      if (items.length) {
        var tid = "title-" + Math.floor(Math.random() * 1e6);
        var title = h("input", { id: tid, type: "text", maxlength: "80", placeholder: "For example: Friendlier hero text", value: titleDraft, autocomplete: "off" });
        title.addEventListener("input", function () { titleDraft = title.value; });
        container.appendChild(h("div", { class: "field" }, h("label", { for: tid }, "Name this draft (optional)"), title));
      }
      var canSave = !!me && items.length > 0 && !status.saving && !busy;
      container.appendChild(h("div", { class: "row-btns" },
        h("button", { type: "button", class: "btn btn-primary", disabled: !canSave, "aria-disabled": canSave ? "false" : "true", on: { click: function () { doSave(false); } } }, status.saving ? "Saving…" : "Save draft")));
      if (status.error && status.error.code !== "validation_failed" && status.error.code !== "conflict") {
        container.appendChild(h("p", { class: "error", role: "alert" }, status.error.userMessage || status.error.message));
      }

      // ---- draft
      if (draft) {
        container.appendChild(h("h3", { class: "sub" }, "Your draft"));
        var dbox = h("div", { class: "draft" });
        dbox.appendChild(h("p", null, h("strong", null, draft.title || "Draft"), " – " + stateWords(draft)));
        if (draft.checks) dbox.appendChild(h("p", { class: "hint" }, checksWords(draft.checks)));
        var links = h("p", { class: "links" });
        if (draft.url) links.appendChild(h("a", { href: draft.url, target: "_blank", rel: "noopener noreferrer" }, "Open the pull request"));
        if (draft.previewUrl) { links.appendChild(document.createTextNode(" · ")); links.appendChild(h("a", { href: draft.previewUrl + "/?studio=1", target: "_blank", rel: "noopener noreferrer" }, "Open the preview in Studio")); }
        dbox.appendChild(links);
        var row = h("div", { class: "row-btns" });
        row.appendChild(h("button", { type: "button", class: "btn btn-small", on: { click: function () { drafts.refresh().then(function () { studio.ui.toast("Draft status updated.", { kind: "info" }); }, function (e) { studio.ui.toast(e.userMessage || "Could not refresh.", { kind: "error" }); }); } } }, "Refresh status"));
        if (draft.state === "draft" && me) row.appendChild(h("button", { type: "button", class: "btn btn-small", on: { click: function () { doSubmit(); } } }, "Send for review"));
        if (me && me.capabilities && me.capabilities.publish && (draft.state === "ready" || draft.state === "draft")) {
          row.appendChild(h("button", { type: "button", class: "btn btn-small btn-primary", disabled: draft.canPublish === false, "aria-label": "Publish this draft to the live site", on: { click: function () { doPublish(); } } }, "Publish"));
        }
        row.appendChild(h("button", { type: "button", class: "btn btn-small btn-danger", on: { click: function () { doDiscardDraft(); } } }, "Discard draft"));
        dbox.appendChild(row);
        if (me && me.capabilities && me.capabilities.publish && draft.canPublish === false) dbox.appendChild(h("p", { class: "hint" }, "Publishing needs the automatic checks to pass and a second person to publish."));
        container.appendChild(dbox);
      }
    }

    function doSave(retry) {
      drafts.save({ title: titleDraft, retry: !!retry }).then(function (res) {
        titleDraft = "";
        studio.ui.toast("Saved as a draft.", { kind: "success", actionLabel: res.draft && res.draft.url ? "Open" : undefined, onAction: function () { window.open(res.draft.url, "_blank", "noopener"); } });
      }, function (err) {
        if (err.code === "client_invalid" || err.code === "empty") studio.ui.toast(err.userMessage, { kind: "error" });
        else if (err.code === "unauthorized") { studio.ui.toast(err.userMessage, { kind: "error" }); studio.ui.openPanel("account"); }
        else if (err.code === "rate_limited") studio.ui.toast("Too many saves in a row. Try again in " + (err.retryAfter || 30) + " seconds.", { kind: "error" });
        else if (err.code !== "offline") studio.ui.toast(err.userMessage || err.message, { kind: "error" });
        paint();
      });
    }
    function wrap(promise, ok) {
      busy = true; paint();
      return promise.then(function () { busy = false; if (ok) studio.ui.toast(ok, { kind: "success" }); paint(); }, function (e) { busy = false; studio.ui.toast(e.userMessage || e.message || "Something went wrong.", { kind: "error" }); paint(); });
    }
    function doSubmit() { wrap(drafts.submit(), "Sent for review. An approver can publish it now."); }
    function doPublish() {
      studio.ui.confirm({ title: "Publish to the live site?", body: "Everything in this draft goes live as soon as the site rebuilds.", confirmLabel: "Publish" }).then(function (ok) { if (ok) wrap(drafts.publish(), "Published. The live site updates in a minute or two."); });
    }
    function doDiscardDraft() {
      studio.ui.confirm({ title: "Discard this draft?", body: "The draft and its pull request are closed. Nothing goes live.", confirmLabel: "Discard draft", danger: true }).then(function (ok) { if (ok) wrap(drafts.discard(), "Draft discarded."); });
    }
    function discardAll() {
      studio.ui.confirm({ title: "Throw away unsaved changes?", body: "Everything listed here that is not saved to a draft yet will be lost.", confirmLabel: "Discard all", danger: true }).then(function (ok) { if (ok) { staging.clear(); studio.ui.toast("Changes discarded.", { kind: "info" }); } });
    }

    ["staged:change", "draft:change", "draft:status", "draft:saved", "auth:change"].forEach(function (ev) { offs.push(studio.on(ev, paint)); });
    paint();
    return function () { offs.forEach(function (o) { o(); }); };
  }

  S.panelChanges = { render: render };
})(window.__CoveredStudioBoot);
