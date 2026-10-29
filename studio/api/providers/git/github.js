"use strict";
// GitProvider over the GitHub REST + GraphQL API, authenticated as a GitHub App installation (DESIGN 8.2).
// Written to the documented public API; the tests point it at studio/dev/mock-github-server.js. It has never been run
// against github.com by the people who wrote it: review the first live run on a throw-away repository.
//
//   auth    App JWT (RS256 via WebCrypto, 9 minute life, iss = app id)  ->  POST /app/installations/{id}/access_tokens
//           -> installation token, cached until 5 minutes before it expires. Neither the key nor a token is ever logged
//           or put in an error message.
//   writes  Git Data API (blobs -> tree with base_tree -> commit -> PATCH ref, force:false); PRs via REST;
//           ready-for-review via GraphQL; merged-PR history via GraphQL.
// Portable: fetch + WebCrypto only.

const iface = require("./interface");

const { GitError, summarizeChecks } = iface;
const API_VERSION = "2022-11-28";
const PERMISSIONS = { contents: "write", pull_requests: "write", issues: "write", checks: "read", statuses: "read", metadata: "read" };
const LABEL_COLORS = { "studio-draft": "0e8a16", "studio-ready": "fbca04", "studio-revert": "d93f0b" };
const enc = new TextEncoder();
const dec = new TextDecoder("utf-8");

const b64url = (bytes) => btoa(String.fromCharCode.apply(null, bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const encPath = (p) => String(p).split("/").map(encodeURIComponent).join("/");
function bytesToB64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// ---- private key handling ------------------------------------------------------------------------------------------
function derLen(n) {
  if (n < 128) return [n];
  const bytes = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 255);
  return [128 | bytes.length].concat(bytes);
}
function derWrap(tag, content) { return [tag].concat(derLen(content.length), Array.from(content)); }

// PKCS#1 ("BEGIN RSA PRIVATE KEY") -> PKCS#8, because WebCrypto imports PKCS#8 only
function pkcs1ToPkcs8(pkcs1) {
  const version = [0x02, 0x01, 0x00];
  const algId = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const octet = derWrap(0x04, pkcs1);
  return new Uint8Array(derWrap(0x30, version.concat(algId, octet)));
}

function pemToKeyBytes(pem) {
  const text = String(pem).replace(/\\n/g, "\n").trim();
  const m = /-----BEGIN ((?:RSA )?PRIVATE KEY)-----([\s\S]+?)-----END (?:RSA )?PRIVATE KEY-----/.exec(text);
  if (!m) throw new Error("GITHUB_APP_PRIVATE_KEY is not a PEM private key");
  const bin = atob(m[2].replace(/\s+/g, ""));
  const der = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) der[i] = bin.charCodeAt(i);
  return m[1] === "RSA PRIVATE KEY" ? pkcs1ToPkcs8(der) : der;
}

