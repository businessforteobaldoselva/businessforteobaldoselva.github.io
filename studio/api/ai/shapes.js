"use strict";
// Runtime validators for the shapes of AI-DESIGN 5 (Status, Proposal, Change, Delta, Rendered, Finding, Accept response).
// CORE runs them on everything it returns (a shape bug becomes a 500, never a malformed 200); tests run them on the shared
// sample file and on real output. The overlay never imports this file (it mirrors the shapes in ai-view.js).
//
//   AiStatus   { enabled, reason, provider, model, vision, modes[], limits{}, usage{} }
//   Proposal   { id, kind, mode, summary, base{sha,draftId,headSha}, instructionHash, model, provider, changes[Change],
//                skipped[], needsCode, question, findings[Finding], warnings[], usage{inTok,outTok,latencyMs} }
//   Change     { id, title, ops[Op], deltas[Delta], requires[], outsideAsk, sensitive, defaultChecked }
//   Delta      { file, path, ref, op, kind, label, before, after, diff }
//   Rendered   text | bool | color | link | fields | order
// Each validator returns a list of problems (strings); [] = valid. Pure, portable.

const KINDS = ["patch", "needs_code", "clarify", "tone"];
const MODES = ["edit", "alt_text", "meta_description", "tone_check"];
const DELTA_KINDS = ["text", "longtext", "markdown", "link", "color", "toggle", "section", "list", "page", "order"];
const OPS = ["replace", "add", "remove", "move"];

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isStr = (v, max) => typeof v === "string" && (max === undefined || v.length <= max);
const isInt = (v) => Number.isInteger(v) && v >= 0;

function exact(o, keys, at, out) {
  if (!isObj(o)) { out.push(at + " must be an object"); return false; }
  for (const k of Object.keys(o)) if (keys.indexOf(k) < 0) out.push(at + "." + k + " is not allowed");
  for (const k of keys) if (!Object.prototype.hasOwnProperty.call(o, k)) out.push(at + "." + k + " is missing");
  return true;
}

