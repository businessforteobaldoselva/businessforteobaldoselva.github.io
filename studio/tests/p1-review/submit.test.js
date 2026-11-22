"use strict";
// Send for review (PHASE1-DESIGN 7): the approver list, the GitHub review request, and every way the notification can fail
// without failing the submit.
const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("../../api/shapes/phase1");
const { GitError } = require("../../api/providers/git/interface");
const { api, draftBy, submit, withReviewers, heroOp, uuid } = require("./helpers");

function make(behaviour, env) {
  const a = api({ env });
  a.fake = withReviewers(a.git, behaviour);
  a.deps.git = a.fake; // the handler reads deps.git on every request
  return a;
}
const meOf = async (who) => (await api().call(who, "GET", "/v1/me")).json.user.id; // dev user ids are fixed per address

test("approvers: names and how they are told, never logins or addresses; nobody lists themselves", async () => {
  const a = api({ env: { STUDIO_REVIEWERS: JSON.stringify([
    { id: "amelia", name: "Amelia", github: "ameliagh", role: "approver", userId: "11111111-1111-4111-8111-111111111111" },
    { id: "teo", name: "Teo", github: null, role: "admin" },
  ]) } });
  const r = await a.call("editor", "GET", "/v1/people/approvers");
  assert.equal(r.status, 200);
  assert.deepEqual(S.validateApprovers(r.json), []);
  assert.deepEqual(r.json.approvers, [
    { id: "amelia", displayName: "Amelia", role: "approver", notify: "github" },
    { id: "teo", displayName: "Teo", role: "admin", notify: "manual" },
  ]);
  assert.equal(r.text.includes("ameliagh"), false, "no GitHub login in the response");
  assert.equal(/@|userId|11111111/.test(r.text), false, "no address or user id either");
  assert.equal((await a.call(null, "GET", "/v1/people/approvers")).status, 401);
});

test("approvers: empty when the variable is unset, and the caller is left out of their own list", async () => {
  const none = require("../fixtures/harness").makeApi();
  assert.deepEqual((await none.call("editor", "GET", "/v1/people/approvers")).json, { approvers: [] });
  const b = api({ env: { STUDIO_REVIEWERS: JSON.stringify([{ id: "me", name: "Me", userId: await meOf("approver") }, { id: "teo", name: "Teo" }]) } });
  assert.deepEqual((await b.call("approver", "GET", "/v1/people/approvers")).json.approvers.map((x) => x.id), ["teo"]);
  assert.deepEqual((await b.call("editor", "GET", "/v1/people/approvers")).json.approvers.map((x) => x.id), ["me", "teo"]);
});

test("a reviewer with a GitHub login is asked to review: via github, named, link, message", async () => {
  const a = make();
  const d = await draftBy(a, "editor");
  const r = await submit(a, "editor", d, "amelia");
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(S.validateSubmitResponse(r.json), []);
  assert.equal(r.json.draft.state, "ready");
  assert.deepEqual(r.json.notified, { via: "github", reviewer: { displayName: "Amelia" }, reason: null });
  assert.equal(r.json.message, "Sent for review. Amelia has been notified on GitHub.");
  assert.equal(r.json.reviewLink, "http://localhost:8080/?studio=1#review=" + d.id);
  assert.deepEqual(a.fake.calls, [{ n: d.number, logins: ["ameliagh"] }]);
  const entry = a.audit.entries.filter((e) => e.action === "draft.submit").pop();
  assert.equal(entry.reviewer, "amelia");
  assert.equal(JSON.stringify(entry).includes("ameliagh"), false, "the audit never holds the login");
});

test("no GitHub login, or no one chosen: nothing is sent to GitHub and the dialog gets a copy-paste message", async () => {
  const a = make();
  const d1 = await draftBy(a, "editor", [heroOp("one")], "One");
  const t = await submit(a, "editor", d1, "teo");
  assert.deepEqual(S.validateSubmitResponse(t.json), []);
  assert.deepEqual(t.json.notified, { via: "none", reviewer: { displayName: "Teo" }, reason: "no_github_login" });
  assert.equal(t.json.message, "Sent for review. Teo is not set up for GitHub notifications, so copy the link and send it to them.");
  const d2 = await draftBy(a, "editor", [heroOp("two")], "Two");
  const n = await submit(a, "editor", d2);
  assert.deepEqual(S.validateSubmitResponse(n.json), []);
  assert.deepEqual(n.json.notified, { via: "none", reviewer: null, reason: "no_reviewer_chosen" });
  const d3 = await draftBy(a, "editor", [heroOp("three")], "Three");
  assert.equal((await submit(a, "editor", d3, null)).json.notified.reason, "no_reviewer_chosen");
  assert.deepEqual(a.fake.calls, []);
});

