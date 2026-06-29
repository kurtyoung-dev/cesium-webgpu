#!/usr/bin/env node
/**
 * Weather Phase 3 — mock-METAR offline pipeline probe (Batch 425). WebGPU-only.
 *
 * Proves the FULL-RGBA METAR ingest chain — station obs -> parse cloud groups ->
 * IDW rasterize -> packer (R coverage + G genus + B base + A density) ->
 * weatherTex -> clouds — works end-to-end WITHOUT live network, by pointing a
 * MetarWeatherSource at the dev server's `/mock-metar` route, which serves a
 * committed station fixture (Tools/visual-regression/fixtures/metar-stations.json)
 * with a CLEAR station (west, SKC), a BKN station, an OVC station, and a CB
 * station — so the IDW field varies BOTH spatially (R) AND in the G/B/A channels.
 *
 * Claims:
 *   (1) MetarWeatherSource is drivable from a mock URL (no live network);
 *   (2) the provider FETCHES + PARSES + RASTERIZES (hasData, version>0, no
 *       lastError — i.e. NO fallback-to-procedural);
 *   (3) the IDW coverage field varies SPATIALLY — the clear-station region has a
 *       thinner deck than the cloudy-station region;
 *   (4) the G/B/A channels reach the shader — over the OVC/CB cloudy region the
 *       deck CHANGES between cloudWeatherChannelStrength=1 (G/B/A active) and =0
 *       (R-only), which can only happen if genus/base/density are sampled;
 *   (5) 0 device errors.
 *
 * Usage: PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-weather-metar.mjs
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
const MOCK_URL = `${BASE}/mock-metar`;

// Fixture stations sit at lat 35: clear @ -120, BKN @ -60, OVC @ 0, CB @ 60, FEW @ 120.
const CLEAR_LON = -120.0; // SKC station region (IDW coverage ~0)
const CLOUDY_LON = 0.0; // OVC station region (full coverage, densest, lowest base)
const LAT = 35.0;

// Count bright cloud pixels in the central nadir window.
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
        bright = 0,
        n = 0;
      for (let y = Math.floor(h * 0.2); y < h * 0.8; y += 2) {
        for (let x = Math.floor(w * 0.2); x < w * 0.8; x += 2) {
          const i = (y * w + x) * 4;
          const mx = Math.max(px[i], px[i + 1], px[i + 2]);
          if (mx > 120) cloud++;
          bright += mx;
          n++;
        }
      }
      return { frac: n ? cloud / n : 0, lum: n ? bright / n : 0 };
    },
    { lon, lat },
  );
}

const SETUP = async (mockUrl) => {
  const C = (window.Cesium =
    window.Cesium || (await import("/Build/CesiumUnminified/index.js")));
  const v = window.viewer,
    s = v.scene,
    g = s.globe;
  s.requestRenderMode = false;
  g.showProceduralClouds = true;
  g.cloudCoverage = 0.6;
  // Moderate base density so the A density-bias has headroom to thicken thin cells
  // (a saturated deck can't show MORE cloud, hiding the channel response).
  g.cloudDensity = 0.5;
  g.cloudLayerBottom = 1500;
  g.cloudLayerTop = 4000;
  g.cloudWeatherChannelStrength = 1.0;
  s.skyAtmosphere.show = false;
  if (s.sun) s.sun.show = false;
  if (s.moon) s.moon.show = false;
  s.skyBox.show = false;
  s.backgroundColor = C.Color.BLACK;
  g.baseColor = C.Color.fromBytes(20, 20, 25);
  const src = new C.MetarWeatherSource({
    url: mockUrl,
    gridWidth: 64,
    gridHeight: 32,
    influenceRadiusDeg: 45,
    sourceLabel: "mock",
  });
  const caps = src.getCapabilities();
  g.weatherProvider = new C.WeatherProvider(src);
  s.requestRender();
  return { capId: caps.id, supportsTime: caps.supportsTime };
};

const PROVIDER_STATE = async () => {
  const p = window.viewer.scene.globe.weatherProvider;
  return p
    ? { hasData: p.hasData, version: p.version, lastError: p.lastError }
    : null;
};

const SET_CHANNEL_STRENGTH = async (val) => {
  window.viewer.scene.globe.cloudWeatherChannelStrength = val;
  // Channel strength is a uniform (no re-fetch); a few frames refresh the deck.
  for (let i = 0; i < 30; i++) {
    window.viewer.scene.render();
    await new Promise((r) => requestAnimationFrame(r));
  }
  return true;
};

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

// Nadir cloud-fraction sweep across the cloudy band (lons that span the BKN ->
// OVC -> CB stations). Returns the per-location bright-pixel fraction.
async function sweep(page, lons, lat) {
  const out = [];
  for (const lon of lons) {
    out.push((await cloudFracAt(page, lon, lat)).frac);
  }
  return out;
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
  const setup = await page.evaluate(SETUP, MOCK_URL);
  await page.waitForTimeout(7000);
  const state = await page.evaluate(PROVIDER_STATE);

  // (3) IDW spatial coverage: clear-station region vs cloudy (OVC) region.
  const clear = await cloudFracAt(page, CLEAR_LON, LAT);
  const cloudy = await cloudFracAt(page, CLOUDY_LON, LAT);

  // (4) G/B/A channel response. Nadir-sweep the cloudy band (BKN -> OVC -> CB
  // stations, where G/B/A all vary cell-to-cell) at full channel strength, then
  // again with cloudWeatherChannelStrength=0 (R-only). The genus/base/density
  // channels add per-location deck variation ON TOP of coverage, so the ch=1
  // sweep's SPREAD (stddev) exceeds the R-only ch=0 sweep's. A neutral cell is a
  // no-op, so this delta can ONLY come from the shader sampling G/B/A. (Same
  // method as probe-weather-channels.mjs, Batch 424.)
  const BAND_LONS = [-60, -40, -20, 0, 20, 40, 60];
  await page.evaluate(SET_CHANNEL_STRENGTH, 1.0);
  const ch1Fr = await sweep(page, BAND_LONS, LAT);
  // Visual read: the OVC (densest, lowest-base) region with channels ON.
  await cloudFracAt(page, CLOUDY_LON, LAT);
  fs.writeFileSync(`${OUT}/weather-metar-channels-on.png`, await page.screenshot());
  await page.evaluate(SET_CHANNEL_STRENGTH, 0.0);
  const ch0Fr = await sweep(page, BAND_LONS, LAT);
  await cloudFracAt(page, CLOUDY_LON, LAT);
  fs.writeFileSync(
    `${OUT}/weather-metar-channels-off.png`,
    await page.screenshot(),
  );

  // Restore strength=1; capture the OVC (cloudy) + clear regions for the visual read.
  await page.evaluate(SET_CHANNEL_STRENGTH, 1.0);
  await cloudFracAt(page, CLOUDY_LON, LAT);
  fs.writeFileSync(`${OUT}/weather-metar-ovc.png`, await page.screenshot());
  await cloudFracAt(page, CLEAR_LON, LAT);
  fs.writeFileSync(`${OUT}/weather-metar-clear.png`, await page.screenshot());

  const gate = await collectGateErrors(page);
  const newErrs = (gate.errors || [])
    .concat(consoleErrors)
    .concat(gate.deviceLost ? [gate.deviceLost] : [])
    .filter(
      (e) => !/Atmosphere ?LUT|SkyAtmosphere|default layout|favicon/i.test(e),
    );

  const ch1 = stats(ch1Fr);
  const ch0 = stats(ch0Fr);
  // PER-LOCATION isolation: at each longitude R is identical between the two
  // sweeps (same field cell), so the ch1-vs-ch0 difference is PURELY the G/B/A
  // contribution. The cloudy band's cells average density-bias A > neutral, so
  // turning the channels ON consistently thickens the deck → a positive mean
  // shift + a non-trivial sum of |per-location deltas|.
  const perLocDeltas = ch1Fr.map((f, i) => f - ch0Fr[i]);
  const meanShift = +(ch1.mean - ch0.mean).toFixed(4);
  const absDeltaSum = +perLocDeltas
    .reduce((a, d) => a + Math.abs(d), 0)
    .toFixed(4);

  console.log("cap", JSON.stringify(setup));
  console.log("state", JSON.stringify(state));
  console.log(
    `clear(frac=${clear.frac.toFixed(3)},lum=${clear.lum.toFixed(1)}) ` +
      `cloudy(frac=${cloudy.frac.toFixed(3)},lum=${cloudy.lum.toFixed(1)})`,
  );
  console.log("ch1 fr:", ch1Fr.map((f) => f.toFixed(3)).join(", "), "->", JSON.stringify(ch1));
  console.log("ch0 fr:", ch0Fr.map((f) => f.toFixed(3)).join(", "), "->", JSON.stringify(ch0));
  console.log("perLocΔ:", perLocDeltas.map((d) => d.toFixed(3)).join(", "));
  console.log(`meanShift=${meanShift} absDeltaSum=${absDeltaSum}`);
  console.log("errs", newErrs.length);

  const checks = [
    [
      `MetarWeatherSource cap id = metar:mock, supportsTime false`,
      setup.capId === "metar:mock" && setup.supportsTime === false,
    ],
    [
      `provider FETCHED + PARSED + RASTERIZED (hasData, version>0, no fallback)`,
      !!state && state.hasData && state.version > 0 && !state.lastError,
    ],
    [
      `IDW coverage varies spatially (cloudy OVC ${cloudy.frac.toFixed(3)} > ` +
        `clear SKC ${clear.frac.toFixed(3)} by >= 0.05)`,
      cloudy.frac - clear.frac >= 0.05,
    ],
    [
      `G/B/A channels reach the shader: turning them ON shifts the deck per ` +
        `location (Σ|Δ| ${absDeltaSum} >= 0.04, mean shift ${meanShift})`,
      absDeltaSum >= 0.04,
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
