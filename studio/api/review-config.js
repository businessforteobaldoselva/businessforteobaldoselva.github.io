"use strict";
// Review settings (studio/PHASE1-DESIGN.md sections 5 to 7 and 13), owned by the REVIEW unit. Pure (reads only the env object it is
// given, never process.env), portable, plain values only. loadConfig() in config.js calls load(env); a malformed value throws
// ConfigError, an unset one means "feature off". Everything is optional: the API works with every variable unset.
//   STUDIO_REVIEWERS          JSON array [{ id, name, github|null, role, userId? }], at most 10 (who can be asked to review)
//   STUDIO_REVIEW_BASE_URL    https origin (or http://localhost) used for review links when a draft has no preview address
//   STUDIO_SITE_URL           https origin of the live site (side-by-side only)
//   STUDIO_PREVIEW_EMBED      "1" allows the side-by-side frame; default "0"
//   STUDIO_SETTLING_MINUTES   how long "Published, updating" is shown, 1 to 60, default 10

const ID_RE = /^[a-z0-9-]{1,30}$/;
const GH_RE = /^[A-Za-z0-9-]{1,39}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCAL_HTTP = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/;

function fail(message) {
  const { ConfigError } = require("./config"); // lazy: config.js requires this file while it is still loading
  throw new ConfigError(message);
}

function origin(name, value) {
  const v = String(value || "").trim();
  if (!v) return "";
  let u;
  try { u = new URL(v); } catch (e) { return fail(name + " must be an https address such as https://example.org"); }
  const ok = (u.protocol === "https:" || LOCAL_HTTP.test(u.origin)) && !u.username && !u.password && !u.search && !u.hash && (u.pathname === "/" || u.pathname === "");
  if (!ok) fail(name + " must be an https address with no path, no login and no query, such as https://example.org");
  return u.origin;
}

function reviewers(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return [];
  let list;
  try { list = JSON.parse(String(raw)); } catch (e) { return fail("STUDIO_REVIEWERS must be a JSON list, for example [{\"id\":\"molly\",\"name\":\"Molly\",\"github\":\"mollygh\",\"role\":\"approver\"}]"); }
  if (!Array.isArray(list) || list.length > 10) fail("STUDIO_REVIEWERS must be a list of at most 10 people");
  const seen = new Set();
  return list.map((p, i) => {
    const at = "STUDIO_REVIEWERS entry " + (i + 1);
    if (!p || typeof p !== "object" || Array.isArray(p)) return fail(at + " must be an object");
    for (const k of Object.keys(p)) if (["id", "name", "github", "role", "userId"].indexOf(k) < 0) fail(at + " has an unknown field " + JSON.stringify(k.slice(0, 20)));
    if (typeof p.id !== "string" || !ID_RE.test(p.id)) fail(at + ": id must be 1 to 30 lower-case letters, digits or dashes");
    if (seen.has(p.id)) fail(at + ": id " + p.id + " is used twice");
    seen.add(p.id);
    if (typeof p.name !== "string" || !p.name.trim() || p.name.length > 60 || /[\u0000-\u001f\u007f<>]/.test(p.name)) fail(at + ": name must be 1 to 60 plain characters");
    if (p.github !== undefined && p.github !== null && (typeof p.github !== "string" || !GH_RE.test(p.github))) fail(at + ": github must be a GitHub user name or null");
    const role = p.role === undefined ? "approver" : p.role;
    if (role !== "approver" && role !== "admin") fail(at + ": role must be approver or admin");
    if (p.userId !== undefined && (typeof p.userId !== "string" || !UUID_RE.test(p.userId))) fail(at + ": userId must be the person's Studio user id (a UUID)");
    return { id: p.id, name: p.name.trim(), github: p.github || null, role, userId: p.userId ? p.userId.toLowerCase() : null };
  });
}

function load(env) {
  const e = env || {};
  const embed = e.STUDIO_PREVIEW_EMBED === undefined || e.STUDIO_PREVIEW_EMBED === "" ? "0" : String(e.STUDIO_PREVIEW_EMBED);
  if (embed !== "0" && embed !== "1") fail("STUDIO_PREVIEW_EMBED must be 0 or 1");
  let minutes = 10;
  if (e.STUDIO_SETTLING_MINUTES !== undefined && e.STUDIO_SETTLING_MINUTES !== "") {
    if (!/^[0-9]{1,2}$/.test(String(e.STUDIO_SETTLING_MINUTES)) || Number(e.STUDIO_SETTLING_MINUTES) < 1 || Number(e.STUDIO_SETTLING_MINUTES) > 60) fail("STUDIO_SETTLING_MINUTES must be a whole number from 1 to 60");
    minutes = Number(e.STUDIO_SETTLING_MINUTES);
  }
  return {
    reviewers: reviewers(e.STUDIO_REVIEWERS),
    previewEmbed: embed === "1",
    siteUrl: origin("STUDIO_SITE_URL", e.STUDIO_SITE_URL),
    reviewBaseUrl: origin("STUDIO_REVIEW_BASE_URL", e.STUDIO_REVIEW_BASE_URL),
    settlingMinutes: minutes,
  };
}

module.exports = { load };
