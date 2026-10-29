"use strict";
// A small CSS reader for the accessibility gate: parses a stylesheet into rules, parses selectors
// (with specificity) and matches them against htmlparser2 nodes. It understands exactly what a site
// like this one writes (classes, ids, attributes, descendant / child / sibling combinators, :not(),
// :is(), :nth-child(), :hover / :focus-visible ..., ::before / ::after, @media, @supports) and does
// NOT try to be a browser: a selector it cannot read never matches and is counted in `unsupported`
// so a reviewer can see it (the gate prints the count).

const KEYFRAME_LIKE = /^@(-webkit-)?(keyframes|font-face|page|property|counter-style|font-feature-values|viewport)\b/i;
const BLOCK_AT = /^@(media|supports|layer|container|document)\b/i;

// ---------------------------------------------------------------- low-level scanning
function stripComments(css) {
  let out = "";
  for (let i = 0; i < css.length; i += 1) {
    const c = css[i];
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < css.length && css[j] !== c) j += css[j] === "\\" ? 2 : 1;
      out += css.slice(i, j + 1);
      i = j;
    } else if (c === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      i = end < 0 ? css.length : end + 1;
      out += " ";
    } else out += c;
  }
  return out;
}

// splits `text` on a separator char outside (), [] and strings
function splitTop(text, sep) {
  const out = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === "\\" ? 2 : 1;
      cur += text.slice(i, j + 1);
      i = j;
      continue;
    }
    if (c === "(" || c === "[") depth += 1;
    else if (c === ")" || c === "]") depth -= 1;
    if (c === sep && depth <= 0) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

// splits on whitespace outside brackets / strings
function tokensTop(text) {
  const out = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === "\\" ? 2 : 1;
      cur += text.slice(i, j + 1);
      i = j;
      continue;
    }
    if (c === "(") depth += 1;
    else if (c === ")") depth -= 1;
    if (/\s/.test(c) && depth <= 0) {
      if (cur) out.push(cur);
      cur = "";
    } else cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

function matchingBrace(css, open) {
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    const c = css[i];
    if (c === '"' || c === "'") {
      i += 1;
      while (i < css.length && css[i] !== c) i += css[i] === "\\" ? 2 : 1;
    } else if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return css.length;
}

// ---------------------------------------------------------------- declarations
// -> [{ prop, value, important }]  with the shorthands this gate cares about expanded
function parseDecls(body) {
  const out = [];
  for (const part of splitTop(body, ";")) {
    const i = part.indexOf(":");
    if (i < 0) continue;
    const prop = part.slice(0, i).trim().toLowerCase();
    let value = part.slice(i + 1).trim();
    if (!prop || !value) continue;
    let important = false;
    const im = /\s*!\s*important\s*$/i.exec(value);
    if (im) {
      important = true;
      value = value.slice(0, im.index).trim();
    }
    expand(prop, value, important, out);
  }
  return out;
}

