"use strict";
// Phase 1 wire shapes (studio/PHASE1-DESIGN.md sections 4 to 8) as EXECUTABLE checks. Producers (API routes) call these in
// their tests; consumers (overlay) are tested against the same example payloads in studio/tests/fixtures/phase1/*.json.
// Each validateX(value) -> string[] of problems ([] = valid). Keys are EXACT: an unknown or missing key is a problem, so a
// producer and a consumer cannot drift apart silently. Portable: no node: modules. Owned by the architect; a unit that needs
// a change records it under "Deviations" in its studio/README.md section and the integrator edits this file.

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isStr = (v, max) => typeof v === "string" && (max === undefined || v.length <= max);
const isInt = (v) => Number.isInteger(v) && v >= 0;
const isIso = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(v);
const isSha = (v) => typeof v === "string" && /^[0-9a-f]{40}$/.test(v);
const nullable = (f) => (v) => v === null || f(v);
const oneOf = (list) => (v) => list.indexOf(v) >= 0;

// check(obj, { key: predicate }, name, out): exact key set + every predicate
function check(o, spec, name, out) {
  if (!isObj(o)) { out.push(name + " must be an object"); return false; }
  for (const k of Object.keys(o)) if (!(k in spec)) out.push(name + "." + k + " is not allowed");
  for (const k of Object.keys(spec)) {
    if (!(k in o)) { out.push(name + "." + k + " is missing"); continue; }
    if (!spec[k](o[k])) out.push(name + "." + k + " is not valid");
  }
  return true;
}
const listOf = (f, max) => (v) => Array.isArray(v) && (max === undefined || v.length <= max) && v.every(f);
const shape = (spec) => (v) => { const o = []; check(v, spec, "x", o); return o.length === 0; };

// ---- 4. health -------------------------------------------------------------------------------------------------------
const SERVICE_STATE = ["ok", "slow", "paused", "unreachable", "unknown"];
const AI_STATE = ["off", "ready", "budget_exhausted", "no_key", "unknown"];
function validateHealth(h) {
  const out = [];
  check(h, {
    ok: (v) => typeof v === "boolean", checkedAt: isIso, cached: (v) => typeof v === "boolean",
    services: shape({
      auth: shape({ state: oneOf(SERVICE_STATE), message: nullable((v) => isStr(v, 240)) }),
      git: shape({ state: oneOf(SERVICE_STATE), message: nullable((v) => isStr(v, 240)) }),
      ai: shape({ state: oneOf(AI_STATE), store: oneOf(["memory", "supabase"]), message: nullable((v) => isStr(v, 240)) }),
    }),
    message: nullable((v) => isStr(v, 240)),
  }, "health", out);
  if (isObj(h) && typeof h.ok === "boolean" && isObj(h.services)) {
    const bad = ["auth", "git"].some((k) => h.services[k] && h.services[k].state !== "ok" && h.services[k].state !== "slow");
    if (h.ok === bad) out.push("health.ok must be true exactly when auth and git are ok or slow");
    if (h.ok && h.message !== null) out.push("health.message must be null when ok");
  }
  return out;
}

// ---- 5. board --------------------------------------------------------------------------------------------------------
const STEPS = ["editing", "waiting_for_checks", "checks_failed", "waiting_for_approval", "ready_to_publish", "published", "restored"];
const person = shape({ name: (v) => isStr(v, 60) });
const boardItem = shape({
  id: (v) => isStr(v, 80), number: isInt, title: (v) => isStr(v, 120), url: (v) => isStr(v, 300), reviewLink: nullable((v) => isStr(v, 400)),
  step: oneOf(STEPS), stepLabel: (v) => isStr(v, 80), author: person, updatedAt: isIso, changeCount: nullable(isInt),
  mine: (v) => typeof v === "boolean", canReview: (v) => typeof v === "boolean", canPublish: (v) => typeof v === "boolean",
});
function validateBoard(b) {
  const out = [];
  check(b, {
    generatedAt: isIso,
    live: nullable(shape({ number: isInt, title: (v) => isStr(v, 120), mergedAt: isIso, sha: isSha, url: (v) => isStr(v, 300), by: person, settling: (v) => typeof v === "boolean" })),
    waiting: listOf(boardItem, 50), restored: listOf(boardItem, 20), mine: listOf(boardItem, 50),
    othersWaiting: isInt,
  }, "board", out);
  return out;
}

