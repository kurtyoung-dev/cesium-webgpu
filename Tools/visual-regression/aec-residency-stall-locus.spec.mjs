// aec-residency-stall-locus.spec.mjs — behaviour spec for the E-1 stall-locus
// reader. Pure Node: no browser, no GPU, no build, no network.
//
// @purpose Drives the stall-locus classifier over synthetic legs that carry each reachable outcome, over the real banked E-1 receipts when they are present, and through source mutations that make its two load-bearing readings inert, so a classifier that stops reading the poll cadence or the frame gaps fails here.
// @status ACTIVE
//
// ── WHAT IS BEING ASSERTED ──────────────────────────────────────────────────
//
// The classifier's claim is a behavioural one about a measurement, not a claim
// about its own source text: given a leg whose frames stopped for tens of
// seconds while its wall-clock poll kept ticking on cadence, it must say the
// wait was NOT on the main thread; given a leg whose poll starved alongside its
// frames, it must say the opposite. Every test here constructs a leg with the
// property under test and reads the verdict; none of them greps the module.
//
// ── HOW IT AVOIDS CERTIFYING ITS OWN BRIEF ──────────────────────────────────
//
// Three ways.
//
//   1. NEGATIVE CONTROLS FIRST. The main-thread-blocked leg (B2) and the
//      diffuse leg (B1) are built to make the classifier say things the lane
//      that wrote it did NOT want to hear. If the classifier only ever emits
//      `off-main-thread`, those two fail.
//
//   2. THE REAL RECEIPTS ARE OPTIONAL BUT NOT DECORATIVE. Group C runs the
//      banked 2026-09-02 receipts when the evidence directory is present and
//      requires the properties the lane's finding rests on — a dominant gap
//      owning most of the window, a poll that held cadence inside it, and a
//      pipeline cause that comes back UNLICENSED. When the bank is absent the
//      tests skip loudly rather than passing quietly, and C0 records which of
//      the two happened so a run cannot look green by finding nothing.
//
//   3. INERTNESS MUTANTS, NOT DELETIONS. Group D rewrites the module so each
//      reading is still computed and still reported but can no longer affect
//      the verdict — the cadence comparison always passes, and the gap
//      decomposition returns no gaps. A spec that survives those is asserting
//      the module's shape, not its behaviour.
//
// Run: node --test Tools/visual-regression/aec-residency-stall-locus.spec.mjs

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  STALL_LOCUS_THRESHOLDS,
  analyzeReceipt,
  buildStallLocusReport,
  classifyStallLocus,
  decomposeFrameGaps,
  pipelineProgressInWindow,
  pollCadenceInWindow,
} from "./lib/aec-residency-stall-locus.mjs";
import { mutateOrFail } from "./lib/engine-stub-bundler.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const MODULE_PATH = resolve(directory, "lib/aec-residency-stall-locus.mjs");
const EVIDENCE_DIR = resolve(directory, "output/aec-residency-e1-2026-09-02");

/**
 * Builds a leg whose frames and wall-clock polls are laid out on one timeline.
 *
 * The leg is described by a list of frame intervals; polls are then laid down
 * across the whole timeline at `pollIntervalMs`, except inside the windows
 * named by `starvePolls`, where the poll is suppressed and the next one carries
 * the whole suppressed span as its own interval — which is exactly how a
 * blocked event loop records itself.
 *
 * @param {object} options Leg shape.
 * @param {ReadonlyArray<number>} options.frameDeltasMs Inter-frame intervals.
 * @param {number} [options.pollIntervalMs] Nominal poll cadence.
 * @param {ReadonlyArray<number>} [options.starveFrameIndices] Frame intervals
 *   during which the poll is suppressed.
 * @param {(elapsedMs: number) => object} [options.cacheAt] Pipeline counters as
 *   a function of elapsed time. Defaults to a cache that never moves.
 * @returns {object} A leg shaped like one `legs[]` entry of an E-1 receipt.
 */
function makeLeg(options) {
  const {
    frameDeltasMs,
    pollIntervalMs = 250,
    starveFrameIndices = [],
    cacheAt = () => ({ hits: 0, misses: 107, created: 3, pending: 4 }),
  } = options;

  const starved = new Set(starveFrameIndices);
  const frameSamples = [];
  const starvedWindows = [];
  let clock = 0;

  // The first sample carries a pre-recording interval, matching the probe.
  frameSamples.push({
    index: 0,
    atMs: clock,
    sinceLastFrameMs: 600,
    commandListLength: 0,
    pipelineCache: cacheAt(clock),
  });

  frameDeltasMs.forEach((delta, position) => {
    const start = clock;
    clock += delta;
    if (starved.has(position)) {
      starvedWindows.push({ startMs: start, endMs: clock });
    }
    frameSamples.push({
      index: position + 1,
      atMs: clock,
      sinceLastFrameMs: delta,
      commandListLength: 6,
      pipelineCache: cacheAt(clock),
    });
  });

  const totalMs = clock;
  const cacheSamples = [];
  let pollClock = 0;
  let lastPollAt = 0;
  while (pollClock <= totalMs) {
    const at = pollClock;
    const inStarvedWindow = starvedWindows.some(
      (window) => at > window.startMs && at < window.endMs,
    );
    if (!inStarvedWindow) {
      cacheSamples.push({
        atMs: pollClock,
        sinceLastSampleMs: pollClock - lastPollAt || pollIntervalMs,
        pipelineCache: cacheAt(pollClock),
      });
      lastPollAt = pollClock;
    }
    pollClock += pollIntervalMs;
  }

  return { backend: "webgpu", frameSamples, cacheSamples };
}

