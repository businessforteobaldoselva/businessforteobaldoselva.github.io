"use strict";
// Sentinel experiment: replace every editable string in a throwaway copy of the site by a unique
// token, build, and look for each token in the output. A token that never shows up belongs to a
// data value (or CMS field) that no template reads - a dead field.
//
// Also adds the tokens the data does not hold yet: optional CMS fields that are absent from the
// data are injected, and one example of every list item type the data never uses is appended, so
// fields of unused block types are tested too.

const fs = require("fs");
const path = require("path");
const { widgetOf, listItemFields, contentCollections } = require("./cmsconfig");
const { schemaPath, pathString, setAt, getAt, joinFrontMatter, leaves } = require("./data");
const { listFiles, toPosix, readText } = require("./util");
const { proseKind } = require("./prose");

const TOKEN_RE = /wiretk\d{5}x/gi;
const MEDIA_RE = /^\/?(images|videos)\/[A-Za-z0-9._\/-]+\.(jpe?g|png|webp|gif|avif|svg|mp4|webm|m4v)$/i;
const TEXT_WIDGETS = new Set(["string", "text", "markdown"]);
const MEDIA_WIDGETS = new Set(["image", "file"]);
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

class Plan {
  constructor() {
    this.edits = []; // { src, path, schema, field, orig, token, kind, synth?, injected? }
    this.skipped = []; // { src, schema, reason }
    this.counter = 0;
  }
  token() {
    this.counter += 1;
    return "wiretk" + String(this.counter).padStart(5, "0") + "x";
  }
}

