#!/usr/bin/env node
/**
 * Batch 408 V11 — per-genus optical EXTINCTION activation probe. WebGPU-only.
 * @purpose B408 V11 per-genus optical extinction gate: cumulus byte-identical default, cumulonimbus more opaque than cirrus, deck neither vanished nor blown out
 * @status ACTIVE
 * @runtime lib/probe-runtime.mjs
 *
 * Slot 103 `profileExtinction` (normalized so the DEFAULT genus CUMULUS == 1.0)
 * now scales `cloud.absorptionCoeff` at the light-march beer/powder, the
 * multi-scatter octaves, AND the view-ray sample transmittance — so a denser
 * genus (cumulonimbus, ~1.58x) absorbs more light → darker, MORE OPAQUE cloud
 * bodies; a thin genus (cirrus, ~0.17x) absorbs less → wispier, MORE TRANSLUCENT.
 *
 * Claims:
 *   (1) CUMULUS (default genus, profileExtinction normalized to 1.0) is
 *       byte-identical to the explicit-CUMULUS render — the default look is
 *       UNCHANGED by the activation (whole-frame diff ~0);
 *   (2) CUMULONIMBUS renders a MORE OPAQUE / DARKER-cored cloud body than CIRRUS
 *       (higher cloud-opacity coverage), confirming extinction scales density;
 *   (3) the default cloud deck is still present (not vanished) and not blown to
 *       white — the zero/unset fallback guard means no all-transparent clouds;
 *   (4) 0 new device/validation errors.
 *
 * Usage: node Tools/visual-regression/probe-cloud-extinction.mjs --port 8094
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
  CUMULONIMBUS = 10;

/**
 * Page boot: Playwright's 30 s `goto` default plus this probe's own 60 s wait
 * for `window.viewer`.
 */
const BOOT_BUDGET_MS = 90_000;
/** Settle after cloudCoverage/cloudDensity are raised, before the default capture. */
const SETTLE_AFTER_CONFIG_MS = 9000;
/** Settle after each cloudType switch, paid three times: cumulus, cirrus, cumulonimbus. */
const SETTLE_AFTER_TYPE_MS = 4500;
/**
 * Four element captures (default, cumulus, cirrus, cumulonimbus) plus their
 * in-page metrics decodes, plus the cumulus-vs-default two-image diff decode.
 */
const READBACK_BUDGET_MS = 30_000;

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

// Region metrics over the deck area (lower-centre, right of the panel).
// Returns:
//   cloudFrac  — fraction of pixels that read as opaque grey cloud (coverage/opacity)
//   meanL      — mean luminance over that region (darker cores → lower)
//   cloudMeanL — mean luminance of just the cloud pixels (dense extinction → darker)
function metrics(page, dataUrl) {
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
      n = 0,
      sumL = 0,
      cloudSumL = 0;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i],
        g = d[i + 1],
        b = d[i + 2];
      const L = 0.299 * r + 0.587 * g + 0.114 * b;
      const mx = Math.max(r, g, b),
        mn = Math.min(r, g, b);
      const blueSky = b > r + 25 && b > 120;
      sumL += L;
      // Opaque grey cloud: not blue sky, bright-ish, low chroma.
      if (!blueSky && L > 70 && mx - mn < 55) {
        cloud++;
        cloudSumL += L;
      }
      n++;
    }
    return {
      cloudFrac: +((100 * cloud) / n).toFixed(2),
      meanL: +(sumL / n).toFixed(2),
      cloudMeanL: +(cloud > 0 ? cloudSumL / cloud : 0).toFixed(2),
    };
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
 * The extinction clauses, over one run's cells.
 *
 * Pure and exported so the routing spec can exercise the verdict logic
 * without a browser. One verdict per clause in the pre-migration `checks`
 * array, in the same order, with the same claim text and the same boolean
 * test — including clause 3, which reads the CUMULUS capture's `cloudMeanL`
 * rather than the default capture's, exactly as the pre-migration probe did.
 *
 * @param {Array<object>} cells The run's cells.
 * @returns {Array<object>} Verdicts in the runtime's shape.
 */
