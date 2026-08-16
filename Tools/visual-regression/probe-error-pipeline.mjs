#!/usr/bin/env node
/**
 * Probe: C2-22 flat-magenta error pipeline for a failed model PBR pipeline.
 * @purpose Flat-magenta fallback for a failed model PBR pipeline: forced-failure hook renders magenta instead of a silent hole; hook off renders normally.
 * @status ACTIVE
 *
 * When a model's PBR pipeline fails validation, WebGPU's synchronous
 * createRenderPipeline returns an INVALID pipeline whose draws are silently
 * dropped → a render-hole. C2-22 wraps creation in a validation error scope and
 * substitutes a flat-magenta pipeline so the model shows magenta instead of
 * nothing. The debug-only test hook globalThis.CesiumWebGPUForcePipelineError
 * forces a real failure (an invalid shader module).
 *
 * Tests (WebGPU, globe/sky off, a CesiumMilkTruck framed center-screen):
 *   - FORCE ON  → the model renders MAGENTA (fallback engaged), not a hole.
 *   - FORCE OFF → the model renders normally (no magenta), proving no regression.
 *
 * Usage: PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-error-pipeline.mjs
 */
import { chromium } from "playwright";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";

async function run(forceError, fs) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({
    viewport: { width: 1024, height: 768 },
  });
  const errs = [];
  page.on("console", (m) => {
    if (m.type() === "error") errs.push(m.text());
  });
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
    waitUntil: "networkidle",
    timeout: 90000,
  });
  await page.waitForFunction(() => !!window.viewer, { timeout: 90000 });

  const res = await page.evaluate(async (forceError) => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer,
      s = v.scene;
    s.globe.show = false;
    s.skyBox.show = false;
    if (s.sun) s.sun.show = false;
    if (s.moon) s.moon.show = false;
    s.skyAtmosphere.show = false;
    s.backgroundColor = C.Color.BLACK;

    // Set the force-error flag BEFORE the model's pipeline is built.
    if (forceError) globalThis.CesiumWebGPUForcePipelineError = true;
    else delete globalThis.CesiumWebGPUForcePipelineError;

    const pos = C.Cartesian3.fromDegrees(-95.0, 39.0, 0.0);
    const entity = v.entities.add({
      position: pos,
      model: {
        uri: "/Apps/SampleData/models/CesiumMilkTruck/CesiumMilkTruck.glb",
        scale: 1.0,
      },
    });
    // Frame the truck (it's a few meters; look from ~12 m).
    v.camera.lookAt(
      pos,
      new C.HeadingPitchRange(0.6, C.Math.toRadians(-15.0), 12.0),
    );
    v.camera.lookAtTransform(C.Matrix4.IDENTITY);

    // Render generously so the model loads + the async popErrorScope swap lands.
    let ready = false;
    for (let i = 0; i < 220; i++) {
      s.render();
      const _prim = v.scene.primitives;
      // entity model readiness — best-effort via the entity's model primitive
      try {
        if (entity.model && v.dataSourceDisplay) ready = true;
      } catch (e) {
        // ignore
      }
      await new Promise((r) => requestAnimationFrame(r));
    }

    const canvas = s.canvas,
      w = canvas.width,
      h = canvas.height;
    const tmp = document.createElement("canvas");
    tmp.width = w;
    tmp.height = h;
    const cx = tmp.getContext("2d");
    cx.drawImage(canvas, 0, 0);
    const px = cx.getImageData(0, 0, w, h).data;
    let magenta = 0,
      nonBlack = 0,
      truckColor = 0;
    for (let i = 0; i < px.length; i += 4) {
      const r = px[i],
        g = px[i + 1],
        b = px[i + 2];
      if (r > 10 || g > 10 || b > 10) nonBlack++;
      if (r > 200 && g < 70 && b > 200) magenta++;
      // truck-ish = colored but NOT magenta (the truck is red/white/blue-ish).
      if ((r > 60 || g > 60 || b > 60) && !(r > 200 && g < 70 && b > 200))
        truckColor++;
    }
    return { ready, magenta, nonBlack, truckColor, width: w, height: h };
  }, forceError);

  const buf = await page.screenshot({ omitBackground: false });
  fs.writeFileSync(
    `Tools/visual-regression/output/error-pipeline-${forceError ? "forced" : "normal"}.png`,
    buf,
  );
  await browser.close();
  return {
    res,
    errs: errs.filter((e) => !/AtmosphereLUT|default layout/.test(e)),
  };
}

const fs = await import("fs");
fs.mkdirSync("Tools/visual-regression/output", { recursive: true });

const normal = await run(false, fs);
const forced = await run(true, fs);

console.log("NORMAL (no force):", JSON.stringify(normal.res));
console.log("FORCED (error)   :", JSON.stringify(forced.res));

const checks = [
  ["NORMAL: model renders (nonBlack > 500)", normal.res.nonBlack > 500],
  ["NORMAL: NOT magenta (magenta < 100)", normal.res.magenta < 100],
  [
    "FORCED: magenta fallback engaged (magenta > 500)",
    forced.res.magenta > 500,
  ],
  [
    "FORCED: magenta dominates the model (magenta > truckColor)",
    forced.res.magenta > forced.res.truckColor,
  ],
];
let pass = true;
console.log("\n=== ANALYSIS ===");
for (const [label, ok] of checks) {
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}`);
  if (!ok) pass = false;
}
console.log(`\nRESULT: ${pass ? "GREEN" : "RED"}`);
process.exitCode = pass ? 0 : 1;
