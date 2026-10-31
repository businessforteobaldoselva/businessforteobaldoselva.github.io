"use strict";
globalThis.window = globalThis.window || {}; // the ext modules end with })(window.__CoveredStudioBoot); outside a browser they only export their pure parts
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const V = require("../../overlay/ext/ai-view.js");

const SAMPLE = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "fixtures", "ai-proposals.sample.json"), "utf8"));
const clone = (x) => JSON.parse(JSON.stringify(x));
const KEY = "6b1d2c3e-4f50-4a61-8b72-9c8d7e6f5a40";
const ENABLED = SAMPLE.status.enabled;

// a reducer run from a state, ignoring the steps that are not under test
function run(actions, from) {
  let s = from || V.initialState({ signedIn: true });
  for (const a of actions) s = V.reduce(s, a);
  return s;
}
const ready = () => run([{ type: "status", status: ENABLED }]);
const working = (instruction) => run([{ type: "instruction", text: instruction || "make the hero shorter" }, { type: "submit", key: KEY }], ready());
const withResult = (proposal) => run([{ type: "result", proposal: clone(proposal) }], working());

test("every sample proposal turns into a safe view without throwing", () => {
  for (const [name, p] of Object.entries(SAMPLE.proposals)) {
    const v = V.normalizeProposal(clone(p));
    assert.ok(v, name);
    assert.equal(v.kind, p.kind, name);
    assert.equal(v.changes.length, p.changes.length, name);
    for (const c of v.changes) {
      assert.ok(c.title && c.deltas.length, name + " " + c.id);
      for (const d of c.deltas) assert.ok(d.label, name + " delta label");
    }
    // and a full pass through the reducer into the result state
    const s = withResult(p);
    assert.equal(s.phase, "result", name);
  }
});

test("the state machine: signed out -> loading -> off / idle -> working -> result -> saving -> saved", () => {
  let s = V.initialState({ signedIn: false });
  assert.equal(s.phase, "signedOut");
  s = V.reduce(s, { type: "auth", signedIn: true });
  assert.equal(s.phase, "loadingStatus");
  const off = V.reduce(s, { type: "status", status: SAMPLE.status.disabled });
  assert.equal(off.phase, "off");
  assert.equal(V.offReasonOf(off), "disabled");
  assert.equal(V.reduce(s, { type: "status", status: SAMPLE.status.no_key }).phase, "off");
  assert.equal(V.offReasonOf(V.reduce(s, { type: "status", status: SAMPLE.status.budget_exhausted })), "budget_exhausted");
  assert.equal(V.reduce(s, { type: "statusFail" }).offReason, "unreachable");
  s = V.reduce(s, { type: "status", status: ENABLED });
  assert.equal(s.phase, "idle");
  // an empty instruction cannot be submitted in edit mode; the other modes may
  assert.equal(V.reduce(s, { type: "submit", key: KEY }).phase, "idle");
  assert.equal(V.reduce(V.reduce(s, { type: "mode", mode: "tone_check" }), { type: "submit", key: KEY }).phase, "working");
  s = V.reduce(s, { type: "instruction", text: "make the hero shorter" });
  s = V.reduce(s, { type: "submit", key: KEY });
  assert.equal(s.phase, "working");
  assert.equal(V.reduce(s, { type: "submit", key: "x" }).key, KEY, "a second click while working changes nothing");
  assert.equal(V.reduce(s, { type: "mode", mode: "alt_text" }).mode, "edit", "the mode cannot change while working");
  const res = V.reduce(s, { type: "result", proposal: clone(SAMPLE.proposals.patch) });
  assert.equal(res.phase, "result");
  const saving = V.reduce(res, { type: "save", key: "k2" });
  assert.equal(saving.phase, "saving");
  assert.equal(V.reduce(saving, { type: "discard" }).phase, "saving", "discard does nothing while saving (the draft is being made)");
  const saved = V.reduce(saving, { type: "saved", saved: { accepted: 2, total: 2 } });
  assert.equal(saved.phase, "saved");
  assert.equal(V.reduce(saved, { type: "reset", clearInstruction: true }).phase, "idle");
  assert.equal(V.reduce(res, { type: "discard" }).phase, "idle");
  assert.equal(V.reduce(V.reduce(s, { type: "cancel" }), { type: "result", proposal: clone(SAMPLE.proposals.patch) }).phase, "idle", "a late answer after Cancel is ignored");
  // a result with no usable shape is an error, never a blank panel
  assert.equal(V.reduce(s, { type: "result", proposal: null }).phase, "error");
});

