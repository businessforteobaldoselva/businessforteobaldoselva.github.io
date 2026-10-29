"use strict";
// Upload validation (DESIGN 6 stage 6). Rules come from scripts/lib/image-rules.js, the same module
// scripts/check-images.js uses over images/, so Studio can never accept a file the CI guard would fail.
// Pure, portable: base64 via atob, text via TextDecoder.

const rules = require("../../scripts/lib/image-rules");
const { mk } = require("./problem");
const { classify } = require("./scope");

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_SIDE = 8000;
const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

function decodeBase64(s) {
  if (typeof s !== "string" || s.length % 4 !== 0 || !B64_RE.test(s)) return null;
  try {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
  } catch (e) { return null; }
}

function same(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

// -> { problems, files: [{ id, path, name, bytes, type, mime, existing }] }
async function validateUploads(uploads, ctx, maxBytes) {
  const limit = maxBytes || MAX_IMAGE_BYTES;
  const problems = [];
  const files = [];
  const seenNames = new Set();
  for (const u of uploads || []) {
    const where = "uploads/" + String(u && u.id).slice(0, 20);
    const name = u && u.name;
    const target = "images/" + name;
    const bad = (msg, hint) => problems.push(mk("image", target, where, msg, hint));
    if (!rules.fileNameOk(name) || classify(target) !== "image") { bad("The file name " + JSON.stringify(String(name).slice(0, 60)) + " cannot be used.", "Use letters, numbers, dots, dashes and underscores only, ending in .jpg, .png, .webp, .gif, .avif or .svg."); continue; }
    if (seenNames.has(name.toLowerCase())) { bad("Two uploads have the same file name.", "Give each picture its own name."); continue; }
    seenNames.add(name.toLowerCase());
    if (typeof u.size !== "number" || !Number.isInteger(u.size) || u.size < 1 || u.size > limit) { bad("The picture is empty or larger than " + Math.round(limit / 1048576) + " MB.", "Choose a smaller picture."); continue; }
    if (typeof u.dataBase64 !== "string" || u.dataBase64.length > Math.ceil(limit / 3) * 4 + 8) { bad("The picture is too large.", "Choose a smaller picture."); continue; }
    const bytes = decodeBase64(u.dataBase64);
    if (!bytes) { bad("The picture data is not valid base64."); continue; }
    if (bytes.length !== u.size) { bad("The picture size does not match its data.", "Try adding the picture again."); continue; }
    const ext = /\.([A-Za-z0-9]+)$/.exec(name)[1].toLowerCase();
    const sniffed = rules.sniffImage(bytes);
    if (!sniffed) { bad("This file is not a usable picture.", "Upload a .jpg, .png, .webp, .gif, .avif or .svg picture."); continue; }
    if (sniffed.type !== rules.EXT_TYPE[ext]) { bad("The file name says ." + ext + " but the contents are " + sniffed.type.toUpperCase() + ".", "Rename the file to match, or export the picture again."); continue; }
    if (u.contentType !== rules.TYPE_MIME[sniffed.type]) { bad("The declared type " + JSON.stringify(String(u.contentType).slice(0, 40)) + " does not match the picture.", "Expected " + rules.TYPE_MIME[sniffed.type] + "."); continue; }
    if (sniffed.type === "svg") {
      let text;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch (e) { bad("The SVG is not valid UTF-8 text."); continue; }
      const sp = rules.svgProblems(text);
      if (sp.length) { bad("This SVG is not safe: it contains " + sp[0].what + ".", "Export it again as a plain picture without scripts, event handlers or outside links."); continue; }
    } else {
      if (!sniffed.width || !sniffed.height) { bad("The picture has no readable pixel size.", "Upload the picture again."); continue; }
      if (sniffed.width > MAX_SIDE || sniffed.height > MAX_SIDE) { bad("The picture is " + sniffed.width + " x " + sniffed.height + " pixels; the limit is " + MAX_SIDE + " on each side.", "Resize it before adding it."); continue; }
      if (sniffed.type === "jpeg" && rules.jpegHasGps(bytes)) { bad("The photo carries the GPS position where it was taken.", "Remove the location data (re-save or export the photo without it) and add it again."); continue; }
    }
    // never overwrite an existing file; identical bytes are an accepted no-op
    let existing = false;
    if (await ctx.hasFile(target)) {
      const cur = ctx.readBytes ? await ctx.readBytes(target) : null;
      if (!same(cur, bytes)) { bad("A different picture called " + name + " already exists.", "Pick another file name."); continue; }
      existing = true;
    }
    files.push({ id: u.id, path: target, name, bytes, type: sniffed.type, mime: u.contentType, existing });
  }
  return { problems, files };
}

module.exports = { validateUploads, decodeBase64, MAX_IMAGE_BYTES };
