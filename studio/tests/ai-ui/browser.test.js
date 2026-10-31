"use strict";
// Real-browser run of the "Describe a change" panel: the REAL overlay bundle in headless Chrome against the overlay stub
// server with the deterministic AI demo (studio/overlay/dev/ai-demo.js). Keyboard-only completion, partial accept, the exact
// patch that reached the draft, the off state, the needs-code card, hostile model text, phone layout, dark mode contrast.
// Skips itself (never fails) without puppeteer-core or Chrome:  STUDIO_PUPPETEER=<path to puppeteer-core>  STUDIO_CHROME=<chrome>.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const H = require("./harness/browser.js");
const CC = require(path.resolve(__dirname, "..", "..", "..", "cms", "contrast.js"));

let env = null;
test.before(async () => { if (!H.SKIP) env = await H.launch(); });
test.after(async () => { if (env) await env.close(); });

const page$ = async (o) => { const p = await H.newPage(env, o); await H.signIn(p); return p; };
const phase = (p) => H.inShadow(p, (r) => { const e = r.querySelector(".csx-ai [data-phase], .csx-ai [data-kind]"); return e ? e.getAttribute("data-phase") || e.getAttribute("data-kind") : null; });

test("keyboard only: open from the palette-less dock, describe, review, untick one, save, and the draft holds only the ticked change", { skip: H.SKIP }, async () => {
  const page = await page$();
  await H.openAi(page);
  // the panel title takes focus; Tab to the box, type, Ctrl+Enter
  assert.equal(await phase(page), "idle");
  await page.keyboard.press("Tab");
  let a = await H.active(page);
  for (let i = 0; i < 30 && !(a && a.id === "csx-ai-instr"); i++) { await page.keyboard.press("Tab"); a = await H.active(page); }
  assert.equal(a.id, "csx-ai-instr", "the instruction box is reachable by Tab");
  await page.keyboard.type("make the hero shorter and warmer");
  await page.keyboard.down("Control"); await page.keyboard.press("Enter"); await page.keyboard.up("Control");
  await H.waitShadow(page, (r) => r.querySelector(".csx-ai [data-kind='patch']"));
  a = await H.active(page);
  assert.equal(a.tag, "h3", "focus moved to the result heading");
  assert.match(a.text, /Suggested changes/);
  // Tab to the second change's checkbox and untick it with Space
  let hit = null;
  for (let i = 0; i < 40 && !hit; i++) { await page.keyboard.press("Tab"); a = await H.active(page); if (a && a.change === "c2") hit = a; }
  assert.ok(hit, "c2 checkbox reachable");
  await page.keyboard.press("Space");
  const saveText = await H.inShadow(page, (r) => r.querySelector("[data-act='save']").textContent);
  assert.equal(saveText, "Save 2 changes as a draft", "three suggested, second unticked");
  // go to Save and press Enter
  for (let i = 0; i < 40 && !(a && a.act === "save"); i++) { await page.keyboard.press("Tab"); a = await H.active(page); }
  assert.equal(a.act, "save");
  await page.keyboard.press("Enter");
  await H.waitShadow(page, (r) => r.querySelector(".csx-ai [data-phase='saved']"));
  const patch = env.stub.patches[env.stub.patches.length - 1];
  assert.deepEqual(env.stub.ai.accepted.map((x) => x.accept), [["c1", "c3"]]);
  assert.equal(patch.ops.length, 2, "only the ticked changes became ops");
  assert.deepEqual(patch.ops.map((o) => o.path), ["/headlineMain", "/subhead"]);
  assert.ok(patch.ops.every((o) => o.op === "replace" && "expect" in o && o.file === "src/_data/hero.json"), "ops carry expect and stay in the data layer");
  assert.equal(env.stub.mainDocs["src/_data/hero.json"].headlineAccent, "one venue at a time", "the unticked change did not happen");
  assert.equal(env.stub.drafts.size, 1);
  assert.deepEqual(page.__errors, []);
  await H.closePage(page);
});

