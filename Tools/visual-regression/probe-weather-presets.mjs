#!/usr/bin/env node
/**
 * Weather Inspector — standards-keyed PRESET sweep. WebGPU-only.
 * @purpose Sweeps the Weather Inspector's 8 METAR/WMO presets: okta brightness ladder holds (clear > broken > overcast/storm), 0 device errors.
 * @status ACTIVE
 *
 * Boots the WebGPU Weather Inspector gallery demo standalone (stub Sandcastle,
 * inject Cesium as a module, call the demo's own startup — the gallery boot
 * recipe; see DEBUGGING_GUIDE "Booting a gallery demo standalone"), then clicks
 * each of the 8 METAR/WMO presets in turn, settles, compositor-screenshots the
 * canvas (page element screenshot, NOT toDataURL), and measures the upper-sky
 * brightness + a whitish-cloud fraction.
 *
 * Claims (verifies the presets are real + distinct, not just labels):
 *   (1) all 8 presets apply with 0 device errors;
 *   (2) SKC (clear, 0/8) leaves the deck wedge bright (open sky);
 *   (3) the OVC / Ns / Cb decks DARKEN the wedge (denser cover → dimmer scene,
 *       the physical signature of overcast/storm);
 *   (4) a brightness okta-ladder holds: clear/sparse > broken > overcast/storm;
 *   (5) clear vs overcast and few vs storm are visibly different images.
 *
 * NOTE on the metric: the deck-wedge LUMINANCE (not a whitish-pixel count) is
 * the robust discriminator — the heavy decks render DARK grey under their own
 * dim lighting, so a "bright cloud %" misses them while brightness separates the
 * whole okta ladder cleanly.
 *
 * Usage: PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-weather-presets.mjs
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

// preset key (button id suffix) -> short tag for the output filename.
// SKC is captured LAST: it turns clouds OFF, and the deck takes a few frames
// to re-bake on the next cloud preset — sweeping the cloud presets first (deck
// stays on) keeps each comparison apples-to-apples.
const PRESETS = [
  ["FEWcu", "few-cu"],
  ["SCTcu", "sct-cu"],
  ["BKNsc", "bkn-sc"],
  ["OVCst", "ovc-st"],
  ["Ns", "ns-rain"],
  ["Cb", "cb-storm"],
  ["Ci", "ci"],
  ["SKC", "skc"],
];

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
    return { ok: false, err: "window.startup not defined by demo" };
  }
  try {
    await window.startup(C);
    return { ok: true };
  } catch (e) {
    return { ok: false, err: String((e && e.stack) || e) };
  }
};

const CLICK = async ({ id }) => {
  const el = document.getElementById(id);
  if (!el) {
    return { ok: false };
  }
  el.click();
  return { ok: true };
};

// Upper-sky stats from a screenshot data URL: mean luminance + whitish-cloud %.
function skyStats(page, dataUrl) {
  return page.evaluate(async (du) => {
    const img = new Image();
    img.src = du;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const cx = c.getContext("2d");
    cx.drawImage(img, 0, 0);
    // The deck wedge: right of the control panel (panel is top-left ~270px) and
    // in the lower-left/centre where the overhead ceiling actually rasterizes
    // for this near-ground upward view (the upper-right stays open sky — only
    // dense decks reach the very top).
    const x0 = Math.floor(c.width * 0.42),
      x1 = Math.floor(c.width * 0.8),
      y0 = Math.floor(c.height * 0.42),
      y1 = Math.floor(c.height * 0.9);
    const d = cx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
    let lum = 0,
      cloud = 0,
      n = 0;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i],
        g = d[i + 1],
        b = d[i + 2];
      lum += 0.299 * r + 0.587 * g + 0.114 * b;
      const mx = Math.max(r, g, b),
        mn = Math.min(r, g, b);
      // whitish + bright = cloud-ish (vs blue sky which is saturated)
      if (0.299 * r + 0.587 * g + 0.114 * b > 130 && mx - mn < 40) {
        cloud++;
      }
      n++;
    }
    return {
      lum: +(lum / n).toFixed(1),
      cloudPct: +((100 * cloud) / n).toFixed(2),
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

  // Let the first frame settle before the sweep.
  await page.waitForTimeout(9000);

  const stats = {};
  const dataUrls = {};
  for (const [key, tag] of PRESETS) {
    await page.evaluate(CLICK, { id: `wi-preset-${key}` });
    // Generous settle — the volumetric deck re-bakes over several frames when
    // coverage / layer heights change.
    await page.waitForTimeout(6000);
    const du = await shot(`weather-preset-${tag}`);
    dataUrls[key] = du;
    stats[key] = await skyStats(page, du);
    console.log(`${key.padEnd(6)}`, JSON.stringify(stats[key]));
  }

  // distinctness diffs
  const dSkcOvc = await diff(page, dataUrls.SKC, dataUrls.OVCst);
  const dFewCb = await diff(page, dataUrls.FEWcu, dataUrls.Cb);

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
    "\ndiffs  SKC↔OVC",
    dSkcOvc,
    " FEW↔Cb",
    dFewCb,
    " newErrs",
    newErrs.length,
  );

  const clearLum = (stats.SKC.lum + stats.FEWcu.lum + stats.Ci.lum) / 3;
  const stormLum = (stats.OVCst.lum + stats.Ns.lum + stats.Cb.lum) / 3;
  const checks = [
    [
      `SKC leaves the wedge bright/open (lum ${stats.SKC.lum} > 150)`,
      stats.SKC.lum > 150,
    ],
    [
      `OVC St darkens the wedge (overcast deck, lum ${stats.OVCst.lum} < 145)`,
      stats.OVCst.lum < 145,
    ],
    [
      `Ns + Cb storm decks darkest (lum ${stats.Ns.lum} & ${stats.Cb.lum} < 140)`,
      stats.Ns.lum < 140 && stats.Cb.lum < 140,
    ],
    [
      `brightness okta-ladder: clear/sparse ${clearLum.toFixed(0)} > broken ${stats.BKNsc.lum} > overcast/storm ${stormLum.toFixed(0)}`,
      clearLum > stats.BKNsc.lum + 4 && stats.BKNsc.lum > stormLum + 4,
    ],
    [`clear vs overcast visibly differ (diff ${dSkcOvc} > 3)`, dSkcOvc > 3],
    [`few vs storm visibly differ (diff ${dFewCb} > 3)`, dFewCb > 3],
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
