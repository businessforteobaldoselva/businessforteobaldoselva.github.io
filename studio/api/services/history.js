"use strict";
// History + Restore (studio/DESIGN.md 7.4 / 7.6). Transport-free: routes (unit B's router) call these two functions.
//
//   const svc = createHistoryService({ git, drafts, parseFile, describeOps, baseBranch });
//   svc.list(user, token, { limit, cursor })                  -> { items: [HistoryItem], next }
//   svc.restore(user, token, prNumber, { onConflict, idempotencyKey }) -> { draft, changes, skipped, warnings }
//
// SECURITY: this module never writes to Git by itself. The ONLY write path is drafts.createFromOps(), which runs the
// same validation pipeline as every other draft and lands on a studio/ branch (never main). Restore therefore cannot
// touch anything a normal draft cannot. check-history.js enforces that no git write method is referenced here.

const diff = require("./history-diff");

class HistoryError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = "HistoryError";
    this.status = status;
    this.code = code;
    this.details = details || {};
  }
}

// The same three rules as studio/validate/scope.js (the single definition lives there; keep in sync).
// Image files are listed in History but never diffed.
const DATA_RE = /^src\/_data\/[a-z0-9-]+\.json$/;
const PAGE_RE = /^src\/pages\/[a-z0-9-]+\.md$/;
const IMAGE_RE = /^images\/[A-Za-z0-9][A-Za-z0-9._-]{0,79}\.(jpg|jpeg|png|webp|gif|avif|svg)$/;
const isDocFile = (p) => DATA_RE.test(p) || PAGE_RE.test(p);
const inScope = (p) => isDocFile(p) || IMAGE_RE.test(p);

const MARKER_RE = /<!-- studio:v1 (\{[^\r\n]{0,2000}\}) -->/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function clean(s, max) {
  return String(s == null ? "" : s).replace(/[\u0000-\u0008\u000B-\u001F\u007F‪-‮⁦-⁩]/g, "").slice(0, max || 200);
}

// Strict: unknown shape => null (the PR is then treated as a plain GitHub/Decap one).
function parseMarker(body) {
  const m = MARKER_RE.exec(String(body || ""));
  if (!m) return null;
  let j;
  try { j = JSON.parse(m[1]); } catch (e) { return null; }
  if (!j || typeof j !== "object" || Array.isArray(j)) return null;
  if (typeof j.authorId !== "string" || !UUID_RE.test(j.authorId)) return null;
  if (typeof j.authorName !== "string" || !j.authorName || j.authorName.length > 80) return null;
  if (typeof j.draftId !== "string" || !/^[a-z0-9-]{3,80}$/.test(j.draftId)) return null;
  const revertOf = j.revertOf === null || j.revertOf === undefined ? null : j.revertOf;
  if (revertOf !== null && !(Number.isInteger(revertOf) && revertOf > 0)) return null;
  return { authorId: j.authorId, authorName: clean(j.authorName, 80), draftId: j.draftId, revertOf };
}

function authorOf(item, marker) {
  if (marker) return { name: marker.authorName, via: "studio" };
  const via = typeof item.headRef === "string" && item.headRef.startsWith("cms/") ? "decap" : "github";
  return { name: clean(item.authorLogin || "unknown", 80), via };
}

// "Studio: Make the hero friendlier (Molly)" -> "Make the hero friendlier"; other titles are kept as they are.
function cleanTitle(t) {
  const s = clean(t, 200);
  const r = /^Studio:\s*(.*?)(\s*\([^()]{1,40}\))?$/.exec(s);
  return (r ? r[1] : s) || "Untitled change";
}

