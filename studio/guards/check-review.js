#!/usr/bin/env node
"use strict";
// check-review (Studio Phase 1, REVIEW unit; studio/PHASE1-DESIGN.md 5 to 7 and 15): the promises of the status board, the
// "what will change" screen and "Send for review".
//
//   node studio/guards/check-review.js [--root <repo>]
//
// Static (read the code):
//   1. the board and review services and routes never write to Git and never publish: no Git write method, no saveDraft /
//      publishDraft / submitDraft / merge; the overlay reaches publishing only through the ONE existing route, once, in ext/review.js;
//   2. STUDIO_REVIEWERS is parsed in api/review-config.js and nowhere else in the API;
//   3. the overlay files ext/status.js and ext/review.js put text on the page only as text (no innerHTML and friends, no eval, no
//      createElement, no network primitive, no URL to another host, h() tags and props from the allow-list, localStorage in try/catch).
// Behavioural (run the real thing on the in-memory API; nothing leaves this machine):
//   4. an editor's board never shows another person's draft title; an approver's does;
//   5. the review's blockers are the publish conditions: an unsent draft is blocked with draft_state and the publish route refuses
//      with the same reason; with no blocker the publish route accepts the head the review handed out;
//   6. EVERY patch operation kind (replace, add, remove, move) yields a non-empty plain-English line;
//   7. the approver list never carries a GitHub login or a user id; side by side stays off unless STUDIO_PREVIEW_EMBED=1;
//   8. a GitHub refusal or outage while asking for a review never fails the submit.
// Exit 0 clean, 1 violations.

const fs = require("fs");
const path = require("path");

const argv = process.argv.slice(2);
const ROOT = path.resolve(argv.indexOf("--root") >= 0 ? argv[argv.indexOf("--root") + 1] : path.join(__dirname, "..", ".."));
const acorn = require(path.join(ROOT, "node_modules", "acorn"));
const walk = require(path.join(ROOT, "node_modules", "acorn-walk"));

const problems = [];
const fail = (where, msg) => problems.push(where + ": " + msg);
const read = (rel) => { try { return fs.readFileSync(path.join(ROOT, rel), "utf8"); } catch (e) { return null; } };
const stripComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'\\])\/\/[^\n]*/g, "$1");

