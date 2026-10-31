"use strict";
// Gate 1: the model's answer is hostile input. A table of hostile and benign outputs with the class each must land in.
const test = require("node:test");
const assert = require("node:assert/strict");
const { parseModelOutput } = require("../../api/ai/output");
const { parseCtx, patchOf, ch, rep, HERO } = require("./helpers");

const tool = (input, extra) => Object.assign({ toolInputs: [input], text: "", stopReason: "tool_use", usage: { inTok: 1, outTok: 1 } }, extra || {});
const P = (...changes) => patchOf("s", ...changes);
const op = (o) => ch("c", o);
const deep = (n) => { let v = []; for (let i = 0; i < n; i += 1) v = [v]; return v; };

const CASES = [
  ["a minimal valid patch", tool(P(op(rep(HERO, "/badge", "Hello")))), "ok"],
  ["a line break tag the site itself uses is allowed", tool(P(op(rep("src/_data/vision.json", "/title", "One.<br />Two.")))), "ok"],
  ["a plain less-than sign is not markup", tool(P(op(rep(HERO, "/badge", "1 < 2 and 3 > 2")))), "ok"],
  ["clarify is fine", tool({ kind: "clarify", summary: "s", question: "Which?" }), "ok"],
  ["needs_code is fine", tool({ kind: "needs_code", summary: "s", reason: "r", request: { title: "t", body: "b", where: "w", priority: "ASAP" } }), "ok"],
  ["an extra top-level key", tool(Object.assign(P(op(rep(HERO, "/badge", "x"))), { draftId: "a--b" })), "extra_field"],
  ["an unknown kind", tool({ kind: "run", summary: "s" }), "unknown_kind"],
  ["no kind at all", tool({ summary: "s" }), "bad_op_shape"],
  ["a bad priority in a code request", tool({ kind: "needs_code", summary: "s", reason: "r", request: { title: "t", body: "b", where: "w", priority: "Yesterday" } }), "bad_op_shape"],
  ["an op that carries expect", tool(P(op(Object.assign(rep(HERO, "/badge", "x"), { expect: "y" })))), "expect_supplied"],
  ["an unknown op: copy", tool(P(op({ op: "copy", file: HERO, from: "/badge", path: "/stamp" }))), "unknown_op"],
  ["an unknown op: test", tool(P(op({ op: "test", file: HERO, path: "/badge", value: "x" }))), "unknown_op"],
  ["an extra key on an op", tool(P(op(Object.assign(rep(HERO, "/badge", "x"), { exec: "rm" })))), "extra_field"],
  ["replace without a value", tool(P(op({ op: "replace", file: HERO, path: "/badge" }))), "bad_op_shape"],
  ["remove with a value", tool(P(op({ op: "remove", file: "src/_data/faq.json", path: "/items/0", value: 1 }))), "bad_op_shape"],
  ["add with a from", tool(P(op({ op: "add", file: "src/_data/faq.json", path: "/items/-", from: "/items/0", value: { q: "a", a: "b" } }))), "bad_op_shape"],
  ["move without a from", tool(P(op({ op: "move", file: "src/_data/faq.json", path: "/items/1" }))), "bad_op_shape"],
  ["a workflow file", tool(P(op(rep(".github/workflows/site-checks.yml", "/on", "x")))), "path_outside_allowlist"],
  ["a template", tool(P(op(rep("src/_includes/sections/hero.njk", "/x", "x")))), "path_outside_allowlist"],
  ["package.json", tool(P(op(rep("package.json", "/name", "x")))), "path_outside_allowlist"],
  ["the CMS configuration", tool(P(op(rep("cms/config.yml", "/x", "x")))), "path_outside_allowlist"],
  ["Studio's own code", tool(P(op(rep("studio/api/ai/policy.js", "/x", "x")))), "path_outside_allowlist"],
  ["a dot-dot traversal", tool(P(op(rep("src/_data/../../package.json", "/name", "x")))), "path_outside_allowlist"],
  ["an encoded traversal", tool(P(op(rep("src/_data/%2e%2e/x.json", "/name", "x")))), "path_outside_allowlist"],
  ["a backslash path", tool(P(op(rep("src\\_data\\hero.json", "/badge", "x")))), "path_outside_allowlist"],
  ["an absolute path", tool(P(op(rep("/etc/passwd", "/x", "x")))), "path_outside_allowlist"],
  ["a data file the schema does not know", tool(P(op(rep("src/_data/unknown.json", "/x", "x")))), "path_outside_allowlist"],
  ["the redirects file", tool(P(op(rep("src/_data/redirects.json", "/items/0/to", "https://evil.example/")))), "path_outside_allowlist"],
  ["a picture field", tool(P(op(rep("src/_data/how.json", "/story/0/src", "/images/evil.png")))), "forbidden_target"],
  ["a page permalink", tool(P(op(rep("src/pages/about.md", "/permalink", "/x/")))), "forbidden_target"],
  ["a made-up field", tool(P(op(rep(HERO, "/notAField", "x")))), "path_outside_allowlist"],
  ["a __proto__ pointer", tool(P(op(rep(HERO, "/__proto__/x", "x")))), "proto_key"],
  ["a constructor pointer", tool(P(op(rep(HERO, "/constructor/prototype/x", "x")))), "proto_key"],
  ["a prototype pointer", tool(P(op(rep(HERO, "/prototype", "x")))), "proto_key"],
  ["an empty pointer segment", tool(P(op(rep(HERO, "//badge", "x")))), "path_outside_allowlist"],
  ["a bad ~ escape", tool(P(op(rep(HERO, "/ba~2dge", "x")))), "path_outside_allowlist"],
  ["an object where text belongs", tool(P(op(rep(HERO, "/badge", { a: 1 })))), "bad_op_shape"],
  ["a script tag", tool(P(op(rep(HERO, "/badge", "<script>alert(1)</script>")))), "markup_in_value"],
  ["an img with an event handler", tool(P(op(rep(HERO, "/badge", "<img src=x onerror=alert(1)>")))), "markup_in_value"],
  ["an HTML comment", tool(P(op(rep(HERO, "/badge", "a <!-- b -->")))), "markup_in_value"],
  ["a javascript: address", tool(P(op(rep("src/_data/problem.json", "/sourceUrl", "javascript:alert(1)")))), "markup_in_value"],
  ["a vbscript: address", tool(P(op(rep("src/_data/problem.json", "/sourceUrl", "VBScript:x")))), "markup_in_value"],
  ["a data: HTML address", tool(P(op(rep("src/_data/problem.json", "/sourceUrl", "data:text/html;base64,AAAA")))), "markup_in_value"],
  ["a NUL character", tool(P(op(rep(HERO, "/badge", "a\u0000b")))), "markup_in_value"],
  ["a bidi override", tool(P(op(rep(HERO, "/badge", "a‮b")))), "markup_in_value"],
  ["a bidi isolate", tool(P(op(rep(HERO, "/badge", "a⁦b")))), "markup_in_value"],
  ["a prototype key inside an added value", tool(P(op({ op: "add", file: "src/_data/faq.json", path: "/items/-", value: { q: "a", a: "b", constructor: { x: 1 } } }))), "proto_key"],
  ["an unknown key inside an added value", tool(P(op({ op: "add", file: "src/_data/faq.json", path: "/items/-", value: { q: "a", a: "b", evil: "c" } }))), "forbidden_target"],
  ["an add to a list the AI may only reorder", tool(P(op({ op: "add", file: "src/_data/homepage.json", path: "/sections/-", value: { type: "hero", enabled: true } }))), "forbidden_target"],
  ["a move across two lists", tool(P(op({ op: "move", file: "src/_data/footer.json", from: "/columns/0/links/1", path: "/columns/1/links/0" }))), "bad_op_shape"],
  ["nesting that is far too deep", tool(P(op({ op: "add", file: "src/_data/faq.json", path: "/items/-", value: { q: "a", a: deep(40) } }))), "too_large"],
  ["forty-one changes", tool(P(...Array.from({ length: 41 }, (_, i) => op(rep(HERO, "/badge", "x" + i))))), "too_many"],
  ["twenty-one ops in one change", tool(P(ch("c", ...Array.from({ length: 21 }, (_, i) => rep(HERO, "/badge", "x" + i))))), "too_many"],
  ["a change without ops", tool(P({ title: "t", ops: [] })), "bad_op_shape"],
  ["a huge string", tool(P(op(rep(HERO, "/badge", "a".repeat(130000))))), "too_large"],
  ["two changes writing the same place", tool(P(op(rep(HERO, "/badge", "a")), op(rep(HERO, "/badge", "b")))), "duplicate_pointer"],
  ["the answer is a string", tool("hello"), "bad_op_shape"],
  ["the answer is an array", tool([1, 2]), "bad_op_shape"],
  ["no tool call (prose)", { toolInputs: [], text: "Sure!", stopReason: "end_turn" }, "prose_not_tool"],
  ["two tool calls", { toolInputs: [P(op(rep(HERO, "/badge", "a"))), P(op(rep(HERO, "/badge", "b")))], text: "", stopReason: "tool_use" }, "multiple_tool_calls"],
  ["cut off at max_tokens", tool(P(op(rep(HERO, "/badge", "a"))), { stopReason: "max_tokens" }), "max_tokens"],
  ["a tone answer in edit mode", tool({ kind: "tone", summary: "s", overall: "on_brand", findings: [] }), "wrong_kind_for_mode"],
];

