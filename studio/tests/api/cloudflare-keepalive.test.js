"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

async function adapter() { return (await import("../../api/adapters/cloudflare.mjs")).default; }
function run(env, fetchImpl) {
  const real = globalThis.fetch; const waits = []; const logs = []; const log = console.log;
  globalThis.fetch = fetchImpl; console.log = (m) => logs.push(m);
  return adapter().then(async (a) => { await a.scheduled({}, env, { waitUntil: (p) => waits.push(p) }); await Promise.all(waits); }).finally(() => { globalThis.fetch = real; console.log = log; }).then(() => logs);
}

test("the weekly trigger makes one read against the Supabase REST API with the public key", async () => {
  const seen = [];
  const logs = await run({ SUPABASE_URL: "https://abc123.supabase.co/", SUPABASE_ANON_KEY: "pub" }, async (url, init) => { seen.push([url, init.headers.apikey]); return { status: 401 }; });
  assert.deepEqual(seen, [["https://abc123.supabase.co/rest/v1/studio_roles?select=id&limit=1", "pub"]]);
  assert.match(logs[0], /HTTP 401/);
});

test("it never calls anything but a supabase.co address, and does nothing without a key", async () => {
  let calls = 0;
  const f = async () => { calls++; return { status: 200 }; };
  await run({ SUPABASE_URL: "https://evil.example", SUPABASE_ANON_KEY: "pub" }, f);
  await run({ SUPABASE_URL: "https://abc123.supabase.co" }, f);
  await run({}, f);
  assert.equal(calls, 0);
});
