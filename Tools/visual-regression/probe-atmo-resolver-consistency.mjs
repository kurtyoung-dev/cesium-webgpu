#!/usr/bin/env node
// C7-DPH47-ATMO-RESOLVER — shared WebGPUAtmosphereUniforms resolver consistency.
//
// The DP-H47 debt item builds ONE parameterized resolver
// (Renderer/WebGPU/WebGPUAtmosphereUniforms.ts) and migrates the WebGPU Sky
// (WebGPUSkyAtmosphereRenderer) + Model DynamicEnvironmentMap IBL
// (WebGPUDynamicEnvironmentMapManager) CPU uniform packing onto it, byte-
// identical at default `scene.atmosphere` settings.
//
// The dynamic-atmosphere-lighting enum reaches BOTH the sky
// (Scene/SkyAtmosphere.setDynamicLighting) and the model IBL fill
// (DynamicEnvironmentMapManager u_radiiAndDynamicAtmosphereColor.z), and both
// WebGPU consumers resolve it through the SAME seam. This probe proves the
// seam routes it into BOTH consumers by asserting a visible delta in each
// when it flips NONE(0) -> SUNLIGHT(2):
//   (SKY)   fullscreen sky mean color shifts (sky reads the resolved enum).
//   (MODEL) isolated metallic-IBL model pixels shift (model reads it too).
//
// ── WHY THE SKY LEG'S DRIVER CHANGED (C12-29 S6 / obs-1, 2026-07-25) ──
//
// The header used to say `scene.atmosphere.dynamicLighting` is "the ONE
// `scene.atmosphere.*` field WebGL applies to BOTH", and the sky leg drove
// exactly that field. That was only half true, and the probe was codifying
// the half that was wrong. `Scene.updateEnvironment` resolves the SKY's enum
// as:
//
//   defined(globe) ? DynamicAtmosphereLightingType.fromGlobeFlags(globe)
//                  : atmosphere.dynamicLighting
//
// so WebGL routes `scene.atmosphere.dynamicLighting` to the sky ONLY when
// there is no globe. This probe leaves `scene.globe` DEFINED (it merely sets
// `globe.show = false`) with `globe.enableLighting = false`, so on WebGL the
// sky's enum was pinned at NONE for BOTH captures all along — the sky leg was
// green only because the WebGPU renderer was re-resolving the field itself,
// i.e. because of the divergence obs-1 fixed. With the renderer now reading
// the value Scene resolved, driving `scene.atmosphere.dynamicLighting` alone
// makes the two sky captures identical and `skyResponse` collapse to ~0.
//
// The SKY leg is therefore driven through the channel WebGL actually uses
// with a globe present — the legacy globe flags — while the MODEL leg keeps
// driving `scene.atmosphere.dynamicLighting`, which is genuinely what
// `DynamicEnvironmentMapManager` reads on BOTH backends. Both fields are set
// on every capture, so each consumer sees the flip through its own real
// channel and the probe tests the seam instead of a bug.
//
// Byte-identical off-gate: run with PHASE=pre (pre-change build) and PHASE=post
// (post-change build); the DEFAULT (dynamicLighting NONE) sky + model PNGs must
// be pixel-identical across the two phases (see compare step in the runner).
//
//   node Tools/visual-regression/probe-atmo-resolver-consistency.mjs
//   PHASE=post node Tools/visual-regression/probe-atmo-resolver-consistency.mjs

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const PHASE = process.env.PHASE || "post";
const OUT_DIR = "Tools/visual-regression/output";
const MODEL = "/Apps/SampleData/models/TestKHRExtensions/TestKhrSpecular.gltf";
// Morning sun, low elevation, so NONE ("lit from directly above") differs
// strongly from SUNLIGHT (actual low-sun direction) for both consumers.
const TIME_ISO = "2026-05-19T12:30:00Z";
const VIEW = { lon: -80.0, lat: 40.0, height: 300.0 };

