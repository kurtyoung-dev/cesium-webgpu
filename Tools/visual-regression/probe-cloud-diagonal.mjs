#!/usr/bin/env node
/**
 * Cloud-coverage DIAGONAL probe. WebGPU-only.
 * @purpose Regression for the fullscreen-triangle fix: an overcast deck must fill the top-right quadrant (old triangle rasterized only half the screen)
 * @status ACTIVE
 * @runtime lib/probe-runtime.mjs
 *
 * The procedural-cloud fullscreen pass used a NON-oversized triangle (verts at
 * three NDC corners), so it rasterized only the lower-left half of the screen
 * and clouds appeared behind a hard corner-to-corner diagonal (long misfiled as
 * a "frustum-edge artifact"). Batch 406 swaps in the oversized fullscreen
 * triangle so the whole screen is shaded.
 *
 * This probe boots the Weather Inspector demo (gallery standalone-boot recipe),
 * applies the OVC St preset (8/8 overcast — a deck that SHOULD fill the sky),
 * settles, compositor-screenshots the canvas (page element screenshot, NOT
 * toDataURL), and measures the grey-cloud-deck fraction in the four screen
 * quadrants. The diagonal bug's signature is a stark TL→BR asymmetry: clouds in
 * the BOTTOM-LEFT quadrant, ~0 in the TOP-RIGHT. The fix makes the overcast deck
 * present in the TOP-RIGHT quadrant too.
 *
 * Usage: node Tools/visual-regression/probe-cloud-diagonal.mjs --port 8094
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
/** Settle after boot, before the preset is applied. */
const SETTLE_AFTER_BOOT_MS = 9000;
/** Settle after the OVC St preset, so the 8/8 deck is fully built. */
const SETTLE_AFTER_PRESET_MS = 7000;
/** One element capture plus the in-page quadrant decode. */
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

const CLICK = async ({ id }) => {
  const el = document.getElementById(id);
  if (el) {
    el.click();
  }
  return { ok: !!el };
};

// Grey-cloud-deck fraction in each screen quadrant. "Deck" = mid/low luminance,
// low saturation (the overcast grey) — distinct from saturated-blue sky. The
// control panel occupies the left ~270px of the top, so the left quadrants are
// measured to the RIGHT of the panel to avoid counting UI chrome.
function quadrantDeck(page, dataUrl) {
  return page.evaluate(async (du) => {
    const img = new Image();
    img.src = du;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const cx = c.getContext("2d");
    cx.drawImage(img, 0, 0);
    const Wd = c.width,
      Hd = c.height;
    const panelRight = Math.floor(Wd * 0.28); // skip the control panel
    function frac(x0, x1, y0, y1) {
      x0 = Math.max(x0, panelRight);
      if (x1 <= x0) {
        return { deck: 0, lum: 0, n: 0 };
      }
      const d = cx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
      let deck = 0,
        lum = 0,
        n = 0;
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i],
          g = d[i + 1],
          b = d[i + 2];
        const L = 0.299 * r + 0.587 * g + 0.114 * b;
        const mx = Math.max(r, g, b),
          mn = Math.min(r, g, b);
        lum += L;
        // overcast grey deck: not strongly blue-saturated, mid luminance band
        const blueDom = b > r + 25 && b > 120; // clearly blue sky
        if (!blueDom && L > 80 && L < 215 && mx - mn < 55) {
          deck++;
        }
        n++;
      }
      return {
        deck: +((100 * deck) / n).toFixed(1),
        lum: +(lum / n).toFixed(0),
        n,
      };
    }
    const midX = Math.floor(Wd * 0.5),
      midY = Math.floor(Hd * 0.5),
      botCap = Math.floor(Hd * 0.86); // exclude the timeline strip at the very bottom
    return {
      topLeft: frac(0, midX, 0, midY),
      topRight: frac(midX, Wd, 0, midY),
      botLeft: frac(0, midX, midY, botCap),
      botRight: frac(midX, Wd, midY, botCap),
    };
  }, dataUrl);
}

