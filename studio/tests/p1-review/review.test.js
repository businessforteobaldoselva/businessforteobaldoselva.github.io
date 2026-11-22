"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("../../api/shapes/phase1");
const { api, draftBy, submit, publish, heroOp, uuid } = require("./helpers");
const { upload, PNG_1x1 } = require("../fixtures/repo");

const review = async (a, who, d) => a.call(who, "GET", "/v1/drafts/" + d.id + "/review");
const OPS = [heroOp("We cover the UK"), { op: "replace", file: "src/_data/homepage.json", path: "/sections/4/enabled", value: false }];

test("the review lists every change in plain English, careful ones first, and the head to approve", async () => {
  const a = api();
  const d = await draftBy(a, "editor", OPS, "Summer edits");
  await submit(a, "editor", d);
  const r = await review(a, "approver", d);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(S.validateReview(r.json), []);
  assert.equal(r.json.summary, "2 changes on 1 page");
  assert.deepEqual(r.json.items.map((i) => i.id), ["r1", "r2"]);
  const [hero, sec] = r.json.items;
  assert.equal(hero.line, "Changes the Headline (Home page) from “Free period products,” to “We cover the UK”.");
  assert.equal(hero.before.text, "Free period products,");
  assert.equal(hero.after.text, "We cover the UK");
  assert.equal(hero.pageUrl, "/");
  assert.equal(sec.kind, "section");
  assert.equal(sec.attention, "hidden");
  assert.deepEqual([sec.before.text, sec.after.text], ["Shown", "Hidden"]);
  assert.equal(r.json.headSha, (await a.call("approver", "GET", "/v1/drafts/" + d.id)).json.draft.headSha);
  assert.deepEqual(r.json.gates, { checks: "success", canPublish: true, blockers: [] });
  assert.equal(r.json.sideBySide, null);
});

test("pictures: the file name and size are named once, no bytes are sent", async () => {
  const a = api();
  const swap = { op: "replace", file: "src/pages/about.md", path: "/sections/2/image", value: "/images/review-pic.png" };
  const r0 = await a.call("editor", "POST", "/v1/drafts", { idempotencyKey: uuid(), baseSha: a.mainSha(), title: "New picture", ops: [swap], uploads: [upload("u1", "review-pic.png", PNG_1x1)] });
  assert.equal(r0.status, 201, r0.text);
  const r = await review(a, "editor", r0.json.draft);
  assert.deepEqual(S.validateReview(r.json), []);
  const pics = r.json.items.filter((i) => i.kind === "image");
  assert.equal(pics.length, 1, "the swap and its file are one line, not two");
  assert.equal(pics[0].attention, "image");
  assert.match(pics[0].line, /Swaps the picture for .* to “\/images\/review-pic\.png”/);
  assert.match(pics[0].after.image, /^review-pic\.png \(1 × 1 pixels, [0-9]+ KB\)$/);
  assert.ok(pics[0].before.image, "the picture it replaces is named too");
  assert.equal(r.text.includes("iVBOR"), false, "no image bytes in the response");
});

test("who may open it: the owner and approvers; another editor gets a plain 404", async () => {
  const a = api({ people: [{ email: "zoe@covered.test", displayName: "Zoe", role: "editor" }] });
  const d = await draftBy(a, "editor", OPS);
  assert.equal((await review(a, "editor", d)).status, 200);
  assert.equal((await review(a, "approver", d)).status, 200);
  assert.equal((await review(a, "admin", d)).status, 200);
  const other = await review(a, "dev:editor:zoe@covered.test", d);
  assert.equal(other.status, 404);
  assert.equal(other.json.error.code, "not_found");
  assert.equal((await review(a, null, d)).status, 401);
  assert.equal((await a.call("approver", "GET", "/v1/drafts/u0000000--nope/review")).status, 404);
  assert.equal((await a.call("approver", "GET", "/v1/drafts/..%2f..%2fx/review")).status, 404);
});

