#!/usr/bin/env node
// Probe (WIRE-PP-LIBRARY-BUILTINS): the 7 named PostProcessStageLibrary
// built-ins (BlackAndWhite, Brightness, NightVision, Silhouette,
// EdgeDetection, LensFlare, DepthView) are intercepted on the WebGPU
// backend and substituted with their WGSL twins instead of hitting the
// GLSL-drop warning and no-opping.
// @purpose Gate: the 7 PostProcessStageLibrary builtins get WGSL twins with per-stage cross-backend tolerance, off-gate, and post-tonemap HDR order
// @status ACTIVE
//
// For each stage, on BOTH backends (same deterministic scene):
//   (1) enabling the stage visibly transforms the frame
//       (diff vs that backend's default capture)
//   (2) the WebGPU frame matches the WebGL frame within a per-stage
//       tolerance (mean absolute byte delta). Tolerances are loose for
//       stages with documented divergence (LensFlare has no dirt/star
//       textures on WebGPU; DepthView shows conventional rather than
//       reversed-log depth; NightVision noise is frame-number-seeded).
//   (3) WebGPU-only: the LibraryPP-* render pass label appears while the
//       stage is enabled and never appears by default.
// OFF-GATE:
//   (4) after removing all stages, the WebGPU frame returns
//       BYTE-IDENTICAL to the default capture and no LibraryPP pass is
//       recorded.
//   (5) zero console errors + zero GPU uncapturederrors.
// HDR PHASE (NEW-PP-LIBRARY-TONEMAP-ORDER):
//   (6) with scene.highDynamicRange=true (SDR canvas — tonemap RUNS on
//       both backends), the WebGPU library builtin executes AFTER the
//       tonemap pass (pass-label order) and its output matches WebGL's
//       post-tonemap output within the SDR-band tolerance.
//
// Usage: node Tools/visual-regression/probe-pp-library-builtins.mjs
// Env: PROBE_BASE (default http://localhost:8080)

import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "output",
  "pp-library-builtins",
);
mkdirSync(OUT_DIR, { recursive: true });

// Per-stage config: cross-backend mean-abs-delta tolerance (0-255 bytes)
// + whether the stage output is stable enough for the settle loop
// (NightVision animates noise every frame → plain render+grab).
const STAGES = [
  {
    key: "blackAndWhite",
    create: "createBlackAndWhiteStage",
    tol: 8,
    settle: true,
  },
  { key: "brightness", create: "createBrightnessStage", tol: 8, settle: true },
  {
    key: "nightVision",
    create: "createNightVisionStage",
    tol: 20,
    settle: false,
  },
  { key: "silhouette", create: "createSilhouetteStage", tol: 15, settle: true },
  {
    key: "edgeDetection",
    create: "createEdgeDetectionStage",
    tol: 12,
    settle: true,
  },
  { key: "depthView", create: "createDepthViewStage", tol: 45, settle: true },
];
// LensFlare is exercised separately: WebGL's flare is a PASS-THROUGH
// unless the camera is in space (|viewerPos| > 6 500 000 m) AND the sun
// is on screen, so it needs a dedicated space view + its own baseline.
// Loose tolerance — the WGSL twin has no dirt/star textures (documented).
const LENS_FLARE = { key: "lensFlare", tol: 60 };

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});

