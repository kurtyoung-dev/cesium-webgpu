#!/usr/bin/env node
/**
 * Batch 555 (E2 CLOUD-MAMMATUS) — pendulous underside pouches. WebGPU-only.
 * @purpose B555 mammatus gate: underside pouch carve visibly thins the deck, OFF byte-identical under a frozen clock, strength=0 restores the baseline
 * @status ACTIVE
 * @runtime lib/probe-runtime.mjs
 *
 * globe.defaultCloudCollection.volumetric.cloudMammatusStrength (+ Scale/Depth) carves the cloud UNDERSIDE between
 * rounded lobe cells so the flat base reads as a field of downward-bulging pouches
 * (the mammatus signature). Default OFF (strength undefined/0) → the WGSL
 * mammatusFactor() early-returns 1.0 → byte-identical to the pre-555 render.
 *
 * This probe boots the Weather Inspector on a dense towering (cumulonimbus) deck,
 * FREEZES the clock (so cloud animation can't confound the off-gate), and:
 *   (1) OFF baseline vs a 2nd OFF capture with the frozen clock → ~0 diff
 *       (deterministic; the grown 128→132 UBO does not perturb the OFF render);
 *   (2) mammatusStrength=1.5 substantially changes the render (whole-frame diff);
 *   (3) the underside carve REMOVES density → the deck fraction DROPS vs OFF
 *       (more sky shows between the pouches);
 *   (4) restoring strength=0 returns to the OFF baseline (clean toggle, no residual);
 *   (5) 0 new device errors.
 *
 * Usage: node Tools/visual-regression/probe-cloud-mammatus.mjs --port 8094
 *
 * The origin comes from the runtime (`--port`, governed, never 8080) and the
 * served-build preflight runs before Edge is launched, so a run against a tree
 * whose served bytes are not the bytes on disk refuses instead of measuring.
 */
import {
  errorGateInit,
  armWebGPUDevices,
  collectGateErrors,
  attachConsoleErrorGate,
} from "../lib/webgpu-error-gate.mjs";
import {
  ProbeRefusal,
  captureElement,
  isEntryPoint,
  runProbe,
} from "./lib/probe-runtime.mjs";

const W = 1024,
  H = 768;
const DEMO = "/Apps/Sandcastle/gallery/WebGPU%20Weather%20Inspector.html";

const CUMULONIMBUS = 10;

/**
 * Page boot: Playwright's 30 s `goto` default plus this probe's own 60 s wait
 * for `window.viewer`.
 */
const BOOT_BUDGET_MS = 90_000;
/**
 * Settle after the deck (cumulonimbus, coverage, density) is configured and
 * the clock is frozen, before the OFF baseline capture.
 */
const SETTLE_AFTER_SETUP_MS = 9000;
/**
 * Settle the `set()` helper pays after each globe-property change, before the
 * capture that follows it — paid 3 times (the 2nd-OFF cell, the ON cell, and
 * the restore cell).
 */
const SETTLE_AFTER_SET_MS = 4000;
/**
 * Four element captures (off, off2, on, off-restored) plus five in-page
 * decode round trips (two `deck()` fractions, three `diff()` luminance
 * comparisons) — roughly double the template's one-capture-plus-one-decode
 * budget.
 */
const READBACK_BUDGET_MS = 60_000;

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

