"use strict";
// Selftest scenarios of the Phase 1 BACKEND unit (PHASE1-DESIGN 15): break ONE thing in a throwaway copy of the site and require
// check-resilience (or the unit test that guards the CI gate) to fail for the right reason, so no guard is vacuous. A control shows
// the untouched copy passes. Loaded by scripts/selftest.js. Edits use single-line patterns so they work whatever the line ends are.

const fs = require("fs");
const path = require("path");

const REPO = path.resolve(__dirname, "..", "..");

module.exports = (h) => {
  // the copy omits scripts/ and .github/, which the scope rules and the workflow test need: put them back
  const withScripts = (ws) => { if (!fs.existsSync(ws.file("scripts"))) fs.cpSync(path.join(REPO, "scripts"), ws.file("scripts"), { recursive: true }); };
  const withWorkflow = (ws) => { ws.write(".github/workflows/studio-scope.yml", fs.readFileSync(path.join(REPO, ".github", "workflows", "studio-scope.yml"), "utf8")); };
  const guard = (ws) => h.runScript(path.join(ws.dir, "studio", "guards", "check-resilience.js"), ws.dir, []);
  const unit = (ws, files) => { const r = require("child_process").spawnSync(process.execPath, ["--require", path.join(ws.dir, "studio", "guards", "no-network.js"), "--test"].concat(files.map((f) => path.join(ws.dir, f))), { cwd: ws.dir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }); return { code: r.status, out: (r.stdout || "") + (r.stderr || "") }; };
  const API = "studio/api/";
  const rx = (re, to) => (t) => { if (!re.test(t)) throw new Error("selftest anchor not found: " + re); return t.replace(re, to); };
  const once = (a, b) => h.replaceOnce(a, b);

  const broken = (name, edits, has) => ({
    name: "studio p1 backend: " + name,
    build: false,
    mutate(ws) { withScripts(ws); for (const [rel, fn] of edits) h.edit(ws, rel, fn); },
    run(ws) { h.expectRun("check-resilience catches it", guard(ws), { code: 1, has }); },
  });

  // ---- "three ordinary publishes stay green" ---------------------------------------------------------------------------------------------
  // an editor changes a headline, hides a section and rewrites an alt text; the website's own content tests must still pass
  const LIVE_TESTS = ["studio/tests/markers/schema.test.js", "studio/tests/markers/snapshot.test.js", "studio/tests/markers/grammar.test.js", "studio/tests/markers/analyse.test.js", "studio/tests/ai/allowlist.test.js"];
  const threePublishes = (ws) => {
    const hero = ws.readJson("src/_data/hero.json");
    hero.headlineMain = "A different headline, published today";
    ws.writeJson("src/_data/hero.json", hero);
    const home = ws.readJson("src/_data/homepage.json");
    const hide = (o) => { if (o && typeof o === "object") { if (o.enabled === true) { o.enabled = false; return true; } for (const k of Object.keys(o)) if (hide(o[k])) return true; } return false; };
    if (!hide(home)) throw new Error("selftest: no section to hide in homepage.json");
    ws.writeJson("src/_data/homepage.json", home);
    const how = ws.readJson("src/_data/how.json");
    const pic = (how.story || []).find((s) => s && typeof s.alt === "string");
    if (!pic) throw new Error("selftest: no alt text in how.json");
    pic.alt = "A reworded description of the dispenser on a bathroom wall";
    ws.writeJson("src/_data/how.json", how);
  };

  return [
    {
      name: "studio p1 backend: control - the untouched copy passes check-resilience, and the CI gate tests",
      mutate: (ws) => { withScripts(ws); withWorkflow(ws); },
      build: false,
      run(ws) {
        h.expectRun("check-resilience is green", guard(ws), { code: 0, has: ["check-resilience: OK"] });
        h.expectRun("the scope workflow test is green", unit(ws, ["studio/tests/ci/scope-workflow.test.js"]), { code: 0 });
      },
    },

    // health
    broken("the health route repeats an upstream error text", [[API + "services/health.js", once("} catch (e) { return { state: \"unreachable\", message: MESSAGES.authDown }; }", "} catch (e) { return { state: \"unreachable\", message: MESSAGES.authDown + \" \" + String(e && e.message) }; }")]], ["R6", "repeats upstream text"]),
    broken("the health route calls fetch directly instead of deps.fetch", [[API + "services/health.js", once("await deps.fetch(url,", "await fetch(url,")]], ["R1", "calls fetch directly"]),
    broken("the health route writes an audit entry per call", [[API + "routes/health.js", once("async run(ctx) {", "async run(ctx) { ctx.deps.audit.write({ action: \"rate.limited\" });")]], ["R1", "audit entry per call"]),
    broken("the health route needs a sign-in", [[API + "routes/health.js", once("anon: true, cls: \"anon\"", "cls: \"read\"")]], ["R1", "must be anonymous"]),
    broken("a paused Supabase project is reported as merely unreachable", [[API + "services/health.js", once("if (res.status === 540 || /paus/i.test(res.text))", "if (false)")]], ["R6", "not reported as paused"]),
    broken("the sign-in service being down is a 401 again, not a 503", [[API + "handler.js", once("e.code === \"keys_unavailable\") throw unavailable(\"auth\");", "e.code === \"keys_unavailable\") throw new ApiError(\"unauthorized\", \"Please sign in again.\");")]], ["R8", "service_unavailable"]),

    // 003
    broken("003 loses security definer on a function", [["studio/sql/003_studio_ai_usage.sql", rx(/^security definer(?=\r?$)/m, "security invoker")]], ["R2", "is not security definer"]),
    broken("003 lets the caller set the daily token cap", [["studio/sql/003_studio_ai_usage.sql", once("max_tokens := least(p_max_tokens, lim.max_tokens);", "max_tokens := p_max_tokens;")]], ["R2", "reserve2 must clamp every caller-supplied cap"]),
    broken("003 lets settle2 undo more than the caller reserved", [["studio/sql/003_studio_ai_usage.sql", once("if not found or u.pending_requests < 1 then return; end if;", "if not found then return; end if;")]], ["R2", "studio_ai_settle2 must only undo what the caller reserved"]),
    broken("003 leaves the limits table open (no row level security)", [["studio/sql/003_studio_ai_usage.sql", once("alter table public.studio_ai_limits enable row level security;", "")]], ["R2", "row level security is not enabled on studio_ai_limits"]),
    broken("003 gains a policy on a usage table", [["studio/sql/003_studio_ai_usage.sql", (t) => t + "\ncreate policy anyone on public.studio_ai_requests for select using (true);\n"]], ["R2", "a policy exists"]),
    broken("003 grants a function to anon", [["studio/sql/003_studio_ai_usage.sql", once("grant execute on function public.studio_ai_recent(integer) to authenticated;", "grant execute on function public.studio_ai_recent(integer) to authenticated, anon;")]], ["R2", "something is granted to anon"]),
    broken("003 stops checking the caller is an active person in one function", [["studio/sql/003_studio_ai_usage.sql", rx(/^(create or replace function public\.studio_ai_attach[\s\S]*?)studio_roles r where r\.user_id = caller and r\.active/m, "$1studio_roles r where r.user_id = caller")]], ["R2", "studio_ai_attach does not check the caller is an active person"]),

    // the usage store
    broken("the memory store forgets to give a rejected answer's request back", [[API + "ai/budget.js", once("if (countRequest === false) {", "if (false) {")]], ["R3", "give a rejected answer's REQUEST back"]),
    broken("a rejected AI proposal counts as a request again", [[API + "ai/index.js", once("countRequest: counted }", "countRequest: true }")]], ["R10", "must give the request back"]),
    broken("a failing shared store makes the first request unlimited", [[API + "ai/budget.js", once("fall(e.message);", "fall(e.message); if (name === \"reserve\") return { ok: true, reason: null, global: { requests: 0, tokens: 0 }, user: { requests: 0, tokens: 0 } };")]], ["R9", "not to unlimited"]),
    broken("the in-memory per-user Map comes back", [[API + "ai/index.js", once("  const sharedState = {};", "  const sharedState = {};\n  const usageToday = new Map();")]], ["R4", "usageToday"]),
    broken("the shared store learns about a service-role key", [["studio/api/providers/usage/supabase-budget.js", once("const RECENT_MAX = 20;", "const RECENT_MAX = 20;\nconst KEY_NAME = \"service_role\";")]], ["R9", "service-role key"]),
    broken("a setting the config reads is missing from the runbook", [["docs/STUDIO-RUNBOOK.md", (t) => t.split("STUDIO_HEALTH_TIMEOUT_MS").join("STUDIO_HEALTH_TIMEOUT")]], ["R5", "STUDIO_HEALTH_TIMEOUT_MS"]),

    // labels
    broken("a label failure fails creating the pull request again", [[API + "providers/git/github.js", once("if (typeof opts.onLabelFailure === \"function\") {", "throw e; if (typeof opts.onLabelFailure === \"function\") {")]], ["R7", "opening a pull request failed when the label write was refused"]),
    broken("merge needs the label again (a draft with no label can never be published)", [[API + "providers/git/interface.js", once("return m !== null && m.draftId === idFromBranch(pr.headRef);", "return false;")]], ["R7", "could not be merged"]),

    // the studio-scope gate (plan items 2 and 3)
    {
      name: "studio p1 backend: the scope guard requires a module the workflow does not copy",
      build: false,
      mutate(ws) {
        withScripts(ws); withWorkflow(ws);
        ws.write("studio/validate/extra.js", "\"use strict\";\nmodule.exports = {};\n");
        h.edit(ws, "studio/guards/check-scope.js", once("const scope = require(\"../validate/scope.js\");", "const scope = require(\"../validate/scope.js\");\nrequire(\"../validate/extra.js\");"));
      },
      run(ws) { h.expectRun("the scope-workflow test fails", unit(ws, ["studio/tests/ci/scope-workflow.test.js"]), { code: 1, has: ["studio/validate/extra.js is required by the scope guard but the workflow does not take it from main"] }); },
    },
    {
      name: "studio p1 backend: the workflow stops copying the image rules (the guard would crash on every draft)",
      build: false,
      mutate(ws) { withScripts(ws); withWorkflow(ws); h.edit(ws, ".github/workflows/studio-scope.yml", rx(/^.*git show origin\/main:scripts\/lib\/image-rules\.js.*$/m, "          true")); },
      run(ws) {
        h.expectRun("the scope-workflow test fails", unit(ws, ["studio/tests/ci/scope-workflow.test.js"]), { code: 1, has: ["scripts/lib/image-rules.js"] });
        h.expectRun("and so does the executed copy step", unit(ws, ["studio/tests/p1-backend/scope-guard-behaviour.test.js"]), { code: 1 });
      },
    },
    {
      name: "studio p1 backend: three ordinary publishes (headline, a hidden section, an alt text) keep the content tests green",
      build: false,
      mutate: (ws) => { withScripts(ws); threePublishes(ws); },
      run(ws) { h.expectRun("the tests that read the live content pass", unit(ws, LIVE_TESTS), { code: 0 }); },
    },
    {
      name: "studio p1 backend: control for the above - a test that pins the sample fixture to live words fails the same three publishes",
      build: false,
      mutate(ws) {
        withScripts(ws);
        threePublishes(ws);
        h.edit(ws, "studio/tests/markers/schema.test.js", (t) => t + "\ntest(\"PINNED (selftest control)\", () => {\n  const sample = JSON.parse(fs.readFileSync(path.join(ROOT, \"studio\", \"tests\", \"fixtures\", \"content.sample.json\"), \"utf8\"));\n  assert.deepEqual(files.hero.data, sample.files.hero.data);\n});\n");
      },
      run(ws) { h.expectRun("a pinned fixture breaks on an ordinary publish", unit(ws, LIVE_TESTS), { code: 1, has: ["PINNED (selftest control)"] }); },
    },
  ];
};