async function runBackend(renderer) {
  const page = await browser.newPage({
    viewport: { width: 1024, height: 768 },
  });
  const consoleErrors = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);

  const out = await page.evaluate(
    async ({ stages, isWebGPU }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const scene = v.scene;

      // ---- instrumentation (WebGPU only) ----
      window.__passLabels = [];
      window.__gpuErrors = [];
      if (isWebGPU && typeof GPUCommandEncoder !== "undefined") {
        const origBRP = GPUCommandEncoder.prototype.beginRenderPass;
        GPUCommandEncoder.prototype.beginRenderPass = function (desc) {
          window.__passLabels.push((desc && desc.label) || "");
          return origBRP.call(this, desc);
        };
        const context = scene.context;
        const dev = context._device || context.device;
        if (dev && dev.addEventListener) {
          dev.addEventListener("uncapturederror", (e) => {
            window.__gpuErrors.push(String(e.error && e.error.message));
          });
        }
      }

      // ---- deterministic scene (probe-colorgrading-wired recipe +
      // boxes for depth discontinuities) ----
      scene.requestRenderMode = false;
      v.clock.shouldAnimate = false;
      v.clock.currentTime = C.JulianDate.fromIso8601("2026-06-21T08:00:00Z");
      scene.fog.enabled = false;
      if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
      if (scene.skyBox) scene.skyBox.show = false;
      if (scene.sun) scene.sun.show = false;
      if (scene.moon) scene.moon.show = false;
      scene.globe.showGroundAtmosphere = false;
      scene.terrainProvider = new C.EllipsoidTerrainProvider();
      scene.globe.showWaterEffect = false;
      scene.globe.baseColor = new C.Color(0.12, 0.15, 0.2, 1.0);
      v.imageryLayers.removeAll();

      // Bright point (lens-flare ghost source) + boxes (depth edges).
      const points = scene.primitives.add(new C.PointPrimitiveCollection());
      points.add({
        position: C.Cartesian3.fromDegrees(0.7, 0.0, 30000.0),
        color: C.Color.WHITE,
        pixelSize: 200,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      });
      const boxSpecs = [
        { lon: 0.15, height: 6000, color: C.Color.ORANGE },
        { lon: 0.3, height: 10000, color: C.Color.CORNFLOWERBLUE },
      ];
      for (const b of boxSpecs) {
        v.entities.add({
          position: C.Cartesian3.fromDegrees(b.lon, 0.0, b.height),
          box: {
            dimensions: new C.Cartesian3(6000.0, 6000.0, 12000.0),
            material: b.color,
          },
        });
      }

      scene.morphTo3D(0);
      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(0.0, 0.0, 20000.0),
        orientation: {
          heading: C.Math.toRadians(90.0),
          pitch: C.Math.toRadians(-10.0),
          roll: 0.0,
        },
      });

      const oncePostRender = () =>
        new Promise((resolve) => {
          const remove = scene.postRender.addEventListener(() => {
            remove();
            resolve();
          });
        });
      const renderFrames = async (n) => {
        for (let i = 0; i < n; i++) await oncePostRender();
      };
      // Memory note: raw pixel data is shipped to Node as base64 (a JS
      // number[] of 3.1M elements per capture OOMs the Node heap across
      // ~20 captures × 2 backends).
      const grab = () =>
        new Promise((resolve) => {
          const remove = scene.postRender.addEventListener(() => {
            remove();
            const c = scene.canvas;
            const off = document.createElement("canvas");
            off.width = c.width;
            off.height = c.height;
            const cx = off.getContext("2d");
            cx.drawImage(c, 0, 0);
            const u8 = new Uint8Array(
              cx.getImageData(0, 0, c.width, c.height).data.buffer,
            );
            let bin = "";
            const chunk = 0x8000;
            for (let i = 0; i < u8.length; i += chunk) {
              bin += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
            }
            resolve({
              b64: btoa(bin),
              png: off.toDataURL("image/png"),
              w: c.width,
              h: c.height,
            });
          });
        });
      const bytesEqual = (a, b) => a.b64 === b.b64;
      const settleAndGrab = async () => {
        let prev = await grab();
        for (let i = 0; i < 40; i++) {
          await renderFrames(10);
          const cur = await grab();
          if (scene.globe.tilesLoaded && bytesEqual(prev, cur)) return cur;
          prev = cur;
        }
        return prev;
      };
      const passLabelsOneFrame = async () => {
        await oncePostRender();
        window.__passLabels.length = 0;
        await oncePostRender();
        return window.__passLabels.slice();
      };

      // Strip async default ion imagery until tiles settle.
      let stable = 0;
      for (let i = 0; i < 600 && stable < 5; i++) {
        if (v.imageryLayers.length > 0) v.imageryLayers.removeAll();
        await oncePostRender();
        stable = scene.globe.tilesLoaded ? stable + 1 : 0;
      }
      await renderFrames(60);

      const captures = {};
      captures.default = await settleAndGrab();
      const defaultLabels = await passLabelsOneFrame();

      const stageLabels = {};
      for (const s of stages) {
        const stage = C.PostProcessStageLibrary[s.create]();
        scene.postProcessStages.add(stage);
        await renderFrames(10);
        captures[s.key] = s.settle ? await settleAndGrab() : await grab();
        stageLabels[s.key] = await passLabelsOneFrame();
        scene.postProcessStages.remove(stage);
        await renderFrames(10);
      }

      // Off-gate: all stages removed → back to baseline.
      captures.restored = await settleAndGrab();
      const restoredLabels = await passLabelsOneFrame();

      // ---- LensFlare (space view, sun on screen) ----
      if (scene.sun) scene.sun.show = true;
      await renderFrames(3);
      const us = scene.context.uniformState;
      const sunWC = C.Cartesian3.clone(us.sunPositionWC);
      // Camera at ~2 earth radii altitude, ~70 deg of longitude past the
      // subsolar point (60E at 08:00 UTC on Jun 21): looking at the sun
      // from here leaves the earth centre well IN FRONT of the camera
      // (sane isInEarth projection — the ghost mask unmasks the sky) but
      // off screen. Closer/overhead cameras put the earth centre ~90 deg
      // off-axis where the GLSL isInEarth projection degenerates and
      // masks ALL ghosts on both backends (leaving only WebGL's
      // dirt-texture overlay visible).
      const camPos = C.Cartesian3.fromDegrees(130.0, 0.0, 12756000.0);
      const dir = C.Cartesian3.normalize(
        C.Cartesian3.subtract(sunWC, camPos, new C.Cartesian3()),
        new C.Cartesian3(),
      );
      let right = C.Cartesian3.cross(
        dir,
        C.Cartesian3.normalize(camPos, new C.Cartesian3()),
        new C.Cartesian3(),
      );
      if (C.Cartesian3.magnitude(right) < 1e-6) {
        right = C.Cartesian3.cross(dir, C.Cartesian3.UNIT_Z, right);
      }
      C.Cartesian3.normalize(right, right);
      // Aim ~15 deg OFF the sun: WebGL's flare weight is
      // length(sunNDC) — looking straight at the sun gives weight 0 and
      // therefore ZERO flare on both backends. Off-center puts the sun
      // at NDC ~0.45 where the flare is strong.
      const aim = C.Cartesian3.normalize(
        C.Cartesian3.add(
          dir,
          C.Cartesian3.multiplyByScalar(right, 0.27, new C.Cartesian3()),
          new C.Cartesian3(),
        ),
        new C.Cartesian3(),
      );
      const up = C.Cartesian3.normalize(
        C.Cartesian3.cross(right, aim, new C.Cartesian3()),
        new C.Cartesian3(),
      );
      v.camera.setView({
        destination: camPos,
        orientation: { direction: aim, up },
      });
      await renderFrames(30);
      captures.flareBase = await settleAndGrab();
      const flareStage = C.PostProcessStageLibrary.createLensFlareStage();
      scene.postProcessStages.add(flareStage);
      await renderFrames(10);
      captures.lensFlare = await settleAndGrab();
      stageLabels.lensFlare = await passLabelsOneFrame();
      scene.postProcessStages.remove(flareStage);

      return {
        captures,
        defaultLabels,
        stageLabels,
        restoredLabels,
        gpuErrors: window.__gpuErrors,
      };
    },
    { stages: STAGES, isWebGPU: renderer === "webgpu" },
  );

  await page.close();
  return { out, consoleErrors };
}

