"use strict";
// POST /v1/ai/accept: the only way a proposal becomes a draft, and it is the same path as a hand-made patch.
const test = require("node:test");
const assert = require("node:assert/strict");
const { replayApi, body, rec, patchOf, ch, rep, HERO, uuid, strip, makeApi, AI_ENV } = require("./helpers");
const text = require("../../api/services/pr-text");

const REQ = { mode: "edit", instruction: "make the hero shorter and warmer" };
const THREE = rec(patchOf("Warmer hero.",
  ch("Shorter headline", rep(HERO, "/headlineMain", "Free period products.")),
  ch("Friendlier line", rep(HERO, "/headlineAccent", "paid for by ads, not by you.")),
  ch("Plainer intro", rep(HERO, "/subhead", "Smart dispensers with free period products. No cost. No card. No catch."))));
const dec = new TextDecoder();
const read = (api, ref, p) => JSON.parse(dec.decode(api.repo.fileAt(ref, p)));

async function propose(api, req) {
  const r = await api.call("editor", "POST", "/v1/ai/propose", body(req || REQ));
  assert.equal(r.status, 200, r.text.slice(0, 300));
  return r.json.proposal;
}
const accept = (api, p, ids, extra, who) => api.call(who || "editor", "POST", "/v1/ai/accept", Object.assign({ idempotencyKey: uuid(), proposal: strip(p, REQ.instruction), accept: ids }, extra || {}));