// Grey-cloud-deck fraction in the deck region (lower-centre, right of panel).
function deck(page, dataUrl) {
  return page.evaluate(async (du) => {
    const img = new Image();
    img.src = du;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const cx = c.getContext("2d");
    cx.drawImage(img, 0, 0);
    const x0 = Math.floor(c.width * 0.42),
      x1 = Math.floor(c.width * 0.95),
      y0 = Math.floor(c.height * 0.08),
      y1 = Math.floor(c.height * 0.86);
    const d = cx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
    let cloud = 0,
      n = 0;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i],
        g = d[i + 1],
        b = d[i + 2];
      const L = 0.299 * r + 0.587 * g + 0.114 * b;
      const mx = Math.max(r, g, b),
        mn = Math.min(r, g, b);
      const blueSky = b > r + 25 && b > 120;
      if (!blueSky && L > 90 && mx - mn < 50) {
        cloud++;
      }
      n++;
    }
    return +((100 * cloud) / n).toFixed(2);
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

/**
 * The mammatus clauses, over one run's cells.
 *
 * Pure and exported so the routing spec can exercise the thresholds without a
 * browser. One verdict per clause in the old `checks` array, in the same
 * order, with the same claim text and the same boolean test.
 *
 * @param {Array<object>} cells The run's cells.
 * @returns {Array<object>} Verdicts in the runtime's shape.
 */
export function evaluateMammatus(cells) {
  const verdicts = [];
  for (const cell of cells) {
    const suffix = `run${cell.run}`;
    verdicts.push(
      {
        id: `off-deterministic/${suffix}`,
        claim: `OFF is deterministic w/ grown UBO (off-vs-off2 ${cell.diffOffOff} < 0.25)`,
        pass: cell.diffOffOff < 0.25,
        detail: { diff: cell.diffOffOff, tolerance: 0.25 },
      },
      {
        id: `mammatus-on-changes-render/${suffix}`,
        claim: `mammatus ON substantially changes the render (on-vs-off ${cell.diffOn} > 1.5)`,
        pass: cell.diffOn > 1.5,
        detail: { diff: cell.diffOn, threshold: 1.5 },
      },
      // Carving between pouches removes underside density → measurably thinner deck
      // (directional; the drop is ~14x the off-vs-off2 noise floor of ~0.05).
      {
        id: `underside-carve-thins-deck/${suffix}`,
        claim: `underside carve THINS the deck (on ${cell.deckOn} < off ${cell.deckOff} - 0.3)`,
        pass: cell.deckOn < cell.deckOff - 0.3,
        detail: { deckOn: cell.deckOn, deckOff: cell.deckOff },
      },
      {
        id: `restore-returns-to-off/${suffix}`,
        claim: `restoring strength=0 returns to OFF baseline (restore-vs-off ${cell.diffRestore} < 0.25)`,
        pass: cell.diffRestore < 0.25,
        detail: { diff: cell.diffRestore, tolerance: 0.25 },
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
 * The console report, unchanged in shape from the pre-runtime probe.
 *
 * @param {object} receipt The probe receipt.
 * @returns {void}
 */
function printReport(receipt) {
  for (const cell of receipt.cells) {
    console.log(`deck%%: off=${cell.deckOff} on=${cell.deckOn}`);
    console.log(
      `diff: off-vs-off2=${cell.diffOffOff} on-vs-off=${cell.diffOn} restore-vs-off=${cell.diffRestore} | errs=${cell.deviceErrors.length}`,
    );
  }
  console.log("\n=== ANALYSIS ===");
  for (const verdict of receipt.verdicts) {
    console.log(`  [${verdict.pass ? "PASS" : "FAIL"}] ${verdict.claim}`);
  }
  const errors = receipt.cells.flatMap((cell) => cell.deviceErrors);
  if (errors.length > 0) {
    console.log("  errors:", errors.slice(0, 5));
  }
  console.log(
    `\nRESULT: ${receipt.verdicts.every((v) => v.pass === true) ? "GREEN" : "RED"}`,
  );
}

/** The descriptor the shared runtime executes. */
export const descriptor = {
  name: "cloud-mammatus",
  title:
    "Cloud mammatus — the underside pouch carve thins the deck, OFF stays byte-identical, and the toggle is clean",
  // The empty subdirectory keeps the captures exactly where the pre-routing
  // probe wrote them: `output/mammatus-off.png`, `output/mammatus-off2.png`,
  // `output/mammatus-on.png`, `output/mammatus-off-restored.png` — not a new
  // folder beneath it.
  outputSubdirectory: "",
  // This probe banked no JSON receipt before the migration, so no downstream
  // reader keys off a field set that has to survive byte-comparable: the
  // single-document runtime envelope is the honest shape for it.
  receiptEnvelope: "runtime",
  // The demo page loads `Cesium.js` through its own script tag and its boot
  // helper imports `index.js`; the default list's Sandcastle2 bucket bundle is
  // a file this legacy gallery page never touches, so naming it would refuse
  // runs over an artifact the measurement does not read.
  servedArtifacts: [
    "Build/CesiumUnminified/Cesium.js",
    "Build/CesiumUnminified/index.js",
  ],
  // The budget THIS probe's work needs per run: boot, the setup settle, the
  // three post-`set()` settles, and the capture/decode readback.
  workBudgetMs: () =>
    BOOT_BUDGET_MS +
    SETTLE_AFTER_SETUP_MS +
    SETTLE_AFTER_SET_MS * 3 +
    READBACK_BUDGET_MS,
  async cells({ browser, run, options, origin, outputDirectory, captures }) {
    if (!options.renderers.includes("webgpu")) {
      throw new ProbeRefusal(
        "renderer-unavailable",
        "the mammatus underside carve is WebGPU-only, so a measurement on " +
          `${options.renderers.join(",")} would read a deck with no carve to gate`,
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
      // measurement: the runtime refuses (exit 3) rather than scoring it 1.
      throw new ProbeRefusal(
        "demo-boot-failed",
        `the Weather Inspector demo did not boot: ${boot.err}`,
        { demo: DEMO, error: boot.err },
      );
    }
    await page.waitForFunction(
      () => !!(window.viewer && window.viewer.scene),
      null,
      {
        timeout: 60000,
      },
    );
    await armWebGPUDevices(page);

    // Dense towering deck (mammatus lives on the underside of a Cb anvil). FREEZE the
    // clock so cloud advection can't confound the OFF byte-identity gate — with the
    // clock stopped `cloud.time` is constant across captures.
    await page.evaluate((cb) => {
      const v = window.viewer;
      const g = v.scene.globe;
      g.defaultCloudCollection.cloudType = cb;
      g.defaultCloudCollection.volumetric.cloudCoverage = 0.85;
      g.defaultCloudCollection.volumetric.cloudDensity = 0.5;
      g.defaultCloudCollection.volumetric.cloudMammatusStrength = undefined; // OFF (default)
      v.clock.shouldAnimate = false;
      v.scene.requestRender();
    }, CUMULONIMBUS);
    await page.waitForTimeout(SETTLE_AFTER_SETUP_MS);

    const set = async (obj) => {
      await page.evaluate((o) => {
        const g = window.viewer.scene.globe;
        for (const k of Object.keys(o)) {
          g[k] = o[k];
        }
        window.viewer.scene.requestRender();
      }, obj);
      await page.waitForTimeout(SETTLE_AFTER_SET_MS);
    };

    const captureOff = await captureElement({
      page,
      selector: ".cesium-widget canvas",
      name: "mammatus-off",
      outputDirectory,
      captures,
    });
    const duOff = `data:image/png;base64,${captureOff.buffer.toString("base64")}`;
    const deckOff = await deck(page, duOff);

    // 2nd OFF capture (frozen clock) — determinism / grown-UBO off-gate.
    await set({ cloudMammatusStrength: undefined });
    const captureOff2 = await captureElement({
      page,
      selector: ".cesium-widget canvas",
      name: "mammatus-off2",
      outputDirectory,
      captures,
    });
    const duOff2 = `data:image/png;base64,${captureOff2.buffer.toString("base64")}`;

    // ON — pronounced underside pouches.
    await set({
      cloudMammatusStrength: 1.5,
      cloudMammatusScale: 1.0,
      cloudMammatusDepth: 0.4,
    });
    const captureOn = await captureElement({
      page,
      selector: ".cesium-widget canvas",
      name: "mammatus-on",
      outputDirectory,
      captures,
    });
    const duOn = `data:image/png;base64,${captureOn.buffer.toString("base64")}`;
    const deckOn = await deck(page, duOn);

    // Restore OFF — clean toggle, no residual.
    await set({
      cloudMammatusStrength: undefined,
      cloudMammatusScale: undefined,
      cloudMammatusDepth: undefined,
    });
    const captureRestore = await captureElement({
      page,
      selector: ".cesium-widget canvas",
      name: "mammatus-off-restored",
      outputDirectory,
      captures,
    });
    const duRestore = `data:image/png;base64,${captureRestore.buffer.toString("base64")}`;

    const diffOffOff = await diff(page, duOff, duOff2);
    const diffOn = await diff(page, duOff, duOn);
    const diffRestore = await diff(page, duOff, duRestore);

    const gate = await collectGateErrors(page);
    const deviceErrors = (gate.errors || [])
      .concat(consoleErrors)
      .filter(
        (e) =>
          !/Atmosphere ?LUT|SkyAtmosphere|default layout|favicon|bucket\.css|Sandcastle-header|load-cesium-es6/i.test(
            e,
          ),
      );

    return [
      { run, deckOff, deckOn, diffOffOff, diffOn, diffRestore, deviceErrors },
    ];
  },
  verdicts(cells) {
    return evaluateMammatus(cells);
  },
  receipt(cells, context) {
    const receipt = {
      demo: DEMO,
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
