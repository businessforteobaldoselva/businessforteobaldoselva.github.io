"use strict";
// Uploads: magic bytes, size caps, SVG refusal, EXIF GPS, safe names, no overwrite.
const test = require("node:test");
const assert = require("node:assert/strict");
const { snapshot, ctxFrom, uuid, upload, PNG_1x1, jpegWithGps, jpegPlain, b64 } = require("../fixtures/repo");
const { validatePatch } = require("../../validate");
const { jpegHasGps, sniffImage } = require("../../../scripts/lib/image-rules");

const files = snapshot();
const swap = (name) => ({ op: "replace", file: "src/pages/about.md", path: "/sections/2/image", value: name });
const mk = (name, ups, extraOps) => ({ idempotencyKey: uuid(), baseSha: "a".repeat(40), ops: [swap(name)].concat(extraOps || []), uploads: ups });
const run = (p) => validatePatch(ctxFrom(files), p);
const enc = (s) => new TextEncoder().encode(s);
const svg = (body) => enc('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">' + body + "</svg>");

test("a real PNG becomes a file under images/ and the field points at it", async () => {
  const r = await run(mk("/images/fresh-shot.png", [upload("u1", "fresh-shot.png", PNG_1x1)]));
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  assert.equal(r.uploads.length, 1);
  assert.equal(r.uploads[0].path, "images/fresh-shot.png");
  assert.deepEqual(Array.from(r.uploads[0].bytes), Array.from(PNG_1x1));
  assert.equal(r.changes[0].kind, "image");
});

test("sniffing reads the bytes, not the name", () => {
  assert.equal(sniffImage(PNG_1x1).type, "png");
  assert.deepEqual([sniffImage(PNG_1x1).width, sniffImage(PNG_1x1).height], [1, 1]);
  assert.equal(sniffImage(jpegPlain()).type, "jpeg");
  assert.deepEqual([sniffImage(jpegPlain()).width, sniffImage(jpegPlain()).height], [3, 2]);
  assert.equal(sniffImage(enc("<?xml version='1.0'?><svg></svg>   ")).type, "svg");
  assert.equal(sniffImage(enc("MZ\u0090\u0000not an image at all, just text")), null);
});

test("name says one thing, contents another: refused", async () => {
  const r = await run(mk("pic.jpg", [upload("u1", "pic.jpg", PNG_1x1, "image/jpeg")]));
  assert.equal(r.ok, false);
  assert.match(r.problems[0].message, /name says .jpg but the contents are PNG/);
  const exe = await run(mk("pic.png", [upload("u1", "pic.png", enc("MZ" + "\u0000".repeat(40)), "image/png")]));
  assert.equal(exe.ok, false);
  assert.match(exe.problems[0].message, /not a usable picture/);
});

test("declared content type must match", async () => {
  const r = await run(mk("pic.png", [upload("u1", "pic.png", PNG_1x1, "text/html")]));
  assert.equal(r.ok, false);
  assert.match(r.problems[0].message, /declared type/);
});

test("JPEG with GPS EXIF is refused; without it is accepted", async () => {
  assert.equal(jpegHasGps(jpegWithGps()), true);
  assert.equal(jpegHasGps(jpegPlain()), false);
  const bad = await run(mk("gps.jpg", [upload("u1", "gps.jpg", jpegWithGps(), "image/jpeg")]));
  assert.equal(bad.ok, false);
  assert.match(bad.problems[0].message, /GPS/);
  const ok = await run(mk("plain.jpg", [upload("u1", "plain.jpg", jpegPlain(), "image/jpeg")]));
  assert.equal(ok.ok, true, JSON.stringify(ok.problems));
});

test("SVG: scripts, handlers, external references are refused (same rules as check-images); a plain SVG passes", async () => {
  const hazards = [
    '<script>alert(1)</script>', '<rect onload="x()" width="1" height="1"/>', '<foreignObject><div/></foreignObject>', '<a href="https://evil.example"><rect/></a>',
    '<image href="//evil.example/x.png"/>', '<style>@import url(http://evil.example/x.css);</style>', '<rect style="fill:url(http://evil.example/x)"/>', '<a href="javascript:alert(1)"><rect/></a>',
    '<!ENTITY x "y">', '<iframe src="x"/>',
  ];
  for (const h of hazards) {
    const r = await run(mk("logo.svg", [upload("u1", "logo.svg", svg(h), "image/svg+xml")]));
    assert.equal(r.ok, false, h);
    assert.match(r.problems[0].message, /not safe|not a usable/, h);
  }
  const ok = await run(mk("logo.svg", [upload("u1", "logo.svg", svg('<rect width="10" height="10" fill="#fff"/><use href="#a"/>'), "image/svg+xml")]));
  assert.equal(ok.ok, true, JSON.stringify(ok.problems));
});

