"use strict";
// The single forced tool the model must call, `submit_result` (AI-DESIGN 7), and the key sets the strict parser
// (output.js) enforces. One source: the JSON schema sent to the API and the parser's allow-lists are built from the
// same tables here, so they cannot drift apart. Pure, portable.

const policy = require("./policy");

const TOOL_NAME = "submit_result";

const KINDS = {
  patch: { required: ["kind", "summary", "changes"], optional: [] },
  needs_code: { required: ["kind", "summary", "request", "reason"], optional: [] },
  clarify: { required: ["kind", "summary", "question"], optional: [] },
  tone: { required: ["kind", "summary", "overall", "findings"], optional: [] },
};
const KINDS_BY_MODE = {
  edit: ["patch", "needs_code", "clarify"],
  alt_text: ["patch", "clarify"],
  meta_description: ["patch", "clarify"],
  tone_check: ["tone"],
};
const CHANGE_KEYS = { required: ["title", "ops"], optional: [] };
const OP_KEYS = { required: ["op", "file", "path"], optional: ["from", "value"] };
const REQUEST_KEYS = { required: ["title", "body", "where", "priority"], optional: [] };
const FINDING_KEYS = { required: ["path", "quote", "issue", "suggestion"], optional: ["fix"] };
const FIX_KEYS = { required: ["title", "ops"], optional: [] };
const OPS = ["replace", "add", "remove", "move"];
const PRIORITIES = ["Whenever", "This week", "ASAP"];
const OVERALL = ["on_brand", "mostly", "off_brand"];

const opSchema = {
  type: "object",
  additionalProperties: false,
  required: OP_KEYS.required,
  properties: {
    op: { type: "string", enum: OPS },
    file: { type: "string", description: "A file path exactly as it appears in the editable index." },
    path: { type: "string", description: "A JSON pointer exactly as it appears in the editable index (use /- to append to a list)." },
    from: { type: "string", description: "Only for move: the JSON pointer of the item to move." },
    value: { description: "The new value (replace, add). Plain text only, never markup." },
  },
};

function inputSchema(mode) {
  const kinds = KINDS_BY_MODE[mode] || KINDS_BY_MODE.edit;
  return {
    type: "object",
    additionalProperties: false,
    required: ["kind", "summary"],
    properties: {
      kind: { type: "string", enum: kinds, description: "patch = a list of changes; needs_code = the request needs a developer; clarify = ask one question; tone = tone check result." },
      summary: { type: "string", maxLength: policy.CAPS.summary, description: "One plain sentence for the person who asked." },
      changes: {
        type: "array", maxItems: policy.CAPS.changes,
        items: { type: "object", additionalProperties: false, required: CHANGE_KEYS.required, properties: { title: { type: "string", maxLength: policy.CAPS.title }, ops: { type: "array", maxItems: policy.CAPS.opsPerChange, items: opSchema } } },
      },
      request: { type: "object", additionalProperties: false, required: REQUEST_KEYS.required, properties: { title: { type: "string" }, body: { type: "string" }, where: { type: "string" }, priority: { type: "string", enum: PRIORITIES } } },
      reason: { type: "string", maxLength: policy.CAPS.reason },
      question: { type: "string", maxLength: policy.CAPS.question },
      overall: { type: "string", enum: OVERALL },
      findings: {
        type: "array", maxItems: policy.CAPS.findings,
        items: {
          type: "object", additionalProperties: false, required: FINDING_KEYS.required,
          properties: {
            path: { type: "string", description: "A reference such as hero.headlineMain." }, quote: { type: "string" }, issue: { type: "string" }, suggestion: { type: "string" },
            fix: { type: "object", additionalProperties: false, required: FIX_KEYS.required, properties: { title: { type: "string" }, ops: { type: "array", maxItems: policy.CAPS.opsPerChange, items: opSchema } } },
          },
        },
      },
    },
  };
}

const TOOL_DESCRIPTION = "Return the one and only answer to the request. For website changes return kind patch with changes whose ops use only paths listed in the editable index. Never include expect, ids or anything else.";

