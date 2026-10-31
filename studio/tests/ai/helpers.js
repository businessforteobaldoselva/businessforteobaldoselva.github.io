"use strict";
// Shared helpers for the AI tests (not a test file). Everything runs in memory with the replay provider: no network.

const crypto = require("crypto");
const { makeApi } = require("../fixtures/harness");
const A = require("../../api/ai/allowlist");
const ctxMod = require("../../api/ai/context");
const prop = require("../../api/ai/proposal");

const uuid = () => crypto.randomUUID();
const AI_ENV = { STUDIO_AI_ENABLED: "1", STUDIO_AI_PROVIDER: "replay", STUDIO_AI_USER_PER_10MIN: "100", STUDIO_AI_USER_PER_DAY: "1000", STUDIO_AI_GLOBAL_PER_HOUR: "1000" };
const rec = (input, extra) => Object.assign({ toolInputs: [input], usage: { inTok: 1000, outTok: 100 }, stopReason: "tool_use" }, extra || {});
const patchOf = (summary, ...changes) => ({ kind: "patch", summary, changes });
const ch = (title, ...ops) => ({ title, ops });
const rep = (file, path, value) => ({ op: "replace", file, path, value });
const HERO = "src/_data/hero.json";

// an API whose replay provider answers `recorded` to the request (mode, instruction, refs)
async function replayApi(req, recorded, opts) {
  const o = opts || {};
  const key = await prop.replayKey(req.mode || "edit", req.instruction || "", req.feedback || "", (req.context && req.context.refs) || [], !!req.draft, "default");
  const api = makeApi(Object.assign({}, o, { env: Object.assign({}, AI_ENV, o.env || {}), depsOverrides: Object.assign({ aiRecordings: { [key]: recorded } }, o.depsOverrides || {}) }));
  return api;
}
const body = (req, extra) => Object.assign({ idempotencyKey: uuid(), mode: "edit", context: { refs: [] } }, req, extra || {});

async function parseCtx(mode) {
  const api = makeApi();
  const al = A.deriveAllowList(api.deps.schema);
  const docs = await ctxMod.loadDocs(api.deps, api.mainSha(), al);
  const pack = ctxMod.buildPack(al, docs, { mode: mode || "edit", refs: [] });
  return { api, al, docs, ctx: { mode: mode || "edit", allow: al, docs, filesSent: pack.filesSent } };
}

const strip = (p, instruction) => ({ id: p.id, instructionHash: p.instructionHash, instructionPreview: instruction || "x", base: p.base, model: p.model, changes: p.changes.map((c) => ({ id: c.id, title: c.title, ops: c.ops })) });

module.exports = { uuid, AI_ENV, rec, patchOf, ch, rep, HERO, replayApi, body, parseCtx, strip, makeApi };