// Value that goes into a field, shaped so common validators (links, paths, patterns) accept it.
function sentinelValue(tok, orig, field) {
  const w = widgetOf(field);
  const name = (field && field.name) || "";
  if (MEDIA_WIDGETS.has(w) || (typeof orig === "string" && MEDIA_RE.test(orig))) return { kind: "media" };
  if (typeof orig === "string") {
    if (/^https?:\/\//i.test(orig)) return { kind: "text", value: "https://" + tok + ".example/" };
    if (/^mailto:/i.test(orig)) return { kind: "text", value: "mailto:" + tok + "@example.com" };
    if (/^#./.test(orig)) return { kind: "text", value: "#" + tok };
    if (/^\/(?!\/)/.test(orig)) return { kind: "text", value: "/" + tok + "/" };
    // "{year} COVERED" style strings: keep the placeholders the templates substitute, tokenise the rest
    const ph = orig.match(/\{[A-Za-z][A-Za-z0-9_.]*\}/g);
    if (ph) return { kind: "text", value: ph.join(" ") + " " + tok };
  }
  if ((orig === "" || orig === null || orig === undefined) && /(url|link|href)$/i.test(name)) return { kind: "text", value: "/" + tok + "/" };
  return { kind: "text", value: tok };
}

function planFor(plan, src, p, field, orig, extra) {
  const schema = schemaPath(p);
  const w = widgetOf(field);
  if (w === "boolean" && plan.switches && typeof orig === "boolean") {
    // yes / no switches are flipped between builds so conditional markup shows up too (not part of the token search)
    // The "Decorative picture" switch hides the picture's description (alt=""), so it stays OFF in the token
    // build - otherwise every description token would vanish and look like a dead field - and is only
    // flipped in the alternating variants.
    plan.edits.push({ src, path: p, schema, field, orig, token: null, kind: "bool", value: field.name === "decorative" ? false : true, flip: true });
    return;
  }
  if (w === "select" && plan.switches && typeof orig === "string" && Array.isArray(field.options) && field.options.length) {
    const options = field.options.map((o) => (o && typeof o === "object" ? o.value : o));
    plan.edits.push({ src, path: p, schema, field, orig, token: null, kind: "select", options, value: orig, flip: true });
    return;
  }
  if (w === "hidden") {
    plan.skipped.push({ src: src.file, schema, reason: "hidden field (not editable)" });
    return;
  }
  if (!TEXT_WIDGETS.has(w) && !MEDIA_WIDGETS.has(w)) {
    plan.skipped.push({ src: src.file, schema, reason: "not free text (" + w + " widget)" });
    return;
  }
  const token = plan.token();
  const sv = sentinelValue(token, orig, field);
  if (sv.kind === "text" && Array.isArray(field.pattern)) {
    let re = null;
    try {
      re = new RegExp(field.pattern[0]);
    } catch (e) {
      /* reported by check-cms */
    }
    // a field whose pattern asks for an e-mail address (site.contactEmail) takes a token shaped like one
    if (re && !re.test(sv.value) && re.test(sv.value + "@example.com")) sv.value += "@example.com";
    if (re && !re.test(sv.value)) {
      plan.counter -= 1;
      plan.skipped.push({ src: src.file, schema, reason: "CMS pattern rejects a free token (" + field.pattern[0].slice(0, 40) + ")" });
      return;
    }
  }
  plan.edits.push(Object.assign({ src, path: p, schema, field, orig, token, kind: sv.kind, value: sv.value }, extra || {}));
}

// Walk an object value alongside its field definitions.
function planObject(plan, src, obj, fields, basePath, opts) {
  for (const f of fields || []) {
    const w = widgetOf(f);
    const p = basePath.concat(f.name);
    const v = obj[f.name];
    if (w === "hidden") continue;
    if (v === undefined || v === null) {
      if (TEXT_WIDGETS.has(w) || MEDIA_WIDGETS.has(w)) {
        planFor(plan, src, p, f, undefined, { injected: true });
      } else if (w === "object" && f.fields) {
        const child = {};
        plan.edits.push({ src, path: p, schema: schemaPath(p), synth: true, value: child, kind: "structure", field: f });
        planObject(plan, src, child, f.fields, p, opts);
      } else if (w === "list") {
        plan.edits.push({ src, path: p, schema: schemaPath(p), synth: true, value: [], kind: "structure", field: f });
        planList(plan, src, [], f, p, opts, true);
      }
      continue;
    }
    planValue(plan, src, v, f, p, opts);
  }
}

function planValue(plan, src, v, f, p, opts) {
  const w = widgetOf(f);
  if (w === "object" && isObj(v)) planObject(plan, src, v, f.fields, p, opts);
  else if (w === "list" && Array.isArray(v)) planList(plan, src, v, f, p, opts, false);
  else if (!isObj(v) && !Array.isArray(v)) planFor(plan, src, p, f, v);
}

function planList(plan, src, arr, f, p, opts, missing) {
  const typeKey = f.typeKey || "type";
  arr.forEach((item, i) => {
    const ip = p.concat(i);
    const sub = listItemFields(f, item);
    if (!sub) {
      if (!isObj(item) && !Array.isArray(item)) planFor(plan, src, ip, { name: f.name, widget: "string", label: f.label }, item);
    } else if (sub.single) {
      if (isObj(item) && widgetOf(sub.single) === "object") planObject(plan, src, item, sub.single.fields, ip, opts);
      else if (!isObj(item)) planFor(plan, src, ip, sub.single, item);
    } else if (sub.fields && isObj(item)) planObject(plan, src, item, sub.fields, ip, opts);
  });
  // an example of every item type the data does not use yet
  if (f.types) {
    const used = new Set(arr.map((it) => it && it[typeKey]));
    let at = arr.length;
    for (const t of f.types) {
      if (used.has(t.name)) continue;
      const item = { [typeKey]: t.name };
      const ip = p.concat(at);
      at += 1;
      plan.edits.push({ src, path: ip, schema: schemaPath(ip), synth: true, value: item, kind: "structure", field: f, typeName: t.name, missingList: missing && at === arr.length + 1 });
      planObject(plan, src, item, t.fields, ip, opts);
    }
  } else if (f.fields && arr.length === 0) {
    const item = {};
    const ip = p.concat(0);
    plan.edits.push({ src, path: ip, schema: schemaPath(ip), synth: true, value: item, kind: "structure", field: f, missingList: missing });
    planObject(plan, src, item, f.fields, ip, opts);
  }
  // a list of plain strings gets padded to three examples, so templates that treat the last two items
  // differently (the ticker's "… and …" joiner) are exercised whatever the editors left in the list
  if (!f.types && !f.fields && f.field && !isObj(f.field.fields)) {
    for (let i = arr.length; i < 3; i += 1) planFor(plan, src, p.concat(i), f.field, undefined, { injected: true, listItem: true });
  }
}

// Developer-owned front matter of src/*.njk (no CMS entry): its sentences become tokens too, so the
// copy scan can tell them from hard-coded words. Not reported as dead when unused.
function planDev(plan, src) {
  for (const l of leaves(src.data)) {
    if (typeof l.value !== "string" || proseKind(l.value) !== "copy") continue;
    const token = plan.token();
    plan.edits.push({ src, path: l.path, schema: schemaPath(l.path), field: { name: String(l.path[l.path.length - 1]), widget: "string" }, orig: l.value, token, kind: "text", value: token, dev: true });
  }
}

// Plan edits for every source that has a CMS entry.
function makePlan(sources, cfg, ignoreMatcher, opts) {
  const plan = new Plan();
  plan.switches = !!(opts && opts.switches);
  const entries = contentCollections(cfg);
  const missingEntry = [];
  for (const src of sources) {
    if (src.kind === "njk") {
      planDev(plan, src);
      continue;
    }
    let entry = null;
    if (src.kind === "data") entry = entries.find((e) => e.kind === "file" && e.file === src.file);
    else entry = entries.find((e) => e.kind === "folder" && e.folder === path.posix.dirname(src.file));
    if (!entry) {
      missingEntry.push(src.file);
      continue;
    }
    planObject(plan, src, src.data, entry.fields, [], {});
  }
  // ignore-list: drop edits (and everything beneath a dropped structure is already separate)
  const kept = [];
  for (const e of plan.edits) {
    const m = ignoreMatcher && !e.dev ? ignoreMatcher(e.src.name, e.schema, "wiring", !!e.injected, e.src.kind) : null;
    if (m) plan.skipped.push({ src: e.src.file, schema: e.schema, reason: "wiring-ignore: " + m.reason });
    else kept.push(e);
  }
  plan.edits = kept;
  plan.missingEntry = missingEntry;
  return plan;
}

// Apply the edits of one source to a deep copy of its data and return the copy.
// resolveMedia(edit) -> the string to store for a media edit, or null when none can be made.
function mutateData(src, edits, resolveMedia) {
  const data = JSON.parse(JSON.stringify(src.data));
  // synthetic structures first (shallow before deep), then values
  const ordered = (edits || []).slice().sort((a, b) => a.path.length - b.path.length);
  for (const e of ordered) {
    if (e.synth) {
      const parentPath = e.path.slice(0, -1);
      const key = e.path[e.path.length - 1];
      let parent = parentPath.length ? getAt(data, parentPath) : data;
      if (parent === undefined || parent === null) {
        setAt(data, parentPath, typeof key === "number" ? [] : {});
        parent = getAt(data, parentPath);
      }
      if (Array.isArray(parent)) parent.push(e.value);
      else parent[key] = e.value;
      continue;
    }
    let value = e.value;
    if (e.kind === "media") {
      value = resolveMedia(e);
      if (value === null || value === undefined) continue;
      e.value = value;
    }
    const container = e.path.length > 1 ? getAt(data, e.path.slice(0, -1)) : data;
    if (container === undefined || container === null) {
      e.unfoundable = "parent structure missing";
      continue;
    }
    container[e.path[e.path.length - 1]] = value;
  }
  if (src.kind === "data" && src.name === "homepage" && Array.isArray(data.sections)) {
    data.sections.forEach((x) => x && typeof x === "object" && "enabled" in x && (x.enabled = true));
  }
  return data;
}

function groupBySource(plan) {
  const bySrc = new Map();
  for (const e of plan.edits) {
    if (!bySrc.has(e.src.file)) bySrc.set(e.src.file, []);
    bySrc.get(e.src.file).push(e);
  }
  return bySrc;
}

// Rewrite every string of a value (not the keys). `skip` keys keep their value.
function mapStrings(v, fn, key) {
  if (Array.isArray(v)) return v.map((x) => mapStrings(x, fn, key));
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v)) out[k] = mapStrings(v[k], fn, k);
    return out;
  }
  return typeof v === "string" ? fn(v, key) : v;
}

