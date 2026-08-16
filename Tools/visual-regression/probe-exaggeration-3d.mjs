#!/usr/bin/env node
// Probe (MORPH-EXAG-SKIRTS didn't-break guard): SCENE3D vertical exaggeration on
// WebGPU must still match WebGL after the Batch-362 unification that switched the
// 3D position offset from `length(position3D)-radius` to the WebGL attribute-based
// `(newHeight - resolvedHeight)`. Captures an oblique 3D Himalaya view at EXAG=10
// on both backends. READ the PNGs: WebGPU 3D relief should match WebGL.
// @purpose SCENE3D vertical-exaggeration didn't-break guard after the B362 switch to the WebGL attribute-based height offset; oblique Himalaya EXAG=10.
// @status ACTIVE
//
// Usage: PROBE_BASE=http://localhost:8080 EXAG=10 node Tools/visual-regression/probe-exaggeration-3d.mjs
import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";
const EXAG = Number(process.env.EXAG ?? 10);

async function capture(rendererArg) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 720 },
  });
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push("PAGEERR: " + e.message));
  await page.goto(
    `${BASE}/Apps/CesiumViewer/index.html?renderer=${rendererArg}`,
    { waitUntil: "networkidle" },
  );
  await page.waitForFunction(() => !!window.viewer);
  const out = await page.evaluate(async (exagValue) => {
    const v = window.viewer,
      c = v.camera;
    v.scene.verticalExaggeration = exagValue;
    const ell = v.scene.ellipsoid ?? v.scene.globe.ellipsoid;
    const dest = ell.cartographicToCartesian({
      longitude: (86.9 * Math.PI) / 180,
      latitude: (27.0 * Math.PI) / 180,
      height: 250000,
    });
    c.setView({
      destination: dest,
      orientation: { heading: 0.0, pitch: -0.45, roll: 0.0 },
    });
    // SCENE3D — no morph.
    for (let i = 0; i < 300; i++) {
      v.scene.initializeFrame();
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
    c.setView({
      destination: dest,
      orientation: { heading: 0.0, pitch: -0.45, roll: 0.0 },
    });
    for (let i = 0; i < 120; i++) {
      v.scene.initializeFrame();
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
    const cv = v.scene.canvas;
    return {
      mode: v.scene.mode,
      exaggeration: v.scene.verticalExaggeration,
      dataUrl: cv.toDataURL("image/png"),
    };
  }, EXAG);
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `exag${EXAG}-3d-${rendererArg}.png`);
  fs.writeFileSync(file, Buffer.from(out.dataUrl.split(",")[1], "base64"));
  await browser.close();
  console.log(
    `${rendererArg}: mode=${out.mode} exag=${out.exaggeration} errors=${errors.length} saved ${file}`,
  );
  return out;
}
await capture("webgl");
await capture("webgpu");
console.log(
  "[probe-exaggeration-3d] done — READ the PNGs: WebGPU 3D relief should match WebGL.",
);
