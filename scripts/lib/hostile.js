"use strict";
// Analysis helpers for check-hostile: describe what a built page can DO (handlers, scripts, links,
// style blocks, elements that load things) so a build made from hostile data can be compared with a
// build made from the shipped data.

const acorn = require("acorn");
const { parseDocument } = require("htmlparser2");

const URL_ATTRS = new Set(["href", "src", "srcset", "action", "formaction", "poster", "data", "xlink:href", "cite", "background", "ping", "manifest", "codebase", "longdesc", "usemap"]);
const LOADERS = new Set(["iframe", "frame", "frameset", "object", "embed", "applet", "base", "portal"]);
const JS_TYPE = /^(|text\/javascript|application\/javascript|module|text\/ecmascript)$/i;
const text = (n) => (n.children || []).map((c) => c.data || "").join("");

function analysePage(html) {
  const doc = parseDocument(html, { decodeEntities: true });
  const out = {
    handlers: [], // { el, attr, value }
    scripts: [], // { type, code }
    styles: [],
    urls: [], // { el, attr, value }
    loaders: {}, // tag -> count
    metaRefresh: 0,
    forms: [], // action attributes
    elements: 0,
    rawScriptCloses: (html.match(/<\/script/gi) || []).length,
    rawCommentOpens: (html.match(/<!--/g) || []).length,
  };
  (function walk(n) {
    if (n.type === "script") {
      out.scripts.push({ type: (n.attribs.type || "").trim(), code: text(n), attribs: n.attribs });
    } else if (n.type === "style") {
      out.styles.push(text(n));
    }
    if (n.type === "tag" || n.type === "script" || n.type === "style") {
      out.elements += 1;
      for (const [k0, v] of Object.entries(n.attribs || {})) {
        const k = k0.toLowerCase();
        if (/^on/.test(k)) out.handlers.push({ el: n.name, attr: k, value: v });
        if (k === "srcdoc") out.handlers.push({ el: n.name, attr: k, value: v });
        if (URL_ATTRS.has(k)) out.urls.push({ el: n.name, attr: k, value: v, rel: String((n.attribs || {}).rel || "").toLowerCase() });
        if (k === "style" && /expression\s*\(|javascript:|url\s*\(\s*["']?\s*(javascript|data):/i.test(v)) out.handlers.push({ el: n.name, attr: "style", value: v });
        if ((k === "action" || k === "formaction") && n.name !== "svg") out.forms.push({ el: n.name, value: v });
      }
      if (LOADERS.has(n.name)) out.loaders[n.name] = (out.loaders[n.name] || 0) + 1;
      if (n.name === "meta" && /refresh|set-cookie/i.test((n.attribs || {})["http-equiv"] || "")) out.metaRefresh += 1;
    }
    (n.children || []).forEach(walk);
  })(doc);
  return out;
}

// Problems inside one inline script (syntax, injected calls / identifiers).
function scriptProblems(s) {
  const probs = [];
  if (/ld\+json/i.test(s.type)) {
    try {
      JSON.parse(s.code);
    } catch (e) {
      probs.push("JSON-LD block is no longer valid JSON: " + e.message);
    }
    return probs;
  }
  if (!JS_TYPE.test(s.type) || s.attribs.src) return probs;
  let ast;
  try {
    ast = acorn.parse(s.code, { ecmaVersion: "latest", sourceType: "script", allowReturnOutsideFunction: true });
  } catch (e) {
    return ["inline script no longer parses (" + e.message + ")"];
  }
  (function walk(n) {
    if (!n || typeof n.type !== "string") return;
    if (n.type === "CallExpression" && n.callee.type === "Identifier" && /^(alert|prompt|confirm)$/.test(n.callee.name)) probs.push("injected call " + n.callee.name + "(…) in script code");
    if (n.type === "Identifier" && /^HX/.test(n.name)) probs.push("injected identifier " + n.name + " in script code");
    for (const k of Object.keys(n)) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v.type === "string") walk(v);
    }
  })(ast);
  return probs;
}

const SINK_PROPS = new Set(["innerHTML", "outerHTML", "srcdoc"]);
const SINK_CALLS = new Set(["insertAdjacentHTML", "write", "writeln", "createContextualFragment", "parseFromString"]);

// Static rule for page scripts: HTML / code sinks may only be fed string literals; navigation may
// only go to mailto: / same-site / anchor targets. Returns [{ line, what }].
function sinkProblems(code) {
  const probs = [];
  let ast;
  try {
    ast = acorn.parse(code, { ecmaVersion: "latest", sourceType: "script", locations: true, allowReturnOutsideFunction: true });
  } catch (e) {
    return [{ line: 0, what: "script does not parse: " + e.message }];
  }
  const isLiteralOnly = (n) => {
    if (!n) return true;
    if (n.type === "Literal") return true;
    if (n.type === "TemplateLiteral") return n.expressions.length === 0;
    if (n.type === "BinaryExpression" && n.operator === "+") return isLiteralOnly(n.left) && isLiteralOnly(n.right);
    return false;
  };
  const leftmost = (n) => {
    if (!n) return null;
    if (n.type === "Literal") return String(n.value);
    if (n.type === "TemplateLiteral") return n.quasis[0].value.cooked;
    if (n.type === "BinaryExpression" && n.operator === "+") return leftmost(n.left);
    if (n.type === "SequenceExpression") return leftmost(n.expressions[n.expressions.length - 1]);
    if (n.type === "AssignmentExpression" && n.operator === "=") return leftmost(n.right);
    return null;
  };
  const propName = (m) => (m.type === "MemberExpression" ? (m.computed ? (m.property.type === "Literal" ? String(m.property.value) : "") : m.property.name) : "");
  (function walk(n) {
    if (!n || typeof n.type !== "string") return;
    const line = n.loc ? n.loc.start.line : 0;
    if (n.type === "AssignmentExpression" && n.left.type === "MemberExpression") {
      const p = propName(n.left);
      if (SINK_PROPS.has(p) && !isLiteralOnly(n.right)) probs.push({ line, what: p + " is assigned something that is not a fixed string (use textContent or build elements)" });
      if (p === "href" && /location/.test(code.slice(n.left.start, n.left.end)) && !/^(mailto:|\/|#)/.test(leftmost(n.right) || "")) probs.push({ line, what: "location.href is set to a value that does not start with mailto: / # or a site path" });
    }
    if (n.type === "CallExpression") {
      const c = n.callee;
      const name = c.type === "Identifier" ? c.name : propName(c);
      if (SINK_CALLS.has(name) && !n.arguments.every(isLiteralOnly)) probs.push({ line, what: name + "() is given something that is not a fixed string" });
      if (c.type === "Identifier" && (c.name === "eval" || c.name === "Function")) probs.push({ line, what: c.name + "() runs code from a string" });
      if ((name === "setTimeout" || name === "setInterval") && n.arguments[0] && (n.arguments[0].type === "Literal" || n.arguments[0].type === "TemplateLiteral" || (n.arguments[0].type === "BinaryExpression" && n.arguments[0].operator === "+"))) probs.push({ line, what: name + "() is given a string to run" });
      if ((name === "assign" || name === "replace") && /location/.test(code.slice(c.start, c.end)) && !/^(mailto:|\/|#)/.test(leftmost(n.arguments[0]) || "")) probs.push({ line, what: "location." + name + "() goes to a value that does not start with mailto: / # or a site path" });
      if (name === "open" && /window/.test(code.slice(c.start, c.end)) && n.arguments[0] && !/^(mailto:|\/|#)/.test(leftmost(n.arguments[0]) || "")) probs.push({ line, what: "window.open() goes to a value that does not start with mailto: / # or a site path" });
    }
    if (n.type === "NewExpression" && n.callee.type === "Identifier" && n.callee.name === "Function") probs.push({ line, what: "new Function() runs code from a string" });
    for (const k of Object.keys(n)) {
      if (k === "loc") continue;
      const v = n[k];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v.type === "string") walk(v);
    }
  })(ast);
  return probs;
}

module.exports = { analysePage, scriptProblems, sinkProblems };
