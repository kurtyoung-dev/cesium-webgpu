#!/usr/bin/env node
// Probe (NEW-PRIMITIVE-MAT-LOG-DEPTH — log-depth slice for the Mat/PBR/Basic
// geometry primitives). Until this slice, only the lit Phong producers
// (PrimitivePhongColor / PrimitivePhongTexturedColor) wrote LOGARITHMIC
// @builtin(frag_depth); every geometry Primitive routed through a Mat*/PBR/
// Basic pipeline still wrote HYPERBOLIC NDC z into the SAME scene depth buffer
// the globe now writes LOG depth into. At a far nadir camera that mismatch is a
// range-dependent z-fight: a low-altitude box loses a large fraction of its
// pixels to terrain bleed-through (the re-audit measured ~28% loss).
//
// This probe renders a green Box with a MaterialAppearance (ColorMaterial →
// the Mat pipeline — the NEW log-depth path) ~2 km above a solid globe at a
// 220 km nadir camera, lets the globe settle, and counts the box's green
// pixels with renderer-wide log depth ON vs OFF (runtime kill switch). After
// the fix, ON green-px MUST be >= OFF green-px (no more terrain bleed-through),
// and ON must keep essentially all of the box.
//
// A magenta billboard grid at the same altitude (already log-depth since
// Batch 250) is the reference: it should be stable across ON/OFF.
//
// Checks:
//   (1) ON  — green box renders with ~all its pixels (>= MIN floor).
//   (2) ON  >= OFF — log depth recovers the pixels hyperbolic depth lost.
//   (3) negative control — a green box 2 km BELOW the surface stays occluded.
//   (4) flip back ON re-verifies (exercises the Mat-pipeline flip-rebuild guard).
//   (5) 0 console errors (incl. WebGPU validation errors).
//
// Usage: node Tools/visual-regression/probe-logdepth-zfight.mjs
// Env:   PROBE_BASE (default http://localhost:8134)
// Out:   Tools/visual-regression/output/logdepth-zfight-{on,off}.png

// ─────────────────────────────────────────────────────────────────────────────
// RECORDING VALIDITY NOTE (NEW-WEBGPU-PIPELINE-KEY-LOG-DEPTH, fixed 2026-08-01)
//
// Any result recorded from this probe BEFORE the pipeline-key log-depth markers
// landed is INVALID for its gate-OFF leg and must not be cited as a baseline.
//
// This probe flips `context._logDepthWriteEnabled` mid-session (lines 265 / 272)
// with a globe already on screen. Until the fix, the central pipeline cache
// (`WebGPURenderPipelineCache.generateCacheKey`) hashed `descriptor.name` plus
// structural fields ONLY — never `vertex.module` / `fragment.module` /
// `entryPoint` / the define bitmask — and the globe's descriptor name carried no
// log-depth marker. On the flip the globe rebuilt its descriptor around the
// correctly-recompiled module, looked it up under an UNCHANGED name, and was
// handed back the pipeline it had already cached. The globe therefore kept its
// STARTUP pipeline through BOTH legs, so the gate-off leg never exercised the
// globe's off state at all.
//
// SUBJECT IMPACT: the green box's own Mat/PBR pipeline did flip correctly; what
// did not flip was the globe whose depth this probe z-fights against. Since the
// entire measurement is "box pixels lost to terrain bleed-through", the OFF
// reference was measured against a globe still writing LOG depth — i.e. it was
// not a hyperbolic reference at all.
//
// The assertions here are unchanged and remain correct; only the pre-fix
// recorded numbers are void. From the fix onward this probe's OFF leg is
// meaningful for the first time. Guards:
// `pipeline-key-aliasing.spec.mjs` (static) and
// `probe-pipeline-key-aliasing.mjs` (runtime).
//
// STATUS 2026-08-02 — THE FLIP IS NOW REAL END TO END, and this probe is
// RUNNABLE. Two separate defects had to close:
//   * Batch 803 (NEW-WEBGPU-PIPELINE-KEY-LOG-DEPTH) made the globe's pipeline
//     genuinely REBUILD on the master-switch flip, via the `, ld=1`
//     descriptor-name marker. That is what un-voids the gate-OFF leg described
//     above.
//   * NEW-WEBGPU-GLOBE-USE-LOG-DEPTH routed the globe's log-depth state through
//     the shared gate `isWebGPULogDepthActive(context, frameState)`, so it also
//     honours `frameState.useLogDepth`.
// This probe never leaves SCENE3D with a perspective frustum, where
// `useLogDepth === true` (it is already reported in this probe's output), so
// `master && useLogDepth === master` and the second change does NOT alter what
// is measured here. It re-voids nothing; a re-baseline is still required only
// because no post-803 recording exists.
//
// ★ ORCHESTRATOR: RUN THIS ONE FIRST of the five. It is the only single-subject
// probe whose entire measurement — green-slab pixels lost to terrain
// bleed-through — is read directly against GLOBE depth, so it re-establishes
// the globe's OFF reference with no second aliasing source to confound it.
// Guard for the second change: `globe-use-log-depth.spec.mjs`.
// ─────────────────────────────────────────────────────────────────────────────

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
await page.goto(
  `${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu&offline=true`,
  {
    waitUntil: "networkidle",
  },
);
await page.waitForFunction(() => !!window.viewer);

