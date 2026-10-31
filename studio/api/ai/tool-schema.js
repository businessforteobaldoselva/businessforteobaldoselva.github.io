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

module.exports = { TOOL_NAME, TOOL_DESCRIPTION, KINDS, KINDS_BY_MODE, CHANGE_KEYS, OP_KEYS, REQUEST_KEYS, FINDING_KEYS, FIX_KEYS, OPS, PRIORITIES, OVERALL, inputSchema };
