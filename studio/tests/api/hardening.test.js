"use strict";
// Final-fix regressions: SVG bypasses, GPS in every container, Windows names, case collisions, Markdown in PR text,
// the preview-origin gate. Each payload below got through before the fix.
const test = require("node:test");
const assert = require("node:assert/strict");
const { snapshot, ctxFrom, uuid, upload, PNG_1x1, jpegWithGps, jpegPlain } = require("../fixtures/repo");
const { makeApi, patch, heroOp } = require("../fixtures/harness");
const { validatePatch } = require("../../validate");
const rules = require("../../../scripts/lib/image-rules");
const text = require("../../api/services/pr-text");
const { createCors } = require("../../api/cors");

const files = snapshot();
const enc = (s) => new TextEncoder().encode(s);
const swap = (name) => ({ op: "replace", file: "src/pages/about.md", path: "/sections/2/image", value: name });
const mk = (name, ups) => ({ idempotencyKey: uuid(), baseSha: "a".repeat(40), ops: [swap(name)], uploads: ups });
const run = (p) => validatePatch(ctxFrom(files), p);
const XH = 'xmlns:h="http://www.w3.org/1999/xhtml"';
const wrap = (body) => '<svg xmlns="http://www.w3.org/2000/svg">' + body + "</svg>";

const BAD_SVGS = {
  "namespaced script": wrap("<h:script " + XH + ">alert(document.domain)</h:script>"),
  "namespaced iframe": wrap('<x:iframe xmlns:x="http://www.w3.org/1999/xhtml" src="https://evil.example/"/>'),
  "namespaced script src": wrap('<x:script xmlns:x="http://www.w3.org/1999/xhtml" src="https://evil.example/x.js"/>'),
  "xhtml default namespace": '<svg xmlns="http://www.w3.org/2000/svg"><g xmlns="http://www.w3.org/1999/xhtml"><b>x</b></g></svg>',
  "css escape hides url()": wrap("<style>rect{fill:\\75rl(https://evil.example/t.png)}</style>"),
  "image-set": wrap('<style>rect{background:image-set("https://evil.example/t.png" 1x)}</style>'),
  "css src()": wrap('<style>rect{background:src("https://evil.example/t.png")}</style>'),
  "cursor": wrap("<style>rect{cursor:url(#a)}</style><rect style=\"cursor:pointer\"/>"),
  "entity-hidden animation target": wrap('<animate attributeName="hr&#101;f" values="https://x"/>'),
  "src attribute": wrap('<image src="https://evil.example/x.png"/>'),
  "xml-stylesheet": '<?xml-stylesheet href="https://evil.example/a.css"?>' + wrap("<rect/>"),
};

test("SVGs that slipped past the word lists are refused by the picture rules, the API and the CI guard's list", async () => {
  for (const [name, body] of Object.entries(BAD_SVGS)) {
    assert.ok(rules.svgProblems(body).length > 0, name + " must have a hazard");
    const r = await run(mk("/images/x.svg", [upload("u1", "x.svg", enc(body), "image/svg+xml")]));
    assert.equal(r.ok, false, name + " must be refused through the API");
    assert.match(r.problems[0].message, /not safe/, name);
  }
});

