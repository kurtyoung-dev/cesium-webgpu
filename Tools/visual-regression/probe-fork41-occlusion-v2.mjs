#!/usr/bin/env node
/**
 * Probe: FORK-41 / C2-21 Hi-Z occlusion CULL CORRECTNESS — occludable scene.
 *
 * The original probe-fork41-occlusion.mjs scene uses 90 km-TALL boxes whose
 * bounding spheres (~45 km radius) project to huge screen rects that overhang
 * the sky — so the C2-21 footprint+background rule (correctly) never culls them
 * and hitRatio stays 0. That scene can prove "no false-cull" but cannot prove
 * the cull WORKS.
 *
 * This scene IS occludable: a big near "lid" (a wide flat box) with 2500 small
 * cubes fully hidden BELOW/behind it (no sky overhang, no peeking around). The
 * lid covers every small box's screen footprint, so the boxes are genuinely
 * fully occluded.
 *
 * Checks (WebGPU, dense path latched at >=2400 commands):
 *   1. Path runs (dispatches > 0) + gate active.
 *   2. CULL WORKS: with consume ON the occlusion flags the hidden boxes
 *      (hitRatio > 0) — the C2-21 footprint fix made the cull effective.
 *   3. PIXEL-SAFE: consume-ON image matches the no-cull baseline (the culled
 *      boxes were hidden by the lid anyway, so dropping them changes nothing).
 *   4. No NEW device errors (AtmosphereLUT filtered).
 *
 * Usage: PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-fork41-occlusion-v2.mjs
 */
import { chromium } from "playwright";
import {
  errorGateInit,
  armWebGPUDevices,
  collectGateErrors,
  attachConsoleErrorGate,
} from "../lib/webgpu-error-gate.mjs";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const W = 1024,
  H = 768;
const MISMATCH_BUDGET_PCT = 1.5;

const BUILD_SCENE = async () => {
  const Cesium = await import("/Build/CesiumUnminified/index.js");
  const v = window.viewer;
  const scene = v.scene;
  const prims = scene.primitives;
  scene.requestRenderMode = false;
  scene.globe.show = false;
  scene.skyBox.show = false;
  scene.skyAtmosphere.show = false;
  if (scene.sun) scene.sun.show = false;
  scene.backgroundColor = Cesium.Color.BLACK;

  const lon0 = -105.0,
    lat0 = 39.0;

  // Big near "lid" — wide flat box at 60 km, grey, opaque. Covers the small-box
  // region below it.
  const lidGeom = Cesium.BoxGeometry.fromDimensions({
    vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
    dimensions: new Cesium.Cartesian3(140000.0, 140000.0, 2000.0),
  });
  const lidPos = Cesium.Cartesian3.fromDegrees(lon0, lat0, 60000.0);
  prims.add(
    new Cesium.Primitive({
      geometryInstances: new Cesium.GeometryInstance({
        geometry: lidGeom,
        modelMatrix: Cesium.Transforms.eastNorthUpToFixedFrame(lidPos),
        attributes: {
          color: Cesium.ColorGeometryInstanceAttribute.fromColor(
            Cesium.Color.fromBytes(150, 150, 160, 255),
          ),
        },
      }),
      appearance: new Cesium.PerInstanceColorAppearance({
        translucent: false,
        closed: true,
      }),
      asynchronous: false,
    }),
  );

  // 2500 small cubes at 30 km (28 km below the lid), packed in a ~50 km region
  // well inside the lid footprint → fully occluded from a nadir view.
  const grid = 50;
  const cubeGeom = Cesium.BoxGeometry.fromDimensions({
    vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
    dimensions: new Cesium.Cartesian3(2000.0, 2000.0, 2000.0),
  });
  let created = 0;
  for (let i = 0; i < grid; i++) {
    for (let j = 0; j < grid; j++) {
      const dLon = (i / grid - 0.5) * 0.55;
      const dLat = (j / grid - 0.5) * 0.55;
      const pos = Cesium.Cartesian3.fromDegrees(
        lon0 + dLon,
        lat0 + dLat,
        30000.0,
      );
      prims.add(
        new Cesium.Primitive({
          geometryInstances: new Cesium.GeometryInstance({
            geometry: cubeGeom,
            modelMatrix: Cesium.Transforms.eastNorthUpToFixedFrame(pos),
            attributes: {
              color: Cesium.ColorGeometryInstanceAttribute.fromColor(
                Cesium.Color.fromHsl((created % 360) / 360, 0.9, 0.55, 1.0),
              ),
            },
          }),
          appearance: new Cesium.PerInstanceColorAppearance({
            translucent: false,
            closed: true,
          }),
          asynchronous: false,
        }),
      );
      created++;
    }
  }

  const center = Cesium.Cartesian3.fromDegrees(lon0, lat0, 45000.0);
  scene.camera.lookAt(
    center,
    new Cesium.HeadingPitchRange(0.0, Cesium.Math.toRadians(-90.0), 260000.0),
  );
  scene.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
  return { created: created + 1, primCount: prims.length };
};