function createGithubGit(opts) {
  const { owner, repo, appId, installationId, privateKey, baseBranch, fetch: fetchFn, now } = opts;
  const apiBase = (opts.apiBase || "https://api.github.com").replace(/\/+$/, "");
  if (apiBase !== "https://api.github.com" && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(apiBase) && !opts.allowCustomApiBase) throw new Error("apiBase must be https://api.github.com (tests may use a localhost mock)");
  const clock = now || (() => new Date());
  const doFetch = fetchFn || ((...a) => fetch(...a));
  const base = baseBranch || "main";
  const R = "/repos/" + owner + "/" + repo;
  let cryptoKey = null;
  let tokenCache = null;
  let tokenPending = null;

  async function appJwt() {
    if (!cryptoKey) cryptoKey = await crypto.subtle.importKey("pkcs8", pemToKeyBytes(privateKey), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
    const t = Math.floor(clock().getTime() / 1000);
    const head = b64url(enc.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
    const body = b64url(enc.encode(JSON.stringify({ iat: t - 60, exp: t + 540, iss: String(appId) })));
    const sig = new Uint8Array(await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, cryptoKey, enc.encode(head + "." + body)));
    return head + "." + body + "." + b64url(sig);
  }

  async function installationToken() {
    const t = clock().getTime();
    if (tokenCache && tokenCache.expiresAt - t > 5 * 60 * 1000) return tokenCache.token;
    if (tokenPending) return tokenPending;
    tokenPending = (async () => {
      const res = await doFetch(apiBase + "/app/installations/" + encodeURIComponent(installationId) + "/access_tokens", {
        method: "POST",
        headers: { Authorization: "Bearer " + (await appJwt()), Accept: "application/vnd.github+json", "X-GitHub-Api-Version": API_VERSION, "User-Agent": "covered-studio", "Content-Type": "application/json" },
        body: JSON.stringify({ permissions: PERMISSIONS }),
      });
      if (res.status !== 201) throw new GitError("upstream", "GitHub refused the app login (HTTP " + res.status + ")");
      const j = await res.json();
      if (!j || typeof j.token !== "string") throw new GitError("upstream", "GitHub returned no installation token");
      tokenCache = { token: j.token, expiresAt: Date.parse(j.expires_at) || t + 50 * 60 * 1000 };
      return tokenCache.token;
    })();
    try { return await tokenPending; } finally { tokenPending = null; }
  }

  // -> { status, json?, bytes? }. GETs retry twice on 5xx; one retry with a fresh token on 401.
  async function call(method, path, o) {
    const opt = o || {};
    let attempts = method === "GET" ? 3 : 1;
    let refreshed = false;
    for (;;) {
      let res;
      try {
        res = await doFetch(apiBase + path, {
          method,
          headers: { Authorization: "Bearer " + (await installationToken()), Accept: opt.accept || "application/vnd.github+json", "X-GitHub-Api-Version": API_VERSION, "User-Agent": "covered-studio", "Content-Type": "application/json" },
          body: opt.body === undefined ? undefined : JSON.stringify(opt.body),
        });
      } catch (e) {
        if (e instanceof GitError) throw e;
        attempts -= 1;
        if (attempts > 0) continue;
        throw new GitError("upstream", "GitHub is unreachable");
      }
      if (res.status === 401 && !refreshed) { refreshed = true; tokenCache = null; continue; }
      if (res.status >= 500 && --attempts > 0) continue;
      if (opt.raw) {
        if (res.status === 404) return { status: 404 };
        if (!res.ok) throw new GitError("upstream", "GitHub HTTP " + res.status + " on " + method + " " + path.split("?")[0].slice(0, 80));
        return { status: res.status, bytes: new Uint8Array(await res.arrayBuffer()) };
      }
      let j = null;
      const txt = await res.text();
      if (txt) { try { j = JSON.parse(txt); } catch (e) { j = null; } }
      return { status: res.status, json: j };
    }
  }
  const fail = (r, what) => new GitError(r.status === 404 ? "not_found" : r.status === 409 || r.status === 422 ? "conflict" : "upstream", "GitHub HTTP " + r.status + " on " + what);
  const must = (r, what, ok) => { if (!(ok || [200, 201, 204]).includes(r.status)) throw fail(r, what); return r.json; };

  async function graphql(operationName, query, variables) {
    const r = await call("POST", "/graphql", { body: { operationName, query, variables } });
    if (r.status !== 200 || !r.json || r.json.errors) throw new GitError("upstream", "GitHub GraphQL " + operationName + " failed (HTTP " + r.status + ")");
    return r.json.data;
  }

  const ensured = new Set();
  async function ensureLabels(labels) {
    for (const l of labels || []) {
      if (ensured.has(l)) continue;
      const r = await call("POST", R + "/labels", { body: { name: l, color: LABEL_COLORS[l] || "ededed" } });
      if (r.status !== 201 && r.status !== 422) throw fail(r, "POST /labels"); // 422 = already exists
      ensured.add(l);
    }
  }

  async function checksFor(sha) {
    const runs = await call("GET", R + "/commits/" + sha + "/check-runs?per_page=100");
    const st = await call("GET", R + "/commits/" + sha + "/status");
    return summarizeChecks(((runs.json && runs.json.check_runs) || []).map((c) => ({ name: c.name, status: c.status, conclusion: c.conclusion })), ((st.json && st.json.statuses) || []).map((s) => ({ context: s.context, state: s.state })), iface.REQUIRED_CHECKS);
  }

  async function view(p) {
    const merged = !!p.merged || !!p.merged_at;
    let baseSha = null;
    let behind = false;
    if (!merged && p.state === "open") {
      const cmp = await call("GET", R + "/compare/" + encodeURIComponent(base) + "..." + p.head.sha);
      if (cmp.status === 200 && cmp.json) { baseSha = cmp.json.merge_base_commit ? cmp.json.merge_base_commit.sha : null; behind = (cmp.json.behind_by || 0) > 0; }
    }
    return {
      number: p.number, url: p.html_url, state: p.state === "open" ? "open" : "closed", draft: !!p.draft, merged, headRef: p.head.ref, headSha: p.head.sha, baseSha, behindBase: behind,
      mergeable: merged ? null : typeof p.mergeable === "boolean" ? p.mergeable : null, labels: (p.labels || []).map((l) => l.name).sort(), authorLogin: p.user ? p.user.login : "", title: p.title, body: p.body || "",
      checks: await checksFor(p.head.sha), mergeCommitSha: p.merge_commit_sha || null, createdAt: p.created_at, updatedAt: p.updated_at,
    };
  }

  const MERGED_FIELDS = "number title body mergedAt headRefName author { login } mergedBy { login } mergeCommit { oid parents(first: 1) { nodes { oid } } } labels(first: 20) { nodes { name } } files(first: 100) { nodes { path } }";
  const mergedItem = (n) => ({ number: n.number, title: n.title, body: n.body || "", mergedAt: n.mergedAt, mergeSha: n.mergeCommit ? n.mergeCommit.oid : null, parentSha: n.mergeCommit && n.mergeCommit.parents.nodes[0] ? n.mergeCommit.parents.nodes[0].oid : null, authorLogin: n.author ? n.author.login : "", mergedByLogin: n.mergedBy ? n.mergedBy.login : null, headRef: n.headRefName, files: n.files.nodes.map((f) => f.path), labels: n.labels.nodes.map((l) => l.name).sort() });

  return {
    getBaseBranch: () => base,
    prUrl: (n) => "https://github.com/" + owner + "/" + repo + "/pull/" + n,

    async getHead(branch) {
      const r = await call("GET", R + "/git/ref/heads/" + encPath(branch));
      if (r.status === 404) return null;
      return { sha: must(r, "GET ref").object.sha };
    },
    async readFileBytes(ref, p) {
      const r = await call("GET", R + "/contents/" + encPath(p) + "?ref=" + encodeURIComponent(ref), { accept: "application/vnd.github.raw+json", raw: true });
      return r.status === 404 ? null : r.bytes;
    },
    async readTextFile(ref, p) { const b = await this.readFileBytes(ref, p); return b ? dec.decode(b) : null; },
    async hasFile(ref, p) {
      const r = await call("GET", R + "/contents/" + encPath(p) + "?ref=" + encodeURIComponent(ref));
      if (r.status === 404) return false;
      return !!must(r, "GET contents") && !Array.isArray(r.json);
    },
    async listDir(ref, dir) {
      const r = await call("GET", R + "/contents/" + encPath(dir.replace(/\/+$/, "")) + "?ref=" + encodeURIComponent(ref));
      if (r.status === 404) return null;
      const j = must(r, "GET contents");
      return Array.isArray(j) ? j.map((x) => x.name).sort() : null;
    },
    async changedFiles(a, b) {
      const out = new Set();
      for (let page = 1; page <= 5; page += 1) {
        const r = await call("GET", R + "/compare/" + encodeURIComponent(a) + "..." + encodeURIComponent(b) + "?per_page=100&page=" + page);
        const j = must(r, "GET compare");
        for (const f of j.files || []) { out.add(f.filename); if (f.previous_filename) out.add(f.previous_filename); }
        if (!j.files || j.files.length < 100) break;
      }
      return [...out].sort();
    },

    async createBranch(name, fromSha) {
      iface.guardBranchWrite(name);
      const r = await call("POST", R + "/git/refs", { body: { ref: "refs/heads/" + name, sha: fromSha } });
      if (r.status === 422) throw new GitError("exists", "branch already exists");
      must(r, "POST ref");
    },
    async commitFiles({ branch, expectedHeadSha, message, files }) {
      iface.guardBranchWrite(branch);
      iface.guardFiles(files);
      const head = await this.getHead(branch);
      if (!head) throw new GitError("not_found", "branch does not exist");
      if (head.sha !== expectedHeadSha) throw new GitError("head_moved", "the branch moved", { headSha: head.sha });
      const commit = must(await call("GET", R + "/git/commits/" + head.sha), "GET commit");
      const tree = [];
      for (const f of files) {
        const blob = must(await call("POST", R + "/git/blobs", { body: f.bytes !== undefined ? { content: bytesToB64(f.bytes), encoding: "base64" } : { content: f.text, encoding: "utf-8" } }), "POST blob");
        tree.push({ path: f.path, mode: "100644", type: "blob", sha: blob.sha });
      }
      const newTree = must(await call("POST", R + "/git/trees", { body: { base_tree: commit.tree.sha, tree } }), "POST tree");
      const made = must(await call("POST", R + "/git/commits", { body: { message, tree: newTree.sha, parents: [head.sha] } }), "POST commit");
      const upd = await call("PATCH", R + "/git/refs/heads/" + encPath(branch), { body: { sha: made.sha, force: false } });
      if (upd.status === 422 || upd.status === 409) throw new GitError("head_moved", "the branch moved", { headSha: ((await this.getHead(branch)) || {}).sha });
      must(upd, "PATCH ref");
      return { sha: made.sha };
    },
    async resetBranch(branch, sha, expectedHeadSha) {
      iface.guardBranchWrite(branch);
      const head = await this.getHead(branch);
      if (!head || head.sha !== expectedHeadSha) throw new GitError("head_moved", "the branch moved", { headSha: head ? head.sha : null });
      must(await call("PATCH", R + "/git/refs/heads/" + encPath(branch), { body: { sha, force: true } }), "PATCH ref");
    },

    async openPr({ head, base: baseRef, title, body, labels, draft }) {
      iface.guardPrCreate({ head, base: baseRef }, base);
      const p = must(await call("POST", R + "/pulls", { body: { title, head, base: baseRef, body: body || "", draft: !!draft } }), "POST pulls");
      if (labels && labels.length) { await ensureLabels(labels); must(await call("POST", R + "/issues/" + p.number + "/labels", { body: { labels } }), "POST labels"); }
      return this.getPr(p.number);
    },
    async updatePr(n, patch) {
      const body = {};
      if (patch.title !== undefined) body.title = patch.title;
      if (patch.body !== undefined) body.body = patch.body;
      if (Object.keys(body).length) must(await call("PATCH", R + "/pulls/" + n, { body }), "PATCH pull");
      if (patch.labels && patch.labels.length) { await ensureLabels(patch.labels); must(await call("POST", R + "/issues/" + n + "/labels", { body: { labels: patch.labels } }), "POST labels"); }
      return this.getPr(n);
    },
    async getPr(n) {
      const r = await call("GET", R + "/pulls/" + n);
      if (r.status === 404) return null;
      return view(must(r, "GET pull"));
    },
    async listPrs({ headPrefix, state }) {
      const exact = headPrefix && /^studio\/[a-z0-9]+\/[a-z0-9-]+$/.test(headPrefix) ? "&head=" + encodeURIComponent(owner + ":" + headPrefix) : "";
      const out = [];
      for (let page = 1; page <= 3 && out.length < 50; page += 1) {
        const j = must(await call("GET", R + "/pulls?state=" + (state === "open" ? "open" : "all") + "&per_page=100&page=" + page + "&sort=created&direction=desc" + exact), "GET pulls");
        for (const p of j) if (!headPrefix || p.head.ref.startsWith(headPrefix)) out.push(p);
        if (j.length < 100) break;
      }
      const views = [];
      for (const p of out.slice(0, 50)) views.push(await view(p));
      return views;
    },
    async markReady(n) {
      const p = must(await call("GET", R + "/pulls/" + n), "GET pull");
      await graphql("StudioMarkReady", "mutation StudioMarkReady($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { number isDraft } } }", { id: p.node_id });
    },
    async closePr(n, comment) {
      const p = must(await call("GET", R + "/pulls/" + n), "GET pull");
      iface.guardBranchWrite(p.head.ref);
      if (comment) must(await call("POST", R + "/issues/" + n + "/comments", { body: { body: comment } }), "POST comment");
      must(await call("PATCH", R + "/pulls/" + n, { body: { state: "closed" } }), "PATCH pull");
    },
    async deleteBranch(name) {
      iface.guardBranchWrite(name);
      const r = await call("DELETE", R + "/git/refs/heads/" + encPath(name));
      if (r.status !== 204 && r.status !== 404 && r.status !== 422) throw fail(r, "DELETE ref");
    },
    async merge(n, { method, sha }) {
      if (method !== "squash") throw new GitError("bad_request", "only squash merges");
      const p = must(await call("GET", R + "/pulls/" + n), "GET pull");
      iface.guardBranchWrite(p.head.ref);
      if (!(p.labels || []).some((l) => l.name === "studio-draft")) throw new iface.ScopeError("only Studio drafts can be merged here", p.head.ref);
      const r = await call("PUT", R + "/pulls/" + n + "/merge", { body: { merge_method: "squash", sha, commit_title: p.title + " (#" + n + ")" } });
      if (r.status === 409) throw new GitError("sha_mismatch", "Head branch was modified. Review and try the merge again.");
      if (r.status === 405) throw new GitError("not_mergeable", "Pull Request is not mergeable");
      return { sha: must(r, "PUT merge").sha };
    },

    async listMerged({ limit, cursor }) {
      const d = await graphql("StudioMerged", "query StudioMerged($owner: String!, $name: String!, $base: String!, $first: Int!, $after: String) { repository(owner: $owner, name: $name) { pullRequests(states: MERGED, baseRefName: $base, first: $first, after: $after, orderBy: { field: UPDATED_AT, direction: DESC }) { pageInfo { hasNextPage endCursor } nodes { " + MERGED_FIELDS + " } } } }", { owner, name: repo, base, first: Math.max(1, Math.min(50, limit || 20)), after: cursor || null });
      const conn = d.repository.pullRequests;
      const items = conn.nodes.filter((n) => n.mergeCommit).map(mergedItem).sort((a, b) => (a.mergedAt < b.mergedAt ? 1 : -1));
      return { items, next: conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null };
    },
    async getMergedPr(n) {
      const d = await graphql("StudioMergedOne", "query StudioMergedOne($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { merged baseRefName " + MERGED_FIELDS + " } } }", { owner, name: repo, number: n });
      const p = d.repository.pullRequest;
      return p && p.merged && p.baseRefName === base && p.mergeCommit ? mergedItem(p) : null;
    },
    async findCommitByTrailer(branch, key, value) {
      const r = await call("GET", R + "/commits?sha=" + encodeURIComponent(branch) + "&per_page=30");
      if (r.status === 404) return null;
      for (const c of must(r, "GET commits")) if (iface.trailerValue(c.commit && c.commit.message, key) === value) return { sha: c.sha };
      return null;
    },
  };
}

module.exports = { createGithubGit, pemToKeyBytes, pkcs1ToPkcs8 };
