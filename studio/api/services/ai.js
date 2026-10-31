"use strict";
// Accepting (part of) an AI proposal (AI-DESIGN 9.2). There is NO second write path: the accepted changes are re-checked
// from scratch (the AI allow-list again, the value rules again, the dependency closure) and then handed to the SAME
// drafts.saveDraft as a hand-made patch, which validates against the CURRENT head, runs the Git provider's scope guard and
// opens the draft pull request that CI checks. An editor cannot use this route to smuggle anything past the allow-list.
// Portable.

const { ApiError } = require("../errors");
const out = require("../ai/output");
const A = require("../ai/allowlist");
const policy = require("../ai/policy");
const prop = require("../ai/proposal");
const ctxMod = require("../ai/context");
const P = require("../../validate/pointer");
const drafts = require("./drafts");
const ids = require("./ids");
const text = require("./pr-text");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{40}$/;
const bad = (m) => new ApiError("bad_request", m);

function strictKeys(o, allowed, name) {
  if (!P.isPlainObject(o)) throw bad(name + " must be an object.");
  for (const k of Object.keys(o)) if (allowed.indexOf(k) < 0) throw bad("Unknown field " + JSON.stringify(k.slice(0, 30)) + " in " + name + ".");
}

function problem(code, file, path, message) { return { code, file: file || "", path: path || "", message }; }
function invalid(problems) { return new ApiError("validation_failed", "Some changes cannot be saved. Nothing was saved.", { problems }); }

function parseBody(body) {
  strictKeys(body, ["idempotencyKey", "proposal", "accept", "title"], "the request");
  if (!UUID_RE.test(String(body.idempotencyKey))) throw bad("idempotencyKey must be a UUID v4.");
  const pr = body.proposal;
  strictKeys(pr, ["id", "instructionHash", "instructionPreview", "base", "model", "changes"], "proposal");
  if (!/^p_[a-z0-9]{12}$/.test(String(pr.id))) throw bad("proposal.id is not valid.");
  if (!/^[0-9a-f]{16}$/.test(String(pr.instructionHash))) throw bad("proposal.instructionHash is not valid.");
  if (pr.instructionPreview !== undefined && typeof pr.instructionPreview !== "string") throw bad("proposal.instructionPreview must be text.");
  if (pr.model !== undefined && (typeof pr.model !== "string" || pr.model.length > 80)) throw bad("proposal.model is not valid.");
  strictKeys(pr.base, ["sha", "draftId", "headSha"], "proposal.base");
  if (!SHA.test(String(pr.base.sha))) throw bad("proposal.base.sha is not valid.");
  if (pr.base.draftId !== null && pr.base.draftId !== undefined) {
    if (!ids.parseId(pr.base.draftId)) throw bad("proposal.base.draftId is not valid.");
    if (!SHA.test(String(pr.base.headSha))) throw bad("proposal.base.headSha is required for a draft.");
  }
  if (!Array.isArray(pr.changes) || pr.changes.length < 1 || pr.changes.length > policy.CAPS.changes) throw bad("proposal.changes must be a list of 1 to " + policy.CAPS.changes + " changes.");
  let total = 0;
  const seen = new Set();
  pr.changes.forEach((c, i) => {
    strictKeys(c, ["id", "title", "ops"], "change " + (i + 1));
    if (!/^c[1-9][0-9]{0,2}$/.test(String(c.id)) || seen.has(c.id)) throw bad("change ids must be unique and look like c1.");
    seen.add(c.id);
    if (typeof c.title !== "string" || c.title.length > 200) throw bad("change " + (i + 1) + " needs a title.");
    if (!Array.isArray(c.ops) || c.ops.length < 1 || c.ops.length > policy.CAPS.opsPerChange) throw bad("change " + (i + 1) + " needs 1 to " + policy.CAPS.opsPerChange + " ops.");
    total += c.ops.length;
  });
  if (total > policy.CAPS.ops) throw bad("Too many changes at once.");
  if (!Array.isArray(body.accept) || body.accept.length < 1 || body.accept.length > pr.changes.length || body.accept.some((x) => typeof x !== "string")) throw bad("accept must list the changes to save.");
  if (new Set(body.accept).size !== body.accept.length) throw bad("accept lists a change twice.");
  for (const id of body.accept) if (!seen.has(id)) throw bad("accept names a change that is not in the proposal.");
  if (body.title !== undefined && (typeof body.title !== "string" || body.title.length > 80)) throw bad("title must be text of at most 80 characters.");
  return body;
}

