#!/usr/bin/env node
// Probe (NEW-PARTIAL-WRITE-WIRE-BPL remainder verify — Point + Label):
// @purpose Gate: settled point+label scene uploads nothing; one moved point = exactly one 112-byte partial write; label text change = full rebuild
// @status ACTIVE
//
// the point + label renderers' resident-instance manager wirings must
//   (A) upload NOTHING for a settled scene of 1000 points + 200 labels
//       (0 full rebuilds AND 0 partial writes on BOTH managers over 30
//       static frames),
//   (B) on moving ONE point, issue exactly 1 partial write of exactly one
//       point stride (112 B) — NOT a full rebuild, NOT N x stride — and
//       render the mover (cyan) at its NEW screen position,
//   (C) on changing ONE label's text, take the full-rebuild path (label
//       dirty granularity is documented-unsound for partial slot writes)
//       and render the NEW text (yellow pixel coverage in the label's
//       window grows: "i" -> "WWWW"),
//   (D) leave the points rendering throughout (magenta count),
//   (E) produce zero console errors.
//
// Counters read from collection._webgpuCache.instanceManager (points) and
// labelCollection._webgpuLabelCache.sdfInstanceManager (labels) —
// debug-pragma instrumentation, present in CesiumUnminified.
//
// The globe is hidden (scene.globe.show = false) so color-threshold pixel
// checks run against a black background — no imagery false-positives and
// no globe-depth quantization interference (see the GEOMETRY NOTE in
// probe-billboard-partial-write.mjs for why that matters at range).
//
// Usage: node Tools/visual-regression/probe-point-label-partial-write.mjs
// Env:   PROBE_BASE (default http://localhost:8134)

import { chromium } from "playwright";

const BASE = process.env.PROBE_BASE || "http://localhost:8134";
const POINT_STRIDE = 112; // FLOATS_PER_INSTANCE (28) * 4

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});
const page = await browser.newPage({ viewport: { width: 1024, height: 700 } });
const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
  waitUntil: "networkidle",
});
await page.waitForFunction(() => !!window.viewer);

