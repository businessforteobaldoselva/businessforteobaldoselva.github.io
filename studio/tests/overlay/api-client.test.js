"use strict";
// A 200 that is not JSON (a hotel Wi-Fi or proxy page) must never count as a success: the founder's staged edits would be cleared.
const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./load");

const reply = (status, body) => async () => ({ ok: status < 300, status, headers: { get: () => null }, text: async () => body });

test("a 200 HTML page is an error, not a saved draft", async () => {
  const S = load(null, { fetch: reply(200, "<html>Project paused</html>") });
  S.api.configure({ base: "https://api.test", getToken: () => "t" });
  await assert.rejects(() => S.api.post("/v1/drafts", {}), (e) => e.code === "upstream_error" && /try again/i.test(e.userMessage));
});

test("a 200 with JSON, and a 200 with an empty body, still succeed", async () => {
  let S = load(null, { fetch: reply(200, '{"draft":{"id":"d1"}}') });
  S.api.configure({ base: "https://api.test", getToken: () => "t" });
  assert.equal((await S.api.post("/v1/drafts", {})).draft.id, "d1");
  S = load(null, { fetch: reply(200, "") });
  S.api.configure({ base: "https://api.test", getToken: () => "t" });
  assert.deepEqual(JSON.parse(JSON.stringify(await S.api.post("/v1/drafts", {}))), {});
});
