/* COVERED Studio - login page script (the token broker, DESIGN 8.5).
   A static page on its OWN origin (STUDIO_APP_URL), separate from every preview. It signs a person in with
   Supabase Auth over plain fetch (email code; no SDK, no third-party script) and hands the short-lived access token to
   the overlay that opened it with postMessage - to the exact origin named in ?origin= and ONLY if that origin passes
   the same allow rule as the API (an exact list, or one structural template such as
   https://deploy-preview-{n}--site.netlify.app). The refresh token stays in this origin's localStorage (try/catch).
   Everything shown is written with textContent. */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else api.boot(root);
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var TEMPLATE_N = "{n}";

  // https://... or http://localhost[:port] / 127.0.0.1[:port] - nothing else, no path, no credentials
  function wellFormedOrigin(o) {
    if (typeof o !== "string" || o.length > 200) return false;
    var u;
    try { u = new URL(o); } catch (e) { return false; }
    if (u.origin !== o || u.username || u.password) return false;
    if (u.protocol === "https:") return true;
    return u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1");
  }
  // The template: "{n}" matches 1-6 digits, everything else is literal (escaped). Anchored. Not a wildcard.
  function templateRegExp(template) {
    if (typeof template !== "string" || !template || template.length > 200 || template.indexOf(TEMPLATE_N) < 0) return null;
    var parts = template.split(TEMPLATE_N).map(function (p) { return p.replace(/[.*+?^${}()|[\]\\\/-]/g, "\\$&"); });
    return new RegExp("^" + parts.join("[0-9]{1,6}") + "$");
  }
  function originAllowed(origin, cfg) {
    if (!wellFormedOrigin(origin)) return false;
    cfg = cfg || {};
    var list = Array.isArray(cfg.allowedOrigins) ? cfg.allowedOrigins : [];
    if (list.indexOf(origin) >= 0) return true;
    var re = templateRegExp(cfg.previewOriginTemplate);
    return !!(re && re.test(origin));
  }

  // ---- the page ------------------------------------------------------------
  function boot(win) {
    var doc = win.document;
    if (!doc || !doc.getElementById("studio-login")) return;
    var $ = function (id) { return doc.getElementById(id); };
    var status = $("status");
    var steps = { email: $("step-email"), code: $("step-code"), done: $("step-done"), refused: $("step-refused") };
    var store = { get: function (k) { try { return win.localStorage.getItem(k); } catch (e) { return null; } }, set: function (k, v) { try { win.localStorage.setItem(k, v); } catch (e) { /* ignore */ } }, del: function (k) { try { win.localStorage.removeItem(k); } catch (e) { /* ignore */ } } };
    var RT = "covered.studio.login.rt";
    var cfg = null;
    var pc = null;
    var targetOrigin = null;
    var email = "";

    function say(msg, bad) { status.textContent = msg; status.setAttribute("data-bad", bad ? "1" : "0"); }
    function show(name) { Object.keys(steps).forEach(function (k) { steps[k].hidden = k !== name; }); var f = steps[name].querySelector("input,button"); if (f) f.focus(); }
    function jsonFetch(url, init) {
      return win.fetch(url, init).then(function (r) { return r.text().then(function (t) { var d = null; try { d = t ? JSON.parse(t) : null; } catch (e) { d = null; } if (!r.ok) { var err = new Error((d && (d.msg || d.error_description || d.message)) || "Request failed"); err.status = r.status; throw err; } return d; }); });
    }
    function sb(path, body, query) {
      return jsonFetch(pc.auth.supabaseUrl.replace(/\/+$/, "") + "/auth/v1" + path + (query || ""), { method: "POST", headers: { "Content-Type": "application/json", apikey: pc.auth.supabaseAnonKey }, body: JSON.stringify(body), credentials: "omit", cache: "no-store" });
    }
    function deliver(session) {
      if (session.refresh_token) store.set(RT, session.refresh_token);
      if (!win.opener || win.opener.closed) { say("Signed in, but the page that opened this window is gone. Close this window and try again.", true); return; }
      win.opener.postMessage({ type: "covered-studio-token", accessToken: session.access_token, expiresAt: session.expires_at || Math.floor(Date.now() / 1000) + (session.expires_in || 3600) }, targetOrigin);
      show("done");
      say("You're signed in. This window will close.");
      win.setTimeout(function () { try { win.close(); } catch (e) { /* ignore */ } }, 400);
    }

    var params = new URLSearchParams(win.location.search);
    var asked = params.get("origin");

    jsonFetch("config.json", { credentials: "omit", cache: "no-store" }).then(function (c) {
      cfg = c || {};
      if (!originAllowed(asked, cfg)) { show("refused"); say("This sign-in page can't be opened from there.", true); return null; }
      targetOrigin = asked;
      if (!cfg.api || !wellFormedOrigin(cfg.api)) { say("Studio sign-in is not set up yet (no service address).", true); return null; }
      return jsonFetch(cfg.api.replace(/\/+$/, "") + "/v1/preview-config", { credentials: "omit", cache: "no-store" });
    }).then(function (p) {
      if (!p) return;
      pc = p;
      if (!pc.auth || pc.auth.mode !== "supabase" || !pc.auth.supabaseUrl || !pc.auth.supabaseAnonKey) { say("Studio sign-in is not set up yet.", true); return; }
      var rt = store.get(RT);
      if (rt) {
        sb("/token", { refresh_token: rt }, "?grant_type=refresh_token").then(deliver, function () { store.del(RT); show("email"); say(""); });
      } else { show("email"); say(""); }
    }).catch(function () { say("Could not reach the Studio service. Check your connection and reload.", true); });

    $("form-email").addEventListener("submit", function (e) {
      e.preventDefault();
      email = $("email").value.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { say("Type your email address.", true); return; }
      say("Sending a code…");
      sb("/otp", { email: email, create_user: false }).then(function () { show("code"); say("We sent a code to " + email + ". It can take a minute."); }, function () { say("We could not send a code. Check the address (only invited people can sign in).", true); });
    });
    $("form-code").addEventListener("submit", function (e) {
      e.preventDefault();
      var code = $("code").value.replace(/\s+/g, "");
      if (!/^[0-9]{6,8}$/.test(code)) { say("The code is 6 to 8 digits.", true); return; }
      say("Checking…");
      sb("/verify", { type: "email", email: email, token: code }).then(deliver, function () { say("That code didn't work. Check it, or go back and ask for a new one.", true); });
    });
    $("back").addEventListener("click", function () { show("email"); say(""); });
  }

  return { originAllowed: originAllowed, templateRegExp: templateRegExp, wellFormedOrigin: wellFormedOrigin, boot: boot };
});