const RENDER_AND_CAPTURE = async (cfg) => {
  const _Cesium = await import("/Build/CesiumUnminified/index.js");
  const v = window.viewer;
  const scene = v.scene;
  scene.gpuCullingHint = cfg.hint;
  // Toggle the consume flag via the debug hook.
  if (
    window.CesiumDebug &&
    typeof window.CesiumDebug.hiZConsume === "function"
  ) {
    window.CesiumDebug.hiZConsume(cfg.consume === true);
  }
  for (let i = 0; i < cfg.frames; i++) {
    scene.render();
    await new Promise((r) => requestAnimationFrame(r));
  }
  scene.render();
  await new Promise((r) => requestAnimationFrame(r));
  scene.render();

  let stats = null;
  try {
    const renderer = scene._alternateSceneRenderer;
    if (renderer && typeof renderer.getHighDensityCullStats === "function") {
      const s = renderer.getHighDensityCullStats();
      stats = {
        hiZActive: s.hiZ.activeAnyFrustum,
        hiZDispatches: s.hiZ.dispatches,
        hiZInput: s.hiZ.lastFrameInput,
        hiZFiltered: s.hiZ.lastFrameFiltered,
        hiZHitRatio: s.hiZ.hitRatio,
      };
    }
  } catch (e) {
    stats = { error: String(e) };
  }
  return { dataUrl: scene.canvas.toDataURL("image/png"), stats };
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

async function run() {
  const fs = await import("fs");
  fs.mkdirSync("Tools/visual-regression/output", { recursive: true });
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  attachConsoleErrorGate(page);
  await page.addInitScript(errorGateInit);
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForFunction(() => !!window.viewer, null, { timeout: 60000 });
  await armWebGPUDevices(page);

  const buildInfo = await page.evaluate(BUILD_SCENE);
  // Baseline: no GPU culling at all.
  const off = await page.evaluate(RENDER_AND_CAPTURE, {
    hint: "never",
    consume: false,
    frames: 120,
  });
  // Consume ON: occlusion path drops fully-hidden boxes.
  const on = await page.evaluate(RENDER_AND_CAPTURE, {
    hint: "auto",
    consume: true,
    frames: 200,
  });

  const offRgba = await decodePngToRgba(page, off.dataUrl);
  const onRgba = await decodePngToRgba(page, on.dataUrl);
  let mismatch = 0;
  const total = offRgba.w * offRgba.h;
  for (let i = 0; i < offRgba.data.length; i += 4) {
    const dr = Math.abs(offRgba.data[i] - onRgba.data[i]);
    const dg = Math.abs(offRgba.data[i + 1] - onRgba.data[i + 1]);
    const db = Math.abs(offRgba.data[i + 2] - onRgba.data[i + 2]);
    if (dr + dg + db > 24) mismatch++;
  }
  const mismatchPct = (100 * mismatch) / total;

  fs.writeFileSync(
    "Tools/visual-regression/output/fork41v2-nocull.png",
    Buffer.from(off.dataUrl.split(",")[1], "base64"),
  );
  fs.writeFileSync(
    "Tools/visual-regression/output/fork41v2-consume.png",
    Buffer.from(on.dataUrl.split(",")[1], "base64"),
  );

  const gate = await collectGateErrors(page);
  await browser.close();
  // Known pre-existing device error unrelated to Hi-Z:
  // NEW-WEBGPU-ATMOSPHERE-LUT-BGL-INCOMPAT — the "SkyAtmosphere LUT dispatch"
  // command buffer is invalid due to a BGL mismatch at init. Filter it.
  const newErrs = (gate.errors || []).filter(
    (e) => !/Atmosphere ?LUT|SkyAtmosphere|default layout/i.test(e),
  );

  console.log("built:", JSON.stringify(buildInfo));
  console.log("OFF (no cull):", JSON.stringify(off.stats));
  console.log("ON  (consume):", JSON.stringify(on.stats));
  console.log(
    `pixel mismatch consume-vs-nocull: ${mismatch}/${total} (${mismatchPct.toFixed(3)}%) budget=${MISMATCH_BUDGET_PCT}%`,
  );
  if (newErrs.length) console.log("NEW errs:", newErrs.slice(0, 3));

  const s = on.stats || {};
  const checks = [
    ["occlusion path runs (dispatches > 0)", (s.hiZDispatches || 0) > 0],
    ["occlusion active (gate latched)", s.hiZActive === true],
    [
      `CULL WORKS (hitRatio ${(s.hiZHitRatio || 0).toFixed(3)} > 0.5)`,
      (s.hiZHitRatio || 0) > 0.5,
    ],
    [
      `PIXEL-SAFE: consume matches no-cull (${mismatchPct.toFixed(3)}% <= ${MISMATCH_BUDGET_PCT}%)`,
      mismatchPct <= MISMATCH_BUDGET_PCT,
    ],
    ["no NEW device errors", newErrs.length === 0],
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

run();