test("the default ticks: flagged changes are never ticked for you, whatever the server says", () => {
  const p = clone(SAMPLE.proposals.patchOutside);
  const s = withResult(p);
  const flagged = s.view.changes.filter((c) => c.outsideAsk || c.sensitive);
  assert.ok(flagged.length >= 1, "the sample has a flagged change");
  for (const c of s.view.changes) assert.equal(!!s.checked[c.id], !c.outsideAsk && !c.sensitive && c.defaultChecked, c.id);
  // a server bug (defaultChecked true on a flagged change) must not tick it
  p.changes.forEach((c) => { c.defaultChecked = true; });
  const s2 = withResult(p);
  for (const c of s2.view.changes) if (c.outsideAsk || c.sensitive) assert.equal(!!s2.checked[c.id], false, c.id + " stays unticked");
  // and an unflagged change the server did not tick stays unticked
  const p3 = clone(SAMPLE.proposals.patch);
  p3.changes[0].defaultChecked = false;
  assert.equal(!!withResult(p3).checked.c1, false);
});

test("closure: ticking a change ticks what it needs; unticking a change unticks what needs it", () => {
  const s = withResult(SAMPLE.proposals.patchTwoChangesWithDependency);
  assert.deepEqual(s.view.changes.map((c) => c.requires), [[], ["c1"]]);
  let t = V.reduce(s, { type: "selectNone" });
  assert.deepEqual(V.selectedIds(t.view, t.checked), []);
  t = V.reduce(t, { type: "toggle", id: "c2", on: true });
  assert.deepEqual(V.selectedIds(t.view, t.checked), ["c1", "c2"], "c1 comes along");
  assert.match(t.note, /Also selected .Add the question. because it goes together/);
  t = V.reduce(t, { type: "toggle", id: "c1", on: false });
  assert.deepEqual(V.selectedIds(t.view, t.checked), [], "c2 goes with it");
  assert.match(t.note, /Also unselected .Say how fast we reply./);
  // unticking the one that needs another leaves the other alone
  t = V.reduce(V.reduce(t, { type: "toggle", id: "c2", on: true }), { type: "toggle", id: "c2", on: false });
  assert.deepEqual(V.selectedIds(t.view, t.checked), ["c1"]);
  assert.equal(t.note, "");
  // a selection nobody could save is repaired by unticking, never by ticking
  assert.deepEqual(V.normalizeChecked(t.view.changes, { c2: true }), { c2: false });
  // long chains and cycles do not hang
  const chain = [1, 2, 3, 4, 5].map((n) => ({ id: "c" + n, requires: n > 1 ? ["c" + (n - 1)] : [] }));
  assert.deepEqual(V.closure(chain, ["c5"]), ["c1", "c2", "c3", "c4", "c5"]);
  const cyc = [{ id: "c1", requires: ["c2"] }, { id: "c2", requires: ["c1"] }];
  assert.deepEqual(V.closure(cyc, ["c1"]), ["c1", "c2"]);
  assert.deepEqual(V.dependents(cyc, "c1"), ["c2"]);
  // select all ticks even the flagged ones (the person asked for it)
  const o = V.reduce(withResult(SAMPLE.proposals.patchOutside), { type: "selectAll" });
  assert.equal(V.selectedIds(o.view, o.checked).length, o.view.changes.length);
});

