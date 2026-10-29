"use strict";
// Computes, for a node of a built page, the handful of style values the accessibility gate needs:
// text colour, background layers, opacity, font size / weight, whether it is hidden, the focus
// outline. It cascades the page's own stylesheets (specificity, order, !important, inline style,
// custom properties with var(), inheritance) on top of a tiny user-agent sheet. Colours keep their
// PROVENANCE: a value that came from `var(--ink-soft)` is remembered as the theme role "--ink-soft",
// which is how the report can say "Secondary text on Page background" instead of two hex codes.

const { parseStylesheet, parseDecls, matchComplex, mediaActive, splitTop, tokensTop, classesOf, parentEl } = require("./a11y-css");
const { parseColor, toHex } = require("../../cms/contrast.js");

const UA_CSS = `
head, script, style, template, meta, link, title, noscript, datalist, area { display: none }
[hidden] { display: none }
input[type=hidden] { display: none }
h1 { font-size: 2em; font-weight: 700 } h2 { font-size: 1.5em; font-weight: 700 } h3 { font-size: 1.17em; font-weight: 700 }
h4 { font-weight: 700 } h5 { font-size: .83em; font-weight: 700 } h6 { font-size: .67em; font-weight: 700 }
b, strong, th { font-weight: 700 }
small { font-size: .83em } sub, sup { font-size: .83em }
a:any-link { color: #0000EE }
button, input[type=submit], input[type=button], input[type=reset] { color: #000000; background-color: #EFEFEF; font-size: 13.3333px; font-weight: 400 }
input, textarea, select { color: #000000; background-color: #FFFFFF; font-size: 13.3333px; font-weight: 400 }
`;
let uaCache = null;
function uaSheet() {
  if (!uaCache) uaCache = parseStylesheet(UA_CSS, -100000);
  return uaCache;
}

const BLACK = { c: { r: 0, g: 0, b: 0, a: 1 }, layer: "#000000" };
const FONT_KEYWORDS = { "xx-small": 9, "x-small": 10, small: 13, medium: 16, large: 18, "x-large": 24, "xx-large": 32 };

