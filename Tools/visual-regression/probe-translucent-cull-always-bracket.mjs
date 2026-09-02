#!/usr/bin/env node
/**
 * Probe: translucent-pass GPU cull render-pass bracket (Q-20 / Q-48 / Q-50).
 * @purpose Reproduces Q-48 by crossing the translucent GPU-cull gate under gpuCullingHint='always' and asserting the frame does not blank with a locked-encoder validation error
 * @status ACTIVE
 *
 * Q-20 found `gpuCullCommandsForTranslucent`'s `beginComputePass` dispatch
 * with no `endCurrentRenderPass()` / `_resumeScenePass()` bracket around the
 * call site in `_maybeGPUCullTranslucent` — unlike the verbatim-identical
 * bracket the OPAQUE cull call site carries. The translucent gate is reached
 * ONLY when `Scene.gpuCullingHint === 'always'` (`'auto'` stays opaque-only
 * characterization), which is exactly the condition Q-48 reports as fatal:
 * "'auto'/'never' clean at the same count" while 'always' blanks the frame
 * with a permanent "CommandEncoder locked while RenderPassEncoder is open"
 * validation error. The opaque-pass gate does not differ between 'auto' and
 * 'always' (`forceOff = hint === 'never'` for both), so the translucent
 * branch is the only code path 'always' adds — this scene isolates it by
 * building enough TRANSLUCENT commands to cross the shared
 * `GPU_CULL_THRESHOLD_HI` (384) gate, which none of the fleet's existing
 * `gpuCullingHint` probes do (they cross opaque-only thresholds with
 * `translucent: false` geometry, so the translucent branch never dispatches
 * in them regardless of hint).
 *
 * Two legs, same 500-box translucent scene:
 *   - NEVER : gpuCullingHint = 'never'  (translucent cull gate never reached)
 *   - ALWAYS: gpuCullingHint = 'always' (translucent cull gate active, count
 *             500 > GPU_CULL_THRESHOLD_HI = 384)
 *
 * The globe stays ON (offline imagery/terrain; GlobeSurfaceTileProvider's
 * default baseColor is navy (0,0,0.5,1) — packages/engine/Source/Scene/
 * GlobeSurfaceTileProvider.js:421) rather than off against a black
 * background. From 260 km straight down, the horizon distance
 * (sqrt(2*R*h) ~= 1820 km) is far outside the ~300 km frustum footprint, so
 * the globe alone should cover very close to 100% of the canvas whenever the
 * frame renders at all — matching the discriminator the original Edge-lane
 * reproducer (probe-gpucull-blackframe-isolation.mjs, see the Owed-at-
 * landing section) used, and making the non-background fraction independent
 * of how much screen area the translucent boxes themselves happen to
 * subtend.
 *
 * PASS requires the ALWAYS leg to render a non-blank frame with no
 * locked-encoder validation error and no device loss — before the Q-20 fix
 * this leg blanks (0% non-background pixels; the whole command buffer is
 * dropped by the validation error) and the error gate reports the lock. The
 * NEVER leg is the sanity control proving the scene itself is visible and
 * unrelated to the crash.
 *
 * Usage:
 *   PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-translucent-cull-always-bracket.mjs
 *
 * Output: Tools/visual-regression/output/translucent-cull-always-{never,always}.png
 */
import { chromium } from "playwright";
import fs from "fs";
import {
  errorGateInit,
  armWebGPUDevices,
  collectGateErrors,
  attachConsoleErrorGate,
} from "../lib/webgpu-error-gate.mjs";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const W = 1024,
  H = 768;
// 500 > GPU_CULL_THRESHOLD_HI (384) with headroom above the hysteresis LO
// (192) so the gate stays active across every rendered frame.
const BOX_COUNT = Number(process.env.PROBE_TRANSLUCENT_COUNT || 500);
const LOCK_ERROR_RE = /locked while RenderPassEncoder is open/i;

