#!/usr/bin/env node
/**
 * Weather Phase 3 — G/B/A channel reads (Batch 424). WebGPU-only.
 *
 * Proves the cloud raymarcher APPLIES the weather map's G (genus), B (cloud
 * base) and A (density-bias) channels, not just R (coverage). Drives a
 * SyntheticWeatherSource "rich" field whose R is near-flat (0.85 everywhere) but
 * whose A varies WEST(thin 0.05)->EAST(dense 0.95), B varies NORTH(low)->
 * SOUTH(high), and G varies WEST(stratus/SLAB)->EAST(cumulonimbus/TOWER).
 *
 * Measurement (the proven probe-weather-map nadir pattern): fly a 250 km nadir
 * camera to many far-apart longitudes, with sky/sun/skyBox OFF + a dark globe,
 * and count bright cloud pixels at each. Because R is ~flat, the per-location
 * cloud-density spread is driven by A (and the genus/base shape change from G/B).
 *
 * Claims:
 *   (1) the "rich" field renders a deck (auto-enabled map, hasData);
 *   (2) the rich field's per-location cloud-density SPREAD exceeds the neutral
 *       R-only control's (the same flat R can't produce it → G/B/A response),
 *       AND west(thin/flat) is visibly lighter than east(dense/towering);
 *   (3) cloudWeatherChannelStrength=0 collapses the spread back toward neutral
 *       (the channels are gated; neutral G=0.5/B=0/A=0.5 is a no-op);
 *   (4) 0 device errors.
 *
 * Usage: PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-weather-channels.mjs
 */
import { chromium } from "playwright";
import {
  errorGateInit,
  armWebGPUDevices,
  collectGateErrors,
  attachConsoleErrorGate,
} from "../lib/webgpu-error-gate.mjs";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT = "Tools/visual-regression/output";
const URL = `${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`;

// Far-apart longitudes spanning the field west->east at a fixed mid latitude, so
// each samples a different A/G column of the "rich" field.
const LON_SWEEP = [-170, -130, -90, -50, -10, 30, 70, 110, 150];
const LAT = 25.0;

