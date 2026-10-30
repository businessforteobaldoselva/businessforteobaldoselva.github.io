"use strict";
// Loads overlay modules into a vm context the way the bundle does (each file is an IIFE over window.__CoveredStudioBoot),
// so the pure logic can be unit-tested under node without a browser. Results are crossing a realm: compare with
// JSON.parse(JSON.stringify(x)) before deepStrictEqual.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const OVERLAY = path.resolve(__dirname, "..", "..", "overlay");
const FIX = path.join(__dirname, "fixtures");
const LOGIC = ["core/util.js", "core/events.js", "core/state.js", "core/schema-client.js", "core/validate-client.js", "core/api-client.js", "core/auth.js", "core/staging.js", "core/images.js", "core/patch-builder.js", "core/drafts.js"];

function plain(x) { return x === undefined ? undefined : JSON.parse(JSON.stringify(x)); }

function load(files, extra) {
  extra = extra || {};
  const S = { _q: [], css: [], schema: null, studio: null };
  const win = Object.assign({ __CoveredStudioBoot: S, addEventListener() {}, removeEventListener() {}, location: { origin: "http://page.test", search: "", hash: "" } }, extra.window || {});
  const ctx = vm.createContext(Object.assign({ window: win, console, URL, Blob, btoa, atob, setTimeout, clearTimeout, setInterval, clearInterval, Promise, document: extra.document, fetch: extra.fetch, crypto: globalThis.crypto, Symbol, Uint8Array, JSON, Math, Date, Map, Object, Array }, extra.globals || {}));
  for (const rel of files || LOGIC) vm.runInContext(fs.readFileSync(path.join(OVERLAY, rel), "utf8"), ctx, { filename: rel });
  return S;
}
function fixtures() {
  return { schema: JSON.parse(fs.readFileSync(path.join(FIX, "schema.json"), "utf8")), content: JSON.parse(fs.readFileSync(path.join(FIX, "content.json"), "utf8")) };
}
// A staging store over the fixture content, with an in-memory storage.
function makeStaging(extra) {
  extra = extra || {};
  const S = load(null, extra);
  const fx = fixtures();
  const sc = S.schemaClient.create(fx.schema);
  const mem = new Map();
  const storage = { get: (k) => (mem.has(k) ? mem.get(k) : null), set: (k, v) => { mem.set(k, v); return true; }, del: (k) => { mem.delete(k); } };
  const events = [];
  const st = S.stagingLib.create({ files: fx.content.files, schemaClient: sc, storage: extra.noStorage ? null : storage, storeKey: "k1", processImage: extra.processImage, emit: (e, d) => events.push([e, d]) });
  return { S, st, sc, fx, mem, storage, events };
}
module.exports = { load, fixtures, makeStaging, plain, OVERLAY, FIX, LOGIC };
