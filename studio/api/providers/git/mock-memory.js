"use strict";
// In-memory Git host: a tiny git object store (blobs, flat trees, commits, refs) plus pull requests, checks and
// squash merges. It serves two purposes:
//   * MemoryGit        - a GitProvider used directly by unit tests and by `npm run studio:dev`;
//   * the mock GitHub REST server (studio/dev/mock-github-server.js) translates GitHub's REST/GraphQL calls onto the
//     same MemoryRepo, so providers/git/github.js is tested against the exact semantics MemoryGit has.
// Node only (node:crypto, node:fs for seeding). Never imported by the portable set.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const iface = require("./interface");

const { GitError, REQUIRED_CHECKS, summarizeChecks } = iface;
const sha1 = (buf) => crypto.createHash("sha1").update(buf).digest("hex");
const enc = new TextEncoder();
const dec = new TextDecoder("utf-8");
const isSha = (s) => /^[0-9a-f]{40}$/.test(s);

class MemoryRepo {
  constructor(opts) {
    const o = opts || {};
    this.owner = o.owner || "covered";
    this.name = o.name || "website";
    this.baseBranch = o.baseBranch || "main";
    this.botLogin = o.botLogin || "covered-studio[bot]";
    this.autoChecks = o.autoChecks || "success"; // success | pending | none | failure
    this.blobs = new Map();
    this.trees = new Map();
    this.commits = new Map();
    this.refs = new Map();
    this.prs = new Map();
    this.labels = new Set();
    this.checkOverride = new Map(); // head sha -> { runs, statuses }
    this.nextPr = o.firstPr || 1;
    this.clock = o.clock || (() => new Date());
    this.tick = 0;
    this.log = [];
  }

  now() { return this.clock().toISOString(); }

  putBlob(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : enc.encode(String(bytes));
    const sha = sha1(Buffer.concat([Buffer.from("blob " + b.length + "\0"), Buffer.from(b)]));
    this.blobs.set(sha, b);
    return sha;
  }

