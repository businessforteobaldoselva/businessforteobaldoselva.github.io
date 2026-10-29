"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const H = require("../../overlay/ext/history.js");

const NOW = new Date(2026, 9, 29, 15, 0, 0).getTime(); // local time, so day boundaries do not depend on the timezone
const ago = (ms) => new Date(NOW - ms).toISOString();
const MIN = 60e3, HOUR = 3600e3;

test("relative time", () => {
  assert.equal(H.relativeTime(ago(10e3), NOW), "just now");
  assert.equal(H.relativeTime(ago(1 * MIN), NOW), "1 minute ago");
  assert.equal(H.relativeTime(ago(45 * MIN), NOW), "45 minutes ago");
  assert.equal(H.relativeTime(ago(2 * HOUR), NOW), "2 hours ago");
  assert.equal(H.relativeTime(new Date(2026, 9, 28, 23, 0).toISOString(), NOW), "yesterday");
  assert.equal(H.relativeTime(new Date(2026, 9, 25, 12, 0).toISOString(), NOW), "4 days ago");
  assert.equal(H.relativeTime(new Date(2026, 9, 1, 12, 0).toISOString(), NOW), "1 Oct");
  assert.equal(H.relativeTime(new Date(2025, 11, 3, 12, 0).toISOString(), NOW), "3 Dec 2025");
  assert.equal(H.relativeTime("garbage", NOW), "");
  assert.equal(H.relativeTime(new Date(NOW + 5 * MIN).toISOString(), NOW), "just now");
});

test("day groups", () => {
  assert.equal(H.dayLabel(ago(MIN), NOW), "Today");
  assert.equal(H.dayLabel(new Date(2026, 9, 28, 1).toISOString(), NOW), "Yesterday");
  assert.equal(H.dayLabel(new Date(2026, 9, 20, 12).toISOString(), NOW), "Tuesday 20 October");
  assert.equal(H.dayLabel(new Date(2025, 0, 2, 12).toISOString(), NOW), "Thursday 2 January 2025");
});

test("file names become plain English", () => {
  assert.equal(H.fileText("src/_data/hero.json"), "Hero");
  assert.equal(H.fileText("src/_data/our-story.json"), "Our story");
  assert.equal(H.fileText("src/pages/about.md"), "About page");
  assert.equal(H.fileText("images/story-5.jpg"), "Picture story-5.jpg");
  assert.equal(H.fileText("src/_data/how.json", (p, k) => (k === "how" ? "How it works" : null)), "How it works");
  assert.deepEqual(H.summarizeFiles(["src/_data/hero.json", "src/_data/hero.json", "images/a.jpg"]), ["Hero", "Picture a.jpg"]);
});

const ITEM = (o) => Object.assign({ number: 1, title: "T", mergedAt: ago(HOUR), url: "https://github.com/o/r/pull/1", author: { name: "Molly", via: "studio" }, files: ["src/_data/hero.json"], changes: null, restorable: true, revertOf: null }, o);

test("view model: grouping, author text, changes, restore flags", () => {
  const items = [
    ITEM({ number: 3, mergedAt: ago(HOUR), changes: [1, 2, 3, 4, 5].map((n) => ({ label: "Hero > Headline " + n, summary: "Changed " + n })) }),
    ITEM({ number: 2, mergedAt: ago(2 * MIN), author: { name: "amelia", via: "github" } }),
    ITEM({ number: 1, mergedAt: new Date(2026, 9, 27, 10).toISOString(), author: { name: "Eve", via: "decap" }, restorable: false, revertOf: 9, title: "x".repeat(200) }),
  ];
  const vm = H.buildViewModel(items, { now: NOW, role: "editor" });
  assert.equal(vm.empty, false);
  assert.deepEqual(vm.groups.map((g) => g.label), ["Today", "Tuesday 27 October"]);
  const [a, b] = vm.groups[0].rows;
  assert.equal(a.authorText, "Molly via Studio");
  assert.equal(a.lines.length, 3);
  assert.equal(a.moreLines.length, 2);
  assert.equal(a.lines[0], "Hero > Headline 1: Changed 1");
  assert.equal(b.authorText, "amelia via GitHub");
  assert.deepEqual(b.lines, ["Changed: Hero"]);
  assert.ok(a.canRestore && b.canRestore);
  const c = vm.groups[1].rows[0];
  assert.equal(c.authorText, "Eve via the content editor");
  assert.ok(c.title.length <= 90 && c.title.endsWith("…"));
  assert.equal(c.canRestore, false);
  assert.match(c.restoreHint, /cannot be undone/);
  assert.equal(c.revertBadge, "Undo of #9");
});

test("view model: only roles that may draft can restore; empty list", () => {
  assert.equal(H.buildViewModel([ITEM({})], { now: NOW, role: undefined }).groups[0].rows[0].canRestore, false);
  assert.equal(H.buildViewModel([ITEM({})], { now: NOW, role: "viewer" }).groups[0].rows[0].canRestore, false);
  for (const r of ["editor", "approver", "admin"]) assert.equal(H.buildViewModel([ITEM({})], { now: NOW, role: r }).groups[0].rows[0].canRestore, true);
  assert.deepEqual(H.buildViewModel([], { now: NOW, role: "admin" }), { empty: true, groups: [] });
  assert.equal(H.buildViewModel(null, {}).empty, true);
});

test("view model leaves text as text (the browser test proves it renders as text)", () => {
  const vm = H.buildViewModel([ITEM({ title: "<img src=x onerror=1>", author: { name: "<b>Eve</b>", via: "github" } })], { now: NOW, role: "editor" });
  assert.equal(vm.groups[0].rows[0].title, "<img src=x onerror=1>");
});
