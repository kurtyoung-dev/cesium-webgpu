#!/usr/bin/env node
/**
 * W1 — Dual-lobe Henyey-Greenstein cloud phase (silver lining). WebGPU-only
 * (procedural clouds don't render on WebGL).
 * @purpose W1 dual-lobe Henyey-Greenstein gate: the backlit (toward-sun) cloud band's p95/median rim contrast exceeds the frontlit (away-sun) one's, both bands populated; single-run bars
 * @status ACTIVE
 * @runtime lib/probe-runtime.mjs
 *
 * The forward lobe (phaseG1) makes BACKLIT clouds (camera looking toward the
 * sun) develop a bright forward-scatter rim — the silver lining — while
 * FRONTLIT clouds (camera away from the sun) stay flatter. Scene: camera below
 * the cloud layer looking up at the horizon. Capture two headings (toward-sun,
 * away-sun) and compare the rim contrast of the cloud band.
 *
 * Clauses (what the code has always enforced — the pre-harvest header promised
 * a 1.25x bright-rim COUNT ratio that the code never computed):
 *   1. clouds render in both views (> 5000 band pixels each).
 *   2. silver lining: the toward-sun band's p95/median contrast is greater than
 *      the away-sun band's (forward scatter brightens the sun-facing edges).
 *   3. no NEW WebGPU device errors (Atmosphere-LUT filtered).
 * Then READ output/cloud-phase-toward-sun.png (bright rim toward the sun) vs
 * output/cloud-phase-away-sun.png (flatter).
 *
 * ON THE KIT (probe-kit harvest, cloud family, round 1). The two views are the
 * rigs `cloud-phase-backlit` and `cloud-phase-frontlit`, each staged, settled,
 * read and banked by `captureCloudRigArm` (`lib/cloud-rig-stage.mjs`); the
 * band statistics are `lib/metrics/cloud-band.mjs`, computed in Node over the
 * canvas read; the origin, preflight, Edge slot, lifecycle, receipt and exit
 * code are the runtime's. The frame is the canvas (`toDataURL`, as before the
 * harvest, now in the task of one final render), never an element screenshot,
 * which would add the viewer's DOM chrome to the band. One deliberate change
 * from the pre-harvest probe: the cloud dials now reach the deck (they sat
 * behind `"cloudCoverage" in globe` guards that have been false since Batch
 * 622). Its first Edge run on the kit is owed.
 *
 * Usage: node Tools/visual-regression/probe-cloud-phase.mjs --port 8094
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
import BACKLIT from "./rigs/cloud-phase-backlit.mjs";
import FRONTLIT from "./rigs/cloud-phase-frontlit.mjs";

/** The two legs, in capture order, with the file names the evidence is banked under. */
const LEGS = Object.freeze([
  { key: "toward", rig: BACKLIT, capture: "cloud-phase-toward-sun" },
  { key: "away", rig: FRONTLIT, capture: "cloud-phase-away-sun" },
]);

/** Viewer boot: the page load plus the 60 s wait for `window.viewer`. */
const BOOT_BUDGET_MS = 90_000;
/** One leg's 160-frame settle, at a pessimistic ~0.75 s per volumetric frame. */
const SETTLE_BUDGET_MS = 120_000;
/** One canvas read, its decode and the band statistics. */
const CAPTURE_BUDGET_MS = 15_000;

/** Pixels whose brightest channel clears this are cloud against the black sky. */
const CLOUD_FLOOR = 24;
/** Each band must hold more cloud pixels than this to count as rendered. */
const MIN_CLOUD_PIXELS = 5000;
/** Console noise the W-series gates have always filtered. */
const IGNORED_ERRORS = /Atmosphere ?LUT|SkyAtmosphere|default layout/i;

/**
 * The band's rim contrast, as the pre-harvest in-page `measure` returned it:
 * brightest-channel median and 95th percentile over the upper 60 % of rows,
 * and their ratio rounded to three places (the comparison reads the rounded
 * value, as it always did).
 *
 * @param {{width: number, height: number, data: ArrayLike<number>}} image The capture.
 * @returns {{cloud: number, median: number, p95: number, contrast: number}} The band.
 */
