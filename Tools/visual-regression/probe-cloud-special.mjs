#!/usr/bin/env node
/**
 * Batch 612 (E3 CLOUD-EXOTIC-SPECIAL) — the "special clouds" (noctilucent / nacreous)
 * as an iridescent SHADING tint on the WebGPU procedural-cloud arch. WebGPU-only.
 * @purpose E3 acceptance: noctilucent/nacreous iridescent tints change the deck, differ from each other, OFF stays byte-identical.
 * @status ACTIVE
 * @runtime lib/probe-runtime.mjs
 *
 * Unlike the E1/E2 density-shaping dials (species/features), this multiplies the
 * cloud COLOR by an iridescent tint:
 *   globe.defaultCloudCollection.volumetric.cloudSpecial ("noctilucent"/"nlc" | "nacreous"/"psc") (or numeric
 *   globe.defaultCloudCollection.volumetric.cloudSpecialShadeMode 1/2) tints the deck:
 *     mode 1 noctilucent — electric silvery-blue billow bands;
 *     mode 2 nacreous    — pastel mother-of-pearl iridescence keyed to sun/view angle.
 * Default OFF (cloudSpecial unset → specialShadeMode=0) → the WGSL specialShadeTint()
 * early-returns vec3(1.0) so the cloud color is multiplied by exactly 1.0 →
 * byte-identical to the pre-612 render.
 *
 * Boots the Weather Inspector on a dense deck, FREEZES the clock (so cloud advection
 * can't confound the off-gate), and checks:
 *   (1) OFF baseline vs a 2nd OFF capture → ~0 diff (grown 140→144 UBO does not
 *       perturb the OFF render);
 *   (2) noctilucent ON substantially changes the render AND shifts the deck BLUE;
 *   (3) nacreous ON substantially changes the render;
 *   (4) nacreous differs from noctilucent (different tint model);
 *   (5) restoring OFF returns to the OFF baseline (clean toggle, no residual);
 *   (6) 0 new device errors.
 *
 * ON THE KIT (probe-kit harvest, cloud family, round 1). The deck is the rig
 * `weather-inspector-cumulonimbus-deck`; the whole-frame difference is
 * `lib/metrics/luma-difference.mjs` and the region measure is
 * `lib/metrics/deck-region.mjs`, both computed in Node over the canvas
 * reads instead of in the page; every dial goes through the cloud probe
 * harness's `configure`, which throws on a key `CloudVolumetrics` lacks and on
 * a value that did not round-trip; the origin, preflight, Edge slot,
 * lifecycle, receipt and exit code are the runtime's. One deliberate change:
 * the pre-harvest `set()` wrote each toggle onto `viewer.scene.globe`, where
 * no cloud dial has lived since Batch 622 moved them to
 * `globe.defaultCloudCollection.volumetric` (`Globe.js` declares none of these
 * keys; `CloudVolumetrics.js` declares all of them), so the ON legs'
 * assignments landed on an object no cloud dial is read from; they now set the
 * collection's volumetric dials. Its first Edge run on the kit is owed.
 *
 * THE FRAME IS THE CANVAS (harvest round 3). Each leg's frame is the canvas,
 * read by `lib/cloud-rig-stage.mjs`'s `captureViewerCanvas` in the task of
 * one more render at the viewer's frozen clock, never an element screenshot.
 * The demo builds its viewer with every default widget and lays its inspector
 * panel and toolbar over the canvas, so an element screenshot of
 * `.cesium-widget canvas` takes all of them, and the panels are translucent:
 * on the banked 2026-07-05 element frames, blanking the help panel alone moves
 * the sibling features probe's deck fraction from 17.03 % to 15.11 %. The
 * pre-harvest probe read that element screenshot, so the numbers it banked
 * are of another population than the ones this probe reads; its first Edge
 * run banks the canvas-read numbers.
 *
 * Usage: node Tools/visual-regression/probe-cloud-special.mjs --port 8094
 */