test("GitHub refuses (not a collaborator) or is down: the submit still succeeds and says to copy the link", async () => {
  const refused = make(async () => { throw new GitError("conflict", "Reviews may only be requested from collaborators"); });
  const d = await draftBy(refused, "editor");
  const r = await submit(refused, "editor", d, "amelia");
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(S.validateSubmitResponse(r.json), []);
  assert.equal(r.json.draft.state, "ready", "the draft IS ready for review");
  assert.deepEqual(r.json.notified, { via: "none", reviewer: { displayName: "Amelia" }, reason: "github_refused" });
  assert.match(r.json.message, /^Sent for review\. GitHub would not notify Amelia, so copy the link/);

  const down = make(async () => { throw new GitError("upstream", "GitHub HTTP 503"); });
  const d2 = await draftBy(down, "editor");
  const r2 = await submit(down, "editor", d2, "amelia");
  assert.equal(r2.status, 200);
  assert.deepEqual(r2.json.notified, { via: "none", reviewer: { displayName: "Amelia" }, reason: "github_unavailable" });
  assert.equal(JSON.stringify(r2.json).includes("503"), false, "no upstream error text reaches the person");

  const crash = make(async () => { throw new Error("socket hang up"); });
  const d3 = await draftBy(crash, "editor");
  assert.equal((await submit(crash, "editor", d3, "amelia")).json.notified.reason, "github_unavailable");

  const noMethod = api(); noMethod.git.requestReviewers = undefined; // a provider without requestReviewers
  const d4 = await draftBy(noMethod, "editor");
  const r4 = await submit(noMethod, "editor", d4, "amelia");
  assert.equal(r4.status, 200);
  assert.equal(r4.json.notified.reason, "github_unavailable");
});

test("a replayed submit does not notify again and returns the first answer", async () => {
  const a = make();
  const d = await draftBy(a, "editor");
  const key = uuid();
  const first = await a.call("editor", "POST", "/v1/drafts/" + d.id + "/submit", { idempotencyKey: key, reviewerId: "amelia" });
  const again = await a.call("editor", "POST", "/v1/drafts/" + d.id + "/submit", { idempotencyKey: key, reviewerId: "amelia" });
  assert.equal(again.status, 200);
  assert.deepEqual(again.json, first.json);
  assert.equal(a.fake.calls.length, 1);
  // another key (for example after a restart): the draft is already ready, so GitHub is not asked again either
  const later = await a.call("editor", "POST", "/v1/drafts/" + d.id + "/submit", { idempotencyKey: uuid(), reviewerId: "amelia" });
  assert.equal(later.status, 200);
  assert.equal(a.fake.calls.length, 1);
  assert.equal(later.json.notified.via, "none");
  assert.match(later.json.message, /already sent for review/);
});

test("bad input: unknown reviewer, odd characters, wrong type, extra fields, someone else's draft", async () => {
  const a = make();
  const d = await draftBy(a, "editor");
  for (const bad of ["nobody", "AMELIA", "../x", "a".repeat(40), 7, {}, ["amelia"]]) {
    const r = await a.call("editor", "POST", "/v1/drafts/" + d.id + "/submit", { idempotencyKey: uuid(), reviewerId: bad });
    assert.equal(r.status, 400, JSON.stringify(bad) + " " + r.text);
  }
  assert.equal((await a.call("editor", "POST", "/v1/drafts/" + d.id + "/submit", { idempotencyKey: uuid(), reviewer: "amelia" })).status, 400);
  assert.equal((await a.call("editor", "GET", "/v1/drafts/" + d.id)).json.draft.state, "draft", "nothing was sent");
  assert.equal((await a.call("approver", "POST", "/v1/drafts/" + d.id + "/submit", { idempotencyKey: uuid(), reviewerId: "amelia" })).status, 404);
  assert.deepEqual(a.fake.calls, []);
});

test("you cannot pick yourself when your Studio user id is in the list", async () => {
  const me = await meOf("editor");
  const a = api({ env: { STUDIO_REVIEWERS: JSON.stringify([{ id: "molly", name: "Molly", github: "mollygh", userId: me }]) } });
  const d = await draftBy(a, "editor");
  const r = await submit(a, "editor", d, "molly");
  assert.equal(r.status, 400);
  assert.match(r.json.error.message, /cannot review your own changes/);
});

test("the review link needs an https or localhost base: STUDIO_REVIEW_BASE_URL wins, otherwise the preview, otherwise none", async () => {
  const a = make(undefined, { STUDIO_REVIEW_BASE_URL: "https://studio.example.org" });
  const d = await draftBy(a, "editor");
  assert.equal((await submit(a, "editor", d)).json.reviewLink, "https://studio.example.org/?studio=1#review=" + d.id);
  const none = api({ env: { STUDIO_PREVIEW_URL_TEMPLATE: "" } });
  const d2 = await draftBy(none, "editor");
  const r = await submit(none, "editor", d2);
  assert.equal(r.json.reviewLink, null);
  assert.deepEqual(S.validateSubmitResponse(r.json), []);
});
