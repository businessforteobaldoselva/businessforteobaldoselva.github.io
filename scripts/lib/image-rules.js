"use strict";
// Picture-file rules shared by scripts/check-images.js (the CI guard over images/) and the Studio API
// (validation of an uploaded picture BEFORE it is committed). One definition: a file Studio would refuse is a
// file the guard would fail. Pure functions over Uint8Array / strings: no fs, no Buffer, no process.

const RASTER = /\.(jpe?g|png|webp|gif|avif)$/i;

// An SVG opened on its own address runs its scripts on the real website: refuse anything active or external.
// Defence in depth: the /images/*.svg CSP sandbox header exists only on Netlify, so these rules must hold on their own.
// A plain SVG needs no namespaced elements, no extra xmlns, no CSS escapes, no src= / image-set() / cursor
// references and no character references inside animations; each of those is a way past a simple word match.
const SVG_NS = "http:\\/\\/www\\.w3\\.org\\/(?:2000\\/svg|1999\\/xlink)";
const SVG_HAZARDS = [
  [/<\s*script/i, "a <script> element"],
  [/<\s*foreignObject/i, "a <foreignObject> element (can hold HTML and script)"],
  [/<\s*(iframe|embed|object|audio|video|link|meta|base|frame|frameset|applet|template|handler|listener)\b/i, "an <iframe> / <embed> / <object> / <link> style element that loads something else"],
  [/<\s*\/?\s*[A-Za-z_][\w.-]*:[A-Za-z_]/, "an element with a namespace prefix (such as <x:script> or <h:iframe>)"],
  [/\bxmlns:(?!xlink\b)[\w.-]+\s*=/i, "an extra XML namespace declaration (xmlns:...)"],
  [new RegExp("\\bxmlns(?::xlink)?\\s*=\\s*(?![\"']" + SVG_NS + "[\"'])", "i"), "an XML namespace other than SVG or xlink (for example XHTML)"],
  [/<\?xml-stylesheet/i, "an xml-stylesheet instruction"],
  [/<!ENTITY/i, "an entity declaration (<!ENTITY>)"],
  [/\bon[a-z]+\s*=/i, "an event-handler attribute (onload=, onclick= ...)"],
  [/(javascript|vbscript)\s*:/i, "a javascript: URL"],
  [/(?:xlink:)?\bhref\s*=\s*["']?\s*(?!#|data:image\/(?:png|jpe?g|webp|gif);)[^"'\s>]/i, "a link / image reference that is not inside the file (href other than #id)"],
  [/\bsrc\s*=/i, "a src= attribute that loads something else"],
  [/url\(\s*["']?\s*(?!#|data:image\/(?:png|jpe?g|webp|gif);)[^"')\s]/i, "a CSS url() that is not inside the file"],
  [/\\/, "a backslash (CSS escapes can hide url() and other references)"],
  [/\b(?:-webkit-)?image-set\s*\(|\bsrc\s*\(|\bcursor\s*:|-moz-binding|\bbehavior\s*:|\bexpression\s*\(/i, "a CSS image-set() / src() / cursor / binding that loads something else"],
  [/@import/i, "a CSS @import"],
  [/<\s*(set|animate\w*)\b[^>]*&/i, "an animation whose attributes use character references (can hide a link rewrite)"],
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

// ---- location data (GPS) in uploaded pictures --------------------------------------------------------------------
// The original upload is published as it is, so the location a photo was taken at would be public. Every container that
// can carry it is read here: JPEG (every APP1 Exif and XMP segment), PNG (eXIf, XMP text, raw profile chunks), WebP
// (EXIF and XMP chunks), AVIF/HEIF (any embedded TIFF header), GIF and everything else (XMP text). When a block cannot be
// read, the answer is "has GPS": a picture whose metadata cannot be checked is refused, not trusted.
const ascii = (b, a, n) => { let s = ""; for (let k = a; k < a + n && k < b.length; k += 1) s += String.fromCharCode(b[k]); return s; };

// TIFF block (starting at t): does IFD0 or the IFD chain after it hold the GPS pointer tag 0x8825?
function tiffHasGps(b, t) {
  if (t < 0 || t + 8 > b.length) return true;
  const mark = ascii(b, t, 2);
  if (mark !== "II" && mark !== "MM") return true;
  const le = mark === "II";
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  try {
    let ifd = t + dv.getUint32(t + 4, le);
    for (let hop = 0; hop < 4 && ifd > t; hop += 1) {
      if (ifd + 2 > b.length) return true;
      const n = dv.getUint16(ifd, le);
      for (let k = 0; k < n; k += 1) if (dv.getUint16(ifd + 2 + k * 12, le) === 0x8825) return true;
      const next = dv.getUint32(ifd + 2 + n * 12, le);
      if (next === 0) return false;
      ifd = t + next;
    }
    return false;
  } catch (e) {
    return true;
  }
}
// A block of XMP text (any encoding that keeps the ASCII letters) that names a GPS property
const XMP_GPS = /GPS(?:Latitude|Longitude|Altitude|Position|Coordinates|Version|Timestamp|Area)|<\s*exif:GPS/i;
const textHasGps = (b, a, z) => XMP_GPS.test(ascii(b, a, z - a));

function jpegHasGps(buf) {
  if (!buf || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return false;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let i = 2;
  while (i + 3 < buf.length) {
    if (buf[i] !== 0xff) return true; // garbage between segments: cannot be sure what a viewer reads
    while (i < buf.length && buf[i] === 0xff) i += 1; // 0xFF fill bytes are legal before any marker
    if (i >= buf.length) break;
    const marker = buf[i];
    i += 1;
    if (marker === 0xd9) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue; // markers without a length
    if (i + 2 > buf.length) return true;
    const len = dv.getUint16(i, false);
    if (len < 2 || i + len > buf.length) return marker !== 0xda;
    const start = i + 2;
    const end = i + len;
    if (marker === 0xe1) {
      if (ascii(buf, start, 6) === "Exif\0\0") { if (tiffHasGps(buf, start + 6)) return true; }
      else if (textHasGps(buf, start, end)) return true; // XMP and extended XMP
    } else if (marker === 0xed || marker === 0xfe || marker === 0xe2) {
      if (textHasGps(buf, start, end)) return true; // Photoshop IRB / comment / ICC carrying XMP-like text
    }
    if (marker === 0xda) break; // start of scan: metadata segments are over
    i = end;
  }
  return false;
}

function pngHasGps(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let i = 8;
  while (i + 12 <= b.length) {
    const len = dv.getUint32(i, false);
    const type = ascii(b, i + 4, 4);
    const start = i + 8;
    const end = start + len;
    if (end > b.length) return true;
    if (type === "eXIf") { const t = ascii(b, start, 6) === "Exif\0\0" ? start + 6 : start; if (tiffHasGps(b, t)) return true; }
    else if (type === "iTXt" || type === "tEXt" || type === "zTXt") {
      const head = ascii(b, start, Math.min(len, 40));
      if (/^Raw profile type/i.test(head) || type === "zTXt") return true; // compressed or hex-wrapped metadata cannot be read here
      if (type === "iTXt") {
        const nul = head.indexOf("\0");
        if (nul >= 0 && b[start + nul + 1] === 1) return true; // compressed XMP
      }
      if (textHasGps(b, start, end)) return true;
    }
    if (type === "IEND") break;
    i = end + 4;
  }
  return false;
}

function webpHasGps(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let i = 12;
  while (i + 8 <= b.length) {
    const type = ascii(b, i, 4);
    const len = dv.getUint32(i + 4, true);
    const start = i + 8;
    const end = start + len;
    if (end > b.length) return true;
    if (type === "EXIF") { const t = ascii(b, start, 6) === "Exif\0\0" ? start + 6 : start; if (tiffHasGps(b, t)) return true; }
    else if (type === "XMP ") { if (textHasGps(b, start, end)) return true; }
    i = end + (len % 2);
  }
  return false;
}

// AVIF / HEIF: the Exif item is wherever "iloc" says; instead of resolving it, look for any TIFF header in the file and
// read its GPS pointer. A false hit needs a 4 byte magic plus a plausible IFD inside picture data: negligible.
function isoHasGps(b) {
  if (textHasGps(b, 0, b.length)) return true;
  for (let i = 0; i + 8 < b.length; i += 1) {
    const ii = b[i] === 0x49 && b[i + 1] === 0x49 && b[i + 2] === 0x2a && b[i + 3] === 0x00;
    const mm = b[i] === 0x4d && b[i + 1] === 0x4d && b[i + 2] === 0x00 && b[i + 3] === 0x2a;
    if ((ii || mm) && tiffLooksReal(b, i) && tiffHasGps(b, i)) return true;
  }
  return false;
}
// the first IFD offset is small and its entry count plausible (keeps random picture bytes from tripping the AVIF scan)
function tiffLooksReal(b, t) {
  const le = b[t] === 0x49;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  try {
    const off = dv.getUint32(t + 4, le);
    if (off < 8 || off > 65536 || t + off + 2 > b.length) return false;
    const n = dv.getUint16(t + off, le);
    return n >= 1 && n <= 200;
  } catch (e) { return false; }
}

// true when the picture carries a GPS position, whatever its type (decided from the bytes, not the name)
function imageHasGps(bytes) {
  const b = bytes;
  if (!b || b.length < 12) return false;
  try {
    if (b[0] === 0xff && b[1] === 0xd8) return jpegHasGps(b);
    if (b[0] === 0x89 && ascii(b, 1, 3) === "PNG") return pngHasGps(b);
    if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") return webpHasGps(b);
    if (ascii(b, 4, 4) === "ftyp") return isoHasGps(b);
    return textHasGps(b, 0, b.length); // GIF and anything else: XMP text
  } catch (e) {
    return true;
  }
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
// Names Windows (and so Git for Windows, OneDrive, every founder's checkout) cannot hold: a file called con.png or NUL.svg
// makes a pull of main fail on those machines. Checked on the part before the first dot, any case.
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
function fileNameOk(name) {
  return typeof name === "string" && IMAGE_NAME_RE.test(name) && IMAGE_EXT_RE.test(name) && !/\.\./.test(name) && !/[. ]$/.test(name) && !WINDOWS_RESERVED.test(name.split(".")[0]);
}
const EXT_TYPE = { jpg: "jpeg", jpeg: "jpeg", png: "png", webp: "webp", gif: "gif", avif: "avif", svg: "svg" };
const TYPE_MIME = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", avif: "image/avif", svg: "image/svg+xml" };

module.exports = { RASTER, SVG_HAZARDS, svgProblems, jpegHasGps, imageHasGps, WINDOWS_RESERVED, sniffImage, fileNameOk, EXT_TYPE, TYPE_MIME, IMAGE_NAME_RE };
