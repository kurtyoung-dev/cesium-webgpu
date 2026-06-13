#!/usr/bin/env node
// Probe (NEW-BUFFER-LOG-DEPTH — log-depth slice for the experimental Buffer*
// collection family: BufferPoint / BufferPolyline / BufferPolygon). Until this
// slice the Buffer family ALWAYS wrote hyperbolic NDC depth: its WGSL called a
// 1-arg `csm_vertexLogDepth` + an empty `csm_writeLogDepth` no-op stub (resolved
// in WebGPUBufferPrimitiveRenderer.ts) and never consulted isWebGPULogDepthActive.
// Since Batch 251 the WebGPU globe writes LOG depth, so Buffer fill geometry sat
// in a DIFFERENT depth space than the globe and sank behind terrain at a far
// nadir camera — the z-fight the renderer-wide log-depth epic resolves for every
// other producer.
//
// Verification strategy — log-depth REFERENCE, not a kill-switch OFF leg.
// Toggling `context._logDepthWriteEnabled` (or building hyperbolic from frame 0)
// leaves the GLOBE pipelines in a half-rebuilt state that blacks the globe — a
// pre-existing kill-switch limitation that makes the OFF leg unreliable (it
// also breaks the reference Mat probe's OFF-dependent checks). So instead of an
// OFF baseline this probe uses a KNOWN-GOOD log-depth producer as the reference:
// a magenta BillboardCollection grid co-located with the cyan BufferPoint grid.
// Billboards have written LOG depth since Batch 250, so at this far nadir camera
// they sit cleanly on the log-depth globe. The PRE-fix Buffer family (hyperbolic)
// would sink behind the same globe and LOSE most of its pixels while the
// billboard reference stayed put — a coverage divergence. POST-fix the Buffer
// fill composes into the same log space, so its coverage tracks the reference.
//
// Checks (all in the default ON / log-depth-master-switch-true state):
//   (1) Buffer point grid + polygon slab + polyline render with >= MIN pixels
//       AND the billboard reference renders too (sanity that the log globe is up).
//   (2) the Buffer fill is NOT sunk behind terrain: the cyan BufferPoint grid's
//       coverage is at least a floor fraction of the co-located magenta billboard
//       reference's coverage. Pre-fix the Buffer points (hyperbolic) would be
//       largely eaten by the log globe while billboards (log) stayed — coverage
//       would collapse far below this floor.
//   (3) flip off→on once exercises the LOG_DEPTH flip-rebuild guard with NO
//       WebGPU validation error (post-flip pixels not asserted — see strategy).
//   (4) 0 console errors (incl. WebGPU validation errors).
//
// Usage: node Tools/visual-regression/probe-buffer-logdepth-zfight.mjs
// Env:   PROBE_BASE (default http://localhost:8134)
// Out:   Tools/visual-regression/output/buffer-logdepth-zfight.png

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

  // cyan = BufferPoint, yellow = BufferPolygon, red = BufferPolyline,
  // magenta = reference BillboardCollection (already log-depth since Batch 250).
  const isCyan = (d, i) => d[i] < 110 && d[i + 1] > 150 && d[i + 2] > 150;
  const isYellow = (d, i) => d[i] > 170 && d[i + 1] > 170 && d[i + 2] < 110;
  const isRed = (d, i) => d[i] > 170 && d[i + 1] < 90 && d[i + 2] < 90;
  const isMagenta = (d, i) => d[i] > 170 && d[i + 2] > 170 && d[i + 1] < 90;
  const countAll = (img, pred) => {
    let n = 0;
    for (let p = 0; p < img.w * img.h; p++) if (pred(img.data, 4 * p)) n++;
    return n;
  };

  const LON = -75.0;
  const LAT = 40.0;
  // A few hundred meters above the ellipsoid — surface-hugging, so at a far
  // nadir camera one 24-bit hyperbolic quantum is tens of km of eye-z and the
  // pre-fix (hyperbolic) Buffer fill lands in the SAME depth bucket as the
  // log-depth globe directly under it, getting eaten. Log depth resolves it.
  const ALT = 300.0;

  // 6x6 grid positions reused by the BufferPoint grid AND the billboard ref.
  const grid = [];
  for (let i = 0; i < 6; i++)
    for (let j = 0; j < 6; j++)
      grid.push([LON - 0.25 + (0.5 * i) / 5, LAT - 0.25 + (0.5 * j) / 5]);

  // ── BufferPointCollection grid (cyan) ────────────────────────────────────
  const points = scene.primitives.add(
    new C.BufferPointCollection({ primitiveCountMax: 256 }),
  );
  const ptMat = new C.BufferPointMaterial({
    color: new C.Color(0.1, 1.0, 1.0, 1.0),
    size: 18,
    outlineWidth: 0,
  });
  for (const [lon, lat] of grid) {
    const p = points.add({ position: C.Cartesian3.fromDegrees(lon, lat, ALT) });
    p.setMaterial(ptMat);
  }

  // ── Reference BillboardCollection grid (magenta) — same positions ────────
  const refImg = document.createElement("canvas");
  refImg.width = 16;
  refImg.height = 16;
  const rg = refImg.getContext("2d");
  rg.fillStyle = "#ffffff";
  rg.fillRect(0, 0, 16, 16);
  const bbs = scene.primitives.add(new C.BillboardCollection());
  for (const [lon, lat] of grid) {
    bbs.add({
      position: C.Cartesian3.fromDegrees(lon, lat, ALT),
      image: refImg,
      color: C.Color.MAGENTA,
      width: 18,
      height: 18,
      disableDepthTestDistance: 0.0,
    });
  }

  // ── BufferPolygon quad slab (yellow) — two triangles, no earcut ──────────
  const polys = scene.primitives.add(
    new C.BufferPolygonCollection({
      primitiveCountMax: 16,
      vertexCountMax: 64,
      holeCountMax: 16,
      triangleCountMax: 32,
    }),
  );
  const polyMat = new C.BufferPolygonMaterial({
    color: new C.Color(1.0, 1.0, 0.1, 1.0),
  });
  const corners = [
    [LON - 0.4, LAT - 0.4],
    [LON - 0.32, LAT - 0.4],
    [LON - 0.32, LAT + 0.4],
    [LON - 0.4, LAT + 0.4],
  ];
  const positions = new Float64Array(corners.length * 3);
  for (let k = 0; k < corners.length; k++) {
    const c = C.Cartesian3.fromDegrees(corners[k][0], corners[k][1], ALT);
    positions[k * 3] = c.x;
    positions[k * 3 + 1] = c.y;
    positions[k * 3 + 2] = c.z;
  }
  const polyResult = polys.add({
    positions,
    holes: new Uint32Array([]),
    triangles: new Uint32Array([0, 1, 2, 0, 2, 3]),
    material: polyMat,
  });

  // ── BufferPolyline (red) — a vertical line east of the grid ──────────────
  const lines = scene.primitives.add(
    new C.BufferPolylineCollection({
      primitiveCountMax: 16,
      vertexCountMax: 64,
    }),
  );
  const lineMat = new C.BufferPolylineMaterial({
    color: new C.Color(1.0, 0.1, 0.1, 1.0),
    width: 10,
  });
  const linePts = new Float64Array(3 * 8);
  for (let k = 0; k < 8; k++) {
    const c = C.Cartesian3.fromDegrees(LON + 0.36, LAT - 0.4 + (0.8 * k) / 7, ALT);
    linePts[k * 3] = c.x;
    linePts[k * 3 + 1] = c.y;
    linePts[k * 3 + 2] = c.z;
  }
  const lineResult = lines.add({ positions: linePts, material: lineMat });

  v.camera.setView({
    destination: C.Cartesian3.fromDegrees(LON, LAT, 220000.0),
    orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
  });

  // Settle the globe (tilesLoaded-gated, not a fixed warmup).
  await frame(30);
  let stable = 0;
  for (let i = 0; i < 150 && stable < 6; i++) {
    await frame(1);
    stable = scene.globe.tilesLoaded ? stable + 1 : 0;
  }
  await frame(12);

  const img = await snap(true);
  const cyan = countAll(img, isCyan);
  const yellow = countAll(img, isYellow);
  const red = countAll(img, isRed);
  const magenta = countAll(img, isMagenta);

  // Flip off→on once to exercise the LOG_DEPTH flip-rebuild guard. We do NOT
  // assert post-flip pixels (mid-session toggle blacks the globe); we only
  // require no validation error, captured in `errors`.
  scene.context._logDepthWriteEnabled = false;
  await frame(15);
  scene.context._logDepthWriteEnabled = true;
  await frame(20);

  return {
    cyan,
    yellow,
    red,
    magenta,
    polyReady: polyResult !== undefined,
    lineReady: lineResult !== undefined,
    png: img.png,
    useLogDepth: scene._frameState ? scene._frameState.useLogDepth : null,
    masterSwitch: scene.context._logDepthWriteEnabled,
  };
});