// HDR phase (NEW-PP-LIBRARY-TONEMAP-ORDER) — separate page load with
// `scene.highDynamicRange = true` set BEFORE the first settle so the
// scene framebuffer + all cached pipelines are created against the HDR
// format from the start. (Toggling highDynamicRange mid-session on
// WebGPU currently invalidates cached primitive pipelines — a
// pre-existing, unrelated bug; probe-hdr-pp-math takes the same
// startup-HDR approach.) SDR canvas: the tonemap stage RUNS on both
// backends, so the library builtin must see the tonemapped SDR frame,
// matching WebGL's post-tonemap insertion point.
async function runHdrBackend(renderer) {
  const page = await browser.newPage({
    viewport: { width: 1024, height: 768 },
  });
  const consoleErrors = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);

  const out = await page.evaluate(
    async ({ isWebGPU }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const scene = v.scene;

      window.__passLabels = [];
      window.__gpuErrors = [];
      if (isWebGPU && typeof GPUCommandEncoder !== "undefined") {
        const origBRP = GPUCommandEncoder.prototype.beginRenderPass;
        GPUCommandEncoder.prototype.beginRenderPass = function (desc) {
          window.__passLabels.push((desc && desc.label) || "");
          return origBRP.call(this, desc);
        };
        const dev = scene.context._device || scene.context.device;
        if (dev && dev.addEventListener) {
          dev.addEventListener("uncapturederror", (e) => {
            window.__gpuErrors.push(String(e.error && e.error.message));
          });
        }
      }

      // HDR BEFORE any scene setup / rendering we depend on.
      scene.highDynamicRange = true;

      // Deterministic WHITE-POINT scene: the HDR gate must measure the
      // POST-PROCESS chain (tonemap order + tonemap math + the library
      // builtin), so it deliberately excludes scene content with known
      // scene-side cross-backend gaps that would pollute the compare —
      // the globe (WGSL plain-HDR sRGB->linear decode is gated on HDR
      // canvas output only; WebGL's `#ifdef HDR` engages on useHdr
      // alone), entity boxes (WebGPU per-instance color divergence),
      // and mid-gray point colors (WebGL's PointPrimitiveCollectionFS
      // czm_gammaCorrect linearizes under HDR; the WGSL point renderer
      // does not). WHITE (1.0) and the black sky (0.0) are fixed points
      // of the gamma pow, so identical values enter the scene FB on
      // both backends and any output delta is attributable to the PP
      // chain. The tonemap curve still discriminates strongly: PBR
      // Neutral maps 1.0 -> ~0.88, sRGB-encodes to ~240 (a missing
      // tonemap shows 255), and post-tonemap BlackAndWhite posterizes
      // ~0.94 luma to the 0.8 band (~204) while a PRE-tonemap
      // BlackAndWhite would emit ~240.
      scene.requestRenderMode = false;
      v.clock.shouldAnimate = false;
      v.clock.currentTime = C.JulianDate.fromIso8601("2026-06-21T08:00:00Z");
      scene.fog.enabled = false;
      if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
      if (scene.skyBox) scene.skyBox.show = false;
      if (scene.sun) scene.sun.show = false;
      if (scene.moon) scene.moon.show = false;
      scene.globe.show = false;
      v.imageryLayers.removeAll();

      const points = scene.primitives.add(new C.PointPrimitiveCollection());
      for (let pi = 0; pi < 3; pi++) {
        points.add({
          position: C.Cartesian3.fromDegrees(0.45 + 0.3 * pi, 0.0, 30000.0),
          color: C.Color.WHITE,
          pixelSize: 130,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        });
      }

      scene.morphTo3D(0);
      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(0.0, 0.0, 20000.0),
        orientation: {
          heading: C.Math.toRadians(90.0),
          pitch: C.Math.toRadians(-10.0),
          roll: 0.0,
        },
      });

      const oncePostRender = () =>
        new Promise((resolve) => {
          const remove = scene.postRender.addEventListener(() => {
            remove();
            resolve();
          });
        });
      const renderFrames = async (n) => {
        for (let i = 0; i < n; i++) await oncePostRender();
      };
      const grab = () =>
        new Promise((resolve) => {
          const remove = scene.postRender.addEventListener(() => {
            remove();
            const c = scene.canvas;
            const off = document.createElement("canvas");
            off.width = c.width;
            off.height = c.height;
            const cx = off.getContext("2d");
            cx.drawImage(c, 0, 0);
            const u8 = new Uint8Array(
              cx.getImageData(0, 0, c.width, c.height).data.buffer,
            );
            let bin = "";
            const chunk = 0x8000;
            for (let i = 0; i < u8.length; i += chunk) {
              bin += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
            }
            resolve({
              b64: btoa(bin),
              png: off.toDataURL("image/png"),
              w: c.width,
              h: c.height,
            });
          });
        });
      const bytesEqual = (a, b) => a.b64 === b.b64;
      // Globe is hidden — settle on byte-stable frames only (no
      // tilesLoaded dependency).
      const settleAndGrab = async () => {
        let prev = await grab();
        for (let i = 0; i < 40; i++) {
          await renderFrames(10);
          const cur = await grab();
          if (bytesEqual(prev, cur)) return cur;
          prev = cur;
        }
        return prev;
      };
      const passLabelsOneFrame = async () => {
        await oncePostRender();
        window.__passLabels.length = 0;
        await oncePostRender();
        return window.__passLabels.slice();
      };

      for (let i = 0; i < 60; i++) {
        if (v.imageryLayers.length > 0) v.imageryLayers.removeAll();
        await oncePostRender();
      }

      const captures = {};
      captures.hdrBase = await settleAndGrab();
      const bw = C.PostProcessStageLibrary.createBlackAndWhiteStage();
      scene.postProcessStages.add(bw);
      await renderFrames(10);
      captures.hdrBlackAndWhite = await settleAndGrab();
      const hdrBWLabels = await passLabelsOneFrame();
      scene.postProcessStages.remove(bw);

      return {
        captures,
        hdrBWLabels,
        hdrInfo: {
          highDynamicRangeSupported: !!scene.highDynamicRangeSupported,
          sceneHdr: scene.highDynamicRange === true,
          // WebGL's tonemap gate: PostProcessStageCollection.update sets
          // `tonemapping.enabled = useHdr`. On WebGPU the equivalent
          // evidence is the PostProcess-Tonemap pass label (asserted
          // node-side from hdrBWLabels).
          tonemappingEnabled: !!(
            scene.postProcessStages &&
            scene.postProcessStages._tonemapping &&
            scene.postProcessStages._tonemapping.enabled
          ),
        },
        gpuErrors: window.__gpuErrors,
      };
    },
    { isWebGPU: renderer === "webgpu" },
  );

  await page.close();
  return { out, consoleErrors };
}

