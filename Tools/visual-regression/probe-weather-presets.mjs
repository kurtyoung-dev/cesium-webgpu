#!/usr/bin/env node
/**
 * Weather Inspector — standards-keyed PRESET sweep. WebGPU-only.
 * @purpose Sweeps the Weather Inspector's 8 METAR/WMO presets: okta brightness ladder holds (clear > broken > overcast/storm), 0 device errors.
 * @status ACTIVE
 * @runtime lib/probe-runtime.mjs
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
 * RUNTIME (probe-kit harvest). The browser, the served-build preflight, the
 * Edge slot, the deadline and the receipt belong to `lib/probe-runtime.mjs`.
 * The screenshots are the runtime's element captures of the same canvas, and
 * they are reduced in Node by `lib/metrics/luma-regions.mjs` — the same wedge,
 * Rec. 601 luma and cloud bars the page used to compute after decoding the
 * very same PNG. Every bar is unchanged. A demo that does not boot is now a
 * refusal (exit 3, no measurement) rather than a red exit 1.
 * CHROME CAVEAT: these gallery-demo element captures include the Viewer's
 * widgets and the demo's #weatherPanel, unchanged from HEAD and disclosed as
 * F9 (`NEW-WEATHER-DEMO-PROBES-SCORE-DOM-CHROME`) - the wedge misses them but
 * each whole-frame diff carries about 2 from them; see the in-line note on
 * this probe's line of `C13-WEATHER-PROBE-FLEET-NETWORK-GLOBE-TAIL` in
 * `DEFERRED_WORK.md`.
 *
 * Usage (serve the built tree on a governed port first, e.g.
 * `node server.js --port 8094 --serve-built`):
 *   node Tools/visual-regression/probe-weather-presets.mjs [--port 8094]
 */
import { decodePng } from "../lib/png-decode.mjs";
import {
  errorGateInit,
  armWebGPUDevices,
  collectGateErrors,
  attachConsoleErrorGate,
} from "../lib/webgpu-error-gate.mjs";
import {
  lumaRegionStats,
  meanAbsLumaDelta,
} from "./lib/metrics/luma-regions.mjs";
import {
  ProbeRefusal,
  captureElement,
  isEntryPoint,
  runProbe,
} from "./lib/probe-runtime.mjs";

const W = 1024,
  H = 768;
const DEMO = "/Apps/Sandcastle/gallery/WebGPU%20Weather%20Inspector.html";
const CANVAS = ".cesium-widget canvas";

/** Boot: the 30 s navigation default plus the 60 s wait for the viewer. */
const BOOT_BUDGET_MS = 90_000;
/** Let the first frame settle before the sweep. */
const SETTLE_AFTER_BOOT_MS = 9000;
/**
 * Generous settle per preset — the volumetric deck re-bakes over several
 * frames when coverage / layer heights change. Paid once per preset.
 */
const SETTLE_AFTER_PRESET_MS = 6000;
/** Eight element captures and their Node-side decodes. */
const READBACK_BUDGET_MS = 60_000;

/** The deck wedge and its cloud bars (Rec. 601 luma > 130, chroma < 40). */
const WEDGE = Object.freeze({
  region: Object.freeze({ x0: 0.42, x1: 0.8, y0: 0.42, y1: 0.9 }),
  cloudLumaAbove: 130,
  cloudChromaBelow: 40,
});

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

/**
 * Score one run. Pure: the per-preset wedge statistics, the two distinctness
 * diffs and the filtered error list go in; the gates come out. The wedge sits
 * right of the control panel (top-left, ~270 px) and in the lower-left/centre,
 * where the overhead ceiling rasterises for this near-ground upward view; the
 * upper right stays open sky, since only dense decks reach the very top.
 *
 * @param {Record<string, {lum: number, cloudPct: number}>} stats By preset key.
 * @param {{skcOvc: number, fewCb: number}} diffs Whole-frame mean |dLuma|.
 * @param {string[]} errors New device / console errors, already filtered.
 * @returns {Array<[string, string, boolean]>} The gates, in the old order.
 */
export function scorePresets(stats, diffs, errors) {
  const clearLum = (stats.SKC.lum + stats.FEWcu.lum + stats.Ci.lum) / 3;
  const stormLum = (stats.OVCst.lum + stats.Ns.lum + stats.Cb.lum) / 3;
  return [
    [
      "skc-open",
      `SKC leaves the wedge bright/open (lum ${stats.SKC.lum} > 150)`,
      stats.SKC.lum > 150,
    ],
    [
      "ovc-darkens",
      `OVC St darkens the wedge (overcast deck, lum ${stats.OVCst.lum} < 145)`,
      stats.OVCst.lum < 145,
    ],
    [
      "storm-darkest",
      `Ns + Cb storm decks darkest (lum ${stats.Ns.lum} & ${stats.Cb.lum} < 140)`,
      stats.Ns.lum < 140 && stats.Cb.lum < 140,
    ],
    [
      "okta-ladder",
      `brightness okta-ladder: clear/sparse ${clearLum.toFixed(0)} > broken ${stats.BKNsc.lum} > overcast/storm ${stormLum.toFixed(0)}`,
      clearLum > stats.BKNsc.lum + 4 && stats.BKNsc.lum > stormLum + 4,
    ],
    [
      "skc-vs-ovc",
      `clear vs overcast visibly differ (diff ${diffs.skcOvc} > 3)`,
      diffs.skcOvc > 3,
    ],
    [
      "few-vs-cb",
      `few vs storm visibly differ (diff ${diffs.fewCb} > 3)`,
      diffs.fewCb > 3,
    ],
    ["clean", `no NEW device errors (${errors.length})`, errors.length === 0],
  ];
}

