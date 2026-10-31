"use strict";
// The REAL panel code (ext/ai.js + ext/ai-view.js + core/dom.js h()) on the test DOM, against a fake of the three /v1/ai routes
// built from the shared sample file. Covers the flow the founders use: describe -> review -> tick some -> save as a draft, and
// every way it can stop: switched off, errors, cancel, stale suggestion, needs-code, clarify, tone check.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createHost, createFakeApi, SAMPLE, clone } = require("./harness/host.js");
const { ev } = require("./harness/dom-stub.js");

const open = async (o) => { const h = createHost(o); h.openPanel(); await h.settle(); return h; };
const names = (h, sel) => h.qa(sel).map((e) => e.textContent.trim());

test("registers the panel and four commands; commands only appear for a signed-in person in edit mode", async () => {
  const h = createHost();
  assert.deepEqual(Object.keys(h.panels), ["ai"]);
  const p = h.panels.ai;
  assert.equal(p.title, "Describe a change");
  assert.equal(p.minRole, "editor");
  assert.equal(p.order, 15);
  assert.deepEqual(h.commands.map((c) => c.id), ["ai.describe", "ai.alt", "ai.meta", "ai.tone"]);
  assert.deepEqual(h.commands.map((c) => c.title), ["Describe a change", "Suggest alt text for this picture", "Suggest a meta description", "Check the tone of this page"]);
  assert.ok(h.commands.every((c) => c.when() === true));
  const browse = createHost({ mode: "browse" });
  assert.ok(browse.commands.every((c) => c.when() === false));
  const out = createHost({ signedOut: true });
  assert.ok(out.commands.every((c) => c.when() === false));
});

test("signed out: a plain pointer to Account, no request is made", async () => {
  const h = await open({ signedOut: true });
  assert.equal(h.phase(), "signedOut");
  assert.match(h.text(), /Sign in to describe a change/);
  assert.equal(h.api.calls.length, 0);
  h.must("[data-act='account']").click();
  assert.deepEqual(h.opened, ["account"]);
  h.close();
});