test("hostile and benign outputs land in the right class (Gate 1)", async () => {
  const { ctx } = await parseCtx("edit");
  for (const [name, res, want] of CASES) {
    const r = parseModelOutput(res, ctx);
    if (want === "ok") assert.equal(r.ok, true, name + " should be accepted: " + JSON.stringify(r.violations));
    else {
      assert.equal(r.ok, false, name + " should be rejected");
      assert.ok(r.violations.some((v) => v.code === want), name + ": expected " + want + ", got " + JSON.stringify(r.violations));
    }
  }
  assert.ok(CASES.length >= 40);
});

test("mode narrowing: alt text mode may only write alt fields, meta mode only descriptions", async () => {
  const alt = await parseCtx("alt_text");
  const meta = await parseCtx("meta_description");
  const hero = tool(P(op(rep(HERO, "/badge", "x"))));
  assert.ok(parseModelOutput(hero, alt.ctx).violations.some((v) => v.code === "path_outside_allowlist"));
  assert.ok(parseModelOutput(hero, meta.ctx).violations.some((v) => v.code === "path_outside_allowlist"));
  assert.equal(parseModelOutput(tool(P(op(rep("src/_data/site.json", "/metaDescription", "A description of the site.")))), meta.ctx).ok, true);
  assert.ok(parseModelOutput(tool({ kind: "needs_code", summary: "s", reason: "r", request: { title: "t", body: "b", where: "w", priority: "ASAP" } }), alt.ctx).violations.some((v) => v.code === "wrong_kind_for_mode"));
});

