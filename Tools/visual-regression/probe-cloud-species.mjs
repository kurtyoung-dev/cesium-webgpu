#!/usr/bin/env node
/**
 * Batch 610 (E1 CLOUD-EXOTIC-SPECIES) — species/varieties as bounded density
 * SHAPING on the baked-density-field procedural-cloud arch. WebGPU-only.
 * @purpose E1 acceptance: lenticularis/fibratus/uncinus density shaping changes the deck as specified; species-unset path byte-identical.
 * @status ACTIVE
 * @runtime lib/probe-runtime.mjs
 *
 * globe.defaultCloudCollection.volumetric.cloudSpecies ("lenticularis" | "fibratus" | "uncinus") (or numeric
 * globe.defaultCloudCollection.volumetric.cloudSpeciesMode 1/2) shapes the deck: mode 1 carves smooth wind-aligned
 * stacked lens plates (lenticularis); mode 2 carves wind-aligned wispy filaments
 * (fibratus), with speciesParam adding an uncinus fallstreak hook. Default OFF
 * (species unset → speciesMode=0) → the WGSL speciesFactor() early-returns 1.0 →
 * byte-identical to the pre-610 render.
 *
 * Boots the Weather Inspector on a dense deck, FREEZES the clock (so cloud
 * advection can't confound the off-gate), and checks:
 *   (1) OFF baseline vs a 2nd OFF capture → ~0 diff (grown 132→136 UBO does not
 *       perturb the OFF render);
 *   (2) lenticularis ON substantially changes the render (whole-frame diff);
 *   (3) fibratus ON substantially changes the render, and THINS the deck (the
 *       filament carve removes density → more sky between filaments);
 *   (4) uncinus differs from fibratus (the height-sheared hook re-shapes filaments);
 *   (5) restoring OFF returns to the OFF baseline (clean toggle, no residual);
 *   (6) 0 new device errors.
 *
 * Usage: node Tools/visual-regression/probe-cloud-species.mjs --port 8094
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

/**
 * Page boot: Playwright's 30 s `goto` default plus this probe's own 60 s wait
 * for `window.viewer`.
 */
const BOOT_BUDGET_MS = 90_000;
/** Settle after the dense deck is configured and the clock frozen. */
const SETTLE_AFTER_DECK_MS = 9000;
/** Settle after each `set()`; paid 5 times, once per species toggle. */
const SETTLE_AFTER_SET_MS = 4000;
/** How many times `set()` is called in one run. */
const SET_COUNT = 5;
/** Six element captures plus eight full-frame in-page readbacks. */
const READBACK_BUDGET_MS = 60_000;

const CUMULONIMBUS = 10;

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
 * The seven E1 clauses, over one run's cells.
 *
 * Pure and exported so the routing spec can put every clause on either side of
 * its bar without a browser. The bars are the ones the probe shipped with.
 *
 * @param {Array<object>} cells The run's cells.
 * @returns {Array<object>} Verdicts in the runtime's shape.
 */
