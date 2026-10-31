"use strict";
// Selftest scenarios for the hardening round of the AI layer (final fixer): each guard added there is broken ON PURPOSE in a
// throwaway copy and the matching check must fail for the right reason. A guard nobody has seen fail proves nothing.
//   module.exports = (h) => [ { name, mutate(ws), build, run(ws) } ]
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const REPO = path.resolve(__dirname, "..", "..");
const A = "studio/api/ai/";

module.exports = (h) => {
  const withScripts = (ws) => { if (!fs.existsSync(ws.file("scripts"))) fs.cpSync(path.join(REPO, "scripts"), ws.file("scripts"), { recursive: true }); };
  const guard = (ws) => h.runScript(path.join(ws.dir, "studio", "guards", "check-ai.js"), ws.dir, []);
  const evaluation = (ws) => h.runScript(path.join(ws.dir, "studio", "ai-eval", "run.js"), ws.dir, ["--quiet"]);
  const apiStatic = (ws) => h.runScript(path.join(ws.dir, "scripts", "check-studio-api.js"), ws.dir, ["--static"]);
  const unit = (file) => (ws) => {
    const r = spawnSync(process.execPath, ["--test", path.join(ws.dir, "studio", "tests", "ai", file)], { cwd: ws.dir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
  };
  const once = (from, to) => h.replaceOnce(from, to);
  const raw = String.raw;
  // built at run time so this file itself holds no key-shaped text for the secret scan to find
  const KEY_LIT = "sk-" + "ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijkl";
  const HDR = "x-api" + "-key";

  // edits: [[relative file, (text) => text]]; via: the runner; has: strings the output must mention
  const broken = (name, edits, via, has) => ({
    name: "studio ai hardening: " + name,
    mutate: (ws) => { withScripts(ws); for (const [rel, fn] of edits) h.edit(ws, rel, fn); },
    build: false,
    run(ws) { h.expectRun("the check catches it", via(ws), { code: 1, has }); },
  });

  return [
    {
      name: "studio ai hardening: control - the untouched copy passes check-ai, the evaluation, the API static rules and the unit tests it relies on",
      mutate: (ws) => withScripts(ws),
      build: false,
      run(ws) {
        h.expectRun("check-ai is green", guard(ws), { code: 0, has: ["check-ai: OK", "D11"] });
        h.expectRun("studio:ai-eval is green", evaluation(ws), { code: 0, has: ["ai-eval (replay) OK"] });
        h.expectRun("check-studio-api static rules are green", apiStatic(ws), { code: 0, has: ["static rules ok"] });
        h.expectRun("the routes tests are green", unit("routes.test.js")(ws), { code: 0 });
      },
    },

    // 1 quadratic markup scan
    broken("the markup scan becomes quadratic again", [[A + "policy.js", once(raw`const MARKUP_RE = /<[\/a-z!?]/i;`, raw`const MARKUP_RE = /<\/?[a-z!?][^>]*>/i;`)]], guard, ["D10", "quadratic"]),
    broken("the markup scan becomes quadratic again (seen by the evaluation too)", [[A + "policy.js", once(raw`const MARKUP_RE = /<[\/a-z!?]/i;`, raw`const MARKUP_RE = /<\/?[a-z!?][^>]*>/i;`)]], evaluation, ["A20-quadratic-markup", "FAIL", "limit 1500"]),

    // 2 links in markdown
    broken("a link, picture or bare address in a markdown body is no longer flagged", [[A + "index.js", once("if (op.op !== \"move\" && ((m.ok && m.target.sensitive) || A.valueAddsLink(op.value))) sensitive = true;", "if (op.op !== \"move\" && ((m.ok && m.target.sensitive))) sensitive = true;")]], evaluation, ["A21-markdown-external-link", "FAIL", "sensitive is []"]),

    // 3 double submit
    broken("a double submit joins nothing (every click makes its own model call)", [[A + "index.js", once("if (flying) return flying.then(", "if (false) return flying.then(")]], guard, ["D8", "model calls"]),
    broken("the retry cache ignores the draft and the selection", [[A + "index.js", once("const sig = instrHash + \"|\" + JSON.stringify([req.draftId || null, req.context.refs, req.context.page || null, req.context.scope || null]);", "const sig = instrHash;")]], unit("routes.test.js"), ["a different selection with the same key must not be served the first answer"]),

    // 4 rate-limit wait shown to the person
    broken("the panel reads the wrong field for the wait", [["studio/overlay/ext/ai-view.js", once("Number(err.details && err.details.retryAfterSec) || Number(err.retryAfter) || 30", "Number(err.retryAfter) || Number(err.details && err.details.retryAfter) || 30")]], unit("routes.test.js"), ["Try again in"]),
    broken("the browser may no longer read Retry-After", [["studio/api/cors.js", once("        \"Access-Control-Expose-Headers\": \"Retry-After\",\n", "")]], unit("routes.test.js"), ["hides the header"]),

    // 5 guards that were vacuous
    broken("the nested prototype-key rule is removed", [[A + "output.js", once("if (P.FORBIDDEN_SEGS.has(k)) return \"proto_key\";", "")]], evaluation, ["A22-proto-in-replace-value", "FAIL"]),
    broken("the node-count cap is removed", [[A + "output.js", once("if (nodes > CAPS.nodes) return \"too_large\";", "")]], evaluation, ["A23-node-flood", "FAIL"]),
    broken("script schemes in text are no longer refused", [[A + "policy.js", once(raw`const SCHEME_RE = /\b(?:javascript|vbscript)`, raw`const SCHEME_RE = /\b(?:zzzzzzzz)`)]], evaluation, ["A24-script-scheme", "FAIL"]),
    broken("the accept route stops scanning what the browser sent", [["studio/api/services/ai.js", once("if (sc) {", "if (false) {")]], evaluation, ["A22-proto-forged", "FAIL", "expected guard"]),
    broken("the accept route stops re-checking each op against the allow-list", [["studio/api/services/ai.js", once("if (code) problems.push(", "if (false) problems.push(")]], evaluation, ["A24-script-scheme-forged", "FAIL", "forged proposal"]),
    broken("a move may cross from one list into another", [[A + "output.js", once("    if (pp(op.from) !== pp(op.path)) return \"bad_op_shape\";\n", "")]], evaluation, ["A26-forged-cross-list-move", "FAIL"]),

    // 6 schema pin
    broken("the schema told to the model allows extra fields", [[A + "tool-schema.js", (t) => { if (t.indexOf("additionalProperties: false") < 0) throw new Error("selftest anchor not found"); return t.split("additionalProperties: false").join("additionalProperties: true"); }]], guard, ["D9", "extra fields"]),
    broken("the schema told to the model loses its size cap", [[A + "tool-schema.js", once("type: \"array\", maxItems: policy.CAPS.changes,", "type: \"array\",")]], guard, ["D9", "changes maxItems"]),

    // 7 key literals
    broken("an Anthropic key literal is committed in the AI code", [[A + "index.js", once("\"use strict\";", "\"use strict\";\nconst K = " + JSON.stringify(KEY_LIT) + ";")]], apiStatic, ["an Anthropic API key", "studio/api/ai/index.js"]),
    broken("an Anthropic key literal is committed in a test", [["studio/tests/ai/routes.test.js", (t) => t + "\nconst LEAK = " + JSON.stringify(KEY_LIT) + ";\n"]], apiStatic, ["an Anthropic API key", "routes.test.js"]),
    broken("the key header is committed with a literal value", [[A + "providers/anthropic.js", (t) => t + "\nconst H = { " + JSON.stringify(HDR) + ": \"abcdefghijklmnop1234567890\" };\n"]], apiStatic, ["x-api-key header with a literal value"]),

    // lows
    broken("the key header may follow a redirect to another host", [[A + "providers/anthropic.js", once("        redirect: \"manual\",\n", "")]], unit("providers.test.js"), ["a 3xx must not carry x-api-key"]),
    broken("AI help may run in production without a secret audit salt", [["studio/api/config.js", once("if (production && aiCfg.enabled && !e.STUDIO_AUDIT_SALT) throw", "if (false) throw")]], unit("config.test.js"), ["secret audit salt"]),
    broken("a hand edit of an AI draft erases its provenance", [["studio/api/services/drafts.js", once("aiCarry: o.ai ? null : text.carryAi(pr.body) });", "aiCarry: null });")]], unit("accept-flow.test.js"), ["the provenance survived the hand edit"]),

    // 8 no network in tests
    broken("the unit-test runner stops loading the no-network guard", [["scripts/check-studio.js", once("\"--require\", path.join(gdir, \"no-network.js\"), ", "")]], guard, ["S7", "check-studio.js"]),
    broken("the replay evaluation may reach the network", [["studio/ai-eval/run.js", once("if (!flag(\"--live\")) require(path.join(ROOT, \"studio\", \"guards\", \"no-network.js\"));", "")]], guard, ["S7", "run.js"]),
    broken("the no-network guard lets every connection through", [["studio/guards/no-network.js", once("throw blocked(a.host);", "return connect.apply(this, args);")]], guard, ["D11", "not blocked"]),
  ];
};