function savePng(name, img) {
  writeFileSync(
    join(OUT_DIR, name),
    Buffer.from(img.png.split(",")[1], "base64"),
  );
}
function diffImgs(a, b) {
  const A = Buffer.from(a.b64, "base64");
  const B = Buffer.from(b.b64, "base64");
  if (A.length !== B.length)
    return {
      fracDiff: 1,
      meanDelta: 255,
      diffBytes: -1,
      note: "size mismatch",
    };
  let diffBytes = 0;
  let maxDelta = 0;
  let sum = 0;
  for (let i = 0; i < A.length; i++) {
    const d = Math.abs(A[i] - B[i]);
    if (d > 0) diffBytes++;
    if (d > maxDelta) maxDelta = d;
    sum += d;
  }
  return {
    diffBytes,
    maxDelta,
    meanDelta: sum / A.length,
    fracDiff: diffBytes / A.length,
  };
}

console.log("=== WebGPU run ===");
const gpu = await runBackend("webgpu");
console.log("=== WebGL run ===");
const gl = await runBackend("webgl");
console.log("=== WebGPU HDR run ===");
const gpuHdr = await runHdrBackend("webgpu");
console.log("=== WebGL HDR run ===");
const glHdr = await runHdrBackend("webgl");
await browser.close();

if (
  !gpu.out?.captures ||
  !gl.out?.captures ||
  !gpuHdr.out?.captures ||
  !glHdr.out?.captures
) {
  console.error("FATAL: missing captures");
  process.exit(1);
}