// Apply a plan to a workspace (writes the edited data files; copies sample images / videos under
// the token names for image fields). Returns { mediaFiles }.
// opts.payload(edit) -> string: put that into every planned TEXT field instead of the token. Media fields keep a valid
//   sample file (otherwise the <img> is dropped and its alt text would never be attacked)
// opts.all(string, keyName) -> string: afterwards rewrite EVERY other string of the data as well
// opts.variant: integer, see below (switches and dropdowns)
function applyPlan(ws, plan, sources, opts) {
  const o = opts || {};
  const bySrc = groupBySource(plan);
  const imagesDir = path.join(ws.dir, "images");
  const videosDir = path.join(ws.dir, "videos");
  const templates = {};
  const findTemplate = (ext) => {
    ext = ext.toLowerCase().replace(/^jpeg$/, "jpg");
    if (templates[ext] !== undefined) return templates[ext];
    let found = null;
    for (const d of [imagesDir, videosDir].filter((x) => fs.existsSync(x))) {
      const f = fs.readdirSync(d).find((n) => n.toLowerCase().replace(/\.jpeg$/, ".jpg").endsWith("." + ext) && !/-480\./.test(n));
      if (f) {
        found = path.join(d, f);
        break;
      }
    }
    templates[ext] = found;
    return found;
  };
  let mediaFiles = 0;
  const resolveMedia = (e) => {
    const ext = ((typeof e.orig === "string" && /\.([A-Za-z0-9]+)$/.exec(e.orig)) || [null, "jpg"])[1];
    const tpl = findTemplate(ext);
    if (!tpl) {
      e.unfoundable = "no sample ." + ext + " file to copy";
      return null;
    }
    const origStr = typeof e.orig === "string" ? e.orig : "/images/x.jpg";
    const folder = /^\/?videos\//i.test(origStr) ? "videos" : "images";
    const lead = origStr.startsWith("/") ? "/" : "";
    fs.copyFileSync(tpl, path.join(ws.dir, folder, e.token + "." + ext.toLowerCase()));
    mediaFiles += 1;
    return lead + folder + "/" + e.token + "." + ext.toLowerCase();
  };
  for (const src of sources) {
    let edits = bySrc.get(src.file);
    const isHomepage = src.kind === "data" && src.name === "homepage";
    if (!edits && !isHomepage && !(o.all && src.kind !== "njk")) continue;
    if (o.payload && edits) edits = edits.map((e) => (e.synth || e.flip || e.kind === "media" ? e : Object.assign({}, e, { kind: "text", value: o.payload(e) })));
    // variant 0 = switches on, dropdowns as shipped; variant k = switches on/off alternately, dropdowns at their k-th choice
    if (edits && o.variant) {
      edits = edits.map((e) => {
        if (e.kind === "bool") return Object.assign({}, e, { value: o.variant % 2 === 0 });
        if (e.kind === "select") return Object.assign({}, e, { value: e.options[o.variant % e.options.length] });
        return e;
      });
    }
    let data = mutateData(src, edits, resolveMedia);
    if (o.all) data = mapStrings(data, (s, k) => (MEDIA_RE.test(s) ? s : o.all(s, k)));
    if (src.kind === "data") ws.writeJson(src.file, data);
    else ws.write(src.file, joinFrontMatter(data, src.body));
  }
  return { mediaFiles };
}

// Text files of a build that can show a token to a visitor (internal tools and passthrough excluded).
function readBuild(outDir, isExcluded) {
  const skipTop = new Set(["images", "img", "fonts", "videos", "frames", "cms", "admin", "assets"]);
  const parts = [];
  for (const f of listFiles(outDir, (x) => /\.(html?|xml|txt|json|webmanifest)$|(^|[\\/])_redirects$/i.test(x))) {
    const rel = toPosix(path.relative(outDir, f));
    if (skipTop.has(rel.split("/")[0])) continue;
    const url = "/" + rel.replace(/index\.html$/, "");
    if (isExcluded && isExcluded(url)) continue;
    parts.push(readText(f));
  }
  return parts.join("\n").toLowerCase();
}

module.exports = { TOKEN_RE, makePlan, applyPlan, mutateData, mapStrings, groupBySource, readBuild, pathString };
