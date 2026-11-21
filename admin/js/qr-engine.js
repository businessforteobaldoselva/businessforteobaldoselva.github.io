// =============================================================================
// COVERED Admin Console — QR engine (pure, no DOM)
// -----------------------------------------------------------------------------
// Everything the QR page needs that is not a screen: build the payload, encode
// it with the vendored nayuki library, work out the physical geometry, emit a
// print-grade SVG and a 1-bit PNG, and write the manifest. It touches no DOM so
// it runs unchanged under Node for the cross-check tests.
//
// WHY IT EXISTS (QR-PLATFORM-PLAN.md §6)
//   * qr-generator-multi-machine.html produced PNGs whose quiet zone measured
//     3.27 modules (the spec says 4). Here the quiet zone is a number of MODULES
//     that is written into the vector itself so nobody can crop it away.
//   * The printed string is ALWAYS  HTTPS://<SHORT-DOMAIN>/C/<CODE>  upper-cased,
//     so it encodes in alphanumeric mode (v2 at EC Q for a 26-char payload).
//     No UTM, no machine id, no tracking parameter: those change the length,
//     the version and the module size, and they are frozen in ink.
//   * Black on white only, 100% K. No colours, gradients, logos or rounded
//     modules (plan D26). Contrast is asserted, not eyeballed.
// =============================================================================

import qrcodegen from './vendor/qrcodegen.js';
import { crc32 } from './vendor/zip.js';

export const LIBRARY = { name: 'nayuki-qr-code-generator', version: '1.8.0', licence: 'MIT' };
export const QUIET_MODULES = 4;
export const ALNUM_RE = /^[0-9A-Z $%*+\-./:]*$/;
export const SHORT_CODE_RE = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{8}$/;

const ECC = qrcodegen.QrCode.Ecc;
export const EC_LEVELS = { L: ECC.LOW, M: ECC.MEDIUM, Q: ECC.QUARTILE, H: ECC.HIGH };
const EC_NAME = new Map([[ECC.LOW, 'L'], [ECC.MEDIUM, 'M'], [ECC.QUARTILE, 'Q'], [ECC.HIGH, 'H']]);

// Plan §6.3. symbolMm is the dark symbol WITHOUT its quiet zone. minXmm is the
// smallest module a printer should be trusted with on this surface.
export const SURFACE_SPECS = {
  carton:  { label: 'Carton (16-pack, handheld)', ecl: 'H', symbolMm: 25,  floorMm: 20,  minXmm: 0.50 },
  machine: { label: 'Machine sticker',            ecl: 'Q', symbolMm: 40,  floorMm: 30,  minXmm: 1.00 },
  poster:  { label: 'A3 poster',                  ecl: 'Q', symbolMm: 250, floorMm: 200, minXmm: 1.00 },
  other:   { label: 'Flyer / other print',        ecl: 'Q', symbolMm: 40,  floorMm: 30,  minXmm: 1.00 },
  // The screen is sized in pixels, not millimetres: integer px per module, always.
  screen:  { label: '32-inch screen',             ecl: 'M', pxPerModule: 22, symbolMm: null, floorMm: null, minXmm: null },
};

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

/** Normalise a short domain. Returns '' when it is not a plausible bare hostname. */
export function normaliseHost(raw) {
  const h = String(raw || '').trim().toUpperCase();
  if (!/^[A-Z0-9]([A-Z0-9-]*[A-Z0-9])?(\.[A-Z0-9]([A-Z0-9-]*[A-Z0-9])?)+$/.test(h)) return '';
  return h;
}

