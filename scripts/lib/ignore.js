"use strict";
// scripts/wiring-ignore.json: data paths the structure / wiring guards deliberately skip.
//
//   { "entries": [ { "path": "brands.form.fields[].id", "checks": ["cms", "wiring"], "reason": "..." } ] }
//
// path   <data file or page name>.<key>.<key>[].<key>   ("[]" = any list item, "*" = any one key, "**" = anything below)
// checks which guards may skip it: "cms" (check-cms coverage) and/or "wiring" (check-wiring sentinel)
// injectedOnly (optional, wiring): skip only the probe check-wiring injects into items that do not hold the field
//          (for fields that a template reads for some item types only, e.g. a dropdown's first choice)
// reason why an editor never needs to change it / why it cannot be tested (20+ characters)
// An entry that skips nothing is reported by the guard that owns it, so entries cannot rot.

const { collapse } = require("./util");
const { patternToRegExp } = require("./data");

class IgnoreList {
  constructor(data) {
    this.problems = [];
    this.entries = [];
    for (const e of (data && data.entries) || []) {
      const label = "wiring-ignore entry " + JSON.stringify(e && e.path);
      if (!e || typeof e.path !== "string" || !e.path) {
        this.problems.push(label + ": needs a path");
        continue;
      }
      if (!e.reason || collapse(e.reason).length < 20) {
        this.problems.push(label + ": needs a reason of at least 20 characters");
        continue;
      }
      const checks = Array.isArray(e.checks) && e.checks.length ? e.checks : ["cms", "wiring"];
      if (checks.some((c) => c !== "cms" && c !== "wiring")) {
        this.problems.push(label + ': "checks" may only contain "cms" and "wiring"');
        continue;
      }
      this.entries.push({ path: e.path, re: patternToRegExp(e.path), reason: e.reason, checks, injectedOnly: e.injectedOnly === true, uses: { cms: 0, wiring: 0 } });
    }
  }

  // -> entry | null.   sourceName "brands" / "about", schema "form.fields[].id"
  match(sourceName, schema, check, injected) {
    const full = sourceName + "." + schema;
    for (const e of this.entries) {
      if (e.checks.includes(check) && (!e.injectedOnly || injected) && (e.re.test(full) || e.re.test(schema))) {
        e.uses[check] += 1;
        return e;
      }
    }
    return null;
  }

  // Entries of a guard that matched nothing.
  unused(check) {
    return this.entries.filter((e) => e.checks.includes(check) && e.uses[check] === 0);
  }
}

module.exports = { IgnoreList };
