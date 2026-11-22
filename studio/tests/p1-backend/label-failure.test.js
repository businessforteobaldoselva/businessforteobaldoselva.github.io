"use strict";
// GitHub labels are a convenience. When they cannot be written (the App has no "Issues: write"), creating a draft must still work,
// and merge() must still know a Studio draft when it sees one (PHASE1-DESIGN 4.3). The four-way identity matrix on every provider.
const test = require("node:test");
const assert = require("node:assert/strict");
const { memoryProvider, githubProvider, localProvider, hasGit } = require("../fixtures/providers");
const { makeApi, patch, heroOp, uuid } = require("../fixtures/harness");
const text = require("../../api/services/pr-text");

const MARK = '<!-- studio:v1 {"authorId":"11111111-2222-4333-8444-555555555555","authorName":"Molly","draftId":"uabcdefg--label","ops":1,"revertOf":null} -->';
const BRANCH = "studio/uabcdefg/label";
const OTHER = "feature/not-studio";

async function prepare(p, branch) {
  const main = (await p.git.getHead("main")).sha;
  await p.git.createBranch(branch, main);
  const c = await p.git.commitFiles({ branch, expectedHeadSha: main, message: "m", files: [{ path: "src/_data/hero.json", text: JSON.stringify({ badge: "x" }) + "\n" }] });
  return { main, sha: c.sha };
}

const failLabels = {
  memory: (p) => { p.repo.failLabels = true; },
  github: (p) => { p.server.state.failLabels = 403; },
};

for (const kind of ["memory", "github"]) {
  const make = kind === "memory" ? memoryProvider : githubProvider;

  test("label write refused: the PR is still created and says labelsApplied=false (" + kind + ")", async () => {
    const failures = [];
    const p = await (kind === "github" ? githubProvider({ onLabelFailure: (x) => failures.push(x) }) : make());
    try {
      failLabels[kind](p);
      const { sha } = await prepare(p, BRANCH);
      const pr = await p.git.openPr({ head: BRANCH, base: "main", title: "Studio: t (Molly)", body: "b\n" + MARK, labels: ["studio-draft", "studio-ai"], draft: true });
      assert.equal(pr.labelsApplied, false);
      assert.ok(pr.labels.includes("studio-draft"), "a Studio draft still reports its identity label, so the code that lists drafts keeps working");
      if (kind === "github") assert.equal(failures.length, 1, "the failure is reported ONCE (no body, no names)");
      assert.equal(pr.headSha, sha);
      const upd = await p.git.updatePr(pr.number, { body: "new\n" + MARK, labels: ["studio-ready"] });
      assert.equal(upd.labelsApplied, false);
      assert.equal(upd.body, "new\n" + MARK);
    } finally { await p.close(); }
  });

  test("merge identity matrix (" + kind + "): marker + label write refused is accepted; the refusals", async () => {
    const p = await make();
    try {
      // 1. accepted: studio branch + marker, label write refused (403)
      failLabels[kind](p);
      const a = await prepare(p, BRANCH);
      const pr = await p.git.openPr({ head: BRANCH, base: "main", title: "Studio: t (Molly)", body: MARK, labels: ["studio-draft"], draft: true });
      await p.git.markReady(pr.number);
      const merged = await p.git.merge(pr.number, { method: "squash", sha: a.sha });
      assert.match(merged.sha, /^[0-9a-f]{40}$/);
      // 2. refused: a studio branch WITHOUT the marker (and no label either)
      const B2 = "studio/uabcdefg/nomarker";
      const main2 = (await p.git.getHead("main")).sha;
      await p.git.createBranch(B2, main2);
      const c2 = await p.git.commitFiles({ branch: B2, expectedHeadSha: main2, message: "m", files: [{ path: "src/_data/hero.json", text: JSON.stringify({ badge: "y" }) + "\n" }] });
      const bare = await p.git.openPr({ head: B2, base: "main", title: "t", body: "no marker here", labels: [], draft: false });
      assert.equal(bare.labelsApplied, true, "a PR that is not a Studio draft is not 'missing' a label");
      await assert.rejects(() => p.git.merge(bare.number, { method: "squash", sha: c2.sha }), (e) => e.name === "ScopeError");
      // 3. refused: a forged marker on a branch that is not studio/ (the branch guard)
      await assert.rejects(() => p.git.openPr({ head: OTHER, base: "main", title: "t", body: MARK, labels: [], draft: false }), (e) => e.name === "ScopeError");
    } finally { await p.close(); }
  });

  test("merge identity matrix (" + kind + "): marker + label present is accepted", async () => {
    const p = await make();
    try {
      const a = await prepare(p, BRANCH);
      const pr = await p.git.openPr({ head: BRANCH, base: "main", title: "Studio: t (Molly)", body: MARK, labels: ["studio-draft"], draft: true });
      assert.equal(pr.labelsApplied, true);
      await p.git.markReady(pr.number);
      assert.match((await p.git.merge(pr.number, { method: "squash", sha: a.sha })).sha, /^[0-9a-f]{40}$/);
    } finally { await p.close(); }
  });

  test("a label alone is not enough: studio branch + label but no marker is refused (" + kind + ")", async () => {
    const p = await make();
    try {
      const a = await prepare(p, BRANCH);
      const pr = await p.git.openPr({ head: BRANCH, base: "main", title: "t", body: "someone edited the body", labels: ["studio-draft"], draft: false });
      await assert.rejects(() => p.git.merge(pr.number, { method: "squash", sha: a.sha }), (e) => e.name === "ScopeError");
    } finally { await p.close(); }
  });
}