import {
  armWebGPUDevices,
  attachConsoleErrorGate,
  collectGateErrors,
  errorGateInit,
} from "../lib/webgpu-error-gate.mjs";
import { installCloudProbeHarness } from "./lib/cloud-probe-harness.mjs";
import { captureViewerCanvas } from "./lib/cloud-rig-stage.mjs";
import { changedPixelChromaShift } from "./lib/metrics/deck-region.mjs";
import { meanAbsLumaDifference } from "./lib/metrics/luma-difference.mjs";
import { ProbeRefusal, isEntryPoint, runProbe } from "./lib/probe-runtime.mjs";
import DECK from "./rigs/weather-inspector-cumulonimbus-deck.mjs";

/** Page boot: the 30 s `goto` default plus the 60 s wait for `window.viewer`. */
const BOOT_BUDGET_MS = 90_000;
/** Settle after each dial change, before its capture; paid 4 times. */
const SETTLE_AFTER_SET_MS = 4000;
/** Five canvas reads and their decodes in Node. */
const READBACK_BUDGET_MS = 60_000;

/**
 * The region the noctilucent cool shift is read over: the pre-harvest
 * probe's, set right of where the inspector panel sits on the page. A canvas
 * read carries no panel; the region is kept so the clause reads the same part
 * of the scene.
 */
const DECK_REGION = Object.freeze({ x0: 0.42, x1: 0.95, y0: 0.08, y1: 0.86 });

/** Console noise the demo cohort has always filtered. */
const IGNORED_ERRORS =
  /Atmosphere ?LUT|SkyAtmosphere|default layout|favicon|bucket\.css|Sandcastle-header|load-cesium-es6/i;

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

/**
 * PAGE SIDE. The deck's collection-level genus and frozen clock, which are not
 * CloudVolumetrics properties and so are not the harness's to set.
 */
const APPLY_COLLECTION = (dials) => {
  const viewer = window.viewer;
  viewer.scene.globe.defaultCloudCollection.cloudType =
    dials.collectionCloudType;
  viewer.clock.shouldAnimate = dials.shouldAnimate;
  viewer.scene.requestRender();
  return { ok: true };
};

/**
 * PAGE SIDE. Set CloudVolumetrics dials through the harness, which throws on a
 * key the class lacks and on a value that did not round-trip. `"__undef__"`
 * stands for `undefined`, which page.evaluate cannot carry as a value.
 */
const APPLY_VOLUMETRIC = (dials) => {
  const volumetric = {};
  for (const [key, value] of Object.entries(dials)) {
    volumetric[key] = value === "__undef__" ? undefined : value;
  }
  const truth = window.__cloudProbe.configure({ volumetric });
  window.viewer.scene.requestRender();
  return { ok: truth.ok };
};

const round = (value, places) => +value.toFixed(places);

/**
 * The seven E3 clauses, over one run's cells. Pure; same claim text and the
 * same boolean tests as the pre-harvest `checks` array, in the same order.
 *
 * @param {Array<object>} cells The run's cells.
 * @returns {Array<object>} Verdicts in the runtime's shape.
 */
