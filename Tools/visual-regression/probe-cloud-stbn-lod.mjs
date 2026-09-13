#!/usr/bin/env node
/**
 * C6-CLOUD-STBN-TAAU (LOD half) — geometric in-march step growth + far-cap on the
 * WebGPU volumetric cloud view-ray march (marchDeck in ProceduralClouds.wgsl).
 * @purpose Acceptance for cloud march LOD dials (step growth, max ray distance): both reach the march, both true no-ops at defaults.
 * @status ACTIVE
 * @runtime lib/probe-runtime.mjs
 *
 * WebGPU-only. Two orbit-cost dials on globe.defaultCloudCollection.volumetric:
 *   - cloudMarchStepGrowth (UBO 144) — 1.0 off; (1.0,1.1] grows the step with
 *     distance so far shell samples (1-2 px) coarsen.
 *   - cloudMaxRayDistance  (UBO 145) — 0 off; >0 stops the march past that distance.
 *
 * Claims:
 *   (1) OFF-GATE: with both dials OFF (undefined → 1.0 / 0), two successive renders
 *       are byte-identical (deterministic default path).
 *   (2) OFF-GATE: explicit cloudMarchStepGrowth=1.0 + cloudMaxRayDistance=0 is
 *       byte-identical to the undefined default (1.0/0 are true no-ops).
 *   (3) WIRING (step growth): cloudMarchStepGrowth=1.08 materially changes the
 *       far-shell render (the dial reaches the march) while clouds still render.
 *   (4) WIRING (far cap): a finite cloudMaxRayDistance materially changes the
 *       horizon render (the far shell is cut).
 *   (5) no NEW device errors.
 *
 * Usage: node Tools/visual-regression/probe-cloud-stbn-lod.mjs --port 8094
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
/** Settle after streaming, before the deck config is applied. */
const SETTLE_AFTER_TILES_MS = 3000;
/** Settle after each `apply()`; paid 7 times, once per configuration change. */
const SETTLE_AFTER_APPLY_MS = 4500;
/** How many times `apply()` is called in one run (camera, deck config, requestRender, off-b, explicit-off, growth-on, cap-on). */
const APPLY_COUNT = 7;
/** Five element captures plus four full-frame in-page luminance diffs. */
const READBACK_BUDGET_MS = 45_000;

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
 * The five LOD clauses, over one run's cells.
 *
 * Pure and exported so the routing spec can put every clause on either side of
 * its bar without a browser. The two off-gates are stated as an upper bound on
 * drift (deterministic default path, true no-op at explicit 1.0/0), the two
 * wiring clauses as a lower bound on change, and the device-error gate closes
 * the set — the same five clauses the pre-routing `checks` array carried, in
 * the same order.
 *
 * @param {Array<object>} cells The run's cells.
 * @returns {Array<object>} Verdicts in the runtime's shape.
 */
