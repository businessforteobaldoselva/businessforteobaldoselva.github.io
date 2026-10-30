/* COVERED Studio overlay - core/auth.js
   Token handling. The access token lives in memory only. Two modes (from GET /v1/preview-config):
   - "dev": the local stub; a person is picked in the panel and the token "dev:<role>:<email>" is built here.
   - "supabase": a popup to the login page (STUDIO_APP_URL, a separate origin) sends the token back with
     postMessage; the overlay accepts messages only from that origin AND only from the popup it opened. */
(function (S) {
  "use strict";
  var DEV_PEOPLE = [
    { name: "Molly", role: "editor", email: "molly@covered.test" },
    { name: "Amelia", role: "approver", email: "amelia@covered.test" },
    { name: "Teo", role: "admin", email: "teo@covered.test" },
  ];
  var token = null;
  var expiresAt = 0;
  var popup = null;
  var waiting = null;
  var listening = false;

  function appOrigin() {
    try { return new URL(S.state.config.appUrl).origin; } catch (e) { return null; }
  }
  function onMessage(ev) {
    var origin = appOrigin();
    if (!origin || ev.origin !== origin) return;
    if (!popup || ev.source !== popup) return;
    var d = ev.data;
    if (!d || d.type !== "covered-studio-token" || typeof d.accessToken !== "string" || d.accessToken.length > 8192) return;
    token = d.accessToken;
    var exp = Number(d.expiresAt);
    expiresAt = exp > 0 ? (exp < 1e12 ? exp * 1000 : exp) : Date.now() + 55 * 60 * 1000;
    try { popup.close(); } catch (e) { /* ignore */ }
    popup = null;
    var w = waiting;
    waiting = null;
    if (w) w.resolve(token);
  }
  function listen() {
    if (listening) return;
    listening = true;
    window.addEventListener("message", onMessage);
  }

  // Must be called from a user gesture (popup blockers). Resolves with the token.
  function signInPopup() {
    listen();
    var base = S.state.config.appUrl;
    if (!base) return Promise.reject(S.api.StudioError(0, "unauthorized", "The sign-in page is not configured for this preview."));
    var u = base.replace(/\/+$/, "") + "/?origin=" + encodeURIComponent(location.origin);
    popup = window.open(u, "covered-studio-login", "popup,width=460,height=640");
    if (!popup) return Promise.reject(S.api.StudioError(0, "unauthorized", "Your browser blocked the sign-in window. Allow pop-ups for this site and try again."));
    return new Promise(function (resolve, reject) {
      waiting = { resolve: resolve, reject: reject };
      var t = setInterval(function () {
        if (!popup || popup.closed) {
          clearInterval(t);
          if (waiting) { waiting.reject(S.api.StudioError(0, "unauthorized", "Sign-in was cancelled.")); waiting = null; }
        }
      }, 600);
    });
  }

  function getToken() {
    if (token && Date.now() < expiresAt - 30000) return token;
    token = null;
    return null;
  }
  // Loads /v1/me with the current token and publishes the result.
  function loadMe() {
    return S.api.get("/v1/me").then(function (me) {
      S.state.me = me;
      S.events.emit("auth:change", { me: me });
      return me;
    });
  }
  function signInDev(person) {
    token = "dev:" + person.role + ":" + person.email;
    expiresAt = Date.now() + 8 * 3600 * 1000;
    S.util.session.set("covered.studio.devUser", person.email);
    return loadMe().catch(function (e) { token = null; throw e; });
  }
  function signOut() {
    token = null;
    expiresAt = 0;
    S.state.me = null;
    S.util.session.del("covered.studio.devUser");
    S.events.emit("auth:change", { me: null });
  }

  S.auth = {
    DEV_PEOPLE: DEV_PEOPLE,
    getToken: getToken,
    signInPopup: signInPopup,
    signInDev: signInDev,
    signOut: signOut,
    loadMe: loadMe,
    needsRefreshSoon: function () { return !!token && Date.now() > expiresAt - 2 * 60 * 1000; },
    _accept: onMessage,
    _setPopup: function (p) { popup = p; },
    rememberedDevUser: function () {
      var e = S.util.session.get("covered.studio.devUser");
      return DEV_PEOPLE.filter(function (p) { return p.email === e; })[0] || null;
    },
  };
})(window.__CoveredStudioBoot);
