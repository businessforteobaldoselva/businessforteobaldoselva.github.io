"use strict";
// The approver's "what will change" screen (studio/PHASE1-DESIGN.md section 6) and the approver list (section 7.1).
// READ ONLY: nothing here writes to Git. Publishing stays the existing POST /v1/drafts/:id/publish with all of its gates.
// Portable.

const { ApiError } = require("../errors");
const { describe } = require("../../validate/describe");
const { sniffImage } = require("../../../scripts/lib/image-rules");
const P = require("../../validate/pointer");
const text = require("./pr-text");
const drafts = require("./drafts");

const MAX_ITEMS = 200;

// "photo.jpg (1200 x 800 pixels, 84 KB)" from the picture's own header; the bytes are never sent to the browser
async function pictureLabel(deps, ref, path) {
  const name = String(path).split("/").pop();
  let bytes = null;
  try { bytes = await deps.git.readFileBytes(ref, path); } catch (e) { bytes = null; }
  if (!bytes) return name.slice(0, 120);
  const kb = Math.max(1, Math.round(bytes.length / 1024));
  const info = sniffImage(bytes);
  const size = info && info.width && info.height ? info.width + " × " + info.height + " pixels, " : "";
  return (name.slice(0, 70) + " (" + size + kb + " KB)").slice(0, 120);
}

async function itemsOf(deps, pr) {
  const d = await drafts.appliedOf(deps, pr);
  const items = [];
  for (const a of d.applied) {
    if (items.length >= MAX_ITEMS) break;
    const x = describe(a, { schema: deps.schema, before: d.before, after: d.after });
    if (x.kind === "image") {
      // name the real picture file (and its size) instead of just the path text
      for (const side of ["before", "after"]) {
        const v = x[side];
        if (v && typeof v.text === "string" && /^[A-Za-z0-9._\/-]{1,120}$/.test(v.text)) {
          const bare = v.text.replace(/^\//, "");
          const path = bare.indexOf("/") >= 0 ? bare : "images/" + bare;
          if (/^images\/[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(path)) v.image = await pictureLabel(deps, side === "after" ? pr.headSha : pr.baseSha, path);
        }
      }
    }
    items.push({ file: a.file, path: P.format(a.segs), op: a.op, kind: x.kind, label: x.label, where: x.where, line: x.line, before: x.before, after: x.after, pageUrl: x.pageUrl, attention: x.attention });
  }
  for (const p of d.pictures) {
    if (items.length >= MAX_ITEMS) break;
    const label = await pictureLabel(deps, pr.headSha, p);
    const name = p.replace(/^images\//, "");
    if (items.some((it) => it.kind === "image" && it.after && it.after.image && (it.after.image === name || it.after.image.indexOf(name + " (") === 0))) continue; // already shown as the swap that uses it
    items.push({ file: p, path: "", op: "add", kind: "image", label: "Pictures", where: "Pictures", line: "Adds the picture “" + name + "”.", before: null, after: { text: name.slice(0, 120), truncated: false, image: label }, pageUrl: null, attention: "image" });
  }
  items.forEach((it, i) => { it.id = "r" + (i + 1); });
  // the same keys in the same order as the wire shape
  return items.map((it) => ({ id: it.id, file: it.file, path: it.path, op: it.op, kind: it.kind, label: it.label, where: it.where, line: it.line, before: it.before, after: it.after, pageUrl: it.pageUrl, attention: it.attention }));
}

function summaryOf(items, total) {
  if (!items.length) return "No changes to the website content";
  const areas = new Set(items.map((i) => i.where)).size;
  return items.length + " change" + (items.length === 1 ? "" : "s") + " on " + areas + " page" + (areas === 1 ? "" : "s") + (total > items.length ? " (the first " + items.length + " are shown)" : "");
}

async function reviewDraft(ctx, id) {
  const deps = ctx.deps;
  const { parsed, pr: listed } = await drafts.loadDraft(ctx, id, { allowApprover: true });
  const pr = (await deps.git.getPr(listed.number)) || listed; // never trust a list snapshot: the approver's expectedHeadSha comes from here
  const draft = await drafts.toDraft(ctx, pr);
  const items = await itemsOf(deps, pr);
  const blockers = drafts.publishBlockers(deps, ctx, pr, parsed.userKey);
  const cfg = deps.config.review;
  let sideBySide = null;
  if (cfg.previewEmbed && draft.previewUrl && cfg.siteUrl) {
    const pagePath = (items.find((i) => i.pageUrl) || { pageUrl: "/" }).pageUrl;
    try {
      const pu = new URL(draft.previewUrl);
      sideBySide = { productionUrl: cfg.siteUrl + pagePath, draftUrl: pu.origin + pagePath, pagePath };
    } catch (e) { sideBySide = null; }
  }
  return {
    draft,
    generatedAt: new Date(deps.now().getTime()).toISOString(),
    headSha: pr.headSha,
    summary: summaryOf(items, items.length),
    items,
    gates: { checks: pr.checks.state, canPublish: blockers.length === 0, blockers },
    sideBySide,
  };
}

// who can be asked to review: the configured approvers, never the caller; no logins or e-mail addresses leave the server
function approvers(ctx) {
  const me = String(ctx.user.id).toLowerCase();
  const list = ctx.deps.config.review.reviewers.filter((r) => !r.userId || r.userId !== me);
  return { approvers: list.map((r) => ({ id: r.id, displayName: text.oneLine(r.name, 60), role: r.role, notify: r.github ? "github" : "manual" })) };
}

module.exports = { reviewDraft, approvers };
