"use strict";
// Finds every text / background pairing of one built page and says which theme colour roles it is made of.
//
// For each visible piece of text it asks the style engine (a11y-style.js) for the text colour, then walks
// up the tree to find what is painted behind it (layers of background colours, gradient stops, pictures).
// It repeats that for the states a visitor can put the page in: hover, keyboard focus, pressed, and the
// classes the page's scripts toggle (see `stateClasses` in scripts/a11y-config.json), at a wide and a narrow
// screen. The result is a list of unique pairs { fg, bg[], kind } with the places they were found.

const { parentEl, elementKids } = require("./a11y-css");
const { literalLayer } = require("./a11y-style");
const { collapse } = require("./util");

const VIEWPORTS = [{ w: 1280, h: 800, name: "wide" }, { w: 360, h: 640, name: "narrow" }];
const SKIP_TAGS = new Set(["script", "style", "noscript", "template", "head", "title", "meta", "link", "option", "optgroup", "datalist"]);
const NON_TEXT_INPUT = /^(hidden|checkbox|radio|file|range|color|image|reset|submit|button)$/i;

// the identity of a pairing: text colour, the background stack under it, size class, focus-ring alternative
function pairKey(fg, bgLayers, kind, altLayers, what) {
  return fg + " | " + bgLayers.join(" > ") + " | " + kind + (altLayers ? " | alt " + altLayers.join(" > ") : "") + (what === "decorative symbol" ? " | soft" : "") + (what === "focus ring" ? " | ring" : "");
}

function describe(n) {
  const cls = n.attribs && n.attribs.class ? "." + n.attribs.class.split(/\s+/).filter(Boolean).slice(0, 2).join(".") : "";
  const id = n.attribs && n.attribs.id ? "#" + n.attribs.id : "";
  return n.name + id + cls;
}
function ownText(n) {
  let t = "";
  for (const k of n.children || []) if (k.type === "text") t += k.data;
  return collapse(t);
}
function hasLetters(t) {
  return /[\p{L}\p{N}]/u.test(t);
}
function walk(n, fn) {
  fn(n);
  for (const k of elementKids(n)) walk(k, fn);
}
function inSvg(n) {
  for (let p = n; p; p = parentEl(p)) if (p.name === "svg") return true;
  return false;
}

// ---------------------------------------------------------------- what is behind an element
// -> [{ layers: [string], picture: bool, unknown: string|null }]  (several options when a gradient is involved)
function backgroundOptions(styler, el, ctx, themeVars) {
  const chain = [];
  let unknown = null;
  for (let n = el; n; n = parentEl(n)) {
    const s = styler.computed(n, ctx);
    chain.push(s);
    if (s.bg && !s.bg.c) {
      unknown = s.bg.unknown;
      break;
    }
    if (s.bg && s.bg.c.a >= 1) break;
  }
  let options = [{ layers: [], picture: false, unknown }];
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    const s = chain[i];
    if (s.bg && s.bg.c) for (const o of options) o.layers.push(layerOf(s.bg, themeVars));
    for (const img of s.images.slice().reverse()) {
      if (img.picture) {
        for (const o of options) o.picture = true;
      } else if (img.stops && img.stops.length) {
        const next = [];
        const seen = new Set();
        for (const o of options) {
          for (const stop of img.stops) {
            const layers = stop.c.a <= 0 ? o.layers.slice() : o.layers.concat(layerOf(stop, themeVars));
            const key = layers.join("|");
            if (seen.has(key)) continue;
            seen.add(key);
            next.push({ layers, picture: o.picture, unknown: o.unknown });
          }
        }
        options = next.slice(0, 12);
      }
    }
  }
  return options;
}

// a colour with provenance -> the layer string (theme role when the role is a theme colour)
function layerOf(col, themeVars) {
  if (col.layer && col.layer.slice(0, 2) === "--" && themeVars.has(col.layer)) return col.layer;
  return literalLayer(col.c);
}
function fgLayer(col, opacity, themeVars) {
  if (col.layer && col.layer.slice(0, 2) === "--" && themeVars.has(col.layer) && col.c.a >= 1) return opacity < 1 ? col.layer + "@" + Math.round(opacity * 1000) / 1000 : col.layer;
  return literalLayer({ r: col.c.r, g: col.c.g, b: col.c.b, a: col.c.a * opacity });
}

