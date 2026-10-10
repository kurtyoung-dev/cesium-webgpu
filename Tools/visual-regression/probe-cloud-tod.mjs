#!/usr/bin/env node
/**
 * W3 — Time-of-day cloud sun color. WebGPU-only.
 * @purpose Time-of-day cloud sun-color acceptance: dawn/dusk decks warm (R/B >= 1.15), noon less warm than both, via manual scene.render(jd) sun control.
 * @status ACTIVE
 * @runtime lib/probe-runtime.mjs
 *
 * The direct-sun term is tinted by a CPU-computed sun color keyed on the LOCAL
 * sun elevation: warm orange near the horizon (dawn/dusk), neutral white at
 * noon. Fixed camera looking up at the cloud band; render at three sun
 * elevations (dawn / noon / dusk) and compare the cloud color.
 *
 * Sun control: viewer.useDefaultRenderLoop=false + scene.render(jd) so the sun
 * follows the supplied JulianDate (the RAF path ignored the clock).
 *
 * Clauses:
 *   1. clouds render at all three times (> 3000 band pixels each).
 *   2. dawn AND dusk warm: cloud sumR/sumB >= 1.15.
 *   3. noon less warm than dawn and than dusk.
 *   4. no NEW device errors.
 * Then READ output/cloud-tod-{dawn,noon,dusk}.png — dawn/dusk orange-tinted,
 * noon white-grey.
 *
 * ON THE KIT (probe-kit harvest, cloud family, round 1). The three instants
 * are the rigs `cloud-tod-dawn`, `cloud-tod-noon` and `cloud-tod-dusk`, each
 * staged, settled, read and banked by `captureCloudRigArm`
 * (`lib/cloud-rig-stage.mjs`); the red/blue sums are
 * `lib/metrics/cloud-band.mjs`, computed in Node over the canvas read; the
 * origin, preflight, Edge slot, lifecycle, receipt and exit code are the
 * runtime's. The frame is the canvas (`toDataURL`, as before the harvest, now
 * in the task of one final render), never an element screenshot, which would
 * add the viewer's DOM chrome to the band and dilute its warmth. One
 * deliberate change from the pre-harvest probe: the cloud dials now reach the
 * deck (they sat behind `"cloudCoverage" in globe` guards that have been false
 * since Batch 622). Its first Edge run on the kit is owed.
 *
 * Usage: node Tools/visual-regression/probe-cloud-tod.mjs --port 8094
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
import { cloudBandStats } from "./lib/metrics/cloud-band.mjs";
import { ProbeRefusal, isEntryPoint, runProbe } from "./lib/probe-runtime.mjs";
import DAWN from "./rigs/cloud-tod-dawn.mjs";
import DUSK from "./rigs/cloud-tod-dusk.mjs";
import NOON from "./rigs/cloud-tod-noon.mjs";

/** The three instants, in capture order, with their banked file names. */
const LEGS = Object.freeze([
  { key: "dawn", rig: DAWN, capture: "cloud-tod-dawn" },
  { key: "noon", rig: NOON, capture: "cloud-tod-noon" },
  { key: "dusk", rig: DUSK, capture: "cloud-tod-dusk" },
]);

/** Viewer boot: the page load plus the 60 s wait for `window.viewer`. */
const BOOT_BUDGET_MS = 90_000;
/** One leg's 90-frame settle, at a pessimistic ~0.75 s per volumetric frame. */
const SETTLE_BUDGET_MS = 70_000;
/** One canvas read, its decode and the band sums. */
const CAPTURE_BUDGET_MS = 15_000;

/** Pixels whose brightest channel clears this are cloud against the black sky. */
const CLOUD_FLOOR = 24;
/** Each band must hold more cloud pixels than this to count as rendered. */
const MIN_CLOUD_PIXELS = 3000;
/** The warm bar dawn and dusk must reach. */
const WARM_R_OVER_B = 1.15;
/** Console noise the W-series gates have always filtered. */
const IGNORED_ERRORS = /Atmosphere ?LUT|SkyAtmosphere|default layout/i;