test("normalizeProposal repairs dependency lists a hostile server could send", () => {
  const p = clone(SAMPLE.proposals.patchTwoChangesWithDependency);
  p.changes[1].requires = ["c2", "zz", "c1", "<b>"];
  p.changes.push(clone(p.changes[0])); // duplicate id
  const v = V.normalizeProposal(p);
  assert.equal(v.changes.length, 2);
  assert.deepEqual(v.changes[1].requires, ["c1"]);
});

test("the save button and the counters are plain English", () => {
  assert.equal(V.saveLabel(1), "Save 1 change as a draft");
  assert.equal(V.saveLabel(3), "Save 3 changes as a draft");
  assert.equal(V.countText(0, 4), "No changes selected");
  assert.equal(V.countText(2, 4), "2 of 4 changes selected");
  assert.equal(V.countText(1, 1), "1 of 1 change selected");
  assert.equal(V.counterText(12), "12 / 1000");
  assert.match(V.COPY.safety, /Nothing goes live until an approver publishes it/);
  assert.equal(V.workingMessage(0), V.COPY.working0);
  assert.equal(V.workingMessage(8), V.COPY.working8);
  assert.equal(V.workingMessage(25), V.COPY.working20);
});

test("fixed copy for every off reason and every error code (no raw error text ever reaches the panel)", () => {
  assert.equal(V.offCopy("disabled"), "AI help is switched off. A Studio admin can turn it on in the settings. Everything else in Studio works as usual.");
  assert.equal(V.offCopy("no_key"), "AI help is not connected yet. A Studio admin needs to add the AI key in the settings.");
  assert.equal(V.offCopy("budget_exhausted"), "Today's AI allowance is used up. It starts again at midnight UTC (1 am UK time in summer).");
  assert.equal(V.offCopy("whatever"), V.offCopy("disabled"));
  const secret = "Error: ECONNRESET at /srv/app/node_modules/x.js:44 token=abc123";
  const codes = ["ai_disabled", "ai_budget_exhausted", "rate_limited", "ai_unavailable", "ai_bad_output", "bad_request", "payload_too_large", "conflict", "base_moved", "draft_moved", "validation_failed", "unauthorized", "forbidden", "not_invited", "offline", "aborted", "internal", "something_new"];
  for (const code of codes) {
    const info = V.errorInfo({ code, message: secret, requestId: "11111111-2222-4333-8444-555555555555", details: { problems: [] } });
    assert.ok(info.message && info.message.length > 10, code);
    assert.ok(!/ECONNRESET|node_modules|abc123|stack/i.test(info.message), code + " leaks raw text");
  }
  assert.equal(V.errorInfo({ code: "ai_unavailable" }).message, "The AI service did not answer. Nothing was changed. Try again in a minute.");
  assert.equal(V.errorInfo({ code: "ai_bad_output" }).message, "The AI gave an answer Studio could not safely use, so nothing was changed. You can ask for another try.");
  assert.equal(V.errorInfo({ code: "rate_limited", retryAfter: 42 }).message, "You have asked a lot in a short time. Try again in 42 seconds.");
  assert.match(V.errorInfo({ code: "rate_limited", retryAfter: 600 }).message, /Try again in 10 minutes/);
  assert.equal(V.errorInfo({ code: "rate_limited", retryAfter: -5 }).message, "You have asked a lot in a short time. Try again in 1 second.");
  assert.equal(V.errorInfo({ code: "bad_request" }, { instructionLength: 1500 }).message, "That request is too long. Keep it under 1,000 characters.");
  assert.equal(V.errorInfo({ code: "ai_disabled" }).off, "disabled");
  assert.equal(V.errorInfo({ code: "ai_budget_exhausted" }).off, "budget_exhausted");
  assert.deepEqual(V.errorInfo({ code: "conflict" }).actions, ["askAgain", "back"]);
  // the reference is shown only when it looks like an id
  assert.equal(V.errorInfo({ code: "internal", requestId: "<script>" }).requestId, null);
  assert.equal(V.errorInfo({ code: "internal", requestId: "11111111-2222-4333-8444-555555555555" }).requestId, "11111111-2222-4333-8444-555555555555");
});