/** The exact string a printed code encodes. Uppercase so it stays in alphanumeric mode. */
export function payloadFor(host, shortCode) {
  const h = normaliseHost(host);
  const c = String(shortCode || '').toUpperCase();
  if (!h) throw new Error('A short domain is required before a code can be generated.');
  if (!SHORT_CODE_RE.test(c)) throw new Error('Short code must be 8 characters from the COVERED alphabet.');
  return `HTTPS://${h}/C/${c}`;
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

/**
 * Encode text. boostEcl is OFF: the level you ask for is the level you get, so a
 * print run is reproducible. Version and mask can be pinned.
 * @returns {{text, ecl, eclRequested, version, size, mask, modules:Uint8Array, dark(x,y):boolean, mode:string}}
 */
export function encode(text, eclName = 'Q', opts = {}) {
  const ecl = EC_LEVELS[eclName];
  if (!ecl) throw new Error(`Unknown error-correction level: ${eclName}`);
  const { minVersion = 1, maxVersion = 40, mask = -1 } = opts;
  const segs = qrcodegen.QrSegment.makeSegments(text);
  const qr = qrcodegen.QrCode.encodeSegments(segs, ecl, minVersion, maxVersion, mask, false);
  const size = qr.size;
  const modules = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) modules[y * size + x] = qr.getModule(x, y) ? 1 : 0;
  return {
    text,
    eclRequested: eclName,
    ecl: EC_NAME.get(qr.errorCorrectionLevel),
    version: qr.version,
    size,
    mask: qr.mask,
    mode: ALNUM_RE.test(text) ? 'alphanumeric' : (/^[0-9]*$/.test(text) ? 'numeric' : 'byte'),
    modules,
    dark: (x, y) => x >= 0 && y >= 0 && x < size && y < size && modules[y * size + x] === 1,
  };
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** Physical numbers for a symbol of `symbolMm` (dark area, quiet zone excluded). */
export function geometry(size, symbolMm, quiet = QUIET_MODULES) {
  const xMm = symbolMm / size;
  const quietMm = xMm * quiet;
  const footprintMm = xMm * (size + 2 * quiet);
  return { xMm, quietMm, footprintMm, symbolMm, quiet };
}

const r = (n, dp = 3) => Math.round(n * 10 ** dp) / 10 ** dp;

/**
 * Pre-print gate for one code on one surface. Errors block print-ready export,
 * warnings are shown but allowed.
 * @returns {{level:'error'|'warn'|'ok', text:string}[]}
 */
export function assessments(qr, surfaceKey, symbolMm, colours = { dark: '#000000', light: '#ffffff' }) {
  const out = [];
  const spec = SURFACE_SPECS[surfaceKey] || SURFACE_SPECS.other;
  if (qr.ecl !== qr.eclRequested) {
    out.push({ level: 'warn', text: `Error correction was raised to ${qr.ecl} (asked for ${qr.eclRequested}).` });
  }
  if (qr.mode !== 'alphanumeric') {
    out.push({ level: 'error', text: 'The payload is not alphanumeric-mode. A printed code must be the upper-case short URL only.' });
  }
  if (spec.ecl && qr.ecl !== spec.ecl) {
    out.push({ level: 'warn', text: `${spec.label} is specified at error correction ${spec.ecl}; this is ${qr.ecl}.` });
  }
  const cr = contrastRatio(colours.dark, colours.light);
  if (cr < 7) out.push({ level: 'error', text: `Contrast ${cr.toFixed(1)}:1 is below the 7:1 floor. Use black on white.` });
  if (surfaceKey !== 'screen' && symbolMm) {
    const g = geometry(qr.size, symbolMm);
    if (symbolMm < spec.floorMm) {
      out.push({ level: 'error', text: `Symbol ${symbolMm} mm is below the ${spec.floorMm} mm hard floor for this surface. Re-plan the artwork.` });
    }
    if (g.xMm < spec.minXmm) {
      out.push({ level: 'error', text: `Module size ${r(g.xMm)} mm is below the ${spec.minXmm} mm minimum for this surface.` });
    }
    if (qr.version > 4) {
      out.push({ level: 'warn', text: `Version ${qr.version} (${qr.size} modules): the payload is longer than planned, so each module is smaller at this size.` });
    }
  }
  if (!out.some((o) => o.level === 'error')) out.push({ level: 'ok', text: 'Passes the automatic checks. The physical proof checklist still applies.' });
  return out;
}

// ---------------------------------------------------------------------------
// Colour / contrast
// ---------------------------------------------------------------------------

function lum(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`Bad colour: ${hex}`);
  const v = parseInt(m[1], 16);
  const ch = [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}
export function contrastRatio(a, b) {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// ---------------------------------------------------------------------------
// SVG — print grade
// ---------------------------------------------------------------------------

/**
 * One merged <path>, fill only (no stroke), no transform / group / clip /
 * transparency. width/height in mm, viewBox in module units. The light quiet
 * zone is a real rect INSIDE the file, so it cannot be cropped away.
 */
export function toSvg(qr, { symbolMm, quiet = QUIET_MODULES, dark = '#000000', light = '#ffffff' } = {}) {
  const total = qr.size + 2 * quiet;
  const g = symbolMm ? geometry(qr.size, symbolMm, quiet) : null;
  const dim = g ? `width="${r(g.footprintMm, 3)}mm" height="${r(g.footprintMm, 3)}mm"` : `width="${total}" height="${total}"`;
  let d = '';
  for (let y = 0; y < qr.size; y++) {
    let x = 0;
    while (x < qr.size) {
      if (!qr.dark(x, y)) { x++; continue; }
      let run = 1;
      while (x + run < qr.size && qr.dark(x + run, y)) run++;
      d += `M${x + quiet},${y + quiet}h${run}v1h-${run}z`;
      x += run;
    }
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n`
    + `<svg xmlns="http://www.w3.org/2000/svg" ${dim} viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges">`
    + `<rect width="${total}" height="${total}" fill="${light}"/>`
    + `<path fill="${dark}" d="${d}"/>`
    + `</svg>\n`;
}

// ---------------------------------------------------------------------------
// PNG — 1-bit, integer px per module, no antialiasing, stored (uncompressed)
// ---------------------------------------------------------------------------

function adler32(bytes) {
  let a = 1, b = 0;
  for (let i = 0; i < bytes.length; i++) { a = (a + bytes[i]) % 65521; b = (b + a) % 65521; }
  return ((b << 16) | a) >>> 0;
}

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/**
 * @param {number} scale  integer pixels per module (never fractional)
 * @param {number} [dpi]  written to pHYs so a printer sees the intended size
 */
export function toPng(qr, { scale, quiet = QUIET_MODULES, dpi = 0 } = {}) {
  if (!Number.isInteger(scale) || scale < 1) throw new Error('PNG scale must be a whole number of pixels per module.');
  const modulesAcross = qr.size + 2 * quiet;
  const w = modulesAcross * scale;
  if (w > 8192) throw new Error('PNG would exceed 8192 px; use SVG for this size.');
  const rowBytes = Math.ceil(w / 8);
  const raw = new Uint8Array((rowBytes + 1) * w);          // filter byte per row
  raw.fill(0xFF);                                          // 1 = white
  for (let py = 0; py < w; py++) {
    const rowStart = py * (rowBytes + 1);
    raw[rowStart] = 0;                                     // filter: None
    const my = Math.floor(py / scale) - quiet;
    if (my < 0 || my >= qr.size) continue;
    for (let px = 0; px < w; px++) {
      const mx = Math.floor(px / scale) - quiet;
      if (mx >= 0 && mx < qr.size && qr.dark(mx, my)) {
        raw[rowStart + 1 + (px >> 3)] &= ~(0x80 >> (px & 7));   // 0 = black
      }
    }
  }
  // zlib stream of stored blocks
  const blocks = [];
  for (let i = 0; i < raw.length; i += 65535) {
    const len = Math.min(65535, raw.length - i);
    const hdr = new Uint8Array(5);
    hdr[0] = (i + len >= raw.length) ? 1 : 0;
    hdr[1] = len & 255; hdr[2] = len >> 8; hdr[3] = (~len) & 255; hdr[4] = ((~len) >> 8) & 255;
    blocks.push(hdr, raw.subarray(i, i + len));
  }
  const adler = adler32(raw);
  const tail = new Uint8Array(4);
  new DataView(tail.buffer).setUint32(0, adler);
  const zParts = [new Uint8Array([0x78, 0x01]), ...blocks, tail];
  const zlen = zParts.reduce((n, p) => n + p.length, 0);
  const z = new Uint8Array(zlen);
  let pos = 0;
  for (const p of zParts) { z.set(p, pos); pos += p.length; }

  const ihdr = new Uint8Array(13);
  const idv = new DataView(ihdr.buffer);
  idv.setUint32(0, w); idv.setUint32(4, w);
  ihdr[8] = 1;           // bit depth 1
  ihdr[9] = 0;           // greyscale
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr)];
  if (dpi > 0) {
    const ppm = Math.round(dpi / 0.0254);
    const phys = new Uint8Array(9);
    const pdv = new DataView(phys.buffer);
    pdv.setUint32(0, ppm); pdv.setUint32(4, ppm); phys[8] = 1;
    parts.push(chunk('pHYs', phys));
  }
  parts.push(chunk('IDAT', z), chunk('IEND', new Uint8Array(0)));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  pos = 0;
  for (const p of parts) { out.set(p, pos); pos += p.length; }
  return out;
}

// ---------------------------------------------------------------------------
// Hashing, naming, manifest
// ---------------------------------------------------------------------------

export async function sha256Hex(bytes) {
  const data = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
  const buf = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function slug(s) {
  return String(s || 'na').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'na';
}

/** covered-qr_<surface>_<entity>_<token>_<ec><version>_<Xmm>_r<rev>.<ext> */
export function fileName({ surface, entity, shortCode, qr, xMm, rev = 1, ext, draft = false }) {
  const x = xMm ? `${r(xMm, 2).toString().replace('.', 'p')}mm` : 'px';
  const base = `covered-qr_${slug(surface)}_${slug(entity)}_${shortCode}_${qr.ecl}${qr.version}_${x}_r${rev}.${ext}`;
  return draft ? `DRAFT-${base}` : base;
}

/** CSV cell, hardened against spreadsheet formula injection (= + - @ tab CR). */
export function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const MANIFEST_COLUMNS = [
  'short_code', 'label', 'surface', 'advertiser', 'machine_id', 'full_url', 'destination_url', 'lifecycle',
  'ec_requested', 'ec_actual', 'version', 'modules', 'mask', 'x_mm', 'symbol_mm', 'quiet_mm', 'footprint_mm',
  'dark_hex', 'light_hex', 'contrast_ratio', 'matrix_sha256', 'sha256_svg', 'sha256_png', 'generated_at', 'library',
  'library_version', 'print_run_ref',
];

export function manifestCsv(rows) {
  const lines = [MANIFEST_COLUMNS.join(',')];
  for (const row of rows) lines.push(MANIFEST_COLUMNS.map((c) => csvCell(row[c])).join(','));
  return lines.join('\r\n') + '\r\n';
}

/**
 * Build every artefact for one register row. Pure + async only because of SHA-256.
 * @returns {{qr, geo, svg, png, files:{name,data}[], manifestRow, checks}}
 */
export async function buildArtefacts(code, { host, advertiserName = '', symbolMm, dpi = 600, rev = 1, now = new Date() } = {}) {
  const spec = SURFACE_SPECS[code.surface] || SURFACE_SPECS.other;
  // 'direct' codes encode the destination itself (untracked, recorded for the register only). Every
  // other mode encodes the COVERED short URL. The manifest's full_url says which one was printed.
  const url = code.mode === 'direct' ? code.destination_url : payloadFor(host, code.short_code);
  const qr = encode(url, spec.ecl);
  const isScreen = code.surface === 'screen';
  const sym = isScreen ? null : (symbolMm || spec.symbolMm);
  const geo = sym ? geometry(qr.size, sym) : null;
  const colours = { dark: '#000000', light: '#ffffff' };
  const checks = assessments(qr, code.surface, sym, colours);
  const draft = !(code.lifecycle === 'approved_for_print' || code.lifecycle === 'in_field');

  const svg = toSvg(qr, { symbolMm: sym, ...colours });
  const scale = isScreen ? spec.pxPerModule
    : Math.max(1, Math.round((dpi * geo.xMm) / 25.4));                       // integer px per module at `dpi`
  // A very large symbol can exceed what a 1-bit PNG should hold. That must not take the SVG (the file
  // that is actually printed at that size) and the ZIP down with it.
  let png = null; let pngNote = '';
  try { png = toPng(qr, { scale, dpi: isScreen ? 0 : dpi }); } catch (e) { pngNote = String((e && e.message) || e); }
  const entity = code.machine_id || advertiserName || code.label;

  const svgName = fileName({ surface: code.surface, entity, shortCode: code.short_code, qr, xMm: geo && geo.xMm, rev, ext: 'svg', draft });
  const pngName = fileName({ surface: code.surface, entity, shortCode: code.short_code, qr, xMm: geo && geo.xMm, rev, ext: 'png', draft });
  const matrixRows = Array.from({ length: qr.size }, (_, y) => Array.from({ length: qr.size }, (_, x) => qr.modules[y * qr.size + x]).join(''));
  const [hSvg, hPng, hMatrix] = await Promise.all([sha256Hex(svg), png ? sha256Hex(png) : Promise.resolve(''), sha256Hex(matrixRows.join(String.fromCharCode(10)))]);

  const manifestRow = {
    short_code: code.short_code, label: code.label, surface: code.surface, advertiser: advertiserName,
    machine_id: code.machine_id || '', full_url: url, destination_url: code.destination_url, lifecycle: code.lifecycle,
    ec_requested: qr.eclRequested, ec_actual: qr.ecl, version: qr.version, modules: qr.size, mask: qr.mask,
    x_mm: geo ? r(geo.xMm, 4) : '', symbol_mm: sym || '', quiet_mm: geo ? r(geo.quietMm, 4) : '',
    footprint_mm: geo ? r(geo.footprintMm, 3) : '', dark_hex: colours.dark, light_hex: colours.light,
    contrast_ratio: r(contrastRatio(colours.dark, colours.light), 1), matrix_sha256: hMatrix, sha256_svg: hSvg, sha256_png: hPng,
    generated_at: now.toISOString(), library: LIBRARY.name, library_version: LIBRARY.version,
    print_run_ref: code.print_run_ref || '',
  };
  return {
    qr, geo, svg, png, pngNote, draft, checks, manifestRow,
    files: png ? [{ name: svgName, data: svg }, { name: pngName, data: png }] : [{ name: svgName, data: svg }],
  };
}
