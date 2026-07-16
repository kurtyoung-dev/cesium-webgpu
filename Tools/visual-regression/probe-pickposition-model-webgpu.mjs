#!/usr/bin/env node
// Probe (DP-H45, Batch 254): scene.pickPosition() over an OPAQUE glTF Model
// on WebGPU must return the MODEL surface, not the globe behind/below it.
//
// Background — the bug:
//   The packed pick-depth color texture (globeDepth.globeDepthTexture) was
//   re-copied after the globe pass (executeCopyDepth) and after the 3D-Tiles
//   pass (executeUpdateDepth), but NOT after the OPAQUE pass. OPAQUE models
//   write depth into the scene-framebuffer depth attachment, which never got
//   re-packed into globeDepthTexture before the per-frustum pick-depth copy.
//   Result: scene.pickPosition over an opaque model returned the globe
//   surface below it (or undefined when the globe was hidden), while WebGL
//   returned the model top. DP-H45 fix re-packs scene depth after OPAQUE on
//   render (!picking) frames.
//
// What it asserts:
//   1. WebGL leg: pickPosition at the model center returns a Cartesian3 whose
//      height is well above the bare globe surface (the model top), and the
//      picked primitive at that pixel is the Model.
//   2. WebGPU leg converges to a Cartesian3 by frame <= 4 after >=150 warmup
//      frames (model load + async pick-depth readback armed).
//   3. WebGPU picked height matches WebGL within a few meters (model top),
//      and is NOT the globe surface far below (which is the bug signature).
//   4. Zero console errors on both legs.
//
// Usage: node Tools/visual-regression/probe-pickposition-model-webgpu.mjs

import { chromium } from "playwright";

const BASE = process.env.PROBE_BASE || "http://localhost:8134";
const LON = -75.0;
const LAT = 40.0;
// Model sits on the ellipsoid at height 0, scaled large so it fills the
// center pixel when we look straight down. Its top is hundreds of meters up.
const MODEL_SCALE = 800.0;
// Camera looks straight down from this altitude.
const CAM_HEIGHT = 8000.0;
// A picked height well above this proves we hit the model, not the globe (~0).
const MODEL_TOP_MIN = 200.0;

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});

async function runLeg(renderer) {
  const page = await browser.newPage({
    viewport: { width: 1000, height: 700 },
  });
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(`PAGEERROR: ${e.message}`));

  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);

  await page.evaluate(async () => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    const terrain = new C.EllipsoidTerrainProvider();
    v.terrainProvider = terrain;
    v.scene.globe.terrainProvider = terrain;
    const imagery = await C.TileMapServiceImageryProvider.fromUrl(
      C.buildModuleUrl("Assets/Textures/NaturalEarthII"),
    );
    v.imageryLayers.removeAll();
    v.imageryLayers.addImageryProvider(imagery);
    v.scene.requestRenderMode = false;
  });
  errors.length = 0;

  const out = await page.evaluate(
    async ({ LON, LAT, MODEL_SCALE, CAM_HEIGHT }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const scene = v.scene;
      scene.globe.depthTestAgainstTerrain = false;

      // Place a large opaque glTF model on the ellipsoid surface.
      const origin = C.Cartesian3.fromDegrees(LON, LAT, 0.0);
      const modelMatrix = C.Transforms.eastNorthUpToFixedFrame(origin);
      let model;
      try {
        model = await C.Model.fromGltfAsync({
          url: "/Apps/SampleData/models/CesiumMilkTruck/CesiumMilkTruck.glb",
          modelMatrix,
          scale: MODEL_SCALE,
        });
        scene.primitives.add(model);
      } catch (e) {
        return { fatal: `model load failed: ${e}` };
      }

      // Look straight down at the model from directly above.
      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(LON, LAT, CAM_HEIGHT),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });

      // Warm >=150 frames so the model fully loads + renders, the globe
      // tiles settle, and the async pick-depth readback is armed.
      let modelReady = false;
      for (let i = 0; i < 200; i++) {
        scene.render();
        if (model.ready) modelReady = true;
        await new Promise((r) => requestAnimationFrame(r));
      }

      const center = new C.Cartesian2(
        Math.floor(scene.canvas.clientWidth / 2),
        Math.floor(scene.canvas.clientHeight / 2),
      );

      const toCarto = (pos) => {
        if (!pos || typeof pos.x !== "number" || !isFinite(pos.x)) return null;
        const cc = C.Cartographic.fromCartesian(pos);
        return cc
          ? {
              lon: C.Math.toDegrees(cc.longitude),
              lat: C.Math.toDegrees(cc.latitude),
              h: cc.height,
            }
          : null;
      };

      // What feature is under the center pixel? (pick, not pickPosition)
      let pickedIsModel = false;
      try {
        const picked = scene.pick(center);
        pickedIsModel = !!(picked && picked.primitive === model);
      } catch (e) {
        /* ignore */
      }

      // Per-frame pickPosition samples (frame 0 may be cold on WebGPU).
      const samples = [];
      for (let i = 0; i < 8; i++) {
        let res;
        try {
          res = scene.pickPosition(center);
        } catch (e) {
          res = `THREW: ${e}`;
        }
        let kind = "undefined";
        let carto = null;
        if (res && typeof res.then === "function") {
          kind = "Promise";
        } else if (res && typeof res.x === "number" && isFinite(res.x)) {
          kind = "Cartesian3";
          carto = toCarto(res);
        } else if (res && typeof res.x === "number") {
          kind = `Cartesian3-NaN(${res.x})`;
        } else if (typeof res === "string") {
          kind = res;
        }
        samples.push({ frame: i, kind, carto });
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }

      return {
        rendererType: scene.context?.rendererType,
        pickPositionSupported: scene.pickPositionSupported,
        useLogDepth: scene.frameState?.useLogDepth,
        numFrustums: scene._view?.frustumCommandsList?.length,
        modelReady,
        pickedIsModel,
        samples,
      };
    },
    { LON, LAT, MODEL_SCALE, CAM_HEIGHT },
  );

  await page.close();
  const relevantErrors = errors.filter(
    (message) =>
      message !== "RequestErrorEvent" &&
      !message.includes("net::ERR_NETWORK_ACCESS_DENIED"),
  );
  return {
    ...out,
    errors: relevantErrors,
    ignoredViewerBootNetworkErrors: errors.length - relevantErrors.length,
  };
}

