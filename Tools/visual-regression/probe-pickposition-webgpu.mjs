#!/usr/bin/env node
// Probe (NEW-PICK-WEBGPU-DEPTH-RECONSTRUCTION, Batch 252): scene.pickPosition()
// must return a REAL globe-surface Cartesian3 on WebGPU, matching WebGL.
//
// What it asserts:
//  1. WebGL leg: pickPosition at screen center over the globe returns a
//     Cartesian3 near (-75, 40) — the reference position.
//  2. WebGPU leg, cold cache: the FIRST pickPosition query returns undefined
//     (the async readback is only being armed) and converges to a Cartesian3
//     by frame 3 at the latest.
//  3. WebGPU converged position matches WebGL: |dLon|,|dLat| < 0.05 deg,
//     |dHeight| < 100 m (RGBA8 log-depth quantum is ~2.5 m at this view).
//  4. Zoom-to-cursor smoke: mouse-wheel zoom over the canvas center moves the
//     camera DOWN toward the picked point without jumping to garbage
//     (lat/lon stay near the target, height stays positive).
//  5. Zero console errors on both legs.
//
// Usage: node Tools/visual-regression/probe-pickposition-webgpu.mjs

import { chromium } from "playwright";

const BASE = process.env.PROBE_BASE || "http://localhost:8134";
const LON = -75.0;
const LAT = 40.0;
const HEIGHT = 2_000_000.0;
const DISABLE_DEPTH_BINDING_CACHE =
  process.env.PROBE_DISABLE_DEPTH_BINDING_CACHE === "1";

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

  // Replace Viewer boot's online terrain/imagery before measuring. The public
  // ion token may be current while CI/network policy still blocks requests;
  // letting that failure stand produces an empty globe and a false pick-depth
  // regression on both renderers.
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
  // Ignore only the boot layer's already-observed network errors. Any error
  // raised after deterministic local setup remains a probe failure.
  errors.length = 0;

  const out = await page.evaluate(
    async ({ LON, LAT, HEIGHT, DISABLE_DEPTH_BINDING_CACHE }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const scene = v.scene;

      // Diagnostic escape hatch: force GlobeDepth to rebuild its source-depth
      // view/bind group on every copy. This lets the regression probe isolate
      // cache lifetime errors without changing the production bundle.
      const globeDepth = scene._alternateSceneRenderer?._globeDepth;
      const depthBindingCacheDisabled =
        DISABLE_DEPTH_BINDING_CACHE && !!globeDepth;
      if (depthBindingCacheDisabled) {
        globeDepth._depthCopyBindings = {
          get() {
            return undefined;
          },
          set() {},
        };
      }

      // Look straight down at a known location so the center pixel is globe.
      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(LON, LAT, HEIGHT),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });

      // Let the globe load + render so the depth texture is populated.
      // IMPORTANT: no pickPosition call happens before the cold-cache test —
      // calling pickPosition here would arm the async readback and break the
      // frame-0-undefined cold-cache assertion below. scene.globe.tilesLoaded
      // is a pure read that does NOT arm the pick readback, so it is the safe
      // readiness signal.
      //
      // A fixed 90-frame warmup was flaky (FQ-7): in headless Edge the globe
      // depth texture sometimes still read 1.0 everywhere at frame 90, so the
      // cold-cache getDepth cached _lastDepthValue=1, the >=1.0 sky-reject
      // fired, and the leg returned all-undefined nondeterministically. Gate
      // the sample window on actual tile-load completion instead, with a frame
      // cap so the probe can never hang, plus a few settling frames after
      // tilesLoaded so the depth attachment is definitely written.
      const MAX_WARMUP_FRAMES = 600;
      let warmupFrames = 0;
      let tilesLoadedAt = -1;
      for (let i = 0; i < MAX_WARMUP_FRAMES; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
        warmupFrames = i + 1;
        if (scene.globe && scene.globe.tilesLoaded) {
          tilesLoadedAt = i;
          break;
        }
      }
      // Settle frames: ensure the depth texture is rendered from the now-loaded
      // tiles before the cold-cache window opens. Also enforce a generous floor
      // so very fast tile loads still get a populated depth attachment.
      const SETTLE_FRAMES = 60;
      for (let i = 0; i < SETTLE_FRAMES; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
        warmupFrames += 1;
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

      // Per-frame samples: frame 0 is the cold-cache query.
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
          kind = "Promise"; // contract violation — consumers are synchronous
        } else if (res && typeof res.x === "number" && isFinite(res.x)) {
          kind = "Cartesian3";
          carto = toCarto(res);
        } else if (res && typeof res.x === "number") {
          kind = `Cartesian3-NaN(${res.x})`;
        } else if (typeof res === "string") {
          kind = res;
        }
        const pickDepthDebug = scene._picking.getPickDepth(scene, 0);
        samples.push({
          frame: i,
          kind,
          carto,
          cachedDepth: pickDepthDebug?._lastDepthValue,
          pendingReadback: pickDepthDebug?._pendingReadback,
          depthUpdateCount: pickDepthDebug?._updateCount,
        });
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }

      // Camera state before the zoom smoke.
      const camBefore = toCarto(v.camera.positionWC);

      return {
        rendererType: scene.context?.rendererType,
        pickPositionSupported: scene.pickPositionSupported,
        pickDepthFullFrustumLogEncode:
          scene.context?.pickDepthFullFrustumLogEncode,
        useLogDepth: scene.frameState?.useLogDepth,
        numFrustums: scene._view?.frustumCommandsList?.length,
        warmupFrames,
        depthBindingCacheDisabled,
        tilesLoadedAt,
        tilesLoaded: !!(scene.globe && scene.globe.tilesLoaded),
        samples,
        camBefore,
      };
    },
    { LON, LAT, HEIGHT, DISABLE_DEPTH_BINDING_CACHE },
  );

  // Zoom-to-cursor smoke: wheel over the canvas center (SSCC consumes
  // pickPositionWorldCoordinates for the zoom anchor), then let the
  // controller animate.
  await page.mouse.move(500, 350);
  for (let i = 0; i < 5; i++) {
    await page.mouse.wheel(0, -300);
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(1500);

  const zoom = await page.evaluate(async () => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    for (let i = 0; i < 10; i++) {
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
    const cc = C.Cartographic.fromCartesian(v.camera.positionWC);
    return {
      lon: C.Math.toDegrees(cc.longitude),
      lat: C.Math.toDegrees(cc.latitude),
      h: cc.height,
    };
  });

  await page.close();
  return { ...out, zoom, errors };
}

