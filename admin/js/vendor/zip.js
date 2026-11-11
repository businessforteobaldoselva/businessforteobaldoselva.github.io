// =============================================================================
// COVERED Admin Console — store-only ZIP writer + CRC-32
// -----------------------------------------------------------------------------
// Written in-house (it lives in vendor/ only because the QR plan files it with
// the other no-CDN pieces). Store-only means NO deflate: the payloads are PNGs
// and SVG that gain nothing from compression, and it keeps the CSP at
// script-src 'self' with no third-party origin.
//
//   crc32(bytes)               -> unsigned 32-bit integer
//   makeZip([{ name, data }])  -> Uint8Array  (data: Uint8Array | string)
//
// Names must be plain ASCII-ish relative paths; anything else is replaced so a
// hostile label can never produce "../" traversal or an absolute path.
// =============================================================================

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

const enc = new TextEncoder();

/** Collapse a name to safe characters; never allow path traversal or a leading slash. */
export function safeEntryName(name) {
  const cleaned = String(name || 'file')
    .replace(/\\/g, '/')
    .split('/')
    .filter((seg) => seg && seg !== '.' && seg !== '..')
    .map((seg) => seg.replace(/[^A-Za-z0-9._ -]/g, '_'))
    .join('/');
  return cleaned || 'file';
}

function dosDateTime(d) {
  const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() >> 1) & 31);
  const date = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
  return { time, date };
}

export function makeZip(files, when = new Date()) {
  const { time, date } = dosDateTime(when);
  const parts = [];
  const central = [];
  let offset = 0;
  const seen = new Set();

  for (const f of files) {
    let name = safeEntryName(f.name);
    // Two entries must never share a name: the second would be unreachable.
    if (seen.has(name)) {
      const dot = name.lastIndexOf('.');
      let i = 2, candidate;
      do { candidate = dot > 0 ? `${name.slice(0, dot)}-${i}${name.slice(dot)}` : `${name}-${i}`; i++; } while (seen.has(candidate));
      name = candidate;
    }
    seen.add(name);

    const nameBytes = enc.encode(name);
    const data = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
    const crc = crc32(data);
    const size = data.length;
    if (size >= 0xFFFFFFFF) throw new Error('File too large for the simple ZIP writer.');

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);          // version needed
    local.setUint16(6, 0x0800, true);      // flag: UTF-8 names
    local.setUint16(8, 0, true);           // method 0 = stored
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true);
    local.setUint32(22, size, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);
    parts.push(new Uint8Array(local.buffer), nameBytes, data);

    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, 0, true);
    cd.setUint16(12, time, true);
    cd.setUint16(14, date, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, size, true);
    cd.setUint32(24, size, true);
    cd.setUint16(28, nameBytes.length, true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), nameBytes);

    offset += 30 + nameBytes.length + size;
  }

  const cdSize = central.reduce((n, p) => n + p.length, 0);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, seen.size, true);
  eocd.setUint16(10, seen.size, true);
  eocd.setUint32(12, cdSize, true);
  eocd.setUint32(16, offset, true);

  const all = [...parts, ...central, new Uint8Array(eocd.buffer)];
  const total = all.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of all) { out.set(p, pos); pos += p.length; }
  return out;
}