test("names: traversal, odd characters, no extension, too long, duplicates", async () => {
  for (const n of ["../x.png", "a/b.png", "a\\b.png", ".htaccess.png", "x.png.php", "x", "x.html", "a b.png", "\u00e9.png", "x".repeat(90) + ".png", "-x.png", "x%2e.png", "CON\u0000.png"]) {
    const r = await run(mk(n, [upload("u1", n, PNG_1x1)]));
    assert.equal(r.ok, false, n);
  }
  const dup = await run({ idempotencyKey: uuid(), baseSha: "a".repeat(40), ops: [swap("a.png")], uploads: [upload("u1", "a.png", PNG_1x1), upload("u2", "A.png", PNG_1x1)] });
  assert.equal(dup.ok, false);
});

test("size caps: declared size, base64 shape, decoded length, huge data", async () => {
  const good = upload("u1", "ok.png", PNG_1x1);
  assert.equal((await run(mk("ok.png", [Object.assign({}, good, { size: 999 })]))).ok, false);
  assert.equal((await run(mk("ok.png", [Object.assign({}, good, { dataBase64: good.dataBase64 + "\n" })]))).ok, false);
  assert.equal((await run(mk("ok.png", [Object.assign({}, good, { dataBase64: "!!!!" })]))).ok, false);
  assert.equal((await run(mk("ok.png", [Object.assign({}, good, { dataBase64: good.dataBase64.slice(1) })]))).ok, false);
  const big = new Uint8Array(4 * 1024 * 1024 + 1); big.set(PNG_1x1);
  const r = await run(mk("big.png", [{ id: "u1", name: "big.png", contentType: "image/png", size: big.length, dataBase64: b64(big) }]));
  assert.equal(r.ok, false);
  assert.match(r.problems[0].message, /larger than 4 MB/);
  const px = Buffer.from(PNG_1x1); px.writeUInt32BE(9000, 16);
  const wide = await run(mk("wide.png", [upload("u1", "wide.png", new Uint8Array(px))]));
  assert.equal(wide.ok, false);
  assert.match(wide.problems[0].message, /9000 x 1 pixels/);
});

test("never overwrites: a different picture with an existing name is refused, identical bytes are a no-op", async () => {
  const f2 = new Map(files);
  f2.set("images/taken.png", PNG_1x1);
  const other = Buffer.from(PNG_1x1); other[24] ^= 1; // different bytes, still a PNG header
  const r = await validatePatch(ctxFrom(f2), mk("taken.png", [upload("u1", "taken.png", new Uint8Array(other))]));
  assert.equal(r.ok, false);
  assert.match(r.problems[0].message, /already exists/);
  const same = await validatePatch(ctxFrom(f2), mk("taken.png", [upload("u1", "taken.png", PNG_1x1)]));
  assert.equal(same.ok, true, JSON.stringify(same.problems));
  assert.equal(same.uploads.length, 0); // nothing to write
});

test("an upload nothing points at, and a picture reference to a file that does not exist, are refused", async () => {
  const lonely = await run({ idempotencyKey: uuid(), baseSha: "a".repeat(40), ops: [swap("pads-beige.jpg")], uploads: [upload("u1", "lonely.png", PNG_1x1)] });
  assert.equal(lonely.ok, false);
  assert.match(lonely.problems[0].message, /not used by any change/);
  const ghost = await run(mk("does-not-exist.jpg", []));
  assert.equal(ghost.ok, false);
  assert.match(ghost.problems[0].message, /does not exist/);
  for (const v of ["http://evil.example/x.jpg", "/etc/passwd", "../x.jpg", "images/../x.jpg", "/videos/../../x.jpg", "javascript:alert(1).jpg", "data:image/png;base64,AAAA"]) {
    const r = await run(mk(v, []));
    assert.equal(r.ok, false, v);
  }
  const existing = await run(mk("/images/pads-beige.jpg", []));
  assert.equal(existing.ok, true, JSON.stringify(existing.problems));
});
