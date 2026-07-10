// Classifier scene-mode probe (NEW-CLASSIFIER-2D-CV-MORPH verification).
//
// Verifies a flat-color GroundPrimitive (the commonly-used classification
// primitive — ground-clamped polygon) on the WebGPU backend across SCENE3D,
// SCENE2D, and COLUMBUS_VIEW. Built to confirm the doc's claim that
// GroundPrimitive flat-color works in all these modes — and it REFUTED it
// (cf. the dusk-terminator probe, which likewise revealed a "shipped"
// feature wasn't actually exercised on WebGPU). Findings (Batch 161):
//
//   - SCENE3D: was a CATASTROPHIC crash — `ClassificationPrimitive.update`
//     pushed the single-target `depthSamplePick` command into the main
//     command list tagged with the classification pass, so the MSAA 2-target
//     MRT scene pass tried to bind it → command-buffer invalidation → fully
//     black scene + ~hundreds of device errors. FIXED (Batch 161): push only
//     color commands; the pick variant is attached via
//     `derivedCommands.picking` for the pick pass. Now renders matching WebGL.
//   - SCENE2D / COLUMBUS_VIEW: the cascading render-pass crash
//     (NEW-CLASSIFIER-GROUNDPRIM-2D-RENDERPASS — `_beginDefaultRenderPass()
//     called with an active render pass`) was FIXED in Batch 164: on
//     WebGPU, GroundPrimitive no longer falls through to the WebGL command
//     path (which threw mid-frame and left the scene pass open).
//   - The over-broad `_needs2DShader` silent-skip was removed in Batch 169
//     (flat-color GroundPrimitive does NOT need WebGL's `appearance2D` to
//     render in 2D — it only consumes `appearance.material.uniforms.color`).
//   - The LAST 2D blocker — RTE coordinate-frame mismatch between
//     `position2DHigh/Low` `(projX, projY, height)` and `camera.positionWC`
//     in ENU `(altitude, projX, projY)` — was FIXED in Batch 170 via a
//     mode-conditional `.zxy` swizzle in `colorVS` / `vsVelocity` (matches
//     WebGL's `czm_translateRelativeToEye(pos2D.zxy, ...)` convention at
//     PrimitiveShaderHelpers.js:291). SCENE2D and CV now both render the
//     classification polygon at coverage within ~6% of WebGL (Batch 170
//     measured SCENE2D 20781 vs WebGL 20787, CV 14574 vs WebGL 15484).
//
// Method: drop a bright-red ground-clamped polygon over the central US,
// then for each scene mode morph instantly (morphTo*(0)+completeMorph),
// frame the camera over the polygon, render, count "classified" red pixels.
//
// PASS (regression guard for Batches 161 + 164 + 169 + 170): ALL modes
// render the polygon (>= MIN_RED px) with 0 device errors. SCENE2D and CV
// coverage is now ENFORCED (Batch 170 — `ENFORCE_2D = true`).

import { chromium } from "playwright";
import fs from "fs";

const PROBE_BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";
const MIN_RED = 1500; // red-pixel floor: polygon clearly present
const MODES = ["SCENE3D", "SCENE2D", "COLUMBUS_VIEW"];
// 2D/CV polygon coverage is enforced as of Batch 170 (NEW-CLASSIFIER-
// GROUNDPRIM-2D-RTE — mode-conditional .zxy swizzle in colorVS/vsVelocity
// landed; SCENE2D and CV now match WebGL coverage within ~6%).
const ENFORCE_2D = true;

