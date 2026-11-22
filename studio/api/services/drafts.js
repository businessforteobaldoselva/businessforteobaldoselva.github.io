"use strict";
// Draft lifecycle (DESIGN 7.4 / 7.5): create / update / list / get / submit / publish / rebase / discard, and
// createFromOps (used by History's Restore). Everything a draft writes goes through validatePatch first and lands on a
// studio/* branch behind a draft pull request; merging needs both CI workflows green and the head sha the approver saw.
// Portable: Web APIs only.
//
// `ctx` = { deps, user: { id, email, name }, role, token }

const { ApiError } = require("../errors");
const { validatePatch } = require("../../validate");
const { fileInfo } = require("../../validate/walk");
const { parseWithRanges } = require("../../validate/jsontext");
const { parsePage } = require("../../validate/pagefile");
const { diffOps } = require("../../validate/diff");
const { describeApplied } = require("../../validate/describe");
const P = require("../../validate/pointer");
const scope = require("../../validate/scope");
const ids = require("./ids");
const text = require("./pr-text");
const { GitError } = require("../providers/git/interface");

const ROLE_RANK = { editor: 1, approver: 2, admin: 3 };
const atLeast = (role, min) => (ROLE_RANK[role] || 0) >= ROLE_RANK[min];
const dec = new TextDecoder("utf-8");

function toB64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// ---- helpers --------------------------------------------------------------------------------------------------------
function validatorCtx(deps, ref, extra) {
  const git = deps.git;
  return Object.assign({
    schema: deps.schema,
    reservedIds: deps.reservedIds,
    now: deps.now,
    readText: (p) => git.readTextFile(ref, p),
    hasFile: (p) => git.hasFile(ref, p),
    readBytes: (p) => git.readFileBytes(ref, p),
    listDir: (d) => git.listDir(ref, d),
  }, extra || {});
}

async function permalinkMap(deps, ref) {
  const names = (await deps.git.listDir(ref, "src/pages")) || [];
  const m = new Map();
  for (const n of names) {
    if (!/\.md$/.test(n)) continue;
    const t = await deps.git.readTextFile(ref, "src/pages/" + n);
    try { const d = parsePage(t).doc; if (typeof d.permalink === "string") m.set("src/pages/" + n, d.permalink); } catch (e) { /* unreadable page: not part of the check */ }
  }
  return m;
}

function throwValidation(deps, ctx, r, action) {
  if (r.conflicts.length) {
    deps.audit.write({ requestId: ctx.requestId, actor: actorOf(ctx), action: "validation.failed", outcome: "conflict", files: r.conflicts.map((c) => c.file), problems: r.conflicts.map((c) => "conflict@" + c.path) });
    throw new ApiError("conflict", "Someone changed some of these settings since you started.", { items: r.conflicts });
  }
  if (r.problems.length) {
    deps.audit.write({ requestId: ctx.requestId, actor: actorOf(ctx), action: "validation.failed", outcome: "invalid", files: [...new Set(r.problems.map((p) => p.file))].slice(0, 20), problems: r.problems.slice(0, 20).map((p) => p.code + "@" + p.path) });
    throw new ApiError("validation_failed", "Some changes cannot be saved. Nothing was saved.", { problems: r.problems });
  }
}

const actorOf = (ctx) => ({ id: ctx.user.id, email: ctx.user.email, role: ctx.role });

function previewUrlFor(deps, number) {
  const tpl = deps.config && deps.config.previewUrlTemplate;
  return tpl ? tpl.replace("{pr}", String(number)) : null;
}

function stateOf(pr) {
  if (pr.merged) return "merged";
  if (pr.state !== "open") return "closed";
  return pr.draft ? "draft" : "ready";
}

