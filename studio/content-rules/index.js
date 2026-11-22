"use strict";
// Node entry for the rule engine: `const rules = require("./studio/content-rules")` -> the engine with every rule registered.
// (rules.js self-registers when required; the overlay gets the same two files through overlay/manifest.json.)
const engine = require("./engine.js");
require("./rules.js");
module.exports = engine;
