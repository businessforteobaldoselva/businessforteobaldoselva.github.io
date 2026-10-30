"use strict";
// Studio unit B (API) selftest scenarios, loaded by scripts/selftest.js (DESIGN 9).
// Each scenario breaks a throwaway copy of the repository in ONE way and requires the guard or test that exists for it
// to fail for the right reason.  The copy has no scripts/ folder (the workspace skips it), so `scripts/` is copied in.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const REAL_ROOT = path.resolve(__dirname, "..", "..");

module.exports = (h) => {
  const { edit, replaceOnce, expectRun, runScript } = h;
  const withScripts = (ws) => fs.cpSync(path.join(REAL_ROOT, "scripts"), path.join(ws.dir, "scripts"), { recursive: true });
  const unitTest = (ws, file) => {
    const r = spawnSync(process.execPath, ["--test", path.join(ws.dir, "studio", "tests", "api", file)], { cwd: ws.dir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
  };
  const guard = (ws, name, args) => runScript(path.join(ws.dir, "studio", "guards", name), ws.dir, args);

  return [
    {
      name: "[studio api] the scope definition lets Studio change package.json",
      mutate(ws) {
        withScripts(ws); // scope.js shares the Windows-name rule with scripts/lib/image-rules.js
        edit(ws, "studio/validate/scope.js", replaceOnce("const DATA_RE = /^src\\/_data\\/[a-z0-9-]+\\.json$/;", "const DATA_RE = /^(?:src\\/_data\\/[a-z0-9-]+|package)\\.json$/;"));
      },
      run(ws) {
        expectRun("check-scope notices the widened scope", guard(ws, "check-scope.js", []), { code: 1, has: ["scope.js lets Studio touch", "package.json"] });
        const files = path.join(ws.dir, "changed.txt");
        fs.writeFileSync(files, "M\tpackage.json\n");
        expectRun("check-scope (pull request mode) rejects a package.json change when the scope is sound", runScript(path.join(REAL_ROOT, "studio", "guards", "check-scope.js"), REAL_ROOT, ["--paths-file", files]), { code: 1, has: ["package.json", "outside what Studio may change"] });
      },
    },
    {
      name: "[studio api] a pull request that renames or deletes data is out of scope",
      mutate(ws) { withScripts(ws); ws.write("studio/NOTES-selftest.txt", "x\n"); },
      run(ws) {
        const f = path.join(ws.dir, "changed2.txt");
        fs.writeFileSync(f, "D\tsrc/_data/hero.json\nA\tsrc/_data/new.json\nM\t.github/workflows/site-checks.yml\nM\tsrc/_data/hero.json\nA\timages/new.jpg\n");
        expectRun("check-scope names each offender and passes the good ones", guard(ws, "check-scope.js", ["--paths-file", f]), { code: 1, has: ["D src/_data/hero.json", "A src/_data/new.json", "site-checks.yml"], hasNot: ["images/new.jpg"] });
      },
    },
    {
      name: "[studio api] the validator stops checking patterns",
      mutate(ws) {
        withScripts(ws);
        edit(ws, "studio/validate/fields.js", replaceOnce("if (re && !re.test(v)) add(\"pattern\", segs, f.pattern.message || \"This does not look right.\"", "if (false && re && !re.test(v)) add(\"pattern\", segs, f.pattern.message || \"This does not look right.\""));
      },
      run(ws) {
        expectRun("validator-parity notices it disagrees with check-cms", guard(ws, "check-validator-parity.js", ["--mutations", "4"]), { code: 1, has: ["ACCEPTED what check-cms rejects", "pattern"] });
      },
    },
    {
      name: "[studio api] the validator stops applying safeUrl",
      mutate(ws) {
        withScripts(ws);
        edit(ws, "studio/validate/fields.js", replaceOnce("rules.safeUrl(v) !== v", "false"));
      },
      run(ws) {
        expectRun("the validation tests refuse javascript: links no more -> they fail", unitTest(ws, "validate-fields.test.js"), { code: 1, has: ["links"] });
      },
    },
    {
      name: "[studio api] a Git provider forgets the studio/ branch guard",
      mutate(ws) {
        withScripts(ws);
        edit(ws, "studio/api/providers/git/mock-memory.js", replaceOnce("async commitFiles({ branch, expectedHeadSha, message, files }) {\n    iface.guardBranchWrite(branch);", "async commitFiles({ branch, expectedHeadSha, message, files }) {"));
      },
      run(ws) {
        expectRun("the provider contract test fails (main could be written)", unitTest(ws, "provider-contract.test.js"), { code: 1 });
      },
    },
    {
      name: "[studio api] the dev auth stub ignores a production environment",
      mutate(ws) {
        withScripts(ws);
        edit(ws, "studio/api/providers/auth/dev.js", replaceOnce("if ((e.STUDIO_ENV || \"production\") === \"production\") throw new AuthError(\"dev_disabled\", \"STUDIO_ENV is production\");", ""));
      },
      run(ws) {
        expectRun("the auth-dev tests fail", unitTest(ws, "auth-dev.test.js"), { code: 1 });
      },
    },
    {
      name: "[studio api] publishing ignores the checks",
      mutate(ws) {
        withScripts(ws);
        edit(ws, "studio/api/services/drafts.js", replaceOnce("  if (pr.checks.state !== \"success\") return \"checks_pending\";\n", ""));
      },
      run(ws) {
        expectRun("the publish-gate tests fail", unitTest(ws, "publish-gates.test.js"), { code: 1 });
      },
    },
    {
      name: "[studio api] eval appears in a route, and a secret in a file",
      mutate(ws) {
        withScripts(ws);
        edit(ws, "studio/api/routes/me.js", (t) => t + "\nmodule.exports.x = () => eval(\"1\");\n");
        ws.write("studio/api/leak.js", "\"use strict\";\nmodule.exports = { githubToken: \"ghp_" + "a".repeat(36) + "\" };\n");
      },
      run(ws) {
        expectRun("check-studio-api names both", runScript(path.join(ws.dir, "scripts", "check-studio-api.js"), ws.dir, ["--static"]), { code: 1, has: ["routes/me.js", "eval", "leak.js", "GitHub token"] });
      },
    },
    {
      name: "[studio api] a portable file starts using Buffer",
      mutate(ws) { edit(ws, "studio/validate/pointer.js", (t) => t + "\nconst __b = Buffer.from('x');\n"); },
      run(ws) {
        expectRun("check-portability fails", guard(ws, "check-portability.js", []), { code: 1, has: ["pointer.js", "Buffer"] });
      },
    },
  ];
};
