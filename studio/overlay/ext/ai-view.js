(function (S) {
  "use strict";
  // "Describe a change" panel: the PURE view model (studio/AI-DESIGN.md 14). No DOM, no network, no storage, no timers:
  // a state machine (one reducer), the default-checkbox rules, closure toggling, the fixed plain-English copy, the
  // mapping of error codes to what a founder reads, and the Rendered/Delta -> render-plan step. ext/ai.js turns the
  // plans into elements (text nodes only). Everything here is unit-tested under node (studio/tests/ai-ui/).
  //
  // Shapes mirrored from AI-DESIGN 5 (the UI never imports the server's validators):
  //   Proposal { id, kind, mode, summary, base, instructionHash, model, changes[Change], skipped[], needsCode, question,
  //              findings[], warnings[], usage }   Change { id, title, ops[], deltas[], requires[], outsideAsk, sensitive, defaultChecked }
  //   Delta { file, path, ref, op, kind, label, before, after, diff }   Rendered { type: text|bool|color|link|fields|order }
  // Model text is DATA: every string that is shown goes through clean() (control and bidi characters removed, length capped),
  // and the caller puts it into the page as a text node only.

  // ------------------------------------------------------------------ constants
  var LIMITS = { instruction: 1000, feedback: 300, refs: 5, changes: 40, deltas: 20, fields: 20, segments: 400, text: 2000, field: 300, label: 200, summary: 200, title: 80, previewChars: 200 };
  var MODES = ["edit", "alt_text", "meta_description", "tone_check"];
  var MODE_INFO = {
    edit: { tab: "Describe a change", label: "What would you like to change?", help: "Say it the way you would to a colleague. You will see exactly what would change before anything is saved.", button: "Suggest changes", placeholder: "For example: make the hero shorter and warmer" },
    alt_text: { tab: "Alt text", label: "Anything the description should mention? (optional)", help: "Alt text is the short description of a picture that screen readers read out. Pick a picture on the page, or let Studio find pictures that have none.", button: "Suggest picture descriptions", placeholder: "" },
    meta_description: { tab: "Meta description", label: "Anything it should stress? (optional)", help: "The meta description is the short summary people see under the page title in search results.", button: "Draft a meta description", placeholder: "" },
    tone_check: { tab: "Tone check", label: "Anything to look out for? (optional)", help: "Studio reads the page copy and points out wording that does not sound like COVERED. It never changes anything by itself.", button: "Check the tone", placeholder: "" },
  };
  var EXAMPLES = ["Make the hero shorter and warmer", "Translate the FAQ to Welsh", "Add a question about venues to the FAQ", "Make the footer tagline shorter"];

  var COPY = {
    title: "Describe a change",
    intro: "Tell Studio what you want in plain words. It suggests changes to the words and settings of the site. Nothing is saved until you say so, and nothing goes live until an approver publishes it.",
    signedOut: "Sign in to describe a change. You can do that in the Account panel.",
    loading: "Checking whether AI help is available…",
    off_disabled: "AI help is switched off. A Studio admin can turn it on in the settings. Everything else in Studio works as usual.",
    off_no_key: "AI help is not connected yet. A Studio admin needs to add the AI key in the settings.",
    off_budget_exhausted: "Today's AI allowance is used up. It starts again at midnight UTC (1 am UK time in summer).",
    off_unreachable: "Studio could not check whether AI help is on. Nothing was changed. Try again in a moment.",
    rate_limited: "You have asked a lot in a short time. Try again in {n} seconds.",
    rate_limited_min: "You have asked a lot in a short time. Try again in {n} minutes.",
    ai_unavailable: "The AI service did not answer. Nothing was changed. Try again in a minute.",
    ai_bad_output: "The AI gave an answer Studio could not safely use, so nothing was changed. You can ask for another try.",
    too_long: "That request is too long. Keep it under 1,000 characters.",
    bad_request: "That request could not be understood. Change the wording a little and try again.",
    conflict: "Something on the site changed since this suggestion was made. Nothing was saved. Ask again to get a fresh suggestion.",
    validation: "Some of these changes cannot be saved yet. They are marked below. Untick them, or ask for another try.",
    selection_incomplete: "Some of the ticked changes need another change that is not ticked. Tick it too, or untick them.",
    unauthorized: "Your sign-in has expired. Please sign in again.",
    forbidden: "You do not have permission to do that.",
    offline: "You seem to be offline. Nothing was changed. Try again when you are back online.",
    generic: "Something went wrong. Nothing was changed. Try again in a moment.",
    empty: "No changes were suggested.",
    emptyHelp: "Try describing it a little differently, or pick the part of the page you mean.",
    working0: "Thinking about it… this usually takes 5 to 20 seconds.",
    working8: "Still working… longer requests, like translations, take a little more time.",
    working20: "Almost there. If this takes much longer you can cancel and try a smaller part of the page.",
    cancelled: "Cancelled. Nothing was changed.",
    safety: "Nothing goes live until an approver publishes it.",
    savedTitle: "Saved as a draft",
    savedLine: "Nothing is live yet. An approver has to publish it first.",
    savedToast: "Saved as a draft. Nothing is live yet.",
    undoLine: "Changed your mind? Discard the draft in Changes, or undo it later from History.",
    needsCodeTitle: "This needs a developer change",
    needsCodeLine: "Studio only changes words, picture settings and colours. Code changes go to Claude through Ask Claude.",
    needsCodeCopied: "Request copied. Paste it into Ask Claude.",
    needsCodeCopyFail: "The request is selected. Press Ctrl+C (or Cmd+C) to copy it.",
    clarifyTitle: "One question first",
    toneNone: "Reads like COVERED.",
    leftOut: "Left out",
    leftOutHelp: "These suggestions could not be used, so they are not in the list above.",
    siteWide: "Site-wide change",
    siteWideHelp: "This suggestion touches several parts of the site. Look through each one.",
    fresh: "Fresh suggestion",
    notShown: "(not shown)",
    emptyValue: "(empty)",
    nothingBefore: "Nothing here yet",
    removedAfter: "Removed",
  };
  var FLAGS = {
    outsideAsk: { badge: "Outside what you asked about", help: "This change is on a part of the site you did not mention. Check it carefully before you include it." },
    sensitive: { badge: "Changes where visitors go (link or email)", help: "Links and email addresses decide where people end up. Only include this if you are sure it is right." },
  };
  var OVERALL = { on_brand: "On brand", mostly: "Mostly on brand", off_brand: "Off brand" };

  // ------------------------------------------------------------------ text hygiene
  function cc(n) { return String.fromCharCode(n); }
  var CTRL = new RegExp("[" + cc(0) + "-" + cc(8) + cc(11) + cc(12) + cc(14) + "-" + cc(31) + cc(127) + "-" + cc(159) + "]", "g");
  // bidi marks and overrides/isolates, line and paragraph separators, byte-order mark
  var BIDI = new RegExp("[" + cc(0x61c) + cc(0x200e) + cc(0x200f) + cc(0x202a) + "-" + cc(0x202e) + cc(0x2066) + "-" + cc(0x2069) + cc(0x2028) + cc(0x2029) + cc(0xfeff) + "]", "g");
  function isObj(x) { return x !== null && typeof x === "object" && !Array.isArray(x); }
  function arr(x) { return Array.isArray(x) ? x : []; }
  function own(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  // Text for display: strings only, control + bidi characters removed, length capped (never splits a surrogate pair).
  function clean(s, max) {
    if (typeof s === "number" && isFinite(s)) s = String(s);
    if (typeof s !== "string") return "";
    s = s.replace(CTRL, "").replace(BIDI, "");
    max = max || LIMITS.text;
    if (s.length > max) {
      s = s.slice(0, max - 1);
      var last = s.charCodeAt(s.length - 1);
      if (last >= 0xd800 && last <= 0xdbff) s = s.slice(0, -1);
      s = s + "…";
    }
    return s;
  }
  function oneLine(s, max) { return clean(s, max).replace(/\s+/g, " ").trim(); }
  function plural(n, one, many) { return n + " " + (n === 1 ? one : many); }
  function safeId(x) { return typeof x === "string" && /^[A-Za-z0-9_-]{1,16}$/.test(x) ? x : null; }

  // ------------------------------------------------------------------ Rendered / Delta -> render plans
  function renderedPlan(r, deltaKind) {
    if (!isObj(r)) return null;
    switch (r.type) {
      case "text": return { type: "text", text: clean(r.text, LIMITS.text), truncated: r.truncated === true };
      case "bool": {
        var on = r.value === true;
        return { type: "bool", text: deltaKind === "toggle" ? (on ? "On" : "Off") : (on ? "Shown" : "Hidden") };
      }
      case "color": {
        var hex = typeof r.hex === "string" && /^#[0-9a-fA-F]{3,8}$/.test(r.hex) ? r.hex : null;
        return { type: "color", text: hex || COPY.notShown, hex: hex };
      }
      case "link": return { type: "link", text: clean(r.text, LIMITS.field) };
      case "fields": return { type: "fields", fields: arr(r.fields).slice(0, LIMITS.fields).filter(isObj).map(function (f) { return { label: oneLine(f.label, 80), text: clean(f.text, LIMITS.field) }; }) };
      case "order": {
        var from = Number(r.from), to = Number(r.to), of = Number(r.of);
        var ok = isFinite(from) && isFinite(to) && isFinite(of);
        return { type: "order", text: ok ? "Moves from position " + (from + 1) + " to " + (to + 1) + " of " + of : COPY.notShown, item: oneLine(r.itemLabel, 80) };
      }
      default: return { type: "text", text: COPY.notShown, truncated: false };
    }
  }

  function joinSegs(segs, kinds) {
    return segs.filter(function (g) { return kinds.indexOf(g.t) >= 0; }).map(function (g) { return g.s; }).join("");
  }
  // A diff is only trusted when it rebuilds both texts exactly (the server's law). Otherwise show plain before/after.
  function diffOk(diff, before, after) {
    if (!Array.isArray(diff) || !diff.length || diff.length > LIMITS.segments) return false;
    if (!before || !after || before.type !== "text" || after.type !== "text") return false;
    for (var i = 0; i < diff.length; i++) {
      var g = diff[i];
      if (!isObj(g) || (g.t !== "same" && g.t !== "del" && g.t !== "ins") || typeof g.s !== "string") return false;
    }
    return joinSegs(diff, ["same", "del"]) === before.text && joinSegs(diff, ["same", "ins"]) === after.text;
  }
  // Runs for one side: the BEFORE side shows same + del, the AFTER side shows same + ins. Adjacent runs of one type are merged.
  function sideRuns(diff, side) {
    var keep = side === "before" ? "del" : "ins";
    var out = [];
    diff.forEach(function (g) {
      if (g.t !== "same" && g.t !== keep) return;
      var s = clean(g.s, LIMITS.text);
      if (!s) return;
      var last = out[out.length - 1];
      if (last && last.t === g.t) last.s += s;
      else out.push({ t: g.t, s: s, sr: g.t === "ins" ? "[added] " : g.t === "del" ? "[removed] " : "" });
    });
    return out;
  }

  function deltaPlan(d) {
    d = isObj(d) ? d : {};
    var kind = typeof d.kind === "string" ? d.kind : "text";
    var before = renderedPlan(d.before, kind);
    var after = renderedPlan(d.after, kind);
    var diff = diffOk(d.diff, isObj(d.before) ? d.before : null, isObj(d.after) ? d.after : null) ? d.diff : null;
    var op = typeof d.op === "string" ? d.op : "replace";
    return {
      label: oneLine(d.label, LIMITS.label) || "Change",
      ref: typeof d.ref === "string" && /^[A-Za-z0-9_:.\-]{1,120}$/.test(d.ref) ? d.ref : null,
      op: op, kind: kind,
      before: before, after: after,
      beforeNote: !before ? (op === "add" ? COPY.nothingBefore : COPY.notShown) : null,
      afterNote: !after ? (op === "remove" ? COPY.removedAfter : COPY.notShown) : null,
      beforeRuns: diff ? sideRuns(diff, "before") : null,
      afterRuns: diff ? sideRuns(diff, "after") : null,
    };
  }

  // ------------------------------------------------------------------ closure (AI-DESIGN 9.3, mirrored for the checkboxes)
  function requiresMap(changes) {
    var m = {};
    changes.forEach(function (c) { m[c.id] = c.requires.slice(); });
    return m;
  }
  // ids -> ids plus everything they transitively require
  function closure(changes, ids) {
    var m = requiresMap(changes);
    var seen = {};
    var stack = ids.slice();
    while (stack.length) {
      var id = stack.pop();
      if (seen[id] || !own(m, id)) continue;
      seen[id] = true;
      m[id].forEach(function (r) { stack.push(r); });
    }
    return changes.map(function (c) { return c.id; }).filter(function (id) { return seen[id]; });
  }
  // everything that (transitively) needs `id`
  function dependents(changes, id) {
    var out = {};
    var grew = true;
    out[id] = true;
    while (grew) {
      grew = false;
      changes.forEach(function (c) {
        if (!out[c.id] && c.requires.some(function (r) { return out[r]; })) { out[c.id] = true; grew = true; }
      });
    }
    return changes.map(function (c) { return c.id; }).filter(function (x) { return out[x] && x !== id; });
  }
  // A selection nobody could save (a change ticked without something it needs) is repaired by UNticking, never by ticking.
  function normalizeChecked(changes, checked) {
    var next = Object.assign({}, checked);
    var changed = true;
    while (changed) {
      changed = false;
      changes.forEach(function (c) {
        if (next[c.id] && c.requires.some(function (r) { return !next[r]; })) { next[c.id] = false; changed = true; }
      });
    }
    return next;
  }
  // -> { checked, alsoOn: [ids switched on because they are needed], alsoOff: [ids switched off because they needed this one] }
  function toggle(changes, checked, id, on) {
    var next = Object.assign({}, checked);
    var alsoOn = [];
    var alsoOff = [];
    if (!own(requiresMap(changes), id)) return { checked: next, alsoOn: alsoOn, alsoOff: alsoOff };
    if (on) {
      closure(changes, [id]).forEach(function (x) { if (!next[x]) { next[x] = true; if (x !== id) alsoOn.push(x); } });
    } else {
      next[id] = false;
      dependents(changes, id).forEach(function (x) { if (next[x]) { next[x] = false; alsoOff.push(x); } });
    }
    return { checked: next, alsoOn: alsoOn, alsoOff: alsoOff };
  }
  function selectedIds(view, checked) {
    return view ? view.changes.filter(function (c) { return checked[c.id]; }).map(function (c) { return c.id; }) : [];
  }
  // The flags beat the server's defaultChecked: a flagged change is never ticked for you.
  function initialChecked(changes) {
    var c = {};
    changes.forEach(function (ch) { c[ch.id] = ch.defaultChecked === true && !ch.outsideAsk && !ch.sensitive; });
    return normalizeChecked(changes, c);
  }
  function titleOf(changes, id) {
    for (var i = 0; i < changes.length; i++) if (changes[i].id === id) return changes[i].title;
    return id;
  }
  function alsoText(changes, res) {
    var parts = [];
    if (res.alsoOn.length) parts.push("Also selected " + res.alsoOn.map(function (x) { return "“" + titleOf(changes, x) + "”"; }).join(", ") + " because it goes together with this.");
    if (res.alsoOff.length) parts.push("Also unselected " + res.alsoOff.map(function (x) { return "“" + titleOf(changes, x) + "”"; }).join(", ") + " because it needed this.");
    return parts.join(" ");
  }

  // ------------------------------------------------------------------ proposal -> a safe, cleaned view
  function normalizeChange(c) {
    if (!isObj(c)) return null;
    var id = safeId(c.id);
    if (!id) return null;
    return {
      id: id,
      title: oneLine(c.title, LIMITS.title) || "Change",
      deltas: arr(c.deltas).slice(0, LIMITS.deltas).map(deltaPlan),
      opCount: arr(c.ops).length,
      requires: arr(c.requires).map(safeId).filter(Boolean),
      outsideAsk: c.outsideAsk === true,
      sensitive: c.sensitive === true,
      defaultChecked: c.defaultChecked === true,
    };
  }
  function normalizeProposal(p) {
    if (!isObj(p)) return null;
    var kinds = ["patch", "needs_code", "clarify", "tone"];
    var kind = kinds.indexOf(p.kind) >= 0 ? p.kind : "patch";
    var changes = arr(p.changes).slice(0, LIMITS.changes).map(normalizeChange).filter(Boolean);
    var ids = {};
    changes = changes.filter(function (c) { if (ids[c.id]) return false; ids[c.id] = true; return true; });
    changes.forEach(function (c) { c.requires = c.requires.filter(function (r) { return ids[r] && r !== c.id; }); });
    var nc = null;
    if (isObj(p.needsCode)) {
      var rq = isObj(p.needsCode.request) ? p.needsCode.request : {};
      var pri = ["Whenever", "This week", "ASAP"].indexOf(rq.priority) >= 0 ? rq.priority : "Whenever";
      nc = { reason: clean(p.needsCode.reason, 300), title: oneLine(rq.title, 120), body: clean(rq.body, 1500), where: oneLine(rq.where, 80), priority: pri };
    }
    var findings = arr(p.findings).slice(0, 20).filter(isObj).map(function (f) {
      return { id: safeId(f.id) || "f", label: oneLine(f.label, LIMITS.label), ref: typeof f.ref === "string" && /^[A-Za-z0-9_:.\-]{1,120}$/.test(f.ref) ? f.ref : null, quote: clean(f.quote, 200), issue: clean(f.issue, 300), suggestion: clean(f.suggestion, 500), changeId: safeId(f.changeId) && ids[f.changeId] ? f.changeId : null };
    });
    var overall = own(OVERALL, p.overall) ? p.overall : null;
    if (kind === "tone" && !overall) overall = !findings.length ? "on_brand" : findings.length <= 2 ? "mostly" : "off_brand";
    var base = isObj(p.base) ? p.base : {};
    return {
      id: typeof p.id === "string" ? p.id : "",
      kind: kind,
      mode: MODES.indexOf(p.mode) >= 0 ? p.mode : "edit",
      summary: oneLine(p.summary, LIMITS.summary),
      changes: changes,
      skipped: arr(p.skipped).slice(0, 40).filter(isObj).map(function (s) { return { title: oneLine(s.title, LIMITS.title) || "A suggestion", reason: clean(s.reason, 300) }; }),
      warnings: arr(p.warnings).slice(0, 5).filter(isObj).map(function (w) { return { code: oneLine(w.code, 40), message: clean(w.message, 300), refs: arr(w.refs).slice(0, 8).filter(function (r) { return typeof r === "string" && /^[A-Za-z0-9_:.\-]{1,120}$/.test(r); }) }; }),
      needsCode: nc,
      question: p.question ? clean(p.question, 300) : null,
      findings: findings,
      overall: overall,
      overallText: overall ? OVERALL[overall] : "",
      draftBase: !!(base && base.draftId),
      siteWide: filesTouched(p) >= 4,
    };
  }
  function filesTouched(p) {
    var f = {};
    arr(p.changes).forEach(function (c) { if (isObj(c)) arr(c.ops).forEach(function (o) { if (isObj(o) && typeof o.file === "string") f[o.file] = true; }); });
    return Object.keys(f).length;
  }

  // ------------------------------------------------------------------ requests
  function cleanRefs(refs) {
    var out = [];
    arr(refs).forEach(function (r) {
      if (typeof r === "string" && /^[A-Za-z0-9_:.\-]{1,120}$/.test(r) && out.indexOf(r) < 0 && out.length < LIMITS.refs) out.push(r);
    });
    return out;
  }
  // The Phase 5 propose body (5.3). Unknown keys are refused by the server, so nothing else is ever added.
  function buildProposeBody(s, key, env) {
    env = env || {};
    var body = { idempotencyKey: key, mode: s.mode };
    var instruction = (s.instruction || "").trim();
    if (instruction) body.instruction = instruction.slice(0, LIMITS.instruction);
    var ctx = {};
    var refs = cleanRefs(s.refs);
    if (refs.length) ctx.refs = refs;
    if (env.page && (s.mode === "meta_description" || s.mode === "tone_check") && !refs.length) ctx.page = env.page;
    if (s.mode === "alt_text" && !refs.length && s.scopeMissing) ctx.scope = "missing";
    if (Object.keys(ctx).length) body.context = ctx;
    if (env.draftId) body.draftId = env.draftId;
    if (s.retryOf && /^p_[A-Za-z0-9]{1,24}$/.test(s.retryOf)) body.retryOf = s.retryOf;
    var fb = (s.feedback || "").trim();
    if (fb) body.feedback = fb.slice(0, LIMITS.feedback);
    return body;
  }
  // The accept body (5.6): the proposal exactly as received (minus deltas and flags) + the ticked ids.
  function buildAcceptBody(s, key) {
    var p = s.proposal;
    var base = isObj(p.base) ? p.base : {};
    var body = {
      idempotencyKey: key,
      proposal: {
        id: p.id,
        instructionHash: p.instructionHash,
        instructionPreview: oneLine(s.lastInstruction || s.instruction || "", LIMITS.previewChars),
        base: { sha: base.sha, draftId: base.draftId == null ? null : base.draftId, headSha: base.headSha == null ? null : base.headSha },
        model: p.model,
        changes: arr(p.changes).map(function (c) { return { id: c.id, title: c.title, ops: JSON.parse(JSON.stringify(arr(c.ops))) }; }),
      },
      accept: selectedIds(s.view, s.checked),
    };
    var title = oneLine(p.summary || "", LIMITS.title);
    if (title) body.title = title;
    return body;
  }

  function canSubmit(s) {
    if (s.phase !== "idle") return false;
    var t = (s.instruction || "").trim();
    if (s.mode === "edit") return t.length > 0 && t.length <= LIMITS.instruction;
    return t.length <= LIMITS.instruction;
  }
  function submitHint(s) {
    var t = (s.instruction || "").trim();
    if (s.mode === "edit" && !t) return "Type what you would like to change.";
    if (t.length > LIMITS.instruction) return COPY.too_long;
    return "";
  }
  function counterText(n) { return n + " / " + LIMITS.instruction; }
  function saveLabel(n) { return n === 1 ? "Save 1 change as a draft" : "Save " + n + " changes as a draft"; }
  function countText(n, total) { return n === 0 ? "No changes selected" : n + " of " + plural(total, "change", "changes") + " selected"; }
  function workingMessage(sec) { return sec >= 20 ? COPY.working20 : sec >= 8 ? COPY.working8 : COPY.working0; }

  function metaGuidance(len) {
    if (len < 70) return { ok: false, text: len + " characters. A little short: 70 to 160 works best." };
    if (len > 160) return { ok: false, text: len + " characters. Long: search results usually cut it off at about 160." };
    return { ok: true, text: len + " characters. Good length (70 to 160)." };
  }

  // "/" -> "index"; "/about/" -> "pages:about" when that page exists in the content snapshot.
  function pageKey(pathname, fileKeys) {
    var p = typeof pathname === "string" ? pathname : "/";
    if (p === "/" || /^\/index\.html?$/.test(p) || p === "") return "index";
    var m = /^\/([a-z0-9-]+)(?:\/(?:index\.html?)?|\.html?)?$/.exec(p);
    if (m && arr(fileKeys).indexOf("pages:" + m[1]) >= 0) return "pages:" + m[1];
    return null;
  }
  // https, or http on this machine, or the same origin as the page. Null otherwise (the link is then simply not shown).
  function askClaudeUrl(configured, origin) {
    function ok(u) {
      try {
        var x = new URL(u);
        if (x.username || x.password) return false;
        if (x.protocol === "https:") return true;
        return x.protocol === "http:" && (x.hostname === "localhost" || x.hostname === "127.0.0.1");
      } catch (e) { return false; }
    }
    if (typeof configured === "string" && configured && ok(configured)) return configured;
    if (typeof origin === "string" && ok(origin)) return origin.replace(/\/+$/, "") + "/admin/#/collections/requests/new";
    return null;
  }
  function requestText(nc) {
    if (!nc) return "";
    return "Title: " + nc.title + "\nWhere: " + nc.where + "\nHow soon: " + nc.priority + "\n\n" + nc.body;
  }

  // ------------------------------------------------------------------ errors
  function offReasonOf(s) {
    var r = (s.status && s.status.reason) || s.offReason || "disabled";
    return own(OFF, r) ? r : "disabled";
  }
  var OFF = { disabled: COPY.off_disabled, no_key: COPY.off_no_key, budget_exhausted: COPY.off_budget_exhausted, unreachable: COPY.off_unreachable };
  function offCopy(reason) { return own(OFF, reason) ? OFF[reason] : COPY.off_disabled; }

  // -> { code, message, actions: ["retry","askAgain","back","signin"], requestId, off: null|"disabled"|"budget_exhausted" }
  function errorInfo(err, ctx) {
    ctx = ctx || {};
    err = err || {};
    var code = typeof err.code === "string" ? err.code : "internal";
    var info = { code: code, message: COPY.generic, actions: ["retry", "back"], requestId: typeof err.requestId === "string" && /^[A-Za-z0-9-]{8,64}$/.test(err.requestId) ? err.requestId : null, off: null };
    switch (code) {
      case "ai_disabled": info.message = COPY.off_disabled; info.actions = []; info.off = "disabled"; break;
      case "ai_budget_exhausted": info.message = COPY.off_budget_exhausted; info.actions = []; info.off = "budget_exhausted"; break;
      case "rate_limited": {
        var n = Number(err.retryAfter) || Number(err.details && err.details.retryAfter) || 30;
        n = Math.max(1, Math.min(3600, Math.round(n)));
        info.message = n > 120 ? COPY.rate_limited_min.replace("{n}", String(Math.ceil(n / 60))) : n === 1 ? COPY.rate_limited.replace("{n} seconds", "1 second") : COPY.rate_limited.replace("{n}", String(n));
        info.actions = ["retry", "back"];
        break;
      }
      case "ai_unavailable": info.message = COPY.ai_unavailable; break;
      case "ai_bad_output": info.message = COPY.ai_bad_output; info.actions = ["retry", "back"]; break;
      case "bad_request":
      case "payload_too_large":
        info.message = ctx.instructionLength > LIMITS.instruction || code === "payload_too_large" ? COPY.too_long : COPY.bad_request; info.actions = ["back"]; break;
      case "conflict": case "base_moved": case "draft_moved":
        info.message = COPY.conflict; info.actions = ["askAgain", "back"]; break;
      case "validation_failed": info.message = COPY.validation; info.actions = []; break;
      case "unauthorized": info.message = COPY.unauthorized; info.actions = ["signin"]; break;
      case "forbidden": case "not_invited": info.message = COPY.forbidden; info.actions = ["back"]; break;
      case "offline": info.message = COPY.offline; info.actions = ["retry", "back"]; break;
      case "aborted": info.message = COPY.cancelled; info.actions = ["back"]; break;
      default: break;
    }
    return info;
  }
  // 422 problems -> messages per change card (matched by file + pointer of any op) and general ones
  function problemMap(proposal, problems) {
    var byChange = {};
    var general = [];
    arr(problems).slice(0, 40).forEach(function (pr) {
      if (!isObj(pr)) return;
      var msg = clean(pr.message, 300) || "This cannot be saved.";
      if (pr.path === "/accept" || !pr.file) {
        general.push(/also needs/i.test(msg) ? COPY.selection_incomplete : msg);
        return;
      }
      var hit = null;
      arr(proposal && proposal.changes).forEach(function (c) {
        if (hit || !isObj(c)) return;
        arr(c.ops).forEach(function (o) {
          if (isObj(o) && o.file === pr.file && (o.path === pr.path || o.from === pr.path)) hit = safeId(c.id);
        });
      });
      if (hit) (byChange[hit] = byChange[hit] || []).push(msg); else general.push(msg);
    });
    return { byChange: byChange, general: general };
  }

  // ------------------------------------------------------------------ the reducer
  function initialState(o) {
    o = o || {};
    return {
      phase: o.signedIn === false ? "signedOut" : "loadingStatus",
      status: null, offReason: null,
      mode: "edit", instruction: o.instruction || "", feedback: "", refs: cleanRefs(o.refs), scopeMissing: true,
      key: null, retryOf: null, lastInstruction: "",
      proposal: null, view: null, checked: {}, error: null, problems: null, saved: null, note: "",
    };
  }
  var BUSY = { working: 1, saving: 1 };
  function reduce(s, a) {
    var n = Object.assign({}, s);
    switch (a.type) {
      case "auth":
        if (!a.signedIn) { n.phase = "signedOut"; return n; }
        if (n.phase === "signedOut") n.phase = "loadingStatus";
        return n;
      case "statusLoading":
        if (!BUSY[n.phase] && n.phase !== "result" && n.phase !== "saved") n.phase = "loadingStatus";
        return n;
      case "status":
        n.status = a.status;
        n.offReason = null;
        if (n.phase === "loadingStatus" || n.phase === "off" || n.phase === "idle") n.phase = a.status && a.status.enabled ? "idle" : "off";
        else if (a.status && !a.status.enabled && !BUSY[n.phase]) n.phase = "off";
        return n;
      case "statusFail":
        if (n.phase === "loadingStatus" || n.phase === "off") { n.phase = "off"; n.offReason = "unreachable"; }
        return n;
      case "mode":
        if (n.phase !== "idle" || MODES.indexOf(a.mode) < 0) return n;
        n.mode = a.mode;
        return n;
      case "instruction": n.instruction = typeof a.text === "string" ? a.text.slice(0, LIMITS.instruction + 200) : ""; return n;
      case "feedback": n.feedback = typeof a.text === "string" ? a.text.slice(0, LIMITS.feedback + 100) : ""; return n;
      case "refs": n.refs = cleanRefs(a.refs); return n;
      case "addRef": n.refs = cleanRefs(n.refs.concat([a.ref])); return n;
      case "replaceRef": n.refs = cleanRefs(a.ref ? [a.ref] : n.refs); return n;
      case "removeRef": n.refs = n.refs.filter(function (r) { return r !== a.ref; }); return n;
      case "scope": n.scopeMissing = !!a.missing; return n;
      case "reset": {
        n.phase = n.status && n.status.enabled ? "idle" : n.phase === "signedOut" ? "signedOut" : "off";
        n.proposal = null; n.view = null; n.checked = {}; n.error = null; n.problems = null; n.saved = null; n.retryOf = null; n.feedback = ""; n.key = null; n.note = "";
        if (a.clearInstruction) n.instruction = "";
        return n;
      }
      case "submit":
        if (n.phase === "idle" ? !canSubmit(n) : !(n.phase === "result" || n.phase === "error")) return n;
        n.phase = "working"; n.key = a.key; n.error = null; n.problems = null; n.note = "";
        if (a.retryOf) { n.retryOf = a.retryOf; if (typeof a.feedback === "string") n.feedback = a.feedback; }
        else { n.retryOf = null; n.feedback = ""; }
        if (a.instruction != null) n.instruction = a.instruction;
        n.lastInstruction = (n.instruction || "").trim();
        return n;
      case "result": {
        if (n.phase !== "working") return n;
        var view = normalizeProposal(a.proposal);
        if (!view) { n.phase = "error"; n.error = errorInfo({ code: "ai_bad_output" }); return n; }
        n.proposal = a.proposal; n.view = view; n.error = null; n.problems = null;
        n.checked = view.kind === "patch" || view.kind === "tone" ? initialChecked(view.changes) : {};
        n.phase = "result";
        return n;
      }
      case "fail": {
        if (n.phase !== "working" && n.phase !== "saving") return n;
        var info = errorInfo(a.error, { instructionLength: (n.instruction || "").length });
        if (info.off) { n.phase = "off"; n.offReason = info.off; n.status = n.status ? Object.assign({}, n.status, { enabled: false, reason: info.off }) : n.status; n.error = null; return n; }
        if (n.phase === "saving") {
          // the suggestion stays on screen so nothing the person ticked is lost
          n.phase = "result"; n.error = info;
          if (info.code === "validation_failed") n.problems = problemMap(n.proposal, a.error && a.error.details && a.error.details.problems);
          if (info.actions.indexOf("askAgain") >= 0) n.phase = "error";
          return n;
        }
        n.phase = "error"; n.error = info;
        return n;
      }
      case "cancel": if (n.phase === "working") { n.phase = "idle"; n.error = null; n.note = COPY.cancelled; } return n;
      case "discard": if (n.phase === "saving" || n.phase === "working") return n; n.phase = n.status && n.status.enabled ? "idle" : "off"; n.proposal = null; n.view = null; n.checked = {}; n.error = null; n.problems = null; n.retryOf = null; n.note = ""; return n;
      case "toggle": {
        if (n.phase !== "result" || !n.view) return n;
        var r = toggle(n.view.changes, n.checked, a.id, !!a.on);
        n.checked = r.checked;
        n.note = alsoText(n.view.changes, r);
        return n;
      }
      case "selectAll": {
        if (n.phase !== "result" || !n.view) return n;
        var all = {};
        n.view.changes.forEach(function (c) { all[c.id] = true; });
        n.checked = all; n.note = ""; return n;
      }
      case "selectNone": if (n.phase === "result") { n.checked = {}; n.note = ""; } return n;
      case "save":
        if (n.phase !== "result" || !selectedIds(n.view, n.checked).length) return n;
        n.phase = "saving"; n.key = a.key; n.error = null; n.problems = null; return n;
      case "saved": if (n.phase !== "saving") return n; n.phase = "saved"; n.saved = a.saved || {}; return n;
      default: return n;
    }
  }

  function overallClass(o) { return o === "on_brand" ? "ok" : o === "mostly" ? "warn" : "bad"; }

  var api = {
    LIMITS: LIMITS, MODES: MODES, MODE_INFO: MODE_INFO, EXAMPLES: EXAMPLES, COPY: COPY, FLAGS: FLAGS, OVERALL: OVERALL,
    clean: clean, oneLine: oneLine, renderedPlan: renderedPlan, diffOk: diffOk, sideRuns: sideRuns, deltaPlan: deltaPlan,
    closure: closure, dependents: dependents, normalizeChecked: normalizeChecked, toggle: toggle, selectedIds: selectedIds, initialChecked: initialChecked, alsoText: alsoText,
    normalizeProposal: normalizeProposal, cleanRefs: cleanRefs, buildProposeBody: buildProposeBody, buildAcceptBody: buildAcceptBody,
    canSubmit: canSubmit, submitHint: submitHint, counterText: counterText, saveLabel: saveLabel, countText: countText, workingMessage: workingMessage, metaGuidance: metaGuidance,
    pageKey: pageKey, askClaudeUrl: askClaudeUrl, requestText: requestText, offReasonOf: offReasonOf, offCopy: offCopy, errorInfo: errorInfo, problemMap: problemMap,
    initialState: initialState, reduce: reduce, overallClass: overallClass,
  };
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (S) { S.ext = S.ext || {}; S.ext.aiView = api; }
})(window.__CoveredStudioBoot);
