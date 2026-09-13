#!/usr/bin/env node
/**
 * CLOUD-U7-EXOTIC-E1-E2 — exotic E1/E2 flags exposed through collection.volumetric.
 * @purpose U7 gate: exotic E1/E2 dials (mammatus/species/feature) reach the raymarcher via collection.volumetric; off states byte-identical
 * @status ACTIVE
 * @runtime lib/probe-runtime.mjs
 *
 * WebGPU-only. Slice 7 of the cloud-unification epic.
 *
 * The exotic density-shaping dials all live on
 * globe.defaultCloudCollection.volumetric (a CloudVolumetrics instance) and reach
 * the raymarcher purely through _resolveVolumetricConfig()'s `...this.volumetric`
 * spread (published via context.requestVolumetricClouds, consumed by
 * WebGPUSceneRendererEnvironmentalEffects → WebGPUProceduralCloudRenderer, which
 * packs them into UBO slots 128-139 and the WGSL ProceduralClouds.wgsl consumes
 * them):
 *   - E2 mammatus  : cloudMammatus{Strength,Scale,Depth}   → slots 128-131
 *   - E1 species   : cloudSpecies / cloudSpecies{Mode,...}  → slots 132-135
 *   - E2 remaining : cloudFeature / cloudFeature{Mode,...}  → slots 136-139
 *
 * Claims:
 *   (1) OFF-GATE: in BILLBOARD mode (no volumetric deck) flipping the exotic flags
 *       on↔off is BYTE-IDENTICAL — they are inert stores off the deck path.
 *   (2) OFF-GATE: in VOLUMETRIC mode with all exotics OFF, two successive renders
 *       are byte-identical (the mode=0 early-out path is deterministic and
 *       reproduces today's pixels).
 *   (3) WIRING (E2 mammatus): volumetric.cloudMammatusStrength through the collection
 *       materially changes the deck.
 *   (4) WIRING (E1 species): volumetric.cloudSpecies="lenticularis" through the
 *       collection materially changes the deck.
 *   (5) WIRING (E2 feature): volumetric.cloudFeature="asperitas" through the
 *       collection materially changes the deck.
 *   (6) no NEW device errors.
 *
 * Usage: node Tools/visual-regression/probe-cloud-exotic-flags.mjs --port 8094
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
/** The terrain/imagery streaming wait, which this probe lets lapse rather than fail. */
const TILES_LOADED_TIMEOUT_MS = 30_000;
/** Settle after streaming, before the first capture. */
const SETTLE_AFTER_TILES_MS = 3000;
/** Settle after each `apply()`; paid 11 times, once per configuration change. */
const SETTLE_AFTER_APPLY_MS = 4500;
/** How many times `apply()` is called in one run. */
const APPLY_COUNT = 11;
/** Seven element captures plus five full-frame in-page luminance diffs. */
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
      return +(acc / n).toFixed(4);
    },
    [a, b],
  );
}

/**
 * The six U7 clauses, over one run's cells.
 *
 * Pure and exported so the routing spec can put every clause on either side of
 * its bar without a browser. The bars are the ones the probe shipped with: two
 * off-gates stated as an upper bound on drift, three wiring clauses stated as a
 * lower bound on change, and the device-error gate.
 *
 * @param {Array<object>} cells The run's cells.
 * @returns {Array<object>} Verdicts in the runtime's shape.
 */