export function evaluateSpecial(cells) {
  const verdicts = [];
  for (const cell of cells) {
    const suffix = `run${cell.run}`;
    const d = cell.diff;
    verdicts.push(
      {
        id: `off-deterministic/${suffix}`,
        claim: `OFF is deterministic w/ grown UBO (off-vs-off2 ${d.offOff} < 0.25)`,
        pass: d.offOff < 0.25,
        detail: { diff: d.offOff, tolerance: 0.25 },
      },
      {
        id: `noctilucent-changes-render/${suffix}`,
        claim: `noctilucent ON substantially changes the render (${d.noctilucent} > 1.0)`,
        pass: d.noctilucent > 1.0,
        detail: { diff: d.noctilucent, tolerance: 1.0 },
      },
      {
        id: `noctilucent-cools/${suffix}`,
        claim: `noctilucent COOLS the changed cloud pixels (Δb-Δr ${cell.coolNoctilucent.cool} > 3)`,
        pass: cell.coolNoctilucent.cool > 3,
        detail: cell.coolNoctilucent,
      },
      {
        id: `nacreous-changes-render/${suffix}`,
        claim: `nacreous ON substantially changes the render (${d.nacreous} > 1.0)`,
        pass: d.nacreous > 1.0,
        detail: { diff: d.nacreous, tolerance: 1.0 },
      },
      {
        id: `nacreous-differs/${suffix}`,
        claim: `nacreous differs from noctilucent (nlc-vs-nac ${d.noctilucentNacreous} > 0.5)`,
        pass: d.noctilucentNacreous > 0.5,
        detail: { diff: d.noctilucentNacreous, tolerance: 0.5 },
      },
      {
        id: `restore-returns-to-baseline/${suffix}`,
        claim: `restoring OFF returns to baseline (restore-vs-off ${d.restore} < 0.25)`,
        pass: d.restore < 0.25,
        detail: { diff: d.restore, tolerance: 0.25 },
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

/**
 * The measurements, from the five decoded captures. Pure; the rounding is
 * the pre-harvest in-page copies' (three places for a diff, two for a shift).
 *
 * @param {Record<string, object>} frames Decoded captures by leg.
 * @returns {{diff: object, coolNoctilucent: object}} The measurements.
 */
export function measureSpecial(frames) {
  const diff = (a, b) => round(meanAbsLumaDifference(a, b), 3);
  const cool = changedPixelChromaShift(
    frames.off,
    frames.noctilucent,
    DECK_REGION,
  );
  return {
    diff: {
      offOff: diff(frames.off, frames.off2),
      noctilucent: diff(frames.off, frames.noctilucent),
      nacreous: diff(frames.off, frames.nacreous),
      noctilucentNacreous: diff(frames.noctilucent, frames.nacreous),
      restore: diff(frames.off, frames.restore),
    },
    coolNoctilucent: {
      dr: round(cool.dr, 2),
      db: round(cool.db, 2),
      cool: round(cool.cool, 2),
      n: cool.n,
    },
  };
}

function printReport(receipt) {
  for (const cell of receipt.cells) {
    const c = cell.coolNoctilucent;
    const d = cell.diff;
    console.log(
      `noctilucent cool-shift on changed pixels: Δr=${c.dr} Δb=${c.db} (Δb-Δr=${c.cool}, n=${c.n})`,
    );
    console.log(
      `diff: off-vs-off2=${d.offOff} nlc=${d.noctilucent} nacreous=${d.nacreous} nlc-vs-nac=${d.noctilucentNacreous} restore=${d.restore} | errs=${cell.deviceErrors.length}`,
    );
  }
  console.log("\n=== ANALYSIS ===");
  for (const verdict of receipt.verdicts) {
    console.log(`  [${verdict.pass ? "PASS" : "FAIL"}] ${verdict.claim}`);
  }
  console.log(
    `\nRESULT: ${receipt.verdicts.every((v) => v.pass === true) ? "GREEN" : "RED"}`,
  );
}

/** The five legs: the capture's banked name and the dials set before it. */
const LEGS = Object.freeze([
  { key: "off", capture: "special-off", set: null },
  {
    key: "off2",
    capture: "special-off2",
    set: { cloudSpecial: "__undef__", cloudSpecialShadeMode: "__undef__" },
  },
  {
    key: "noctilucent",
    capture: "special-noctilucent",
    set: {
      cloudSpecial: "noctilucent",
      cloudSpecialShadeStrength: 0.9,
      cloudSpecialShadeScale: 1.0,
    },
  },
  {
    key: "nacreous",
    capture: "special-nacreous",
    set: {
      cloudSpecial: "nacreous",
      cloudSpecialShadeStrength: 0.9,
      cloudSpecialShadeScale: 1.0,
    },
  },
  {
    key: "restore",
    capture: "special-off-restored",
    set: {
      cloudSpecial: "__undef__",
      cloudSpecialShadeMode: "__undef__",
      cloudSpecialShadeStrength: "__undef__",
      cloudSpecialShadeScale: "__undef__",
      cloudSpecialShadeParam: "__undef__",
    },
  },
]);

/** The descriptor the shared runtime executes. */
export const descriptor = {
  name: "cloud-special",
  title:
    "Cloud special (E3) — noctilucent/nacreous tints change the deck, differ, and OFF stays byte-identical",
  // Keeps every capture at `output/special-*.png`, where it was banked.
  outputSubdirectory: "",
  receiptEnvelope: "runtime",
  // The demo page loads `Cesium.js` through its own script tag and its boot
  // helper imports `index.js` — the same two its cohort declares.
  servedArtifacts: [
    "Build/CesiumUnminified/Cesium.js",
    "Build/CesiumUnminified/index.js",
  ],
  workBudgetMs: () =>
    BOOT_BUDGET_MS +
    DECK.readiness.ms +
    SETTLE_AFTER_SET_MS * (LEGS.length - 1) +
    READBACK_BUDGET_MS,
  async cells({ browser, run, options, origin, outputDirectory, captures }) {
    if (!options.renderers.includes("webgpu")) {
      throw new ProbeRefusal(
        "renderer-unavailable",
        "the special-cloud tints are WebGPU-only, so a tint gate measured on " +
          `${options.renderers.join(",")} would read an untinted deck`,
        { renderers: options.renderers },
      );
    }
    const { width, height } = DECK.viewport;
    const page = await browser.newPage({ viewport: { width, height } });
    const consoleErrors = attachConsoleErrorGate(page);
    await page.addInitScript(errorGateInit);
    await page.addInitScript(SANDCASTLE_STUB);
    await page.addInitScript(installCloudProbeHarness);
    await page.goto(`${origin}/${DECK.page}`, {
      waitUntil: "domcontentloaded",
    });
    await page.addStyleTag({
      content:
        "#cesiumContainer{position:absolute;top:0;left:0;width:100%;height:100%;}#loadingOverlay{display:none;}",
    });
    const boot = await page.evaluate(BOOT);
    if (!boot.ok) {
      throw new ProbeRefusal(
        "demo-boot-failed",
        `the Weather Inspector demo did not boot: ${boot.err}`,
        { page: DECK.page, error: boot.err },
      );
    }
    await page.waitForFunction(
      () => !!(window.viewer && window.viewer.scene),
      null,
      { timeout: 60000 },
    );
    await armWebGPUDevices(page);

    // The rig's deck, OFF by default, clock frozen so advection cannot
    // confound the byte-identity legs.
    await page.evaluate(APPLY_COLLECTION, DECK.dials);
    await page.evaluate(APPLY_VOLUMETRIC, {
      cloudCoverage: DECK.dials.cloudCoverage,
      cloudDensity: DECK.dials.cloudDensity,
      cloudSpecial: "__undef__",
      cloudSpecialShadeMode: "__undef__",
    });
    await page.waitForTimeout(DECK.readiness.ms);

    const frames = {};
    for (const leg of LEGS) {
      if (leg.set !== null) {
        await page.evaluate(APPLY_VOLUMETRIC, leg.set);
        await page.waitForTimeout(SETTLE_AFTER_SET_MS);
      }
      const shot = await captureViewerCanvas({
        page,
        name: leg.capture,
        rigId: DECK.id,
        outputDirectory,
        captures,
      });
      frames[leg.key] = shot.image;
    }

    const gate = await collectGateErrors(page);
    const deviceErrors = (gate.errors || [])
      .concat(consoleErrors)
      .filter((error) => !IGNORED_ERRORS.test(error));
    return [{ run, ...measureSpecial(frames), deviceErrors }];
  },
  verdicts(cells) {
    return evaluateSpecial(cells);
  },
  receipt(cells, context) {
    const receipt = { rig: DECK.id, cells, verdicts: context.verdicts };
    if (cells.length > 0) {
      printReport(receipt);
    }
    return receipt;
  },
};

if (isEntryPoint(import.meta.url)) {
  process.exitCode = await runProbe(descriptor);
}
