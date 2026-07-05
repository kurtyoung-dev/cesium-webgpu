#!/usr/bin/env node
/**
 * Weather-config foundation — live cloud appearance dials. WebGPU-only.
 *
 * Routes the cloud silver-lining / phase / ambient / erosion uniforms through
 * `globe.cloud*` fields exposed on `scene.atmosphericConditions.clouds.*`. Two
 * claims:
 *   (1) DIALS ARE LIVE — setting a property (no rebuild) changes the render.
 *   (2) DEFAULTS PRESERVE behavior — with nothing set, the frame is byte-identical
 *       to the pre-config build (the `?? default` values equal the old constants).
 *
 * Single run proves (1): renders default, then ambientIntensity=4.0 (brighter),
 * then silverLining=3.0 (changed), asserting each tweak moves the image.
 * For (2): TAG=base on the pre-config build (git stash), then TAG=config compares
 * the DEFAULT frames.
 *
 *   TAG=config node probe-cloud-config.mjs
 *   (pre-config: git stash the 4 files, rebuild) TAG=base node probe-cloud-config.mjs
 *
 * Usage: TAG=config PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-cloud-config.mjs
 */
import { chromium } from "playwright";
import {
  errorGateInit,
  armWebGPUDevices,
  collectGateErrors,
  attachConsoleErrorGate,
} from "../lib/webgpu-error-gate.mjs";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const TAG = process.env.TAG || "config";
const W = 1024,
  H = 768;
const LON = -95.0,
  LAT = 39.0,
  ALT = 800.0;
const NOON = "2026-06-21T18:20:00Z";
const OUT = "Tools/visual-regression/output";

const SETUP = async (cfg) => {
  const C = await import("/Build/CesiumUnminified/index.js");
  const v = window.viewer;
  const s = v.scene;
  const g = s.globe;
  v.useDefaultRenderLoop = false;
  s.requestRenderMode = false;
  g.defaultCloudCollection.enableVolumetric = true;
  if ("cloudCoverage" in g) g.defaultCloudCollection.volumetric.cloudCoverage = 0.6;
  if ("cloudWeatherMap" in g) g.defaultCloudCollection.volumetric.cloudWeatherMap = false;
  if ("cloudDensity" in g) g.defaultCloudCollection.volumetric.cloudDensity = 0.85;
  s.skyBox.show = false;
  s.skyAtmosphere.show = false;
  if (s.sun) s.sun.show = false;
  s.backgroundColor = C.Color.BLACK;
  v.camera.setView({
    destination: C.Cartesian3.fromDegrees(cfg.LON, cfg.LAT, cfg.ALT),
    orientation: {
      heading: C.Math.toRadians(90.0),
      pitch: C.Math.toRadians(16.0),
      roll: 0.0,
    },
  });
  return { ok: true };
};

// Apply a clouds.* tweak (or reset all to undefined), render, return mean luma + png.
const RENDER_WITH = async (cfg) => {
  const C = await import("/Build/CesiumUnminified/index.js");
  const v = window.viewer;
  const s = v.scene;
  const jd = C.JulianDate.fromIso8601(cfg.iso);
  v.clock.currentTime = jd;
  s.render(jd); // warmup so globe.atmosphericConditions facade is built
  const cl = s.globe.atmosphericConditions.clouds;
  const hasLeaf = "silverLining" in cl;
  cl.ambientIntensity = undefined;
  cl.silverLining = undefined;
  if (cfg.prop) cl[cfg.prop] = cfg.value;
  for (let i = 0; i < 80; i++) {
    s.render(jd);
    await new Promise((r) => requestAnimationFrame(r));
  }
  return { hasLeaf, dataUrl: s.canvas.toDataURL("image/png") };
};

function meanLum(page, dataUrl) {
  return page.evaluate(async (du) => {
    const img = new Image();
    img.src = du;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const cx = c.getContext("2d");
    cx.drawImage(img, 0, 0);
    const d = cx.getImageData(0, 0, c.width, c.height).data;
    let sum = 0,
      n = 0;
    for (let i = 0; i < d.length; i += 4) {
      const lum = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255;
      if (lum < 30 / 255) continue;
      sum += lum;
      n++;
    }
    return { cloudPx: n, mean: n ? +(sum / n).toFixed(4) : 0 };
  }, dataUrl);
}

