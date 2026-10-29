"use strict";
// Factories for the three GitProvider implementations, all over the same tiny seed repository.
//   memory     providers/git/mock-memory.js
//   github     providers/git/github.js talking to studio/dev/mock-github-server.js over loopback
//   local-git  providers/git/local-git.js over a real temp git repository (skipped when git is missing)

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const { createMemoryGit } = require("../../api/providers/git/mock-memory");
const { createGithubGit } = require("../../api/providers/git/github");
const { createLocalGit } = require("../../api/providers/git/local-git");
const { createMockGithub } = require("../../dev/mock-github-server");

const enc = new TextEncoder();
const HERO = JSON.stringify({ badge: "Free", headlineMain: "Free period products,", headlineAccent: "for everyone." }, null, 2) + "\n";
const ABOUT = "---\ntitle: About us\npermalink: /about/\nlayout: page.njk\n---\nBody.\n";
const SEED = () => new Map([
  ["src/_data/hero.json", enc.encode(HERO)],
  ["src/pages/about.md", enc.encode(ABOUT)],
  ["images/a.png", new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4])],
  ["package.json", enc.encode('{"name":"x"}\n')],
]);

const hasGit = () => spawnSync("git", ["--version"]).status === 0;

function makeRsa() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { privateKey, publicKey, pkcs8: privateKey.export({ type: "pkcs8", format: "pem" }), pkcs1: privateKey.export({ type: "pkcs1", format: "pem" }), publicPem: publicKey.export({ type: "spki", format: "pem" }) };
}

async function memoryProvider(opts) {
  const m = createMemoryGit(Object.assign({ files: SEED() }, opts || {}));
  return { name: "memory", git: m.git, repo: m.repo, close: async () => {} };
}

async function githubProvider(opts) {
  const o = opts || {};
  const m = createMemoryGit(Object.assign({ files: SEED() }, o.memory || {}));
  const keys = o.keys || makeRsa();
  const server = createMockGithub({ repo: m.repo, appId: "12345", installationId: "67890", publicKey: keys.publicKey, now: o.now, tokenTtlMs: o.tokenTtlMs });
  const base = await server.listen();
  const git = createGithubGit({ owner: m.repo.owner, repo: m.repo.name, baseBranch: "main", appId: "12345", installationId: "67890", privateKey: o.privateKey || keys.pkcs8, apiBase: base, now: o.now, fetch: o.fetch });
  return { name: "github", git, repo: m.repo, server, keys, close: () => server.close() };
}

async function localProvider(opts) {
  const o = opts || {};
  const src = fs.mkdtempSync(path.join(os.tmpdir(), "studio-src-"));
  const g = (args) => { const r = spawnSync("git", ["-C", src].concat(args), { encoding: "utf8", env: Object.assign({}, process.env, { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" }) }); if (r.status !== 0) throw new Error(r.stderr); };
  g(["init", "--quiet", "-b", "main"]);
  for (const [p, b] of (o.files || SEED())) { fs.mkdirSync(path.dirname(path.join(src, p)), { recursive: true }); fs.writeFileSync(path.join(src, p), Buffer.from(b)); }
  g(["add", "-A"]);
  g(["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "seed"]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-lg-"));
  const git = createLocalGit({ source: src, dir, baseBranch: "main", checkRunner: o.checkRunner });
  return { name: "local-git", git, close: async () => { fs.rmSync(src, { recursive: true, force: true }); fs.rmSync(dir, { recursive: true, force: true }); } };
}

module.exports = { SEED, HERO, ABOUT, memoryProvider, githubProvider, localProvider, makeRsa, hasGit };
