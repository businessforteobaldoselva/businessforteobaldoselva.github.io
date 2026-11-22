"use strict";
// The pure parts of the EDIT unit's overlay code: the legend count, "Check my changes" (grouping, gate, ignore store), the
// service-unavailable message, the palette's new rows, and the bundle's field roles.
globalThis.window = globalThis.window || {};
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const legend = require("../../overlay/ext/legend.js");
const checks = require("../../overlay/ext/checks.js");
const palette = require("../../overlay/ext/palette.js");
const { load } = require("../overlay/load.js");

const F = (severity, key) => ({ key, rule: "r", severity, file: "f", path: "/" + key, message: "m " + key, hint: "", fix: null, data: null });

test("legend: the count is distinct refs of leaf kinds, once each; wrappers are not counted", () => {
  const m = [{ ref: "a.b", kind: "text" }, { ref: "a.b", kind: "text" }, { ref: "a.c", kind: "image" }, { ref: "s.0", kind: "section" }, { ref: "i.0", kind: "item" }, { ref: "a.d", kind: "toggle" }, { ref: "a.e", kind: "link" }, { ref: "a.f", kind: "color" }, { ref: "a.g", kind: "markdown" }, { ref: "a.h", kind: "longtext" }, null, { kind: "text" }];
  assert.equal(legend.countEditable(m), 7);
  assert.deepEqual(legend.countByKind(m), { text: 1, image: 1, toggle: 1, link: 1, color: 1, markdown: 1, longtext: 1 });
  assert.equal(legend.countEditable([]), 0);
  assert.equal(legend.countEditable(undefined), 0);
});

test("legend: plain wording for none, one and many", () => {
  assert.equal(legend.chipText(14), "14 editable things here");
  assert.equal(legend.chipText(1), "1 editable thing here");
  assert.equal(legend.chipText(0), "Nothing editable here");
  assert.equal(legend.sentence(0), "Nothing on this page can be edited here; use All fields.");
  assert.equal(legend.sentence(3), "3 editable things here.");
  assert.deepEqual(legend.MOVES.map((x) => x[0]), ["]", "[", "Enter", "Esc"]);
});

test("checks: new blocks stop 'Send for review'; blocks already on the live site and warnings do not; a block can never be ignored", () => {
  const block = F("block", "new");
  const rep = (...x) => ({ findings: x });
  assert.equal(checks.gate(checks.summarize(rep(block), rep(), {})).blocked, true);
  assert.equal(checks.gate(checks.summarize(rep(block), rep(), { new: 1 })).blocked, true, "ignoring does nothing for a block");
  assert.equal(checks.gate(checks.summarize(rep(block), rep(block), {})).blocked, false);
  assert.equal(checks.gate(checks.summarize(rep(F("warn", "w"), F("info", "i")), rep(), {})).blocked, false);
  assert.equal(checks.canIgnore(block), false);
  assert.equal(checks.canIgnore(F("warn", "w")), true);
  assert.equal(checks.gate(checks.summarize(rep(block), rep(), {})).message, "Fix these first; they would stop your change from going live.");
});

test("checks: warnings that were ignored leave the open list; existing findings are marked", () => {
  const rep = (...x) => ({ findings: x });
  const s = checks.summarize(rep(F("warn", "a"), F("warn", "b"), F("block", "c")), rep(F("warn", "b")), { a: 1 });
  assert.deepEqual(s.open.map((r) => r.finding.key), ["b", "c"]);
  assert.deepEqual(s.rows.map((r) => [r.finding.key, r.existing, r.ignored]), [["a", false, true], ["b", true, false], ["c", false, false]]);
});

test("checks: status line in plain words", () => {
  const rep = (...x) => ({ findings: x });
  assert.equal(checks.statusLine(checks.summarize(rep(), rep(), {})), "Nothing to fix. Your words, links and pictures look fine.");
  assert.equal(checks.statusLine(checks.summarize(rep(F("block", "a")), rep(), {})), "1 thing to fix before sending.");
  assert.equal(checks.statusLine(checks.summarize(rep(F("block", "a"), F("block", "b"), F("warn", "c")), rep(), {})), "2 things to fix before sending, and 1 to look at.");
  assert.equal(checks.statusLine(checks.summarize(rep(F("warn", "c"), F("info", "d")), rep(), {})), "2 things worth a look. None of them stops you from sending.");
});

test("checks: the ignore list lives per draft, survives bad storage, and is capped", () => {
  const mem = new Map();
  const storage = { get: (k) => (mem.has(k) ? mem.get(k) : null), set: (k, v) => { mem.set(k, v); return true; } };
  assert.deepEqual(checks.readIgnored(storage, "d1"), {});
  assert.equal(checks.writeIgnored(storage, "d1", { a: 1, b: 1 }), true);
  assert.deepEqual(checks.readIgnored(storage, "d1"), { a: 1, b: 1 });
  assert.deepEqual(checks.readIgnored(storage, "d2"), {}, "another draft starts clean");
  mem.set(checks.ignoreKeyFor("d3"), "{not json");
  assert.deepEqual(checks.readIgnored(storage, "d3"), {});
  assert.equal(checks.writeIgnored({ set() { throw new Error("blocked"); } }, "d", { a: 1 }), false, "storage that throws is not fatal");
  const many = {}; for (let i = 0; i < 500; i++) many["k" + i] = 1;
  checks.writeIgnored(storage, "d4", many);
  assert.equal(Object.keys(checks.readIgnored(storage, "d4")).length, 300);
});

