// probe-globe-cold-start-readiness.mjs — Edge recipe for Q-101 and Q-102.
//
// @purpose Measures whether a settle gated on the new readiness predicate ends with a drawn frame, and what the globe's first non-empty command list costs on each backend.
// @status ACTIVE
// @runtime lib/probe-runtime.mjs
//
// ── WHAT IT ANSWERS ─────────────────────────────────────────────────────────
//
//   Q-101. The first round gated on `scene.renderReady` captures the frame at
//          which readiness first reports true. Its black fraction is compared
//          with a settled reference captured from the same page and camera a
//          configurable number of frames later. It passes when it has no more
//          black than that reference within tolerance and
//          `frameState.commandsDeferred` is zero.
//
//   Q-102. WebGPU published its first non-empty command list on settle frame
//          295 at the slab view and 325 at Cape Point, against WebGL's 24 and
//          23. The claim under test is that pre-cooking the globe's default
//          vertex-layout variants at context init moves most of that cost off
//          the render path.
//
// ── WHY BOTH GATES RUN ON ONE PAGE ──────────────────────────────────────────
//
// The legacy gate and the readiness gate are both evaluated by the harness, so
// the before and the after are two rounds of one page rather than two builds.
// That removes the largest confound in a cold-start measurement — a warm
// driver shader cache on the second run of the day. The FIRST round of a page
// is the only cold one, so each (backend × view × gate) cell gets its own
// browser context, and the order the cells run in is reported.
//
// ── MULTI-METRIC, PER THE MAINTAINER RULE ───────────────────────────────────
//
// A settle-frame count alone cannot say whether a change moved work or removed
// it. Every round therefore records frames, wall-clock ms, pipeline-cache
// hits/misses/created, resolved async resources and their mean duration split
// by kind (render-pipeline, shader-module, texture-upload, image-decode), the
// JS heap, and the black fraction of the bottom third.
//
// The cost metrics are sampled TWICE: once at the end of the round, and once
// AT the frame that published the first non-empty command list. The second
// sample is the one the Q-102 discriminator is defined over — the question is
// what the globe had already spent by the moment it could first draw, and an
// end-of-round sample answers a different question. It is also the sample that
// catches a prewarm built against a key the runtime never requests: the
// pipelines would show as created AND the misses would still be there.
//
// Noise behaviour, per metric:
//
//   frames, wallMs      — dominated by network terrain fetches; expect ±20 %
//                         run to run. Compare medians of >= 3 runs, never one.
//   firstNonEmpty       — the Q-102 statistic. Also network-sensitive, but the
//                         WebGL/WebGPU RATIO within a run is not, which is why
//                         the report prints the ratio.
//   pipelineCache.*     — deterministic for a fixed view. A changed `created`
//                         count between runs of the same cell is a finding.
//   async.*.resolvedCount — deterministic. `meanMs` is not; it carries the
//                         driver's compile time and moves with machine load.
//   usedJSHeapBytes     — Chromium only, quantised, and GC-timing dependent.
//                         Quote it as an order of magnitude, never as a delta.
//   blackFraction       — the Q-101 statistic, and the only one that is a
//                         pass/fail rather than a measurement.
//
// ── WHAT THE SHARED RUNTIME OWNS ────────────────────────────────────────────
//
// Argument parsing, the single-Edge-slot lock, the Edge launch, the
// served-build preflight, element-only capture with its sha256, receipt
// serialization and the exit-code table all live in `lib/probe-runtime.mjs`.
// What is left below is what is genuinely this probe's: the two views, the two
// gates, the settle loop, and the two verdict shapes.
//
// The Edge launch flags are UNCHANGED by the move: the runtime default is the
// single flag this probe already passed, and this probe declares no
// `launchArgs`. That is deliberate. A flag such as `--use-vulkan` moves Dawn
// off the Windows D3D default and would shift the pipeline-compile counters
// below without changing a line of the probe, so the receipts either side of
// the migration would stop being comparable. The runtime now records the flags
// it launched with in `*-runtime.json`, so this is checkable rather than
// asserted.
//
// Four consequences of the move, stated rather than left to be discovered:
//
//   * The probe now serves from a governed port (8094 by default) and asserts
//     that the bytes the server hands out are the bytes on disk. Port 8080 is
//     refused — the default dev server there serves a live esbuild of the
//     SOURCE tree, so a run against it cannot say which engine it measured.
//   * Each `--runs` repeat gets its OWN browser, not just its own context. The
//     default (`--runs 1`) is one browser either way, so a single-run receipt
//     is unchanged; a repeat is now genuinely as cold as the first, which is
//     the direction this probe wants.
//   * A precondition that fails is now a REFUSAL (exit 3), distinct from a
//     measured red (exit 1). It used to be an uncaught throw.
//   * A refused run no longer publishes a receipt at all. Pre-migration the
//     throw happened before the single `writeFileSync`, so the last good
//     `globe-cold-start-report.json` survived; the runtime keeps that property
//     deliberately rather than by accident, and records the refusal beside it
//     in `globe-cold-start-refusal.json`. A run that produced no cells must not
//     overwrite one that did with a document reporting 0/0 verdicts.
//
// ── PRECONDITIONS ───────────────────────────────────────────────────────────
//
//   * `npx gulp build` has run, so `/Build/CesiumUnminified/` is current. The
//     runtime's served-build preflight compares the served bytes with the
//     on-disk bytes, and this probe additionally asserts the served bundle
//     exposes `scene.renderReady`; a build without it refuses rather than
//     silently measuring the old engine.
//   * `node server.js --port 8094 --serve-built` is running. Use `localhost`,
//     not `127.0.0.1` — the dev server binds IPv6.
//   * Edge, not Firefox: Playwright's bundled Firefox has no WebGPU.
//   * An ion token is configured, or terrain requests fail and both backends
//     measure the ellipsoid.
//
// Run:
//   node Tools/visual-regression/probe-globe-cold-start-readiness.mjs
//   node Tools/visual-regression/probe-globe-cold-start-readiness.mjs --runs 3
//   node Tools/visual-regression/probe-globe-cold-start-readiness.mjs --headed
//   node Tools/visual-regression/probe-globe-cold-start-readiness.mjs --settled-frames 60 --black-tolerance-pp 0.5

