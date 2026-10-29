/* COVERED Studio overlay - core/validate-client.js
   Advisory, instant checks of one value against its schema field (same rules as the server, section 6 stage 5).
   The server is authoritative; this only gives people a reason next to the field before they save.
   validate(field, value, ctx) -> [{ code, message }]   (empty = fine) */
(function (S) {
  "use strict";
  var LINK_RE = /^(\/(?!\/)\S*|#\S+|https?:\/\/\S+|mailto:\S+)$/;
  var HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
  var CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
  var BIDI = /[\u202a-\u202e\u2066-\u2069]/;

  function p(code, message) { return { code: code, message: message }; }

  function validate(field, value, ctx) {
    ctx = ctx || {};
    var limits = ctx.limits || { string: 20000, markdown: 60000 };
    var out = [];
    if (!field) return out;
    var w = field.widget || "string";
    var req = field.required !== false;
    var x = field.x || {};

    if (w === "boolean") {
      if (value !== true && value !== false) out.push(p("type", "This must be on or off."));
      return out;
    }
    if (w === "number") {
      if (typeof value !== "number" || !isFinite(value)) { out.push(p("type", "Enter a number.")); return out; }
      if (field.valueType === "int" && Math.floor(value) !== value) out.push(p("type", "Enter a whole number."));
      if (typeof field.min === "number" && value < field.min) out.push(p("range", "The smallest allowed number is " + field.min + "."));
      if (typeof field.max === "number" && value > field.max) out.push(p("range", "The largest allowed number is " + field.max + "."));
      return out;
    }
    if (w === "select") {
      var vals = (field.options || []).map(function (o) { return o && typeof o === "object" ? o.value : o; });
      var list = field.multiple ? (Array.isArray(value) ? value : [value]) : [value];
      list.forEach(function (v) { if (vals.indexOf(v) < 0) out.push(p("option", "Pick one of the choices offered.")); });
      return out;
    }
    if (w === "string" || w === "text" || w === "markdown" || w === "color" || w === "image") {
      if (typeof value !== "string") { out.push(p("type", "This must be text.")); return out; }
      var v = value.replace(/\r\n/g, "\n");
      var max = w === "markdown" ? limits.markdown : limits.string;
      if (typeof field.max === "number" && w !== "list") max = Math.min(max, field.max);
      if (v.length > max) { out.push(p("too_large", "That is too long: " + v.length + " characters, the most allowed here is " + max + ".")); return out; }
      if (CONTROL.test(v)) out.push(p("encoding", "Remove the hidden control characters."));
      if (BIDI.test(v)) out.push(p("encoding", "Remove the hidden text-direction characters (they can make text read back to front)."));
      if ((w === "string" || w === "color" || w === "image") && /\n/.test(v)) out.push(p("encoding", "This must be a single line."));
      if (req && v.trim() === "") { out.push(p("required", "This can't be empty.")); return out; }
      if (v === "" && !req) return out;
      if (w === "color") {
        if (!HEX.test(v)) out.push(p("color", "Use a colour like #FFEFDA."));
        return out;
      }
      if (field.pattern && field.pattern.source) {
        var re = null;
        try { re = new RegExp(field.pattern.source); } catch (e) { re = null; }
        if (re && !re.test(v)) out.push(p("pattern", field.pattern.message || "That doesn't look right."));
      }
      if (x.rule === "url" && !LINK_RE.test(v)) out.push(p("url", "Start with / for a page here, https:// for another website, # for a spot on this page, or mailto: for an email."));
      if (x.rule === "anchor" && v !== "") {
        if (!/^[a-z0-9-]+$/.test(v)) out.push(p("anchor", "Use only lower-case letters, numbers and dashes."));
        else if ((ctx.reservedIds || []).indexOf(v) >= 0) out.push(p("anchor", "The site already uses that name for something else. Pick another."));
      }
      if (w === "image" && v !== "" && !/\.(jpe?g|png|webp|gif|avif|svg)$/i.test(v)) out.push(p("image", "Pick a picture file (.jpg, .png, .webp, .gif, .avif or .svg)."));
      return out;
    }
    return out;
  }
  S.validateClient = { validate: validate, LINK_RE: LINK_RE, HEX: HEX };
})(window.__CoveredStudioBoot);