// ── SKY leg: fullscreen sky, measure mean color over the sky band ──
async function captureSky(dynEnum) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu", "--use-vulkan", "--disable-cache"],
  });
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  const consoleErrors = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);

  await page.evaluate(
    async ({ dynEnum, view, timeIso }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const fixed = C.JulianDate.fromIso8601(timeIso);
      v.clock.currentTime = fixed.clone();
      v.clock.startTime = fixed.clone();
      v.clock.stopTime = fixed.clone();
      v.clock.shouldAnimate = false;
      v.clock.multiplier = 0;

      const sky = v.scene.skyAtmosphere;
      sky.show = true;
      sky._webgpuFullscreen = true;
      // Set BOTH channels on every capture. `scene.atmosphere.dynamicLighting`
      // is what the model IBL fill reads on both backends and is kept for
      // completeness; the SKY's enum, with a globe defined, is resolved by
      // `Scene.updateEnvironment` from the legacy globe flags, so that is what
      // the sky leg has to drive. See the header for why this changed.
      v.scene.atmosphere.dynamicLighting = dynEnum;

      v.scene.globe.showGroundAtmosphere = false;
      v.scene.globe.show = false;
      v.scene.fog.enabled = false;
      v.scene.skyBox.show = false;
      v.scene.sun.show = false;
      v.scene.moon.show = false;
      // DynamicAtmosphereLightingType.fromGlobeFlags: lighting off -> NONE(0);
      // lighting on + fromSun -> SUNLIGHT(2). Exactly the two states this
      // probe flips between.
      const wantSunlight = dynEnum === 2;
      v.scene.globe.enableLighting = wantSunlight;
      v.scene.globe.dynamicAtmosphereLighting = true;
      v.scene.globe.dynamicAtmosphereLightingFromSun = wantSunlight;
      v.scene.backgroundColor = C.Color.BLACK;

      for (const sel of [
        ".cesium-viewer-timelineContainer",
        ".cesium-viewer-animationContainer",
        ".cesium-viewer-bottom",
        ".cesium-viewer-toolbar",
      ]) {
        const el = document.querySelector(sel);
        if (el) el.style.display = "none";
      }

      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(view.lon, view.lat, view.height),
        orientation: {
          heading: C.Math.toRadians(90.0), // look east toward the morning sun
          pitch: C.Math.toRadians(5.0),
          roll: 0.0,
        },
      });

      for (let i = 0; i < 90; i++) {
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
    },
    { dynEnum, view: VIEW, timeIso: TIME_ISO },
  );
  await page.waitForTimeout(500);
  const out = path.join(OUT_DIR, `resolver-sky-${PHASE}-dyn${dynEnum}.png`);
  await page.screenshot({ path: out });
  await browser.close();
  return { out, consoleErrors };
}

// ── MODEL leg: isolated metallic model lit only by the procedural
//    DynamicEnvironmentMap IBL; measure model pixels ──
async function captureModel(dynEnum) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu", "--use-vulkan", "--disable-cache"],
  });
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  const consoleErrors = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
    waitUntil: "networkidle",
    timeout: 90000,
  });
  await page.waitForFunction(() => !!window.viewer, { timeout: 90000 });

  const decoded = await page.evaluate(
    async ({ modelUrl, dynEnum, timeIso }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const scene = v.scene;
      const fixed = C.JulianDate.fromIso8601(timeIso);
      v.clock.currentTime = fixed.clone();
      v.clock.startTime = fixed.clone();
      v.clock.stopTime = fixed.clone();
      v.clock.shouldAnimate = false;
      v.clock.multiplier = 0;

      for (const sel of [
        ".cesium-viewer-toolbar",
        ".cesium-viewer-animationContainer",
        ".cesium-viewer-timelineContainer",
        ".cesium-viewer-bottom",
      ]) {
        document.querySelectorAll(sel).forEach((e) => (e.style.display = "none"));
      }

      // Isolate the model to pure IBL: hide globe + the visible SkyAtmosphere
      // (so the canvas readback is ONLY the model, not the sky band — the
      // DynamicEnvironmentMap bake is independent of skyAtmosphere.show) + black
      // bg + kill direct light.
      scene.globe.show = false;
      scene.skyBox.show = false;
      scene.skyAtmosphere.show = false;
      scene.backgroundColor = C.Color.BLACK;
      scene.atmosphere.dynamicLighting = dynEnum;
      scene.light = new C.DirectionalLight({
        direction: new C.Cartesian3(0, 0, -1),
        color: C.Color.BLACK,
        intensity: 0.0,
      });

      const modelMatrix = C.Transforms.eastNorthUpToFixedFrame(
        C.Cartesian3.fromDegrees(-75, 40, 0),
      );
      const model = await C.Model.fromGltfAsync({
        url: modelUrl,
        modelMatrix,
        scale: 1.0,
      });
      model.imageBasedLighting.imageBasedLightingFactor = new C.Cartesian2(
        1.0,
        1.0,
      );
      scene.primitives.add(model);
      for (let i = 0; i < 600 && !model.ready; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
      // Let the procedural DynamicEnvironmentMapManager bake + prefilter.
      for (let i = 0; i < 200; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }

      v.camera.viewBoundingSphere(
        model.boundingSphere,
        new C.HeadingPitchRange(0.2, -0.35, model.boundingSphere.radius * 3.0),
      );
      v.camera.lookAtTransform(C.Matrix4.IDENTITY);
      for (let i = 0; i < 40; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }

      const cv = scene.canvas;
      const off = new OffscreenCanvas(cv.width, cv.height);
      const ctx = off.getContext("2d");
      ctx.drawImage(cv, 0, 0);
      const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
      return { w: cv.width, h: cv.height, data: Array.from(d), ready: !!model.ready };
    },
    { modelUrl: MODEL, dynEnum, timeIso: TIME_ISO },
  );
  const out = path.join(OUT_DIR, `resolver-model-${PHASE}-dyn${dynEnum}.png`);
  await page.screenshot({ path: out });
  await browser.close();
  return { decoded, out, consoleErrors };
}

