const fs = require("fs");
const path = require("path");

// Data-driven enquiry forms (src/_data/brands.json, venues.json -> "form").
//
// A form is { fields: [...], button, hint, sending, success, mailto: {...} }.
// The templates never touch raw field data: everything goes through the
// filters below, which whitelist the input type, make sure `id` and `name`
// are unique, well-formed and cannot clash with the reserved Netlify inputs,
// and derive both from the label for fields an editor added in the CMS.
//
//   {% set fields = brands.form | formFields("bf") %}      -> render these
//   {{ brands.form | formScript("bf") | dump | ... }}      -> same fields, for the JS
//   {{ photo.tilt | safeTilt }}                            -> "-2deg"
//   {{ video | siteMediaPath }}                            -> "/images/x.mp4" | ""
const TYPES = ["text", "email", "tel", "textarea", "select"];
const RESERVED_NAMES = new Set(["form-name", "bot-field"]);
// Explicit ids (kept in the data for the original fields, e.g. "bName") must look
// like one lowercase letter + a capital: no section, script or layout id on the
// page has that shape, so a stored id can never shadow one of them.
const SAFE_ID = /^[a-z][A-Z][A-Za-z0-9]{1,30}$/;
const SAFE_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
const ROOT = process.cwd();
const MEDIA_PATH = /^\/?images\/[A-Za-z0-9._\/-]+\.(mp4|webm|m4v|mov|jpe?g|png|webp|gif|avif|svg)$/i;

const text = (v) => (typeof v === "string" ? v.trim() : "");

function slug(value) {
  return text(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32);
}

// Unique-ify `wanted` against `used` (a Set) by appending _2, _3, ...
function unique(wanted, used) {
  let candidate = wanted;
  for (let n = 2; used.has(candidate.toLowerCase()); n += 1) {
    candidate = wanted + "_" + n;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

function resolveFields(form, prefix) {
  const raw = form && Array.isArray(form.fields) ? form.fields : [];
  const pre = /^[a-z]{1,6}$/.test(prefix) ? prefix : "f";
  const usedNames = new Set(RESERVED_NAMES);
  const usedIds = new Set();
  const out = [];
  raw.forEach((f, i) => {
    if (!f || typeof f !== "object") return;
    const label = text(f.label);
    if (!label) return; // a field without a label cannot be used by screen readers
    const type = TYPES.includes(f.type) ? f.type : "text";
    const options = (Array.isArray(f.options) ? f.options : []).map(text).filter(Boolean);
    const emptyOption = text(f.emptyOption);
    if (type === "select" && !options.length && !emptyOption) return;

    const base = slug(label) || "field_" + (i + 1);
    const wantedName = SAFE_NAME.test(text(f.name)) ? text(f.name) : /^[a-z]/.test(base) ? base : "f_" + base;
    const name = unique(wantedName, usedNames);
    const wantedId = SAFE_ID.test(text(f.id)) ? text(f.id) : pre + "_" + name;
    const id = unique(wantedId, usedIds);

    const mail = f.mail && typeof f.mail === "object" ? f.mail : {};
    const hint = text(f.hint);
    out.push({
      type,
      id,
      name,
      label,
      required: f.required === true,
      placeholder: type === "select" ? "" : text(f.placeholder),
      autocomplete: text(f.autocomplete),
      hint,
      hintId: hint ? id + "_hint" : "",
      options: type === "select" ? options : [],
      emptyOption: type === "select" ? emptyOption : "",
      full: f.width === "full" || (!f.width && type === "textarea"),
      mailLabel: text(mail.label) || label,
      mailEmpty: text(mail.ifEmpty),
      block: type === "textarea",
    });
  });
  return out;
}

module.exports = function (eleventyConfig) {
  eleventyConfig.addFilter("formFields", (form, prefix) => resolveFields(form, prefix));

  // Everything the submit script needs (button text while sending, success
  // note, the mailto fallback and the fields it lists in the e-mail body).
  eleventyConfig.addFilter("formScript", (form, prefix) => {
    const f = form && typeof form === "object" ? form : {};
    const mailto = f.mailto && typeof f.mailto === "object" ? f.mailto : {};
    return {
      sending: text(f.sending),
      success: text(f.success),
      subject: text(mailto.subject),
      greeting: text(mailto.greeting),
      intro: text(mailto.intro),
      signoff: text(mailto.signoff),
      fields: resolveFields(f, prefix).map((x) => ({
        name: x.name,
        label: x.mailLabel,
        ifEmpty: x.mailEmpty,
        block: x.block,
      })),
    };
  });

  // Polaroid tilt: a number of degrees (or "-2deg") -> "-2deg". Anything else
  // is 0deg, so an edited value can never add CSS to the style attribute.
  eleventyConfig.addFilter("safeTilt", (value) => {
    const n = typeof value === "number" ? value : parseFloat(String(value == null ? "" : value));
    if (!isFinite(n) || Math.abs(n) > 20) return "0deg";
    return Math.round(n * 100) / 100 + "deg";
  });

  // Video / poster files: only an existing file under /images/ is emitted,
  // always with exactly one leading slash. "" when unsafe or missing.
  eleventyConfig.addFilter("siteMediaPath", (value) => {
    const v = text(value);
    if (!MEDIA_PATH.test(v) || v.split("/").includes("..")) return "";
    const rel = v.replace(/^\//, "");
    return fs.existsSync(path.join(ROOT, rel)) ? "/" + rel : "";
  });
};
