#!/usr/bin/env node
/**
 * Weather Phase 3 — mock-WCS (OGC API-Coverages / MSC GeoMet) offline probe
 * (Batch 425). WebGPU-only.
 *
 * Proves the OGC Coverages ingest chain — fetch -> CoverageJSON parse (the SHARED
 * parser, same one EDR uses) -> packer -> weatherTex -> clouds — works end-to-end
 * WITHOUT live network, by pointing a WcsCoveragesWeatherSource at the dev
 * server's `/mock-wcs` route, which serves a committed CoverageJSON fixture
 * (Tools/visual-regression/fixtures/wcs-coverage.json: a 12x6 TCDC grid ramping
 * clear(west) -> overcast(east)).
 *
 * Claims:
 *   (1) WcsCoveragesWeatherSource.buildUrl() targets the mock endpoint;
 *   (2) the provider FETCHES + PARSES the fixture (hasData, version>0, no
 *       lastError — i.e. NO fallback-to-procedural);
 *   (3) the fixture's spatial pattern reaches the deck (clear west < overcast east);
 *   (4) 0 device errors.
 *
 * Usage: PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-weather-wcs.mjs
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
const MOCK_BASE = `${BASE}/mock-wcs`;

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

const SETUP = async (mockBase) => {
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
  s.skyAtmosphere.show = false;
  if (s.sun) s.sun.show = false;
  if (s.moon) s.moon.show = false;
  s.skyBox.show = false;
  s.backgroundColor = C.Color.BLACK;
  g.baseColor = C.Color.fromBytes(20, 20, 25);
  const src = new C.WcsCoveragesWeatherSource({
    baseUrl: mockBase,
    collection: "gdps-cloud-cover",
    parameterName: "TCDC",
    coverageUnits: "percent",
  });
  const wcsUrl = src.buildUrl({ time: "latest" });
  g.defaultCloudCollection.volumetric.weatherProvider = new C.WeatherProvider(
    src,
  );
  s.requestRender();
  return { wcsUrl };
};

const PROVIDER_STATE = async () => {
  const p =
    window.viewer.scene.globe.defaultCloudCollection.volumetric.weatherProvider;
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
  const setup = await page.evaluate(SETUP, MOCK_BASE);
  await page.waitForTimeout(7000);
  const state = await page.evaluate(PROVIDER_STATE);

  const fr = [];
  for (const lon of LON_SWEEP) {
    fr.push(await cloudFracAt(page, lon, LAT));
  }
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
  fs.writeFileSync(`${OUT}/weather-wcs-mock-west.png`, await page.screenshot());
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
  fs.writeFileSync(`${OUT}/weather-wcs-mock-east.png`, await page.screenshot());

  const gate = await collectGateErrors(page);
  const newErrs = (gate.errors || [])
    .concat(consoleErrors)
    .concat(gate.deviceLost ? [gate.deviceLost] : [])
    .filter(
      (e) => !/Atmosphere ?LUT|SkyAtmosphere|default layout|favicon/i.test(e),
    );

  const urlOk =
    typeof setup.wcsUrl === "string" &&
    setup.wcsUrl.startsWith(MOCK_BASE) &&
    setup.wcsUrl.includes("/collections/gdps-cloud-cover/coverage?") &&
    setup.wcsUrl.includes("bbox=");

  const st = stats(fr);
  const west = fr[0];
  const east = fr[fr.length - 1];

  console.log("wcsUrl", setup.wcsUrl);
  console.log("state", JSON.stringify(state));
  console.log(
    "fr:",
    fr.map((f) => f.toFixed(3)).join(", "),
    "->",
    JSON.stringify(st),
  );
  console.log(`west=${west.toFixed(3)} east=${east.toFixed(3)}`);
  console.log("errs", newErrs.length);

  const checks = [
    [`WcsCoveragesWeatherSource.buildUrl() targets the mock endpoint`, urlOk],
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