fs.mkdirSync(OUT_DIR, { recursive: true });
if (out.png)
  fs.writeFileSync(
    path.join(OUT_DIR, "buffer-logdepth-zfight.png"),
    Buffer.from(out.png.split(",")[1], "base64"),
  );

const CYAN_MIN = 1000;
const YELLOW_MIN = 4000;
const RED_MIN = 1000;
const MAGENTA_MIN = 1000;
// The cyan BufferPoint grid and the magenta billboard reference are co-located
// at the same 36 positions and similar on-screen size. Post-fix both compose on
// the log globe, so the cyan coverage should be a healthy fraction of the
// magenta reference (point quads are circles vs billboard squares, so allow the
// point coverage to be smaller — require >= 40%). Pre-fix the hyperbolic Buffer
// points would be eaten by the log globe and this ratio would collapse toward 0.
const TRACK_MIN = 0.4;

let ok = true;
const check = (label, pass, detail) => {
  console.log(`(${label}) ${detail} ${pass ? "OK" : "FAIL"}`);
  if (!pass) ok = false;
};

const trackRatio = out.magenta > 0 ? out.cyan / out.magenta : 0;

check(
  "1",
  out.cyan >= CYAN_MIN &&
    out.yellow >= YELLOW_MIN &&
    out.red >= RED_MIN &&
    out.magenta >= MAGENTA_MIN,
  `Buffer point/polygon/polyline + billboard ref render @220km (log depth ON): cyan=${out.cyan}/${CYAN_MIN} yellow=${out.yellow}/${YELLOW_MIN} red=${out.red}/${RED_MIN} magenta(ref)=${out.magenta}/${MAGENTA_MIN} (polyReady=${out.polyReady} lineReady=${out.lineReady} useLogDepth=${out.useLogDepth})`,
);
check(
  "2",
  trackRatio >= TRACK_MIN,
  `Buffer fill composes on the log globe (NOT sunk behind terrain): cyan/magenta coverage ratio=${trackRatio.toFixed(3)} (>= ${TRACK_MIN}; pre-fix hyperbolic Buffer would collapse toward 0 while the log billboard ref stays). cyan=${out.cyan} magenta=${out.magenta}`,
);
check(
  "3",
  errors.length === 0,
  `flip off→on exercises the Buffer LOG_DEPTH flip-rebuild guard with NO validation error (masterSwitch back=${out.masterSwitch})`,
);
check("4", errors.length === 0, `console errors: ${errors.length}`);
if (errors.length) for (const e of errors.slice(0, 8)) console.log(`  ERR: ${e}`);

console.log(ok ? "PASS" : "FAIL");
await browser.close();
process.exit(ok ? 0 : 1);