test("the violation list is bounded and never echoes model text", async () => {
  const { ctx } = await parseCtx("edit");
  const r = parseModelOutput(tool(P(...Array.from({ length: 30 }, (_, i) => op(rep(".github/x" + i + ".yml", "/a", "SECRET-MODEL-TEXT"))))), ctx);
  assert.ok(r.violations.length <= 10);
  assert.equal(JSON.stringify(r).includes("SECRET-MODEL-TEXT"), false);
});

test("labels shown in the panel lose angle brackets and are capped", async () => {
  const { ctx } = await parseCtx("edit");
  const r = parseModelOutput(tool({ kind: "patch", summary: "a <b>bold</b> summary " + "x".repeat(400), changes: [ch("t <i>itle</i> " + "y".repeat(200), rep(HERO, "/badge", "Hello"))] }), ctx);
  assert.equal(r.ok, true);
  assert.equal(/[<>]/.test(r.summary + r.changes[0].title), false);
  assert.ok(r.summary.length <= 200 && r.changes[0].title.length <= 80);
});

test("tone: a quote that is not in the current text drops the finding", async () => {
  const { ctx } = await parseCtx("tone_check");
  const mk = (quote, extra) => tool({ kind: "tone", summary: "s", overall: "mostly", findings: [Object.assign({ path: "hero.headlineMain", quote, issue: "i", suggestion: "s" }, extra || {})] });
  assert.equal(parseModelOutput(mk("Free period products"), ctx).findings.length, 1);
  assert.equal(parseModelOutput(mk("Buy now!"), ctx).findings.length, 0);
  assert.equal(parseModelOutput(mk("Free period products", { path: "hero.notAField" }), ctx).findings.length, 0);
  assert.equal(parseModelOutput(mk("Free   period\nproducts"), ctx).findings.length, 1, "whitespace is normalised");
  const bad = parseModelOutput(mk("Free period products", { fix: { title: "t", ops: [rep(".github/x.yml", "/a", "b")] } }), ctx);
  assert.equal(bad.ok, false, "a fix goes through the same gates");
});
