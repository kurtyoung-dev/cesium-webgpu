// probe-ar002-per-tile-credits.mjs — AR-M14, the acceptance for AR-002.
//
// @purpose Counts per-tile terrain/imagery credits actually present in the credit-bar DOM on WebGL vs WebGPU at one settled Bing/ion view, so the AR-002 hoist's cross-backend parity is a measurement, not an inference.
// @status ACTIVE
// @runtime lib/probe-runtime.mjs
//
// ── WHAT IT ANSWERS ─────────────────────────────────────────────────────────
//
//   AR-M14. Bing/ion imagery (plus ion terrain), both backends, one saved
//           view -> count of per-tile credits in the credit bar. Before the
//           AR-002 hoist WebGPU counted 0 while WebGL counted the real
//           per-tile set; the row's acceptance is that the two counts match
//           and are non-zero.
//
// ── WHY THIS PROBE EXISTS RATHER THAN REUSING AN EXISTING CREDIT READER ─────
//
// AR-M14 is filed in the architecture-review queue as "NOT RUN" because every
// existing credit-adjacent probe reaches its capture through
// `lib/strip-viewer-widgets.mjs`'s `STRIP_WIDGETS_SOURCE`, which REMOVES
// `.cesium-widget-credits` and `.cesium-credit-lightbox-overlay` from the DOM
// before the measurement. That removal is correct for those probes — a
// Playwright element screenshot of the canvas composites whatever is
// absolutely positioned over its rect, and the credit line is one of those
// things — but it means those probes structurally cannot see a credit: the
// nodes are gone by the time they look.
//
// This probe never calls that helper. Its harness
// (`ar002-per-tile-credits-harness.html`) hides only the toolbar / animation /
// timeline / bottom-bar chrome (as `globe-cold-start-harness.html` already
// does for reasons unrelated to credits) and leaves the credit widget alone,
// so `window.__countPerTileCredits()` reads the live `CreditDisplay` DOM:
// on-screen children of `.cesium-credit-textContainer`, plus `<li>` entries
// under the `.cesium-credit-lightbox` `<ul>` — both populated every frame by
// `CreditDisplay.endFrame()` regardless of whether the lightbox is currently
// open. See the harness file for the exact container mapping.
//
// ── WHAT THE SHARED RUNTIME OWNS ────────────────────────────────────────────
//
// Argument parsing, the single-Edge-slot lock, the Edge launch, the
// served-build preflight, receipt serialization and the exit-code table all
// live in `lib/probe-runtime.mjs`, exactly as in `probe-globe-cold-start-
// readiness.mjs` (the template this probe's shape is copied from). This probe
// takes no element screenshot — the count is read directly via
// `page.evaluate`, so it does not use `captureElement`.
//
// ── PRECONDITIONS ───────────────────────────────────────────────────────────
//
//   * `npx gulp build` has run, so `/Build/CesiumUnminified/` is current.
//   * `node server.js --port 8094 --serve-built` is running (or pass
//     `--port`/`--no-served-build` per the runtime's own contract). Use
//     `localhost`, not `127.0.0.1`.
//   * Edge, not Firefox: Playwright's bundled Firefox has no WebGPU.
//   * An ion token is configured (the fork's built-in default token is
//     sufficient), or imagery/terrain requests fail and BOTH backends read
//     zero credits — which would read as a false PASS-by-symmetry. The
//     receipt records `imageryOk`/`terrainOk` per cell so that distinction is
//     checkable rather than assumed.
//
// Run:
//   node Tools/visual-regression/probe-ar002-per-tile-credits.mjs
//   node Tools/visual-regression/probe-ar002-per-tile-credits.mjs --headed

import { ProbeRefusal, isEntryPoint, runProbe } from "./lib/probe-runtime.mjs";

const HARNESS_PATH =
  "/Tools/visual-regression/ar002-per-tile-credits-harness.html";

// One saved view carrying real per-tile attribution in view: a mid-latitude
// city at a terrain-visible altitude, so both the Bing/ion imagery tiles and
// the ion terrain tiles in frame have resolved, non-degenerate credits.
const VIEW = {
  id: "pittsburgh",
  label: "Pittsburgh — 8 km, imagery + terrain both in view",
  iso: "2026-09-04T18:00:00Z",
  viewport: { width: 1024, height: 640 },
  camera: {
    longitude: -79.9959,
    latitude: 40.4406,
    height: 8000,
    heading: 0,
    pitch: -35,
  },
};

/**
 * Runs one (backend) cell in its own browser context: build, set the saved
 * view, settle, then read the credit-bar DOM directly.
 *
 * @param {object} options
 * @param {import("playwright").Browser} options.browser
 * @param {string} options.harness Absolute harness URL.
 * @param {string} options.renderer "webgl" or "webgpu".
 * @param {number} options.run The repeat index.
 * @returns {Promise<object>} The cell's result.
 */