// ── A. THE DECOMPOSITION READS THE FRAMES IT IS GIVEN ───────────────────────

test("A1 a window of even frames reports no gaps and its median delta", () => {
  const leg = makeLeg({ frameDeltasMs: Array.from({ length: 40 }, () => 80) });
  const decomposition = decomposeFrameGaps(leg);
  assert.equal(decomposition.gaps.length, 0);
  assert.equal(decomposition.gapMs, 0);
  assert.equal(decomposition.windowMs, 40 * 80);
  assert.equal(decomposition.medianFrameDeltaMs, 80);
});

test("A2 the pre-recording first interval is excluded from the window", () => {
  const leg = makeLeg({ frameDeltasMs: [100, 100] });
  // The synthetic first sample carries 600 ms; a decomposition that counted it
  // would report 800 ms.
  assert.equal(decomposeFrameGaps(leg).windowMs, 200);
});

test("A3 gaps come back longest first, with the window bounds they span", () => {
  const leg = makeLeg({ frameDeltasMs: [80, 4000, 80, 30000, 80] });
  const { gaps, gapFraction } = decomposeFrameGaps(leg);
  assert.deepEqual(
    gaps.map((gap) => gap.durationMs),
    [30000, 4000],
  );
  assert.equal(gaps[0].endMs - gaps[0].startMs, 30000);
  assert.ok(gapFraction > 0.99, `gap share was ${gapFraction}`);
});

// ── B. THE CLASSIFIER CAN COME OUT AGAINST THE LANE ─────────────────────────

test("B1 a window with no dominant gap is NOT attributed to a discrete wait", () => {
  const leg = makeLeg({ frameDeltasMs: Array.from({ length: 60 }, () => 400) });
  const verdict = classifyStallLocus(leg);
  assert.equal(verdict.locus, "no-dominant-gap");
  assert.equal(verdict.pipelineCauseLicensed, null);
  assert.equal(verdict.dominantGap, null);
});

test("B2 a gap whose poll starved with it reads as a blocked main thread", () => {
  const leg = makeLeg({
    frameDeltasMs: [200, 200, 30000, 200, 200],
    starveFrameIndices: [2],
  });
  const verdict = classifyStallLocus(leg);
  // A loop blocked for the WHOLE gap observes nothing inside it, so there is
  // no inflated median to read. Coverage against the cadence the leg keeps
  // outside the gap is what catches it, and reading zero observations as
  // "cannot tell" would hide exactly the case the axis exists to catch.
  assert.equal(verdict.cadence.polls, 0);
  assert.ok(verdict.cadence.expectedPolls > 100);
  assert.equal(verdict.locus, "main-thread-blocked");
  // A blocked main thread is an admissible cause, so the pipeline reading
  // keeps its licence here. The whole point of the axis is that this is a
  // DIFFERENT answer from B3.
  assert.equal(verdict.pipelineCauseLicensed, true);
});

test("B2b a gap the poll entered late, but entered, is still starvation", () => {
  // Half the gap's polls arrive; the loop was serviced, just not on time.
  const leg = makeLeg({ frameDeltasMs: [200, 200, 30000, 200, 200] });
  const gapStart = 400;
  const gapEnd = 30400;
  leg.cacheSamples = leg.cacheSamples.filter(
    (sample) =>
      sample.atMs <= gapStart ||
      sample.atMs >= gapEnd ||
      sample.atMs % 1000 === 0,
  );
  const verdict = classifyStallLocus(leg);
  assert.ok(verdict.cadence.polls > 0, "the gap must not be empty of polls");
  assert.ok(verdict.cadence.pollCoverage < 0.5);
  assert.equal(verdict.locus, "main-thread-blocked");
});

