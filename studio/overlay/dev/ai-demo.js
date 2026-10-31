"use strict";
// Deterministic "Describe a change" demo and test double (studio/AI-DESIGN.md 5, 6, 14).
//
// This is NOT the real service (that is studio/api/ai, built by the CORE unit, and it needs no key in the replay mode of
// `npm run studio:dev`). It speaks the same three routes with the same shapes, so the overlay panel can be driven in a
// browser and in tests without a key, a network or a model:
//   GET  /v1/ai/status
//   POST /v1/ai/propose   instruction keywords pick a canned scenario; the BEFORE side and `expect` come from the stub's
//                         real documents, the AFTER side is canned. Nothing is written.
//   POST /v1/ai/accept    re-checks the selection against the proposal's `requires`, then saves a draft through the same
//                         code path as a hand-made patch (the stub's commitDraft).
// Test hooks on the returned object: status ("enabled"|"disabled"|"no_key"|"budget_exhausted"), next (a Proposal to return
// once, or { error: { status, code, message, details } }), delayMs, calls (every request), reset().
const crypto = require("crypto");

const ALLOWED_PROPOSE = new Set(["idempotencyKey", "mode", "instruction", "context", "draftId", "retryOf", "feedback"]);
const ALLOWED_CONTEXT = new Set(["refs", "page", "scope"]);
const ALLOWED_ACCEPT = new Set(["idempotencyKey", "proposal", "accept", "title"]);
const ALLOWED_PROPOSAL = new Set(["id", "instructionHash", "instructionPreview", "base", "model", "changes"]);
const MODES = ["edit", "alt_text", "meta_description", "tone_check"];
const SHA = "3f9c2a7be0d44aa1c5e6f7081928374655647382";

function textDiff(a, b) {
  const ta = a.split(/(\s+)/).filter(Boolean);
  const tb = b.split(/(\s+)/).filter(Boolean);
  const m = ta.length, n = tb.length;
  const L = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) L[i][j] = ta[i] === tb[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const segs = [];
  const push = (t, s) => { const last = segs[segs.length - 1]; if (last && last.t === t) last.s += s; else segs.push({ t, s }); };
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (ta[i] === tb[j]) { push("same", ta[i]); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) { push("del", ta[i]); i++; }
    else { push("ins", tb[j]); j++; }
  }
  while (i < m) push("del", ta[i++]);
  while (j < n) push("ins", tb[j++]);
  return segs;
}

