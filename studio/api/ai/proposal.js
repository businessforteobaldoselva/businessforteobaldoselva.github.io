"use strict";
// Proposal building blocks (AI-DESIGN 5.4, 5.5, 9.3, 9.4, 10): which change needs which, ids, the BEFORE/AFTER Deltas.
// Everything shown to the person comes from the server's own dry run and the schema labels; the model supplies neither
// a "before" nor a description of what an op does. Pure, portable.

const W = require("../../validate/walk");
const P = require("../../validate/pointer");
const { base32 } = require("../services/ids");
const textdiff = require("./textdiff");
const policy = require("./policy");
const chars = require("./chars");
const grammar = require("../../markers/grammar");

const STRUCTURAL = new Set(["add", "remove", "move"]);
const within = (p, root) => typeof p === "string" && typeof root === "string" && (p === root || p.startsWith(root + "/"));
const parentOf = (p) => p.slice(0, p.lastIndexOf("/"));
const listOf = (op) => parentOf(op.path);

// does later op x need earlier op y?  (AI-DESIGN 9.3)
function opNeeds(x, y) {
  if (x.file !== y.file) return false;
  if (STRUCTURAL.has(y.op)) {
    const L = listOf(y);
    if (within(x.path, L) || within(x.from, L)) return true;
  }
  for (const px of [x.path, x.from]) for (const py of [y.path, y.from]) if (typeof px === "string" && typeof py === "string" && (within(px, py) || within(py, px))) return true;
  return false;
}

// changes = [{ ops }] in model order -> requires[i] = sorted indexes (< i) that change i needs directly
function computeRequires(changes) {
  return changes.map((x, i) => {
    const need = [];
    for (let j = 0; j < i; j += 1) if (x.ops.some((ox) => changes[j].ops.some((oy) => opNeeds(ox, oy)))) need.push(j);
    return need;
  });
}

// the selected indexes plus everything they transitively need
function closure(requires, selected) {
  const out = new Set();
  const stack = [...selected];
  while (stack.length) {
    const i = stack.pop();
    if (out.has(i)) continue;
    out.add(i);
    for (const j of requires[i] || []) stack.push(j);
  }
  return out;
}

// who needs a given change, transitively (for dropping a change)
function dependants(requires, index) {
  const out = new Set([index]);
  let grew = true;
  while (grew) {
    grew = false;
    requires.forEach((req, i) => { if (!out.has(i) && req.some((j) => out.has(j))) { out.add(i); grew = true; } });
  }
  return out;
}

async function sha256Bytes(text) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}
const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, "0")).join("");

async function proposalId(userKey, baseSha, headSha, changes) {
  const canon = JSON.stringify(changes.map((c) => c.ops));
  return "p_" + base32(await sha256Bytes([userKey, baseSha, headSha || "", canon].join("|"))).slice(0, 12);
}

// 16 hex of sha256(salt + mode + instruction + feedback): the audit identity of a request, never the text
async function instructionHash(salt, mode, instruction, feedback) {
  return hex(await sha256Bytes(String(salt || "") + "\u0000" + mode + "\u0000" + String(instruction || "") + "\u0000" + String(feedback || ""))).slice(0, 16);
}

// the key the replay provider answers on (AI-DESIGN 7.1)
async function replayKey(mode, instruction, feedback, refs, draft, worldId) {
  return hex(await sha256Bytes([mode, instruction || "", feedback || "", (refs || []).slice().sort().join(","), draft ? "draft" : "main", worldId || "default"].join("|")));
}

// ---- Deltas ----------------------------------------------------------------------------------------------------------------
const rd = (s, max) => chars.readable(s, max);

function rendered(value, kind) {
  if (typeof value === "boolean") return { type: "bool", value };
  if (kind === "color" && typeof value === "string" && /^#[0-9a-fA-F]{3,8}$/.test(value)) return { type: "color", hex: value.toLowerCase() };
  if (kind === "link" && typeof value === "string") { const t = rd(value, policy.CAPS.renderedText); return { type: "link", text: t.text }; }
  const s = typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value);
  const t = rd(s, policy.CAPS.renderedText);
  return { type: "text", text: t.text, truncated: t.truncated };
}

// a whole list item as labelled fields (add / remove)
function itemFields(schema, file, listSegs, value, doc) {
  if (!P.isPlainObject(value)) return rendered(value, "text");
  const listNode = W.resolve(schema, file, listSegs, doc);
  const item = listNode && listNode.type === "list" ? W.itemNode(listNode.field, value) : null;
  const out = [];
  for (const f of (item && item.fields) || []) {
    const v = value[f.name];
    if (typeof v !== "string" && typeof v !== "boolean" && typeof v !== "number") continue;
    if (W.widgetOf(f) === "hidden") continue;
    out.push({ label: rd(W.cleanLabel(f.label || f.name), 60).text, text: rd(String(v), policy.CAPS.fieldText).text });
    if (out.length >= 8) break;
  }
  if (!out.length) for (const k of Object.keys(value).slice(0, 6)) if (typeof value[k] === "string") out.push({ label: rd(k, 40).text, text: rd(value[k], policy.CAPS.fieldText).text });
  return { type: "fields", fields: out };
}

function refFor(file, segs) {
  const m = /^src\/_data\/([a-z0-9-]+)\.json$/.exec(file) || null;
  const p = /^src\/pages\/([a-z0-9-]+)\.md$/.exec(file);
  const key = m ? m[1] : p ? "pages:" + p[1] : null;
  if (!key) return null;
  try { return grammar.formatRef(key, segs); } catch (e) { return null; }
}

// one Delta per op.  op = the op (server-built), a = its applied entry, d = its described change, docs = { before, after }
function buildDelta(schema, op, a, d, docs) {
  const doc = docs.after || docs.before;
  let kind = d.kind;
  const node = a.op === "remove" ? null : W.resolve(schema, op.file, a.segs, doc);
  const widget = node && node.field ? W.widgetOf(node.field) : "";
  if (a.op === "move") kind = "order";
  else if (kind === "text" && widget === "text") kind = "longtext";
  else if ((kind === "text" || kind === "page") && widget === "markdown") kind = "markdown";
  let before = null;
  let after = null;
  let diff = null;
  if (a.op === "replace") {
    before = rendered(a.before, kind);
    after = rendered(a.after, kind);
    if (before.type === "text" && after.type === "text") diff = textdiff.diff(before.text, after.text);
  } else if (a.op === "add") {
    after = P.isPlainObject(a.after) ? itemFields(schema, op.file, a.segs.slice(0, -1), a.after, docs.after) : rendered(a.after, kind);
  } else if (a.op === "remove") {
    before = P.isPlainObject(a.before) ? itemFields(schema, op.file, a.segs.slice(0, -1), a.before, docs.before) : rendered(a.before, kind);
  } else {
    const parent = P.get(docs.after || docs.before, a.segs.slice(0, -1));
    const lbl = W.labelFor(schema, op.file, a.segs.slice(0, -1).concat(String(a.from)), docs.before);
    before = null;
    after = { type: "order", from: a.from, to: a.to, of: Array.isArray(parent) ? parent.length : a.to + 1, itemLabel: rd(lbl.split(" > ").pop(), 60).text };
  }
  const structural = a.op !== "replace";
  return { file: op.file, path: op.path, ref: structural ? null : refFor(op.file, a.segs), op: a.op, kind, label: rd(d.label, 160).text, before, after, diff };
}

module.exports = { computeRequires, closure, dependants, opNeeds, proposalId, instructionHash, replayKey, buildDelta, rendered, refFor, sha256Bytes, hex, STRUCTURAL };
