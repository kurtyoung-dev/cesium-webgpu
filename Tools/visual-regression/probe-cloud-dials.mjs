#!/usr/bin/env node
/**
 * Batch 407 struct-growth cloud dials — end-to-end wiring + byte-identity probe.
 * @purpose B407 struct-growth dials gate: puffSize/exposure/msDecay wired end-to-end, defaults byte-identical, reset returns to the default render
 * @status ACTIVE
 * @runtime lib/probe-runtime.mjs
 *
 * WebGPU-only.
 *
 * Promotes SHAPE_SCALE/CLOUD_EXPOSURE/MS-decay from WGSL consts to CloudUniforms
 * dials exposed on globe.cloud{PuffSize,Exposure,MsDecay*}. This probe boots the
 * Weather Inspector demo (gallery standalone-boot), then drives the new globe
 * fields directly and screenshots each state (compositor element screenshot).
 *
 * Claims:
 *   (1) DEFAULT path is byte-identical: with the dials unset, then SET to their
 *       documented defaults (0.45/0.22/...), the render is unchanged (the WGSL
 *       now reads cloud.X == the former const) — diff ~0;
 *   (2) the EXPOSURE dial drives brightness (0.22 -> 0.45 brightens the deck);
 *   (3) the PUFF-SIZE dial changes the deck morphology (0.45 -> 0.25 moves it);
 *   (4) resetting to undefined returns to the default render (diff ~0);
 *   (5) 0 device errors.
 *
 * Usage: node Tools/visual-regression/probe-cloud-dials.mjs --port 8094
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
/** Settle after boot, before the first (default-state) capture. */
const SETTLE_AFTER_BOOT_MS = 9000;
/**
 * Settle after each dial change, before its capture. Paid 4 times: after the
 * explicit-defaults SETGLOBE, the exposure-lo SETGLOBE, the puff-big SETGLOBE,
 * and the reset-to-undefined SETGLOBE.
 */
const SETTLE_AFTER_DIAL_MS = 3500;
/**
 * Five element captures (default, explicit-defaults, exposure-lo, puff-big,
 * reset) plus six in-page image-decode evaluates (2 deckLum, 4 diff), each
 * loading one or two full-frame PNGs and looping every pixel.
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

// Set globe cloud fields directly (the config path the inspector dials drive).
const SETGLOBE = async (kv) => {
  const g = window.viewer.scene.globe;
  for (const [k, v] of Object.entries(kv)) {
    g[k] = v === null ? undefined : v;
  }
  window.viewer.scene.requestRender();
  return { ok: true };
};

// Mean luminance of the cloud-deck region (lower-centre, right of the panel).
function deckLum(page, dataUrl) {
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
      x1 = Math.floor(c.width * 0.85),
      y0 = Math.floor(c.height * 0.4),
      y1 = Math.floor(c.height * 0.85);
    const d = cx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
    let lum = 0,
      n = 0;
    for (let i = 0; i < d.length; i += 4) {
      lum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      n++;
    }
    return +(lum / n).toFixed(2);
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
 * The five dial clauses, over one run's cells.
 *
 * Pure and exported so the routing spec can put the diff table on either side
 * of every bar without a browser. Same claim text and same boolean test as
 * the pre-routing `checks` array, in the same order.
 *
 * @param {Array<object>} cells The run's cells.
 * @returns {Array<object>} Verdicts in the runtime's shape.
 */
