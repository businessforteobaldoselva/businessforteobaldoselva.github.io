"use strict";
// The status board (studio/PHASE1-DESIGN.md section 5): what is live, what waits for approval, what was restored, my drafts.
// READ ONLY: it builds the picture from the same reads the Drafts and History services use and never writes to Git.
// Portable.

const { ApiError } = require("../errors");
const text = require("./pr-text");
const ids = require("./ids");
const drafts = require("./drafts");
const history = require("./history");
const scope = require("../../validate/scope");

const CACHE_MS = 15000;
const DAY_MS = 24 * 60 * 60 * 1000;

// the pull request title carries "Studio: " and the author's first name; a founder reads neither
const tidy = (t) => text.oneLine(String(t || "").replace(/^Studio: /, "").replace(/ \([^()]*\)$/, ""), 120);

const LABELS = {
  editing: "Still being edited",
  waiting_for_checks: "Safety checks are running",
  checks_failed: "Safety checks need attention",
  waiting_for_approval: "Waiting for approval",
  ready_to_publish: "Ready for you to approve",
  published: "Live",
  restored: "Restored",
};

// first match wins (design table)
function stepOf(draft) {
  if (draft.state === "draft") return "editing";
  const ck = draft.checks && draft.checks.state;
  if (ck === "failure") return "checks_failed";
  if (ck !== "success") return "waiting_for_checks";
  return draft.canPublish ? "ready_to_publish" : "waiting_for_approval";
}

function itemOf(ctx, row) {
  const { pr, draft } = row;
  const step = stepOf(draft);
  const approver = drafts.atLeast(ctx.role, "approver");
  return {
    id: draft.id,
    number: draft.number,
    title: text.oneLine(draft.title, 120),
    url: draft.url,
    reviewLink: drafts.reviewLinkFor(ctx.deps, draft),
    step,
    stepLabel: LABELS[step],
    author: { name: text.oneLine(draft.author.name, 60) },
    updatedAt: draft.updatedAt || draft.createdAt || new Date(ctx.deps.now()).toISOString(),
    changeCount: text.parseChangeCount(pr.body),
    mine: draft.isMine,
    canReview: draft.isMine || approver,
    canPublish: !!draft.canPublish,
  };
}

async function build(ctx) {
  const deps = ctx.deps;
  const now = deps.now().getTime();
  const cfg = deps.config.review;
  const approver = drafts.atLeast(ctx.role, "approver");
  const rows = await drafts.openDrafts(ctx);
  const ready = rows.filter((r) => r.draft.state === "ready");
  const waitingRows = approver ? ready : ready.filter((r) => r.draft.isMine);
  const merged = (await deps.git.listMerged({ limit: 30, cursor: null })).items.filter((it) => it.files.some((p) => scope.classify(p) !== null));

  const mergedItem = (it) => {
    const { author, revertOf } = history.authorOf(it);
    return { it, author, revertOf, at: Date.parse(it.mergedAt) };
  };
  const m = merged.map(mergedItem);
  const first = m[0] || null;
  const live = first ? {
    number: first.it.number, title: tidy(first.it.title), mergedAt: first.it.mergedAt, sha: first.it.mergeSha,
    url: deps.git.prUrl ? deps.git.prUrl(first.it.number) : "", by: { name: text.oneLine(first.author.name, 60) },
    settling: now - first.at < cfg.settlingMinutes * 60 * 1000,
  } : null;
  const restored = m.filter((x) => x.revertOf !== null && now - x.at <= 30 * DAY_MS).slice(0, 10).map((x) => ({
    id: ids.idFromBranch(x.it.headRef) || "pr-" + x.it.number, number: x.it.number, title: tidy(x.it.title), url: deps.git.prUrl ? deps.git.prUrl(x.it.number) : "",
    reviewLink: null, step: "restored", stepLabel: LABELS.restored, author: { name: text.oneLine(x.author.name, 60) }, updatedAt: x.it.mergedAt, changeCount: null, mine: false, canReview: false, canPublish: false,
  }));
  return {
    generatedAt: new Date(now).toISOString(),
    live,
    waiting: waitingRows.slice(0, 50).map((r) => itemOf(ctx, r)),
    restored,
    mine: rows.filter((r) => r.draft.isMine).slice(0, 50).map((r) => itemOf(ctx, r)),
    othersWaiting: approver ? 0 : ready.filter((r) => !r.draft.isMine).length,
  };
}

async function board(ctx) {
  const deps = ctx.deps;
  const cache = deps.boardCache || (deps.boardCache = new Map());
  const key = ctx.role + ":" + ctx.userKey;
  const now = deps.now().getTime();
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_MS) return hit.body;
  let body;
  try { body = await build(ctx); } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError("upstream_error", "The status board is unavailable right now. Try again in a minute.");
  }
  cache.set(key, { at: now, body });
  if (cache.size > 100) cache.delete(cache.keys().next().value);
  return body;
}

module.exports = { board, stepOf, LABELS };
