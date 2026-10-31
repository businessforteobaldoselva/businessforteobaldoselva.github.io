"use strict";
// Runs the REAL overlay code (core/util, events, dom, ext/ai-view, ext/ai) under node on the test DOM, against a fake of
// the three /v1/ai routes built from studio/tests/fixtures/ai-proposals.sample.json. No browser, no network.
//   const host = createHost(); const panel = host.openPanel(); ... host.q(".csx-ai [data-act='submit']").click(); await host.settle();
const fs = require("fs");
const path = require("path");
const { load } = require("../../overlay/load.js");
const { createDom, ev } = require("./dom-stub.js");

const SAMPLE = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "..", "fixtures", "ai-proposals.sample.json"), "utf8"));
const clone = (x) => JSON.parse(JSON.stringify(x));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function apiError(status, body) {
  const er = body.error || {};
  const e = new Error(er.message || er.code);
  e.name = "StudioError"; e.status = status; e.code = er.code; e.details = er.details || null; e.requestId = body.requestId || null; e.retryAfter = 0;
  return e;
}

// Fake of the three routes. `queue` = scripted answers for the next propose calls: a Proposal, or { error: <sample error body>, status }.
function createFakeApi(opts) {
  opts = opts || {};
  const api = { calls: [], queue: [], statusKey: "enabled", statusFail: false, hold: null, acceptStatus: null, accepts: [] };
  api.get = async function (p) {
    api.calls.push({ method: "GET", path: p });
    if (p !== "/v1/ai/status") throw apiError(404, { error: { code: "not_found", message: "no" } });
    if (api.statusFail) throw apiError(0, { error: { code: "offline", message: "offline" } });
    return clone(SAMPLE.status[api.statusKey]);
  };
  api.post = async function (p, body) {
    api.calls.push({ method: "POST", path: p, body: clone(body) });
    if (api.hold) await api.hold.promise;
    if (p === "/v1/ai/propose") {
      const allowed = ["idempotencyKey", "mode", "instruction", "context", "draftId", "retryOf", "feedback"];
      Object.keys(body).forEach((k) => { if (allowed.indexOf(k) < 0) throw apiError(400, { error: { code: "bad_request", message: "unknown field " + k } }); });
      if (!UUID.test(body.idempotencyKey)) throw apiError(400, { error: { code: "bad_request", message: "key" } });
      const next = api.queue.shift();
      if (next && next.error) throw apiError(next.status || 502, next.error);
      if (next) return { proposal: clone(next) };
      const k = body.mode === "alt_text" ? "alt" : body.mode === "tone_check" ? "tone" : /code|font|video/i.test(body.instruction || "") ? "needs_code" : /venue/i.test(body.instruction || "") ? "clarify" : "patch";
      return { proposal: clone(SAMPLE.proposals[k]) };
    }
    if (p === "/v1/ai/accept") {
      const keys = Object.keys(body).sort().join(",");
      if (keys !== "accept,idempotencyKey,proposal" && keys !== "accept,idempotencyKey,proposal,title") throw apiError(400, { error: { code: "bad_request", message: "accept body keys: " + keys } });
      api.accepts.push(clone(body));
      if (api.acceptStatus) throw apiError(api.acceptStatus.status, api.acceptStatus.body);
      const r = clone(SAMPLE.acceptResponse);
      r.ai = { proposalId: body.proposal.id, accepted: body.accept.length, total: body.proposal.changes.length };
      return r;
    }
    throw apiError(404, { error: { code: "not_found", message: "no" } });
  };
  api.pause = () => { let release; const promise = new Promise((r) => { release = r; }); api.hold = { promise, release }; return () => { const h = api.hold; api.hold = null; h.release(); }; };
  return api;
}

function createHost(options) {
  options = options || {};
  const dom = createDom();
  const document = dom.document;
  const copied = [];
  const S = load(["core/util.js", "core/events.js", "core/dom.js", "ext/ai-view.js", "ext/ai.js"], {
    document, globals: { navigator: { clipboard: { writeText: (t) => { copied.push(t); return Promise.resolve(); } } }, AbortController, Event: function () {} },
    window: { location: { origin: options.origin || "https://page.test", pathname: options.pathname || "/", search: "", hash: "" } },
  });
  const api = options.api || createFakeApi();
  const panels = {};
  const commands = [];
  const toasts = [];
  const opened = [];
  const state = { selection: null, markers: options.markers || {}, selected: [] };
  const me = options.signedOut ? null : { role: options.role || "editor", user: { id: "u1", name: "Molly" } };
  const drafts = { set: [], refreshed: 0, submitted: 0, setCurrent(d) { this.set.push(d); }, refresh() { this.refreshed++; return Promise.resolve(null); }, current() { return options.currentDraft || null; }, submit() { this.submitted++; return Promise.resolve({}); } };
  const studio = {
    version: 1, me, mode: options.mode || "edit", api, previewConfig: options.previewConfig || {}, on: S.events.on, emit: S.events.emit,
    ui: {
      h: S.dom.h, registerPanel: (d) => { panels[d.id] = d; }, registerCommand: (c) => { commands.push(c); },
      openPanel: (id) => { opened.push(id); }, toast: (m, o) => { toasts.push({ message: m, opts: o || {} }); },
    },
    schema: { label: (ref) => "Label for " + ref },
    inspect: { selected: () => (state.selection ? { ref: state.selection } : null), markerForRef: (r) => state.markers[r] || null, select: (m, o) => { state.selected.push({ m, o }); } },
    content: { files: () => options.files || { hero: {}, faq: {}, "pages:about": {} } },
    drafts, util: { uuid: S.util.uuid },
  };
  S._flushReady(studio);

  const host = { S, dom, document, api, studio, panels, commands, toasts, opened, copied, drafts, state, container: null, dispose: null };
  host.openPanel = function () {
    const c = document.createElement("div");
    c.setAttribute("class", "panel-body");
    document.body.appendChild(c);
    host.container = c;
    host.dispose = panels.ai.render(c, studio);
    return c;
  };
  host.close = function () { if (typeof host.dispose === "function") host.dispose(); host.dispose = null; if (host.container && host.container.parentNode) host.container.parentNode.removeChild(host.container); };
  host.q = (sel) => host.container.querySelector(sel);
  host.qa = (sel) => host.container.querySelectorAll(sel);
  host.must = (sel) => { const e = host.q(sel); if (!e) throw new Error("not found: " + sel + "\n--- panel text ---\n" + host.text()); return e; };
  host.text = () => (host.container ? host.container.textContent : "");
  host.type = (sel, value) => { const t = host.must(sel); t.value = value; t.dispatchEvent(ev("input")); return t; };
  host.settle = async (n, ms) => { for (let i = 0; i < (n || 6); i++) await new Promise((r) => setImmediate(r)); await new Promise((r) => setTimeout(r, ms === undefined ? 70 : ms)); };
  host.phase = () => { const e = host.q("[data-phase]"); return e ? e.getAttribute("data-phase") : (host.q("[data-kind]") ? host.q("[data-kind]").getAttribute("data-kind") : null); };
  host.live = () => host.qa("[aria-live]").map((e) => e.textContent).join(" | ");
  host.ask = async (instruction) => { host.type("#csx-ai-instr", instruction); host.must("[data-act='submit']").click(); await host.settle(); };
  return host;
}

module.exports = { createHost, createFakeApi, SAMPLE, clone, apiError, ev };
