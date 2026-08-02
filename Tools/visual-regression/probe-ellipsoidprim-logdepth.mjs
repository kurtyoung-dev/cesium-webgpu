#!/usr/bin/env node
// Probe (NEW-ELLIPSOIDPRIM-LOG-DEPTH — log-depth slice for the ray-marched
// EllipsoidPrimitive) + BUG-ELLIPSOIDPRIM-WEBGPU-INVISIBLE end-to-end pixel
// verification.
//
// HISTORY:
//   Batch 266 shipped the LOG_DEPTH shader variant + flip-rebuild guard but the
//   WebGPU EllipsoidPrimitive rendered 0 visible pixels (log ON and OFF), so the
//   pixel ON~=OFF assertions were scaffolded-but-disabled — only the structural
//   compile/flip/error-free invariant was checked. Two stacked pre-existing bugs
//   were the cause (BUG-ELLIPSOIDPRIM-WEBGPU-INVISIBLE):
//     (a) the renderer read `primitive.modelMatrix` instead of the Scene's
//         `_computedModelMatrix` (= modelMatrix * translate(center)), dropping
//         `center` so the shell landed at the model-frame origin;
//     (b) the ray-cast used a full-screen quad with a FOV-less fake eyeDirection
//         (x*aspect, y, -1) that never matched the real camera ray → 0 fragments.
//   Batch 269 fixed both: the renderer now uses _computedModelMatrix and renders
//   a radii-scaled bounding-box geometry whose rasterized eye-space surface
//   gives the FS correct per-pixel rays (mirrors WebGL EllipsoidVS/FS). The pixel
//   assertions below are now ENABLED.
//
// Checks:
//   (1) log depth reports ACTIVE when the master switch is on (useLogDepth=true).
//   (2) the EllipsoidPrimitive renderer materializes its cache + pipeline with
//       log depth ON (`_pipelineLogDepth === true`).
//   (3) the ellipsoid renders NON-ZERO green pixels with log depth ON (the shell
//       is lit + composes against the log globe).
//   (4) flipping the kill switch OFF rebuilds the pipeline (`_pipelineLogDepth
//       === false`) AND still renders ~the same green-pixel count (ON ~= OFF).
//   (5) flipping back ON rebuilds again (`_pipelineLogDepth === true`) and the
//       ellipsoid is still visible.
//   (6) FAR-CAMERA composition: from a distant camera the log ellipsoid at
//       altitude still renders non-zero pixels and is NOT eaten by the globe
//       (no terrain bleed-through / z-fight at planetary distance).
//   (7) 0 console / WebGPU validation errors across the whole flip sequence.
//
// Usage: node Tools/visual-regression/probe-ellipsoidprim-logdepth.mjs
// Env:   PROBE_BASE (default http://localhost:8134)

