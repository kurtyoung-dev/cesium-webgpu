#!/usr/bin/env node
// Probe (DP-H35): glTF morph-target NORMAL deltas on WebGPU.
// @purpose DP-H35 acceptance: morph-target NORMAL deltas re-shade on WebGPU — within-backend luminance ratio isolates the normal morph from BRDF gaps.
// @status ACTIVE
//
// Bug: WebGPU morph applies POSITION deltas but NOT NORMAL deltas, so the lit
// shading on a morph-animated mesh is FROZEN — the surface deforms but the
// lighting doesn't follow because the normals never morph. WebGL morphs the
// normals (MorphTargetsStageVS.glsl getMorphedNormal()).
//
// Method: load AnimatedMorphCube, kill the model's animations so morph weights
// are under our control, and sample the average lit color at the REST pose vs
// the TARGET-1 morph. Morphing target 1 tilts the cube's faces so a backend that
// morphs normals RE-SHADES them (here: darker, the faces rotate away from the
// fixed light); a frozen-normal backend keeps the rest-pose shading on those
// faces even though the silhouette deforms.
//
// WHY TARGET 1 (decoded from the asset's accessors): AnimatedMorphCube target 0
// has a POSITION delta but a ZERO normal delta — its faces translate without
// reorienting, so it can NEVER show a normal-morph effect. Target 1 carries the
// real NORMAL delta (maxAbs 0.705). A controlled build A/B (normal accumulation
// ON vs OFF, identical silhouette) confirmed the fix: at the target-1 morph the
// WebGPU lit mean is 65.3 with normals ON vs 98.6 with them OFF — a 33-unit
// shading swing attributable ONLY to the normal morph (the position morph and
// silhouette are byte-identical between the two builds).
//
// CONTROLLING FOR THE SEPARATE BRDF GRAY GAP (Batch 337): AnimatedMorphCube's
// material is a NEUTRAL gray baseColorFactor (0.604,0.604,0.604). WebGPU renders
// it correctly gray (R=G=B); WebGL adds a greenish IBL-ambient tint and is
// brighter. That cross-backend gray-vs-tint divergence is a SEPARATE model-PBR
// direct-light/IBL parity item (Batch 337) — it exists at the REST pose where
// nothing morphs, so it is NOT a morph-normal bug. To divide it out we assert on
// the WITHIN-backend rest→morphed luminance RATIO, where the constant per-
// backend BRDF offset cancels: a correct normal morph gives WebGPU ≈1.22 (close
// to WebGL ≈1.33); a FROZEN normal would give ≈1.84 (98.6/53.6 — silhouette
// brightening with no compensating normal re-shading).
//
// Assertions:
//   1. Position-morph parity: lit-pixel COUNT matches cross-backend at the
//      morphed weight (the position morph is byte-identical and unchanged).
//   2. Normal morph present (WebGPU within-backend): the rest→morphed luminance
//      ratio is well BELOW the frozen-normal value — the normals re-shade.
//   3. Cross-backend ratio agreement (controls out the BRDF gray gap).
//
// Usage: PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-morph-normals.mjs
// Out:   output/morph-normals-{webgl,webgpu}-w{A,B}.png

import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import {
  errorGateInit,
  armWebGPUDevices,
  collectGateErrors,
  attachConsoleErrorGate,
} from "../lib/webgpu-error-gate.mjs";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";
const MODEL_URL =
  "/Specs/Data/Models/glTF-2.0/AnimatedMorphCube/glTF/AnimatedMorphCube.gltf";

// Rest pose vs target-1 morph. CRITICAL ASSET DETAIL (verified by decoding the
// accessors): AnimatedMorphCube TARGET 0 carries a POSITION delta but a ZERO
// NORMAL delta (maxAbs 0.0) — morphing it changes the silhouette but legitimately
// does NOT change any normal. TARGET 1 is the one with the real NORMAL delta
// (maxAbs 0.705). So the morph-normal path is ONLY exercised by weighting
// TARGET 1; an earlier [1,0] (target-0) weight could never show a normal-morph
// effect regardless of the fix. We weight target 1 ([0,1]) here.
const WEIGHT_A = [0.0, 0.0]; // rest
const WEIGHT_B = [0.0, 1.0]; // target-1 morph (the one with a non-zero NORMAL delta)