export function evaluateSpecies(cells) {
  const verdicts = [];
  for (const cell of cells) {
    const d = cell.diffs;
    const deckPercent = cell.deck;
    const suffix = `run${cell.run}`;
    verdicts.push(
      {
        id: `off-determinism/${suffix}`,
        claim: `OFF is deterministic w/ grown UBO (off-vs-off2 ${d.offOff} < 0.25)`,
        pass: d.offOff < 0.25,
        detail: { diff: d.offOff, tolerance: 0.25 },
      },
      {
        id: `lenticularis-changes/${suffix}`,
        claim: `lenticularis ON substantially changes the render (lent-vs-off ${d.lent} > 1.0)`,
        pass: d.lent > 1.0,
        detail: { diff: d.lent, floor: 1.0 },
      },
      {
        id: `fibratus-changes/${suffix}`,
        claim: `fibratus ON substantially changes the render (fib-vs-off ${d.fib} > 1.0)`,
        pass: d.fib > 1.0,
        detail: { diff: d.fib, floor: 1.0 },
      },
      {
        // The filament carve removes density → measurably thinner deck vs OFF.
        id: `fibratus-thins/${suffix}`,
        claim: `fibratus carve THINS the deck (fib ${deckPercent.fib} < off ${deckPercent.off} - 0.3)`,
        pass: deckPercent.fib < deckPercent.off - 0.3,
        detail: { fib: deckPercent.fib, off: deckPercent.off, margin: 0.3 },
      },
      {
        // The uncinus hook re-shapes the filaments → distinct from straight
        // fibratus.
        id: `uncinus-differs/${suffix}`,
        claim: `uncinus differs from fibratus (unc-vs-fib ${d.fibUnc} > 0.3)`,
        pass: d.fibUnc > 0.3,
        detail: { diff: d.fibUnc, floor: 0.3 },
      },
      {
        id: `restore-clean/${suffix}`,
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
 * The console report, unchanged in shape from the pre-runtime probe.
 *
 * @param {object} receipt The probe receipt.
 * @returns {void}
 */
function printReport(receipt) {
  for (const cell of receipt.cells) {
    const d = cell.diffs;
    console.log(
      `deck%%: off=${cell.deck.off} lent=${cell.deck.lent} fib=${cell.deck.fib}`,
    );
    console.log(
      `diff: off-vs-off2=${d.offOff} lent-vs-off=${d.lent} fib-vs-off=${d.fib} unc-vs-fib=${d.fibUnc} restore-vs-off=${d.restore} | errs=${cell.deviceErrors.length}`,
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
  name: "cloud-species",
  title:
    "Cloud species — lenticularis / fibratus / uncinus density shaping (E1, Batch 610)",
  // The empty subdirectory keeps the six captures exactly where the
  // pre-routing probe wrote them: `output/species-*.png`, not a new folder.
  outputSubdirectory: "",
  // This probe banked no JSON receipt before the migration, so no downstream
  // reader keys off a field set that has to survive byte-comparable.
  receiptEnvelope: "runtime",
  // The demo page loads `Cesium.js` through its own script tag and its boot
  // helper imports `index.js`; the default list's Sandcastle2 bucket bundle is
  // a file this legacy gallery page never touches.
  servedArtifacts: [
    "Build/CesiumUnminified/Cesium.js",
    "Build/CesiumUnminified/index.js",
  ],
  // The budget THIS probe's work needs per run: boot, the deck settle the
  // frozen-clock off-gate is defined over, the five species toggles, and the
  // captures plus readbacks.
  workBudgetMs: () =>
    BOOT_BUDGET_MS +
    SETTLE_AFTER_DECK_MS +
    SET_COUNT * SETTLE_AFTER_SET_MS +
    READBACK_BUDGET_MS,
  async cells({ browser, run, options, origin, outputDirectory, captures }) {
    if (!options.renderers.includes("webgpu")) {
      throw new ProbeRefusal(
        "renderer-unavailable",
        "species shaping runs in the WebGPU raymarcher only, so an E1 gate on " +
          `${options.renderers.join(",")} would measure a deck that was never drawn`,
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

    const shot = async (name) => {
      const capture = await captureElement({
        page,
        selector: ".cesium-widget canvas",
        name,
        outputDirectory,
        captures,
      });
      return `data:image/png;base64,${capture.buffer.toString("base64")}`;
    };

    // Dense deck to shape. FREEZE the clock so cloud advection can't confound
    // the OFF byte-identity gate — with the clock stopped `cloud.time` is
    // constant.
    await page.evaluate((cb) => {
      const v = window.viewer;
      const g = v.scene.globe;
      g.defaultCloudCollection.cloudType = cb;
      g.defaultCloudCollection.volumetric.cloudCoverage = 0.85;
      g.defaultCloudCollection.volumetric.cloudDensity = 0.5;
      g.defaultCloudCollection.volumetric.cloudSpecies = undefined; // OFF (default)
      g.defaultCloudCollection.volumetric.cloudSpeciesMode = undefined;
      v.clock.shouldAnimate = false;
      v.scene.requestRender();
    }, CUMULONIMBUS);
    await page.waitForTimeout(SETTLE_AFTER_DECK_MS);

    const set = async (obj) => {
      await page.evaluate((o) => {
        const g = window.viewer.scene.globe;
        for (const k of Object.keys(o)) {
          g[k] = o[k] === "__undef__" ? undefined : o[k];
        }
        window.viewer.scene.requestRender();
      }, obj);
      await page.waitForTimeout(SETTLE_AFTER_SET_MS);
    };

    const duOff = await shot("species-off");
    const deckOff = await deck(page, duOff);

    // 2nd OFF capture (frozen clock) — determinism / grown-UBO off-gate.
    await set({ cloudSpecies: "__undef__", cloudSpeciesMode: "__undef__" });
    const duOff2 = await shot("species-off2");

    // Lenticularis — smooth stacked lens plates.
    await set({
      cloudSpecies: "lenticularis",
      cloudSpeciesStrength: 0.9,
      cloudSpeciesScale: 1.0,
    });
    const duLent = await shot("species-lenticularis");
    const deckLent = await deck(page, duLent);

    // Fibratus — wind-aligned wispy filaments (straight).
    await set({
      cloudSpecies: "fibratus",
      cloudSpeciesStrength: 0.9,
      cloudSpeciesScale: 1.0,
    });
    const duFib = await shot("species-fibratus");
    const deckFib = await deck(page, duFib);

    // Uncinus — filaments + fallstreak hook (height shear).
    await set({
      cloudSpecies: "uncinus",
      cloudSpeciesStrength: 0.9,
      cloudSpeciesScale: 1.0,
    });
    const duUnc = await shot("species-uncinus");

    // Restore OFF — clean toggle, no residual.
    await set({
      cloudSpecies: "__undef__",
      cloudSpeciesMode: "__undef__",
      cloudSpeciesStrength: "__undef__",
      cloudSpeciesScale: "__undef__",
      cloudSpeciesParam: "__undef__",
    });
    const duRestore = await shot("species-off-restored");

    const diffOffOff = await diff(page, duOff, duOff2);
    const diffLent = await diff(page, duOff, duLent);
    const diffFib = await diff(page, duOff, duFib);
    const diffFibUnc = await diff(page, duFib, duUnc);
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
      {
        run,
        deck: { off: deckOff, lent: deckLent, fib: deckFib },
        diffs: {
          offOff: diffOffOff,
          lent: diffLent,
          fib: diffFib,
          fibUnc: diffFibUnc,
          restore: diffRestore,
        },
        deviceErrors,
      },
    ];
  },
  verdicts(cells) {
    return evaluateSpecies(cells);
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
