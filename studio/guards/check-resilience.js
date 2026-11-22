#!/usr/bin/env node
"use strict";
// check-resilience (PHASE1-DESIGN 15, unit BACKEND): the health route, the usage store and the label fallback do what the design says.
//   node studio/guards/check-resilience.js [--root <repo>]
//
//   R1  the health route and service take no network path except deps.fetch / deps.git, and the route is anonymous, rate-classed, read-only
//   R2  studio/sql/003_studio_ai_usage.sql: every function is security definer with a pinned search path and the active-person check,
//       both tables have row level security and NO policy, nothing is granted to anon, no text columns for personal data
//   R3  the budget store has the seven methods in BOTH implementations; the memory one counts like the design says (a rejected answer
//       gives the REQUEST back and keeps the real tokens)
//   R4  the old in-memory per-user Map and the synchronous budget calls are gone from ai/index.js
//   R5  every setting api/config.js reads (STUDIO_*) is named in docs/STUDIO-RUNBOOK.md
//   R6  health never repeats what upstream said (an address, a key, an error text) and says the fixed sentences
//   R7  a failing label write does NOT fail creating a pull request (the real GitHub provider over the mock GitHub server)
//   R8  the handler turns "the sign-in service is down" into 503 service_unavailable, not a 401 and not a 500
//   R9  a failing shared store degrades to memory with the caps still applied (never "unlimited"), and no service-role key exists in api/
//   R10 a rejected AI proposal does not count as a request but its tokens stay counted

const fs = require("fs");
const path = require("path");

const argv = process.argv.slice(2);
const ri = argv.indexOf("--root");
const ROOT = path.resolve(ri >= 0 ? argv[ri + 1] : path.join(__dirname, "..", ".."));
const rq = (p) => require(path.join(ROOT, p));
const problems = [];
const fail = (rule, msg) => problems.push(rule + " " + msg);
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const exists = (p) => fs.existsSync(path.join(ROOT, p));
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");

// ---- R2: the SQL, as text. Exported so the unit test and the guard apply the SAME rules --------------------------------------------
const FUNCTIONS = ["studio_ai_reserve2", "studio_ai_settle2", "studio_ai_release2", "studio_ai_snapshot2", "studio_ai_record", "studio_ai_attach", "studio_ai_recent"];
function checkSql(sql) {
  const out = [];
  if (!/^-- REVIEW BEFORE APPLYING/.test(sql)) out.push("the file must start with the human-review header");
  const bodies = [...sql.matchAll(/create or replace function public\.(\w+)\(([^)]*)\)([\s\S]*?)\n\$\$;/gi)];
  const names = bodies.map((m) => m[1]);
  for (const f of FUNCTIONS) if (names.indexOf(f) < 0) out.push("function " + f + " is missing");
  for (const n of names) if (FUNCTIONS.indexOf(n) < 0) out.push("unexpected function " + n);
  for (const m of bodies) {
    const [, name, , body] = m;
    if (!/security definer/i.test(body)) out.push(name + " is not security definer");
    if (!/set search_path = public/i.test(body)) out.push(name + " does not pin its search_path");
    if (!/auth\.uid\(\)/.test(body) || !/studio_roles r where r\.user_id = caller and r\.active/.test(body)) out.push(name + " does not check the caller is an active person");
    if (!new RegExp("revoke all on function public\\." + name + "\\([^)]*\\) from public, anon;", "i").test(sql)) out.push(name + " is not revoked from anon");
    if (!new RegExp("grant execute on function public\\." + name + "\\([^)]*\\) to authenticated;", "i").test(sql)) out.push(name + " is not granted to signed-in people");
  }
  for (const t of ["studio_ai_user_usage", "studio_ai_requests", "studio_ai_limits"]) {
    if (!new RegExp("alter table public\\." + t + " enable row level security", "i").test(sql)) out.push("row level security is not enabled on " + t);
    if (!new RegExp("revoke all on public\\." + t + " from anon, authenticated", "i").test(sql)) out.push(t + " is not closed to direct access");
  }
  // the caller must never decide the limits or the amounts: caps are clamped by the owner's row, settle / release act on a pending reservation
  const fnBody = (n) => { const m = new RegExp("create or replace function public\\." + n + "\\([^)]*\\)[\\s\\S]*?\\n\\$\\$;", "i").exec(sql); return m ? m[0] : ""; };
  const reserve = fnBody("studio_ai_reserve2");
  if (!/least\(p_max_requests, lim\.max_requests\)/.test(reserve) || !/least\(p_max_tokens, lim\.max_tokens\)/.test(reserve) || !/least\(p_user_max_requests, lim\.user_max_requests\)/.test(reserve) || !/v_tokens <= lim\.max_reservation/.test(reserve)) out.push("reserve2 must clamp every caller-supplied cap and amount to the studio_ai_limits row");
  if (/<=\s*p_max_|<=\s*p_user_max_/.test(reserve)) out.push("reserve2 compares against a caller-supplied cap directly");
  for (const n of ["studio_ai_settle2", "studio_ai_release2"]) if (!/pending_requests < 1 then return/.test(fnBody(n)) || !/least\([^;]*pending_tokens\)/.test(fnBody(n))) out.push(n + " must only undo what the caller reserved (pending_requests / pending_tokens)");
  if (/create policy/i.test(sql)) out.push("a policy exists: the tables must be reachable only through the functions");
  if (/grant\s[^;]*\sto\s[^;]*\banon\b/i.test(sql)) out.push("something is granted to anon");
  if (/grant\s[^;]*\sto\s[^;]*\bpublic\b/i.test(sql)) out.push("something is granted to public");
  if (/drop\s+(table|function)/i.test(sql)) out.push("the file drops something");
  const tables = (sql.match(/create table if not exists[\s\S]*?\);/gi) || []).join("\n");
  const col = /^\s+(instruction|prompt|content|body|email|name|text_value)\b/im.exec(tables);
  if (col) out.push("a column that could hold personal text: " + col[1]);
  return out;
}