test("Before and After are shown per change; the diff has a cue besides colour; nothing is written by asking", { skip: H.SKIP }, async () => {
  const page = await page$();
  await H.openAi(page);
  const before = env.stub.patches.length;
  await H.ask(page, "make the hero shorter and warmer");
  const info = await H.inShadow(page, (r) => ({
    heads: Array.from(r.querySelectorAll(".csx-ai h5")).map((h) => h.textContent),
    ins: Array.from(r.querySelectorAll(".csx-ai-ins")).map((e) => e.textContent),
    del: Array.from(r.querySelectorAll(".csx-ai-del")).map((e) => e.textContent),
    decoIns: getComputedStyle(r.querySelector(".csx-ai-ins")).textDecorationLine,
    decoDel: getComputedStyle(r.querySelector(".csx-ai-del")).textDecorationLine,
    cards: r.querySelectorAll("[data-card]").length,
  }));
  assert.equal(info.cards, 3);
  assert.ok(info.heads.length === 6 && info.heads.every((t) => t === "Before" || t === "After"));
  assert.ok(info.ins.every((t) => t.startsWith("[added]")) && info.del.every((t) => t.startsWith("[removed]")));
  assert.match(info.decoIns, /underline/);
  assert.match(info.decoDel, /line-through/);
  assert.equal(env.stub.patches.length, before, "a suggestion writes nothing");
  assert.equal(env.stub.drafts.size, 0);
  await H.closePage(page);
});

test("flagged change (contact email, outside the ask): unticked by default with a plain reason; saving without it", { skip: H.SKIP }, async () => {
  const page = await page$();
  await H.openAi(page);
  await H.ask(page, "warm up the hero and change the contact email");
  const st = await H.inShadow(page, (r) => Array.from(r.querySelectorAll("input[data-change]")).map((c) => [c.getAttribute("data-change"), c.checked]));
  assert.deepEqual(st, [["c1", true], ["c2", false]]);
  const txt = await H.shadowText(page);
  assert.match(txt, /Outside what you asked about/);
  assert.match(txt, /Changes where visitors go \(link or email\)/);
  assert.match(txt, /Some page text reads like an instruction/);
  await H.click(page, "Save 1 change as a draft");
  await H.waitShadow(page, (r) => r.querySelector(".csx-ai [data-phase='saved']"));
  assert.equal(env.stub.mainDocs["src/_data/site.json"].contactEmail, "hello@example.test", "the email was not touched");
  const patch = env.stub.patches[env.stub.patches.length - 1];
  assert.ok(patch.ops.every((o) => o.file === "src/_data/hero.json"));
  await H.closePage(page);
});

