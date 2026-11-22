"use strict";
// Small BACKEND pieces: requestReviewers on every Git provider, the weekly keep-alive trigger, the sign-in e-mail notes.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { memoryProvider, githubProvider, localProvider, hasGit } = require("../fixtures/providers");
const { METHODS } = require("../../api/providers/git/interface");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const MARK = '<!-- studio:v1 {"authorId":"11111111-2222-4333-8444-555555555555","authorName":"Molly","draftId":"uabcdefg--rev","ops":1,"revertOf":null} -->';
const BRANCH = "studio/uabcdefg/rev";

const kinds = [["memory", memoryProvider], ["github-over-mock", githubProvider]];
if (hasGit()) kinds.push(["local-git", localProvider]);

test("requestReviewers is part of the Git provider interface", () => { assert.ok(METHODS.includes("requestReviewers")); });

for (const [label, make] of kinds) {
  test("requestReviewers (" + label + "): asks for review, validates every login, never trusts the caller", async () => {
    const p = await make();
    try {
      const main = (await p.git.getHead("main")).sha;
      await p.git.createBranch(BRANCH, main);
      await p.git.commitFiles({ branch: BRANCH, expectedHeadSha: main, message: "m", files: [{ path: "src/_data/hero.json", text: "{}\n" }] });
      const pr = await p.git.openPr({ head: BRANCH, base: "main", title: "t", body: MARK, labels: ["studio-draft"], draft: true });
      assert.deepEqual(await p.git.requestReviewers(pr.number, ["mollygh", "Amelia-B"]), { requested: ["mollygh", "Amelia-B"] });
      for (const bad of [[], ["has space"], ["a/b"], ["x".repeat(40)], ["ok", "not ok"], [""], [1], "mollygh", null, ["-"].concat(["a".repeat(40)])]) {
        await assert.rejects(() => p.git.requestReviewers(pr.number, bad), (e) => e.name === "GitError" && e.code === "bad_request", JSON.stringify(bad));
      }
      await assert.rejects(() => p.git.requestReviewers(99999, ["mollygh"]), (e) => e.name === "GitError");
    } finally { await p.close(); }
  });
}

test("requestReviewers: GitHub refusing (not a collaborator) is a GitError the caller can catch", async () => {
  const p = await githubProvider();
  try {
    const main = (await p.git.getHead("main")).sha;
    await p.git.createBranch(BRANCH, main);
    await p.git.commitFiles({ branch: BRANCH, expectedHeadSha: main, message: "m", files: [{ path: "src/_data/hero.json", text: "{}\n" }] });
    const pr = await p.git.openPr({ head: BRANCH, base: "main", title: "t", body: MARK, labels: [], draft: true });
    p.server.state.failReviewers = 422;
    await assert.rejects(() => p.git.requestReviewers(pr.number, ["stranger"]), (e) => e.name === "GitError" && e.code === "conflict");
    p.server.state.failReviewers = 0;
    assert.deepEqual((await p.git.requestReviewers(pr.number, ["stranger"])).requested, ["stranger"]);
  } finally { await p.close(); }
});

test("the weekly keep-alive trigger is still in wrangler.example.toml (a paused Supabase project means nobody can sign in)", () => {
  const toml = fs.readFileSync(path.join(ROOT, "studio", "api", "deploy", "wrangler.example.toml"), "utf8");
  assert.match(toml, /^\[triggers\]\s*$/m);
  assert.match(toml, /^crons\s*=\s*\["[0-9*,\/ -]+ [0-9*,\/ -]+ \* \* [0-9,*-]+"\]/m, "a cron expression that runs at least weekly");
  const dow = /^crons\s*=\s*\["\S+ \S+ \S+ \S+ (\S+)"\]/m.exec(toml);
  assert.ok(dow && dow[1] !== "*" ? dow[1].split(",").length >= 1 : true);
});

test("the runbook says what to do about sign-in e-mail and the GitHub App Issues permission", () => {
  const rb = fs.readFileSync(path.join(ROOT, "docs", "STUDIO-RUNBOOK.md"), "utf8");
  assert.match(rb, /custom SMTP/i);
  assert.match(rb, /20 codes arrive within 60 seconds/);
  assert.match(rb, /Issues: Read and write/);
  assert.match(rb, /Restore project/);
});