import {
  ProbeRefusal,
  captureElement,
  isEntryPoint,
  runProbe,
} from "./lib/probe-runtime.mjs";

const HARNESS_PATH = "/Tools/visual-regression/globe-cold-start-harness.html";

export function decideReadinessVerdict({
  blackFraction,
  settledBlackFraction,
  commandsDeferred,
  tolerance,
}) {
  const blackDelta = blackFraction - settledBlackFraction;
  return {
    blackFraction,
    settledBlackFraction,
    blackDelta,
    tolerance,
    commandsDeferred,
    pass: blackDelta <= tolerance + Number.EPSILON && commandsDeferred === 0,
  };
}

// The two 3e-B views, unchanged. The slab view is where the black near field
// was measured; Cape Point is where the 325-vs-23 first-command gap was.
const VIEWS = [
  {
    id: "slab",
    label: "Yosemite slab — low pitch, 6 km, terrain with vertex normals",
    iso: "2026-08-28T18:00:00Z",
    viewport: { width: 1024, height: 640 },
    camera: {
      longitude: -119.55,
      latitude: 37.62,
      height: 6000,
      heading: 0,
      pitch: -12,
    },
    rounds: 8,
  },
  {
    id: "capepoint",
    label: "Cape Point — 2 km, 56.2 degrees of depression",
    iso: "2026-09-24T10:38:00Z",
    viewport: { width: 640, height: 360 },
    camera: {
      longitude: 18.4967,
      latitude: -34.3568,
      height: 2000,
      heading: 0,
      pitch: -56.2,
    },
    rounds: 3,
  },
];