test("a pull request from a fork is never a Studio draft, whatever its body says", async () => {
  const p = await memoryProvider();
  try {
    const { sha } = await prepare(p, BRANCH);
    const pr = await p.git.openPr({ head: BRANCH, base: "main", title: "t", body: MARK, labels: ["studio-draft"], draft: false });
    p.repo.prs.get(pr.number).fromFork = true;
    await assert.rejects(() => p.git.merge(pr.number, { method: "squash", sha }), (e) => e.name === "ScopeError");
  } finally { await p.close(); }
});

if (hasGit()) {
  test("local-git: the same identity rule", async () => {
    const p = await localProvider();
    try {
      const a = await prepare(p, BRANCH);
      const good = await p.git.openPr({ head: BRANCH, base: "main", title: "t", body: MARK, labels: [], draft: false });
      assert.equal(good.labelsApplied, false);
      assert.ok(good.labels.includes("studio-draft"));
      assert.match((await p.git.merge(good.number, { method: "squash", sha: a.sha })).sha, /^[0-9a-f]{40}$/);
    } finally { await p.close(); }
  });
}

test("end to end through the API: with every label write failing, a draft can be created, listed, submitted and published", async () => {
  const api = makeApi();
  api.repo.failLabels = true;
  const made = await api.call("editor", "POST", "/v1/drafts", patch(api, [heroOp("Labels are optional")], { title: "No labels today" }));
  assert.equal(made.status, 201, made.text);
  const id = made.json.draft.id;
  assert.ok(text.parseMarker(api.repo.prs.get(made.json.draft.number).body));
  assert.deepEqual([...api.repo.prs.get(made.json.draft.number).labels], [], "no label really exists on the pull request");
  const list = await api.call("editor", "GET", "/v1/drafts");
  assert.ok(list.json.drafts.some((d) => d.id === id), "the draft is still found");
  const sub = await api.call("editor", "POST", "/v1/drafts/" + id + "/submit", { idempotencyKey: uuid() });
  assert.equal(sub.status, 200, sub.text);
  const pub = await api.call("approver", "POST", "/v1/drafts/" + id + "/publish", { expectedHeadSha: sub.json.draft.headSha, idempotencyKey: uuid() });
  assert.equal(pub.status, 200, pub.text);
  assert.match(new TextDecoder().decode(api.repo.fileAt("main", "src/_data/hero.json")), /Labels are optional/);
});

test("the GitHub provider reports a label failure through the audit sink as label.failed, with no body", async () => {
  const { createAudit, memorySink } = require("../../api/audit");
  const sink = memorySink();
  const audit = createAudit({ sinks: [sink], salt: "t" });
  const p = await githubProvider({ onLabelFailure: () => audit.write({ requestId: "git", action: "label.failed", outcome: "error" }) });
  try {
    p.server.state.failLabels = 403;
    await prepare(p, BRANCH);
    await p.git.openPr({ head: BRANCH, base: "main", title: "t", body: MARK, labels: ["studio-draft"], draft: true });
    assert.deepEqual(sink.entries.map((e) => e.action), ["label.failed"]);
    assert.equal(JSON.stringify(sink.entries[0]).includes("Resource not accessible"), false);
  } finally { await p.close(); }
});
