"use strict";
// Structural accessibility of every screen of the panel, checked on the test DOM (a real-browser keyboard run is in
// browser.test.js when Chrome is available): names for every control, labelled groups, a heading outline without gaps,
// unique ids whose references exist, a polite live region, alerts for errors, focus moves, no positive tabindex,
// and a non-colour cue for every Before/After difference.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createHost, createFakeApi, SAMPLE, ev } = require("./harness/host.js");

function all(root, out) { out = out || []; root.childNodes.forEach((c) => { if (c.nodeType === 1) { out.push(c); all(c, out); } }); return out; }
function nameOf(el, root) {
  const aria = el.getAttribute("aria-label");
  if (aria && aria.trim()) return aria.trim();
  const lb = el.getAttribute("aria-labelledby");
  if (lb) return lb.split(/\s+/).map((id) => { const t = root.querySelector("#" + id); return t ? t.textContent.trim() : ""; }).join(" ").trim();
  if (el.id) { const l = root.querySelector("label[for='" + el.id + "']"); if (l) return l.textContent.trim(); }
  for (let p = el.parentNode; p && p.nodeType === 1; p = p.parentNode) if (p.tagName === "LABEL") return p.textContent.trim();
  if (el.tagName === "BUTTON" || el.tagName === "A") return el.textContent.trim();
  return "";
}

function checkStructure(h, label) {
  const root = h.container;
  const els = all(root);
  // 1. every control has a name
  for (const e of els.filter((x) => ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(x.tagName) || (x.tagName === "A" && x.hasAttribute("href")))) {
    assert.ok(nameOf(e, root).length > 0, label + ": unnamed " + e.tagName + " " + (e.getAttribute("data-act") || e.id));
  }
  // 2. ids are unique and every reference points at something
  const ids = els.map((e) => e.id).filter(Boolean);
  assert.equal(new Set(ids).size, ids.length, label + ": duplicate ids " + ids.filter((x, i) => ids.indexOf(x) !== i));
  for (const e of els) {
    for (const a of ["for", "aria-describedby", "aria-labelledby", "aria-controls"]) {
      const v = e.getAttribute(a);
      if (v) for (const id of v.split(/\s+/)) assert.ok(root.querySelector("#" + id), label + ": " + a + "=" + id + " has no target");
    }
  }
  // 3. groups are named
  for (const g of els.filter((e) => e.getAttribute("role") === "group")) assert.ok(g.getAttribute("aria-label") || g.getAttribute("aria-labelledby"), label + ": an unnamed group");
  // 4. headings never skip a level and start at h3 (the panel title is the h2 of the shell)
  const heads = els.filter((e) => /^H[1-6]$/.test(e.tagName)).map((e) => Number(e.tagName[1]));
  let prev = 2;
  for (const n of heads) { assert.ok(n <= prev + 1, label + ": heading jumps from h" + prev + " to h" + n); prev = n; }
  if (heads.length) assert.equal(heads[0], 3, label + ": first heading is h3");
  // 5. no positive tabindex, no mouse-only element (a click handler on something that is not a control)
  for (const e of els) { const t = e.getAttribute("tabindex"); if (t !== null) assert.ok(Number(t) <= 0, label + ": tabindex " + t); }
  for (const e of els) if (e.listeners && e.listeners.click && e.listeners.click.length) assert.ok(["BUTTON", "A", "INPUT", "LABEL"].includes(e.tagName), label + ": click handler on <" + e.tagName + ">");
  // 6. a polite live region exists inside the panel
  assert.ok(els.some((e) => e.getAttribute("role") === "status" && e.getAttribute("aria-live") === "polite"), label + ": polite live region");
}

const opened = async (h) => { h.openPanel(); await h.settle(2, 0); return h; };
const flow = {
  signedOut: async () => opened(createHost({ signedOut: true })),
  off: async () => { const api = createFakeApi(); api.statusKey = "disabled"; return opened(createHost({ api })); },
  idle: async () => opened(createHost()),
  working: async () => { const api = createFakeApi(); api.pause(); const h = await opened(createHost({ api })); h.type("#csx-ai-instr", "x"); h.must("[data-act='submit']").click(); await h.settle(2, 0); return h; },
  patch: async () => { const h = await opened(createHost()); await h.ask("make the hero shorter"); return h; },
  patchFlagged: async () => { const api = createFakeApi(); api.queue.push(SAMPLE.proposals.patchOutside); const h = await opened(createHost({ api })); await h.ask("warm up"); return h; },
  needs_code: async () => { const h = await opened(createHost()); await h.ask("change the font"); return h; },
  clarify: async () => { const h = await opened(createHost()); await h.ask("add a venue in Bristol"); return h; },
  tone: async () => { const h = await opened(createHost()); h.qa(".csx-ai-mode")[3].click(); h.must("[data-act='submit']").click(); await h.settle(); return h; },
  saved: async () => { const h = await opened(createHost()); await h.ask("make the hero shorter"); h.must("[data-act='save']").click(); await h.settle(); return h; },
  error: async () => { const api = createFakeApi(); api.queue.push({ status: 502, error: SAMPLE.errors.ai_unavailable }); const h = await opened(createHost({ api })); await h.ask("x"); return h; },
};

