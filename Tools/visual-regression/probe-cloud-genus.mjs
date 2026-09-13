#!/usr/bin/env node
/**
 * Batch 408 V11 per-genus cloud types — wiring + byte-identity probe. WebGPU-only.
 * @purpose B408 V11 per-genus vertical-profile wiring: cirrus thinner, cumulonimbus denser, stratus distinct; cumulus/unset byte-identical to the pre-V11 default
 * @status ACTIVE
 * @runtime lib/probe-runtime.mjs
 *
 * globe.defaultCloudCollection.cloudType (a CloudType index) selects a per-genus vertical density
 * profile: SLAB (flat stratus), BILLOWY (rounded cumulus = the historical
 * default), TOWERING_ANVIL (cumulonimbus), plus a per-genus density scale
 * normalized so CUMULUS == 1.0 (byte-identical default). This probe boots the
 * Weather Inspector, drives globe.defaultCloudCollection.cloudType, and screenshots each genus.
 *
 * Claims:
 *   (1) CUMULUS (and undefined) is byte-identical to the pre-V11 default;
 *   (2) CIRRUS (thin, densityScale ~0.21) renders a markedly THINNER deck;
 *   (3) CUMULONIMBUS (towering, densityScale ~1.43) renders a DENSER deck;
 *   (4) STRATUS (flat slab) differs from CUMULUS;
 *   (5) each non-cumulus genus changes the render (whole-frame diff); 0 errors.
 *
 * Usage: node Tools/visual-regression/probe-cloud-genus.mjs --port 8094
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

// CloudType indices
const CUMULUS = 0,
  CIRRUS = 1,
  STRATUS = 7,
  CUMULONIMBUS = 10;

/**
 * Page boot: Playwright's 30 s `goto` default plus this probe's own 60 s wait
 * for `window.viewer`.
 */
const BOOT_BUDGET_MS = 90_000;
/** Settle after the fuller-deck coverage/density is set, before the default capture. */
const SETTLE_AFTER_COVERAGE_MS = 9000;
/**
 * Settle after each `cloudType` change, before its capture. Paid 4 times:
 * cumulus, cirrus, cumulonimbus, stratus.
 */
const SETTLE_AFTER_GENUS_MS = 4500;
/**
 * Five element captures, five in-page deck decodes and four whole-frame
 * diffs — more read-back work than a single-capture probe, so a larger
 * budget than the diagonal probe's 30s.
 */
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

