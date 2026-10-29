"use strict";
// ONE contract, three implementations: mock-memory, github.js over the mock GitHub server, local-git over a real repo.
// It includes the scope guards: every write method refuses main, workflows, package files and non-studio branches
// INSIDE the provider, even when no route is involved.
const test = require("node:test");
const assert = require("node:assert/strict");
const { memoryProvider, githubProvider, localProvider, hasGit, HERO } = require("../fixtures/providers");
const { METHODS } = require("../../api/providers/git/interface");

const BRANCH = "studio/uabcdefg/contract";
const dec = new TextDecoder();

const kinds = [["memory", memoryProvider], ["github-over-mock", githubProvider]];
if (hasGit()) kinds.push(["local-git", localProvider]);

for (const [label, make] of kinds) {
  test("GitProvider contract: " + label, async () => {
    const p = await make();
    const git = p.git;
    try {
      for (const m of METHODS) assert.equal(typeof git[m], "function", "missing method " + m);
      // ---- reads
      const main = (await git.getHead("main")).sha;
      assert.match(main, /^[0-9a-f]{40}$/);
      assert.equal(await git.getHead("no-such-branch"), null);
      assert.equal(await git.readTextFile("main", "src/_data/hero.json"), HERO);
      assert.equal(await git.readTextFile(main, "src/_data/hero.json"), HERO);
      assert.equal(await git.readTextFile("main", "src/_data/nope.json"), null);
      assert.deepEqual(Array.from(await git.readFileBytes("main", "images/a.png")), [137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
      assert.equal(await git.hasFile("main", "images/a.png"), true);
      assert.equal(await git.hasFile("main", "images/zzz.png"), false);
      assert.deepEqual(await git.listDir("main", "src/_data"), ["hero.json"]);
      assert.equal(await git.listDir("main", "no/dir"), null);
      assert.equal(git.getBaseBranch(), "main");

      // ---- branch + atomic commit (text and binary together)
      await git.createBranch(BRANCH, main);
      await assert.rejects(() => git.createBranch(BRANCH, main), (e) => /exist/.test(e.message));
      const c1 = await git.commitFiles({
        branch: BRANCH, expectedHeadSha: main,
        message: "Studio: Change hero\n\n- Hero > Headline: changed\n\nStudio-User: 4ce9d419-e0c5-40cd-b421-fc9138ed7895\nStudio-Idempotency: 9b1c0e0e-5c8e-4f4e-8a55-0f6f6c5b2d11",
        files: [{ path: "src/_data/hero.json", text: HERO.replace("Free period products,", "We cover the UK") }, { path: "images/new.png", bytes: new Uint8Array([137, 80, 78, 71, 1, 1, 1, 1, 9]) }],
      });
      assert.match(c1.sha, /^[0-9a-f]{40}$/);
      assert.equal((await git.getHead(BRANCH)).sha, c1.sha);
      assert.match(await git.readTextFile(BRANCH, "src/_data/hero.json"), /We cover the UK/);
      assert.match(await git.readTextFile("main", "src/_data/hero.json"), /Free period products/); // main untouched
      assert.deepEqual(Array.from(await git.readFileBytes(BRANCH, "images/new.png")), [137, 80, 78, 71, 1, 1, 1, 1, 9]);
      assert.deepEqual((await git.changedFiles(main, c1.sha)).sort(), ["images/new.png", "src/_data/hero.json"]);

      // a stale head is refused with the current head in the details
      await assert.rejects(() => git.commitFiles({ branch: BRANCH, expectedHeadSha: main, message: "x", files: [{ path: "src/_data/hero.json", text: "{}" }] }), (e) => e.code === "head_moved" && e.details.headSha === c1.sha);

      // ---- trailers (idempotency lookback)
      assert.deepEqual(await git.findCommitByTrailer(BRANCH, "Studio-Idempotency", "9b1c0e0e-5c8e-4f4e-8a55-0f6f6c5b2d11"), { sha: c1.sha });
      assert.equal(await git.findCommitByTrailer(BRANCH, "Studio-Idempotency", "00000000-0000-4000-8000-000000000000"), null);
      assert.equal(await git.findCommitByTrailer("studio/uabcdefg/none", "Studio-Idempotency", "x"), null);

      // ---- pull requests
      await assert.rejects(() => git.openPr({ head: BRANCH, base: "develop", title: "x", body: "", labels: [], draft: true }), (e) => e.name === "ScopeError");
      await assert.rejects(() => git.openPr({ head: "main", base: "main", title: "x", body: "", labels: [], draft: true }), (e) => e.name === "ScopeError");
      const pr = await git.openPr({ head: BRANCH, base: "main", title: "Studio: Change hero (Molly)", body: "body", labels: ["studio-draft"], draft: true });
      assert.equal(pr.headRef, BRANCH);
      assert.equal(pr.headSha, c1.sha);
      assert.equal(pr.draft, true);
      assert.equal(pr.state, "open");
      assert.equal(pr.merged, false);
      assert.deepEqual(pr.labels, ["studio-draft"]);
      assert.equal(pr.baseSha, main);
      assert.equal(pr.behindBase, false);
      assert.equal(pr.mergeable, true);
      assert.ok(["none", "pending", "success", "failure"].includes(pr.checks.state));
      assert.equal((await git.getPr(pr.number)).title, "Studio: Change hero (Molly)");
      assert.equal(await git.getPr(9999), null);
      const listed = await git.listPrs({ headPrefix: BRANCH, state: "open" });
      assert.deepEqual(listed.map((x) => x.number), [pr.number]);
      assert.deepEqual(await git.listPrs({ headPrefix: "studio/uzzzzzzz/", state: "open" }), []);
      const upd = await git.updatePr(pr.number, { body: "new body", labels: ["studio-ready"] });
      assert.equal(upd.body, "new body");
      assert.deepEqual(upd.labels, ["studio-draft", "studio-ready"]);

      // ---- merge needs the label, a ready PR and the head sha
      await assert.rejects(() => git.merge(pr.number, { method: "squash", sha: c1.sha }), (e) => e.name === "GitError"); // still a draft
      await git.markReady(pr.number);
      assert.equal((await git.getPr(pr.number)).draft, false);
      await assert.rejects(() => git.merge(pr.number, { method: "merge", sha: c1.sha }), (e) => e.name === "GitError");
      await assert.rejects(() => git.merge(pr.number, { method: "squash", sha: main }), (e) => e.code === "sha_mismatch");
      const merged = await git.merge(pr.number, { method: "squash", sha: c1.sha });
      assert.match(merged.sha, /^[0-9a-f]{40}$/);
      assert.equal((await git.getHead("main")).sha, merged.sha);
      assert.match(await git.readTextFile("main", "src/_data/hero.json"), /We cover the UK/);
      assert.equal((await git.getPr(pr.number)).merged, true);
      const item = await git.getMergedPr(pr.number);
      assert.equal(item.parentSha, main);
      assert.equal(item.mergeSha, merged.sha);
      assert.deepEqual(item.files.sort(), ["images/new.png", "src/_data/hero.json"]);
      assert.equal(item.title, "Studio: Change hero (Molly)");
      const page = await git.listMerged({ limit: 10, cursor: null });
      assert.equal(page.items[0].number, pr.number);
      assert.equal(page.next, null);
      assert.equal(await git.getMergedPr(9999), null);

      // ---- reset (rebase support) and discard
      const B2 = "studio/uabcdefg/second";
      await git.createBranch(B2, merged.sha);
      const c2 = await git.commitFiles({ branch: B2, expectedHeadSha: merged.sha, message: "m", files: [{ path: "src/pages/about.md", text: "---\ntitle: x\n---\n" }] });
      await assert.rejects(() => git.resetBranch(B2, merged.sha, main), (e) => e.code === "head_moved");
      await git.resetBranch(B2, merged.sha, c2.sha);
      assert.equal((await git.getHead(B2)).sha, merged.sha);
      const pr2 = await git.openPr({ head: B2, base: "main", title: "t", body: "", labels: ["studio-draft"], draft: true });
      await git.closePr(pr2.number, "Discarded");
      await git.deleteBranch(B2);
      assert.equal(await git.getHead(B2), null);
      assert.equal((await git.getPr(pr2.number)).state, "closed");
    } finally { await p.close(); }
  });

  test("GitProvider scope guards live INSIDE every write method: " + label, async () => {
    const p = await make();
    const git = p.git;
    try {
      const main = (await git.getHead("main")).sha;
      await git.createBranch(BRANCH, main);
      const files = (path) => [{ path, text: "x" }];
      // branch guards
      for (const b of ["main", "master", "feature/x", "studio/main", "studio/a/b/c", "refs/heads/main", "studio/../main"]) {
        await assert.rejects(() => git.createBranch(b, main), (e) => e.name === "ScopeError", "createBranch " + b);
        await assert.rejects(() => git.commitFiles({ branch: b, expectedHeadSha: main, message: "x", files: files("src/_data/hero.json") }), (e) => e.name === "ScopeError", "commitFiles " + b);
        await assert.rejects(() => git.resetBranch(b, main, main), (e) => e.name === "ScopeError", "resetBranch " + b);
        await assert.rejects(() => git.deleteBranch(b), (e) => e.name === "ScopeError", "deleteBranch " + b);
      }
      // path guards, on a perfectly valid studio branch
      for (const f of [".github/workflows/x.yml", "package.json", "package-lock.json", "cms/config.yml", ".eleventy.js", "netlify.toml", "src/index.njk", "src/_data/../../package.json", "lib/rules.js", "studio/api/handler.js", "scripts/check-cms.js", "images/../package.json", "src/pages/new.njk", "src/_data/hero.js", "node_modules/x/index.js", ".git/config", "/etc/passwd"]) {
        await assert.rejects(() => git.commitFiles({ branch: BRANCH, expectedHeadSha: main, message: "x", files: files(f) }), (e) => e.name === "ScopeError", "commitFiles path " + f);
      }
      await assert.rejects(() => git.commitFiles({ branch: BRANCH, expectedHeadSha: main, message: "x", files: [{ path: "src/_data/hero.json", text: "a", bytes: new Uint8Array(1) }] }), (e) => e.name === "GitError");
      await assert.rejects(() => git.commitFiles({ branch: BRANCH, expectedHeadSha: main, message: "x", files: [] }), (e) => e.name === "GitError");
      assert.equal((await git.getHead(BRANCH)).sha, main); // nothing slipped in
      assert.equal((await git.getHead("main")).sha, main);
      // a PR that is not a Studio draft cannot be merged through this provider
      const other = await git.openPr({ head: BRANCH, base: "main", title: "t", body: "", labels: [], draft: false });
      await assert.rejects(() => git.merge(other.number, { method: "squash", sha: main }), (e) => e.name === "ScopeError");
    } finally { await p.close(); }
  });
}