export function evaluateExtinction(cells) {
  const verdicts = [];
  for (const cell of cells) {
    const suffix = `run${cell.run}`;
    verdicts.push(
      {
        id: `cumulus-equals-default/${suffix}`,
        claim: `CUMULUS == default (activation leaves default look UNCHANGED, diff ${cell.diffCuDef} < 0.4)`,
        pass: cell.diffCuDef < 0.4,
        detail: { diff: cell.diffCuDef, tolerance: 0.4 },
      },
      {
        id: `default-deck-present/${suffix}`,
        claim: `default deck PRESENT (not vanished — cloudFrac ${cell.default.cloudFrac} > 3)`,
        pass: cell.default.cloudFrac > 3,
        detail: { cloudFrac: cell.default.cloudFrac },
      },
      {
        id: `default-deck-not-blown-out/${suffix}`,
        claim: `default deck not blown-out white (cloudMeanL ${cell.cumulus.cloudMeanL} < 252)`,
        pass: cell.cumulus.cloudMeanL < 252,
        detail: { cloudMeanL: cell.cumulus.cloudMeanL },
      },
      {
        id: `cumulonimbus-more-opaque-than-cirrus/${suffix}`,
        claim: `CUMULONIMBUS more OPAQUE than CIRRUS (cloudFrac cb ${cell.cumulonimbus.cloudFrac} > cirrus ${cell.cirrus.cloudFrac})`,
        pass: cell.cumulonimbus.cloudFrac > cell.cirrus.cloudFrac,
        detail: {
          cumulonimbus: cell.cumulonimbus.cloudFrac,
          cirrus: cell.cirrus.cloudFrac,
        },
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
      `default : cloudFrac=${cell.default.cloudFrac} meanL=${cell.default.meanL} cloudMeanL=${cell.default.cloudMeanL}`,
    );
    console.log(
      `cumulus : cloudFrac=${cell.cumulus.cloudFrac} meanL=${cell.cumulus.meanL} cloudMeanL=${cell.cumulus.cloudMeanL}`,
    );
    console.log(
      `cirrus  : cloudFrac=${cell.cirrus.cloudFrac} meanL=${cell.cirrus.meanL} cloudMeanL=${cell.cirrus.cloudMeanL}`,
    );
    console.log(
      `cb      : cloudFrac=${cell.cumulonimbus.cloudFrac} meanL=${cell.cumulonimbus.meanL} cloudMeanL=${cell.cumulonimbus.cloudMeanL}`,
    );
    console.log(
      `diff cumulus-vs-default=${cell.diffCuDef} | errs=${cell.deviceErrors.length}`,
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
  name: "cloud-extinction",
  title:
    "Per-genus optical extinction — cumulus byte-identical default, cumulonimbus more opaque than cirrus",
  // The empty subdirectory keeps the captures exactly where the pre-routing
  // probe wrote them: `output/extinction-*.png`, not a new folder beneath it.
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
  // config settle, the per-genus settle paid three times (cumulus, cirrus,
  // cumulonimbus), and the four captures' readback plus the diff decode.
  workBudgetMs: () =>
    BOOT_BUDGET_MS +
    SETTLE_AFTER_CONFIG_MS +
    SETTLE_AFTER_TYPE_MS * 3 +
    READBACK_BUDGET_MS,
  async cells({ browser, run, options, origin, outputDirectory, captures }) {
    if (!options.renderers.includes("webgpu")) {
      throw new ProbeRefusal(
        "renderer-unavailable",
        "per-genus optical extinction is a WebGPU-only cloud-shader activation, so a measurement on " +
          `${options.renderers.join(",")} would read an unaffected sky`,
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

    // Fuller deck so the per-genus optical extinction reads clearly: a high coverage
    // + density so the cloud body has interior depth for the extinction to darken.
    await page.evaluate(() => {
      const g = window.viewer.scene.globe;
      g.defaultCloudCollection.volumetric.cloudCoverage = 0.8;
      g.defaultCloudCollection.volumetric.cloudDensity = 0.4;
      window.viewer.scene.requestRender();
    });
    await page.waitForTimeout(SETTLE_AFTER_CONFIG_MS);
    const defaultCapture = await captureElement({
      page,
      selector: ".cesium-widget canvas",
      name: "extinction-default",
      outputDirectory,
      captures,
    });
    const duDef = `data:image/png;base64,${defaultCapture.buffer.toString("base64")}`;
    const mDef = await metrics(page, duDef);

    const cap = async (t, name) => {
      await page.evaluate(SETTYPE, t);
      await page.waitForTimeout(SETTLE_AFTER_TYPE_MS);
      const capture = await captureElement({
        page,
        selector: ".cesium-widget canvas",
        name,
        outputDirectory,
        captures,
      });
      const du = `data:image/png;base64,${capture.buffer.toString("base64")}`;
      return { du, m: await metrics(page, du) };
    };

    const cu = await cap(CUMULUS, "extinction-cumulus");
    const ci = await cap(CIRRUS, "extinction-cirrus");
    const cb = await cap(CUMULONIMBUS, "extinction-cumulonimbus");

    const diffCuDef = await diff(page, duDef, cu.du);

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
        default: mDef,
        cumulus: cu.m,
        cirrus: ci.m,
        cumulonimbus: cb.m,
        diffCuDef,
        deviceErrors,
      },
    ];
  },
  verdicts(cells) {
    return evaluateExtinction(cells);
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