  putTree(entries) { // Map path -> blobSha
    const lines = [...entries].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([p, s]) => "100644 " + p + "\0" + s).join("\n");
    const sha = sha1(Buffer.from("tree " + lines.length + "\0" + lines));
    this.trees.set(sha, new Map(entries));
    return sha;
  }

  putCommit({ tree, parents, message, author, date }) {
    this.tick += 1;
    const body = "tree " + tree + "\n" + (parents || []).map((p) => "parent " + p + "\n").join("") + "author " + (author || this.botLogin) + " " + (date || this.now()) + " #" + this.tick + "\n\n" + message;
    const sha = sha1(Buffer.from("commit " + body.length + "\0" + body));
    this.commits.set(sha, { sha, tree, parents: parents || [], message, author: author || this.botLogin, date: date || this.now() });
    return sha;
  }

  seed(files, message) {
    const entries = new Map();
    for (const [p, bytes] of files) entries.set(p, this.putBlob(bytes));
    const sha = this.putCommit({ tree: this.putTree(entries), parents: [], message: message || "Seed", author: "seed" });
    this.refs.set("refs/heads/" + this.baseBranch, sha);
    return sha;
  }

  resolve(ref) {
    if (typeof ref !== "string" || !ref) return null;
    if (isSha(ref)) return this.commits.has(ref) ? ref : null;
    return this.refs.get("refs/heads/" + ref) || null;
  }
  head(branch) { return this.refs.get("refs/heads/" + branch) || null; }
  treeOf(sha) { const c = this.commits.get(sha); return c ? this.trees.get(c.tree) : null; }
  fileAt(ref, p) {
    const sha = this.resolve(ref);
    if (!sha) return null;
    const bs = this.treeOf(sha).get(p);
    return bs ? this.blobs.get(bs) : null;
  }
  ancestors(sha) {
    const seen = new Set();
    const stack = [sha];
    while (stack.length) { const s = stack.pop(); if (seen.has(s)) continue; seen.add(s); for (const p of this.commits.get(s).parents) stack.push(p); }
    return seen;
  }
  mergeBase(a, b) {
    const inB = this.ancestors(b);
    const queue = [a];
    const seen = new Set();
    while (queue.length) { const s = queue.shift(); if (seen.has(s)) continue; seen.add(s); if (inB.has(s)) return s; for (const p of this.commits.get(s).parents) queue.push(p); }
    return null;
  }
  changedPaths(shaA, shaB) {
    const a = shaA ? this.treeOf(shaA) : new Map();
    const b = shaB ? this.treeOf(shaB) : new Map();
    const out = [];
    for (const [p, s] of b) if (a.get(p) !== s) out.push(p);
    for (const p of a.keys()) if (!b.has(p)) out.push(p);
    return out.sort();
  }
  // a commit on top of `parentSha` with the given changes [{ path, bytes|null }]
  commitOn(parentSha, changes, message, author, date) {
    const entries = new Map(this.treeOf(parentSha));
    for (const c of changes) { if (c.bytes === null) entries.delete(c.path); else entries.set(c.path, this.putBlob(c.bytes)); }
    return this.putCommit({ tree: this.putTree(entries), parents: [parentSha], message, author, date });
  }

  // ---- pull requests -------------------------------------------------------------------------------------
  createPr({ head, base, title, body, draft, labels, authorLogin }) {
    if (!this.head(head)) throw new GitError("not_found", "head branch does not exist");
    const n = this.nextPr++;
    const pr = { number: n, headRef: head, baseRef: base, title, body: body || "", draft: !!draft, labels: new Set(labels || []), state: "open", merged: false, authorLogin: authorLogin || this.botLogin, createdAt: this.now(), updatedAt: this.now(), mergeSha: null, mergedAt: null, mergedBy: null, parentSha: null, headShaAtClose: null, files: null };
    this.prs.set(n, pr);
    (labels || []).forEach((l) => this.labels.add(l));
    return pr;
  }

  checksFor(sha) {
    if (this.checkOverride.has(sha)) return this.checkOverride.get(sha);
    const mode = this.autoChecks;
    if (mode === "none") return { runs: [], statuses: [] };
    if (mode === "pending") return { runs: REQUIRED_CHECKS.map((name) => ({ name, status: "in_progress", conclusion: null })), statuses: [] };
    if (mode === "failure") return { runs: REQUIRED_CHECKS.map((name, i) => ({ name, status: "completed", conclusion: i ? "success" : "failure" })), statuses: [] };
    return { runs: REQUIRED_CHECKS.map((name) => ({ name, status: "completed", conclusion: "success" })), statuses: [] };
  }
  setChecks(number, state, failing) {
    const pr = this.prs.get(number);
    const sha = this.head(pr.headRef) || pr.headShaAtClose;
    let runs;
    if (state === "none") runs = [];
    else if (state === "pending") runs = REQUIRED_CHECKS.map((name) => ({ name, status: "in_progress", conclusion: null }));
    else if (state === "failure") runs = REQUIRED_CHECKS.map((name) => ({ name, status: "completed", conclusion: (failing || [REQUIRED_CHECKS[0]]).includes(name) ? "failure" : "success" }));
    else runs = REQUIRED_CHECKS.map((name) => ({ name, status: "completed", conclusion: "success" }));
    this.checkOverride.set(sha, { runs, statuses: [] });
  }

  prView(pr, urlBase) {
    const headSha = this.head(pr.headRef) || pr.headShaAtClose;
    const mainSha = this.head(this.baseBranch);
    const base = pr.merged ? pr.parentSha : headSha ? this.mergeBase(headSha, mainSha) : null;
    let mergeable = null;
    if (!pr.merged && pr.state === "open" && headSha) {
      mergeable = true;
      const mainTree = this.treeOf(mainSha);
      const baseTree = this.treeOf(base);
      const headTree = this.treeOf(headSha);
      for (const p of this.changedPaths(base, headSha)) if (mainTree.get(p) !== baseTree.get(p) && mainTree.get(p) !== headTree.get(p)) mergeable = false;
    }
    const ck = headSha ? this.checksFor(headSha) : { runs: [], statuses: [] };
    return {
      fromFork: !!pr.fromFork, number: pr.number, url: (urlBase || "https://github.com/" + this.owner + "/" + this.name) + "/pull/" + pr.number, state: pr.state, draft: pr.draft, merged: pr.merged,
      headRef: pr.headRef, headSha, baseSha: base, behindBase: !pr.merged && !!base && base !== mainSha, mergeable, labels: [...pr.labels].sort(), authorLogin: pr.authorLogin,
      title: pr.title, body: pr.body, checks: summarizeChecks(ck.runs, ck.statuses), mergeCommitSha: pr.mergeSha, createdAt: pr.createdAt, updatedAt: pr.updatedAt,
    };
  }

  // squash merge: the PR's changed files (relative to the merge base) land on main in one commit
  squashMerge(number, expectedSha, mergedBy) {
    const pr = this.prs.get(number);
    const headSha = this.head(pr.headRef);
    if (expectedSha && headSha !== expectedSha) throw new GitError("sha_mismatch", "Head branch was modified. Review and try the merge again.");
    const view = this.prView(pr);
    if (view.mergeable === false) throw new GitError("not_mergeable", "Pull Request is not mergeable");
    const mainSha = this.head(this.baseBranch);
    const base = view.baseSha;
    const headTree = this.treeOf(headSha);
    const changes = this.changedPaths(base, headSha).map((p) => ({ path: p, bytes: headTree.has(p) ? this.blobs.get(headTree.get(p)) : null }));
    const sha = this.commitOn(mainSha, changes, pr.title + " (#" + number + ")\n\n" + pr.body, pr.authorLogin);
    this.refs.set("refs/heads/" + this.baseBranch, sha);
    Object.assign(pr, { merged: true, state: "closed", mergeSha: sha, mergedAt: this.now(), mergedBy: mergedBy || this.botLogin, parentSha: mainSha, files: this.changedPaths(mainSha, sha), headShaAtClose: headSha, updatedAt: this.now() });
    return sha;
  }

  // History fixtures: a merged PR with arbitrary authorship (Studio, Decap or plain GitHub)
  seedMergedPr({ title, body, headRef, authorLogin, mergedByLogin, files, labels, mergedAt }) {
    const mainSha = this.head(this.baseBranch);
    const sha = this.commitOn(mainSha, files.map((f) => ({ path: f.path, bytes: f.text !== undefined ? enc.encode(f.text) : f.bytes })), title, authorLogin);
    this.refs.set("refs/heads/" + this.baseBranch, sha);
    const n = this.nextPr++;
    this.prs.set(n, { number: n, headRef: headRef || "feature/x", baseRef: this.baseBranch, title, body: body || "", draft: false, labels: new Set(labels || []), state: "closed", merged: true, authorLogin: authorLogin || "someone", createdAt: mergedAt || this.now(), updatedAt: mergedAt || this.now(), mergeSha: sha, mergedAt: mergedAt || this.now(), mergedBy: mergedByLogin || null, parentSha: mainSha, headShaAtClose: null, files: this.changedPaths(mainSha, sha) });
    return n;
  }

  mergedItem(pr) {
    return { number: pr.number, title: pr.title, body: pr.body, mergedAt: pr.mergedAt, mergeSha: pr.mergeSha, parentSha: pr.parentSha, authorLogin: pr.authorLogin, mergedByLogin: pr.mergedBy, headRef: pr.headRef, files: pr.files || [], labels: [...pr.labels].sort() };
  }
  mergedList() { return [...this.prs.values()].filter((p) => p.merged).sort((a, b) => (a.mergedAt < b.mergedAt ? 1 : a.mergedAt > b.mergedAt ? -1 : b.number - a.number)); }
}

