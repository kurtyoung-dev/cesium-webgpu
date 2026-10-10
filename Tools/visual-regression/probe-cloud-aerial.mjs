#!/usr/bin/env node
/**
 * W4 — Aerial-perspective blend on distant clouds. WebGPU-only.
 * @purpose W4 aerial-perspective gate: the whole-frame blend coefficient of the far deck exceeds 0.3 and the near deck's by more than 0.08 via the runtime strength toggle; single-run bars
 * @status ACTIVE
 * @runtime lib/probe-runtime.mjs
 *
 * Distant clouds tint toward a time-of-day horizon-haze color (`aerialColor`) by
 * view distance, so they fade into the horizon instead of popping. The shader
 * keys the haze on the march MIDPOINT distance.
 *
 * Framing: camera BELOW the layer (ALT 800 m) looking UP at the cloud underside
 * against a black sky — the same clean framing W1-W3 used (no terrain, no
 * grazing frustum-edge artifact). Raising the deck from 1,500-4,000 m to
 * 28,000-31,000 m moves the SAME-looking clouds tens of kilometres farther from
 * the fixed camera, so the far deck's coefficient against the near deck's
 * isolates distance grading.
 *
 * Verification — A/B per deck, aerial-COEFFICIENT metric:
 *   Render the same camera/time twice: cloudAerialStrength 0 (off) vs 1.
 *   The haze maps the un-hazed mean toward aerialColor:
 *       meanOn ≈ mix(meanOff, aerialColor, a)   →   a ≈ |on-off| / |off-aerial|
 *   `a` is the effective blend fraction, NORMALIZED for how dim/bright the
 *   clouds intrinsically are, averaged over every pixel bright in either arm.
 *
 * Clauses (what the code has always enforced — the pre-harvest header listed
 * `a_far > 2.5 x a_near` and `a_near < 0.2`, which the code replaced with the
 * two below and never asserted):
 *   1. both decks populated with cloud pixels (> 3000 each).
 *   2. far blends toward aerialColor (a_far > 0.3).
 *   3. distance-graded: a_far - a_near > 0.08.
 *   4. near deck less hazed than far (a_near < a_far).
 *   5. no NEW device errors.
 * Then READ output/cloud-aerial-{near,far,beauty}.png — the ON arms and the
 * low-sun oblique beauty shot; the OFF arms are banked beside them as
 * `cloud-aerial-{near,far}-off.png`.
 *
 * ON THE KIT (probe-kit harvest, cloud family, round 1). The decks are the rigs
 * `cloud-aerial-near-deck`, `cloud-aerial-far-deck` and
 * `cloud-aerial-dusk-beauty`, each arm staged, settled, read and banked by
 * `captureCloudRigArm` (`lib/cloud-rig-stage.mjs`; the OFF arm is each rig
 * with the aerial strength overridden to 0); the coefficient is
 * `lib/metrics/aerial-blend.mjs`, computed in Node over the canvas reads; the
 * origin, preflight, Edge slot, lifecycle, receipt and exit code are the
 * runtime's. The frames are the canvas (`toDataURL`, as before the harvest,
 * now in the task of one final render), never element screenshots, which
 * would add the viewer's DOM chrome to the deck. Two deliberate changes from
 * the pre-harvest probe: the coverage, density and weather-map dials now reach
 * the deck (they sat behind `"cloudCoverage" in globe` guards that have been
 * false since Batch 622), and the OFF arms are banked. Its first Edge run on
 * the kit is owed.
 *
 * Usage: node Tools/visual-regression/probe-cloud-aerial.mjs --port 8094
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
import { aerialBlendCoefficient } from "./lib/metrics/aerial-blend.mjs";
import { ProbeRefusal, isEntryPoint, runProbe } from "./lib/probe-runtime.mjs";
import BEAUTY from "./rigs/cloud-aerial-dusk-beauty.mjs";
import FAR from "./rigs/cloud-aerial-far-deck.mjs";
import NEAR from "./rigs/cloud-aerial-near-deck.mjs";

/** The two measured decks, with the file names their arms are banked under. */
const DECKS = Object.freeze([
  {
    key: "near",
    rig: NEAR,
    on: "cloud-aerial-near",
    off: "cloud-aerial-near-off",
  },
  { key: "far", rig: FAR, on: "cloud-aerial-far", off: "cloud-aerial-far-off" },
]);

/** Viewer boot: the page load plus the 60 s wait for `window.viewer`. */
const BOOT_BUDGET_MS = 90_000;
/** One arm's 90-frame settle, at a pessimistic ~0.75 s per volumetric frame. */
const SETTLE_BUDGET_MS = 70_000;
/** One canvas read and its decode. */
const CAPTURE_BUDGET_MS = 15_000;
/** Two arms per deck, plus the beauty shot. */
const ARM_COUNT = DECKS.length * 2 + 1;

/** Each deck must hold more cloud pixels than this to count as populated. */
const MIN_CLOUD_PIXELS = 3000;
/** Console noise the W-series gates have always filtered. */
const IGNORED_ERRORS = /Atmosphere ?LUT|SkyAtmosphere|default layout/i;

/**
 * The horizon-haze colour the shader blends toward, as a function of the
 * sun's elevation in degrees: a smoothstep from warm (0.80, 0.62, 0.50) at
 * the horizon to cool (0.62, 0.72, 0.85) by sin(elevation) = 0.35. This is
 * the gate's REFERENCE MODEL, carried over unchanged from the pre-harvest
 * probe; it is what `a` is measured against, not a metric.
 *
 * @param {number} elevDeg Sun elevation, degrees (the probe passes it rounded to 0.1).
 * @returns {number[]} RGB in 0-1.
 */
