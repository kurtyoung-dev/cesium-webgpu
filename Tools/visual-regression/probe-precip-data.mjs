#!/usr/bin/env node
/**
 * PRECIP-DATA (Batch 444) — data-driven precipitation probe. WebGPU-only.
 *
 * Verifies improvement-plan 4.11: the `effects.precipitation.dataDriven` flag,
 * when set AND a weather-ingest provider with present-weather is attached,
 * overrides the precip TYPE + intensity from the ingest field's WMO `ww` code,
 * couples particle density to visibility, and (flag-gated) ramps a ground
 * snow-cover scalar. Default-OFF must be byte/behaviour-identical to the
 * manual/auto precip path (Batch 417a/423).
 *
 * What it checks (all WebGPU):
 *   1. WMO MAPPING (pure, in-page): precipFromWmoCode asserted at key codes —
 *      63→RAIN, 73→SNOW, 53→RAIN(drizzle), 45→FOG, 96→HAIL, 5→NONE, plus heavier
 *      codes give higher intensity.
 *   2. PARITY OFF: dataDriven=false with a provider attached → applyAtmospheric-
 *      Conditions leaves the manual selection EXACTLY (a manual RAIN selection
 *      survives an apply; the provider's snow ww does NOT leak in). Screenshot.
 *   3. FLAG ON — SNOW: synthetic source ww=73 + dataDriven=true → scene flips to
 *      SNOW (weatherType=1), particles render. Screenshot.
 *   4. FLAG ON — RAIN: ww=63 → RAIN (weatherType=0), particles render. Screenshot.
 *   5. SNOW vs RAIN screenshots differ (distinct particle look).
 *   6. VISIBILITY coupling: ww=65 (rain) with low visibilityKm=1 sets a
 *      weatherDensityScale > 1; high visibility=20 sets ~1.
 *   7. SNOW ACCUMULATION: snowAccumulation=true + snow ww → snowCover ramps up
 *      across applied frames; melts when precip stops.
 *   8. 0 device / validation errors throughout.
 *
 * Capture: Playwright `page.screenshot()` of the canvas (reliable WebGPU
 * readback; in-page toDataURL returns blank for the WebGPU swap chain).
 *
 * Usage: PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-precip-data.mjs
 * Outputs: Tools/visual-regression/output/probe-precip-data-{off,snow,rain}.png
 */
import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import {
  errorGateInit,
  armWebGPUDevices,
  collectGateErrors,
  attachConsoleErrorGate,
} from "../lib/webgpu-error-gate.mjs";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const URL = `${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`;
const OUT_DIR = "Tools/visual-regression/output";