// One nadir capture of the cloud field at (lon, lat); returns the bright-pixel
// fraction in the center region (cloud density proxy).
async function cloudFracAt(page, lon, lat) {
  return page.evaluate(
    async ({ lon, lat }) => {
      const C = (window.Cesium =
        window.Cesium || (await import("/Build/CesiumUnminified/index.js")));
      const v = window.viewer,
        s = v.scene;
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
    { lon, lat },
  );
}

function stats(arr) {
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const variance =
    arr.reduce((a, b) => a + (b - mean) * (b - mean), 0) / arr.length;
  return {
    mean: +mean.toFixed(4),
    stddev: +Math.sqrt(variance).toFixed(4),
    range: +(Math.max(...arr) - Math.min(...arr)).toFixed(4),
  };
}

const SETUP = async () => {
  const C = (window.Cesium =
    window.Cesium || (await import("/Build/CesiumUnminified/index.js")));
  const v = window.viewer,
    s = v.scene,
    g = s.globe;
  s.requestRenderMode = false;
  g.defaultCloudCollection.enableVolumetric = true;
  g.defaultCloudCollection.volumetric.cloudCoverage = 0.6;
  g.defaultCloudCollection.volumetric.cloudDensity = 0.9;
  g.defaultCloudCollection.volumetric.cloudLayerBottom = 1500;
  g.defaultCloudCollection.volumetric.cloudLayerTop = 4000;
  g.defaultCloudCollection.volumetric.cloudWeatherChannelStrength = 1.0;
  s.skyAtmosphere.show = false;
  if (s.sun) s.sun.show = false;
  if (s.moon) s.moon.show = false;
  s.skyBox.show = false;
  s.backgroundColor = C.Color.BLACK;
  g.baseColor = C.Color.fromBytes(20, 20, 25);
  s.requestRender();
  return { ok: true };
};

const SET_SRC = async (kind) => {
  const C = window.Cesium;
  const g = window.viewer.scene.globe;
  const src =
    kind === "rich"
      ? new C.SyntheticWeatherSource("rich")
      : new C.SyntheticWeatherSource("uniform", 0.85);
  if (!g.defaultCloudCollection.volumetric.weatherProvider) {
    g.defaultCloudCollection.volumetric.weatherProvider = new C.WeatherProvider(
      src,
    );
  } else {
    g.defaultCloudCollection.volumetric.weatherProvider.setSource(src);
  }
  window.viewer.scene.requestRender();
  return { ok: true };
};

const SET_STRENGTH = async (value) => {
  window.viewer.scene.globe.defaultCloudCollection.volumetric.cloudWeatherChannelStrength =
    value;
  window.viewer.scene.requestRender();
  return { ok: true };
};

const PROVIDER_STATE = async () => {
  const p =
    window.viewer.scene.globe.defaultCloudCollection.volumetric.weatherProvider;
  return p
    ? { hasData: p.hasData, version: p.version, lastError: p.lastError }
    : null;
};

async function sweep(page) {
  const fr = [];
  for (const lon of LON_SWEEP) {
    fr.push(await cloudFracAt(page, lon, LAT));
  }
  return fr;
}

async function run() {
  const fs = await import("fs");
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({
    viewport: { width: 1024, height: 768 },
  });
  const consoleErrors = attachConsoleErrorGate(page);
  await page.addInitScript(errorGateInit);
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => !!(window.viewer && window.viewer.scene),
    null,
    { timeout: 60000 },
  );
  await armWebGPUDevices(page);
  await page.evaluate(SETUP);
  await page.waitForTimeout(4000);

  // Rich field, full channel strength.
  await page.evaluate(SET_SRC, "rich");
  await page.waitForTimeout(5000);
  const richState = await page.evaluate(PROVIDER_STATE);
  const richFr = await sweep(page);
  // Save a representative west (thin) + east (dense) capture for the visual read.
  await page.evaluate(async () => {
    const C = window.Cesium;
    window.viewer.camera.setView({
      destination: C.Cartesian3.fromDegrees(-150, 25, 250000.0),
      orientation: { heading: 0.0, pitch: C.Math.toRadians(-90.0), roll: 0.0 },
    });
    for (let i = 0; i < 60; i++) {
      window.viewer.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
  });
  fs.writeFileSync(
    `${OUT}/weather-channels-rich-west.png`,
    await page.screenshot(),
  );
  await page.evaluate(async () => {
    const C = window.Cesium;
    window.viewer.camera.setView({
      destination: C.Cartesian3.fromDegrees(150, 25, 250000.0),
      orientation: { heading: 0.0, pitch: C.Math.toRadians(-90.0), roll: 0.0 },
    });
    for (let i = 0; i < 60; i++) {
      window.viewer.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
  });
  fs.writeFileSync(
    `${OUT}/weather-channels-rich-east.png`,
    await page.screenshot(),
  );

  // Neutral R-only control (flat 0.85). Same R, no G/B/A variation.
  await page.evaluate(SET_SRC, "uniform");
  await page.waitForTimeout(5000);
  const neutralFr = await sweep(page);

  // Rich field with channelStrength=0 → channels gated off → spread should
  // collapse back toward the neutral control (neutral=no-op).
  await page.evaluate(SET_SRC, "rich");
  await page.waitForTimeout(2000);
  await page.evaluate(SET_STRENGTH, 0.0);
  await page.waitForTimeout(3000);
  const richOffFr = await sweep(page);

  const gate = await collectGateErrors(page);
  const newErrs = (gate.errors || [])
    .concat(consoleErrors)
    .concat(gate.deviceLost ? [gate.deviceLost] : [])
    .filter(
      (e) => !/Atmosphere ?LUT|SkyAtmosphere|default layout|favicon/i.test(e),
    );

  const rich = stats(richFr);
  const neutral = stats(neutralFr);
  const richOff = stats(richOffFr);
  // West (thin A, flat G) should be LIGHTER (less cloud) than east (dense A, tower G).
  const westFrac = richFr[0];
  const eastFrac = richFr[richFr.length - 1];

  console.log("richState", JSON.stringify(richState));
  console.log(
    "rich   fr:",
    richFr.map((f) => f.toFixed(3)).join(", "),
    "->",
    JSON.stringify(rich),
  );
  console.log(
    "neutral fr:",
    neutralFr.map((f) => f.toFixed(3)).join(", "),
    "->",
    JSON.stringify(neutral),
  );
  console.log(
    "richOff fr:",
    richOffFr.map((f) => f.toFixed(3)).join(", "),
    "->",
    JSON.stringify(richOff),
  );
  console.log(`west=${westFrac.toFixed(3)} east=${eastFrac.toFixed(3)}`);
  console.log("errs", newErrs.length);

  const checks = [
    [
      `rich field renders a deck (hasData, version>0)`,
      !!richState && richState.hasData && richState.version > 0,
    ],
    [
      `clouds present across the sweep (rich mean ${rich.mean} > 0.02)`,
      rich.mean > 0.02,
    ],
    [
      `G/B/A drive a per-location spread ABOVE the R-only control ` +
        `(rich stddev ${rich.stddev} >= neutral stddev ${neutral.stddev} + 0.01)`,
      rich.stddev >= neutral.stddev + 0.01,
    ],
    [
      `west(thin/flat A,G) is lighter than east(dense/tower) ` +
        `(west ${westFrac.toFixed(3)} < east ${eastFrac.toFixed(3)} - 0.02)`,
      westFrac < eastFrac - 0.02,
    ],
    [
      `channelStrength=0 collapses the spread toward neutral ` +
        `(richOff stddev ${richOff.stddev} closer to neutral ${neutral.stddev} than rich ${rich.stddev})`,
      Math.abs(richOff.stddev - neutral.stddev) <
        Math.abs(rich.stddev - neutral.stddev),
    ],
    [`no NEW device errors (${newErrs.length})`, newErrs.length === 0],
  ];

  console.log("\n=== ANALYSIS ===");
  let pass = true;
  for (const [n, ok] of checks) {
    console.log(`  [${ok ? "PASS" : "FAIL"}] ${n}`);
    if (!ok) {
      pass = false;
    }
  }
  if (newErrs.length) {
    console.log("  errors:", newErrs.slice(0, 5));
  }
  console.log(`\nRESULT: ${pass ? "GREEN" : "RED"}`);
  await browser.close();
  process.exitCode = pass ? 0 : 1;
}
run();
