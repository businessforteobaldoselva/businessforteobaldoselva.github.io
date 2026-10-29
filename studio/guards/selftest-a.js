"use strict";
// Selftest scenarios of unit A (markers + schema). Loaded by scripts/selftest.js:
//   module.exports = (h) => [ { name, mutate(ws), build: false, run(ws) } ]
// Each scenario breaks a throwaway copy of the site in ONE way and the Studio guard that should notice must fail for the
// right reason (studio/DESIGN.md section 9).

const path = require("path");
const { spawnSync } = require("child_process");

const MARKERS = path.join(__dirname, "check-markers.js");
const SCHEMA = path.join(__dirname, "check-schema.js");
const UTIL = path.resolve(__dirname, "..", "..", "scripts", "lib", "util.js");

module.exports = (h) => {
  const markers = (ws, expect) => h.expectRun("check-markers", h.runScript(MARKERS, ws.dir, ["--no-hostile"]), expect);
  const hero = "src/_includes/sections/hero.njk";
  return [
    {
      name: "studio markers: a template builds a marker reference from data",
      mutate: (ws) => h.edit(ws, "src/_includes/sections/how.njk", h.replaceOnce('"how.story." + loop.index0 + ".title"', '"how.story." + s.title')),
      build: false,
      run: (ws) => markers(ws, { code: 1, has: ["CMS_EDIT=1 build fails", "invalid markers in templates"] }),
    },
    {
      name: "studio markers: a marker names a field that does not exist in the schema",
      mutate: (ws) => h.edit(ws, "src/_includes/sections/how.njk", h.replaceOnce('{% cms "how.title", "text" %}', '{% cms "how.titel", "text" %}')),
      build: false,
      run: (ws) => markers(ws, { code: 1, has: ["no field in cms/config.yml", "how.titel"] }),
    },
    {
      name: "studio markers: a marker shows a different value than it names",
      mutate: (ws) => h.edit(ws, hero, h.replaceOnce('{% cms "hero.badge", "text" %}', '{% cms "hero.stamp", "text" %}')),
      build: false,
      run: (ws) => markers(ws, { code: 1, has: ["does not tell the truth", "hero.stamp"] }),
    },
    {
      name: "studio markers: a marker of the wrong kind for its field",
      mutate: (ws) => h.edit(ws, hero, h.replaceOnce('{% cms "hero.subhead", "longtext" %}', '{% cms "hero.subhead", "text" %}')),
      build: false,
      run: (ws) => markers(ws, { code: 1, has: ["does not fit a 'text' field", "hero.subhead"] }),
    },
    {
      name: "studio markers: a marker is removed (coverage ratchet)",
      mutate: (ws) => h.edit(ws, hero, h.replaceOnce('{% cms "hero.headlineMain", "text" %}', "")),
      build: false,
      run: (ws) => markers(ws, { code: 1, has: ["no longer editable in place: hero#/headlineMain"] }),
    },
    {
      name: "studio markers: the shortcode prints in a normal build (parity)",
      mutate: (ws) => h.edit(ws, "studio/markers/shortcode.js", h.replaceOnce('if (!isEditBuild(env)) return "";', "")),
      build: false,
      run: (ws) => markers(ws, { code: 1, has: ["Parity: production output must be unchanged", "a normal build must contain no data-cms attribute"] }),
    },
    {
      name: "studio markers: the overlay is injected in a normal build (parity)",
      mutate: (ws) => h.edit(ws, "lib/eleventy/studio.js", h.replaceOnce('if (process.env.CMS_EDIT !== "1") return;', "if (false) return;")),
      build: false,
      run: (ws) => markers(ws, { code: 1, has: ["a normal build must contain no studio/ path"] }),
    },
    {
      name: "studio schema: the committed schema is out of date with cms/config.yml",
      mutate: (ws) => h.edit(ws, "cms/config.yml", h.replaceOnce('hint: "The small pill with the pulsing dot above the headline."', 'hint: "The small pill, changed in a selftest."')),
      build: false,
      run: (ws) => h.expectRun("check-schema", h.runScript(SCHEMA, ws.dir, []), { code: 1, has: ["out of date"] }),
    },
    {
      name: "studio guards build production html even when the shell has CMS_EDIT=1",
      mutate: null,
      build: false,
      run: () => {
        const r = spawnSync(process.execPath, ["-e", "process.env.CMS_EDIT='1'; require(" + JSON.stringify(UTIL) + "); process.stdout.write(String(process.env.CMS_EDIT))"], { encoding: "utf8" });
        h.mark(r.stdout === "undefined", "scripts/lib/util.js removes CMS_EDIT from the environment (got " + JSON.stringify(r.stdout) + ")");
      },
    },
  ];
};