async function runCell({ browser, harness, renderer, run }) {
  const context = await browser.newContext({
    viewport: VIEW.viewport,
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e.message)));

  await page.goto(harness, { waitUntil: "load", timeout: 60000 });
  await page.waitForFunction(() => window.Cesium !== undefined, null, {
    timeout: 60000,
  });

  const built = await page.evaluate((a) => window.__build(a), {
    renderer,
    terrain: true,
  });
  if (!built.ok) {
    await context.close();
    throw new ProbeRefusal(
      "harness-build-failed",
      `build failed for ${renderer}: ${built.error}`,
      { renderer, error: built.error },
    );
  }

  await page.evaluate((v) => window.__setView(v), VIEW.camera);
  await page.evaluate(() => window.__stripWidgets());

  const settled = await page.evaluate((a) => window.__settle(a), {
    iso: VIEW.iso,
    budgetMs: 60000,
    minFrames: 60,
  });

  const credits = await page.evaluate(() => window.__countPerTileCredits());
  const errors = await page.evaluate(() => window.__errors.slice());

  await context.close();
  return {
    renderer,
    run,
    view: VIEW.id,
    built,
    settled,
    credits,
    pageErrors: [...pageErrors, ...errors],
  };
}

/**
 * AR-002's acceptance, computed per run: the WebGL and WebGPU total counts
 * must match and must be non-zero. A zero-zero match is reported separately
 * as `symmetricButEmpty` rather than folded into `pass`, since it is
 * indistinguishable from "both backends failed to load imagery" without that
 * flag.
 *
 * @param {Array<object>} cells Every cell of the run.
 * @returns {Array<object>} One verdict per run index.
 */
export function buildAr002Verdicts(cells) {
  const byRun = new Map();
  for (const cell of cells) {
    if (!byRun.has(cell.run)) {
      byRun.set(cell.run, {});
    }
    byRun.get(cell.run)[cell.renderer] = cell;
  }
  const verdicts = [];
  for (const [run, byRenderer] of byRun) {
    const webgl = byRenderer.webgl;
    const webgpu = byRenderer.webgpu;
    if (!webgl || !webgpu) {
      continue;
    }
    const webglTotal = webgl.credits.total;
    const webgpuTotal = webgpu.credits.total;
    const symmetricButEmpty = webglTotal === 0 && webgpuTotal === 0;
    verdicts.push({
      id: `${VIEW.id}/run${run}`,
      claim: "AR-M14 — per-tile credit count is equal on both backends",
      webglTotal,
      webgpuTotal,
      webglBreakdown: webgl.credits,
      webgpuBreakdown: webgpu.credits,
      symmetricButEmpty,
      pass: webglTotal === webgpuTotal && !symmetricButEmpty,
    });
  }
  return verdicts;
}

function printReport(receipt) {
  console.log("\n── AR-M14 ──");
  for (const verdict of receipt.verdicts) {
    console.log(
      `${verdict.pass ? "PASS" : "FAIL"} ${verdict.id} ` +
        `webgl=${verdict.webglTotal} (onScreen=${verdict.webglBreakdown.onScreen} lightbox=${verdict.webglBreakdown.lightbox}) ` +
        `webgpu=${verdict.webgpuTotal} (onScreen=${verdict.webgpuBreakdown.onScreen} lightbox=${verdict.webgpuBreakdown.lightbox}) ` +
        `symmetricButEmpty=${verdict.symmetricButEmpty}`,
    );
  }
}

/** The descriptor the shared runtime executes. */
export const descriptor = {
  name: "ar002-per-tile-credits",
  title: "AR-002 / AR-M14 — per-tile credit parity",
  outputSubdirectory: "ar002-per-tile-credits",
  receiptEnvelope: "probe-owned",
  async cells({ browser, run, options, origin }) {
    const harness = `${origin}${HARNESS_PATH}`;
    const produced = [];
    for (const renderer of options.renderers) {
      produced.push(await runCell({ browser, harness, renderer, run }));
    }
    return produced;
  },
  verdicts(cells) {
    return buildAr002Verdicts(cells);
  },
  receipt(cells, context) {
    const receipt = {
      generatedAt: context.generatedAt,
      harness: `${context.origin}${HARNESS_PATH}`,
      view: VIEW,
      verdicts: context.verdicts,
      cells,
    };
    if (cells.length > 0) {
      printReport(receipt);
    }
    return receipt;
  },
  summary(receipt) {
    const passed = receipt.verdicts.filter((v) => v.pass === true).length;
    return [
      "# AR-002 per-tile credit parity",
      "",
      `Generated: ${receipt.generatedAt}`,
      "",
      `Harness: \`${receipt.harness}\``,
      "",
      `AR-M14: ${passed}/${receipt.verdicts.length} runs passed.`,
      "",
    ].join("\n");
  },
};

if (isEntryPoint(import.meta.url)) {
  process.exitCode = await runProbe(descriptor);
}
