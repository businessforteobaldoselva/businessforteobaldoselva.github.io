"use strict";
// The AI service (AI-DESIGN 1, 6, 9): createAiService({ deps, provider, config, budget }) -> { status, propose, accept }.
//
// PROPOSE IS READ-ONLY. It reads page content from Git, asks the provider for a patch, treats the answer as hostile
// (strict parser + AI allow-list = Gate 1; the Phase 4 validator, change by change = Gate 2), and returns a Proposal with a
// server-computed BEFORE/AFTER for every change. It writes nothing: no branch, no commit, no pull request. The only way a
// proposal becomes a draft is accept() (services/ai.js), which re-validates and calls the same drafts.saveDraft as a
// hand-made patch. This file never calls a Git write method (a guard checks that).
// Portable: Web APIs only; time and randomness come from deps.

const { ApiError } = require("../errors");
const { validatePatch } = require("../../validate");
const { assertProvider, ProviderError } = require("./providers/interface");
const { createDisabledProvider } = require("./providers/disabled");
const { createMemoryBudget, dayKey, nextMidnight } = require("./budget");
const A = require("./allowlist");
const policy = require("./policy");
const T = require("./tool-schema");
const ctxMod = require("./context");
const prompt = require("./prompt");
const out = require("./output");
const prop = require("./proposal");
const shapes = require("./shapes");
const chars = require("./chars");
const W = require("../../validate/walk");
const P = require("../../validate/pointer");
const grammar = require("../../markers/grammar");
const ids = require("../services/ids");
const drafts = require("../services/drafts");

const CACHE_MS = 10 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COPY = {
  disabled: "AI help is switched off.",
  budget: "Today's AI allowance is used up.",
  unavailable: "The AI service did not answer. Nothing was changed.",
  badOutput: "The AI gave an answer Studio could not safely use. Nothing was changed.",
  tooLong: "The answer was too long. Try a smaller part of the page.",
  nothingUsable: "None of the suggestions could be used. Nothing was changed.",
  empty: "No changes were suggested.",
};
const hexNonce = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");
const actorOf = (ctx) => ({ id: ctx.user.id, email: ctx.user.email, role: ctx.role });
const plainOne = (s, max) => chars.oneLine(s, max).replace(/[<>]/g, " ");