const SETTYPE = async (t) => {
  window.viewer.scene.globe.defaultCloudCollection.cloudType =
    t === null ? undefined : t;
  window.viewer.scene.requestRender();
  return { ok: true };
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
 * The genus clauses, over one run's cells.
 *
 * Pure and exported so the routing spec can exercise the five claims without
 * a browser. Same claims, same order, same boolean tests as the pre-runtime
 * `checks` array.
 *
 * @param {Array<object>} cells The run's cells.
 * @returns {Array<object>} Verdicts in the runtime's shape.
 */
export function evaluateGenus(cells) {
  const verdicts = [];
  for (const cell of cells) {
    const suffix = `run${cell.run}`;
    verdicts.push(
      {
        id: `cumulus-byte-identical/${suffix}`,
        claim: `CUMULUS == default (byte-identical, diff ${cell.diffCumulusVsDefault} < 0.4)`,
        pass: cell.diffCumulusVsDefault < 0.4,
        detail: { diff: cell.diffCumulusVsDefault, tolerance: 0.4 },
      },
      {
        id: `cirrus-thinner-deck/${suffix}`,
        claim: `CIRRUS renders a thinner deck (${cell.deckCirrus} < ${cell.deckCumulus} - 3) — 0.21x density scale`,
        pass: cell.deckCirrus < cell.deckCumulus - 3,
        detail: { cirrus: cell.deckCirrus, cumulus: cell.deckCumulus },
      },
      {
        id: `cirrus-cumulonimbus-change-render/${suffix}`,
        claim: `CIRRUS + CUMULONIMBUS substantially change the render (cirrus ${cell.diffCirrus} & cb ${cell.diffCumulonimbus} > 1.5)`,
        pass: cell.diffCirrus > 1.5 && cell.diffCumulonimbus > 1.5,
        detail: {
          diffCirrus: cell.diffCirrus,
          diffCumulonimbus: cell.diffCumulonimbus,
        },
      },
      {
        id: `stratus-changes-render/${suffix}`,
        claim: `STRATUS (flat slab) changes the render (diff ${cell.diffStratus} > 0.5)`,
        pass: cell.diffStratus > 0.5,
        detail: { diff: cell.diffStratus },
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
      `deck%%: default=${cell.deckDefault} cumulus=${cell.deckCumulus} cirrus=${cell.deckCirrus} cb=${cell.deckCumulonimbus} stratus=${cell.deckStratus}`,
    );
    console.log(
      `diff: cumulus-vs-default=${cell.diffCumulusVsDefault} cirrus=${cell.diffCirrus} cb=${cell.diffCumulonimbus} stratus=${cell.diffStratus} | errs=${cell.deviceErrors.length}`,
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
  name: "cloud-genus",
  title:
    "Cloud genus vertical profile — cirrus thinner, cumulonimbus denser, stratus distinct, cumulus byte-identical",
  // The empty subdirectory keeps the captures exactly where the pre-routing
  // probe wrote them: `output/genus-*.png`, not a new folder beneath it.
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
  // coverage settle, the four per-genus settles, and the capture/decode/diff
  // read-back.
  workBudgetMs: () =>
    BOOT_BUDGET_MS +
    SETTLE_AFTER_COVERAGE_MS +
    SETTLE_AFTER_GENUS_MS * 4 +
    READBACK_BUDGET_MS,
  async cells({ browser, run, options, origin, outputDirectory, captures }) {
    if (!options.renderers.includes("webgpu")) {
      throw new ProbeRefusal(
        "renderer-unavailable",
        "the per-genus cloud vertical profile is WebGPU-only, so a genus " +
          `comparison measured on ${options.renderers.join(",")} would read an empty sky`,
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

    // Fuller deck so the per-genus density scale (cirrus ~0.21x thin, cb ~1.43x
    // dense) reads clearly from the upward view; the genus is then the only
    // variable across captures (coverage held fixed, so CUMULUS still == default).
    await page.evaluate(() => {
      const g = window.viewer.scene.globe;
      g.defaultCloudCollection.volumetric.cloudCoverage = 0.8;
      g.defaultCloudCollection.volumetric.cloudDensity = 0.4;
      window.viewer.scene.requestRender();
    });
    await page.waitForTimeout(SETTLE_AFTER_COVERAGE_MS);
    const defaultCapture = await captureElement({
      page,
      selector: ".cesium-widget canvas",
      name: "genus-default",
      outputDirectory,
      captures,
    });
    const duDef = `data:image/png;base64,${defaultCapture.buffer.toString("base64")}`;
    const deckDef = await deck(page, duDef);

    const cap = async (t, name) => {
      await page.evaluate(SETTYPE, t);
      await page.waitForTimeout(SETTLE_AFTER_GENUS_MS);
      const capture = await captureElement({
        page,
        selector: ".cesium-widget canvas",
        name,
        outputDirectory,
        captures,
      });
      const du = `data:image/png;base64,${capture.buffer.toString("base64")}`;
      return { du, deck: await deck(page, du) };
    };

    const cu = await cap(CUMULUS, "genus-cumulus");
    const ci = await cap(CIRRUS, "genus-cirrus");
    const cb = await cap(CUMULONIMBUS, "genus-cumulonimbus");
    const st = await cap(STRATUS, "genus-stratus");

    const diffCuDef = await diff(page, duDef, cu.du);
    const diffCi = await diff(page, cu.du, ci.du);
    const diffCb = await diff(page, cu.du, cb.du);
    const diffSt = await diff(page, cu.du, st.du);

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
        deckDefault: deckDef,
        deckCumulus: cu.deck,
        deckCirrus: ci.deck,
        deckCumulonimbus: cb.deck,
        deckStratus: st.deck,
        diffCumulusVsDefault: diffCuDef,
        diffCirrus: diffCi,
        diffCumulonimbus: diffCb,
        diffStratus: diffSt,
        deviceErrors,
      },
    ];
  },
  verdicts(cells) {
    return evaluateGenus(cells);
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
