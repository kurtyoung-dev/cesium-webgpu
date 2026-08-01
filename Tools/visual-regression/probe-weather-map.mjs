#!/usr/bin/env node
/**
 * Probe: the weather-map seam (Weather Phase 1 / C2-16, the keystone).
 *
 * Before: ProceduralClouds uses ONE global coverage scalar → cloud cover is
 * uniform across the whole sky (only FBM small-scale detail varies). After:
 * globe.defaultCloudCollection.volumetric.cloudWeatherMap=true makes the raymarcher sample a 2D lat/lon weather
 * texture per world position, so coverage varies SPATIALLY — distinct cloudy
 * regions + clear gaps.
 *
 * Test (WebGPU), high nadir view over a wide footprint:
 *   - weatherMap OFF: coarse grid of cloud-fraction cells has LOW stddev (uniform).
 *   - weatherMap ON : HIGH stddev (regional structure from the weather map).
 *   - OFF still renders clouds (no regression); ON has clear gaps (some cells ~0).
 *
 * Usage: PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-weather-map.mjs
 */
import { chromium } from "playwright";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});
const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
const errs = [];
page.on("console", (m) => {
  if (m.type() === "error") errs.push(m.text());
});
page.on("pageerror", (e) => errs.push("PE:" + e.message));
await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
  waitUntil: "networkidle",
  timeout: 90000,
});
await page.waitForFunction(() => !!window.viewer, { timeout: 90000 });

const fs = await import("fs");
fs.mkdirSync("Tools/visual-regression/output", { recursive: true });

// Far-apart geographic locations. With weatherMap ON they sample different
// weather-map regions → different coverage; with OFF they're uniform (global).
const LOCATIONS = [
  [-120.0, 45.0],
  [-105.0, 47.0],
  [-95.0, 38.0],
  [-82.0, 43.0],
  [-70.0, 42.0],
  [-90.0, 25.0],
  [-110.0, 30.0],
  [-75.0, 30.0],
  [-100.0, 33.0],
  [-118.0, 36.0],
];

async function cloudFracAt(lon, lat, weatherOn) {
  return page.evaluate(
    async ({ lon, lat, weatherOn }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer,
        s = v.scene,
        g = s.globe;
      g.defaultCloudCollection.enableVolumetric = true;
      g.defaultCloudCollection.volumetric.cloudCoverage = 0.6;
      g.defaultCloudCollection.volumetric.cloudDensity = 0.9;
      g.defaultCloudCollection.volumetric.cloudLayerBottom = 1500;
      g.defaultCloudCollection.volumetric.cloudLayerTop = 4000;
      g.defaultCloudCollection.volumetric.cloudWeatherMap = weatherOn;
      s.skyAtmosphere.show = false;
      if (s.sun) s.sun.show = false;
      if (s.moon) s.moon.show = false;
      s.skyBox.show = false;
      s.backgroundColor = C.Color.BLACK;
      s.globe.baseColor = C.Color.fromBytes(20, 20, 25);
      // Nadir over this location at 250 km — captures the local cloud field.
      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(lon, lat, 250000.0),
        orientation: {
          heading: 0.0,
          pitch: C.Math.toRadians(-90.0),
          roll: 0.0,
        },
      });
      for (let i = 0; i < 90; i++) {
        s.render();
        await new Promise((res) => requestAnimationFrame(res));
      }
      const cv = s.canvas,
        w = cv.width,
        h = cv.height;
      const t = document.createElement("canvas");
      t.width = w;
      t.height = h;
      const cx = t.getContext("2d");
      cx.drawImage(cv, 0, 0);
      const px = cx.getImageData(0, 0, w, h).data;
      let cloud = 0,
        n = 0;
      // Center region (avoid the limb / UI).
      for (let y = Math.floor(h * 0.2); y < h * 0.8; y += 3) {
        for (let x = Math.floor(w * 0.2); x < w * 0.8; x += 3) {
          const i = (y * w + x) * 4;
          const mx = Math.max(px[i], px[i + 1], px[i + 2]);
          if (mx > 120) cloud++;
          n++;
        }
      }
      return n ? cloud / n : 0;
    },
    { lon, lat, weatherOn },
  );
}

function stats(arr) {
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const variance =
    arr.reduce((a, b) => a + (b - mean) * (b - mean), 0) / arr.length;
  return {
    mean,
    stddev: Math.sqrt(variance),
    range: Math.max(...arr) - Math.min(...arr),
  };
}

const offFracs = [];
for (const [lon, lat] of LOCATIONS)
  offFracs.push(await cloudFracAt(lon, lat, false));
const onFracs = [];
for (const [lon, lat] of LOCATIONS)
  onFracs.push(await cloudFracAt(lon, lat, true));

// Wide-orbit captures for the visual read (regional structure spans many texels).
async function wideCapture(weatherOn) {
  await page.evaluate(async (weatherOn) => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer,
      s = v.scene,
      g = s.globe;
    g.defaultCloudCollection.volumetric.cloudWeatherMap = weatherOn;
    g.defaultCloudCollection.volumetric.cloudCoverage = 0.6;
    v.camera.setView({
      destination: C.Cartesian3.fromDegrees(-95.0, 38.0, 2600000.0),
      orientation: { heading: 0.0, pitch: C.Math.toRadians(-90.0), roll: 0.0 },
    });
    for (let i = 0; i < 120; i++) {
      s.render();
      await new Promise((res) => requestAnimationFrame(res));
    }
  }, weatherOn);
  const buf = await page.screenshot({ omitBackground: false });
  fs.writeFileSync(
    `Tools/visual-regression/output/weather-map-wide-${weatherOn ? "on" : "off"}.png`,
    buf,
  );
}
await wideCapture(false);
await wideCapture(true);
await browser.close();

const off = stats(offFracs);
const on = stats(onFracs);
console.log(
  "OFF per-location cloudFrac:",
  offFracs.map((f) => f.toFixed(3)).join(", "),
);
console.log("  OFF", JSON.stringify(off));
console.log(
  "ON  per-location cloudFrac:",
  onFracs.map((f) => f.toFixed(3)).join(", "),
);
console.log("  ON ", JSON.stringify(on));
const newErrs = errs.filter((e) => !/AtmosphereLUT|default layout/.test(e));
if (newErrs.length) console.log("NEW errs:", newErrs.slice(0, 4));

const offMin = Math.min(...offFracs),
  onMin = Math.min(...onFracs),
  onMax = Math.max(...onFracs);
const checks = [
  [
    "OFF renders clouds everywhere (min > 0.1 — uniform coverage)",
    offMin > 0.1,
  ],
  ["ON renders dense clouds somewhere (max > 0.3)", onMax > 0.3],
  [
    `ON carves clearer regions than uniform coverage (onMin ${onMin.toFixed(3)} < 0.5 * offMin ${offMin.toFixed(3)})`,
    onMin < offMin * 0.5,
  ],
  [
    `ON has wider regional range than OFF (${on.range.toFixed(3)} > ${off.range.toFixed(3)})`,
    on.range > off.range,
  ],
  ["no NEW webgpu errors", newErrs.length === 0],
];
let pass = true;
console.log("\n=== ANALYSIS ===");
for (const [label, ok] of checks) {
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}`);
  if (!ok) pass = false;
}
console.log(`\nRESULT: ${pass ? "GREEN" : "RED"}`);
process.exitCode = pass ? 0 : 1;
