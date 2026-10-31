#!/usr/bin/env node
"use strict";
// check-ai-overlay (Phase 5, UI unit): static and behavioural rules for the "Describe a change" panel
// (studio/overlay/ext/ai-view.js, ai.js, ai.css; studio/AI-DESIGN.md 14, 17.3).
//
//   node studio/guards/check-ai-overlay.js [--root <repo>]
//
//  1. The files parse (acorn), keep the overlay shape (IIFE over window.__CoveredStudioBoot) and are listed in the manifest in
//     the right order (ai-view.js before ai.js, both after palette.js and before main.js; ai.css after ext.css).
//  2. Text safety (AI-DESIGN 14.7): no innerHTML / outerHTML / insertAdjacentHTML / document.write / eval / new Function /
//     string timers / createElement / srcdoc / import() / on*-property / DOMParser; every el() call uses a LITERAL tag from the
//     list h() allows and only props h() allows (no `style`, no `on*` attributes); a link target (`href`) only ever receives a
//     value that went through httpUrl() / V.askClaudeUrl(); target=_blank always comes with rel=noopener.
//  3. No network and no secrets: no fetch / XMLHttpRequest / WebSocket / EventSource / sendBeacon, no URL literal to another host;
//     the only calls to studio.api are GET /v1/ai/status and POST /v1/ai/propose|accept; the strings STUDIO_AI_API_KEY, x-api-key,
//     api.anthropic.com and anthropic-version appear in NO file under studio/overlay or studio/login.
//  4. ai-view.js is PURE: no document, window (apart from the closing IIFE argument), navigator, location, storage, timers,
//     Date, Math.random or console. The UI never edits the model's ops (no assignment to .ops/.expect/.file/.path/.value/.op/.from).
//  5. Behaviour (ai-view.js is loaded and exercised): flagged changes are never pre-ticked (even when the server says
//     defaultChecked), ticking a change ticks what it needs and unticking one unticks what needs it, the propose/accept bodies have
//     exactly the allowed keys, hostile text is cleaned, a lying diff is dropped, every state has copy and every error code has
//     fixed plain-English copy that never echoes server text, every sample proposal renders.
//  6. ai.js paints a screen for every state of the state machine.
//  7. ai.css: no @import / external url() / web font, a :focus-visible rule, reduced motion, dark mode, 44 px coarse-pointer
//     targets, and every text/background pair of its fixed colours meets WCAG 2.2 in light and dark (cms/contrast.js).
//  8. Budgets: check-overlay.js may not raise the script budget above 330 KiB or the style budget above 48 KiB.
//  9. The founders' runbook has the "Describe a change" section.
// Exit 0 clean, 1 on any violation. No network, no build.

const fs = require("fs");
const path = require("path");

const argv = process.argv.slice(2);
const ROOT = path.resolve(argv.indexOf("--root") >= 0 ? argv[argv.indexOf("--root") + 1] : path.resolve(__dirname, "..", ".."));
const acorn = require(path.join(ROOT, "node_modules", "acorn"));

const problems = [];
const fail = (where, msg) => problems.push(where + ": " + msg);
const read = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const rel = (p) => path.relative(ROOT, p).split(path.sep).join("/");
const OVERLAY = path.join(ROOT, "studio", "overlay");
const FILES = { view: "studio/overlay/ext/ai-view.js", panel: "studio/overlay/ext/ai.js", css: "studio/overlay/ext/ai.css" };

