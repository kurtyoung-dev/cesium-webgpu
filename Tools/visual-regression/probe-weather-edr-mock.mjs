#!/usr/bin/env node
/**
 * Weather Phase 1/3 — mock-EDR offline pipeline probe (Batch 424). WebGPU-only.
 *
 * Proves the FULL EDR ingest chain — fetch -> CoverageJSON parse -> packer ->
 * weatherTex -> clouds — works end-to-end WITHOUT the live (CORS-uncertain,
 * dev-lab) network, by pointing an EdrWeatherSource at the dev server's
 * `/mock-edr` route, which serves a committed CoverageJSON fixture
 * (Tools/visual-regression/fixtures/edr-cube-tcc.json: a 12x6 TCDC grid with a
 * recognizable clear-NW -> overcast-SE pattern + a clear "eye" in the east).
 * This retroactively completes Phase 1's end-to-end verification that the live
 * network blocked.
 *
 * Measurement: the proven probe-weather-map nadir sweep — fly a 250 km nadir
 * camera west->east across the fixture (sky/sun/skyBox OFF, dark globe) and count
 * bright cloud pixels at each. The fixture ramps clear(west) -> overcast(east),
 * so the per-location cloud fraction should rise west->east.
 *
 * Claims:
 *   (1) EdrWeatherSource.buildUrl() targets the mock endpoint;
 *   (2) the provider FETCHES + PARSES the fixture (hasData true, no lastError —
 *       i.e. NO fallback-to-procedural);
 *   (3) the fixture's spatial pattern reaches the deck (clear west < overcast
 *       east — coverage rises across the field);
 *   (4) 0 device errors.
 *
 * Usage: PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-weather-edr-mock.mjs
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
const MOCK_BASE = `${BASE}/mock-edr`;

// West -> east longitudes across the fixture (clear -> overcast ramp).
const LON_SWEEP = [-160, -120, -80, -40, 0, 40, 80, 120, 160];
const LAT = 30.0;

async function cloudFracAt(page, lon, lat) {
  return page.evaluate(
    async ({ lon, lat }) => {
      const C = (window.Cesium =
        window.Cesium || (await import("/Build/CesiumUnminified/index.js")));
      const v = window.viewer,
        s = v.scene;
      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(lon, lat, 250000.0),
        orientation: { heading: 0.0, pitch: C.Math.toRadians(-90.0), roll: 0.0 },
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

const SETUP = async (mockBase) => {
  const C = (window.Cesium =
    window.Cesium || (await import("/Build/CesiumUnminified/index.js")));
  const v = window.viewer,
    s = v.scene,
    g = s.globe;
  s.requestRenderMode = false;
  g.showProceduralClouds = true;
  g.cloudCoverage = 0.6;
  g.cloudDensity = 0.9;
  g.cloudLayerBottom = 1500;
  g.cloudLayerTop = 4000;
  s.skyAtmosphere.show = false;
  if (s.sun) s.sun.show = false;
  if (s.moon) s.moon.show = false;
  s.skyBox.show = false;
  s.backgroundColor = C.Color.BLACK;
  g.baseColor = C.Color.fromBytes(20, 20, 25);
  const src = new C.EdrWeatherSource({
    baseUrl: mockBase,
    collection: "mock-gfs",
    parameterName: "TCDC",
    coverageUnits: "percent",
  });
  const edrUrl = src.buildUrl({ time: "latest" });
  g.weatherProvider = new C.WeatherProvider(src);
  s.requestRender();
  return { edrUrl };
};

const PROVIDER_STATE = async () => {
  const p = window.viewer.scene.globe.weatherProvider;
  return p
    ? { hasData: p.hasData, version: p.version, lastError: p.lastError }
    : null;
};

function stats(arr) {
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  return {
    mean: +mean.toFixed(4),
    range: +(Math.max(...arr) - Math.min(...arr)).toFixed(4),
  };
}

async function run() {
  const fs = await import("fs");
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
  const consoleErrors = attachConsoleErrorGate(page);
  await page.addInitScript(errorGateInit);
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => !!(window.viewer && window.viewer.scene),
    null,
    { timeout: 60000 },
  );
  await armWebGPUDevices(page);
  const setup = await page.evaluate(SETUP, MOCK_BASE);
  // Allow the async EDR fetch + parse + pack to land.
  await page.waitForTimeout(7000);
  const state = await page.evaluate(PROVIDER_STATE);

  const fr = [];
  for (const lon of LON_SWEEP) {
    fr.push(await cloudFracAt(page, lon, LAT));
  }
  // Visual read: a west (clear) and an east (overcast) nadir capture.
  await page.evaluate(async () => {
    const C = window.Cesium;
    window.viewer.camera.setView({
      destination: C.Cartesian3.fromDegrees(-150, 30, 250000.0),
      orientation: { heading: 0.0, pitch: C.Math.toRadians(-90.0), roll: 0.0 },
    });
    for (let i = 0; i < 60; i++) {
      window.viewer.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
  });
  fs.writeFileSync(`${OUT}/weather-edr-mock-west.png`, await page.screenshot());
  await page.evaluate(async () => {
    const C = window.Cesium;
    window.viewer.camera.setView({
      destination: C.Cartesian3.fromDegrees(150, 30, 250000.0),
      orientation: { heading: 0.0, pitch: C.Math.toRadians(-90.0), roll: 0.0 },
    });
    for (let i = 0; i < 60; i++) {
      window.viewer.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
  });
  fs.writeFileSync(`${OUT}/weather-edr-mock-east.png`, await page.screenshot());

  const gate = await collectGateErrors(page);
  const newErrs = (gate.errors || [])
    .concat(consoleErrors)
    .concat(gate.deviceLost ? [gate.deviceLost] : [])
    .filter(
      (e) => !/Atmosphere ?LUT|SkyAtmosphere|default layout|favicon/i.test(e),
    );

  const urlOk =
    typeof setup.edrUrl === "string" &&
    setup.edrUrl.startsWith(MOCK_BASE) &&
    setup.edrUrl.includes("/collections/mock-gfs/cube?") &&
    setup.edrUrl.includes("parameter-name=TCDC");

  const st = stats(fr);
  const west = fr[0];
  const east = fr[fr.length - 1];

  console.log("edrUrl", setup.edrUrl);
  console.log("state", JSON.stringify(state));
  console.log("fr:", fr.map((f) => f.toFixed(3)).join(", "), "->", JSON.stringify(st));
  console.log(`west=${west.toFixed(3)} east=${east.toFixed(3)}`);
  console.log("errs", newErrs.length);

  const checks = [
    [`EdrWeatherSource.buildUrl() targets the mock endpoint`, urlOk],
    [
      `provider FETCHED + PARSED the fixture (hasData, version>0, no fallback)`,
      !!state && state.hasData && state.version > 0 && !state.lastError,
    ],
    [
      `fixture spatial pattern reaches the deck (overcast east ${east.toFixed(3)} ` +
        `> clear west ${west.toFixed(3)} by >= 0.03)`,
      east - west >= 0.03,
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
  if (state && state.lastError) {
    console.log("  lastError:", state.lastError);
  }
  console.log(`\nRESULT: ${pass ? "GREEN" : "RED"}`);
  await browser.close();
  process.exitCode = pass ? 0 : 1;
}
run();