export function evaluateStbnLod(cells) {
  const verdicts = [];
  for (const cell of cells) {
    const d = cell.diffs;
    const suffix = `run${cell.run}`;
    verdicts.push(
      {
        id: `off-gate-stability/${suffix}`,
        claim: `OFF-GATE: default render deterministic (stability diff ${d.offStable} == 0)`,
        pass: d.offStable === 0,
        detail: { diff: d.offStable },
      },
      {
        id: `off-gate-explicit-noop/${suffix}`,
        claim: `OFF-GATE: explicit growth=1.0 + cap=0 byte-identical to undefined default (diff ${d.explicitOff} == 0)`,
        pass: d.explicitOff === 0,
        detail: { diff: d.explicitOff },
      },
      {
        id: `wiring-step-growth/${suffix}`,
        claim: `WIRING step growth: cloudMarchStepGrowth=1.08 materially changes the far shell (diff ${d.growth} > 0.15)`,
        pass: d.growth > 0.15,
        detail: { diff: d.growth, floor: 0.15 },
      },
      {
        id: `wiring-far-cap/${suffix}`,
        claim: `WIRING far cap: cloudMaxRayDistance=40km materially changes the horizon (diff ${d.cap} > 0.15)`,
        pass: d.cap > 0.15,
        detail: { diff: d.cap, floor: 0.15 },
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
      `diff: off-stability=${d.offStable} explicit-off=${d.explicitOff} growth=${d.growth} cap=${d.cap} | errs=${cell.deviceErrors.length}`,
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
  name: "cloud-stbn-lod",
  title:
    "Cloud march LOD dials — step growth and far cap on the volumetric view-ray march",
  // The empty subdirectory keeps the five captures exactly where the
  // pre-routing probe wrote them: `output/stbnlod-*.png`, not a new folder.
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
  // lets lapse plus its settle, the seven configuration-change settles, and
  // the five captures plus four full-frame diffs.
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
        "the cloud march LOD dials (step growth, far cap) are WebGPU-only " +
          `raymarch parameters, so a run on ${options.renderers.join(",")} would measure a march that never executed`,
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

    // Horizon-grazing camera at altitude so the cloud shell extends to the far
    // horizon — the regime where the far-shell coarsen / far-cap actually bite.
    await apply(() => {
      const C = window.Cesium;
      window.viewer.scene.camera.setView({
        destination: C.Cartesian3.fromDegrees(-100.0, 30.0, 9000.0),
        orientation: {
          heading: C.Math.toRadians(20.0),
          pitch: C.Math.toRadians(-8.0),
          roll: 0.0,
        },
      });
      window.viewer.scene.requestRender();
    });

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

    // Volumetric deck config — a solid shell so the march has real length.
    const deckCfg = () => {
      const c = window.viewer.scene.globe.defaultCloudCollection;
      c.enableVolumetric = true;
      const v = c.volumetric;
      v.cloudCoverage = 0.6;
      v.cloudDensity = 0.9;
      v.cloudLayerBottom = 1500;
      v.cloudLayerTop = 4000;
      v.cloudMarchStepGrowth = undefined;
      v.cloudMaxRayDistance = undefined;
      window.viewer.scene.requestRender();
    };
    await apply(deckCfg);
    await apply(() => window.viewer.scene.requestRender());

    // ── OFF-GATE 1: default (both dials undefined) is deterministic ──
    const offA = await shot("stbnlod-off-a");
    await apply(() => window.viewer.scene.requestRender());
    const offB = await shot("stbnlod-off-b");
    const diffOffStable = await diff(page, offA, offB);

    // ── OFF-GATE 2: explicit 1.0 / 0 == undefined default (true no-op) ──
    await apply(() => {
      const v = window.viewer.scene.globe.defaultCloudCollection.volumetric;
      v.cloudMarchStepGrowth = 1.0;
      v.cloudMaxRayDistance = 0.0;
      window.viewer.scene.requestRender();
    });
    const offExplicit = await shot("stbnlod-off-explicit");
    const diffExplicitOff = await diff(page, offA, offExplicit);

    // ── WIRING: step growth ON ──
    await apply(() => {
      const v = window.viewer.scene.globe.defaultCloudCollection.volumetric;
      v.cloudMarchStepGrowth = 1.08;
      v.cloudMaxRayDistance = undefined;
      window.viewer.scene.requestRender();
    });
    const growthOn = await shot("stbnlod-growth-on");
    const diffGrowth = await diff(page, offA, growthOn);

    // ── WIRING: far cap ON (cut the far horizon shell) ──
    await apply(() => {
      const v = window.viewer.scene.globe.defaultCloudCollection.volumetric;
      v.cloudMarchStepGrowth = undefined;
      v.cloudMaxRayDistance = 40000.0; // 40 km
      window.viewer.scene.requestRender();
    });
    const capOn = await shot("stbnlod-cap-on");
    const diffCap = await diff(page, offA, capOn);

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
          offStable: diffOffStable,
          explicitOff: diffExplicitOff,
          growth: diffGrowth,
          cap: diffCap,
        },
        deviceErrors,
      },
    ];
  },
  verdicts(cells) {
    return evaluateStbnLod(cells);
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