test("B3 a gap the poll rode out on cadence reads as off the main thread", () => {
  const leg = makeLeg({ frameDeltasMs: [200, 200, 30000, 200, 200] });
  const verdict = classifyStallLocus(leg);
  assert.equal(verdict.locus, "off-main-thread");
  assert.ok(
    verdict.cadence.polls >= STALL_LOCUS_THRESHOLDS.minimumPollsInGap,
    `only ${verdict.cadence.polls} polls landed inside the gap`,
  );
  assert.ok(
    verdict.cadence.cadenceRatio <=
      STALL_LOCUS_THRESHOLDS.cadenceToleranceFactor,
    `cadence ratio was ${verdict.cadence.cadenceRatio}`,
  );
});

test("B4 a free event loop plus a frozen pipeline cache withdraws the cause", () => {
  const leg = makeLeg({ frameDeltasMs: [200, 200, 30000, 200, 200] });
  const verdict = classifyStallLocus(leg);
  assert.equal(verdict.pipelineCauseLicensed, false);
  assert.match(verdict.reason, /co-victim/);
});

test("B5 the same gap WITH creations landing inside it keeps the cause", () => {
  // Everything about this leg matches B4 except that `created` climbs while
  // the frames are stopped, which is what a genuinely creation-bound wait
  // looks like. The verdict must move.
  const leg = makeLeg({
    frameDeltasMs: [200, 200, 30000, 200, 200],
    cacheAt: (elapsedMs) => ({
      hits: 0,
      misses: 107,
      created: 3 + Math.floor(elapsedMs / 3000),
      pending: 4,
    }),
  });
  const verdict = classifyStallLocus(leg);
  assert.equal(verdict.locus, "off-main-thread");
  assert.equal(verdict.pipelineCauseLicensed, true);
  assert.ok(verdict.pipeline.createdDelta > 0);
});

test("B6 a poll too coarse to resolve the gap leaves the locus undetermined", () => {
  // The distinction B2 turns on: a poll that COULD have sampled the gap and
  // did not is starvation, while a poll whose own cadence is longer than the
  // gap can accommodate never had the chance, and that is undetermined.
  const leg = makeLeg({
    frameDeltasMs: [200, 200, 30000, 200, 200],
    pollIntervalMs: 20000,
  });
  const verdict = classifyStallLocus(leg);
  assert.ok(
    verdict.cadence.expectedPolls < STALL_LOCUS_THRESHOLDS.minimumPollsInGap,
  );
  assert.equal(verdict.locus, "undetermined-no-poll-axis");
  assert.equal(verdict.pipelineCauseLicensed, null);
});

// ── C. THE REAL BANKED RECEIPTS ─────────────────────────────────────────────

const BANKED_LEGS = ["leg-a", "leg-b"]
  .map((name) => join(EVIDENCE_DIR, name, "dm09-e1-receipt.json"))
  .filter((path) => existsSync(path));

test("C0 whether the banked evidence was available is recorded, not hidden", () => {
  // A run that finds nothing must say so in its output rather than reporting
  // the C-group as passed.
  const message =
    BANKED_LEGS.length === 0
      ? `banked E-1 evidence ABSENT at ${EVIDENCE_DIR}; C1-C3 skipped`
      : `banked E-1 evidence present: ${BANKED_LEGS.length} receipt(s)`;
  assert.ok(message.length > 0);
  process.stdout.write(`# ${message}\n`);
});

test("C1 each banked WebGPU leg is dominated by a handful of multi-second gaps", (t) => {
  if (BANKED_LEGS.length === 0) {
    t.skip("banked E-1 evidence not present in this checkout");
    return;
  }
  for (const path of BANKED_LEGS) {
    const receipt = JSON.parse(readFileSync(path, "utf8"));
    const leg = receipt.legs.find((entry) => entry.backend === "webgpu");
    const decomposition = decomposeFrameGaps(leg);
    assert.ok(
      decomposition.gaps.length <= 8,
      `${path}: ${decomposition.gaps.length} reported gaps is not "a handful"`,
    );
    assert.ok(
      decomposition.gapFraction > 0.5,
      `${path}: gaps own only ${(decomposition.gapFraction * 100).toFixed(1)}% of the window`,
    );
  }
});

test("C2 the banked WebGPU legs classify off the main thread, cause unlicensed", (t) => {
  if (BANKED_LEGS.length === 0) {
    t.skip("banked E-1 evidence not present in this checkout");
    return;
  }
  for (const path of BANKED_LEGS) {
    const receipt = JSON.parse(readFileSync(path, "utf8"));
    const rows = analyzeReceipt(receipt);
    const webgpu = rows.find((row) => row.backend === "webgpu");
    assert.equal(webgpu.e1Verdict, "pipeline-creation-bound");
    assert.equal(webgpu.locus, "off-main-thread", `${path}: ${webgpu.reason}`);
    assert.equal(
      webgpu.pipelineCauseLicensed,
      false,
      `${path}: ${webgpu.reason}`,
    );
  }
});

