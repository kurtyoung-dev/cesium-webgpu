// probe-globe-cold-start-readiness.mjs — Edge recipe for Q-101 and Q-102.
//
// @purpose Measures whether a settle gated on the new readiness predicate ends with a drawn frame, and what the globe's first non-empty command list costs on each backend.
// @status ACTIVE
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
// ── PRECONDITIONS ───────────────────────────────────────────────────────────
//
//   * `npx gulp build` has run, so `/Build/CesiumUnminified/` is current. The
//     probe asserts the served bundle exposes `scene.renderReady`; a build
//     without it aborts rather than silently measuring the old engine.
//   * `node server.js` is serving on 8080. Use `localhost`, not `127.0.0.1` —
//     the dev server binds IPv6.
//   * Edge, not Firefox: Playwright's bundled Firefox has no WebGPU.
//   * An ion token is configured, or terrain requests fail and both backends
//     measure the ellipsoid.
//
// Run:
//   node Tools/visual-regression/probe-globe-cold-start-readiness.mjs
//   node Tools/visual-regression/probe-globe-cold-start-readiness.mjs --runs 3
//   node Tools/visual-regression/probe-globe-cold-start-readiness.mjs --headed
//   node Tools/visual-regression/probe-globe-cold-start-readiness.mjs --settled-frames 60 --black-tolerance-pp 0.5

import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const outputDirectory = path.join(here, "output", "globe-cold-start");
const harness =
  "http://localhost:8080/Tools/visual-regression/globe-cold-start-harness.html";

const argv = process.argv.slice(2);

function readNonNegativeNumberOption(name, fallback) {
  const index = argv.indexOf(name);
  if (index === -1) {
    return fallback;
  }

  const value = Number(argv[index + 1]);
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative number`);
  }
  return value;
}

const headed = argv.includes("--headed");
const runs = readNonNegativeNumberOption("--runs", 1);
if (!Number.isInteger(runs) || runs < 1) {
  throw new TypeError("--runs must be a positive integer");
}

const settledReferenceFrames = readNonNegativeNumberOption(
  "--settled-frames",
  60,
);
if (!Number.isInteger(settledReferenceFrames) || settledReferenceFrames < 1) {
  throw new TypeError("--settled-frames must be a positive integer");
}

// blackFraction is a fraction, so 0.5 percentage points is represented as
// 0.005 in verdicts and comparisons.
const blackTolerance =
  readNonNegativeNumberOption("--black-tolerance-pp", 0.5) / 100;

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

const BACKENDS = ["webgl", "webgpu"];
const GATES = ["legacy", "readiness"];

/**
 * Runs every settle round for one (backend, view, gate) cell in its own
 * browser context, so the first round of the cell is genuinely cold.
 *
 * @param {object} browser The Playwright browser.
 * @param {string} renderer The backend.
 * @param {object} view One entry of VIEWS.
 * @param {string} gate "legacy" or "readiness".
 * @param {number} run The repeat index.
 * @returns {Promise<object>} The cell's result.
 */
async function runCell(browser, renderer, view, gate, run) {
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
    throw new Error(`build failed for ${renderer}: ${built.error}`);
  }
  if (!built.hasRenderReady || !built.hasPendingResourceCount) {
    await context.close();
    throw new Error(
      "the served bundle has no readiness signal — rebuild before running " +
        "this probe, or it will measure the old engine and report the result " +
        "as an after",
    );
  }
  if (!built.terrainReady) {
    await context.close();
    throw new Error(
      "terrain did not resolve — both backends would measure the ellipsoid",
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
    const buffer = await page
      .locator("canvas")
      .first()
      .screenshot({
        type: "png",
        path: path.join(outputDirectory, `${name}.png`),
      });
    const black = await page.evaluate(
      (b64) => window.__blackBottomThird(b64),
      buffer.toString("base64"),
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

mkdirSync(outputDirectory, { recursive: true });
const browser = await chromium.launch({
  channel: "msedge",
  headless: !headed,
  args: ["--enable-unsafe-webgpu"],
});

const cells = [];
for (let run = 0; run < runs; run++) {
  for (const view of VIEWS) {
    for (const renderer of BACKENDS) {
      for (const gate of GATES) {
        cells.push(await runCell(browser, renderer, view, gate, run));
      }
    }
  }
}
await browser.close();

// ── verdicts ────────────────────────────────────────────────────────────────
//
// Q-101 is a pass/fail: the FIRST readiness-gated round is compared with the
// second round, captured from the same page and camera after at least
// settledReferenceFrames additional frames. Q-102 is a measurement and is
// reported rather than gated — a threshold on a network-bound number would be
// a coin flip.
const verdicts = [];
for (const cell of cells) {
  const first = cell.rounds[0];
  if (cell.gate === "readiness") {
    const settledReference = cell.rounds[1];
    if (!settledReference) {
      throw new Error(
        `no settled reference was captured for ${cell.view}/${cell.renderer}/run${cell.run}`,
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
}

const firstCommand = {};
for (const cell of cells) {
  const first = cell.rounds[0];
  const at = first.metricsAtFirstNonEmpty;
  firstCommand[`${cell.view}/${cell.renderer}/${cell.gate}/run${cell.run}`] = {
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
    renderPipelinesResolved: at?.async?.renderPipelines?.resolvedCount ?? null,
    renderPipelineMeanMs: at?.async?.renderPipelines?.meanMs ?? null,
    shaderModulesResolved: at?.async?.shaderModules?.resolvedCount ?? null,
    textureUploadsResolved: at?.async?.textureUploads?.resolvedCount ?? null,
    usedJSHeapBytes: at?.usedJSHeapBytes ?? null,
  };
}

const report = {
  generatedAt: new Date().toISOString(),
  harness,
  runs,
  cellOrder: cells.map((c) => `${c.view}/${c.renderer}/${c.gate}/run${c.run}`),
  verdicts,
  firstNonEmptyByCell: firstCommand,
  cells,
};
const reportPath = path.join(outputDirectory, "globe-cold-start-report.json");
writeFileSync(reportPath, JSON.stringify(report, null, 2));

console.log("\n── Q-101 ──");
for (const verdict of verdicts) {
  console.log(
    `${verdict.pass ? "PASS" : "FAIL"} ${verdict.id} ` +
      `blackFraction=${verdict.blackFraction} ` +
      `settledBlackFraction=${verdict.settledBlackFraction} ` +
      `blackDelta=${verdict.blackDelta} tolerance=${verdict.tolerance} ` +
      `commandsDeferred=${verdict.commandsDeferred}`,
  );
}
console.log("\n── Q-102 (state AT the first non-empty command list) ──");
for (const [id, value] of Object.entries(firstCommand)) {
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
console.log(`\nreport: ${reportPath}`);

const failed = verdicts.filter((v) => !v.pass);
process.exitCode = failed.length === 0 ? 0 : 1;
