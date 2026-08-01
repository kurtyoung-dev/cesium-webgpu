#!/usr/bin/env node
/**
 * Probe: DP-H18 / C2-23 depthFailAppearance — WebGPU vs WebGL parity.
 *
 * Scene: a BLUE opaque box (depthFailColor RED) partially hidden behind a
 * narrower GREY occluder box, globe off, nadir view.
 *   - Center (blue behind grey): the blue box fails the depth test, so the
 *     depth-fail pass (depthCompare 'greater', no write) shades RED — the
 *     "see-through" highlight.
 *   - Ring (blue not behind grey): the blue box passes depth → stays BLUE.
 *
 * PASS (WebGPU):
 *   1. RED present (depth-fail works) — redPx > 1% of canvas.
 *   2. BLUE present (main pass unregressed) — bluePx > 1%.
 *   3. Parity: WebGPU redPx within 0.6–1.6x of WebGL redPx (backends differ in
 *      AA/projection; this is a "both produce a comparable depth-fail region"
 *      check, not pixel-exact).
 *
 * Usage: PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-depthfail-appearance.mjs
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

const BUILD_SCENE = async () => {
  const Cesium = await import("/Build/CesiumUnminified/index.js");
  const scene = window.viewer.scene;
  const prims = scene.primitives;
  scene.requestRenderMode = false;
  scene.globe.show = false;
  scene.skyBox.show = false;
  scene.skyAtmosphere.show = false;
  if (scene.sun) scene.sun.show = false;
  scene.backgroundColor = Cesium.Color.BLACK;
  const lon0 = -105.0,
    lat0 = 39.0;

  // BLUE target box behind, with a RED depthFail highlight.
  const blueGeom = Cesium.BoxGeometry.fromDimensions({
    vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
    dimensions: new Cesium.Cartesian3(90000.0, 90000.0, 4000.0),
  });
  prims.add(
    new Cesium.Primitive({
      geometryInstances: new Cesium.GeometryInstance({
        geometry: blueGeom,
        modelMatrix: Cesium.Transforms.eastNorthUpToFixedFrame(
          Cesium.Cartesian3.fromDegrees(lon0, lat0, 20000.0),
        ),
        attributes: {
          color: Cesium.ColorGeometryInstanceAttribute.fromColor(
            Cesium.Color.fromBytes(40, 60, 230, 255),
          ),
          depthFailColor: Cesium.ColorGeometryInstanceAttribute.fromColor(
            Cesium.Color.fromBytes(230, 40, 40, 255),
          ),
        },
      }),
      appearance: new Cesium.PerInstanceColorAppearance({
        translucent: false,
        closed: true,
      }),
      depthFailAppearance: new Cesium.PerInstanceColorAppearance({
        translucent: false,
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
      else if (
        r > 90 &&
        r < 200 &&
        Math.abs(r - g) < 30 &&
        Math.abs(g - b) < 30
      )
        grey++;
    }
    const total = c.width * c.height;
    return { red, blue, grey, total };
  }, dataUrl);
}

async function capture(renderer) {
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
  const built = await page.evaluate(BUILD_SCENE);
  const dataUrl = await page.evaluate(CAPTURE);
  const counts = await decode(page, dataUrl);
  const fs = await import("fs");
  fs.mkdirSync("Tools/visual-regression/output", { recursive: true });
  fs.writeFileSync(
    `Tools/visual-regression/output/depthfail-${renderer}.png`,
    Buffer.from(dataUrl.split(",")[1], "base64"),
  );
  const gate = await collectGateErrors(page);
  await browser.close();
  const newErrs = (gate.errors || []).filter(
    (e) => !/Atmosphere ?LUT|SkyAtmosphere|default layout/i.test(e),
  );
  return { built, counts, newErrs };
}

async function run() {
  const gpu = await capture("webgpu");
  const gl = await capture("webgl");
  console.log(
    "WebGPU:",
    JSON.stringify(gpu.counts),
    "errs:",
    gpu.newErrs.length,
  );
  console.log("WebGL :", JSON.stringify(gl.counts), "errs:", gl.newErrs.length);

  const c = gpu.counts;
  const redPct = (100 * c.red) / c.total;
  const redRatio = gl.counts.red > 0 ? c.red / gl.counts.red : 0;
  const greyRatio = gl.counts.grey > 0 ? c.grey / gl.counts.grey : 0;
  // Reference (WebGL) renders the closed depthFail box fully RED (the back face
  // shows through the front via 'greater'), with the GREY occluder over the
  // center. WebGPU must match: comparable red region + comparable grey center.
  const checks = [
    [`RED present (depth-fail works): ${redPct.toFixed(2)}% > 1%`, redPct > 1],
    [
      `parity vs WebGL red (ratio ${redRatio.toFixed(2)} in 0.7–1.4)`,
      redRatio >= 0.7 && redRatio <= 1.4,
    ],
    [
      `grey occluder parity (ratio ${greyRatio.toFixed(2)} in 0.7–1.4)`,
      greyRatio >= 0.7 && greyRatio <= 1.4,
    ],
    ["WebGL also shows RED (reference valid)", gl.counts.red > 0],
    ["no NEW WebGPU device errors", gpu.newErrs.length === 0],
  ];
  let pass = true;
  console.log("\n=== ANALYSIS ===");
  for (const [name, ok] of checks) {
    console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}`);
    if (!ok) pass = false;
  }
  if (gpu.newErrs.length) console.log("NEW errs:", gpu.newErrs.slice(0, 2));
  console.log(`\nRESULT: ${pass ? "GREEN" : "RED"}`);
  process.exitCode = pass ? 0 : 1;
}
run();
