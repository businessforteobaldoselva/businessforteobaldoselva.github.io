/* COVERED Studio overlay - core/events.js : a tiny event emitter (window.CoveredStudio.on / emit). */
(function (S) {
  "use strict";
  var handlers = {};
  function on(event, fn) {
    (handlers[event] = handlers[event] || []).push(fn);
    return function off() {
      var l = handlers[event] || [];
      var i = l.indexOf(fn);
      if (i >= 0) l.splice(i, 1);
    };
  }
  function emit(event, detail) {
    (handlers[event] || []).slice().forEach(function (fn) {
      try { fn(detail); } catch (e) { if (typeof console !== "undefined") console.error("[studio] handler for " + event + " failed", e); }
    });
  }
  S.events = { on: on, emit: emit };
})(window.__CoveredStudioBoot);