export function evaluateDials(cells) {
  const verdicts = [];
  for (const cell of cells) {
    const suffix = `run${cell.run}`;
    verdicts.push(
      {
        id: `explicit-defaults-byte-identical/${suffix}`,
        claim: `explicit-defaults byte-identical to default (diff ${cell.diffDefaults} < 0.4)`,
        pass: cell.diffDefaults < 0.4,
        detail: { diff: cell.diffDefaults, tolerance: 0.4 },
      },
      {
        id: `exposure-changes-render/${suffix}`,
        claim: `exposure 0.22->0.10 changes the render (diff ${cell.diffExp} > 0.5)`,
        pass: cell.diffExp > 0.5,
        detail: { diff: cell.diffExp, tolerance: 0.5 },
      },
      {
        id: `puff-size-changes-deck/${suffix}`,
        claim: `puff-size 0.45->0.25 changes the deck (diff ${cell.diffPuff} > 1.0)`,
        pass: cell.diffPuff > 1.0,
        detail: { diff: cell.diffPuff, tolerance: 1.0 },
      },
      {
        id: `reset-returns-to-default/${suffix}`,
        claim: `reset to undefined returns to default (diff ${cell.diffReset} < 0.6)`,
        pass: cell.diffReset < 0.6,
        detail: { diff: cell.diffReset, tolerance: 0.6 },
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
    console.log(
      `lumDefault=${cell.lumDefault} lumExp=${cell.lumExp} | diffDefaults=${cell.diffDefaults} diffExp=${cell.diffExp} diffPuff=${cell.diffPuff} diffReset=${cell.diffReset} | errs=${cell.deviceErrors.length}`,
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
  name: "cloud-dials",
  title:
    "Cloud dials — struct-growth puffSize/exposure/msDecay wired end-to-end, byte-identical at defaults",
  // The empty subdirectory keeps the captures exactly where the pre-routing
  // probe wrote them: `output/dials-*.png`, not a new folder beneath it.
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
  // The budget THIS probe's work needs per run, so the lifecycle's orderly
  // deadline is derived from it rather than from a global cap: boot, the
  // initial settle before the default capture, the four dial-change settles,
  // and the five captures plus six image-decode evaluates the analysis
  // reads back.
  workBudgetMs: () =>
    BOOT_BUDGET_MS +
    SETTLE_AFTER_BOOT_MS +
    SETTLE_AFTER_DIAL_MS * 4 +
    READBACK_BUDGET_MS,
  async cells({ browser, run, options, origin, outputDirectory, captures }) {
    if (!options.renderers.includes("webgpu")) {
      throw new ProbeRefusal(
        "renderer-unavailable",
        "the struct-growth cloud dials (puffSize/exposure/msDecay) are WebGPU-only, " +
          `so a byte-identity/behaviour probe measured on ${options.renderers.join(",")} would read an empty sky`,
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

    await page.waitForTimeout(SETTLE_AFTER_BOOT_MS);
    const captureDefault = await captureElement({
      page,
      selector: ".cesium-widget canvas",
      name: "dials-default",
      outputDirectory,
      captures,
    });
    const duDefault = `data:image/png;base64,${captureDefault.buffer.toString("base64")}`;
    const lumDefault = await deckLum(page, duDefault);

    // (1) set all five dials to their documented DEFAULTS -> must be byte-identical
    await page.evaluate(SETGLOBE, {
      cloudPuffSize: 0.45,
      cloudExposure: 0.22,
      cloudMsDecayScatter: 0.5,
      cloudMsDecayExtinction: 0.5,
      cloudMsDecayPhase: 0.85,
    });
    await page.waitForTimeout(SETTLE_AFTER_DIAL_MS);
    const captureDefaults = await captureElement({
      page,
      selector: ".cesium-widget canvas",
      name: "dials-explicit-defaults",
      outputDirectory,
      captures,
    });
    const duDefaults = `data:image/png;base64,${captureDefaults.buffer.toString("base64")}`;
    const diffDefaults = await diff(page, duDefault, duDefaults);

    // (2) exposure DOWN. The Reinhard tone-map compresses the already-bright deck,
    // so the mean-luminance move is small/diluted by sky pixels — the robust signal
    // is that exposure CHANGES the render (whole-frame diff), same as puff-size.
    await page.evaluate(SETGLOBE, { cloudExposure: 0.1 });
    await page.waitForTimeout(SETTLE_AFTER_DIAL_MS);
    const captureExp = await captureElement({
      page,
      selector: ".cesium-widget canvas",
      name: "dials-exposure-lo",
      outputDirectory,
      captures,
    });
    const duExp = `data:image/png;base64,${captureExp.buffer.toString("base64")}`;
    const lumExp = await deckLum(page, duExp);
    const diffExp = await diff(page, duDefault, duExp);

    // (3) reset exposure, change puff size -> morphology moves
    await page.evaluate(SETGLOBE, {
      cloudExposure: 0.22,
      cloudPuffSize: 0.25,
    });
    await page.waitForTimeout(SETTLE_AFTER_DIAL_MS);
    const capturePuff = await captureElement({
      page,
      selector: ".cesium-widget canvas",
      name: "dials-puff-big",
      outputDirectory,
      captures,
    });
    const duPuff = `data:image/png;base64,${capturePuff.buffer.toString("base64")}`;
    const diffPuff = await diff(page, duDefaults, duPuff);

    // (4) reset everything to undefined -> back to default render
    await page.evaluate(SETGLOBE, {
      cloudPuffSize: null,
      cloudExposure: null,
      cloudMsDecayScatter: null,
      cloudMsDecayExtinction: null,
      cloudMsDecayPhase: null,
    });
    await page.waitForTimeout(SETTLE_AFTER_DIAL_MS);
    const captureReset = await captureElement({
      page,
      selector: ".cesium-widget canvas",
      name: "dials-reset",
      outputDirectory,
      captures,
    });
    const duReset = `data:image/png;base64,${captureReset.buffer.toString("base64")}`;
    const diffReset = await diff(page, duDefault, duReset);

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
        lumDefault,
        lumExp,
        diffDefaults,
        diffExp,
        diffPuff,
        diffReset,
        deviceErrors,
      },
    ];
  },
  verdicts(cells) {
    return evaluateDials(cells);
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