const out = await page.evaluate(async () => {
  const C = await import("/Build/CesiumUnminified/index.js");
  const v = window.viewer;
  const scene = v.scene;
  v.clock.shouldAnimate = false;
  scene.globe.show = false; // black background for color-threshold checks
  // Defensive: with the globe hidden, skybox stars / atmosphere haze /
  // sun bloom would otherwise reach the canvas behind the primitives and
  // could graze the cyan/yellow channel thresholds.
  if (scene.skyBox) scene.skyBox.show = false;
  if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
  if (scene.sun) scene.sun.show = false;
  if (scene.moon) scene.moon.show = false;

  const frame = async (n) => {
    for (let i = 0; i < n; i++) {
      scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
  };
  const grab = () => {
    const c = scene.canvas;
    const off = document.createElement("canvas");
    off.width = c.width;
    off.height = c.height;
    const cx = off.getContext("2d");
    cx.drawImage(c, 0, 0);
    return {
      data: cx.getImageData(0, 0, c.width, c.height).data,
      w: c.width,
      h: c.height,
    };
  };
  const isMagenta = (d, i) => d[i] > 180 && d[i + 2] > 180 && d[i + 1] < 90;
  const isCyan = (d, i) => d[i + 1] > 180 && d[i + 2] > 180 && d[i] < 90;
  // Lower-than-usual r/g floor: an SDF-antialiased 24px "i" stem over
  // black tops out below 180 (edge smoothing dims the 1-2px core). The
  // b<90 test still excludes the 0.5-gray (128,128,128) filler labels.
  const isYellow = (d, i) => d[i] > 140 && d[i + 1] > 140 && d[i + 2] < 90;
  const countIn = (img, pred, x0, y0, x1, y1) => {
    let n = 0;
    const xa = Math.max(0, Math.floor(x0));
    const ya = Math.max(0, Math.floor(y0));
    const xb = Math.min(img.w, Math.ceil(x1));
    const yb = Math.min(img.h, Math.ceil(y1));
    for (let y = ya; y < yb; y++) {
      for (let x = xa; x < xb; x++) {
        if (pred(img.data, 4 * (y * img.w + x))) n++;
      }
    }
    return n;
  };

  // 1000 points: 32x32 grid south, ~20 m spacing, 1000 m altitude.
  // Index 0 is the cyan mover; rest magenta.
  const LON = -75.0;
  const LAT = 40.0;
  const pts = scene.primitives.add(new C.PointPrimitiveCollection());
  for (let i = 0; i < 1000; i++) {
    pts.add({
      position: C.Cartesian3.fromDegrees(
        LON + 0.0002 * (i % 32),
        LAT + 0.0002 * Math.floor(i / 32),
        1000.0,
      ),
      pixelSize: 8,
      color: i === 0 ? C.Color.CYAN : C.Color.MAGENTA,
    });
  }

  // 200 labels: 20x10 grid ~2 km north of the points. Label 0 is yellow
  // with deliberately-thin text "i" (its text mutates to "WWWW" in (C));
  // the rest are dim gray digits (kept off the yellow/magenta/cyan
  // thresholds) drawn from a small glyph set so the SDF atlas settles
  // fast.
  const labels = scene.primitives.add(new C.LabelCollection());
  for (let i = 0; i < 200; i++) {
    labels.add({
      position: C.Cartesian3.fromDegrees(
        LON + 0.0012 * (i % 20),
        LAT + 0.018 + 0.0008 * Math.floor(i / 20),
        1000.0,
      ),
      text: i === 0 ? "i" : String(i % 10),
      font: "24px sans-serif",
      fillColor: i === 0 ? C.Color.YELLOW : new C.Color(0.5, 0.5, 0.5, 1.0),
      outlineWidth: 0,
      style: C.LabelStyle.FILL,
      verticalOrigin: C.VerticalOrigin.CENTER,
      horizontalOrigin: C.HorizontalOrigin.LEFT,
    });
  }

  scene.morphTo3D(0);
  v.camera.setView({
    destination: C.Cartesian3.fromDegrees(-74.985, 40.012, 11000.0),
    orientation: { heading: 0.0, pitch: -Math.PI / 2, roll: 0.0 },
  });

  // Warmup: SDF rasterization, atlas upload, pipeline resolve, readiness
  // dirty churn. Settle until BOTH managers exist and their counters stop
  // moving for 10 consecutive frames (cap 300).
  let ptsMgr = null;
  let lblMgr = null;
  let settled = 0;
  let last = null;
  let warmupFrames = 0;
  for (; warmupFrames < 300 && settled < 10; warmupFrames++) {
    await frame(1);
    ptsMgr = pts._webgpuCache?.instanceManager ?? null;
    lblMgr = labels._webgpuLabelCache?.sdfInstanceManager ?? null;
    if (!ptsMgr || !lblMgr) continue;
    const cur = [
      ptsMgr._fullRebuilds,
      ptsMgr._partialWrites,
      lblMgr._fullRebuilds,
      lblMgr._partialWrites,
    ].join(",");
    if (cur === last) {
      settled++;
    } else {
      settled = 0;
      last = cur;
    }
  }
  if (!ptsMgr) return { fatal: "point instanceManager never appeared" };
  if (!lblMgr) return { fatal: "label sdfInstanceManager never appeared" };
  if (settled < 10) return { fatal: `never settled (warmup=${warmupFrames})` };

  // (A) 30 static frames -> no uploads at all on EITHER manager.
  const a0 = {
    pFull: ptsMgr._fullRebuilds,
    pPartial: ptsMgr._partialWrites,
    pBytes: ptsMgr._bytesUploaded,
    lFull: lblMgr._fullRebuilds,
    lPartial: lblMgr._partialWrites,
    lBytes: lblMgr._bytesUploaded,
  };
  await frame(30);
  const stat = {
    pFull: ptsMgr._fullRebuilds - a0.pFull,
    pPartial: ptsMgr._partialWrites - a0.pPartial,
    pBytes: ptsMgr._bytesUploaded - a0.pBytes,
    lFull: lblMgr._fullRebuilds - a0.lFull,
    lPartial: lblMgr._partialWrites - a0.lPartial,
    lBytes: lblMgr._bytesUploaded - a0.lBytes,
  };

  // (D-before) + (B-before): points render; mover window clean; label 0
  // window baseline.
  const before = grab();
  const magentaBefore = countIn(before, isMagenta, 0, 0, before.w, before.h);
  const newPos = C.Cartesian3.fromDegrees(-74.99, 40.008, 1000.0);
  const win = scene.cartesianToCanvasCoordinates(newPos);
  const cyanAtNewBefore = win
    ? countIn(before, isCyan, win.x - 25, win.y - 25, win.x + 25, win.y + 25)
    : -1;
  const lbl0Pos = labels.get(0).position;
  const lwin = scene.cartesianToCanvasCoordinates(lbl0Pos);
  const yellowBefore = lwin
    ? countIn(
        before,
        isYellow,
        lwin.x - 20,
        lwin.y - 40,
        lwin.x + 160,
        lwin.y + 40,
      )
    : -1;

  // (B) move ONE point -> exactly 1 partial write of exactly 1 stride.
  const b0 = {
    full: ptsMgr._fullRebuilds,
    partial: ptsMgr._partialWrites,
    bytes: ptsMgr._bytesUploaded,
  };
  pts.get(0).position = newPos;
  await frame(1);
  const moveFullDelta1 = ptsMgr._fullRebuilds - b0.full;
  const movePartialDelta1 = ptsMgr._partialWrites - b0.partial;
  const moveBytesDelta1 = ptsMgr._bytesUploaded - b0.bytes;
  await frame(5); // settle — no further uploads expected
  const moveFullDelta = ptsMgr._fullRebuilds - b0.full;
  const movePartialDelta = ptsMgr._partialWrites - b0.partial;
  const moveBytesDelta = ptsMgr._bytesUploaded - b0.bytes;

  const afterMove = grab();
  const win2 = scene.cartesianToCanvasCoordinates(newPos) ?? win;
  const cyanAtNewAfter = win2
    ? countIn(
        afterMove,
        isCyan,
        win2.x - 25,
        win2.y - 25,
        win2.x + 25,
        win2.y + 25,
      )
    : -1;

  // (C) change ONE label's text -> full rebuild + the new text renders.
  // "i" -> "WWWW" multiplies the glyph pixel coverage; new 'W' glyphs
  // also rotate the SDF atlas (rasterize + re-upload), all of which must
  // land as full rebuilds, never a stale partial render.
  const c0 = {
    full: lblMgr._fullRebuilds,
    partial: lblMgr._partialWrites,
    pFull: ptsMgr._fullRebuilds,
    pPartial: ptsMgr._partialWrites,
  };
  labels.get(0).text = "WWWW";
  // Allow SDF rasterization + atlas upload + readiness churn to settle.
  let lblSettled = 0;
  let lblLast = null;
  let textFrames = 0;
  for (; textFrames < 120 && lblSettled < 10; textFrames++) {
    await frame(1);
    const cur = `${lblMgr._fullRebuilds},${lblMgr._partialWrites}`;
    if (cur === lblLast) {
      lblSettled++;
    } else {
      lblSettled = 0;
      lblLast = cur;
    }
  }
  const textFullDelta = lblMgr._fullRebuilds - c0.full;
  const textPartialDelta = lblMgr._partialWrites - c0.partial;
  // Cross-collection isolation: the label edit must not touch the points.
  const textPointFullDelta = ptsMgr._fullRebuilds - c0.pFull;
  const textPointPartialDelta = ptsMgr._partialWrites - c0.pPartial;

  const afterText = grab();
  const lwin2 = scene.cartesianToCanvasCoordinates(lbl0Pos) ?? lwin;
  const yellowAfter = lwin2
    ? countIn(
        afterText,
        isYellow,
        lwin2.x - 20,
        lwin2.y - 40,
        lwin2.x + 160,
        lwin2.y + 40,
      )
    : -1;
  const magentaAfter = countIn(
    afterText,
    isMagenta,
    0,
    0,
    afterText.w,
    afterText.h,
  );

  return {
    warmupFrames,
    ptsVisible: ptsMgr.lastVisibleCount,
    lblVisible: lblMgr.lastVisibleCount,
    stat,
    moveFullDelta1,
    movePartialDelta1,
    moveBytesDelta1,
    moveFullDelta,
    movePartialDelta,
    moveBytesDelta,
    cyanAtNewBefore,
    cyanAtNewAfter,
    winXY: win2 ? [Math.round(win2.x), Math.round(win2.y)] : null,
    textFrames,
    textFullDelta,
    textPartialDelta,
    textPointFullDelta,
    textPointPartialDelta,
    yellowBefore,
    yellowAfter,
    lwinXY: lwin2 ? [Math.round(lwin2.x), Math.round(lwin2.y)] : null,
    magentaBefore,
    magentaAfter,
  };
});

if (out.fatal) {
  console.log(`FATAL: ${out.fatal}`);
  await browser.close();
  process.exit(1);
}

const s = out.stat;
const aOK =
  s.pFull === 0 &&
  s.pPartial === 0 &&
  s.pBytes === 0 &&
  s.lFull === 0 &&
  s.lPartial === 0 &&
  s.lBytes === 0;
const bOK =
  out.moveFullDelta === 0 &&
  out.movePartialDelta1 === 1 &&
  out.moveBytesDelta1 === POINT_STRIDE &&
  out.moveBytesDelta === out.moveBytesDelta1 && // settles after one frame
  out.cyanAtNewBefore === 0 &&
  out.cyanAtNewAfter > 3;
const cOK =
  out.textFullDelta >= 1 &&
  out.textPartialDelta === 0 && // label path never partial-writes on dirty
  out.textPointFullDelta === 0 &&
  out.textPointPartialDelta === 0 &&
  out.yellowBefore > 0 &&
  out.yellowAfter > out.yellowBefore * 2 + 30;
const dOK = out.magentaBefore > 200 && out.magentaAfter > 200;
const eOK = errors.length === 0;

console.log(
  `warmup: ${out.warmupFrames} frames, ptsVisible=${out.ptsVisible}, lblGlyphsVisible=${out.lblVisible}`,
);
console.log(
  `(A) 30 static frames: points full=${s.pFull} partial=${s.pPartial} bytes=${s.pBytes}; labels full=${s.lFull} partial=${s.lPartial} bytes=${s.lBytes} ${aOK ? "OK" : "FAIL"}`,
);
console.log(
  `(B) move 1 of 1000 points: frame1 full=${out.moveFullDelta1} partial=${out.movePartialDelta1} bytes=${out.moveBytesDelta1} (stride=${POINT_STRIDE}); settled full=${out.moveFullDelta} partial=${out.movePartialDelta} bytes=${out.moveBytesDelta}; cyan@${JSON.stringify(out.winXY)} before=${out.cyanAtNewBefore} after=${out.cyanAtNewAfter} ${bOK ? "OK" : "FAIL"}`,
);
console.log(
  `(C) label text "i"->"WWWW": full=${out.textFullDelta} partial=${out.textPartialDelta} (points full=${out.textPointFullDelta} partial=${out.textPointPartialDelta}) over ${out.textFrames} frames; yellow@${JSON.stringify(out.lwinXY)} before=${out.yellowBefore} after=${out.yellowAfter} ${cOK ? "OK" : "FAIL"}`,
);
console.log(
  `(D) points render: magenta before=${out.magentaBefore} after=${out.magentaAfter} ${dOK ? "OK" : "FAIL"}`,
);
console.log(`(E) console errors: ${errors.length} ${eOK ? "OK" : "FAIL"}`);
errors.slice(0, 5).forEach((e) => console.log("  ERR:", e.slice(0, 200)));

const pass = aOK && bOK && cOK && dOK && eOK;
console.log(pass ? "PASS" : "FAIL");
await browser.close();
process.exit(pass ? 0 : 1);