// ---- the contract, pinned. The schema the model is TOLD to follow must say exactly what the strict parser (output.js) enforces:
// no extra fields on any object, the same key sets, the same op list, the same size caps. check-ai.js (D9) and the unit tests call
// this; a loosened schema ("additionalProperties": true, a missing cap, a new op) is reported here, not discovered in production.
// -> list of plain problems (empty = pinned). `build(mode)` defaults to the real inputSchema.
function pinProblems(build) {
  const mk = build || inputSchema; // a test may hand in a loosened builder to prove the pin notices
  const out = [];
  const CAPS = policy.CAPS;
  const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
  const keysOf = (spec) => spec.required.concat(spec.optional);
  const objectCheck = (where, node, spec) => {
    if (!node || node.type !== "object") { out.push(where + " is not an object schema"); return; }
    if (node.additionalProperties !== false) out.push(where + " must set additionalProperties to false");
    if (!same(node.required || [], spec.required)) out.push(where + " required list differs from the parser's (" + (node.required || []).join(",") + ")");
    if (!same(Object.keys(node.properties || {}), keysOf(spec))) out.push(where + " offers properties the parser does not accept, or leaves out ones it does");
  };
  const cap = (where, got, want) => { if (got !== want) out.push(where + " is " + got + ", the parser enforces " + want); };
  // every object node anywhere must refuse extra fields
  const walk = (where, n) => {
    if (!n || typeof n !== "object") return;
    if (n.type === "object" && n.additionalProperties !== false) out.push(where + " allows extra fields");
    for (const [k, v] of Object.entries(n.properties || {})) walk(where + "." + k, v);
    if (n.items) walk(where + "[]", n.items);
  };
  if (!same(OPS, ["replace", "add", "remove", "move"])) out.push("the op list changed: " + OPS.join(","));
  for (const mode of Object.keys(KINDS_BY_MODE)) {
    const s = mk(mode);
    const at = "the " + mode + " schema";
    walk(at, s);
    if (s.type !== "object" || s.additionalProperties !== false) out.push(at + " must be a closed object");
    if (!same(s.required || [], ["kind", "summary"])) out.push(at + " must require kind and summary");
    if (!s.properties || !s.properties.kind || !same(s.properties.kind.enum || [], KINDS_BY_MODE[mode])) out.push(at + " lists kinds the mode does not allow");
    const p = s.properties || {};
    cap(at + " summary maxLength", p.summary && p.summary.maxLength, CAPS.summary);
    cap(at + " changes maxItems", p.changes && p.changes.maxItems, CAPS.changes);
    cap(at + " findings maxItems", p.findings && p.findings.maxItems, CAPS.findings);
    cap(at + " reason maxLength", p.reason && p.reason.maxLength, CAPS.reason);
    cap(at + " question maxLength", p.question && p.question.maxLength, CAPS.question);
    objectCheck(at + " change", p.changes && p.changes.items, CHANGE_KEYS);
    cap(at + " change title maxLength", p.changes && p.changes.items.properties.title.maxLength, CAPS.title);
    cap(at + " ops maxItems", p.changes && p.changes.items.properties.ops.maxItems, CAPS.opsPerChange);
    const opNode = p.changes && p.changes.items.properties.ops.items;
    objectCheck(at + " op", opNode, OP_KEYS);
    if (opNode && opNode.properties && !same(opNode.properties.op.enum || [], OPS)) out.push(at + " op enum differs from the parser's");
    objectCheck(at + " request", p.request, REQUEST_KEYS);
    if (p.request && !same(p.request.properties.priority.enum || [], PRIORITIES)) out.push(at + " priority enum differs from the parser's");
    if (!same(p.overall && p.overall.enum || [], OVERALL)) out.push(at + " overall enum differs from the parser's");
    objectCheck(at + " finding", p.findings && p.findings.items, FINDING_KEYS);
    const fix = p.findings && p.findings.items.properties.fix;
    objectCheck(at + " finding fix", fix, FIX_KEYS);
    cap(at + " fix ops maxItems", fix && fix.properties.ops.maxItems, CAPS.opsPerChange);
    if (fix) objectCheck(at + " fix op", fix.properties.ops.items, OP_KEYS);
  }
  return out;
}

module.exports = { pinProblems, TOOL_NAME, TOOL_DESCRIPTION, KINDS, KINDS_BY_MODE, CHANGE_KEYS, OP_KEYS, REQUEST_KEYS, FINDING_KEYS, FIX_KEYS, OPS, PRIORITIES, OVERALL, inputSchema };
