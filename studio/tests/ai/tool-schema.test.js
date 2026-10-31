"use strict";
// The schema the model is told to follow must stay exactly as strict as the parser that checks the answer.
const test = require("node:test");
const assert = require("node:assert/strict");
const T = require("../../api/ai/tool-schema");
const policy = require("../../api/ai/policy");

const clone = (x) => JSON.parse(JSON.stringify(x));
const everyNode = (n, fn) => { if (n && typeof n === "object") { fn(n); for (const v of Object.values(n.properties || {})) everyNode(v, fn); if (n.items) everyNode(n.items, fn); } };

test("the real schema is pinned, and says what the parser enforces", () => {
  assert.deepEqual(T.pinProblems(), []);
  for (const mode of Object.keys(T.KINDS_BY_MODE)) {
    const s = T.inputSchema(mode);
    let objects = 0;
    everyNode(s, (n) => { if (n.type === "object") { objects += 1; assert.equal(n.additionalProperties, false, mode + ": an object schema allows extra fields"); } });
    assert.ok(objects >= 5, "the walk found the nested objects");
    assert.deepEqual(s.required.slice().sort(), ["kind", "summary"]);
    assert.equal(s.properties.changes.maxItems, policy.CAPS.changes);
    assert.equal(s.properties.changes.items.properties.ops.maxItems, policy.CAPS.opsPerChange);
    assert.deepEqual(s.properties.changes.items.properties.ops.items.properties.op.enum, ["replace", "add", "remove", "move"]);
  }
});

test("loosening the schema is noticed: every kind of widening is reported", () => {
  const widen = (edit) => (mode) => { const s = clone(T.inputSchema(mode)); edit(s); return s; };
  const cases = {
    "extra fields allowed on every object": widen((s) => everyNode(s, (n) => { if (n.type === "object") n.additionalProperties = true; })),
    "extra fields allowed on the top object only": widen((s) => { s.additionalProperties = true; }),
    "extra fields allowed on an op only": widen((s) => { s.properties.changes.items.properties.ops.items.additionalProperties = true; }),
    "a new op": widen((s) => { s.properties.changes.items.properties.ops.items.properties.op.enum.push("copy"); }),
    "a property the parser rejects": widen((s) => { s.properties.changes.items.properties.ops.items.properties.expect = {}; }),
    "the change cap raised": widen((s) => { s.properties.changes.maxItems = 400; }),
    "the ops cap removed": widen((s) => { delete s.properties.changes.items.properties.ops.maxItems; }),
    "the summary cap removed": widen((s) => { delete s.properties.summary.maxLength; }),
    "a required key dropped": widen((s) => { s.properties.changes.items.required = ["title"]; }),
    "a kind the mode must not have": widen((s) => { s.properties.kind.enum = s.properties.kind.enum.concat("tone"); }),
  };
  for (const [name, build] of Object.entries(cases)) {
    const p = T.pinProblems((mode) => (mode === "edit" || mode === "tone_check" ? build(mode) : T.inputSchema(mode)));
    assert.ok(p.length > 0, "widening was not noticed: " + name);
  }
});
