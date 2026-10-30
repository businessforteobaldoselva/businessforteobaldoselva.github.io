"use strict";
// Stage 9: each applied op becomes a Change a founder can read (PR bodies, the Changes panel, History).

const { resolve, labelFor, widgetOf } = require("./walk");
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

module.exports = { describeApplied, clip };