// ---- the provider -----------------------------------------------------------------------------------------------
class MemoryGit {
  constructor(repo) { this.repo = repo; }
  getBaseBranch() { return this.repo.baseBranch; }
  async getHead(branch) { const s = this.repo.head(branch); return s ? { sha: s } : null; }
  async readFileBytes(ref, p) { const b = this.repo.fileAt(ref, p); return b ? new Uint8Array(b) : null; }
  async readTextFile(ref, p) { const b = this.repo.fileAt(ref, p); return b ? dec.decode(b) : null; }
  async hasFile(ref, p) { return !!this.repo.fileAt(ref, p); }
  async listDir(ref, dir) {
    const sha = this.repo.resolve(ref);
    if (!sha) return null;
    const pre = dir.replace(/\/+$/, "") + "/";
    const names = [];
    for (const p of this.repo.treeOf(sha).keys()) if (p.startsWith(pre) && p.indexOf("/", pre.length) < 0) names.push(p.slice(pre.length));
    return names.length ? names.sort() : null;
  }
  async changedFiles(a, b) {
    const sa = this.repo.resolve(a);
    const sb = this.repo.resolve(b);
    if (!sa || !sb) throw new GitError("not_found", "unknown commit");
    return this.repo.changedPaths(this.repo.mergeBase(sa, sb) || sa, sb);
  }
  prUrl(n) { return "https://github.com/" + this.repo.owner + "/" + this.repo.name + "/pull/" + n; }
  async createBranch(name, fromSha) {
    iface.guardBranchWrite(name);
    if (this.repo.head(name)) throw new GitError("exists", "branch already exists");
    if (!this.repo.commits.has(fromSha)) throw new GitError("not_found", "unknown commit");
    this.repo.refs.set("refs/heads/" + name, fromSha);
  }
  async commitFiles({ branch, expectedHeadSha, message, files }) {
    iface.guardBranchWrite(branch);
    iface.guardFiles(files);
    const head = this.repo.head(branch);
    if (!head) throw new GitError("not_found", "branch does not exist");
    if (head !== expectedHeadSha) throw new GitError("head_moved", "the branch moved", { headSha: head });
    const changes = files.map((f) => ({ path: f.path, bytes: f.bytes !== undefined ? f.bytes : enc.encode(f.text) }));
    const sha = this.repo.commitOn(head, changes, message, this.repo.botLogin);
    this.repo.refs.set("refs/heads/" + branch, sha);
    return { sha };
  }
  async resetBranch(branch, sha, expectedHeadSha) {
    iface.guardBranchWrite(branch);
    const head = this.repo.head(branch);
    if (!head || head !== expectedHeadSha) throw new GitError("head_moved", "the branch moved", { headSha: head });
    if (!this.repo.commits.has(sha)) throw new GitError("not_found", "unknown commit");
    this.repo.refs.set("refs/heads/" + branch, sha);
  }
  async openPr({ head, base, title, body, labels, draft }) {
    iface.guardPrCreate({ head, base }, this.repo.baseBranch);
    return this.repo.prView(this.repo.createPr({ head, base, title, body, labels, draft }));
  }
  async updatePr(n, patch) {
    const pr = this.repo.prs.get(n);
    if (!pr) throw new GitError("not_found", "no such pull request");
    if (patch.title !== undefined) pr.title = patch.title;
    if (patch.body !== undefined) pr.body = patch.body;
    if (patch.labels) { patch.labels.forEach((l) => { pr.labels.add(l); this.repo.labels.add(l); }); }
    pr.updatedAt = this.repo.now();
    return this.repo.prView(pr);
  }
  async getPr(n) { const pr = this.repo.prs.get(n); return pr ? this.repo.prView(pr) : null; }
  async listPrs({ headPrefix, state }) {
    const out = [];
    for (const pr of this.repo.prs.values()) {
      if (headPrefix && !pr.headRef.startsWith(headPrefix)) continue;
      if (state === "open" && pr.state !== "open") continue;
      out.push(this.repo.prView(pr));
    }
    return out.sort((a, b) => b.number - a.number);
  }
  async markReady(n) { const pr = this.repo.prs.get(n); if (!pr) throw new GitError("not_found", "no such pull request"); pr.draft = false; pr.updatedAt = this.repo.now(); }
  async closePr(n, comment) {
    const pr = this.repo.prs.get(n);
    if (!pr) throw new GitError("not_found", "no such pull request");
    if (!pr.headRef.startsWith("studio/")) throw new iface.ScopeError("only Studio drafts can be closed here", pr.headRef);
    pr.headShaAtClose = this.repo.head(pr.headRef) || pr.headShaAtClose;
    pr.state = "closed";
    pr.comments = (pr.comments || []).concat(comment || "");
    pr.updatedAt = this.repo.now();
  }
  async deleteBranch(name) { iface.guardBranchWrite(name); this.repo.refs.delete("refs/heads/" + name); }
  async merge(n, { method, sha }) {
    const pr = this.repo.prs.get(n);
    if (!pr) throw new GitError("not_found", "no such pull request");
    if (method !== "squash") throw new GitError("bad_request", "only squash merges");
    iface.guardBranchWrite(pr.headRef);
    if (!pr.labels.has("studio-draft")) throw new iface.ScopeError("only Studio drafts can be merged here", pr.headRef);
    if (pr.state !== "open" || pr.draft) throw new GitError("not_mergeable", "the pull request is not open and ready");
    return { sha: this.repo.squashMerge(n, sha, this.repo.botLogin) };
  }
  async listMerged({ limit, cursor }) {
    const all = this.repo.mergedList();
    const start = cursor ? Number(cursor) || 0 : 0;
    const n = Math.max(1, Math.min(100, limit || 20));
    const items = all.slice(start, start + n).map((p) => this.repo.mergedItem(p));
    return { items, next: start + n < all.length ? String(start + n) : null };
  }
  async getMergedPr(n) { const pr = this.repo.prs.get(n); return pr && pr.merged ? this.repo.mergedItem(pr) : null; }
  async findCommitByTrailer(branch, key, value) {
    let sha = this.repo.head(branch);
    for (let i = 0; i < 30 && sha; i += 1) {
      const c = this.repo.commits.get(sha);
      if (iface.trailerValue(c.message, key) === value) return { sha };
      sha = c.parents[0];
    }
    return null;
  }
}

// editable files of a checkout as Map<repoPath, Uint8Array> (src/_data, src/pages, images; files over 3 MB are skipped)
function filesFromWorkingTree(root) {
  const m = new Map();
  const add = (dir, filter) => {
    const abs = path.join(root, dir);
    if (!fs.existsSync(abs)) return;
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      if (!e.isFile() || !filter(e.name)) continue;
      const file = path.join(abs, e.name);
      if (fs.statSync(file).size > 3 * 1024 * 1024) continue;
      m.set(dir + "/" + e.name, new Uint8Array(fs.readFileSync(file)));
    }
  };
  add("src/_data", (n) => /\.json$/.test(n));
  add("src/pages", (n) => /\.md$/.test(n));
  add("images", () => true);
  add("videos", () => true);
  return m;
}

function createMemoryGit(opts) {
  const repo = new MemoryRepo(opts);
  if (opts && opts.root) repo.seed(filesFromWorkingTree(opts.root), "Seed from working tree");
  else if (opts && opts.files) repo.seed(opts.files, "Seed");
  return { repo, git: new MemoryGit(repo) };
}

module.exports = { MemoryRepo, MemoryGit, createMemoryGit, filesFromWorkingTree };