// ─────────────────────────────────────────────────────────────────────────────
// RECORDING VALIDITY NOTE (NEW-WEBGPU-PIPELINE-KEY-LOG-DEPTH, fixed 2026-08-01)
//
// Any result recorded from this probe BEFORE the pipeline-key log-depth markers
// landed is INVALID for its gate-OFF leg and must not be cited as a baseline.
// This probe is the WORST affected of the five, because BOTH sides were stale.
//
// This probe flips `context._logDepthWriteEnabled` mid-session (lines 178 / 186)
// with a globe already on screen. Until the fix, the central pipeline cache
// (`WebGPURenderPipelineCache.generateCacheKey`) hashed `descriptor.name` plus
// structural fields ONLY — never `vertex.module` / `fragment.module` /
// `entryPoint` / the define bitmask.
//
// SUBJECT IMPACT: the globe's descriptor name carried no log-depth marker, so it
// kept its STARTUP pipeline through both legs. AND this probe's own subject —
// `WebGPUEllipsoidPrimitiveRenderer`'s COLOR pipeline — was named by the
// constant `"EllipsoidPrimitive color pipeline"`, so it aliased too: the
// renderer's `_pipelineLogDepth` guard rebuilt the descriptor with the correct
// module and the cache handed back the other one. (The PICK descriptor already
// carried an `[ld]` marker and was the only correct half.) The gate-off leg
// therefore exercised neither the globe's nor the EllipsoidPrimitive's off state.
//
// The assertions here are unchanged and remain correct; only the pre-fix
// recorded numbers are void. Guards: `pipeline-key-aliasing.spec.mjs` (static)
// and `probe-pipeline-key-aliasing.mjs` (runtime).
//
// STATUS 2026-08-02 — THE FLIP IS NOW REAL END TO END, and this probe is
// RUNNABLE. Two separate defects had to close:
//   * Batch 803 (NEW-WEBGPU-PIPELINE-KEY-LOG-DEPTH) made the globe's pipeline
//     genuinely REBUILD on the master-switch flip, via the `, ld=1`
//     descriptor-name marker.
//   * NEW-WEBGPU-GLOBE-USE-LOG-DEPTH routed the globe's log-depth state through
//     the shared gate `isWebGPULogDepthActive(context, frameState)`, so it also
//     honours `frameState.useLogDepth`.
// This probe never leaves SCENE3D with a perspective frustum, where
// `useLogDepth === true` (it ASSERTS that, see the `out.useLogDepth === true`
// gate below), so `master && useLogDepth === master` and the second change does
// NOT alter what is measured here. It re-voids nothing.
//
// ★ ORCHESTRATOR: run this SECOND, after `probe-logdepth-zfight`. This probe
// was the worst affected of the five — pre-803 BOTH the globe and its own
// subject aliased — which makes it the strongest confirmation but the most
// confounded: a clean result here is only interpretable once the globe's OFF
// reference has been re-established by a single-subject probe.
// Guard for the second change: `globe-use-log-depth.spec.mjs`.
// ─────────────────────────────────────────────────────────────────────────────

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

  // Deterministic readback INSIDE postRender (rules: readback inside postRender).
  const snap = () =>
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
        });
      });
      scene.render();
    });

  // The ellipsoid material is bright green (0.1, 1.0, 0.1); the FS dims it to
  // 0.3..1.0 of base by NdotL. Accept any pixel where green clearly dominates.
  const isGreen = (d, i) =>
    d[i + 1] > 70 && d[i + 1] > d[i] + 30 && d[i + 1] > d[i + 2] + 30;
  const countGreen = (img) => {
    let n = 0;
    for (let p = 0; p < img.w * img.h; p++) if (isGreen(img.data, 4 * p)) n++;
    return n;
  };
  // Gate captures on the globe actually having drawn (dark-blue baseColor fills
  // most of the frame). A near-black frame means the globe skipped its draw this
  // tick (async-pipeline settle race) and the no-bleed assertion would be moot.
  const globeDrawn = (img) => {
    let nonBlack = 0;
    const total = img.w * img.h;
    for (let p = 0; p < total; p++) {
      const i = 4 * p;
      if (img.data[i + 2] > 20 && img.data[i + 1] > 10 && img.data[i] < 120)
        nonBlack++;
    }
    return nonBlack / total > 0.2;
  };
  const snapWithGlobe = async (maxTries = 40) => {
    let img = await snap();
    for (let t = 0; t < maxTries && !globeDrawn(img); t++) {
      await frame(2);
      img = await snap();
    }
    return img;
  };

  const LON = -75.0;
  const LAT = 40.0;
  const m = C.Material.fromType("Color");
  m.uniforms.color = new C.Color(0.1, 1.0, 0.1, 1.0);
  // Canonical placement (matches WebGL EllipsoidPrimitive.modelMatrix JSDoc):
  // modelMatrix = ENU frame at the origin; center defaults to ZERO. Passing a
  // world-position `center` AND an ENU modelMatrix (as an earlier draft of this
  // probe did) double-positions the shell to ~2x Earth radius — behind the
  // camera — which is why it appeared invisible (it WAS off-screen).
  const ep = new C.EllipsoidPrimitive({
    radii: new C.Cartesian3(30000.0, 30000.0, 30000.0),
    material: m,
    modelMatrix: C.Transforms.eastNorthUpToFixedFrame(
      C.Cartesian3.fromDegrees(LON, LAT, 50000.0),
    ),
  });
  scene.primitives.add(ep);

  // ---- Near camera (the original probe view) ----
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

  // ON leg — structural + pixels.
  const useLogDepth = scene._frameState ? scene._frameState.useLogDepth : null;
  const onCache = ep._webgpuCache;
  const onLog = onCache ? onCache._pipelineLogDepth : null;
  const onPipeline = !!onCache?.pipeline;
  const onImg = await snapWithGlobe();
  const onGreen = countGreen(onImg);

  // OFF leg — runtime kill switch.
  ctx._logDepthWriteEnabled = false;
  await frame(20);
  const offLog = ep._webgpuCache ? ep._webgpuCache._pipelineLogDepth : null;
  const offPipeline = !!ep._webgpuCache?.pipeline;
  const offImg = await snapWithGlobe();
  const offGreen = countGreen(offImg);

  // Flip back ON.
  ctx._logDepthWriteEnabled = true;
  await frame(20);
  const on2Log = ep._webgpuCache ? ep._webgpuCache._pipelineLogDepth : null;
  const on2Pipeline = !!ep._webgpuCache?.pipeline;
  const on2Img = await snapWithGlobe();
  const on2Green = countGreen(on2Img);

  // ---- Far camera: log ellipsoid at altitude composed against the log globe
  // at planetary distance. Pull WAY back; the shell must still render and not be
  // eaten by terrain bleed-through (the z-fight failure mode log depth fixes).
  v.camera.setView({
    destination: C.Cartesian3.fromDegrees(LON, LAT, 6000000.0),
    orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
  });
  await frame(20);
  stable = 0;
  for (let i = 0; i < 120 && stable < 6; i++) {
    await frame(1);
    stable = scene.globe.tilesLoaded ? stable + 1 : 0;
  }
  const farImg = await snapWithGlobe();
  const farGreen = countGreen(farImg);
  const farGlobeOk = globeDrawn(farImg);

  return {
    useLogDepth,
    onLog,
    onPipeline,
    onGreen,
    offLog,
    offPipeline,
    offGreen,
    on2Log,
    on2Pipeline,
    on2Green,
    farGreen,
    farGlobeOk,
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
  out.onGreen > 200,
  `ellipsoid renders green pixels with LOG ON: green=${out.onGreen}`,
);