async function meanRGB(pngPath) {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage();
  await page.setContent("<!doctype html><html><body></body></html>");
  const b64 = fs.readFileSync(pngPath).toString("base64");
  const s = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = "data:image/png;base64," + b64;
    await img.decode();
    const cv = document.createElement("canvas");
    cv.width = img.width;
    cv.height = img.height;
    const ctx = cv.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, img.width, img.height).data;
    const w = img.width,
      h = img.height;
    let r = 0,
      g = 0,
      b = 0,
      n = 0;
    // Sky band: upper-middle of the frame.
    for (let y = Math.floor(h * 0.1); y < Math.floor(h * 0.45); y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        r += d[i];
        g += d[i + 1];
        b += d[i + 2];
        n++;
      }
    }
    return { r: r / n, g: g / n, b: b / n };
  }, b64);
  await browser.close();
  return s;
}

// Count model (non-black) pixels that differ by > 24 on any channel.
function diffModelPixels(a, b) {
  let modelPx = 0,
    mismatch = 0;
  if (a.w !== b.w || a.h !== b.h) return { modelPx: 0, mismatchPct: null };
  for (let i = 0; i < a.data.length; i += 4) {
    const aLum = a.data[i] + a.data[i + 1] + a.data[i + 2];
    const bLum = b.data[i] + b.data[i + 1] + b.data[i + 2];
    if (aLum > 12 || bLum > 12) {
      modelPx++;
      if (
        Math.abs(a.data[i] - b.data[i]) > 24 ||
        Math.abs(a.data[i + 1] - b.data[i + 1]) > 24 ||
        Math.abs(a.data[i + 2] - b.data[i + 2]) > 24
      ) {
        mismatch++;
      }
    }
  }
  return {
    modelPx,
    mismatch,
    mismatchPct: modelPx ? +((100 * mismatch) / modelPx).toFixed(2) : null,
  };
}

const rgbDelta = (a, b) =>
  Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b);

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(
    `[atmo-resolver-consistency] PHASE=${PHASE} — scene.atmosphere.dynamicLighting lands in BOTH sky + model consumers via the shared resolver`,
  );

  // NONE = default; SUNLIGHT = non-default override.
  const skyNone = await captureSky(0);
  const skySun = await captureSky(2);
  const modelNone = await captureModel(0);
  const modelSun = await captureModel(2);

  const errs =
    skyNone.consoleErrors.length +
    skySun.consoleErrors.length +
    modelNone.consoleErrors.length +
    modelSun.consoleErrors.length;

  const skyNoneRGB = await meanRGB(skyNone.out);
  const skySunRGB = await meanRGB(skySun.out);
  const skyResponse = rgbDelta(skyNoneRGB, skySunRGB);
  const modelResponse = diffModelPixels(modelNone.decoded, modelSun.decoded);

  console.log(
    `  SKY   none   r=${skyNoneRGB.r.toFixed(1)} g=${skyNoneRGB.g.toFixed(1)} b=${skyNoneRGB.b.toFixed(1)}`,
  );
  console.log(
    `  SKY   sun    r=${skySunRGB.r.toFixed(1)} g=${skySunRGB.g.toFixed(1)} b=${skySunRGB.b.toFixed(1)}`,
  );
  console.log(`  SKY   response |dR|+|dG|+|dB| = ${skyResponse.toFixed(1)} (want > 8)`);
  console.log(
    `  MODEL response mismatch = ${modelResponse.mismatchPct}% over ${modelResponse.modelPx} model px (want > 3%)`,
  );
  console.log(`  console errors = ${errs} (want 0)`);

  // C12-29 S6: the sky leg's A/B is now driven by the globe flags, because
  // that is the channel `Scene.updateEnvironment` uses when a globe exists.
  // Driving `scene.atmosphere.dynamicLighting` alone would leave both
  // captures at NONE and collapse this to ~0 — which is what the fix to
  // obs-1 exposed about the OLD version of this probe.
  const passSky = skyResponse > 8;
  const passModel =
    modelResponse.mismatchPct !== null && modelResponse.mismatchPct > 3;
  const passErr = errs === 0;
  const pass = passSky && passModel && passErr && modelNone.decoded.ready;

  console.log(
    `\n  RESULT: ${pass ? "PASS" : "FAIL"}  [sky:${passSky} model:${passModel} errs:${passErr}]`,
  );
  process.exit(pass ? 0 : 1);
})();
