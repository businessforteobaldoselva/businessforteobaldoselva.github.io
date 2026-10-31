"use strict";
// Word diff for BEFORE/AFTER (AI-DESIGN 10). tokens(a), tokens(b) -> LCS -> merged segments { t: same|del|ins, s }.
// Law (tested): the "same"+"del" segments concatenate to `a`, the "same"+"ins" segments concatenate to `b`.
// Falls back to paragraphs, then to one del + one ins, when the inputs are large. Pure, portable.

const MAX_CELLS = 4000000;
const MAX_CHARS = 4000;
const MAX_SEGMENTS = 400;

const tokens = (s) => String(s).split(/(\s+)/).filter((x) => x.length > 0);

function merge(segs) {
  const out = [];
  for (const sg of segs) {
    if (!sg.s) continue;
    const last = out[out.length - 1];
    if (last && last.t === sg.t) last.s += sg.s;
    else out.push({ t: sg.t, s: sg.s });
  }
  return out;
}

function lcsDiff(A, B) {
  const n = A.length;
  const m = B.length;
  const w = m + 1;
  const dp = new Uint16Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i * w + j] = A[i] === B[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push({ t: "same", s: A[i] }); i += 1; j += 1; }
    else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) { out.push({ t: "del", s: A[i] }); i += 1; }
    else { out.push({ t: "ins", s: B[j] }); j += 1; }
  }
  while (i < n) { out.push({ t: "del", s: A[i] }); i += 1; }
  while (j < m) { out.push({ t: "ins", s: B[j] }); j += 1; }
  // inside one changed run, show all removals before all additions (easier to read than interleaved words)
  const fixed = [];
  let dels = [];
  let inss = [];
  const flush = () => { for (const x of dels) fixed.push(x); for (const x of inss) fixed.push(x); dels = []; inss = []; };
  for (const sg of out) {
    if (sg.t === "same") { flush(); fixed.push(sg); } else if (sg.t === "del") dels.push(sg); else inss.push(sg);
  }
  flush();
  return fixed;
}

function wordDiff(a, b) {
  const A = tokens(a);
  const B = tokens(b);
  if (A.length * B.length > MAX_CELLS || A.length > 60000 || B.length > 60000) return null;
  return merge(lcsDiff(A, B));
}

// diff(a, b) -> Segment[] (at most 400)
function diff(a, b) {
  a = String(a);
  b = String(b);
  if (a === b) return a ? [{ t: "same", s: a }] : [];
  let segs = null;
  if (a.length <= MAX_CHARS && b.length <= MAX_CHARS) segs = wordDiff(a, b);
  if (!segs) {
    const pa = a.split(/(\n\n)/);
    const pb = b.split(/(\n\n)/);
    if (pa.length * pb.length <= MAX_CELLS && pa.length < 5000 && pb.length < 5000) segs = merge(lcsDiff(pa, pb));
  }
  if (!segs || segs.length > MAX_SEGMENTS) segs = merge([{ t: "del", s: a }, { t: "ins", s: b }]);
  return segs;
}

module.exports = { diff, tokens, MAX_SEGMENTS };