const BUILD_SCENE = async (count) => {
  const Cesium = await import("/Build/CesiumUnminified/index.js");
  const v = window.viewer;
  const scene = v.scene;
  const prims = scene.primitives;
  scene.requestRenderMode = false;
  // Globe ON, offline-safe (no imagery/terrain fetch): GlobeSurfaceTileProvider's
  // default baseColor navy (0,0,0.5,1) fills the frame with a clearly
  // non-background color whenever the render pass actually completes, and
  // the globe alone covers ~100% of the canvas at this altitude/pitch (see
  // header comment) regardless of how many translucent boxes are visible.
  scene.globe.show = true;
  scene.globe.terrainProvider = new Cesium.EllipsoidTerrainProvider();
  scene.globe.imageryLayers.removeAll();
  scene.skyBox.show = false;
  if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
  if (scene.sun) scene.sun.show = false;
  scene.backgroundColor = Cesium.Color.BLACK;

  const lon0 = -105.0,
    lat0 = 39.0;
  const grid = Math.ceil(Math.sqrt(count));
  const boxGeom = Cesium.BoxGeometry.fromDimensions({
    vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
    dimensions: new Cesium.Cartesian3(1800.0, 1800.0, 1800.0),
  });
  let created = 0;
  for (let i = 0; i < grid && created < count; i++) {
    for (let j = 0; j < grid && created < count; j++) {
      const dLon = (i / grid - 0.5) * 0.5;
      const dLat = (j / grid - 0.5) * 0.5;
      const pos = Cesium.Cartesian3.fromDegrees(
        lon0 + dLon,
        lat0 + dLat,
        30000.0,
      );
      prims.add(
        new Cesium.Primitive({
          geometryInstances: new Cesium.GeometryInstance({
            geometry: boxGeom,
            modelMatrix: Cesium.Transforms.eastNorthUpToFixedFrame(pos),
            attributes: {
              color: Cesium.ColorGeometryInstanceAttribute.fromColor(
                Cesium.Color.fromHsl(
                  (created % 360) / 360,
                  0.85,
                  0.55,
                  0.6, // translucent — routes into Pass.TRANSLUCENT
                ),
              ),
            },
          }),
          // The translucent gate this probe targets is reached only for
          // commands in Pass.TRANSLUCENT — opaque geometry never reaches
          // `_maybeGPUCullTranslucent` regardless of gpuCullingHint.
          appearance: new Cesium.PerInstanceColorAppearance({
            translucent: true,
            closed: true,
          }),
          asynchronous: false,
        }),
      );
      created++;
    }
  }

  const center = Cesium.Cartesian3.fromDegrees(lon0, lat0, 30000.0);
  scene.camera.lookAt(
    center,
    new Cesium.HeadingPitchRange(0.0, Cesium.Math.toRadians(-90.0), 260000.0),
  );
  scene.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
  return { created, primCount: prims.length };
};

const RENDER_AND_CAPTURE = async (cfg) => {
  const v = window.viewer;
  const scene = v.scene;
  scene.gpuCullingHint = cfg.hint;
  for (let i = 0; i < cfg.frames; i++) {
    scene.render();
    await new Promise((r) => requestAnimationFrame(r));
  }
  scene.render();
  return { dataUrl: scene.canvas.toDataURL("image/png") };
};

function decodePngToRgba(page, dataUrl) {
  return page.evaluate(async (du) => {
    const img = new Image();
    img.src = du;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    return { w: c.width, h: c.height, data: Array.from(d) };
  }, dataUrl);
}

// Fraction of pixels that are NOT the black background — a blanked frame
// (the Q-48 symptom) reads ~0 here even though the scene has hundreds of
// bright translucent boxes framed dead-center.
function nonBackgroundFraction(rgba) {
  let lit = 0;
  const total = rgba.w * rgba.h;
  for (let i = 0; i < rgba.data.length; i += 4) {
    if (rgba.data[i] + rgba.data[i + 1] + rgba.data[i + 2] > 15) lit++;
  }
  return lit / total;
}

// Machine-safety contract (Tools/visual-regression/probe-fleet-contract.spec.mjs):
// every probe carries a watchdog that force-exits a hung run, and closes the
// browser inside a `finally` so a throw between legs can never leave a WebGPU
// browser process running unattended.
const WATCHDOG_MS = 240_000;