test("blockers are exactly what the publish route refuses, for every reason", async () => {
  const clash = async (a) => {
    const d = await draftBy(a, "editor", OPS);
    await submit(a, "editor", d);
    const cur = new TextDecoder().decode(a.repo.fileAt("main", "src/_data/hero.json"));
    const moved = cur.replace(/("headlineMain":\s*")[^"]*(")/, "$1Main moved$2");
    const sha = a.repo.commitOn(a.mainSha(), [{ path: "src/_data/hero.json", bytes: new TextEncoder().encode(moved) }], "direct", "someone");
    a.repo.refs.set("refs/heads/main", sha);
    return d;
  };
  const sent = async (a, who, checks) => {
    const d = await draftBy(a, who, OPS);
    await submit(a, who, d);
    if (checks) a.repo.setChecks(d.number, checks);
    return d;
  };
  // [description, setup(a) -> draft, who opens it, expected first blocker, expected publish refusal]
  const cases = [
    ["still a draft", (a) => draftBy(a, "editor", OPS), "approver", "draft_state", { status: 409, reason: "draft_state" }],
    ["checks pending", (a) => sent(a, "editor", "pending"), "approver", "checks_pending", { status: 409, reason: "checks_pending" }],
    ["checks failed", (a) => sent(a, "editor", "failure"), "approver", "checks_failed", { status: 409, reason: "checks_failed" }],
    ["own draft", (a) => sent(a, "approver"), "approver", "self_publish", { status: 409, reason: "self_publish" }],
    ["clashes with main", clash, "approver", "not_mergeable", { status: 409, reason: "not_mergeable" }],
    ["an editor opens their own ready draft", (a) => sent(a, "editor"), "editor", "role", { status: 403 }],
  ];
  for (const [name, setup, who, blocker, refusal] of cases) {
    const a = api();
    const d = await setup(a);
    const r = await review(a, who, d);
    assert.equal(r.status, 200, name + " " + r.text);
    assert.deepEqual(S.validateReview(r.json), [], name);
    assert.equal(r.json.gates.canPublish, false, name);
    assert.equal(r.json.gates.blockers[0].reason, blocker, name);
    assert.ok(r.json.gates.blockers.every((b) => b.message.length > 5), name + ": plain words");
    const mainBefore = a.repo.head("main");
    const p = await publish(a, who, d, r.json.headSha);
    assert.equal(p.status, refusal.status, name + " " + p.text);
    if (refusal.reason) assert.equal(p.json.error.details.reason, refusal.reason, name);
    assert.equal(a.repo.head("main"), mainBefore, name + ": nothing was merged");
  }
  // no blocker: publish works with the head the review handed out, and the draft then reads as published
  const a = api();
  const d = await sent(a, "editor");
  const r = await review(a, "approver", d);
  assert.deepEqual(r.json.gates.blockers, []);
  assert.equal((await publish(a, "approver", d, r.json.headSha)).status, 200);
  const after = await review(a, "approver", d);
  assert.equal(after.status, 200);
  assert.equal(after.json.draft.state, "merged");
  assert.equal(after.json.gates.canPublish, false);
});

test("approving through the real publish route keeps the head gate: a push after the review is refused", async () => {
  const a = api();
  const d = await draftBy(a, "editor", OPS);
  await submit(a, "editor", d);
  const r = await review(a, "approver", d);
  const upd = await a.call("editor", "POST", "/v1/drafts", { idempotencyKey: uuid(), draftId: d.id, expectedHeadSha: d.headSha, ops: [heroOp("Pushed after the review")], uploads: [] });
  assert.equal(upd.status, 200, upd.text);
  const p = await publish(a, "approver", d, r.json.headSha);
  assert.equal(p.status, 409);
  assert.equal(p.json.error.details.reason, "head_changed");
  const again = await review(a, "approver", d);
  assert.notEqual(again.json.headSha, r.json.headSha, "reloading the screen shows the new head and the new list");
  assert.equal((await publish(a, "approver", d, again.json.headSha)).status, 200);
});

test("side by side stays off unless STUDIO_PREVIEW_EMBED=1 AND a preview address AND the site address exist", async () => {
  for (const [env, on] of [[{}, false], [{ STUDIO_PREVIEW_EMBED: "1" }, true], [{ STUDIO_PREVIEW_EMBED: "1", STUDIO_SITE_URL: "" }, false]]) {
    const a = api({ env });
    const d = await draftBy(a, "editor", OPS);
    const r = await review(a, "editor", d);
    assert.deepEqual(S.validateReview(r.json), []);
    if (on) assert.deepEqual(r.json.sideBySide, { productionUrl: "https://www.example.org/", draftUrl: "http://localhost:8080/", pagePath: "/" });
    else assert.equal(r.json.sideBySide, null);
  }
  const noPreview = api({ env: { STUDIO_PREVIEW_EMBED: "1", STUDIO_PREVIEW_URL_TEMPLATE: "" } });
  const d = await draftBy(noPreview, "editor", OPS);
  assert.equal((await review(noPreview, "editor", d)).json.sideBySide, null);
});

test("hostile text in a draft never reaches the review as markup", async () => {
  const a = api();
  const d = await draftBy(a, "editor", [heroOp('<img src=x onerror="alert(1)"> <b>bold</b>')], "Hostile");
  const r = await review(a, "approver", d);
  assert.equal(r.status, 200);
  assert.deepEqual(S.validateReview(r.json), []);
  const all = JSON.stringify(r.json.items.map((i) => Object.assign({}, i, { label: "" }))); // the label keeps its " > " breadcrumb separator
  assert.equal(/[<>]/.test(all), false);
  assert.match(r.json.items[0].after.text, /‹img src=x/);
});

test("the review never writes", async () => {
  const a = api();
  const d = await draftBy(a, "editor", OPS);
  await submit(a, "editor", d);
  const writes = [];
  for (const m of ["commitFiles", "createBranch", "resetBranch", "openPr", "updatePr", "markReady", "closePr", "deleteBranch", "merge"]) {
    const o = a.deps.git[m].bind(a.deps.git);
    a.deps.git[m] = (...x) => { writes.push(m); return o(...x); };
  }
  await review(a, "approver", d);
  assert.deepEqual(writes, []);
});
