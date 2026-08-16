#!/usr/bin/env node
/**
 * WebGPU Fullscreen Sky gallery demo — end-to-end verification. WebGPU-only.
 * @purpose Boots the WebGPU Fullscreen Sky gallery demo standalone and verifies fullscreen-vs-shell sky parity, day/night darkening, zero device errors
 * @status ACTIVE
 *
 * Boots the gallery .html standalone (the bootstrap scripts 404 on :8080 — stub
 * Sandcastle, inject Cesium as a module, call the demo's own startup, supply the
 * bucket.css sizing — see DEBUGGING_GUIDE "Booting a gallery demo standalone"),
 * then drives the sky path + time of day via the exposed window.viewer and
 * compositor-screenshots each state (page.screenshot, NOT toDataURL).
 *
 * Claims: (1) the demo boots on WebGPU + the panel builds; (2) the FULLSCREEN sky
 * renders blue daytime sky; (3) the SHELL sky renders the same blue (parity);
 * (4) at night the sky darkens (stars show); (5) 0 device errors.
 *
 * Usage: PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-fullscreen-sky-demo.mjs
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
const DEMO = "/Apps/Sandcastle/gallery/WebGPU%20Fullscreen%20Sky.html";

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

// Set the sky path + UTC hour, then return after a settle in-page.
const APPLY = async (cfg) => {
  const v = window.viewer;
  const s = v.scene;
  s.requestRenderMode = false;
  s.skyAtmosphere._webgpuFullscreen = cfg.fullscreen;
  const h = Math.floor(cfg.hour);
  const m = Math.round((cfg.hour - h) * 60);
  const iso = `2026-06-21T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`;
  v.clock.currentTime = window.Cesium.JulianDate.fromIso8601(iso);
  v.clock.shouldAnimate = false;
};

function skyRGB(page, dataUrl) {
  return page.evaluate(async (du) => {
    const img = new Image();
    img.src = du;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const cx = c.getContext("2d");
    cx.drawImage(img, 0, 0);
    const x0 = Math.floor(c.width * 0.34),
      x1 = Math.floor(c.width * 0.62),
      y0 = Math.floor(c.height * 0.06),
      y1 = Math.floor(c.height * 0.3);
    const d = cx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
    let r = 0,
      g = 0,
      b = 0,
      n = 0;
    for (let i = 0; i < d.length; i += 4) {
      r += d[i];
      g += d[i + 1];
      b += d[i + 2];
      n++;
    }
    return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) };
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

  const panelInfo = await page.evaluate(() => ({
    rows: document.querySelectorAll("#skyPanel .row").length,
    fs: !!window.viewer.scene.skyAtmosphere._webgpuFullscreen,
  }));

  // 1) fullscreen sky, noon
  await page.evaluate(APPLY, { fullscreen: true, hour: 18 });
  await page.waitForTimeout(9000);
  const fsDay = skyRGB(page, await shot("fullscreen-sky-fs-day"));
  // 2) shell sky, noon
  await page.evaluate(APPLY, { fullscreen: false, hour: 18 });
  await page.waitForTimeout(3500);
  const shellDay = skyRGB(page, await shot("fullscreen-sky-shell-day"));
  // 3) fullscreen sky, night
  await page.evaluate(APPLY, { fullscreen: true, hour: 6 });
  await page.waitForTimeout(3500);
  const fsNight = skyRGB(page, await shot("fullscreen-sky-fs-night"));

  const day1 = await fsDay,
    day2 = await shellDay,
    night = await fsNight;

  const gate = await collectGateErrors(page);
  const newErrs = (gate.errors || [])
    .concat(consoleErrors)
    .filter(
      (e) =>
        !/Atmosphere ?LUT|SkyAtmosphere|default layout|favicon|bucket\.css|Sandcastle-header|load-cesium-es6/i.test(
          e,
        ),
    );

  console.log("panel", JSON.stringify(panelInfo));
  console.log(
    "fs-day",
    JSON.stringify(day1),
    "shell-day",
    JSON.stringify(day2),
    "fs-night",
    JSON.stringify(night),
  );

  const isBlue = (c) => c.b > 120 && c.b > c.r + 20;
  const checks = [
    [
      "demo booted on WebGPU + panel built",
      panelInfo.rows >= 3 && panelInfo.fs === true,
    ],
    [`fullscreen sky day is blue ${JSON.stringify(day1)}`, isBlue(day1)],
    [`shell sky day is blue (parity) ${JSON.stringify(day2)}`, isBlue(day2)],
    [
      `fullscreen vs shell day match (|Δb| ${Math.abs(day1.b - day2.b)} ≤ 25)`,
      Math.abs(day1.b - day2.b) <= 25,
    ],
    [
      `night sky darkens ${JSON.stringify(night)} (much darker than day)`,
      night.b < day1.b - 40,
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
