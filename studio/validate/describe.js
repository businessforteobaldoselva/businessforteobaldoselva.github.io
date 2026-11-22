"use strict";
// Stage 9: each applied op becomes a Change a founder can read (PR bodies, the Changes panel, History).

const { resolve, labelFor, widgetOf, cleanLabel, fileInfo } = require("./walk");
const { format } = require("./pointer");

function clip(v) {
  let s = typeof v === "string" ? v : JSON.stringify(v);
  if (s === undefined) s = "";
  s = s.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\u2028\u2029]+/g, " ").replace(/@/g, "@\u200b");
  return s.length > 80 ? s.slice(0, 79) + "\u2026" : s;
}
const q = (v) => "\u201c" + clip(v) + "\u201d";

function kindOf(node, segs, file) {
  const f = node && node.field;
  const w = f ? widgetOf(f) : "";
  const rule = f && f.x && f.x.rule;
  const last = segs[segs.length - 1];
  const prev = segs[segs.length - 3];
  if (last === "enabled" && prev === "sections" && /homepage\.json$/.test(file)) return "section";
  if (node && node.itemOf && node.type) return "list";
  if (w === "image" || w === "file") return "image";
  if (rule === "url") return "link";
  if (w === "color") return "color";
  if (w === "boolean") return "toggle";
  if (/\/pages\//.test(file)) return "page";
  return "text";
}

// describeApplied(schema, before: Map<file,doc>, after: Map<file,doc>, applied) -> [Change]
function describeApplied(schema, before, after, applied) {
  return applied.map((a) => {
    const docForLabel = a.op === "add" ? after.get(a.file) : before.get(a.file);
    const node = resolve(schema, a.file, a.segs, a.op === "remove" ? before.get(a.file) : after.get(a.file));
    const label = labelFor(schema, a.file, a.segs, docForLabel);
    const kind = kindOf(node, a.segs, a.file);
    let summary;
    if (a.op === "replace") {
      if (kind === "section") summary = a.after === false ? "Hid this section on the website" : "Showed this section on the website";
      else if (kind === "toggle") summary = a.after ? "Turned this on" : "Turned this off";
      else if (kind === "image") summary = "Swapped the picture to " + q(a.after);
      else if (kind === "link") summary = "Changed the link from " + q(a.before) + " to " + q(a.after);
      else if (kind === "color") summary = "Changed the colour from " + clip(a.before) + " to " + clip(a.after);
      else if (typeof a.after === "string" && typeof a.before === "string") summary = "Changed the text from " + q(a.before) + " to " + q(a.after);
      else if (typeof a.after === "object" && a.after !== null) summary = "Replaced the contents";
      else summary = "Changed the value from " + clip(a.before) + " to " + clip(a.after);
    } else if (a.op === "add") summary = "Added " + (typeof a.after === "string" ? q(a.after) : "a new item");
    else if (a.op === "remove") summary = "Removed " + (typeof a.before === "string" ? q(a.before) : "this item");
    else summary = "Moved from position " + (a.from + 1) + " to position " + (a.to + 1);
    return { file: a.file, path: format(a.segs), op: a.op, label: clip(label), summary, kind: a.op === "add" || a.op === "remove" || a.op === "move" ? (kind === "section" ? "section" : "list") : kind };
  });
}


// ---- the approver's "what will change" screen (Phase 1, REVIEW) ----------------------------------------------------------
// describe(op, ctx) -> { kind, label, line, before, after, where, pageUrl, attention } for ONE applied operation of any kind
// (replace / add / remove / move) on any field of the schema. `op` = { op, file, segs, before, after, from?, to? } exactly as
// describeApplied takes it; ctx = { schema, before: Map<file,doc>, after: Map<file,doc> }. Pure and portable. The returned strings
// are plain text for textContent: control characters are gone and "<" / ">" are swapped for look-alikes, so even a careless
// consumer cannot be handed markup.
const HOME_KEYS = ["homepage", "hero", "problem", "model", "how", "brands", "partners", "venues", "locations", "vision", "faq"];
const MAX_VALUE = 2000;

const plain = (s, max) => {
  let t = String(s == null ? "" : s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, " ").replace(/</g, "\u2039").replace(/>/g, "\u203a");
  if (max && t.length > max) t = t.slice(0, max - 1) + "\u2026";
  return t;
};
const shortQ = (v) => "\u201c" + plain(clip(v), 90) + "\u201d";

function viewOf(v, kind) {
  if (v === undefined) return null;
  let text;
  let image = null;
  if (kind === "section") text = v === false ? "Hidden" : "Shown";
  else if (kind === "toggle") text = v ? "On" : "Off";
  else if (typeof v === "string") text = v;
  else if (v === null) text = "(empty)";
  else if (typeof v === "number") text = String(v);
  else text = JSON.stringify(v);
  if (kind === "image" && typeof v === "string" && v) image = plain(v.split("/").pop(), 120);
  const t = plain(text, 0);
  const truncated = t.length > MAX_VALUE;
  return { text: truncated ? t.slice(0, MAX_VALUE - 1) + "\u2026" : t, truncated, image };
}

function whereOf(schema, file, docs) {
  const info = fileInfo(schema, file);
  if (!info) return { where: plain(file, 80), pageUrl: null };
  if (info.kind === "page") {
    const d = docs.after.get(file) || docs.before.get(file) || {};
    const url = typeof d.permalink === "string" && /^\/[A-Za-z0-9._~\/-]*$/.test(d.permalink) ? d.permalink : null;
    return { where: plain(typeof d.title === "string" && d.title.trim() ? d.title.trim() : info.key.replace(/^pages:/, ""), 60) + " page", pageUrl: url };
  }
  if (HOME_KEYS.indexOf(info.key) >= 0) return { where: "Home page", pageUrl: "/" };
  return { where: plain(cleanLabel(info.label), 80), pageUrl: null };
}

function describe(a, ctx) {
  const docs = { before: ctx.before || new Map(), after: ctx.after || new Map() };
  const node = resolve(ctx.schema, a.file, a.segs, a.op === "remove" ? docs.before.get(a.file) : docs.after.get(a.file));
  const parts = labelFor(ctx.schema, a.file, a.segs, a.op === "add" ? docs.after.get(a.file) : docs.before.get(a.file)).split(" > ").map((x) => plain(x, 80));
  const label = parts.join(" > ").slice(0, 200);
  const k = kindOf(node, a.segs, a.file);
  const kind = a.op === "replace" ? k : k === "section" ? "section" : a.op === "move" || a.op === "add" || a.op === "remove" ? "list" : k;
  const { where, pageUrl } = whereOf(ctx.schema, a.file, docs);
  // a section switch reads best as the section's name ("How it works"), not as its last field ("Show this section")
  const leaf = k === "section" && parts.length > 1 ? parts[parts.length - 2].replace(/ [0-9]+$/, "") : parts[parts.length - 1];
  const at = "the " + leaf + " (" + where + ")";
  let line;
  if (a.op === "replace") {
    if (k === "section") line = (a.after === false ? "Hides" : "Shows") + " the “" + leaf + "” section (" + where + ").";
    else if (k === "toggle") line = "Turns " + at + " " + (a.after ? "on" : "off") + ".";
    else if (k === "image") line = "Swaps the picture for " + at + " to " + shortQ(a.after) + ".";
    else if (k === "link") line = "Changes where " + at + " goes: from " + shortQ(a.before) + " to " + shortQ(a.after) + ".";
    else if (k === "color") line = "Changes the colour of " + at + " from " + plain(clip(a.before), 40) + " to " + plain(clip(a.after), 40) + ".";
    else if (typeof a.after === "object" && a.after !== null) line = "Replaces the contents of " + at + ".";
    else line = "Changes " + at + " from " + shortQ(a.before) + " to " + shortQ(a.after) + ".";
  } else if (a.op === "add") line = "Adds " + (typeof a.after === "string" ? shortQ(a.after) : "a new item") + " to " + at + ".";
  else if (a.op === "remove") line = "Removes " + (typeof a.before === "string" ? shortQ(a.before) : "an item") + " from " + at + ".";
  else line = "Moves an item in " + at + " from position " + (Number(a.from) + 1) + " to position " + (Number(a.to) + 1) + ".";
  line = plain(line, 400);

  const legal = (a.file === "src/_data/site.json" && a.segs[0] === "contactEmail") || a.file === "src/pages/privacy.md";
  let attention = "none";
  if (legal) attention = "legal";
  else if (k === "section" && a.op === "replace" && a.after === false) attention = "hidden";
  else if (k === "link") attention = "link";
  else if (k === "image") attention = "image";
  return {
    kind, label, line, where, pageUrl, attention,
    before: a.op === "add" || a.op === "move" ? null : viewOf(a.before, k),
    after: a.op === "remove" || a.op === "move" ? null : viewOf(a.after, k),
  };
}

module.exports = { describeApplied, describe, clip };
