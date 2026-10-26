/* Signature Maker — strokes are kept in memory only; nothing about the signature is stored or sent. */
(function () {
  "use strict";
  var $ = S3.$, $$ = S3.$$, h = S3.h;
  var FONTS = ["Segoe Script", "Brush Script MT", "Lucida Handwriting", "Freestyle Script", "Mistral", "Ink Free", "Segoe Print",
    "Snell Roundhand", "Apple Chancery", "Bradley Hand", "Savoye LET", "Zapfino", "Noteworthy", "URW Chancery L", "Z003",
    "Dancing Script", "Great Vibes", "Pacifico", "Satisfy", "Comic Sans MS"];
  var saved = S3.store("signature.settings") || {};
  var st = {
    mode: saved.mode === "type" ? "type" : "draw",
    color: /^#[0-9a-f]{6}$/i.test(saved.color) ? saved.color : "#1d3a8a",
    width: +saved.width >= 1 && +saved.width <= 12 ? +saved.width : 3.5,
    dynamic: saved.dynamic !== false,
    font: typeof saved.font === "string" ? saved.font : "",
    size: +saved.size >= 28 && +saved.size <= 120 ? +saved.size : 64
  };
  var strokes = [], history = [], live = null;
  var cv = $("#cv"), ctx = cv.getContext("2d"), pad = $("#pad");

  function remember() { S3.store("signature.settings", { mode: st.mode, color: st.color, width: st.width, dynamic: st.dynamic, font: st.font, size: st.size }); }

  // ---------- geometry (pure, tested) ----------
  function mid(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, w: (a.w + b.w) / 2 }; }
  // Quadratic segments through the midpoints: smooth curves that pass near every sample.
  function segments(p) {
    var out = [], a = p[0];
    for (var i = 1; i < p.length; i++) {
      var c = p[i], e = i < p.length - 1 ? mid(p[i], p[i + 1]) : p[i];
      out.push({ a: a, c: c, e: e, w: c.w });
      a = e;
    }
    return out;
  }
  // Faster pen → thinner line; real pen pressure wins when the device reports it.
  function targetWidth(base, speed, pressure) {
    if (pressure > 0 && pressure !== 0.5) return base * (0.35 + pressure * 1.3);
    return base * Math.max(0.4, Math.min(1.5, 1.5 - speed * 0.45));
  }
  function bbox(list) {
    var b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    list.forEach(function (s) {
      s.forEach(function (p) {
        var r = p.w / 2 + 1;
        b.x0 = Math.min(b.x0, p.x - r); b.y0 = Math.min(b.y0, p.y - r); b.x1 = Math.max(b.x1, p.x + r); b.y1 = Math.max(b.y1, p.y + r);
      });
    });
    return isFinite(b.x0) ? b : null;
  }
  function paint(c, list, color, ox, oy, scale) {
    c.save(); c.scale(scale, scale); c.translate(-ox, -oy);
    c.strokeStyle = c.fillStyle = color; c.lineCap = "round"; c.lineJoin = "round";
    list.forEach(function (s) {
      if (s.length === 1) { c.beginPath(); c.arc(s[0].x, s[0].y, s[0].w / 2, 0, Math.PI * 2); c.fill(); return; }
      segments(s).forEach(function (g) {
        c.beginPath(); c.lineWidth = g.w; c.moveTo(g.a.x, g.a.y); c.quadraticCurveTo(g.c.x, g.c.y, g.e.x, g.e.y); c.stroke();
      });
    });
    c.restore();
  }
  function r2(n) { return Math.round(n * 100) / 100; }
  function toSVG(list, color) {
    var b = bbox(list); if (!b) return "";
    var pad = 4, w = r2(b.x1 - b.x0 + pad * 2), hh = r2(b.y1 - b.y0 + pad * 2), ox = b.x0 - pad, oy = b.y0 - pad, body = "";
    list.forEach(function (s) {
      if (s.length === 1) { body += '<circle cx="' + r2(s[0].x - ox) + '" cy="' + r2(s[0].y - oy) + '" r="' + r2(s[0].w / 2) + '"/>'; return; }
      segments(s).forEach(function (g) {
        body += '<path fill="none" d="M' + r2(g.a.x - ox) + " " + r2(g.a.y - oy) + "Q" + r2(g.c.x - ox) + " " + r2(g.c.y - oy) + " " + r2(g.e.x - ox) + " " + r2(g.e.y - oy) + '" stroke-width="' + r2(g.w) + '"/>';
      });
    });
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + hh + '" viewBox="0 0 ' + w + " " + hh + '">' +
      '<g fill="' + color + '" stroke="' + color + '" stroke-linecap="round" stroke-linejoin="round">' + body + "</g></svg>";
  }
  // Crop a canvas to its non-transparent pixels (+pad). Returns null when empty.
  function trimCanvas(src, padPx) {
    var w = src.width, hh = src.height, d = src.getContext("2d").getImageData(0, 0, w, hh).data;
    var x0 = w, y0 = hh, x1 = -1, y1 = -1;
    for (var y = 0; y < hh; y++) for (var x = 0; x < w; x++) {
      if (d[(y * w + x) * 4 + 3] > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    if (x1 < 0) return null;
    padPx = padPx || 0;
    var out = document.createElement("canvas");
    out.width = x1 - x0 + 1 + padPx * 2; out.height = y1 - y0 + 1 + padPx * 2;
    out.getContext("2d").drawImage(src, x0, y0, x1 - x0 + 1, y1 - y0 + 1, padPx, padPx, x1 - x0 + 1, y1 - y0 + 1);
    return out;
  }
  function hasFont(name) {
    var c = document.createElement("canvas").getContext("2d"), t = "Signature mwlli 0123", base = {};
    return ["monospace", "serif"].some(function (g) {
      c.font = "40px " + g; base = c.measureText(t).width;
      c.font = '40px "' + name + '", ' + g; return c.measureText(t).width !== base;
    });
  }
  function typedFont() { return st.font === "cursive" || !st.font ? "cursive" : '"' + st.font + '", cursive'; }

  // ---------- pad ----------
  function size() {
    var r = pad.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr);
    draw();
  }
  function draw() {
    var dpr = cv.width / (pad.clientWidth || 1);
    ctx.clearRect(0, 0, cv.width, cv.height);
    if (st.mode === "draw") paint(ctx, live ? strokes.concat([live]) : strokes, st.color, 0, 0, dpr);
    else if (st.text) {
      ctx.save(); ctx.scale(dpr, dpr); ctx.fillStyle = st.color; ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
      ctx.font = st.size + "px " + typedFont();
      var w = pad.clientWidth, s = st.size, m;
      while ((m = ctx.measureText(st.text).width) > w - 40 && s > 12) { s -= 2; ctx.font = s + "px " + typedFont(); }
      ctx.fillText(st.text, w / 2, pad.clientHeight * 0.68);
      ctx.restore();
    }
    $("#hint").hidden = st.mode === "draw" ? strokes.length > 0 || !!live : !!st.text;
  }
  var frame = 0;
  function drawSoon() { if (!frame) frame = requestAnimationFrame(function () { frame = 0; draw(); }); }

  function pt(e, prev) {
    var r = cv.getBoundingClientRect(), p = { x: e.clientX - r.left, y: e.clientY - r.top, t: e.timeStamp };
    if (!st.dynamic) p.w = st.width;
    else if (!prev) p.w = targetWidth(st.width, 0, e.pointerType === "pen" ? e.pressure : 0);
    else {
      var dt = Math.max(1, p.t - prev.t), speed = Math.hypot(p.x - prev.x, p.y - prev.y) / dt;
      p.w = prev.w * 0.65 + targetWidth(st.width, speed, e.pointerType === "pen" ? e.pressure : 0) * 0.35;
    }
    return p;
  }
  cv.addEventListener("pointerdown", function (e) {
    if (st.mode !== "draw" || e.button > 0) return;
    e.preventDefault(); cv.setPointerCapture(e.pointerId);
    live = [pt(e)]; drawSoon();
  });
  cv.addEventListener("pointermove", function (e) {
    if (!live) return;
    var evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    (evs.length ? evs : [e]).forEach(function (ev) {
      var last = live[live.length - 1], p = pt(ev, last);
      if (Math.hypot(p.x - last.x, p.y - last.y) >= 1.2) live.push(p);
    });
    drawSoon();
  });
  function end() {
    if (!live) return;
    history.push(strokes.slice()); if (history.length > 100) history.shift();
    strokes.push(live.map(function (p) { return { x: p.x, y: p.y, w: p.w }; })); live = null;
    draw(); result();
  }
  cv.addEventListener("pointerup", end);
  cv.addEventListener("pointercancel", end);

  // ---------- output ----------
  var SCALE = 3;
  function exportCanvas() {
    if (st.mode === "draw") {
      var b = bbox(strokes); if (!b) return null;
      var p = 6, out = document.createElement("canvas");
      out.width = Math.ceil((b.x1 - b.x0 + p * 2) * SCALE); out.height = Math.ceil((b.y1 - b.y0 + p * 2) * SCALE);
      paint(out.getContext("2d"), strokes, st.color, b.x0 - p, b.y0 - p, SCALE);
      return out;
    }
    if (!st.text.trim()) return null;
    var big = document.createElement("canvas"), c = big.getContext("2d"), fs = st.size * SCALE;
    c.font = fs + "px " + typedFont();
    big.width = Math.ceil(c.measureText(st.text).width + fs * 1.5); big.height = Math.ceil(fs * 2.2);
    c.font = fs + "px " + typedFont(); c.fillStyle = st.color; c.textBaseline = "alphabetic";
    c.fillText(st.text, fs * 0.75, fs * 1.45);
    return trimCanvas(big, Math.round(6 * SCALE));
  }
  var lastOut = null;
  function result() {
    lastOut = exportCanvas();
    var box = $("#result"); box.textContent = "";
    if (!lastOut) {
      box.appendChild(h("div", { "class": "empty" }, [h("b", { text: "Nothing yet" }), "Draw or type your signature above."]));
      $("#dims").textContent = "—";
    } else {
      var img = h("img", { alt: "Your signature", src: lastOut.toDataURL("image/png") });
      box.appendChild(img);
      $("#dims").textContent = lastOut.width + " × " + lastOut.height + " px";
    }
    ["#copy", "#png"].forEach(function (s) { $(s).disabled = !lastOut; });
    $("#svg").disabled = !lastOut || st.mode !== "draw";
    $("#svg").title = st.mode === "draw" ? "Vector SVG" : "SVG is available for drawn signatures";
  }
  var resultSoon = S3.debounce(result, 200);

  function blob(cb) { if (lastOut) lastOut.toBlob(cb, "image/png"); }
  $("#png").addEventListener("click", function () { blob(function (b) { S3.download(b, "signature.png"); S3.done(); }); });
  $("#svg").addEventListener("click", function () {
    var s = toSVG(strokes, st.color); if (!s) return;
    S3.download(s, "signature.svg", "image/svg+xml"); S3.done();
  });
  $("#copy").addEventListener("click", function () {
    if (!navigator.clipboard || !window.ClipboardItem || !window.isSecureContext) { S3.toast("Your browser can't copy images — use Download", "error"); return; }
    blob(function (b) {
      navigator.clipboard.write([new ClipboardItem({ "image/png": b })]).then(function () { S3.toast("Signature copied ✓"); S3.done(); },
        function () { S3.toast("Copy was blocked — use Download", "error"); });
    });
  });

  // ---------- controls ----------
  function undo() {
    if (st.mode !== "draw" || !history.length) return;
    strokes = history.pop(); draw(); result();
  }
  $("#undo").addEventListener("click", undo);
  $("#clear").addEventListener("click", function () {
    if (st.mode === "type") { st.text = ""; $("#text").value = ""; }
    else if (strokes.length) { history.push(strokes.slice()); strokes = []; }
    draw(); result();
  });
  document.addEventListener("keydown", function (e) {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "z" && e.target.tagName !== "INPUT") { e.preventDefault(); undo(); }
  });
  function setMode(m) {
    st.mode = m; remember();
    $$("#mode button").forEach(function (b) { b.setAttribute("aria-pressed", String(b.dataset.v === m)); });
    $("#drawOpts").hidden = m !== "draw"; $("#typeOpts").hidden = m !== "type";
    $("#undo").disabled = m !== "draw";
    pad.classList.toggle("typing", m === "type");
    $("#hint").textContent = m === "draw" ? "Sign here" : "Type your name above";
    draw(); result();
  }
  $$("#mode button").forEach(function (b) { b.addEventListener("click", function () { setMode(b.dataset.v); }); });
  function setColor(c) {
    st.color = c; $("#color").value = c; remember(); draw(); resultSoon();
    $$(".sw").forEach(function (b) { b.setAttribute("aria-pressed", String(b.dataset.c === c)); });
  }
  $$(".sw").forEach(function (b) { b.style.background = b.dataset.c; b.addEventListener("click", function () { setColor(b.dataset.c); }); });
  $("#color").addEventListener("input", function (e) { setColor(e.target.value); });
  $("#width").addEventListener("input", function (e) { st.width = +e.target.value; $("#widthVal").textContent = st.width + " px"; remember(); });
  $("#dynamic").addEventListener("change", function (e) { st.dynamic = e.target.checked; remember(); });
  $("#text").addEventListener("input", function (e) { st.text = e.target.value; draw(); resultSoon(); });
  $("#font").addEventListener("change", function (e) { st.font = e.target.value; remember(); draw(); resultSoon(); });
  $("#size").addEventListener("input", function (e) { st.size = +e.target.value; $("#sizeVal").textContent = st.size + " px"; remember(); draw(); resultSoon(); });

  // ---------- boot ----------
  st.text = "";
  var fonts = FONTS.filter(hasFont);
  fonts.concat(["cursive"]).forEach(function (f) {
    $("#font").appendChild(h("option", { value: f, text: f === "cursive" ? "Browser cursive" : f, style: "font-family:" + (f === "cursive" ? "cursive" : '"' + f + '", cursive') }));
  });
  if (fonts.concat(["cursive"]).indexOf(st.font) < 0) st.font = fonts[0] || "cursive";
  $("#font").value = st.font;
  $("#width").value = st.width; $("#widthVal").textContent = st.width + " px";
  $("#size").value = st.size; $("#sizeVal").textContent = st.size + " px";
  $("#dynamic").checked = st.dynamic;
  setColor(st.color);
  window.addEventListener("resize", S3.debounce(size, 150));
  size(); setMode(st.mode);

  window.S3_DEMO = function () {
    setMode("draw");
    var w = pad.clientWidth, hh = pad.clientHeight, s = [], u = [], T = Math.PI * 2 * 6.3;
    // Prolate cycloid = joined handwriting loops; first loop taller like a capital letter.
    for (var i = 0; i <= 420; i++) {
      var t = i / 420 * T + Math.PI, amp = 34 + 46 * Math.exp(-(t - Math.PI) / 3), sp = Math.abs(Math.sin(t));
      s.push({ x: w * 0.2 + t * 13 - 22 * Math.sin(t), y: hh * 0.62 - amp * (1 + Math.cos(t)) / 2 + t * 0.6, w: 1.8 + 2.4 * (1 - sp) });
    }
    for (var j = 0; j <= 40; j++) { var k = j / 40; u.push({ x: w * 0.22 + k * w * 0.5, y: hh * 0.7 + Math.sin(k * Math.PI) * 5, w: 3.4 - k * 2 }); }
    strokes = [s, u]; history = [[]]; draw(); result();
  };

  window.S3_SELFTEST = function () {
    var p = [{ x: 0, y: 0, w: 2 }, { x: 10, y: 0, w: 4 }, { x: 20, y: 10, w: 2 }];
    var g = segments(p);
    var okSeg = g.length === 2 && g[0].e.x === 15 && g[0].e.y === 5 && g[1].e.x === 20 && g[1].w === 2;
    var b = bbox([p]);
    var okBox = b.x0 === -2 && b.y0 === -3 && b.x1 === 22 && b.y1 === 12 && bbox([]) === null;
    var okW = targetWidth(4, 0, 0) === 6 && targetWidth(4, 10, 0) === 1.6 && targetWidth(4, 0, 1) > targetWidth(4, 0, 0.2);
    var svg = toSVG([p, [{ x: 5, y: 5, w: 4 }]], "#112233");
    var doc = new DOMParser().parseFromString(svg, "image/svg+xml");
    var okSvg = !doc.querySelector("parsererror") && doc.querySelectorAll("path").length === 2 && doc.querySelectorAll("circle").length === 1 &&
      doc.documentElement.getAttribute("viewBox") === "0 0 32 23";
    var c = document.createElement("canvas"); c.width = 50; c.height = 40;
    var cx = c.getContext("2d"); cx.fillStyle = "#000"; cx.fillRect(10, 5, 7, 3);
    var tr = trimCanvas(c, 2), empty = document.createElement("canvas"); empty.width = empty.height = 5;
    var okTrim = tr && tr.width === 11 && tr.height === 7 && trimCanvas(empty) === null;
    return okSeg && okBox && okW && okSvg && okTrim;
  };
})();
