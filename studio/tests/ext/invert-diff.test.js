"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const D = require("../../api/services/history-diff.js");

const clone = (x) => JSON.parse(JSON.stringify(x));
// Property: applying invertDiff(before, after) to `after` (checking every expect on the way) yields `before`.
function roundTrip(before, after, label) {
  const ops = D.invertDiff({ file: "src/_data/x.json", before, after });
  const doc = clone(after);
  for (const op of ops) {
    if (op.op === "replace" || op.op === "remove") {
      const here = D.getAt(doc, op.path);
      assert.ok(here.found && D.deepEqual(here.value, op.expect), (label || "") + ": expect holds for " + op.op + " " + op.path);
    }
    assert.ok(D.applyOp(doc, op), (label || "") + ": applies " + op.op + " " + op.path);
  }
  assert.deepEqual(doc, before, label);
  return ops;
}

test("identical documents need no ops", () => {
  assert.deepEqual(D.invertDiff({ file: "f", before: { a: [1, 2] }, after: { a: [1, 2] } }), []);
});

test("text edit: replace with expect", () => {
  const ops = roundTrip({ headlineMain: "We're covering the UK," }, { headlineMain: "We cover the UK" }, "text");
  assert.deepEqual(ops, [{ op: "replace", file: "src/_data/x.json", path: "/headlineMain", value: "We're covering the UK,", expect: "We cover the UK" }]);
});

test("section hide: boolean replace", () => {
  const ops = roundTrip({ sections: [{ type: "a", enabled: true }, { type: "b", enabled: true }] }, { sections: [{ type: "a", enabled: true }, { type: "b", enabled: false }] }, "hide");
  assert.equal(ops.length, 1);
  assert.equal(ops[0].path, "/sections/1/enabled");
  assert.equal(ops[0].expect, false);
});

test("list reorder round-trips", () => {
  const ops = roundTrip({ s: ["a", "b", "c", "d", "e"] }, { s: ["e", "b", "a", "d", "c"] }, "reorder");
  assert.ok(ops.length > 0);
  roundTrip({ s: [{ t: 1 }, { t: 2 }, { t: 3 }] }, { s: [{ t: 3 }, { t: 1 }, { t: 2 }] }, "reorder objects");
  roundTrip({ s: ["x", "x", "y"] }, { s: ["y", "x", "x"] }, "reorder duplicates");
});

test("added and removed list items", () => {
  const added = roundTrip({ items: [{ q: "1" }, { q: "2" }] }, { items: [{ q: "1" }, { q: "new" }, { q: "2" }] }, "added");
  assert.ok(added.length > 0);
  const removed = roundTrip({ items: [{ q: "1" }, { q: "gone" }, { q: "2" }] }, { items: [{ q: "1" }, { q: "2" }] }, "removed");
  assert.ok(removed.length > 0);
  roundTrip({ items: ["a", "b", "c", "d"] }, { items: ["a", "x", "y", "z", "d", "w"] }, "mixed");
  roundTrip({ items: [] }, { items: ["a", "b"] }, "empty before");
  roundTrip({ items: ["a", "b"] }, { items: [] }, "empty after");
});

test("an edited item inside a list is a nested replace, not remove+add", () => {
  const ops = roundTrip({ story: [{ title: "A", img: "a.jpg" }, { title: "B", img: "b.jpg" }] }, { story: [{ title: "A", img: "a.jpg" }, { title: "B2", img: "b2.jpg" }] }, "nested");
  assert.deepEqual(ops.map((o) => o.op), ["replace", "replace"]);
  assert.deepEqual(ops.map((o) => o.path).sort(), ["/story/1/img", "/story/1/title"]);
});

test("image swap, optional keys added and removed, page body", () => {
  roundTrip({ img: "/images/old.jpg", alt: "Old" }, { img: "/images/new.jpg", alt: "New" }, "image");
  const ops = roundTrip({ a: 1, extra: "x" }, { a: 1, other: "y" }, "keys");
  assert.deepEqual(ops.map((o) => o.op).sort(), ["add", "remove"]);
  roundTrip({ title: "About", _body: "Line one\n\nLine two" }, { title: "About us", _body: "Line one\n\nChanged" }, "page");
  roundTrip({ a: { b: { c: [1, { d: "x" }] } } }, { a: { b: { c: [1, { d: "y" }, 3] } } }, "deep");
});

test("pointer escaping for odd keys", () => {
  const ops = roundTrip({ "a/b": 1, "c~d": 2 }, { "a/b": 9, "c~d": 8 }, "escape");
  assert.deepEqual(ops.map((o) => o.path).sort(), ["/a~1b", "/c~0d"]);
});

test("randomised documents round-trip", () => {
  let seed = 1234567;
  const rnd = (n) => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return (((t ^ (t >>> 14)) >>> 0) % 4294967296) % n; };
  const leaf = () => [rnd(5), "s" + rnd(4), rnd(2) === 0, null][rnd(4)];
  const gen = (d) => {
    if (d === 0 || rnd(4) === 0) return leaf();
    if (rnd(2)) return Array.from({ length: rnd(5) }, () => gen(d - 1));
    const o = {};
    for (let i = 0; i < rnd(4); i++) o["k" + rnd(4)] = gen(d - 1);
    return o;
  };
  const mutate = (v, d) => {
    if (d === 0 || rnd(5) === 0) return gen(1);
    if (Array.isArray(v)) {
      const a = v.map((x) => (rnd(3) ? x : mutate(x, d - 1)));
      if (rnd(3) === 0) a.splice(rnd(a.length + 1), rnd(2), gen(1));
      if (rnd(4) === 0) a.reverse();
      return a;
    }
    if (v && typeof v === "object") {
      const o = Object.assign({}, v);
      for (const k of Object.keys(o)) { if (rnd(4) === 0) delete o[k]; else if (rnd(3) === 0) o[k] = mutate(o[k], d - 1); }
      if (rnd(3) === 0) o["k" + rnd(4)] = gen(1);
      return o;
    }
    return rnd(2) ? v : leaf();
  };
  for (let i = 0; i < 400; i++) {
    const before = { root: gen(4) };
    const after = { root: mutate(clone(before.root), 4) };
    roundTrip(before, after, "random #" + i + " " + JSON.stringify(before) + " -> " + JSON.stringify(after));
  }
});
