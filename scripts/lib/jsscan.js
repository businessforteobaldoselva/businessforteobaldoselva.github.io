"use strict";
// Finds the human-readable strings in a piece of JavaScript with a real parser (acorn), so
// string and template literals are found whatever characters they contain.
//
// scanScript(code) -> { error?, strings: [{ text, kind, line, via }] }
//   kind "copy"        a sentence / label / message
//   kind "glyph"       a lone symbol or emoji (UI chrome such as an arrow)
//   kind "html-text"   visible text inside an HTML string (innerHTML = "<p>…</p>")
//   kind "html-attr"   alt / aria-label / title / placeholder … inside an HTML string
//
// Strings in clearly non-visible positions are skipped (see codeContext): selectors, event and
// attribute names, comparisons, object keys, className / style / dataset targets, Error and
// console messages, "use strict". Everything else is judged by its shape (prose.js).

const acorn = require("acorn");
const { parseDocument } = require("htmlparser2");
const { collapse } = require("./util");
const { proseKind } = require("./prose");

// A string counts as HTML only when it holds a real HTML / SVG element, so a sentence that merely
// contains "<angle> brackets" is judged as plain text (and reported whole).
const KNOWN_TAGS = new Set(
  (
    "a abbr address article aside audio b bdi bdo blockquote body br button canvas caption cite code col colgroup data datalist dd del " +
    "details dfn dialog div dl dt em embed fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 head header hr html i iframe img " +
    "input ins kbd label legend li link main map mark menu meta meter nav noscript object ol optgroup option output p picture pre " +
    "progress q rp rt ruby s samp script section select small source span strong style sub summary sup svg table tbody td template " +
    "textarea tfoot th thead time title tr track u ul var video wbr text path circle rect g use defs line polygon polyline ellipse tspan"
  ).split(" ")
);
const TAG_RE = /<\/?([A-Za-z][\w:-]*)(?:\s[^<>]*)?\/?>/g;
const HTML_LIKE = {
  test(text) {
    TAG_RE.lastIndex = 0;
    let m;
    while ((m = TAG_RE.exec(text))) if (KNOWN_TAGS.has(m[1].toLowerCase())) return true;
    return false;
  },
};

// Attributes whose value is shown to people or read out by assistive technology.
const TEXT_ATTRS = new Set([
  "alt", "title", "aria-label", "aria-description", "aria-roledescription", "aria-valuetext", "aria-placeholder",
  "aria-braillelabel", "placeholder", "label", "summary", "abbr",
]);
// Attributes that never hold copy.
const CODE_ATTRS = new Set([
  "class", "id", "style", "href", "src", "srcset", "sizes", "d", "points", "transform", "viewbox", "fill", "stroke",
  "for", "name", "rel", "type", "role", "lang", "charset", "method", "action", "target", "crossorigin", "as", "media",
  "loading", "decoding", "autocomplete", "inputmode", "tabindex", "pattern", "poster", "preload", "enctype", "accept",
  "http-equiv", "property", "xmlns", "slot", "is", "itemprop", "itemtype", "itemscope", "value", "content", "list",
  "aria-hidden", "aria-expanded", "aria-pressed", "aria-current", "aria-live", "aria-controls", "aria-labelledby",
  "aria-describedby", "aria-haspopup", "aria-atomic", "aria-modal", "aria-selected", "aria-checked", "aria-disabled",
  "aria-busy", "aria-relevant", "aria-owns", "aria-activedescendant", "aria-orientation", "aria-level", "aria-multiline",
  "aria-valuenow", "aria-valuemin", "aria-valuemax", "aria-posinset", "aria-setsize", "aria-sort", "aria-required",
  "aria-invalid", "aria-readonly", "aria-errormessage", "aria-details", "aria-flowto", "aria-keyshortcuts", "aria-autocomplete",
]);

// ---------------------------------------------------------------- HTML fragments
// Visible text + readable attributes of an HTML string. Used for built pages and for HTML held in JS strings.
function htmlItems(html, opts) {
  const o = opts || {};
  const doc = parseDocument(html, { decodeEntities: true });
  const items = [];
  (function walk(n) {
    if (n.type === "text") {
      const t = collapse(n.data);
      if (t) items.push({ kind: "html-text", text: t });
      return;
    }
    if (n.type === "style" || n.type === "script") return;
    if (n.attribs) {
      for (const [k0, v0] of Object.entries(n.attribs)) {
        const k = k0.toLowerCase();
        const v = collapse(v0);
        if (!v) continue;
        if (TEXT_ATTRS.has(k)) items.push({ kind: "html-attr", text: v, attr: k });
        else if (n.name === "input" && k === "value" && /^(submit|button|reset)$/i.test(n.attribs.type || "")) items.push({ kind: "html-attr", text: v, attr: k });
        else if (!CODE_ATTRS.has(k) && !/^on/.test(k) && proseKind(v) === "copy") items.push({ kind: "html-attr", text: v, attr: k });
        else if (/^on/.test(k) && o.flagHandlers) items.push({ kind: "handler", text: v, attr: k });
      }
    }
    if (n.children) n.children.forEach(walk);
  })(doc);
  return items;
}

