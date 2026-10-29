"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { makeStaging, plain } = require("./load");

const sha = "a".repeat(40);
async function build(st, S, over) {
  return plain(await S.patchBuilder.build(Object.assign({ staging: st, key: "9b1c0e0e-5c8e-4f4e-8a55-0f6f6c5b2d11", baseSha: sha }, over || {})));
}

test("a headline edit is one replace with the base value as expect", async () => {
  const { S, st } = makeStaging();
  st.set("hero.headlineMain", "We cover the UK");
  const p = await build(st, S, { title: "Make the hero friendlier" });
  assert.deepEqual(p, {
    idempotencyKey: "9b1c0e0e-5c8e-4f4e-8a55-0f6f6c5b2d11", baseSha: sha, title: "Make the hero friendlier", uploads: [],
    ops: [{ op: "replace", file: "src/_data/hero.json", path: "/headlineMain", value: "We cover the UK", expect: "We're covering the UK," }],
  });
});

test("hiding a section is a replace of /sections/N/enabled", async () => {
  const { S, st } = makeStaging();
  st.set("homepage.sections.3.enabled", false);
  const p = await build(st, S);
  assert.deepEqual(p.ops, [{ op: "replace", file: "src/_data/homepage.json", path: "/sections/3/enabled", value: false, expect: true }]);
});

test("reordering sections becomes sequential moves", async () => {
  const { S, st } = makeStaging();
  st.move("homepage.sections", 3, 1);
  const p = await build(st, S);
  assert.deepEqual(p.ops, [{ op: "move", file: "src/_data/homepage.json", from: "/sections/3", path: "/sections/1" }]);
});

test("replaying the moves on the head reproduces the working order for many shuffles", async () => {
  const { S, st } = makeStaging();
  [[0, 3], [2, 0], [1, 3], [3, 1], [0, 2]].forEach(([a, b]) => st.move("homepage.sections", a, b));
  const want = plain(st._working().homepage.sections.map((s) => s.type));
  const p = await build(st, S);
  const arr = ["hero", "how", "faq", "problem"];
  for (const o of p.ops) {
    assert.equal(o.op, "move");
    const f = Number(o.from.split("/").pop());
    const t = Number(o.path.split("/").pop());
    arr.splice(t, 0, arr.splice(f, 1)[0]);
  }
  assert.deepEqual(arr, want);
});

test("edits (head coordinates) come first, removes next, moves last; remove carries the old item as expect", async () => {
  const { S, st } = makeStaging();
  st.set("how.story.2.title", "Third");
  st.remove("how.story.0");
  st.move("how.story", 1, 0);
  st.set("hero.badge", "B");
  const p = await build(st, S);
  const order = p.ops.map((o) => o.op);
  assert.deepEqual(order.filter((o) => o === "replace").length, 2);
  const last = (name) => order.lastIndexOf(name);
  assert.ok(last("replace") < order.indexOf("remove"));
  if (order.includes("move")) assert.ok(order.indexOf("remove") < order.indexOf("move"));
  const rm = p.ops.find((o) => o.op === "remove");
  assert.equal(rm.path, "/story/0");
  assert.equal(rm.expect.title, "Step one");
  const title = p.ops.find((o) => o.path === "/story/2/title");
  assert.equal(title.expect, "Step three", "expect is in head coordinates even though the list was changed");
});

test("a picture swap includes the upload (base64, exact size) referenced by exactly one op; alt and decorative go with it", async () => {
  const bytes = new Uint8Array([255, 216, 255, 224, 0, 16, 74, 70, 73, 70, 0, 1]);
  const { S, st } = makeStaging();
  await st.setImage("how.story.0.image", new Blob([bytes], { type: "image/jpeg" }), { processed: true, name: "hero-shot-a1b2c.jpg", alt: "A dispenser on a tiled wall", altRef: "how.story.0.alt", decorative: false, decorativeRef: "how.story.0.decorative" });
  const p = await build(st, S);
  assert.equal(p.uploads.length, 1);
  assert.equal(p.uploads[0].name, "hero-shot-a1b2c.jpg");
  assert.equal(p.uploads[0].contentType, "image/jpeg");
  assert.equal(p.uploads[0].size, bytes.length);
  assert.equal(Buffer.from(p.uploads[0].dataBase64, "base64").equals(Buffer.from(bytes)), true);
  const byPath = Object.fromEntries(p.ops.map((o) => [o.path, o]));
  assert.equal(byPath["/story/0/image"].value, "hero-shot-a1b2c.jpg");
  assert.equal(byPath["/story/0/image"].expect, "story-1.svg");
  assert.equal(byPath["/story/0/alt"].value, "A dispenser on a tiled wall");
  assert.equal(byPath["/story/0/decorative"].op, "add", "an optional key that was absent is added, not replaced");
  assert.equal(p.ops.filter((o) => o.value === "hero-shot-a1b2c.jpg").length, 1);
});

