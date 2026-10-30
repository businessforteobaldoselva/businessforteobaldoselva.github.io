/* COVERED Studio overlay - core/images.js
   Picture handling in the browser: a quick type/size check, then a canvas re-encode to a JPEG of at most
   1.5 MB and 2400 px on the long side (which also strips EXIF/GPS), optionally cropped to the shape the picture
   has on the page. The crop is baked into the uploaded file - no focal point is stored (DESIGN section 16).
   cropRect() is pure and tested under node. */
(function (S) {
  "use strict";

  var MAX_INPUT_BYTES = 25 * 1024 * 1024;
  var MAX_OUT_BYTES = 1500 * 1024;
  var MAX_SIDE = 2400;
  // SVG is deliberately not accepted here: it can carry script, and a canvas re-encode would flatten it.
  var TYPES = { "image/jpeg": 1, "image/png": 1, "image/webp": 1, "image/gif": 1, "image/avif": 1 };

  function checkFile(file) {
    if (!file || typeof file.size !== "number") return { ok: false, message: "Pick a picture file." };
    if (!TYPES[file.type]) {
      if (file.type === "image/svg+xml") return { ok: false, message: "SVG drawings can't be added from Studio. Use a .jpg, .png or .webp picture." };
      return { ok: false, message: "That file isn't a picture Studio can use. Pick a .jpg, .png, .webp, .gif or .avif file." };
    }
    if (file.size > MAX_INPUT_BYTES) return { ok: false, message: "That picture is very large (over 25 MB). Pick a smaller one." };
    if (file.size === 0) return { ok: false, message: "That file is empty." };
    return { ok: true };
  }

  // The part of the source picture to keep. aspect = width/height wanted (null = whole picture).
  // focus 0..1 on each axis (0.5 = centred), zoom >= 1.
  function cropRect(srcW, srcH, aspect, fx, fy, zoom) {
    zoom = Math.max(1, Number(zoom) || 1);
    fx = Math.min(1, Math.max(0, fx == null ? 0.5 : fx));
    fy = Math.min(1, Math.max(0, fy == null ? 0.5 : fy));
    var w = srcW;
    var h = srcH;
    if (aspect && isFinite(aspect) && aspect > 0) {
      if (srcW / srcH > aspect) w = srcH * aspect; else h = srcW / aspect;
    }
    w /= zoom;
    h /= zoom;
    var x = (srcW - w) * fx;
    var y = (srcH - h) * fy;
    return { x: x, y: y, w: w, h: h };
  }
  function fitSize(w, h, maxSide) {
    var k = Math.min(1, maxSide / Math.max(w, h));
    return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
  }

  // A file name the server accepts: letters/numbers/dot/dash, <= 80 chars, ends .jpg
  function safeName(original) {
    var stem = String(original || "picture").replace(/\.[A-Za-z0-9]+$/, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "picture";
    var rnd = S.util.uuid().replace(/-/g, "").slice(0, 5);
    return stem + "-" + rnd + ".jpg";
  }

  function decode(file) {
    if (typeof createImageBitmap === "function") return createImageBitmap(file);
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.addEventListener("load", function () { URL.revokeObjectURL(url); resolve(img); });
      img.addEventListener("error", function () { URL.revokeObjectURL(url); reject(new Error("decode")); });
      img.src = url;
    });
  }
  function toBlob(canvas, quality) {
    return new Promise(function (resolve) { canvas.toBlob(resolve, "image/jpeg", quality); });
  }

  // file -> { blob, name, contentType, size, width, height }.  opts: { aspect, fx, fy, zoom }
  function process(file, opts) {
    opts = opts || {};
    var check = checkFile(file);
    if (!check.ok) return Promise.reject(new Error(check.message));
    return decode(file).then(function (img) {
      var sw = img.width || img.naturalWidth;
      var sh = img.height || img.naturalHeight;
      if (!sw || !sh) throw new Error("That picture could not be read.");
      var r = cropRect(sw, sh, opts.aspect, opts.fx, opts.fy, opts.zoom);
      var size = fitSize(r.w, r.h, MAX_SIDE);
      var best = null;
      var step = function (scale, quality) {
        var c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(size.w * scale));
        c.height = Math.max(1, Math.round(size.h * scale));
        var ctx = c.getContext("2d");
        ctx.fillStyle = "#ffffff"; // transparent PNGs/GIFs would otherwise turn black in a JPEG
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(img, r.x, r.y, r.w, r.h, 0, 0, c.width, c.height);
        return toBlob(c, quality).then(function (b) {
          if (!b) throw new Error("This browser could not prepare the picture.");
          best = { blob: b, width: c.width, height: c.height };
          return b;
        });
      };
      var tries = [[1, 0.88], [1, 0.8], [1, 0.7], [0.8, 0.7], [0.65, 0.68], [0.5, 0.65], [0.35, 0.6]];
      var i = 0;
      var loop = function () {
        var t = tries[i];
        return step(t[0], t[1]).then(function (b) {
          if (b.size <= MAX_OUT_BYTES || i === tries.length - 1) return;
          i += 1;
          return loop();
        });
      };
      return loop().then(function () {
        if (img.close) img.close();
        if (best.blob.size > MAX_OUT_BYTES) throw new Error("That picture is too detailed to shrink enough. Try a smaller one.");
        return { blob: best.blob, name: safeName(file.name), contentType: "image/jpeg", size: best.blob.size, width: best.width, height: best.height };
      });
    });
  }

  S.images = { checkFile: checkFile, cropRect: cropRect, fitSize: fitSize, safeName: safeName, process: process, decode: decode, MAX_OUT_BYTES: MAX_OUT_BYTES, MAX_SIDE: MAX_SIDE };
})(window.__CoveredStudioBoot);