// ---- what h() allows (studio/overlay/core/dom.js): tags and properties
const TAGS = new Set("div span p a button input textarea select option label form fieldset legend ul ol li h1 h2 h3 h4 h5 h6 strong em code pre table thead tbody tr th td img canvas small br hr details summary section header footer nav main aside figure figcaption kbd mark".split(" "));
// and what this panel actually needs (a narrower list: anything else is a decision somebody should take on purpose)
const USED_TAGS = new Set("div span p a button input textarea label ul li h3 h4 h5 strong".split(" "));
const PROPS = new Set("class id type value placeholder title role tabindex hidden disabled checked rows for name href target rel maxlength spellcheck readonly required".split(" "));
const BANNED_MEMBERS = new Set(["innerHTML", "outerHTML", "insertAdjacentHTML", "insertAdjacentElement", "srcdoc", "createContextualFragment", "execCommand", "parseFromString", "cookie"]);
const NET = new Set(["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "sendBeacon", "importScripts", "Worker", "SharedWorker"]);
const IMPURE = new Set(["document", "navigator", "location", "localStorage", "sessionStorage", "indexedDB", "setTimeout", "setInterval", "clearTimeout", "clearInterval", "requestAnimationFrame", "Date", "console", "performance", "XMLHttpRequest", "fetch", "AbortController", "Image", "Audio"]);
const OPS_FIELDS = new Set(["ops", "expect", "file", "path", "value", "op", "from"]);
const API_PATHS = { get: ["/v1/ai/status"], post: ["/v1/ai/propose", "/v1/ai/accept"] };
const SECRET_STRINGS = ["STUDIO_AI_API_KEY", "x-api-key", "api.anthropic.com", "anthropic-version"];
const OK_HOSTS = /^(localhost|127\.0\.0\.1|(www\.)?example\.(com|test|org)|[a-z0-9-]+\.test)$/i;

function exists(rp) { return fs.existsSync(path.join(ROOT, rp)); }
for (const rp of Object.values(FILES)) if (!exists(rp)) fail(rp, "is missing");
if (problems.length) done();

function walk(node, fn, parent, key) {
  if (!node || typeof node.type !== "string") return;
  fn(node, parent, key);
  for (const k of Object.keys(node)) {
    if (k === "loc" || k === "start" || k === "end") continue;
    const v = node[k];
    if (Array.isArray(v)) v.forEach((c) => c && typeof c.type === "string" && walk(c, fn, node, k));
    else if (v && typeof v.type === "string") walk(v, fn, node, k);
  }
}
const isStr = (n) => n && n.type === "Literal" && typeof n.value === "string";
const memberName = (n) => (n.computed ? (isStr(n.property) ? n.property.value : null) : n.property.name);
const keyName = (p) => (p.key.type === "Identifier" && !p.computed ? p.key.name : isStr(p.key) ? p.key.value : null);

function parse(rp) {
  const text = read(path.join(ROOT, rp));
  let ast;
  try { ast = acorn.parse(text, { ecmaVersion: 2022, sourceType: "script", locations: true }); } catch (e) { fail(rp, "does not parse (" + e.message + ")"); return null; }
  if (!/^(\/\*[\s\S]*?\*\/\s*)?\(function \(S\) \{\s*\n\s*"use strict";/.test(text.replace(/^(\s*\/\/[^\n]*\n)+/, ""))) fail(rp, 'must be an IIFE over window.__CoveredStudioBoot starting with (function (S) { "use strict";');
  if (!/\}\)\(window\.__CoveredStudioBoot\);\s*$/.test(text)) fail(rp, "must end with })(window.__CoveredStudioBoot);");
  return { text, ast, rp };
}
const at = (f, n) => f.rp + ":" + (n.loc ? n.loc.start.line : "?");

// ------------------------------------------------------------------ 1-4: static rules on the two scripts
const view = parse(FILES.view);
const panel = parse(FILES.panel);
for (const f of [view, panel]) {
  if (!f) continue;
  walk(f.ast, (n, parent) => {
    if (n.type === "MemberExpression") {
      const name = memberName(n);
      if (name && BANNED_MEMBERS.has(name)) fail(at(f, n), "uses ." + name + " (text must never be parsed as markup)");
      if (name && /^on[a-z]+$/.test(name)) fail(at(f, n), "touches ." + name + " (attach handlers through el(... { on: { ... } }))");
      if (n.computed && (n.property.type === "TemplateLiteral" || (n.property.type === "BinaryExpression" && n.property.operator === "+" && (isStr(n.property.left) || isStr(n.property.right))))) fail(at(f, n), "a member name built from text cannot be checked");
      if ((name === "write" || name === "writeln") && n.object.type === "Identifier" && n.object.name === "document") fail(at(f, n), "uses document." + name);
    }
    if (n.type === "Identifier") {
      const isProp = parent && ((parent.type === "MemberExpression" && parent.property === n && !parent.computed) || (parent.type === "Property" && parent.key === n && !parent.computed && !parent.shorthand));
      if (!isProp) {
        if (NET.has(n.name)) fail(at(f, n), "references " + n.name + " (every server call goes through studio.api)");
        if (n.name === "eval" || n.name === "Function" || n.name === "DOMParser") fail(at(f, n), "uses " + n.name);
      }
    }
    if (n.type === "ImportExpression") fail(at(f, n), "uses import()");
    if (n.type === "NewExpression" && n.callee.type === "Identifier" && n.callee.name === "Function") fail(at(f, n), "uses new Function");
    if (n.type === "CallExpression") {
      const c = n.callee;
      const name = c.type === "Identifier" ? c.name : c.type === "MemberExpression" ? memberName(c) : null;
      if ((name === "setTimeout" || name === "setInterval") && n.arguments[0] && (isStr(n.arguments[0]) || n.arguments[0].type === "TemplateLiteral")) fail(at(f, n), name + " with a string");
      if (name === "createElement" || name === "createElementNS" || name === "createDocumentFragment") fail(at(f, n), name + " (use el() / h(): its tag list is the allow-list)");
      if (name === "setAttribute" && (!isStr(n.arguments[0]) || /^(on|href$|src$|srcdoc$|style$|action$|formaction$)/i.test(n.arguments[0].value))) fail(at(f, n), "setAttribute with a name that is not a safe literal");
      if (name === "postMessage" || name === "open" && c.type === "MemberExpression" && c.object.type === "Identifier" && c.object.name === "window") fail(at(f, n), "uses " + name);
    }
    if (n.type === "AssignmentExpression" && n.left.type === "MemberExpression") {
      const name = memberName(n.left);
      if (name && /^on[a-z]+$/.test(name)) fail(at(f, n), "assigns ." + name);
      if (name && OPS_FIELDS.has(name) && n.left.object.type !== "ThisExpression") fail(at(f, n), "assigns ." + name + ": the panel must never edit the ops the model proposed (they go back to the server exactly as received)");
    }
    if (n.type === "CallExpression" && n.callee.type === "MemberExpression" && memberName(n.callee) === "push" && n.callee.object.type === "MemberExpression" && memberName(n.callee.object) === "ops") fail(at(f, n), "pushes onto .ops");
    if (n.type === "Literal" && typeof n.value === "string") {
      const re = /\b([a-z][a-z0-9+.-]*):\/\/([^\s/"'`)<>\]]+)/gi;
      let m;
      while ((m = re.exec(n.value))) {
        const host = m[2].replace(/:\d+$/, "").replace(/^[^@]*@/, "");
        if (!OK_HOSTS.test(host)) fail(at(f, n), "URL literal to another host: " + m[0]);
      }
    }
  });
}

if (view) {
  // 4. purity of the view model
  walk(view.ast, (n, parent) => {
    if (n.type !== "Identifier") return;
    const isProp = parent && ((parent.type === "MemberExpression" && parent.property === n && !parent.computed) || (parent.type === "Property" && parent.key === n && !parent.computed && !parent.shorthand));
    if (isProp) return;
    if (IMPURE.has(n.name)) fail(at(view, n), "ai-view.js must stay pure but references " + n.name);
    if (n.name === "window") {
      const ok = parent && parent.type === "MemberExpression" && parent.property && parent.property.name === "__CoveredStudioBoot";
      if (!ok) fail(at(view, n), "ai-view.js must stay pure but references window");
    }
  });
  walk(view.ast, (n) => {
    if (n.type === "MemberExpression" && n.object.type === "Identifier" && n.object.name === "Math" && memberName(n) === "random") fail(at(view, n), "ai-view.js must be deterministic (Math.random)");
  });
}

if (panel) {
  const elLike = new Set(["el"]);
  walk(panel.ast, (n) => {
    // 2. every el(...) call: literal tag from the lists, props from the list
    if (n.type === "CallExpression" && n.callee.type === "Identifier" && elLike.has(n.callee.name)) {
      const tag = n.arguments[0];
      if (!isStr(tag) || !TAGS.has(tag.value)) fail(at(panel, n), "el() tag is not a literal from the allowed list: " + (isStr(tag) ? tag.value : "(computed)"));
      else if (!USED_TAGS.has(tag.value)) fail(at(panel, n), "el(" + tag.value + "): this panel's tag list is div span p a button input textarea label ul li h3 h4 h5 strong; widen it on purpose");
      const props = n.arguments[1];
      if (props && props.type === "ObjectExpression") {
        for (const p of props.properties) {
          if (p.type !== "Property") { fail(at(panel, p), "el() props must be a plain object literal (no spread)"); continue; }
          const k = keyName(p);
          if (k === null) { fail(at(panel, p), "el() prop name is computed"); continue; }
          if (k === "on") continue;
          if (!(PROPS.has(k) || /^aria-[a-z]+$/.test(k) || /^data-[a-z-]+$/.test(k))) fail(at(panel, p), "el() prop not allowed: " + k);
          if (k === "href") {
            const v = p.value;
            const okValue = (v.type === "Identifier" && /^(ask|pv)$/.test(v.name)) || (v.type === "CallExpression" && v.callee.type === "Identifier" && v.callee.name === "httpUrl");
            if (!okValue) fail(at(panel, p), "a link target must come from httpUrl() or V.askClaudeUrl() (found " + v.type + ")");
          }
          if (k === "target" && isStr(p.value) && p.value.value === "_blank" && !props.properties.some((q) => q.type === "Property" && keyName(q) === "rel" && isStr(q.value) && /noopener/.test(q.value.value))) fail(at(panel, p), 'target "_blank" without rel "noopener noreferrer"');
        }
      } else if (props && !(props.type === "Literal" && props.value === null)) fail(at(panel, n), "el() props must be an object literal or null");
    }
    // 3. studio.api calls
    if (n.type === "CallExpression" && n.callee.type === "MemberExpression" && n.callee.object.type === "MemberExpression" && memberName(n.callee.object) === "api") {
      const verb = memberName(n.callee);
      const first = n.arguments[0];
      if (!API_PATHS[verb]) fail(at(panel, n), "studio.api." + verb + " is not allowed here");
      else if (!isStr(first) || API_PATHS[verb].indexOf(first.value) < 0) fail(at(panel, n), "studio.api." + verb + " may only be called with " + API_PATHS[verb].join(" or ") + " (a literal)");
    }
  });
  // everything the panel puts in the page that came from the server goes through h() children / textContent: no `value:` of a
  // non-input and no raw markup is possible because innerHTML is banned above; here make sure textContent receives strings only
  walk(panel.ast, (n) => {
    if (n.type === "AssignmentExpression" && n.left.type === "MemberExpression" && memberName(n.left) === "textContent" && n.right.type === "ObjectExpression") fail(at(panel, n), "textContent assigned an object");
  });
  // 6. a screen for every state of the state machine
  for (const ph of ["signedOut", "loadingStatus", "off", "idle", "working", "result", "saving", "saved", "error"]) {
    if (!new RegExp('p === "' + ph + '"').test(panel.text)) fail(FILES.panel, 'paint() has no screen for the state "' + ph + '"');
  }
  for (const sc of ["screenPatch", "screenTone", "screenNeedsCode", "screenClarify"]) if (!panel.text.includes("function " + sc)) fail(FILES.panel, "missing " + sc);
  for (const id of ["ai.describe", "ai.alt", "ai.meta", "ai.tone"]) if (!panel.text.includes('"' + id + '"')) fail(FILES.panel, "missing the command " + id);
  if (!/registerPanel\(\{\s*id: "ai"/.test(panel.text) || !/minRole: "editor"/.test(panel.text)) fail(FILES.panel, 'the panel must register as id "ai" with minRole "editor"');
  if (!/role: "status", "aria-live": "polite"/.test(panel.text)) fail(FILES.panel, "the progress / count live region (role=status aria-live=polite) is missing");
  if (!/role: "alert"/.test(panel.text)) fail(FILES.panel, "errors must be role=alert");
}

// ------------------------------------------------------------------ 3b: secrets and hosts in ANY overlay or login file
function* filesUnder(dir) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* filesUnder(p);
    else if (/\.(js|css|json|html|map)$/.test(e.name)) yield p;
  }
}
for (const dir of [OVERLAY, path.join(ROOT, "studio", "login")]) {
  for (const f of filesUnder(dir)) {
    const t = fs.readFileSync(f, "utf8");
    for (const s of SECRET_STRINGS) if (t.toLowerCase().includes(s.toLowerCase())) fail(rel(f), "mentions " + s + " (the AI key and the model host never appear in browser files)");
  }
}

// ------------------------------------------------------------------ 1b: manifest order
try {
  const man = JSON.parse(read(path.join(OVERLAY, "manifest.json")));
  const s = man.scripts || [];
  const ix = (x) => s.indexOf(x);
  if (ix("ext/ai-view.js") < 0 || ix("ext/ai.js") < 0) fail("studio/overlay/manifest.json", "ext/ai-view.js and ext/ai.js must be listed");
  else {
    if (!(ix("ext/ai-view.js") < ix("ext/ai.js"))) fail("studio/overlay/manifest.json", "ext/ai-view.js must come before ext/ai.js");
    if (!(ix("ext/palette.js") >= 0 && ix("ext/ai-view.js") > ix("ext/palette.js"))) fail("studio/overlay/manifest.json", "the AI panel must come after ext/palette.js");
    if (!(ix("ext/ai.js") < ix("main.js"))) fail("studio/overlay/manifest.json", "the AI panel must come before main.js");
  }
  const st = man.styles || [];
  if (st.indexOf("ext/ai.css") < 0 || st.indexOf("ext/ai.css") < st.indexOf("ext/ext.css")) fail("studio/overlay/manifest.json", "ext/ai.css must be listed after ext/ext.css");
} catch (e) { fail("studio/overlay/manifest.json", "cannot be read: " + e.message); }

// ------------------------------------------------------------------ 5: behaviour of the view model
let V = null;
if (view && !problems.length) {
  try {
    globalThis.window = globalThis.window || {};
    delete require.cache[require.resolve(path.join(ROOT, FILES.view))];
    V = require(path.join(ROOT, FILES.view));
  } catch (e) { fail(FILES.view, "cannot be loaded under node: " + e.message); }
}
if (V) {
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const need = (cond, msg) => { if (!cond) fail(FILES.view, msg); };
  const SAMPLE_FILE = path.join(ROOT, "studio", "tests", "fixtures", "ai-proposals.sample.json");
  const sample = fs.existsSync(SAMPLE_FILE) ? JSON.parse(read(SAMPLE_FILE)) : null;
  const clone = (x) => JSON.parse(JSON.stringify(x));
  try {
    // defaults: a flagged change is never ticked for you
    const mk = (id, o) => Object.assign({ id, title: "t " + id, ops: [{ op: "replace", file: "src/_data/hero.json", path: "/x" + id, value: "v", expect: "e" }], deltas: [], requires: [], outsideAsk: false, sensitive: false, defaultChecked: true }, o || {});
    const prop = { id: "p_aaaaaaaaaaaa", kind: "patch", mode: "edit", summary: "s", base: { sha: "a".repeat(40), draftId: null, headSha: null }, instructionHash: "0123456789abcdef", model: "m", changes: [mk("c1"), mk("c2", { outsideAsk: true }), mk("c3", { sensitive: true }), mk("c4", { requires: ["c1"] })] };
    const view1 = V.normalizeProposal(clone(prop));
    const ticks = V.initialChecked(view1.changes);
    need(eq([ticks.c1, ticks.c2, ticks.c3, ticks.c4], [true, false, false, true]), "flagged changes (outsideAsk / sensitive) must start unticked even when the server says defaultChecked");
    const off1 = clone(prop); off1.changes[0].defaultChecked = false;
    need(V.initialChecked(V.normalizeProposal(off1).changes).c1 === false, "a change the server did not tick must start unticked");
    // closure
    const t1 = V.toggle(view1.changes, { c1: false, c2: false, c3: false, c4: false }, "c4", true);
    need(t1.checked.c1 === true && t1.checked.c4 === true, "ticking a change must tick the change it needs");
    const t2 = V.toggle(view1.changes, { c1: true, c2: false, c3: false, c4: true }, "c1", false);
    need(t2.checked.c1 === false && t2.checked.c4 === false, "unticking a change must untick the changes that need it");
    need(V.normalizeChecked(view1.changes, { c1: false, c4: true }).c4 === false, "a selection that is not closed must be repaired by unticking");
    // request bodies
    const st = Object.assign(V.initialState({ signedIn: true }), { mode: "edit", instruction: " hi ", refs: ["hero.headlineMain", "<x>"] });
    const pb = V.buildProposeBody(st, "6b1d2c3e-4f50-4a61-8b72-9c8d7e6f5a40", { page: "index", draftId: "d" });
    need(Object.keys(pb).every((k) => ["idempotencyKey", "mode", "instruction", "context", "draftId", "retryOf", "feedback"].indexOf(k) >= 0), "the propose body may only have idempotencyKey, mode, instruction, context, draftId, retryOf, feedback");
    need(eq(pb.context, { refs: ["hero.headlineMain"] }), "unsafe refs must be dropped from the request");
    let s2 = V.reduce(V.reduce(V.initialState({ signedIn: true }), { type: "status", status: { enabled: true } }), { type: "instruction", text: "x" });
    s2 = V.reduce(s2, { type: "submit", key: "k" });
    s2 = V.reduce(s2, { type: "result", proposal: clone(prop) });
    s2 = V.reduce(s2, { type: "toggle", id: "c4", on: false });
    const ab = V.buildAcceptBody(s2, "k2");
    need(eq(Object.keys(ab).sort(), ["accept", "idempotencyKey", "proposal", "title"]) || eq(Object.keys(ab).sort(), ["accept", "idempotencyKey", "proposal"]), "the accept body must be exactly idempotencyKey, proposal, accept (and title)");
    need(eq(Object.keys(ab.proposal).sort(), ["base", "changes", "id", "instructionHash", "instructionPreview", "model"]), "the accepted proposal must carry only id, instructionHash, instructionPreview, base, model, changes");
    need(ab.proposal.changes.every((c) => eq(Object.keys(c).sort(), ["id", "ops", "title"])), "changes go back as {id, title, ops} only (no deltas, no flags)");
    need(eq(ab.proposal.changes[0].ops, prop.changes[0].ops), "ops must go back to the server exactly as received");
    need(eq(ab.accept, ["c1"]), "accept must list exactly the ticked change ids (c1 here; c2 and c3 start unticked, c4 was unticked)");
    // hygiene and the diff law
    const c = V.clean("a\u0000b‮c⁦d e", 100);
    need(c === "abcde", "clean() must remove control and bidi characters");
    need(V.clean("x".repeat(5000), 50).length === 50, "clean() must cap the length");
    const D = { before: { type: "text", text: "a b" }, after: { type: "text", text: "a c" } };
    need(V.diffOk([{ t: "same", s: "a " }, { t: "del", s: "b" }, { t: "ins", s: "c" }], D.before, D.after) === true, "a diff that rebuilds both texts must be accepted");
    need(V.diffOk([{ t: "same", s: "zzz" }], D.before, D.after) === false, "a diff that does not rebuild the texts must be dropped");
    // copy for every state and every error code
    for (const k of ["signedOut", "loading", "off_disabled", "off_no_key", "off_budget_exhausted", "working0", "working8", "working20", "safety", "savedTitle", "savedLine", "savedToast", "needsCodeTitle", "needsCodeLine", "clarifyTitle", "toneNone", "empty", "cancelled", "generic", "conflict", "validation", "ai_unavailable", "ai_bad_output", "rate_limited", "too_long", "offline", "unauthorized", "forbidden"]) need(typeof V.COPY[k] === "string" && V.COPY[k].length > 8, "missing copy: " + k);
    need(/switched off/.test(V.offCopy("disabled")) && /not connected/.test(V.offCopy("no_key")) && /allowance is used up/.test(V.offCopy("budget_exhausted")), "the three off reasons must each say what is going on in plain English");
    need(/approver/.test(V.COPY.safety) && /approver/.test(V.COPY.savedLine), "the copy must say that nothing goes live until an approver publishes it");
    for (const code of ["ai_disabled", "ai_budget_exhausted", "rate_limited", "ai_unavailable", "ai_bad_output", "bad_request", "payload_too_large", "conflict", "base_moved", "validation_failed", "unauthorized", "forbidden", "offline", "internal", "never_seen_before"]) {
      const info = V.errorInfo({ code, message: "SECRET-SERVER-TEXT <b>x</b>", requestId: "11111111-2222-4333-8444-555555555555" });
      need(info.message && info.message.length > 8, "no copy for the error " + code);
      need(!/SECRET-SERVER-TEXT/.test(info.message), "the error " + code + " shows the server's own words");
    }
    // state machine reaches every state
    const seen = {};
    let s = V.initialState({ signedIn: false }); seen[s.phase] = 1;
    s = V.reduce(s, { type: "auth", signedIn: true }); seen[s.phase] = 1;
    seen[V.reduce(s, { type: "status", status: { enabled: false, reason: "disabled" } }).phase] = 1;
    s = V.reduce(s, { type: "status", status: { enabled: true } }); seen[s.phase] = 1;
    s = V.reduce(V.reduce(s, { type: "instruction", text: "x" }), { type: "submit", key: "k" }); seen[s.phase] = 1;
    seen[V.reduce(s, { type: "fail", error: { code: "ai_unavailable" } }).phase] = 1;
    s = V.reduce(s, { type: "result", proposal: clone(prop) }); seen[s.phase] = 1;
    s = V.reduce(s, { type: "save", key: "k3" }); seen[s.phase] = 1;
    s = V.reduce(s, { type: "saved", saved: {} }); seen[s.phase] = 1;
    for (const ph of ["signedOut", "loadingStatus", "off", "idle", "working", "result", "saving", "saved", "error"]) need(seen[ph], 'the state "' + ph + '" cannot be reached');
    // every sample proposal renders
    if (sample) {
      for (const [name, p] of Object.entries(sample.proposals || {})) {
        const v = V.normalizeProposal(clone(p));
        need(v && v.kind === p.kind && v.changes.length === (p.changes || []).length, "the sample proposal '" + name + "' does not render");
      }
    } else fail("studio/tests/fixtures/ai-proposals.sample.json", "is missing");
  } catch (e) { fail(FILES.view, "behaviour check crashed: " + (e && e.stack || e)); }
}

// ------------------------------------------------------------------ 7: ai.css
if (exists(FILES.css)) {
  const css = read(path.join(ROOT, FILES.css)).replace(/\/\*[\s\S]*?\*\//g, "");
  if (/@import|url\(|@font-face|expression\(/i.test(css)) fail(FILES.css, "must not load anything (no @import, url(), web fonts)");
  if (!/:focus-visible/.test(css)) fail(FILES.css, "no :focus-visible rule");
  if (/outline:\s*(none|0)\b/.test(css.replace(/\.csx-ai-h:focus \{[^}]*\}/, "").replace(/\.csx-ai-card:focus \{[^}]*\}/, ""))) fail(FILES.css, "removes an outline (focus must stay visible)");
  if (!/prefers-reduced-motion:\s*reduce/.test(css)) fail(FILES.css, "no prefers-reduced-motion rule");
  if (!/prefers-color-scheme:\s*dark/.test(css)) fail(FILES.css, "no dark-mode block");
  if (!/pointer:\s*coarse/.test(css) || !/min-height:\s*44px/.test(css)) fail(FILES.css, "no 44px coarse-pointer rule");
  if (!/unicode-bidi:\s*plaintext/.test(css)) fail(FILES.css, "model and editor text must use unicode-bidi: plaintext (right-to-left text)");
  if (!/text-decoration:\s*underline/.test(css) || !/text-decoration:\s*line-through/.test(css)) fail(FILES.css, "added and removed text must differ by more than colour (underline / line-through)");
  const tokens = (block) => { const o = {}; block.replace(/(--csx-[a-z-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;/g, (m, k, v) => { o[k] = v; return m; }); return o; };
  const light = tokens((/\.csx-ai \{([\s\S]*?)\n\}/.exec(css) || [])[1] || "");
  const darkBlock = /@media \(prefers-color-scheme: dark\) \{\s*\.csx-ai \{([\s\S]*?)\}\s*\}/.exec(css);
  const dark = Object.assign({}, light, tokens(darkBlock ? darkBlock[1] : ""));
  const ccFile = path.join(ROOT, "cms", "contrast.js");
  if (!Object.keys(light).length) fail(FILES.css, "the .csx-ai colour tokens (--csx-*) were not found");
  else if (!fs.existsSync(ccFile)) fail("cms/contrast.js", "missing (needed for the colour check)");
  else {
    const CC = require(ccFile);
    const PAIRS = [
      ["--csx-fg", "--csx-bg", 4.5, "body text"], ["--csx-muted", "--csx-bg", 4.5, "hints"], ["--csx-muted", "--csx-soft", 4.5, "hints on grey"],
      ["--csx-fg", "--csx-soft", 4.5, "notes, chips, read-only boxes"], ["--csx-accent-fg", "--csx-accent", 4.5, "buttons, the pressed mode"],
      ["--csx-accent", "--csx-bg", 4.5, "quiet buttons and links"], ["--csx-danger", "--csx-bg", 4.5, "error text"], ["--csx-danger", "--csx-danger-bg", 4.5, "error box and cards with a problem"],
      ["--csx-fg", "--csx-ins-bg", 4.5, "added text"], ["--csx-fg", "--csx-del-bg", 4.5, "removed text"], ["--csx-warn-fg", "--csx-warn-bg", 4.5, "flags and the injection note"],
      ["--csx-edge", "--csx-bg", 3, "borders of fields and chips (non-text)"], ["--csx-focus", "--csx-bg", 3, "focus ring"], ["--csx-focus", "--csx-soft", 3, "focus ring on grey"],
    ];
    for (const [mode, set] of [["light", light], ["dark", dark]]) {
      for (const [a, b, need, where] of PAIRS) {
        const fg = CC.parseColor(set[a]);
        const bg = CC.parseColor(set[b]);
        if (!fg || !bg) { fail(FILES.css, mode + ": token " + (fg ? b : a) + " is missing or not a hex colour"); continue; }
        const r = CC.ratio(fg, bg);
        if (r < need) fail(FILES.css, mode + " mode: " + a + " on " + b + " is " + CC.fmt(r, need) + ":1, needs " + need + ":1 (" + where + ")");
      }
    }
  }
}

// ------------------------------------------------------------------ 8: budgets
try {
  const co = read(path.join(ROOT, "studio", "guards", "check-overlay.js"));
  const m = /const BUDGET = \{ scriptsKiB: (\d+), cssKiB: (\d+) \}/.exec(co);
  if (!m) fail("studio/guards/check-overlay.js", "BUDGET line not found");
  else {
    if (Number(m[1]) > 330) fail("studio/guards/check-overlay.js", "the script budget is " + m[1] + " KiB; the Phase 5 design allows at most 330");
    if (Number(m[2]) > 48) fail("studio/guards/check-overlay.js", "the style budget is " + m[2] + " KiB; the Phase 5 design allows at most 48");
  }
} catch (e) { fail("studio/guards/check-overlay.js", "cannot be read"); }

// ------------------------------------------------------------------ 9: the founders' runbook
try {
  const rb = read(path.join(ROOT, "docs", "STUDIO-RUNBOOK.md"));
  if (!/Describe a change/.test(rb)) fail("docs/STUDIO-RUNBOOK.md", 'has no "Describe a change" section for founders');
  else {
    for (const w of ["Save", "draft", "approver", "History", "Ask Claude", "Before", "After"]) if (!rb.includes(w)) fail("docs/STUDIO-RUNBOOK.md", 'the "Describe a change" section never mentions "' + w + '"');
  }
} catch (e) { fail("docs/STUDIO-RUNBOOK.md", "cannot be read"); }

done();
function done() {
  if (problems.length) {
    console.error("check-ai-overlay: " + problems.length + " problem(s)");
    problems.slice(0, 40).forEach((p) => console.error("  " + p));
    process.exit(1);
  }
  const bytes = (rp) => Buffer.byteLength(read(path.join(ROOT, rp)));
  console.log("check-ai-overlay: OK - panel " + ((bytes(FILES.view) + bytes(FILES.panel)) / 1024).toFixed(1) + " KiB of script, " + (bytes(FILES.css) / 1024).toFixed(1) + " KiB of styles; text-only rendering, literal tags, no network, no key strings, pure view model, safe defaults, closure, request shapes, copy for every state, contrast in light and dark");
}
