"use strict";
// The context pack (AI-DESIGN 7.4, 8.3): the ONLY page content a model ever sees. It is built from Git, from allow-listed
// leaves only (their current values, labels and the list structure) and nothing else: no templates, no configuration,
// no secrets, no code. The request never carries page content (the browser sends refs, the server reads Git).
// Portable (reads through the injected Git provider).

const A = require("./allowlist");
const W = require("../../validate/walk");
const P = require("../../validate/pointer");
const policy = require("./policy");
const grammar = require("../../markers/grammar");
const { parseWithRanges } = require("../../validate/jsontext");
const { parsePage } = require("../../validate/pagefile");

const PAGE_RE = /^[a-z0-9-]+\.md$/;
const MAX_VALUE_CHARS = 8000;
const IMAGE_TYPES = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif" };

// instruction-like text inside page content (forensics and a UI warning only, never a security boundary)
const INJECTION = [
  /\b(ignore|disregard|forget)\b.{0,40}\b(previous|above|prior|instructions?|rules?)\b/i,
  /\bsystem\s*:/i,
  /\b(you are|act as|new instructions?)\b/i,
  /\bsubmit_result\b/i,
  /<\/?(system|assistant|user|site_content|request)/i,
];
const looksLikeInstruction = (s) => typeof s === "string" && INJECTION.some((re) => re.test(s));

// ---- reading ---------------------------------------------------------------------------------------------------------
// -> Map<file, doc> of every file the AI could ever touch, at `ref` (a commit sha). Reads are memoised for the request.
async function loadDocs(deps, ref, allow, only) {
  const docs = new Map();
  const git = deps.git;
  const files = [];
  for (const [stem, f] of Object.entries((allow.schema && allow.schema.files) || {})) if (f.path && allow.index.has(A.KEY(f.path, ""))) files.push(f.path);
  const names = (await git.listDir(ref, "src/pages")) || [];
  for (const n of names) if (PAGE_RE.test(n)) files.push("src/pages/" + n);
  for (const file of files) {
    if (only && !only.has(file)) continue;
    const text = await git.readTextFile(ref, file);
    if (typeof text !== "string") continue;
    try { docs.set(file, /\.json$/.test(file) ? parseWithRanges(text).value : parsePage(text).doc); } catch (e) { /* unreadable: not offered */ }
  }
  return docs;
}

function fileKeyOf(file) {
  const m = /^src\/_data\/([a-z0-9-]+)\.json$/.exec(file);
  if (m) return m[1];
  const p = /^src\/pages\/([a-z0-9-]+)\.md$/.exec(file);
  return p ? "pages:" + p[1] : null;
}

function refOf(file, segs) {
  const k = fileKeyOf(file);
  if (!k) return null;
  try { return grammar.formatRef(k, segs); } catch (e) { return null; }
}

// the files a ref list / page names: Set<file>
function filesOfRefs(refs, page) {
  const out = new Set();
  for (const r of refs || []) { const loc = grammar.locate(r); if (loc) out.add(loc.filePath); }
  if (page === "index") out.add("src/_data/homepage.json");
  else if (typeof page === "string" && /^pages:[a-z0-9-]+$/.test(page)) out.add("src/pages/" + page.slice(6) + ".md");
  return out;
}

// ---- walking a document beside the schema ---------------------------------------------------------------------------------
function walkFile(allow, file, doc, visit) {
  const info = W.fileInfo(allow.schema, file);
  if (!info) return;
  const root = W.rootNode(info);
  const rec = (node, value, segs, parentNode, parentValue) => {
    if (node.type === "object") {
      if (!P.isPlainObject(value)) return;
      const names = node.fields.map((f) => f.name);
      if (node.root && info.kind === "page" && info.body) names.push("_body");
      for (const name of names) {
        if (!P.hasOwn(value, name)) continue;
        const c = W.child(node, name, value);
        if (c) rec(c, value[name], segs.concat(name), node, value);
      }
      return;
    }
    if (node.type === "list") {
      if (!Array.isArray(value)) return;
      visit({ kind: "list", node, value, segs, parentNode, parentValue });
      value.forEach((item, i) => {
        const c = W.child(node, String(i), value);
        if (c) rec(c, item, segs.concat(String(i)), node, value);
      });
      return;
    }
    visit({ kind: "leaf", node, value, segs, parentNode, parentValue });
  };
  rec(root, doc, [], null, null);
}

const normImage = (v) => (typeof v === "string" ? v.replace(/^\/+/, "") : "");
const weakAlt = (alt, image) => {
  const a = typeof alt === "string" ? alt.trim() : "";
  const base = String(image || "").split("/").pop();
  return a.length < 8 || a === base || a === base.replace(/\.[a-z0-9]+$/i, "");
};