/**
 * The quadrant clauses, over one run's cells.
 *
 * Pure and exported so the routing spec can put a quadrant table on either
 * side of every bar without a browser. The diagonal bug's signature is a
 * left-right asymmetry, so three of the five clauses are stated over a
 * difference rather than over an absolute the demo's own lighting could move.
 *
 * @param {Array<object>} cells The run's cells.
 * @returns {Array<object>} Verdicts in the runtime's shape.
 */
export function evaluateDiagonal(cells) {
  const verdicts = [];
  for (const cell of cells) {
    const q = cell.quadrants;
    const lrBottom = Math.abs(q.botLeft.deck - q.botRight.deck);
    const lrTop = Math.abs(q.topLeft.deck - q.topRight.deck);
    const suffix = `run${cell.run}`;
    verdicts.push(
      {
        id: `bottom-right-deck/${suffix}`,
        claim: `bottom-RIGHT now has the deck (was ~0 with the diagonal) (${q.botRight.deck}% > 50)`,
        pass: q.botRight.deck > 50,
        detail: { deck: q.botRight.deck },
      },
      {
        id: `bottom-left-deck/${suffix}`,
        claim: `bottom-LEFT has the deck (${q.botLeft.deck}% > 50)`,
        pass: q.botLeft.deck > 50,
        detail: { deck: q.botLeft.deck },
      },
      {
        id: `bottom-symmetry/${suffix}`,
        claim: `deck is left-right symmetric in the bottom (|${q.botLeft.deck}-${q.botRight.deck}| = ${lrBottom.toFixed(1)} < 15) -> no TL->BR diagonal`,
        pass: lrBottom < 15,
        detail: { delta: +lrBottom.toFixed(1), tolerance: 15 },
      },
      {
        id: `top-symmetry/${suffix}`,
        claim: `top is left-right symmetric (|${q.topLeft.deck}-${q.topRight.deck}| = ${lrTop.toFixed(1)} < 15) -> no diagonal`,
        pass: lrTop < 15,
        detail: { delta: +lrTop.toFixed(1), tolerance: 15 },
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
    console.log("quadrant deck%:", JSON.stringify(cell.quadrants, null, 0));
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
  name: "cloud-diagonal",
  title:
    "Cloud coverage diagonal — the overcast deck must fill the top-right quadrant",
  // The empty subdirectory keeps the capture exactly where the pre-routing
  // probe wrote it: `output/cloud-diagonal-ovc.png`, not a new folder beneath it.
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
  // deadline is derived from it rather than from a global cap: boot, the two
  // settles the measurement is defined over, and the capture plus decode.
  workBudgetMs: () =>
    BOOT_BUDGET_MS +
    SETTLE_AFTER_BOOT_MS +
    SETTLE_AFTER_PRESET_MS +
    READBACK_BUDGET_MS,
  async cells({ browser, run, options, origin, outputDirectory, captures }) {
    if (!options.renderers.includes("webgpu")) {
      throw new ProbeRefusal(
        "renderer-unavailable",
        "the procedural cloud deck is WebGPU-only, so a diagonal measured on " +
          `${options.renderers.join(",")} would read an empty sky`,
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
    // OVC St = full 8/8 overcast: a deck that should fill the entire sky.
    await page.evaluate(CLICK, { id: "wi-preset-OVCst" });
    await page.waitForTimeout(SETTLE_AFTER_PRESET_MS);

    const capture = await captureElement({
      page,
      selector: ".cesium-widget canvas",
      name: "cloud-diagonal-ovc",
      outputDirectory,
      captures,
    });
    const quadrants = await quadrantDeck(
      page,
      `data:image/png;base64,${capture.buffer.toString("base64")}`,
    );

    const gate = await collectGateErrors(page);
    const deviceErrors = (gate.errors || [])
      .concat(consoleErrors)
      .filter(
        (e) =>
          !/Atmosphere ?LUT|SkyAtmosphere|default layout|favicon|bucket\.css|Sandcastle-header|load-cesium-es6/i.test(
            e,
          ),
      );

    return [{ run, capture: capture.name, quadrants, deviceErrors }];
  },
  verdicts(cells) {
    return evaluateDiagonal(cells);
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
