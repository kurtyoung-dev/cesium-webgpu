#!/usr/bin/env node
/**
 * Batch 436 (3.6 CLOUD-CONE-LIGHT) — PARITY probe.
 *
 * Captures the WebGPU procedural clouds at the CINEMATIC tier
 * (cloudVolumetricQuality = "high" → tier 3), where the new cone-sampled light
 * march is OFF (lightConeSampling=false). At this tier the straight N-step light
 * march runs verbatim, so the render MUST be byte-identical to pre-436 main.
 *
 * This script captures ONE deterministic frame to a PNG. Run it against the
 * current tree, stash + rebuild main, run it again, then pixel-diff the two PNGs.
 * Zero drift is the gate.
 *
 * Usage:
 *   node Tools/visual-regression/probe-cloud-cone-parity.mjs <tag>
 *   (writes output/cloud-cone-parity-<tag>.png)
 */
import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dir, "output");
mkdirSync(OUT, { recursive: true });

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const TAG = process.argv[2] || "tree";

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});
const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
  waitUntil: "networkidle",
  timeout: 90_000,
});
await page.waitForFunction(() => !!window.viewer, { timeout: 90_000 });

if (process.env.CONE_ISOLATE === "1") {
  await page.evaluate(() => {
    window.__CONE_ISOLATE = true;
  });
}

const result = await page.evaluate(async () => {
  const C = await import("/Build/CesiumUnminified/index.js");
  const v = window.viewer,
    s = v.scene,
    g = s.globe;

  // ISOLATE=1 strips sky/atmosphere/globe so ONLY the procedural cloud pass
  // contributes — removes the atmosphere-LUT-bake capture jitter so the parity
  // diff measures the cloud LIGHTING path alone (near byte-exact run-to-run).
  const ISOLATE = window.__CONE_ISOLATE === true;
  s.skyBox.show = !ISOLATE;
  s.sun.show = !ISOLATE;
  s.skyAtmosphere.show = !ISOLATE;
  s.backgroundColor = C.Color.BLACK;
  g.show = !ISOLATE;

  v.clock.shouldAnimate = false;
  v.clock.currentTime = C.JulianDate.fromIso8601("2026-06-21T18:20:00Z");

  // CINEMATIC tier → cone OFF (straight march, parity baseline).
  g.defaultCloudCollection.enableVolumetric = true;
  g.defaultCloudCollection.volumetric.cloudVolumetricQuality = "high";
  g.defaultCloudCollection.volumetric.cloudQuality = 64; // not the escape hatch
  g.defaultCloudCollection.volumetric.cloudCoverage = 0.5;
  g.defaultCloudCollection.volumetric.cloudDensity = 0.85;
  g.defaultCloudCollection.volumetric.cloudLayerBottom = 1500;
  g.defaultCloudCollection.volumetric.cloudLayerTop = 4000;

  // Oblique-from-above so we see lit tops + shadowed sides (the lighting that the
  // cone approximates).
  v.camera.setView({
    destination: C.Cartesian3.fromDegrees(-95, 37.5, 9000),
    orientation: {
      heading: C.Math.toRadians(15),
      pitch: C.Math.toRadians(-22),
      roll: 0.0,
    },
  });

  for (let i = 0; i < 150; i++) {
    s.render();
    await new Promise((r) => requestAnimationFrame(r));
  }

  return new Promise((resolve) => {
    const remove = s.postRender.addEventListener(() => {
      remove();
      const c = s.canvas;
      const off = document.createElement("canvas");
      off.width = c.width;
      off.height = c.height;
      const cx = off.getContext("2d");
      cx.drawImage(c, 0, 0);
      const d = cx.getImageData(0, 0, c.width, c.height).data;
      let cloudish = 0,
        lumSum = 0;
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i],
          gg = d[i + 1],
          b = d[i + 2];
        const mx = Math.max(r, gg, b),
          mn = Math.min(r, gg, b);
        const sat = mx > 0 ? (mx - mn) / mx : 0;
        if (mx > 150 && sat < 0.25) {
          cloudish++;
          lumSum += mx;
        }
      }
      resolve({
        png: off.toDataURL("image/png"),
        renderer: s.context?.rendererType,
        cloudish,
        cloudMeanLum: cloudish ? Math.round(lumSum / cloudish) : 0,
        w: c.width,
        h: c.height,
      });
    });
    s.render();
  });
});

writeFileSync(
  join(OUT, `cloud-cone-parity-${TAG}.png`),
  Buffer.from(result.png.split(",")[1], "base64"),
);
await browser.close();

console.log(
  `[${TAG}] renderer=${result.renderer} cloudish=${result.cloudish} meanLum=${result.cloudMeanLum} ${result.w}x${result.h} errors=${errors.length}`,
);
errors.slice(0, 5).forEach((e) => console.log("  ERR:", e.slice(0, 160)));
console.log(`PNG: output/cloud-cone-parity-${TAG}.png`);
