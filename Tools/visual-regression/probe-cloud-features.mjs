#!/usr/bin/env node
/**
 * Batch 611 (E2 CLOUD-EXOTIC-FEATURES-REMAINING) — the sibling supplementary features
 * to B592 mammatus / B610 species, as bounded density SHAPING on the baked-density-field
 * procedural-cloud arch. WebGPU-only.
 * @purpose B611 feature gate: asperitas/fluctus/arcus/virga each reshape the deck; OFF byte-identical under a frozen clock; toggle restores cleanly
 * @status ACTIVE
 * @runtime lib/probe-runtime.mjs
 *
 * globe.defaultCloudCollection.volumetric.cloudFeature ("asperitas" | "fluctus"/"kelvin-helmholtz" | "arcus" | "virga" |
 * "praecipitatio") (or numeric globe.defaultCloudCollection.volumetric.cloudFeatureMode 1-4) shapes the deck:
 *   mode 1 asperitas — chaotic wavy underside carve;
 *   mode 2 fluctus   — Kelvin-Helmholtz breaking-wave billows along the top;
 *   mode 3 arcus     — shelf/roll leading edge;
 *   mode 4 virga     — fallstreak tail below the base (praecipitatio = denser streaks).
 * Default OFF (feature unset → featureMode=0) → the WGSL featureFactor() early-returns
 * 1.0 → byte-identical to the pre-611 render.
 *
 * Boots the Weather Inspector on a dense deck, FREEZES the clock (so cloud advection
 * can't confound the off-gate), and checks:
 *   (1) OFF baseline vs a 2nd OFF capture → ~0 diff (grown 136→140 UBO does not
 *       perturb the OFF render);
 *   (2) each of asperitas / fluctus / arcus / virga ON substantially changes the render;
 *   (3) virga carve THINS the deck (the fallstreak carve removes density);
 *   (4) praecipitatio differs from plain virga (the featureParam reach change);
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
 * this probe's deck fraction from 17.03 % to 15.11 % (OFF) and from 16.25 %
 * to 14.32 % (virga). The pre-harvest probe read that element screenshot, so
 * the numbers it banked are of another population than the ones this probe
 * reads; its first Edge run banks the canvas-read numbers.
 *
 * Usage: node Tools/visual-regression/probe-cloud-features.mjs --port 8094
 */
import {
  armWebGPUDevices,
  attachConsoleErrorGate,
  collectGateErrors,
  errorGateInit,
} from "../lib/webgpu-error-gate.mjs";
import { installCloudProbeHarness } from "./lib/cloud-probe-harness.mjs";
import { captureViewerCanvas } from "./lib/cloud-rig-stage.mjs";
import { greyDeckFraction } from "./lib/metrics/deck-region.mjs";
import { meanAbsLumaDifference } from "./lib/metrics/luma-difference.mjs";
import { ProbeRefusal, isEntryPoint, runProbe } from "./lib/probe-runtime.mjs";
import DECK from "./rigs/weather-inspector-cumulonimbus-deck.mjs";

/** Page boot: the 30 s `goto` default plus the 60 s wait for `window.viewer`. */
const BOOT_BUDGET_MS = 90_000;
/** Settle after each dial change, before its capture; paid 7 times. */
const SETTLE_AFTER_SET_MS = 4000;
/** Eight canvas reads and their decodes in Node. */
const READBACK_BUDGET_MS = 60_000;

/**
 * The deck region the grey-cloud fraction is read over: the pre-harvest
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

const feature = (name) => ({
  cloudFeature: name,
  cloudFeatureStrength: 0.9,
  cloudFeatureScale: 1.0,
});

/** The eight legs: the capture's banked name and the dials set before it. */
const LEGS = Object.freeze([
  { key: "off", capture: "features-off", set: null },
  {
    key: "off2",
    capture: "features-off2",
    set: { cloudFeature: "__undef__", cloudFeatureMode: "__undef__" },
  },
  {
    key: "asperitas",
    capture: "features-asperitas",
    set: feature("asperitas"),
  },
  { key: "fluctus", capture: "features-fluctus", set: feature("fluctus") },
  { key: "arcus", capture: "features-arcus", set: feature("arcus") },
  { key: "virga", capture: "features-virga", set: feature("virga") },
  {
    key: "praecipitatio",
    capture: "features-praecipitatio",
    set: feature("praecipitatio"),
  },
  {
    key: "restore",
    capture: "features-off-restored",
    set: {
      cloudFeature: "__undef__",
      cloudFeatureMode: "__undef__",
      cloudFeatureStrength: "__undef__",
      cloudFeatureScale: "__undef__",
      cloudFeatureParam: "__undef__",
    },
  },
]);