test("checks: wording promises (header, sub-line, no accessibility claim)", () => {
  assert.equal(checks.HEADER, "Check my changes");
  assert.equal(checks.SUBLINE, "These checks look at your words, links and pictures. They are not a full accessibility audit.");
  const src = fs.readFileSync(path.join(__dirname, "..", "..", "overlay", "ext", "checks.js"), "utf8");
  assert.ok(!/WCAG/.test(src));
  assert.ok(!/\baccessible\b/i.test(src));
});

test("palette: the new rows are found by their words, and every row can show a shortcut hint", () => {
  const rows = [
    { id: "fields.jump.site.metaDescription", title: "Jump to field: Site-wide > Meta description", keywords: ["The grey text under the headline", "field"], group: "Fields" },
    { id: "fields.jump.hero.headlineMain", title: "Jump to field: Hero > Headline", keywords: ["We're covering the UK,", "field"], group: "Fields" },
    { id: "sections.jump.7", title: "Jump to section: Partner wall", keywords: ["section", "jump", "partners"], group: "Sections" },
    { id: "history.recent.52", title: "Recent change: Make the hero friendlier", keywords: ["history", "published", "restore"], group: "History" },
  ];
  assert.equal(palette.search(rows, "meta description", 3)[0].id, "fields.jump.site.metaDescription");
  assert.equal(palette.search(rows, "headline", 3)[0].id, "fields.jump.hero.headlineMain");
  assert.equal(palette.search(rows, "partner wall", 3)[0].id, "sections.jump.7");
  assert.equal(palette.search(rows, "restore", 3)[0].id, "history.recent.52");
  assert.match(palette.FOOTER, /^Up\/Down to move, Enter to run, Esc to close, \? for help$/);
  assert.deepEqual(palette.mergeById([[rows[0]], [rows[0], rows[1]]]).map((r) => r.id), [rows[0].id, rows[1].id], "de-duplicated by id");
});

test("the service-unavailable sentence is the shared one and reaches the Account panel state", async () => {
  const S = load(["core/util.js", "core/events.js", "core/state.js", "core/api-client.js"], { fetch: async () => ({ ok: false, status: 503, headers: { get: () => null }, text: async () => JSON.stringify({ error: { code: "service_unavailable", message: "x", details: { service: "auth" } }, requestId: "r" }) }) });
  const seen = [];
  S.events.on("service:change", (d) => seen.push(d.down && d.down.service));
  S.api.configure({ base: "http://api.test", getToken: () => null });
  await assert.rejects(() => S.api.get("/v1/me"), (e) => e.code === "service_unavailable" && /Your edits on this page are safe/.test(e.userMessage) && e.details.service === "auth");
  assert.equal(S.state.serviceDown.message, "Studio cannot reach its sign-in service right now. Your edits on this page are safe. Try again in a minute.");
  assert.deepEqual(seen, ["auth"]);
  // the next good answer clears it
  const S2 = load(["core/util.js", "core/events.js", "core/state.js", "core/api-client.js"], { fetch: async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => "{}" }) });
  S2.state.serviceDown = { service: "auth", message: "x" };
  S2.api.configure({ base: "http://api.test", getToken: () => null });
  await S2.api.get("/v1/me");
  assert.equal(S2.state.serviceDown, null);
});

test("api-client: a caller can cancel a request (the cost estimate does when the person keeps typing)", async () => {
  let aborted = false;
  const S = load(["core/util.js", "core/events.js", "core/state.js", "core/api-client.js"], { fetch: (url, opts) => new Promise((_, rej) => { opts.signal.addEventListener("abort", () => { aborted = true; rej(new Error("abort")); }); }), globals: { AbortController } });
  S.api.configure({ base: "http://api.test", getToken: () => null });
  const ctl = new AbortController();
  const p = S.api.post("/v1/ai/estimate", { mode: "edit" }, { signal: ctl.signal });
  await new Promise((r) => setImmediate(r));
  ctl.abort();
  await assert.rejects(p, (e) => e.code === "offline");
  assert.equal(aborted, true);
});

test("the bundle carries the field roles and the facts-based rules run the same inside the overlay's sandbox as under node", () => {
  const { bundle } = require("../../overlay/bundle.js");
  const text = bundle({ warn() {} });
  assert.match(text, /S\.fieldRoles = \{/);
  // load the engine + rules the way the bundle does (one IIFE scope each, a plain global) and compare with the node entry
  const ctx = vm.createContext({ console });
  for (const rel of ["engine.js", "rules.js"]) vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "..", "content-rules", rel), "utf8"), ctx, { filename: rel });
  const inSandbox = vm.runInContext("CoveredContentRules.rules().map(function (r) { return r.id; })", ctx);
  assert.deepEqual(Array.from(inSandbox), require("../../content-rules").rules().map((r) => r.id));
});
