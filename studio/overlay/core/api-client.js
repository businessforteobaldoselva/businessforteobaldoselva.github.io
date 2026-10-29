/* COVERED Studio overlay - core/api-client.js
   The ONLY place that talks to the Studio API (one fetch call site). Adds the bearer token, never cookies
   (credentials: "omit"), speaks JSON, and turns every failure into a StudioError with a human message. */
(function (S) {
  "use strict";

  function StudioError(status, code, message, details, requestId) {
    var e = new Error(message || code || "Request failed");
    e.name = "StudioError";
    e.status = status;
    e.code = code;
    e.details = details || null;
    e.requestId = requestId || null;
    return e;
  }

  // What a founder reads, per error code (DESIGN 7.2).
  function humanMessage(err) {
    if (!err) return "Something went wrong.";
    switch (err.code) {
      case "offline": return "You seem to be offline. Your changes are kept on this device and nothing is lost.";
      case "unauthorized": return "Your sign-in has expired. Please sign in again.";
      case "not_invited": return "You are signed in, but you have not been invited to edit this site yet. Ask an admin to add you.";
      case "forbidden": return "You don't have permission to do that.";
      case "not_found": return "That draft could not be found. It may have been published or discarded.";
      case "conflict": return "Someone else changed some of these things since you started.";
      case "draft_moved": return "This draft was changed somewhere else. Refresh to get the latest version.";
      case "base_moved": return "The live site changed while you were editing. Refresh to see the latest, then try again.";
      case "not_ready": return notReadyText(err.details && err.details.reason);
      case "payload_too_large": return "That is too much to send at once. Try fewer or smaller pictures.";
      case "unsupported_media_type": return "The server did not understand what was sent. Please reload the page.";
      case "validation_failed": return "Some of your changes can't be saved yet. Fix the items marked in red.";
      case "rate_limited": return "You're going a bit fast. Wait a moment and try again.";
      case "upstream_error": return "The publishing service is having trouble. Try again in a minute.";
      case "bad_request": return "The request was not understood. Please reload the page and try again.";
      default: return "Something went wrong on our side. Nothing was lost; try again in a moment.";
    }
  }
  function notReadyText(reason) {
    switch (reason) {
      case "checks_pending": return "The automatic checks are still running. Try again in a minute.";
      case "checks_failed": return "The automatic checks found a problem, so this can't be published yet.";
      case "not_mergeable": return "This draft can't be merged right now. Refresh it first.";
      case "draft_state": return "Send the draft for review first.";
      case "self_publish": return "Someone else has to publish your changes (two people always look before anything goes live).";
      case "head_changed": return "The draft changed after you looked at it. Refresh and check again.";
      default: return "This can't be published yet.";
    }
  }

  var cfg = { base: "", getToken: null, timeoutMs: 30000 };
  function configure(c) { Object.assign(cfg, c || {}); }

  function request(method, path, body, opts) {
    opts = opts || {};
    if (!cfg.base) return Promise.reject(StudioError(0, "offline", "Studio API is not configured."));
    var url = cfg.base.replace(/\/+$/, "") + path;
    return Promise.resolve(opts.noAuth || !cfg.getToken ? null : cfg.getToken()).then(function (token) {
      var headers = { Accept: "application/json" };
      if (token) headers.Authorization = "Bearer " + token;
      if (body !== undefined) headers["Content-Type"] = "application/json";
      var ctl = typeof AbortController === "function" ? new AbortController() : null;
      var timer = ctl ? setTimeout(function () { ctl.abort(); }, cfg.timeoutMs) : null;
      return fetch(url, { method: method, headers: headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: "omit", mode: "cors", cache: "no-store", signal: ctl ? ctl.signal : undefined })
        .then(
          function (res) {
            if (timer) clearTimeout(timer);
            var retryAfter = Number(res.headers.get("Retry-After")) || 0;
            return res.text().then(function (txt) {
              var data = null;
              try { data = txt ? JSON.parse(txt) : null; } catch (e) { data = null; }
              if (res.ok) return data || {};
              var er = data && data.error ? data.error : {};
              var se = StudioError(res.status, er.code || "internal", er.message, er.details, data && data.requestId);
              se.retryAfter = retryAfter;
              se.userMessage = humanMessage(se);
              throw se;
            });
          },
          function () {
            if (timer) clearTimeout(timer);
            var se = StudioError(0, "offline", "Network error");
            se.userMessage = humanMessage(se);
            throw se;
          }
        );
    });
  }

  S.api = {
    configure: configure,
    get: function (p, o) { return request("GET", p, undefined, o); },
    post: function (p, b, o) { return request("POST", p, b === undefined ? {} : b, o); },
    put: function (p, b, o) { return request("PUT", p, b === undefined ? {} : b, o); },
    del: function (p, o) { return request("DELETE", p, undefined, o); },
    StudioError: StudioError,
    humanMessage: humanMessage,
  };
})(window.__CoveredStudioBoot);
