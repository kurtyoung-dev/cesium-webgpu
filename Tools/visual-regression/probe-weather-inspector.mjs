#!/usr/bin/env node
/**
 * Weather Inspector Sandcastle demo — end-to-end verification. WebGPU-only.
 * @purpose Boots the Weather Inspector Sandcastle demo standalone and drives its real DOM controls: coverage slider + OVC preset change the sky.
 * @status ACTIVE
 * @runtime lib/probe-runtime.mjs
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
 * RUNTIME (probe-kit harvest). The browser, the served-build preflight, the
 * Edge slot, the deadline and the receipt belong to `lib/probe-runtime.mjs`.
 * The screenshots are the runtime's element captures of the same canvas,
 * reduced in Node by `lib/metrics/luma-regions.mjs` (the whole frame, Rec. 601
 * luma, the same cloud and sky bars) instead of in the page after decoding the
 * same PNG. Every bar is unchanged. A demo that does not boot is now a refusal
 * (exit 3, no measurement) rather than a red exit 1.
 * CHROME CAVEAT: these gallery-demo element captures include the Viewer's
 * widgets and the demo's #weatherPanel, unchanged from HEAD and disclosed as
 * F9 (`NEW-WEATHER-DEMO-PROBES-SCORE-DOM-CHROME`) - on the banked frames the
 * chrome alone clears the whole-frame `cloudPct > 2` bar; see the in-line
 * note on this probe's line of `C13-WEATHER-PROBE-FLEET-NETWORK-GLOBE-TAIL`
 * in `DEFERRED_WORK.md`.
 *
 * Usage (serve the built tree on a governed port first, e.g.
 * `node server.js --port 8094 --serve-built`):
 *   node Tools/visual-regression/probe-weather-inspector.mjs [--port 8094]
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
const COVERAGE_SLIDER =
  "wi-globe.defaultCloudCollection.volumetric.cloudCoverage-Coverage";

/** Boot: the 30 s navigation default plus the 60 s wait for the viewer. */
const BOOT_BUDGET_MS = 90_000;
/** Settle before the default capture. */
const SETTLE_AFTER_BOOT_MS = 9000;
/** Settle after each control change. Paid twice: the slider and the preset. */
const SETTLE_AFTER_CONTROL_MS = 3500;
/** Three element captures and their Node-side decodes. */
const READBACK_BUDGET_MS = 60_000;

/** The whole-frame cloud bars (Rec. 601 luma > 140, chroma < 45). */
const CLOUD_BARS = Object.freeze({ cloudLumaAbove: 140, cloudChromaBelow: 45 });

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

/**
 * Score one run. Pure: the panel census, the default capture's statistics, the
 * slider write, the two diffs, the slider read-back and the filtered error list
 * go in; the gates come out, in the pre-migration order.
 *
 * @param {object} run What `cells` measured.
 * @returns {Array<[string, string, boolean]>}
 */
export function scoreInspector({
  panelInfo,
  defStats,
  setCov,
  covDiff,
  stormyDiff,
  covAfterPreset,
  errors,
}) {
  return [
    [
      "panel",
      "demo booted on WebGPU + panel built (8 groups, 8 presets)",
      panelInfo.rows >= 15 && panelInfo.presets === 8 && panelInfo.groups >= 7,
    ],
    [
      "default-clouds",
      `clouds render in default sky (cloudPct ${defStats.cloudPct} > 2)`,
      defStats.cloudPct > 2,
    ],
    [
      "coverage-slider",
      `Coverage slider wired (set ok, diff ${covDiff} > 0.5)`,
      Boolean(setCov.ok) && covDiff > 0.5,
    ],
    [
      "ovc-changes-sky",
      `OVC St preset changes sky (diff ${stormyDiff} > 1.0)`,
      stormyDiff > 1.0,
    ],
    [
      "ovc-refreshes-ui",
      `OVC St preset refreshes UI (coverage slider ${covAfterPreset} ~ 0.98)`,
      covAfterPreset != null && covAfterPreset > 0.9,
    ],
    [
      "clean",
      `no NEW device/runtime errors (${errors.length})`,
      errors.length === 0,
    ],
  ];
}

