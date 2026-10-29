"use strict";
// Response / request helpers shared by the handler and routes. Portable (Web Request / Response only).

const { ApiError } = require("./errors");

const BASE_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

function json(status, body, headers) {
  return new Response(JSON.stringify(body), { status, headers: Object.assign({}, BASE_HEADERS, headers || {}) });
}

function errorBody(err, requestId) {
  return { error: { code: err.code, message: err.message, details: err.details || {} }, requestId };
}

// Reads the JSON body with a hard size cap, enforced while streaming (a lying Content-Length does not help).
async function readJson(request, maxBytes) {
  const ct = (request.headers.get("content-type") || "").toLowerCase();
  if (!/^application\/json(\s*;\s*charset=utf-?8)?$/.test(ct.trim())) throw new ApiError("unsupported_media_type", "Send the request as application/json.");
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new ApiError("payload_too_large", "The request is too large.");
  let total = 0;
  const chunks = [];
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) { try { await reader.cancel(); } catch (e) { /* ignore */ } throw new ApiError("payload_too_large", "The request is too large."); }
      chunks.push(value);
    }
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.length; }
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(all); } catch (e) { throw new ApiError("bad_request", "The request is not valid UTF-8."); }
  if (!text.trim()) return {};
  try { return JSON.parse(text); } catch (e) { throw new ApiError("bad_request", "The request is not valid JSON."); }
}

function bearer(request) {
  const h = request.headers.get("authorization") || "";
  const m = /^Bearer ([A-Za-z0-9._~+/=:@-]{10,8192})$/.exec(h.trim());
  return m ? m[1] : null;
}

module.exports = { json, errorBody, readJson, bearer, BASE_HEADERS };
