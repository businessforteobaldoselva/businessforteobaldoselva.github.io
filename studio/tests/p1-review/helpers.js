"use strict";
// Shared by the REVIEW tests: a real API in memory (handler + mock Git + dev auth) with a reviewer list, and small flows.
const { makeApi, patch, heroOp, uuid } = require("../fixtures/harness");

const REVIEWERS = [
  { id: "amelia", name: "Amelia", github: "ameliagh", role: "approver" },
  { id: "teo", name: "Teo", github: null, role: "admin" },
];

function api(extra) {
  const o = Object.assign({}, extra || {});
  o.env = Object.assign({ STUDIO_REVIEWERS: JSON.stringify(REVIEWERS), STUDIO_SITE_URL: "https://www.example.org" }, o.env || {});
  const a = makeApi(o);
  a.repo.clock = () => a.deps.now(); // one clock: pull request times follow a.advance()
  return a;
}

async function draftBy(a, who, ops, title) {
  const r = await a.call(who || "editor", "POST", "/v1/drafts", patch(a, ops || [heroOp("Review me")], { title: title || "Review me" }));
  if (r.status !== 201) throw new Error("draft failed " + r.status + " " + r.text);
  return r.json.draft;
}
async function submit(a, who, d, reviewerId) {
  const body = { idempotencyKey: uuid() };
  if (reviewerId !== undefined) body.reviewerId = reviewerId;
  return a.call(who || "editor", "POST", "/v1/drafts/" + d.id + "/submit", body);
}
const publish = (a, who, d, sha) => a.call(who, "POST", "/v1/drafts/" + d.id + "/publish", { expectedHeadSha: sha || d.headSha, idempotencyKey: uuid() });

// a git wrapper that gives the mock the requestReviewers method BACKEND adds to the real providers
function withReviewers(git, behaviour) {
  const calls = [];
  const wrapped = Object.create(git);
  wrapped.requestReviewers = async (n, logins) => {
    calls.push({ n, logins: logins.slice() });
    if (behaviour) await behaviour(n, logins);
    return { requested: logins };
  };
  wrapped.calls = calls;
  return wrapped;
}

module.exports = { api, draftBy, submit, publish, withReviewers, REVIEWERS, patch, heroOp, uuid };
