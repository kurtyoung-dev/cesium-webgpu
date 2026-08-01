#!/usr/bin/env node
/**
 * Weather ingest MVP (Phase 0/1) — end-to-end pipeline probe. WebGPU-only.
 *
 * Proves the data-driven path: a WeatherProvider + a WeatherSource emits a real
 * WeatherField → WeatherTexPacker bakes it into the C2-16 weather-map texture →
 * the cloud raymarcher's effectiveCoverage reads R → the deck reflects the data,
 * and the weather map AUTO-ENABLES once data arrives. Uses SyntheticWeatherSource
 * (deterministic, no network) so the pipeline is verifiable without the live
 * (CORS-uncertain, dev-lab) EDR endpoint. The EdrWeatherSource is checked for a
 * well-formed cube URL (its live call is opt-in).
 *
 * Claims:
 *   (1) the Weather API is exported (WeatherProvider / EdrWeatherSource /
 *       SyntheticWeatherSource / packWeatherField);
 *   (2) EdrWeatherSource.buildUrl() yields a valid OGC API-EDR cube URL;
 *   (3) a uniform-0.95 synthetic provider fills the sky (auto-enabled map);
 *   (4) swapping to a uniform-0.0 synthetic source CLEARS the deck;
 *   (5) 0 device errors.
 *
 * Usage: PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-weather-ingest.mjs
 */
import { chromium } from "playwright";
import {
  errorGateInit,
  armWebGPUDevices,
  collectGateErrors,
  attachConsoleErrorGate,
} from "../lib/webgpu-error-gate.mjs";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const W = 1024,
  H = 768;
const OUT = "Tools/visual-regression/output";
const URL = `${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`;

const SETUP = async () => {
  const C = (window.Cesium =
    window.Cesium || (await import("/Build/CesiumUnminified/index.js")));
  const v = window.viewer;
  const s = v.scene;
  s.requestRenderMode = false;
  const g = s.globe;
  g.defaultCloudCollection.enableVolumetric = true;
  g.defaultCloudCollection.volumetric.cloudCoverage = 0.5; // weatherStrength = 1.0 → effectiveCoverage = map R
  g.defaultCloudCollection.volumetric.cloudDensity = 0.45;
  // Near-ground upward view so the deck fills the sky and reads clearly.
  v.camera.setView({
    destination: C.Cartesian3.fromDegrees(-95.0, 39.0, 650.0),
    orientation: {
      heading: C.Math.toRadians(90.0),
      pitch: C.Math.toRadians(16.0),
      roll: 0.0,
    },
  });
  // Export-surface + EDR URL checks (no network).
  const api = {
    hasProvider: typeof C.WeatherProvider === "function",
    hasEdr: typeof C.EdrWeatherSource === "function",
    hasSynthetic: typeof C.SyntheticWeatherSource === "function",
    hasPacker: typeof C.packWeatherField === "function",
  };
  let edrUrl = "";
  if (api.hasEdr) {
    edrUrl = new C.EdrWeatherSource().buildUrl({ time: "latest" });
  }
  s.requestRender();
  return { api, edrUrl };
};

const SET_PROVIDER = async (value) => {
  const C = window.Cesium;
  const g = window.viewer.scene.globe;
  if (!g.defaultCloudCollection.volumetric.weatherProvider) {
    g.defaultCloudCollection.volumetric.weatherProvider = new C.WeatherProvider(
      new C.SyntheticWeatherSource("uniform", value),
    );
  } else {
    g.defaultCloudCollection.volumetric.weatherProvider.setSource(
      new C.SyntheticWeatherSource("uniform", value),
    );
  }
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

// Whitish/grey cloud-deck fraction in the sky region (upper-centre, right of HUD).
function deck(page, dataUrl) {
  return page.evaluate(async (du) => {
    const img = new Image();
    img.src = du;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const cx = c.getContext("2d");
    cx.drawImage(img, 0, 0);
    const x0 = Math.floor(c.width * 0.1),
      x1 = Math.floor(c.width * 0.95),
      y0 = Math.floor(c.height * 0.1),
      y1 = Math.floor(c.height * 0.82);
    const d = cx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
    let cloud = 0,
      n = 0;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i],
        g = d[i + 1],
        b = d[i + 2];
      const L = 0.299 * r + 0.587 * g + 0.114 * b;
      const mx = Math.max(r, g, b),
        mn = Math.min(r, g, b);
      const blueSky = b > r + 25 && b > 120;
      if (!blueSky && L > 90 && mx - mn < 55) {
        cloud++;
      }
      n++;
    }
    return +((100 * cloud) / n).toFixed(2);
  }, dataUrl);
}

async function run() {
  const fs = await import("fs");
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  const consoleErrors = attachConsoleErrorGate(page);
  await page.addInitScript(errorGateInit);
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => !!(window.viewer && window.viewer.scene),
    null,
    {
      timeout: 60000,
    },
  );
  await armWebGPUDevices(page);
  const setup = await page.evaluate(SETUP);
  await page.waitForTimeout(9000);

  const canvas = await page.$(".cesium-widget canvas");
  const shot = async (name) => {
    await canvas.screenshot({ path: `${OUT}/${name}.png` });
    return (
      "data:image/png;base64," +
      fs.readFileSync(`${OUT}/${name}.png`).toString("base64")
    );
  };

  // Provider with uniform-0.95 coverage everywhere → sky fills.
  await page.evaluate(SET_PROVIDER, 0.95);
  await page.waitForTimeout(6000);
  const deckHi = await deck(page, await shot("weather-ingest-uniform-hi"));
  const stateHi = await page.evaluate(PROVIDER_STATE);

  // Swap to uniform-0.0 → deck clears.
  await page.evaluate(SET_PROVIDER, 0.0);
  await page.waitForTimeout(6000);
  const deckLo = await deck(page, await shot("weather-ingest-uniform-lo"));
  const stateLo = await page.evaluate(PROVIDER_STATE);

  const gate = await collectGateErrors(page);
  const newErrs = (gate.errors || [])
    .concat(consoleErrors)
    .filter(
      (e) => !/Atmosphere ?LUT|SkyAtmosphere|default layout|favicon/i.test(e),
    );

  const edrOk =
    typeof setup.edrUrl === "string" &&
    setup.edrUrl.includes("/collections/") &&
    setup.edrUrl.includes("/cube?") &&
    setup.edrUrl.includes("parameter-name=") &&
    setup.edrUrl.includes("CoverageJSON");

  console.log("api", JSON.stringify(setup.api));
  console.log("edrUrl", setup.edrUrl);
  console.log(
    `deck%% hi=${deckHi} lo=${deckLo} | stateHi=${JSON.stringify(stateHi)} stateLo=${JSON.stringify(stateLo)} errs=${newErrs.length}`,
  );

  const checks = [
    [
      "Weather API exported (Provider/Edr/Synthetic/packer)",
      setup.api.hasProvider &&
        setup.api.hasEdr &&
        setup.api.hasSynthetic &&
        setup.api.hasPacker,
    ],
    [`EdrWeatherSource.buildUrl() is a valid EDR cube URL`, edrOk],
    [
      `provider fetched data (hasData true, version > 0)`,
      !!stateHi && stateHi.hasData && stateHi.version > 0,
    ],
    [`uniform-0.95 renders a deck (deck ${deckHi}% > 5)`, deckHi > 5],
    [
      `uniform-0.0 CLEARS the deck (deck ${deckLo}% < ${deckHi} - 5, i.e. data drives coverage)`,
      deckLo < deckHi - 5,
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
