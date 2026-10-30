"use strict";
// GitProvider over a REAL local git repository (a temp clone) driven with git plumbing through the git CLI. Pull requests
// live in a JSON file next to it. Used by `npm run studio:e2e` to build an actual draft branch and run `npm run check`
// on it: it proves that what the validator accepts passes the repository's own guards, and (through `checkRunner`) that a
// failing guard blocks publishing. Node only; the one module of the API that may use child_process (check-studio-api).

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const iface = require("./interface");

const { GitError, summarizeChecks } = iface;
const dec = new TextDecoder("utf-8");

function createLocalGit(opts) {
  const base = opts.baseBranch || "main";
  const dir = opts.dir || fs.mkdtempSync(path.join(os.tmpdir(), "studio-localgit-"));
  const repoDir = path.join(dir, "repo");
  const prFile = path.join(dir, "prs.json");
  const clock = opts.now || (() => new Date());
  const bot = opts.botLogin || "covered-studio[bot]";

  const git = (args, o) => {
    const r = spawnSync("git", ["-C", repoDir].concat(args), { input: o && o.input, env: Object.assign({}, process.env, { GIT_AUTHOR_NAME: "Studio", GIT_AUTHOR_EMAIL: "studio@example.invalid", GIT_COMMITTER_NAME: "Studio", GIT_COMMITTER_EMAIL: "studio@example.invalid", GIT_CONFIG_NOSYSTEM: "1" }, (o && o.env) || {}), maxBuffer: 256 * 1024 * 1024 });
    if (r.status !== 0 && !(o && o.allowFail)) throw new GitError("upstream", "git " + args[0] + " failed: " + String(r.stderr || "").slice(0, 200));
    return r;
  };
  const out = (args, o) => String(git(args, o).stdout).trim();

  if (!fs.existsSync(repoDir)) {
    fs.mkdirSync(dir, { recursive: true });
    const r = spawnSync("git", ["clone", "--quiet", "--no-hardlinks", "--branch", opts.sourceBranch || base, opts.source, repoDir], { encoding: "utf8" });
    if (r.status !== 0) throw new Error("git clone failed: " + String(r.stderr).slice(0, 200));
    git(["checkout", "--quiet", "-B", base]);
  }
  const load = () => (fs.existsSync(prFile) ? JSON.parse(fs.readFileSync(prFile, "utf8")) : { next: 1, prs: {}, labels: [] });
  const save = (s) => fs.writeFileSync(prFile, JSON.stringify(s));

  const head = (branch) => { const r = git(["rev-parse", "--verify", "--quiet", "refs/heads/" + branch], { allowFail: true }); return r.status === 0 ? String(r.stdout).trim() : null; };
  const resolve = (ref) => { if (/^[0-9a-f]{40}$/.test(ref)) return ref; return head(ref); };
  const blobAt = (ref, p) => { const r = git(["cat-file", "blob", ref + ":" + p], { allowFail: true }); return r.status === 0 ? new Uint8Array(r.stdout) : null; };
  const mergeBase = (a, b) => out(["merge-base", a, b]);
  const changed = (a, b) => out(["diff-tree", "-r", "--name-only", "--no-renames", a, b]).split("\n").filter(Boolean).sort();
  const entryAt = (ref, p) => { const l = out(["ls-tree", ref, "--", p]); const m = /^(\d+) blob ([0-9a-f]{40})\t/.exec(l); return m ? { mode: m[1], sha: m[2] } : null; };

  // a commit on top of `parent` with the given changes [{path, bytes|null}] (plumbing: temp index, no checkout)
  function commitOn(parent, changes, message) {
    const idx = path.join(dir, "index-" + crypto.randomBytes(6).toString("hex"));
    const env = { GIT_INDEX_FILE: idx };
    try {
      git(["read-tree", parent], { env });
      for (const c of changes) {
        if (c.bytes === null) git(["update-index", "--force-remove", "--", c.path], { env });
        else {
          const blob = String(git(["hash-object", "-w", "--stdin"], { input: Buffer.from(c.bytes) }).stdout).trim();
          git(["update-index", "--add", "--cacheinfo", "100644," + blob + "," + c.path], { env });
        }
      }
      const tree = String(git(["write-tree"], { env }).stdout).trim();
      return String(git(["commit-tree", tree, "-p", parent, "-m", message]).stdout).trim();
    } finally { try { fs.unlinkSync(idx); } catch (e) { /* ignore */ } }
  }

  const view = async (pr) => {
    const headSha = head(pr.headRef) || pr.headShaAtClose;
    const mainSha = head(base);
    const baseSha = pr.merged ? pr.parentSha : headSha ? mergeBase(headSha, mainSha) : null;
    let mergeable = null;
    if (!pr.merged && pr.state === "open" && headSha) {
      mergeable = true;
      for (const p of changed(baseSha, headSha)) {
        const m = entryAt(mainSha, p); const b = entryAt(baseSha, p); const h = entryAt(headSha, p);
        const sm = m && m.sha; if (sm !== (b && b.sha) && sm !== (h && h.sha)) mergeable = false;
      }
    }
    let runs = [];
    if (headSha && opts.checkRunner) {
      pr.checkCache = pr.checkCache || {};
      // like GitHub, a run that has not finished is asked again next time; only finished results are remembered
      if (!pr.checkCache[headSha] || pr.checkCache[headSha].some((r) => r.status !== "completed")) { pr.checkCache[headSha] = await opts.checkRunner(headSha, repoDir); const s = load(); s.prs[pr.number] = pr; save(s); }
      runs = pr.checkCache[headSha];
    }
    return { number: pr.number, url: "https://example.invalid/pull/" + pr.number, state: pr.state, draft: pr.draft, merged: pr.merged, headRef: pr.headRef, headSha, baseSha, behindBase: !pr.merged && !!baseSha && baseSha !== mainSha, mergeable, labels: pr.labels.slice().sort(), authorLogin: pr.authorLogin, title: pr.title, body: pr.body, checks: summarizeChecks(runs, []), mergeCommitSha: pr.mergeSha || null, createdAt: pr.createdAt, updatedAt: pr.updatedAt };
  };

  const item = (pr) => ({ number: pr.number, title: pr.title, body: pr.body, mergedAt: pr.mergedAt, mergeSha: pr.mergeSha, parentSha: pr.parentSha, authorLogin: pr.authorLogin, mergedByLogin: pr.mergedBy || null, headRef: pr.headRef, files: pr.files || [], labels: pr.labels.slice().sort() });
  const getRaw = (n) => load().prs[n] || null;

  return {
    dir, repoDir,
    getBaseBranch: () => base,
    prUrl: (n) => "https://example.invalid/pull/" + n,
    async getHead(b) { const s = head(b); return s ? { sha: s } : null; },
    async readFileBytes(ref, p) { const s = resolve(ref); return s ? blobAt(s, p) : null; },
    async readTextFile(ref, p) { const b = await this.readFileBytes(ref, p); return b ? dec.decode(b) : null; },
    async hasFile(ref, p) { const s = resolve(ref); return !!s && git(["cat-file", "-e", s + ":" + p], { allowFail: true }).status === 0; },
    async listDir(ref, d) {
      const s = resolve(ref);
      if (!s) return null;
      const r = git(["ls-tree", "--name-only", s, d.replace(/\/+$/, "") + "/"], { allowFail: true });
      const names = r.status === 0 ? String(r.stdout).split("\n").filter(Boolean).map((x) => x.split("/").pop()).sort() : [];
      return names.length ? names : null;
    },
    async changedFiles(a, b) { const sa = resolve(a); const sb = resolve(b); return changed(mergeBase(sa, sb), sb); },
    async createBranch(name, fromSha) {
      iface.guardBranchWrite(name);
      if (head(name)) throw new GitError("exists", "branch already exists");
      git(["update-ref", "refs/heads/" + name, fromSha, ""]);
    },
    async commitFiles({ branch, expectedHeadSha, message, files }) {
      iface.guardBranchWrite(branch);
      iface.guardFiles(files);
      const cur = head(branch);
      if (!cur) throw new GitError("not_found", "branch does not exist");
      if (cur !== expectedHeadSha) throw new GitError("head_moved", "the branch moved", { headSha: cur });
      const sha = commitOn(cur, files.map((f) => ({ path: f.path, bytes: f.bytes !== undefined ? f.bytes : new TextEncoder().encode(f.text) })), message);
      const r = git(["update-ref", "refs/heads/" + branch, sha, cur], { allowFail: true });
      if (r.status !== 0) throw new GitError("head_moved", "the branch moved", { headSha: head(branch) });
      return { sha };
    },
    async resetBranch(branch, sha, expectedHeadSha) {
      iface.guardBranchWrite(branch);
      const cur = head(branch);
      if (!cur || cur !== expectedHeadSha) throw new GitError("head_moved", "the branch moved", { headSha: cur });
      git(["update-ref", "refs/heads/" + branch, sha, cur]);
    },
    async openPr({ head: h, base: b, title, body, labels, draft }) {
      iface.guardPrCreate({ head: h, base: b }, base);
      const s = load();
      const n = s.next++;
      s.prs[n] = { number: n, headRef: h, baseRef: b, title, body: body || "", draft: !!draft, labels: (labels || []).slice(), state: "open", merged: false, authorLogin: bot, createdAt: clock().toISOString(), updatedAt: clock().toISOString() };
      save(s);
      return view(s.prs[n]);
    },
    async updatePr(n, patch) {
      const s = load();
      const pr = s.prs[n];
      if (!pr) throw new GitError("not_found", "no such pull request");
      if (patch.title !== undefined) pr.title = patch.title;
      if (patch.body !== undefined) pr.body = patch.body;
      for (const l of patch.labels || []) if (pr.labels.indexOf(l) < 0) pr.labels.push(l);
      pr.updatedAt = clock().toISOString();
      save(s);
      return view(pr);
    },
    async getPr(n) { const pr = getRaw(n); return pr ? view(pr) : null; },
    async listPrs({ headPrefix, state }) {
      const s = load();
      const res = [];
      for (const pr of Object.values(s.prs).sort((a, b) => b.number - a.number)) {
        if (headPrefix && !pr.headRef.startsWith(headPrefix)) continue;
        if (state === "open" && pr.state !== "open") continue;
        res.push(await view(pr));
      }
      return res;
    },
    async markReady(n) { const s = load(); if (!s.prs[n]) throw new GitError("not_found", "no such pull request"); s.prs[n].draft = false; save(s); },
    async closePr(n, comment) {
      const s = load();
      const pr = s.prs[n];
      if (!pr) throw new GitError("not_found", "no such pull request");
      iface.guardBranchWrite(pr.headRef);
      pr.headShaAtClose = head(pr.headRef) || pr.headShaAtClose;
      pr.state = "closed";
      pr.comments = (pr.comments || []).concat(comment || "");
      save(s);
    },
    async deleteBranch(name) { iface.guardBranchWrite(name); git(["update-ref", "-d", "refs/heads/" + name], { allowFail: true }); },
    async merge(n, { method, sha }) {
      const s = load();
      const pr = s.prs[n];
      if (!pr) throw new GitError("not_found", "no such pull request");
      if (method !== "squash") throw new GitError("bad_request", "only squash merges");
      iface.guardBranchWrite(pr.headRef);
      if (pr.labels.indexOf("studio-draft") < 0) throw new iface.ScopeError("only Studio drafts can be merged here", pr.headRef);
      if (pr.state !== "open" || pr.draft) throw new GitError("not_mergeable", "the pull request is not open and ready");
      const headSha = head(pr.headRef);
      if (sha && headSha !== sha) throw new GitError("sha_mismatch", "Head branch was modified. Review and try the merge again.");
      const v = await view(pr);
      if (v.mergeable === false) throw new GitError("not_mergeable", "Pull Request is not mergeable");
      const mainSha = head(base);
      const changes = changed(v.baseSha, headSha).map((p) => ({ path: p, bytes: blobAt(headSha, p) }));
      const merged = commitOn(mainSha, changes, pr.title + " (#" + n + ")\n\n" + pr.body);
      git(["update-ref", "refs/heads/" + base, merged, mainSha]);
      Object.assign(pr, { merged: true, state: "closed", mergeSha: merged, mergedAt: clock().toISOString(), mergedBy: bot, parentSha: mainSha, files: changed(mainSha, merged), headShaAtClose: headSha });
      save(s);
      return { sha: merged };
    },
    async listMerged({ limit, cursor }) {
      const all = Object.values(load().prs).filter((p) => p.merged).sort((a, b) => (a.mergedAt < b.mergedAt ? 1 : -1));
      const start = cursor ? Number(cursor) || 0 : 0;
      const nn = Math.max(1, Math.min(100, limit || 20));
      return { items: all.slice(start, start + nn).map(item), next: start + nn < all.length ? String(start + nn) : null };
    },
    async getMergedPr(n) { const pr = getRaw(n); return pr && pr.merged ? item(pr) : null; },
    async findCommitByTrailer(branch, key, value) {
      const cur = head(branch);
      if (!cur) return null;
      const log = out(["log", "-30", "--format=%H%x00%B%x01", cur]).split("\x01");
      for (const e of log) {
        const [sha, msg] = e.trim().split("\x00");
        if (sha && iface.trailerValue(msg, key) === value) return { sha };
      }
      return null;
    },
  };
}

module.exports = { createLocalGit };
