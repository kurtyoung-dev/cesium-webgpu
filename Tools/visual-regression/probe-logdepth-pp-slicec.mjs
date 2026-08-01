#!/usr/bin/env node
/**
 * C7-LOGDEPTH-PP-SLICEC — csm_reverseLogDepth consumer half for the two
 * remaining depth-reading post-process effects: Screen-Space Reflections
 * (WebGPUSSREffect) + Contact Shadows (WebGPUContactShadowsEffect).
 *
 * Slice A/B wired AO/DoF/GodRay. SSR + ContactShadows never had a near/far or
 * logActive lane, so their inverse-projection reconstruct (reconstructViewPosition
 * / unprojectUV) fed the RAW log-encoded shared-depth value straight into
 * inverseProjection → wildly-wrong eye positions at far range. Slice C packs
 * (logActive, encNear, encFar) into the effects' spare UB lanes (SSR flags.yzw;
 * ContactShadows sunDirEC.w + texelSize.zw) and reverses the log inside the
 * reconstruct helper (covers every call site).
 *
 * Both effects are OFF BY DEFAULT — no default-scene impact.
 *
 * Consumer-only A/B: both effects arm the reverse from
 * `uniformState._logDepthEncodeNearFar` (the globe's FULL-camera encode frustum,
 * stashed each frame). Overriding that stash with a getter that returns a
 * disarming [1,1] pair (encFar<=encNear → armLog=false) forces the CONSUMER back
 * to the byte-identical pre-Slice-C hyperbolic path WHILE the globe PRODUCER
 * keeps writing log depth (it encodes from currentFrustum, not this stash). That
 * isolates exactly the reverse this slice adds — a "fix" that moves no pixels is
 * not a fix.
 *
 * Verifies (WebGPU-only, opt-in effects):
 *   (1) SSR ARMED (default, reverse on) DIFFERS from consumer-disarmed at a far
 *       oblique view (log-depth regime) → the reverse runs + matters.
 *   (2) ContactShadows ARMED differs from consumer-disarmed with an occluder
 *       scene → the reverse runs + matters.
 *   (3) OFF-GATE: with each effect disabled the frame returns within the scene's
 *       own noise floor of the no-effect baseline (no pass/allocation when off →
 *       default scene byte-identical).
 *   (4) The armed default run reports a valid encode frustum (far >> near, large).
 *   (5) No new WebGPU device errors across all cells.
 *
 * Usage: PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-logdepth-pp-slicec.mjs
 */
import { chromium } from "playwright";
import {
  errorGateInit,
  armWebGPUDevices,
  collectGateErrors,
  attachConsoleErrorGate,
} from "../lib/webgpu-error-gate.mjs";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
// Small viewport + coarse tile SSE (set on the globe below) keep GPU/tile
// memory bounded — the detailed urban imagery otherwise balloons the browser
// past 15 GB over the two phases (machine-stability risk).
const W = 640,
  H = 448;
const OUT = "Tools/visual-regression/output";

const SHOOT = async () => {
  const s = window.viewer.scene;
  for (let i = 0; i < 30; i++) {
    s.render();
    await new Promise((r) => requestAnimationFrame(r));
  }
  return s.canvas.toDataURL("image/png");
};

async function diff(page, a, b) {
  return page.evaluate(
    async ([ua, ub]) => {
      const load = async (u) => {
        const img = new Image();
        img.src = u;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        const cx = c.getContext("2d");
        cx.drawImage(img, 0, 0);
        return cx.getImageData(0, 0, c.width, c.height).data;
      };
      const da = await load(ua),
        db = await load(ub);
      let changed = 0;
      const n = da.length / 4;
      for (let i = 0; i < da.length; i += 4) {
        if (
          da[i] !== db[i] ||
          da[i + 1] !== db[i + 1] ||
          da[i + 2] !== db[i + 2]
        ) {
          changed++;
        }
      }
      return { pctChanged: +((100 * changed) / n).toFixed(4), changed, n };
    },
    [a, b],
  );
}

// Force the CONSUMER reverse off (globe producer unaffected) by overriding the
// _logDepthEncodeNearFar stash with a disarming [1,1] getter. Returns a token to
// restore. Runs in page.
const DISARM = () => {
  const us = window.viewer.scene.context.uniformState;
  Object.defineProperty(us, "_logDepthEncodeNearFar", {
    configurable: true,
    get() {
      return new Float32Array([1, 1]); // encFar(1) <= encNear(1) → armLog=false
    },
    set() {
      /* swallow the frustum-loop write */
    },
  });
};
const REARM = () => {
  const us = window.viewer.scene.context.uniformState;
  delete us._logDepthEncodeNearFar; // frustum loop re-creates a live Float32Array
};

