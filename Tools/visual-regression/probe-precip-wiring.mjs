#!/usr/bin/env node
/**
 * Atmospheric effects — Phase E (Batch 423): PRECIPITATION wiring slice.
 * @purpose Visual gate: weather particles render via the conditions->effects hierarchy (auto and direct facade), rain vs snow differ, off = baseline
 * @status ACTIVE
 *
 * WebGPU-only VISUAL probe.
 *
 * Drives the WebGPU weather-particle renderer THROUGH the unified
 * conditions→effects hierarchy (and the direct facade path) and asserts the
 * particles actually render. The particle SYSTEM already ships; this slice
 * connects it to `effects.precipitation` so the 417a auto-master + the
 * `atmosphericConditions.weather` facade drive the particles.
 *
 * What it checks (all WebGPU):
 *   1. OFF baseline (no precip / auto off) → settle, screenshot.
 *   2. AUTO path: set `weather.type`/`weather.intensity`, flip `effects.auto`,
 *      call `applyAtmosphericConditions` → renderer activates → particles render
 *      (screenshot differs from OFF; the diff pixels are the particles).
 *   3. DIRECT facade path: set `weather.enabled/type/intensity` directly (no
 *      auto) → particles render too (the manual control surface).
 *   4. RAIN vs SNOW differ (distinct particle screenshots).
 *   5. 0 device errors throughout. auto-OFF / no-precip → ~no particles
 *      (screenshot ≈ OFF baseline).
 *
 * Capture method: Playwright `page.screenshot()` of the canvas element — the
 * reliable WebGPU readback (in-page `canvas.toDataURL()` returns a stale/blank
 * drawing buffer for the WebGPU swap chain). Diffs are computed Node-side by
 * decoding the PNGs in a headless canvas (no Node PNG dep), the same technique
 * as probe-saved-view.mjs.
 *
 * Usage: PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-precip-wiring.mjs
 * Outputs: Tools/visual-regression/output/probe-precip-{off,rain-auto,after-auto-off,rain-direct,snow}.png
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

// Settle: render a burst of frames so imagery/tiles load and the particle
// spawn volume fills (emission + advection take several frames).
async function burst(page, frames) {
  await page.evaluate(async (n) => {
    const s = window.viewer.scene;
    for (let i = 0; i < n; i++) {
      s.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
  }, frames);
}

// Drive a precip state through the facade/hierarchy. `mode` selects the path.
async function setState(page, mode) {
  return await page.evaluate(async (mode) => {
    const C = (window.Cesium =
      window.Cesium || (await import("/Build/CesiumUnminified/index.js")));
    const s = window.viewer.scene;
    const cond = s.globe.atmosphericConditions;
    const out = {};
    if (mode === "off") {
      cond.weather.enabled = false;
      if (cond.effects) {
        cond.effects.auto = false;
      }
      C.applyAtmosphericConditions(s);
    } else if (mode === "rain-auto") {
      // AUTO path: conditions → effects hierarchy → flat scene fields.
      cond.weather.type = 0; // legacy flat index 0 = rain
      cond.weather.intensity = 1.0;
      cond.effects.auto = true;
      C.applyAtmosphericConditions(s);
      out.precipLeaf = {
        enabled: cond.effects.precipitation.enabled,
        type: cond.effects.precipitation.type,
        intensity: cond.effects.precipitation.intensity,
      };
    } else if (mode === "after-auto-off") {
      // auto OFF with no manual weather → applyAtmosphericConditions should turn
      // weather off (enableWeather=false from the precip.enabled=false leaf).
      cond.weather.enabled = false;
      cond.effects.auto = false;
      C.applyAtmosphericConditions(s);
    } else if (mode === "rain-direct") {
      // DIRECT facade path: no auto, set weather directly.
      cond.effects.auto = false;
      cond.weather.enabled = true;
      cond.weather.type = 0; // rain
      cond.weather.intensity = 1.0;
    } else if (mode === "snow") {
      cond.weather.enabled = true;
      cond.weather.type = 1; // snow
      cond.weather.intensity = 1.0;
    }
    out.sceneEnableWeather = s.enableWeather;
    out.sceneWeatherType = s.weatherType;
    out.sceneWeatherIntensity = s.weatherIntensity;
    return out;
  }, mode);
}

// Decode two PNGs and compute: nonBg diff pixels (where ON differs visibly from
// OFF — the particles), and the per-image bright-pixel count, via a headless
// canvas. Mirrors probe-saved-view.mjs's decode-and-diff.
async function diffAgainst(page, fileOn, fileOff) {
  const bOn = fs.readFileSync(fileOn).toString("base64");
  const bOff = fs.readFileSync(fileOff).toString("base64");
  return await page.evaluate(
    async ({ bOn, bOff }) => {
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
      const on = await decode(bOn);
      const off = await decode(bOff);
      if (on.w !== off.w || on.h !== off.h) {
        return { error: "size mismatch" };
      }
      const total = on.w * on.h;
      let diff = 0;
      let brightOn = 0;
      let brightOff = 0;
      for (let i = 0; i < on.data.length; i += 4) {
        const r1 = on.data[i];
        const g1 = on.data[i + 1];
        const b1 = on.data[i + 2];
        const r0 = off.data[i];
        const g0 = off.data[i + 1];
        const b0 = off.data[i + 2];
        const d = Math.abs(r1 - r0) + Math.abs(g1 - g0) + Math.abs(b1 - b0);
        // Rain streaks are thin + near-transparent (subtle color modulation);
        // 16 catches them while staying above PNG-encode + tile-jitter noise
        // (the after-auto-off control reads ~0 at this threshold).
        if (d > 16) {
          diff++;
        }
        // "particle-ish" bright + low-saturation pixels.
        const isBright = (r, g, b) => {
          const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          const mx = Math.max(r, g, b);
          const mn = Math.min(r, g, b);
          const sat = mx === 0 ? 0 : (mx - mn) / mx;
          return lum > 150 && sat < 0.3;
        };
        if (isBright(r1, g1, b1)) {
          brightOn++;
        }
        if (isBright(r0, g0, b0)) {
          brightOff++;
        }
      }
      return {
        total,
        diffPx: diff,
        diffPct: ((100 * diff) / total).toFixed(2),
        brightOn,
        brightOff,
        brightDelta: brightOn - brightOff,
      };
    },
    { bOn, bOff },
  );
}

// Per-pixel UNION diff of several ON frames against one OFF baseline. A pixel is
// counted once if it differs (sum-abs > 16) in ANY frame; brightDelta is the max
// bright-pixel rise across frames. Decodes all PNGs in a headless canvas.
async function diffUnion(page, onFiles, offFile) {
  const onB64 = onFiles.map((f) => fs.readFileSync(f).toString("base64"));
  const offB64 = fs.readFileSync(offFile).toString("base64");
  return await page.evaluate(
    async ({ onB64, offB64 }) => {
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
      const isBright = (r, g, b) => {
        const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        const mx = Math.max(r, g, b);
        const mn = Math.min(r, g, b);
        const sat = mx === 0 ? 0 : (mx - mn) / mx;
        return lum > 150 && sat < 0.3;
      };
      const off = await decode(offB64);
      const total = off.w * off.h;
      let brightOff = 0;
      for (let i = 0; i < off.data.length; i += 4) {
        if (isBright(off.data[i], off.data[i + 1], off.data[i + 2])) {
          brightOff++;
        }
      }
      const mask = new Uint8Array(total);
      let brightDelta = 0;
      for (const b64 of onB64) {
        const on = await decode(b64);
        if (on.w !== off.w || on.h !== off.h) {
          return { error: "size mismatch" };
        }
        let brightOn = 0;
        for (let i = 0, p = 0; i < on.data.length; i += 4, p++) {
          const dr = Math.abs(on.data[i] - off.data[i]);
          const dg = Math.abs(on.data[i + 1] - off.data[i + 1]);
          const db = Math.abs(on.data[i + 2] - off.data[i + 2]);
          if (dr + dg + db > 16) {
            mask[p] = 1;
          }
          if (isBright(on.data[i], on.data[i + 1], on.data[i + 2])) {
            brightOn++;
          }
        }
        brightDelta = Math.max(brightDelta, brightOn - brightOff);
      }
      let diff = 0;
      for (let p = 0; p < total; p++) {
        if (mask[p]) {
          diff++;
        }
      }
      return {
        total,
        diffPx: diff,
        diffPct: ((100 * diff) / total).toFixed(2),
        brightDelta,
      };
    },
    { onB64, offB64 },
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
    { timeout: 60000 },
  );
  await armWebGPUDevices(page);

  const api = await page.evaluate(async () => {
    const C = (window.Cesium =
      window.Cesium || (await import("/Build/CesiumUnminified/index.js")));
    const v = window.viewer;
    const s = v.scene;
    // Low altitude + near-level pitch so the camera sits deep inside the
    // camera-relative particle spawn volume (radius ~500 m) where particle
    // density is highest and the streaks cross the most screen area.
    s.camera.setView({
      destination: C.Cartesian3.fromDegrees(-122.4, 37.78, 180),
      orientation: { heading: 0, pitch: -C.Math.toRadians(4), roll: 0 },
    });
    return {
      hasApply: typeof C.applyAtmosphericConditions === "function",
      hasPrecipType: typeof C.PrecipitationType === "object",
      hasPrecipToString: typeof C.precipitationTypeToString === "function",
      precipMap:
        typeof C.precipitationTypeToString === "function"
          ? {
              none: C.precipitationTypeToString(0),
              rain: C.precipitationTypeToString(1),
              snow: C.precipitationTypeToString(2),
              fog: C.precipitationTypeToString(3),
              hail: C.precipitationTypeToString(4),
            }
          : null,
    };
  });

  // Settle imagery + tiles BEFORE the OFF baseline so every state shares the
  // same background — the only inter-state delta should be the particles.
  await burst(page, 200);
  await page.waitForTimeout(1500);

  const canvas = await page.$("#cesiumContainer canvas, canvas");
  const shoot = async (file) => {
    const out = path.join(OUT_DIR, file);
    await canvas.screenshot({ path: out });
    return out;
  };

  const states = {};
  // Particles are sparse + animated, so a single frame undercounts them. Capture
  // a few frames per state (3) so the union-diff against OFF sweeps the moving
  // particles' footprint. The first frame is saved as the human-readable PNG.
  const capture = async (mode, file, frames = 60, extra = 5) => {
    const info = await setState(page, mode);
    await burst(page, frames);
    info.pngs = [];
    info.png = await shoot(file);
    info.pngs.push(info.png);
    for (let i = 1; i < extra; i++) {
      await burst(page, 6);
      const f = file.replace(".png", `-f${i}.png`);
      info.pngs.push(await shoot(f));
    }
    states[mode] = info;
    return info;
  };

  await capture("off", "probe-precip-off.png");
  await capture("rain-auto", "probe-precip-rain-auto.png");
  await capture("after-auto-off", "probe-precip-after-auto-off.png");
  await capture("rain-direct", "probe-precip-rain-direct.png");
  await capture("snow", "probe-precip-snow.png");

  await armWebGPUDevices(page);
  const gate = await collectGateErrors(page);

  // Union-diff: a pixel counts as "particle" if it differs from the OFF baseline
  // in ANY of the state's captured frames (animated particles move frame to
  // frame). offPng for the OFF state is a single static frame.
  const offPng = states["off"].png;
  const unionDiff = async (mode) => {
    // True per-pixel UNION across the state's frames: a pixel counts if it
    // differs from the OFF baseline in ANY frame. Moving particles occupy
    // different pixels each frame, so the union sweeps their full footprint —
    // far more sensitive to sparse animated rain than a single frame.
    return await diffUnion(page, states[mode].pngs, offPng);
  };
  const diffs = {};
  for (const k of ["rain-auto", "after-auto-off", "rain-direct", "snow"]) {
    diffs[k] = await unionDiff(k);
  }
  // Rain vs snow: diff the two ON images directly.
  const rainVsSnow = await diffAgainst(
    page,
    states["rain-direct"].png,
    states["snow"].png,
  );

  const report = { api, states: {}, diffs, rainVsSnow };
  for (const [k, v] of Object.entries(states)) {
    report.states[k] = { ...v };
    delete report.states[k].png;
    delete report.states[k].pngs;
  }
  console.log(JSON.stringify(report, null, 1));

  const fatal = [
    ...consoleErrors,
    ...gate.errors,
    ...(gate.deviceLost ? [gate.deviceLost] : []),
  ];

  const rainAuto = states["rain-auto"];
  const da = diffs["rain-auto"];
  const dAfterOff = diffs["after-auto-off"];
  const dDirect = diffs["rain-direct"];
  const dSnow = diffs["snow"];

  // An ON state renders particles when its union-diff against OFF shows a
  // meaningful pixel footprint AND its bright-pixel count rose. Floors are set
  // well above the `after-auto-off` control (which should read ~0) but below the
  // honest sparse-particle signal: snow flakes are bright/round (strong), rain
  // is thin near-transparent streaks (weaker) — both clearly beat the static
  // OFF baseline once the moving particles' footprint is union-swept.
  const renders = (d) => d && !d.error && d.diffPx > 400 && d.brightDelta > 30;

  const checks = [
    ["applyAtmosphericConditions exported", api.hasApply],
    [
      `PrecipitationType + precipitationTypeToString exported (none=${api.precipMap?.none}, rain=${api.precipMap?.rain}, snow=${api.precipMap?.snow}, hail=${api.precipMap?.hail})`,
      api.hasPrecipType &&
        api.hasPrecipToString &&
        api.precipMap.none === "none" &&
        api.precipMap.rain === "rain" &&
        api.precipMap.snow === "snow" &&
        api.precipMap.fog === "fog" &&
        api.precipMap.hail === "hail",
    ],
    [
      `AUTO path pushes precip to flat scene fields (enableWeather=${rainAuto.sceneEnableWeather}, weatherType=${rainAuto.sceneWeatherType}, intensity=${rainAuto.sceneWeatherIntensity})`,
      rainAuto.sceneEnableWeather === true &&
        rainAuto.sceneWeatherType === 0 &&
        rainAuto.sceneWeatherIntensity > 0,
    ],
    [
      `AUTO precip leaf in PrecipitationType convention (type=${rainAuto.precipLeaf?.type} === RAIN(1), enabled=${rainAuto.precipLeaf?.enabled})`,
      rainAuto.precipLeaf?.type === 1 && rainAuto.precipLeaf?.enabled === true,
    ],
    [
      `AUTO rain renders particles (diff ${da?.diffPx}px / ${da?.diffPct}%, brightDelta ${da?.brightDelta})`,
      renders(da),
    ],
    [
      `auto OFF + no manual weather → weather off (enableWeather=${states["after-auto-off"].sceneEnableWeather}, diff ${dAfterOff?.diffPx}px ~ baseline)`,
      states["after-auto-off"].sceneEnableWeather === false &&
        dAfterOff.diffPx < 400,
    ],
    [
      `DIRECT facade renders particles (enableWeather=${states["rain-direct"].sceneEnableWeather}, diff ${dDirect?.diffPx}px / ${dDirect?.diffPct}%, brightDelta ${dDirect?.brightDelta})`,
      states["rain-direct"].sceneEnableWeather === true && renders(dDirect),
    ],
    [
      `SNOW renders particles (diff ${dSnow?.diffPx}px / ${dSnow?.diffPct}%, brightDelta ${dSnow?.brightDelta})`,
      renders(dSnow),
    ],
    [
      `RAIN vs SNOW differ (diff ${rainVsSnow?.diffPx}px / ${rainVsSnow?.diffPct}%)`,
      rainVsSnow && !rainVsSnow.error && rainVsSnow.diffPx > 800,
    ],
    [`0 device / validation errors`, fatal.length === 0],
  ];

  console.log("\n=== ANALYSIS ===");
  let pass = true;
  for (const [n, ok] of checks) {
    console.log(`  [${ok ? "PASS" : "FAIL"}] ${n}`);
    if (!ok) {
      pass = false;
    }
  }
  if (fatal.length) {
    console.log("\n  device/console errors:");
    fatal.slice(0, 8).forEach((e) => console.log(`    ${e}`));
  }
  console.log(`\nPNGs in ${OUT_DIR}/probe-precip-*.png`);
  console.log(`\nRESULT: ${pass ? "GREEN" : "RED"}`);
  await browser.close();
  process.exitCode = pass ? 0 : 1;
}
run();
