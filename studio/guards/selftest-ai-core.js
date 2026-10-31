"use strict";
// Self-test scenarios of the AI layer, CORE half (AI-DESIGN 17.2). Loaded by scripts/selftest.js. Each scenario breaks a
// throwaway copy of the site in ONE way and requires check-ai (or the replay evaluation, studio:ai-eval) to fail for the
// right reason, so every guard is proven not to be vacuous. A control scenario shows the untouched copy passes.

const fs = require("fs");
const path = require("path");

const REPO = path.resolve(__dirname, "..", "..");

module.exports = (h) => {
  // the workspace omits scripts/, which the validator's scope rules import: put it back (read only)
  const withScripts = (ws) => { if (!fs.existsSync(ws.file("scripts"))) fs.cpSync(path.join(REPO, "scripts"), ws.file("scripts"), { recursive: true }); };
  const guard = (ws) => h.runScript(path.join(REPO, "studio", "guards", "check-ai.js"), ws.dir, []);
  const evaluation = (ws) => h.runScript(path.join(REPO, "studio", "ai-eval", "run.js"), ws.dir, ["--quiet"]);
  const A = "studio/api/ai/";

  const broken = (name, edits, via, has) => ({
    name: "studio ai: " + name,
    mutate: (ws) => { withScripts(ws); for (const [rel, fn] of edits) h.edit(ws, rel, fn); },
    build: false,
    run(ws) { h.expectRun((via === "eval" ? "studio:ai-eval" : "check-ai") + " catches it", via === "eval" ? evaluation(ws) : guard(ws), { code: 1, has }); },
  });
  const once = (from, to) => h.replaceOnce(from, to);

  return [
    {
      name: "studio ai: control - the untouched AI layer passes check-ai and the replay evaluation",
      mutate: (ws) => withScripts(ws),
      build: false,
      run(ws) {
        h.expectRun("check-ai is green", guard(ws), { code: 0, has: ["check-ai: OK"] });
        h.expectRun("studio:ai-eval is green", evaluation(ws), { code: 0, has: ["ai-eval (replay) OK", "all adversarial outputs rejected or neutralised", "revertible: 26/26"] });
      },
    },
    broken("the allow-list gains a workflow file", [[A + "allowlist.js", once("  targets.sort(", "  targets.push({ file: \".github/workflows/site-checks.yml\", template: \"/on\", widget: \"string\", rule: null, maxLen: null, ops: [\"replace\"], sensitive: false, modes: [\"edit\"] });\n  targets.sort(")]], "guard", ["D2", "is not a data or page file"]),
    broken("the prototype-key rule is switched off", [["studio/validate/pointer.js", once("const FORBIDDEN_SEGS = new Set([\"__proto__\", \"constructor\", \"prototype\"]);", "const FORBIDDEN_SEGS = new Set([]);")]], "eval", ["A04-proto-pointer", "FAIL"]),
    broken("the model is allowed to supply expect", [[A + "output.js", once("if (!o.allowExpect && own(op, \"expect\")) return \"expect_supplied\";", "")]], "eval", ["A16-invented-expect", "FAIL"]),
    broken("markup in text is no longer rejected", [[A + "output.js", once("function markupIn(v, depth) {", "function markupIn(v, depth) {\n  return null;")]], "eval", ["A05-markup-in-value", "FAIL"]),
    broken("the kill switch check is removed", [[A + "index.js", once("if (!isEnabled()) {\n      await audit(ctx, \"ai.denied\", \"denied\", { codes: [cfg.enabled ? \"no_key\" : \"disabled\"] });\n      throw new ApiError(\"ai_disabled\", COPY.disabled);\n    }\n    const req = parseRequest(body);", "const req = parseRequest(body);")]], "guard", ["D4"]),
    broken("the API key is printed by the provider", [[A + "providers/anthropic.js", once("const doFetch = o.fetchFn;", "const doFetch = o.fetchFn;\n  console.log(apiKey);")]], "guard", ["S2", "calls console"]),
    broken("the budget reservation is removed", [[A + "index.js", once("const rv = budget.reserve(day, est);", "const rv = { ok: true };")]], "guard", ["D6", "budget"]),
    broken("angle brackets are no longer escaped in the prompt data", [[A + "prompt.js", once("new RegExp(\"[<>&\"", "new RegExp(\"[&\"")]], "guard", ["D5"]),
    broken("accept writes to Git directly", [["studio/api/services/ai.js", once("  let r;\n  try {", "  let r;\n  await deps.git.commitFiles({ branch: \"studio/x/y\", expectedHeadSha: pr.base.sha, message: \"x\", files: [] });\n  try {")]], "guard", ["S5", "Git write method"]),
    broken("every schema leaf becomes writable (pictures, hidden fields, addresses)", [[A + "allowlist.js", once("function leafDenial(f, w) {", "function leafDenial(f, w) {\n  return null;")]], "guard", ["D2"]),
    broken("the dependency check on accepted changes is ignored", [["studio/api/services/ai.js", once("const miss = requires[i].find((j) => !closed.has(j) || !selected.has(j));", "const miss = undefined;")]], "eval", ["25-two-dependent-changes", "FAIL", "does not say which change is missing"]),
    broken("the tone check no longer verifies its quotes", [[A + "output.js", once("if (typeof current !== \"string\" || !quote || squash(current).indexOf(quote) < 0) {", "if (typeof current !== \"string\" || !quote) {")]], "eval", ["A19-tone-invented-quote", "FAIL"]),
    broken("changes are never marked as outside the request", [[A + "index.js", once("outsideAsk: outside,", "outsideAsk: false,")], [A + "index.js", once("defaultChecked: !outside && !sensitive", "defaultChecked: !sensitive")]], "eval", ["A01-injection-faq-model-complies", "FAIL", "outsideAsk"]),
    broken("the instruction text is written to the audit trail", [[A + "index.js", once("const meta = { mode: req.mode, instrHash };", "const meta = { mode: req.mode, instrHash, instruction: req.instruction };")]], "eval", ["instruction text appears in the audit trail"]),
    broken("an AI route becomes anonymous", [["studio/api/routes/ai.js", once("method: \"GET\", path: \"/v1/ai/status\", cls: \"read\", minRole: \"editor\",", "method: \"GET\", path: \"/v1/ai/status\", cls: \"read\", anon: true,")]], "guard", ["D1", "anonymous"]),
    broken("the replay provider reaches for the network", [[A + "providers/replay.js", once("const calls = [];", "const calls = [];\n  const probe = () => fetch(\"https://example.invalid/\");")]], "guard", ["S3", "replay"]),
    broken("token counts are renamed so the audit redaction swallows them", [[A + "index.js", once("model: proposal.model, usage, changes: proposal.changes.length", "model: proposal.model, usage: { tokens: usage.inTok, outTok: usage.outTok }, changes: proposal.changes.length")]], "eval", ["lost its token counts"]),
    broken("the API key is stored in the configuration object", [["studio/api/config.js", once("ai: loadAiConfig(e),", "ai: loadAiConfig(e), aiKey: e.STUDIO_AI_API_KEY,")]], "guard", ["D3", "part of the configuration"]),
    broken("the provider sends the key to another address", [[A + "providers/anthropic.js", once("const ENDPOINT = \"https://api.anthropic.com/v1/messages\";", "const ENDPOINT = \"https://api.example.org/v1/messages\";")]], "guard", ["S4", "D3"]),
    broken("a second web address appears in the AI code", [[A + "prompt.js", once("const PROMPT_VERSION", "const COLLECT = \"https://example.org/collect\";\nconst PROMPT_VERSION")]], "guard", ["S4", "URL literal"]),
    {
      name: "studio ai: an overlay file names the key",
      mutate: (ws) => { withScripts(ws); ws.write("studio/overlay/ext/leak.js", "// STUDIO_AI_API_KEY and x-api-key\n"); },
      build: false,
      run(ws) { h.expectRun("check-ai catches it", guard(ws), { code: 1, has: ["S6", "STUDIO_AI_API_KEY"] }); },
    },
    {
      name: "studio ai: a template or script names the key",
      mutate: (ws) => { withScripts(ws); ws.write("lib/leak.js", "module.exports = process.env.STUDIO_AI_API_KEY;\n"); },
      build: false,
      run(ws) { h.expectRun("check-ai catches it", guard(ws), { code: 1, has: ["S1", "lib/leak.js"] }); },
    },
    broken("the frozen content no longer matches the schema", [["studio/ai-eval/world/src/_data/hero.json", once("\"badge\": \"Pilot launching in Exeter, UK\"", "\"badge\": \"\"")]], "guard", ["D7", "world file"]),
    {
      name: "studio ai: too few fixtures",
      mutate: (ws) => { withScripts(ws); for (const n of ["01", "02", "03", "04", "05", "06"]) for (const f of fs.readdirSync(ws.file("studio/ai-eval/fixtures"))) if (f.startsWith(n + "-")) fs.unlinkSync(ws.file("studio/ai-eval/fixtures/" + f)); },
      build: false,
      run(ws) { h.expectRun("check-ai catches it", guard(ws), { code: 1, has: ["D7", "valid patch fixtures"] }); },
    },
    {
      name: "studio ai: a schema change that moves the AI's reach is caught until a human reviews the snapshot",
      mutate: (ws) => {
        withScripts(ws);
        const rel = "studio/schema/studio-schema.json";
        const j = JSON.parse(ws.read(rel));
        const hero = j.files.hero.fields.find((f) => f.name === "stamp");
        hero.name = "stampRenamed";
        ws.write(rel, JSON.stringify(j, null, 2) + "\n");
      },
      build: false,
      run(ws) { h.expectRun("check-ai catches it", guard(ws), { code: 1, has: ["D2", "the AI's reach changed"] }); },
    },
  ];
};