for (const [key, copy] of [["disabled", /AI help is switched off\. A Studio admin can turn it on in the settings\. Everything else in Studio works as usual\./], ["no_key", /AI help is not connected yet\. A Studio admin needs to add the AI key in the settings\./], ["budget_exhausted", /Today's AI allowance is used up\. It starts again at midnight UTC \(1 am UK time in summer\)\./]]) {
  test("off state (" + key + "): the plain explanation, no input, no way to send anything", async () => {
    const api = createFakeApi(); api.statusKey = key;
    const h = await open({ api });
    assert.equal(h.phase(), "off");
    assert.match(h.text(), copy);
    assert.equal(h.q("textarea"), null, "no input is shown");
    assert.equal(h.q("[data-act='submit']"), null);
    assert.deepEqual(api.calls.map((c) => c.path), ["/v1/ai/status"], "only the status was asked for");
    h.close();
  });
}

test("status unreachable: says so and offers to check again", async () => {
  const api = createFakeApi(); api.statusFail = true;
  const h = await open({ api });
  assert.equal(h.phase(), "off");
  assert.match(h.text(), /could not check whether AI help is on/);
  api.statusFail = false;
  h.must("[data-act='recheck']").click();
  await h.settle();
  assert.equal(h.phase(), "idle");
  h.close();
});

test("idle: labelled field, live counter, mode buttons with pressed state, examples fill the box, empty cannot be sent", async () => {
  const h = await open();
  assert.equal(h.phase(), "idle");
  const ta = h.must("#csx-ai-instr");
  const lab = h.must("label[for='csx-ai-instr']");
  assert.match(lab.textContent, /What would you like to change\?/);
  assert.equal(ta.getAttribute("maxlength"), "1000");
  assert.match(ta.getAttribute("aria-describedby"), /csx-ai-count/);
  assert.equal(h.must("[data-act='submit']").disabled, true);
  assert.deepEqual(h.qa(".csx-ai-mode").map((b) => [b.textContent, b.getAttribute("aria-pressed")]), [["Describe a change", "true"], ["Alt text", "false"], ["Meta description", "false"], ["Tone check", "false"]]);
  h.type("#csx-ai-instr", "make it warmer");
  assert.equal(h.must("#csx-ai-count").textContent, "14 / 1000");
  assert.equal(h.must("[data-act='submit']").disabled, false);
  const ex = h.qa(".csx-ai-ex")[1];
  ex.click();
  assert.equal(h.must("#csx-ai-instr").value, ex.textContent);
  h.type("#csx-ai-instr", "x".repeat(1001));
  assert.equal(h.must("[data-act='submit']").disabled, true, "over 1000 characters cannot be sent");
  assert.match(h.must("#csx-ai-hint").textContent, /too long/);
  // switching mode keeps the text and changes the button
  h.qa(".csx-ai-mode")[3].click();
  assert.equal(h.must("[data-act='submit']").textContent, "Check the tone");
  h.close();
});

test("propose -> result: the request has exactly the allowed fields; cards show Before/After with real headings", async () => {
  const h = await open();
  await h.ask("make the hero shorter and warmer");
  const call = h.api.calls.find((c) => c.path === "/v1/ai/propose");
  assert.deepEqual(Object.keys(call.body).sort(), ["idempotencyKey", "instruction", "mode"]);
  assert.equal(call.body.mode, "edit");
  assert.equal(call.body.instruction, "make the hero shorter and warmer");
  assert.equal(h.phase(), "patch");
  assert.match(names(h, "h3")[0], /Suggested changes/);
  const cards = h.qa("[data-card]");
  assert.equal(cards.length, 2);
  assert.ok(cards.every((c) => c.getAttribute("role") === "group" && c.getAttribute("aria-labelledby")));
  const heads = names(h, "h5");
  assert.deepEqual(heads, ["Before", "After", "Before", "After"]);
  // the diff is shown as text nodes with a screen-reader cue and a non-colour cue (class names for underline / strikethrough)
  assert.ok(h.qa(".csx-ai-ins").length >= 1 && h.qa(".csx-ai-del").length >= 1);
  assert.match(h.must(".csx-ai-ins .csx-visually-hidden").textContent, /\[added\]/);
  assert.match(h.must(".csx-ai-del .csx-visually-hidden").textContent, /\[removed\]/);
  assert.equal(h.must("[data-act='save']").textContent, "Save 2 changes as a draft");
  assert.equal(h.must("[data-count]").textContent, "2 of 2 changes selected");
  assert.match(h.text(), /Nothing goes live until an approver publishes it\./);
  // focus moved to the result heading; the progress was announced
  assert.equal(h.document.activeElement.tagName, "H3");
  assert.match(h.live(), /2 changes suggested\. Review them below before saving\./);
  h.close();
});

test("save all: ONE accept request with exactly {idempotencyKey, proposal, accept, title}; the draft is selected; Nothing live toast", async () => {
  const h = await open();
  await h.ask("make the hero shorter and warmer");
  h.must("[data-act='save']").click();
  await h.settle();
  assert.equal(h.api.accepts.length, 1);
  const body = h.api.accepts[0];
  assert.deepEqual(Object.keys(body).sort(), ["accept", "idempotencyKey", "proposal", "title"]);
  assert.deepEqual(body.accept, ["c1", "c2"]);
  assert.deepEqual(Object.keys(body.proposal).sort(), ["base", "changes", "id", "instructionHash", "instructionPreview", "model"]);
  const sent = JSON.stringify(body.proposal.changes);
  assert.deepEqual(body.proposal.changes, SAMPLE.proposals.patch.changes.map((c) => ({ id: c.id, title: c.title, ops: c.ops })));
  assert.ok(!/deltas|defaultChecked|outsideAsk|sensitive/.test(sent));
  assert.equal(body.proposal.instructionPreview, "make the hero shorter and warmer");
  assert.equal(h.phase(), "saved");
  assert.match(h.text(), /Saved as a draft/);
  assert.match(h.text(), /Nothing is live yet\. An approver has to publish it first\./);
  assert.match(h.text(), /2 changes saved\./);
  assert.equal(h.drafts.set.length, 1);
  assert.equal(h.drafts.set[0].id, SAMPLE.acceptResponse.draft.id);
  assert.equal(h.drafts.refreshed, 1);
  assert.deepEqual(h.toasts.map((t) => t.message), ["Saved as a draft. Nothing is live yet."]);
  assert.equal(h.api.calls.filter((c) => c.path === "/v1/ai/propose").length, 1, "saving does not ask the AI again");
  // the draft actions
  h.must("[data-act='open-changes']").click();
  assert.deepEqual(h.opened.slice(-1), ["changes"]);
  h.must("[data-act='send-review']").click();
  await h.settle();
  assert.equal(h.drafts.submitted, 1);
  h.must("[data-act='another']").click();
  assert.equal(h.phase(), "idle");
  assert.equal(h.must("#csx-ai-instr").value, "");
  h.close();
});

test("partial accept: unticking a change sends only the ticked ids, and the button counts them", async () => {
  const h = await open();
  await h.ask("make the hero shorter and warmer");
  const second = h.must("input[data-change='c2']");
  second.click();
  assert.equal(second.checked, false);
  assert.equal(h.must("[data-act='save']").textContent, "Save 1 change as a draft");
  assert.equal(h.must("[data-count]").textContent, "1 of 2 changes selected");
  h.must("[data-act='save']").click();
  await h.settle();
  assert.deepEqual(h.api.accepts[0].accept, ["c1"]);
  assert.match(h.text(), /1 change saved \(1 left out\)\./);
  h.close();
});

test("nothing ticked: Save is disabled; Select all / Select none work; the count is announced", async () => {
  const h = await open();
  await h.ask("make the hero shorter and warmer");
  h.must("button[data-act]"); // sanity
  const none = h.qa("button").find((b) => b.textContent === "Select none");
  none.click();
  assert.equal(h.must("[data-act='save']").disabled, true);
  assert.equal(h.must("[data-count]").textContent, "No changes selected");
  await h.settle();
  assert.match(h.live(), /No changes selected/);
  h.qa("button").find((b) => b.textContent === "Select all").click();
  assert.equal(h.must("[data-act='save']").disabled, false);
  assert.ok(h.qa("input[data-change]").every((c) => c.checked));
  h.close();
});

test("flagged changes start unticked and say why; the safe one is ticked", async () => {
  const api = createFakeApi();
  api.queue.push(SAMPLE.proposals.patchOutside);
  const h = await open({ api });
  await h.ask("warm up the hero");
  const flagged = SAMPLE.proposals.patchOutside.changes.filter((c) => c.outsideAsk || c.sensitive);
  assert.ok(flagged.length >= 1);
  for (const c of SAMPLE.proposals.patchOutside.changes) {
    const cb = h.must("input[data-change='" + c.id + "']");
    assert.equal(cb.checked, !(c.outsideAsk || c.sensitive), c.id);
  }
  assert.match(h.text(), /Outside what you asked about/);
  assert.match(h.text(), /Changes where visitors go \(link or email\)|Outside what you asked about/);
  assert.ok(h.qa("[role='note']").length >= 1, "the injection warning is a note");
  assert.match(h.text(), /looks like instructions to an assistant/);
  // save sends only the unflagged one
  h.must("[data-act='save']").click();
  await h.settle();
  const sentIds = h.api.accepts[0].accept;
  for (const c of flagged) assert.ok(!sentIds.includes(c.id), c.id + " was not sent");
  h.close();
});

test("dependencies: ticking a change ticks what it needs, announced; unticking the first unticks the second", async () => {
  const api = createFakeApi();
  api.queue.push(SAMPLE.proposals.patchTwoChangesWithDependency);
  const h = await open({ api });
  await h.ask("add a venue question to the faq");
  assert.match(h.text(), /Goes together with: Add the question/);
  h.qa("button").find((b) => b.textContent === "Select none").click();
  h.must("input[data-change='c2']").click();
  assert.equal(h.must("input[data-change='c1']").checked, true);
  assert.match(h.must("[data-also]").textContent, /Also selected .Add the question. because it goes together with this\./);
  await h.settle();
  assert.match(h.live(), /Also selected/);
  h.must("input[data-change='c1']").click();
  assert.equal(h.must("input[data-change='c2']").checked, false);
  assert.match(h.must("[data-also]").textContent, /Also unselected/);
  h.close();
});

test("Discard clears the suggestion without any request", async () => {
  const h = await open();
  await h.ask("make the hero shorter");
  const before = h.api.calls.length;
  h.qa("button").find((b) => b.textContent === "Discard").click();
  assert.equal(h.phase(), "idle");
  assert.equal(h.api.calls.length, before);
  assert.equal(h.api.accepts.length, 0);
  assert.equal(h.must("#csx-ai-instr").value, "make the hero shorter", "the instruction is kept so it can be edited");
  h.close();
});

test("working: progress line in a polite live region, Cancel stops it, a late answer is ignored", async () => {
  const api = createFakeApi();
  const release = api.pause();
  const h = await open({ api });
  h.type("#csx-ai-instr", "translate the faq to welsh");
  h.must("[data-act='submit']").click();
  await h.settle(2);
  assert.equal(h.phase(), "working");
  assert.equal(h.must(".csx-ai").getAttribute("aria-busy"), "true");
  assert.match(h.must("[data-working-line]").textContent, /Thinking about it… this usually takes 5 to 20 seconds\./);
  assert.match(h.live(), /Thinking about it/);
  h.must("[data-act='cancel']").click();
  assert.equal(h.phase(), "idle");
  await h.settle();
  assert.match(h.live(), /Cancelled\. Nothing was changed\./);
  release();
  await h.settle();
  assert.equal(h.phase(), "idle", "the answer that arrives after Cancel is ignored");
  assert.equal(h.api.accepts.length, 0);
  h.close();
});

const ERR = SAMPLE.errors;
for (const [code, status, body, copy] of [
  ["ai_unavailable", 502, ERR.ai_unavailable, /The AI service did not answer\. Nothing was changed\. Try again in a minute\./],
  ["ai_bad_output", 502, ERR.ai_bad_output, /The AI gave an answer Studio could not safely use, so nothing was changed\. You can ask for another try\./],
]) {
  test("propose error " + code + ": fixed plain-English copy in an alert, a reference id, no raw error text, Try again works", async () => {
    const api = createFakeApi();
    api.queue.push({ error: body.error ? Object.assign({}, body, { requestId: body.requestId }) : body, status });
    const h = await open({ api });
    await h.ask("make the hero shorter");
    assert.equal(h.phase(), "error");
    assert.match(h.text(), copy);
    assert.ok(!/path_outside_allowlist|ops\/1|violations/.test(h.text()), "violation details are not shown");
    assert.equal(h.must("[role='alert']").getAttribute("data-error"), code);
    assert.match(h.text(), /Reference: 11111111-2222-4333-8444-555555555555/);
    await h.settle();
    assert.match(h.live(), /nothing was changed|Nothing was changed/);
    h.must("[data-act='try-again']").click();
    await h.settle();
    assert.equal(h.phase(), "patch", "the second try (the fake now answers) shows the suggestion");
    h.close();
  });
}

test("propose error rate_limited: says how long to wait", async () => {
  const api = createFakeApi();
  api.queue.push({ status: 429, error: { error: { code: "rate_limited", message: "Slow down", details: { retryAfter: 42 } }, requestId: "11111111-2222-4333-8444-555555555555" } });
  const h = await open({ api });
  await h.ask("make the hero shorter");
  assert.match(h.text(), /Try again in 42 seconds\./);
  h.close();
});

test("the day's allowance running out turns the panel into the off state", async () => {
  const api = createFakeApi();
  api.queue.push({ status: 429, error: ERR.ai_budget_exhausted });
  const h = await open({ api });
  await h.ask("make the hero shorter");
  assert.equal(h.phase(), "off");
  assert.match(h.text(), /Today's AI allowance is used up/);
  assert.equal(h.q("textarea"), null);
  h.close();
});

test("the kill switch flipped mid-session (503 ai_disabled) also ends in the off state", async () => {
  const api = createFakeApi();
  api.queue.push({ status: 503, error: ERR.ai_disabled });
  const h = await open({ api });
  await h.ask("make the hero shorter");
  assert.equal(h.phase(), "off");
  assert.match(h.text(), /AI help is switched off/);
  h.close();
});

test("a stale suggestion (409 on save): says so, nothing is saved, Ask again sends the same instruction", async () => {
  const api = createFakeApi();
  const h = await open({ api });
  await h.ask("make the hero shorter and warmer");
  api.acceptStatus = { status: 409, body: { error: { code: "conflict", message: "Changed since", details: { items: [] } }, requestId: "11111111-2222-4333-8444-555555555555" } };
  h.must("[data-act='save']").click();
  await h.settle();
  assert.equal(h.phase(), "error");
  assert.match(h.text(), /Something on the site changed since this suggestion was made\. Nothing was saved\./);
  assert.equal(h.drafts.set.length, 0);
  api.acceptStatus = null;
  h.must("[data-act='ask-again']").click();
  await h.settle();
  const proposes = h.api.calls.filter((c) => c.path === "/v1/ai/propose");
  assert.equal(proposes.length, 2);
  assert.equal(proposes[1].body.instruction, "make the hero shorter and warmer");
  assert.notEqual(proposes[1].body.idempotencyKey, proposes[0].body.idempotencyKey);
  assert.equal(h.phase(), "patch");
  h.close();
});

test("a 422 on save marks the card, keeps every tick, and moves focus to the first invalid card", async () => {
  const api = createFakeApi();
  const h = await open({ api });
  await h.ask("make the hero shorter and warmer");
  const op = SAMPLE.proposals.patch.changes[1].ops[0];
  api.acceptStatus = { status: 422, body: { error: { code: "validation_failed", message: "no", details: { problems: [{ code: "too_long", file: op.file, path: op.path, message: "That is too long: 90 of 60 characters." }] } }, requestId: "11111111-2222-4333-8444-555555555555" } };
  h.must("[data-act='save']").click();
  await h.settle();
  assert.equal(h.phase(), "patch");
  const bad = h.must("[data-invalid]");
  assert.equal(bad.getAttribute("data-card"), "c2");
  assert.match(bad.textContent, /That is too long: 90 of 60 characters\./);
  assert.equal(h.document.activeElement, bad);
  assert.match(h.text(), /Some changes cannot be saved yet/);
  assert.ok(h.qa("input[data-change]").every((c) => c.checked), "ticks survive");
  assert.equal(h.drafts.set.length, 0);
  h.close();
});

test("offline while saving: the suggestion stays, the message is plain, Try again is possible", async () => {
  const api = createFakeApi();
  const h = await open({ api });
  await h.ask("make the hero shorter and warmer");
  api.acceptStatus = { status: 0, body: { error: { code: "offline", message: "Network error" } } };
  h.must("[data-act='save']").click();
  await h.settle();
  assert.match(h.text(), /You seem to be offline\. Nothing was changed\./);
  assert.equal(h.phase(), "patch", "the suggestion is still on screen");
  assert.ok(h.q("[data-act='save']"));
  h.close();
});

test("needs-code: a card with the drafted request, Copy and Open Ask Claude, and NO Studio write", async () => {
  const api = createFakeApi();
  const h = await open({ api });
  await h.ask("make the hero video autoplay with parallax");
  assert.equal(h.phase(), "needs_code");
  assert.match(h.text(), /This needs a developer change/);
  assert.match(h.text(), /Studio only changes words, picture settings and colours\. Code changes go to Claude through Ask Claude\./);
  assert.equal(h.q("[data-act='save']"), null);
  const nc = SAMPLE.proposals.needs_code.needsCode.request;
  assert.equal(h.must("textarea[data-req='title']").value, nc.title);
  assert.equal(h.must("textarea[data-req='body']").value, nc.body);
  assert.equal(h.must("textarea[data-req='title']").getAttribute("readonly"), "");
  const link = h.must("a.csx-ai-link");
  assert.equal(link.getAttribute("href"), "https://page.test/admin/#/collections/requests/new");
  assert.equal(link.getAttribute("target"), "_blank");
  assert.match(link.getAttribute("rel"), /noopener/);
  h.must("[data-act='copy']").click();
  await h.settle();
  assert.equal(h.copied.length, 1);
  assert.match(h.copied[0], /^Title: Make the hero video autoplay/);
  assert.match(h.must("[data-copy-note]").textContent, /Request copied\. Paste it into Ask Claude\./);
  assert.equal(h.api.accepts.length, 0);
  assert.ok(h.api.calls.every((c) => c.path === "/v1/ai/status" || c.path === "/v1/ai/propose"), "no other request was made");
  h.close();
});

test("needs-code: the configured Ask Claude address is used only when it is a safe one", async () => {
  const good = await open({ previewConfig: { askClaudeUrl: "https://cms.example.test/new" } });
  await good.ask("change the font");
  assert.equal(good.must("a.csx-ai-link").getAttribute("href"), "https://cms.example.test/new");
  good.close();
  const bad = await open({ previewConfig: { askClaudeUrl: "javascript:alert(1)" } });
  await bad.ask("change the font");
  assert.equal(bad.must("a.csx-ai-link").getAttribute("href"), "https://page.test/admin/#/collections/requests/new");
  bad.close();
  const none = await open({ origin: "data:text/html,x" });
  await none.ask("change the font");
  assert.equal(none.q("a.csx-ai-link"), null, "no link rather than an unsafe one");
  none.close();
});

test("clarify: the question is shown and the answer goes back as feedback on the same proposal", async () => {
  const api = createFakeApi();
  const h = await open({ api });
  await h.ask("add a venue called Hope in Bristol");
  assert.equal(h.phase(), "clarify");
  assert.match(h.must(".csx-ai-question").textContent, /The site lists cities, not individual venues/);
  assert.equal(h.q("[data-act='save']"), null);
  const ta = h.must("#csx-ai-answer");
  ta.value = "Yes, mention it in the Bristol text";
  h.must("[data-act='answer']").click();
  await h.settle();
  const second = h.api.calls.filter((c) => c.path === "/v1/ai/propose")[1].body;
  assert.equal(second.retryOf, SAMPLE.proposals.clarify.id);
  assert.equal(second.feedback, "Yes, mention it in the Bristol text");
  assert.equal(second.instruction, "add a venue called Hope in Bristol");
  h.close();
});

test("Ask for another try: reveals a labelled box, sends retryOf and feedback", async () => {
  const h = await open();
  await h.ask("make the hero shorter and warmer");
  h.must("[data-act='retry-open']").click();
  assert.match(h.must("label[for='csx-ai-fb']").textContent, /What should be different\?/);
  assert.equal(h.document.activeElement.id, "csx-ai-fb");
  h.type("#csx-ai-fb", "shorter please");
  h.must("[data-act='retry-go']").click();
  await h.settle();
  const second = h.api.calls.filter((c) => c.path === "/v1/ai/propose")[1].body;
  assert.equal(second.retryOf, SAMPLE.proposals.patch.id);
  assert.equal(second.feedback, "shorter please");
  assert.equal(h.phase(), "patch");
  h.close();
});

test("tone check: verdict in words, findings, a 'Use this wording' card, then Save", async () => {
  const h = await open();
  h.qa(".csx-ai-mode")[3].click();
  h.must("[data-act='submit']").click();
  await h.settle();
  const call = h.api.calls.find((c) => c.path === "/v1/ai/propose");
  assert.equal(call.body.mode, "tone_check");
  assert.equal(call.body.context.page, "index");
  assert.equal(h.phase(), "tone");
  assert.match(h.must(".csx-ai-verdict").textContent, /On brand|Mostly on brand|Off brand/);
  assert.match(h.must("[data-quote]").textContent, /Unlock the future/);
  assert.match(h.text(), /Hype wording\./);
  assert.match(h.text(), /Use this wording/);
  h.must("[data-act='save']").click();
  await h.settle();
  assert.equal(h.api.accepts.length, 1);
  h.close();
});

test("alt text and meta description: same patch screen; meta shows the length guidance", async () => {
  const h = await open();
  h.qa(".csx-ai-mode")[1].click();
  assert.ok(h.q("input[type='checkbox']"), "the 'find pictures with no description' option is offered without a selected picture");
  h.must("[data-act='submit']").click();
  await h.settle();
  const call = h.api.calls.find((c) => c.path === "/v1/ai/propose");
  assert.deepEqual(call.body.context, { scope: "missing" });
  assert.equal(h.phase(), "patch");
  h.close();
  const api = createFakeApi();
  const p = clone(SAMPLE.proposals.alt);
  p.mode = "meta_description";
  p.changes[0].deltas[0].after = { type: "text", text: "Short.", truncated: false };
  p.changes[0].deltas[0].diff = null;
  api.queue.push(p);
  const m = await open({ api });
  m.qa(".csx-ai-mode")[2].click();
  m.must("[data-act='submit']").click();
  await m.settle();
  assert.match(m.must("[data-meta]").textContent, /6 characters\. A little short: 70 to 160 works best\./);
  m.close();
});

test("the selected element becomes a removable chip and goes in as context; picking another replaces it", async () => {
  const h = createHost();
  h.state.selection = "hero.headlineMain";
  h.openPanel(); await h.settle();
  assert.match(h.must(".csx-ai-chips").textContent, /About: Label for hero\.headlineMain/);
  h.studio.emit("selection", { ref: "hero.subhead" });
  assert.match(h.must(".csx-ai-chip").textContent, /hero\.subhead/);
  assert.equal(h.qa(".csx-ai-chip").length, 1);
  await h.ask("make this warmer");
  assert.deepEqual(h.api.calls.find((c) => c.path === "/v1/ai/propose").body.context, { refs: ["hero.subhead"] });
  h.close();
  const g = createHost();
  g.state.selection = "hero.headlineMain";
  g.openPanel(); await g.settle();
  g.must(".csx-ai-x").click();
  assert.equal(g.q(".csx-ai-chip"), null);
  assert.match(g.must(".csx-ai-x, #csx-ai-instr").tagName, /TEXTAREA|BUTTON/);
  await g.ask("make the footer shorter");
  assert.equal(g.api.calls.find((c) => c.path === "/v1/ai/propose").body.context, undefined);
  g.close();
});

test("commands open the panel in the right mode with the selection as context", async () => {
  const h = createHost();
  h.state.selection = "how.story.0.alt";
  h.commands.find((c) => c.id === "ai.alt").run();
  assert.deepEqual(h.opened, ["ai"]);
  h.openPanel(); await h.settle();
  assert.equal(h.must(".csx-ai-mode[aria-pressed='true']").textContent, "Alt text");
  assert.match(h.must(".csx-ai-chips").textContent, /how\.story\.0\.alt/);
  // with the panel already open, the command switches the mode in place
  h.commands.find((c) => c.id === "ai.meta").run();
  await h.settle();
  assert.equal(h.must(".csx-ai-mode[aria-pressed='true']").textContent, "Meta description");
  h.close();
});

test("closing the panel mid-request does not throw or paint later", async () => {
  const api = createFakeApi();
  const release = api.pause();
  const h = await open({ api });
  h.type("#csx-ai-instr", "translate the faq");
  h.must("[data-act='submit']").click();
  await h.settle(2);
  const container = h.container;
  h.close();
  release();
  await h.settle();
  assert.equal(container.childNodes.length, 0, "nothing was painted after close");
});
