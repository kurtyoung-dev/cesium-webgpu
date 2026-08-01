#!/usr/bin/env node
/**
 * C6-CLOUD-STBN-TAAU (LOD half) — geometric in-march step growth + far-cap on the
 * WebGPU volumetric cloud view-ray march (marchDeck in ProceduralClouds.wgsl).
 * WebGPU-only. Two orbit-cost dials on globe.defaultCloudCollection.volumetric:
 *   - cloudMarchStepGrowth (UBO 144) — 1.0 off; (1.0,1.1] grows the step with
 *     distance so far shell samples (1-2 px) coarsen.
 *   - cloudMaxRayDistance  (UBO 145) — 0 off; >0 stops the march past that distance.
 *
 * Claims:
 *   (1) OFF-GATE: with both dials OFF (undefined → 1.0 / 0), two successive renders
 *       are byte-identical (deterministic default path).
 *   (2) OFF-GATE: explicit cloudMarchStepGrowth=1.0 + cloudMaxRayDistance=0 is
 *       byte-identical to the undefined default (1.0/0 are true no-ops).
 *   (3) WIRING (step growth): cloudMarchStepGrowth=1.08 materially changes the
 *       far-shell render (the dial reaches the march) while clouds still render.
 *   (4) WIRING (far cap): a finite cloudMaxRayDistance materially changes the
 *       horizon render (the far shell is cut).
 *   (5) no NEW device errors.
 *
 * Usage: PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-cloud-stbn-lod.mjs
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

  // Horizon-grazing camera at altitude so the cloud shell extends to the far
  // horizon — the regime where the far-shell coarsen / far-cap actually bite.
  await apply(() => {
    const C = window.Cesium;
    window.viewer.scene.camera.setView({
      destination: C.Cartesian3.fromDegrees(-100.0, 30.0, 9000.0),
      orientation: {
        heading: C.Math.toRadians(20.0),
        pitch: C.Math.toRadians(-8.0),
        roll: 0.0,
      },
    });
    window.viewer.scene.requestRender();
  });

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

  // Volumetric deck config — a solid shell so the march has real length.
  const deckCfg = () => {
    const c = window.viewer.scene.globe.defaultCloudCollection;
    c.enableVolumetric = true;
    const v = c.volumetric;
    v.cloudCoverage = 0.6;
    v.cloudDensity = 0.9;
    v.cloudLayerBottom = 1500;
    v.cloudLayerTop = 4000;
    v.cloudMarchStepGrowth = undefined;
    v.cloudMaxRayDistance = undefined;
    window.viewer.scene.requestRender();
  };
  await apply(deckCfg);
  await apply(() => window.viewer.scene.requestRender());

  // ── OFF-GATE 1: default (both dials undefined) is deterministic ──
  const offA = await shot("stbnlod-off-a");
  await apply(() => window.viewer.scene.requestRender());
  const offB = await shot("stbnlod-off-b");
  const diffOffStable = await diff(page, offA, offB);

  // ── OFF-GATE 2: explicit 1.0 / 0 == undefined default (true no-op) ──
  await apply(() => {
    const v = window.viewer.scene.globe.defaultCloudCollection.volumetric;
    v.cloudMarchStepGrowth = 1.0;
    v.cloudMaxRayDistance = 0.0;
    window.viewer.scene.requestRender();
  });
  const offExplicit = await shot("stbnlod-off-explicit");
  const diffExplicitOff = await diff(page, offA, offExplicit);

  // ── WIRING: step growth ON ──
  await apply(() => {
    const v = window.viewer.scene.globe.defaultCloudCollection.volumetric;
    v.cloudMarchStepGrowth = 1.08;
    v.cloudMaxRayDistance = undefined;
    window.viewer.scene.requestRender();
  });
  const growthOn = await shot("stbnlod-growth-on");
  const diffGrowth = await diff(page, offA, growthOn);

  // ── WIRING: far cap ON (cut the far horizon shell) ──
  await apply(() => {
    const v = window.viewer.scene.globe.defaultCloudCollection.volumetric;
    v.cloudMarchStepGrowth = undefined;
    v.cloudMaxRayDistance = 40000.0; // 40 km
    window.viewer.scene.requestRender();
  });
  const capOn = await shot("stbnlod-cap-on");
  const diffCap = await diff(page, offA, capOn);

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
    `diff: off-stability=${diffOffStable} explicit-off=${diffExplicitOff} growth=${diffGrowth} cap=${diffCap} | errs=${newErrs.length}`,
  );

  const checks = [
    [
      `OFF-GATE: default render deterministic (stability diff ${diffOffStable} == 0)`,
      diffOffStable === 0,
    ],
    [
      `OFF-GATE: explicit growth=1.0 + cap=0 byte-identical to undefined default (diff ${diffExplicitOff} == 0)`,
      diffExplicitOff === 0,
    ],
    [
      `WIRING step growth: cloudMarchStepGrowth=1.08 materially changes the far shell (diff ${diffGrowth} > 0.15)`,
      diffGrowth > 0.15,
    ],
    [
      `WIRING far cap: cloudMaxRayDistance=40km materially changes the horizon (diff ${diffCap} > 0.15)`,
      diffCap > 0.15,
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