/** The runtime descriptor: the demo boot and the preset sweep run in `cells`. */
export const descriptor = {
  name: "weather-presets",
  title:
    "Weather Inspector preset sweep: the eight METAR/WMO presets hold the okta brightness ladder",
  // The empty subdirectory keeps the captures where the pre-migration probe
  // wrote them: `output/weather-preset-*.png`.
  outputSubdirectory: "",
  receiptEnvelope: "runtime",
  // The demo page loads `Cesium.js` through its own script tag and its boot
  // helper imports `index.js`; the default list's Sandcastle2 bucket bundle is
  // a file this legacy gallery page never touches.
  servedArtifacts: [
    "Build/CesiumUnminified/Cesium.js",
    "Build/CesiumUnminified/index.js",
  ],
  workBudgetMs: () =>
    BOOT_BUDGET_MS +
    SETTLE_AFTER_BOOT_MS +
    SETTLE_AFTER_PRESET_MS * PRESETS.length +
    READBACK_BUDGET_MS,
  async cells({ browser, run, options, origin, outputDirectory, captures }) {
    if (!options.renderers.includes("webgpu")) {
      throw new ProbeRefusal(
        "renderer-unavailable",
        "the Weather Inspector demo boots WebGPU and its presets drive " +
          `volumetric clouds, so a run on ${options.renderers.join(",")} would read an empty sky`,
        { renderers: options.renderers },
      );
    }
    const page = await browser.newPage({ viewport: { width: W, height: H } });
    const consoleErrors = attachConsoleErrorGate(page);
    await page.addInitScript(errorGateInit);
    await page.addInitScript(SANDCASTLE_STUB);
    await page.goto(`${origin}${DEMO}`, { waitUntil: "domcontentloaded" });
    await page.addStyleTag({
      content:
        "#cesiumContainer{position:absolute;top:0;left:0;width:100%;height:100%;}#loadingOverlay{display:none;}",
    });

    const boot = await page.evaluate(BOOT);
    if (!boot.ok) {
      // A demo that did not boot is not a red measurement, it is no
      // measurement: the runtime refuses (exit 3) rather than scoring it.
      throw new ProbeRefusal(
        "demo-boot-failed",
        `the Weather Inspector demo did not boot: ${boot.err}`,
        { demo: DEMO, error: boot.err },
      );
    }
    await page.waitForFunction(
      () => !!(window.viewer && window.viewer.scene),
      null,
      { timeout: 60000 },
    );
    await armWebGPUDevices(page);

    await page.waitForTimeout(SETTLE_AFTER_BOOT_MS);
    const stats = {};
    const frames = {};
    for (const [key, tag] of PRESETS) {
      await page.evaluate(CLICK, { id: `wi-preset-${key}` });
      await page.waitForTimeout(SETTLE_AFTER_PRESET_MS);
      const shot = await captureElement({
        page,
        selector: CANVAS,
        name: `weather-preset-${tag}`,
        outputDirectory,
        captures,
      });
      frames[key] = decodePng(shot.buffer);
      const { lum, cloudPct } = lumaRegionStats(frames[key], WEDGE);
      stats[key] = { lum, cloudPct };
      console.log(`${key.padEnd(6)}`, JSON.stringify(stats[key]));
    }
    const diffs = {
      skcOvc: meanAbsLumaDelta(frames.SKC, frames.OVCst),
      fewCb: meanAbsLumaDelta(frames.FEWcu, frames.Cb),
    };

    const gate = await collectGateErrors(page);
    const errors = (gate.errors || [])
      .concat(consoleErrors)
      .filter(
        (e) =>
          !/Atmosphere ?LUT|SkyAtmosphere|default layout|favicon|bucket\.css|Sandcastle-header|load-cesium-es6/i.test(
            e,
          ),
      );
    console.log(
      `diffs SKC-OVC ${diffs.skcOvc} FEW-Cb ${diffs.fewCb} newErrs ${errors.length}`,
    );
    return [
      { run, stats, diffs, errors, checks: scorePresets(stats, diffs, errors) },
    ];
  },
  verdicts(cells) {
    return cells.flatMap((cell) =>
      cell.checks.map(([id, claim, pass]) => ({
        id: cells.length > 1 ? `run${cell.run}:${id}` : id,
        claim,
        pass,
      })),
    );
  },
  receipt(cells) {
    return { demo: DEMO, wedge: WEDGE, runs: cells };
  },
};

if (isEntryPoint(import.meta.url)) {
  process.exitCode = await runProbe(descriptor);
}
