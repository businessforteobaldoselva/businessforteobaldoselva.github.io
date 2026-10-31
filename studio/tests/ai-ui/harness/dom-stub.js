"use strict";
// A very small DOM, enough to run the REAL core/dom.js h() and the REAL ext/ai.js under node (no browser, no jsdom).
// It is deliberately strict where it matters for the tests: there is NO innerHTML (a setter throws), text only enters through
// text nodes / textContent, and event dispatch bubbles. Selectors: tag, #id, .class, [attr], [attr=v], [attr='v'], compound
// selectors, descendant (space) and child (>) combinators, comma lists.
class Node {
  constructor(type) { this.nodeType = type; this.parentNode = null; this.childNodes = []; }
  get firstChild() { return this.childNodes[0] || null; }
  get isConnected() { let n = this; while (n.parentNode) n = n.parentNode; return n.nodeType === 9; }
  getRootNode() { let n = this; while (n.parentNode) n = n.parentNode; return n; }
  appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.childNodes.push(c); return c; }
  removeChild(c) { const i = this.childNodes.indexOf(c); if (i < 0) throw new Error("removeChild: not a child"); this.childNodes.splice(i, 1); c.parentNode = null; return c; }
  contains(o) { for (let n = o; n; n = n.parentNode) if (n === this) return true; return false; }
  get textContent() { return this.childNodes.map((c) => c.textContent).join(""); }
  set textContent(v) { this.childNodes.slice().forEach((c) => this.removeChild(c)); if (v !== "" && v != null) this.appendChild(new Text(String(v))); }
}
class Text extends Node {
  constructor(data) { super(3); this.data = data; }
  get textContent() { return this.data; }
  set textContent(v) { this.data = String(v); }
}

