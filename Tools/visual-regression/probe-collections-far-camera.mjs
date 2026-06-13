#!/usr/bin/env node
// Probe (NEW-COLLECTIONS-LOG-DEPTH, Batch 251 — the far-camera envelope
// gate): billboards + points 1000 m above a VISIBLE globe at a 220 km
// camera, WITHOUT disableDepthTestDistance. This is the original "bug 2"
// case that was previously impossible on WebGPU: with hyperbolic NDC
// depth, a 1000 m marker-above-ground separation at 220 km is ~0.03
// 24-bit quantization steps (Batch 229 measurement) — an unresolvable
// tie against the globe, and markers depth-vanish on some tiles. Every
// collection probe before this one was capped to <= 11 km cameras.
//
// With renderer-wide log depth (master switch `_logDepthWriteEnabled`
// defaults TRUE since Batch 251), depth resolves at sub-meter precision
// across the whole frustum, so the markers MUST render.
//
// Checks:
//   (1) ON  — billboards (magenta) + points (cyan) RENDER at the 220 km
//       camera over the visible globe (no disableDepthTestDistance).
//   (2) ON  — negative control: a marker 1000 m BELOW the ellipsoid
//       surface stays occluded (depth testing still works; log depth
//       didn't degenerate into depth-test-off).
//   (3) OFF — kill-switch leg (runtime flip to hyperbolic): reported as
//       diagnostics (historically the markers partially/fully vanish —
//       the tie is tile-dependent — so no hard assertion), then flipped
//       back ON and re-verified green. Exercises every renderer's
//       flip-rebuild guard end-to-end.
//   (4) Frame-cost note — average scene.render() wall time ON vs OFF
//       (frag_depth disables early-Z; WebGL pays the same cost with log
//       depth on). Reported, not asserted (wall time is noisy in CI).
//   (5) 0 console errors (incl. WebGPU validation errors).
//
// Globe: solid baseColor (imagery layers stripped — no Ion dependency),
// smooth ellipsoid terrain.
//
// Usage: node Tools/visual-regression/probe-collections-far-camera.mjs
// Env:   PROBE_BASE (default http://localhost:8134)
// Out:   Tools/visual-regression/output/collections-far-camera-{on,off}.png

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = process.env.PROBE_BASE || "http://localhost:8134";
const OUT_DIR = "Tools/visual-regression/output";

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
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
  waitUntil: "networkidle",
});
await page.waitForFunction(() => !!window.viewer);

