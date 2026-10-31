"use strict";
// The model providers: the Anthropic client over an injected fetch (no network), the replay provider and the disabled one.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createAnthropicProvider, ENDPOINT, buildBody } = require("../../api/ai/providers/anthropic");
const { createReplayProvider } = require("../../api/ai/providers/replay");
const { createDisabledProvider } = require("../../api/ai/providers/disabled");
const { ProviderError, assertProvider } = require("../../api/ai/providers/interface");
const T = require("../../api/ai/tool-schema");

const KEY = "sk-ant-TEST-0123456789abcdefghijklmnop";
const OK = { id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-5-5", stop_reason: "tool_use", content: [{ type: "text", text: "thinking" }, { type: "tool_use", id: "tu_1", name: "submit_result", input: { kind: "clarify", summary: "s", question: "q?" } }], usage: { input_tokens: 1234, output_tokens: 56 } };
const res = (status, json, headers) => new Response(JSON.stringify(json), { status, headers: Object.assign({ "content-type": "application/json" }, headers || {}) });
const req = (extra) => Object.assign({ system: "SYS", user: "USER", images: [], tool: { name: T.TOOL_NAME, description: "d", inputSchema: T.inputSchema("edit") }, maxTokens: 777, deadlineAtMs: Date.now() + 10000, meta: { replayKey: "k", mode: "edit" } }, extra || {});

function make(responses, extra) {
  const calls = [];
  const sleeps = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    const r = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (r instanceof Error) throw r;
    return typeof r === "function" ? r(init) : r;
  };
  const p = createAnthropicProvider(Object.assign({ apiKey: KEY, model: "claude-sonnet-5-5", fetchFn, sleep: async (ms) => { sleeps.push(ms); }, random: () => 0.5 }, extra || {}));
  return { p, calls, sleeps };
}

test("the request follows the public Messages API: endpoint, headers, one forced tool call, no sampling settings", async () => {
  const { p, calls } = make([res(200, OK)]);
  const r = await p.complete(req({ images: [{ mediaType: "image/png", dataBase64: "AAAA" }] }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.anthropic.com/v1/messages");
  assert.equal(ENDPOINT, calls[0].url);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["x-api-key"], KEY);
  assert.equal(calls[0].init.headers["anthropic-version"], "2023-06-01");
  assert.equal(calls[0].init.headers["content-type"], "application/json");
  const b = JSON.parse(calls[0].init.body);
  assert.equal(b.model, "claude-sonnet-5-5");
  assert.equal(b.max_tokens, 777);
  assert.equal(b.system, "SYS");
  assert.deepEqual(b.tool_choice, { type: "tool", name: "submit_result" });
  assert.equal(b.tools.length, 1);
  assert.equal(b.tools[0].name, "submit_result");
  assert.ok(b.tools[0].input_schema.properties.kind);
  assert.deepEqual(b.messages[0].content[0], { type: "text", text: "USER" });
  assert.deepEqual(b.messages[0].content[1], { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } });
  for (const k of ["temperature", "top_p", "top_k", "stream"]) assert.equal(k in b, false, k);
  assert.equal(JSON.stringify(b).includes(KEY), false, "the key is only ever in the header");
  assert.deepEqual(r.toolInputs, [OK.content[1].input]);
  assert.deepEqual(r.usage, { inTok: 1234, outTok: 56 });
  assert.equal(r.stopReason, "tool_use");
  assert.equal(r.text, "thinking");
  assert.ok(buildBody("m", req()).tools);
});

test("429 and 529 are retried with backoff inside the deadline; retry-after is honoured up to 3 seconds", async () => {
  const { p, calls, sleeps } = make([res(429, { error: { type: "rate_limit_error" } }, { "retry-after": "2" }), res(529, { error: { type: "overloaded_error" } }), res(200, OK)]);
  const r = await p.complete(req());
  assert.equal(calls.length, 3);
  assert.equal(r.stopReason, "tool_use");
  assert.equal(sleeps[0], 2000);
  assert.ok(sleeps[1] >= 900 && sleeps[1] <= 1500);
  const slow = make([res(429, { error: { type: "rate_limit_error" } }, { "retry-after": "999" }), res(200, OK)]);
  await slow.p.complete(req());
  assert.equal(slow.sleeps[0], 3000);
});

test("at most 3 attempts, then the error is reduced to a code, a status and the API's error type", async () => {
  const { p, calls } = make([() => res(503, { error: { type: "overloaded_error", message: "SECRET " + KEY } })]);
  await assert.rejects(() => p.complete(req()), (e) => {
    assert.ok(e instanceof ProviderError);
    assert.deepEqual([e.code, e.status, e.type], ["unavailable", 503, "overloaded_error"]);
    assert.equal(JSON.stringify(e).includes(KEY), false);
    assert.equal(String(e.message).includes(KEY), false);
    assert.equal(String(e.stack).includes(KEY), false);
    return true;
  });
  assert.equal(calls.length, 3);
});