const IMAGE_TOKEN = /^(url\(|(repeating-)?(linear|radial|conic)-gradient\(|image-set\(|-webkit-)/i;
const BG_WORDS = /^(no-repeat|repeat|repeat-x|repeat-y|space|round|center|top|bottom|left|right|cover|contain|fixed|scroll|local|border-box|padding-box|content-box|auto|\/)$/i;

function expand(prop, value, important, out) {
  const push = (p, v) => out.push({ prop: p, value: v, important });
  if (prop === "background") {
    let color = "transparent";
    const images = [];
    // layers are separated by top-level commas; the colour is allowed in the last one only
    for (const layer of splitTop(value, ",")) {
      for (const t of tokensTop(layer)) {
        if (/^none$/i.test(t)) continue;
        if (IMAGE_TOKEN.test(t)) images.push(t);
        else if (BG_WORDS.test(t) || /^-?[\d.]+(px|%|em|rem|vw|vh)?$/.test(t) || /^[\d.]+(px|%|em|rem)?\/.+/.test(t)) continue;
        else color = t;
      }
    }
    push("background-color", color);
    push("background-image", images.length ? images.join(", ") : "none");
  } else if (prop === "outline") {
    let color = "currentcolor";
    let style = "none";
    let width = "medium";
    for (const t of tokensTop(value)) {
      if (/^(none|auto|solid|dashed|dotted|double|groove|ridge|inset|outset|hidden)$/i.test(t)) style = t.toLowerCase();
      else if (/^[\d.]+(px|em|rem)?$/.test(t) || /^(thin|medium|thick)$/i.test(t)) width = t;
      else color = t;
    }
    push("outline-color", color);
    push("outline-style", style);
    push("outline-width", width);
  } else if (prop === "font") {
    // [style] [variant] [weight] size[/line-height] family
    const toks = tokensTop(value);
    for (const t of toks) {
      if (/^(bold|bolder|[1-9]00)$/i.test(t)) push("font-weight", t);
      else if (/^normal$/i.test(t)) continue;
      else if (/^[\d.]+(px|rem|em|%|pt)(\/.*)?$/i.test(t) || /^(clamp|min|max|calc)\(/i.test(t)) {
        push("font-size", t.split("/")[0]);
        break;
      }
    }
  } else if (prop === "opacity" || prop === "color" || prop === "display" || prop === "visibility") push(prop, value);
  else if (prop === "inset" || prop === "margin" || prop === "padding") return;
  else push(prop, value);
}

// ---------------------------------------------------------------- selectors
// compound: { tag, id, classes[], attrs[{name, op, value}], pseudos[{name, arg}], pe }
function parseNth(arg) {
  const s = arg.replace(/\s+/g, "").toLowerCase();
  if (s === "odd") return { a: 2, b: 1 };
  if (s === "even") return { a: 2, b: 0 };
  const m = /^([+-]?\d*)n([+-]\d+)?$/.exec(s);
  if (m) return { a: m[1] === "" || m[1] === "+" ? 1 : m[1] === "-" ? -1 : parseInt(m[1], 10), b: m[2] ? parseInt(m[2], 10) : 0 };
  if (/^[+-]?\d+$/.test(s)) return { a: 0, b: parseInt(s, 10) };
  return null;
}

const SPEC_ZERO = [0, 0, 0];
function addSpec(x, y) {
  return [x[0] + y[0], x[1] + y[1], x[2] + y[2]];
}
function maxSpec(list) {
  return list.reduce((m, s) => (s[0] > m[0] || (s[0] === m[0] && (s[1] > m[1] || (s[1] === m[1] && s[2] > m[2]))) ? s : m), SPEC_ZERO);
}

// one complex selector -> { parts: [{comb, c}], spec, pe, text } | null when it cannot be read
function parseSelector(text, note) {
  const src = text.trim();
  if (!src) return null;
  const parts = [];
  let spec = [0, 0, 0];
  let pe = "";
  let i = 0;
  let comb = null;
  const n = src.length;
  const ident = () => {
    let j = i;
    while (j < n && /[\w\- -￿\\]/.test(src[j])) j += src[j] === "\\" ? 2 : 1;
    const s = src.slice(i, j).replace(/\\(.)/g, "$1");
    i = j;
    return s;
  };
  while (i < n) {
    // combinator
    let sawSpace = false;
    while (i < n && /\s/.test(src[i])) {
      sawSpace = true;
      i += 1;
    }
    if (i >= n) break;
    if (/[>+~]/.test(src[i])) {
      comb = src[i];
      i += 1;
      while (i < n && /\s/.test(src[i])) i += 1;
    } else if (sawSpace && parts.length) comb = " ";
    const c = { tag: "", id: "", classes: [], attrs: [], pseudos: [] };
    let any = false;
    for (;;) {
      const ch = src[i];
      if (ch === "*") {
        c.tag = "*";
        i += 1;
        any = true;
      } else if (ch === "#") {
        i += 1;
        c.id = ident();
        spec[0] += 1;
        any = true;
      } else if (ch === ".") {
        i += 1;
        c.classes.push(ident());
        spec[1] += 1;
        any = true;
      } else if (ch === "[") {
        const end = src.indexOf("]", i);
        if (end < 0) return null;
        const m = /^\s*([\w:-]+)\s*(?:([~|^$*]?=)\s*("([^"]*)"|'([^']*)'|[^\s\]]+)\s*(i)?)?\s*$/.exec(src.slice(i + 1, end));
        if (!m) return null;
        c.attrs.push({ name: m[1].toLowerCase(), op: m[2] || "", value: m[4] !== undefined ? m[4] : m[5] !== undefined ? m[5] : m[3] || "" });
        spec[1] += 1;
        i = end + 1;
        any = true;
      } else if (ch === ":") {
        const dbl = src[i + 1] === ":";
        i += dbl ? 2 : 1;
        const name = ident().toLowerCase();
        let arg = null;
        if (src[i] === "(") {
          let depth = 0;
          let j = i;
          for (; j < n; j += 1) {
            if (src[j] === "(") depth += 1;
            else if (src[j] === ")") {
              depth -= 1;
              if (depth === 0) break;
            }
          }
          arg = src.slice(i + 1, j);
          i = j + 1;
        }
        any = true;
        if (dbl || /^(before|after|first-line|first-letter)$/.test(name)) {
          pe = name;
          spec[2] += 1;
        } else if (name === "not" || name === "is" || name === "where" || name === "matches" || name === "-webkit-any") {
          const inner = splitTop(arg || "", ",").map((s) => parseSelector(s, note)).filter(Boolean);
          if (!inner.length) return null;
          c.pseudos.push({ name: name === "not" ? "not" : "is", list: inner });
          if (name !== "where") spec = addSpec(spec, maxSpec(inner.map((s) => s.spec)));
        } else if (/^nth-(child|last-child|of-type|last-of-type)$/.test(name)) {
          const nth = parseNth(arg || "");
          if (!nth) return null;
          c.pseudos.push({ name, nth });
          spec[1] += 1;
        } else {
          c.pseudos.push({ name, arg });
          spec[1] += 1;
        }
      } else if (!any && /[A-Za-z_ -￿\\]/.test(ch || "")) {
        c.tag = ident().toLowerCase();
        spec[2] += 1;
        any = true;
      } else break;
    }
    if (!any) return null;
    parts.push({ comb: parts.length ? comb || " " : null, c });
    comb = null;
  }
  if (!parts.length) return null;
  return { parts, spec, pe, text: src };
}

// ---------------------------------------------------------------- stylesheet
// -> { rules: [{ sels: [selector], decls, media: [string], order, pe }], unsupported: Map, hasReducedMotion, keyframes }
function parseStylesheet(css, startOrder) {
  const src = stripComments(String(css));
  const rules = [];
  const info = { reducedMotion: false, keyframes: 0, animations: false };
  let order = startOrder || 0;
  const walk = (text, media) => {
    let i = 0;
    while (i < text.length) {
      while (i < text.length && /\s/.test(text[i])) i += 1;
      if (i >= text.length) break;
      const open = text.indexOf("{", i);
      const semi = text.indexOf(";", i);
      if (text[i] === "@" && semi >= 0 && (open < 0 || semi < open)) {
        i = semi + 1; // @import / @charset
        continue;
      }
      if (open < 0) break;
      const prelude = text.slice(i, open).trim();
      const close = matchingBrace(text, open);
      const body = text.slice(open + 1, close);
      i = close + 1;
      if (prelude[0] === "@") {
        if (/^@(-webkit-)?keyframes\b/i.test(prelude)) info.keyframes += 1;
        if (KEYFRAME_LIKE.test(prelude)) continue;
        if (BLOCK_AT.test(prelude)) {
          if (/^@media\b/i.test(prelude) && /prefers-reduced-motion\s*:\s*reduce/i.test(prelude)) info.reducedMotion = true;
          walk(body, /^@(media|supports)\b/i.test(prelude) ? media.concat(prelude) : media);
        }
        continue;
      }
      const decls = parseDecls(body);
      if (decls.some((d) => /^(animation|animation-name)$/.test(d.prop) && !/^none$/i.test(d.value))) info.animations = true;
      const sels = splitTop(prelude, ",").map((s) => parseSelector(s)).filter(Boolean);
      const dropped = splitTop(prelude, ",").length - sels.length;
      if (dropped) info.unparsed = (info.unparsed || 0) + dropped;
      if (!sels.length) continue;
      order += 1;
      rules.push({ sels, decls, media, order, ua: order < 0 });
    }
  };
  walk(src, []);
  return { rules, info, order };
}

// ---------------------------------------------------------------- media queries
// Evaluates the @media / @supports preludes of a rule for a viewport { w, h }.
function mediaActive(media, vp) {
  for (const q of media) {
    if (/^@supports\b/i.test(q)) {
      if (/^@supports\s+not\b/i.test(q)) return false;
      continue;
    }
    const cond = q.replace(/^@media\s*/i, "");
    // a comma means "or"
    const ok = splitTop(cond, ",").some((alt) => {
      let a = alt.trim().toLowerCase();
      let negate = false;
      if (/^not\b/.test(a)) {
        negate = true;
        a = a.replace(/^not\s+/, "");
      }
      a = a.replace(/^only\s+/, "");
      const terms = a.split(/\s+and\s+/).map((t) => t.trim()).filter(Boolean);
      const res = terms.every((t) => {
        if (t === "all" || t === "screen") return true;
        if (t === "print" || t === "speech") return false;
        const m = /^\(\s*([a-z-]+)\s*(?::\s*([^)]+?))?\s*\)$/.exec(t);
        if (!m) return false;
        const f = m[1];
        const v = (m[2] || "").trim();
        const px = parseFloat(v) * (/em$/.test(v) ? 16 : 1);
        if (f === "max-width") return vp.w <= px;
        if (f === "min-width") return vp.w >= px;
        if (f === "max-height") return vp.h <= px;
        if (f === "min-height") return vp.h >= px;
        if (f === "prefers-reduced-motion") return v === "no-preference";
        if (f === "prefers-color-scheme") return v === "light";
        if (f === "hover") return v === "hover";
        if (f === "pointer") return v === "fine";
        if (f === "orientation") return v === (vp.w >= vp.h ? "landscape" : "portrait");
        return false;
      });
      return negate ? !res : res;
    });
    if (!ok) return false;
  }
  return true;
}

// ---------------------------------------------------------------- matching
const elementKids = (n) => (n.children || []).filter((k) => k.type === "tag" || k.type === "script" || k.type === "style");
function parentEl(n) {
  const p = n.parent;
  return p && (p.type === "tag" || p.type === "script" || p.type === "style") ? p : null;
}
function prevSibling(n) {
  const p = n.parent;
  if (!p) return null;
  const sibs = elementKids(p);
  const i = sibs.indexOf(n);
  return i > 0 ? sibs[i - 1] : null;
}
function classesOf(n, ctx) {
  const set = new Set(String((n.attribs && n.attribs.class) || "").split(/\s+/).filter(Boolean));
  const extra = ctx && ctx.addClass && ctx.addClass.get(n);
  if (extra) for (const c of extra) set.add(c);
  return set;
}
function attrOf(n, name, ctx) {
  const extra = ctx && ctx.addAttr && ctx.addAttr.get(n);
  if (extra && Object.prototype.hasOwnProperty.call(extra, name)) return extra[name];
  const a = n.attribs || {};
  return Object.prototype.hasOwnProperty.call(a, name) ? a[name] : undefined;
}

function attrMatches(a, v) {
  if (v === undefined) return false;
  const val = a.value;
  switch (a.op) {
    case "": return true;
    case "=": return v === val;
    case "~=": return v.split(/\s+/).includes(val);
    case "|=": return v === val || v.startsWith(val + "-");
    case "^=": return val !== "" && v.startsWith(val);
    case "$=": return val !== "" && v.endsWith(val);
    case "*=": return val !== "" && v.includes(val);
    default: return false;
  }
}

// assumptions: when ctx.assume is set, hover / focus / dynamic classes / aria-* attributes "could be true";
// every use is pushed on `used` as { node, kind, name } so the caller can build the real state later.
function matchCompound(n, c, ctx, used, unsupported) {
  if (c.tag && c.tag !== "*" && n.name !== c.tag) return false;
  if (c.id && (n.attribs && n.attribs.id) !== c.id) return false;
  if (c.classes.length) {
    const have = classesOf(n, ctx);
    for (const cl of c.classes) {
      if (have.has(cl)) continue;
      if (ctx.assume && ctx.assume.classes.has(cl)) used.push({ node: n, kind: "class", name: cl });
      else return false;
    }
  }
  for (const a of c.attrs) {
    const v = attrOf(n, a.name, ctx);
    if (attrMatches(a, v)) continue;
    if (ctx.assume && /^(aria-|data-)/.test(a.name) && a.op === "=" && v !== undefined) {
      used.push({ node: n, kind: "attr", name: a.name, value: a.value });
      continue;
    }
    if (ctx.assume && /^(aria-|data-)/.test(a.name) && v === undefined) {
      used.push({ node: n, kind: "attr", name: a.name, value: a.op === "=" ? a.value : "true" });
      continue;
    }
    return false;
  }
  for (const p of c.pseudos) {
    switch (p.name) {
      case "hover":
      case "focus":
      case "focus-visible":
      case "active": {
        const set = ctx[p.name === "focus-visible" ? "focusVisible" : p.name];
        if (set && set.has(n)) break;
        if (ctx.assume && ctx.assume.states) {
          used.push({ node: n, kind: p.name });
          break;
        }
        return false;
      }
      case "focus-within": return false;
      case "root": if (!(n.name === "html")) return false; break;
      case "any-link":
      case "link": if (!(n.name === "a" || n.name === "area") || (n.attribs || {}).href === undefined) return false; break;
      case "visited":
      case "checked":
      case "disabled":
      case "target":
      case "invalid":
      case "placeholder-shown": return false;
      case "enabled": if (attrOf(n, "disabled", ctx) !== undefined) return false; break;
      case "first-child": if (prevSibling(n)) return false; break;
      case "last-child": {
        const p2 = n.parent;
        const sibs = p2 ? elementKids(p2) : [];
        if (sibs[sibs.length - 1] !== n) return false;
        break;
      }
      case "only-child": {
        const p2 = n.parent;
        if (!p2 || elementKids(p2).length !== 1) return false;
        break;
      }
      case "empty": if ((n.children || []).length) return false; break;
      case "nth-child":
      case "nth-last-child":
      case "nth-of-type":
      case "nth-last-of-type": {
        const p2 = n.parent;
        let sibs = p2 ? elementKids(p2) : [n];
        if (/of-type/.test(p.name)) sibs = sibs.filter((s) => s.name === n.name);
        let idx = sibs.indexOf(n) + 1;
        if (/last/.test(p.name)) idx = sibs.length - idx + 1;
        const { a, b } = p.nth;
        const ok = a === 0 ? idx === b : (idx - b) / a >= 0 && Number.isInteger((idx - b) / a);
        if (!ok) return false;
        break;
      }
      case "not":
        if (p.list.some((s) => matchComplex(n, s, s.parts.length - 1, { ...ctx, assume: null }, [], unsupported))) return false;
        break;
      case "is":
        if (!p.list.some((s) => matchComplex(n, s, s.parts.length - 1, ctx, used, unsupported))) return false;
        break;
      default:
        if (unsupported) unsupported.set(":" + p.name, (unsupported.get(":" + p.name) || 0) + 1);
        return false;
    }
  }
  return true;
}

// matches parts[0..i] with parts[i] on node n. `used` receives the assumptions of the successful path.
function matchComplex(n, sel, i, ctx, used, unsupported) {
  const part = sel.parts[i];
  const mine = [];
  if (!matchCompound(n, part.c, ctx, mine, unsupported)) return false;
  if (i === 0) {
    used.push(...mine);
    return true;
  }
  const tryNode = (cand) => {
    const sub = [];
    if (cand && matchComplex(cand, sel, i - 1, ctx, sub, unsupported)) {
      used.push(...mine, ...sub);
      return true;
    }
    return false;
  };
  switch (part.comb) {
    case ">": return tryNode(parentEl(n));
    case "+": return tryNode(prevSibling(n));
    case "~": {
      for (let p = prevSibling(n); p; p = prevSibling(p)) if (tryNode(p)) return true;
      return false;
    }
    default: {
      for (let p = parentEl(n); p; p = parentEl(p)) if (tryNode(p)) return true;
      return false;
    }
  }
}

module.exports = { parseStylesheet, parseSelector, parseDecls, matchComplex, mediaActive, splitTop, tokensTop, classesOf, attrOf, parentEl, elementKids, stripComments };