test("C3 the banked WebGL legs are not dominated by a discrete wait", (t) => {
  if (BANKED_LEGS.length === 0) {
    t.skip("banked E-1 evidence not present in this checkout");
    return;
  }
  for (const path of BANKED_LEGS) {
    const receipt = JSON.parse(readFileSync(path, "utf8"));
    const rows = analyzeReceipt(receipt);
    const webgl = rows.find((row) => row.backend === "webgl");
    // WebGL settles in a third of the time with its lost time spread across
    // its frames. If this ever reads `off-main-thread` the two backends are
    // not being told apart and the WebGPU reading means nothing.
    assert.equal(webgl.locus, "no-dominant-gap", webgl.reason);
  }
});

// ── D. INERTNESS MUTANTS ────────────────────────────────────────────────────

/**
 * Imports a rewritten copy of the module from a temporary directory, so the
 * mutation cannot touch the checkout.
 *
 * @param {(source: string) => string} rewrite Source rewrite.
 * @param {string} label Name used in the did-it-change assertion.
 * @returns {Promise<object>} The mutated module namespace.
 */
async function importMutated(rewrite, label) {
  const source = readFileSync(MODULE_PATH, "utf8").split("\r\n").join("\n");
  const mutated = mutateOrFail(source, rewrite, label);
  const scratch = mkdtempSync(join(tmpdir(), "turin-stall-locus-"));
  const path = join(scratch, "aec-residency-stall-locus.mjs");
  writeFileSync(path, mutated, "utf8");
  return import(pathToFileURL(path).href);
}

test("D1 a poll-axis test that can never fire loses B2", async () => {
  // The readings are still computed and still reported; they just cannot reach
  // the verdict any more. The blocked-main-thread leg must stop being
  // recognised.
  const mutated = await importMutated(
    (source) =>
      source.replace(
        "  if (coverageShort || cadenceInflated) {\n",
        "  if (false && (coverageShort || cadenceInflated)) {\n",
      ),
    "poll-axis-inert",
  );
  const leg = makeLeg({
    frameDeltasMs: [200, 200, 30000, 200, 200],
    starveFrameIndices: [2],
  });
  assert.equal(classifyStallLocus(leg).locus, "main-thread-blocked");
  assert.notEqual(
    mutated.classifyStallLocus(leg).locus,
    "main-thread-blocked",
    "the cadence axis no longer decides anything, yet the verdict is unchanged",
  );
});

test("D2 a decomposition that reports no gaps loses B3 and C2", async () => {
  const mutated = await importMutated(
    (source) =>
      source.replace(
        "    if (durationMs < reportGapMs) {\n",
        "    if (true || durationMs < reportGapMs) {\n",
      ),
    "gap-decomposition-inert",
  );
  const leg = makeLeg({ frameDeltasMs: [200, 200, 30000, 200, 200] });
  assert.equal(classifyStallLocus(leg).locus, "off-main-thread");
  assert.equal(
    mutated.classifyStallLocus(leg).locus,
    "no-dominant-gap",
    "the gaps are gone, yet a dominant gap is still being found",
  );
});

test("D3 a pipeline-progress reading that always moves loses B4", async () => {
  const mutated = await importMutated(
    (source) =>
      source.replace(
        '    typeof pipeline.createdDelta === "number" && pipeline.createdDelta > 0;\n',
        "    true;\n",
      ),
    "pipeline-progress-inert",
  );
  const leg = makeLeg({ frameDeltasMs: [200, 200, 30000, 200, 200] });
  assert.equal(classifyStallLocus(leg).pipelineCauseLicensed, false);
  assert.equal(
    mutated.classifyStallLocus(leg).pipelineCauseLicensed,
    true,
    "the licence no longer reads the creation delta, yet it is still withheld",
  );
});

// ── E. THE REPORT CARRIES THE VERDICT ───────────────────────────────────────

test("E1 the report names the locus and the licence for every leg", () => {
  const rows = [
    {
      backend: "webgpu",
      e1Verdict: "pipeline-creation-bound",
      ...classifyStallLocus(
        makeLeg({ frameDeltasMs: [200, 200, 30000, 200, 200] }),
      ),
    },
  ];
  const report = buildStallLocusReport(rows);
  assert.match(report, /off-main-thread/);
  assert.match(report, /\| NO \|/);
});

test("E2 an empty window reads as an empty window, not as a verdict", () => {
  const empty = { backend: "webgpu", frameSamples: [], cacheSamples: [] };
  const verdict = classifyStallLocus(empty);
  assert.equal(verdict.locus, "no-dominant-gap");
  assert.equal(verdict.decomposition.windowMs, 0);
  assert.equal(pollCadenceInWindow(empty, { startMs: 0, endMs: 10 }).polls, 0);
  assert.equal(
    pipelineProgressInWindow(empty, { startMs: 0, endMs: 10 }).createdDelta,
    null,
  );
});