async function run(renderer) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  page.on("pageerror", (e) => console.log(`>> [${renderer}] pageerror: ${e.message}`));
  await page.goto(`${PROBE_BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);

  await page.evaluate(() => {
    window.__probeErrors = [];
    const dev = window.viewer?.scene?.context?._device;
    if (dev) dev.onuncapturederror = (ev) => window.__probeErrors.push(ev?.error?.message ?? "");
  });

  // Add the ground-clamped polygon (per-instance color — the recipe the
  // WebGPUGroundPrimitiveRenderer supports).
  await page.evaluate(async () => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    // Drive rendering deterministically from the probe — stop the viewer's
    // own requestAnimationFrame loop so it can't interleave pick frames
    // (which would corrupt frameState.passes mid-render).
    v.useDefaultRenderLoop = false;
    const scene = v.scene;
    scene.skyBox.show = false;
    scene.skyAtmosphere.show = false;
    scene.backgroundColor = C.Color.fromCssColorString("#101014");
    const positions = C.Cartesian3.fromDegreesArray([
      -100, 40, -95, 40, -95, 43, -100, 43,
    ]);
    const ground = new C.GroundPrimitive({
      geometryInstances: new C.GeometryInstance({
        geometry: new C.PolygonGeometry({
          polygonHierarchy: new C.PolygonHierarchy(positions),
        }),
        attributes: {
          color: C.ColorGeometryInstanceAttribute.fromColor(
            new C.Color(1.0, 0.05, 0.05, 1.0),
          ),
        },
      }),
      classificationType: C.ClassificationType.TERRAIN,
      asynchronous: false,
    });
    scene.groundPrimitives.add(ground);
    window.__C = C;
    window.__ground = ground;
    // Let the primitive build.
    for (let i = 0; i < 120; i++) {
      scene.render();
      await new Promise((r) => requestAnimationFrame(r));
      if (ground.ready) break;
    }
  });

  const perMode = {};
  for (const mode of MODES) {
    const errsBefore = await page.evaluate(() => window.__probeErrors.length);
    await page.evaluate(async (m) => {
      const C = window.__C;
      const v = window.viewer;
      const scene = v.scene;
      // Switch + force-settle the morph so each mode is measured in a
      // clean steady state (duration-0 morph still completes on a tick;
      // completeMorph snaps it). 3D is the default — only morph away.
      if (m === "SCENE2D") {
        scene.morphTo2D(0);
        scene.completeMorph();
      } else if (m === "COLUMBUS_VIEW") {
        scene.morphToColumbusView(0);
        scene.completeMorph();
      } else {
        scene.morphTo3D(0);
        scene.completeMorph();
      }
      // Frame the polygon (centroid ~ -97.5, 41.5) from above in every mode.
      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(-97.5, 41.5, 2_400_000),
        orientation: { heading: 0, pitch: -C.Math.PI_OVER_TWO, roll: 0 },
      });
      // READINESS RACE FIX (C7-GROUNDPRIM-TEXTURED-CLASSIFY-ZERO): gate
      // on GLOBE-pass commands in the frustum lists + tilesLoaded so the
      // capture never races the WebGPU globe terrain pipeline's ~1-2 s
      // createRenderPipelineAsync (headless RAF settles complete well
      // inside that). Without this, the first-measured mode captured a
      // globe-less scene — and with the czm_packDepth(1.0) no-surface
      // sentinel (WebGL parity), a globe-less scene correctly
      // classifies NOTHING.
      const globeCommandCount = () =>
        (scene.frustumCommandsList ?? []).reduce(
          (acc, fc) => acc + (fc.indices?.[2] ?? 0),
          0,
        );
      const t0 = performance.now();
      while (performance.now() - t0 < 90_000) {
        scene.requestRender();
        scene.render();
        if (scene.globe.tilesLoaded && globeCommandCount() > 0) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      for (let i = 0; i < 90; i++) {
        scene.requestRender();
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
    }, mode);

    const png = await page.screenshot({ type: "png" });
    fs.writeFileSync(`${OUT_DIR}/classifier-${mode}-${renderer}.png`, png);

    const red = await page.evaluate(async (durl) => {
      return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          const c = document.createElement("canvas");
          c.width = img.width;
          c.height = img.height;
          const cx = c.getContext("2d");
          cx.drawImage(img, 0, 0);
          const d = cx.getImageData(0, 0, c.width, c.height).data;
          let n = 0;
          for (let i = 0; i < d.length; i += 4) {
            // "Classified red": dominant red channel, distinct from the
            // blue/green globe + dark background + grey UI.
            if (d[i] > 120 && d[i] > d[i + 1] * 1.7 && d[i] > d[i + 2] * 1.7) n++;
          }
          resolve(n);
        };
        img.src = durl;
      });
    }, `data:image/png;base64,${png.toString("base64")}`);

    const errsAfter = await page.evaluate(() => window.__probeErrors.length);
    perMode[mode] = { red, newErrs: errsAfter - errsBefore };
  }

  const errs = await page.evaluate(() => window.__probeErrors ?? []);
  await browser.close();
  return { perMode, errs };
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const wgl = await run("webgl");
  const wgpu = await run("webgpu");

  console.log("=== Classifier scene-mode probe (flat-color GroundPrimitive) ===\n");
  console.log("  mode            WebGL red px    WebGPU red px   WebGPU errs");
  let pass = true;
  for (const m of MODES) {
    const g = wgl.perMode[m].red;
    const p = wgpu.perMode[m].red;
    const e = wgpu.perMode[m].newErrs;
    const ok = p >= MIN_RED && e === 0;
    const enforced = m === "SCENE3D" || ENFORCE_2D;
    const tag = ok ? "OK" : enforced ? "FAIL" : "known-open(textured-2D)";
    console.log(
      `  ${m.padEnd(15)} ${String(g).padStart(10)}    ${String(p).padStart(10)}    ${String(e).padStart(6)}   ${tag}`,
    );
    // The render-pass crash (Batch 164) is fixed → device errors are
    // enforced for ALL modes, even the known-open 2D/CV coverage gap.
    if (e !== 0) pass = false;
    if (!ok && enforced) pass = false;
  }
  console.log(`\n  total WebGPU device errors: ${wgpu.errs.length}`);
  wgpu.errs.slice(0, 5).forEach((x) => console.log(`    - ${(x ?? "").slice(0, 160)}`));
  console.log(`\n  PNGs: ${OUT_DIR}/classifier-{SCENE3D,SCENE2D,COLUMBUS_VIEW}-{webgl,webgpu}.png`);
  console.log(pass ? "\nPASS" : "\nFAIL");
  process.exit(pass ? 0 : 1);
})();