async function accept(ctx, body, env) {
  const { deps, allow, cfg } = env;
  const audit = (action, outcome, ai) => env.audit(ctx, action, outcome, ai);
  if (!env.isEnabled()) {
    await audit("ai.denied", "denied", { codes: [cfg.enabled ? "no_key" : "disabled"] });
    throw new ApiError("ai_disabled", "AI help is switched off.");
  }
  const b = parseBody(body);
  const pr = b.proposal;
  const draftId = pr.base.draftId || undefined;
  const meta = { mode: "accept", instrHash: pr.instructionHash, model: String(pr.model || "").slice(0, 80) };

  // the value rules (no markup, no prototype keys, bounded depth) on everything the client sent
  const sc = out.scan(pr.changes);
  if (sc) { await audit("ai.accept", "denied", Object.assign({}, meta, { codes: [sc] })); throw invalid([problem("type", "", "/proposal", "These changes contain something that is not allowed.")]); }

  // the AI allow-list again, op by op, against the files as they are NOW
  let ref;
  if (draftId) {
    const parsed = ids.parseId(draftId);
    if (parsed.userKey !== ctx.userKey) throw new ApiError("not_found", "No such draft.");
    const head = await deps.git.getHead(parsed.branch);
    if (!head) throw new ApiError("not_found", "No such draft.");
    ref = head.sha;
  } else ref = (await deps.git.getHead(deps.git.getBaseBranch())).sha;
  const files = new Set();
  for (const c of pr.changes) for (const op of c.ops) if (P.isPlainObject(op) && typeof op.file === "string") files.add(op.file);
  const docs = await ctxMod.loadDocs(deps, ref, allow, files);
  const problems = [];
  pr.changes.forEach((c, ci) => c.ops.forEach((op) => {
    const code = out.opViolation(op, { mode: "edit", allow, docs }, { allowExpect: true, requireExpect: true });
    if (code) problems.push(problem(code === "markup_in_value" || code === "extra_field" || code === "bad_op_shape" ? "type" : "path_forbidden", P.isPlainObject(op) ? String(op.file || "").slice(0, 100) : "", P.isPlainObject(op) ? String(op.path || "").slice(0, 100) : "", "Change " + (ci + 1) + " is outside what AI help may change (" + code + ")."));
  }));
  if (problems.length) { await audit("ai.accept", "denied", Object.assign({}, meta, { codes: [...new Set(problems.map((p) => p.code))] })); throw invalid(problems.slice(0, 20)); }

  // the selection must be closed under "needs"
  const requires = prop.computeRequires(pr.changes);
  const idxOf = new Map(pr.changes.map((c, i) => [c.id, i]));
  const selected = new Set(b.accept.map((id) => idxOf.get(id)));
  const closed = prop.closure(requires, selected);
  for (const i of [...selected].sort((a, c) => a - c)) {
    const miss = requires[i].find((j) => !closed.has(j) || !selected.has(j));
    if (miss !== undefined) {
      await audit("ai.accept", "invalid", Object.assign({}, meta, { codes: ["selection_incomplete"] }));
      throw invalid([problem("type", "", "/accept", "Change " + (i + 1) + " also needs change " + (miss + 1) + ".")]);
    }
  }
  const order = [...selected].sort((a, c) => a - c);
  const ops = order.flatMap((i) => pr.changes[i].ops.map((o) => Object.assign({}, o)));
  const title = text.plain(b.title || pr.changes[order[0]].title || "AI draft", 80) || "AI draft";
  const patch = { idempotencyKey: b.idempotencyKey, title, ops, uploads: [] };
  if (draftId) { patch.draftId = draftId; patch.expectedHeadSha = pr.base.headSha; } else patch.baseSha = pr.base.sha;

  let r;
  try {
    r = await drafts.saveDraft(ctx, patch, { labels: ["studio-ai"], ai: { instructionPreview: pr.instructionPreview || "", model: meta.model, accepted: order.length, total: pr.changes.length, instrHash: pr.instructionHash } });
  } catch (e) {
    if (e instanceof ApiError) await audit("ai.accept", e.code === "validation_failed" ? "invalid" : e.code === "conflict" || e.code === "base_moved" || e.code === "draft_moved" ? "conflict" : "error", Object.assign({}, meta, { codes: [e.code] }));
    throw e;
  }
  await audit("ai.accept", "ok", Object.assign({}, meta, { changes: order.length, skipped: pr.changes.length - order.length, codes: [] }));
  const ai = { proposalId: pr.id, accepted: order.length, total: pr.changes.length };
  if (r.noop) return { status: 200, body: { noop: true, draft: r.draft, changes: [], replayed: false, warnings: r.warnings, ai } };
  return { status: r.replayed || draftId ? 200 : 201, body: { draft: r.draft, changes: r.changes, replayed: r.replayed, warnings: r.warnings, ai } };
}

module.exports = { accept, parseBody };
