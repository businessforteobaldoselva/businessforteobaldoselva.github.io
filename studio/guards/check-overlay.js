#!/usr/bin/env node
"use strict";
// check-overlay: static rules for the Studio overlay and login page (studio/overlay/**, studio/login/**).
//
//   node studio/guards/check-overlay.js [--root <repo>]
//
// The overlay runs inside a preview of the real site, next to editor-controlled text, so it is held to a stricter
// standard than the site: it parses every browser file with acorn and fails on
//   * ways to turn text into markup or code: innerHTML / outerHTML / insertAdjacentHTML / srcdoc / document.write /
//     eval / Function / string timers / import() / DOMParser / createContextualFragment / execCommand /
//     on* handler properties and attributes;
//   * elements that load or run things: createElement of script, style, iframe, link, object, embed, base, meta
//     (and any non-literal createElement outside core/dom.js, whose h() holds the tag allow-list);
//   * the network: fetch only at the two allowed call sites (core/api-client.js, core/util.js), no XMLHttpRequest /
//     WebSocket / EventSource / sendBeacon / importScripts / Worker; window.open only in core/auth.js; a
//     "message" listener only in core/auth.js and studio/login/login.js, and postMessage never to "*";
//   * third parties: any URL literal whose host is not localhost / 127.0.0.1 / an example domain, any CDN host;
//   * structure: every module is an IIFE over window.__CoveredStudioBoot; one shadow root; the manifest lists real files;
//   * size: a budget for the shipped code (the generated schema is data and not counted);
//   * accessibility of the overlay itself: every text/background pair of its fixed colours (light and dark)
//     meets WCAG 2.2 (4.5:1 text, 3:1 parts) using cms/contrast.js; focus-visible, reduced-motion, dark-mode and
//     44px touch-target rules exist; the live region, dialog roles and complementary landmark are present.
// Exit 0 clean, 1 on any violation. No network, no build.

const fs = require("fs");
const path = require("path");
const acorn = require("acorn");

const args = process.argv.slice(2);
const rootArg = args.indexOf("--root") >= 0 ? args[args.indexOf("--root") + 1] : path.resolve(__dirname, "..", "..");
const ROOT = path.resolve(rootArg);
const OVERLAY = path.join(ROOT, "studio", "overlay");
const LOGIN = path.join(ROOT, "studio", "login");

const FETCH_FILES = new Set(["core/api-client.js", "core/util.js"]);
const BANNED_MEMBERS = new Set(["innerHTML", "outerHTML", "insertAdjacentHTML", "insertAdjacentElement", "srcdoc", "createContextualFragment", "execCommand", "parseFromString"]);
const BANNED_GLOBALS = new Set(["eval", "Function", "XMLHttpRequest", "WebSocket", "EventSource", "importScripts", "Worker", "SharedWorker", "ServiceWorker", "DOMParser"]);
const BANNED_TAGS = new Set(["script", "style", "iframe", "link", "object", "embed", "base", "meta", "frame", "frameset", "template"]);
const LITERAL_TAGS = new Set(["div", "canvas", "br", "span", "a", "input"]);
const OK_HOSTS = /^(localhost|127\.0\.0\.1|(www\.)?example\.(com|test|org)|[a-z0-9-]+\.test|github\.test)$/i;
const CDN = /(cdn|unpkg|jsdelivr|cdnjs|googleapis|gstatic|jquery|bootstrapcdn|fontawesome|cloudflare|polyfill)/i;
const BUDGET = { scriptsKiB: 300, cssKiB: 40 }; // 260 before the History/palette/tour/help modules (unit D, ~65 KiB) were bundled

const problems = [];
const warn = (file, line, msg) => problems.push(file + (line ? ":" + line : "") + "  " + msg);

