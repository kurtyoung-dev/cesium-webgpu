#!/usr/bin/env node
// Probe (NEW-ELLIPSOIDPRIM-LOG-DEPTH — log-depth slice for the ray-marched
// EllipsoidPrimitive). Verifies the LOG_DEPTH shader variant compiles, the
// renderer's flip-rebuild guard toggles the pipeline, and NO WebGPU validation
// or console errors occur across a log-depth ON -> OFF -> ON flip while an
// EllipsoidPrimitive is in the scene over a settled globe.
//
// WHY THIS IS A STRUCTURAL (no-pixel) PROBE:
//   The WebGPU EllipsoidPrimitive renderer does NOT currently produce visible
//   output for a scene-placed ellipsoid (verified 2026-06-13: 0 lit pixels with
//   log depth BOTH ON and OFF, for radii 30 km..200 km, center passed via either
//   `center` or `modelMatrix`). Two pre-existing gaps stack:
//     (a) updateWebGPUEllipsoidPrimitive reads `primitive.modelMatrix` instead of
//         the Scene's `_computedModelMatrix` (= modelMatrix * translate(center)),
//         so `center` is dropped and the shell lands at the Earth's center;
//     (b) even when placed via modelMatrix translation the ray-cast quad emits no
//         visible coverage at these views.
//   Both predate this log-depth slice (the OFF leg is byte-identical to the
//   pre-change shader, and it is equally invisible). They are tracked as
//   BUG-ELLIPSOIDPRIM-WEBGPU-INVISIBLE in DEFERRED_WORK.md. Until that lands a
//   pixel ON~=OFF assertion is impossible, so this probe asserts the achievable
//   invariant: the log-depth plumbing compiles + flips + stays error-free.
//
// Checks:
//   (1) log depth reports ACTIVE when the master switch is on (useLogDepth=true).
//   (2) the EllipsoidPrimitive renderer materializes its cache + pipeline with
//       log depth ON (`_pipelineLogDepth === true`).
//   (3) flipping the kill switch OFF rebuilds the pipeline (`_pipelineLogDepth
//       === false`) — exercises the flip-rebuild guard.
//   (4) flipping back ON rebuilds again (`_pipelineLogDepth === true`).
//   (5) 0 console / WebGPU validation errors across the whole flip sequence.
//
// Usage: node Tools/visual-regression/probe-ellipsoidprim-logdepth.mjs
// Env:   PROBE_BASE (default http://localhost:8134)

import { chromium } from "playwright";

const BASE = process.env.PROBE_BASE || "http://localhost:8134";

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

  const LON = -75.0;
  const LAT = 40.0;
  const m = C.Material.fromType("Color");
  m.uniforms.color = new C.Color(0.1, 1.0, 0.1, 1.0);
  const ep = new C.EllipsoidPrimitive({
    center: C.Cartesian3.fromDegrees(LON, LAT, 50000.0),
    radii: new C.Cartesian3(30000.0, 30000.0, 30000.0),
    material: m,
    modelMatrix: C.Transforms.eastNorthUpToFixedFrame(
      C.Cartesian3.fromDegrees(LON, LAT, 50000.0),
    ),
  });
  scene.primitives.add(ep);

  v.camera.setView({
    destination: C.Cartesian3.fromDegrees(LON, LAT, 400000.0),
    orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
  });

  await frame(30);
  let stable = 0;
  for (let i = 0; i < 150 && stable < 6; i++) {
    await frame(1);
    stable = scene.globe.tilesLoaded ? stable + 1 : 0;
  }
  await frame(12);

  const ctx = scene.context;

  // ON leg.
  const useLogDepth = scene._frameState ? scene._frameState.useLogDepth : null;
  const onCache = ep._webgpuCache;
  const onLog = onCache ? onCache._pipelineLogDepth : null;
  const onPipeline = !!onCache?.pipeline;

  // OFF leg — runtime kill switch.
  ctx._logDepthWriteEnabled = false;
  await frame(20);
  const offLog = ep._webgpuCache ? ep._webgpuCache._pipelineLogDepth : null;
  const offPipeline = !!ep._webgpuCache?.pipeline;

  // Flip back ON.
  ctx._logDepthWriteEnabled = true;
  await frame(20);
  const on2Log = ep._webgpuCache ? ep._webgpuCache._pipelineLogDepth : null;
  const on2Pipeline = !!ep._webgpuCache?.pipeline;

  return {
    useLogDepth,
    onLog,
    onPipeline,
    offLog,
    offPipeline,
    on2Log,
    on2Pipeline,
  };
});

let ok = true;
const check = (label, pass, detail) => {
  console.log(`(${label}) ${detail} ${pass ? "OK" : "FAIL"}`);
  if (!pass) ok = false;
};

check(
  "1",
  out.useLogDepth === true,
  `renderer-wide log depth active: useLogDepth=${out.useLogDepth}`,
);
check(
  "2",
  out.onLog === true && out.onPipeline === true,
  `EllipsoidPrimitive pipeline built with LOG_DEPTH ON: _pipelineLogDepth=${out.onLog} pipeline=${out.onPipeline}`,
);
check(
  "3",
  out.offLog === false && out.offPipeline === true,
  `kill switch OFF rebuilds hyperbolic pipeline: _pipelineLogDepth=${out.offLog} pipeline=${out.offPipeline}`,
);
check(
  "4",
  out.on2Log === true && out.on2Pipeline === true,
  `flip back ON rebuilds log pipeline: _pipelineLogDepth=${out.on2Log} pipeline=${out.on2Pipeline}`,
);
check("5", errors.length === 0, `console / WebGPU validation errors: ${errors.length}`);
if (errors.length) for (const e of errors.slice(0, 8)) console.log(`  ERR: ${e}`);

console.log(ok ? "PASS" : "FAIL");
await browser.close();
process.exit(ok ? 0 : 1);