test("failures move the state machine to the right screen and keep the person's ticks", () => {
  const w = working();
  assert.equal(V.reduce(w, { type: "fail", error: { code: "ai_unavailable" } }).phase, "error");
  const off = V.reduce(w, { type: "fail", error: { code: "ai_disabled" } });
  assert.equal(off.phase, "off");
  assert.equal(V.offReasonOf(off), "disabled");
  assert.equal(V.reduce(w, { type: "fail", error: { code: "ai_budget_exhausted" } }).status.reason, "budget_exhausted");
  // a failed SAVE keeps the suggestion and the ticks (validation) or asks to ask again (conflict)
  let s = V.reduce(withResult(SAMPLE.proposals.patchTwoChangesWithDependency), { type: "selectAll" });
  s = V.reduce(s, { type: "save", key: "k" });
  const bad = V.reduce(s, { type: "fail", error: { code: "validation_failed", details: { problems: [{ code: "too_long", file: "src/_data/faq.json", path: "/items/7/a", message: "Too long." }, { code: "type", file: "", path: "/accept", message: "Change 2 also needs change 1." }] } } });
  assert.equal(bad.phase, "result");
  assert.deepEqual(bad.problems.byChange, { c2: ["Too long."] });
  assert.deepEqual(bad.problems.general, [V.COPY.selection_incomplete]);
  assert.deepEqual(V.selectedIds(bad.view, bad.checked), ["c1", "c2"]);
  const stale = V.reduce(s, { type: "fail", error: { code: "conflict" } });
  assert.equal(stale.phase, "error");
  assert.deepEqual(stale.error.actions, ["askAgain", "back"]);
  // asking again from there is allowed and sends the same instruction
  const again = V.reduce(stale, { type: "submit", key: "k3", instruction: stale.lastInstruction });
  assert.equal(again.phase, "working");
  assert.equal(again.instruction, "make the hero shorter");
});

test("the propose body has exactly the allowed keys and caps everything", () => {
  const s = Object.assign(V.initialState({ signedIn: true }), { mode: "edit", instruction: "  make the hero shorter  ", refs: ["hero.headlineMain"] });
  assert.deepEqual(V.buildProposeBody(s, KEY, {}), { idempotencyKey: KEY, mode: "edit", instruction: "make the hero shorter", context: { refs: ["hero.headlineMain"] } });
  // refs are checked against the grammar, de-duplicated and capped at 5
  const many = Object.assign({}, s, { refs: ["a.b", "a.b", "<x>", "c.d", "e.f", "g.h", "i.j", "k.l", "m.n", "javascript:alert(1)"] });
  assert.deepEqual(V.buildProposeBody(many, KEY, {}).context.refs, ["a.b", "c.d", "e.f", "g.h", "i.j"]);
  assert.equal(V.buildProposeBody(Object.assign({}, s, { instruction: "x".repeat(5000) }), KEY, {}).instruction.length, 1000);
  assert.equal(V.buildProposeBody(Object.assign({}, s, { retryOf: "p_7f3k2m9qxa4d", feedback: "y".repeat(900) }), KEY, {}).feedback.length, 300);
  assert.equal(V.buildProposeBody(Object.assign({}, s, { retryOf: "../etc/passwd" }), KEY, {}).retryOf, undefined);
  assert.equal(V.buildProposeBody(s, KEY, { draftId: "u7k2m9qa--summer-edits" }).draftId, "u7k2m9qa--summer-edits");
  // page and "missing pictures" scopes only where they belong
  const meta = Object.assign({}, s, { mode: "meta_description", instruction: "", refs: [] });
  assert.deepEqual(V.buildProposeBody(meta, KEY, { page: "index" }), { idempotencyKey: KEY, mode: "meta_description", context: { page: "index" } });
  const alt = Object.assign({}, s, { mode: "alt_text", instruction: "", refs: [], scopeMissing: true });
  assert.deepEqual(V.buildProposeBody(alt, KEY, { page: "index" }).context, { scope: "missing" });
  const allowed = new Set(["idempotencyKey", "mode", "instruction", "context", "draftId", "retryOf", "feedback"]);
  for (const body of [V.buildProposeBody(s, KEY, { page: "index", draftId: "d" }), V.buildProposeBody(many, KEY, {}), V.buildProposeBody(meta, KEY, {})]) for (const k of Object.keys(body)) assert.ok(allowed.has(k), k);
});