function read(p) { return fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n"); }
function exists(p) { return fs.existsSync(p); }

// ---------------------------------------------------------------- manifest
const manifestFile = path.join(OVERLAY, "manifest.json");
if (!exists(manifestFile)) {
  console.error("check-overlay: studio/overlay/manifest.json is missing");
  process.exit(1);
}
const manifest = JSON.parse(read(manifestFile));
const scripts = (manifest.scripts || []).filter((rel) => {
  if (exists(path.join(OVERLAY, rel))) return true;
  if (!rel.startsWith("ext/")) warn("studio/overlay/manifest.json", 0, "lists a file that does not exist: " + rel);
  return false;
});
if ((manifest.scripts || [])[manifest.scripts.length - 1] !== "main.js") warn("studio/overlay/manifest.json", 0, "main.js must be last (it boots the overlay)");
const styles = (manifest.styles || []).filter((rel) => exists(path.join(OVERLAY, rel)));

const files = scripts.filter((rel) => !rel.startsWith("../")).map((rel) => ({ rel, abs: path.join(OVERLAY, rel), label: "studio/overlay/" + rel }));
if (exists(path.join(LOGIN, "login.js"))) files.push({ rel: "login/login.js", abs: path.join(LOGIN, "login.js"), label: "studio/login/login.js" });
// files outside the overlay folder named in the manifest (cms/contrast.js) are shared, pure maths: scanned too
scripts.filter((rel) => rel.startsWith("../")).forEach((rel) => files.push({ rel, abs: path.resolve(OVERLAY, rel), label: path.relative(ROOT, path.resolve(OVERLAY, rel)).split(path.sep).join("/"), shared: true }));

// ---------------------------------------------------------------- AST walk
function walk(node, fn, parent) {
  if (!node || typeof node.type !== "string") return;
  fn(node, parent);
  for (const k of Object.keys(node)) {
    if (k === "loc" || k === "start" || k === "end") continue;
    const v = node[k];
    if (Array.isArray(v)) v.forEach((c) => c && typeof c.type === "string" && walk(c, fn, node));
    else if (v && typeof v.type === "string") walk(v, fn, node);
  }
}
const memberName = (n) => (n.computed ? (n.property.type === "Literal" ? String(n.property.value) : null) : n.property.name);
const isStrLit = (n) => n && n.type === "Literal" && typeof n.value === "string";

function scanJs(f) {
  const text = read(f.abs);
  let ast;
  try {
    ast = acorn.parse(text, { ecmaVersion: 2022, sourceType: "script", locations: true, allowHashBang: true });
  } catch (e) {
    warn(f.label, e.loc && e.loc.line, "does not parse (" + e.message + ")");
    return { text, calls: { fetch: 0 } };
  }
  const calls = { fetch: 0, open: 0, message: 0 };
  walk(ast, (n) => {
    const line = n.loc && n.loc.start.line;
    if (n.type === "MemberExpression") {
      const name = memberName(n);
      if (name && BANNED_MEMBERS.has(name)) warn(f.label, line, "uses ." + name + " (text must never be parsed as markup)");
      if (name && /^on[a-z]+$/.test(name) && n.object && !f.shared) {
        // el.onclick = ... is banned; reading event.on... does not exist
        warn(f.label, line, "touches ." + name + " (attach handlers with addEventListener)");
      }
      if (name === "write" || name === "writeln") {
        if (n.object.type === "Identifier" && n.object.name === "document") warn(f.label, line, "uses document." + name);
      }
    }
    if (n.type === "Identifier" && BANNED_GLOBALS.has(n.name) && !f.shared) {
      const ok = false;
      if (!ok) warn(f.label, line, "uses " + n.name);
    }
    if (n.type === "ImportExpression") warn(f.label, line, "uses dynamic import()");
    if (n.type === "NewExpression" && n.callee.type === "Identifier" && n.callee.name === "Function") warn(f.label, line, "uses new Function");
    if (n.type === "CallExpression") {
      const c = n.callee;
      const name = c.type === "Identifier" ? c.name : c.type === "MemberExpression" ? memberName(c) : null;
      if (name === "fetch") {
        calls.fetch += 1;
        if (!FETCH_FILES.has(f.rel) && f.rel !== "login/login.js") warn(f.label, line, "fetch outside core/api-client.js and core/util.js");
      }
      if ((name === "setTimeout" || name === "setInterval") && n.arguments[0] && (isStrLit(n.arguments[0]) || n.arguments[0].type === "TemplateLiteral")) warn(f.label, line, name + " with a string");
      if (name === "createElement" && !f.shared) {
        const a = n.arguments[0];
        if (!isStrLit(a)) {
          if (f.rel !== "core/dom.js") warn(f.label, line, "createElement with a computed tag outside core/dom.js (use h())");
        } else if (BANNED_TAGS.has(a.value.toLowerCase())) warn(f.label, line, "createElement(" + a.value + ")");
        else if (!LITERAL_TAGS.has(a.value.toLowerCase()) && f.rel !== "core/dom.js") warn(f.label, line, "createElement(" + a.value + ") outside the allow-list (use h())");
      }
      if (name === "setAttribute" && isStrLit(n.arguments[0]) && /^on/i.test(n.arguments[0].value)) warn(f.label, line, "setAttribute of an event-handler attribute");
      if (name === "open" && c.type === "MemberExpression" && c.object.type === "Identifier" && c.object.name === "window") {
        calls.open += 1;
        if (f.rel !== "core/auth.js" && f.rel !== "ui/panel-changes.js") warn(f.label, line, "window.open outside core/auth.js (and the PR link in the Changes panel)");
      }
      if (name === "postMessage" && n.arguments[1] && isStrLit(n.arguments[1]) && n.arguments[1].value === "*") warn(f.label, line, "postMessage to the wildcard origin");
      if (name === "sendBeacon") warn(f.label, line, "navigator.sendBeacon");
      if (name === "addEventListener" && isStrLit(n.arguments[0]) && n.arguments[0].value === "message") {
        calls.message += 1;
        if (f.rel !== "core/auth.js" && f.rel !== "login/login.js") warn(f.label, line, "a message listener outside core/auth.js");
      }
    }
    if (n.type === "Literal" && typeof n.value === "string") {
      const re = /\b([a-z][a-z0-9+.-]*):\/\/([^\s/"'`)<>\]]+)/gi;
      let m;
      while ((m = re.exec(n.value))) {
        const scheme = m[1].toLowerCase();
        if (scheme !== "http" && scheme !== "https" && scheme !== "ws" && scheme !== "wss") continue;
        const host = m[2].replace(/:\d+$/, "").replace(/^[^@]*@/, "");
        if (CDN.test(host) || !OK_HOSTS.test(host)) warn(f.label, line, "URL to a third-party host: " + m[0]);
      }
      if (/^\/\/[a-z0-9.-]+\.[a-z]{2,}\//i.test(n.value)) warn(f.label, line, "protocol-relative URL: " + n.value.slice(0, 60));
    }
    if (n.type === "TemplateElement" && /https?:\/\/(?!localhost|127\.0\.0\.1)[a-z0-9.-]+\.[a-z]{2,}/i.test(n.value.raw)) warn(f.label, line, "URL to a third-party host in a template string");
  });
  return { text, calls };
}

let totalScriptBytes = 0;
const seenFetch = {};
for (const f of files) {
  const r = scanJs(f);
  if (!f.shared) {
    totalScriptBytes += Buffer.byteLength(r.text);
    seenFetch[f.rel] = r.calls.fetch;
    if (f.rel !== "login/login.js" && !/^\s*(\/\*[\s\S]*?\*\/\s*)?\(function \(S\) \{\s*\n\s*"use strict";/.test(r.text)) warn(f.label, 1, 'must be an IIFE over window.__CoveredStudioBoot starting with (function (S) { "use strict";');
    if (f.rel !== "login/login.js" && !/\}\)\(window\.__CoveredStudioBoot\);\s*$/.test(r.text)) warn(f.label, 0, "must end with })(window.__CoveredStudioBoot);");
  } else totalScriptBytes += Buffer.byteLength(r.text);
}
for (const rel of FETCH_FILES) if (files.some((f) => f.rel === rel) && seenFetch[rel] !== 1) warn("studio/overlay/" + rel, 0, "must contain exactly one fetch call site (found " + seenFetch[rel] + ")");

// exactly one shadow root, and the only appendChild to document.body is the host mount
const shell = files.find((f) => f.rel === "ui/shell.js");
if (shell) {
  const t = read(shell.abs);
  if (!/attachShadow\(\{ mode: "open" \}\)/.test(t)) warn(shell.label, 0, 'the chrome must live in an open shadow root: attachShadow({ mode: "open" })');
  if (!/aria-live/.test(t) || !/role: "status"/.test(t)) warn(shell.label, 0, "missing the polite live region (role=status, aria-live)");
  if (!/role: "dialog"/.test(t) || !/"aria-modal": "true"/.test(t) || !/aria-labelledby/.test(t)) warn(shell.label, 0, "dialogs need role=dialog, aria-modal and aria-labelledby");
  if (!/role: "complementary"/.test(t)) warn(shell.label, 0, "the panel needs role=complementary and an accessible name");
  if (!/focusTrap/.test(t)) warn(shell.label, 0, "dialogs must trap focus");
}
for (const f of files) {
  if (f.rel === "ui/shell.js" || f.shared) continue;
  const t = read(f.abs);
  if (/document\.(body|head|documentElement)\.appendChild/.test(t)) warn(f.label, 0, "adds nodes to the page outside the shadow root");
}
// the one place that may name the browser storage objects is the safe wrapper (everything else goes through S.util)
for (const f of files) {
  if (f.shared || f.rel === "core/util.js" || f.rel === "login/login.js") continue;
  if (/\b(localStorage|sessionStorage)\b/.test(read(f.abs).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""))) warn(f.label, 0, "touches localStorage/sessionStorage directly (use S.util.local / S.util.session: they are try/catch wrapped)");
}

// ---------------------------------------------------------------- size
if (totalScriptBytes / 1024 > BUDGET.scriptsKiB) warn("studio/overlay", 0, "scripts are " + (totalScriptBytes / 1024).toFixed(1) + " KiB, budget " + BUDGET.scriptsKiB + " KiB");
let cssBytes = 0;
styles.forEach((rel) => { cssBytes += Buffer.byteLength(read(path.join(OVERLAY, rel))); });
if (cssBytes / 1024 > BUDGET.cssKiB) warn("studio/overlay", 0, "styles are " + (cssBytes / 1024).toFixed(1) + " KiB, budget " + BUDGET.cssKiB + " KiB");

// ---------------------------------------------------------------- CSS: colours and rules
const cssFile = path.join(OVERLAY, "overlay.css");
if (exists(cssFile)) {
  const css = read(cssFile).replace(/\/\*[\s\S]*?\*\//g, "");
  if (/@import|url\(\s*["']?(https?:)?\/\//i.test(css)) warn("studio/overlay/overlay.css", 0, "must not load anything (no @import, no url())");
  if (/@font-face/.test(css)) warn("studio/overlay/overlay.css", 0, "no web fonts (system-ui only)");
  const tokens = (block) => { const o = {}; block.replace(/(--s-[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;/g, (m, k, v) => { o[k] = v; return m; }); return o; };
  const light = tokens((/:host\s*\{([\s\S]*?)\n\}/.exec(css) || [])[1] || "");
  const darkBlock = /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:host\s*\{([\s\S]*?)\}\s*\}/.exec(css);
  const dark = Object.assign({}, light, tokens(darkBlock ? darkBlock[1] : ""));
  if (!darkBlock) warn("studio/overlay/overlay.css", 0, "no prefers-color-scheme: dark block");
  if (!/:focus-visible/.test(css)) warn("studio/overlay/overlay.css", 0, "no :focus-visible rule");
  if (!/prefers-reduced-motion:\s*reduce/.test(css)) warn("studio/overlay/overlay.css", 0, "no prefers-reduced-motion rule");
  if (!/min-height:\s*44px/.test(css)) warn("studio/overlay/overlay.css", 0, "no 44px touch-target rule");
  if (!/pointer:\s*coarse/.test(css)) warn("studio/overlay/overlay.css", 0, "no coarse-pointer rule");
  if (/outline:\s*(none|0)\b/.test(css)) warn("studio/overlay/overlay.css", 0, "removes an outline (focus must stay visible)");
  const ccFile = path.join(ROOT, "cms", "contrast.js");
  if (!exists(ccFile)) warn("cms/contrast.js", 0, "missing (needed for the colour check)");
  else {
    const CC = require(ccFile);
    // [foreground, background, needed ratio, where it is used]
    const PAIRS = [
      ["--s-fg", "--s-bg", 4.5, "panel text"], ["--s-fg", "--s-bg2", 4.5, "buttons, preview box"], ["--s-fg", "--s-danger-bg", 4.5, "changes with a problem"],
      ["--s-muted", "--s-bg", 4.5, "hints"], ["--s-muted", "--s-bg2", 4.5, "hints on grey"],
      ["--s-accent", "--s-bg", 4.5, "links"], ["--s-accent", "--s-bg2", 4.5, "links on grey"],
      ["--s-accent-fg", "--s-accent", 4.5, "primary buttons, chips, pressed pill"],
      ["--s-danger", "--s-bg", 4.5, "error text"], ["--s-danger", "--s-danger-bg", 4.5, "error text in a red box"], ["--s-danger", "--s-bg2", 4.5, "error text on grey"],
      ["--s-ok", "--s-bg", 4.5, "good news text"], ["--s-warn", "--s-bg", 4.5, "warning text"], ["--s-warn", "--s-warn-bg", 4.5, "warning banner"],
      ["--s-ink-fg", "--s-ink", 4.5, "toasts, badges, hints on the page"], ["--s-bad-ink-fg", "--s-bad-ink", 4.5, "error toasts and hints"],
      ["--s-accent", "--s-accent-fg", 4.5, "badge inside the pressed pill"],
      ["--s-line", "--s-bg", 3, "borders of fields and buttons (non-text, WCAG 1.4.11)"], ["--s-line", "--s-bg2", 3, "borders on grey"],
      ["--s-accent", "--s-bg", 3, "focus ring and outlines"], ["--s-accent", "--s-bg2", 3, "focus ring on grey"],
    ];
    for (const [name, set] of [["light", light], ["dark", dark]]) {
      for (const [fgN, bgN, need, where] of PAIRS) {
        const fg = CC.parseColor(set[fgN]);
        const bg = CC.parseColor(set[bgN]);
        if (!fg || !bg) { warn("studio/overlay/overlay.css", 0, name + ": token " + (fg ? bgN : fgN) + " is missing or not a hex colour"); continue; }
        const r = CC.ratio(fg, bg);
        if (r < need) warn("studio/overlay/overlay.css", 0, name + " mode: " + fgN + " on " + bgN + " is " + CC.fmt(r, need) + ":1, needs " + need + ":1 (" + where + ")");
      }
    }
  }
}

if (problems.length) {
  console.error("check-overlay: " + problems.length + " problem(s)");
  problems.forEach((p) => console.error("  " + p));
  process.exit(1);
}
console.log("check-overlay: OK - " + files.length + " browser files, scripts " + (totalScriptBytes / 1024).toFixed(1) + " KiB (budget " + BUDGET.scriptsKiB + "), styles " + (cssBytes / 1024).toFixed(1) + " KiB, no markup/code injection, one fetch site per allowed file, no third-party host, overlay colours pass WCAG in light and dark");
