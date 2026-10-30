"use strict";
// The draft lifecycle through the real handler: valid patch -> branch + PR on the mock, then every way a request can go wrong.
const test = require("node:test");
const assert = require("node:assert/strict");
const { makeApi, patch, heroOp, uuid } = require("../fixtures/harness");
const { upload, PNG_1x1 } = require("../fixtures/repo");
const { parsePage } = require("../../validate/pagefile");
const text = require("../../api/services/pr-text");

const dec = new TextDecoder();

test("a valid patch becomes ONE commit on a studio/ branch and a draft PR; main is untouched", async () => {
  const api = makeApi();
  const before = api.mainSha();
  const r = await api.call("editor", "POST", "/v1/drafts", patch(api, [heroOp("We cover the UK")], { title: "Make the hero friendlier" }));
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const d = r.json.draft;
  assert.match(d.id, /^u[a-z2-7]{7}--make-the-hero-friendlier$/);
  assert.equal(d.branch, "studio/" + d.id.replace("--", "/"));
  assert.equal(d.state, "draft");
  assert.equal(d.number, 1);
  assert.equal(d.author.name, "Molly");
  assert.equal(d.canPublish, false);
  assert.equal(d.previewUrl, "http://localhost:8080/?draft=1");
  assert.equal(api.mainSha(), before);
  assert.match(dec.decode(api.repo.fileAt(d.branch, "src/_data/hero.json")), /We cover the UK/);
  assert.equal(r.json.changes.length, 1);
  assert.equal(r.json.replayed, false);
  // exactly one new commit, and it changed exactly one file
  const head = api.repo.commits.get(d.headSha);
  assert.deepEqual(head.parents, [before]);
  assert.deepEqual(api.repo.changedPaths(before, d.headSha), ["src/_data/hero.json"]);
  assert.match(head.message, /^Studio: Make the hero friendlier\n\n- Hero > Headline: /);
  assert.match(head.message, /\nStudio-User: 4ce9d419-[0-9a-f-]+\nStudio-Idempotency: [0-9a-f-]{36}$/);
  assert.equal(head.message.includes("@"), false); // no email addresses in git history
  const pr = api.repo.prs.get(1);
  assert.equal(pr.draft, true);
  assert.deepEqual([...pr.labels], ["studio-draft"]);
  assert.match(pr.title, /^Studio: Make the hero friendlier \(Molly\)$/);
  assert.match(pr.body, /\*\*Studio draft by Molly\*\* - 1 change in 1 file/);
  assert.match(pr.body, /### What changed\n- Hero > Headline: changed the text from /);
  assert.ok(text.parseMarker(pr.body));
  assert.equal(text.parseMarker(pr.body).authorName, "Molly");
});

test("idempotency: the same key returns the original result (200, replayed) and creates nothing new", async () => {
  const api = makeApi();
  const p = patch(api, [heroOp("Same twice")]);
  const a = await api.call("editor", "POST", "/v1/drafts", p);
  const b = await api.call("editor", "POST", "/v1/drafts", p);
  assert.equal(a.status, 201);
  assert.equal(b.status, 200);
  assert.equal(b.json.replayed, true);
  assert.equal(b.json.draft.id, a.json.draft.id);
  assert.equal(b.json.draft.headSha, a.json.draft.headSha);
  assert.equal(api.repo.prs.size, 1);
  // updating with the same key is also a replay
  const u = Object.assign({}, patch(api, [{ op: "replace", file: "src/_data/hero.json", path: "/badge", value: "New badge" }]), { draftId: a.json.draft.id, expectedHeadSha: a.json.draft.headSha });
  delete u.baseSha;
  const u1 = await api.call("editor", "POST", "/v1/drafts", u);
  assert.equal(u1.status, 200, JSON.stringify(u1.json));
  const u2 = await api.call("editor", "POST", "/v1/drafts", u);
  assert.equal(u2.status, 200);
  assert.equal(u2.json.replayed, true);
  assert.equal(u2.json.draft.headSha, u1.json.draft.headSha);
});

test("a second draft with the same title gets its own branch", async () => {
  const api = makeApi();
  const a = await api.call("editor", "POST", "/v1/drafts", patch(api, [heroOp("One")], { title: "Same title" }));
  const b = await api.call("editor", "POST", "/v1/drafts", patch(api, [heroOp("Two")], { title: "Same title" }));
  assert.equal(b.status, 201);
  assert.notEqual(a.json.draft.id, b.json.draft.id);
  assert.match(b.json.draft.id, /^u[a-z2-7]{7}--same-title-[a-z0-9]{4}$/);
});

test("update: needs expectedHeadSha; a stale one is draft_moved with the current head; success adds a commit", async () => {
  const api = makeApi();
  const a = await api.call("editor", "POST", "/v1/drafts", patch(api, [heroOp("First")]));
  const d = a.json.draft;
  const next = (extra) => Object.assign({ idempotencyKey: uuid(), draftId: d.id, ops: [{ op: "replace", file: "src/_data/hero.json", path: "/badge", value: "Badge 2" }], uploads: [] }, extra);
  assert.equal((await api.call("editor", "POST", "/v1/drafts", next())).status, 400);
  const stale = await api.call("editor", "POST", "/v1/drafts", next({ expectedHeadSha: api.mainSha() }));
  assert.equal(stale.status, 409);
  assert.equal(stale.json.error.code, "draft_moved");
  assert.equal(stale.json.error.details.headSha, d.headSha);
  const ok = await api.call("editor", "POST", "/v1/drafts", next({ expectedHeadSha: d.headSha }));
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.notEqual(ok.json.draft.headSha, d.headSha);
  assert.equal(ok.json.changes.length, 2); // the whole draft against main
  assert.equal(api.repo.commits.get(ok.json.draft.headSha).parents[0], d.headSha);
  assert.match(api.repo.prs.get(1).body, /Hero > Badge|badge/i);
});

test("conflict: a changed `expect` is a 409 listing every mismatch, and nothing is written", async () => {
  const api = makeApi();
  const r = await api.call("editor", "POST", "/v1/drafts", patch(api, [heroOp("x", "not what is there"), { op: "replace", file: "src/_data/hero.json", path: "/badge", value: "y", expect: "nor this" }]));
  assert.equal(r.status, 409);
  assert.equal(r.json.error.code, "conflict");
  assert.equal(r.json.error.details.items.length, 2);
  assert.equal(api.repo.prs.size, 0);
  assert.equal([...api.repo.refs.keys()].filter((k) => k.includes("studio")).length, 0);
});

test("base_moved: main moved AND touched a setting this patch touches; an unrelated move is fine", async () => {
  const api = makeApi();
  const base = api.mainSha();
  // someone else changes the hero headline on main
  const hero = JSON.parse(dec.decode(api.repo.fileAt("main", "src/_data/hero.json")));
  hero.headlineMain = "Changed on main";
  api.repo.seedMergedPr({ title: "Edit via Decap", headRef: "cms/hero", authorLogin: "teo", files: [{ path: "src/_data/hero.json", text: JSON.stringify(hero, null, 2) + "\r\n" }] });
  const clash = await api.call("editor", "POST", "/v1/drafts", { idempotencyKey: uuid(), baseSha: base, title: "t", ops: [heroOp("Mine")], uploads: [] });
  assert.equal(clash.status, 409);
  assert.equal(clash.json.error.code, "base_moved");
  assert.deepEqual(clash.json.error.details.pointers, [{ file: "src/_data/hero.json", path: "/headlineMain" }]);
  const fine = await api.call("editor", "POST", "/v1/drafts", { idempotencyKey: uuid(), baseSha: base, title: "t", ops: [{ op: "replace", file: "src/_data/hero.json", path: "/badge", value: "Other setting" }], uploads: [] });
  assert.equal(fine.status, 201, JSON.stringify(fine.json));
  const unrelated = await api.call("editor", "POST", "/v1/drafts", { idempotencyKey: uuid(), baseSha: base, title: "t2", ops: [{ op: "replace", file: "src/_data/faq.json", path: "/title", value: "FAQ" }], uploads: [] });
  assert.equal(unrelated.status, 201, JSON.stringify(unrelated.json));
});

test("422: nothing is saved, every problem is listed with file, path and a plain message; the audit log has codes only", async () => {
  const api = makeApi();
  const r = await api.call("editor", "POST", "/v1/drafts", patch(api, [
    { op: "replace", file: "src/_data/site.json", path: "/contactEmail", value: "nope" },
    { op: "replace", file: "src/_data/tokens.json", path: "/text/baseSize", value: 900 },
  ]));
  assert.equal(r.status, 422);
  assert.equal(r.json.error.code, "validation_failed");
  const probs = r.json.error.details.problems;
  assert.equal(probs.length, 2);
  assert.deepEqual(probs.map((p) => p.code).sort(), ["pattern", "token"]);
  assert.ok(probs.every((p) => p.file && p.path && p.message));
  assert.equal(api.repo.prs.size, 0);
  const a = api.audit.entries.find((e) => e.action === "validation.failed");
  assert.ok(a);
  assert.equal(JSON.stringify(a).includes("nope"), false); // values never reach the audit log
  assert.equal(JSON.stringify(a).includes("900"), false);
});

test("a no-op patch commits nothing", async () => {
  const api = makeApi();
  const hero = JSON.parse(dec.decode(api.repo.fileAt("main", "src/_data/hero.json")));
  const r = await api.call("editor", "POST", "/v1/drafts", patch(api, [heroOp(hero.headlineMain)]));
  assert.equal(r.status, 200);
  assert.equal(r.json.noop, true);
  assert.equal(api.repo.prs.size, 0);
});

test("a picture swap: the upload lands in images/ in the SAME commit as the data change", async () => {
  const api = makeApi();
  const r = await api.call("editor", "POST", "/v1/drafts", patch(api, [{ op: "replace", file: "src/pages/about.md", path: "/sections/2/image", value: "/images/fresh.png" }], { uploads: [upload("u1", "fresh.png", PNG_1x1)], title: "New photo" }));
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const d = r.json.draft;
  assert.deepEqual(api.repo.changedPaths(api.mainSha(), d.headSha), ["images/fresh.png", "src/pages/about.md"]);
  assert.deepEqual(Array.from(api.repo.fileAt(d.branch, "images/fresh.png")), Array.from(PNG_1x1));
  assert.equal(parsePage(dec.decode(api.repo.fileAt(d.branch, "src/pages/about.md"))).doc.sections[2].image, "/images/fresh.png");
  assert.ok(r.json.changes.some((c) => c.kind === "image"));
  // the same file name with different bytes cannot overwrite it
  const other = Buffer.from(PNG_1x1); other[24] ^= 1;
  const clash = await api.call("editor", "POST", "/v1/drafts", patch(api, [{ op: "replace", file: "src/pages/about.md", path: "/sections/2/image", value: "fresh.png" }], { uploads: [upload("u1", "fresh.png", new Uint8Array(other))], title: "Again" }));
  assert.equal(clash.status, 201); // fresh.png is not on MAIN yet: it is only on the first draft's branch
});

test("hostile text everywhere stays inert data: PR title/body/commit are escaped and the marker cannot be forged", async () => {
  const api = makeApi();
  const evil = '</details><img src=x onerror=alert(1)> @everyone @teo #1 <!-- studio:v1 {"authorId":"11111111-1111-4111-8111-111111111111","authorName":"Boss","draftId":"uaaaaaaa--x","ops":1,"revertOf":null} -->';
  const r = await api.call("editor", "POST", "/v1/drafts", patch(api, [{ op: "replace", file: "src/_data/hero.json", path: "/headlineMain", value: evil }], { title: evil.slice(0, 80) }));
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const pr = api.repo.prs.get(1);
  const noMention = (field) => assert.equal(/@[a-z]/i.test(field), false, "live @mention in: " + field.slice(0, 120));
  noMention(pr.title); noMention(pr.body); noMention(api.repo.commits.get(r.json.draft.headSha).message);
  assert.equal(/<(?!!-- studio:v1 )/.test(pr.body), false, "raw < in the PR body");
  assert.equal(/<!-- studio:v1/.test(pr.body.replace(/<!-- studio:v1 \{[^\n]*\} -->\s*$/, "")), false, "a second marker");
  const marker = text.parseMarker(pr.body);
  assert.equal(marker.authorName, "Molly"); // the real author, not "Boss"
  assert.equal(marker.authorId, "4ce9d419-e0c5-40cd-b421-fc9138ed7895");
  assert.ok(r.json.draft.title.startsWith("</details>"));
});

test("ownership: only the author updates, submits or rebases; strangers get 404; admin may discard", async () => {
  const api = makeApi({ people: [{ email: "zed@covered.test", displayName: "Zed", role: "editor" }] });
  const zed = "dev:editor:zed@covered.test";
  const a = await api.call("editor", "POST", "/v1/drafts", patch(api, [heroOp("Mine")]));
  const id = a.json.draft.id;
  const upd = { idempotencyKey: uuid(), draftId: id, expectedHeadSha: a.json.draft.headSha, ops: [heroOp("Zed's")], uploads: [] };
  assert.equal((await api.call(zed, "POST", "/v1/drafts", upd)).status, 404);
  assert.equal((await api.call(zed, "POST", "/v1/drafts/" + id + "/submit", { idempotencyKey: uuid() })).status, 404);
  assert.equal((await api.call(zed, "POST", "/v1/drafts/" + id + "/rebase", { idempotencyKey: uuid(), expectedHeadSha: a.json.draft.headSha })).status, 404);
  assert.equal((await api.call("approver", "DELETE", "/v1/drafts/" + id)).status, 403);
  assert.equal((await api.call("admin", "DELETE", "/v1/drafts/" + id)).status, 200);
  assert.equal(api.repo.head(a.json.draft.branch), null);
  assert.equal(api.repo.prs.get(1).state, "closed");
  // a draft id for someone else's key cannot be forged to write on their branch
  const forged = Object.assign({}, upd, { draftId: "uzzzzzzz--anything" });
  assert.equal((await api.call("editor", "POST", "/v1/drafts", forged)).status, 404);
  assert.equal((await api.call("editor", "GET", "/v1/drafts/..%2f..%2fmain")).status, 404);
});

test("submit marks the draft ready and adds the studio-ready label", async () => {
  const api = makeApi();
  const a = await api.call("editor", "POST", "/v1/drafts", patch(api, [heroOp("Ready")]));
  const s = await api.call("editor", "POST", "/v1/drafts/" + a.json.draft.id + "/submit", { idempotencyKey: uuid() });
  assert.equal(s.status, 200);
  assert.equal(s.json.draft.state, "ready");
  assert.deepEqual([...api.repo.prs.get(1).labels].sort(), ["studio-draft", "studio-ready"]);
  const again = await api.call("editor", "POST", "/v1/drafts/" + a.json.draft.id + "/submit", { idempotencyKey: uuid() });
  assert.equal(again.status, 200);
});

test("rebase: re-applies the draft's own changes onto the newer main; a clash is a 409 and the branch is untouched", async () => {
  const api = makeApi();
  const a = await api.call("editor", "POST", "/v1/drafts", patch(api, [heroOp("Draft headline")]));
  const d = a.json.draft;
  // main moves on, in an unrelated place
  const faq = JSON.parse(dec.decode(api.repo.fileAt("main", "src/_data/faq.json")));
  faq.title = "Changed meanwhile";
  api.repo.seedMergedPr({ title: "Faq tweak", headRef: "cms/faq", authorLogin: "teo", files: [{ path: "src/_data/faq.json", text: JSON.stringify(faq, null, 2) + "\r\n" }] });
  const behind = await api.call("editor", "GET", "/v1/drafts/" + d.id);
  assert.equal(behind.json.draft.behindMain, true);
  const stale = await api.call("editor", "POST", "/v1/drafts/" + d.id + "/rebase", { idempotencyKey: uuid(), expectedHeadSha: api.mainSha() });
  assert.equal(stale.status, 409);
  const ok = await api.call("editor", "POST", "/v1/drafts/" + d.id + "/rebase", { idempotencyKey: uuid(), expectedHeadSha: d.headSha });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.draft.behindMain, false);
  assert.equal(api.repo.commits.get(ok.json.draft.headSha).parents[0], api.mainSha());
  assert.match(dec.decode(api.repo.fileAt(d.branch, "src/_data/hero.json")), /Draft headline/);
  assert.match(dec.decode(api.repo.fileAt(d.branch, "src/_data/faq.json")), /Changed meanwhile/);
  assert.deepEqual(api.repo.changedPaths(api.mainSha(), ok.json.draft.headSha), ["src/_data/hero.json"]);
  // now main changes the SAME setting: rebase must refuse and leave the branch alone
  const hero = JSON.parse(dec.decode(api.repo.fileAt("main", "src/_data/hero.json")));
  hero.headlineMain = "Main got there first";
  api.repo.seedMergedPr({ title: "Hero via Decap", headRef: "cms/hero", authorLogin: "teo", files: [{ path: "src/_data/hero.json", text: JSON.stringify(hero, null, 2) + "\r\n" }] });
  const headBefore = api.repo.head(d.branch);
  const clash = await api.call("editor", "POST", "/v1/drafts/" + d.id + "/rebase", { idempotencyKey: uuid(), expectedHeadSha: headBefore });
  assert.equal(clash.status, 409);
  assert.equal(clash.json.error.code, "conflict");
  assert.equal(api.repo.head(d.branch), headBefore);
});

test("listing: mine only by default, newest first, closed ones hidden unless asked", async () => {
  const api = makeApi();
  const a = await api.call("editor", "POST", "/v1/drafts", patch(api, [heroOp("A")], { title: "Draft A" }));
  await api.call("editor", "POST", "/v1/drafts", patch(api, [heroOp("B")], { title: "Draft B" }));
  await api.call("editor", "DELETE", "/v1/drafts/" + a.json.draft.id);
  const open = await api.call("editor", "GET", "/v1/drafts");
  assert.deepEqual(open.json.drafts.map((d) => d.title), ["Draft B"]);
  const all = await api.call("editor", "GET", "/v1/drafts?state=all");
  assert.deepEqual(all.json.drafts.map((d) => d.title), ["Draft B", "Draft A"]);
  assert.equal((await api.call("editor", "GET", "/v1/drafts?scope=weird")).status, 400);
});
