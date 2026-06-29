#!/usr/bin/env node
/**
 * Cloud atmosphere-LUT PARITY probe (Batch 434 — 3.3 CLOUD-AERIAL-LUT +
 * 3.4 CLOUD-AMBIENT-LUT). Captures the DEFAULT/cinematic FULL-RES cloud tier
 * (cloudVolumetricQuality='high' → T3 renderResScale=1.0, temporal OFF) with the
 * two new flags at their DEFAULTS (cloudAerialMode='heuristic',
 * cloudAmbientSource='constant') deterministically, dumping the RAW CANVAS pixels
 * to a PNG via the browser's toDataURL.
 *
 * Run once on the modified build (PARITY_TAG=modified) and once on the
 * stash-reverted main build (PARITY_TAG=main); the two PNGs MUST be byte-identical
 * (zero drift) — coupling the clouds to the atmosphere LUTs must not touch the
 * default heuristic-aerial + constant-ambient path.
 *
 * Output: output/cloud-lut/parity-<TAG>.png  (TAG from PARITY_TAG env).
 *
 * Usage:
 *   PARITY_TAG=modified node Tools/visual-regression/probe-cloud-lut-parity.mjs
 */
import { chromium } from "playwright";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const TAG = process.env.PARITY_TAG || "tag";

const SCENE = {
  proc: { coverage: 0.45, density: 0.75, bottom: 1500, top: 3800 },
  camera: { lon: -95, lat: 39, height: 1200, heading: 0, pitch: 12 },
  timeIso: "2026-06-21T18:20:00Z",
};

(async () => {
  const fs = await import("fs");
  fs.mkdirSync("Tools/visual-regression/output/cloud-lut", {
    recursive: true,
  });
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
    timeout: 90_000,
  });
  await page.waitForFunction(() => !!window.viewer, { timeout: 90_000 });

  const dataUrl = await page.evaluate(async (scene) => {
    const v = window.viewer,
      s = v.scene,
      g = s.globe;
    const C = await import("/Build/CesiumUnminified/index.js");
    s.skyBox.show = true;
    s.sun.show = true;
    s.skyAtmosphere.show = true;
    s.globe.show = true;
    v.clock.shouldAnimate = false;
    v.clock.currentTime = C.JulianDate.fromIso8601(scene.timeIso);
    g.showProceduralClouds = true;
    g.cloudCoverage = scene.proc.coverage;
    g.cloudDensity = scene.proc.density;
    g.cloudLayerBottom = scene.proc.bottom;
    g.cloudLayerTop = scene.proc.top;
    g.cloudVolumetricQuality = "high"; // DEFAULT cinematic full-res (T3)
    // New flags left at their DEFAULTS — set them explicitly to be sure the
    // parity capture exercises the default ('heuristic' / 'constant') path even
    // on a build where the setters exist.
    if ("cloudAerialMode" in g) g.cloudAerialMode = "heuristic";
    if ("cloudAmbientSource" in g) g.cloudAmbientSource = "constant";
    v.camera.setView({
      destination: C.Cartesian3.fromDegrees(
        scene.camera.lon,
        scene.camera.lat,
        scene.camera.height,
      ),
      orientation: {
        heading: C.Math.toRadians(scene.camera.heading),
        pitch: C.Math.toRadians(scene.camera.pitch),
        roll: 0.0,
      },
    });
    // Deterministic settle: fixed clock + fixed frame count, no animation.
    for (let i = 0; i < 200; i++) {
      s.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
    return s.canvas.toDataURL("image/png");
  }, SCENE);

  await browser.close();
  const b64 = dataUrl.split(",")[1];
  const path = `Tools/visual-regression/output/cloud-lut/parity-${TAG}.png`;
  fs.writeFileSync(path, Buffer.from(b64, "base64"));
  const newErrs = errs.filter(
    (e) => !/AtmosphereLUT|default layout|favicon/.test(e),
  );
  console.log(`[parity:${TAG}] wrote ${path}`);
  console.log(
    newErrs.length ? `NEW errs: ${newErrs.slice(0, 4).join(" | ")}` : "no new console errors",
  );
})();