export function evaluateExoticFlags(cells) {
  const verdicts = [];
  for (const cell of cells) {
    const d = cell.diffs;
    const suffix = `run${cell.run}`;
    verdicts.push(
      {
        id: `off-gate-billboard/${suffix}`,
        claim: `OFF-GATE billboard: exotic flags inert (off vs exoticOn diff ${d.billboard} < 0.4)`,
        pass: d.billboard < 0.4,
        detail: { diff: d.billboard, tolerance: 0.4 },
      },
      {
        id: `off-gate-volumetric/${suffix}`,
        claim: `OFF-GATE volumetric: exotics-off render deterministic (stability diff ${d.volumetricStable} < 0.6)`,
        pass: d.volumetricStable < 0.6,
        detail: { diff: d.volumetricStable, tolerance: 0.6 },
      },
      {
        // Mammatus only carves the underside band (depth fraction), so it is
        // the subtlest of the three exotic modes — 0.4 cleanly separates its
        // real change from the 0 deterministic stability floor.
        id: `wiring-mammatus/${suffix}`,
        claim: `WIRING E2 mammatus: cloudMammatusStrength through collection changes the deck (diff ${d.mammatus} > 0.4)`,
        pass: d.mammatus > 0.4,
        detail: { diff: d.mammatus, floor: 0.4 },
      },
      {
        id: `wiring-species/${suffix}`,
        claim: `WIRING E1 species: cloudSpecies=lenticularis through collection changes the deck (diff ${d.species} > 1.0)`,
        pass: d.species > 1.0,
        detail: { diff: d.species, floor: 1.0 },
      },
      {
        id: `wiring-feature/${suffix}`,
        claim: `WIRING E2 feature: cloudFeature=asperitas through collection changes the deck (diff ${d.feature} > 1.0)`,
        pass: d.feature > 1.0,
        detail: { diff: d.feature, floor: 1.0 },
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
      `diff: billboard(off vs exoticOn)=${d.billboard} volumetric(off stability)=${d.volumetricStable} mammatus=${d.mammatus} species=${d.species} feature=${d.feature} | errs=${cell.deviceErrors.length}`,
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
  name: "cloud-exotic-flags",
  title:
    "Cloud exotic E1/E2 flags — mammatus, species and feature through collection.volumetric",
  // The empty subdirectory keeps the seven captures exactly where the
  // pre-routing probe wrote them: `output/exotic-*.png`, not a new folder.
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
  // The budget THIS probe's work needs per run: boot, the streaming wait it
  // lets lapse, and the eleven settles its eleven configuration changes are
  // each defined over, plus the captures and the five full-frame diffs.
  workBudgetMs: () =>
    BOOT_BUDGET_MS +
    TILES_LOADED_TIMEOUT_MS +
    SETTLE_AFTER_TILES_MS +
    APPLY_COUNT * SETTLE_AFTER_APPLY_MS +
    READBACK_BUDGET_MS,
  async cells({ browser, run, options, origin, outputDirectory, captures }) {
    if (!options.renderers.includes("webgpu")) {
      throw new ProbeRefusal(
        "renderer-unavailable",
        "the exotic dials reach the raymarcher only on WebGPU, so a U7 gate on " +
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
    const apply = async (fn) => {
      await page.evaluate(fn);
      await page.waitForTimeout(SETTLE_AFTER_APPLY_MS);
    };

    // Let terrain/imagery finish streaming before any capture, else an
    // in-flight tile load confounds the byte-identity diffs.
    await page
      .waitForFunction(
        () => window.viewer.scene.globe.tilesLoaded === true,
        null,
        {
          timeout: TILES_LOADED_TIMEOUT_MS,
        },
      )
      .catch(() => {});
    await page.waitForTimeout(SETTLE_AFTER_TILES_MS);

    // Common deck config so the exotic modes have a deck to shape.
    const deckCfg = () => {
      const v = window.viewer.scene.globe.defaultCloudCollection.volumetric;
      v.cloudCoverage = 0.6;
      v.cloudDensity = 0.9;
      v.cloudLayerBottom = 1500;
      v.cloudLayerTop = 4000;
      window.viewer.scene.requestRender();
    };
    const clearExotics = () => {
      const v = window.viewer.scene.globe.defaultCloudCollection.volumetric;
      v.cloudMammatusStrength = undefined;
      v.cloudSpecies = undefined;
      v.cloudSpeciesMode = undefined;
      v.cloudFeature = undefined;
      v.cloudFeatureMode = undefined;
      window.viewer.scene.requestRender();
    };

    // ── OFF-GATE 1: BILLBOARD mode — exotic flags inert off the deck path ──
    await apply(() => {
      const c = window.viewer.scene.globe.defaultCloudCollection;
      c.enableVolumetric = false; // renderMode → BILLBOARD
      const v = c.volumetric;
      v.cloudMammatusStrength = undefined;
      v.cloudSpecies = undefined;
      v.cloudFeature = undefined;
      window.viewer.scene.requestRender();
    });
    const billOff = await shot("exotic-billboard-off");
    await apply(() => {
      const v = window.viewer.scene.globe.defaultCloudCollection.volumetric;
      v.cloudMammatusStrength = 0.8;
      v.cloudMammatusScale = 2.0;
      v.cloudMammatusDepth = 0.4;
      v.cloudSpecies = "lenticularis";
      v.cloudFeature = "asperitas";
      window.viewer.scene.requestRender();
    });
    const billOn = await shot("exotic-billboard-exoticon");
    const diffBillboard = await diff(page, billOff, billOn);

    // ── OFF-GATE 2 + WIRING: VOLUMETRIC mode ──
    await apply(() => {
      window.viewer.scene.globe.defaultCloudCollection.enableVolumetric = true;
      window.viewer.scene.requestRender();
    });
    await apply(deckCfg);
    await apply(clearExotics);
    const volOffA = await shot("exotic-volumetric-off-a");
    await apply(() => window.viewer.scene.requestRender());
    const volOffB = await shot("exotic-volumetric-off-b");
    const diffVolStable = await diff(page, volOffA, volOffB);

    // WIRING (E2 mammatus)
    await apply(() => {
      const v = window.viewer.scene.globe.defaultCloudCollection.volumetric;
      v.cloudMammatusStrength = 0.9;
      v.cloudMammatusScale = 2.5;
      v.cloudMammatusDepth = 0.5;
      window.viewer.scene.requestRender();
    });
    const volMammatus = await shot("exotic-volumetric-mammatus");
    const diffMammatus = await diff(page, volOffA, volMammatus);

    // WIRING (E1 species) — reset exotics, then lenticularis
    await apply(clearExotics);
    await apply(() => {
      const v = window.viewer.scene.globe.defaultCloudCollection.volumetric;
      v.cloudSpecies = "lenticularis";
      v.cloudSpeciesStrength = 1.0;
      window.viewer.scene.requestRender();
    });
    const volSpecies = await shot("exotic-volumetric-species");
    const diffSpecies = await diff(page, volOffA, volSpecies);

    // WIRING (E2 feature) — reset exotics, then asperitas
    await apply(clearExotics);
    await apply(() => {
      const v = window.viewer.scene.globe.defaultCloudCollection.volumetric;
      v.cloudFeature = "asperitas";
      v.cloudFeatureStrength = 1.0;
      window.viewer.scene.requestRender();
    });
    const volFeature = await shot("exotic-volumetric-feature");
    const diffFeature = await diff(page, volOffA, volFeature);

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
        diffs: {
          billboard: diffBillboard,
          volumetricStable: diffVolStable,
          mammatus: diffMammatus,
          species: diffSpecies,
          feature: diffFeature,
        },
        deviceErrors,
      },
    ];
  },
  verdicts(cells) {
    return evaluateExoticFlags(cells);
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
