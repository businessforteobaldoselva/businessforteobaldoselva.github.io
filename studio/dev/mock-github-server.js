"use strict";
// A mock GitHub REST + GraphQL server on 127.0.0.1, backed by providers/git/mock-memory.js (MemoryRepo).
// It emulates exactly the endpoints providers/git/github.js calls: App-token exchange (the App JWT is verified with the
// public key it is given), the Git Data API, contents, pulls, issue labels/comments, compare, commits, check-runs,
// commit status, and GraphQL by operation name. Nothing leaves loopback. Node only; used by tests and `studio:dev`.

const http = require("http");
const crypto = require("crypto");
const { MemoryRepo } = require("./../api/providers/git/mock-memory");

const enc = new TextEncoder();
const dec = new TextDecoder();

function createMockGithub(opts) {
  const o = opts || {};
  const repo = o.repo;
  if (!(repo instanceof MemoryRepo)) throw new Error("pass a MemoryRepo");
  const appId = String(o.appId || "12345");
  const installationId = String(o.installationId || "67890");
  const clock = o.now || (() => new Date());
  const tokens = new Map(); // token -> expiresAt ms
  const requests = [];
  const state = { failNext: null, tokenTtlMs: o.tokenTtlMs || 3600 * 1000, tokensIssued: 0 };
  const R = "/repos/" + repo.owner + "/" + repo.name;

  function verifyAppJwt(h) {
    const m = /^Bearer ([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(h || "");
    if (!m) return false;
    const header = JSON.parse(Buffer.from(m[1], "base64url").toString());
    const claims = JSON.parse(Buffer.from(m[2], "base64url").toString());
    if (header.alg !== "RS256") return false;
    const ok = crypto.verify("RSA-SHA256", Buffer.from(m[1] + "." + m[2]), o.publicKey, Buffer.from(m[3], "base64url"));
    const t = Math.floor(clock().getTime() / 1000);
    return ok && String(claims.iss) === appId && claims.exp > t && claims.exp - claims.iat <= 660 && claims.iat <= t + 5;
  }

  const prJson = (pr) => {
    const v = repo.prView(pr, "https://github.com/" + repo.owner + "/" + repo.name);
    return { number: pr.number, node_id: "PR_" + pr.number, state: pr.state, draft: pr.draft, merged: pr.merged, merged_at: pr.mergedAt, title: pr.title, body: pr.body, html_url: v.url, head: { ref: pr.headRef, sha: v.headSha }, base: { ref: pr.baseRef, sha: v.baseSha }, user: { login: pr.authorLogin }, labels: [...pr.labels].map((name) => ({ name })), mergeable: v.mergeable, merge_commit_sha: pr.mergeSha, created_at: pr.createdAt, updated_at: pr.updatedAt };
  };

  const gqlNode = (pr) => {
    const m = pr.mergeSha ? repo.commits.get(pr.mergeSha) : null;
    return { number: pr.number, title: pr.title, body: pr.body, mergedAt: pr.mergedAt, merged: pr.merged, baseRefName: pr.baseRef, headRefName: pr.headRef, author: { login: pr.authorLogin }, mergedBy: pr.mergedBy ? { login: pr.mergedBy } : null, mergeCommit: m ? { oid: m.sha, parents: { nodes: m.parents.map((oid) => ({ oid })) } } : null, labels: { nodes: [...pr.labels].map((name) => ({ name })) }, files: { nodes: (pr.files || []).map((path) => ({ path })) } };
  };

  async function route(method, url, headers, bodyText) {
    const u = new URL(url, "http://x");
    const p = u.pathname;
    const q = u.searchParams;
    const body = bodyText ? JSON.parse(bodyText) : {};
    let m;

    if (method === "POST" && (m = /^\/app\/installations\/([^/]+)\/access_tokens$/.exec(p))) {
      if (!verifyAppJwt(headers.authorization) || m[1] !== installationId) return [401, { message: "Bad credentials" }];
      const token = "ghs_" + crypto.randomBytes(18).toString("hex");
      const exp = clock().getTime() + state.tokenTtlMs;
      tokens.set(token, exp);
      state.tokensIssued += 1;
      return [201, { token, expires_at: new Date(exp).toISOString(), permissions: body.permissions }];
    }

    const auth = /^Bearer (ghs_[0-9a-f]+)$/.exec(headers.authorization || "");
    if (!auth || !tokens.has(auth[1]) || tokens.get(auth[1]) <= clock().getTime()) return [401, { message: "Bad credentials" }];
    if (state.failNext) { const f = state.failNext; state.failNext = null; return [f, { message: "injected failure" }]; }

    if (method === "POST" && p === "/graphql") return graphql(body);
    if (!p.startsWith(R + "/")) return [404, { message: "Not Found" }];
    const rp = p.slice(R.length);

    if (method === "GET" && (m = /^\/git\/ref\/heads\/(.+)$/.exec(rp))) {
      const sha = repo.head(decodeURIComponent(m[1]));
      return sha ? [200, { ref: "refs/heads/" + decodeURIComponent(m[1]), object: { sha, type: "commit" } }] : [404, { message: "Not Found" }];
    }
    if (method === "POST" && rp === "/git/refs") {
      if (!/^refs\/heads\/.+/.test(body.ref) || repo.refs.has(body.ref)) return [422, { message: "Reference already exists" }];
      if (!repo.commits.has(body.sha)) return [422, { message: "Object does not exist" }];
      repo.refs.set(body.ref, body.sha);
      return [201, { ref: body.ref, object: { sha: body.sha } }];
    }
    if (method === "PATCH" && (m = /^\/git\/refs\/heads\/(.+)$/.exec(rp))) {
      const name = decodeURIComponent(m[1]);
      const cur = repo.head(name);
      if (!cur) return [404, { message: "Reference does not exist" }];
      if (!repo.commits.has(body.sha)) return [422, { message: "Object does not exist" }];
      if (!body.force && !repo.ancestors(body.sha).has(cur)) return [422, { message: "Update is not a fast forward" }];
      repo.refs.set("refs/heads/" + name, body.sha);
      return [200, { ref: "refs/heads/" + name, object: { sha: body.sha } }];
    }
    if (method === "DELETE" && (m = /^\/git\/refs\/heads\/(.+)$/.exec(rp))) {
      const name = decodeURIComponent(m[1]);
      if (!repo.refs.has("refs/heads/" + name)) return [422, { message: "Reference does not exist" }];
      repo.refs.delete("refs/heads/" + name);
      return [204, null];
    }
    if (method === "GET" && (m = /^\/git\/commits\/([0-9a-f]{40})$/.exec(rp))) {
      const c = repo.commits.get(m[1]);
      return c ? [200, { sha: c.sha, tree: { sha: c.tree }, parents: c.parents.map((sha) => ({ sha })), message: c.message }] : [404, { message: "Not Found" }];
    }
    if (method === "POST" && rp === "/git/blobs") {
      const bytes = body.encoding === "base64" ? new Uint8Array(Buffer.from(body.content, "base64")) : enc.encode(body.content);
      return [201, { sha: repo.putBlob(bytes) }];
    }
    if (method === "POST" && rp === "/git/trees") {
      const baseTree = repo.trees.get(body.base_tree);
      if (!baseTree) return [422, { message: "base_tree does not exist" }];
      const entries = new Map(baseTree);
      for (const t of body.tree) {
        if (!repo.blobs.has(t.sha)) return [422, { message: "blob does not exist" }];
        entries.set(t.path, t.sha);
      }
      return [201, { sha: repo.putTree(entries) }];
    }
    if (method === "POST" && rp === "/git/commits") {
      if (!repo.trees.has(body.tree)) return [422, { message: "tree does not exist" }];
      return [201, { sha: repo.putCommit({ tree: body.tree, parents: body.parents || [], message: body.message, author: repo.botLogin }) }];
    }
    if (method === "GET" && (m = /^\/contents\/(.+)$/.exec(rp))) {
      const path = m[1].split("/").map(decodeURIComponent).join("/");
      const ref = q.get("ref") || repo.baseBranch;
      const sha = repo.resolve(ref);
      if (!sha) return [404, { message: "No commit found for the ref" }];
      const tree = repo.treeOf(sha);
      if (tree.has(path)) {
        const bytes = repo.blobs.get(tree.get(path));
        if (/raw/.test(headers.accept || "")) return [200, bytes, "application/octet-stream"];
        return [200, { type: "file", name: path.split("/").pop(), path, sha: tree.get(path), size: bytes.length, encoding: "base64", content: Buffer.from(bytes).toString("base64") }];
      }
      const pre = path.replace(/\/+$/, "") + "/";
      const names = new Set();
      for (const k of tree.keys()) if (k.startsWith(pre)) names.add(k.slice(pre.length).split("/")[0]);
      if (names.size) return [200, [...names].sort().map((n) => ({ name: n, path: pre + n, type: tree.has(pre + n) ? "file" : "dir" }))];
      return [404, { message: "Not Found" }];
    }
    if (method === "GET" && (m = /^\/compare\/(.+?)\.\.\.(.+)$/.exec(rp))) {
      const a = repo.resolve(decodeURIComponent(m[1]));
      const b = repo.resolve(decodeURIComponent(m[2]));
      if (!a || !b) return [404, { message: "Not Found" }];
      const mb = repo.mergeBase(a, b);
      const inB = repo.ancestors(b);
      const behind = [...repo.ancestors(a)].filter((s) => !inB.has(s)).length;
      const files = repo.changedPaths(mb, b).map((filename) => ({ filename }));
      const page = Number(q.get("page") || 1);
      const per = Number(q.get("per_page") || 100);
      return [200, { merge_base_commit: { sha: mb }, behind_by: behind, ahead_by: 0, files: files.slice((page - 1) * per, page * per) }];
    }
    if (method === "GET" && rp === "/commits") {
      const out = [];
      let sha = repo.resolve(q.get("sha") || repo.baseBranch);
      for (let i = 0; i < Number(q.get("per_page") || 30) && sha; i += 1) { const c = repo.commits.get(sha); out.push({ sha, commit: { message: c.message } }); sha = c.parents[0]; }
      return [200, out];
    }
    if (method === "GET" && (m = /^\/commits\/([0-9a-f]{40})\/check-runs$/.exec(rp))) {
      const ck = repo.checksFor(m[1]);
      return [200, { total_count: ck.runs.length, check_runs: ck.runs }];
    }
    if (method === "GET" && (m = /^\/commits\/([0-9a-f]{40})\/status$/.exec(rp))) {
      const ck = repo.checksFor(m[1]);
      return [200, { state: ck.statuses.length ? "success" : "pending", statuses: ck.statuses }];
    }
    if (method === "POST" && rp === "/labels") {
      if (repo.labels.has(body.name)) return [422, { message: "Validation Failed", errors: [{ code: "already_exists" }] }];
      repo.labels.add(body.name);
      return [201, { name: body.name }];
    }
    if (method === "POST" && (m = /^\/issues\/(\d+)\/labels$/.exec(rp))) {
      const pr = repo.prs.get(Number(m[1]));
      if (!pr) return [404, { message: "Not Found" }];
      for (const l of body.labels) { if (!repo.labels.has(l)) return [422, { message: "label does not exist" }]; pr.labels.add(l); }
      return [200, [...pr.labels].map((name) => ({ name }))];
    }
    if (method === "POST" && (m = /^\/issues\/(\d+)\/comments$/.exec(rp))) {
      const pr = repo.prs.get(Number(m[1]));
      if (!pr) return [404, { message: "Not Found" }];
      pr.comments = (pr.comments || []).concat(body.body);
      return [201, { id: 1 }];
    }
    if (method === "GET" && rp === "/pulls") {
      const head = q.get("head");
      let list = [...repo.prs.values()].filter((pr) => q.get("state") === "open" ? pr.state === "open" : true);
      if (head) list = list.filter((pr) => repo.owner + ":" + pr.headRef === head);
      list.sort((a, b) => b.number - a.number);
      const page = Number(q.get("page") || 1);
      return [200, list.slice((page - 1) * 100, page * 100).map(prJson)];
    }
    if (method === "POST" && rp === "/pulls") {
      if (!repo.head(body.head)) return [422, { message: "head branch does not exist" }];
      return [201, prJson(repo.createPr({ head: body.head, base: body.base, title: body.title, body: body.body, draft: body.draft }))];
    }
    if ((m = /^\/pulls\/(\d+)$/.exec(rp))) {
      const pr = repo.prs.get(Number(m[1]));
      if (!pr) return [404, { message: "Not Found" }];
      if (method === "GET") return [200, prJson(pr)];
      if (method === "PATCH") {
        if (body.title !== undefined) pr.title = body.title;
        if (body.body !== undefined) pr.body = body.body;
        if (body.state === "closed") { pr.headShaAtClose = repo.head(pr.headRef) || pr.headShaAtClose; pr.state = "closed"; }
        pr.updatedAt = repo.now();
        return [200, prJson(pr)];
      }
    }
    if (method === "PUT" && (m = /^\/pulls\/(\d+)\/merge$/.exec(rp))) {
      const pr = repo.prs.get(Number(m[1]));
      if (!pr) return [404, { message: "Not Found" }];
      if (pr.draft || pr.state !== "open") return [405, { message: "Pull Request is not mergeable" }];
      if (body.sha && repo.head(pr.headRef) !== body.sha) return [409, { message: "Head branch was modified. Review and try the merge again." }];
      if (repo.prView(pr).mergeable === false) return [405, { message: "Pull Request is not mergeable" }];
      return [200, { merged: true, sha: repo.squashMerge(pr.number, body.sha, "covered-studio[bot]") }];
    }
    return [404, { message: "Not Found" }];
  }

  function graphql(body) {
    const v = body.variables || {};
    if (body.operationName === "StudioMarkReady") {
      const n = Number(String(v.id).replace("PR_", ""));
      const pr = repo.prs.get(n);
      if (!pr) return [200, { errors: [{ message: "not found" }] }];
      pr.draft = false;
      return [200, { data: { markPullRequestReadyForReview: { pullRequest: { number: n, isDraft: false } } } }];
    }
    if (body.operationName === "StudioMerged") {
      const all = repo.mergedList();
      const start = v.after ? Number(v.after) || 0 : 0;
      const page = all.slice(start, start + v.first);
      return [200, { data: { repository: { pullRequests: { pageInfo: { hasNextPage: start + v.first < all.length, endCursor: String(start + v.first) }, nodes: page.map(gqlNode) } } } }];
    }
    if (body.operationName === "StudioMergedOne") {
      const pr = repo.prs.get(Number(v.number));
      return [200, { data: { repository: { pullRequest: pr ? gqlNode(pr) : null } } }];
    }
    return [200, { errors: [{ message: "unknown operation" }] }];
  }

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const bodyText = Buffer.concat(chunks).toString("utf8");
      const headers = {};
      for (const k of Object.keys(req.headers)) headers[k] = req.headers[k];
      requests.push({ method: req.method, url: req.url, auth: headers.authorization ? headers.authorization.slice(0, 12) : null });
      try {
        const out = await route(req.method, req.url, headers, bodyText);
        const [status, payload, type] = out;
        if (payload === null) { res.writeHead(status); res.end(); return; }
        if (payload instanceof Uint8Array) { res.writeHead(status, { "Content-Type": type || "application/octet-stream" }); res.end(Buffer.from(payload)); return; }
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ message: "mock server error: " + e.message }));
      }
    });
  });

  return {
    state, requests, repo,
    listen: () => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve("http://127.0.0.1:" + server.address().port))),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

module.exports = { createMockGithub };