// ---------------------------------------------------------------- AST helpers
const CODE_ARG0_CALLS = new Set([
  "querySelector", "querySelectorAll", "closest", "matches", "getElementById", "getElementsByClassName",
  "getElementsByTagName", "getElementsByName", "matchMedia", "getAttribute", "hasAttribute", "removeAttribute",
  "toggleAttribute", "setAttribute", "removeAttributeNS", "hasAttributeNS", "getAttributeNS", "addEventListener",
  "removeEventListener", "createElement", "createEvent", "setProperty", "getPropertyValue", "removeProperty",
  "indexOf", "lastIndexOf", "includes", "startsWith", "endsWith", "split", "search", "match", "matchAll", "test",
  "replace", "replaceAll", "insertAdjacentHTML", "insertAdjacentElement", "hasOwnProperty", "defineProperty",
  "getOwnPropertyDescriptor", "parse", "localeCompare", "dispatchEvent", "postMessage", "toLocaleString",
  "toLocaleDateString", "toLocaleTimeString", "createElementNS", "setAttributeNS", "getItem", "setItem", "removeItem",
]);
const CODE_ALL_ARGS_METHODS = new Set(["add", "remove", "toggle", "contains", "replace", "item"]); // only on .classList
const CODE_CTORS = new Set(["RegExp", "Date", "URL", "URLSearchParams", "Event", "CustomEvent", "Error", "TypeError", "RangeError", "Request", "Intl", "IntersectionObserver", "MutationObserver", "ResizeObserver"]);
const CODE_FUNCS = new Set(["parseInt", "parseFloat", "Number", "Boolean", "fetch", "require", "import", "setTimeout", "setInterval", "requestAnimationFrame", "isNaN", "encodeURIComponent", "decodeURIComponent", "encodeURI", "decodeURI", "escape", "unescape"]);
const CODE_OBJECTS = new Set(["console", "Math", "JSON", "Object", "Array", "Number", "Reflect", "Symbol", "Intl", "Date"]);
const CODE_ASSIGN_PROPS = new Set([
  "className", "id", "type", "name", "htmlFor", "rel", "href", "src", "srcset", "sizes", "action", "method", "target", "tabIndex",
  "role", "crossOrigin", "loading", "decoding", "autocomplete", "inputMode", "cssText", "display", "position", "cursor",
  "transition", "transform", "opacity", "color", "background", "width", "height", "overflow", "pointerEvents", "willChange",
  "scrollBehavior", "hash", "pathname", "search", "location",
]);
// Object keys whose values are API vocabulary (fetch options, observer options ...). Keys that may hold wording
// (name, title, label, icon, kind ...) are deliberately NOT here: their values are judged by what they say.
const CODE_KEYS = new Set([
  "method", "mode", "cache", "credentials", "redirect", "referrerPolicy", "rootMargin", "threshold", "behavior", "block", "inline",
  "easing", "fill", "direction", "Content-Type", "content-type", "accept", "cursor", "display", "position", "rel", "as", "role", "selector",
]);

const keyName = (k) => (k.type === "Identifier" ? k.name : k.type === "Literal" ? String(k.value) : "");
const calleeName = (callee) => {
  if (callee.type === "Identifier") return callee.name;
  if (callee.type === "MemberExpression" && !callee.computed && callee.property.type === "Identifier") return callee.property.name;
  if (callee.type === "MemberExpression" && callee.computed && callee.property.type === "Literal") return String(callee.property.value);
  return "";
};
const memberObjectName = (callee) => {
  if (callee.type !== "MemberExpression") return "";
  const o = callee.object;
  if (o.type === "Identifier") return o.name;
  if (o.type === "MemberExpression" && !o.computed && o.property.type === "Identifier") return o.property.name;
  return "";
};

// Climb out of wrappers that merely pass a string through to the real consumer.
function effective(node, stack) {
  let cur = node;
  let i = stack.length - 1;
  while (i >= 0) {
    const p = stack[i];
    const passes =
      (p.type === "ConditionalExpression" && p.test !== cur) ||
      p.type === "LogicalExpression" ||
      p.type === "TemplateLiteral" ||
      p.type === "ParenthesizedExpression" ||
      (p.type === "BinaryExpression" && p.operator === "+") ||
      (p.type === "SequenceExpression" && p.expressions[p.expressions.length - 1] === cur);
    if (!passes) return { node: cur, parent: p };
    cur = p;
    i -= 1;
  }
  return { node: cur, parent: null };
}

