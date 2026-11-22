"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("../../api/review-config");
const { loadConfig, ConfigError } = require("../../api/config");

const bad = (env, re) => assert.throws(() => load(env), (e) => e instanceof ConfigError && re.test(e.message));

test("everything unset: the feature is simply off", () => {
  assert.deepEqual(load({}), { reviewers: [], previewEmbed: false, siteUrl: "", reviewBaseUrl: "", settlingMinutes: 10 });
});

test("reviewers: parsed, trimmed, defaults to approver, github optional", () => {
  const c = load({ STUDIO_REVIEWERS: '[{"id":"molly","name":" Molly ","github":"mollygh"},{"id":"teo","name":"Teo","role":"admin","userId":"4CE9D419-E0C5-40CD-B421-FC9138ED7895"}]' });
  assert.deepEqual(c.reviewers, [
    { id: "molly", name: "Molly", github: "mollygh", role: "approver", userId: null },
    { id: "teo", name: "Teo", github: null, role: "admin", userId: "4ce9d419-e0c5-40cd-b421-fc9138ed7895" },
  ]);
});

test("reviewers: junk is refused with a plain sentence, never half-read", () => {
  bad({ STUDIO_REVIEWERS: "not json" }, /JSON list/);
  bad({ STUDIO_REVIEWERS: "{}" }, /list of at most 10/);
  bad({ STUDIO_REVIEWERS: JSON.stringify(Array.from({ length: 11 }, (_, i) => ({ id: "p" + i, name: "P" }))) }, /at most 10/);
  bad({ STUDIO_REVIEWERS: '[{"id":"Bad Id","name":"X"}]' }, /id must be/);
  bad({ STUDIO_REVIEWERS: '[{"id":"a","name":"X"},{"id":"a","name":"Y"}]' }, /used twice/);
  bad({ STUDIO_REVIEWERS: '[{"id":"a","name":"<b>"}]' }, /name must be/);
  bad({ STUDIO_REVIEWERS: '[{"id":"a","name":"X","github":"no spaces"}]' }, /github/);
  bad({ STUDIO_REVIEWERS: '[{"id":"a","name":"X","role":"editor"}]' }, /role/);
  bad({ STUDIO_REVIEWERS: '[{"id":"a","name":"X","email":"x@y.z"}]' }, /unknown field/);
  bad({ STUDIO_REVIEWERS: '[{"id":"a","name":"X","userId":"nope"}]' }, /userId/);
});

test("addresses must be https origins (or localhost); embed and minutes are checked", () => {
  assert.equal(load({ STUDIO_SITE_URL: "https://www.example.org/" }).siteUrl, "https://www.example.org");
  assert.equal(load({ STUDIO_REVIEW_BASE_URL: "http://localhost:8080" }).reviewBaseUrl, "http://localhost:8080");
  bad({ STUDIO_SITE_URL: "http://www.example.org" }, /STUDIO_SITE_URL/);
  bad({ STUDIO_SITE_URL: "https://user:pw@example.org" }, /STUDIO_SITE_URL/);
  bad({ STUDIO_REVIEW_BASE_URL: "https://example.org/path?x=1" }, /STUDIO_REVIEW_BASE_URL/);
  bad({ STUDIO_REVIEW_BASE_URL: "javascript:alert(1)" }, /STUDIO_REVIEW_BASE_URL/);
  assert.equal(load({ STUDIO_PREVIEW_EMBED: "1" }).previewEmbed, true);
  bad({ STUDIO_PREVIEW_EMBED: "yes" }, /STUDIO_PREVIEW_EMBED/);
  assert.equal(load({ STUDIO_SETTLING_MINUTES: "60" }).settlingMinutes, 60);
  bad({ STUDIO_SETTLING_MINUTES: "0" }, /STUDIO_SETTLING_MINUTES/);
  bad({ STUDIO_SETTLING_MINUTES: "61" }, /STUDIO_SETTLING_MINUTES/);
  bad({ STUDIO_SETTLING_MINUTES: "ten" }, /STUDIO_SETTLING_MINUTES/);
});

test("loadConfig wires it in and reads only the env object it is given", () => {
  const c = loadConfig({ STUDIO_ENV: "development", STUDIO_DEV: "1", STUDIO_ALLOWED_ORIGINS: "http://localhost:8080", STUDIO_SETTLING_MINUTES: "3" });
  assert.equal(c.review.settlingMinutes, 3);
  assert.throws(() => loadConfig({ STUDIO_ENV: "development", STUDIO_DEV: "1", STUDIO_ALLOWED_ORIGINS: "http://localhost:8080", STUDIO_PREVIEW_EMBED: "2" }), ConfigError);
});