// ---- run both legs ----
const webgl = await runLeg("webgl");
const webgpu = await runLeg("webgpu");
await browser.close();

// ---- report ----
function printLeg(name, leg) {
  console.log(`\n=== ${name} (${leg.rendererType}) ===`);
  console.log(
    `pickPositionSupported: ${leg.pickPositionSupported}  useLogDepth: ${leg.useLogDepth}  numFrustums: ${leg.numFrustums}`,
  );
  console.log(
    `warmup: ${leg.warmupFrames} frames  tilesLoadedAt: ${leg.tilesLoadedAt}  tilesLoaded: ${leg.tilesLoaded}`,
  );
  for (const s of leg.samples) {
    console.log(
      `  frame ${String(s.frame).padStart(2)}: ${s.kind}` +
        (s.carto
          ? ` @ lon=${s.carto.lon.toFixed(4)} lat=${s.carto.lat.toFixed(4)} h=${s.carto.h.toFixed(1)}`
          : "") +
        ` cachedDepth=${s.cachedDepth} pending=${s.pendingReadback}` +
        ` updates=${s.depthUpdateCount}`,
    );
  }
  console.log(
    `  camera after wheel-zoom: lon=${leg.zoom.lon.toFixed(3)} lat=${leg.zoom.lat.toFixed(3)} h=${leg.zoom.h.toFixed(0)}`,
  );
  console.log(`  console errors: ${leg.errors.length}`);
  leg.errors.slice(0, 6).forEach((e) => console.log("   ERR:", e));
}
printLeg("WebGL", webgl);
printLeg("WebGPU", webgpu);

