/* COVERED Studio overlay - core/state.js : the small shared state object (read by every module). */
(function (S) {
  "use strict";
  S.state = {
    mode: "browse",       // "browse" | "edit"
    me: null,             // { user, role, capabilities }
    config: { apiBase: "", appUrl: "", contentUrl: "/studio/content.json", build: { sha: null, branch: null, prNumber: null }, dev: false },
    previewConfig: null,  // GET /v1/preview-config
    content: null,        // content.json (base snapshot)
    selected: null,       // ref of the selected element
    online: true,
  };
})(window.__CoveredStudioBoot);