// ---------------------------------------------------------------- lengths
// "clamp(2.5rem, 5.5vw, 4.2rem)" "0.93rem" "1.2em" "120%" "calc(1rem + 2vw)" -> px, or null
function evalLength(str, env) {
  const s = String(str).trim();
  let i = 0;
  const ws = () => {
    while (i < s.length && /\s/.test(s[i])) i += 1;
  };
  const num = () => {
    const m = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(s.slice(i));
    if (!m) return null;
    i += m[0].length;
    const v = parseFloat(m[0]);
    const u = /^[a-z%]*/i.exec(s.slice(i))[0].toLowerCase();
    i += u.length;
    switch (u) {
      case "": return { v, unitless: true };
      case "px": return { v };
      case "rem": return { v: v * env.rem };
      case "em": return { v: v * env.em };
      case "%": return { v: (v / 100) * env.em };
      case "vw": return { v: (v / 100) * env.vw };
      case "vh":
      case "dvh":
      case "svh":
      case "lvh": return { v: (v / 100) * env.vh };
      case "vmin": return { v: (v / 100) * Math.min(env.vw, env.vh) };
      case "vmax": return { v: (v / 100) * Math.max(env.vw, env.vh) };
      case "pt": return { v: (v * 4) / 3 };
      case "ch": return { v: v * 8 };
      case "ex": return { v: v * 8 };
      default: return null;
    }
  };
  let bad = false;
  const factor = () => {
    ws();
    if (s[i] === "(") {
      i += 1;
      const v = expr();
      ws();
      if (s[i] === ")") i += 1;
      else bad = true;
      return v;
    }
    const f = /^(clamp|min|max|calc)\(/i.exec(s.slice(i));
    if (f) {
      i += f[0].length;
      const args = [];
      for (;;) {
        args.push(expr());
        ws();
        if (s[i] === ",") i += 1;
        else break;
      }
      ws();
      if (s[i] === ")") i += 1;
      else bad = true;
      const vs = args.filter((x) => x !== null);
      if (vs.length !== args.length) return null;
      switch (f[1].toLowerCase()) {
        case "min": return Math.min(...vs);
        case "max": return Math.max(...vs);
        case "clamp": return Math.max(vs[0], Math.min(vs[1], vs[2]));
        default: return vs[0];
      }
    }
    const n = num();
    if (!n) {
      bad = true;
      return null;
    }
    return n.v;
  };
  const term = () => {
    let a = factor();
    for (;;) {
      ws();
      if (s[i] === "*") {
        i += 1;
        const b = factor();
        a = a === null || b === null ? null : a * b;
      } else if (s[i] === "/") {
        i += 1;
        const b = factor();
        a = a === null || b === null || b === 0 ? null : a / b;
      } else return a;
    }
  };
  function expr() {
    let a = term();
    for (;;) {
      ws();
      if ((s[i] === "+" || s[i] === "-") && /\s/.test(s[i + 1] || "")) {
        const op = s[i];
        i += 1;
        const b = term();
        a = a === null || b === null ? null : op === "+" ? a + b : a - b;
      } else return a;
    }
  }
  const out = expr();
  ws();
  return bad || i < s.length || out === null || !isFinite(out) ? null : out;
}

// ---------------------------------------------------------------- var() substitution
function findVar(s, from) {
  const i = s.indexOf("var(", from);
  if (i < 0) return null;
  let depth = 0;
  for (let j = i + 3; j < s.length; j += 1) {
    if (s[j] === "(") depth += 1;
    else if (s[j] === ")") {
      depth -= 1;
      if (depth === 0) return { start: i, end: j + 1, inner: s.slice(i + 4, j) };
    }
  }
  return null;
}
// replaces every var(--x, fallback) with the custom property's value; null when one cannot be resolved
function substitute(s, vars, depth) {
  if ((depth || 0) > 12) return null;
  let out = "";
  let pos = 0;
  for (;;) {
    const v = findVar(s, pos);
    if (!v) break;
    out += s.slice(pos, v.start);
    const comma = splitTop(v.inner, ",");
    const name = comma[0].trim();
    let val = Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : undefined;
    if (val === undefined && comma.length > 1) val = comma.slice(1).join(",").trim();
    if (val === undefined) return null;
    const sub = substitute(val, vars, (depth || 0) + 1);
    if (sub === null) return null;
    out += sub;
    pos = v.end;
  }
  return out + s.slice(pos);
}

// ---------------------------------------------------------------- colours with provenance
// -> { c: {r,g,b,a}, layer } | null.  layer: "--role" for a theme custom property, else a literal colour string
function literalLayer(c) {
  return c.a >= 1 ? toHex(c) : "rgba(" + Math.round(c.r) + ", " + Math.round(c.g) + ", " + Math.round(c.b) + ", " + Math.round(c.a * 1000) / 1000 + ")";
}
function resolveColor(str, vars, current) {
  const s = String(str || "").trim();
  if (!s) return null;
  if (/^currentcolor$/i.test(s)) return current || null;
  const pure = /^var\(\s*(--[\w-]+)\s*(?:,([\s\S]*))?\)$/.exec(s);
  if (pure && findVar(s, 0) && findVar(s, 0).end === s.length) {
    const name = pure[1];
    let val = Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : undefined;
    let viaFallback = false;
    if (val === undefined && pure[2] !== undefined) {
      val = pure[2].trim();
      viaFallback = true;
    }
    if (val === undefined) return null;
    const inner = resolveColor(val, vars, current);
    if (!inner) return null;
    if (viaFallback) return inner;
    return inner.layer.slice(0, 2) === "--" ? inner : { c: inner.c, layer: name };
  }
  const plain = substitute(s, vars);
  if (plain === null) return null;
  const c = parseColor(plain);
  return c ? { c, layer: literalLayer(c) } : null;
}

// ---------------------------------------------------------------- the engine
class Styler {
  // sheets: [cssText]  (in document order);  doc: htmlparser2 document
  constructor(sheets) {
    this.entries = [];
    this.byId = new Map();
    this.byClass = new Map();
    this.byTag = new Map();
    this.universal = [];
    this.info = { reducedMotion: false, keyframes: 0, animations: false, unparsed: 0 };
    this.unsupported = new Map();
    let order = 0;
    const all = [{ rules: uaSheet().rules }];
    for (const css of sheets) {
      const p = parseStylesheet(css, order);
      order = p.order;
      all.push(p);
      if (p.info.reducedMotion) this.info.reducedMotion = true;
      this.info.keyframes += p.info.keyframes;
      if (p.info.animations) this.info.animations = true;
      this.info.unparsed += p.info.unparsed || 0;
    }
    this.rules = [];
    for (const p of all) for (const r of p.rules) this.rules.push(r);
    for (const rule of this.rules) {
      for (const sel of rule.sels) {
        const last = sel.parts[sel.parts.length - 1].c;
        const e = { sel, rule };
        this.entries.push(e);
        if (sel.pe) {
          (this.peEntries || (this.peEntries = [])).push(e);
          continue;
        }
        if (last.id) push(this.byId, last.id, e);
        else if (last.classes.length) push(this.byClass, last.classes[0], e);
        else if (last.tag && last.tag !== "*") push(this.byTag, last.tag, e);
        else this.universal.push(e);
      }
    }
    this.peEntries = this.peEntries || [];
  }

  newCtx(vp, extra) {
    return Object.assign({ vp, hover: new Set(), focus: new Set(), focusVisible: new Set(), active: new Set(), addClass: new Map(), addAttr: new Map(), assume: null, cache: new Map(), mq: new Map() }, extra || {});
  }

  active(rule, ctx) {
    if (!rule.media.length) return true;
    let v = ctx.mq.get(rule);
    if (v === undefined) {
      v = mediaActive(rule.media, ctx.vp);
      ctx.mq.set(rule, v);
    }
    return v;
  }

  candidates(el, ctx) {
    const out = [];
    const id = el.attribs && el.attribs.id;
    if (id && this.byId.has(id)) out.push(...this.byId.get(id));
    for (const c of classesOf(el, ctx)) if (this.byClass.has(c)) out.push(...this.byClass.get(c));
    if (this.byTag.has(el.name)) out.push(...this.byTag.get(el.name));
    out.push(...this.universal);
    return out;
  }

  // property -> { value, rank } for the element (or, with `pe`, for its ::before / ::after)
  cascade(el, ctx, pe) {
    const win = new Map();
    const take = (decls, spec, order, inline, ua) => {
      for (const d of decls) {
        const rank = [d.important ? 1 : 0, ua ? -1 : inline ? 1 : 0, spec[0], spec[1], spec[2], order];
        const cur = win.get(d.prop);
        if (!cur || cmp(rank, cur.rank) >= 0) win.set(d.prop, { value: d.value, rank });
      }
    };
    const list = pe ? this.peEntries.filter((e) => e.sel.pe === pe) : this.candidates(el, ctx);
    for (const e of list) {
      if (!this.active(e.rule, ctx)) continue;
      if (matchComplex(el, e.sel, e.sel.parts.length - 1, ctx, [], this.unsupported)) take(e.rule.decls, e.sel.spec, e.rule.order, false, e.rule.ua);
    }
    if (!pe && el.attribs && el.attribs.style) take(parseDecls(el.attribs.style), [0, 0, 0], 0, true);
    return win;
  }

  computed(el, ctx) {
    let st = ctx.cache.get(el);
    if (st) return st;
    const parent = parentEl(el);
    const ps = parent ? this.computed(parent, ctx) : null;
    const cs = this.cascade(el, ctx, "");
    const val = (p) => (cs.has(p) ? cs.get(p).value : undefined);
    const inherit = (v) => v === undefined || /^(inherit|unset)$/i.test(v);

    const vars = ps ? Object.assign({}, ps.vars) : {};
    for (const [p, d] of cs) if (p.slice(0, 2) === "--") vars[p] = d.value;

    // font
    const fs = val("font-size");
    const em = ps ? ps.fontPx : 16;
    let fontPx = em;
    if (fs !== undefined && !/^(inherit|unset)$/i.test(fs)) {
      const sub = substitute(fs, vars);
      const kw = sub && FONT_KEYWORDS[sub.trim().toLowerCase()];
      if (kw) fontPx = kw;
      else if (sub && /^smaller$/i.test(sub.trim())) fontPx = em / 1.2;
      else if (sub && /^larger$/i.test(sub.trim())) fontPx = em * 1.2;
      else {
        const px = sub === null ? null : evalLength(sub, { rem: 16, em, vw: ctx.vp.w, vh: ctx.vp.h });
        if (px !== null) fontPx = px;
      }
    }
    let weight = ps ? ps.weight : 400;
    const fw = val("font-weight");
    if (fw !== undefined && !/^(inherit|unset)$/i.test(fw)) {
      const t = fw.trim().toLowerCase();
      weight = t === "bold" ? 700 : t === "normal" ? 400 : t === "bolder" ? Math.min(900, weight + 300) : t === "lighter" ? Math.max(100, weight - 300) : parseInt(t, 10) || weight;
    }

    // colour
    const parentColor = ps ? ps.color : BLACK;
    let color = parentColor;
    const cv = val("color");
    if (!inherit(cv)) {
      const r = resolveColor(cv, vars, parentColor);
      color = r || { c: null, layer: null, unknown: cv };
    }
    // SVG text is painted with `fill`
    let fill = ps ? ps.fill : null;
    const fv = val("fill") !== undefined ? val("fill") : el.attribs && el.attribs.fill;
    if (fv !== undefined && !/^(inherit|unset)$/i.test(fv)) {
      if (/^none$/i.test(fv.trim())) fill = { none: true };
      else fill = resolveColor(fv, vars, color) || { c: null, layer: null, unknown: fv };
    }

    // background
    let bg = null;
    const bv = val("background-color");
    if (bv !== undefined && !/^(transparent|none|initial)$/i.test(bv.trim())) {
      bg = resolveColor(bv, vars, color) || { c: null, layer: null, unknown: bv };
    }
    const images = [];
    const bi = val("background-image");
    if (bi !== undefined && !/^(none|initial)$/i.test(bi.trim())) {
      const subst = substitute(bi, vars);
      for (const layer of splitTop(subst === null ? bi : subst, ",")) {
        const t = layer.trim();
        if (/^url\(/i.test(t) || /^image-set\(/i.test(t)) images.push({ picture: true });
        else if (/gradient\(/i.test(t)) images.push({ stops: gradientStops(t, vars, color) });
        else if (t) images.push({ picture: true });
      }
    }

    // opacity
    let opacity = 1;
    const ov = val("opacity");
    if (ov !== undefined && !inherit(ov)) {
      const sub = substitute(ov, vars) || ov;
      const n = /%$/.test(sub.trim()) ? parseFloat(sub) / 100 : parseFloat(sub);
      if (isFinite(n)) opacity = Math.max(0, Math.min(1, n));
    }
    const opacityAcc = (ps ? ps.opacityAcc : 1) * opacity;

    // visibility
    const display = (val("display") || "").trim().toLowerCase();
    let visibility = ps ? ps.visibility : "visible";
    const vv = val("visibility");
    if (vv !== undefined && !inherit(vv)) visibility = vv.trim().toLowerCase();
    const hidden = (ps ? ps.hidden : false) || display === "none";
    const clip = (val("clip") || "").replace(/\s|,/g, "");
    const srOnlySelf = /^rect\(0(px)?0(px)?0(px)?0(px)?\)$/.test(clip) || /^inset\(50%\)$/.test((val("clip-path") || "").replace(/\s/g, ""));

    // outline
    const outline = { style: (val("outline-style") || "none").trim().toLowerCase(), width: val("outline-width") || "medium", color: null, offset: val("outline-offset") || "0" };
    const oc = val("outline-color");
    outline.color = oc === undefined || /^(currentcolor|invert)$/i.test(oc.trim()) ? color : resolveColor(oc, vars, color) || { c: null, layer: null, unknown: oc };

    const srOnly = srOnlySelf || (ps ? ps.srOnly : false);
    st = { fontPx, weight, color, fill, bg, images, opacity, opacityAcc, visibility, hidden, srOnly, vars, outline, display, tag: el.name };
    ctx.cache.set(el, st);
    return st;
  }

  // ::before / ::after of an element -> { text, color, fontPx, bold } | null when it prints no text
  pseudoText(el, ctx, which, base) {
    const cs = this.cascade(el, ctx, which);
    if (!cs.has("content")) return null;
    const raw = cs.get("content").value;
    const m = /^(?:"((?:\\[\s\S]|[^"\\])*)"|'((?:\\[\s\S]|[^'\\])*)')$/.exec(raw.trim());
    if (!m) return null;
    const text = (m[1] !== undefined ? m[1] : m[2]).replace(/\\([0-9a-fA-F]{1,6})\s?|\\([\s\S])/g, (x, hex, ch) => (hex ? String.fromCodePoint(parseInt(hex, 16)) : ch));
    if (!text.trim()) return null;
    const get = (p) => (cs.has(p) ? cs.get(p).value : undefined);
    const vars = base.vars;
    let color = base.color;
    const cv = get("color");
    if (cv !== undefined && !/^(inherit|unset)$/i.test(cv)) color = resolveColor(cv, vars, base.color) || { c: null, layer: null, unknown: cv };
    let fontPx = base.fontPx;
    const fs = get("font-size");
    if (fs !== undefined) {
      const sub = substitute(fs, vars);
      const px = sub === null ? null : evalLength(sub, { rem: 16, em: base.fontPx, vw: ctx.vp.w, vh: ctx.vp.h });
      if (px !== null) fontPx = px;
    }
    let weight = base.weight;
    const fw = get("font-weight");
    if (fw !== undefined) weight = /bold/i.test(fw) ? 700 : parseInt(fw, 10) || weight;
    const disp = (get("display") || "").trim();
    if (disp === "none") return null;
    return { text, color, fontPx, weight };
  }
}

function push(map, key, e) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(e);
}
function cmp(a, b) {
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

// colour stops of a gradient: [{c, layer}]  (direction, angles and positions are ignored)
function gradientStops(text, vars, current) {
  const open = text.indexOf("(");
  const inner = text.slice(open + 1, text.lastIndexOf(")"));
  const stops = [];
  for (const arg of splitTop(inner, ",")) {
    for (const tok of tokensTop(arg.trim())) {
      if (/^(to|at|from|in|circle|ellipse|closest|farthest)/i.test(tok) || /^[-+]?[\d.]+(deg|turn|rad|grad|%|px|em|rem)?$/i.test(tok)) continue;
      const sub = substitute(tok, vars);
      const r = resolveColor(tok, vars, current) || (sub ? resolveColor(sub, vars, current) : null);
      if (r) stops.push(r);
    }
  }
  return stops;
}

module.exports = { Styler, evalLength, resolveColor, substitute, literalLayer, BLACK };
