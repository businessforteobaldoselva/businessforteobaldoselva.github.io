"use strict";
// studio/sql/003_studio_ai_usage.sql is applied BY A HUMAN, so its safety properties are checked as text (PHASE1-DESIGN 10.2):
// every function is security definer with a pinned search_path and the active-person check, RLS on with no policy, nothing for anon.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { checkSql } = require("../../guards/check-resilience");

const SQL = fs.readFileSync(path.join(__dirname, "..", "..", "sql", "003_studio_ai_usage.sql"), "utf8");
const FUNCTIONS = ["studio_ai_reserve2", "studio_ai_settle2", "studio_ai_release2", "studio_ai_snapshot2", "studio_ai_record", "studio_ai_attach", "studio_ai_recent"];

test("the file is clean under the guard's own SQL rules", () => { assert.deepEqual(checkSql(SQL), []); });

test("it names the human-review header and does not touch 002", () => {
  assert.match(SQL.split("\n")[0], /REVIEW BEFORE APPLYING/);
  assert.doesNotMatch(SQL, /drop\s+(table|function)/i, "003 never drops anything");
  assert.doesNotMatch(SQL, /alter\s+table\s+public\.studio_ai_usage\b/i, "002's table is reused, not altered");
});

test("all seven functions exist, are security definer, pin the search path and check the caller is an active person", () => {
  for (const fn of FUNCTIONS) {
    const m = new RegExp("create or replace function public\\." + fn + "\\([^)]*\\)[\\s\\S]*?\\n\\$\\$;", "i").exec(SQL);
    assert.ok(m, fn + " is defined");
    assert.match(m[0], /security definer/i, fn);
    assert.match(m[0], /set search_path = public/i, fn);
    assert.match(m[0], /auth\.uid\(\)/, fn);
    assert.match(m[0], /studio_roles r where r\.user_id = caller and r\.active/, fn + " refuses people who are not active");
  }
  assert.equal((SQL.match(/create or replace function/gi) || []).length, FUNCTIONS.length, "no extra function sneaks in");
});

test("both tables have row level security and NO policy; nothing is granted to anon; functions only to authenticated", () => {
  for (const t of ["studio_ai_user_usage", "studio_ai_requests", "studio_ai_limits"]) {
    assert.match(SQL, new RegExp("alter table public\\." + t + " enable row level security", "i"));
    assert.match(SQL, new RegExp("revoke all on public\\." + t + " from anon, authenticated", "i"));
  }
  assert.doesNotMatch(SQL, /create policy/i);
  assert.doesNotMatch(SQL, /grant\s[^;]*\sto\s[^;]*\banon\b/i);
  assert.doesNotMatch(SQL, /grant\s[^;]*\sto\s[^;]*\bpublic\b/i);
  for (const fn of FUNCTIONS) {
    assert.match(SQL, new RegExp("revoke all on function public\\." + fn + "\\([^)]*\\) from public, anon;", "i"), fn + " is closed to anon");
    assert.match(SQL, new RegExp("grant execute on function public\\." + fn + "\\([^)]*\\) to authenticated;", "i"), fn + " is open to signed-in people only");
  }
});

test("it stores counters and ids only: no instruction text, page content or names", () => {
  const tableDefs = SQL.match(/create table if not exists[\s\S]*?\);/gi).join("\n");
  for (const bad of /\b(instruction|prompt|content|body|email|name|text_value)\b/i.exec(tableDefs) || []) assert.fail("a column that could hold personal text: " + bad);
  assert.match(tableDefs, /id\s+text primary key check \(id ~ '\^p_\[a-z0-9\]\{12\}\$'\)/);
});

test("reserve2 keeps the lock order (global, then person) and undoes the global bump when the person's cap refuses", () => {
  const m = /create or replace function public\.studio_ai_reserve2[\s\S]*?\n\$\$;/i.exec(SQL)[0];
  const global = m.indexOf("update public.studio_ai_usage x");
  const person = m.indexOf("update public.studio_ai_user_usage y");
  const undo = m.indexOf("requests = x.requests - 1");
  assert.ok(global > 0 && person > global, "global is locked before the person");
  assert.ok(undo > person, "the global bump is undone after the person's cap refuses");
  assert.match(m, /'user_requests'/);
});
