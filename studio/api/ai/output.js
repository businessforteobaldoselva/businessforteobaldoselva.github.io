"use strict";
// Strict parsing of the model's answer (AI-DESIGN 7.3). The answer is HOSTILE input. This is Gate 1: anything that is
// not exactly the expected shape, or that names something outside the AI allow-list, rejects the WHOLE answer. Gate 2
// (the Phase 4 validator) runs later, in the service, and drops single changes.
//
//   parseModelOutput(res, ctx) -> { ok:true, kind, summary, ... } | { ok:false, violations:[{code, where}] }
//   res = ProviderResult { toolInputs, text, stopReason }
//   ctx = { mode, allow, docs: Map<file, doc>, filesSent?: Set<file>, requireExpect?: boolean }
// Pure, portable.

const policy = require("./policy");
const T = require("./tool-schema");
const A = require("./allowlist");
const P = require("../../validate/pointer");
const grammar = require("../../markers/grammar");
const chars = require("./chars");

const CAPS = policy.CAPS;
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// ---- structure: JSON only, bounded ------------------------------------------------------------------------------------
// -> null | violation code
function scan(root) {
  let json;
  try { json = JSON.stringify(root); } catch (e) { return "not_json"; }
  if (typeof json !== "string") return "not_json";
  if (json.length > CAPS.outputChars) return "too_large";
  let nodes = 0;
  const stack = [[root, 1]];
  while (stack.length) {
    const [v, depth] = stack.pop();
    nodes += 1;
    if (nodes > CAPS.nodes) return "too_large";
    if (depth > CAPS.depth + 4) return "too_large";
    if (v === null || typeof v === "boolean") continue;
    if (typeof v === "number") { if (!Number.isFinite(v)) return "not_json"; continue; }
    if (typeof v === "string") {
      if (chars.BAD_CHARS.test(v)) return "markup_in_value";
      continue;
    }
    if (Array.isArray(v)) { for (const x of v) stack.push([x, depth + 1]); continue; }
    if (P.isPlainObject(v)) {
      for (const k of Object.keys(v)) {
        if (P.FORBIDDEN_SEGS.has(k)) return "proto_key";
        if (chars.BAD_CHARS.test(k)) return "markup_in_value";
        stack.push([v[k], depth + 1]);
      }
      continue;
    }
    return "not_json";
  }
  return null;
}

// does any string inside `v` carry markup or a script scheme? -> null | "markup_in_value"
function markupIn(v, depth) {
  if (typeof v === "string") return policy.MARKUP_RE.test(v.replace(policy.BR_RE, " ")) || policy.SCHEME_RE.test(v) ? "markup_in_value" : null;
  if (depth > 10) return "too_large";
  if (Array.isArray(v)) { for (const x of v) { const r = markupIn(x, depth + 1); if (r) return r; } return null; }
  if (v && typeof v === "object") { for (const k of Object.keys(v)) { const r = markupIn(v[k], depth + 1); if (r) return r; } }
  return null;
}

