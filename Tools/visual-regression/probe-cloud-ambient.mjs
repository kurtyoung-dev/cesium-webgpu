#!/usr/bin/env node
/**
 * W2 — Sky-ambient gradient + ground bounce. WebGPU-only.
 * @purpose W2 sky-ambient/ground-bounce gate: over the side-lit cloud band the darkest decile sits in [0.06, 0.5] of full scale and the p90-p10 lit-to-shadow range is at least 0.10; top/bottom blue ratios reported, not asserted; single-run bars
 * @status ACTIVE
 * @runtime lib/probe-runtime.mjs
 *
 * Adds a height-fraction ambient term so the anti-sun SHADOW side of clouds is
 * no longer near-black: blue sky lights the tops, warm ground-bounce the
 * bottoms. Scene: side-lit sun (so clouds have a clear lit face + shadow face),
 * camera below the layer looking up.
 *
 * Clauses (what the code has always enforced — the pre-harvest header listed a
 * top-bluer-than-bottom clause that the code measured and reported but never
 * asserted, because from below the deck the camera sees undersides only):
 *   1. clouds render (cloud band > 5000 px).
 *   2. shadow lifted: darkest-decile (p10) cloud brightness in [0.06, 0.5] of
 *      255 — off near-black, not blown out.
 *   3. form preserved: p90 - p10 >= 0.10 of 255 (the fill does not flatten
 *      the lit-to-shadow range).
 *   4. no NEW WebGPU device errors.
 * Then READ output/cloud-ambient.png — shadow side soft grey-blue (not black).
 *
 * ON THE KIT (probe-kit harvest, cloud family, round 1). The scene is the rig
 * `cloud-ambient-sidelit`, staged, settled, read and banked by
 * `captureCloudRigArm` (`lib/cloud-rig-stage.mjs`); the band statistics are
 * `lib/metrics/cloud-band.mjs`, computed in Node over the canvas read; the
 * origin, preflight, Edge slot, lifecycle, receipt and exit code are the
 * runtime's. The frame is the canvas (`toDataURL`, as before the harvest, now
 * in the task of one final render), never an element screenshot, which would
 * add the viewer's DOM chrome to the band. One deliberate change from the
 * pre-harvest probe: the cloud dials now reach the deck (they sat behind
 * `"cloudCoverage" in globe` guards that have been false since Batch 622). Its
 * first Edge run on the kit is owed.
 *
 * Usage: node Tools/visual-regression/probe-cloud-ambient.mjs --port 8094
 */
import {
  armWebGPUDevices,
  collectGateErrors,
  errorGateInit,
} from "../lib/webgpu-error-gate.mjs";
import { installCloudProbeHarness } from "./lib/cloud-probe-harness.mjs";
import {
  CLOUD_RIG_SERVED_ARTIFACTS,
  captureCloudRigArm,
} from "./lib/cloud-rig-stage.mjs";
import { bandQuantile, cloudBandStats } from "./lib/metrics/cloud-band.mjs";
import { ProbeRefusal, isEntryPoint, runProbe } from "./lib/probe-runtime.mjs";
import SIDELIT from "./rigs/cloud-ambient-sidelit.mjs";

/** Viewer boot: the page load plus the 60 s wait for `window.viewer`. */
const BOOT_BUDGET_MS = 90_000;
/** The 160-frame settle, at a pessimistic ~0.75 s per volumetric frame. */
const SETTLE_BUDGET_MS = 120_000;
/** One canvas read, its decode and the band statistics. */
const CAPTURE_BUDGET_MS = 15_000;

/** Pixels whose brightest channel clears this are cloud against the black sky. */
const CLOUD_FLOOR = 18;
/** The band must hold more cloud pixels than this to count as rendered. */
const MIN_CLOUD_PIXELS = 5000;
/** Console noise the W-series gates have always filtered. */
const IGNORED_ERRORS = /Atmosphere ?LUT|SkyAtmosphere|default layout/i;

/**
 * The band, as the pre-harvest in-page `measure` returned it: brightest-channel
 * p10 / p50 / p90 over the upper 60 % of rows, and the top and bottom rows'
 * mean blue ratio rounded to four places.
 *
 * @param {{width: number, height: number, data: ArrayLike<number>}} image The capture.
 * @returns {{cloud: number, p10?: number, p50?: number, p90?: number,
 *   topBlueRatio?: number, botBlueRatio?: number}} The band; `{cloud: 0}` when empty.
 */
export function measureAmbientBand(image) {
  const band = cloudBandStats(image, { minMaxChannel: CLOUD_FLOOR });
  if (band.count === 0) {
    return { cloud: 0 };
  }
  return {
    cloud: band.count,
    p10: bandQuantile(band.sortedMaxChannel, 0.1),
    p50: bandQuantile(band.sortedMaxChannel, 0.5),
    p90: bandQuantile(band.sortedMaxChannel, 0.9),
    topBlueRatio: band.topCount ? +band.topBlueRatio.toFixed(4) : 0,
    botBlueRatio: band.bottomCount ? +band.bottomBlueRatio.toFixed(4) : 0,
  };
}