test("a colour change targets the theme file; an upload nobody references is not sent", async () => {
  const { S, st } = makeStaging();
  await st.setImage("how.story.0.image", new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" }), { processed: true, name: "x-12345.jpg" });
  st.set("how.story.0.image", "story-3.svg"); // changed their mind
  st.set("theme.paper", "#FFFFFF");
  const p = await build(st, S);
  assert.deepEqual(p.uploads, []);
  assert.ok(p.ops.some((o) => o.file === "src/_data/theme.json" && o.path === "/paper" && o.value === "#FFFFFF" && o.expect === "#FFEFDA"));
});

test("updating a draft sends draftId + expectedHeadSha and no baseSha; the title is cut at 80", async () => {
  const { S, st } = makeStaging();
  st.set("hero.badge", "x");
  const p = await build(st, S, { draft: { id: "u7k2m9q--summer", headSha: "b".repeat(40) }, title: "t".repeat(200) });
  assert.equal(p.draftId, "u7k2m9q--summer");
  assert.equal(p.expectedHeadSha, "b".repeat(40));
  assert.equal("baseSha" in p, false);
  assert.equal(p.title.length, 80);
});

test("the patch has only the contract's keys", async () => {
  const { S, st } = makeStaging();
  st.set("hero.badge", "x");
  st.move("homepage.sections", 0, 1);
  const p = await build(st, S);
  const allowed = new Set(["op", "file", "path", "from", "value", "expect"]);
  p.ops.forEach((o) => Object.keys(o).forEach((k) => assert.ok(allowed.has(k), k)));
  Object.keys(p).forEach((k) => assert.ok(["idempotencyKey", "draftId", "baseSha", "expectedHeadSha", "title", "ops", "uploads"].includes(k), k));
});

test("hostile text is just a string value in the patch (JSON-encoded, never interpreted)", async () => {
  const { S, st } = makeStaging();
  const evil = '<script>alert(1)</script>‮evil"}],\u0000';
  st.set("hero.badge", evil);
  const p = await build(st, S);
  assert.equal(p.ops[0].value, evil);
  assert.equal(JSON.parse(JSON.stringify(p)).ops[0].value, evil);
  // and the client validator flags it before it can be saved
  const probs = plain(st.problems());
  assert.equal(probs.length, 1);
  assert.ok(probs[0].codes.includes("encoding"));
});

test("plain-English lines (old -> new) for the review panel", () => {
  const { st } = makeStaging();
  st.set("hero.headlineMain", "We cover the UK");
  st.set("homepage.sections.3.enabled", false);
  st.move("homepage.sections", 0, 1);
  st.set("theme.paper", "#FFFFFF");
  st.set("hero.ctaLink", "https://example.test/");
  const l = plain(st.list());
  const by = (re) => l.find((x) => re.test(x.summary));
  assert.match(by(/text from/).summary, /Changed the text from “We're covering the UK,” to “We cover the UK”/);
  assert.equal(by(/text from/).label, "Hero > Headline — main part");
  assert.match(by(/^Hid/).summary, /Hid “The problem” on the live site/);
  assert.equal(by(/^Hid/).kind, "section");
  assert.match(by(/^Moved/).summary, /Moved .* (up|down) to position/);
  assert.match(by(/colour/).summary, /colour from #FFEFDA to #FFFFFF/);
  assert.match(by(/link from/).summary, /Changed the link from “\/#faq” to “https:\/\/example.test\/”/);
});
