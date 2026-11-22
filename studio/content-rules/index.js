"use strict";
// Node entry for the rule engine: `const rules = require("./studio/content-rules")` -> the engine with every rule registered
// and the committed field roles (field-roles.json) applied unless the caller passes its own `roles`.
// (rules.js self-registers when required; the overlay gets the same two files through overlay/manifest.json, and the
// roles through the bundle: studio/overlay/bundle.js puts field-roles.json on S.fieldRoles.)
const engine = require("./engine.js");
require("./rules.js");
const roles = require("./field-roles.json");

module.exports = Object.assign({}, engine, {
  roles,
  run: (input, helpers) => engine.run(Object.assign({ roles }, input), helpers),
});