// ---- building the pack ---------------------------------------------------------------------------------------------------
// opts = { mode, refs, page, scope, maxChars }  -> pack
// pack = { editable, lists, pairs, pageCopy, filesSent:Set, docs, warnings:[{code,message,refs}], injectionRefs:[ref], cut:boolean }
function buildPack(allow, docs, opts) {
  const o = opts || {};
  const mode = o.mode || "edit";
  const focusFiles = filesOfRefs(o.refs, o.page);
  const focusRefs = new Set((o.refs || []).filter((r) => grammar.parseRef(r)));
  const editable = [];
  const lists = [];
  const pairs = [];
  const copyByFile = new Map();
  const injectionRefs = [];

  for (const [file, doc] of docs) {
    walkFile(allow, file, doc, (ev) => {
      const pointer = P.format(ev.segs);
      if (ev.kind === "list") {
        const t = A.templateOf(allow, file, ev.segs, doc);
        const hit = t && A.lookup(allow, file, t.template);
        if (!hit || hit.kind !== "list" || mode === "alt_text" || mode === "meta_description") return;
        const f = ev.node.field;
        const fields = f.fields ? f.fields.map((x) => x.name) : f.types ? f.types.map((x) => x.name) : f.field ? ["(text)"] : [];
        lists.push({ file, pointer, label: W.labelFor(allow.schema, file, ev.segs, doc), length: ev.value.length, ops: hit.target.ops, typed: !!hit.target.typed, min: hit.target.min, max: hit.target.max, itemFields: fields.slice(0, 20) });
        return;
      }
      const v = ev.value;
      if (typeof v !== "string" && typeof v !== "boolean" && typeof v !== "number") return;
      const m = A.matchTarget(allow, file, pointer, doc, { op: "replace", mode });
      const mEdit = mode === "edit" ? m : A.matchTarget(allow, file, pointer, doc, { op: "replace", mode: "edit" });
      const ref = refOf(file, ev.segs);
      const widget = ev.node.field && (ev.node.field.widget || "string");
      // meta description mode also needs the page's copy as reading material (never writable)
      if (mode === "meta_description" && mEdit.ok && typeof v === "string" && !m.ok && v.length <= MAX_VALUE_CHARS && widget !== "markdown") {
        const arr = copyByFile.get(file) || [];
        arr.push(v);
        copyByFile.set(file, arr);
      }
      if (!m.ok) return;
      if (typeof v === "string" && v.length > MAX_VALUE_CHARS) return;
      const entry = { file, pointer, label: W.labelFor(allow.schema, file, ev.segs, doc), type: widget, max: m.target.maxLen, value: v };
      if (ref) entry.ref = ref;
      if (ref && focusRefs.has(ref)) entry.focus = true;
      if (mode === "alt_text") {
        const last = ev.segs[ev.segs.length - 1];
        const sib = ev.parentNode && ev.parentNode.fields ? ev.parentNode.fields.find((f) => (last === "alt" && W.widgetOf(f) === "image") || (last === "shareImageAlt" && f.name === "shareImage")) : null;
        const image = sib && P.isPlainObject(ev.parentValue) ? ev.parentValue[sib.name] : undefined;
        if (typeof image !== "string" || !image) return;
        const deco = P.isPlainObject(ev.parentValue) && ev.parentValue.decorative === true;
        entry.image = image;
        entry.weak = !deco && weakAlt(v, image);
        entry.decorative = deco;
        pairs.push(entry);
      }
      if (typeof v === "string" && looksLikeInstruction(v)) { entry.flagged = true; injectionRefs.push(ref || file + pointer); }
      editable.push(entry);
    });
  }

  // alt-text mode: only the pictures asked about (refs / page), else only the weak ones, at most 8
  let chosen = editable;
  if (mode === "alt_text") {
    let list = pairs;
    const byRef = list.filter((e) => e.ref && (focusRefs.has(e.ref) || [...focusRefs].some((r) => e.ref.startsWith(r.replace(/\.(image|src|shareImage)$/, "") + "."))));
    if (byRef.length) list = byRef;
    else if (focusFiles.size) list = list.filter((e) => focusFiles.has(e.file) && (o.scope !== "missing" || e.weak));
    else list = list.filter((e) => e.weak);
    chosen = list.slice(0, policy.CAPS.altImages);
  } else {
    // focus entries first, then the rest in document order
    chosen = editable.slice().sort((a, b) => (b.focus ? 1 : 0) - (a.focus ? 1 : 0));
  }
  const filesSent = new Set(chosen.map((e) => e.file));
  for (const l of lists) filesSent.add(l.file);
  const pageCopy = [];
  if (mode === "meta_description") {
    let budget = 8000;
    const order = [...copyByFile.keys()].sort((a, b) => (focusFiles.has(b) ? 1 : 0) - (focusFiles.has(a) ? 1 : 0));
    for (const f of order) {
      const text = copyByFile.get(f).join(" ").slice(0, Math.min(budget, 3000));
      if (!text) continue;
      pageCopy.push({ file: f, text });
      budget -= text.length;
      if (budget <= 0) break;
    }
  }
  const warnings = [];
  if (injectionRefs.length) warnings.push({ code: "injection_suspected", message: "Some page text looks like instructions to an assistant. It was treated as ordinary text.", refs: [...new Set(injectionRefs)].slice(0, 10) });
  return { editable: chosen, lists: mode === "alt_text" ? [] : lists, pairs: mode === "alt_text" ? chosen : [], pageCopy, filesSent, docs, warnings, injectionRefs, focusFiles };
}

