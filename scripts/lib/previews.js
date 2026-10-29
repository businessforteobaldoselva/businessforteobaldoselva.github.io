"use strict";
// Runs cms/previews.js outside a browser, the way Decap CMS would: previews are React components
// registered with CMS.registerPreviewTemplate(name, createClass({ render })). The sandbox provides a
// tiny `h` (React.createElement) that records elements as plain objects, and an `entry` whose
// getIn() answers like Immutable.js (scalars as plain values, lists / maps as objects with toJS()).

const fs = require("fs");
const vm = require("vm");
const path = require("path");

function makeH() {
  return function h(tag, props, ...kids) {
    return { tag, props: props || {}, kids: kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false && k !== true) };
  };
}

// Immutable-like wrapper over plain JSON.
function imm(v) {
  if (Array.isArray(v)) {
    const wrapped = v.map(imm);
    return {
      __list: true,
      size: v.length,
      toJS: () => JSON.parse(JSON.stringify(v)),
      toArray: () => wrapped.slice(),
      get: (i) => wrapped[i],
      map: (fn) => wrapped.map(fn),
      forEach: (fn) => wrapped.forEach(fn),
      isEmpty: () => v.length === 0,
    };
  }
  if (v && typeof v === "object") {
    const keys = Object.keys(v);
    return {
      __map: true,
      size: keys.length,
      toJS: () => JSON.parse(JSON.stringify(v)),
      get: (k) => imm(v[k]),
      has: (k) => Object.prototype.hasOwnProperty.call(v, k),
      keySeq: () => keys,
      isEmpty: () => keys.length === 0,
    };
  }
  return v;
}

function makeEntry(data) {
  return {
    getIn(p) {
      let cur = { data };
      for (const k of p) {
        if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
        cur = cur[k];
      }
      return imm(cur);
    },
    get(k) {
      return imm(k === "data" ? data : undefined);
    },
  };
}

// -> { templates: { name: spec }, styles: [..] }  (throws when previews.js fails to load)
function loadPreviews(file) {
  const templates = {};
  const styles = [];
  const CMS = {
    registerPreviewTemplate(name, comp) {
      templates[name] = comp;
    },
    registerPreviewStyle(s) {
      styles.push(s);
    },
    registerWidget() {},
    registerEditorComponent() {},
    registerEventListener() {},
  };
  const sandbox = { CMS, createClass: (s) => s, h: makeH(), console, window: {} };
  vm.createContext(sandbox);
  // cms/index.html loads contrast.js (a plain script that defines window.CoveredContrast) before previews.js
  const contrast = path.join(path.dirname(file), "contrast.js");
  if (fs.existsSync(contrast)) {
    vm.runInContext(fs.readFileSync(contrast, "utf8"), sandbox, { filename: contrast, timeout: 5000 });
    sandbox.window.CoveredContrast = sandbox.CoveredContrast;
  }
  vm.runInContext(fs.readFileSync(file, "utf8"), sandbox, { filename: file, timeout: 5000 });
  return { templates, styles };
}

function render(comp, data) {
  const inst = Object.create(comp);
  inst.props = {
    entry: makeEntry(data),
    getAsset: (p) => ({ toString: () => String(p), url: String(p) }),
    widgetFor: () => null,
    widgetsFor: () => [],
    fieldsMetaData: imm({}),
    collection: imm({}),
    document: undefined,
  };
  return inst.render();
}

// Everything the preview shows: text, attribute strings, raw-HTML sinks.
function flatten(node, out, trail) {
  out = out || { text: [], attrs: [], html: [], links: [] };
  trail = trail || [];
  if (node === null || node === undefined || node === false || node === true) return out;
  if (typeof node === "string" || typeof node === "number") {
    out.text.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    node.forEach((n) => flatten(n, out, trail));
    return out;
  }
  if (typeof node !== "object") return out;
  const here = trail.concat(typeof node.tag === "string" ? node.tag : "component");
  const props = node.props || {};
  const cls = typeof props.className === "string" ? props.className.split(/\s+/)[0] : "";
  for (const [k, v] of Object.entries(props)) {
    if (k === "dangerouslySetInnerHTML") out.html.push({ html: String(v && v.__html), tag: node.tag, cls, trail: here });
    else if (typeof v === "string") {
      out.attrs.push({ name: k, value: v, tag: node.tag });
      if (/^(href|src|srcSet|action|formAction|xlinkHref|poster|data)$/.test(k)) out.links.push({ name: k, value: v, tag: node.tag });
    }
  }
  (node.kids || []).forEach((k) => flatten(k, out, here));
  return out;
}

// ---------------------------------------------------------------- data variants
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mapLeaves(v, fn) {
  if (Array.isArray(v)) return v.map((x) => mapLeaves(x, fn));
  if (v && typeof v === "object") {
    const o = {};
    for (const k of Object.keys(v)) o[k] = mapLeaves(v[k], fn);
    return o;
  }
  return fn(v);
}
function mapArrays(v, fn) {
  if (Array.isArray(v)) return fn(v.map((x) => mapArrays(x, fn)));
  if (v && typeof v === "object") {
    const o = {};
    for (const k of Object.keys(v)) o[k] = mapArrays(v[k], fn);
    return o;
  }
  return v;
}
function dropRandom(v, rnd, p) {
  if (Array.isArray(v)) return v.filter(() => rnd() > p).map((x) => dropRandom(x, rnd, p));
  if (v && typeof v === "object") {
    const o = {};
    for (const k of Object.keys(v)) if (rnd() > p) o[k] = dropRandom(v[k], rnd, p);
    return o;
  }
  return v;
}

// -> [{ label, data }]
function variants(data) {
  const out = [{ label: "real data", data }];
  out.push({ label: "empty entry {}", data: {} });
  out.push({ label: "every string empty", data: mapLeaves(data, (x) => (typeof x === "string" ? "" : x)) });
  out.push({ label: "every value null", data: mapLeaves(data, () => null) });
  out.push({ label: "every list empty", data: mapArrays(data, () => []) });
  out.push({ label: "very long strings", data: mapLeaves(data, (x) => (typeof x === "string" && x ? x + " " + "long words keep coming ".repeat(60) : x)) });
  out.push({ label: "numbers as huge / negative", data: mapLeaves(data, (x) => (typeof x === "number" ? -987654321.5 : x)) });
  for (const seed of [1, 2, 3, 4, 5, 6]) out.push({ label: "random keys and items removed (seed " + seed + ")", data: dropRandom(data, mulberry32(seed), 0.35) });
  // an older entry that predates one field: drop each key (top level, then one level down)
  if (data && typeof data === "object" && !Array.isArray(data)) {
    for (const k of Object.keys(data)) {
      const d = Object.assign({}, data);
      delete d[k];
      out.push({ label: "key '" + k + "' missing", data: d });
      if (data[k] && typeof data[k] === "object" && !Array.isArray(data[k])) {
        for (const k2 of Object.keys(data[k])) {
          const d2 = Object.assign({}, data, { [k]: Object.assign({}, data[k]) });
          delete d2[k][k2];
          out.push({ label: "key '" + k + "." + k2 + "' missing", data: d2 });
        }
      }
    }
  }
  return out;
}

module.exports = { loadPreviews, render, flatten, variants, mapLeaves, makeEntry, imm };