// ---------------------------------------------------------------- analysis of one page
// opts: { themeVars:Set<"--name">, stateClasses:[string], url, doc, styler }
// -> { pairs: Map(key -> pair), unresolved: [..], stats }
function analysePage(opts) {
  const { doc, styler, url } = opts;
  const themeVars = opts.themeVars;
  const pairs = opts.pairs || new Map();
  const unresolved = opts.unresolved || [];
  const stats = { texts: 0, variants: 0 };

  const add = (fg, options, kind, what, state, el, text, vpName, alt) => {
    for (const o of options) {
      if (o.unknown) {
        unresolved.push({ url, where: describe(el), why: "background '" + o.unknown + "' is not a colour this check can read" });
        continue;
      }
      const altLayers = alt && alt[0] && !alt[0].unknown ? (alt[0].layers.length ? alt[0].layers : ["#FFFFFF"]) : null;
      const bgLayers = o.layers.length ? o.layers : ["#FFFFFF"];
      const key = pairKey(fg, bgLayers, kind, altLayers, what);
      let p = pairs.get(key);
      if (!p) {
        p = { key, fg, bg: bgLayers, k: kind, what, alt: altLayers || undefined, soft: what === "decorative symbol", picture: false, states: new Set(), places: [], pages: new Set(), vps: new Set() };
        pairs.set(key, p);
      }
      if (o.picture) p.picture = true;
      p.states.add(state || "");
      p.pages.add(url);
      p.vps.add(vpName);
      if (p.places.length < 4 && !p.places.some((x) => x.desc === describe(el) && x.url === url)) p.places.push({ url, desc: describe(el), text: text.slice(0, 40), state: state || "" });
    }
  };

  const exempt = (el) => {
    if (!opts.exempt || !opts.exempt.length) return false;
    const plain = styler.newCtx(VIEWPORTS[0]);
    for (let n = el; n; n = parentEl(n)) for (const sel of opts.exempt) if (matchSel(styler, n, sel, plain, [])) return true;
    return false;
  };
  const processElement = (el, ctx, state, vp, rangeRoot) => {
    if (SKIP_TAGS.has(el.name)) return;
    if (exempt(el)) return;
    const st = styler.computed(el, ctx);
    if (st.hidden || st.visibility !== "visible" || st.opacityAcc <= 0 || st.srOnly) return;
    const svgText = inSvg(el);
    const isField = (el.name === "input" && !NON_TEXT_INPUT.test((el.attribs || {}).type || "text")) || el.name === "textarea" || el.name === "select";
    const submitLike = el.name === "input" && /^(submit|button|reset)$/i.test((el.attribs || {}).type || "") && (el.attribs || {}).value;
    let text = ownText(el);
    if (svgText && !/^(text|tspan)$/.test(el.name)) text = "";
    if (isField && el.name !== "textarea") text = text || "(typed text)";
    if (submitLike) text = el.attribs.value;
    const opacity = st.opacityAcc;
    let options = null;
    const bgFor = () => options || (options = backgroundOptions(styler, el, ctx, themeVars));
    const large = st.fontPx >= 24 || (st.fontPx >= 18.66 && st.weight >= 700);

    if (text) {
      const col = svgText ? (st.fill && !st.fill.none ? st.fill : svgText && !st.fill ? { c: { r: 0, g: 0, b: 0, a: 1 }, layer: "#000000" } : null) : st.color;
      if (col) {
        if (!col.c) unresolved.push({ url, where: describe(el), why: "text colour '" + col.unknown + "' is not a colour this check can read" });
        else {
          stats.texts += 1;
          add(fgLayer(col, opacity, themeVars), bgFor(), hasLetters(text) ? (large ? "l" : "t") : "u", hasLetters(text) ? "text" : "symbol", state, el, text, vp.name);
        }
      }
    }
    if (isField && (el.attribs || {}).placeholder) {
      const pcs = styler.cascade(el, ctx, "placeholder");
      let col = { c: { r: 117, g: 117, b: 117, a: 1 }, layer: "#757575" };
      if (pcs.has("color")) {
        const { resolveColor } = require("./a11y-style");
        col = resolveColor(pcs.get("color").value, st.vars, st.color) || col;
      }
      add(fgLayer(col, opacity, themeVars), bgFor(), "t", "placeholder", state, el, el.attribs.placeholder, vp.name);
    }
    for (const which of ["before", "after"]) {
      const pt = styler.pseudoText(el, ctx, which, st);
      if (!pt || !pt.color || !pt.color.c) continue;
      const big = pt.fontPx >= 24 || (pt.fontPx >= 18.66 && pt.weight >= 700);
      add(fgLayer(pt.color, opacity, themeVars), bgFor(), hasLetters(pt.text) ? (big ? "l" : "t") : "u", hasLetters(pt.text) ? "text" : "decorative symbol", state, el, "::" + which + " " + pt.text, vp.name);
    }
    void rangeRoot;
  };

  const processSubtree = (root, ctx, state, vp) => {
    walk(root, (el) => processElement(el, ctx, state, vp, root));
  };

  const body = findBody(doc);
  if (!body) return { pairs, unresolved, stats };

  for (const vp of VIEWPORTS) {
    const base = styler.newCtx(vp);
    walk(findRoot(doc), (el) => processElement(el, base, "", vp));
    focusRings(base, vp);
    discoverVariants(vp, base);
  }

  // keyboard focus: the outline of every control against what is behind it
  function focusRings(base, vp) {
    const seenDesc = new Set();
    walk(body, (el) => {
      if (!isInteractive(el)) return;
      const st0 = styler.computed(el, base);
      if (st0.hidden || st0.visibility !== "visible" || st0.opacityAcc <= 0) return;
      const ctx = styler.newCtx(vp, { focus: new Set([el]), focusVisible: new Set([el]) });
      const st = styler.computed(el, ctx);
      const o = st.outline;
      const width = parseFloat(o.width) || (/^(thin|medium|thick)$/i.test(o.width) ? 2 : 0);
      if (!o.style || o.style === "none" || o.style === "hidden" || width <= 0) {
        // no outline: fine when the control restyles itself some other way, which we cannot judge -> a note
        const key = describe(el);
        if (!seenDesc.has(key)) {
          seenDesc.add(key);
          (opts.noRing || (opts.noRing = [])).push({ url, where: key });
        }
        return;
      }
      if (!o.color || !o.color.c) return;
      const offset = parseFloat(o.offset) || 0;
      const around = offset >= 0 && parentEl(el) ? parentEl(el) : el;
      const inner = backgroundOptions(styler, el, ctx, themeVars);
      add(fgLayer(o.color, 1, themeVars), backgroundOptions(styler, around, ctx, themeVars), "u", "focus ring", ":focus-visible", el, "keyboard focus ring", vp.name, around === el || offset >= 1 ? null : inner);
    });
  }

  // hover / focus / pressed states and toggled classes
  function discoverVariants(vp, base) {
    const assume = styler.newCtx(vp, { assume: { classes: new Set(opts.stateClasses || []), states: true } });
    const want = styler.entries.filter((e) => e.sel.parts.some((p) => p.c.pseudos.some((q) => /^(hover|focus|focus-visible|active)$/.test(q.name)) || p.c.classes.some((c) => (opts.stateClasses || []).includes(c)) || p.c.attrs.some((a) => /^(aria-|data-)/.test(a.name))));
    const found = new Map();
    walk(body, (el) => {
      for (const e of want) {
        if (!styler.active(e.rule, assume)) continue;
        const used = [];
        if (!matchSel(styler, el, e.sel, assume, used)) continue;
        for (const u of used) {
          if (u.node.name === "body" || u.node.name === "html") continue;
          const k = u.kind + "|" + (u.name || "") + "|" + (u.value || "") + "|" + nodeId(u.node);
          if (!found.has(k)) found.set(k, u);
        }
      }
    });
    let n = 0;
    for (const u of found.values()) {
      if (n >= 4000) break;
      n += 1;
      const ctx = styler.newCtx(vp);
      let label;
      if (u.kind === "hover" || u.kind === "active") {
        for (let p = u.node; p; p = parentEl(p)) ctx.hover.add(p);
        if (u.kind === "active") ctx.active.add(u.node);
        label = ":" + u.kind;
      } else if (u.kind === "focus" || u.kind === "focus-visible") {
        ctx.focus.add(u.node);
        ctx.focusVisible.add(u.node);
        label = ":" + u.kind;
      } else if (u.kind === "class") {
        ctx.addClass.set(u.node, new Set([u.name]));
        label = "." + u.name;
      } else {
        ctx.addAttr.set(u.node, { [u.name]: u.value });
        label = "[" + u.name + "=" + u.value + "]";
      }
      stats.variants += 1;
      processSubtree(u.node, ctx, label, vp);
      // an element that is shown or hidden by the state has an ancestor chain that changed too
    }
    void base;
  }

  return { pairs, unresolved, stats, noRing: opts.noRing || [] };
}

const nodeIds = new WeakMap();
let nodeCounter = 0;
function nodeId(n) {
  if (!nodeIds.has(n)) nodeIds.set(n, (nodeCounter += 1));
  return nodeIds.get(n);
}
function matchSel(styler, el, sel, ctx, used) {
  return require("./a11y-css").matchComplex(el, sel, sel.parts.length - 1, ctx, used, styler.unsupported);
}
function findRoot(doc) {
  for (const k of doc.children || []) if (k.type === "tag" && k.name === "html") return k;
  return doc.children.find((k) => k.type === "tag") || doc;
}
function findBody(doc) {
  let body = null;
  walk(findRoot(doc), (n) => {
    if (!body && n.name === "body") body = n;
  });
  return body;
}
function isInteractive(el) {
  const a = el.attribs || {};
  if (el.name === "a" || el.name === "area") return a.href !== undefined;
  if (el.name === "input") return !/^hidden$/i.test(a.type || "");
  if (/^(button|select|textarea|summary)$/.test(el.name)) return a.disabled === undefined;
  return a.tabindex !== undefined && parseInt(a.tabindex, 10) >= 0;
}

module.exports = { analysePage, VIEWPORTS, describe, pairKey };