function createHistoryService(deps) {
  const git = deps.git;
  const drafts = deps.drafts;
  const baseBranch = deps.baseBranch || "main";
  const describeOps = deps.describeOps || null; // (ops, ctx) -> Change[] (unit B's describe.js)
  const parseFile = deps.parseFile || defaultParseFile;
  const maxDiffFiles = deps.maxDiffFiles || 4;

  async function readDoc(ref, path) {
    const text = await git.readTextFile(ref, path);
    return text == null ? null : parseFile(path, text);
  }

  async function opsFor(item) {
    const ops = [];
    for (const file of (item.files || []).filter(isDocFile)) {
      const before = await readDoc(item.parentSha, file);
      const after = await readDoc(item.mergeSha, file);
      if (before == null || after == null) continue; // file added/removed by that PR: out of scope for restore
      ops.push(...diff.invertDiff({ file, before, after }));
    }
    return ops;
  }

  function toItem(raw, changes) {
    const marker = parseMarker(raw.body);
    const files = (raw.files || []).filter(inScope);
    return {
      number: raw.number,
      title: cleanTitle(raw.title),
      mergedAt: raw.mergedAt,
      sha: raw.mergeSha,
      url: raw.url || null,
      author: authorOf(raw, marker),
      mergedBy: raw.mergedByLogin ? clean(raw.mergedByLogin, 80) : null,
      files,
      changes: changes || null,
      restorable: files.some(isDocFile) && !!raw.parentSha,
      revertOf: marker ? marker.revertOf : null,
    };
  }

  async function list(user, token, opts) {
    const limit = Math.max(1, Math.min(50, ((opts && opts.limit) | 0) || 20));
    const page = await git.listMerged({ limit, cursor: opts && opts.cursor ? String(opts.cursor) : undefined });
    const items = [];
    for (const raw of page.items || []) {
      if (!(raw.files || []).some(inScope)) continue; // only changes that touch content
      let changes = null;
      if (describeOps && raw.parentSha && (raw.files || []).filter(isDocFile).length <= maxDiffFiles) {
        try { changes = describeOps(await opsFor(raw), { item: raw }) || null; } catch (e) { changes = null; }
      }
      items.push(toItem(raw, changes));
    }
    return { items, next: page.next || null };
  }

  // Can this inverse op still be applied to the CURRENT document? (pointer-level conflict test)
  function stillApplies(doc, op) {
    if (doc == null) return false;
    const here = diff.getAt(doc, op.path);
    if (op.op === "replace" || op.op === "remove") return here.found && diff.deepEqual(here.value, op.expect);
    if (op.op === "add") {
      const parentPtr = op.path.slice(0, op.path.lastIndexOf("/"));
      const parent = diff.getAt(doc, parentPtr);
      if (parent.found && Array.isArray(parent.value)) return true; // positional: a wrong index fails validation anyway
      return !here.found || diff.deepEqual(here.value, op.value);
    }
    return op.op === "move";
  }

  async function restore(user, token, prNumber, opts) {
    const o = opts || {};
    const onConflict = o.onConflict === "skip" ? "skip" : "abort";
    if (!Number.isInteger(prNumber) || prNumber < 1) throw new HistoryError(400, "bad_request", "That change number is not valid.");
    const raw = await git.getMergedPr(prNumber);
    if (!raw || !(raw.files || []).some(isDocFile) || !raw.parentSha) throw new HistoryError(404, "not_found", "That change is not in the history.");
    const original = await opsFor(raw);
    if (!original.length) throw new HistoryError(409, "conflict", "That change has nothing that can be undone.", { items: [] });

    // Walk the inverse ops against CURRENT main, checking every `expect` as we go (indexes shift as ops apply).
    const docs = new Map();
    const keep = [];
    const skipped = [];
    const conflicts = [];
    for (const op of original) {
      if (!docs.has(op.file)) docs.set(op.file, await readDoc(baseBranch, op.file));
      const doc = docs.get(op.file);
      if (stillApplies(doc, op) && diff.applyOp(doc, op)) keep.push(op);
      else (onConflict === "skip" ? skipped : conflicts).push({ file: op.file, path: op.path, op: op.op });
    }
    if (conflicts.length) throw new HistoryError(409, "conflict", "Someone has changed some of these parts since. Nothing was restored.", { items: conflicts });
    if (!keep.length) throw new HistoryError(409, "conflict", "Everything that change touched has been edited since, so there is nothing left to undo.", { items: skipped });

    const title = 'Restore: undo "' + cleanTitle(raw.title).slice(0, 50) + '" (#' + prNumber + ")";
    const res = await drafts.createFromOps({
      user, token, title, ops: keep, uploads: [], labels: ["studio-draft", "studio-revert"], revertOf: prNumber, idempotencyKey: o.idempotencyKey,
    });
    return { draft: res.draft, changes: res.changes || [], skipped, warnings: res.warnings || [] };
  }

  return { list, restore };
}

// Front matter + body -> { ...frontMatter, _body }; JSON files are parsed as they are.
function defaultParseFile(path, text) {
  const t = String(text).replace(/\r\n/g, "\n");
  if (path.endsWith(".json")) return JSON.parse(t);
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(t);
  if (!m) throw new Error("page has no front matter: " + path);
  const yaml = require("js-yaml");
  const fm = yaml.load(m[1], { schema: yaml.JSON_SCHEMA }) || {};
  fm._body = m[2];
  return fm;
}

module.exports = { createHistoryService, HistoryError, parseMarker, cleanTitle, inScope, isDocFile };