function createAiDemo(env) {
  env = env || {};
  const demo = { status: "enabled", next: null, delayMs: 0, calls: [], proposals: new Map(), accepted: [], model: "claude-sonnet-5-5" };
  demo.reset = () => { demo.status = "enabled"; demo.next = null; demo.delayMs = 0; demo.calls.length = 0; demo.proposals.clear(); demo.accepted.length = 0; };

  const get = (docs, file, ptr) => {
    let cur = docs[file];
    if (ptr === "") return cur;
    for (const raw of ptr.slice(1).split("/")) {
      const k = raw.replace(/~1/g, "/").replace(/~0/g, "~");
      if (cur === null || typeof cur !== "object" || !(k in cur)) return undefined;
      cur = cur[k];
    }
    return cur;
  };
  const refOf = (file, ptr) => {
    const m = /^src\/(?:_data\/([a-z0-9-]+)\.json|pages\/([a-z0-9-]+)\.md)$/.exec(file);
    if (!m || ptr.indexOf("-") >= 0 && /\/-$/.test(ptr)) return null;
    return (m[1] || "pages:" + m[2]) + "." + ptr.slice(1).split("/").join(".");
  };
  const text = (t) => ({ type: "text", text: String(t).slice(0, 2000), truncated: String(t).length > 2000 });

  // ---- scenario builders: each returns { kind, summary, changes: [{ title, ops, label, kindOf, flags }] ... }
  function replace(docs, file, ptr, value, label, kind, extra) {
    return Object.assign({ op: { op: "replace", file, path: ptr, value, expect: get(docs, file, ptr) }, label, kind }, extra || {});
  }
  function change(title, items, flags) {
    return Object.assign({ title, items: Array.isArray(items) ? items : [items], requires: [], outsideAsk: false, sensitive: false }, flags || {});
  }

  function scenario(req, docs) {
    const ins = String(req.instruction || "").toLowerCase();
    const refs = (req.context && req.context.refs) || [];
    if (req.mode === "alt_text") {
      const only = refs.length && /^how\.story\.(\d)/.exec(refs[0]);
      const idx = only ? [Number(only[1])] : [0, 2];
      return { kind: "patch", summary: "Picture descriptions for " + idx.length + (idx.length === 1 ? " picture." : " pictures."), changes: idx.map((i) => change("Describe picture " + (i + 1), replace(docs, "src/_data/how.json", "/story/" + i + "/alt", ["A wall-mounted dispenser with free period products in a bright toilet cubicle", "A phone showing a short advert", "A smiling student taking a free pad from a dispenser"][i] || "A COVERED dispenser", "How it works > Step " + (i + 1) + " > Picture description", "text"))) };
    }
    if (req.mode === "meta_description") {
      return { kind: "patch", summary: "A meta description for the home page.", changes: [change("New meta description", replace(docs, "src/_data/site.json", "/metaDescription", "COVERED puts free period products in venues across the UK, paid for by brands, so nobody has to go without.", "Site > Meta description", "longtext"))] };
    }
    if (req.mode === "tone_check") {
      const sub = get(docs, "src/_data/hero.json", "/subhead");
      const fixed = change("Warmer sub-heading", replace(docs, "src/_data/hero.json", "/subhead", "Free period products for everyone, paid for by brands who care.", "Hero > Sub-heading", "longtext"));
      return { kind: "tone", overall: "mostly", summary: "Mostly warm, one line reads like an advert.", changes: [fixed],
        findings: [{ ref: "hero.subhead", label: "Hero > Sub-heading", quote: typeof sub === "string" ? sub.slice(0, 60) : "", issue: "Sounds like a product description.", suggestion: "Lead with the person, not the product.", fix: 0 }] };
    }
    if (/\b(email|contact|e-mail)\b/.test(ins)) {
      const c1 = change("Friendlier headline", replace(docs, "src/_data/hero.json", "/headlineMain", "We are covering the UK,", "Hero > Headline - main part", "text"));
      const c2 = change("New contact email", replace(docs, "src/_data/site.json", "/contactEmail", "hello@elsewhere.test", "Site > Contact email", "text"), { outsideAsk: true, sensitive: true });
      return { kind: "patch", summary: "Warmer headline, and a new contact address.", changes: [c1, c2], warnings: [{ code: "injection_suspected", message: "Some page text reads like an instruction to the AI. Look at every change carefully.", refs: ["faq.items.0.a"] }] };
    }
    if (/\bfaq\b.*\b(add|new|question)\b|\b(add|new)\b.*\bfaq\b/.test(ins)) {
      const n = (docs["src/_data/faq.json"].items || []).length;
      const add = { op: { op: "add", file: "src/_data/faq.json", path: "/items/-", value: { q: "Can I get a dispenser for my venue?", a: "Yes. Tell us about your venue." } }, label: "FAQ > Questions > Question " + (n + 1), kind: "list", fields: [["Question", "Can I get a dispenser for my venue?"], ["Answer", "Yes. Tell us about your venue."]] };
      const c1 = change("Add the question", add);
      const c2 = change("Say how fast we reply", { op: { op: "replace", file: "src/_data/faq.json", path: "/items/" + n + "/a", value: "Yes. Tell us about your venue and we will reply within two working days.", expect: "Yes. Tell us about your venue." }, label: "FAQ > Questions > Question " + (n + 1) + " > Answer", kind: "longtext", before: "Yes. Tell us about your venue." }, { requires: ["c1"] });
      return { kind: "patch", summary: "Add a venue question to the FAQ.", changes: [c1, c2] };
    }
    if (/translate|welsh|cymraeg/.test(ins)) {
      const items = docs["src/_data/faq.json"].items || [];
      const cy = [["A yw'n rhad ac am ddim?", "Ydy, bob amser."], ["Pwy sy'n talu?", "Brandiau."]];
      const changes = items.slice(0, 2).map((it, i) => change("Question " + (i + 1) + " in Welsh", [
        replace(docs, "src/_data/faq.json", "/items/" + i + "/q", cy[i][0], "FAQ > Question " + (i + 1) + " > Question", "text"),
        replace(docs, "src/_data/faq.json", "/items/" + i + "/a", cy[i][1], "FAQ > Question " + (i + 1) + " > Answer", "longtext")]));
      return { kind: "patch", summary: "The FAQ in Welsh.", changes };
    }
    if (/\b(code|font|autoplay|parallax|animation|new page|press page|deploy)\b/.test(ins)) {
      return { kind: "needs_code", summary: "That needs a change to the site's code.", reason: "The hero video is set up in the page template, which Studio cannot change.", request: { title: "Make the hero video autoplay with a parallax effect", body: "Please make the hero video start by itself, muted, with a gentle parallax scroll. Keep it off for people who prefer reduced motion.", where: "Hero", priority: "This week" } };
    }
    if (/^(make it better|better|improve|help|\?)\.?$/.test(ins.trim()) || ins.trim().length < 6) {
      return { kind: "clarify", summary: "I need one detail.", question: "Which part of the page would you like me to improve?" };
    }
    if (/\bnothing\b|\bempty\b|\bsame\b/.test(ins)) return { kind: "patch", summary: "No changes were needed.", changes: [] };
    const main = replace(docs, "src/_data/hero.json", "/headlineMain", "We cover the UK,", "Hero > Headline - main part", "text");
    const accent = replace(docs, "src/_data/hero.json", "/headlineAccent", "one friendly venue at a time", "Hero > Headline - second part", "text");
    const sub = replace(docs, "src/_data/hero.json", "/subhead", "Free period products, paid for by brands.", "Hero > Sub-heading", "longtext");
    return { kind: "patch", summary: "Shorter, friendlier hero.", changes: [change("Shorter headline", main), change("Warmer second line", accent), change("Tighter sub-heading", sub)] };
  }

  function build(req, docs, sc) {
    const ih = crypto.createHash("sha256").update(["demo", req.mode, req.instruction || "", req.feedback || ""].join("|")).digest("hex").slice(0, 16);
    const changes = (sc.changes || []).map((c, i) => {
      const ops = [];
      const deltas = c.items.map((it) => {
        ops.push(it.op);
        const op = it.op;
        const before = op.op === "add" ? null : text(get(docs, op.file, op.path) === undefined ? (it.before || "") : get(docs, op.file, op.path));
        const after = it.fields ? { type: "fields", fields: it.fields.map(([label, t]) => ({ label, text: t })) } : text(op.value);
        const diff = op.op === "replace" && before && after.type === "text" ? textDiff(before.text, after.text) : null;
        return { file: op.file, path: op.path, ref: refOf(op.file, op.path), op: op.op, kind: it.kind, label: it.label, before, after, diff };
      });
      return { id: "c" + (i + 1), title: c.title, ops, deltas, requires: c.requires, outsideAsk: !!c.outsideAsk, sensitive: !!c.sensitive, defaultChecked: !c.outsideAsk && !c.sensitive };
    });
    const findings = (sc.findings || []).map((f, i) => ({ id: "f" + (i + 1), ref: f.ref, label: f.label, quote: f.quote, issue: f.issue, suggestion: f.suggestion, changeId: f.fix == null ? null : "c" + (f.fix + 1) }));
    const id = "p_" + crypto.createHash("sha256").update(ih + JSON.stringify(changes.map((c) => c.ops))).digest("hex").slice(0, 12).replace(/[^a-z0-9]/g, "a");
    const p = {
      id, kind: sc.kind, mode: req.mode, summary: sc.summary, base: { sha: SHA, draftId: req.draftId || null, headSha: null }, instructionHash: ih, model: demo.model, provider: "replay",
      changes: sc.kind === "patch" || sc.kind === "tone" ? changes : [], skipped: sc.skipped || [], needsCode: sc.kind === "needs_code" ? { reason: sc.reason, request: sc.request } : null,
      question: sc.kind === "clarify" ? sc.question : null, findings, warnings: sc.warnings || [], usage: { inTok: 12000, outTok: 400, latencyMs: 40 },
    };
    if (sc.overall) p.overall = sc.overall;
    return p;
  }

  const bad = (status, code, message, details) => ({ status, body: { error: { code, message, details: details || null }, requestId: crypto.randomUUID() } });
  const strict = (obj, allowed) => Object.keys(obj).filter((k) => !allowed.has(k));

  // ctx: { method, pathname, user, readJson(), docs(), commit(body) }
  async function handle(ctx) {
    if (!/^\/v1\/ai\//.test(ctx.pathname)) return null;
    demo.calls.push({ method: ctx.method, path: ctx.pathname });
    if (demo.delayMs) await new Promise((r) => setTimeout(r, demo.delayMs));
    if (ctx.pathname === "/v1/ai/status" && ctx.method === "GET") {
      const on = demo.status === "enabled";
      return { status: 200, body: { enabled: on, reason: on ? null : demo.status, provider: on ? "replay" : "none", model: on ? demo.model : null, vision: false, modes: MODES, limits: { instructionChars: 1000, feedbackChars: 300, contextRefs: 5, maxChanges: 40 },
        usage: { requestsToday: 3, requestsLimit: 150, yourRequestsToday: 1, yourRequestsLimit: 60, resetsAt: new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() + 1)).toISOString() } } };
    }
    if (ctx.method !== "POST") return bad(404, "not_found", "No such route.");
    let body;
    try { body = await ctx.readJson(); } catch (e) { return bad(400, "bad_request", "Not JSON."); }
    if (demo.status === "disabled" || demo.status === "no_key") return bad(503, "ai_disabled", "AI help is switched off.");
    if (demo.status === "budget_exhausted") return bad(429, "ai_budget_exhausted", "Today's allowance is used.", { resetsAt: new Date().toISOString() });
    if (!body || typeof body !== "object" || Array.isArray(body)) return bad(400, "bad_request", "Body must be an object.");
    demo.calls[demo.calls.length - 1].body = body;

    if (ctx.pathname === "/v1/ai/propose") {
      const extra = strict(body, ALLOWED_PROPOSE);
      if (extra.length) return bad(400, "bad_request", "Unknown field " + extra[0]);
      if (body.context && typeof body.context === "object") { const e2 = strict(body.context, ALLOWED_CONTEXT); if (e2.length) return bad(400, "bad_request", "Unknown context field " + e2[0]); }
      if (!/^[0-9a-f-]{36}$/.test(body.idempotencyKey || "")) return bad(400, "bad_request", "idempotencyKey required.");
      if (MODES.indexOf(body.mode) < 0) return bad(400, "bad_request", "Unknown mode.");
      if (body.mode === "edit" && (typeof body.instruction !== "string" || !body.instruction.trim())) return bad(400, "bad_request", "instruction required.");
      if (typeof body.instruction === "string" && body.instruction.length > 1000) return bad(400, "bad_request", "instruction too long.");
      if (typeof body.feedback === "string" && body.feedback.length > 300) return bad(400, "bad_request", "feedback too long.");
      if (demo.next) {
        const n = demo.next; demo.next = null;
        if (n.error) return bad(n.error.status || 502, n.error.code || "ai_unavailable", n.error.message || "Failed.", n.error.details);
        demo.proposals.set(n.id, n);
        return { status: 200, body: { proposal: n } };
      }
      const req = Object.assign({}, body);
      if (body.retryOf && body.feedback) req.instruction = String(body.instruction || "") + " " + body.feedback;
      const p = build(req, ctx.docs(), scenario(req, ctx.docs()));
      demo.proposals.set(p.id, p);
      return { status: 200, body: { proposal: p } };
    }

    if (ctx.pathname === "/v1/ai/accept") {
      const extra = strict(body, ALLOWED_ACCEPT);
      if (extra.length) return bad(400, "bad_request", "Unknown field " + extra[0]);
      if (!/^[0-9a-f-]{36}$/.test(body.idempotencyKey || "")) return bad(400, "bad_request", "idempotencyKey required.");
      const pr = body.proposal;
      if (!pr || typeof pr !== "object" || strict(pr, ALLOWED_PROPOSAL).length) return bad(400, "bad_request", "proposal shape.");
      if (!Array.isArray(body.accept) || !body.accept.length) return bad(400, "bad_request", "accept must be a non-empty list.");
      const known = demo.proposals.get(pr.id);
      const byId = new Map((pr.changes || []).map((c) => [c.id, c]));
      for (const id of body.accept) if (!byId.has(id)) return bad(400, "bad_request", "Unknown change " + id);
      for (const id of body.accept) {
        const need = (known && known.changes.find((c) => c.id === id) || { requires: [] }).requires;
        for (const r of need) if (body.accept.indexOf(r) < 0) return bad(422, "validation_failed", "Not closed", { problems: [{ code: "type", path: "/accept", message: "Change " + id.replace(/^c/, "") + " also needs change " + r.replace(/^c/, "") + "." }] });
      }
      const ops = [];
      for (const c of pr.changes) if (body.accept.indexOf(c.id) >= 0) for (const op of c.ops) {
        if (!/^src\/(_data\/[a-z0-9-]+\.json|pages\/[a-z0-9-]+\.md)$/.test(op.file || "")) return bad(422, "validation_failed", "Not allowed", { problems: [{ code: "path_forbidden", file: op.file, path: op.path, message: "That file can't be changed from Studio." }] });
        ops.push(op);
      }
      const out = ctx.commit({ idempotencyKey: body.idempotencyKey, baseSha: pr.base && pr.base.sha, draftId: pr.base && pr.base.draftId || undefined, expectedHeadSha: pr.base && pr.base.headSha || undefined, title: body.title || "Drafted with AI", ops, uploads: [] });
      if (out.status === 200 || out.status === 201) {
        demo.accepted.push({ proposalId: pr.id, accept: body.accept.slice(), total: pr.changes.length });
        out.body = Object.assign({}, out.body, { ai: { proposalId: pr.id, accepted: body.accept.length, total: pr.changes.length } });
      }
      return out;
    }
    return bad(404, "not_found", "No such route.");
  }

  demo.handle = handle;
  return demo;
}

module.exports = { createAiDemo, textDiff };