async function burst(page, frames) {
  await page.evaluate(async (n) => {
    const s = window.viewer.scene;
    for (let i = 0; i < n; i++) {
      s.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
  }, frames);
}

// Diff two PNGs: count diff pixels (sum-abs > 16) via a headless canvas decode.
async function diffPngs(page, fileA, fileB) {
  const bA = fs.readFileSync(fileA).toString("base64");
  const bB = fs.readFileSync(fileB).toString("base64");
  return await page.evaluate(
    async ({ bA, bB }) => {
      const decode = async (b64) => {
        const img = new Image();
        img.src = "data:image/png;base64," + b64;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        const ctx = c.getContext("2d");
        ctx.drawImage(img, 0, 0);
        return {
          w: c.width,
          h: c.height,
          data: ctx.getImageData(0, 0, c.width, c.height).data,
        };
      };
      const a = await decode(bA);
      const b = await decode(bB);
      if (a.w !== b.w || a.h !== b.h) {
        return { error: "size mismatch" };
      }
      let diff = 0;
      for (let i = 0; i < a.data.length; i += 4) {
        const d =
          Math.abs(a.data[i] - b.data[i]) +
          Math.abs(a.data[i + 1] - b.data[i + 1]) +
          Math.abs(a.data[i + 2] - b.data[i + 2]);
        if (d > 16) diff++;
      }
      const total = a.w * a.h;
      return {
        total,
        diffPx: diff,
        diffPct: ((100 * diff) / total).toFixed(2),
      };
    },
    { bA, bB },
  );
}

async function run() {
  if (!fs.existsSync(OUT_DIR)) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
  }
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: [
      "--enable-unsafe-webgpu",
      "--enable-features=Vulkan",
      "--use-vulkan",
    ],
  });
  const page = await browser.newPage({ viewport: { width: 960, height: 640 } });
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

  // ── 1. Pure WMO mapping assertions + camera setup ──────────────────────────
  const api = await page.evaluate(async () => {
    const C = (window.Cesium =
      window.Cesium || (await import("/Build/CesiumUnminified/index.js")));
    const s = window.viewer.scene;
    s.camera.setView({
      destination: C.Cartesian3.fromDegrees(-122.4, 37.78, 180),
      orientation: { heading: 0, pitch: -C.Math.toRadians(4), roll: 0 },
    });
    const m = (ww) => C.precipFromWmoCode(ww); // {type,intensity}
    return {
      hasMap: typeof C.precipFromWmoCode === "function",
      hasSnowAccum: typeof C.updateSnowAccumulation === "function",
      hasVisScale: typeof C.densityScaleFromVisibility === "function",
      hasSynthetic: typeof C.SyntheticWeatherSource === "function",
      hasProvider: typeof C.WeatherProvider === "function",
      // PrecipitationType: NONE0 RAIN1 SNOW2 FOG3 HAIL4
      cases: {
        c5: m(5),
        c45: m(45),
        c53: m(53),
        c63: m(63),
        c65: m(65),
        c73: m(73),
        c82: m(82),
        c86: m(86),
        c96: m(96),
      },
      // Snow accumulation ramp/melt sanity (pure fn).
      snowRamp: C.updateSnowAccumulation(0.0, true, 1.0, 1.0), // up
      snowMelt: C.updateSnowAccumulation(0.5, false, 0.0, 1.0), // down
      // Visibility coupling: low vis → >1, high vis → ~1.
      visLow: C.densityScaleFromVisibility(1.0),
      visHigh: C.densityScaleFromVisibility(20.0),
      visNone: C.densityScaleFromVisibility(undefined),
    };
  });

  // Helper: attach a synthetic provider with a given ww + visibility, set flags,
  // pump a couple of fetches so getPresentWeather() is populated, then apply.
  async function applyDataDriven(opts) {
    return await page.evaluate(async (o) => {
      const C = (window.Cesium =
        window.Cesium || (await import("/Build/CesiumUnminified/index.js")));
      const s = window.viewer.scene;
      const cond = s.globe.atmosphericConditions;

      // Build + attach the provider when requested.
      if (o.attach) {
        const src = new C.SyntheticWeatherSource("uniform", 0.8, 16, 8, {
          ww: o.ww,
          visibilityKm: o.visibilityKm,
        });
        const provider =
          s.globe.defaultCloudCollection.volumetric.weatherProvider instanceof
          C.WeatherProvider
            ? s.globe.defaultCloudCollection.volumetric.weatherProvider
            : new C.WeatherProvider(src);
        provider.setSource(src);
        s.globe.defaultCloudCollection.volumetric.weatherProvider = provider;
        // Kick the async fetch + wait for getPresentWeather to populate.
        for (let i = 0; i < 30; i++) {
          provider.getPackedTexture(16, 8);
          await new Promise((r) => setTimeout(r, 10));
          if (provider.getPresentWeather()?.ww !== undefined) break;
        }
      }

      // Configure the precip flags.
      cond.effects.auto = false;
      cond.effects.precipitation.dataDriven = o.dataDriven === true;
      cond.effects.precipitation.snowAccumulation = o.snowAccumulation === true;
      if (o.resetSnow) cond.effects.precipitation.snowCover = 0;

      // Manual baseline selection (the OFF-parity case asserts this survives).
      if (o.manual) {
        cond.weather.enabled = o.manual.enabled;
        cond.weather.type = o.manual.type;
        cond.weather.intensity = o.manual.intensity;
      }

      const applyN = o.applyFrames ?? 1;
      let lastSnow = cond.effects.precipitation.snowCover;
      for (let i = 0; i < applyN; i++) {
        C.applyAtmosphericConditions(s);
        lastSnow = cond.effects.precipitation.snowCover;
        // Render a frame so deltaTime advances the snow integrator realistically.
        s.render();
        await new Promise((r) => requestAnimationFrame(r));
      }

      return {
        present: cond.effects.precipitation.dataDriven
          ? (s.globe.defaultCloudCollection.volumetric.weatherProvider?.getPresentWeather?.() ??
            null)
          : null,
        precipLeaf: {
          enabled: cond.effects.precipitation.enabled,
          type: cond.effects.precipitation.type,
          intensity: cond.effects.precipitation.intensity,
          snowCover: cond.effects.precipitation.snowCover,
        },
        sceneEnableWeather: s.enableWeather,
        sceneWeatherType: s.weatherType,
        sceneWeatherIntensity: s.weatherIntensity,
        sceneDensityScale: s.weatherDensityScale,
        sceneSnowCover: s.weatherSnowCover,
        snowCoverFinal: lastSnow,
      };
    }, opts);
  }

  // Settle imagery before captures.
  await burst(page, 200);
  await page.waitForTimeout(1200);

  const canvas = await page.$("#cesiumContainer canvas, canvas");
  const shoot = async (file) => {
    const out = path.join(OUT_DIR, file);
    await canvas.screenshot({ path: out });
    return out;
  };

  // ── 2. PARITY OFF: provider attached (snow ww=73) but dataDriven=false +
  // a manual RAIN selection. The data-driven override must NOT fire — the manual
  // RAIN must survive (weatherType stays 0=rain, NOT 1=snow).
  const off = await applyDataDriven({
    attach: true,
    ww: 73,
    visibilityKm: 2,
    dataDriven: false,
    manual: { enabled: true, type: 0, intensity: 0.8 }, // manual RAIN
  });
  await burst(page, 60);
  const pngOff = await shoot("probe-precip-data-off.png");

  // ── 3. FLAG ON — SNOW (ww=73) ──────────────────────────────────────────────
  const snow = await applyDataDriven({
    attach: true,
    ww: 73,
    visibilityKm: 2,
    dataDriven: true,
    snowAccumulation: true,
    resetSnow: true,
    applyFrames: 20, // ramp the snow-cover scalar across frames
  });
  await burst(page, 60);
  const pngSnow = await shoot("probe-precip-data-snow.png");

  // ── 4. FLAG ON — RAIN (ww=63) ──────────────────────────────────────────────
  const rain = await applyDataDriven({
    attach: true,
    ww: 63,
    visibilityKm: 8,
    dataDriven: true,
  });
  await burst(page, 60);
  const pngRain = await shoot("probe-precip-data-rain.png");

  // ── 5/6. VISIBILITY coupling: low vis (ww=65, vis=1) → densityScale > 1 ──────
  const visLowState = await applyDataDriven({
    attach: true,
    ww: 65,
    visibilityKm: 1,
    dataDriven: true,
  });
  const visHighState = await applyDataDriven({
    attach: true,
    ww: 65,
    visibilityKm: 20,
    dataDriven: true,
  });

  // ── 7. SNOW melt: stop precip (ww=0/NONE), snowAccumulation on → cover drops ──
  // Re-use the accumulated cover from the snow case by NOT resetting; ww=2 (clear).
  const melt = await applyDataDriven({
    attach: true,
    ww: 2,
    dataDriven: true,
    snowAccumulation: true,
    applyFrames: 30,
  });

  await armWebGPUDevices(page);
  const gate = await collectGateErrors(page);

  const snowVsRain = await diffPngs(page, pngSnow, pngRain);
  const offVsSnow = await diffPngs(page, pngOff, pngSnow);

  const report = {
    api,
    states: { off, snow, rain, visLowState, visHighState, melt },
    diffs: { snowVsRain, offVsSnow },
  };
  console.log(JSON.stringify(report, null, 1));

  const fatal = [
    ...consoleErrors,
    ...gate.errors,
    ...(gate.deviceLost ? [gate.deviceLost] : []),
  ];

  const c = api.cases;
  // PrecipitationType: NONE0 RAIN1 SNOW2 FOG3 HAIL4
  const checks = [
    [
      "precipFromWmoCode + helpers exported",
      api.hasMap && api.hasSnowAccum && api.hasVisScale,
    ],
    [
      "SyntheticWeatherSource + WeatherProvider exported",
      api.hasSynthetic && api.hasProvider,
    ],
    [`ww 5 → NONE (type=${c.c5.type})`, c.c5.type === 0],
    [`ww 45 → FOG (type=${c.c45.type})`, c.c45.type === 3],
    [`ww 53 → RAIN drizzle (type=${c.c53.type})`, c.c53.type === 1],
    [`ww 63 → RAIN (type=${c.c63.type})`, c.c63.type === 1],
    [`ww 73 → SNOW (type=${c.c73.type})`, c.c73.type === 2],
    [`ww 86 → SNOW shower (type=${c.c86.type})`, c.c86.type === 2],
    [`ww 96 → HAIL (type=${c.c96.type})`, c.c96.type === 4],
    [
      `heavier intensity within band (53<63 drizzle vs rain not compared; 63 ${c.c63.intensity.toFixed(2)} > 53 ${c.c53.intensity.toFixed(2)})`,
      c.c63.intensity > c.c53.intensity,
    ],
    [`snow ramp up (${api.snowRamp.toFixed(3)} > 0)`, api.snowRamp > 0],
    [`snow melt down (${api.snowMelt.toFixed(3)} < 0.5)`, api.snowMelt < 0.5],
    [
      `vis coupling: low(${api.visLow.toFixed(2)}) > high(${api.visHigh.toFixed(2)}) ≈ 1`,
      api.visLow > api.visHigh &&
        Math.abs(api.visHigh - 1) < 0.01 &&
        api.visNone === 1,
    ],

    // PARITY OFF — manual RAIN survives, snow ww does NOT leak in.
    [
      `PARITY OFF: dataDriven=false keeps manual RAIN (weatherType=${off.sceneWeatherType} === 0, present=${JSON.stringify(off.present)})`,
      off.sceneWeatherType === 0 &&
        off.sceneEnableWeather === true &&
        off.present === null,
    ],
    [
      `PARITY OFF: no densityScale/snowCover written (densityScale=${off.sceneDensityScale}, snowCover=${off.sceneSnowCover})`,
      (off.sceneDensityScale === undefined || off.sceneDensityScale === null) &&
        (off.sceneSnowCover === undefined || off.sceneSnowCover === null),
    ],

    // FLAG ON SNOW
    [
      `FLAG ON SNOW: provider present ww=${snow.present?.ww}, scene flips to SNOW (weatherType=${snow.sceneWeatherType} === 1, enabled=${snow.sceneEnableWeather})`,
      snow.present?.ww === 73 &&
        snow.sceneWeatherType === 1 &&
        snow.sceneEnableWeather === true,
    ],
    [
      `FLAG ON SNOW: snowCover ramped > 0 (${snow.snowCoverFinal?.toFixed?.(3)})`,
      typeof snow.snowCoverFinal === "number" && snow.snowCoverFinal > 0,
    ],

    // FLAG ON RAIN
    [
      `FLAG ON RAIN: ww=${rain.present?.ww} → scene RAIN (weatherType=${rain.sceneWeatherType} === 0, enabled=${rain.sceneEnableWeather})`,
      rain.present?.ww === 63 &&
        rain.sceneWeatherType === 0 &&
        rain.sceneEnableWeather === true,
    ],

    // VISIBILITY coupling end-to-end
    [
      `VIS coupling: low-vis densityScale(${visLowState.sceneDensityScale?.toFixed?.(2)}) > high-vis(${visHighState.sceneDensityScale?.toFixed?.(2)})`,
      visLowState.sceneDensityScale > visHighState.sceneDensityScale,
    ],

    // SNOW melt
    [
      `SNOW melt: cover dropped after precip stop (${melt.snowCoverFinal?.toFixed?.(3)} < snow ${snow.snowCoverFinal?.toFixed?.(3)})`,
      melt.snowCoverFinal < snow.snowCoverFinal,
    ],

    // VISUAL: snow vs rain differ
    [
      `SNOW vs RAIN screenshots differ (diff ${snowVsRain?.diffPx}px / ${snowVsRain?.diffPct}%)`,
      snowVsRain && !snowVsRain.error && snowVsRain.diffPx > 300,
    ],

    [`0 device / validation errors`, fatal.length === 0],
  ];

  console.log("\n=== ANALYSIS ===");
  let pass = true;
  for (const [n, ok] of checks) {
    console.log(`  [${ok ? "PASS" : "FAIL"}] ${n}`);
    if (!ok) pass = false;
  }
  if (fatal.length) {
    console.log("\n  device/console errors:");
    fatal.slice(0, 8).forEach((e) => console.log(`    ${e}`));
  }
  console.log(`\nPNGs: ${pngOff}, ${pngSnow}, ${pngRain}`);
  console.log(`\nRESULT: ${pass ? "GREEN" : "RED"}`);
  await browser.close();
  process.exitCode = pass ? 0 : 1;
}
run();
