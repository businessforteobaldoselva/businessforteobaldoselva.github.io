/* COVERED Studio overlay - core/drafts.js
   Saving staged edits as ONE patch, and the life of the draft afterwards (status, submit, publish, discard).
   Error handling follows DESIGN 10.3 "Save flow": 422 -> problems mapped back to fields; 409 conflict ->
   per item Keep mine / Take theirs; base_moved / draft_moved -> refresh; 401 -> sign in again; 429 -> wait;
   offline -> staging is kept and the same Save can be retried. */
(function (S) {
  "use strict";
  var U = S.util;

  function create(env) {
    var staging = env.staging;
    var api = env.api;
    var events = env.events;
    var content = env.content; // content.json
    var current = null;
    var lastChanges = [];
    var lastKey = null;
    var status = { saving: false, error: null, problems: [], conflicts: [], offline: false, baseMoved: false };
    var pollTimer = null;
    var pollUntil = 0;

    function branchDraftId() {
      var b = content && content.build && content.build.branch;
      var m = b && /^studio\/([^/]+)\/([^/]+)$/.exec(b);
      return m ? m[1] + "--" + m[2] : null;
    }
    function setCurrent(d, changes) {
      current = d || null;
      if (changes) lastChanges = changes;
      if (current) U.session.set("covered.studio.draft", current.id); else U.session.del("covered.studio.draft");
      events.emit("draft:change", { draft: current });
    }
    function remembered() { return branchDraftId() || U.session.get("covered.studio.draft"); }

    function mapProblems(list) {
      return (list || []).map(function (p) {
        var fileKey = U.fileKeyOfPath(p.file || "");
        var ref = fileKey && p.path ? staging.refFromPointer(fileKey, p.path, "working") : null;
        return { code: p.code, ref: ref, file: p.file, path: p.path, message: p.message || "That can't be saved.", hint: p.hint || "" };
      });
    }
    function mapConflicts(items) {
      return (items || []).map(function (it) {
        var fileKey = U.fileKeyOfPath(it.file || "");
        return {
          file: it.file, path: it.path, fileKey: fileKey,
          ref: fileKey ? staging.refFromPointer(fileKey, it.path, "head") : null,
          theirs: it.actual !== undefined ? it.actual : it.current,
          expected: it.expected !== undefined ? it.expected : it.expect,
        };
      });
    }

    // opts: { title, retry }
    function save(opts) {
      opts = opts || {};
      if (status.saving) return Promise.reject(new Error("Already saving."));
      var probs = staging.problems();
      if (probs.length) {
        status.problems = probs.map(function (p) { return { ref: p.ref, message: p.messages[0], code: p.codes[0] }; });
        events.emit("draft:status", status);
        return Promise.reject(Object.assign(new Error("Fix the items marked in red first."), { code: "client_invalid", userMessage: "Fix the items marked in red first." }));
      }
      if (!opts.retry || !lastKey) lastKey = U.uuid();
      status.saving = true; status.error = null; status.problems = []; status.conflicts = []; status.offline = false; status.baseMoved = false;
      events.emit("draft:status", status);
      var draft = current && current.state !== "merged" && current.state !== "closed" ? current : null;
      return S.patchBuilder.build({ staging: staging, key: lastKey, title: opts.title, draft: draft, baseSha: content && content.build && content.build.sha }).then(function (patch) {
        if (!patch.ops.length) { status.saving = false; throw Object.assign(new Error("Nothing to save."), { code: "empty", userMessage: "There is nothing new to save." }); }
        return api.post("/v1/drafts", patch).then(
          function (res) {
            status.saving = false;
            lastKey = null;
            staging.markSaved();
            setCurrent(res.draft, res.changes);
            events.emit("draft:saved", { draft: res.draft, changes: res.changes || [], warnings: res.warnings || [] });
            startPolling();
            return res;
          },
          function (err) {
            status.saving = false;
            status.error = err;
            if (err.code === "validation_failed") status.problems = mapProblems(err.details && err.details.problems);
            else if (err.code === "conflict") status.conflicts = mapConflicts(err.details && err.details.items);
            else if (err.code === "base_moved" || err.code === "draft_moved") status.baseMoved = true;
            else if (err.code === "offline") status.offline = true;
            if (err.code === "unauthorized") { events.emit("auth:expired", {}); }
            events.emit("draft:status", status);
            events.emit("error", { error: err });
            throw err;
          }
        );
      }, function (err) { status.saving = false; events.emit("draft:status", status); throw err; });
    }

    // conflict resolution (per item)
    function keepMine(c) {
      if (c.fileKey && c.path) staging.adoptRemote(c.fileKey, c.path, c.theirs);
      status.conflicts = status.conflicts.filter(function (x) { return x !== c; });
      events.emit("draft:status", status);
    }
    function takeTheirs(c) {
      if (c.fileKey && c.path) {
        staging.adoptRemote(c.fileKey, c.path, c.theirs);
        if (c.ref) staging.set(c.ref, c.theirs);
      }
      status.conflicts = status.conflicts.filter(function (x) { return x !== c; });
      events.emit("draft:status", status);
    }

    function refresh() {
      if (!current) { var id = remembered(); if (!id) return Promise.resolve(null); return fetchOne(id); }
      return fetchOne(current.id);
    }
    function fetchOne(id) {
      return api.get("/v1/drafts/" + encodeURIComponent(id)).then(function (res) {
        setCurrent(res.draft, res.changes);
        return res.draft;
      }, function (err) {
        if (err.code === "not_found") setCurrent(null);
        throw err;
      });
    }
    function list() { return api.get("/v1/drafts?scope=mine&state=open").then(function (r) { return r.drafts || []; }); }
    function act(name, extra) {
      if (!current) return Promise.reject(new Error("No draft."));
      var body = Object.assign({ idempotencyKey: U.uuid() }, extra || {});
      return api.post("/v1/drafts/" + encodeURIComponent(current.id) + "/" + name, body).then(function (res) {
        setCurrent(res.draft || current);
        return res.draft;
      });
    }
    function submit() { return act("submit"); }
    function publish() { return act("publish", { expectedHeadSha: current && current.headSha }); }
    function rebase() { return act("rebase", { expectedHeadSha: current && current.headSha }); }
    function discard() {
      if (!current) return Promise.resolve();
      return api.del("/v1/drafts/" + encodeURIComponent(current.id)).then(function () { setCurrent(null); });
    }

    // Poll for checks / preview URL (only while somebody watches the Changes panel; at most 10 minutes).
    function startPolling() { pollUntil = Date.now() + 10 * 60 * 1000; schedule(); }
    function stopPolling() { clearTimeout(pollTimer); pollTimer = null; pollUntil = 0; }
    function schedule() {
      clearTimeout(pollTimer);
      if (!current || Date.now() > pollUntil || (env.isWatching && !env.isWatching())) return;
      pollTimer = setTimeout(function () {
        fetchOne(current.id).then(schedule, schedule);
      }, 15000);
    }

    if (branchDraftId()) current = { id: branchDraftId(), state: "draft", title: "", branch: content.build.branch, headSha: content.build.sha };

    return {
      current: function () { return current; }, setCurrent: function (d) { if (typeof d === "string") d = d ? { id: d } : null; setCurrent(d); },
      changes: function () { return lastChanges; }, status: function () { return status; },
      save: save, keepMine: keepMine, takeTheirs: takeTheirs, refresh: refresh, list: list, submit: submit, publish: publish, rebase: rebase, discard: discard,
      startPolling: startPolling, stopPolling: stopPolling, remembered: remembered, mapProblems: mapProblems,
    };
  }
  S.draftsLib = { create: create };
})(window.__CoveredStudioBoot);