/**
 * The measurements, from the eight decoded captures. Pure; the rounding is
 * the pre-harvest in-page copies' (three places for a diff, two for a deck
 * percentage).
 *
 * @param {Record<string, object>} frames Decoded captures by leg.
 * @returns {{diff: object, deck: object}} The measurements.
 */
export function measureFeatures(frames) {
  const diff = (a, b) => round(meanAbsLumaDifference(a, b), 3);
  return {
    diff: {
      offOff: diff(frames.off, frames.off2),
      asperitas: diff(frames.off, frames.asperitas),
      fluctus: diff(frames.off, frames.fluctus),
      arcus: diff(frames.off, frames.arcus),
      virga: diff(frames.off, frames.virga),
      virgaPraecipitatio: diff(frames.virga, frames.praecipitatio),
      restore: diff(frames.off, frames.restore),
    },
    deck: {
      off: round(greyDeckFraction(frames.off, DECK_REGION), 2),
      virga: round(greyDeckFraction(frames.virga, DECK_REGION), 2),
    },
  };
}

/**
 * The nine B611 clauses, over one run's cells. Pure; same claim text and the
 * same boolean tests as the pre-harvest `checks` array, in the same order.
 *
 * @param {Array<object>} cells The run's cells.
 * @returns {Array<object>} Verdicts in the runtime's shape.
 */
export function evaluateFeatures(cells) {
  const verdicts = [];
  for (const cell of cells) {
    const suffix = `run${cell.run}`;
    const d = cell.diff;
    const changes = (key, name) => ({
      id: `${key}-changes-render/${suffix}`,
      claim: `${name} ON substantially changes the render (${d[key]} > 1.0)`,
      pass: d[key] > 1.0,
      detail: { diff: d[key], tolerance: 1.0 },
    });
    verdicts.push(
      {
        id: `off-deterministic/${suffix}`,
        claim: `OFF is deterministic w/ grown UBO (off-vs-off2 ${d.offOff} < 0.25)`,
        pass: d.offOff < 0.25,
        detail: { diff: d.offOff, tolerance: 0.25 },
      },
      changes("asperitas", "asperitas"),
      changes("fluctus", "fluctus"),
      changes("arcus", "arcus"),
      changes("virga", "virga"),
      {
        id: `virga-thins-deck/${suffix}`,
        claim: `virga carve THINS the deck (virga ${cell.deck.virga} < off ${cell.deck.off} - 0.3)`,
        pass: cell.deck.virga < cell.deck.off - 0.3,
        detail: cell.deck,
      },
      {
        id: `praecipitatio-differs/${suffix}`,
        claim: `praecipitatio differs from virga (prc-vs-virga ${d.virgaPraecipitatio} > 0.3)`,
        pass: d.virgaPraecipitatio > 0.3,
        detail: { diff: d.virgaPraecipitatio, tolerance: 0.3 },
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

function printReport(receipt) {
  for (const cell of receipt.cells) {
    const d = cell.diff;
    console.log(`deck%%: off=${cell.deck.off} virga=${cell.deck.virga}`);
    console.log(
      `diff: off-vs-off2=${d.offOff} asp=${d.asperitas} fluctus=${d.fluctus} arcus=${d.arcus} virga=${d.virga} prc-vs-virga=${d.virgaPraecipitatio} restore=${d.restore} | errs=${cell.deviceErrors.length}`,
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

/** The descriptor the shared runtime executes. */
export const descriptor = {
  name: "cloud-features",
  title:
    "Cloud features (B611) — asperitas/fluctus/arcus/virga reshape the deck, OFF stays byte-identical, the toggle restores",
  // Keeps every capture at `output/features-*.png`, where it was banked.
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
        "the cloud features are WebGPU-only, so a feature gate measured on " +
          `${options.renderers.join(",")} would read an unshaped deck`,
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
      cloudFeature: "__undef__",
      cloudFeatureMode: "__undef__",
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
    return [{ run, ...measureFeatures(frames), deviceErrors }];
  },
  verdicts(cells) {
    return evaluateFeatures(cells);
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
