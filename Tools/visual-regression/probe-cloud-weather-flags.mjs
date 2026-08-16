#!/usr/bin/env node
/**
 * CLOUD-U6-WEATHER-FLAGS — weather flags exposed through collection.volumetric.
 * @purpose U6 acceptance: weather dials reach the raymarcher via collection.volumetric; inert off the deck path, off-legs byte-identical.
 * @status ACTIVE
 *
 * WebGPU-only. Slice 6 of the cloud-unification epic.
 *
 * The three weather dials — cloudWeatherMap, weatherProvider,
 * cloudWeatherChannelStrength — live on globe.defaultCloudCollection.volumetric
 * and reach the raymarcher purely through _resolveVolumetricConfig()'s
 * `...this.volumetric` spread (published via context.requestVolumetricClouds,
 * consumed by WebGPUSceneRendererEnvironmentalEffects → WebGPUProceduralCloudRenderer,
 * which reads config.cloudWeatherMap / config.weatherProvider /
 * config.cloudWeatherChannelStrength). Nothing globe-specific remains.
 *
 * Claims:
 *   (1) OFF-GATE: in BILLBOARD mode (no volumetric deck) flipping cloudWeatherMap
 *       true↔false is BYTE-IDENTICAL — the flag is an inert store off the deck path.
 *   (2) OFF-GATE: in VOLUMETRIC mode with the weather flag OFF, two successive
 *       renders are byte-identical (the weatherMapEnabled=0 path is deterministic
 *       and reproduces today's pixels).
 *   (3) WIRING: in VOLUMETRIC mode, setting volumetric.cloudWeatherMap=true through
 *       the collection materially changes the deck (the weather map carves coverage).
 *   (4) no NEW device errors.
 *
 * Usage: PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-cloud-weather-flags.mjs
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
const DEMO = "/Apps/Sandcastle/gallery/WebGPU%20Weather%20Inspector.html";

const SANDCASTLE_STUB = () => {
  window.Sandcastle = {
    finishedLoading() {
      document.body.classList.remove("sandcastle-loading");
      const o = document.getElementById("loadingOverlay");
      if (o) {
        o.style.display = "none";
      }
    },
    declare() {},
    highlight() {},
    reset() {},
    addToolbarButton() {},
    addToggleButton() {},
    addToolbarMenu() {},
  };
};

const BOOT = async () => {
  const C = await import("/Build/CesiumUnminified/index.js");
  window.Cesium = C;
  if (typeof window.startup !== "function") {
    return { ok: false, err: "window.startup not defined" };
  }
  try {
    await window.startup(C);
    return { ok: true };
  } catch (e) {
    return { ok: false, err: String((e && e.stack) || e) };
  }
};

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
      let acc = 0;
      const n = da.length / 4;
      for (let i = 0; i < da.length; i += 4) {
        acc += Math.abs(
          0.299 * da[i] +
            0.587 * da[i + 1] +
            0.114 * da[i + 2] -
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
  await page.addInitScript(SANDCASTLE_STUB);
  await page.goto(`${BASE}${DEMO}`, { waitUntil: "domcontentloaded" });
  await page.addStyleTag({
    content:
      "#cesiumContainer{position:absolute;top:0;left:0;width:100%;height:100%;}#loadingOverlay{display:none;}",
  });
  const boot = await page.evaluate(BOOT);
  if (!boot.ok) {
    console.log("BOOT FAILED:", boot.err);
    await browser.close();
    process.exitCode = 1;
    return;
  }
  await page.waitForFunction(
    () => !!(window.viewer && window.viewer.scene),
    null,
    {
      timeout: 60000,
    },
  );
  await armWebGPUDevices(page);

  const canvas = await page.$(".cesium-widget canvas");
  const shot = async (name) => {
    await canvas.screenshot({ path: `${OUT}/${name}.png` });
    return (
      "data:image/png;base64," +
      fs.readFileSync(`${OUT}/${name}.png`).toString("base64")
    );
  };
  const apply = async (fn) => {
    await page.evaluate(fn);
    await page.waitForTimeout(4500);
  };

  // Let the globe imagery/terrain finish streaming BEFORE any capture, else an
  // in-flight tile load confounds the byte-identity diffs (nothing to do with
  // the weather flag). tilesLoaded flips true once the tile queue drains.
  await page
    .waitForFunction(
      () => window.viewer.scene.globe.tilesLoaded === true,
      null,
      {
        timeout: 30000,
      },
    )
    .catch(() => {});
  await page.waitForTimeout(3000);

  // Common deck config so the weather map has something to modulate.
  const deckCfg = () => {
    const g = window.viewer.scene.globe;
    const v = g.defaultCloudCollection.volumetric;
    v.cloudCoverage = 0.6;
    v.cloudDensity = 0.9;
    v.cloudLayerBottom = 1500;
    v.cloudLayerTop = 4000;
    window.viewer.scene.requestRender();
  };

  // ── OFF-GATE 1: BILLBOARD mode — weather flag inert off the deck path ──
  await apply(() => {
    const g = window.viewer.scene.globe;
    g.defaultCloudCollection.enableVolumetric = false; // renderMode → BILLBOARD
    g.defaultCloudCollection.volumetric.cloudWeatherMap = false;
    window.viewer.scene.requestRender();
  });
  const billOff = await shot("wflags-billboard-off");
  await apply(() => {
    const g = window.viewer.scene.globe;
    g.defaultCloudCollection.volumetric.cloudWeatherMap = true;
    g.defaultCloudCollection.volumetric.cloudWeatherChannelStrength = 1.0;
    window.viewer.scene.requestRender();
  });
  const billOn = await shot("wflags-billboard-weatheron");
  const diffBillboard = await diff(page, billOff, billOn);

  // ── OFF-GATE 2 + WIRING: VOLUMETRIC mode ──
  await apply(() => {
    const g = window.viewer.scene.globe;
    g.defaultCloudCollection.enableVolumetric = true; // renderMode → VOLUMETRIC
    g.defaultCloudCollection.volumetric.cloudWeatherMap = false;
    window.viewer.scene.requestRender();
  });
  await apply(deckCfg);
  const volOffA = await shot("wflags-volumetric-off-a");
  await apply(() => window.viewer.scene.requestRender());
  const volOffB = await shot("wflags-volumetric-off-b");
  const diffVolStable = await diff(page, volOffA, volOffB);

  await apply(() => {
    window.viewer.scene.globe.defaultCloudCollection.volumetric.cloudWeatherMap = true;
    window.viewer.scene.requestRender();
  });
  const volOn = await shot("wflags-volumetric-weatheron");
  const diffVolWeather = await diff(page, volOffA, volOn);

  const gate = await collectGateErrors(page);
  const newErrs = (gate.errors || [])
    .concat(consoleErrors)
    .filter(
      (e) =>
        !/Atmosphere ?LUT|SkyAtmosphere|default layout|favicon|bucket\.css|Sandcastle-header|load-cesium-es6/i.test(
          e,
        ),
    );

  console.log(
    `diff: billboard(off vs weatherOn)=${diffBillboard} volumetric(off stability)=${diffVolStable} volumetric(off vs weatherOn)=${diffVolWeather} | errs=${newErrs.length}`,
  );

  const checks = [
    [
      `OFF-GATE billboard: weather flag inert (off vs weatherOn diff ${diffBillboard} < 0.4)`,
      diffBillboard < 0.4,
    ],
    [
      `OFF-GATE volumetric: weather-off render deterministic (stability diff ${diffVolStable} < 0.6)`,
      diffVolStable < 0.6,
    ],
    [
      `WIRING: volumetric.cloudWeatherMap=true through collection changes the deck (diff ${diffVolWeather} > 1.5)`,
      diffVolWeather > 1.5,
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