/**
 * The four W2 clauses, over one run's cells. Pure; same claim text and the
 * same boolean tests as the pre-harvest `checks` array, in the same order.
 *
 * @param {Array<object>} cells The run's cells.
 * @returns {Array<object>} Verdicts in the runtime's shape.
 */
export function evaluateAmbient(cells) {
  const verdicts = [];
  for (const cell of cells) {
    const suffix = `run${cell.run}`;
    const m = cell.band;
    const p10n = (m.p10 || 0) / 255;
    const p90n = (m.p90 || 0) / 255;
    verdicts.push(
      {
        id: `clouds-render/${suffix}`,
        claim: `clouds render (band > ${MIN_CLOUD_PIXELS} px)`,
        pass: m.cloud > MIN_CLOUD_PIXELS,
        detail: { cloud: m.cloud },
      },
      {
        id: `shadow-lifted/${suffix}`,
        claim: `shadow lifted off black: p10 ${p10n.toFixed(3)} in [0.06, 0.5]`,
        pass: p10n >= 0.06 && p10n <= 0.5,
        detail: { p10: p10n },
      },
      {
        id: `form-preserved/${suffix}`,
        claim: `form preserved: lit-to-shadow range p90-p10 ${(p90n - p10n).toFixed(3)} >= 0.10`,
        pass: p90n - p10n >= 0.1,
        detail: { p10: p10n, p90: p90n },
      },
      {
        id: `device-errors/${suffix}`,
        claim: `no NEW device errors (${cell.deviceErrors.length})`,
        pass: cell.deviceErrors.length === 0,
        detail: { errors: cell.deviceErrors.slice(0, 5) },
      },
    );
  }
  return verdicts;
}

function printReport(receipt) {
  for (const cell of receipt.cells) {
    console.log("sun:", JSON.stringify(cell.sun));
    console.log("cloud band:", JSON.stringify(cell.band));
  }
  console.log("\n=== ANALYSIS ===");
  for (const verdict of receipt.verdicts) {
    console.log(`  [${verdict.pass ? "PASS" : "FAIL"}] ${verdict.claim}`);
  }
  console.log(
    `\nRESULT: ${receipt.verdicts.every((v) => v.pass === true) ? "GREEN" : "RED"}`,
  );
}

/** The descriptor the shared runtime executes. */
export const descriptor = {
  name: "cloud-ambient",
  title:
    "Cloud ambient (W2) — the side-lit band's shadow floor is lifted and its form survives",
  // Keeps the capture at `output/cloud-ambient.png`, where it was banked.
  outputSubdirectory: "",
  receiptEnvelope: "runtime",
  servedArtifacts: [...CLOUD_RIG_SERVED_ARTIFACTS],
  workBudgetMs: () => BOOT_BUDGET_MS + SETTLE_BUDGET_MS + CAPTURE_BUDGET_MS,
  async cells({ browser, run, options, origin, outputDirectory, captures }) {
    if (!options.renderers.includes("webgpu")) {
      throw new ProbeRefusal(
        "renderer-unavailable",
        "the volumetric cloud ambient is WebGPU-only, so a shadow-floor gate " +
          `measured on ${options.renderers.join(",")} would read an empty sky`,
        { renderers: options.renderers },
      );
    }
    const { width, height } = SIDELIT.viewport;
    const page = await browser.newPage({ viewport: { width, height } });
    await page.addInitScript(errorGateInit);
    await page.addInitScript(installCloudProbeHarness);
    await page.goto(`${origin}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForFunction(() => !!window.viewer, null, {
      timeout: 60000,
    });
    await armWebGPUDevices(page);

    const arm = await captureCloudRigArm({
      page,
      rig: SIDELIT,
      name: "cloud-ambient",
      outputDirectory,
      captures,
    });
    const gate = await collectGateErrors(page);
    return [
      {
        run,
        sun: { sunHeadingDeg: +Number(arm.staged.sunHeadingDeg).toFixed(1) },
        band: measureAmbientBand(arm.image),
        deviceErrors: (gate.errors || []).filter(
          (error) => !IGNORED_ERRORS.test(error),
        ),
      },
    ];
  },
  verdicts(cells) {
    return evaluateAmbient(cells);
  },
  receipt(cells, context) {
    const receipt = { rigs: [SIDELIT.id], cells, verdicts: context.verdicts };
    if (cells.length > 0) {
      printReport(receipt);
    }
    return receipt;
  },
};

if (isEntryPoint(import.meta.url)) {
  process.exitCode = await runProbe(descriptor);
}