test("a plain SVG (shapes, gradients, internal links, xlink namespace, data: image) is still fine", () => {
  const ok = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 2 2"><defs><linearGradient id="g"/></defs><rect width="2" height="2" fill="url(#g)"/><use xlink:href="#g"/><animate attributeName="opacity" values="0;1"/></svg>';
  assert.deepEqual(rules.svgProblems(ok), []);
});

// ---- GPS in every container -----------------------------------------------------------------------------------------
const cat = (...p) => new Uint8Array(Buffer.concat(p.map((x) => Buffer.from(x))));
const TIFF_GPS_BE = Buffer.concat([Buffer.from("MM\x00\x2a\x00\x00\x00\x08", "latin1"), Buffer.from([0, 1, 0x88, 0x25, 0, 4, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0])]);
const TIFF_PLAIN_BE = Buffer.concat([Buffer.from("MM\x00\x2a\x00\x00\x00\x08", "latin1"), Buffer.from([0, 1, 0x01, 0x0f, 0, 2, 0, 0, 0, 1, 0x41, 0, 0, 0, 0, 0, 0, 0])]);
const be32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const le32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const png = (...chunks) => cat(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ...chunks);
const pngChunk = (type, data) => cat(be32(data.length), Buffer.from(type, "latin1"), data, Buffer.alloc(4));
const IHDR = pngChunk("IHDR", Buffer.concat([be32(1), be32(1), Buffer.from([8, 6, 0, 0, 0])]));
const IEND = pngChunk("IEND", Buffer.alloc(0));
const webp = (...chunks) => { const body = Buffer.concat([Buffer.from("WEBP", "latin1"), ...chunks.map((c) => Buffer.from(c))]); return cat(Buffer.from("RIFF", "latin1"), le32(body.length), body); };
const webpChunk = (type, data) => cat(Buffer.from(type, "latin1"), le32(data.length), data, data.length % 2 ? Buffer.from([0]) : Buffer.alloc(0));

test("GPS: the JPEG tricks (fill byte, XMP, second APP1) and the other containers are all caught", () => {
  assert.equal(rules.jpegHasGps(jpegWithGps()), true, "baseline");
  const g = jpegWithGps();
  const filled = cat([0xff, 0xd8, 0xff], g.subarray(2)); // one extra legal 0xFF fill byte after SOI
  assert.equal(rules.sniffImage(filled).type, "jpeg");
  assert.equal(rules.imageHasGps(filled), true, "fill byte");
  const xmp = Buffer.from('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta exif:GPSLatitude="50,43.5N" exif:GPSLongitude="3,31.9W"/>', "latin1");
  const seg = (marker, data) => cat([0xff, marker, (data.length + 2) >> 8, (data.length + 2) & 0xff], data);
  const sof = [0xff, 0xc0, 0, 11, 8, 0, 2, 0, 3, 1, 1, 0x11, 0, 0xff, 0xd9];
  assert.equal(rules.imageHasGps(cat([0xff, 0xd8], seg(0xe1, xmp), sof)), true, "XMP in a JPEG");
  const cleanExif = cat(Buffer.from("Exif\0\0", "latin1"), TIFF_PLAIN_BE);
  assert.equal(rules.imageHasGps(cat([0xff, 0xd8], seg(0xe1, cleanExif), seg(0xe1, cat(Buffer.from("Exif\0\0", "latin1"), TIFF_GPS_BE)), sof)), true, "GPS only in the second APP1");
  assert.equal(rules.imageHasGps(cat([0xff, 0xd8], seg(0xe1, cleanExif), sof)), false, "plain Exif is fine");
  assert.equal(rules.imageHasGps(jpegPlain()), false);

  assert.equal(rules.imageHasGps(png(IHDR, pngChunk("eXIf", TIFF_GPS_BE), IEND)), true, "PNG eXIf");
  assert.equal(rules.imageHasGps(png(IHDR, pngChunk("eXIf", TIFF_PLAIN_BE), IEND)), false, "PNG eXIf without GPS");
  assert.equal(rules.imageHasGps(png(IHDR, pngChunk("iTXt", Buffer.from("XML:com.adobe.xmp\0\0\0\0\0<x exif:GPSLatitude='1'/>", "latin1")), IEND)), true, "PNG XMP");
  assert.equal(rules.imageHasGps(png(IHDR, pngChunk("zTXt", Buffer.from("Raw profile type exif\0\0xx", "latin1")), IEND)), true, "PNG compressed metadata is unreadable");
  assert.equal(rules.imageHasGps(new Uint8Array(PNG_1x1)), false, "plain PNG");

  const vp8x = webpChunk("VP8X", Buffer.from([0x08, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
  assert.equal(rules.imageHasGps(webp(vp8x, webpChunk("EXIF", cat(Buffer.from("Exif\0\0", "latin1"), TIFF_GPS_BE)))), true, "WebP EXIF");
  assert.equal(rules.imageHasGps(webp(vp8x, webpChunk("XMP ", Buffer.from("<x exif:GPSLongitude='1'/>")))), true, "WebP XMP");
  assert.equal(rules.imageHasGps(webp(vp8x, webpChunk("EXIF", cat(Buffer.from("Exif\0\0", "latin1"), TIFF_PLAIN_BE)))), false, "WebP without GPS");

  const avif = (extra) => cat(be32(24), Buffer.from("ftypavif\0\0\0\0avifmif1", "latin1"), be32(8 + extra.length), Buffer.from("mdat", "latin1"), extra);
  assert.equal(rules.imageHasGps(avif(cat(Buffer.from("Exif\0\0", "latin1"), TIFF_GPS_BE))), true, "AVIF Exif item");
  assert.equal(rules.imageHasGps(avif(Buffer.from("just picture data, nothing else here at all"))), false, "AVIF without it");
});

test("GPS reaches the API through the same rule for every type", async () => {
  const withGps = png(IHDR, pngChunk("eXIf", TIFF_GPS_BE), IEND);
  const r = await run(mk("/images/p.png", [upload("u1", "p.png", withGps)]));
  assert.equal(r.ok, false);
  assert.match(r.problems[0].message, /GPS/);
});

// ---- names -----------------------------------------------------------------------------------------------------------
test("Windows device names and trailing dots are refused as picture names", async () => {
  for (const n of ["con.png", "NUL.png", "aux.jpg", "Com1.png", "lpt9.svg", "prn.webp", "con.backup.png"]) {
    assert.equal(rules.fileNameOk(n), false, n);
    const r = await run(mk("/images/" + n, [upload("u1", n, PNG_1x1)]));
    assert.equal(r.ok, false, n);
  }
  assert.equal(rules.fileNameOk("console.png"), true);
  assert.equal(rules.fileNameOk("icon-nul.png"), true);
  assert.equal(require("../../validate/scope").classify("images/NUL.png"), null);
});

test("a name that differs from an existing picture only by capitals is refused (and the exact name is not)", async () => {
  const existing = [...files.keys()].find((k) => /^images\/[a-z][a-z0-9-]*\.png$/.test(k));
  assert.ok(existing, "fixture has a lower-case png");
  const name = existing.slice(7);
  const flipped = name[0].toUpperCase() + name.slice(1);
  assert.notEqual(flipped, name);
  const r = await run(mk("/images/" + flipped, [upload("u1", flipped, PNG_1x1)]));
  assert.equal(r.ok, false);
  assert.match(r.problems[0].message, /capital letters/);
});

// ---- PR text ---------------------------------------------------------------------------------------------------------
test("editor text in a pull request body cannot make links, images, references or closing keywords", () => {
  const evil = "[Log in](https://evil.example/x) ![t](https://evil.example/p.png) owner/repo#1 Closes #2 www.evil.example **bold**";
  const body = text.prBody({ authorName: evil, authorId: uuid(), draftId: "abc--xx", changes: [{ label: evil, summary: evil, file: "a" }], previewUrl: null, opsCount: 1, filesCount: 1 });
  const shown = body.split("<!--")[0];
  assert.doesNotMatch(shown, /(?<!\\)\[Log in\]/);
  assert.doesNotMatch(shown, /(?<!\\)!\[t\]/);
  assert.doesNotMatch(shown, /https:\/\/evil/);
  assert.doesNotMatch(shown, /(?<!\\)#[12]/);
  assert.doesNotMatch(shown, /www\.evil/);
  assert.doesNotMatch(shown, /(?<!\\)\*\*bold/);
  assert.doesNotMatch(text.plain("Fixes #12 now"), /#12/);
  assert.ok(text.parseMarker(body), "the authorship marker still parses");
});

// ---- preview origin gate -----------------------------------------------------------------------------------------------
test("preview-origin: only an open pull request of this repository may receive a sign-in token", async () => {
  const api = makeApi();
  // the development configuration refuses a preview template, so give the route the production-shaped rule directly
  api.deps.cors = createCors({ allowedOrigins: ["http://localhost:8080"], previewTemplate: "https://deploy-preview-{n}--coveredaccess.netlify.app" });
  const mine = await api.call("editor", "POST", "/v1/drafts", patch(api, [heroOp("Hello there")]));
  assert.equal(mine.status, 201, mine.text);
  const n = mine.json.draft.prNumber || mine.json.draft.pr || [...api.repo.prs.keys()][0];
  const ask = (origin) => api.call(null, "GET", "/v1/preview-origin?origin=" + encodeURIComponent(origin), undefined, { origin: "http://localhost:8080" });
  const good = "https://deploy-preview-" + n + "--coveredaccess.netlify.app";
  assert.deepEqual((await ask(good)).json, { allowed: true });
  assert.deepEqual((await ask("https://deploy-preview-999--coveredaccess.netlify.app")).json, { allowed: false }, "no such pull request");
  api.repo.prs.get(n).fromFork = true;
  assert.deepEqual((await ask(good)).json, { allowed: false }, "a fork pull request");
  api.repo.prs.get(n).fromFork = false;
  api.repo.prs.get(n).state = "closed";
  assert.deepEqual((await ask(good)).json, { allowed: false }, "a closed pull request");
  assert.deepEqual((await ask("https://evil.example")).json, { allowed: false });
  assert.deepEqual((await ask("http://localhost:8080")).json, { allowed: true }, "an exact allowed origin");
});
