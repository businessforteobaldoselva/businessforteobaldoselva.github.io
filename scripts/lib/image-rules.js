"use strict";
// Picture-file rules shared by scripts/check-images.js (the CI guard over images/) and the Studio API
// (validation of an uploaded picture BEFORE it is committed). One definition: a file Studio would refuse is a
// file the guard would fail. Pure functions over Uint8Array / strings: no fs, no Buffer, no process.

const RASTER = /\.(jpe?g|png|webp|gif|avif)$/i;

// An SVG opened on its own address runs its scripts on the real website: refuse anything active or external.
const SVG_HAZARDS = [
  [/<\s*script/i, "a <script> element"],
  [/<\s*foreignObject/i, "a <foreignObject> element (can hold HTML and script)"],
  [/<\s*(iframe|embed|object|audio|video|link|meta|base)\b/i, "an <iframe> / <embed> / <object> / <link> style element that loads something else"],
  [/<!ENTITY/i, "an entity declaration (<!ENTITY>)"],
  [/\bon[a-z]+\s*=/i, "an event-handler attribute (onload=, onclick= ...)"],
  [/(javascript|vbscript)\s*:/i, "a javascript: URL"],
  [/(?:xlink:)?\bhref\s*=\s*["']?\s*(?!#|data:image\/(?:png|jpe?g|webp|gif);)[^"'\s>]/i, "a link / image reference that is not inside the file (href other than #id)"],
  [/url\(\s*["']?\s*(?!#|data:image\/(?:png|jpe?g|webp|gif);)[^"')\s]/i, "a CSS url() that is not inside the file"],
  [/@import/i, "a CSS @import"],
  [/<\s*(set|animate)\b[^>]*attributeName\s*=\s*["']?\s*(xlink:)?href/i, "an animation that rewrites a link"],
];

// [{ what, found }] for every hazard in the SVG text; [] = safe. A file without <svg> is its own problem.
function svgProblems(text) {
  const out = [];
  if (!/<\s*svg\b/i.test(text)) return [{ what: "no <svg> element", found: "", notSvg: true }];
  for (const [re, what] of SVG_HAZARDS) {
    const m = re.exec(text);
    if (m) out.push({ what, found: m[0].slice(0, 60) });
  }
  return out;
}

// true when a JPEG carries the GPS block of its EXIF data (APP1 "Exif" -> TIFF -> tag 0x8825)
function jpegHasGps(buf) {
  if (!buf || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return false;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const latin1 = (a, b) => { let s = ""; for (let k = a; k < b && k < buf.length; k += 1) s += String.fromCharCode(buf[k]); return s; };
  let i = 2;
  while (i + 4 < buf.length && buf[i] === 0xff) {
    const marker = buf[i + 1];
    if (marker === 0xda || marker === 0xd9) break;
    const len = dv.getUint16(i + 2, false);
    if (marker === 0xe1 && latin1(i + 4, i + 8) === "Exif") {
      const t = i + 10; // start of the TIFF header
      if (t + 8 > buf.length) return false;
      const le = latin1(t, t + 2) === "II";
      const u16 = (o) => dv.getUint16(o, le);
      const u32 = (o) => dv.getUint32(o, le);
      try {
        const ifd = t + u32(t + 4);
        const n = u16(ifd);
        for (let k = 0; k < n; k += 1) if (u16(ifd + 2 + k * 12) === 0x8825) return true;
      } catch (e) {
        return false;
      }
      return false;
    }
    i += 2 + len;
  }
  return false;
}

function jpegSize(b, dv) {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i += 1; continue; }
    const m = b[i + 1];
    if (m === 0xff) { i += 1; continue; }
    if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) { i += 2; continue; }
    const len = dv.getUint16(i + 2, false);
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { height: dv.getUint16(i + 5, false), width: dv.getUint16(i + 7, false) };
    if (len < 2) break;
    i += 2 + len;
  }
  return { width: 0, height: 0 };
}

function webpSize(b, dv, ascii) {
  const kind = ascii(12, 4);
  try {
    if (kind === "VP8 ") return { width: dv.getUint16(26, true) & 0x3fff, height: dv.getUint16(28, true) & 0x3fff };
    if (kind === "VP8L") { const v = dv.getUint32(21, true); return { width: (v & 0x3fff) + 1, height: ((v >> 14) & 0x3fff) + 1 }; }
    if (kind === "VP8X") return { width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
  } catch (e) { /* fall through */ }
  return { width: 0, height: 0 };
}

function avifSize(b, dv, ascii) {
  // the "ispe" (image spatial extents) box: 4 bytes version/flags, then width, height (big endian)
  for (let i = 8; i + 20 < b.length && i < 65536; i += 1) {
    if (b[i] === 0x69 && ascii(i, 4) === "ispe") return { width: dv.getUint32(i + 8, false), height: dv.getUint32(i + 12, false) };
  }
  return { width: 0, height: 0 };
}

// What an uploaded picture is, from its first bytes (never from its name): { type, width, height } or null.
// type: jpeg | png | gif | webp | avif | svg. width/height are 0 for svg and when the header is unreadable.
function sniffImage(bytes) {
  const b = bytes;
  if (!b || b.length < 12) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const ascii = (a, n) => { let s = ""; for (let k = a; k < a + n && k < b.length; k += 1) s += String.fromCharCode(b[k]); return s; };
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return Object.assign({ type: "jpeg" }, jpegSize(b, dv));
  if (b[0] === 0x89 && ascii(1, 3) === "PNG" && b[4] === 0x0d && b[5] === 0x0a) return { type: "png", width: dv.getUint32(16, false), height: dv.getUint32(20, false) };
  if (ascii(0, 4) === "GIF8") return { type: "gif", width: dv.getUint16(6, true), height: dv.getUint16(8, true) };
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") return Object.assign({ type: "webp" }, webpSize(b, dv, ascii));
  if (ascii(4, 4) === "ftyp" && /^(avif|avis)$/.test(ascii(8, 4))) return Object.assign({ type: "avif" }, avifSize(b, dv, ascii));
  // SVG: text; an XML prolog / comment / doctype may come before <svg
  const head = new TextDecoder("utf-8").decode(b.subarray(0, Math.min(b.length, 2048))).replace(/^\ufeff/, "");
  if (/^\s*(<\?xml[\s\S]*?\?>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(head)) return { type: "svg", width: 0, height: 0 };
  return null;
}

// Upload name grammar (also the scope rule for images/): letters, digits, dot, dash, underscore; <= 80 chars;
// starts with a letter or digit; one of the picture extensions.
const IMAGE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const IMAGE_EXT_RE = /\.(jpg|jpeg|png|webp|gif|avif|svg)$/i;
function fileNameOk(name) {
  return typeof name === "string" && IMAGE_NAME_RE.test(name) && IMAGE_EXT_RE.test(name) && !/\.\./.test(name);
}
const EXT_TYPE = { jpg: "jpeg", jpeg: "jpeg", png: "png", webp: "webp", gif: "gif", avif: "avif", svg: "svg" };
const TYPE_MIME = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", avif: "image/avif", svg: "image/svg+xml" };

module.exports = { RASTER, SVG_HAZARDS, svgProblems, jpegHasGps, sniffImage, fileNameOk, EXT_TYPE, TYPE_MIME, IMAGE_NAME_RE };
