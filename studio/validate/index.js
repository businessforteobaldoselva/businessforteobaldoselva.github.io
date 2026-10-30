"use strict";
// validatePatch: the whole pipeline of DESIGN section 6 in one call. Pure and portable: every read goes through
// the `ctx` readers the Git provider supplies (sync or async), nothing touches fs / path / process.
//
//   const r = await validatePatch(ctx, patch)
//   ctx = { schema, readText(path) -> string|null, hasFile(path) -> bool, readBytes?(path), listDir?(dir) -> [name]|null, reservedIds, now,
//           limits?, pagePermalinks?: Map<path, permalink>, pagePaths?: object }
//   r   = { ok, noop, problems, warnings, conflicts, files: Map<path, {before, after, beforeDoc, afterDoc}>,
//           uploads: [{ path, bytes, mime, existing }], changes: [Change], applied }
//
// Stages: 1 envelope, 2 scope, 3-4 pointers + apply, 5 fields (whole touched files), 6 uploads, 7 serialise,
// 8 post-conditions, 9 describe. A stage collects ALL its problems, then validation stops.

const { mk, key: problemKey } = require("./problem");
const scope = require("./scope");
const P = require("./pointer");
const { fileInfo } = require("./walk");
const { applyOps } = require("./ops");
const { validateDocument } = require("./fields");
const { validateUploads } = require("./images");
const { parseWithRanges, patchText, canon } = require("./jsontext");
const { parsePage, serializePage } = require("./pagefile");
const { describeApplied } = require("./describe");

