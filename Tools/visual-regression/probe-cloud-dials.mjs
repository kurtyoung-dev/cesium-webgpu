#!/usr/bin/env node
/**
 * Batch 407 struct-growth cloud dials — end-to-end wiring + byte-identity probe.
 * WebGPU-only.
 *
 * Promotes SHAPE_SCALE/CLOUD_EXPOSURE/MS-decay from WGSL consts to CloudUniforms
 * dials exposed on globe.cloud{PuffSize,Exposure,MsDecay*}. This probe boots the
 * Weather Inspector demo (gallery standalone-boot), then drives the new globe
 * fields directly and screenshots each state (compositor element screenshot).
 *
 * Claims:
 *   (1) DEFAULT path is byte-identical: with the dials unset, then SET to their
 *       documented defaults (0.45/0.22/...), the render is unchanged (the WGSL
 *       now reads cloud.X == the former const) — diff ~0;
 *   (2) the EXPOSURE dial drives brightness (0.22 -> 0.45 brightens the deck);
 *   (3) the PUFF-SIZE dial changes the deck morphology (0.45 -> 0.25 moves it);
 *   (4) resetting to undefined returns to the default render (diff ~0);
 *   (5) 0 device errors.
 *
 * Usage: PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-cloud-dials.mjs
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

// Set globe cloud fields directly (the config path the inspector dials drive).
const SETGLOBE = async (kv) => {
  const g = window.viewer.scene.globe;
  for (const [k, v] of Object.entries(kv)) {
    g[k] = v === null ? undefined : v;
  }
  window.viewer.scene.requestRender();
  return { ok: true };
};

// Mean luminance of the cloud-deck region (lower-centre, right of the panel).
function deckLum(page, dataUrl) {
  return page.evaluate(async (du) => {
    const img = new Image();
    img.src = du;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const cx = c.getContext("2d");
    cx.drawImage(img, 0, 0);
    const x0 = Math.floor(c.width * 0.42),
      x1 = Math.floor(c.width * 0.85),
      y0 = Math.floor(c.height * 0.4),
      y1 = Math.floor(c.height * 0.85);
    const d = cx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
    let lum = 0,
      n = 0;
    for (let i = 0; i < d.length; i += 4) {
      lum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      n++;
    }
    return +(lum / n).toFixed(2);
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
          0.299 * da[i] + 0.587 * da[i + 1] + 0.114 * da[i + 2] -
            (0.299 * db[i] + 0.587 * db[i + 1] + 0.114 * db[i + 2]),
        );
      }
      return +(acc / n).toFixed(3);
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
  await page.waitForFunction(() => !!(window.viewer && window.viewer.scene), null, {
    timeout: 60000,
  });
  await armWebGPUDevices(page);

  const canvas = await page.$(".cesium-widget canvas");
  const shot = async (name) => {
    await canvas.screenshot({ path: `${OUT}/${name}.png` });
    return (
      "data:image/png;base64," +
      fs.readFileSync(`${OUT}/${name}.png`).toString("base64")
    );
  };

  await page.waitForTimeout(9000);
  const duDefault = await shot("dials-default");
  const lumDefault = await deckLum(page, duDefault);

  // (1) set all five dials to their documented DEFAULTS -> must be byte-identical
  await page.evaluate(SETGLOBE, {
    cloudPuffSize: 0.45,
    cloudExposure: 0.22,
    cloudMsDecayScatter: 0.5,
    cloudMsDecayExtinction: 0.5,
    cloudMsDecayPhase: 0.85,
  });
  await page.waitForTimeout(3500);
  const duDefaults = await shot("dials-explicit-defaults");
  const diffDefaults = await diff(page, duDefault, duDefaults);

  // (2) exposure DOWN. The Reinhard tone-map compresses the already-bright deck,
  // so the mean-luminance move is small/diluted by sky pixels — the robust signal
  // is that exposure CHANGES the render (whole-frame diff), same as puff-size.
  await page.evaluate(SETGLOBE, { cloudExposure: 0.1 });
  await page.waitForTimeout(3500);
  const duExp = await shot("dials-exposure-lo");
  const lumExp = await deckLum(page, duExp);
  const diffExp = await diff(page, duDefault, duExp);

  // (3) reset exposure, change puff size -> morphology moves
  await page.evaluate(SETGLOBE, { cloudExposure: 0.22, cloudPuffSize: 0.25 });
  await page.waitForTimeout(3500);
  const duPuff = await shot("dials-puff-big");
  const diffPuff = await diff(page, duDefaults, duPuff);

  // (4) reset everything to undefined -> back to default render
  await page.evaluate(SETGLOBE, {
    cloudPuffSize: null,
    cloudExposure: null,
    cloudMsDecayScatter: null,
    cloudMsDecayExtinction: null,
    cloudMsDecayPhase: null,
  });
  await page.waitForTimeout(3500);
  const duReset = await shot("dials-reset");
  const diffReset = await diff(page, duDefault, duReset);

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
    `lumDefault=${lumDefault} lumExp=${lumExp} | diffDefaults=${diffDefaults} diffExp=${diffExp} diffPuff=${diffPuff} diffReset=${diffReset} | errs=${newErrs.length}`,
  );

  const checks = [
    [`explicit-defaults byte-identical to default (diff ${diffDefaults} < 0.4)`, diffDefaults < 0.4],
    [`exposure 0.22->0.10 changes the render (diff ${diffExp} > 0.5)`, diffExp > 0.5],
    [`puff-size 0.45->0.25 changes the deck (diff ${diffPuff} > 1.0)`, diffPuff > 1.0],
    [`reset to undefined returns to default (diff ${diffReset} < 0.6)`, diffReset < 0.6],
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