// ---- 6. review screen ------------------------------------------------------------------------------------------------
const KINDS = ["text", "image", "link", "color", "toggle", "section", "list", "page"];
const valueView = nullable(shape({ text: (v) => isStr(v, 2000), truncated: (v) => typeof v === "boolean", image: nullable((v) => isStr(v, 120)) }));
const reviewItem = shape({
  id: (v) => /^r[1-9][0-9]{0,3}$/.test(String(v)), file: (v) => isStr(v, 120), path: (v) => isStr(v, 200), op: oneOf(["replace", "add", "remove", "move"]),
  kind: oneOf(KINDS), label: (v) => isStr(v, 200), where: (v) => isStr(v, 200), line: (v) => isStr(v, 400) && v.length > 0,
  before: valueView, after: valueView, pageUrl: nullable((v) => /^\/[A-Za-z0-9._~\/-]*$/.test(v)), attention: oneOf(["none", "link", "image", "hidden", "legal"]),
});
function validateReview(r) {
  const out = [];
  check(r, {
    draft: isObj, generatedAt: isIso, headSha: isSha, summary: (v) => isStr(v, 200),
    items: listOf(reviewItem, 200),
    gates: shape({ checks: oneOf(["none", "pending", "success", "failure"]), canPublish: (v) => typeof v === "boolean", blockers: listOf(shape({ reason: oneOf(["checks_pending", "checks_failed", "not_mergeable", "draft_state", "self_publish", "head_changed", "role"]), message: (v) => isStr(v, 240) }), 8) }),
    sideBySide: nullable(shape({ productionUrl: (v) => isStr(v, 300), draftUrl: (v) => isStr(v, 300), pagePath: (v) => isStr(v, 200) })),
  }, "review", out);
  if (isObj(r) && Array.isArray(r.items) && r.items.some((it, i) => it && it.id !== "r" + (i + 1))) out.push("review.items ids must be r1..rN in order");
  if (isObj(r) && isObj(r.gates) && Array.isArray(r.gates.blockers) && r.gates.canPublish === (r.gates.blockers.length > 0)) out.push("review.gates.canPublish must be true exactly when there are no blockers");
  return out;
}

// ---- 7. send for review ----------------------------------------------------------------------------------------------
function validateApprovers(a) {
  const out = [];
  check(a, { approvers: listOf(shape({ id: (v) => isStr(v, 80), displayName: (v) => isStr(v, 60), role: oneOf(["approver", "admin"]), notify: oneOf(["github", "manual"]) }), 20) }, "approvers", out);
  return out;
}
function validateSubmitResponse(s) {
  const out = [];
  check(s, {
    draft: isObj, reviewLink: nullable((v) => isStr(v, 400)),
    notified: shape({ via: oneOf(["github", "none"]), reviewer: nullable(shape({ displayName: (v) => isStr(v, 60) })), reason: nullable(oneOf(["no_reviewer_chosen", "no_github_login", "github_refused", "github_unavailable"])) }),
    message: (v) => isStr(v, 300),
  }, "submit", out);
  if (isObj(s) && isObj(s.notified) && (s.notified.via === "github") !== (s.notified.reason === null)) out.push("submit.notified.reason must be null exactly when via is github");
  return out;
}

// ---- 9. AI meter -----------------------------------------------------------------------------------------------------
function validateAiEstimate(e) {
  const out = [];
  check(e, {
    estimate: shape({
      inputTokens: isInt, maxOutputTokens: isInt, estTokens: isInt, typicalTokens: nullable(isInt),
      pctOfDay: (v) => typeof v === "number" && v >= 0 && v <= 100, requestsLeftToday: isInt, yourRequestsLeftToday: isInt,
      label: (v) => isStr(v, 160) && v.length > 0, wouldFit: (v) => typeof v === "boolean",
    }),
  }, "aiEstimate", out);
  return out;
}
const recentItem = shape({
  id: (v) => /^p_[a-z0-9]{12}$/.test(String(v)), at: isIso, mode: (v) => isStr(v, 20), kind: oneOf(["patch", "tone", "alt_text", "audit", "clarify", "needs_code", "rejected"]),
  tokens: isInt, accepted: nullable(isInt), total: nullable(isInt), prNumber: nullable(isInt), prUrl: nullable((v) => isStr(v, 300)),
});
function validateAiRecent(r) {
  const out = [];
  check(r, { items: listOf(recentItem, 20), store: oneOf(["memory", "supabase"]) }, "aiRecent", out);
  return out;
}
// the ADDITIVE keys of GET /v1/ai/status.usage and of a proposal (existing validators in api/ai/shapes.js accept them from Phase 1 on)
function validateAiMeter(m) {
  const out = [];
  check(m, { usedTokens: isInt, tookMs: isInt, pctOfDayUsed: (v) => typeof v === "number" && v >= 0 && v <= 100, requestsLeftToday: isInt, counted: (v) => typeof v === "boolean" }, "meter", out);
  return out;
}

// ---- 8. content rules ------------------------------------------------------------------------------------------------
const finding = shape({
  key: (v) => /^[a-z][a-z0-9-]*\|[^|]+\|[^|]*$/.test(String(v)), rule: (v) => /^[a-z][a-z0-9-]*$/.test(String(v)), severity: oneOf(["block", "warn", "info"]),
  file: (v) => isStr(v, 160), path: (v) => isStr(v, 240), message: (v) => isStr(v, 300) && v.length > 0, hint: (v) => isStr(v, 300),
  fix: nullable(shape({ kind: oneOf(["edit-field", "shorten", "pick-image", "reword-link"]) })), data: nullable(isObj),
});
function validateRuleReport(r) {
  const out = [];
  check(r, { engineVersion: (v) => v === 1, ranRules: listOf((v) => isStr(v, 60)), findings: listOf(finding), counts: shape({ block: isInt, warn: isInt, info: isInt }) }, "report", out);
  if (isObj(r) && Array.isArray(r.findings) && isObj(r.counts)) {
    for (const s of ["block", "warn", "info"]) if (r.counts[s] !== r.findings.filter((f) => f && f.severity === s).length) out.push("report.counts." + s + " does not match the findings");
    if (new Set(r.findings.map((f) => f && f.key)).size !== r.findings.length) out.push("report.findings keys must be unique");
  }
  return out;
}

module.exports = { validateHealth, validateBoard, validateReview, validateApprovers, validateSubmitResponse, validateAiEstimate, validateAiRecent, validateAiMeter, validateRuleReport, STEPS, KINDS };