test("partial accept makes a draft with ONLY the accepted changes, labelled and explained", async () => {
  const api = await replayApi(REQ, THREE);
  const p = await propose(api);
  const r = await accept(api, p, ["c1", "c3"], { title: "Warmer hero" });
  assert.equal(r.status, 201, r.text.slice(0, 400));
  assert.deepEqual(r.json.ai, { proposalId: p.id, accepted: 2, total: 3 });
  const hero = read(api, r.json.draft.branch, "src/_data/hero.json");
  assert.equal(hero.headlineMain, "Free period products.");
  assert.equal(hero.subhead, "Smart dispensers with free period products. No cost. No card. No catch.");
  assert.equal(hero.headlineAccent, "covered by ads — not women.", "the change that was not accepted is untouched");
  const pr = api.repo.prs.get(r.json.draft.number);
  assert.ok(pr.labels.has("studio-ai") && pr.labels.has("studio-draft"));
  assert.match(pr.body, /### Drafted with AI/);
  assert.match(pr.body, /Kept 2 of 3 suggestions/);
  assert.ok(text.parseMarker(pr.body), "the authorship marker is still the last thing in the body");
  assert.equal(r.json.draft.title, "Warmer hero");
  assert.equal(api.repo.head("main"), p.base.sha, "main is untouched until an approver publishes");
  const changed = await api.git.changedFiles(r.json.draft.baseSha, r.json.draft.headSha);
  assert.deepEqual(changed, ["src/_data/hero.json"]);
});

test("the instruction preview in the pull request is escaped: no links, mentions, images or closing keywords", async () => {
  const api = await replayApi(REQ, THREE);
  const p = await propose(api);
  const nasty = "@everyone [click](https://evil.example) ![x](https://evil.example/t.png) closes #1 <b>bold</b> www.evil.example " + "z".repeat(400);
  const r = await api.call("editor", "POST", "/v1/ai/accept", { idempotencyKey: uuid(), proposal: Object.assign(strip(p), { instructionPreview: nasty }), accept: ["c1"] });
  assert.equal(r.status, 201, r.text.slice(0, 300));
  const body = api.repo.prs.get(r.json.draft.number).body;
  const section = body.split("### Drafted with AI")[1].split("<!-- studio:v1")[0];
  assert.equal(/@everyone/.test(section), false);
  assert.equal(/\]\(https/.test(section), false);
  assert.equal(/<b>/.test(section), false);
  assert.equal(/https:\/\/evil/.test(section), false);
  assert.ok(section.length < 700);
  assert.ok(text.parseMarker(body));
});

test("changes that need each other cannot be split: 422 with a plain sentence, nothing saved", async () => {
  const faq = "src/_data/faq.json";
  const api = await replayApi({ mode: "edit", instruction: "add an FAQ for venues and say how quickly we reply" }, rec(patchOf("s",
    ch("Add the question", { op: "add", file: faq, path: "/items/-", value: { q: "Can my venue get a dispenser?", a: "Yes." } }),
    ch("Say how fast", rep(faq, "/items/7/a", "Yes. We reply within two working days.")))));
  const p = await propose(api, { mode: "edit", instruction: "add an FAQ for venues and say how quickly we reply" });
  assert.deepEqual(p.changes[1].requires, ["c1"]);
  const lone = await accept(api, p, ["c2"]);
  assert.equal(lone.status, 422);
  assert.equal(lone.json.error.details.problems[0].message, "Change 2 also needs change 1.");
  assert.equal(lone.json.error.details.problems[0].path, "/accept");
  assert.equal(api.repo.prs.size, 0);
  assert.equal((await accept(api, p, ["c1"])).status, 201, "the first change alone is fine");
  assert.equal((await accept(api, p, ["c1", "c2"])).status, 201);
});

test("an Editor cannot use accept to get past the allow-list: every op is checked again", async () => {
  const api = await replayApi(REQ, THREE);
  const p = await propose(api);
  const hand = (op) => ({ id: "c1", title: "x", ops: [op] });
  const send = (op) => api.call("editor", "POST", "/v1/ai/accept", { idempotencyKey: uuid(), proposal: Object.assign(strip(p), { changes: [hand(op)] }), accept: ["c1"] });
  const bad = [
    { op: "replace", file: "package.json", path: "/name", value: "x", expect: "covered-website" },
    { op: "replace", file: ".github/workflows/site-checks.yml", path: "/on", value: "x", expect: "y" },
    { op: "replace", file: "src/_data/how.json", path: "/story/0/src", value: "/images/evil.png", expect: "/images/story-1-spot.jpg" },
    { op: "replace", file: "src/_data/redirects.json", path: "/items/0/to", value: "https://evil.example/", expect: "x" },
    { op: "replace", file: "src/pages/about.md", path: "/permalink", value: "/x/", expect: "/about/" },
    { op: "replace", file: HERO, path: "/__proto__/x", value: "x", expect: "y" },
    { op: "replace", file: HERO, path: "/badge", value: "<script>alert(1)</script>", expect: "Pilot launching in Exeter, UK" },
    { op: "replace", file: HERO, path: "/badge", value: "javascript:alert(1)", expect: "Pilot launching in Exeter, UK" },
    { op: "replace", file: HERO, path: "/badge", value: "ok" },
    { op: "copy", file: HERO, from: "/badge", path: "/stamp" },
    { op: "replace", file: HERO, path: "/badge", value: "ok", expect: "Pilot launching in Exeter, UK", extra: 1 },
  ];
  for (const op of bad) {
    const r = await send(op);
    assert.ok(r.status === 422 || r.status === 400, JSON.stringify(op) + " -> " + r.status + " " + r.text.slice(0, 200));
  }
  assert.equal(api.repo.prs.size, 0, "nothing was written by any of them");
  assert.equal((await send({ op: "replace", file: HERO, path: "/badge", value: "ok", expect: "Pilot launching in Exeter, UK" })).status, 201, "the same op, well formed, is fine");
});

test("the request itself is strict: unknown fields, ids, empty or doubled selections", async () => {
  const api = await replayApi(REQ, THREE);
  const p = await propose(api);
  const send = (patch) => api.call("editor", "POST", "/v1/ai/accept", Object.assign({ idempotencyKey: uuid(), proposal: strip(p), accept: ["c1"] }, patch));
  for (const patch of [{ surprise: 1 }, { accept: [] }, { accept: ["c9"] }, { accept: ["c1", "c1"] }, { accept: "c1" }, { idempotencyKey: "nope" }, { title: "t".repeat(81) }, { proposal: Object.assign(strip(p), { extra: 1 }) }, { proposal: Object.assign(strip(p), { changes: [] }) }, { proposal: Object.assign(strip(p), { base: { sha: "nope", draftId: null, headSha: null } }) }, { proposal: Object.assign(strip(p), { id: "nope" }) }]) {
    const r = await send(patch);
    assert.equal(r.status, 400, JSON.stringify(patch).slice(0, 80) + " -> " + r.status);
  }
  const ops = Array.from({ length: 21 }, (_, i) => ({ op: "replace", file: HERO, path: "/badge", value: "x" + i, expect: "y" }));
  assert.equal((await send({ proposal: Object.assign(strip(p), { changes: [{ id: "c1", title: "t", ops }] }) })).status, 400);
});

test("the live site changed since the suggestion: 409, never an overwrite", async () => {
  const api = await replayApi(REQ, THREE);
  const p = await propose(api);
  const d = await api.call("approver", "POST", "/v1/drafts", { idempotencyKey: uuid(), baseSha: api.mainSha(), title: "Human edit", ops: [rep(HERO, "/headlineMain", "A human got there first")], uploads: [] });
  const s = await api.call("approver", "POST", "/v1/drafts/" + d.json.draft.id + "/submit", { idempotencyKey: uuid() });
  const pub = await api.call("admin", "POST", "/v1/drafts/" + d.json.draft.id + "/publish", { expectedHeadSha: s.json.draft.headSha, idempotencyKey: uuid() });
  assert.equal(pub.status, 200, pub.text);
  const r = await accept(api, p, ["c1"]);
  assert.equal(r.status, 409);
  assert.ok(["base_moved", "conflict"].indexOf(r.json.error.code) >= 0);
  const other = await accept(api, p, ["c2"]);
  assert.equal(other.status, 201, "a change to a different setting is still fine");
  const tampered = strip(p);
  tampered.changes[1].ops[0].expect = "something else";
  const t = await api.call("editor", "POST", "/v1/ai/accept", { idempotencyKey: uuid(), proposal: tampered, accept: ["c2"] });
  assert.equal(t.status, 409, "a wrong expect is a conflict, not an overwrite");
});

test("building on a draft: the answer updates that draft; a moved draft is a 409", async () => {
  const api = await replayApi(Object.assign({ draft: true }, REQ), THREE);
  const d = await api.call("editor", "POST", "/v1/drafts", { idempotencyKey: uuid(), baseSha: api.mainSha(), title: "Start", ops: [rep(HERO, "/badge", "Pilot launching in Exeter")], uploads: [] });
  assert.equal(d.status, 201, d.text);
  const pr = await api.call("editor", "POST", "/v1/ai/propose", body(REQ, { draftId: d.json.draft.id }));
  assert.equal(pr.status, 200, pr.text.slice(0, 300));
  const p = pr.json.proposal;
  assert.equal(p.base.draftId, d.json.draft.id);
  assert.equal(p.base.headSha, d.json.draft.headSha);
  const moved = await api.call("editor", "POST", "/v1/drafts", { idempotencyKey: uuid(), draftId: d.json.draft.id, expectedHeadSha: d.json.draft.headSha, title: "More", ops: [rep(HERO, "/stamp", "We have you covered.")], uploads: [] });
  assert.equal(moved.status, 200, moved.text);
  const stale = await accept(api, p, ["c1"]);
  assert.equal(stale.status, 409);
  assert.equal(stale.json.error.code, "draft_moved");
  const fresh = await api.call("editor", "POST", "/v1/ai/propose", body(REQ, { draftId: d.json.draft.id }));
  const ok = await accept(api, fresh.json.proposal, ["c1", "c2"]);
  assert.equal(ok.status, 200, ok.text.slice(0, 300));
  assert.equal(ok.json.draft.id, d.json.draft.id);
  const hero = read(api, ok.json.draft.branch, "src/_data/hero.json");
  assert.equal(hero.badge, "Pilot launching in Exeter");
  assert.equal(hero.stamp, "We have you covered.");
  assert.equal(hero.headlineMain, "Free period products.");
  assert.ok(api.repo.prs.get(ok.json.draft.number).labels.has("studio-ai"));
  assert.ok(text.parseMarker(api.repo.prs.get(ok.json.draft.number).body));
  const theirs = await api.call("approver", "POST", "/v1/ai/propose", body(REQ, { draftId: d.json.draft.id }));
  assert.equal(theirs.status, 404);
});

test("accept is idempotent on the key and needs AI to be on", async () => {
  const api = await replayApi(REQ, THREE);
  const p = await propose(api);
  const key = uuid();
  const a = await api.call("editor", "POST", "/v1/ai/accept", { idempotencyKey: key, proposal: strip(p), accept: ["c1"] });
  const b = await api.call("editor", "POST", "/v1/ai/accept", { idempotencyKey: key, proposal: strip(p), accept: ["c1"] });
  assert.equal(a.status, 201);
  assert.equal(b.status, 200);
  assert.equal(b.json.replayed, true);
  assert.equal(api.repo.prs.size, 1);
  const off = makeApi({ env: Object.assign({}, AI_ENV, { STUDIO_AI_ENABLED: "0" }) });
  const r = await off.call("editor", "POST", "/v1/ai/accept", { idempotencyKey: uuid(), proposal: strip(p), accept: ["c1"] });
  assert.equal(r.status, 503);
  assert.equal(off.repo.prs.size, 0);
});

test("only an approver publishes, and never their own AI draft; restore undoes it in one step", async () => {
  const api = await replayApi(REQ, THREE);
  const p = await propose(api);
  const r = await accept(api, p, ["c1", "c2", "c3"]);
  const sub = await api.call("editor", "POST", "/v1/drafts/" + r.json.draft.id + "/submit", { idempotencyKey: uuid() });
  assert.equal((await api.call("editor", "POST", "/v1/drafts/" + r.json.draft.id + "/publish", { expectedHeadSha: sub.json.draft.headSha, idempotencyKey: uuid() })).status, 403);
  const pub = await api.call("approver", "POST", "/v1/drafts/" + r.json.draft.id + "/publish", { expectedHeadSha: sub.json.draft.headSha, idempotencyKey: uuid() });
  assert.equal(pub.status, 200, pub.text);
  const before = dec.decode(api.repo.fileAt(p.base.sha, HERO));
  const h = (await api.call("editor", "GET", "/v1/history")).json.items[0];
  assert.equal(h.restorable, true);
  const rs = await api.call("editor", "POST", "/v1/history/" + h.number + "/restore", { onConflict: "abort", idempotencyKey: uuid() });
  const s2 = await api.call("editor", "POST", "/v1/drafts/" + rs.json.draft.id + "/submit", { idempotencyKey: uuid() });
  await api.call("approver", "POST", "/v1/drafts/" + rs.json.draft.id + "/publish", { expectedHeadSha: s2.json.draft.headSha, idempotencyKey: uuid() });
  assert.equal(dec.decode(api.repo.fileAt("main", HERO)), before, "byte-identical after Restore");
});
