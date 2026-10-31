"use strict";
// Model and editor text reaches the page only as TEXT NODES (AI-DESIGN 2 I8, 14.7). The test DOM throws if innerHTML is
// assigned, and these tests look for the hostile string as the data of a text node, never as an element.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createHost, createFakeApi, SAMPLE, clone } = require("./harness/host.js");

const EVIL = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>';

function textNodes(root, out) {
  out = out || [];
  root.childNodes.forEach((c) => { if (c.nodeType === 3) out.push(c); else textNodes(c, out); });
  return out;
}
function elements(root, out) {
  out = out || [];
  root.childNodes.forEach((c) => { if (c.nodeType === 1) { out.push(c); elements(c, out); } });
  return out;
}

async function show(proposal) {
  const api = createFakeApi();
  api.queue.push(proposal);
  const h = createHost({ api });
  h.openPanel(); await h.settle(3, 0);
  h.type("#csx-ai-instr", "go");
  h.must("[data-act='submit']").click();
  await h.settle(4, 0);
  return h;
}

test("summary, titles, labels, before/after, diff runs, field lists, skipped reasons and warnings are text nodes", async () => {
  const p = clone(SAMPLE.proposals.patchOutside);
  p.summary = EVIL;
  p.changes.forEach((c) => {
    c.title = EVIL;
    c.deltas.forEach((d) => {
      d.label = EVIL;
      if (d.before && d.before.type === "text") d.before.text = EVIL + " old";
      if (d.after && d.after.type === "text") d.after.text = EVIL + " new";
      d.diff = null;
    });
  });
  p.skipped = [{ title: EVIL, reason: EVIL, code: "x" }];
  p.warnings = [{ code: "injection_suspected", message: EVIL, refs: [] }];
  const h = await show(p);
  const nodes = textNodes(h.container).filter((n) => n.data.includes("<img src=x"));
  assert.ok(nodes.length >= 6, "found the hostile text in " + nodes.length + " text nodes");
  for (const n of nodes) assert.ok(["P", "STRONG", "H4", "SPAN", "LI", "DIV"].includes(n.parentNode.tagName), "parent " + n.parentNode.tagName);
  assert.ok(elements(h.container).every((e) => !["IMG", "SCRIPT", "STYLE", "IFRAME", "SVG"].includes(e.tagName)));
  h.close();
});

test("diff runs, order, fields, link and colour renderings are text nodes too", async () => {
  const p = clone(SAMPLE.proposals.patchTwoChangesWithDependency);
  p.changes[0].deltas[0].after = { type: "fields", fields: [{ label: EVIL, text: EVIL }] };
  p.changes[1].deltas[0].before = { type: "text", text: EVIL, truncated: false };
  p.changes[1].deltas[0].after = { type: "text", text: EVIL + "!", truncated: false };
  p.changes[1].deltas[0].diff = [{ t: "del", s: EVIL }, { t: "ins", s: EVIL + "!" }];
  const h = await show(p);
  const nodes = textNodes(h.container).filter((n) => n.data.includes("<script>"));
  assert.ok(nodes.length >= 4);
  assert.ok(h.qa(".csx-ai-ins").length === 1 && h.qa(".csx-ai-del").length === 1, "the diff runs are rendered");
  assert.ok(elements(h.container).every((e) => !["IMG", "SCRIPT"].includes(e.tagName)));
  h.close();
});

test("needs-code request fields are values of read-only boxes, tone quotes are text", async () => {
  const nc = clone(SAMPLE.proposals.needs_code);
  nc.needsCode.request.title = EVIL; nc.needsCode.request.body = EVIL; nc.needsCode.reason = EVIL;
  let h = await show(nc);
  assert.equal(h.must("textarea[data-req='title']").value, EVIL.length > 120 ? EVIL.slice(0, 119) + "…" : EVIL);
  assert.ok(elements(h.container).every((e) => e.tagName !== "IMG" && e.tagName !== "SCRIPT"));
  h.close();
  const t = clone(SAMPLE.proposals.tone);
  t.findings[0].quote = EVIL; t.findings[0].issue = EVIL; t.findings[0].suggestion = EVIL;
  h = await show(t);
  assert.ok(textNodes(h.must("[data-quote]")).some((n) => n.data === EVIL));
  assert.ok(elements(h.container).every((e) => e.tagName !== "IMG" && e.tagName !== "SCRIPT"));
  h.close();
});

test("the host DOM refuses innerHTML, so this test file would fail loudly if the panel used it", () => {
  const { createDom } = require("./harness/dom-stub.js");
  const d = createDom().document;
  const e = d.createElement("div");
  assert.throws(() => { e.innerHTML = "<b>x</b>"; }, /innerHTML was assigned/);
  assert.throws(() => e.outerHTML, /not available/);
});