test("401, 403, 400, 404, 413 and 422 are never retried; 401 and 403 are auth errors", async () => {
  for (const [status, code] of [[401, "auth"], [403, "auth"], [400, "unavailable"], [404, "unavailable"], [413, "unavailable"], [422, "unavailable"]]) {
    const { p, calls } = make([() => res(status, { error: { type: "invalid_request_error", message: "x" } })]);
    await assert.rejects(() => p.complete(req()), (e) => e.code === code && e.status === status);
    assert.equal(calls.length, 1, String(status));
  }
});

test("a network error is retried; an abort at the deadline is a timeout and is not retried", async () => {
  const a = make([new TypeError("fetch failed"), res(200, OK)]);
  assert.equal((await a.p.complete(req())).stopReason, "tool_use");
  assert.equal(a.calls.length, 2);
  const hang = make([(init) => new Promise((_, rej) => { init.signal.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))); })]);
  const t0 = Date.now();
  await assert.rejects(() => hang.p.complete(req({ deadlineAtMs: Date.now() + 60 })), (e) => e.code === "timeout");
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(hang.calls.length, 1);
  await assert.rejects(() => make([res(200, OK)]).p.complete(req({ deadlineAtMs: Date.now() - 1 })), (e) => e.code === "timeout");
});

test("max_tokens, prose, two tool calls and junk are reported as they are (the parser rejects them)", async () => {
  const cut = await make([res(200, Object.assign({}, OK, { stop_reason: "max_tokens" }))]).p.complete(req());
  assert.equal(cut.stopReason, "max_tokens");
  const prose = await make([res(200, Object.assign({}, OK, { stop_reason: "end_turn", content: [{ type: "text", text: "hello" }] }))]).p.complete(req());
  assert.deepEqual(prose.toolInputs, []);
  assert.equal(prose.text, "hello");
  const two = await make([res(200, Object.assign({}, OK, { content: [OK.content[1], OK.content[1]] }))]).p.complete(req());
  assert.equal(two.toolInputs.length, 2);
  await assert.rejects(() => make([res(200, { nope: true })]).p.complete(req()), (e) => e.code === "bad_response");
  await assert.rejects(() => make([new Response("<html>", { status: 200 })]).p.complete(req()), (e) => e.code === "bad_response");
});

test("a provider needs a key and a fetch; there is no setting for the address", () => {
  assert.throws(() => createAnthropicProvider({ model: "m", fetchFn: () => {} }), /API key/);
  assert.throws(() => createAnthropicProvider({ apiKey: KEY, model: "m" }), /fetchFn/);
  const p = createAnthropicProvider({ apiKey: KEY, model: "m", fetchFn: () => {}, baseUrl: "https://evil.example" });
  assert.equal(JSON.stringify(Object.keys(p)).includes("evil"), false);
  assert.equal(JSON.stringify(p).includes(KEY), false);
  assertProvider(p);
});

test("replay: answers from recordings, deterministic, no network, fails loudly on an unknown key", async () => {
  const rec = { k1: { toolInputs: [{ kind: "clarify", summary: "s", question: "q" }], usage: { inTok: 5, outTok: 6 } }, k2: { throw: { code: "unavailable", status: 503 } } };
  const p = createReplayProvider({ recordings: rec });
  const a = await p.complete({ meta: { replayKey: "k1", mode: "edit" } });
  const b = await p.complete({ meta: { replayKey: "k1", mode: "edit" } });
  assert.deepEqual(a, b);
  assert.deepEqual(a.usage, { inTok: 5, outTok: 6 });
  a.toolInputs[0].kind = "patch";
  assert.equal((await p.complete({ meta: { replayKey: "k1" } })).toolInputs[0].kind, "clarify", "a caller cannot change a recording");
  await assert.rejects(() => p.complete({ meta: { replayKey: "k2" } }), (e) => e.code === "unavailable" && e.status === 503);
  await assert.rejects(() => p.complete({ meta: { replayKey: "nope" } }), (e) => e.code === "bad_response");
  await assert.rejects(() => p.complete({ meta: { replayKey: "__proto__" } }), (e) => e.code === "bad_response");
  assert.equal(p.calls.length, 6);
  assertProvider(p);
});

test("disabled: can never be called successfully", async () => {
  const p = createDisabledProvider();
  await assert.rejects(() => p.complete({}), (e) => e.code === "disabled");
  assertProvider(p);
  assert.throws(() => assertProvider({ id: "x", model: "m", complete() {} }), /provider.id/);
  assert.throws(() => assertProvider(null), /provider/);
});

test("the key header never follows a redirect", async () => {
  const { p, calls } = make([res(200, OK)]);
  await p.complete(req({}));
  assert.equal(calls[0].init.redirect, "manual", "a 3xx must not carry x-api-key to another host");
});
