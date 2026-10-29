"use strict";
// TEST HELPERS (Node only): a snapshot of the repository's editable files, a validator context over a Map,
// and tiny valid pictures for upload tests. Tests never touch the network.

const fs = require("fs");
const path = require("path");
const { loadSchema, ROOT } = require("./schema-from-config");
const { reservedIds } = require("../../../lib/reserved-ids");

// Map<repoPath, Uint8Array> of src/_data, src/pages and images (the files Studio may read or write)
function snapshot(root) {
  const base = root || ROOT;
  const m = new Map();
  const add = (dir, filter) => {
    const abs = path.join(base, dir);
    if (!fs.existsSync(abs)) return;
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) if (e.isFile() && filter(e.name)) m.set(dir + "/" + e.name, new Uint8Array(fs.readFileSync(path.join(abs, e.name))));
  };
  add("src/_data", (n) => /\.json$/.test(n));
  add("src/pages", (n) => /\.md$/.test(n));
  add("images", () => true);
  add("videos", () => true);
  return m;
}

const dec = new TextDecoder("utf-8");
function ctxFrom(files, extra) {
  const schema = loadSchema();
  return Object.assign({
    schema,
    reservedIds: reservedIds(ROOT),
    readText: (p) => (files.has(p) ? dec.decode(files.get(p)) : null),
    hasFile: (p) => files.has(p),
    readBytes: (p) => files.get(p) || null,
    now: () => new Date("2026-10-29T12:00:00Z"),
  }, extra || {});
}

const b64 = (u8) => Buffer.from(u8).toString("base64");
// 1x1 PNG
const PNG_1x1 = new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
function upload(id, name, bytes, contentType) { return { id, name, contentType: contentType || "image/png", size: bytes.length, dataBase64: b64(bytes) }; }
// a JPEG with a GPS EXIF block (APP1 with an IFD that holds tag 0x8825)
function jpegWithGps() {
  const tiff = Buffer.concat([Buffer.from("MM\x00\x2a\x00\x00\x00\x08", "latin1"), Buffer.from([0, 1, 0x88, 0x25, 0, 4, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0])]);
  const app1 = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  const len = Buffer.alloc(2); len.writeUInt16BE(app1.length + 2);
  const sof = Buffer.from([0xff, 0xc0, 0, 11, 8, 0, 2, 0, 3, 1, 1, 0x11, 0]);
  return new Uint8Array(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1]), len, app1, sof, Buffer.from([0xff, 0xd9])]));
}
function jpegPlain() {
  const sof = Buffer.from([0xff, 0xc0, 0, 11, 8, 0, 2, 0, 3, 1, 1, 0x11, 0]);
  return new Uint8Array(Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.from([0xff, 0xd9, 0, 0, 0, 0])]));
}

const uuid = () => require("crypto").randomUUID();
module.exports = { snapshot, ctxFrom, PNG_1x1, upload, jpegWithGps, jpegPlain, uuid, ROOT, b64 };
