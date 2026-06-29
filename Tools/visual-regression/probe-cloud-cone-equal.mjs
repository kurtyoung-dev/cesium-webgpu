#!/usr/bin/env node
/**
 * Batch 436 (3.6 CLOUD-CONE-LIGHT) — EQUAL-QUALITY probe.
 *
 * Renders the SAME cinematic full-res baked-noise cloud scene twice, flipping ONLY
 * the cone-light bit via the TEMP `window.__FORCE_CONE` renderer override:
 *   __FORCE_CONE=0 → straight N-step light march (reference)
 *   __FORCE_CONE=1 → Schneider 6-tap cone light march (approximation)
 * Everything else (resolution, noise, temporal-off, camera, sun, clock) is IDENTICAL,
 * so the diff isolates the LIGHT-MARCH SAMPLING PATTERN — the self-shadowing /
 * beer-powder / silhouette darkening. The cone is an approximation; the structure
 * must match closely (no flat / over-dark / over-bright clouds, no sparse-tap banding).
 *
 * Writes output/cloud-cone-equal-straight.png and -cone.png. Diff + eyeball them.
 *
 * Usage: node Tools/visual-regression/probe-cloud-cone-equal.mjs
 */
import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dir, "output");
mkdirSync(OUT, { recursive: true });

const BASE = process.env.PROBE_BASE || "http://localhost:8080";

async function capture(page, forceCone) {
  return page.evaluate(async (forceCone) => {
    window.__FORCE_CONE = forceCone;
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer,
      s = v.scene,
      g = s.globe;

    // Isolate the cloud pass: black bg, no sky/globe, so cloud self-shadow reads clean.
    s.skyBox.show = false;
    s.sun.show = false;
    s.skyAtmosphere.show = false;
    s.backgroundColor = C.Color.BLACK;
    g.show = false;

    v.clock.shouldAnimate = false;
    v.clock.currentTime = C.JulianDate.fromIso8601("2026-06-21T18:20:00Z");

    g.showProceduralClouds = true;
    g.cloudVolumetricQuality = "high"; // cinematic: full-res, baked, temporal off
    g.cloudQuality = 64;
    g.cloudCoverage = 0.4; // scattered cumulus — distinct lit/shadowed puffs
    g.cloudDensity = 0.7;
    g.cloudLayerBottom = 1500;
    g.cloudLayerTop = 3500;

    // Look UP at scattered cumulus from just below the deck: distinct puffs with
    // sun-lit tops + shadowed undersides — the self-shadowing the cone approximates.
    v.camera.setView({
      destination: C.Cartesian3.fromDegrees(-95, 39, 800),
      orientation: {
        heading: C.Math.toRadians(0),
        pitch: C.Math.toRadians(12),
        roll: 0.0,
      },
    });

    for (let i = 0; i < 160; i++) {
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
          lumSum = 0,
          litSum = 0,
          shadowSum = 0,
          litN = 0,
          shadowN = 0;
        for (let i = 0; i < d.length; i += 4) {
          const r = d[i],
            gg = d[i + 1],
            b = d[i + 2];
          const mx = Math.max(r, gg, b);
          if (mx > 20) {
            cloudish++;
            lumSum += mx;
            if (mx > 180) {
              litSum += mx;
              litN++;
            } else {
              shadowSum += mx;
              shadowN++;
            }
          }
        }
        resolve({
          png: off.toDataURL("image/png"),
          renderer: s.context?.rendererType,
          cloudish,
          meanLum: cloudish ? Math.round(lumSum / cloudish) : 0,
          litMean: litN ? Math.round(litSum / litN) : 0,
          shadowMean: shadowN ? Math.round(shadowSum / shadowN) : 0,
          litFrac: cloudish ? (litN / cloudish).toFixed(3) : 0,
        });
      });
      s.render();
    });
  }, forceCone);
}

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

const straight = await capture(page, 0);
writeFileSync(
  join(OUT, "cloud-cone-equal-straight.png"),
  Buffer.from(straight.png.split(",")[1], "base64"),
);
const cone = await capture(page, 1);
writeFileSync(
  join(OUT, "cloud-cone-equal-cone.png"),
  Buffer.from(cone.png.split(",")[1], "base64"),
);
await browser.close();

console.log(
  `STRAIGHT: cloudish=${straight.cloudish} meanLum=${straight.meanLum} litMean=${straight.litMean} shadowMean=${straight.shadowMean} litFrac=${straight.litFrac}`,
);
console.log(
  `CONE    : cloudish=${cone.cloudish} meanLum=${cone.meanLum} litMean=${cone.litMean} shadowMean=${cone.shadowMean} litFrac=${cone.litFrac}`,
);
console.log(`errors=${errors.length}`);
errors.slice(0, 5).forEach((e) => console.log("  ERR:", e.slice(0, 150)));
console.log(
  "PNGs: output/cloud-cone-equal-straight.png, output/cloud-cone-equal-cone.png",
);
