"use strict";
// API errors (DESIGN 7.2). One class, one place that decides the HTTP status. Portable.

const STATUS = {
  bad_request: 400, unauthorized: 401, not_invited: 403, forbidden: 403, not_found: 404,
  conflict: 409, draft_moved: 409, base_moved: 409, not_ready: 409,
  payload_too_large: 413, unsupported_media_type: 415, validation_failed: 422,
  rate_limited: 429, upstream_error: 502, internal: 500,
};

class ApiError extends Error {
  constructor(code, message, details, extra) {
    super(message || code);
    this.name = "ApiError";
    this.code = STATUS[code] ? code : "internal";
    this.status = STATUS[this.code];
    this.details = details || {};
    this.headers = (extra && extra.headers) || {};
  }
}

module.exports = { ApiError, STATUS };