function codeContext(node, stack) {
  const { node: cur, parent: p } = effective(node, stack);
  if (!p) return false;
  switch (p.type) {
    case "Property":
    case "PropertyDefinition":
    case "MethodDefinition":
      if (p.key === cur && !p.computed) return true;
      if (p.value === cur && !p.computed && CODE_KEYS.has(keyName(p.key))) return true;
      return false;
    case "ExpressionStatement":
      return typeof p.directive === "string";
    case "BinaryExpression":
      return ["==", "===", "!=", "!==", "in", "instanceof"].includes(p.operator);
    case "SwitchCase":
      return p.test === cur;
    case "MemberExpression":
      return p.computed && p.property === cur; // obj["key"]
    case "CallExpression":
    case "NewExpression": {
      const idx = p.arguments.indexOf(cur);
      if (idx < 0) return false; // the callee itself
      const name = calleeName(p.callee);
      const obj = p.type === "CallExpression" ? memberObjectName(p.callee) : "";
      if (p.type === "NewExpression" && p.callee.type === "Identifier" && CODE_CTORS.has(p.callee.name)) return true;
      if (p.type === "NewExpression" && p.callee.type === "MemberExpression" && CODE_OBJECTS.has(memberObjectName(p.callee))) return true;
      if (CODE_OBJECTS.has(obj) && obj !== "Date") return true; // console.log, JSON.parse, Object.keys, Math.max …
      if (p.callee.type === "Identifier" && CODE_FUNCS.has(p.callee.name)) return true;
      if (name === "setAttribute" || name === "setAttributeNS") return idx === 0 || (name === "setAttributeNS" && idx === 1);
      if (name === "setProperty") return idx === 0;
      if (name === "replace" || name === "replaceAll") return idx === 0;
      if (name === "createElementNS") return idx <= 1;
      if (obj === "classList" && CODE_ALL_ARGS_METHODS.has(name)) return true;
      if (name === "insertAdjacentHTML") return idx === 0;
      if (name === "setItem") return idx === 0;
      if (CODE_ARG0_CALLS.has(name)) return idx === 0;
      return false;
    }
    case "AssignmentExpression": {
      if (p.right !== cur) return false;
      const l = p.left;
      if (l.type !== "MemberExpression") return false;
      const prop = l.computed ? (l.property.type === "Literal" ? String(l.property.value) : "") : l.property.name;
      if (CODE_ASSIGN_PROPS.has(prop)) return true;
      const o = l.object;
      if (o.type === "MemberExpression" && !o.computed && ["style", "dataset", "classList", "attributes"].includes(o.property.name)) return true;
      return false;
    }
    default:
      return false;
  }
}

function lineOf(node) {
  return node.loc ? node.loc.start.line : 0;
}

function scanScript(code) {
  let ast;
  try {
    ast = acorn.parse(code, { ecmaVersion: "latest", sourceType: "script", locations: true, allowReturnOutsideFunction: true, allowHashBang: true });
  } catch (e) {
    try {
      ast = acorn.parse(code, { ecmaVersion: "latest", sourceType: "module", locations: true });
    } catch (e2) {
      return { error: e.message, strings: [] };
    }
  }
  const strings = [];
  const push = (text, node, stack) => {
    if (typeof text !== "string" || !text.trim()) return;
    if (codeContext(node, stack)) return;
    if (HTML_LIKE.test(text)) {
      for (const it of htmlItems(text)) strings.push({ text: it.text, kind: it.kind, line: lineOf(node), via: "html" });
      return;
    }
    const k = proseKind(text);
    if (k) strings.push({ text: collapse(text), kind: k, line: lineOf(node), via: "string" });
  };
  const stack = [];
  (function walk(n) {
    if (!n || typeof n.type !== "string") return;
    if (n.type === "Literal" && typeof n.value === "string") push(n.value, n, stack);
    else if (n.type === "TemplateElement") push(n.value.cooked === null ? n.value.raw : n.value.cooked, n, stack);
    stack.push(n);
    for (const k of Object.keys(n)) {
      if (k === "loc" || k === "type") continue;
      const v = n[k];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v.type === "string") walk(v);
    }
    stack.pop();
  })(ast);
  return { strings, ast };
}

module.exports = { scanScript, htmlItems, TEXT_ATTRS, CODE_ATTRS, HTML_LIKE };