// ON ~= OFF: same shell, log-depth only affects the depth value, not coverage.
const lo = Math.min(out.onGreen, out.offGreen);
const hi = Math.max(out.onGreen, out.offGreen);
const ratio = hi > 0 ? lo / hi : 0;
check(
  "4",
  out.offLog === false &&
    out.offPipeline === true &&
    out.offGreen > 200 &&
    ratio > 0.8,
  `kill switch OFF rebuilds hyperbolic pipeline + ON~=OFF pixels: _pipelineLogDepth=${out.offLog} pipeline=${out.offPipeline} offGreen=${out.offGreen} onGreen=${out.onGreen} ratio=${ratio.toFixed(3)}`,
);
check(
  "5",
  out.on2Log === true && out.on2Pipeline === true && out.on2Green > 200,
  `flip back ON rebuilds log pipeline + still visible: _pipelineLogDepth=${out.on2Log} pipeline=${out.on2Pipeline} on2Green=${out.on2Green}`,
);
check(
  "6",
  out.farGlobeOk === true && out.farGreen > 50,
  `FAR camera: log globe present + ellipsoid NOT eaten by terrain bleed-through: globeOk=${out.farGlobeOk} farGreen=${out.farGreen}`,
);
check(
  "7",
  errors.length === 0,
  `console / WebGPU validation errors: ${errors.length}`,
);
if (errors.length)
  for (const e of errors.slice(0, 8)) console.log(`  ERR: ${e}`);

console.log(ok ? "PASS" : "FAIL");
await browser.close();
process.exit(ok ? 0 : 1);