// shrink a pack that is too large: keep the focus files (and mode targets) only; the rest becomes unreachable
function narrow(pack, keepFiles) {
  const keep = new Set(keepFiles);
  const editable = pack.editable.filter((e) => keep.has(e.file));
  const lists = pack.lists.filter((l) => keep.has(l.file));
  return Object.assign({}, pack, { editable, lists, filesSent: new Set([...editable.map((e) => e.file), ...lists.map((l) => l.file)]), cut: true });
}

// ---- pictures for alt-text mode (read from the repository, never from the client) ----------------------------------------------
async function loadImages(deps, ref, pack, cfg) {
  if (!cfg.vision) return [];
  const out = [];
  const seen = new Set();
  for (const e of pack.pairs) {
    const rel = normImage(e.image);
    if (!/^images\/[A-Za-z0-9][A-Za-z0-9._-]{0,79}\.(jpe?g|png|webp|gif)$/i.test(rel) || seen.has(rel)) continue;
    seen.add(rel);
    const bytes = await deps.git.readFileBytes(ref, rel);
    if (!bytes || bytes.length > policy.CAPS.imageBytes) continue;
    let b64 = "";
    for (let i = 0; i < bytes.length; i += 0x8000) b64 += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    out.push({ ref: e.ref || rel, name: rel, mediaType: IMAGE_TYPES[rel.split(".").pop().toLowerCase()], dataBase64: btoa(b64) });
    if (out.length >= policy.CAPS.altImages) break;
  }
  return out;
}

// ---- who the request is "about" (for the outsideAsk flag, AI-DESIGN 9.4) -------------------------------------------------------
const STOP = new Set(["the", "and", "for", "with", "our", "you", "your", "this", "that", "from", "into", "page", "section", "text", "make", "all", "any", "its", "not", "use", "are", "was", "has", "have", "can", "new", "add"]);
const words = (s) => String(s || "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w)).map((w) => w.replace(/s$/, ""));

function targetFiles(allow, docs, req, pack) {
  const t = new Set(filesOfRefs(req.refs, req.page));
  const said = new Set(words(req.instruction));
  for (const w of words(req.feedback)) said.add(w);
  if (said.size) {
    for (const file of docs.keys()) {
      const info = W.fileInfo(allow.schema, file);
      if (!info) continue;
      const label = info.kind === "page" ? "page " + file.replace(/^src\/pages\/|\.md$/g, "") : W.cleanLabel(info.label) + " " + info.key;
      for (const w of words(label)) if (said.has(w)) { t.add(file); break; }
    }
  }
  // short names in the instruction ("Bristol", "Privacy") point at the file that holds them
  const names = new Set([...said].filter((w) => w.length >= 5));
  if (names.size) {
    for (const [file, doc] of docs) {
      let hit = false;
      walkFile(allow, file, doc, (ev) => { if (!hit && ev.kind === "leaf" && typeof ev.value === "string" && ev.value.length <= 30 && names.has(ev.value.toLowerCase().trim().replace(/s$/, ""))) hit = true; });
      if (hit) t.add(file);
    }
  }
  if (req.mode === "meta_description") {
    // the description of the page asked about: the home page's lives in the site settings
    if (req.page === "index") { t.delete("src/_data/homepage.json"); t.add("src/_data/site.json"); }
    if (!t.size && pack) for (const f of pack.filesSent) t.add(f);
  } else if (req.mode === "alt_text" && pack && !t.size) for (const f of pack.filesSent) t.add(f);
  return t;
}

module.exports = { loadDocs, buildPack, narrow, loadImages, targetFiles, filesOfRefs, looksLikeInstruction, refOf, fileKeyOf, walkFile, normImage, weakAlt };