export function measurePhaseBand(image) {
  const band = cloudBandStats(image, { minMaxChannel: CLOUD_FLOOR });
  if (band.count === 0) {
    return { cloud: 0, median: 0, p95: 0, contrast: 0 };
  }
  const median = bandQuantile(band.sortedMaxChannel, 0.5);
  const p95 = bandQuantile(band.sortedMaxChannel, 0.95);
  return {
    cloud: band.count,
    median,
    p95,
    contrast: median > 0 ? +(p95 / median).toFixed(3) : 0,
  };
}

/**
 * The three W1 clauses, over one run's cells. Pure, so the harvest spec can
 * put each bar on either side without a browser. Same claim text and the same
 * boolean test as the pre-harvest `checks` array, in the same order.
 *
 * @param {Array<object>} cells The run's cells.
 * @returns {Array<object>} Verdicts in the runtime's shape.
 */
export function evaluatePhase(cells) {
  const verdicts = [];
  for (const cell of cells) {
    const suffix = `run${cell.run}`;
    const { toward, away } = cell;
    verdicts.push(
      {
        id: `clouds-render/${suffix}`,
        claim: `clouds render both views (toward ${toward.cloud}, away ${away.cloud} > ${MIN_CLOUD_PIXELS} px)`,
        pass: toward.cloud > MIN_CLOUD_PIXELS && away.cloud > MIN_CLOUD_PIXELS,
        detail: { toward: toward.cloud, away: away.cloud },
      },
      {
        id: `silver-lining/${suffix}`,
        claim: `silver lining: backlit rim contrast ${toward.contrast} > frontlit ${away.contrast}`,
        pass: toward.contrast > away.contrast,
        detail: { toward, away },
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
    console.log("toward-sun:", JSON.stringify(cell.toward));
    console.log("away-sun  :", JSON.stringify(cell.away));
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
  name: "cloud-phase",
  title:
    "Cloud phase (W1) — backlit rim contrast exceeds frontlit over the rig-declared underside views",
  // The empty subdirectory keeps the captures where the pre-harvest probe
  // wrote them: `output/cloud-phase-{toward,away}-sun.png`.
  outputSubdirectory: "",
  // The probe banked no JSON receipt before the harvest, so the single
  // runtime envelope is the honest shape.
  receiptEnvelope: "runtime",
  servedArtifacts: [...CLOUD_RIG_SERVED_ARTIFACTS],
  workBudgetMs: () =>
    BOOT_BUDGET_MS + LEGS.length * (SETTLE_BUDGET_MS + CAPTURE_BUDGET_MS),
  async cells({ browser, run, options, origin, outputDirectory, captures }) {
    if (!options.renderers.includes("webgpu")) {
      throw new ProbeRefusal(
        "renderer-unavailable",
        "the volumetric cloud phase is WebGPU-only, so a silver-lining gate " +
          `measured on ${options.renderers.join(",")} would read an empty sky`,
        { renderers: options.renderers },
      );
    }
    const { width, height } = BACKLIT.viewport;
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

    const cell = { run };
    for (const leg of LEGS) {
      const arm = await captureCloudRigArm({
        page,
        rig: leg.rig,
        name: leg.capture,
        outputDirectory,
        captures,
      });
      cell[leg.key] = measurePhaseBand(arm.image);
      if (leg.key === "toward") {
        cell.sun = {
          elevDeg: +Number(arm.staged.sunElevationDeg).toFixed(1),
          sunHeadingDeg: +Number(arm.staged.sunHeadingDeg).toFixed(1),
        };
      }
    }
    const gate = await collectGateErrors(page);
    cell.deviceErrors = (gate.errors || []).filter(
      (error) => !IGNORED_ERRORS.test(error),
    );
    return [cell];
  },
  verdicts(cells) {
    return evaluatePhase(cells);
  },
  receipt(cells, context) {
    const receipt = {
      rigs: LEGS.map((leg) => leg.rig.id),
      cells,
      verdicts: context.verdicts,
    };
    if (cells.length > 0) {
      printReport(receipt);
    }
    return receipt;
  },
};

if (isEntryPoint(import.meta.url)) {
  process.exitCode = await runProbe(descriptor);
}