function validateRendered(r, at, out) {
  if (r === null) return;
  if (!isObj(r)) { out.push(at + " must be an object or null"); return; }
  if (r.type === "text") { if (exact(r, ["type", "text", "truncated"], at, out)) { if (!isStr(r.text, 2000)) out.push(at + ".text"); if (typeof r.truncated !== "boolean") out.push(at + ".truncated"); } }
  else if (r.type === "bool") { if (exact(r, ["type", "value"], at, out) && typeof r.value !== "boolean") out.push(at + ".value"); }
  else if (r.type === "color") { if (exact(r, ["type", "hex"], at, out) && !/^#[0-9a-f]{3,8}$/.test(String(r.hex))) out.push(at + ".hex"); }
  else if (r.type === "link") { if (exact(r, ["type", "text"], at, out) && !isStr(r.text, 2000)) out.push(at + ".text"); }
  else if (r.type === "fields") {
    if (exact(r, ["type", "fields"], at, out)) {
      if (!Array.isArray(r.fields) || r.fields.length > 8) out.push(at + ".fields");
      else r.fields.forEach((f, i) => { if (exact(f, ["label", "text"], at + ".fields[" + i + "]", out)) { if (!isStr(f.label, 60) || !isStr(f.text, 300)) out.push(at + ".fields[" + i + "] text"); } });
    }
  } else if (r.type === "order") {
    if (exact(r, ["type", "from", "to", "of", "itemLabel"], at, out)) { if (!isInt(r.from) || !isInt(r.to) || !isInt(r.of) || !isStr(r.itemLabel, 60)) out.push(at + " order fields"); }
  } else out.push(at + ".type is unknown");
}

function validateDiff(diff, before, after, at, out) {
  if (diff === null) return;
  if (!Array.isArray(diff) || diff.length > 400) { out.push(at + " must be null or at most 400 segments"); return; }
  let a = "";
  let b = "";
  for (const s of diff) {
    if (!isObj(s) || ["same", "del", "ins"].indexOf(s.t) < 0 || typeof s.s !== "string" || Object.keys(s).length !== 2) { out.push(at + " has a bad segment"); return; }
    if (s.t !== "ins") a += s.s;
    if (s.t !== "del") b += s.s;
  }
  if (!before || before.type !== "text" || !after || after.type !== "text") { out.push(at + " only belongs to text replaces"); return; }
  if (a !== before.text) out.push(at + " does not rebuild the before text");
  if (b !== after.text) out.push(at + " does not rebuild the after text");
}

function validateOp(op, at, out, withExpect) {
  if (!isObj(op)) { out.push(at + " must be an object"); return; }
  for (const k of Object.keys(op)) if (["op", "file", "path", "from", "value", "expect"].indexOf(k) < 0) out.push(at + "." + k + " is not allowed");
  if (OPS.indexOf(op.op) < 0) out.push(at + ".op");
  if (!isStr(op.file, 120) || !isStr(op.path, 300)) out.push(at + " file/path");
  if (op.op === "move" ? !isStr(op.from, 300) : Object.prototype.hasOwnProperty.call(op, "from")) out.push(at + ".from");
  if ((op.op === "replace" || op.op === "add") !== Object.prototype.hasOwnProperty.call(op, "value")) out.push(at + ".value");
  if (withExpect && (op.op === "replace" || op.op === "remove") && !Object.prototype.hasOwnProperty.call(op, "expect")) out.push(at + ".expect is required");
}

function validateChange(c, at, out) {
  if (!exact(c, ["id", "title", "ops", "deltas", "requires", "outsideAsk", "sensitive", "defaultChecked"], at, out)) return;
  if (!/^c[1-9][0-9]{0,2}$/.test(String(c.id))) out.push(at + ".id");
  if (!isStr(c.title, 80)) out.push(at + ".title");
  if (!Array.isArray(c.ops) || c.ops.length < 1 || c.ops.length > 20) { out.push(at + ".ops"); return; }
  c.ops.forEach((o, i) => validateOp(o, at + ".ops[" + i + "]", out, true));
  if (!Array.isArray(c.deltas) || c.deltas.length !== c.ops.length) { out.push(at + ".deltas must match ops"); return; }
  c.deltas.forEach((d, i) => {
    const dat = at + ".deltas[" + i + "]";
    if (!exact(d, ["file", "path", "ref", "op", "kind", "label", "before", "after", "diff"], dat, out)) return;
    if (!isStr(d.file, 120) || !isStr(d.path, 300) || !(d.ref === null || isStr(d.ref, 160)) || OPS.indexOf(d.op) < 0 || DELTA_KINDS.indexOf(d.kind) < 0 || !isStr(d.label, 200)) out.push(dat + " fields");
    validateRendered(d.before, dat + ".before", out);
    validateRendered(d.after, dat + ".after", out);
    validateDiff(d.diff, d.before, d.after, dat + ".diff", out);
  });
  if (!Array.isArray(c.requires) || c.requires.some((r) => !/^c[1-9][0-9]{0,2}$/.test(String(r)))) out.push(at + ".requires");
  for (const k of ["outsideAsk", "sensitive", "defaultChecked"]) if (typeof c[k] !== "boolean") out.push(at + "." + k);
  else if (k === "defaultChecked" && c.defaultChecked !== (!c.outsideAsk && !c.sensitive)) out.push(at + ".defaultChecked must equal !outsideAsk && !sensitive");
}

function validateProposal(p) {
  const out = [];
  if (!exact(p, ["id", "kind", "mode", "summary", "base", "instructionHash", "model", "provider", "changes", "skipped", "needsCode", "question", "findings", "warnings", "usage"].concat(Object.prototype.hasOwnProperty.call(p || {}, "overall") ? ["overall"] : []), "proposal", out)) return out;
  if (Object.prototype.hasOwnProperty.call(p, "overall") && ["on_brand", "mostly", "off_brand"].indexOf(p.overall) < 0) out.push("proposal.overall");
  if (!/^p_[a-z0-9]{12}$/.test(String(p.id))) out.push("proposal.id");
  if (KINDS.indexOf(p.kind) < 0) out.push("proposal.kind");
  if (MODES.indexOf(p.mode) < 0) out.push("proposal.mode");
  if (!isStr(p.summary, 200)) out.push("proposal.summary");
  if (exact(p.base, ["sha", "draftId", "headSha"], "proposal.base", out)) {
    if (!/^[0-9a-f]{40}$/.test(String(p.base.sha))) out.push("proposal.base.sha");
    if (!(p.base.draftId === null || isStr(p.base.draftId, 80))) out.push("proposal.base.draftId");
    if (!(p.base.headSha === null || /^[0-9a-f]{40}$/.test(String(p.base.headSha)))) out.push("proposal.base.headSha");
  }
  if (!/^[0-9a-f]{16}$/.test(String(p.instructionHash))) out.push("proposal.instructionHash");
  if (!isStr(p.model, 80) || ["anthropic", "replay"].indexOf(p.provider) < 0) out.push("proposal.model/provider");
  if (!Array.isArray(p.changes) || p.changes.length > 40) out.push("proposal.changes");
  else p.changes.forEach((c, i) => validateChange(c, "proposal.changes[" + i + "]", out));
  if (p.kind === "patch" && Array.isArray(p.changes) && p.changes.length < 1) out.push("proposal.changes must not be empty for a patch");
  if ((p.kind === "needs_code" || p.kind === "clarify") && Array.isArray(p.changes) && p.changes.length) out.push("proposal.changes must be empty for " + p.kind);
  if (Array.isArray(p.changes)) {
    const ids = p.changes.map((c) => c && c.id);
    ids.forEach((id, i) => { if (id !== "c" + (i + 1)) out.push("proposal.changes ids must be c1..cN in order"); });
    p.changes.forEach((c, i) => (c && Array.isArray(c.requires) ? c.requires : []).forEach((r) => { if (ids.indexOf(r) < 0 || ids.indexOf(r) >= i) out.push("proposal.changes[" + i + "].requires points at a later or unknown change"); }));
  }
  if (!Array.isArray(p.skipped) || p.skipped.length > 40) out.push("proposal.skipped");
  else p.skipped.forEach((s, i) => { if (exact(s, ["title", "reason", "code"], "proposal.skipped[" + i + "]", out) && (!isStr(s.title, 80) || !isStr(s.reason, 300) || !isStr(s.code, 40))) out.push("proposal.skipped[" + i + "] fields"); });
  if (p.needsCode !== null) {
    if (exact(p.needsCode, ["reason", "request"], "proposal.needsCode", out) && exact(p.needsCode.request, ["title", "body", "where", "priority"], "proposal.needsCode.request", out)) {
      const r = p.needsCode.request;
      if (!isStr(p.needsCode.reason, 300) || !isStr(r.title, 80) || !isStr(r.body, 1000) || !isStr(r.where, 80) || ["Whenever", "This week", "ASAP"].indexOf(r.priority) < 0) out.push("proposal.needsCode fields");
    }
  }
  if (p.kind === "needs_code" && p.needsCode === null) out.push("proposal.needsCode is required for needs_code");
  if (!(p.question === null || isStr(p.question, 300))) out.push("proposal.question");
  if (p.kind === "clarify" && p.question === null) out.push("proposal.question is required for clarify");
  if (!Array.isArray(p.findings) || p.findings.length > 20) out.push("proposal.findings");
  else p.findings.forEach((f, i) => {
    const at = "proposal.findings[" + i + "]";
    if (!exact(f, ["id", "ref", "label", "quote", "issue", "suggestion", "changeId"], at, out)) return;
    if (!/^f[1-9][0-9]{0,2}$/.test(String(f.id)) || !(f.ref === null || isStr(f.ref, 160)) || !isStr(f.label, 200) || !isStr(f.quote, 200) || !isStr(f.issue, 300) || !isStr(f.suggestion, 500)) out.push(at + " fields");
    if (!(f.changeId === null || (isStr(f.changeId) && Array.isArray(p.changes) && p.changes.some((c) => c.id === f.changeId)))) out.push(at + ".changeId");
  });
  if (!Array.isArray(p.warnings) || p.warnings.length > 10) out.push("proposal.warnings");
  else p.warnings.forEach((w, i) => { if (exact(w, ["code", "message", "refs"], "proposal.warnings[" + i + "]", out) && (!isStr(w.code, 40) || !isStr(w.message, 300) || !Array.isArray(w.refs))) out.push("proposal.warnings[" + i + "] fields"); });
  if (exact(p.usage, ["inTok", "outTok", "latencyMs"], "proposal.usage", out) && !(isInt(p.usage.inTok) && isInt(p.usage.outTok) && isInt(p.usage.latencyMs))) out.push("proposal.usage numbers");
  return out;
}

function validateStatus(s) {
  const out = [];
  if (!exact(s, ["enabled", "reason", "provider", "model", "vision", "modes", "limits", "usage"], "status", out)) return out;
  if (typeof s.enabled !== "boolean" || typeof s.vision !== "boolean") out.push("status.enabled/vision");
  if ([null, "disabled", "no_key", "budget_exhausted"].indexOf(s.reason) < 0) out.push("status.reason");
  if (s.enabled !== (s.reason === null)) out.push("status.enabled must be true exactly when reason is null");
  if (["anthropic", "replay", "none"].indexOf(s.provider) < 0 || !(s.model === null || isStr(s.model, 80))) out.push("status.provider/model");
  if (!Array.isArray(s.modes) || s.modes.some((m) => MODES.indexOf(m) < 0)) out.push("status.modes");
  if (exact(s.limits, ["instructionChars", "feedbackChars", "contextRefs", "maxChanges"], "status.limits", out) && !Object.values(s.limits).every(isInt)) out.push("status.limits numbers");
  if (exact(s.usage, ["requestsToday", "requestsLimit", "yourRequestsToday", "yourRequestsLimit", "resetsAt"], "status.usage", out)) {
    if (!["requestsToday", "requestsLimit", "yourRequestsToday", "yourRequestsLimit"].every((k) => isInt(s.usage[k])) || !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(String(s.usage.resetsAt))) out.push("status.usage fields");
  }
  return out;
}

function validateAcceptResponse(r) {
  const out = [];
  if (!isObj(r)) return ["accept response must be an object"];
  for (const k of ["draft", "changes", "replayed", "warnings", "ai"]) if (!Object.prototype.hasOwnProperty.call(r, k)) out.push("accept." + k + " is missing");
  if (isObj(r.ai)) { if (!/^p_[a-z0-9]{12}$/.test(String(r.ai.proposalId)) || !isInt(r.ai.accepted) || !isInt(r.ai.total) || r.ai.accepted > r.ai.total) out.push("accept.ai fields"); } else out.push("accept.ai");
  return out;
}

module.exports = { validateProposal, validateStatus, validateAcceptResponse, validateChange, validateOp, validateRendered, KINDS, MODES, DELTA_KINDS };