function parseSelector(sel) {
  return sel.split(",").map((part) => {
    const tokens = [];
    let rest = part.trim();
    let comb = " ";
    const re = /\s*([>])\s*|\s+/y;
    let i = 0;
    while (i < rest.length) {
      let j = i;
      let depth = 0;
      while (j < rest.length && (depth > 0 || !/[\s>]/.test(rest[j]))) { if (rest[j] === "[") depth++; if (rest[j] === "]") depth--; j++; }
      tokens.push({ comb, compound: parseCompound(rest.slice(i, j)) });
      i = j;
      comb = " ";
      while (i < rest.length && /[\s>]/.test(rest[i])) { if (rest[i] === ">") comb = ">"; i++; }
    }
    void re;
    return tokens;
  });
}
function parseCompound(s) {
  const c = { tag: null, id: null, classes: [], attrs: [] };
  let i = 0;
  const m0 = /^[a-zA-Z][a-zA-Z0-9-]*/.exec(s);
  if (m0) { c.tag = m0[0].toLowerCase(); i = m0[0].length; }
  while (i < s.length) {
    if (s[i] === "#") { const m = /^#([\w-]+)/.exec(s.slice(i)); c.id = m[1]; i += m[0].length; }
    else if (s[i] === ".") { const m = /^\.([\w-]+)/.exec(s.slice(i)); c.classes.push(m[1]); i += m[0].length; }
    else if (s[i] === "[") {
      const m = /^\[([\w:-]+)(?:=(?:'([^']*)'|"([^"]*)"|([^\]]*)))?\]/.exec(s.slice(i));
      if (!m) throw new Error("selector not supported: " + s);
      c.attrs.push({ name: m[1], value: m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : null });
      i += m[0].length;
    } else throw new Error("selector not supported: " + s);
  }
  return c;
}
function matchCompound(el, c) {
  if (c.tag && el.tagName.toLowerCase() !== c.tag) return false;
  if (c.id && el.getAttribute("id") !== c.id) return false;
  const cls = (el.getAttribute("class") || "").split(/\s+/);
  for (const k of c.classes) if (cls.indexOf(k) < 0) return false;
  for (const a of c.attrs) {
    if (!el.hasAttribute(a.name)) return false;
    if (a.value !== null && el.getAttribute(a.name) !== a.value) return false;
  }
  return true;
}
function matches(el, tokens) {
  const last = tokens.length - 1;
  if (!matchCompound(el, tokens[last].compound)) return false;
  function up(node, idx) {
    if (idx < 0) return true;
    const t = tokens[idx];
    const comb = tokens[idx + 1].comb;
    if (comb === ">") { const p = node.parentNode; return !!p && p.nodeType === 1 && matchCompound(p, t.compound) && up(p, idx - 1); }
    for (let p = node.parentNode; p && p.nodeType === 1; p = p.parentNode) if (matchCompound(p, t.compound) && up(p, idx - 1)) return true;
    return false;
  }
  return up(el, last - 1);
}

class Element extends Node {
  constructor(tag, doc) {
    super(1);
    this.tagName = tag.toUpperCase();
    this.ownerDocument = doc;
    this.attrs = new Map();
    this.listeners = {};
    this._value = "";
    this._checked = false;
    this._disabled = false;
  }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  hasAttribute(k) { return this.attrs.has(k); }
  removeAttribute(k) { this.attrs.delete(k); }
  get id() { return this.getAttribute("id") || ""; }
  get className() { return this.getAttribute("class") || ""; }
  get hidden() { return this.hasAttribute("hidden"); }
  set hidden(v) { if (v) this.setAttribute("hidden", ""); else this.removeAttribute("hidden"); }
  get disabled() { return this._disabled || this.hasAttribute("disabled"); }
  set disabled(v) { this._disabled = !!v; if (v) this.setAttribute("disabled", ""); else this.removeAttribute("disabled"); }
  get value() { return this.tagName === "TEXTAREA" || this.tagName === "INPUT" ? this._value : (this.getAttribute("value") || ""); }
  set value(v) { this._value = String(v); }
  get checked() { return this._checked; }
  set checked(v) { this._checked = !!v; }
  get innerHTML() { throw new Error("innerHTML is not available in the test DOM (the overlay must never use it)"); }
  set innerHTML(v) { throw new Error("innerHTML was assigned: " + String(v).slice(0, 40)); }
  get outerHTML() { throw new Error("outerHTML is not available"); }
  addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); }
  removeEventListener(ev, fn) { this.listeners[ev] = (this.listeners[ev] || []).filter((f) => f !== fn); }
  dispatchEvent(e) {
    e.target = e.target || this;
    for (let n = this; n; n = n.parentNode) {
      if (n.nodeType !== 1 && n.nodeType !== 9) continue;
      e.currentTarget = n;
      (n.listeners && n.listeners[e.type] || []).slice().forEach((f) => f.call(n, e));
      if (e.cancelBubble || e.type === "focus") break;
    }
    return !e.defaultPrevented;
  }
  click() {
    if (this.disabled) return;
    if (this.tagName === "INPUT" && this.getAttribute("type") === "checkbox") { this._checked = !this._checked; this.dispatchEvent(ev("input")); this.dispatchEvent(ev("change")); }
    this.dispatchEvent(ev("click"));
    if (this.tagName === "LABEL" && this.getAttribute("for")) { const t = this.getRootNode().__byId && this.getRootNode().__byId(this.getAttribute("for")); if (t && t !== this) t.click(); }
  }
  focus() { if (this.disabled) return; const d = this.ownerDocument; if (d.activeElement === this) return; d.activeElement = this; d.focusLog.push(this); }
  blur() { if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = null; }
  select() { this.selected = true; }
  querySelectorAll(sel) {
    const groups = parseSelector(sel);
    const out = [];
    (function walk(n) { n.childNodes.forEach((c) => { if (c.nodeType === 1) { if (groups.some((g) => matches(c, g))) out.push(c); walk(c); } }); })(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  closest(sel) { const g = parseSelector(sel); for (let n = this; n && n.nodeType === 1; n = n.parentNode) if (g.some((t) => matches(n, t))) return n; return null; }
}
const ev = (type, extra) => Object.assign({ type, defaultPrevented: false, cancelBubble: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.cancelBubble = true; } }, extra || {});

class Document extends Node {
  constructor() {
    super(9);
    this.activeElement = null;
    this.focusLog = [];
    this.listeners = {};
    this.body = new Element("body", this);
    this.appendChild(this.body);
  }
  createElement(tag) { return new Element(tag, this); }
  createTextNode(t) { return new Text(String(t)); }
  addEventListener() {}
  removeEventListener() {}
  contains(n) { return Node.prototype.contains.call(this, n); }
  __byId(id) { return this.body.querySelector("#" + id); }
  querySelector(s) { return this.body.querySelector(s); }
  querySelectorAll(s) { return this.body.querySelectorAll(s); }
}

function createDom() { const document = new Document(); return { document, ev, Element, Text }; }
module.exports = { createDom, ev };
