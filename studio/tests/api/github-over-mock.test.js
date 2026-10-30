"use strict";
// providers/git/github.js against the mock GitHub server: App JWT -> installation token, caching, key formats,
// permissions requested, retries, and that no secret ever appears in an error.
const test = require("node:test");
const assert = require("node:assert/strict");
const { githubProvider, makeRsa } = require("../fixtures/providers");
const { createGithubGit, pemToKeyBytes } = require("../../api/providers/git/github");

test("one installation token is exchanged, reused, and refreshed 5 minutes before it expires", async () => {
  let clock = Date.parse("2026-10-29T12:00:00Z");
  const now = () => new Date(clock);
  const p = await githubProvider({ now, tokenTtlMs: 60 * 60 * 1000 });
  try {
    await p.git.getHead("main");
    await p.git.getHead("main");
    await p.git.readTextFile("main", "src/_data/hero.json");
    assert.equal(p.server.state.tokensIssued, 1);
    clock += 54 * 60 * 1000; // 6 minutes left: still cached
    await p.git.getHead("main");
    assert.equal(p.server.state.tokensIssued, 1);
    clock += 2 * 60 * 1000; // 4 minutes left: refresh
    await p.git.getHead("main");
    assert.equal(p.server.state.tokensIssued, 2);
  } finally { await p.close(); }
});

test("concurrent first calls share one token exchange", async () => {
  const p = await githubProvider();
  try {
    await Promise.all([p.git.getHead("main"), p.git.getHead("main"), p.git.hasFile("main", "images/a.png")]);
    assert.equal(p.server.state.tokensIssued, 1);
  } finally { await p.close(); }
});

test("a PKCS#1 key (BEGIN RSA PRIVATE KEY) and escaped newlines work like PKCS#8", async () => {
  const keys = makeRsa();
  for (const pem of [keys.pkcs1, keys.pkcs1.replace(/\n/g, "\\n"), keys.pkcs8.replace(/\n/g, "\\n")]) {
    const p = await githubProvider({ keys, privateKey: pem });
    try { assert.match((await p.git.getHead("main")).sha, /^[0-9a-f]{40}$/); } finally { await p.close(); }
  }
  assert.throws(() => pemToKeyBytes("not a key"), /PEM/);
});

test("a wrong key or app id is refused by GitHub and the error leaks nothing", async () => {
  const other = makeRsa();
  const p = await githubProvider({ privateKey: other.pkcs8 });
  try {
    await assert.rejects(() => p.git.getHead("main"), (e) => {
      assert.equal(e.name, "GitError");
      assert.equal(e.message.includes("PRIVATE KEY"), false);
      assert.equal(e.message.includes(other.pkcs8.slice(40, 80)), false);
      return true;
    });
  } finally { await p.close(); }
});

test("the token request asks only for the documented least-privilege permissions", async () => {
  const seen = [];
  const p = await githubProvider({ fetch: async (url, init) => { if (/access_tokens/.test(String(url))) seen.push(JSON.parse(init.body)); return fetch(url, init); } });
  try {
    await p.git.getHead("main");
    assert.deepEqual(seen[0].permissions, { contents: "write", pull_requests: "write", issues: "write", checks: "read", statuses: "read", metadata: "read" });
  } finally { await p.close(); }
});

test("requests carry the API version and user agent; GETs retry on 5xx; writes do not", async () => {
  const headersSeen = [];
  const p = await githubProvider({ fetch: async (url, init) => { headersSeen.push(init.headers); return fetch(url, init); } });
  try {
    await p.git.getHead("main");
    const h = headersSeen[headersSeen.length - 1];
    assert.equal(h["X-GitHub-Api-Version"], "2022-11-28");
    assert.equal(h["User-Agent"], "covered-studio");
    assert.match(h.Authorization, /^Bearer ghs_/);
    p.server.state.failNext = 502;
    assert.match((await p.git.getHead("main")).sha, /^[0-9a-f]{40}$/); // retried
    const main = (await p.git.getHead("main")).sha;
    p.server.state.failNext = 502;
    await assert.rejects(() => p.git.createBranch("studio/uabcdefg/write-test", main), (e) => e.name === "GitError"); // a POST is never replayed blindly
  } finally { await p.close(); }
});

test("a 401 on a cached token fetches a fresh one once", async () => {
  const p = await githubProvider();
  try {
    await p.git.getHead("main");
    p.server.state.failNext = 401;
    assert.match((await p.git.getHead("main")).sha, /^[0-9a-f]{40}$/);
    assert.equal(p.server.state.tokensIssued, 2);
  } finally { await p.close(); }
});

test("only https://api.github.com (or a loopback mock) is accepted as the API base", () => {
  assert.throws(() => createGithubGit({ owner: "a", repo: "b", appId: "1", installationId: "2", privateKey: "x", apiBase: "https://evil.example" }), /apiBase/);
  assert.throws(() => createGithubGit({ owner: "a", repo: "b", appId: "1", installationId: "2", privateKey: "x", apiBase: "http://10.0.0.1" }), /apiBase/);
  assert.doesNotThrow(() => createGithubGit({ owner: "a", repo: "b", appId: "1", installationId: "2", privateKey: "x" }));
});

test("paths with spaces and slashes are encoded per segment; labels are created lazily and 'already exists' is fine", async () => {
  const p = await githubProvider();
  try {
    assert.equal(await p.git.hasFile("main", "images/a b.png"), false);
    const main = (await p.git.getHead("main")).sha;
    await p.git.createBranch("studio/uabcdefg/labels", main);
    const c = await p.git.commitFiles({ branch: "studio/uabcdefg/labels", expectedHeadSha: main, message: "m", files: [{ path: "src/_data/hero.json", text: "{}" }] });
    const a = await p.git.openPr({ head: "studio/uabcdefg/labels", base: "main", title: "t", body: "", labels: ["studio-draft", "studio-revert"], draft: true });
    assert.deepEqual(a.labels, ["studio-draft", "studio-revert"]);
    await p.git.createBranch("studio/uabcdefg/labels2", c.sha);
    const b = await p.git.openPr({ head: "studio/uabcdefg/labels2", base: "main", title: "t", body: "", labels: ["studio-draft"], draft: true }); // label exists now: 422 swallowed
    assert.deepEqual(b.labels, ["studio-draft"]);
  } finally { await p.close(); }
});