for (const [name, make] of Object.entries(flow)) {
  test("screen '" + name + "': names, groups, headings, ids, tabindex, live region", async () => {
    const h = await make();
    checkStructure(h, name);
    h.close();
  });
}

test("the result heading takes focus when a result arrives; the progress line is in the live region while working", async () => {
  const h = await flow.patch();
  assert.equal(h.document.activeElement.tagName, "H3");
  assert.equal(h.document.activeElement.getAttribute("tabindex"), "-1");
  assert.equal(h.document.activeElement.textContent, "Suggested changes");
  h.close();
  const w = await flow.working();
  assert.equal(w.must(".csx-ai").getAttribute("aria-busy"), "true");
  assert.ok(w.must("[data-working-line]"));
  await w.settle();
  assert.match(w.live(), /Thinking about it/);
  w.close();
});

test("errors are role=alert; notes are role=note; the working screen offers Cancel", async () => {
  const e = await flow.error();
  assert.equal(e.must("[role='alert']").getAttribute("data-error"), "ai_unavailable");
  e.close();
  const f = await flow.patchFlagged();
  assert.ok(f.qa("[role='note']").length >= 1);
  f.close();
  const w = await flow.working();
  assert.ok(w.must("[data-act='cancel']"));
  w.close();
});

test("each change checkbox is named 'Include <title>' and described by its flags", async () => {
  const h = await flow.patchFlagged();
  for (const c of SAMPLE.proposals.patchOutside.changes) {
    const cb = h.must("input[data-change='" + c.id + "']");
    const name = nameOf(cb, h.container);
    assert.match(name, /^Include /);
    assert.ok(name.includes(c.title.slice(0, 20)), name);
    assert.ok(h.container.querySelector("#" + cb.getAttribute("aria-describedby")), "described-by target exists");
  }
  h.close();
});

test("Before and After are real headings, and every insertion/removal has a text cue as well as a style", async () => {
  const h = await flow.patch();
  const heads = h.qa("h5").map((x) => x.textContent);
  assert.ok(heads.length >= 2 && heads.every((t) => t === "Before" || t === "After"));
  assert.ok(h.qa(".csx-ai-ins").length >= 1);
  for (const ins of h.qa(".csx-ai-ins")) assert.match(ins.textContent, /^\[added\]/);
  for (const del of h.qa(".csx-ai-del")) assert.match(del.textContent, /^\[removed\]/);
  h.close();
});

test("keyboard: Ctrl+Enter in the box sends; Enter alone does not; the mode buttons are real buttons with aria-pressed", async () => {
  const h = await opened(createHost());
  const ta = h.type("#csx-ai-instr", "make the hero shorter");
  ta.dispatchEvent(ev("keydown", { key: "Enter", ctrlKey: false }));
  await h.settle(2, 0);
  assert.equal(h.phase(), "idle", "plain Enter is a new line, not a send");
  ta.dispatchEvent(ev("keydown", { key: "Enter", ctrlKey: true }));
  await h.settle();
  assert.equal(h.phase(), "patch");
  assert.ok(h.api.calls.some((c) => c.path === "/v1/ai/propose"));
  h.close();
  const g = await opened(createHost());
  assert.ok(g.qa(".csx-ai-mode").every((b) => b.tagName === "BUTTON" && b.getAttribute("type") === "button" && b.hasAttribute("aria-pressed")));
  g.close();
});

test("keyboard: after Discard and after Cancel, focus stays inside the panel (never on a removed element)", async () => {
  const h = await flow.patch();
  h.qa("button").find((b) => b.textContent === "Discard").click();
  assert.ok(h.document.activeElement && h.container.contains(h.document.activeElement), "focus is inside the panel");
  h.close();
  const w = await flow.working();
  w.must("[data-act='cancel']").click();
  assert.ok(w.document.activeElement && w.container.contains(w.document.activeElement), "focus is inside the panel after Cancel");
  w.close();
});