async function capture(rendererArg) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: [
      "--enable-unsafe-webgpu",
      "--enable-features=Vulkan",
      "--use-vulkan",
      "--disable-cache",
      "--disk-cache-size=1",
    ],
  });
  const context = await browser.newContext({
    viewport: { width: 800, height: 800 },
  });
  // Force a fresh fetch of the freshly-built bundle on every run (Playwright's
  // HTTP cache otherwise serves the pre-rebuild Cesium.js and masks the fix).
  await context.route("**/*", (route) => {
    const headers = {
      ...route.request().headers(),
      "cache-control": "no-cache",
    };
    route.continue({ headers });
  });
  const page = await context.newPage();
  const consoleErrors = attachConsoleErrorGate(page);
  await page.addInitScript(errorGateInit);
  await page.goto(
    `${BASE}/Apps/CesiumViewer/index.html?renderer=${rendererArg}`,
    {
      waitUntil: "networkidle",
    },
  );
  await page.waitForFunction(() => !!window.viewer);
  await armWebGPUDevices(page);

  const result = await page.evaluate(
    async ({ modelUrl, weightA, weightB }) => {
      const Cesium = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const scene = v.scene;

      // Deterministic lighting: fixed sun, shadows off, no globe/atmosphere
      // noise behind the model. A fixed light is what makes a normal change
      // visible as a shading change.
      scene.globe.show = false;
      scene.skyBox.show = false;
      scene.skyAtmosphere.show = false;
      scene.sun.show = false;
      scene.moon.show = false;
      scene.backgroundColor = Cesium.Color.BLACK.clone();
      scene.shadowMap.enabled = false;
      scene.fog.enabled = false;
      // Fixed directional light so morphed normals produce a stable, repeatable
      // shading response (default sun moves with time).
      scene.light = new Cesium.DirectionalLight({
        direction: Cesium.Cartesian3.normalize(
          new Cesium.Cartesian3(0.3, -0.5, -0.8),
          new Cesium.Cartesian3(),
        ),
        intensity: 2.0,
      });

      // Place the model at a known ECEF origin and frame it head-on.
      const origin = Cesium.Cartesian3.fromDegrees(0.0, 0.0, 0.0);
      const modelMatrix = Cesium.Transforms.eastNorthUpToFixedFrame(origin);
      const model = await Cesium.Model.fromGltfAsync({
        url: modelUrl,
        modelMatrix: modelMatrix,
        scale: 1.0,
        // Force unlit off — we want lit PBR so normals matter.
        incrementallyLoadTextures: false,
      });
      scene.primitives.add(model);

      // Spin up frames until the model is ready.
      for (let i = 0; i < 600 && !model.ready; i++) {
        scene.initializeFrame();
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
      if (!model.ready) {
        return { error: "model never became ready" };
      }

      // Kill animations so they don't drive the morph weights out from under us.
      model.activeAnimations.removeAll();

      // DIAGNOSTIC: confirm the extracted morph geometry actually carries
      // NORMAL deltas (the fix is a no-op if normalData is null at pack time).
      const diag = { primitives: [] };
      try {
        const graph = model.sceneGraph;
        const rns = graph._runtimeNodes;
        for (let i = 0; i < rns.length; i++) {
          const rn = rns[i];
          const runtimePrims = rn?.runtimePrimitives || rn?._runtimePrimitives;
          if (!runtimePrims) continue;
          for (let p = 0; p < runtimePrims.length; p++) {
            const rp = runtimePrims[p];
            const prim = rp.primitive || rp._primitive;
            const mts = prim?.morphTargets;
            if (!mts) continue;
            const info = mts.map((mt) => {
              const attrs = mt.attributes || [];
              return attrs
                .map((a) => a.semantic || a.name)
                .filter((s) => s)
                .join(",");
            });
            diag.primitives.push({ node: i, prim: p, targets: info });
          }
        }
      } catch (e) {
        diag.error = String(e);
      }
      window.__morphDiag = diag;

      // Frame the cube: look at it from the local +E/+Up direction.
      const bs = model.boundingSphere;
      const camOffset = new Cesium.HeadingPitchRange(
        0.0,
        Cesium.Math.toRadians(-20.0),
        bs.radius * 3.5,
      );
      v.camera.lookAt(bs.center, camOffset);

      function setMorphWeights(weights) {
        // Drive the runtime node morph weights directly (public path:
        // sceneGraph._runtimeNodes[*].morphWeights setter copies into
        // _morphWeights, which the WebGPU + WebGL renderers both read).
        const graph = model.sceneGraph;
        const nodes = graph._runtimeNodes;
        let set = 0;
        for (let i = 0; i < nodes.length; i++) {
          const rn = nodes[i];
          if (
            rn &&
            rn.morphWeights &&
            rn.morphWeights.length >= weights.length
          ) {
            rn.morphWeights = weights.slice();
            set++;
          }
        }
        return set;
      }

      function sampleLit() {
        // Read the canvas, find lit (non-black) pixels of the model, and
        // average their RGB. Background is pure black, so any pixel above a
        // small luma floor belongs to the lit cube.
        //
        // Also compute luminance (the load-bearing normal-morph signal) and an
        // informational bright-fraction. Both are ROBUST to the separate model-
        // PBR base-color/IBL gray-vs-tint gap (Batch 337) because the verdict
        // asserts the WITHIN-backend rest→morphed luma RATIO, where the constant
        // per-backend BRDF offset cancels — not the absolute cross-backend color.
        const c = scene.canvas;
        const off = document.createElement("canvas");
        off.width = c.width;
        off.height = c.height;
        const cx = off.getContext("2d");
        cx.drawImage(c, 0, 0);
        const d = cx.getImageData(0, 0, c.width, c.height).data;
        let r = 0,
          g = 0,
          b = 0,
          n = 0,
          lumaSum = 0,
          bright = 0;
        // Bright threshold (0-255 luma): a face tilted into the light reads well
        // above this; a dim rest-pose face reads below it. Mid-gray so it
        // separates the morphed lit face from the rest-pose ambient shading on
        // BOTH backends despite the tint gap.
        const BRIGHT_LUMA = 110;
        for (let p = 0; p < d.length; p += 4) {
          const lr = d[p],
            lg = d[p + 1],
            lb = d[p + 2];
          if (lr + lg + lb > 24) {
            r += lr;
            g += lg;
            b += lb;
            // Rec. 601 luma — perceptual brightness, tint-insensitive enough
            // for the bright-fraction signal on a near-gray material.
            const luma = 0.299 * lr + 0.587 * lg + 0.114 * lb;
            lumaSum += luma;
            if (luma > BRIGHT_LUMA) bright++;
            n++;
          }
        }
        if (n === 0)
          return { r: 0, g: 0, b: 0, n: 0, luma: 0, brightFraction: 0 };
        return {
          r: r / n,
          g: g / n,
          b: b / n,
          n,
          luma: lumaSum / n,
          brightFraction: bright / n,
        };
      }

      async function renderSettled(frames) {
        for (let i = 0; i < frames; i++) {
          scene.initializeFrame();
          scene.render();
          await new Promise((r) => requestAnimationFrame(r));
        }
      }

      const nodesSetA = setMorphWeights(weightA);
      await renderSettled(20);
      const litA = sampleLit();
      const dataA = scene.canvas.toDataURL("image/png");

      const nodesSetB = setMorphWeights(weightB);
      await renderSettled(20);
      const litB = sampleLit();
      const dataB = scene.canvas.toDataURL("image/png");

      // Shading delta between the two weights (sum of abs channel deltas of
      // the average lit color). Frozen normals → ~0; morphed normals → > 0.
      const shadeDelta =
        Math.abs(litA.r - litB.r) +
        Math.abs(litA.g - litB.g) +
        Math.abs(litA.b - litB.b);

      return {
        nodesSetA,
        nodesSetB,
        litA,
        litB,
        shadeDelta,
        dataA,
        dataB,
        diag: window.__morphDiag,
      };
    },
    { modelUrl: MODEL_URL, weightA: WEIGHT_A, weightB: WEIGHT_B },
  );

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  if (result.dataA) {
    fs.writeFileSync(
      path.join(OUT_DIR, `morph-normals-${rendererArg}-wA.png`),
      Buffer.from(result.dataA.split(",")[1], "base64"),
    );
    fs.writeFileSync(
      path.join(OUT_DIR, `morph-normals-${rendererArg}-wB.png`),
      Buffer.from(result.dataB.split(",")[1], "base64"),
    );
  }

  const gate = await collectGateErrors(page);
  await browser.close();

  const fatal = [
    ...consoleErrors,
    ...gate.errors,
    ...(gate.deviceLost ? [gate.deviceLost] : []),
  ];

  console.log(`\n===== ${rendererArg.toUpperCase()} =====`);
  if (result.error) {
    console.log(`  ERROR: ${result.error}`);
  } else {
    const f = (o) =>
      `(${o.r.toFixed(1)}, ${o.g.toFixed(1)}, ${o.b.toFixed(1)}) n=${o.n} luma=${o.luma.toFixed(1)} bright=${(o.brightFraction * 100).toFixed(1)}%`;
    console.log(`  nodes morphed: A=${result.nodesSetA} B=${result.nodesSetB}`);
    console.log(`  litA weight[0,0]: ${f(result.litA)}`);
    console.log(`  litB weight[1,0]: ${f(result.litB)}`);
    console.log(`  shadeDelta (A vs B): ${result.shadeDelta.toFixed(2)}`);
    console.log(`  morph diag: ${JSON.stringify(result.diag)}`);
  }
  console.log(`  gate fatal=${fatal.length}`);
  fatal.slice(0, 4).forEach((e) => console.log(`    FATAL: ${e}`));

  return { rendererArg, ...result, fatal: fatal.length };
}