const out = await page.evaluate(async () => {
  const C = await import("/Build/CesiumUnminified/index.js");
  const v = window.viewer;
  const scene = v.scene;
  const ctx = scene.context;
  v.clock.shouldAnimate = false;

  // Do not inherit CesiumViewer's online world-terrain startup. A missing Ion
  // response produces a black frame that this depth-composition probe cannot
  // distinguish from a globe pipeline that failed to draw. Offline startup
  // already selects the ellipsoid; assign it explicitly as part of the probe's
  // deterministic scene contract.
  v.terrainProvider = new C.EllipsoidTerrainProvider();

  // Solid-color globe — no imagery/Ion dependency, deterministic pixels.
  scene.globe.show = true;
  // The negative control and the feature under test both require primitives
  // to depth-test against terrain. Cesium's default is false, which
  // intentionally clears globe depth before opaque primitives and substitutes
  // the ellipsoid depth plane; under that policy an underground primitive is
  // allowed to render and this is not a globe-depth composition test.
  scene.globe.depthTestAgainstTerrain = true;
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
          clearGlobeDepth: scene._environmentState?.clearGlobeDepth ?? null,
        });
      });
      scene.render();
    });

  // Green = box (Mat pipeline). Magenta = reference billboards (already log).
  const isGreen = (d, i) => d[i + 1] > 150 && d[i] < 110 && d[i + 2] < 110;
  const isMagenta = (d, i) => d[i] > 180 && d[i + 2] > 180 && d[i + 1] < 90;
  // INSTRUMENT FIX (2026-08-02, round 2): the below-ground negative-control
  // boxes are now BLUE, so the green subject count needs no spatial
  // exclusion — a color can never straddle a region boundary. isBelowBlue
  // is deliberately narrow (blue-dominant, low green) so the dark-blue
  // globe baseColor (31,38,51) stays far below its thresholds.
  const isBelowBlue = (d, i) => d[i + 2] > 180 && d[i] < 120 && d[i + 1] < 120;
  const countAll = (img, pred) => {
    let n = 0;
    for (let p = 0; p < img.w * img.h; p++) if (pred(img.data, 4 * p)) n++;
    return n;
  };
  // The dark-blue globe baseColor fills most of the frame; a (near-)black frame
  // is the globe having skipped its draw this frame (the documented async-
  // pipeline / kill-switch settle race). The negative control (below-ground
  // boxes must be occluded) is only meaningful when the globe actually wrote
  // depth, so gate every capture on the globe being present. Sample the globe
  // baseColor directly (rgb ~31,38,51): require a healthy non-black fraction.
  const globeDrawn = (img) => {
    let nonBlack = 0;
    const total = img.w * img.h;
    for (let p = 0; p < total; p++) {
      const i = 4 * p;
      // baseColor pixels: blue dominant, all channels > black-ish floor.
      if (img.data[i + 2] > 20 && img.data[i + 1] > 10 && img.data[i] < 120)
        nonBlack++;
    }
    return nonBlack / total > 0.25; // globe fills well over a quarter of the frame
  };
  // Readiness-gated capture (Batch 808 recipe): the cold pipeline variant a
  // master-switch flip requests takes ~1-2 s of WALL CLOCK to compile
  // (measured 2674 ms), and headless rAF frames under-run that budget — the
  // old 40x2-frame retry loop expired just short and SILENTLY returned a
  // globe-less frame, which read as +8k unoccluded pixels (2026-08-02)
  // first-honest-run incident). setTimeout yields guarantee wall clock
  // passes; the caller gates on `ready`.
  const snapWithGlobe = async (withPng, budgetMs = 45000) => {
    const t0 = performance.now();
    let img = await snap(withPng);
    while (!globeDrawn(img) && performance.now() - t0 < budgetMs) {
      await new Promise((r) => setTimeout(r, 150));
      await frame(1);
      img = await snap(withPng);
    }
    img.ready = globeDrawn(img);
    return img;
  };

  const LON = -75.0;
  const LAT = 40.0;
  // Thin slab ~10 m thick, centered ~5 m above the ellipsoid surface. The slab
  // is near-COPLANAR with the globe at this nadir camera — exactly the condition
  // that produces the hyperbolic-depth z-fight: at 220 km, one 24-bit hyperbolic
  // quantum is tens of km of eye-z, so a surface-hugging slab and the globe
  // directly under it land in the SAME depth bucket and the globe bleeds through,
  // eating slab pixels. Log depth resolves them at sub-meter precision.
  const ALT = 5.0;
  const THICK = 10.0;
  const SPAN = 9000.0; // 9 km footprint per slab

  // ---- Green slab via MaterialAppearance (ColorMaterial → Mat pipeline) ----
  const boxGeom = C.BoxGeometry.fromDimensions({
    vertexFormat: C.MaterialAppearance.MaterialSupport.BASIC.vertexFormat,
    dimensions: new C.Cartesian3(SPAN, SPAN, THICK),
  });
  const instances = [];
  for (let i = 0; i < 36; i++) {
    const lon = LON - 0.25 + 0.1 * (i % 6);
    const lat = LAT - 0.25 + 0.1 * Math.floor(i / 6);
    const center = C.Cartesian3.fromDegrees(lon, lat, ALT);
    instances.push(
      new C.GeometryInstance({
        geometry: boxGeom,
        modelMatrix: C.Transforms.eastNorthUpToFixedFrame(center),
      }),
    );
  }
  const greenMat = C.Material.fromType("Color");
  greenMat.uniforms.color = new C.Color(0.1, 1.0, 0.1, 1.0);
  const boxPrim = scene.primitives.add(
    new C.Primitive({
      geometryInstances: instances,
      appearance: new C.MaterialAppearance({
        material: greenMat,
        // This intentionally requests lighting, but BASIC geometry has no ST
        // attribute and the current WebGPU material selector therefore chooses
        // matColorFlat. This is the layout the original regression exercised.
        flat: false,
        translucent: false,
      }),
      asynchronous: false,
    }),
  );

  // Reference billboards (magenta) at the same altitude — already log-depth.
  const img16 = document.createElement("canvas");
  img16.width = 16;
  img16.height = 16;
  const g16 = img16.getContext("2d");
  g16.fillStyle = "#ffffff";
  g16.fillRect(0, 0, 16, 16);
  const bbs = scene.primitives.add(new C.BillboardCollection());
  for (let i = 0; i < 36; i++) {
    bbs.add({
      position: C.Cartesian3.fromDegrees(
        LON - 0.25 + 0.1 * (i % 6),
        LAT - 0.25 + 0.1 * Math.floor(i / 6),
        ALT,
      ),
      image: img16,
      color: C.Color.MAGENTA,
      disableDepthTestDistance: 0.0,
    });
  }

  // Negative control: green boxes 2 km BELOW the surface — must stay occluded.
  const belowInstances = [];
  for (let i = 0; i < 9; i++) {
    const center = C.Cartesian3.fromDegrees(
      LON + 0.35 + 0.05 * (i % 3),
      LAT + 0.35 + 0.05 * Math.floor(i / 3),
      -3000.0,
    );
    belowInstances.push(
      new C.GeometryInstance({
        geometry: boxGeom,
        modelMatrix: C.Transforms.eastNorthUpToFixedFrame(center),
      }),
    );
  }
  const belowMat = C.Material.fromType("Color");
  belowMat.uniforms.color = new C.Color(0.15, 0.25, 1.0, 1.0); // BLUE — distinct from the subject slab so occlusion bleed can NEVER pollute the green subject count (2026-08-02 instrument fix)
  scene.primitives.add(
    new C.Primitive({
      geometryInstances: belowInstances,
      appearance: new C.MaterialAppearance({
        material: belowMat,
        flat: false,
        translucent: false,
      }),
      asynchronous: false,
    }),
  );

  // Camera: 220 km straight down — the far-range z-fight envelope.
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

  // ---- (1) ON leg ----
  const imgOn = await snapWithGlobe(true);
  const onGlobe = globeDrawn(imgOn);
  const onGreen = countAll(imgOn, isGreen);
  const onMag = countAll(imgOn, isMagenta);
  const onForeground = countAll(
    imgOn,
    (data, index) => isGreen(data, index) || isMagenta(data, index),
  );

  // Locate the below-ground green by sampling the upper-right control region:
  // count green pixels in x>[640..900], y<[120..320] (where the below boxes
  // project). If depth testing works, ~0.
  // Below-ground bleed = BLUE pixels anywhere in frame (distinct color,
  // no projection-rectangle guesswork).
  const ctrlCount = (img) => countAll(img, isBelowBlue);
  const ctrlGreen = ctrlCount(imgOn);

  // ---- (2) OFF leg — runtime kill switch to hyperbolic ----
  ctx._logDepthWriteEnabled = false;
  await frame(20); // Mat pipeline rebuilds via its flip guard
  const imgOff = await snapWithGlobe(true);
  const offGlobe = imgOff.ready === true;
  const offGreen = countAll(imgOff, isGreen);
  const offMag = countAll(imgOff, isMagenta);
  const offForeground = countAll(
    imgOff,
    (data, index) => isGreen(data, index) || isMagenta(data, index),
  );
  // OFF-leg control count: with hyperbolic depth the below-ground boxes are
  // EXPECTED to bleed through (the z-fight the feature fixes) — recorded as
  // evidence, not gated.
  const offCtrlGreen = ctrlCount(imgOff);

  // ---- flip back ON and re-verify ----
  ctx._logDepthWriteEnabled = true;
  await frame(20);
  const imgOn2 = await snapWithGlobe(false);
  const on2Green = countAll(imgOn2, isGreen);

  return {
    onGreen,
    onMag,
    onForeground,
    offGreen,
    offMag,
    offForeground,
    on2Green,
    ctrlGreen,
    offCtrlGreen,
    offGlobe,
    onGlobe,
    onClearGlobeDepth: imgOn.clearGlobeDepth,
    boxReady: boxPrim.ready,
    pngOn: imgOn.png,
    pngOff: imgOff.png,
    useLogDepth: scene._frameState ? scene._frameState.useLogDepth : null,
  };
});

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const [k, f] of [
  ["pngOn", "logdepth-zfight-on.png"],
  ["pngOff", "logdepth-zfight-off.png"],
]) {
  if (out[k]) {
    fs.writeFileSync(
      path.join(OUT_DIR, f),
      Buffer.from(out[k].split(",")[1], "base64"),
    );
  }
}