// A Studio draft is a pull request from a studio/ branch of this repository that carries the studio-draft label. When GitHub
// refused to write labels (PHASE1-DESIGN 4.3) the strictly validated authorship marker, whose draft id must match the branch,
// stands in for the label. Anything else is not ours and is never listed, opened or published here.
function isStudioPr(pr) {
  if (pr.labels.indexOf("studio-draft") >= 0) return true;
  if (pr.fromFork || !/^studio\//.test(pr.headRef)) return false;
  const marker = text.parseMarker(pr.body);
  return !!marker && marker.draftId === ids.idFromBranch(pr.headRef);
}

// EVERY reason the caller cannot publish this draft right now, first the one publishBlock reports (DESIGN 7.2 not_ready reasons).
// The publish route and the approver's review screen both call this, so they cannot disagree.
function publishBlockers(deps, ctx, pr, ownerKey) {
  const out = [];
  const add = (reason) => out.push({ reason, message: NOT_READY_TEXT[reason] });
  if (!atLeast(ctx.role, "approver")) { add("role"); return out; }
  if (pr.state !== "open" || pr.draft || pr.merged || !/^studio\//.test(pr.headRef) || !isStudioPr(pr)) { add("draft_state"); return out; }
  if (!deps.config.allowSelfPublish && ownerKey && ownerKey === ctx.userKey) add("self_publish");
  if (pr.checks.state === "failure") add("checks_failed");
  else if (pr.checks.state !== "success") add("checks_pending");
  if (pr.mergeable !== true) add("not_mergeable");
  return out;
}

// null when the caller may publish this draft right now, else the first reason
function publishBlock(deps, ctx, pr, ownerKey) {
  const b = publishBlockers(deps, ctx, pr, ownerKey);
  return b.length ? (b[0].reason === "role" ? "forbidden" : b[0].reason) : null;
}

async function toDraft(ctx, pr) {
  const deps = ctx.deps;
  const marker = text.parseMarker(pr.body);
  const id = ids.idFromBranch(pr.headRef);
  const ownerKey = id ? id.split("--")[0] : null;
  return {
    id,
    number: pr.number,
    url: pr.url,
    previewUrl: previewUrlFor(deps, pr.number),
    title: String(pr.title || "").replace(/^Studio: /, "").replace(/ \([^()]*\)$/, ""),
    state: stateOf(pr),
    branch: pr.headRef,
    headSha: pr.headSha,
    baseSha: pr.baseSha,
    behindMain: !!pr.behindBase,
    mergeable: pr.mergeable,
    author: { id: marker ? marker.authorId : null, name: marker ? marker.authorName : text.oneLine(pr.authorLogin, 40) },
    createdAt: pr.createdAt || null,
    updatedAt: pr.updatedAt || null,
    checks: pr.checks,
    canPublish: publishBlock(deps, ctx, pr, ownerKey) === null,
    isMine: ownerKey === ctx.userKey,
  };
}

async function loadDraft(ctx, id, opts) {
  const o = opts || {};
  const parsed = ids.parseId(id);
  if (!parsed) throw new ApiError("not_found", "No such draft.");
  const prs = await ctx.deps.git.listPrs({ headPrefix: parsed.branch, state: "all" });
  const pr = prs.filter((p) => p.headRef === parsed.branch && isStudioPr(p)).sort((a, b) => b.number - a.number)[0];
  if (!pr) throw new ApiError("not_found", "No such draft.");
  const mine = parsed.userKey === ctx.userKey;
  if (!mine && !(o.allowApprover && atLeast(ctx.role, "approver"))) throw new ApiError("not_found", "No such draft."); // do not reveal other people's drafts
  return { parsed, pr, mine };
}

// the operations a draft makes relative to the main commit it was built from, with the parsed documents on both sides
async function appliedOf(deps, pr) {
  const git = deps.git;
  const out = { before: new Map(), after: new Map(), applied: [], pictures: [] };
  if (!pr.baseSha || !pr.headSha) return out;
  const paths = await git.changedFiles(pr.baseSha, pr.headSha);
  for (const p of paths.slice(0, 40)) {
    const kind = scope.classify(p);
    if (kind === "image") { out.pictures.push(p); continue; }
    if (kind !== "data" && kind !== "page") continue;
    const a = await git.readTextFile(pr.baseSha, p);
    const b = await git.readTextFile(pr.headSha, p);
    if (a === null || b === null) continue;
    try {
      const da = kind === "data" ? parseWithRanges(a).value : parsePage(a).doc;
      const db = kind === "data" ? parseWithRanges(b).value : parsePage(b).doc;
      out.before.set(p, da);
      out.after.set(p, db);
      for (const op of diffOps(p, da, db)) out.applied.push({ op: op.op, file: p, segs: P.parse(op.path), before: op.expect, after: op.value });
    } catch (e) { /* an unreadable file is reported by CI, not here */ }
  }
  return out;
}

// the changes a draft makes relative to the main commit it was built from, in plain English
async function changesOf(deps, pr) {
  const d = await appliedOf(deps, pr);
  const pics = d.pictures.map((p) => ({ file: p, path: "", op: "add", label: "Pictures", summary: "Added the picture " + p.replace(/^images\//, ""), kind: "image" }));
  return describeApplied(deps.schema, d.before, d.after, d.applied.slice(0, 200)).concat(pics);
}

function deriveTitle(patch) {
  if (typeof patch.title === "string" && patch.title.trim()) return text.plain(patch.title, 80);
  const files = [...new Set((patch.ops || []).map((o) => String(o.file).replace(/^src\/(_data|pages)\//, "").replace(/\.(json|md)$/, "")))];
  return files.length === 1 ? "Update " + files[0].slice(0, 30) : "Update site content";
}

// ---- save (create / update) --------------------------------------------------------------------------------------------
async function saveDraft(ctx, patch, opts) {
  const o = opts || {};
  const deps = ctx.deps;
  const git = deps.git;
  const base = git.getBaseBranch();
  const mainHead = (await git.getHead(base)).sha;
  const key = String(patch && patch.idempotencyKey);
  const hasId = patch && patch.draftId !== undefined;
  const found = async (branch) => (await git.findCommitByTrailer(branch, "Studio-Idempotency", key));

  let branch;
  let slug;
  let headSha = null;
  if (hasId) {
    const parsed = ids.parseId(patch.draftId);
    if (!parsed) throw new ApiError("bad_request", "draftId is not valid.");
    if (parsed.userKey !== ctx.userKey) throw new ApiError("not_found", "No such draft.");
    branch = parsed.branch;
    const head = await git.getHead(branch);
    if (!head) throw new ApiError("not_found", "No such draft.");
    headSha = head.sha;
    if (await found(branch)) return replay(ctx, parsed.branch);
    if (!/^[0-9a-f]{40}$/.test(String(patch.expectedHeadSha))) throw new ApiError("bad_request", "expectedHeadSha is required when updating a draft.");
    if (patch.expectedHeadSha !== headSha) throw new ApiError("draft_moved", "The draft changed since you last looked.", { headSha });
  } else {
    if (!/^[0-9a-f]{40}$/.test(String(patch && patch.baseSha))) throw new ApiError("bad_request", "baseSha is required when creating a draft.");
    slug = ids.slugify(deriveTitle(patch));
    const candidates = [ids.branchOf(ctx.userKey, slug), ids.branchOf(ctx.userKey, slug + "-" + (await ids.keySuffix(key)))];
    for (const c of candidates) if ((await git.getHead(c)) && (await found(c))) return replay(ctx, c);
  }

  const ref = hasId ? headSha : mainHead;

  // main moved since the page the editor looked at was built: only a problem when it touched what the patch touches
  if (!hasId && patch.baseSha !== mainHead) await assertBaseNotMoved(deps, patch, mainHead);

  const extra = { limits: undefined };
  if ((patch.ops || []).some((op) => /^src\/pages\//.test(String(op.file)) && /\/permalink$/.test(String(op.path)))) extra.pagePermalinks = await permalinkMap(deps, ref);
  const r = await validatePatch(validatorCtx(deps, ref, extra), patch, { maxImageBytes: deps.config.maxImageBytes });
  throwValidation(deps, ctx, r, "save");
  if (r.noop) return { noop: true, replayed: false, changes: [], warnings: r.warnings, draft: hasId ? (await toDraft(ctx, (await loadDraft(ctx, patch.draftId)).pr)) : null };

  const title = deriveTitle(patch);
  const message = text.commitMessage(title, r.changes, ctx.user.id, key);
  const files = [...r.files].map(([path, f]) => ({ path, text: f.after })).concat(r.uploads.map((u) => ({ path: u.path, bytes: u.bytes })));

  let pr;
  if (hasId) {
    try { await git.commitFiles({ branch, expectedHeadSha: headSha, message, files }); } catch (e) { throw mapGit(e); }
    pr = await refreshPr(ctx, branch, title, o);
  } else {
    branch = await freeBranch(ctx, slug, key);
    try {
      await git.createBranch(branch, mainHead);
      await git.commitFiles({ branch, expectedHeadSha: mainHead, message, files });
      const draftId = ids.idFromBranch(branch);
      const open = await git.openPr({ head: branch, base, title: text.prTitle(title, ctx.user.name), body: text.prBody({ authorName: ctx.user.name, authorId: ctx.user.id, draftId, changes: r.changes, previewUrl: null, opsCount: patch.ops.length, revertOf: o.revertOf, ai: o.ai }), labels: ["studio-draft"].concat(o.labels || []), draft: true });
      pr = open;
      if (deps.config.previewUrlTemplate) pr = await git.updatePr(open.number, { body: text.prBody({ authorName: ctx.user.name, authorId: ctx.user.id, draftId, changes: r.changes, previewUrl: previewUrlFor(deps, open.number), opsCount: patch.ops.length, revertOf: o.revertOf, ai: o.ai }) });
    } catch (e) {
      try { await git.deleteBranch(branch); } catch (e2) { /* best effort cleanup of a half-made draft */ }
      throw mapGit(e);
    }
  }
  const draft = await toDraft(ctx, pr);
  deps.audit.write({ requestId: ctx.requestId, actor: actorOf(ctx), action: hasId ? "draft.update" : "draft.create", target: { draftId: draft.id, pr: pr.number, branch, sha: pr.headSha }, outcome: "ok", ops: patch.ops.length, files: [...r.files.keys()].concat(r.uploads.map((u) => u.path)) });
  return { draft, changes: await changesOf(deps, pr), replayed: false, warnings: r.warnings };
}

async function refreshPr(ctx, branch, title, opts) {
  const o = opts || {};
  const deps = ctx.deps;
  const list = await deps.git.listPrs({ headPrefix: branch, state: "open" });
  const pr = list.find((p) => p.headRef === branch);
  if (!pr) throw new ApiError("not_found", "No such draft.");
  const changes = await changesOf(deps, pr);
  const marker = text.parseMarker(pr.body);
  const body = text.prBody({ authorName: ctx.user.name, authorId: ctx.user.id, draftId: ids.idFromBranch(branch), changes, previewUrl: previewUrlFor(deps, pr.number), opsCount: (marker ? marker.ops : 0) + 1, revertOf: marker ? marker.revertOf : null, ai: o.ai, aiCarry: o.ai ? null : text.carryAi(pr.body) });
  return deps.git.updatePr(pr.number, o.ai ? { body, labels: o.labels || [] } : { body });
}

async function replay(ctx, branch) {
  const deps = ctx.deps;
  const list = await deps.git.listPrs({ headPrefix: branch, state: "all" });
  const pr = list.filter((p) => p.headRef === branch).sort((a, b) => b.number - a.number)[0];
  if (!pr) throw new ApiError("not_found", "No such draft.");
  return { draft: await toDraft(ctx, pr), changes: await changesOf(deps, pr), replayed: true, warnings: [] };
}

async function freeBranch(ctx, slug, key) {
  const git = ctx.deps.git;
  const a = ids.branchOf(ctx.userKey, slug);
  if (!(await git.getHead(a))) return a;
  const b = ids.branchOf(ctx.userKey, slug + "-" + (await ids.keySuffix(key)));
  if (!(await git.getHead(b))) return b;
  return ids.branchOf(ctx.userKey, slug + "-" + ctx.deps.randomUUID().replace(/-/g, "").slice(0, 4));
}

function mapGit(e) {
  if (e instanceof ApiError) return e;
  if (e instanceof GitError) {
    if (e.code === "head_moved") return new ApiError("draft_moved", "The draft changed since you last looked.", { headSha: e.details.headSha });
    if (e.code === "not_found") return new ApiError("not_found", "Not found.");
    return new ApiError("upstream_error", "The code host refused the request.");
  }
  if (e && e.name === "ScopeError") return new ApiError("forbidden", "That change is outside what Studio may edit.");
  return e;
}

// 409 base_moved: main moved AND changed a setting this patch also touches
async function assertBaseNotMoved(deps, patch, mainHead) {
  const git = deps.git;
  const files = [...new Set(patch.ops.map((o) => o.file))].filter((f) => typeof f === "string" && scope.classify(f));
  const changed = new Set(await git.changedFiles(patch.baseSha, mainHead).catch(() => []));
  const pointers = [];
  for (const f of files) {
    if (!changed.has(f)) continue;
    const a = await git.readTextFile(patch.baseSha, f);
    const b = await git.readTextFile(mainHead, f);
    if (a === null || b === null) continue;
    let da, db;
    try { da = /\.json$/.test(f) ? parseWithRanges(a).value : parsePage(a).doc; db = /\.json$/.test(f) ? parseWithRanges(b).value : parsePage(b).doc; } catch (e) { continue; }
    for (const d of diffOps(f, da, db)) {
      for (const op of patch.ops) {
        if (op.file !== f) continue;
        for (const q of [op.path, op.from]) {
          if (typeof q !== "string") continue;
          if (q === d.path || q.startsWith(d.path + "/") || d.path.startsWith(q + "/")) pointers.push({ file: f, path: d.path });
        }
      }
    }
  }
  if (pointers.length) throw new ApiError("base_moved", "The live site changed some of these settings since you started.", { headSha: mainHead, pointers: pointers.slice(0, 50) });
}

// ---- reads -------------------------------------------------------------------------------------------------------------
async function listDrafts(ctx, { scope: sc, state }) {
  const all = sc === "all";
  if (all && !atLeast(ctx.role, "approver")) throw new ApiError("forbidden", "Only approvers can see everyone's drafts.");
  const prs = await ctx.deps.git.listPrs({ headPrefix: "studio/", state: state === "all" ? "all" : "open" });
  const out = [];
  for (const pr of prs) {
    if (!isStudioPr(pr)) continue;
    const id = ids.idFromBranch(pr.headRef);
    if (!id) continue;
    if (!all && id.split("--")[0] !== ctx.userKey) continue;
    out.push(await toDraft(ctx, pr));
    if (out.length >= 50) break;
  }
  return { drafts: out };
}

async function getDraft(ctx, id) {
  const { pr } = await loadDraft(ctx, id, { allowApprover: true });
  return { draft: await toDraft(ctx, pr), changes: await changesOf(ctx.deps, pr) };
}

// ---- transitions --------------------------------------------------------------------------------------------------------
const REVIEWER_RE = /^[a-z0-9-]{1,30}$/;

// the address an approver opens to see a draft: <base>/?studio=1#review=<id>, or null when no https (or localhost) base is known
function reviewLinkFor(deps, draft) {
  const base = (deps.config.review && deps.config.review.reviewBaseUrl) || draft.previewUrl || deps.config.appUrl || "";
  let u;
  try { u = new URL(base); } catch (e) { return null; }
  if (u.username || u.password || !(u.protocol === "https:" || (u.protocol === "http:" && /^(localhost|127\.0\.0\.1)$/.test(u.hostname)))) return null;
  return u.origin + u.pathname.replace(/\/*$/, "/") + "?studio=1#review=" + draft.id;
}

function notifyMessage(n, name, already) {
  if (already) return "This draft was already sent for review. Copy the link and send it to the approver if they have not seen it.";
  if (n.via === "github") return "Sent for review. " + name + " has been notified on GitHub.";
  if (n.reason === "no_github_login") return "Sent for review. " + name + " is not set up for GitHub notifications, so copy the link and send it to them.";
  if (n.reason === "github_refused") return "Sent for review. GitHub would not notify " + name + ", so copy the link and send it to them.";
  if (n.reason === "github_unavailable") return "Sent for review. GitHub could not be reached to notify " + name + ", so copy the link and send it to them.";
  return "Sent for review. Copy the link and send it to an approver.";
}

// Mark the draft ready and, when an approver with a GitHub login was chosen, ask GitHub to request their review. A failure to
// notify NEVER fails the submit: the dialog falls back to "copy the link". A repeated submit does not notify again.
async function submitDraft(ctx, id, opts) {
  const o = opts || {};
  const deps = ctx.deps;
  const cfg = deps.config.review || { reviewers: [] };
  let reviewer = null;
  if (o.reviewerId !== undefined && o.reviewerId !== null) {
    reviewer = typeof o.reviewerId === "string" && REVIEWER_RE.test(o.reviewerId) ? cfg.reviewers.find((r) => r.id === o.reviewerId) || null : null;
    if (!reviewer) throw new ApiError("bad_request", "That person is not on the list of approvers.");
    if (reviewer.userId && reviewer.userId === String(ctx.user.id).toLowerCase()) throw new ApiError("bad_request", "Choose someone else: you cannot review your own changes.");
  }
  const cache = deps.submitCache || (deps.submitCache = new Map());
  const cacheKey = o.idempotencyKey ? ctx.userKey + ":" + id + ":" + o.idempotencyKey : null;
  if (cacheKey && cache.has(cacheKey)) return cache.get(cacheKey);

  const { pr, mine } = await loadDraft(ctx, id);
  if (!mine) throw new ApiError("not_found", "No such draft.");
  if (pr.merged || pr.state !== "open") throw new ApiError("not_ready", "This draft is already closed.", { reason: "draft_state" });
  const already = !pr.draft && pr.labels.indexOf("studio-ready") >= 0;
  if (pr.draft) await deps.git.markReady(pr.number);
  const labeled = await deps.git.updatePr(pr.number, { labels: ["studio-ready"] });
  const who = reviewer ? { displayName: reviewer.name } : null;
  let notified;
  if (already) notified = { via: "none", reviewer: who, reason: reviewer ? "github_unavailable" : "no_reviewer_chosen" };
  else if (!reviewer) notified = { via: "none", reviewer: null, reason: "no_reviewer_chosen" };
  else if (!reviewer.github) notified = { via: "none", reviewer: who, reason: "no_github_login" };
  else {
    try {
      if (typeof deps.git.requestReviewers !== "function") throw new GitError("upstream", "not supported");
      await deps.git.requestReviewers(pr.number, [reviewer.github]);
      notified = { via: "github", reviewer: who, reason: null };
    } catch (e) {
      notified = { via: "none", reviewer: who, reason: e instanceof GitError && ["conflict", "not_found", "bad_request"].indexOf(e.code) >= 0 ? "github_refused" : "github_unavailable" };
    }
  }
  deps.audit.write({ requestId: ctx.requestId, actor: actorOf(ctx), action: "draft.submit", target: { draftId: id, pr: pr.number, branch: pr.headRef, sha: pr.headSha }, outcome: already ? "replayed" : notified.via === "github" ? "ok" : "ok_not_notified", reviewer: reviewer ? reviewer.id : null });
  const draft = await toDraft(ctx, (await deps.git.getPr(pr.number)) || labeled);
  const out = { draft, reviewLink: reviewLinkFor(deps, draft), notified, message: notifyMessage(notified, reviewer ? reviewer.name : "", already) };
  if (cacheKey) { cache.set(cacheKey, out); if (cache.size > 200) cache.delete(cache.keys().next().value); }
  return out;
}

async function publishDraft(ctx, id, { expectedHeadSha }) {
  if (!atLeast(ctx.role, "approver")) throw new ApiError("forbidden", "Only approvers can publish.");
  const { parsed, pr } = await loadDraft(ctx, id, { allowApprover: true });
  const fresh = await ctx.deps.git.getPr(pr.number); // re-read: never trust a list snapshot
  if (!/^[0-9a-f]{40}$/.test(String(expectedHeadSha))) throw new ApiError("bad_request", "expectedHeadSha is required.");
  if (fresh.headSha !== expectedHeadSha) throw new ApiError("not_ready", "The draft changed after you looked at it.", { reason: "head_changed", headSha: fresh.headSha });
  const reason = publishBlock(ctx.deps, ctx, fresh, parsed.userKey);
  if (reason) {
    ctx.deps.audit.write({ requestId: ctx.requestId, actor: actorOf(ctx), action: "draft.publish", target: { draftId: id, pr: pr.number, branch: pr.headRef, sha: fresh.headSha }, outcome: "denied", problems: [reason] });
    throw new ApiError("not_ready", NOT_READY_TEXT[reason] || "This draft cannot be published yet.", { reason });
  }
  try { await ctx.deps.git.merge(pr.number, { method: "squash", sha: expectedHeadSha }); } catch (e) {
    if (e instanceof GitError && (e.code === "sha_mismatch")) throw new ApiError("not_ready", "The draft changed after you looked at it.", { reason: "head_changed" });
    if (e instanceof GitError && e.code === "not_mergeable") throw new ApiError("not_ready", NOT_READY_TEXT.not_mergeable, { reason: "not_mergeable" });
    throw mapGit(e);
  }
  ctx.deps.audit.write({ requestId: ctx.requestId, actor: actorOf(ctx), action: "draft.publish", target: { draftId: id, pr: pr.number, branch: pr.headRef, sha: expectedHeadSha }, outcome: "ok" });
  return { draft: await toDraft(ctx, await ctx.deps.git.getPr(pr.number)) };
}

const NOT_READY_TEXT = {
  role: "Only approvers can publish.",
  checks_pending: "The website checks have not finished yet. Try again in a minute.",
  checks_failed: "The website checks failed, so this cannot go live.",
  not_mergeable: "The live site changed in a way that clashes with this draft. Update the draft first.",
  draft_state: "This draft is not ready: send it for review first.",
  self_publish: "Someone else has to publish your changes.",
  head_changed: "The draft changed after you looked at it.",
};

async function discardDraft(ctx, id) {
  const { pr, mine } = await loadDraft(ctx, id, { allowApprover: true });
  if (!mine && ctx.role !== "admin") throw new ApiError("forbidden", "Only the author or an admin can discard a draft.");
  if (pr.merged) throw new ApiError("not_ready", "This draft is already published.", { reason: "draft_state" });
  try {
    await ctx.deps.git.closePr(pr.number, "Discarded in Studio by " + text.oneLine(ctx.user.name, 40) + ".");
    await ctx.deps.git.deleteBranch(pr.headRef);
  } catch (e) { throw mapGit(e); }
  ctx.deps.audit.write({ requestId: ctx.requestId, actor: actorOf(ctx), action: "draft.discard", target: { draftId: id, pr: pr.number, branch: pr.headRef, sha: pr.headSha }, outcome: "ok" });
  return { ok: true };
}

// Re-apply this draft's own changes (its diff against the main it was built from) onto the CURRENT main. Any setting
// main changed meanwhile conflicts (409, branch untouched). Only this studio/ branch is force-updated.
async function rebaseDraft(ctx, id, { expectedHeadSha, idempotencyKey }) {
  const deps = ctx.deps;
  const git = deps.git;
  const { parsed, pr, mine } = await loadDraft(ctx, id);
  if (!mine) throw new ApiError("not_found", "No such draft.");
  if (pr.state !== "open") throw new ApiError("not_ready", "This draft is closed.", { reason: "draft_state" });
  if (!/^[0-9a-f]{40}$/.test(String(expectedHeadSha))) throw new ApiError("bad_request", "expectedHeadSha is required.");
  if (pr.headSha !== expectedHeadSha) throw new ApiError("draft_moved", "The draft changed since you last looked.", { headSha: pr.headSha });
  const mainHead = (await git.getHead(git.getBaseBranch())).sha;
  if (pr.baseSha === mainHead) return { draft: await toDraft(ctx, pr), changes: await changesOf(deps, pr), warnings: [] };

  const paths = await git.changedFiles(pr.baseSha, pr.headSha);
  const ops = [];
  const uploads = [];
  for (const p of paths) {
    const kind = scope.classify(p);
    if (kind === "image") {
      const bytes = await git.readFileBytes(pr.headSha, p);
      if (bytes) uploads.push({ id: "r" + uploads.length, name: p.replace(/^images\//, ""), contentType: mimeOf(p), size: bytes.length, dataBase64: toB64(bytes) });
    } else if (kind === "data" || kind === "page") {
      const a = await git.readTextFile(pr.baseSha, p);
      const b = await git.readTextFile(pr.headSha, p);
      if (a === null || b === null) throw new ApiError("conflict", "The draft changes a file that no longer exists.", { items: [{ file: p }] });
      const da = kind === "data" ? parseWithRanges(a).value : parsePage(a).doc;
      const db = kind === "data" ? parseWithRanges(b).value : parsePage(b).doc;
      ops.push(...diffOps(p, da, db));
    } else throw new ApiError("forbidden", "The draft touches a file Studio may not change.");
  }
  const patch = { idempotencyKey: idempotencyKey || deps.randomUUID(), title: pr.title, ops, uploads };
  const r = await validatePatch(validatorCtx(deps, mainHead), patch, { maxOps: 100000, maxImageBytes: deps.config.maxImageBytes, maxUploads: 100 });
  throwValidation(deps, ctx, r, "rebase");
  const files = [...r.files].map(([path, f]) => ({ path, text: f.after })).concat(r.uploads.map((u) => ({ path: u.path, bytes: u.bytes })));
  if (!files.length) throw new ApiError("conflict", "Nothing is left to re-apply: main already has these changes.", { items: [] });
  const message = text.commitMessage("Update " + text.oneLine(pr.title.replace(/^Studio: /, ""), 40), r.changes, ctx.user.id, patch.idempotencyKey);
  const oldHead = pr.headSha;
  try {
    await git.resetBranch(parsed.branch, mainHead, oldHead);
    try { await git.commitFiles({ branch: parsed.branch, expectedHeadSha: mainHead, message, files }); } catch (e) {
      await git.resetBranch(parsed.branch, oldHead, mainHead).catch(() => {}); // put the draft back exactly as it was
      throw e;
    }
  } catch (e) { throw mapGit(e); }
  const fresh = await git.getPr(pr.number);
  deps.audit.write({ requestId: ctx.requestId, actor: actorOf(ctx), action: "draft.rebase", target: { draftId: id, pr: pr.number, branch: parsed.branch, sha: fresh.headSha }, outcome: "ok", ops: ops.length, files: files.map((f) => f.path) });
  return { draft: await toDraft(ctx, fresh), changes: await changesOf(deps, fresh), warnings: r.warnings };
}

const MIME = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", avif: "image/avif", svg: "image/svg+xml" };
const mimeOf = (p) => MIME[String(p).split(".").pop().toLowerCase()] || "application/octet-stream";

// History's Restore: the SAME validation + draft path, with the revert labels.
async function createFromOps(args) {
  const { user, token, role, deps, title, ops, uploads, labels, revertOf, idempotencyKey, requestId } = args;
  const ctx = { deps, user, role: role || "editor", token, userKey: await ids.userKey(user.id), requestId };
  const mainHead = (await deps.git.getHead(deps.git.getBaseBranch())).sha;
  const patch = { idempotencyKey, baseSha: mainHead, title, ops, uploads: uploads || [] };
  return saveDraft(ctx, patch, { labels, revertOf });
}

// every open Studio draft of the repository, whoever owns it (the status board and the review screen filter by role)
async function openDrafts(ctx) {
  const prs = await ctx.deps.git.listPrs({ headPrefix: "studio/", state: "open" });
  const out = [];
  for (const pr of prs) {
    if (!isStudioPr(pr)) continue;
    const id = ids.idFromBranch(pr.headRef);
    if (!id) continue;
    out.push({ pr, draft: await toDraft(ctx, pr) });
    if (out.length >= 100) break;
  }
  return out;
}

module.exports = { openDrafts, loadDraft, appliedOf, isStudioPr, publishBlockers, reviewLinkFor, saveDraft, listDrafts, getDraft, submitDraft, publishDraft, discardDraft, rebaseDraft, createFromOps, toDraft, changesOf, publishBlock, validatorCtx, mapGit, atLeast, ROLE_RANK };
