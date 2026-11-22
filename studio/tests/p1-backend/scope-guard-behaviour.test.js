"use strict";
// What studio-scope REALLY does, not just what it says it does (PHASE1-DESIGN 10.6.1). The workflow text is parsed and its own
// "take the guard from main" lines are executed in a throwaway git repository, then the guard is run on pull requests of
// different shapes. So a guard that crashes (MODULE_NOT_FOUND), or a workflow that forgets to copy a module, fails HERE.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const WF = fs.readFileSync(path.join(ROOT, ".github", "workflows", "studio-scope.yml"), "utf8");
const GIT = (cwd, args) => {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false"].concat(args), { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error("git " + args.join(" ") + ": " + r.stderr);
  return r.stdout;
};
const hasGit = spawnSync("git", ["--version"]).status === 0;

// the workflow's lines: git show origin/main:<src> > "$RUNNER_TEMP/guard/<dest>"
const copies = [...WF.matchAll(/git show origin\/main:(\S+) > "\$RUNNER_TEMP\/guard\/(\S+)"/g)].map((m) => ({ src: m[1], dest: m[2] }));
// the final step: node "$RUNNER_TEMP/guard/<script>" --root "$GITHUB_WORKSPACE" --base origin/main --head HEAD
const runLine = /node "\$RUNNER_TEMP\/guard\/(\S+)" --root "\$GITHUB_WORKSPACE" --base (\S+) --head (\S+)/.exec(WF);

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-scope-"));
  const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
  GIT(dir, ["init", "--quiet", "-b", "main"]);
  // main = this repository's guard files plus a tiny site
  for (const rel of ["studio/guards/check-scope.js", "studio/validate/scope.js", "scripts/lib/image-rules.js"]) put(rel, fs.readFileSync(path.join(ROOT, rel)));
  put("src/_data/hero.json", '{ "headlineMain": "Free period products," }\n');
  put("src/pages/about.md", "---\ntitle: About\n---\nHello.\n");
  put("images/a.png", Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]));
  put("package.json", '{ "name": "x" }\n');
  put("cms/config.yml", "collections: []\n");
  GIT(dir, ["add", "-A"]);
  GIT(dir, ["commit", "--quiet", "-m", "main"]);
  GIT(dir, ["update-ref", "refs/remotes/origin/main", "HEAD"]); // what the checkout step's `git fetch origin main` provides
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "studio-scope-guard-"));
  return { dir, tmp, put, cleanup: () => { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(tmp, { recursive: true, force: true }); } };
}

// the workflow's "Take the guard ... from main" step, executed for real
function takeGuardFromMain(repo) {
  for (const c of copies) {
    const out = path.join(repo.tmp, "guard", c.dest);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const r = spawnSync("git", ["show", "origin/main:" + c.src], { cwd: repo.dir, encoding: "buffer" });
    assert.equal(r.status, 0, "git show origin/main:" + c.src + " failed: " + String(r.stderr));
    fs.writeFileSync(out, r.stdout);
  }
}

function runGuard(repo) {
  const r = spawnSync(process.execPath, [path.join(repo.tmp, "guard", runLine[1]), "--root", repo.dir, "--base", runLine[2], "--head", runLine[3]], { encoding: "utf8" });
  return { code: r.status, out: String(r.stdout || "") + String(r.stderr || "") };
}

// a pull request: a branch off main with these file changes (null = delete), judged against origin/main
function pullRequest(repo, changes) {
  GIT(repo.dir, ["checkout", "--quiet", "-B", "studio/uabcdefg/test", "main"]);
  for (const [rel, text] of Object.entries(changes)) {
    if (text === null) fs.rmSync(path.join(repo.dir, rel));
    else repo.put(rel, text);
  }
  GIT(repo.dir, ["add", "-A"]);
  GIT(repo.dir, ["commit", "--quiet", "-m", "pr"]);
  const res = runGuard(repo);
  GIT(repo.dir, ["checkout", "--quiet", "main"]);
  return res;
}

test("the workflow still has the lines this test executes", () => {
  assert.ok(copies.length >= 3, "the workflow must take at least the guard, the scope definition and the image rules from main (found " + copies.length + ")");
  assert.ok(runLine, "the workflow must run the guard with --root, --base and --head");
});

test("studio-scope on real pull requests: content passes, code and deletions are judged, and the guard never crashes", { skip: !hasGit && "git is not installed" }, () => {
  const repo = makeRepo();
  try {
    takeGuardFromMain(repo);
    const ok = pullRequest(repo, { "src/_data/hero.json": '{ "headlineMain": "A new headline" }\n', "src/pages/about.md": "---\ntitle: About\n---\nChanged.\n", "images/b.png": Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 9, 9]) });
    assert.equal(ok.code, 0, "an ordinary content publish passes: " + ok.out);
    assert.match(ok.out, /check-scope: ok/);

    for (const rel of ["studio/guards/check-scope.js", "studio/validate/scope.js"]) {
      const bad = pullRequest(repo, { [rel]: "// widened\n" });
      assert.equal(bad.code, 1, "editing " + rel + " is judged, not ignored: " + bad.out);
      assert.ok(bad.out.includes(rel), "the answer names " + rel + ": " + bad.out);
      assert.doesNotMatch(bad.out, /MODULE_NOT_FOUND|Cannot find module/);
    }

    const del = pullRequest(repo, { "package.json": null });
    assert.equal(del.code, 1, "deleting a non-image file is refused: " + del.out);
    assert.match(del.out, /package\.json/);
    const delPage = pullRequest(repo, { "src/pages/about.md": null });
    assert.equal(delPage.code, 1);
    assert.match(delPage.out, /never deletes data files or pages/);
    const delPic = pullRequest(repo, { "images/a.png": null });
    assert.equal(delPic.code, 0, "removing a picture is allowed: " + delPic.out);
  } finally { repo.cleanup(); }
});

test("a workflow that forgot to copy a module the guard needs would crash it: the executed copy step is what proves otherwise", { skip: !hasGit && "git is not installed" }, () => {
  const repo = makeRepo();
  try {
    takeGuardFromMain(repo);
    // simulate the bug: the image-rules copy is missing
    fs.rmSync(path.join(repo.tmp, "guard", "scripts", "lib", "image-rules.js"));
    const r = pullRequest(repo, { "src/_data/hero.json": '{ "headlineMain": "x" }\n' });
    assert.match(r.out, /MODULE_NOT_FOUND|Cannot find module/, "this is the crash the workflow's copy step prevents");
    assert.notEqual(r.code, 0);
  } finally { repo.cleanup(); }
});
