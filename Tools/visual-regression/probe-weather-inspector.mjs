#!/usr/bin/env node
/**
 * Weather Inspector Sandcastle demo — end-to-end verification. WebGPU-only.
 *
 * The gallery .html references ../Sandcastle-header.js + ../load-cesium-es6.js,
 * which 404 when the file is served standalone on :8080 (they only exist inside
 * the Sandcastle2 build context). So this probe replicates how the gallery's
 * test runner loads a demo: stub window.Sandcastle, inject the sizing CSS that
 * bucket.css normally provides, import Cesium as an ES module, and call the
 * demo's own window.startup(Cesium). Then it drives the REAL DOM controls
 * (slider input events + a preset button click) and screenshots each state.
 *
 * Claims:
 *   (1) the demo boots on WebGPU, builds the panel + 8 standards-keyed presets,
 *       and renders clouds — 0 errors;
 *   (2) the Coverage slider is wired (0.45 -> 0.95 raises cloud coverage + moves the image);
 *   (3) the OVC St (overcast, 8/8 oktas) preset changes the sky AND refreshes the
 *       slider UI (coverage reads ~0.98).
 *
 * Usage: PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-weather-inspector.mjs
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
  // Minimal Sandcastle the demo needs. finishedLoading() must clear the
  // sandcastle-loading state (bucket.css is 404 standalone, so do it directly).
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

// Boot the demo: load Cesium as a module, call the page's own startup().
const BOOT = async () => {
  const C = await import("/Build/CesiumUnminified/index.js");
  window.Cesium = C;
  if (typeof window.startup !== "function") {
    return { ok: false, err: "window.startup not defined by demo" };
  }
  try {
    await window.startup(C);
    return { ok: true };
  } catch (e) {
    return { ok: false, err: String((e && e.stack) || e) };
  }
};

// Drive a control by its DOM id (ids contain dots → attribute selector).
const SET_SLIDER = async ({ id, value }) => {
  const el = document.querySelector(`[id="${id}"]`);
  if (!el) {
    return { ok: false };
  }
  el.value = String(value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  return { ok: true, value: el.value };
};

const CLICK = async ({ id }) => {
  const el = document.getElementById(id);
  if (!el) {
    return { ok: false };
  }
  el.click();
  return { ok: true };
};

const READ_SLIDER = async ({ id }) => {
  const el = document.querySelector(`[id="${id}"]`);
  return el ? Number(el.value) : null;
};

function cloudStats(page, dataUrl) {
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
    let cloudPx = 0,
      sky = 0;
    const n = d.length / 4;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i],
        g = d[i + 1],
        b = d[i + 2];
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      // "cloud-ish": bright + low saturation (whitish)
      const mx = Math.max(r, g, b),
        mn = Math.min(r, g, b);
      if (lum > 140 && mx - mn < 45) {
        cloudPx++;
      }
      if (b > r && b > 90) {
        sky++;
      }
    }
    return {
      cloudPct: +((100 * cloudPx) / n).toFixed(2),
      skyPct: +((100 * sky) / n).toFixed(2),
    };
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
  // Provide the sizing bucket.css normally supplies.
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

  // Capture the way the canonical gallery runner does: let the viewer's OWN
  // render loop present continuously, settle, then Playwright-screenshot the
  // canvas (compositor read — avoids the toDataURL skew on this WebGPU canvas).
  const canvas = await page.$(".cesium-widget canvas");
  const shot = async (name) => {
    await canvas.screenshot({ path: `${OUT}/${name}.png` });
    return (
      "data:image/png;base64," +
      fs.readFileSync(`${OUT}/${name}.png`).toString("base64")
    );
  };
  const SETTLE = 9000;

  // 1) default sky
  await page.waitForTimeout(SETTLE);
  const panelInfo = await page.evaluate(() => ({
    rows: document.querySelectorAll("#weatherPanel .row").length,
    presets: document.querySelectorAll("#weatherPanel .presets button").length,
    groups: document.querySelectorAll("#weatherPanel fieldset").length,
  }));
  const defDU = await shot("weather-inspector-default");
  const defStats = await cloudStats(page, defDU);
  console.log(
    "default",
    JSON.stringify(defStats),
    "panel",
    JSON.stringify(panelInfo),
  );

  // 2) drive Coverage 0.45 -> 0.95
  const covId =
    "wi-globe.defaultCloudCollection.volumetric.cloudCoverage-Coverage";
  const setCov = await page.evaluate(SET_SLIDER, { id: covId, value: 0.95 });
  await page.waitForTimeout(3500);
  const covDU = await shot("weather-inspector-coverage-hi");
  const covStats = await cloudStats(page, covDU);
  const covDiff = await diff(page, defDU, covDU);
  console.log(
    "coverage0.95",
    JSON.stringify(covStats),
    "diff",
    covDiff,
    "set",
    JSON.stringify(setCov),
  );

  // 3) OVC St preset (button click) — overcast 8/8, and confirm UI refresh
  await page.evaluate(CLICK, { id: "wi-preset-OVCst" });
  await page.waitForTimeout(3500);
  const stormDU = await shot("weather-inspector-ovc-st");
  const stormyDiff = await diff(page, defDU, stormDU);
  const covAfterPreset = await page.evaluate(READ_SLIDER, { id: covId });
  console.log("OVC St diff", stormyDiff, "coverageUI", covAfterPreset);

  const gate = await collectGateErrors(page);
  const newErrs = (gate.errors || [])
    .concat(consoleErrors)
    .filter(
      (e) =>
        !/Atmosphere ?LUT|SkyAtmosphere|default layout|favicon|bucket\.css|Sandcastle-header|load-cesium-es6/i.test(
          e,
        ),
    );

  const checks = [
    [
      "demo booted on WebGPU + panel built (8 groups, 8 presets)",
      panelInfo.rows >= 15 && panelInfo.presets === 8 && panelInfo.groups >= 7,
    ],
    [
      `clouds render in default sky (cloudPct ${defStats.cloudPct} > 2)`,
      defStats.cloudPct > 2,
    ],
    [
      `Coverage slider wired (set ok, diff ${covDiff} > 0.5)`,
      setCov.ok && covDiff > 0.5,
    ],
    [`OVC St preset changes sky (diff ${stormyDiff} > 1.0)`, stormyDiff > 1.0],
    [
      `OVC St preset refreshes UI (coverage slider ${covAfterPreset} ~ 0.98)`,
      covAfterPreset != null && covAfterPreset > 0.9,
    ],
    [`no NEW device/runtime errors (${newErrs.length})`, newErrs.length === 0],
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