// ---- assertions ----
const failures = [];

// 1. WebGL reference: at least one converged Cartesian3 near the target.
const glHit = webgl.samples.find((s) => s.kind === "Cartesian3" && s.carto);
if (!glHit) {
  failures.push("WebGL leg never returned a Cartesian3 from pickPosition");
}

// 2. WebGPU cold cache: frame 0 undefined, converges by frame 3.
const gpuSamples = webgpu.samples;
if (gpuSamples[0].kind !== "undefined") {
  failures.push(
    `WebGPU cold-cache: frame 0 expected undefined, got ${gpuSamples[0].kind}`,
  );
}
const gpuFirstHitIdx = gpuSamples.findIndex(
  (s) => s.kind === "Cartesian3" && s.carto,
);
if (gpuFirstHitIdx === -1) {
  failures.push("WebGPU leg never returned a Cartesian3 from pickPosition");
} else if (gpuFirstHitIdx > 3) {
  failures.push(
    `WebGPU converged too late: first Cartesian3 at frame ${gpuFirstHitIdx} (expected <= 3)`,
  );
}
// No Promise leaks (sync contract).
for (const s of gpuSamples) {
  if (s.kind === "Promise") {
    failures.push(`WebGPU frame ${s.frame} returned a Promise (sync contract)`);
  }
}

// 3. Cross-backend position match.
if (glHit && gpuFirstHitIdx !== -1) {
  const a = glHit.carto;
  const b = gpuSamples[gpuFirstHitIdx].carto;
  const dLon = Math.abs(a.lon - b.lon);
  const dLat = Math.abs(a.lat - b.lat);
  const dH = Math.abs(a.h - b.h);
  console.log(
    `\ncross-backend deltas: dLon=${dLon.toFixed(5)} deg  dLat=${dLat.toFixed(5)} deg  dH=${dH.toFixed(1)} m`,
  );
  if (dLon > 0.05) failures.push(`dLon ${dLon} > 0.05 deg`);
  if (dLat > 0.05) failures.push(`dLat ${dLat} > 0.05 deg`);
  if (dH > 100) failures.push(`dHeight ${dH} m > 100 m`);
}

// 4. Zoom-to-cursor smoke (WebGPU): camera moved down, didn't jump to garbage.
if (webgpu.camBefore && webgpu.zoom) {
  if (!(webgpu.zoom.h < webgpu.camBefore.h)) {
    failures.push(
      `WebGPU wheel zoom did not descend (before h=${webgpu.camBefore.h}, after h=${webgpu.zoom.h})`,
    );
  }
  if (webgpu.zoom.h <= 0 || !isFinite(webgpu.zoom.h)) {
    failures.push(`WebGPU camera height after zoom is garbage: ${webgpu.zoom.h}`);
  }
  if (
    Math.abs(webgpu.zoom.lat - LAT) > 5 ||
    Math.abs(webgpu.zoom.lon - LON) > 5
  ) {
    failures.push(
      `WebGPU camera jumped after zoom: lon=${webgpu.zoom.lon} lat=${webgpu.zoom.lat} (expected near ${LON}, ${LAT})`,
    );
  }
}

// 5. Console errors.
if (webgl.errors.length > 0)
  failures.push(`WebGL console errors: ${webgl.errors.length}`);
if (webgpu.errors.length > 0)
  failures.push(`WebGPU console errors: ${webgpu.errors.length}`);

console.log("");
if (failures.length === 0) {
  console.log("PROBE PASS: pickPosition returns real positions on WebGPU");
  process.exit(0);
} else {
  console.log("PROBE FAIL:");
  failures.forEach((f) => console.log("  - " + f));
  process.exit(1);
}
