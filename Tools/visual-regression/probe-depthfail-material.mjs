#!/usr/bin/env node
/**
 * Probe: NEW-WEBGPU-DEPTHFAIL-MATERIAL (Batch 419) — material-based
 * depthFailAppearance, WebGPU vs WebGL parity + cull-derivation correctness.
 *
 * This is the MATERIAL mirror of probe-depthfail-appearance.mjs (which covers
 * the Batch-390 COLOR-appearance slice). The target box uses a MATERIAL main
 * appearance (so it routes through createWebGPUMaterialCommands, where the
 * material depthFail twin lives) and a MATERIAL depthFailAppearance.
 *
 * Scene: a BLUE box (main MaterialAppearance, Color material blue) whose
 * depthFailAppearance is a MaterialAppearance with a RED Color material,
 * partially hidden behind a narrower GREY occluder box, globe off, nadir view.
 *
 * The probe runs TWO configurations to pin BOTH halves of the fix:
 *
 *   A. depthFail NON-closed (cull 'none' — the working color-slice setup):
 *      the occluded blue box is x-rayed RED with the depthFail MATERIAL (its
 *      far face shows through via depthCompare 'greater'). This DEMONSTRATES the
 *      material depthFail actually renders. WebGPU must match WebGL (red ~40k).
 *
 *   B. depthFail CLOSED (cull 'back'): WebGL's depthFail render state IS the
 *      depthFail appearance's own render state, so a closed depthFail appearance
 *      back-face culls and (for this box/occluder geometry) produces NO red —
 *      it stays all BLUE. This is REAL WebGL behavior (verified: WebGL red 0 /
 *      blue ~40k). Before the Batch-419 cull fix, WebGPU HARDCODED cull-none, so
 *      config B stayed full RED on WebGPU while WebGL went all-blue → the
 *      backends DIVERGED. After the fix WebGPU derives cull from the depthFail
 *      appearance, so config B now matches WebGL (red 0). This is the assertion
 *      that pins the cull-derivation fix — without it, config B's red parity
 *      fails.
 *
 * (There is no Cesium config that yields "red center + blue ring" for a single
 * box: depthFail is whole-primitive. Config A proves depthFail renders; config B
 * proves the cull is honored. Together they prove the twin matches WebGL.)
 *
 * PASS (WebGPU, per config):
 *   - A: RED present (>1%), WebGPU red within 0.7–1.4x WebGL, grey parity, no errs.
 *   - B: WebGPU red ~ WebGL red (both ~0 → |Δ| small), WebGPU blue within
 *        0.7–1.4x WebGL (all-blue), grey parity, no errs.
 *
 * Swap MAT_DF to a stripe material (see DF_MATERIAL_STRIPE below) to exercise a
 * non-Color depthFail fabric — the twin selects the matching Stripe shader.
 *
 * Usage: PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-depthfail-material.mjs
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

const BUILD_SCENE = async (dfClosed) => {
  const Cesium = await import("/Build/CesiumUnminified/index.js");
  const scene = window.viewer.scene;
  const prims = scene.primitives;
  prims.removeAll();
  scene.requestRenderMode = false;
  scene.globe.show = false;
  scene.skyBox.show = false;
  scene.skyAtmosphere.show = false;
  if (scene.sun) scene.sun.show = false;
  scene.backgroundColor = Cesium.Color.BLACK;
  const lon0 = -105.0,
    lat0 = 39.0;

  // BLUE target box — MAIN appearance is a MaterialAppearance (Color material
  // blue) so the primitive routes through createWebGPUMaterialCommands. Its
  // depthFailAppearance is a MaterialAppearance with a RED Color material.
  const blueMaterial = Cesium.Material.fromType("Color", {
    color: Cesium.Color.fromBytes(40, 60, 230, 255),
  });
  const redDepthFailMaterial = Cesium.Material.fromType("Color", {
    color: Cesium.Color.fromBytes(230, 40, 40, 255),
  });
  // DF_MATERIAL_STRIPE alternative (stripe fabric):
  //   const redDepthFailMaterial = Cesium.Material.fromType("Stripe", {
  //     evenColor: Cesium.Color.fromBytes(230, 40, 40, 255),
  //     oddColor: Cesium.Color.fromBytes(120, 20, 20, 255),
  //     repeat: 8,
  //   });

  const blueGeom = Cesium.BoxGeometry.fromDimensions({
    vertexFormat: Cesium.MaterialAppearance.MaterialSupport.BASIC.vertexFormat,
    dimensions: new Cesium.Cartesian3(90000.0, 90000.0, 4000.0),
  });
  prims.add(
    new Cesium.Primitive({
      geometryInstances: new Cesium.GeometryInstance({
        geometry: blueGeom,
        modelMatrix: Cesium.Transforms.eastNorthUpToFixedFrame(
          Cesium.Cartesian3.fromDegrees(lon0, lat0, 20000.0),
        ),
      }),
      appearance: new Cesium.MaterialAppearance({
        material: blueMaterial,
        materialSupport: Cesium.MaterialAppearance.MaterialSupport.BASIC,
        translucent: false,
        closed: true,
        flat: true,
      }),
      depthFailAppearance: new Cesium.MaterialAppearance({
        material: redDepthFailMaterial,
        materialSupport: Cesium.MaterialAppearance.MaterialSupport.BASIC,
        translucent: false,
        closed: dfClosed,
        flat: true,
      }),
      asynchronous: false,
    }),
  );

  // GREY occluder box in front (higher altitude = nearer from nadir), narrower
  // so the blue box's edges stick out.
  const greyGeom = Cesium.BoxGeometry.fromDimensions({
    vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
    dimensions: new Cesium.Cartesian3(44000.0, 44000.0, 4000.0),
  });
  prims.add(
    new Cesium.Primitive({
      geometryInstances: new Cesium.GeometryInstance({
        geometry: greyGeom,
        modelMatrix: Cesium.Transforms.eastNorthUpToFixedFrame(
          Cesium.Cartesian3.fromDegrees(lon0, lat0, 55000.0),
        ),
        attributes: {
          color: Cesium.ColorGeometryInstanceAttribute.fromColor(
            Cesium.Color.fromBytes(140, 140, 145, 255),
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

  scene.camera.lookAt(
    Cesium.Cartesian3.fromDegrees(lon0, lat0, 35000.0),
    new Cesium.HeadingPitchRange(0.0, Cesium.Math.toRadians(-90.0), 320000.0),
  );
  scene.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
  for (let i = 0; i < 8; i++) scene.render();
  return { primCount: prims.length };
};

const CAPTURE = async () => {
  const scene = window.viewer.scene;
  for (let i = 0; i < 10; i++) {
    scene.render();
    await new Promise((r) => requestAnimationFrame(r));
  }
  return scene.canvas.toDataURL("image/png");
};

function decode(page, dataUrl) {
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
    let red = 0,
      blue = 0,
      grey = 0;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i],
        g = d[i + 1],
        b = d[i + 2];
      if (r > 120 && g < 90 && b < 90) red++;
      else if (b > 120 && r < 100 && g < 110) blue++;
      else if (r > 90 && r < 200 && Math.abs(r - g) < 30 && Math.abs(g - b) < 30)
        grey++;
    }
    const total = c.width * c.height;
    return { red, blue, grey, total };
  }, dataUrl);
}

async function captureConfig(renderer, dfClosed, tag) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  attachConsoleErrorGate(page);
  await page.addInitScript(errorGateInit);
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForFunction(() => !!window.viewer, null, { timeout: 60000 });
  if (renderer === "webgpu") await armWebGPUDevices(page);
  const built = await page.evaluate(BUILD_SCENE, dfClosed);
  const dataUrl = await page.evaluate(CAPTURE);
  const counts = await decode(page, dataUrl);
  const fs = await import("fs");
  fs.mkdirSync("Tools/visual-regression/output", { recursive: true });
  fs.writeFileSync(
    `Tools/visual-regression/output/depthfail-material-${tag}-${renderer}.png`,
    Buffer.from(dataUrl.split(",")[1], "base64"),
  );
  const gate = await collectGateErrors(page);
  await browser.close();
  const newErrs = (gate.errors || []).filter(
    (e) => !/Atmosphere ?LUT|SkyAtmosphere|default layout/i.test(e),
  );
  return { built, counts, newErrs };
}

function ratioOk(a, b) {
  return b > 0 ? a / b >= 0.7 && a / b <= 1.4 : a === 0;
}

async function run() {
  let pass = true;
  const log = (s) => console.log(s);

  // ── Config A: depthFail NON-closed (cull none) — depthFail MATERIAL x-rays
  //    the occluded box RED. Proves the material depthFail twin renders. ──
  const aGpu = await captureConfig("webgpu", false, "open");
  const aGl = await captureConfig("webgl", false, "open");
  log(`\n[A] depthFail NON-closed (cull none) — depthFail material renders`);
  log(`    WebGPU ${JSON.stringify(aGpu.counts)} errs:${aGpu.newErrs.length}`);
  log(`    WebGL  ${JSON.stringify(aGl.counts)} errs:${aGl.newErrs.length}`);
  const aRedPct = (100 * aGpu.counts.red) / aGpu.counts.total;
  const aRedRatio =
    aGl.counts.red > 0 ? aGpu.counts.red / aGl.counts.red : 0;
  const aGreyRatio =
    aGl.counts.grey > 0 ? aGpu.counts.grey / aGl.counts.grey : 0;
  const aChecks = [
    [`A: RED present (material depth-fail renders): ${aRedPct.toFixed(2)}% > 1%`, aRedPct > 1],
    [`A: red parity vs WebGL (ratio ${aRedRatio.toFixed(2)} in 0.7–1.4)`, ratioOk(aGpu.counts.red, aGl.counts.red)],
    [`A: grey occluder parity (ratio ${aGreyRatio.toFixed(2)} in 0.7–1.4)`, ratioOk(aGpu.counts.grey, aGl.counts.grey)],
    [`A: WebGL also shows RED (reference valid)`, aGl.counts.red > 0],
    [`A: no NEW WebGPU device errors`, aGpu.newErrs.length === 0],
  ];

  // ── Config B: depthFail CLOSED (cull back) — WebGL's depthFail honors the
  //    depthFail appearance cull → no red, all blue. The twin must MATCH (this
  //    is the cull-derivation assertion: pre-fix WebGPU stayed full red here). ──
  const bGpu = await captureConfig("webgpu", true, "closed");
  const bGl = await captureConfig("webgl", true, "closed");
  log(`\n[B] depthFail CLOSED (cull back) — cull honored, matches WebGL`);
  log(`    WebGPU ${JSON.stringify(bGpu.counts)} errs:${bGpu.newErrs.length}`);
  log(`    WebGL  ${JSON.stringify(bGl.counts)} errs:${bGl.newErrs.length}`);
  const bBlueRatio =
    bGl.counts.blue > 0 ? bGpu.counts.blue / bGl.counts.blue : 0;
  const bGreyRatio =
    bGl.counts.grey > 0 ? bGpu.counts.grey / bGl.counts.grey : 0;
  // Red parity tolerant of a handful of AA pixels: both should be ~0; assert the
  // WebGPU red is no more than 1% of canvas (NOT the pre-fix full-box red) and
  // close to WebGL's red.
  const bRedPctGpu = (100 * bGpu.counts.red) / bGpu.counts.total;
  const bChecks = [
    [`B: WebGPU red collapses to ~0 (cull honored): ${bRedPctGpu.toFixed(3)}% < 1%`, bRedPctGpu < 1],
    [`B: WebGL red ~0 (reference: closed depthFail → no red): ${bGl.counts.red}`, bGl.counts.red < bGl.counts.total * 0.01],
    [`B: |WebGPU red − WebGL red| small (${Math.abs(bGpu.counts.red - bGl.counts.red)} < 0.5% canvas)`, Math.abs(bGpu.counts.red - bGl.counts.red) < bGpu.counts.total * 0.005],
    [`B: blue (all-blue) parity vs WebGL (ratio ${bBlueRatio.toFixed(2)} in 0.7–1.4)`, ratioOk(bGpu.counts.blue, bGl.counts.blue)],
    [`B: grey occluder parity (ratio ${bGreyRatio.toFixed(2)} in 0.7–1.4)`, ratioOk(bGpu.counts.grey, bGl.counts.grey)],
    [`B: no NEW WebGPU device errors`, bGpu.newErrs.length === 0],
  ];

  console.log("\n=== ANALYSIS ===");
  for (const [name, ok] of [...aChecks, ...bChecks]) {
    console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}`);
    if (!ok) pass = false;
  }
  if (aGpu.newErrs.length) console.log("A NEW errs:", aGpu.newErrs.slice(0, 2));
  if (bGpu.newErrs.length) console.log("B NEW errs:", bGpu.newErrs.slice(0, 2));
  console.log(`\nRESULT: ${pass ? "GREEN" : "RED"}`);
  process.exitCode = pass ? 0 : 1;
}
run();