/**
 * The band's warmth, as the pre-harvest in-page `measure` returned it: the
 * cloud-pixel count and the red sum over the blue sum, rounded to three
 * places (the bars read the rounded value, as they always did).
 *
 * @param {{width: number, height: number, data: ArrayLike<number>}} image The capture.
 * @returns {{cloud: number, rOverB: number}} The band.
 */
export function measureTodBand(image) {
  const band = cloudBandStats(image, { minMaxChannel: CLOUD_FLOOR });
  return {
    cloud: band.count,
    rOverB:
      band.count && band.sumB > 0 ? +(band.sumR / band.sumB).toFixed(3) : 0,
  };
}

/**
 * The five time-of-day clauses, over one run's cells. Pure; same claim text
 * and the same boolean tests as the pre-harvest `checks` array, in order.
 *
 * @param {Array<object>} cells The run's cells.
 * @returns {Array<object>} Verdicts in the runtime's shape.
 */
export function evaluateTod(cells) {
  const verdicts = [];
  for (const cell of cells) {
    const suffix = `run${cell.run}`;
    const { dawn, noon, dusk } = cell;
    verdicts.push(
      {
        id: `clouds-render/${suffix}`,
        claim: "clouds render all three",
        pass:
          dawn.cloud > MIN_CLOUD_PIXELS &&
          noon.cloud > MIN_CLOUD_PIXELS &&
          dusk.cloud > MIN_CLOUD_PIXELS,
        detail: { dawn: dawn.cloud, noon: noon.cloud, dusk: dusk.cloud },
      },
      {
        id: `dawn-warm/${suffix}`,
        claim: `dawn warm (R/B ${dawn.rOverB} >= ${WARM_R_OVER_B})`,
        pass: dawn.rOverB >= WARM_R_OVER_B,
        detail: dawn,
      },
      {
        id: `dusk-warm/${suffix}`,
        claim: `dusk warm (R/B ${dusk.rOverB} >= ${WARM_R_OVER_B})`,
        pass: dusk.rOverB >= WARM_R_OVER_B,
        detail: dusk,
      },
      {
        id: `noon-less-warm/${suffix}`,
        claim: `noon less warm than dawn/dusk (${noon.rOverB} < ${dawn.rOverB})`,
        pass: noon.rOverB < dawn.rOverB && noon.rOverB < dusk.rOverB,
        detail: { dawn: dawn.rOverB, noon: noon.rOverB, dusk: dusk.rOverB },
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
    for (const leg of LEGS) {
      console.log(`${leg.key}:`, JSON.stringify(cell[leg.key]));
    }
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
  name: "cloud-tod",
  title:
    "Cloud time of day (W3) — dawn and dusk decks warm, noon less warm, over three rig-declared instants",
  // Keeps the captures at `output/cloud-tod-{dawn,noon,dusk}.png`.
  outputSubdirectory: "",
  receiptEnvelope: "runtime",
  servedArtifacts: [...CLOUD_RIG_SERVED_ARTIFACTS],
  workBudgetMs: () =>
    BOOT_BUDGET_MS + LEGS.length * (SETTLE_BUDGET_MS + CAPTURE_BUDGET_MS),
  async cells({ browser, run, options, origin, outputDirectory, captures }) {
    if (!options.renderers.includes("webgpu")) {
      throw new ProbeRefusal(
        "renderer-unavailable",
        "the volumetric cloud sun colour is WebGPU-only, so a time-of-day gate " +
          `measured on ${options.renderers.join(",")} would read an empty sky`,
        { renderers: options.renderers },
      );
    }
    const { width, height } = NOON.viewport;
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
      cell[leg.key] = {
        elevDeg: +Number(arm.settled.sunElevationDeg).toFixed(1),
        ...measureTodBand(arm.image),
      };
    }
    const gate = await collectGateErrors(page);
    cell.deviceErrors = (gate.errors || []).filter(
      (error) => !IGNORED_ERRORS.test(error),
    );
    return [cell];
  },
  verdicts(cells) {
    return evaluateTod(cells);
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
