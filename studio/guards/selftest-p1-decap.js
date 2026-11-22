"use strict";
// Selftest scenarios for check-no-decap.js (PHASE1-DESIGN 12): put each retired thing back, one at a time, and expect the guard to fail.
const fs = require("fs");
const path = require("path");

module.exports = (h) => {
  const guard = (ws) => h.runScript(path.join(ws.dir, "studio", "guards", "check-no-decap.js"), ws.dir, []);
  const fails = (name, mutate, has) => ({ name: "decap: " + name, build: false, mutate, run: (ws) => h.expectRun(name, guard(ws), { code: 1, has }) });
  const add = (rel, text) => (ws) => fs.appendFileSync(path.join(ws.dir, rel), text);
  const out = [{ name: "decap: control (untouched copy passes check-no-decap)", build: false, run: (ws) => h.expectRun("check-no-decap passes", guard(ws), { code: 0, has: ["check-no-decap: OK"] }) }];

  for (const dead of ["identity.netlify.com", "netlify-identity", "decap-cms", "decap-server", "git-gateway", "editorial_workflow", "/.netlify/identity", "invite_token"]) {
    out.push(fails("a source file brings back " + dead, add("studio/README.md", "\n" + dead + "\n"), ['contains "' + dead + '"']));
  }
  for (const f of ["cms/index.html", "cms/previews.js", "cms/custom.css"]) out.push(fails("the retired file " + f + " comes back", add(f, "x"), [f + ": must not exist"]));
  out.push(fails("config.yml gets a backend again", (ws) => h.edit(ws, "cms/config.yml", (t) => "backend:\n  name: x\n" + t), ["backend: or publish_mode:"]));
  out.push(fails("config.yml gets publish_mode again", (ws) => h.edit(ws, "cms/config.yml", (t) => "publish_mode: x\n" + t), ["backend: or publish_mode:"]));
  out.push(fails("package.json gets cms-local back", (ws) => h.edit(ws, "package.json", h.replaceOnce('"build": "eleventy",', '"build": "eleventy", "cms-local": "x",')), ["mentions cms-local"]));
  out.push(fails("package.json gets check:previews back", (ws) => h.edit(ws, "package.json", h.replaceOnce('"build": "eleventy",', '"build": "eleventy", "check:previews": "x",')), ["mentions check:previews"]));
  out.push(fails("netlify.toml mentions Identity", add("netlify.toml", "\n# Identity\n"), ["netlify.toml: mentions identity"]));
  out.push(fails("the moved page is deleted", (ws) => fs.rmSync(path.join(ws.dir, "cms", "moved.html")), ["cms/moved.html: missing"]));
  out.push(fails("the moved page runs a script", add("cms/moved.html", "<script>1</script>"), ["has a <script"]));
  out.push(fails("the moved page loads another site", add("cms/moved.html", '<img src="https://example.com/x.png">'), ["another address"]));
  out.push(fails("the moved page loses noindex", (ws) => h.edit(ws, "cms/moved.html", (t) => t.replace("noindex", "index")), ["no noindex"]));
  return out;
};