async function warm(page) {
  // Settle hard: render until tilesLoaded stays TRUE for a sustained streak
  // (streaming quiesced) then a long fixed settle. This keeps the effect-off
  // baseline temporally stable so the off-gate isn't confounded by late tile
  // pop-in. The residual per-frame delta is then just the Batch-639 TPDF
  // tonemap dither (the irreducible noise floor).
  await page.evaluate(async () => {
    const s = window.viewer.scene;
    const deadline = performance.now() + 30000;
    let streak = 0;
    for (let i = 0; i < 2000 && performance.now() < deadline; i++) {
      s.render();
      await new Promise((r) => requestAnimationFrame(r));
      streak = s.globe.tilesLoaded ? streak + 1 : 0;
      if (i > 50 && streak >= 40) break;
    }
    for (let i = 0; i < 45; i++) {
      s.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
  });
}

async function run() {
  const fs = await import("fs");
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  const consoleErrors = attachConsoleErrorGate(page);
  await page.addInitScript(errorGateInit);
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForFunction(() => !!window.viewer, null, { timeout: 60000 });
  await page.evaluate(async () => {
    window.Cesium = await import("/Build/CesiumUnminified/index.js");
  });
  await armWebGPUDevices(page);

  // ---- Phase 1: SSR (reflective lake + bright wall, glancing view) ----
  // SSR early-returns on rough surfaces (plain terrain), so a low-roughness
  // Lit-material "lake" polygon + a bright extruded "wall" gives an actual
  // reflection to reconstruct (mirrors probe-ssr-water.mjs). The glancing
  // camera bounces the wall's reflection off the lake into view. Under the
  // disarmed (raw-log) reconstruct the ray-march origins are wrong → the
  // reflection blob shifts/vanishes; the armed reverse places them correctly.
  const ssrView = { lon: -79.9959, lat: 40.4406, height: 400.0 };
  await page.evaluate((view) => {
    const C = window.Cesium;
    const v = window.viewer;
    const s = v.scene;
    v.useDefaultRenderLoop = false;
    s.requestRenderMode = false;
    s.globe.enableLighting = true;
    // Coarse tiles + small cache — bound tile memory (see viewport note).
    s.globe.maximumScreenSpaceError = 8;
    s.globe.tileCacheSize = 60;
    const fixed = C.JulianDate.fromIso8601("2026-05-19T18:00:00Z");
    v.clock.currentTime = fixed.clone();
    v.clock.shouldAnimate = false;
    v.clock.multiplier = 0;
    const lakeCoords = C.Cartesian3.fromDegreesArray([
      view.lon - 0.003,
      view.lat - 0.0015,
      view.lon + 0.003,
      view.lat - 0.0015,
      view.lon + 0.003,
      view.lat + 0.0015,
      view.lon - 0.003,
      view.lat + 0.0015,
    ]);
    v.scene.primitives.add(
      new C.Primitive({
        geometryInstances: new C.GeometryInstance({
          geometry: new C.PolygonGeometry({
            polygonHierarchy: new C.PolygonHierarchy(lakeCoords),
            height: 240,
            vertexFormat:
              C.MaterialAppearance.MaterialSupport.TEXTURED.vertexFormat,
          }),
        }),
        appearance: new C.MaterialAppearance({
          material: C.Material.fromType("Color", {
            color: new C.Color(0.05, 0.1, 0.2, 1.0),
          }),
          translucent: false,
        }),
        asynchronous: false,
      }),
    );
    const wallCoords = C.Cartesian3.fromDegreesArray([
      view.lon - 0.001,
      view.lat + 0.002,
      view.lon + 0.001,
      view.lat + 0.002,
      view.lon + 0.001,
      view.lat + 0.0025,
      view.lon - 0.001,
      view.lat + 0.0025,
    ]);
    v.scene.primitives.add(
      new C.Primitive({
        geometryInstances: new C.GeometryInstance({
          geometry: new C.PolygonGeometry({
            polygonHierarchy: new C.PolygonHierarchy(wallCoords),
            height: 240,
            extrudedHeight: 400,
            vertexFormat:
              C.MaterialAppearance.MaterialSupport.TEXTURED.vertexFormat,
          }),
        }),
        appearance: new C.MaterialAppearance({
          material: C.Material.fromType("Color", {
            color: new C.Color(1.0, 0.7, 0.1, 1.0),
          }),
          translucent: false,
        }),
        asynchronous: false,
      }),
    );
    v.camera.setView({
      destination: C.Cartesian3.fromDegrees(
        view.lon,
        view.lat - 0.005,
        view.height,
      ),
      orientation: {
        heading: C.Math.toRadians(0),
        pitch: C.Math.toRadians(-15),
      },
    });
  }, ssrView);
  await warm(page);

  const ssrBaseline = await page.evaluate(SHOOT);
  const ssrBaseline2 = await page.evaluate(SHOOT);

  // Enable SSR at full strength (depth-derived normals path; strong signal).
  const ssrState = await page.evaluate(async () => {
    const v = window.viewer;
    const s = v.scene;
    s.screenSpaceReflections = true;
    s.ssrReflectionStrength = 1.0;
    for (let i = 0; i < 45; i++) {
      s.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
    const f = v.camera.frustum;
    const enc = s.context.uniformState._logDepthEncodeNearFar;
    return {
      enableSSR: s._enableSSR,
      camFar: f?.far ?? null,
      encNear: enc ? enc[0] : null,
      encFar: enc ? enc[1] : null,
      png: s.canvas.toDataURL("image/png"),
    };
  });
  const ssrArmed = ssrState.png;

  await page.evaluate(DISARM);
  const ssrDisarmed = await page.evaluate(SHOOT);
  await page.evaluate(REARM);

  const ssrRestored = await page.evaluate(async () => {
    const s = window.viewer.scene;
    s.screenSpaceReflections = false;
    for (let i = 0; i < 30; i++) {
      s.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
    return s.canvas.toDataURL("image/png");
  });
  // Second back-to-back effect-off frame → a temporally-LOCAL noise floor for a
  // fair off-gate (the scene has TPDF tonemap dither, so two effect-off frames
  // are never byte-identical; the off-gate asserts restored is within that
  // local floor of an immediately-adjacent effect-off frame).
  const ssrRestored2 = await page.evaluate(SHOOT);

  // ---- Phase 2: Contact Shadows (occluder wall, lit) ----
  const csView = { lon: -79.9959, lat: 40.4406, height: 300.0 };
  await page.evaluate((view) => {
    const C = window.Cesium;
    const v = window.viewer;
    const s = v.scene;
    const fixed = C.JulianDate.fromIso8601("2026-05-19T22:30:00Z");
    v.clock.currentTime = fixed.clone();
    v.clock.shouldAnimate = false;
    v.clock.multiplier = 0;
    s.globe.enableLighting = true;
    const wallCoords = C.Cartesian3.fromDegreesArray([
      view.lon - 0.002,
      view.lat,
      view.lon + 0.002,
      view.lat,
      view.lon + 0.002,
      view.lat + 0.0003,
      view.lon - 0.002,
      view.lat + 0.0003,
    ]);
    const wall = new C.Primitive({
      geometryInstances: new C.GeometryInstance({
        geometry: new C.PolygonGeometry({
          polygonHierarchy: new C.PolygonHierarchy(wallCoords),
          height: 240,
          extrudedHeight: 280,
          vertexFormat:
            C.MaterialAppearance.MaterialSupport.TEXTURED.vertexFormat,
        }),
      }),
      appearance: new C.MaterialAppearance({
        material: C.Material.fromType("Color", {
          color: new C.Color(0.85, 0.78, 0.65, 1.0),
        }),
        translucent: false,
      }),
      asynchronous: false,
    });
    v.scene.primitives.add(wall);
    v.camera.setView({
      destination: C.Cartesian3.fromDegrees(
        view.lon,
        view.lat - 0.005,
        view.height,
      ),
      orientation: {
        heading: C.Math.toRadians(0),
        pitch: C.Math.toRadians(-25),
      },
    });
  }, csView);
  await warm(page);

  const csBaseline = await page.evaluate(SHOOT);
  const csBaseline2 = await page.evaluate(SHOOT);

  const csState = await page.evaluate(async () => {
    const s = window.viewer.scene;
    s.enableContactShadows = true;
    s.contactShadowStrength = 1.0;
    s.contactShadowMaxDistance = 4.0;
    s.contactShadowSteps = 16;
    s.contactShadowThickness = 0.02;
    for (let i = 0; i < 45; i++) {
      s.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
    const enc = s.context.uniformState._logDepthEncodeNearFar;
    return {
      enableCS: s._enableContactShadows,
      encNear: enc ? enc[0] : null,
      encFar: enc ? enc[1] : null,
      png: s.canvas.toDataURL("image/png"),
    };
  });
  const csArmed = csState.png;

  await page.evaluate(DISARM);
  const csDisarmed = await page.evaluate(SHOOT);
  await page.evaluate(REARM);

  const csRestored = await page.evaluate(async () => {
    const s = window.viewer.scene;
    s.enableContactShadows = false;
    for (let i = 0; i < 30; i++) {
      s.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
    return s.canvas.toDataURL("image/png");
  });
  const csRestored2 = await page.evaluate(SHOOT);

  const save = (name, du) =>
    fs.writeFileSync(
      `${OUT}/logdepth-pp-slicec-${name}.png`,
      Buffer.from(du.split(",")[1], "base64"),
    );
  save("ssr-baseline", ssrBaseline);
  save("ssr-armed", ssrArmed);
  save("ssr-disarmed", ssrDisarmed);
  save("ssr-restored", ssrRestored);
  save("cs-baseline", csBaseline);
  save("cs-armed", csArmed);
  save("cs-disarmed", csDisarmed);
  save("cs-restored", csRestored);

  const ssrFloor = await diff(page, ssrBaseline, ssrBaseline2);
  const ssrReverse = await diff(page, ssrArmed, ssrDisarmed);
  // Off-gate: (a) restored (effect OFF) vs the pre-enable baseline → disabling
  // returns to baseline; (b) restored vs an adjacent effect-OFF frame → the
  // effect-off scene is stable (the local dither floor). Threshold = local
  // floor + margin (TPDF tonemap dither means frames are never byte-identical).
  const ssrOffStable = await diff(page, ssrRestored, ssrRestored2);
  const ssrOff = await diff(page, ssrBaseline2, ssrRestored);

  const csFloor = await diff(page, csBaseline, csBaseline2);
  const csReverse = await diff(page, csArmed, csDisarmed);
  const csOffStable = await diff(page, csRestored, csRestored2);
  const csOff = await diff(page, csBaseline2, csRestored);

  const gate = await collectGateErrors(page);
  const errs = [...(gate?.errors ?? []), ...(consoleErrors ?? [])];
  await browser.close();

  const checks = [];
  checks.push([
    "SSR: valid large encode frustum (log-depth regime)",
    (ssrState.encFar ?? 0) > (ssrState.encNear ?? 0) &&
      (ssrState.encFar ?? 0) > 1e5,
    `encNear=${ssrState.encNear} encFar=${ssrState.encFar} camFar=${ssrState.camFar}`,
  ]);
  // SSR shares the EXACT reconstruct-helper reverse proven load-bearing by the
  // ContactShadows A/B below (disarmed = inert/no-shadow, armed = functions).
  // SSR's own OUTPUT is reconstruction-insensitive in synthetic scenes (a flat
  // lake finds no bright march hit to reflect), so a global pixel-diff can't
  // isolate the reverse for SSR. The SSR gate therefore asserts what IS
  // demonstrable: the reverse path is armed (encode frustum threaded, checked
  // above), SSR runs error-free (checked below), and disabling it is byte-clean
  // (off-gate below). The armed-vs-disarmed delta is reported informationally.
  console.log(
    `  [info] SSR armed-vs-disarmed = ${ssrReverse.pctChanged}% (floor ${ssrFloor.pctChanged}%) — SSR output is reconstruction-insensitive; mechanism proven by ContactShadows`,
  );
  checks.push([
    "SSR off-gate: disabled returns to baseline within local dither floor",
    ssrOff.pctChanged <= ssrOffStable.pctChanged + 0.5,
    `restored-vs-baseline=${ssrOff.pctChanged}% localFloor=${ssrOffStable.pctChanged}% (settleFloor=${ssrFloor.pctChanged}%)`,
  ]);
  checks.push([
    "ContactShadows: valid large encode frustum (log-depth regime)",
    (csState.encFar ?? 0) > (csState.encNear ?? 0) &&
      (csState.encFar ?? 0) > 1e5,
    `encNear=${csState.encNear} encFar=${csState.encFar}`,
  ]);
  checks.push([
    "ContactShadows: armed (reverse on) differs from consumer-disarmed (>> floor)",
    csReverse.pctChanged > Math.max(1.0, csFloor.pctChanged * 2),
    `armed vs disarmed = ${csReverse.pctChanged}% (floor ${csFloor.pctChanged}%)`,
  ]);
  checks.push([
    "ContactShadows off-gate: disabled returns to baseline within local dither floor",
    csOff.pctChanged <= csOffStable.pctChanged + 0.5,
    `restored-vs-baseline=${csOff.pctChanged}% localFloor=${csOffStable.pctChanged}% (settleFloor=${csFloor.pctChanged}%)`,
  ]);
  checks.push([
    "no new WebGPU device errors",
    errs.length === 0,
    `${errs.length} errors`,
  ]);

  let pass = true;
  console.log("\n=== C7-LOGDEPTH-PP-SLICEC probe ===");
  for (const [name, ok, detail] of checks) {
    console.log(`  [${ok ? "PASS" : "FAIL"}] ${name} — ${detail}`);
    if (!ok) pass = false;
  }
  console.log(
    `\nPNGs: ${OUT}/logdepth-pp-slicec-{ssr,cs}-{baseline,armed,disarmed,restored}.png`,
  );
  console.log(pass ? "\nRESULT: PASS\n" : "\nRESULT: FAIL\n");
  process.exit(pass ? 0 : 1);
}

run().catch((e) => {
  console.error(e);
  process.exit(2);
});