function createAiService(opts) {
  const o = opts || {};
  const deps = o.deps;
  const cfg = o.config || (deps.config && deps.config.ai);
  if (!cfg) throw new TypeError("AI settings are required");
  const provider = assertProvider(o.provider || createDisabledProvider());
  const budget = o.budget || createMemoryBudget({ dailyRequests: cfg.dailyRequests, dailyTokens: cfg.dailyTokens });
  const worldId = o.worldId || "default";
  let allowCache = null;
  const allow = () => allowCache || (allowCache = A.deriveAllowList(deps.schema));
  const cache = new Map(); // userKey|idempotencyKey -> { at, sig, proposal }
  const usageToday = new Map(); // day|userKey -> count
  const today = () => dayKey(deps.now());
  const modes = policy.MODES.slice();

  const keyPresent = () => provider.id !== "disabled";
  const isEnabled = () => !!cfg.enabled && keyPresent();
  function reasonNow() {
    if (!cfg.enabled) return "disabled";
    if (!keyPresent()) return "no_key";
    const snap = budget.snapshot(today());
    if (snap.requests >= cfg.dailyRequests || snap.tokens >= cfg.dailyTokens) return "budget_exhausted";
    return null;
  }

  async function audit(ctx, action, outcome, ai, extra) {
    try { await deps.audit.write(Object.assign({ requestId: ctx.requestId, actor: actorOf(ctx), action, outcome, ai }, extra || {})); } catch (e) { /* an audit sink must never break a request */ }
  }

  // ---- status -----------------------------------------------------------------------------------------------------------
  async function status(ctx) {
    const reason = reasonNow();
    const day = today();
    const snap = budget.snapshot(day);
    const ok = reason === null;
    const s = {
      enabled: ok, reason,
      provider: ok || reason === "budget_exhausted" ? (provider.id === "replay" ? "replay" : "anthropic") : "none",
      model: ok || reason === "budget_exhausted" ? provider.model : null,
      vision: ok && !!cfg.vision,
      modes: ok ? modes : [],
      limits: { instructionChars: policy.CAPS.instruction, feedbackChars: policy.CAPS.feedback, contextRefs: policy.CAPS.refs, maxChanges: policy.CAPS.changes },
      usage: { requestsToday: snap.requests, requestsLimit: cfg.dailyRequests, yourRequestsToday: usageToday.get(day + "|" + ctx.userKey) || 0, yourRequestsLimit: cfg.userPerDay, resetsAt: nextMidnight(deps.now()) },
    };
    const bad = shapes.validateStatus(s);
    if (bad.length) throw new Error("status shape: " + bad[0]);
    return s;
  }

  // ---- the request ------------------------------------------------------------------------------------------------------
  function parseRequest(body) {
    const bad = (m) => new ApiError("bad_request", m);
    if (!P.isPlainObject(body)) throw bad("The request must be a JSON object.");
    for (const k of Object.keys(body)) if (["idempotencyKey", "mode", "instruction", "context", "draftId", "retryOf", "feedback"].indexOf(k) < 0) throw bad("Unknown field " + JSON.stringify(k.slice(0, 30)) + ".");
    if (!UUID_RE.test(String(body.idempotencyKey))) throw bad("idempotencyKey must be a UUID v4.");
    if (policy.MODES.indexOf(body.mode) < 0) throw bad("mode is not valid.");
    const mode = body.mode;
    const text = (v, max, name, required) => {
      if (v === undefined || v === null) { if (required) throw bad(name + " is required."); return ""; }
      if (typeof v !== "string") throw bad(name + " must be text.");
      const t = v.replace(/\r\n?/g, "\n").trim();
      if (required && !t) throw bad(name + " is required.");
      if (t.length > max) throw bad("That request is too long. Keep it under " + max + " characters.");
      if (chars.BAD_CHARS.test(t)) throw bad(name + " contains characters that are not allowed.");
      return t;
    };
    const instruction = text(body.instruction, mode === "edit" ? policy.CAPS.instruction : policy.CAPS.feedback, "instruction", mode === "edit");
    const feedback = text(body.feedback, policy.CAPS.feedback, "feedback", false);
    if (body.retryOf !== undefined && !/^p_[a-z0-9]{12}$/.test(String(body.retryOf))) throw bad("retryOf is not valid.");
    let context = { refs: [] };
    const warnings = [];
    if (body.context !== undefined) {
      if (!P.isPlainObject(body.context)) throw bad("context must be an object.");
      for (const k of Object.keys(body.context)) if (["refs", "page", "scope"].indexOf(k) < 0) throw bad("Unknown field in context.");
      const refs = body.context.refs === undefined ? [] : body.context.refs;
      if (!Array.isArray(refs) || refs.length > policy.CAPS.refs) throw bad("context.refs must be a list of at most " + policy.CAPS.refs + " references.");
      const kept = [];
      const dropped = [];
      for (const r of refs) {
        const loc = typeof r === "string" ? grammar.locate(r) : null;
        if (loc && W.fileInfo(deps.schema, loc.filePath)) kept.push(r); else dropped.push(typeof r === "string" ? r.slice(0, 60) : "?");
      }
      if (dropped.length) warnings.push({ code: "ref_ignored", message: "Some of the selected items could not be used as context and were ignored.", refs: dropped.slice(0, 5) });
      const page = body.context.page;
      if (page !== undefined && !(typeof page === "string" && (page === "index" || /^pages:[a-z0-9-]+$/.test(page)))) throw bad("context.page is not valid.");
      if (body.context.scope !== undefined && body.context.scope !== "missing") throw bad("context.scope is not valid.");
      context = { refs: [...new Set(kept)], page, scope: body.context.scope };
    }
    if (body.draftId !== undefined && !ids.parseId(body.draftId)) throw bad("draftId is not valid.");
    return { idempotencyKey: body.idempotencyKey, mode, instruction, feedback, context, draftId: body.draftId, retryOf: body.retryOf, warnings };
  }

  function limit(ctx, key, spec, code) {
    const r = deps.limiter.take(key, spec);
    if (!r.ok) {
      audit(ctx, "ai.denied", "denied", { codes: [code] });
      throw new ApiError("rate_limited", "You have asked a lot in a short time. Try again in " + r.retryAfterSec + " seconds.", { retryAfterSec: r.retryAfterSec }, { headers: { "Retry-After": String(r.retryAfterSec) } });
    }
  }

  // validator context with per-request memoised reads
  function memoCtx(ref) {
    const base = drafts.validatorCtx(deps, ref);
    const memo = (fn) => { const m = new Map(); return (a) => { if (!m.has(a)) m.set(a, Promise.resolve(fn(a))); return m.get(a); }; };
    return Object.assign({}, base, { readText: memo(base.readText), hasFile: memo(base.hasFile), readBytes: memo(base.readBytes), listDir: memo(base.listDir) });
  }

  const problemText = (p) => String((p && p.message) || "That suggestion could not be used.").replace(/^Change \d+: /, "").slice(0, 300);

  // ---- propose --------------------------------------------------------------------------------------------------------------
  async function propose(ctx, body) {
    const t0 = Date.now();
    if (!isEnabled()) {
      await audit(ctx, "ai.denied", "denied", { codes: [cfg.enabled ? "no_key" : "disabled"] });
      throw new ApiError("ai_disabled", COPY.disabled);
    }
    const req = parseRequest(body);
    const day = today();
    const cacheKey = ctx.userKey + "|" + req.idempotencyKey;
    const instrHash = await prop.instructionHash(deps.config.auditSalt, req.mode, req.instruction, req.feedback);
    const hit = cache.get(cacheKey);
    if (hit && deps.now().getTime() - hit.at < CACHE_MS && hit.sig === instrHash) return { proposal: structuredClone(hit.proposal) };

    limit(ctx, "ai:u:" + ctx.userKey, { limit: cfg.userPer10Min, windowMs: 600000 }, "rate_user");
    limit(ctx, "ai:ud:" + ctx.userKey + ":" + day, { limit: cfg.userPerDay, windowMs: 86400000 }, "rate_user_day");
    limit(ctx, "ai:g", { limit: cfg.globalPerHour, windowMs: 3600000 }, "rate_global");

    const git = deps.git;
    const mainHead = (await git.getHead(git.getBaseBranch())).sha;
    let ref = mainHead;
    let draftHead = null;
    if (req.draftId) {
      const parsed = ids.parseId(req.draftId);
      if (parsed.userKey !== ctx.userKey) throw new ApiError("not_found", "No such draft.");
      const head = await git.getHead(parsed.branch);
      if (!head) throw new ApiError("not_found", "No such draft.");
      draftHead = head.sha;
      ref = head.sha;
    }

    const al = allow();
    const docs = await ctxMod.loadDocs(deps, ref, al);
    let pack = ctxMod.buildPack(al, docs, { mode: req.mode, refs: req.context.refs, page: req.context.page, scope: req.context.scope });
    const meta = { mode: req.mode, instrHash };
    const base = { sha: mainHead, draftId: req.draftId || null, headSha: draftHead };
    const common = { mode: req.mode, base, instructionHash: instrHash, model: provider.model, provider: provider.id === "replay" ? "replay" : "anthropic" };

    // alt text with nothing to describe: answer without spending a model call
    if (req.mode === "alt_text" && !pack.pairs.length) {
      const pr = finish(Object.assign({ id: await prop.proposalId(ctx.userKey, mainHead, draftHead, []), kind: "clarify", summary: "No pictures to describe.", changes: [], skipped: [], needsCode: null, question: "I could not find a picture that needs a description. Click a picture on the page, then ask again.", findings: [], warnings: req.warnings, usage: { inTok: 0, outTok: 0, latencyMs: 0 } }, common));
      await audit(ctx, "ai.propose", "clarify", Object.assign({}, meta, { provider: pr.provider, model: pr.model, changes: 0, skipped: 0, codes: ["no_pairs"] }));
      return remember(cacheKey, instrHash, pr, ctx, day);
    }

    const build = (pk, images) => prompt.buildPrompt({ mode: req.mode, instruction: req.instruction, feedback: req.feedback, refs: req.context.refs, pack: pk, images, nonce: hexNonce() });
    let images = req.mode === "alt_text" ? await ctxMod.loadImages(deps, ref, pack, cfg) : [];
    let built = build(pack, images);
    if (built.user.length > cfg.maxInputChars) {
      const keep = new Set(pack.focusFiles);
      if (!keep.size) throw new ApiError("bad_request", "There is too much content for one request. Pick a section and try again.");
      pack = ctxMod.narrow(pack, keep);
      built = build(pack, images);
      if (built.user.length > cfg.maxInputChars) throw new ApiError("bad_request", "There is too much content for one request. Pick a section and try again.");
    }

    // budget: estimate now, settle with real usage after
    const est = Math.ceil((built.system.length + built.user.length) / 3) + cfg.maxOutputTokens;
    const rv = budget.reserve(day, est);
    if (!rv.ok) {
      await audit(ctx, "ai.denied", "denied", { codes: ["budget_exhausted"] });
      throw new ApiError("ai_budget_exhausted", COPY.budget, { resetsAt: nextMidnight(deps.now()) });
    }
    usageToday.set(day + "|" + ctx.userKey, (usageToday.get(day + "|" + ctx.userKey) || 0) + 1);

    const replayKey = await prop.replayKey(req.mode, req.instruction, req.feedback, req.context.refs, !!req.draftId, worldId);
    let res;
    try {
      res = await provider.complete({
        system: built.system, user: built.user,
        images: images.map((im) => ({ mediaType: im.mediaType, dataBase64: im.dataBase64 })),
        tool: prompt.toolFor(req.mode), maxTokens: cfg.maxOutputTokens, deadlineAtMs: Date.now() + cfg.timeoutMs,
        meta: { replayKey, mode: req.mode },
      });
    } catch (e) {
      budget.release(day, est);
      const code = e instanceof ProviderError ? e.code : "unavailable";
      if (code === "disabled") throw new ApiError("ai_disabled", COPY.disabled);
      await audit(ctx, code === "auth" ? "ai.denied" : "ai.propose", code === "auth" ? "denied" : "error", Object.assign({}, meta, { provider: provider.id, model: provider.model, codes: [code === "auth" ? "provider_auth" : "provider_" + code].concat(e && e.status ? ["http_" + e.status] : []) }));
      throw new ApiError("ai_unavailable", COPY.unavailable);
    }
    const usage = { inTok: Math.max(0, Math.floor(res.usage && res.usage.inTok) || 0), outTok: Math.max(0, Math.floor(res.usage && res.usage.outTok) || 0) };
    budget.settle(day, est, usage.inTok + usage.outTok);
    usage.latencyMs = Math.max(0, Date.now() - t0);
    common.model = typeof res.model === "string" && res.model ? res.model.slice(0, 80) : provider.model;

    // Gate 1
    const parsed = out.parseModelOutput(res, { mode: req.mode, allow: al, docs, filesSent: pack.filesSent });
    if (!parsed.ok) {
      const codes = parsed.violations.map((v) => v.code);
      await audit(ctx, "ai.rejected", "rejected", Object.assign({}, meta, { provider: provider.id, model: common.model, usage, codes: [...new Set(codes)] }));
      const long = codes.indexOf("max_tokens") >= 0;
      throw new ApiError("ai_bad_output", long ? COPY.tooLong : COPY.badOutput, { violations: parsed.violations.slice(0, 10).map((v) => ({ code: v.code, where: typeof v.where === "number" ? "ops/" + v.where : String(v.where) })) });
    }
    if (pack.injectionRefs.length) await audit(ctx, "ai.injection_suspected", "ok", { mode: req.mode, instrHash, codes: [] }, { target: { refs: pack.injectionRefs.slice(0, 10) } });

    const idBase = { ctx, req, ref, mainHead, draftHead, docs, pack, al, usage, common, instrHash };
    let proposal;
    if (parsed.kind === "clarify") proposal = finish(Object.assign({ id: await prop.proposalId(ctx.userKey, mainHead, draftHead, []), kind: "clarify", summary: parsed.summary, changes: [], skipped: [], needsCode: null, question: parsed.question, findings: [], warnings: pack.warnings.concat(req.warnings), usage }, common));
    else if (parsed.kind === "needs_code") proposal = finish(Object.assign({ id: await prop.proposalId(ctx.userKey, mainHead, draftHead, []), kind: "needs_code", summary: parsed.summary, changes: [], skipped: [], needsCode: { reason: parsed.reason, request: parsed.request }, question: null, findings: [], warnings: pack.warnings.concat(req.warnings), usage }, common));
    else proposal = await buildChangeProposal(idBase, parsed, { meta, audit: (a, oc, x) => audit(ctx, a, oc, x) });

    await audit(ctx, "ai.propose", proposal.kind === "needs_code" ? "needs_code" : proposal.kind === "clarify" ? "clarify" : "ok", Object.assign({}, meta, { provider: proposal.provider, model: proposal.model, usage, changes: proposal.changes.length, skipped: proposal.skipped.length, codes: proposal.skipped.map((s) => s.code).slice(0, 10) }));
    return remember(cacheKey, instrHash, proposal, ctx, day);
  }

  function finish(p) {
    const bad = shapes.validateProposal(p);
    if (bad.length) throw new Error("proposal shape: " + bad.slice(0, 3).join("; "));
    return p;
  }
  function remember(key, sig, proposal, ctx, day) {
    if (cache.size > 200) cache.delete(cache.keys().next().value);
    cache.set(key, { at: deps.now().getTime(), sig, proposal: structuredClone(proposal) });
    return { proposal };
  }

  // ---- patch / tone: Gate 2, server-side expect, dependencies, flags and Deltas --------------------------------------------------
  async function buildChangeProposal(x, parsed, io) {
    const { ctx, req, ref, mainHead, draftHead, docs, pack, al, usage, common, instrHash } = x;
    const vctx = memoCtx(ref);
    const dry = (ops) => validatePatch(vctx, { ops }, { requireKey: false });
    const isTone = parsed.kind === "tone";
    // changes in model order; for tone, each finding's fix is one change
    const list = [];
    const findingChange = new Map();
    if (isTone) parsed.findings.forEach((f, fi) => { if (f.fix) { findingChange.set(fi, list.length); list.push({ title: f.fix.title, ops: f.fix.ops }); } });
    else parsed.changes.forEach((c) => list.push({ title: c.title, ops: c.ops }));
    if (!list.length && !isTone) {
      return finish(Object.assign({ id: await prop.proposalId(ctx.userKey, mainHead, draftHead, []), kind: "clarify", summary: parsed.summary || COPY.empty, changes: [], skipped: [], needsCode: null, question: "I did not find anything to change for that. Could you say a little more about what you would like?", findings: [], warnings: pack.warnings.concat(req.warnings), usage }, common));
    }

    // Gate 2, change by change, each together with the changes it needs
    const requires = prop.computeRequires(list);
    const bad = new Map(); // index -> { reason, code }
    for (let i = 0; i < list.length; i += 1) {
      const dep = requires[i].find((j) => bad.has(j));
      if (dep !== undefined) { bad.set(i, { reason: "This depended on another suggestion that could not be used.", code: "depends" }); continue; }
      const idx = [...prop.closure(requires, [i])].sort((a, b) => a - b);
      const r = await dry(idx.flatMap((k) => list[k].ops));
      if (r.conflicts.length) bad.set(i, { reason: "The text changed while it was being drafted.", code: "conflict" });
      else if (!r.ok) bad.set(i, { reason: problemText(r.problems[0]), code: r.problems[0].code });
      else if (r.noop) bad.set(i, { reason: "This would not change anything.", code: "no_change" });
    }
    // then everything that is left, together
    let keep = list.map((_, i) => i).filter((i) => !bad.has(i));
    let union = null;
    for (let round = 0; round < 6 && keep.length; round += 1) {
      const r = await dry(keep.flatMap((k) => list[k].ops));
      if (r.ok && r.conflicts.length === 0) { union = r; break; }
      const probs = r.conflicts.length ? r.conflicts.map((c) => ({ file: c.file, path: c.path, code: "conflict", message: "The text changed while it was being drafted." })) : r.problems;
      let dropped = false;
      for (const pr of probs) {
        const owner = keep.find((k) => list[k].ops.some((op) => pr.file === op.file && (op.path === pr.path || pr.path === "" || String(pr.path).startsWith(op.path + "/") || op.path.startsWith(pr.path + "/"))));
        if (owner === undefined) continue;
        for (const d of prop.dependants(requires, owner)) if (!bad.has(d) && keep.indexOf(d) >= 0) bad.set(d, { reason: d === owner ? problemText(pr) : "This depended on another suggestion that could not be used.", code: d === owner ? pr.code : "depends" });
        dropped = true;
        break;
      }
      keep = keep.filter((k) => !bad.has(k));
      if (!dropped) { keep = []; break; }
    }
    const skipped = [...bad.entries()].sort((a, b) => a[0] - b[0]).slice(0, policy.CAPS.skipped).map(([i, b]) => ({ title: plainOne(list[i].title, 80), reason: plainOne(b.reason, 300), code: String(b.code).slice(0, 40) }));
    if (!union) {
      if (isTone) union = { applied: [], changes: [], files: new Map() };
      else {
        await io.audit("ai.rejected", "rejected", Object.assign({}, io.meta, { provider: common.provider, model: common.model, usage, codes: ["none_usable"].concat(skipped.map((s) => s.code)).slice(0, 10) }));
        throw new ApiError("ai_bad_output", COPY.nothingUsable, { violations: [{ code: "none_usable", where: "output" }], skipped });
      }
    }
    // server-side expect (the model never supplies one) from the dry run's own before-values
    const flat = keep.flatMap((k) => list[k].ops.map((op) => ({ k, op })));
    const finalOps = flat.map(({ op }, n) => {
      const a = union.applied[n];
      const e = Object.assign({}, op);
      if (op.op === "replace" || op.op === "remove") e.expect = a ? a.before : undefined;
      return e;
    });
    if (keep.length) {
      const again = await dry(finalOps);
      if (!again.ok || again.conflicts.length) throw new Error("internal: a proposal did not validate against itself");
    }

    // flags
    const targets = ctxMod.targetFiles(al, docs, { refs: req.context.refs, page: req.context.page, instruction: req.instruction, feedback: req.feedback, mode: req.mode }, pack);
    const injection = pack.injectionRefs.length > 0;
    const changes = [];
    let at = 0;
    keep.forEach((k, n) => {
      const ops = [];
      const deltas = [];
      let sensitive = false;
      let outside = false;
      for (const op of list[k].ops) {
        const fin = finalOps[at];
        const a = union.applied[at];
        const d = union.changes[at];
        const f = union.files.get(op.file);
        const dd = { before: f ? f.beforeDoc : docs.get(op.file), after: f ? f.afterDoc : docs.get(op.file) };
        ops.push(fin);
        deltas.push(prop.buildDelta(deps.schema, op, a, d, dd));
        const m = A.matchTarget(al, op.file, op.path, docs.get(op.file), { op: op.op });
        if (m.ok && m.target.sensitive) sensitive = true;
        if (targets.size && !targets.has(op.file)) outside = true;
        at += 1;
      }
      if (injection && sensitive) outside = true;
      changes.push({ id: "c" + (n + 1), title: plainOne(list[k].title, 80) || "Change", ops, deltas, requires: [], outsideAsk: outside, sensitive, defaultChecked: !outside && !sensitive });
    });
    const posOf = new Map(keep.map((k, n) => [k, n]));
    keep.forEach((k, n) => { changes[n].requires = requires[k].filter((j) => posOf.has(j)).map((j) => "c" + (posOf.get(j) + 1)); });

    const findings = [];
    if (isTone) {
      parsed.findings.forEach((f) => {
        const ci = findingChange.has(parsed.findings.indexOf(f)) ? findingChange.get(parsed.findings.indexOf(f)) : undefined;
        const loc = grammar.locate(f.ref);
        const segs = loc ? P.parse(loc.pointer) : [];
        findings.push({ id: "f" + (findings.length + 1), ref: f.ref, label: loc ? chars.oneLine(W.labelFor(deps.schema, loc.filePath, segs, docs.get(loc.filePath)), 200) : f.ref, quote: f.quote, issue: f.issue, suggestion: f.suggestion, changeId: ci !== undefined && posOf.has(ci) ? "c" + (posOf.get(ci) + 1) : null });
      });
    }
    const warnings = pack.warnings.concat(req.warnings);
    const p = Object.assign({ id: await prop.proposalId(ctx.userKey, mainHead, draftHead, changes), kind: isTone ? "tone" : "patch", summary: parsed.summary, changes, skipped, needsCode: null, question: null, findings, warnings, usage }, common);
    if (isTone) p.overall = parsed.overall;
    return finish(p);
  }

  const svcAccept = (ctx, body) => require("../services/ai").accept(ctx, body, { deps, allow: allow(), cfg, isEnabled, audit });

  return { status, propose, accept: svcAccept, provider: { id: provider.id, model: provider.model }, _budget: budget };
}

module.exports = { createAiService, COPY };