savePng("webgpu-default.png", gpu.out.captures.default);
savePng("webgl-default.png", gl.out.captures.default);

let pass = true;
const results = [];

// Reference: how far apart the two backends are BEFORE any stage.
const dBase = diffImgs(gpu.out.captures.default, gl.out.captures.default);
console.log(
  `cross-backend default diff: mean=${dBase.meanDelta.toFixed(2)} frac=${(100 * dBase.fracDiff).toFixed(2)}% max=${dBase.maxDelta}`,
);

for (const s of [...STAGES, LENS_FLARE]) {
  const g = gpu.out.captures[s.key];
  const w = gl.out.captures[s.key];
  savePng(`webgpu-${s.key}.png`, g);
  savePng(`webgl-${s.key}.png`, w);

  // LensFlare compares against its own space-view baseline.
  const gBase =
    s.key === "lensFlare"
      ? gpu.out.captures.flareBase
      : gpu.out.captures.default;
  const wBase =
    s.key === "lensFlare" ? gl.out.captures.flareBase : gl.out.captures.default;
  if (s.key === "lensFlare") {
    savePng("webgpu-flareBase.png", gBase);
    savePng("webgl-flareBase.png", wBase);
  }

  // (1) visible transform on each backend.
  const tGPU = diffImgs(g, gBase);
  const tGL = diffImgs(w, wBase);
  const visGPU = tGPU.diffBytes > 5000 && tGPU.maxDelta > 30;
  const visGL = tGL.diffBytes > 5000 && tGL.maxDelta > 30;

  // (2) cross-backend tolerance.
  const x = diffImgs(g, w);
  const xOK = x.meanDelta <= s.tol;

  // (3) WebGPU pass label present while enabled.
  const labels = gpu.out.stageLabels[s.key] || [];
  const hasLib = labels.some((l) => l.startsWith("LibraryPP-"));

  const ok = visGPU && visGL && xOK && hasLib;
  pass = pass && ok;
  results.push({ key: s.key, ok });
  console.log(
    `${s.key.padEnd(14)} visGPU=${visGPU ? "Y" : "N"}(frac=${(100 * tGPU.fracDiff).toFixed(1)}%) ` +
      `visGL=${visGL ? "Y" : "N"}(frac=${(100 * tGL.fracDiff).toFixed(1)}%) ` +
      `xMean=${x.meanDelta.toFixed(2)}(tol ${s.tol}) libPass=${hasLib ? "Y" : "N"} ` +
      `${ok ? "OK" : "FAIL"}`,
  );
}

