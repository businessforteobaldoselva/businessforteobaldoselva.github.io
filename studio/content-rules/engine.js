/* COVERED Studio - content rule engine (Phase 1, studio/PHASE1-DESIGN.md section 8).
   ONE engine, three callers: the overlay ("Check my changes", bundled via overlay/manifest.json), the CI guard
   (studio/guards/check-content-rules.js) and the unit tests. Pure: no DOM, no fs, no network, no eval, no Date, no randomness.
   Same input => same findings in the same order, so the panel and CI can be compared finding by finding (by `key`).
   Skeleton written by the architect; the EDIT unit owns this folder from here on (the exported API below is the contract). */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else root.CoveredContentRules = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var ENGINE_VERSION = 1;
  var SEVERITIES = ["block", "warn", "info"];
  var registry = [];

  // rule = { id: "kebab-case", severity, title, check(ctx) -> [ { file, path, message, hint?, fix?, data? } ] }
  function register(rule) {
    if (!rule || !/^[a-z][a-z0-9-]*$/.test(rule.id || "") || SEVERITIES.indexOf(rule.severity) < 0 || typeof rule.check !== "function" || !rule.title) throw new Error("bad content rule");
    if (registry.some(function (r) { return r.id === rule.id; })) throw new Error("duplicate content rule " + rule.id);
    registry.push(rule);
    return rule;
  }

  function sev(s) { return SEVERITIES.indexOf(s); }

  // input = { files: { fileKey: data }, schema, facts, roles?, only?: [ruleId] }  ->  Report
  function run(input, helpers) {
    var ctx = Object.assign({ files: input.files || {}, schema: input.schema || null, facts: input.facts || {}, roles: input.roles || {} }, helpers || {});
    var findings = [];
    var ran = [];
    registry.slice().sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; }).forEach(function (rule) {
      if (input.only && input.only.indexOf(rule.id) < 0) return;
      ran.push(rule.id);
      (rule.check(ctx) || []).forEach(function (f) {
        findings.push({
          key: rule.id + "|" + f.file + "|" + f.path,
          rule: rule.id, severity: f.severity || rule.severity, file: f.file, path: f.path,
          message: f.message, hint: f.hint || "", fix: f.fix || null, data: f.data || null,
        });
      });
    });
    findings.sort(function (a, b) { return sev(a.severity) - sev(b.severity) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0); });
    var counts = { block: 0, warn: 0, info: 0 };
    findings.forEach(function (f) { counts[f.severity] += 1; });
    return { engineVersion: ENGINE_VERSION, ranRules: ran, findings: findings, counts: counts };
  }

  return { ENGINE_VERSION: ENGINE_VERSION, SEVERITIES: SEVERITIES, register: register, run: run, rules: function () { return registry.slice(); } };
});
