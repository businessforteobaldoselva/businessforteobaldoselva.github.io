/* COVERED Studio overlay - ui/panel-account.js : who is signed in, sign in / out, build info. */
(function (S) {
  "use strict";
  var h = S.dom.h;

  var CAN = {
    editor: "Change text and pictures, save drafts, send them for review and undo past changes.",
    approver: "Everything an editor can, plus publish drafts that someone else prepared.",
    admin: "Everything an approver can, plus manage who has access.",
  };

  function render(container, studio) {
    var offs = [];
    function paint() {
      S.dom.clear(container);
      var me = studio.me;
      var cfg = studio.config;
      if (!cfg.apiBase) {
        container.appendChild(h("p", { class: "error" }, "Studio isn't connected to a service yet, so changes can't be saved from this preview."));
        container.appendChild(h("p", { class: "hint" }, "The site owner needs to finish the Studio setup (see studio/README.md). You can still look around."));
        return;
      }
      if (!me) {
        container.appendChild(h("p", null, "Sign in to edit this site. Nothing you do goes live without a second person publishing it."));
        var pc = studio.previewConfig;
        if (pc && pc.auth && pc.auth.mode === "dev") {
          container.appendChild(h("p", { class: "hint" }, "Test mode: this is the local practice version. Pick a practice person."));
          S.auth.DEV_PEOPLE.forEach(function (p) {
            container.appendChild(h("button", { type: "button", class: "btn", on: { click: function () { signIn(function () { return S.auth.signInDev(p); }); } } }, "Sign in as " + p.name + " (" + p.role + ")"));
          });
        } else if (pc) {
          container.appendChild(h("button", { type: "button", class: "btn btn-primary", on: { click: function () { signIn(function () { return S.auth.signInPopup().then(function () { return S.auth.loadMe(); }); }); } } }, "Sign in"));
          container.appendChild(h("p", { class: "hint" }, "A small window opens to send you an email code."));
        } else {
          container.appendChild(h("p", null, "Connecting…"));
        }
      } else {
        container.appendChild(h("p", null, h("strong", null, me.user.name || me.user.email), " ", h("span", { class: "hint" }, "(" + me.user.email + ")")));
        container.appendChild(h("p", null, "Role: ", h("strong", null, me.role)));
        container.appendChild(h("p", { class: "hint" }, CAN[me.role] || ""));
        container.appendChild(h("button", { type: "button", class: "btn", on: { click: function () { S.auth.signOut(); studio.setMode("browse"); } } }, "Sign out"));
      }
      var b = studio.config.build || {};
      var info = h("details", { class: "hint-d" }, h("summary", null, "About this preview"));
      info.appendChild(h("p", { class: "hint" }, "Built from " + (b.sha ? b.sha.slice(0, 7) : "unknown") + (b.branch ? " on " + b.branch : "") + (b.builtAt ? ", " + b.builtAt : "") + "."));
      if (studio.contentJson && studio.contentJson.schemaSha256 && studio.schema.raw.configSha256 && studio.contentJson.schemaSha256 !== studio.schema.raw.configSha256) {
        info.appendChild(h("p", { class: "warn" }, "The editing rules in this preview are out of date with the page. Rebuild the preview before saving."));
      }
      container.appendChild(info);
    }
    function signIn(fn) {
      Promise.resolve().then(fn).then(function () { studio.ui.toast("Signed in.", { kind: "success" }); studio.setMode("edit"); studio.ui.closePanel(); },
        function (e) { studio.ui.toast((e && (e.userMessage || e.message)) || "Sign-in failed.", { kind: "error" }); });
    }
    offs.push(studio.on("auth:change", paint));
    paint();
    return function () { offs.forEach(function (o) { o(); }); };
  }
  S.panelAccount = { render: render };
})(window.__CoveredStudioBoot);