// (3b) default + restored have NO LibraryPP pass.
const defHasLib = gpu.out.defaultLabels.some((l) => l.startsWith("LibraryPP-"));
const resHasLib = gpu.out.restoredLabels.some((l) =>
  l.startsWith("LibraryPP-"),
);
console.log(
  `default/restored LibraryPP pass present: ${defHasLib}/${resHasLib} ${!defHasLib && !resHasLib ? "OK" : "FAIL"}`,
);
pass = pass && !defHasLib && !resHasLib;

// (4) off-gate: restored byte-identical to default (WebGPU).
savePng("webgpu-restored.png", gpu.out.captures.restored);
const dRes = diffImgs(gpu.out.captures.restored, gpu.out.captures.default);
const offOK = dRes.diffBytes === 0;
console.log(
  `off-gate restored vs default: ${offOK ? "BYTE-IDENTICAL" : `diffBytes=${dRes.diffBytes} max=${dRes.maxDelta}`} ${offOK ? "OK" : "FAIL"}`,
);
pass = pass && offOK;

// (6) HDR phase (NEW-PP-LIBRARY-TONEMAP-ORDER): with
// scene.highDynamicRange=true (SDR canvas) the tonemap stage runs on both
// backends; the WebGPU library builtin must execute AFTER tonemap and its
// output must match WebGL's post-tonemap output.
//
// Two-level compare:
//  - whole-frame meanDelta (loose — black sky dominates)
//  - MEDIAN interior value of the white discs (strict — immune to
//    dilution by the black background and to raster edge jitter).
//    Expected on both backends: base ~240 (PBR Neutral 1.0 -> ~0.88,
//    sRGB-encoded), blackAndWhite ~204 (posterize band 0.8). A missing
//    tonemap reads 255; a pre-tonemap BlackAndWhite reads ~240.
const HDR_BW_TOL = 2; // whole-frame mean (white-only content)
const HDR_MEDIAN_TOL = 6; // per-channel disc-interior median
function discMedian(img) {
  const A = Buffer.from(img.b64, "base64");
  const vals = [];
  for (let i = 0; i < A.length; i += 4) {
    const l = (A[i] + A[i + 1] + A[i + 2]) / 3;
    if (l > 40) vals.push(l); // disc interiors (sky is ~0)
  }
  if (vals.length === 0) return -1;
  vals.sort((a, b) => a - b);
  return vals[Math.floor(vals.length / 2)];
}
savePng("webgpu-hdrBase.png", gpuHdr.out.captures.hdrBase);
savePng("webgl-hdrBase.png", glHdr.out.captures.hdrBase);
savePng("webgpu-hdrBlackAndWhite.png", gpuHdr.out.captures.hdrBlackAndWhite);
savePng("webgl-hdrBlackAndWhite.png", glHdr.out.captures.hdrBlackAndWhite);
const glHdrEngaged =
  !!glHdr.out.hdrInfo?.tonemappingEnabled && !!glHdr.out.hdrInfo?.sceneHdr;