const out = await page.evaluate(async () => {
  const C = await import("/Build/CesiumUnminified/index.js");
  const v = window.viewer;
  const scene = v.scene;
  v.clock.shouldAnimate = false;

  // Solid-color globe — no imagery/Ion dependency, no tile-loading drift
  // (the bloom-parity probe's pattern). Sky off so saturated-marker pixel
  // counts are deterministic.
  scene.globe.show = true;
  scene.imageryLayers.removeAll();
  scene.globe.baseColor = new C.Color(0.12, 0.15, 0.2, 1.0);
  scene.globe.showGroundAtmosphere = false;
  scene.globe.showWaterEffect = false;
  if (scene.skyBox) scene.skyBox.show = false;
  if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
  if (scene.sun) scene.sun.show = false;
  if (scene.moon) scene.moon.show = false;
  scene.backgroundColor = C.Color.BLACK;

  const frame = async (n) => {
    for (let i = 0; i < n; i++) {
      scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
  };
  // Deterministic readback INSIDE scene.postRender — present clears the
  // WebGPU canvas texture, so readback in a later task is racy.
  const snap = (withPng) =>
    new Promise((resolve) => {
      const remove = scene.postRender.addEventListener(() => {
        remove();
        const c = scene.canvas;
        const off = document.createElement("canvas");
        off.width = c.width;
        off.height = c.height;
        const cx = off.getContext("2d");
        cx.drawImage(c, 0, 0);
        resolve({
          data: cx.getImageData(0, 0, c.width, c.height).data,
          w: c.width,
          h: c.height,
          png: withPng ? off.toDataURL("image/png") : null,
        });
      });
      scene.render();
    });

  const isMagenta = (d, i) => d[i] > 180 && d[i + 2] > 180 && d[i + 1] < 90;
  const isCyan = (d, i) => d[i + 1] > 180 && d[i + 2] > 180 && d[i] < 90;
  const isRed = (d, i) => d[i] > 180 && d[i + 1] < 90 && d[i + 2] < 90;
  const countAll = (img, pred) => {
    let n = 0;
    for (let p = 0; p < img.w * img.h; p++) {
      if (pred(img.data, 4 * p)) n++;
    }
    return n;
  };

  // ---- Scene: markers 1000 m above the ellipsoid, camera at 220 km ----
  const LON = -75.0;
  const LAT = 40.0;

  const img16 = document.createElement("canvas");
  img16.width = 16;
  img16.height = 16;
  img16.getContext("2d").fillStyle = "#ffffff";
  img16.getContext("2d").fillRect(0, 0, 16, 16);

  // 10x10 magenta billboards, 1000 m above ground, NO
  // disableDepthTestDistance (the whole point of the probe).
  const bbs = scene.primitives.add(new C.BillboardCollection());
  for (let i = 0; i < 100; i++) {
    bbs.add({
      position: C.Cartesian3.fromDegrees(
        LON - 0.5 + 0.02 * (i % 10),
        LAT - 0.4 + 0.02 * Math.floor(i / 10),
        1000.0,
      ),
      image: img16,
      color: C.Color.MAGENTA,
      disableDepthTestDistance: 0.0,
    });
  }

  // 10x10 cyan points, 1000 m above ground.
  const pts = scene.primitives.add(new C.PointPrimitiveCollection());
  for (let i = 0; i < 100; i++) {
    pts.add({
      position: C.Cartesian3.fromDegrees(
        LON + 0.3 + 0.02 * (i % 10),
        LAT - 0.4 + 0.02 * Math.floor(i / 10),
        1000.0,
      ),
      pixelSize: 10,
      color: C.Color.CYAN,
      disableDepthTestDistance: 0.0,
    });
  }

  // Negative control: 25 RED billboards 1000 m BELOW the surface — must
  // stay occluded by the globe (proves the depth test still functions).
  const below = scene.primitives.add(new C.BillboardCollection());
  for (let i = 0; i < 25; i++) {
    below.add({
      position: C.Cartesian3.fromDegrees(
        LON - 0.1 + 0.02 * (i % 5),
        LAT + 0.25 + 0.02 * Math.floor(i / 5),
        -1000.0,
      ),
      image: img16,
      color: C.Color.RED,
      disableDepthTestDistance: 0.0,
    });
  }

  // Camera: 220 km straight down — the original bug-2 envelope.
  v.camera.setView({
    destination: C.Cartesian3.fromDegrees(LON, LAT, 220000.0),
    orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
  });

  // Settle: solid-color tiles load fast, but give the globe + pipelines
  // time to materialize (async pipeline creation skips draws for a frame).
  await frame(30);
  let stable = 0;
  for (let i = 0; i < 120 && stable < 5; i++) {
    await frame(1);
    stable = scene.globe.tilesLoaded ? stable + 1 : 0;
  }
  await frame(10);

  const ctx = scene.context;

  // ---- (1)+(2) ON leg ----
  let t0 = performance.now();
  const N_TIME = 60;
  for (let i = 0; i < N_TIME; i++) {
    scene.render();
  }
  const msOn = (performance.now() - t0) / N_TIME;
  const imgOn = await snap(true);
  const onBB = countAll(imgOn, isMagenta);
  const onPT = countAll(imgOn, isCyan);
  const onBelow = countAll(imgOn, isRed);

  // ---- (3) OFF leg — runtime kill switch ----
  ctx._logDepthWriteEnabled = false;
  await frame(20); // every renderer rebuilds via its flip guard
  t0 = performance.now();
  for (let i = 0; i < N_TIME; i++) {
    scene.render();
  }
  const msOff = (performance.now() - t0) / N_TIME;
  const imgOff = await snap(true);
  const offBB = countAll(imgOff, isMagenta);
  const offPT = countAll(imgOff, isCyan);

  // ---- flip back ON and re-verify ----
  ctx._logDepthWriteEnabled = true;
  await frame(20);
  const imgOn2 = await snap(false);
  const on2BB = countAll(imgOn2, isMagenta);
  const on2PT = countAll(imgOn2, isCyan);

  return {
    onBB,
    onPT,
    onBelow,
    offBB,
    offPT,
    on2BB,
    on2PT,
    msOn: msOn.toFixed(2),
    msOff: msOff.toFixed(2),
    pngOn: imgOn.png,
    pngOff: imgOff.png,
    useLogDepth: scene._frameState ? scene._frameState.useLogDepth : null,
  };
});

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const [k, f] of [
  ["pngOn", "collections-far-camera-on.png"],
  ["pngOff", "collections-far-camera-off.png"],
]) {
  if (out[k]) {
    fs.writeFileSync(
      path.join(OUT_DIR, f),
      Buffer.from(out[k].split(",")[1], "base64"),
    );
  }
}

// Thresholds: 100 16px billboards ≈ >2000 px fully visible; require a
// conservative floor (pipeline-resolution timing + antialiasing margins).
const BB_MIN = 800;
const PT_MIN = 400;
const BELOW_MAX = 10;

let ok = true;
const check = (label, pass, detail) => {
  console.log(`(${label}) ${detail} ${pass ? "OK" : "FAIL"}`);
  if (!pass) ok = false;
};

check(
  "1",
  out.onBB >= BB_MIN && out.onPT >= PT_MIN,
  `far-camera render @220km (log depth ON): bb(magenta)=${out.onBB}/${BB_MIN} pt(cyan)=${out.onPT}/${PT_MIN} (useLogDepth=${out.useLogDepth})`,
);
check(
  "2",
  out.onBelow <= BELOW_MAX,
  `below-ground negative control: red=${out.onBelow} (max ${BELOW_MAX} — depth test must still occlude)`,
);
console.log(
  `(3) kill-switch OFF leg (hyperbolic, diagnostics only): bb=${out.offBB} pt=${out.offPT} — historically vanishes/ties at this range`,
);
check(
  "3b",
  out.on2BB >= BB_MIN && out.on2PT >= PT_MIN,
  `flip back ON re-verifies: bb=${out.on2BB} pt=${out.on2PT}`,
);
console.log(
  `(4) frame-cost note: avg scene.render() ON=${out.msOn}ms OFF=${out.msOff}ms (frag_depth disables early-Z; mirrors WebGL's log-depth cost)`,
);
check("5", errors.length === 0, `console errors: ${errors.length}`);
if (errors.length) {
  for (const e of errors.slice(0, 8)) console.log(`  ERR: ${e}`);
}

console.log(ok ? "PASS" : "FAIL");
await browser.close();
process.exit(ok ? 0 : 1);
