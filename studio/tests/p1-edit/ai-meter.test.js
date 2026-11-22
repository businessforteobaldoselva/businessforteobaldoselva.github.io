"use strict";
// The AI panel's cost meter, estimate, finish signal and recent requests (studio/PHASE1-DESIGN.md 9.5): the pure view-model and the REAL panel
// code on the test DOM against the shared example payloads (tests/fixtures/phase1/*.json, the same files the API's validators are tested with).
globalThis.window = globalThis.window || {};
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const V = require("../../overlay/ext/ai-view.js");
const shapes = require("../../api/shapes/phase1.js");
const { createHost, createFakeApi, SAMPLE, clone } = require("../ai-ui/harness/host.js");

const fx = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, "..", "fixtures", "phase1", n), "utf8"));
const open = async (o) => { const h = createHost(o); h.openPanel(); await h.settle(); return h; };
const estimateCalls = (h) => h.api.calls.filter((c) => c.path === "/v1/ai/estimate");

test("the fixtures the overlay is tested against are the ones the API is validated with", () => {
  assert.deepEqual(shapes.validateAiMeter(fx("ai-meter.json")), []);
  assert.deepEqual(shapes.validateAiEstimate(fx("ai-estimate.json")), []);
  assert.deepEqual(shapes.validateAiRecent(fx("ai-recent.json")), []);
});

test("meter lines: percent, seconds, and the 'did not count' sentence", () => {
  assert.deepEqual(V.meterLines({ usedTokens: 1, tookMs: 5200, pctOfDayUsed: 2.54, requestsLeftToday: 3, counted: true }), ["Used about 2.5% of today's allowance (5 seconds)."]);
  assert.deepEqual(V.meterLines({ usedTokens: 1, tookMs: 400, pctOfDayUsed: 0.04, requestsLeftToday: 3, counted: false }), ["Used less than 0.1% of today's allowance (1 second).", "This one did not count toward your limit."]);
  assert.deepEqual(V.meterLines({ usedTokens: 1, tookMs: 9000, pctOfDayUsed: 14.6, requestsLeftToday: 3, counted: true }), ["Used about 15% of today's allowance (9 seconds)."]);
  assert.deepEqual(V.meterLines(null), []);
});

test("normalizeMeter refuses anything that is not plain numbers", () => {
  assert.equal(V.normalizeMeter({ usedTokens: "7", tookMs: 1, pctOfDayUsed: 1, requestsLeftToday: 1, counted: true }), null);
  assert.equal(V.normalizeMeter({ usedTokens: 7, tookMs: 1, pctOfDayUsed: 101, requestsLeftToday: 1, counted: true }), null);
  assert.equal(V.normalizeMeter({ usedTokens: 7, tookMs: 1, pctOfDayUsed: 1, requestsLeftToday: 1 }), null);
  assert.deepEqual(V.normalizeMeter(fx("ai-meter.json")), fx("ai-meter.json"));
  assert.equal(V.normalizeProposal(Object.assign(clone(SAMPLE.proposals.patch), { meter: "<b>lots</b>" })).meter, null);
});