const hdrLabels = gpuHdr.out.hdrBWLabels || [];
const tmIdx = hdrLabels.findIndex((l) => l.includes("PostProcess-Tonemap"));
const libIdx = hdrLabels.findIndex((l) => l.startsWith("LibraryPP-"));
const orderOK = tmIdx >= 0 && libIdx >= 0 && tmIdx < libIdx;
const dHdrBase = diffImgs(
  gpuHdr.out.captures.hdrBase,
  glHdr.out.captures.hdrBase,
);
const dHdrBW = diffImgs(
  gpuHdr.out.captures.hdrBlackAndWhite,
  glHdr.out.captures.hdrBlackAndWhite,
);
// The builtin must also visibly transform the HDR frame on both backends.
const tHdrGPU = diffImgs(
  gpuHdr.out.captures.hdrBlackAndWhite,
  gpuHdr.out.captures.hdrBase,
);
const tHdrGL = diffImgs(
  glHdr.out.captures.hdrBlackAndWhite,
  glHdr.out.captures.hdrBase,
);
const hdrVisOK =
  tHdrGPU.diffBytes > 5000 &&
  tHdrGPU.maxDelta > 30 &&
  tHdrGL.diffBytes > 5000 &&
  tHdrGL.maxDelta > 30;
const medBaseGPU = discMedian(gpuHdr.out.captures.hdrBase);
const medBaseGL = discMedian(glHdr.out.captures.hdrBase);
const medBWGPU = discMedian(gpuHdr.out.captures.hdrBlackAndWhite);
const medBWGL = discMedian(glHdr.out.captures.hdrBlackAndWhite);
const medOK =
  medBaseGPU >= 0 &&
  medBaseGL >= 0 &&
  medBWGPU >= 0 &&
  medBWGL >= 0 &&
  Math.abs(medBaseGPU - medBaseGL) <= HDR_MEDIAN_TOL &&
  Math.abs(medBWGPU - medBWGL) <= HDR_MEDIAN_TOL &&
  // Tonemap actually engaged (an un-tonemapped white disc reads 255)
  medBaseGPU < 250 &&
  medBaseGL < 250 &&
  // BlackAndWhite ran POST-tonemap (pre-tonemap would leave ~base value)
  medBWGPU < medBaseGPU - 10 &&
  medBWGL < medBaseGL - 10;
const hdrOK =
  glHdrEngaged &&
  orderOK &&
  hdrVisOK &&
  medOK &&
  dHdrBW.meanDelta <= HDR_BW_TOL &&
  dHdrBase.meanDelta <= HDR_BW_TOL;
console.log(
  `HDR phase: glTonemap=${glHdrEngaged ? "Y" : "N"} ` +
    `gpuOrder(tonemap@${tmIdx}<lib@${libIdx})=${orderOK ? "Y" : "N"} ` +
    `vis=${hdrVisOK ? "Y" : "N"} baseMean=${dHdrBase.meanDelta.toFixed(2)} ` +
    `bwMean=${dHdrBW.meanDelta.toFixed(2)}(tol ${HDR_BW_TOL}) ` +
    `discMedians base=${medBaseGPU}/${medBaseGL} bw=${medBWGPU}/${medBWGL}` +
    `(tol ${HDR_MEDIAN_TOL}) ${hdrOK ? "OK" : "FAIL"}`,
);
pass = pass && hdrOK;

// (5) zero errors (SDR + HDR runs, both backends).
const allErrors = [
  ...gpu.consoleErrors,
  ...gl.consoleErrors,
  ...gpu.out.gpuErrors,
  ...gpuHdr.consoleErrors,
  ...glHdr.consoleErrors,
  ...gpuHdr.out.gpuErrors,
];
console.log(
  `errors: webgpu-console=${gpu.consoleErrors.length} webgl-console=${gl.consoleErrors.length} gpu=${gpu.out.gpuErrors.length} ` +
    `hdr(webgpu-console=${gpuHdr.consoleErrors.length} webgl-console=${glHdr.consoleErrors.length} gpu=${gpuHdr.out.gpuErrors.length}) ` +
    `${allErrors.length === 0 ? "OK" : "FAIL"}`,
);
allErrors
  .slice(0, 10)
  .forEach((e) => console.log("  ERR:", String(e).slice(0, 250)));
pass = pass && allErrors.length === 0;

console.log(`PNGs: ${OUT_DIR}`);
console.log(pass ? "PASS" : "FAIL");
process.exit(pass ? 0 : 1);
