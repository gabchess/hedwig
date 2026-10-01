// Tap field. Reads the owl's pixel cells from the inline SVG, paints them on a
// canvas across the art column, and plays a note on each tap (see sound.js).
// Without this script the page shows the SVG owl unchanged.
(function () {
  "use strict";

  var art = document.querySelector(".art");
  var svg = art && art.querySelector("svg");
  var row = document.getElementById("field-row");
  var motionBtn = document.getElementById("field-motion");
  if (!art || !svg || !row || !motionBtn) return;

  var canvas = document.createElement("canvas");
  var ctx = canvas.getContext && canvas.getContext("2d");
  if (!ctx) return;

  var N = 60; // the owl is 60 by 60 cells of 20 SVG units each
  var UNIT = 20;
  var PAUSE_KEY = "hedwig-motion";
  var REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)");
  var PHONE = window.matchMedia("(max-width: 959px)");

  // ---------- Tokens, read from style.css ----------
  var css = getComputedStyle(document.documentElement);
  var NAMES = ["ground", "surface", "text", "muted", "purple", "blue"];
  var TOKEN = {};
  var BY_HEX = {};
  NAMES.forEach(function (name) {
    var hex = css
      .getPropertyValue("--" + name)
      .trim()
      .toLowerCase();
    TOKEN[name] = hex;
    BY_HEX[hex] = name;
  });

  // ---------- Owl cell map, from the shipped SVG ----------
  // owl[r][c] = { key: token name, glow: shimmer delay in seconds or -1 }
  var owl = [];
  var r, c;
  for (r = 0; r < N; r++) {
    owl[r] = [];
    for (c = 0; c < N; c++) owl[r][c] = { key: "ground", glow: -1 };
  }
  var rects = svg.querySelectorAll("rect");
  var glowIndex = 0;
  for (var i = 0; i < rects.length; i++) {
    var el = rects[i];
    var key = BY_HEX[(el.getAttribute("fill") || "").toLowerCase()] || "ground";
    var glow = -1;
    if (el.classList.contains("glow")) {
      // Same scatter owl.js uses, so the shimmer keeps today's rhythm.
      glow = ((glowIndex * 2654435761) % 6000) / 1000;
      glowIndex++;
    }
    var x0 = Math.round(+el.getAttribute("x") / UNIT);
    var y0 = Math.round(+el.getAttribute("y") / UNIT);
    var w = Math.round(+el.getAttribute("width") / UNIT);
    var h = Math.round(+el.getAttribute("height") / UNIT);
    for (r = y0; r < y0 + h && r < N; r++) {
      for (c = x0; c < x0 + w && c < N; c++)
        owl[r][c] = { key: key, glow: glow };
    }
  }

  // Ground cells reachable from the map edge are field. The rest (pupils and
  // beak) belong to the owl and never drift.
  var outside = [];
  for (r = 0; r < N; r++) {
    outside[r] = [];
    for (c = 0; c < N; c++) outside[r][c] = false;
  }
  var stack = [];
  for (i = 0; i < N; i++) stack.push([0, i], [N - 1, i], [i, 0], [i, N - 1]);
  while (stack.length) {
    var p = stack.pop();
    var pr = p[0];
    var pc = p[1];
    if (pr < 0 || pc < 0 || pr >= N || pc >= N) continue;
    if (outside[pr][pc] || owl[pr][pc].key !== "ground") continue;
    outside[pr][pc] = true;
    stack.push([pr + 1, pc], [pr - 1, pc], [pr, pc + 1], [pr, pc - 1]);
  }

  // ---------- State ----------
  var W = 0;
  var H = 0;
  var cell = 10;
  var cols = N;
  var ox = 0;
  var gap = 0;
  var paused = false;
  try {
    paused = sessionStorage.getItem(PAUSE_KEY) === "paused";
  } catch (e) {}
  var visible = !document.hidden;
  var onscreen = true;
  var t = 0;
  var last = 0;
  var lastPaint = 0;
  var frame = 0;
  var hover = null;
  var cursor = null;
  var showCursor = false;
  var ripples = [];
  var flashes = [];

  function still() {
    return paused || REDUCED.matches;
  }

  // The owl cell under a grid cell, or null for a field cell outside the owl.
  function owlAt(col, rw) {
    var oc = col - ox;
    if (oc < 0 || rw < 0 || oc >= N || rw >= N) return null;
    return owl[rw][oc];
  }

  function isField(col, rw) {
    var o = owlAt(col, rw);
    return !o || (o.key === "ground" && outside[rw][col - ox]);
  }

  function resize() {
    var box = art.getBoundingClientRect();
    if (!box.width || !box.height) return;
    W = box.width;
    H = box.height;
    var ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(W * ratio);
    canvas.height = Math.round(H * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    cell = H / N; // the owl fills the column height, as it does today
    cols = Math.max(N, Math.ceil(W / cell));
    ox = PHONE.matches ? Math.floor((Math.ceil(W / cell) - N) / 2) : 0;
    if (ox < 0) ox = 0;
    gap = cell >= 10 ? 1 : 0;
    if (cursor) {
      cursor.c = Math.max(0, Math.min(cols - 1, cursor.c));
    }
    paint();
  }

  function fill(color, alpha, col, rw) {
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    ctx.fillRect(col * cell, rw * cell, cell - gap, cell - gap);
  }

  function paint() {
    if (!W) return;
    var moving = !still();
    ctx.globalAlpha = 1;
    ctx.fillStyle = TOKEN.ground;
    ctx.fillRect(0, 0, W, H);

    var loopT = t % 22;
    var bandOn = moving && loopT < 14; // reads down for 14 s, rests for 8 s
    var bandRow = (loopT / 14) * N;

    for (var rw = 0; rw < N; rw++) {
      var band = bandOn ? Math.max(0, 1 - Math.abs(rw - bandRow) / 2.5) : 0;
      for (var col = 0; col < cols; col++) {
        var lift = 0;
        if (moving && hover) {
          var dh = Math.max(Math.abs(col - hover.c), Math.abs(rw - hover.r));
          lift += Math.max(0, 1 - dh / 5) * 0.35;
        }
        if (moving) {
          for (var k = 0; k < ripples.length; k++) {
            var rp = ripples[k];
            var age = t - rp.born;
            // Chebyshev distance: the ring is a square, like the tiles.
            var d = Math.max(Math.abs(col - rp.c), Math.abs(rw - rp.r));
            var ring = Math.max(0, 1 - Math.abs(d - age * 13) / 1.6);
            lift += ring * Math.max(0, 1 - age / 2.4);
          }
        }
        if (lift > 1) lift = 1;

        if (isField(col, rw)) {
          // Ledger tide: a slow diagonal wave, about 30 s per cycle.
          var u = col / cols;
          var v = rw / N;
          var tide = Math.sin((u * 1.3 + v) * 5.2 - t * 0.21) * 0.5 + 0.5;
          var grain = Math.sin(col * 12.9898 + rw * 78.233) * 0.5 + 0.5;
          var a = 0.1 + tide * 0.26 + grain * 0.08;
          fill(TOKEN.surface, Math.min(1, a + lift * 0.5), col, rw);
          if (band > 0) fill(TOKEN.purple, band * 0.07, col, rw);
          if (lift > 0.02) fill(TOKEN.purple, lift * 0.62, col, rw);
        } else {
          var o = owlAt(col, rw);
          var alpha = 1;
          if (moving && o.glow >= 0) {
            var ph = ((t + o.glow) % 6) / 6;
            alpha = 0.86 + 0.14 * (0.5 - 0.5 * Math.cos(ph * Math.PI * 2));
          }
          fill(TOKEN[o.key], alpha, col, rw);
          if (lift > 0.02) {
            var tint = o.key === "text" ? TOKEN.purple : TOKEN.text;
            fill(tint, lift * 0.5, col, rw);
          }
        }
      }
    }

    // Tapped squares flash blue and fade. Shown in still mode too: a color
    // change, not motion.
    var now = performance.now();
    for (var f = 0; f < flashes.length; f++) {
      var fa = Math.max(0, 1 - (now - flashes[f].at) / 700);
      if (fa > 0) fill(TOKEN.blue, fa, flashes[f].c, flashes[f].r);
    }

    if (showCursor && cursor) {
      ctx.globalAlpha = 1;
      ctx.strokeStyle = TOKEN.blue;
      ctx.lineWidth = 2;
      var size = Math.max(4, cell - 2);
      ctx.strokeRect(cursor.c * cell + 1, cursor.r * cell + 1, size, size);
    }
    ctx.globalAlpha = 1;
  }

  function loop(now) {
    frame = 0;
    if (!visible || !onscreen) return;
    if (still() && !flashes.length) {
      paint();
      return;
    }
    if (last && !still()) t += Math.min((now - last) / 1000, 0.05);
    last = now;
    if (now - lastPaint >= 1000 / 30) {
      ripples = ripples.filter(function (rp) {
        return t - rp.born < 2.4;
      });
      var clock = performance.now();
      flashes = flashes.filter(function (fl) {
        return clock - fl.at < 700;
      });
      paint();
      lastPaint = now;
    }
    frame = requestAnimationFrame(loop);
  }

  function kick() {
    if (!frame) {
      last = 0;
      frame = requestAnimationFrame(loop);
    }
  }

  function cellFromEvent(e) {
    var box = canvas.getBoundingClientRect();
    return {
      c: Math.max(
        0,
        Math.min(cols - 1, Math.floor((e.clientX - box.left) / cell))
      ),
      r: Math.max(0, Math.min(N - 1, Math.floor((e.clientY - box.top) / cell))),
    };
  }

  function tap(pos) {
    if (!still()) {
      ripples = ripples.slice(-5).concat([{ c: pos.c, r: pos.r, born: t }]);
    }
    flashes = flashes
      .slice(-5)
      .concat([{ c: pos.c, r: pos.r, at: performance.now() }]);
    kick();
    var o = owlAt(pos.c, pos.r);
    var kind = isField(pos.c, pos.r)
      ? "ground"
      : o.key === "blue"
      ? "eye"
      : "owl";
    if (window.hedwigSound)
      window.hedwigSound.interact({ y: pos.r / N, kind: kind });
  }

  function syncMotionButton() {
    if (REDUCED.matches) {
      motionBtn.textContent = "Motion off";
      motionBtn.disabled = true;
      motionBtn.setAttribute("aria-pressed", "true");
    } else {
      motionBtn.disabled = false;
      motionBtn.textContent = paused ? "Play motion" : "Pause motion";
      motionBtn.setAttribute("aria-pressed", String(paused));
    }
  }

  // ---------- Mount ----------
  canvas.setAttribute("aria-hidden", "true");
  art.appendChild(canvas);
  art.classList.add("has-field");
  art.setAttribute("tabindex", "0");
  art.setAttribute("role", "group");
  art.setAttribute(
    "aria-label",
    "Hedwig, a pixel owl. Arrow keys move, Enter plays a note"
  );
  art.setAttribute("aria-describedby", "field-hint");
  row.hidden = false;

  art.addEventListener("pointermove", function (e) {
    if (e.pointerType !== "mouse") return;
    hover = cellFromEvent(e);
    kick();
  });
  art.addEventListener("pointerleave", function () {
    hover = null;
    kick();
  });
  art.addEventListener("click", function (e) {
    showCursor = false;
    tap(cellFromEvent(e));
  });
  art.addEventListener("keydown", function (e) {
    var moves = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    };
    if (!cursor) cursor = { c: ox + 30, r: 22 };
    if (moves[e.key]) {
      e.preventDefault();
      showCursor = true;
      cursor.c = Math.max(0, Math.min(cols - 1, cursor.c + moves[e.key][0]));
      cursor.r = Math.max(0, Math.min(N - 1, cursor.r + moves[e.key][1]));
      paint();
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      showCursor = true;
      tap(cursor);
    }
  });
  art.addEventListener("focus", function () {
    var keyboard = true;
    try {
      keyboard = art.matches(":focus-visible");
    } catch (e) {}
    if (!keyboard) return;
    if (!cursor) cursor = { c: ox + 30, r: 22 };
    showCursor = true;
    paint();
  });
  art.addEventListener("blur", function () {
    showCursor = false;
    paint();
  });

  document.addEventListener("visibilitychange", function () {
    visible = !document.hidden;
    if (visible) kick();
  });
  if ("IntersectionObserver" in window) {
    new IntersectionObserver(function (entries) {
      onscreen = entries[entries.length - 1].isIntersecting;
      if (onscreen) kick();
    }).observe(art);
  }
  if ("ResizeObserver" in window) {
    new ResizeObserver(resize).observe(art);
  } else {
    window.addEventListener("resize", resize);
  }

  motionBtn.addEventListener("click", function () {
    paused = !paused;
    try {
      sessionStorage.setItem(PAUSE_KEY, paused ? "paused" : "on");
    } catch (e) {}
    syncMotionButton();
    kick();
    paint();
  });
  REDUCED.addEventListener("change", function () {
    syncMotionButton();
    kick();
    paint();
  });

  syncMotionButton();
  resize();
  kick();
})();