test("the accept body is exactly the proposal as received (ops with expect) plus the ticked ids", () => {
  const p = clone(SAMPLE.proposals.patch);
  let s = withResult(p);
  s = Object.assign({}, s, { lastInstruction: "make the hero shorter and warmer" });
  s = V.reduce(s, { type: "toggle", id: "c2", on: false });
  const body = V.buildAcceptBody(s, "k9");
  assert.deepEqual(Object.keys(body).sort(), ["accept", "idempotencyKey", "proposal", "title"]);
  assert.deepEqual(body.accept, ["c1"]);
  assert.deepEqual(Object.keys(body.proposal).sort(), ["base", "changes", "id", "instructionHash", "instructionPreview", "model"]);
  assert.deepEqual(body.proposal.changes.map((c) => Object.keys(c).sort().join()), ["id,ops,title", "id,ops,title"], "no deltas or flags go back");
  assert.deepEqual(body.proposal.changes[0].ops, p.changes[0].ops, "ops are untouched, expect included");
  assert.ok(body.proposal.changes[0].ops[0].expect !== undefined);
  assert.equal(body.proposal.instructionPreview, "make the hero shorter and warmer");
  assert.ok(body.title.length <= 80);
  // the preview is one line, at most 200 characters
  const long = Object.assign({}, s, { lastInstruction: "a\n\nb ".repeat(200) });
  assert.ok(V.buildAcceptBody(long, "k").proposal.instructionPreview.length <= 200);
  assert.ok(!/\n/.test(V.buildAcceptBody(long, "k").proposal.instructionPreview));
});

test("Delta -> render plan: every Rendered type", () => {
  const rp = V.renderedPlan;
  assert.deepEqual(rp({ type: "text", text: "Hi", truncated: false }), { type: "text", text: "Hi", truncated: false });
  assert.equal(rp({ type: "bool", value: true }, "section").text, "Shown");
  assert.equal(rp({ type: "bool", value: false }, "section").text, "Hidden");
  assert.equal(rp({ type: "bool", value: true }, "toggle").text, "On");
  assert.deepEqual(rp({ type: "color", hex: "#472549" }), { type: "color", text: "#472549", hex: "#472549" });
  assert.equal(rp({ type: "color", hex: "red; background:url(x)" }).hex, null, "a colour that is not a hex never becomes a style");
  assert.equal(rp({ type: "link", text: "https://example.test/" }).text, "https://example.test/");
  assert.equal(rp({ type: "order", from: 6, to: 2, of: 12, itemLabel: "FAQ question 7" }).text, "Moves from position 7 to 3 of 12");
  assert.equal(rp({ type: "order", from: "a", to: 2, of: 12 }).text, V.COPY.notShown);
  const f = rp({ type: "fields", fields: [{ label: "Question", text: "Q?" }, { label: "Answer", text: "A." }] });
  assert.deepEqual(f.fields, [{ label: "Question", text: "Q?" }, { label: "Answer", text: "A." }]);
  assert.equal(rp({ type: "fields", fields: new Array(100).fill({ label: "x", text: "y" }) }).fields.length, V.LIMITS.fields);
  assert.equal(rp(null), null);
  assert.equal(rp({ type: "mystery" }).text, V.COPY.notShown);
  assert.equal(rp({ type: "text", text: "x".repeat(10000) }).text.length, V.LIMITS.text);
});