const GATES = ["legacy", "readiness"];

/**
 * Runs every settle round for one (backend, view, gate) cell in its own
 * browser context, so the first round of the cell is genuinely cold.
 *
 * @param {object} options One cell's inputs.
 * @param {object} options.browser The Playwright browser.
 * @param {string} options.harness Absolute harness url for this run's origin.
 * @param {string} options.renderer The backend.
 * @param {object} options.view One entry of VIEWS.
 * @param {string} options.gate "legacy" or "readiness".
 * @param {number} options.run The repeat index.
 * @param {number} options.settledReferenceFrames Extra frames the reference round settles for.
 * @param {string} options.outputDirectory Where captures are written.
 * @param {Array<object>} options.captures Runtime capture sink.
 * @returns {Promise<object>} The cell's result.
 */
async function runCell({
  browser,
  harness,
  renderer,
  view,
  gate,
  run,
  settledReferenceFrames,
  outputDirectory,
  captures,
}) {
  const context = await browser.newContext({
    viewport: view.viewport,
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
  if (!built.hasRenderReady || !built.hasPendingResourceCount) {
    await context.close();
    throw new ProbeRefusal(
      "readiness-signal-absent",
      "the served bundle has no readiness signal — rebuild before running " +
        "this probe, or it will measure the old engine and report the result " +
        "as an after",
      { renderer },
    );
  }
  if (!built.terrainReady) {
    await context.close();
    throw new ProbeRefusal(
      "terrain-not-resolved",
      "terrain did not resolve — both backends would measure the ellipsoid",
      { renderer },
    );
  }

  await page.evaluate((v) => window.__setView(v), view.camera);
  await page.evaluate(() => window.__stripWidgets());

  const rounds = [];
  for (let round = 0; round < view.rounds; round++) {
    const settled = await page.evaluate((a) => window.__settle(a), {
      iso: view.iso,
      gate,
      budgetMs: 60000,
      // Round zero remains the first-ready measurement. Round one is the
      // existing later capture reused as its settled reference.
      minFrames: round === 1 ? settledReferenceFrames : 60,
    });
    const name = `${view.id}-${renderer}-${gate}-run${run}-r${round}`;
    // `index: 0` keeps the pre-runtime `.first()` selection exactly. The
    // runtime records how many canvases actually matched, so a harness that
    // grows a second one shows up in the run receipt instead of silently
    // changing which element every number came from.
    const capture = await captureElement({
      page,
      selector: "canvas",
      index: 0,
      name,
      outputDirectory,
      captures,
    });
    const black = await page.evaluate(
      (b64) => window.__blackBottomThird(b64),
      capture.buffer.toString("base64"),
    );
    rounds.push({ round, ...settled, black });
    const atFirst = settled.metricsAtFirstNonEmpty;
    const compiles = atFirst?.pipelineCache?.created ?? "n/a";
    const uploads = atFirst?.async?.textureUploads?.resolvedCount ?? "n/a";
    process.stdout.write(
      `${name}: frames=${settled.frames} firstNonEmpty=${settled.firstNonEmpty} ` +
        `@first(ms=${settled.wallMsAtFirstNonEmpty} compiles=${compiles} ` +
        `uploads=${uploads}) cmds=${settled.commands} ` +
        `deferred=${settled.commandsDeferred} black=${black.blackFraction}\n`,
    );
  }

  await context.close();
  return { renderer, view: view.id, gate, run, built, rounds, pageErrors };
}

/**
 * Q-101 is a pass/fail: the FIRST readiness-gated round is compared with the
 * second round, captured from the same page and camera after at least
 * `settledReferenceFrames` additional frames. Legacy-gated cells contribute no
 * verdict — they are the before, not the claim.
 *
 * @param {Array<object>} cells Every cell of the run.
 * @param {number} blackTolerance Tolerance as a fraction, not percentage points.
 * @returns {Array<object>} The verdicts.
 */
export function buildColdStartVerdicts(cells, blackTolerance) {
  const verdicts = [];
  for (const cell of cells) {
    if (cell.gate !== "readiness") {
      continue;
    }
    const first = cell.rounds[0];
    const settledReference = cell.rounds[1];
    if (!settledReference) {
      throw new ProbeRefusal(
        "settled-reference-missing",
        `no settled reference was captured for ${cell.view}/${cell.renderer}/run${cell.run}`,
        { view: cell.view, renderer: cell.renderer, run: cell.run },
      );
    }
    verdicts.push({
      id: `${cell.view}/${cell.renderer}/run${cell.run}`,
      claim:
        "Q-101 — the first readiness-gated frame matches the settled scene",
      ...decideReadinessVerdict({
        blackFraction: first.black.blackFraction,
        settledBlackFraction: settledReference.black.blackFraction,
        commandsDeferred: first.commandsDeferred,
        tolerance: blackTolerance,
      }),
    });
  }
  return verdicts;
}

/**
 * Q-102 is a measurement and is reported rather than gated — a threshold on a
 * network-bound number would be a coin flip.
 *
 * @param {Array<object>} cells Every cell of the run.
 * @returns {object} The per-cell first-command state, keyed by cell id.
 */
export function buildFirstNonEmptyByCell(cells) {
  const firstCommand = {};
  for (const cell of cells) {
    const first = cell.rounds[0];
    const at = first.metricsAtFirstNonEmpty;
    firstCommand[`${cell.view}/${cell.renderer}/${cell.gate}/run${cell.run}`] =
      {
        settleFrames: first.firstNonEmpty,
        wallMs: first.wallMsAtFirstNonEmpty,
        // The discriminator: what the globe had already spent by the moment it
        // could first draw. If the cold start is a first-use compile burst,
        // these fall when the compiles move off the render path; if they stay
        // put while settleFrames stays high, the remaining cost is scheduling.
        pipelinesCreated: at?.pipelineCache?.created ?? null,
        pipelineCacheMisses: at?.pipelineCache?.misses ?? null,
        // A pre-cook shows up here rather than as one fewer miss: a warm counts a
        // miss of its own when it starts the build, so the tile that finds the
        // pipeline already there turns into a HIT. Zero hits at the first
        // non-empty command list means the globe compiled its own.
        pipelineCacheHits: at?.pipelineCache?.hits ?? null,
        renderPipelinesResolved:
          at?.async?.renderPipelines?.resolvedCount ?? null,
        renderPipelineMeanMs: at?.async?.renderPipelines?.meanMs ?? null,
        shaderModulesResolved: at?.async?.shaderModules?.resolvedCount ?? null,
        textureUploadsResolved:
          at?.async?.textureUploads?.resolvedCount ?? null,
        usedJSHeapBytes: at?.usedJSHeapBytes ?? null,
      };
  }
  return firstCommand;
}

/**
 * The probe's own receipt. Its field set is the pre-runtime field set, in the
 * pre-runtime order — the runtime writes what it knows to a sibling
 * `*-runtime.json` rather than injecting fields here, so a reader of a banked
 * `globe-cold-start-report.json` sees the same document it always saw.
 *
 * @param {Array<object>} cells Every cell of the run.
 * @param {object} context Receipt inputs.
 * @param {string} context.generatedAt ISO timestamp.
 * @param {string} context.harness Harness url.
 * @param {number} context.runs Repeat count.
 * @param {Array<object>} context.verdicts The Q-101 verdicts.
 * @returns {object} The receipt.
 */
export function buildColdStartReceipt(cells, context) {
  return {
    generatedAt: context.generatedAt,
    harness: context.harness,
    runs: context.runs,
    cellOrder: cells.map(
      (c) => `${c.view}/${c.renderer}/${c.gate}/run${c.run}`,
    ),
    verdicts: context.verdicts,
    firstNonEmptyByCell: buildFirstNonEmptyByCell(cells),
    cells,
  };
}

/**
 * The console report, unchanged in shape from the pre-runtime probe.
 *
 * @param {object} receipt The probe receipt.
 * @returns {void}
 */
function printReport(receipt) {
  console.log("\n── Q-101 ──");
  for (const verdict of receipt.verdicts) {
    console.log(
      `${verdict.pass ? "PASS" : "FAIL"} ${verdict.id} ` +
        `blackFraction=${verdict.blackFraction} ` +
        `settledBlackFraction=${verdict.settledBlackFraction} ` +
        `blackDelta=${verdict.blackDelta} tolerance=${verdict.tolerance} ` +
        `commandsDeferred=${verdict.commandsDeferred}`,
    );
  }
  console.log("\n── Q-102 (state AT the first non-empty command list) ──");
  for (const [id, value] of Object.entries(receipt.firstNonEmptyByCell)) {
    console.log(
      `${id}: frames=${value.settleFrames} ms=${value.wallMs} ` +
        `pipelinesCreated=${value.pipelinesCreated} ` +
        `misses=${value.pipelineCacheMisses} ` +
        `hits=${value.pipelineCacheHits} ` +
        `renderPipelines=${value.renderPipelinesResolved}` +
        `@${value.renderPipelineMeanMs}ms ` +
        `modules=${value.shaderModulesResolved} ` +
        `uploads=${value.textureUploadsResolved}`,
    );
  }
}

/** The descriptor the shared runtime executes. */
export const descriptor = {
  name: "globe-cold-start",
  title: "Globe cold start — readiness (Q-101) and first command list (Q-102)",
  outputSubdirectory: "globe-cold-start",
  receiptEnvelope: "probe-owned",
  args: {
    extraOptions: [
      {
        flag: "--settled-frames",
        key: "settledFrames",
        kind: "positive-integer",
        default: 60,
      },
      {
        // A fraction, so 0.5 percentage points is 0.005 in every comparison.
        flag: "--black-tolerance-pp",
        key: "blackTolerancePp",
        kind: "non-negative-number",
        default: 0.5,
      },
    ],
  },
  async cells({ browser, run, options, origin, outputDirectory, captures }) {
    const harness = `${origin}${HARNESS_PATH}`;
    const produced = [];
    for (const view of VIEWS) {
      for (const renderer of options.renderers) {
        for (const gate of GATES) {
          produced.push(
            await runCell({
              browser,
              harness,
              renderer,
              view,
              gate,
              run,
              settledReferenceFrames: options.settledFrames,
              outputDirectory,
              captures,
            }),
          );
        }
      }
    }
    return produced;
  },
  verdicts(cells, { options }) {
    return buildColdStartVerdicts(cells, options.blackTolerancePp / 100);
  },
  receipt(cells, context) {
    const receipt = buildColdStartReceipt(cells, {
      generatedAt: context.generatedAt,
      harness: `${context.origin}${HARNESS_PATH}`,
      runs: context.options?.runs ?? null,
      verdicts: context.verdicts,
    });
    if (cells.length > 0) {
      printReport(receipt);
    }
    return receipt;
  },
  summary(receipt) {
    const passed = receipt.verdicts.filter((v) => v.pass === true).length;
    return [
      "# Globe cold start",
      "",
      `Generated: ${receipt.generatedAt}`,
      "",
      `Harness: \`${receipt.harness}\``,
      "",
      `Q-101: ${passed}/${receipt.verdicts.length} readiness verdicts passed.`,
      "",
      `Cells: ${receipt.cellOrder.length}`,
      "",
    ].join("\n");
  },
};

if (isEntryPoint(import.meta.url)) {
  process.exitCode = await runProbe(descriptor);
}