export function aerialColorForElevDeg(elevDeg) {
  const sinElev = Math.max(0, Math.min(1, Math.sin((elevDeg * Math.PI) / 180)));
  const e = Math.max(0, Math.min(1, sinElev / 0.35));
  const t = e * e * (3 - 2 * e);
  return [
    0.8 + (0.62 - 0.8) * t,
    0.62 + (0.72 - 0.62) * t,
    0.5 + (0.85 - 0.5) * t,
  ];
}

/**
 * One deck's A/B as the pre-harvest `bandCoeff` reported it: the coefficient
 * and the two means rounded to three places, over the whole frame.
 *
 * @param {object} off The OFF arm, decoded.
 * @param {object} on The ON arm, decoded.
 * @param {number} elevDeg The ON arm's sun elevation, rounded to 0.1 degree.
 * @returns {{cloud: number, meanOff?: number[], meanOn?: number[], a?: number, elevDeg: number}} The deck.
 */
export function measureAerialDeck(off, on, elevDeg) {
  const blend = aerialBlendCoefficient(off, on, aerialColorForElevDeg(elevDeg));
  if (blend.cloud === 0) {
    return { cloud: 0, elevDeg };
  }
  return {
    cloud: blend.cloud,
    meanOff: blend.meanOff.map((v) => +v.toFixed(3)),
    meanOn: blend.meanOn.map((v) => +v.toFixed(3)),
    a: +blend.a.toFixed(3),
    elevDeg,
  };
}

/**
 * The five W4 clauses, over one run's cells. Pure; same claim text and the
 * same boolean tests as the pre-harvest `checks` array, in the same order.
 *
 * @param {Array<object>} cells The run's cells.
 * @returns {Array<object>} Verdicts in the runtime's shape.
 */
export function evaluateAerial(cells) {
  const verdicts = [];
  for (const cell of cells) {
    const suffix = `run${cell.run}`;
    const { near, far } = cell;
    const dGrade = +(far.a - near.a).toFixed(3);
    verdicts.push(
      {
        id: `decks-populated/${suffix}`,
        claim: "both layers populated with clouds",
        pass: near.cloud > MIN_CLOUD_PIXELS && far.cloud > MIN_CLOUD_PIXELS,
        detail: { near: near.cloud, far: far.cloud },
      },
      {
        id: `far-blends/${suffix}`,
        claim: `far layer blends toward aerialColor (a_far ${far.a} > 0.3)`,
        pass: far.a > 0.3,
        detail: far,
      },
      {
        id: `distance-graded/${suffix}`,
        claim: `distance-graded: far deck hazes more than near deck (Δa ${dGrade} > 0.08)`,
        pass: dGrade > 0.08,
        detail: { near: near.a, far: far.a, dGrade },
      },
      {
        id: `near-less-hazed/${suffix}`,
        claim: `near deck less hazed than far (a_near ${near.a} < a_far ${far.a})`,
        pass: near.a < far.a,
        detail: { near: near.a, far: far.a },
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
    console.log("NEAR layer (1.5 km up):", JSON.stringify(cell.near));
    console.log("FAR  layer (28 km up) :", JSON.stringify(cell.far));
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
  name: "cloud-aerial",
  title:
    "Cloud aerial perspective (W4) — the far deck blends toward the haze colour more than the near deck",
  // Keeps the captures at `output/cloud-aerial-*.png`, where they were banked.
  outputSubdirectory: "",
  receiptEnvelope: "runtime",
  servedArtifacts: [...CLOUD_RIG_SERVED_ARTIFACTS],
  workBudgetMs: () =>
    BOOT_BUDGET_MS + ARM_COUNT * (SETTLE_BUDGET_MS + CAPTURE_BUDGET_MS),
  async cells({ browser, run, options, origin, outputDirectory, captures }) {
    if (!options.renderers.includes("webgpu")) {
      throw new ProbeRefusal(
        "renderer-unavailable",
        "the volumetric cloud aerial blend is WebGPU-only, so a distance-grading " +
          `gate measured on ${options.renderers.join(",")} would read an empty sky`,
        { renderers: options.renderers },
      );
    }
    const { width, height } = NEAR.viewport;
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
    for (const deck of DECKS) {
      const off = await captureCloudRigArm({
        page,
        rig: deck.rig,
        overrides: { volumetric: { cloudAerialStrength: 0 } },
        name: deck.off,
        outputDirectory,
        captures,
      });
      const on = await captureCloudRigArm({
        page,
        rig: deck.rig,
        name: deck.on,
        outputDirectory,
        captures,
      });
      cell[deck.key] = measureAerialDeck(
        off.image,
        on.image,
        +Number(on.settled.sunElevationDeg).toFixed(1),
      );
    }
    // The beauty shot is evidence to read, not a measured arm.
    await captureCloudRigArm({
      page,
      rig: BEAUTY,
      name: "cloud-aerial-beauty",
      outputDirectory,
      captures,
    });
    const gate = await collectGateErrors(page);
    cell.deviceErrors = (gate.errors || []).filter(
      (error) => !IGNORED_ERRORS.test(error),
    );
    return [cell];
  },
  verdicts(cells) {
    return evaluateAerial(cells);
  },
  receipt(cells, context) {
    const receipt = {
      rigs: [NEAR.id, FAR.id, BEAUTY.id],
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