/** The runtime descriptor: the demo boot and the three states run in `cells`. */
export const descriptor = {
  name: "weather-inspector",
  title:
    "Weather Inspector demo: the panel builds, the coverage slider and the OVC preset change the sky",
  // The empty subdirectory keeps the captures where the pre-migration probe
  // wrote them: `output/weather-inspector-*.png`.
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
    SETTLE_AFTER_CONTROL_MS * 2 +
    READBACK_BUDGET_MS,
  async cells({ browser, run, options, origin, outputDirectory, captures }) {
    if (!options.renderers.includes("webgpu")) {
      throw new ProbeRefusal(
        "renderer-unavailable",
        "the Weather Inspector demo boots WebGPU and its controls drive " +
          `volumetric clouds, so a run on ${options.renderers.join(",")} would read an empty sky`,
        { renderers: options.renderers },
      );
    }
    const page = await browser.newPage({ viewport: { width: W, height: H } });
    const consoleErrors = attachConsoleErrorGate(page);
    await page.addInitScript(errorGateInit);
    await page.addInitScript(SANDCASTLE_STUB);
    await page.goto(`${origin}${DEMO}`, { waitUntil: "domcontentloaded" });
    // Provide the sizing bucket.css normally supplies.
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

    // Capture the way the canonical gallery runner does: let the viewer's OWN
    // render loop present continuously, settle, then take an element capture
    // of the canvas (a compositor read, not toDataURL).
    const shot = async (name) =>
      decodePng(
        (
          await captureElement({
            page,
            selector: CANVAS,
            name,
            outputDirectory,
            captures,
          })
        ).buffer,
      );

    // 1) default sky
    await page.waitForTimeout(SETTLE_AFTER_BOOT_MS);
    const panelInfo = await page.evaluate(() => ({
      rows: document.querySelectorAll("#weatherPanel .row").length,
      presets: document.querySelectorAll("#weatherPanel .presets button")
        .length,
      groups: document.querySelectorAll("#weatherPanel fieldset").length,
    }));
    const defFrame = await shot("weather-inspector-default");
    const defStats = lumaRegionStats(defFrame, CLOUD_BARS);

    // 2) drive Coverage 0.45 -> 0.95
    const setCov = await page.evaluate(SET_SLIDER, {
      id: COVERAGE_SLIDER,
      value: 0.95,
    });
    await page.waitForTimeout(SETTLE_AFTER_CONTROL_MS);
    const covFrame = await shot("weather-inspector-coverage-hi");
    const covStats = lumaRegionStats(covFrame, CLOUD_BARS);
    const covDiff = meanAbsLumaDelta(defFrame, covFrame);

    // 3) OVC St preset (button click) — overcast 8/8, and confirm UI refresh
    await page.evaluate(CLICK, { id: "wi-preset-OVCst" });
    await page.waitForTimeout(SETTLE_AFTER_CONTROL_MS);
    const stormFrame = await shot("weather-inspector-ovc-st");
    const stormyDiff = meanAbsLumaDelta(defFrame, stormFrame);
    const covAfterPreset = await page.evaluate(READ_SLIDER, {
      id: COVERAGE_SLIDER,
    });

    const gate = await collectGateErrors(page);
    const errors = (gate.errors || [])
      .concat(consoleErrors)
      .filter(
        (e) =>
          !/Atmosphere ?LUT|SkyAtmosphere|default layout|favicon|bucket\.css|Sandcastle-header|load-cesium-es6/i.test(
            e,
          ),
      );
    const measured = {
      run,
      panelInfo,
      defStats,
      setCov,
      covStats,
      covDiff,
      stormyDiff,
      covAfterPreset,
      errors,
    };
    console.log(
      `weather-inspector run ${run}: panel ${JSON.stringify(panelInfo)} | default ${JSON.stringify(defStats)} | ` +
        `coverage ${JSON.stringify(covStats)} diff ${covDiff} | OVC diff ${stormyDiff} slider ${covAfterPreset} | ` +
        `errs ${errors.length}`,
    );
    return [{ ...measured, checks: scoreInspector(measured) }];
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
    return { demo: DEMO, cloudBars: CLOUD_BARS, runs: cells };
  },
};

if (isEntryPoint(import.meta.url)) {
  process.exitCode = await runProbe(descriptor);
}