test("the text diff is trusted only when it rebuilds both texts; runs are merged and carry a screen-reader cue", () => {
  const d = clone(SAMPLE.proposals.patch.changes[0].deltas[0]);
  assert.ok(V.diffOk(d.diff, d.before, d.after), "the sample obeys the law");
  const plan = V.deltaPlan(d);
  assert.ok(plan.beforeRuns && plan.afterRuns);
  assert.equal(plan.beforeRuns.filter((r) => r.t === "same" || r.t === "del").map((r) => r.s).join(""), d.before.text);
  assert.equal(plan.afterRuns.filter((r) => r.t === "same" || r.t === "ins").map((r) => r.s).join(""), d.after.text);
  assert.ok(plan.afterRuns.some((r) => r.t === "ins" && r.sr === "[added] "));
  assert.ok(plan.beforeRuns.some((r) => r.t === "del" && r.sr === "[removed] "));
  assert.ok(!plan.beforeRuns.some((r) => r.t === "ins"), "the before side never shows additions");
  // a diff that does not rebuild the texts is dropped: the plain before/after is shown instead
  const lie = clone(d);
  lie.diff = [{ t: "same", s: "totally different" }];
  assert.equal(V.deltaPlan(lie).beforeRuns, null);
  // bad segment shapes, too many segments, and a diff on non-text sides
  assert.equal(V.diffOk([{ t: "boom", s: "x" }], d.before, d.after), false);
  assert.equal(V.diffOk(new Array(500).fill({ t: "same", s: "" }), d.before, d.after), false);
  assert.equal(V.diffOk(d.diff, { type: "bool", value: true }, d.after), false);
  assert.equal(V.diffOk("x", d.before, d.after), false);
  // adjacent runs of one type are merged
  const merged = V.sideRuns([{ t: "same", s: "a " }, { t: "ins", s: "b " }, { t: "ins", s: "c" }, { t: "del", s: "zzz" }], "after");
  assert.deepEqual(merged.map((r) => [r.t, r.s]), [["same", "a "], ["ins", "b c"]]);
});

test("added and removed items have honest placeholders", () => {
  const add = V.deltaPlan({ op: "add", kind: "list", label: "FAQ > Question 8", before: null, after: { type: "fields", fields: [{ label: "Question", text: "Q" }] }, diff: null });
  assert.equal(add.beforeNote, V.COPY.nothingBefore);
  const rem = V.deltaPlan({ op: "remove", kind: "list", label: "FAQ > Question 8", before: { type: "fields", fields: [] }, after: null, diff: null });
  assert.equal(rem.afterNote, V.COPY.removedAfter);
  assert.equal(V.deltaPlan(null).label, "Change");
});

test("text hygiene: control and bidi characters are removed, length is capped, nothing is parsed", () => {
  const evil = ["a\u0000b\u0007c\u202Ed\u2066e\u200Ff\u2028g\uFEFFh", "<img src=x onerror=alert(1)>"].join("");
  const c = V.clean(evil, 500);
  assert.ok(!new RegExp("[" + ["\u0000-\u0008", "\u202A-\u202E", "\u2066-\u2069", "\u200F", "\u2028", "\uFEFF"].join("") + "]").test(c));
  assert.ok(c.includes("<img src=x onerror=alert(1)>"), "markup is kept as TEXT (the panel renders text nodes only)");
  assert.equal(V.clean("x".repeat(5000), 100).length, 100);
  assert.equal(V.clean("😀".repeat(60), 11).length <= 11, true);
  assert.ok(!/[\ud800-\udbff]$/.test(V.clean("😀".repeat(60), 11).replace(/…$/, "")), "never cuts a surrogate pair in half");
  assert.equal(V.clean({ toString() { return "x"; } }), "");
  assert.equal(V.clean(12), "12");
  assert.equal(V.clean(NaN), "");
  assert.equal(V.oneLine("a\n\n  b\tc", 50), "a b c");
});