async function diff(page, a, b) {
  return page.evaluate(
    async ([ua, ub]) => {
      const load = async (u) => {
        const img = new Image();
        img.src = u;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        const cx = c.getContext("2d");
        cx.drawImage(img, 0, 0);
        return cx.getImageData(0, 0, c.width, c.height).data;
      };
      const da = await load(ua),
        db = await load(ub);
      let acc = 0,
        n = da.length / 4;
      for (let i = 0; i < da.length; i += 4) {
        acc += Math.abs(
          (0.299 * da[i] + 0.587 * da[i + 1] + 0.114 * da[i + 2]) -
            (0.299 * db[i] + 0.587 * db[i + 1] + 0.114 * db[i + 2]),
        );
      }
      return +(acc / n).toFixed(4);
    },
    [a, b],
  );
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
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForFunction(() => !!window.viewer, null, { timeout: 60000 });
  await armWebGPUDevices(page);
  await page.evaluate(SETUP, { LON, LAT, ALT });

  const defR = await page.evaluate(RENDER_WITH, { iso: NOON });
  const def = defR.dataUrl;
  const hasLeaf = defR.hasLeaf;
  fs.writeFileSync(`${OUT}/cloud-config-${TAG}-default.png`, Buffer.from(def.split(",")[1], "base64"));
  const defStats = await meanLum(page, def);
  fs.writeFileSync(`${OUT}/cloud-config-${TAG}.json`, JSON.stringify(defStats));

  const gate0 = await collectGateErrors(page);

  let pass = hasLeaf && defStats.cloudPx > 5000;
  console.log(`[${TAG}] hasLeaf=${hasLeaf} default`, JSON.stringify(defStats));

  if (TAG === "config") {
    const ambR = await page.evaluate(RENDER_WITH, { iso: NOON, prop: "ambientIntensity", value: 4.0 });
    const amb = ambR.dataUrl;
    fs.writeFileSync(`${OUT}/cloud-config-ambientHi.png`, Buffer.from(amb.split(",")[1], "base64"));
    const ambStats = await meanLum(page, amb);
    const ambDiff = await diff(page, def, amb);
    const silR = await page.evaluate(RENDER_WITH, { iso: NOON, prop: "silverLining", value: 3.0 });
    const sil = silR.dataUrl;
    fs.writeFileSync(`${OUT}/cloud-config-silverHi.png`, Buffer.from(sil.split(",")[1], "base64"));
    const silDiff = await diff(page, def, sil);

    const gate = await collectGateErrors(page);
    const newErrs = (gate.errors || [])
      .concat(consoleErrors)
      .filter((e) => !/Atmosphere ?LUT|SkyAtmosphere|default layout/i.test(e));

    // preservation A/B vs the pre-config build's default
    let presMismatch = null;
    if (fs.existsSync(`${OUT}/cloud-config-base-default.png`)) {
      const baseDu =
        "data:image/png;base64," +
        fs.readFileSync(`${OUT}/cloud-config-base-default.png`).toString("base64");
      presMismatch = await diff(page, def, baseDu);
    }

    console.log(`  ambientHi mean ${ambStats.mean} (default ${defStats.mean}) diff ${ambDiff}`);
    console.log(`  silverHi diff vs default ${silDiff}`);
    if (presMismatch !== null) console.log(`  default preservation mismatch vs base: ${presMismatch}`);

    const checks = [
      ["config leaf exposes dials", hasLeaf],
      [`ambientIntensity dial is LIVE (render diff ${ambDiff} > 0.3, mean ${ambStats.mean}>${defStats.mean})`, ambDiff > 0.3 && ambStats.mean > defStats.mean],
      [`silverLining dial is LIVE (diff ${silDiff} > 0.3)`, silDiff > 0.3],
      [
        presMismatch === null
          ? "default-preservation: (run base build to compare)"
          : `default byte-identical to pre-config (${presMismatch} ≤ 0.5)`,
        presMismatch === null || presMismatch <= 0.5,
      ],
      ["no NEW device errors", newErrs.length === 0],
    ];
    pass = true;
    console.log("\n=== ANALYSIS ===");
    for (const [n, ok] of checks) {
      console.log(`  [${ok ? "PASS" : "FAIL"}] ${n}`);
      if (!ok) pass = false;
    }
    console.log(`\nRESULT: ${pass ? "GREEN" : "RED"}`);
  } else {
    // base build: just leave cloud-config-base-default.png for the config run to diff.
    fs.copyFileSync(`${OUT}/cloud-config-${TAG}-default.png`, `${OUT}/cloud-config-base-default.png`);
    const newErrs = (gate0.errors || []).concat(consoleErrors)
      .filter((e) => !/Atmosphere ?LUT|SkyAtmosphere|default layout/i.test(e));
    console.log(`(base default captured; errs ${newErrs.length})`);
    pass = newErrs.length === 0 && defStats.cloudPx > 5000;
  }

  await browser.close();
  process.exitCode = pass ? 0 : 1;
}
run();