(async () => {
  const gl = await capture("webgl");
  const gpu = await capture("webgpu");

  console.log("\n[probe-morph-normals] SUMMARY");

  let pass = true;
  const fail = (msg) => {
    console.log(`  FAIL: ${msg}`);
    pass = false;
  };

  if (!(gl.litA && gl.litB && gpu.litA && gpu.litB)) {
    fail("missing samples (model load / render failure).");
    console.log(`[probe-morph-normals] FAIL`);
    process.exit(1);
  }

  // ── Assertion 1: position-morph parity (cross-backend) ──────────────────────
  // The position morph is byte-identical across backends (same packed deltas),
  // so the lit-pixel COUNT — i.e. the silhouette — must match at each weight.
  // This guards the position-morph path that DP-H35 must leave unchanged.
  const relCount = (a, b) => Math.abs(a - b) / Math.max(a, b, 1);
  const countA = relCount(gl.litA.n, gpu.litA.n);
  const countB = relCount(gl.litB.n, gpu.litB.n);
  console.log(
    `  position-morph silhouette: countΔA=${(countA * 100).toFixed(2)}%  countΔB=${(countB * 100).toFixed(2)}%  (cross-backend)`,
  );
  if (countA > 0.03 || countB > 0.03) {
    fail(
      `position-morph silhouette diverged cross-backend (>3%) — the position morph regressed.`,
    );
  }

  // ── Assertion 2: normals morph (WebGPU within-backend re-shading) ───────────
  // Within-backend rest→morphed luminance RATIO. The BRDF gray gap is a constant
  // per-backend offset that cancels in this ratio, so it isolates the normal
  // re-shading. Reference values (from the controlled normal-ON/OFF build A/B):
  //   WebGPU normals ON  : 65.3/53.6 ≈ 1.22   ← correct (normal tilts faces
  //                                              AWAY from light, partly undoing
  //                                              the silhouette brightening)
  //   WebGPU normals OFF : 98.6/53.6 ≈ 1.84   ← frozen (silhouette brightening
  //                                              only, no normal re-shading)
  //   WebGL  normals ON  : 76.7/57.7 ≈ 1.33
  // The morphed ratio must sit well below the frozen-normal value — that gap is
  // the entire normal-morph signal.
  const FROZEN_RATIO = 1.84; // measured WebGPU normals-OFF reference
  const glRatio = gl.litB.luma / Math.max(gl.litA.luma, 1);
  const gpuRatio = gpu.litB.luma / Math.max(gpu.litA.luma, 1);
  console.log(
    `  within-backend rest→morphed luma ratio: WebGL ×${glRatio.toFixed(2)}  WebGPU ×${gpuRatio.toFixed(2)}  (frozen-normal ref ×${FROZEN_RATIO})`,
  );
  // Midpoint between the working (1.22) and frozen (1.84) signals as the ceiling
  // — generous margin on both sides so neither a slightly noisier working run
  // nor a slightly milder frozen run lands on the wrong side.
  const MORPH_RATIO_CEIL = 1.55;
  if (gpuRatio >= MORPH_RATIO_CEIL) {
    fail(
      `WebGPU rest→morphed luma ratio ×${gpuRatio.toFixed(2)} ≥ ${MORPH_RATIO_CEIL} — too close to the frozen-normal value (×${FROZEN_RATIO}); normals appear NOT to morph.`,
    );
  }

  // ── Assertion 3: cross-backend ratio agreement (BRDF gap divided out) ───────
  // With the constant gray offset removed by the ratio, the two backends must
  // re-shade the morph the same way within the residual BRDF/IBL noise.
  const ratioGap = Math.abs(glRatio - gpuRatio) / Math.max(glRatio, 1);
  console.log(
    `  cross-backend ratio gap: ${(ratioGap * 100).toFixed(1)}% (Batch 337 BRDF gray gap divided out)`,
  );
  if (ratioGap > 0.2) {
    fail(
      `WebGPU normal-morph re-shading magnitude differs from WebGL by ${(ratioGap * 100).toFixed(1)}% (>20%) — normal morph response mismatched.`,
    );
  }

  if (pass) {
    console.log(
      `  OK: WebGPU normals morph — rest→morphed luma ratio ×${gpuRatio.toFixed(2)} (vs WebGL ×${glRatio.toFixed(2)}, frozen-normal ref ×${FROZEN_RATIO}); silhouette matches cross-backend.`,
    );
    console.log(
      `  NOTE: WebGPU renders the gray material correctly (R=G=B); WebGL adds an IBL-ambient tint + extra brightness. That cross-backend gray-vs-tint gap is the SEPARATE model-PBR direct-light/IBL parity item (Batch 337), not a morph-normal bug — it is present at the rest pose where nothing morphs.`,
    );
  }

  console.log(`[probe-morph-normals] ${pass ? "PASS" : "FAIL"}`);
  process.exit(pass ? 0 : 1);
})();