// ---- run both legs ----
const webgl = await runLeg("webgl");
const webgpu = await runLeg("webgpu");
await browser.close();

// ---- report ----
function firstHit(leg) {
  if (!leg.samples) return null;
  const s = leg.samples.find((x) => x.kind === "Cartesian3" && x.carto);
  return s ? { idx: s.frame, carto: s.carto } : null;
}

function printLeg(name, leg) {
  console.log(`\n=== ${name} (${leg.rendererType}) ===`);
  if (leg.fatal) {
    console.log(`  FATAL: ${leg.fatal}`);
    return;
  }
  console.log(
    `pickPositionSupported: ${leg.pickPositionSupported}  useLogDepth: ${leg.useLogDepth}  numFrustums: ${leg.numFrustums}`,
  );
  console.log(
    `modelReady: ${leg.modelReady}  pickedIsModel(center): ${leg.pickedIsModel}`,
  );
  for (const s of leg.samples ?? []) {
    console.log(
      `  frame ${String(s.frame).padStart(2)}: ${s.kind}` +
        (s.carto
          ? ` @ lon=${s.carto.lon.toFixed(4)} lat=${s.carto.lat.toFixed(4)} h=${s.carto.h.toFixed(1)}`
          : ""),
    );
  }
  console.log(`  console errors: ${leg.errors.length}`);
  leg.errors.slice(0, 6).forEach((e) => console.log("   ERR:", e));
}
printLeg("WebGL", webgl);
printLeg("WebGPU", webgpu);

// ---- assertions ----
const failures = [];

if (webgl.fatal) failures.push(`WebGL fatal: ${webgl.fatal}`);
if (webgpu.fatal) failures.push(`WebGPU fatal: ${webgpu.fatal}`);

const glHit = firstHit(webgl);
const gpuHit = firstHit(webgpu);

// 1. WebGL reference: model is under the pixel and pickPosition is high (top).
if (!webgl.pickedIsModel) {
  failures.push("WebGL: center pixel did not pick the Model (setup broken)");
}
if (!glHit) {
  failures.push("WebGL: pickPosition never returned a Cartesian3");
} else if (glHit.carto.h < MODEL_TOP_MIN) {
  failures.push(
    `WebGL: picked height ${glHit.carto.h.toFixed(1)} m < ${MODEL_TOP_MIN} m — did not hit the model top`,
  );
}

// 2. WebGPU converges to a Cartesian3 by frame <= 4.
if (!gpuHit) {
  failures.push("WebGPU: pickPosition never returned a Cartesian3");
} else if (gpuHit.idx > 4) {
  failures.push(
    `WebGPU: converged too late (first Cartesian3 at frame ${gpuHit.idx}, expected <= 4)`,
  );
}

// 3. THE BUG: WebGPU picked height must be the model top, not the globe below.
if (gpuHit) {
  if (gpuHit.carto.h < MODEL_TOP_MIN) {
    failures.push(
      `DP-H45 REGRESSION: WebGPU picked height ${gpuHit.carto.h.toFixed(1)} m < ${MODEL_TOP_MIN} m — returned the globe behind the model, not the model surface`,
    );
  }
}

// 4. Cross-backend convergence (model top should match within a few meters).
if (glHit && gpuHit) {
  const a = glHit.carto;
  const b = gpuHit.carto;
  const dLon = Math.abs(a.lon - b.lon);
  const dLat = Math.abs(a.lat - b.lat);
  const dH = Math.abs(a.h - b.h);
  console.log(
    `\ncross-backend deltas: dLon=${dLon.toFixed(5)} deg  dLat=${dLat.toFixed(5)} deg  dH=${dH.toFixed(1)} m`,
  );
  if (dLon > 0.01) failures.push(`dLon ${dLon} > 0.01 deg`);
  if (dLat > 0.01) failures.push(`dLat ${dLat} > 0.01 deg`);
  // RGBA8 log-depth quantum at 8 km view is small; allow a few meters.
  if (dH > 30) failures.push(`dHeight ${dH.toFixed(1)} m > 30 m`);
}

// 5. Console errors.
if (webgl.errors?.length > 0)
  failures.push(`WebGL console errors: ${webgl.errors.length}`);
if (webgpu.errors?.length > 0)
  failures.push(`WebGPU console errors: ${webgpu.errors.length}`);

console.log("");
if (failures.length === 0) {
  console.log(
    "PROBE PASS: pickPosition over an opaque Model returns the model surface on WebGPU (DP-H45)",
  );
  process.exit(0);
} else {
  console.log("PROBE FAIL:");
  failures.forEach((f) => console.log("  - " + f));
  process.exit(1);
}
