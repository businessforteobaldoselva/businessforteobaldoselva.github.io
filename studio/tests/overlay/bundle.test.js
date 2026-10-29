"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { bundle, DIR } = require("../../overlay/bundle.js");
const { FIX, load } = require("./load");

test("the manifest lists real files (D's ext/ files may be absent), in the contract order", () => {
  const m = JSON.parse(fs.readFileSync(path.join(DIR, "manifest.json"), "utf8"));
  const must = m.scripts.filter((s) => !s.startsWith("ext/"));
  for (const s of must) assert.ok(fs.existsSync(path.join(DIR, s)), s);
  const want = ["core/util.js", "core/events.js", "core/dom.js", "core/state.js", "core/schema-client.js", "core/validate-client.js", "core/api-client.js", "core/auth.js", "core/staging.js", "core/images.js", "core/patch-builder.js", "core/drafts.js", "ui/shell.js", "ui/inspect.js", "ui/editors.js", "ui/panel-changes.js", "ui/panel-sections.js", "ui/panel-fields.js", "ui/panel-account.js", "ext/history.js", "ext/help.js", "ext/tour.js", "ext/palette.js", "main.js"];
  assert.deepEqual(m.scripts.filter((s) => want.includes(s)), want, "design 10.4 order");
  assert.equal(m.scripts[m.scripts.length - 1], "main.js");
});

test("bundle() is one plain script that parses, embeds the schema as data and the css as strings", () => {
  const warnings = [];
  const text = bundle({ schemaPath: path.join(FIX, "schema.json"), warn: (w) => warnings.push(w) });
  new vm.Script(text, { filename: "overlay.js" }); // throws on a syntax error
  assert.ok(text.startsWith("(function () {"));
  assert.match(text, /window\.__CoveredStudioBoot = S;/);
  assert.match(text, /S\.schema = \{"schemaVersion":1/);
  assert.match(text, /S\.css\.push\("/);
  assert.ok(warnings.every((w) => /ext\//.test(w)), "only D's optional files may be missing: " + warnings.join("; "));
  assert.ok(Buffer.byteLength(text) < 400 * 1024, "bundle size " + Buffer.byteLength(text));
});

test("bundle() copes with a missing schema (the overlay then explains) and CRLF sources", () => {
  const warnings = [];
  const text = bundle({ schemaPath: path.join(FIX, "does-not-exist.json"), warn: (w) => warnings.push(w) });
  assert.ok(warnings.some((w) => /no generated schema/.test(w)));
  assert.doesNotMatch(text, /\r/);
});

test("the bundle never boots unless the visit asked for Studio: no DOM, no network, nothing in a normal page", () => {
  const text = bundle({ schemaPath: path.join(FIX, "schema.json"), warn() {} });
  const touched = [];
  const doc = new Proxy({}, { get: (_, k) => { touched.push("document." + String(k)); return () => {}; } });
  const fetch = () => { touched.push("fetch"); return Promise.reject(new Error("no")); };
  const win = { location: { search: "", hash: "" }, addEventListener() {}, localStorage: { getItem: () => null, setItem() {} }, sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} } };
  const ctx = vm.createContext({ window: win, self: win, location: win.location, document: doc, fetch, console, URL, setTimeout, clearTimeout, Promise, Symbol, Map, WeakMap, JSON, Object, Array, Math, Date, Uint8Array });
  vm.runInContext(text, ctx);
  assert.deepEqual(touched, [], "a visitor without ?studio=1 gets no DOM access and no request");
});

test("static: the shipped bundle contains none of the banned constructs", () => {
  const text = bundle({ schemaPath: path.join(FIX, "schema.json"), warn() {} }).replace(/S\.schema = .*\n/, "").replace(/S\.css\.push\(.*\);\n/g, "").replace(/\/\* PAIRS:BEGIN \*\/[\s\S]*\/\* PAIRS:END \*\//, "");
  for (const re of [/\.innerHTML\b/, /\.outerHTML\b/, /insertAdjacentHTML/, /document\.write/, /\beval\s*\(/, /new Function\s*\(/, /srcdoc/]) assert.doesNotMatch(text, re, String(re));
});