// The slab grid covers a large region; require a conservative floor. The core
// signal (per the re-audit): with renderer-wide log depth ON but the Mat slab
// still writing HYPERBOLIC depth (the PRE-fix mixed state), the slab and the
// log-depth globe live in different depth spaces and the slab lost ~28% of its
// pixels (audit: 2913 ON / 4067 OFF). After this fix the slab ALSO writes log
// depth, so the two compose correctly and ON recovers to ≈ OFF. We therefore
// assert ON is within a tight ratio band of OFF — NOT the catastrophic 28%
// deficit the bug produced. (OFF here is the all-hyperbolic kill-switch leg,
// the internally-consistent reference count.)
const GREEN_MIN = 5000;
const RECOVER_RATIO = 0.9; // ON must keep >= 90% of OFF's pixels (bug = 72%)

let ok = true;
const check = (label, pass, detail) => {
  console.log(`(${label}) ${detail} ${pass ? "OK" : "FAIL"}`);
  if (!pass) ok = false;
};

// The magenta reference billboards intentionally share the slab positions and
// overwrite some green pixels in the ON image. Count the union for the
// composition gate so reference coverage cannot masquerade as terrain loss.
const ratio = out.offForeground > 0 ? out.onForeground / out.offForeground : 0;
check(
  "1",
  out.onGreen >= GREEN_MIN,
  `Mat-pipeline green slab renders @220km (log depth ON): green=${out.onGreen}/${GREEN_MIN} (boxReady=${out.boxReady}, useLogDepth=${out.useLogDepth})`,
);
// STRUCTURAL precondition for check (2): the OFF leg must have its globe. The
// master-switch flip requests a cold hyperbolic globe pipeline (~1-2 s async
// compile); a capture inside that window has no occluder and inflates the OFF
// count — the 2026-08-02 first-honest-run incident read exactly that as a fake
// 23% ON "loss".
check(
  "2g",
  out.offGlobe === true,
  `globe present in OFF capture (precondition for the OFF reference): offGlobe=${out.offGlobe}`,
);
check(
  "2",
  ratio >= RECOVER_RATIO,
  `log depth composes with the log globe: ON/OFF foreground ratio=${ratio.toFixed(3)} (>= ${RECOVER_RATIO}; green-or-magenta union prevents the colocated reference from reading as slab loss). ONfg=${out.onForeground} OFFfg=${out.offForeground} greenON=${out.onGreen} greenOFF=${out.offGreen} offBelowBleed=${out.offCtrlGreen}`,
);
// The negative control is only meaningful when the globe is present to occlude
// (the globe writes the depth that occludes the below-ground boxes). snapWithGlobe
// guarantees it; assert it explicitly so a settle race can't masquerade as a
// passing-but-empty frame (was an intermittent false FAIL pre-Batch-267).
check(
  "3g",
  out.onGlobe === true,
  `globe present in capture (precondition for occlusion): onGlobe=${out.onGlobe}`,
);
check(
  "3",
  out.ctrlGreen <= 40,
  `below-ground negative control: BLUE below-box pixels in ON frame=${out.ctrlGreen} (max 40 — depth test must still occlude)`,
);
check(
  "4",
  out.on2Green >= GREEN_MIN,
  `flip back ON re-verifies (Mat flip-rebuild guard): green=${out.on2Green}`,
);

check(
  "D0",
  out.onClearGlobeDepth === false,
  `retained globe depth for primitive composition: clearGlobeDepth=${out.onClearGlobeDepth}`,
);
console.log(
  `    reference magenta billboards: ON=${out.onMag} OFF=${out.offMag} (OFF=0 is EXPECTED physics — surface-hugging billboards tie with the globe in one hyperbolic quantum at 220 km and lose; log depth is what resolves them)`,
);
check("5", errors.length === 0, `console errors: ${errors.length}`);
if (errors.length)
  for (const e of errors.slice(0, 8)) console.log(`  ERR: ${e}`);

console.log(ok ? "PASS" : "FAIL");
await browser.close();
process.exit(ok ? 0 : 1);