async function run() {
  fs.mkdirSync("Tools/visual-regression/output", { recursive: true });
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  let neverLit;
  let neverGate;
  let alwaysLit;
  let alwaysGate;
  let consoleErrors;
  let buildInfo;
  try {
    const page = await browser.newPage({ viewport: { width: W, height: H } });
    consoleErrors = attachConsoleErrorGate(page);
    await page.addInitScript(errorGateInit);
    // offline=true drops the default base layer/world terrain at startup
    // (CesiumViewerStartupOptions.js) so the globe backdrop this probe
    // relies on does not depend on Ion auth or network imagery availability.
    await page.goto(
      `${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu&offline=true`,
      { waitUntil: "domcontentloaded" },
    );
    await page.waitForFunction(() => !!window.viewer, null, {
      timeout: 60000,
    });
    await armWebGPUDevices(page);

    buildInfo = await page.evaluate(BUILD_SCENE, BOX_COUNT);

    // Control: gate never reached, proves the scene itself renders.
    const never = await page.evaluate(RENDER_AND_CAPTURE, {
      hint: "never",
      frames: 5,
    });
    neverGate = await collectGateErrors(page);
    const neverRgba = await decodePngToRgba(page, never.dataUrl);
    neverLit = nonBackgroundFraction(neverRgba);

    fs.writeFileSync(
      "Tools/visual-regression/output/translucent-cull-always-never.png",
      Buffer.from(never.dataUrl.split(",")[1], "base64"),
    );

    // Target leg: translucent cull gate active (count 500 > HI=384).
    const always = await page.evaluate(RENDER_AND_CAPTURE, {
      hint: "always",
      frames: 5,
    });
    alwaysGate = await collectGateErrors(page);
    const alwaysRgba = await decodePngToRgba(page, always.dataUrl);
    alwaysLit = nonBackgroundFraction(alwaysRgba);

    fs.writeFileSync(
      "Tools/visual-regression/output/translucent-cull-always-always.png",
      Buffer.from(always.dataUrl.split(",")[1], "base64"),
    );
  } finally {
    await browser.close();
  }

  const lockErrors = [
    ...consoleErrors,
    ...alwaysGate.errors,
    ...(alwaysGate.deviceLost ? [alwaysGate.deviceLost] : []),
  ].filter((e) => LOCK_ERROR_RE.test(e));

  console.log("built:", JSON.stringify(buildInfo));
  console.log(
    `NEVER  leg: lit=${(neverLit * 100).toFixed(2)}% errors=${neverGate.errors.length}`,
  );
  console.log(
    `ALWAYS leg: lit=${(alwaysLit * 100).toFixed(2)}% errors=${alwaysGate.errors.length} deviceLost=${alwaysGate.deviceLost || "none"}`,
  );
  if (lockErrors.length) console.log("LOCK errors:", lockErrors.slice(0, 3));

  // 0.5 (50%) leaves wide margin under the ~100% the globe backdrop is
  // expected to cover (see header comment) while still being a strict test
  // against the ~0% a fully blanked/dropped command buffer produces.
  const LIT_BAR = 0.5;
  const checks = [
    ["control (NEVER) leg renders a lit scene", neverLit > LIT_BAR],
    [
      `ALWAYS leg renders a lit scene (${(alwaysLit * 100).toFixed(2)}% lit, was ~0% blanked pre-fix)`,
      alwaysLit > LIT_BAR,
    ],
    ["no locked-encoder validation error", lockErrors.length === 0],
    ["no device loss on ALWAYS leg", !alwaysGate.deviceLost],
  ];
  let pass = true;
  console.log("\n=== ANALYSIS ===");
  for (const [name, ok] of checks) {
    console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}`);
    if (!ok) pass = false;
  }
  console.log(`\nRESULT: ${pass ? "GREEN" : "RED"}`);
  process.exitCode = pass ? 0 : 1;
}

const watchdog = setTimeout(() => {
  console.error(
    `probe-translucent-cull-always-bracket: watchdog fired after ${WATCHDOG_MS}ms`,
  );
  process.exit(2);
}, WATCHDOG_MS);
watchdog.unref?.();

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 2;
  })
  .finally(() => {
    clearTimeout(watchdog);
  });