const LIMITS = { ops: 200, uploads: 4, title: 80, depth: 20 };
const TOP_KEYS = new Set(["idempotencyKey", "draftId", "baseSha", "expectedHeadSha", "title", "ops", "uploads"]);
const OP_KEYS = new Set(["op", "file", "path", "from", "value", "expect"]);
const UP_KEYS = new Set(["id", "name", "contentType", "size", "dataBase64"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA_RE = /^[0-9a-f]{40}$/;
const OPS = new Set(["replace", "add", "remove", "move"]);

function depthOf(v, d) {
  if (d > LIMITS.depth + 2) return d;
  if (Array.isArray(v)) return v.reduce((m, x) => Math.max(m, depthOf(x, d + 1)), d);
  if (v && typeof v === "object") return Object.keys(v).reduce((m, k) => Math.max(m, depthOf(v[k], d + 1)), d);
  return d;
}

function envelope(patch, opts) {
  const problems = [];
  const bad = (code, path, msg, hint) => problems.push(mk(code, "", path, msg, hint));
  if (!P.isPlainObject(patch)) { bad("type", "", "The request must be a JSON object."); return problems; }
  for (const k of Object.keys(patch)) if (!TOP_KEYS.has(k)) bad("unknown_field", "/" + k, "Unknown field " + JSON.stringify(k.slice(0, 40)) + " in the request.");
  if (opts.requireKey !== false && !UUID_RE.test(String(patch.idempotencyKey))) bad("type", "/idempotencyKey", "idempotencyKey must be a UUID v4.");
  for (const k of ["baseSha", "expectedHeadSha"]) if (patch[k] !== undefined && !SHA_RE.test(String(patch[k]))) bad("type", "/" + k, k + " must be a 40-character commit id.");
  if (patch.title !== undefined && (typeof patch.title !== "string" || patch.title.length > LIMITS.title)) bad("too_large", "/title", "The title must be text of at most " + LIMITS.title + " characters.");
  if (patch.draftId !== undefined && !/^[a-z0-9]{1,16}--[a-z0-9][a-z0-9-]{1,50}$/.test(String(patch.draftId))) bad("type", "/draftId", "draftId is not valid.");
  const ops = patch.ops;
  const uploads = patch.uploads === undefined ? [] : patch.uploads;
  if (!Array.isArray(ops)) { bad("type", "/ops", "ops must be a list."); return problems; }
  if (ops.length > (opts.maxOps || LIMITS.ops)) bad("too_large", "/ops", "At most " + (opts.maxOps || LIMITS.ops) + " changes can be saved at once.");
  if (!Array.isArray(uploads)) { bad("type", "/uploads", "uploads must be a list."); return problems; }
  if (uploads.length > (opts.maxUploads || LIMITS.uploads)) bad("too_large", "/uploads", "At most " + (opts.maxUploads || LIMITS.uploads) + " pictures can be added at once.");
  if (depthOf(ops, 0) > LIMITS.depth) bad("too_large", "/ops", "The values are nested too deeply.");
  if (problems.length) return problems;
  ops.forEach((o, i) => {
    const at = "/ops/" + i;
    if (!P.isPlainObject(o)) { bad("type", at, "Change " + (i + 1) + " is not an object."); return; }
    for (const k of Object.keys(o)) if (!OP_KEYS.has(k)) bad("unknown_field", at + "/" + k, "Change " + (i + 1) + " has an unknown field " + JSON.stringify(k.slice(0, 30)) + ".");
    if (!OPS.has(o.op)) bad("type", at + "/op", "Change " + (i + 1) + ": the operation must be replace, add, remove or move.");
    if (typeof o.file !== "string") bad("type", at + "/file", "Change " + (i + 1) + " has no file.");
    if (typeof o.path !== "string") bad("type", at + "/path", "Change " + (i + 1) + " has no path.");
    if (o.op === "move" && typeof o.from !== "string") bad("type", at + "/from", "Change " + (i + 1) + ": move needs a from.");
    if (o.op !== "move" && o.from !== undefined) bad("unknown_field", at + "/from", "Change " + (i + 1) + ": from is only for move.");
    if ((o.op === "replace" || o.op === "add") && !Object.prototype.hasOwnProperty.call(o, "value")) bad("type", at + "/value", "Change " + (i + 1) + " needs a value.");
    if ((o.op === "remove" || o.op === "move") && Object.prototype.hasOwnProperty.call(o, "value")) bad("unknown_field", at + "/value", "Change " + (i + 1) + ": " + o.op + " takes no value.");
  });
  uploads.forEach((u, i) => {
    if (!P.isPlainObject(u)) { bad("type", "/uploads/" + i, "Upload " + (i + 1) + " is not an object."); return; }
    for (const k of Object.keys(u)) if (!UP_KEYS.has(k)) bad("unknown_field", "/uploads/" + i + "/" + k, "Upload " + (i + 1) + " has an unknown field.");
    if (typeof u.id !== "string" || !/^[A-Za-z0-9_-]{1,32}$/.test(u.id)) bad("type", "/uploads/" + i + "/id", "Upload " + (i + 1) + " needs an id.");
  });
  const ids = uploads.map((u) => u && u.id);
  if (new Set(ids).size !== ids.length) bad("type", "/uploads", "Upload ids must be unique.");
  return problems;
}

const failed = (problems, extra) => Object.assign({ ok: false, noop: false, problems, warnings: [], conflicts: [], files: new Map(), uploads: [], changes: [], applied: [] }, extra || {});

async function validatePatch(ctx, patch, opts) {
  const o = opts || {};
  const schema = ctx.schema;
  const env = envelope(patch, o);
  if (env.length) return failed(env);

  // ---- stage 2: scope
  const scopeProblems = [];
  const files = [];
  const seen = new Set();
  for (const op of patch.ops) {
    if (!seen.has(op.file)) { seen.add(op.file); files.push(op.file); }
  }
  const lower = new Map();
  for (const f of files) {
    const kind = scope.classify(f);
    if (kind !== "data" && kind !== "page") { scopeProblems.push(mk("path_forbidden", String(f).slice(0, 100), "", "Studio is not allowed to change " + JSON.stringify(String(f).slice(0, 80)) + ".", "Only website content (data files and pages) and new pictures can be changed here.")); continue; }
    if (lower.has(f.toLowerCase())) scopeProblems.push(mk("path_forbidden", f, "", "The same file is named twice with different capitals."));
    lower.set(f.toLowerCase(), f);
    if (!fileInfo(schema, f)) scopeProblems.push(mk("path_forbidden", f, "", "The editor does not manage " + f + "."));
  }
  if (scopeProblems.length) return failed(scopeProblems);

  const heads = new Map(); // path -> { info, text, doc, ast?, eol? }
  for (const f of files) {
    const text = await ctx.readText(f);
    if (typeof text !== "string") { scopeProblems.push(mk("path_forbidden", f, "", "That file does not exist, and Studio cannot create files.")); continue; }
    const info = fileInfo(schema, f);
    try {
      if (info.kind === "data") { const ast = parseWithRanges(text); heads.set(f, { info, text, ast, doc: ast.value }); }
      else { const pg = parsePage(text); heads.set(f, { info, text, doc: pg.doc, eol: pg.eol }); }
    } catch (e) { scopeProblems.push(mk("encoding", f, "", "The file on the draft cannot be read: " + String(e.message).slice(0, 120) + ".")); }
  }
  if (scopeProblems.length) return failed(scopeProblems);

  // ---- stage 3-4: pointers + apply on clones
  const work = new Map();
  for (const [f, h] of heads) work.set(f, { info: h.info, doc: structuredClone(h.doc) });
  const ap = applyOps(schema, patch.ops, work);
  if (ap.conflicts.length) return failed([], { conflicts: ap.conflicts });
  if (ap.problems.length) return failed(ap.problems);

  // ---- stage 5: whole-file field validation, head problems become warnings
  const problems = [];
  const warnings = [];
  const refs = [];
  for (const f of ap.touched) {
    const h = heads.get(f);
    const after = work.get(f).doc;
    const headRes = validateDocument(ctx, h.info, h.doc, h.doc);
    const headKeys = new Set(headRes.problems.map(problemKey));
    const res = validateDocument(ctx, h.info, after, h.doc);
    for (const p of res.problems) (headKeys.has(problemKey(p)) ? warnings : problems).push(p);
    for (const w of res.warnings) warnings.push(w);
    for (const r of res.refs) refs.push(Object.assign({ file: f }, r));
  }

  // ---- stage 6: uploads, and every picture the patch points at must exist
  const up = await validateUploads(patch.uploads || [], ctx, o.maxImageBytes);
  problems.push(...up.problems);
  const uploadByName = new Map(up.files.map((u) => [u.name, u]));
  const referenced = new Set();
  for (const r of refs) {
    if (!r.changed) continue;
    if (r.dir === "images" && uploadByName.has(r.name)) { referenced.add(r.name); continue; }
    if (!(await ctx.hasFile(r.path))) problems.push(mk("image", r.file, r.ptr, "The picture " + r.path + " does not exist on the website.", "Pick a picture from the library or upload a new one."));
  }
  for (const u of up.files) if (!referenced.has(u.name)) problems.push(mk("image", u.path, "uploads/" + u.id, "The picture " + u.name + " is not used by any change.", "Remove it or use it in a change."));
  if (problems.length) return failed(problems, { warnings });

  // ---- stage 7: serialise (format-preserving) and prove it parses back to the intended value
  const out = new Map();
  for (const f of ap.touched) {
    const h = heads.get(f);
    const afterDoc = work.get(f).doc;
    if (canon(h.doc) === canon(afterDoc)) continue; // net no-op for this file: do not rewrite it
    let text;
    try {
      if (h.info.kind === "data") {
        text = patchText(h.text, h.ast, afterDoc);
        if (canon(parseWithRanges(text).value) !== canon(afterDoc)) throw new Error("the JSON did not round-trip");
      } else {
        text = serializePage(afterDoc, h.eol);
        if (canon(parsePage(text).doc) !== canon(afterDoc)) throw new Error("the front matter did not round-trip");
      }
    } catch (e) { return failed([mk("encoding", f, "", "The change could not be written safely: " + String(e.message).slice(0, 120) + ".")], { warnings }); }
    out.set(f, { before: h.text, after: text, beforeDoc: h.doc, afterDoc });
  }
  // ---- stage 8: post-conditions
  for (const f of out.keys()) if (!scope.isInScope(f)) return failed([mk("path_forbidden", f, "", "Out of scope.")], { warnings });
  const uploadsOut = up.files.filter((u) => !u.existing).map((u) => ({ path: u.path, bytes: u.bytes, mime: u.mime, id: u.id }));
  if (!out.size && !uploadsOut.length) return { ok: true, noop: true, problems: [], warnings, conflicts: [], files: out, uploads: [], changes: [], applied: ap.applied };

  // ---- stage 9: describe
  const beforeDocs = new Map([...heads].map(([f, h]) => [f, h.doc]));
  const afterDocs = new Map([...work].map(([f, w]) => [f, w.doc]));
  const changes = describeApplied(schema, beforeDocs, afterDocs, ap.applied);
  return { ok: true, noop: false, problems: [], warnings, conflicts: [], files: out, uploads: uploadsOut, changes, applied: ap.applied };
}

module.exports = { validatePatch, envelope, LIMITS };