test("estimate lines use the smaller of the two 'left today' numbers and refuse an oversized request", () => {
  const e = V.normalizeEstimate(fx("ai-estimate.json"));
  assert.deepEqual(V.estimateLines(e), ["About 0.4% of today's AI allowance.", "You have 55 suggestions left today."]);
  assert.equal(e.wouldFit, true);
  const one = V.normalizeEstimate({ estimate: Object.assign({}, fx("ai-estimate.json").estimate, { yourRequestsLeftToday: 1 }) });
  assert.match(V.estimateLines(one)[1], /You have 1 suggestion left today\./);
  const big = V.normalizeEstimate({ estimate: Object.assign({}, fx("ai-estimate.json").estimate, { wouldFit: false }) });
  assert.equal(big.wouldFit, false);
  assert.match(big.reason, /not enough of today's allowance/i);
  const none = V.normalizeEstimate({ estimate: Object.assign({}, fx("ai-estimate.json").estimate, { yourRequestsLeftToday: 0 }) });
  assert.equal(none.wouldFit, false);
  assert.match(none.reason, /used all your suggestions/);
  assert.equal(V.normalizeEstimate({ estimate: { label: "x" } }), null);
});

test("recent requests: a date, a kind, 'N of M accepted' and an https link only; never any instruction text", () => {
  const rows = V.normalizeRecent(fx("ai-recent.json"));
  assert.deepEqual(rows, [
    { date: "22 Nov", kind: "Change", accepted: "2 of 3 accepted", url: "https://github.com/o/r/pull/58" },
    { date: "22 Nov", kind: "Not usable", accepted: "Not saved", url: null },
  ]);
  const evil = V.normalizeRecent({ items: [{ at: "2026-11-22T09:30:00Z", kind: "patch", accepted: 1, total: 1, prUrl: "javascript:alert(1)", instruction: "secret words" }, { at: "2026-11-22T09:30:00Z", kind: "<img>", accepted: 1, total: 1, prUrl: "http://example.org/x" }, { at: "x", kind: "patch", total: 1, prUrl: "https://u:p@example.org/" }] });
  assert.deepEqual(evil.map((r) => r.url), [null, null, null]);
  assert.equal(evil[1].kind, "Request");
  assert.ok(!JSON.stringify(evil).includes("secret words"));
});

test("a rejected answer says it did not count; the new service message is the shared sentence", () => {
  assert.equal(V.errorInfo({ code: "ai_bad_output" }).notCounted, true);
  assert.equal(V.errorInfo({ code: "ai_unavailable" }).notCounted, undefined);
  assert.match(V.errorInfo({ code: "service_unavailable" }).message, /Your edits on this page are safe/);
});

test("estimate: asked once after the person pauses (not on every keystroke), without a key, and shown as two plain sentences", async () => {
  const h = await open();
  assert.equal(h.q("#csx-ai-est").textContent, "");
  for (const t of ["Make", "Make the", "Make the hero", "Make the hero shorter", "Make the hero shorter and warmer"]) h.type("#csx-ai-instr", t);
  assert.equal(estimateCalls(h).length, 0, "nothing is asked while typing");
  await h.settle(2, 800);
  const calls = estimateCalls(h);
  assert.equal(calls.length, 1, "one estimate for the pause");
  assert.equal(calls[0].body.idempotencyKey, undefined);
  assert.equal(calls[0].body.mode, "edit");
  assert.equal(h.q("#csx-ai-est").textContent, "About 0.4% of today's AI allowance. You have 55 suggestions left today.");
  assert.equal(h.q("#csx-ai-est").getAttribute("aria-live"), "polite");
  assert.equal(h.api.calls.filter((c) => c.path === "/v1/ai/propose").length, 0, "an estimate never asks the model");
  h.close();
});

test("estimate: nothing under 10 characters, and the old answer is cleared when the text changes", async () => {
  const h = await open();
  h.type("#csx-ai-instr", "short");
  await h.settle(2, 800);
  assert.equal(estimateCalls(h).length, 0);
  h.type("#csx-ai-instr", "Make the hero shorter please");
  await h.settle(2, 800);
  assert.equal(estimateCalls(h).length, 1);
  assert.notEqual(h.q("#csx-ai-est").textContent, "");
  h.type("#csx-ai-instr", "Make the");
  assert.equal(h.q("#csx-ai-est").textContent, "", "stale numbers are gone at once");
  h.close();
});

test("estimate: a request that would not fit disables the button with the reason; a failing estimate never blocks the request", async () => {
  const h = await open();
  h.api.estimate = { estimate: Object.assign({}, fx("ai-estimate.json").estimate, { wouldFit: false, label: "About 40% of today's AI allowance." }) };
  h.type("#csx-ai-instr", "Translate the whole page into Welsh");
  await h.settle(2, 800);
  assert.equal(h.must("[data-act='submit']").disabled, true);
  assert.match(h.q("#csx-ai-hint").textContent, /not enough of today's allowance/i);
  h.close();
  const h2 = await open();
  h2.api.estimate = null; // older API: the route does not exist
  h2.type("#csx-ai-instr", "Make the hero shorter please");
  await h2.settle(2, 800);
  assert.equal(h2.q("#csx-ai-est").textContent, "");
  assert.equal(h2.must("[data-act='submit']").disabled, false);
  h2.close();
});

test("estimate: not asked when AI is off, and not after the request was sent", async () => {
  const h = createHost();
  h.api.statusKey = "disabled";
  h.openPanel();
  await h.settle();
  assert.equal(estimateCalls(h).length, 0);
  h.close();
  const sent = await open();
  sent.type("#csx-ai-instr", "Make the hero shorter please");
  sent.must("[data-act='submit']").click();
  await sent.settle(2, 800);
  assert.equal(estimateCalls(sent).length, 0, "a pending estimate was cancelled by sending");
  sent.close();
});

test("result: the meter line is shown under the summary", async () => {
  const api = createFakeApi();
  const p = clone(SAMPLE.proposals.patch);
  p.meter = { usedTokens: 7400, tookMs: 5200, pctOfDayUsed: 2.54, requestsLeftToday: 139, counted: true };
  api.queue.push(p);
  const h = await open({ api });
  await h.ask("Make the hero shorter");
  assert.equal(h.must("[data-meter]").textContent, "Used about 2.5% of today's allowance (5 seconds).");
  h.close();
});

test("rejected answer: the error screen says it did not count toward the limit", async () => {
  const api = createFakeApi();
  api.queue.push({ status: 502, error: SAMPLE.errors.ai_bad_output });
  const h = await open({ api });
  await h.ask("Make the hero shorter");
  assert.equal(h.must("[data-not-counted]").textContent, "This one did not count toward your limit.");
  h.close();
});

test("finish signal: while the page is hidden a toast and a dock dot say it is ready; in front, nothing extra", async () => {
  const inFront = await open();
  await inFront.ask("Make the hero shorter");
  assert.deepEqual(inFront.toasts.map((t) => t.message), [], "the person is looking at the panel");
  assert.deepEqual(inFront.attention, []);
  inFront.close();
  const away = await open();
  away.document.hidden = true;
  await away.ask("Make the hero shorter");
  assert.deepEqual(away.toasts.map((t) => t.message), ["Your suggestion is ready"]);
  assert.deepEqual(away.attention, [["ai", true]]);
  // no sound, no notification permission
  assert.ok(!/Notification|Audio|requestPermission/.test(fs.readFileSync(path.join(__dirname, "..", "..", "overlay", "ext", "ai.js"), "utf8")));
  away.close();
});

test("recent requests: a collapsed list that loads on open, shows rows and an https link, and says so plainly when it cannot load", async () => {
  const h = await open();
  assert.equal(h.api.calls.filter((c) => c.path === "/v1/ai/recent").length, 0, "nothing is fetched until it is opened");
  const d = h.must("[data-recent]");
  d.open = true;
  d.dispatchEvent(require("../ai-ui/harness/dom-stub.js").ev("toggle"));
  await h.settle();
  assert.equal(h.api.calls.filter((c) => c.path === "/v1/ai/recent").length, 1);
  const list = h.must("[data-recent-list]");
  assert.match(list.textContent, /22 Nov · Change · 2 of 3 accepted · Open the pull request/);
  assert.match(list.textContent, /22 Nov · Not usable · Not saved/);
  const a = list.querySelector("a");
  assert.equal(a.getAttribute("href"), "https://github.com/o/r/pull/58");
  assert.equal(a.getAttribute("rel"), "noopener noreferrer");
  h.close();
  const h2 = createHost();
  h2.api.recent = null;
  h2.openPanel();
  await h2.settle();
  const d2 = h2.must("[data-recent]");
  d2.open = true;
  d2.dispatchEvent(require("../ai-ui/harness/dom-stub.js").ev("toggle"));
  await h2.settle();
  assert.match(h2.must("[data-recent-list]").textContent, /not available right now/);
  h2.close();
});
