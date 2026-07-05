#!/usr/bin/env node
/**
 * Cloud half-res PARITY probe (Batch 432). Captures the DEFAULT/cinematic FULL-RES
 * cloud tier (cloudVolumetricQuality='high' → T3 renderResScale=1.0) deterministi-
 * cally, dumping the RAW CANVAS pixels (not a page screenshot — no UI chrome) to a
 * PNG via the browser's toDataURL. Run once on the modified build and once on the
 * stash-reverted main build; the two PNGs must be byte-identical (zero drift) — the
 * half-res change must not touch the full-res default path.
 *
 * Output: output/cloud-halfres/parity-<TAG>.png  (TAG from PARITY_TAG env).
 *
 * Usage:
 *   PARITY_TAG=modified node Tools/visual-regression/probe-cloud-halfres-parity.mjs
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
  fs.mkdirSync("Tools/visual-regression/output/cloud-halfres", {
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
    g.defaultCloudCollection.enableVolumetric = true;
    g.defaultCloudCollection.volumetric.cloudCoverage = scene.proc.coverage;
    g.defaultCloudCollection.volumetric.cloudDensity = scene.proc.density;
    g.defaultCloudCollection.volumetric.cloudLayerBottom = scene.proc.bottom;
    g.defaultCloudCollection.volumetric.cloudLayerTop = scene.proc.top;
    g.defaultCloudCollection.volumetric.cloudVolumetricQuality = "high"; // DEFAULT cinematic full-res (T3)
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
  const path = `Tools/visual-regression/output/cloud-halfres/parity-${TAG}.png`;
  fs.writeFileSync(path, Buffer.from(b64, "base64"));
  const newErrs = errs.filter(
    (e) => !/AtmosphereLUT|default layout|favicon/.test(e),
  );
  console.log(`[parity:${TAG}] wrote ${path}`);
  console.log(
    newErrs.length ? `NEW errs: ${newErrs.slice(0, 4).join(" | ")}` : "no new console errors",
  );
})();