test("dependent changes: ticking the second ticks the first; saving only the first is fine; the server refuses an incomplete selection", { skip: H.SKIP }, async () => {
  const page = await page$();
  await H.openAi(page);
  await H.ask(page, "add a venue question to the faq");
  await H.click(page, "Select none");
  await H.inShadow(page, (r) => r.querySelector("input[data-change='c2']").click());
  const st = await H.inShadow(page, (r) => Array.from(r.querySelectorAll("input[data-change]")).map((c) => c.checked));
  assert.deepEqual(st, [true, true]);
  await H.click(page, "Save 2 changes as a draft");
  await H.waitShadow(page, (r) => r.querySelector(".csx-ai [data-phase='saved']"));
  const faq = env.stub.drafts.values().next().value.docs["src/_data/faq.json"];
  assert.equal(faq.items.length, 3);
  assert.match(faq.items[2].a, /within two working days/);
  await H.closePage(page);
  // the demo server (like the real one) also refuses a hand-made incomplete selection
  const res = await (await fetch(env.stub.apiOrigin + "/v1/ai/accept", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer dev:editor:molly@covered.test", Origin: env.stub.siteOrigin }, body: JSON.stringify({ idempotencyKey: "6b1d2c3e-4f50-4a61-8b72-9c8d7e6f5a40", proposal: { id: [...env.stub.ai.proposals.keys()].pop(), instructionHash: "x", base: { sha: "a".repeat(40), draftId: null, headSha: null }, model: "m", changes: [{ id: "c1", title: "t", ops: [] }, { id: "c2", title: "t", ops: [] }] }, accept: ["c2"] }) })).json();
  assert.equal(res.error.code, "validation_failed");
  assert.match(res.error.details.problems[0].message, /also needs/);
});

test("the off states: switched off, no key, allowance used up", { skip: H.SKIP }, async () => {
  for (const [status, re] of [["disabled", /AI help is switched off/], ["no_key", /not connected yet/], ["budget_exhausted", /allowance is used up/]]) {
    const page = await H.newPage(env);
    env.stub.ai.status = status;
    await H.signIn(page);
    await H.openAi(page);
    assert.match(await H.shadowText(page), re);
    assert.equal(await H.inShadow(page, (r) => !!r.querySelector("#csx-ai-instr")), false, "no input in the off state");
    assert.equal(env.stub.ai.calls.filter((c) => c.method === "POST").length, 0, "nothing was sent");
    await H.closePage(page);
  }
});

test("needs-code: card with the drafted request, Copy, Open Ask Claude; no draft is made", { skip: H.SKIP }, async () => {
  const page = await page$();
  await H.openAi(page);
  await H.ask(page, "make the hero video autoplay with parallax");
  const info = await H.inShadow(page, (r) => ({ title: r.querySelector("textarea[data-req='title']").value, link: r.querySelector("a.csx-ai-link") && r.querySelector("a.csx-ai-link").href, rel: r.querySelector("a.csx-ai-link").rel, save: !!r.querySelector("[data-act='save']") }));
  assert.match(info.title, /autoplay/);
  assert.match(info.link, /\/admin\/#\/collections\/requests\/new$/);
  assert.match(info.rel, /noopener/);
  assert.equal(info.save, false);
  await H.click(page, "Copy request");
  await H.waitShadow(page, (r) => r.querySelector("[data-copy-note]").textContent.length > 0);
  assert.equal(env.stub.drafts.size, 0);
  assert.equal(env.stub.patches.length, 0);
  await H.closePage(page);
});

test("hostile model text in the browser: nothing runs, nothing becomes an element, bidi controls vanish, RTL text stays readable", { skip: H.SKIP }, async () => {
  const page = await page$();
  const dialogs = [];
  page.on("dialog", (d) => { dialogs.push(d.message()); d.dismiss(); });
  await H.openAi(page);
  const EVIL = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>';
  const BIDI = "evil‮fdp.exe‬";
  env.stub.ai.next = {
    id: "p_hostile000001", kind: "patch", mode: "edit", summary: EVIL, base: { sha: "a".repeat(40), draftId: null, headSha: null }, instructionHash: "0123456789abcdef", model: "m", provider: "replay",
    changes: [
      { id: "c1", title: EVIL, ops: [{ op: "replace", file: "src/_data/hero.json", path: "/subhead", value: "x", expect: "y" }], requires: [], outsideAsk: false, sensitive: false, defaultChecked: true,
        deltas: [{ file: "src/_data/hero.json", path: "/subhead", ref: "hero.subhead", op: "replace", kind: "longtext", label: EVIL, before: { type: "text", text: EVIL + BIDI, truncated: false }, after: { type: "text", text: "مرحبا بالعالم — שלום עולם " + BIDI, truncated: false }, diff: null }] },
    ],
    skipped: [{ title: EVIL, reason: EVIL, code: "x" }], needsCode: null, question: null, findings: [], warnings: [{ code: "injection_suspected", message: EVIL, refs: ["hero.subhead"] }], usage: { inTok: 1, outTok: 1, latencyMs: 1 },
  };
  await H.ask(page, "anything");
  assert.equal(await phase(page), "patch");
  const r = await H.inShadow(page, (root) => ({
    tags: Array.from(root.querySelectorAll("*")).map((e) => e.tagName.toLowerCase()).filter((t) => ["img", "script", "svg", "iframe", "style"].indexOf(t) >= 0 && !(t === "style")),
    pwned: window.__pwned, text: root.querySelector(".csx-ai").textContent,
    bidiAttr: Array.from(root.querySelectorAll(".csx-ai *")).some((e) => Array.from(e.attributes).some((a) => /[‪-‮⁦-⁩]/.test(a.value))),
    plaintext: getComputedStyle(root.querySelector(".csx-ai-text")).unicodeBidi,
  }));
  assert.deepEqual(r.tags, []);
  assert.equal(r.pwned, 0);
  assert.ok(r.text.includes("<img src=x"), "the markup is visible as text");
  assert.ok(!/[‪-‮⁦-⁩]/.test(r.text), "bidi overrides are gone");
  assert.ok(r.text.includes("مرحبا بالعالم") && r.text.includes("שלום עולם"), "RTL text is kept intact");
  assert.equal(r.bidiAttr, false);
  assert.match(r.plaintext, /plaintext|isolate/);
  assert.deepEqual(dialogs, []);
  assert.deepEqual(page.__errors, []);
  await H.closePage(page);
});

test("a stale suggestion (the page moved on) is explained and can be asked for again", { skip: H.SKIP }, async () => {
  const page = await page$();
  await H.openAi(page);
  await H.ask(page, "make the hero shorter and warmer");
  env.stub.mainDocs["src/_data/hero.json"].headlineMain = "Changed by someone else";
  await H.click(page, "Save 3 changes as a draft");
  await H.waitShadow(page, (r) => r.querySelector(".csx-ai [data-phase='error']"));
  assert.match(await H.shadowText(page), /Something on the site changed since this suggestion was made\. Nothing was saved\./);
  assert.equal(env.stub.drafts.size, 0);
  await H.click(page, "Ask again");
  await H.waitShadow(page, (r) => r.querySelector(".csx-ai [data-kind='patch']"));
  await H.closePage(page);
});

test("the selected picture or headline becomes the request's context", { skip: H.SKIP }, async () => {
  const page = await page$();
  await page.click("#h1");
  await H.openAi(page);
  const chip = await H.inShadow(page, (r) => r.querySelector(".csx-ai-chip") && r.querySelector(".csx-ai-chip").textContent);
  assert.match(chip, /Headline|headline/i);
  await H.ask(page, "make this warmer");
  const sent = env.stub.ai.calls.find((c) => c.path === "/v1/ai/propose").body;
  assert.deepEqual(sent.context, { refs: ["hero.headlineMain"] });
  await H.closePage(page);
});

test("phone (375 px): no dock button for it, reachable from Changes, bottom sheet, no sideways scroll, 44 px controls, stacked Before/After", { skip: H.SKIP }, async () => {
  const page = await H.newPage(env, { viewport: { width: 375, height: 812, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } });
  await H.signIn(page);
  const dock = await H.inShadow(page, (r) => Array.from(r.querySelectorAll(".dock > *")).filter((e) => e.getBoundingClientRect().width > 0).map((e) => e.getBoundingClientRect().top));
  assert.equal(new Set(dock.map(Math.round)).size, 1, "the dock stays on one row");
  await H.click(page, "Changes", { exact: true });
  await H.click(page, "Or describe a change in words");
  await H.waitShadow(page, (r) => r.querySelector(".csx-ai [data-phase='idle']"));
  await H.ask(page, "make the hero shorter and warmer");
  const g = await H.inShadow(page, (r) => {
    const rect = (e) => { const b = e.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom, w: b.width, h: b.height }; };
    const small = Array.from(r.querySelectorAll(".csx-ai button, .csx-ai input, .csx-ai textarea, .csx-ai a")).filter((e) => { const b = e.getBoundingClientRect(); return b.width > 0 && e.closest && !e.closest(".csx-visually-hidden") && (b.width < 43.5 || b.height < 43.5); }).map((e) => (e.textContent || e.type || e.tagName).slice(0, 20) + " " + Math.round(e.getBoundingClientRect().width) + "x" + Math.round(e.getBoundingClientRect().height));
    const sides = r.querySelector(".csx-ai-sides");
    const kids = Array.from(sides.children).map(rect);
    return { panel: rect(r.querySelector(".panel")), dock: rect(r.querySelector(".dock")), small, scrollW: document.documentElement.scrollWidth, vw: window.innerWidth, stacked: kids[1].t >= kids[0].b - 1 };
  });
  assert.ok(g.panel.l >= 0 && g.panel.r <= 376, "panel inside the screen");
  assert.ok(g.panel.b <= g.dock.t + 1, "sheet above the dock");
  assert.deepEqual(g.small, [], "every control is at least 44x44");
  assert.ok(g.scrollW <= g.vw, "no horizontal scroll");
  assert.equal(g.stacked, true, "Before above After on a phone");
  await H.closePage(page);
});

test("a wide sheet (700 px) puts Before and After side by side", { skip: H.SKIP }, async () => {
  const page = await H.newPage(env, { viewport: { width: 700, height: 900, isMobile: true, hasTouch: true, deviceScaleFactor: 1 } });
  await H.signIn(page);
  await H.openAi(page).catch(async () => { await H.click(page, "Changes", { exact: true }); await H.click(page, "Or describe a change in words"); await H.waitShadow(page, (r) => r.querySelector(".csx-ai")); });
  await H.ask(page, "make the hero shorter and warmer");
  const side = await H.inShadow(page, (r) => { const k = Array.from(r.querySelector(".csx-ai-sides").children).map((e) => e.getBoundingClientRect()); return k[1].left > k[0].left + 50 && Math.abs(k[1].top - k[0].top) < 4; });
  assert.equal(side, true);
  await H.closePage(page);
});

for (const scheme of ["light", "dark"]) {
  test("colours (" + scheme + "): body text, added and removed text, flags, muted text and buttons meet WCAG AA", { skip: H.SKIP }, async () => {
    const page = await page$();
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
    await H.openAi(page);
    env.stub.ai.status = "enabled";
    await H.ask(page, "warm up the hero and change the contact email");
    const pairs = await H.inShadow(page, (r) => {
      const eff = (el) => { let c = el; while (c) { const bg = getComputedStyle(c).backgroundColor; if (bg && !/rgba\(0, 0, 0, 0\)|transparent/.test(bg)) return bg; c = c.parentElement || (c.getRootNode && c.getRootNode().host) || null; if (c && c.id === "covered-studio") break; } return null; };
      const pick = (sel) => r.querySelector(sel);
      const out = {};
      for (const [k, sel] of [["text", ".csx-ai-text"], ["ins", ".csx-ai-ins"], ["del", ".csx-ai-del"], ["flag", ".csx-ai-flag"], ["muted", ".csx-ai .csx-muted"], ["btn", ".csx-ai .csx-btn:not(.csx-btn-quiet)"], ["quiet", ".csx-ai .csx-btn-quiet"], ["mode", ".csx-ai-mode[aria-pressed='true']"], ["heading", ".csx-ai-sidehead"]]) {
        const e = pick(sel);
        if (!e) continue;
        const cs = getComputedStyle(e);
        out[k] = { fg: cs.color, bg: eff(e) || getComputedStyle(r.querySelector(".panel")).backgroundColor };
      }
      return out;
    });
    const parse = (s) => { const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(s); return m ? { r: +m[1], g: +m[2], b: +m[3] } : null; };
    assert.ok(Object.keys(pairs).length >= 8, "measured " + Object.keys(pairs).join(","));
    for (const [k, v] of Object.entries(pairs)) {
      const fg = parse(v.fg), bg = parse(v.bg);
      assert.ok(fg && bg, k + " colours readable");
      const ratio = CC.ratio(CC.parseColor("rgb(" + fg.r + "," + fg.g + "," + fg.b + ")") || fg, CC.parseColor("rgb(" + bg.r + "," + bg.g + "," + bg.b + ")") || bg);
      assert.ok(ratio >= 4.5, scheme + " " + k + ": " + ratio.toFixed(2) + ":1 (" + v.fg + " on " + v.bg + ")");
    }
    await H.closePage(page);
  });
}

test("closing the panel while a suggestion is on screen, and reopening, starts clean; Escape closes without errors", { skip: H.SKIP }, async () => {
  const page = await page$();
  await H.openAi(page);
  await H.ask(page, "make the hero shorter and warmer");
  await page.keyboard.press("Escape");
  await H.click(page, "Describe a change", { exact: true });
  await H.waitShadow(page, (r) => r.querySelector(".csx-ai [data-phase='idle']"));
  assert.deepEqual(page.__errors, []);
  await H.closePage(page);
});