test("needs-code card: request text, Ask Claude address checks", () => {
  const v = V.normalizeProposal(clone(SAMPLE.proposals.needs_code));
  assert.equal(v.kind, "needs_code");
  assert.match(V.requestText(v.needsCode), /^Title: Make the hero video autoplay with a parallax effect\nWhere: Hero\nHow soon: Whenever\n\nThe hero video should start/);
  assert.equal(V.askClaudeUrl(null, "https://www.coveredaccess.com"), "https://www.coveredaccess.com/admin/#/collections/requests/new");
  assert.equal(V.askClaudeUrl(null, "http://localhost:8080/"), "http://localhost:8080/admin/#/collections/requests/new");
  assert.equal(V.askClaudeUrl("https://cms.example.test/new", "https://x.test"), "https://cms.example.test/new");
  assert.equal(V.askClaudeUrl("javascript:alert(1)", "https://x.test"), "https://x.test/admin/#/collections/requests/new", "a bad configured address falls back to the site's own");
  assert.equal(V.askClaudeUrl("http://evil.test/", null), null);
  assert.equal(V.askClaudeUrl("https://user:pw@evil.test/", null), null);
  assert.equal(V.askClaudeUrl(null, "data:text/html,x"), null);
  // an unknown priority becomes the default
  const odd = clone(SAMPLE.proposals.needs_code);
  odd.needsCode.request.priority = "RIGHT NOW!!!";
  assert.equal(V.normalizeProposal(odd).needsCode.priority, "Whenever");
});

test("tone proposals: verdict word, findings and the change a finding points at", () => {
  const v = V.normalizeProposal(clone(SAMPLE.proposals.tone));
  assert.equal(v.kind, "tone");
  assert.ok(["on_brand", "mostly", "off_brand"].includes(v.overall));
  assert.equal(v.overallText, V.OVERALL[v.overall]);
  assert.equal(v.findings.length, 1);
  assert.equal(v.findings[0].changeId, "c1");
  const none = clone(SAMPLE.proposals.tone);
  none.findings = []; none.changes = [];
  assert.equal(V.normalizeProposal(none).overall, "on_brand");
  const dangling = clone(SAMPLE.proposals.tone);
  dangling.findings[0].changeId = "c99";
  assert.equal(V.normalizeProposal(dangling).findings[0].changeId, null, "a finding cannot point at a change that does not exist");
  assert.equal(V.metaGuidance(40).ok, false);
  assert.equal(V.metaGuidance(120).ok, true);
  assert.equal(V.metaGuidance(200).ok, false);
});

test("page keys and the submit gate", () => {
  assert.equal(V.pageKey("/", []), "index");
  assert.equal(V.pageKey("/index.html", []), "index");
  assert.equal(V.pageKey("/about/", ["hero", "pages:about"]), "pages:about");
  assert.equal(V.pageKey("/about", ["hero"]), null);
  assert.equal(V.pageKey("/../../etc", ["pages:etc"]), null);
  const idle = Object.assign(V.initialState({ signedIn: true }), { phase: "idle", mode: "edit", instruction: "" });
  assert.equal(V.canSubmit(idle), false);
  assert.equal(V.canSubmit(Object.assign({}, idle, { instruction: "   " })), false);
  assert.equal(V.canSubmit(Object.assign({}, idle, { instruction: "x" })), true);
  assert.equal(V.canSubmit(Object.assign({}, idle, { instruction: "x".repeat(1001) })), false);
  assert.equal(V.submitHint(Object.assign({}, idle, { instruction: "x".repeat(1001) })), V.COPY.too_long);
  assert.equal(V.canSubmit(Object.assign({}, idle, { phase: "working", instruction: "x" })), false);
  assert.equal(V.canSubmit(Object.assign({}, idle, { mode: "alt_text" })), true);
});

test("the fixed copy never promises more than the truth: nothing is live until an approver publishes", () => {
  for (const k of ["intro", "safety", "savedLine", "savedToast"]) assert.match(V.COPY[k], /approver|live/i, k);
  assert.ok(!/\bapprove all\b/i.test(JSON.stringify(V.COPY)), "'Approve' is the approver's word, not a button here");
  for (const [k, v] of Object.entries(V.COPY)) assert.ok(typeof v === "string" && v.length > 0, k);
  for (const m of V.MODES) assert.ok(V.MODE_INFO[m].tab && V.MODE_INFO[m].button && V.MODE_INFO[m].help, m);
});