function staticRules() {
  // R1
  for (const f of ["studio/api/services/health.js", "studio/api/routes/health.js"]) {
    const src = code(read(f));
    if (/(^|[^\w.])fetch\b/.test(src)) fail("R1", f + " calls fetch directly; the only network path is deps.fetch");
    if (/\brequire\(\s*["'](?:node:)?(?:http|https|net|dns|fs|child_process)["']\s*\)/.test(src)) fail("R1", f + " requires a network or file module");
    if (/\bprocess\.env\b/.test(src)) fail("R1", f + " reads process.env");
    if (/\bdeps\.git\.(createBranch|commitFiles|resetBranch|openPr|updatePr|markReady|closePr|deleteBranch|merge|requestReviewers)\b/.test(src)) fail("R1", f + " writes to Git");
  }
  const route = code(read("studio/api/routes/health.js"));
  if (!/path: "\/v1\/health"/.test(route) || !/anon: true/.test(route) || !/cls: "anon"/.test(route) || /minRole/.test(route)) fail("R1", "GET /v1/health must be anonymous with the anon rate class and no role");
  if (/audit\.write|audit\(/.test(route + code(read("studio/api/services/health.js")))) fail("R1", "health must not write an audit entry per call (it is polled)");
  // R2
  if (!exists("studio/sql/003_studio_ai_usage.sql")) fail("R2", "studio/sql/003_studio_ai_usage.sql is missing");
  else for (const p of checkSql(read("studio/sql/003_studio_ai_usage.sql"))) fail("R2", p);
  if (exists("studio/sql/002_studio_ai.sql") && /studio_ai_reserve2|studio_ai_user_usage/.test(read("studio/sql/002_studio_ai.sql"))) fail("R2", "002 must stay untouched");
  // R4
  const idx = code(read("studio/api/ai/index.js"));
  if (/usageToday/.test(idx)) fail("R4", "ai/index.js still has the in-memory usageToday Map; per-user limits come from the store");
  if (/(^|[^\w.])budget\.(reserve|settle|release|snapshot)\(/.test(idx.replace(/await budget\./g, ""))) fail("R4", "ai/index.js calls the budget without await (the store is async)");
  // R5
  const runbook = exists("docs/STUDIO-RUNBOOK.md") ? read("docs/STUDIO-RUNBOOK.md") : "";
  const seen = new Set();
  for (const f of ["studio/api/config.js", "studio/api/ai/config.js"]) for (const m of read(f).matchAll(/\b(STUDIO_[A-Z0-9_]+)\b/g)) seen.add(m[1]);
  for (const v of ["STUDIO_AI_BUDGET_STORE", "STUDIO_HEALTH_TTL_SECONDS", "STUDIO_HEALTH_TIMEOUT_MS"]) if (!seen.has(v)) fail("R5", "config.js no longer reads " + v);
  for (const v of seen) if (!runbook.includes(v)) fail("R5", "docs/STUDIO-RUNBOOK.md does not mention " + v + ", which api/config.js reads");
  // R9 (static half): the API never holds a service-role key
  for (const f of ["studio/api/config.js", "studio/api/providers/usage/supabase-budget.js", "studio/api/providers/roles/supabase.js"]) if (/service[_-]?role/i.test(code(read(f)))) fail("R9", f + " names a service-role key; the API must work with the caller's own token only");
}

async function dynamicRules() {
  const budget = rq("studio/api/ai/budget");
  const { createSupabaseBudget } = rq("studio/api/providers/usage/supabase-budget");
  const { createFakePostgrest } = rq("studio/tests/p1-backend/fake-postgrest");
  // R3
  const METHODS = ["reserve", "settle", "release", "snapshot", "recordRequest", "attachAccept", "recent"];
  const lim = { dailyRequests: 5, dailyTokens: 10000, userPerDay: 3 };
  const mem = budget.createMemoryBudget(lim);
  const fake = createFakePostgrest();
  const sb = createSupabaseBudget({ deps: { config: { supabase: { url: "https://x.supabase.co", anonKey: "k" } }, fetch: fake.fetch }, token: "tok-molly", limits: lim });
  for (const [name, s] of [["memory", mem], ["supabase", sb]]) for (const m of METHODS) if (typeof s[m] !== "function") fail("R3", "the " + name + " budget store has no " + m + "()");
  const caps = { requests: 5, tokens: 10000, userRequests: 3 };
  for (const [name, s] of [["memory", mem], ["supabase", sb]]) {
    await s.reserve({ day: "d", tokens: 1000, userId: "u", caps });
    await s.settle({ day: "d", reserved: 1000, actual: 400, userId: "u", countRequest: false });
    const snap = await s.snapshot({ day: "d", userId: "u" });
    if (snap.global.requests !== 0 || snap.global.tokens !== 400) fail("R3", "the " + name + " store must give a rejected answer's REQUEST back and keep its real tokens (requests 0, tokens 400), got " + snap.global.requests + " and " + snap.global.tokens);
  }
  // R9 (dynamic half): a dead shared store is replaced by memory and the caps still apply
  {
    const dead = createFakePostgrest();
    dead.fail = "500";
    const down = createSupabaseBudget({ deps: { config: { supabase: { url: "https://x.supabase.co", anonKey: "k" } }, fetch: dead.fetch }, token: "tok-molly", limits: lim });
    const m2 = budget.createMemoryBudget(lim);
    const logs = [];
    let ok = 0;
    const shared = {};
    for (let i = 0; i < 6; i += 1) {
      const st = budget.selectStore({ memory: m2, supabase: down, shared, now: () => new Date(0), log: (x) => logs.push(x) });
      if ((await st.reserve({ day: "d", tokens: 10, userId: "u", caps })).ok) ok += 1;
    }
    if (ok !== 3) fail("R9", "with the shared store down, the person's cap of 3 let " + ok + " requests through (it must degrade to the memory caps, not to unlimited)");
    if (logs.length !== 1) fail("R9", "a failing shared store must be logged once per minute, not " + logs.length + " times");
  }

  const harness = rq("studio/tests/fixtures/harness");
  const uuid = () => require("crypto").randomUUID();
  // R6 + R8 + R10 through the real handler
  const { createHealth } = rq("studio/api/services/health");
  const SECRET = ["https://secret-ref.supabase.co", "sk-secret-key", "ghs_secret", "ECONNREFUSED"];
  const clock = Date.parse("2026-11-22T10:00:00Z");
  const deps = {
    config: { dev: false, supabase: { url: SECRET[0], anonKey: SECRET[1] }, health: { ttlSeconds: 30, timeoutMs: 500 } }, now: () => new Date(clock), perfNow: () => 0,
    fetch: async () => { throw new Error("connect " + SECRET[3] + " " + SECRET[0] + " " + SECRET[1]); },
    git: { getBaseBranch: () => "main", getHead: async () => { throw new Error(SECRET[2]); } },
    ai: { health: async () => ({ state: "ready", store: "memory", message: null }) },
  };
  const h = await createHealth(deps).check();
  const text = JSON.stringify(h);
  for (const s of SECRET) if (text.includes(s)) fail("R6", "the health answer repeats upstream text (" + s + ")");
  if (h.ok !== false || h.services.auth.state !== "unreachable" || h.services.git.state !== "unreachable") fail("R6", "unreachable services were not reported as unreachable");
  if (!/Studio cannot reach its sign-in service right now\. Your edits on this page are safe\. Try again in a minute\./.test(h.message || "")) fail("R6", "the sign-in message is not the agreed sentence");
  const hp = await createHealth(Object.assign({}, deps, { fetch: async () => ({ status: 540, text: async () => "" }) })).check();
  if (hp.services.auth.state !== "paused" || !/Restore project/.test(hp.message || "")) fail("R6", "a paused project (HTTP 540) is not reported as paused with the way to wake it");

  {
    const { AuthError } = rq("studio/api/providers/auth/interface");
    const api = harness.makeApi({ depsOverrides: { auth: { async verify() { throw new AuthError("keys_unavailable", "x"); } } } });
    const r = await api.call("some-token-value-that-is-long-enough", "GET", "/v1/me");
    if (r.status !== 503 || !r.json || r.json.error.code !== "service_unavailable") fail("R8", "the sign-in service being down must be 503 service_unavailable, got " + r.status + " " + (r.json && r.json.error && r.json.error.code));
    const api2 = harness.makeApi({ roles: { async getRole() { throw new Error("down"); }, async listPeople() { return []; }, async upsertPerson() { return null; } } });
    const r2 = await api2.call("editor", "GET", "/v1/me");
    if (r2.status !== 503 || r2.json.error.details.service !== "auth") fail("R8", "the people list being down must be 503 service_unavailable with details.service 'auth'");
  }

  {
    const { AI_ENV, replayApi, rec, patchOf, ch, rep, HERO } = rq("studio/tests/ai/helpers");
    const api = await replayApi({ mode: "edit", instruction: "make it bold" }, rec(patchOf("s", ch("Bold", rep(HERO, "/badge", "<b>bold</b>"))), { usage: { inTok: 1000, outTok: 100 } }));
    const r = await api.call("editor", "POST", "/v1/ai/propose", { idempotencyKey: uuid(), mode: "edit", instruction: "make it bold", context: { refs: [] } });
    const s = (await api.deps.ai._budget.snapshot({ day: api.deps.now().toISOString().slice(0, 10), userId: "" })).global;
    if (r.status !== 502) fail("R10", "the markup answer should have been rejected (502), got " + r.status);
    else if (s.requests !== 0 || s.tokens !== 1100) fail("R10", "a rejected proposal must give the request back and keep the 1100 real tokens, got " + s.requests + " request(s) and " + s.tokens + " tokens");
    if (!(r.json && r.json.error && r.json.error.details && r.json.error.details.meter && r.json.error.details.meter.counted === false)) fail("R10", "a rejected proposal's error must carry meter.counted = false");
    void AI_ENV;
  }

  // R7: the real GitHub provider over the mock GitHub server, label writes refused
  {
    const { githubProvider } = rq("studio/tests/fixtures/providers");
    const p = await githubProvider();
    try {
      p.server.state.failLabels = 403;
      const main = (await p.git.getHead("main")).sha;
      await p.git.createBranch("studio/uabcdefg/guard", main);
      await p.git.commitFiles({ branch: "studio/uabcdefg/guard", expectedHeadSha: main, message: "m", files: [{ path: "src/_data/hero.json", text: "{}\n" }] });
      const marker = '<!-- studio:v1 {"authorId":"11111111-2222-4333-8444-555555555555","authorName":"M","draftId":"uabcdefg--guard","ops":1,"revertOf":null} -->';
      let pr = null;
      try { pr = await p.git.openPr({ head: "studio/uabcdefg/guard", base: "main", title: "t", body: marker, labels: ["studio-draft"], draft: true }); } catch (e) { fail("R7", "opening a pull request failed when the label write was refused (" + e.message + ")"); }
      if (pr && pr.labelsApplied !== false) fail("R7", "a pull request whose labels could not be written must say labelsApplied=false");
      if (pr) { await p.git.markReady(pr.number); try { await p.git.merge(pr.number, { method: "squash", sha: pr.headSha }); } catch (e) { fail("R7", "a Studio draft without labels (marker present) could not be merged: " + e.message); } }
    } finally { await p.close(); }
  }
}

async function main() {
  try { staticRules(); } catch (e) { fail("R0", "the static rules crashed: " + (e && e.message)); }
  try { await dynamicRules(); } catch (e) { fail("R0", "the dynamic rules crashed: " + (e && e.stack ? e.stack.split("\n").slice(0, 4).join(" | ") : e)); }
  if (problems.length) {
    console.error("check-resilience: " + problems.length + " problem(s)");
    for (const p of problems) console.error("  - " + p);
    process.exitCode = 1;
    return;
  }
  console.log("check-resilience: OK (health, usage SQL, usage store, label fallback, service_unavailable)");
}

module.exports = { checkSql, FUNCTIONS };
if (require.main === module) main();