// ---- 1. read-only services and routes -----------------------------------------------------------------------------------
const READ_ONLY = ["studio/api/services/board.js", "studio/api/services/review.js", "studio/api/routes/board.js", "studio/api/routes/review.js"];
const GIT_WRITES = /\b(commitFiles|createBranch|resetBranch|openPr|updatePr|markReady|closePr|deleteBranch|merge|requestReviewers)\b\s*[:(]/;
const PUBLISHING = /\b(saveDraft|publishDraft|submitDraft|createFromOps|rebaseDraft|discardDraft)\b|\/publish\b/;
for (const rel of READ_ONLY) {
  const src = read(rel);
  if (src === null) { fail(rel, "missing"); continue; }
  const code = stripComments(src);
  let m = GIT_WRITES.exec(code);
  if (m) fail(rel, "calls a Git write method (" + m[1] + "): the board and the review screen only read");
  m = PUBLISHING.exec(code);
  if (m) fail(rel, "reaches a write or publish path (" + m[0] + "): publishing stays the existing POST /v1/drafts/:id/publish");
  if (/\bfetch\s*\(|require\(["'](?:node:)?(?:fs|child_process|http|https|net)["']\)|\bprocess\b|\bBuffer\b/.test(code)) fail(rel, "must stay portable: no fetch, node:* modules, process or Buffer");
}
{
  const svc = stripComments(read("studio/api/services/review.js") || "");
  if (!/drafts\.publishBlockers\(/.test(svc)) fail("studio/api/services/review.js", "must take its blockers from drafts.publishBlockers (the publish route's own conditions)");
  const dr = stripComments(read("studio/api/services/drafts.js") || "");
  if (!/function publishBlock\(deps, ctx, pr, ownerKey\) \{\s*const b = publishBlockers\(/.test(dr)) fail("studio/api/services/drafts.js", "publishDraft must decide through publishBlockers, the same function the review screen uses");
}

// ---- 2. the reviewer list is parsed in one place ------------------------------------------------------------------------
{
  const dir = path.join(ROOT, "studio", "api");
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (/\.js$/.test(e.name) && e.name !== "review-config.js" && /STUDIO_REVIEWERS/.test(stripComments(fs.readFileSync(p, "utf8")))) fail(path.relative(ROOT, p).split(path.sep).join("/"), "reads STUDIO_REVIEWERS: it is parsed only in api/review-config.js");
    }
  }
}

// ---- 3. the overlay files ----------------------------------------------------------------------------------------------
const TAGS = new Set(["div", "span", "p", "ul", "ol", "li", "h2", "h3", "h4", "button", "a", "strong", "em", "label", "input", "select", "textarea", "section", "header", "footer", "nav"]);
const PROPS = new Set("class id type value placeholder title role tabindex hidden disabled checked min max rows for name href target rel src alt width height open autocomplete spellcheck readonly maxlength on".split(" "));
const BANNED_MEMBERS = new Set(["innerHTML", "outerHTML", "insertAdjacentHTML", "srcdoc", "cookie", "createContextualFragment", "execCommand"]);
const NET = new Set(["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "sendBeacon", "importScripts", "Worker", "SharedWorker"]);
const HOSTS = /^(localhost|127\.0\.0\.1|\[::1\])$/;
const OVERLAY_FILES = ["studio/overlay/ext/status.js", "studio/overlay/ext/review.js"];

function checkOverlayFile(rel) {
  const src = read(rel);
  if (src === null) { fail(rel, "missing"); return; }
  let ast;
  try { ast = acorn.parse(src, { ecmaVersion: 2020, sourceType: "script", locations: true }); } catch (e) { fail(rel, "does not parse: " + e.message); return; }
  if (!/^\(function \(S\) \{\s*\n\s*"use strict";/.test(src)) fail(rel, 'must start with (function (S) { "use strict";');
  if (!/\}\)\(window\.__CoveredStudioBoot\);\s*$/.test(src)) fail(rel, "must end with })(window.__CoveredStudioBoot);");
  const at = (n) => rel + ":" + (n.loc ? n.loc.start.line : "?");
  walk.ancestor(ast, {
    MemberExpression(n, _s, anc) {
      const name = !n.computed && n.property.type === "Identifier" ? n.property.name : n.computed && n.property.type === "Literal" ? String(n.property.value) : "";
      if (BANNED_MEMBERS.has(name)) fail(at(n), "uses ." + name + " (server and editor text must only reach the page as text nodes)");
      if (name === "open" && n.object.type === "Identifier" && n.object.name === "window") fail(at(n), "uses window.open");
      if (name === "postMessage") fail(at(n), "uses postMessage");
      if (name === "localStorage" && !anc.some((a) => a.type === "TryStatement")) fail(at(n), "localStorage used outside try/catch");
    },
    Identifier(n, _s, anc) {
      if (n.name === "eval") fail(at(n), "uses eval");
      if (NET.has(n.name)) {
        const parent = anc[anc.length - 2];
        const prop = parent && parent.type === "MemberExpression" && parent.property === n && !parent.computed;
        const key = parent && parent.type === "Property" && parent.key === n && !parent.computed;
        if (!prop && !key) fail(at(n), "references " + n.name + ": all network access goes through studio.api");
      }
    },
    NewExpression(n) { if (n.callee.type === "Identifier" && n.callee.name === "Function") fail(at(n), "uses new Function"); },
    ImportExpression(n) { fail(at(n), "uses import()"); },
    CallExpression(n) {
      const c = n.callee;
      const cname = c.type === "Identifier" ? c.name : c.type === "MemberExpression" && !c.computed ? c.property.name : "";
      if (cname === "createElement" || cname === "createElementNS") fail(at(n), "uses " + cname + " (h() is the only element factory)");
      if ((cname === "setTimeout" || cname === "setInterval") && n.arguments[0] && (n.arguments[0].type === "Literal" || n.arguments[0].type === "TemplateLiteral")) fail(at(n), cname + " with a string");
      if (cname === "el" && c.type === "Identifier") {
        const tag = n.arguments[0];
        if (!tag || tag.type !== "Literal" || !TAGS.has(tag.value)) fail(at(n), "el() tag is not a literal from the allowed list: " + (tag && tag.value));
        const props = n.arguments[1];
        if (props && props.type === "ObjectExpression") {
          for (const p of props.properties) {
            if (p.type !== "Property" || p.computed) { fail(at(n), "el() props must be plain keys"); continue; }
            const k = p.key.type === "Identifier" ? p.key.name : String(p.key.value);
            if (!(PROPS.has(k) || /^aria-[a-z]+$/.test(k) || /^data-[a-z-]+$/.test(k))) fail(at(n), "el() prop not allowed by h(): " + k);
          }
        }
      }
    },
    AssignmentExpression(n) {
      const l = n.left;
      if (l.type === "MemberExpression" && !l.computed && /^on[a-z]+$/.test(l.property.name)) fail(at(n), "assigns the " + l.property.name + " handler property");
      if (l.type === "MemberExpression" && !l.computed && (l.property.name === "href" || l.property.name === "src") && l.object.type === "Identifier") fail(at(n), "assigns ." + l.property.name + " directly (use h() so safeHref applies)");
    },
    Literal(n) {
      if (typeof n.value !== "string") return;
      for (const m of n.value.matchAll(/(?:https?:)?\/\/([A-Za-z0-9.\-[\]:]+)/g)) if (!HOSTS.test(m[1].replace(/:\d+$/, ""))) fail(at(n), "URL literal to another host: " + m[0]);
    },
  });
}
for (const rel of OVERLAY_FILES) checkOverlayFile(rel);
{
  const rv = read("studio/overlay/ext/review.js") || "";
  const hits = rv.match(/\/publish"/g) || [];
  if (hits.length !== 1) fail("studio/overlay/ext/review.js", 'must call the existing publish route exactly once (found ' + hits.length + ")");
  if ((rv.match(/data-approve/g) || []).length !== 1) fail("studio/overlay/ext/review.js", "there must be exactly ONE Approve and publish button");
  if (!/"Approve and publish"/.test(rv)) fail("studio/overlay/ext/review.js", "the button must say \"Approve and publish\"");
  if (/\/publish\b/.test(read("studio/overlay/ext/status.js") || "")) fail("studio/overlay/ext/status.js", "the status board must not publish");
  if (!/aria-live/.test(rv) || !/\.focus\(\)/.test(rv)) fail("studio/overlay/ext/review.js", "the review screen must announce its summary (aria-live) and move focus");
}

// ---- 4 to 8. behaviour --------------------------------------------------------------------------------------------------
async function behaviour() {
  // the selftest's throwaway copy leaves scripts/ out; the in-memory API needs scripts/lib, so borrow it from the real checkout
  // (the copy's node_modules is a link to it). A normal run already has scripts/lib and never gets here.
  if (!fs.existsSync(path.join(ROOT, "scripts", "lib", "image-rules.js"))) {
    const real = path.dirname(fs.realpathSync(path.join(ROOT, "node_modules")));
    fs.cpSync(path.join(real, "scripts", "lib"), path.join(ROOT, "scripts", "lib"), { recursive: true });
  }
  const H = require(path.join(ROOT, "studio", "tests", "p1-review", "helpers.js"));
  const { describe } = require(path.join(ROOT, "studio", "validate", "describe.js"));
  const { GitError } = require(path.join(ROOT, "studio", "api", "providers", "git", "interface.js"));
  const OPS = [H.heroOp("Guard check")];
  const text = (r) => JSON.stringify(r.json);

  // 4. board visibility
  {
    const a = H.api();
    const mine = await H.draftBy(a, "editor", OPS, "Mollys draft");
    const theirs = await H.draftBy(a, "approver", [{ op: "replace", file: "src/_data/hero.json", path: "/badge", value: "Guard badge" }], "Secret title of someone else");
    await H.submit(a, "editor", mine);
    await H.submit(a, "approver", theirs);
    const e = await a.call("editor", "GET", "/v1/board");
    if (e.status !== 200 || text(e).includes("Secret title of someone else")) fail("GET /v1/board", "an editor must never see another person's draft title");
    else if (e.json.othersWaiting !== 1) fail("GET /v1/board", "an editor gets a COUNT of other people's waiting drafts (expected 1, got " + e.json.othersWaiting + ")");
    const p = await a.call("approver", "GET", "/v1/board");
    if (p.status !== 200 || !text(p).includes("Mollys draft")) fail("GET /v1/board", "an approver must see every waiting draft");
  }

  // 5. blockers are the publish conditions
  {
    const a = H.api();
    const d = await H.draftBy(a, "editor", OPS);
    const r = await a.call("approver", "GET", "/v1/drafts/" + d.id + "/review");
    const reason = r.json && r.json.gates && r.json.gates.blockers && r.json.gates.blockers[0] && r.json.gates.blockers[0].reason;
    const p = await H.publish(a, "approver", d);
    if (reason !== "draft_state" || !p.json.error || p.json.error.details.reason !== reason) fail("GET /v1/drafts/:id/review", "an unsent draft must be blocked with the reason the publish route gives (review: " + reason + ", publish: " + (p.json.error && p.json.error.details.reason) + ")");
    await H.submit(a, "editor", d);
    const r2 = await a.call("approver", "GET", "/v1/drafts/" + d.id + "/review");
    if (!r2.json.gates || r2.json.gates.blockers.length !== 0 || r2.json.gates.canPublish !== true) fail("GET /v1/drafts/:id/review", "a ready draft with green checks has no blockers");
    else if ((await H.publish(a, "approver", d, r2.json.headSha)).status !== 200) fail("POST /v1/drafts/:id/publish", "the head the review handed out must be publishable when there are no blockers");
  }

  // 6. every op kind yields a line
  {
    const schema = JSON.parse(read("studio/schema/studio-schema.json"));
    const doc = JSON.parse(read("src/_data/hero.json"));
    const before = new Map([["src/_data/hero.json", doc]]);
    const ops = [
      { op: "replace", file: "src/_data/hero.json", segs: ["headlineMain"], before: "a", after: "b" },
      { op: "add", file: "src/_data/hero.json", segs: ["badge"], after: "b" },
      { op: "remove", file: "src/_data/hero.json", segs: ["badge"], before: "a" },
      { op: "move", file: "src/_data/faq.json", segs: ["items"], from: 0, to: 1 },
    ];
    for (const op of ops) {
      let x = null;
      try { x = describe(op, { schema, before, after: before }); } catch (e) { fail("validate/describe.js", op.op + " throws: " + e.message); continue; }
      if (!x || typeof x.line !== "string" || x.line.length === 0 || x.line.length > 400) fail("validate/describe.js", "describe must return a plain-English line for a " + op.op + " operation");
      else if (/[<>]/.test(x.line)) fail("validate/describe.js", "the " + op.op + " line carries markup characters");
    }
  }

  // 7. approver list and side by side
  {
    const a = H.api({ env: { STUDIO_PREVIEW_EMBED: "0" } });
    const r = await a.call("editor", "GET", "/v1/people/approvers");
    if (/ameliagh|userId|@/.test(r.text)) fail("GET /v1/people/approvers", "the approver list must not carry a GitHub login, user id or address");
    if (!r.json || !r.json.approvers || r.json.approvers.length !== 2 || r.json.approvers[0].notify !== "github") fail("GET /v1/people/approvers", "expected the two configured approvers with how each is told");
    const d = await H.draftBy(a, "editor", OPS);
    const rv = await a.call("editor", "GET", "/v1/drafts/" + d.id + "/review");
    if (rv.json.sideBySide !== null) fail("GET /v1/drafts/:id/review", "side by side must stay off unless STUDIO_PREVIEW_EMBED=1");
    const b = H.api({ env: { STUDIO_PREVIEW_EMBED: "1" } });
    const d2 = await H.draftBy(b, "editor", OPS);
    if ((await b.call("editor", "GET", "/v1/drafts/" + d2.id + "/review")).json.sideBySide === null) fail("GET /v1/drafts/:id/review", "side by side must appear when STUDIO_PREVIEW_EMBED=1 and the addresses are set");
  }

  // 8. a GitHub refusal never fails the submit
  for (const [code, why] of [["conflict", "github_refused"], ["upstream", "github_unavailable"]]) {
    const a = H.api();
    a.deps.git = H.withReviewers(a.git, async () => { throw new GitError(code, "GitHub said no"); });
    const d = await H.draftBy(a, "editor", OPS);
    const r = await H.submit(a, "editor", d, "amelia");
    if (r.status !== 200 || !r.json.notified || r.json.notified.reason !== why || r.json.draft.state !== "ready") fail("POST /v1/drafts/:id/submit", "a GitHub " + code + " while asking for a review must still submit the draft (expected reason " + why + ", got status " + r.status + ")");
  }
}

behaviour().catch((e) => fail("behaviour", "could not run: " + (e && e.stack ? e.stack.split("\n").slice(0, 3).join(" | ") : e))).then(() => {
  if (problems.length) {
    console.error("check-review: FAILED\n  " + problems.join("\n  "));
    process.exit(1);
  }
  console.log("check-review: OK - read-only board and review, one publish route, one approve button, text-only overlay, blockers = publish conditions, every op has a line, approver list leaks nothing, notification failure never fails a submit");
});
