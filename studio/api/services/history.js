"use strict";
// History (merged changes) and Restore (opens a revert draft). DESIGN 7.4 / 7.6. Portable.

const { ApiError } = require("../errors");
const { validatePatch } = require("../../validate");
const { parseWithRanges } = require("../../validate/jsontext");
const { parsePage } = require("../../validate/pagefile");
const { describeApplied } = require("../../validate/describe");
const { labelFor } = require("../../validate/walk");
const P = require("../../validate/pointer");
const scope = require("../../validate/scope");
const text = require("./pr-text");
const { invertDiff } = require("./history-diff");
const { diffOps } = require("../../validate/diff");
const drafts = require("./drafts");

const inScope = (p) => scope.classify(p) !== null;

function parseDoc(path, t) {
  return /\.json$/.test(path) ? parseWithRanges(t).value : parsePage(t).doc;
}

function authorOf(item) {
  const marker = text.parseMarker(item.body);
  if (marker) return { author: { name: marker.authorName, via: "studio" }, revertOf: marker.revertOf };
  const via = /^cms\//.test(item.headRef || "") ? "decap" : "github";
  return { author: { name: text.oneLine(item.authorLogin || "someone", 40), via }, revertOf: null };
}

async function changesOfMerged(deps, item) {
  const before = new Map();
  const after = new Map();
  const applied = [];
  for (const f of item.files.filter((p) => ["data", "page"].indexOf(scope.classify(p)) >= 0).slice(0, 20)) {
    const a = await deps.git.readTextFile(item.parentSha, f);
    const b = await deps.git.readTextFile(item.mergeSha, f);
    if (a === null || b === null) continue;
    try {
      const da = parseDoc(f, a);
      const db = parseDoc(f, b);
      before.set(f, da);
      after.set(f, db);
      for (const op of diffOps(f, da, db)) applied.push({ op: op.op, file: f, segs: P.parse(op.path), before: op.expect, after: op.value });
    } catch (e) { /* unreadable: left out */ }
  }
  const pics = item.files.filter((p) => scope.classify(p) === "image").map((p) => ({ file: p, path: "", op: "add", label: "Pictures", summary: "Added the picture " + p.replace(/^images\//, ""), kind: "image" }));
  return describeApplied(deps.schema, before, after, applied.slice(0, 100)).concat(pics);
}

async function listHistory(ctx, { limit, cursor }) {
  const deps = ctx.deps;
  const want = Math.max(1, Math.min(50, Number(limit) || 20));
  const items = [];
  let next = cursor || null;
  for (let round = 0; round < 5 && items.length < want; round += 1) {
    const page = await deps.git.listMerged({ limit: want, cursor: next });
    for (const it of page.items) {
      const files = it.files.filter(inScope);
      if (!files.length) continue;
      const { author, revertOf } = authorOf(it);
      let changes = null;
      try { changes = await changesOfMerged(deps, it); } catch (e) { changes = null; }
      const restorable = it.files.some((p) => ["data", "page"].indexOf(scope.classify(p)) >= 0);
      items.push({ number: it.number, title: text.oneLine(it.title, 120), mergedAt: it.mergedAt, sha: it.mergeSha, url: deps.git.prUrl ? deps.git.prUrl(it.number) : null, author, mergedBy: it.mergedByLogin ? text.oneLine(it.mergedByLogin, 40) : null, files, changes, restorable, revertOf });
      if (items.length >= want) break;
    }
    next = page.next;
    if (!next) break;
  }
  return { items, next };
}

async function restore(ctx, prNumber, { onConflict, idempotencyKey }) {
  const deps = ctx.deps;
  const git = deps.git;
  if (onConflict !== "abort" && onConflict !== "skip") throw new ApiError("bad_request", "onConflict must be abort or skip.");
  const item = await git.getMergedPr(prNumber);
  if (!item || !item.files.some(inScope)) throw new ApiError("not_found", "That change is not in the history.");
  const baseBranch = git.getBaseBranch();
  const mainHead = (await git.getHead(baseBranch)).sha;

  let ops = [];
  for (const f of item.files.filter((p) => ["data", "page"].indexOf(scope.classify(p)) >= 0)) {
    const a = await git.readTextFile(item.parentSha, f);
    const b = await git.readTextFile(item.mergeSha, f);
    if (a === null || b === null) throw new ApiError("conflict", "A file this change touched has been removed, so it cannot be undone automatically.", { items: [{ file: f }] });
    ops.push(...invertDiff(f, parseDoc(f, a), parseDoc(f, b)));
  }
  if (!ops.length) throw new ApiError("not_found", "This change has nothing that can be undone.");

  const skipped = [];
  const vctx = drafts.validatorCtx(deps, mainHead);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const r = await validatePatch(vctx, { idempotencyKey, baseSha: mainHead, ops, uploads: [] }, { maxOps: 100000 });
    if (!r.conflicts.length) break;
    if (onConflict === "abort") throw new ApiError("conflict", "Some of these settings were changed after that edit, so it cannot be undone cleanly.", { items: r.conflicts });
    const drop = new Set(r.conflicts.map((c) => c.op));
    for (const c of r.conflicts) {
      const t = await git.readTextFile(mainHead, c.file);
      let label = c.path;
      try { label = labelFor(deps.schema, c.file, P.parse(c.path), parseDoc(c.file, t)); } catch (e) { /* keep the pointer */ }
      skipped.push({ file: c.file, path: c.path, op: "replace", label: text.oneLine(label, 100), summary: "Left as it is now: it was changed again after this edit", kind: "text" });
    }
    ops = ops.filter((o, i) => !drop.has(i));
    if (!ops.length) throw new ApiError("conflict", "Everything this edit changed has been changed again since.", { items: r.conflicts });
  }

  const made = await drafts.createFromOps({
    deps, user: ctx.user, token: ctx.token, role: ctx.role, requestId: ctx.requestId,
    title: 'Restore: undo "' + text.oneLine(item.title, 40) + '" (#' + prNumber + ")",
    ops, uploads: [], labels: ["studio-draft", "studio-revert"], revertOf: prNumber, idempotencyKey,
  });
  deps.audit.write({ requestId: ctx.requestId, actor: { id: ctx.user.id, email: ctx.user.email, role: ctx.role }, action: "history.restore", target: { pr: prNumber, draftId: made.draft && made.draft.id }, outcome: "ok", ops: ops.length, files: [...new Set(ops.map((o) => o.file))] });
  return { draft: made.draft, changes: made.changes, skipped, warnings: made.warnings, replayed: made.replayed };
}

module.exports = { listHistory, restore, authorOf };