// a label shown in the panel: no angle brackets, one line, capped
function label(s, cap) {
  return String(s).replace(/[<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, cap);
}

function keysOk(obj, spec) {
  if (!P.isPlainObject(obj)) return "bad_op_shape";
  for (const k of Object.keys(obj)) if (spec.required.indexOf(k) < 0 && spec.optional.indexOf(k) < 0) return "extra_field";
  for (const k of spec.required) if (!own(obj, k)) return "bad_op_shape";
  return null;
}

// ---- one op ------------------------------------------------------------------------------------------------------------
// -> null | violation code.  opts.allowExpect: the accept route (Editor-submitted ops carry server-made expect)
function opViolation(op, ctx, opts) {
  const o = opts || {};
  if (!P.isPlainObject(op)) return "bad_op_shape";
  if (!o.allowExpect && own(op, "expect")) return "expect_supplied";
  for (const k of Object.keys(op)) if (T.OP_KEYS.required.indexOf(k) < 0 && T.OP_KEYS.optional.indexOf(k) < 0 && !(o.allowExpect && k === "expect")) return "extra_field";
  if (typeof op.op !== "string" || T.OPS.indexOf(op.op) < 0) return own(op, "op") ? "unknown_op" : "bad_op_shape";
  if (typeof op.file !== "string" || typeof op.path !== "string") return "bad_op_shape";
  const kind = op.op;
  if ((kind === "replace" || kind === "add") && !own(op, "value")) return "bad_op_shape";
  if ((kind === "remove" || kind === "move") && own(op, "value")) return "bad_op_shape";
  if (kind === "move" ? typeof op.from !== "string" : own(op, "from")) return "bad_op_shape";
  if (o.allowExpect && o.requireExpect && (kind === "replace" || kind === "remove") && !own(op, "expect")) return "bad_op_shape";
  if (o.allowExpect && own(op, "expect") && kind !== "replace" && kind !== "remove") return "bad_op_shape";

  const doc = ctx.docs.get(op.file);
  const mopts = { op: kind, mode: ctx.mode, filesSent: ctx.filesSent };
  const m = A.matchTarget(ctx.allow, op.file, op.path, doc, mopts);
  if (!m.ok) return m.code;
  if (kind === "move") {
    const f = A.matchTarget(ctx.allow, op.file, op.from, doc, mopts);
    if (!f.ok) return f.code;
    if (f.target.template !== m.target.template) return "bad_op_shape";
    const pp = (s) => s.slice(0, s.lastIndexOf("/"));
    if (pp(op.from) !== pp(op.path)) return "bad_op_shape";
    return null;
  }
  if (kind === "remove") return null;
  if (kind === "replace" || !m.list) {
    if (op.value !== null && typeof op.value === "object") return "bad_op_shape";
  } else {
    const code = A.checkAddedValue(ctx.allow, op.file, m.target.template, op.value);
    if (code) return code;
  }
  return markupIn(op.value, 0);
}

// a flat op list (with global indexes for the violation report) -> pushes violations
function checkOps(ops, base, ctx, add, seen, opts) {
  ops.forEach((op, i) => {
    const where = base + i;
    const c = opViolation(op, ctx, opts);
    if (c) { add(c, where); return; }
    if (op.op === "move" || (op.op === "add" && /\/-$/.test(op.path))) return;
    const key = op.file + "\u0000" + op.path;
    if (seen.has(key)) add("duplicate_pointer", where); else seen.add(key);
  });
}

const cleanOp = (op) => {
  const o = { op: op.op, file: op.file, path: op.path };
  if (op.from !== undefined) o.from = op.from;
  if (op.value !== undefined) o.value = structuredClone(op.value);
  if (op.expect !== undefined) o.expect = structuredClone(op.expect);
  return o;
};

const squash = (s) => String(s).replace(/\s+/g, " ").trim();

// ---- the whole answer ----------------------------------------------------------------------------------------------------
function parseModelOutput(res, ctx) {
  const violations = [];
  const add = (code, where) => { if (violations.length < CAPS.violations) violations.push({ code, where: where === undefined ? "output" : where }); };
  const fail = () => ({ ok: false, violations });

  if (!res || !Array.isArray(res.toolInputs)) { add("prose_not_tool"); return fail(); }
  if (res.stopReason === "max_tokens") { add("max_tokens"); return fail(); }
  if (res.toolInputs.length === 0) { add("prose_not_tool"); return fail(); }
  if (res.toolInputs.length > 1) { add("multiple_tool_calls"); return fail(); }
  const out = res.toolInputs[0];
  const sc = scan(out);
  if (sc) { add(sc); return fail(); }
  if (!P.isPlainObject(out) || typeof out.kind !== "string" || !own(T.KINDS, out.kind)) { add(P.isPlainObject(out) && own(out, "kind") ? "unknown_kind" : "bad_op_shape"); return fail(); }
  const kind = out.kind;
  if ((T.KINDS_BY_MODE[ctx.mode] || []).indexOf(kind) < 0) { add("wrong_kind_for_mode"); return fail(); }
  const ke = keysOk(out, T.KINDS[kind]);
  if (ke) { add(ke); return fail(); }
  if (typeof out.summary !== "string") { add("bad_op_shape"); return fail(); }
  const result = { ok: true, kind, summary: label(out.summary, CAPS.summary), dropped: 0 };

  if (kind === "clarify") {
    if (typeof out.question !== "string" || !out.question.trim()) { add("bad_op_shape"); return fail(); }
    result.question = label(out.question, CAPS.question);
    return result;
  }

  if (kind === "needs_code") {
    const r = out.request;
    const rk = keysOk(r, T.REQUEST_KEYS);
    if (rk) { add(rk); return fail(); }
    if (typeof out.reason !== "string" || ["title", "body", "where", "priority"].some((k) => typeof r[k] !== "string")) { add("bad_op_shape"); return fail(); }
    if (T.PRIORITIES.indexOf(r.priority) < 0) { add("bad_op_shape"); return fail(); }
    result.reason = label(out.reason, CAPS.reason);
    result.request = { title: label(r.title, CAPS.title), body: String(r.body).replace(/[<>]/g, " ").trim().slice(0, CAPS.requestBody), where: label(r.where, CAPS.where), priority: r.priority };
    return result;
  }

  const seen = new Set();
  if (kind === "patch") {
    if (!Array.isArray(out.changes)) { add("bad_op_shape"); return fail(); }
    if (out.changes.length > CAPS.changes) { add("too_many"); return fail(); }
    let total = 0;
    const changes = [];
    let base = 0;
    for (const ch of out.changes) {
      const ck = keysOk(ch, T.CHANGE_KEYS);
      if (ck || typeof ch.title !== "string" || !Array.isArray(ch.ops) || ch.ops.length < 1) { add(ck || "bad_op_shape", base); continue; }
      if (ch.ops.length > CAPS.opsPerChange) { add("too_many", base); continue; }
      total += ch.ops.length;
      if (total > CAPS.ops) { add("too_many"); break; }
      checkOps(ch.ops, base, ctx, (c, w) => add(c, w), seen, { allowExpect: false });
      changes.push({ title: label(ch.title, CAPS.title) || "Change", ops: ch.ops.map(cleanOp) });
      base += ch.ops.length;
    }
    if (violations.length) return fail();
    result.changes = changes;
    return result;
  }

  // tone
  if (T.OVERALL.indexOf(out.overall) < 0 || !Array.isArray(out.findings)) { add("bad_op_shape"); return fail(); }
  if (out.findings.length > CAPS.findings) { add("too_many"); return fail(); }
  const findings = [];
  let base = 0;
  for (const f of out.findings) {
    const fk = keysOk(f, T.FINDING_KEYS);
    if (fk || ["path", "quote", "issue", "suggestion"].some((k) => typeof f[k] !== "string")) { add(fk || "bad_op_shape", base); continue; }
    let fix = null;
    if (own(f, "fix")) {
      const xk = keysOk(f.fix, T.FIX_KEYS);
      if (xk || typeof f.fix.title !== "string" || !Array.isArray(f.fix.ops) || f.fix.ops.length < 1) { add(xk || "bad_op_shape", base); continue; }
      if (f.fix.ops.length > CAPS.opsPerChange) { add("too_many", base); continue; }
      checkOps(f.fix.ops, base, ctx, (c, w) => add(c, w), seen, { allowExpect: false });
      base += f.fix.ops.length;
      fix = { title: label(f.fix.title, CAPS.title) || "Change", ops: f.fix.ops.map(cleanOp) };
    }
    // the quote must really be in the current text at that place, else the finding is dropped (a model cannot invent evidence)
    const loc = grammar.locate(f.path);
    let current;
    if (loc) {
      const m = A.matchTarget(ctx.allow, loc.filePath, loc.pointer, ctx.docs.get(loc.filePath), { op: "replace", mode: "tone_check", filesSent: ctx.filesSent });
      if (m.ok) { try { current = P.get(ctx.docs.get(loc.filePath), P.parse(loc.pointer)); } catch (e) { current = undefined; } }
    }
    const quote = squash(f.quote).slice(0, CAPS.quote);
    if (typeof current !== "string" || !quote || squash(current).indexOf(quote) < 0) { result.dropped += 1; if (fix) { /* its ops were checked above, but without evidence there is no finding */ } continue; }
    findings.push({ ref: f.path, file: loc.filePath, pointer: loc.pointer, quote, issue: label(f.issue, CAPS.issue), suggestion: label(f.suggestion, CAPS.suggestion), fix });
  }
  if (violations.length) return fail();
  result.overall = out.overall;
  result.findings = findings;
  return result;
}

module.exports = { parseModelOutput, opViolation, scan, markupIn, label, cleanOp };
