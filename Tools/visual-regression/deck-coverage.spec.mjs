// deck-coverage.spec.mjs - the covered-pixel metric and the pre-registered populations rule.
//
// @purpose Node spec for lib/metrics/deck-coverage.mjs: a pixel is covered by Rec. 601 luma above 8 (alpha unread, boundaries pinned), the mean luma is taken over covered pixels only (null for none), and the populations verdict is UNMEASURED under 1 % single-layer coverage or on a size mismatch, FAIL under 25 % of the covered pixels or under 25 % of the mean covered luma (each branch alone), else PASS, all limits strict; with inertness mutants that make the luma test, the UNMEASURED branch, each FAIL branch and the outcome fold unreachable.
// @status ACTIVE
//
// Frames are synthetic RGBA: nothing here reads a PNG or a page.

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { importMutated } from "./lib/import-mutated.mjs";
import * as realModule from "./lib/metrics/deck-coverage.mjs";

const METRIC_MODULE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "lib",
  "metrics",
  "deck-coverage.mjs",
);

const WIDTH = 10;
const HEIGHT = 10;

/** A WIDTH x HEIGHT frame whose first `count` pixels are `rgb`, the rest black. */
function frameWith(count, rgb, alpha = 255) {
  const data = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let i = 0; i < WIDTH * HEIGHT; i++) {
    data.set(i < count ? [...rgb, alpha] : [0, 0, 0, 255], i * 4);
  }
  return { width: WIDTH, height: HEIGHT, data };
}

const BRIGHT = [200, 200, 200];
const DIM = [20, 20, 20];

/** Every behaviour of the module, asserted against `mod`. */
function behaviours(mod) {
  const { deckCoverage, populationsCoverageVerdict } = mod;

  // The rule's constants are the pre-registered ones.
  assert.equal(mod.COVERED_LUMA_ABOVE, 8);
  assert.equal(mod.UNMEASURED_BELOW_FRACTION, 0.01);
  assert.equal(mod.MIN_COVERED_RATIO, 0.25);
  assert.equal(mod.MIN_MEAN_LUMA_RATIO, 0.25);

  // A black frame covers nothing and has no mean.
  const black = deckCoverage(frameWith(0, BRIGHT));
  assert.deepEqual(black, {
    covered: 0,
    total: 100,
    fraction: 0,
    meanLuma: null,
  });

  // Rec. 601 weights, strict boundary at 8. Blue 70 is 7.98, blue 71 is 8.09.
  assert.equal(deckCoverage(frameWith(100, [0, 0, 70])).covered, 0);
  assert.equal(deckCoverage(frameWith(100, [0, 0, 71])).covered, 100);
  // Red 26 is 7.77 and red 27 is 8.07; Rec. 709 would read red 27 as 5.74.
  assert.equal(deckCoverage(frameWith(100, [26, 0, 0])).covered, 0);
  assert.equal(deckCoverage(frameWith(100, [27, 0, 0])).covered, 100);
  // Green weighs most: green 14 is 8.22, green 13 is 7.63.
  assert.equal(deckCoverage(frameWith(100, [0, 14, 0])).covered, 100);
  assert.equal(deckCoverage(frameWith(100, [0, 13, 0])).covered, 0);

  // Alpha is not read.
  assert.equal(deckCoverage(frameWith(100, [200, 200, 200], 0)).covered, 100);

  // The mean is over the covered pixels only: 30 pixels at luma 200.
  const partial = deckCoverage(frameWith(30, BRIGHT));
  assert.equal(partial.covered, 30);
  assert.equal(partial.fraction, 0.3);
  assert.ok(Math.abs(partial.meanLuma - 200) < 1e-9, String(partial.meanLuma));

  // A custom threshold moves the boundary.
  assert.equal(deckCoverage(frameWith(100, DIM), { lumaAbove: 30 }).covered, 0);
  assert.equal(
    deckCoverage(frameWith(100, DIM), { lumaAbove: 10 }).covered,
    100,
  );

  const single = deckCoverage(frameWith(40, BRIGHT));

  // PASS: the same deck, and the deck at exactly the limits (strict compare).
  // These pass the PIXEL FLOORS only: two identical frames pass here whether
  // or not the population march ran. The cell's first condition is the engine's
  // request flag, judged beside this rule in lib/metrics/landing-cross-page.mjs
  // (landing-weather-dial-cells.spec.mjs, section h).
  assert.equal(populationsCoverageVerdict(single, single).outcome, "PASS");
  assert.equal(
    populationsCoverageVerdict(single, deckCoverage(frameWith(10, BRIGHT)))
      .outcome,
    "PASS",
    "10 of 40 covered pixels is exactly 25 %, which does not cross the limit",
  );
  assert.equal(
    populationsCoverageVerdict(
      single,
      deckCoverage(frameWith(40, [50, 50, 50])),
    ).outcome,
    "PASS",
    "mean luma 50 of 200 is exactly 25 %",
  );

  // FAIL by the covered-pixel branch alone: 9 of 40 is 22.5 %, same brightness.
  const fewPixels = populationsCoverageVerdict(
    single,
    deckCoverage(frameWith(9, BRIGHT)),
  );
  assert.equal(fewPixels.outcome, "FAIL");
  assert.equal(fewPixels.reasons.length, 1);
  assert.match(fewPixels.reasons[0], /covers 9 px/);

  // FAIL by the mean-luma branch alone: every pixel covered, a fifth as bright.
  const dim = populationsCoverageVerdict(
    single,
    deckCoverage(frameWith(40, [40, 40, 40])),
  );
  assert.equal(dim.outcome, "FAIL");
  assert.equal(dim.reasons.length, 1);
  assert.match(dim.reasons[0], /mean covered luma/);

  // FAIL: a black populations frame fails both branches.
  const blackDeck = populationsCoverageVerdict(single, black);
  assert.equal(blackDeck.outcome, "FAIL");
  assert.equal(blackDeck.reasons.length, 2);
  assert.equal(blackDeck.coveredRatio, 0);

  // UNMEASURED: the single-layer frame covers under 1 % of the frame, so there
  // is no deck to compare against; exactly 1 % is measured.
  const sparse = deckCoverage(frameWith(0, BRIGHT));
  assert.equal(
    populationsCoverageVerdict(sparse, single).outcome,
    "UNMEASURED",
  );
  const tiny = { width: 100, height: 100, data: new Uint8Array(100 * 100 * 4) };
  const tinyAt = (count) => {
    const data = new Uint8Array(100 * 100 * 4);
    for (let i = 0; i < count; i++) {
      data.set([200, 200, 200, 255], i * 4);
    }
    return deckCoverage({ ...tiny, data });
  };
  assert.equal(
    populationsCoverageVerdict(tinyAt(99), tinyAt(99)).outcome,
    "UNMEASURED",
  );
  assert.equal(
    populationsCoverageVerdict(tinyAt(100), tinyAt(100)).outcome,
    "PASS",
  );
  // UNMEASURED outranks FAIL: a black populations frame beside an empty
  // single-layer frame is not a failure of the populations march.
  assert.equal(populationsCoverageVerdict(sparse, black).outcome, "UNMEASURED");

  // Frames of different sizes cannot be compared.
  assert.equal(
    populationsCoverageVerdict(single, tinyAt(5000)).outcome,
    "UNMEASURED",
  );
}

test("a: covered-pixel metric and the populations rule on synthetic frames", () => {
  behaviours(realModule);
});

test("a: a malformed frame is refused, not read as empty", () => {
  assert.throws(
    () => realModule.deckCoverage({ width: 4, height: 4, data: [] }),
    TypeError,
  );
  assert.throws(() => realModule.deckCoverage(null), TypeError);
});

// ---------------------------------------------------------------------------
// Inertness mutants: each makes one clause unreachable and must turn the
// behaviours red.
// ---------------------------------------------------------------------------

const MUTANTS = Object.freeze([
  {
    name: "the luma test never covers a pixel",
    from: "    if (luma > lumaAbove) {",
    to: "    if (false && luma > lumaAbove) {",
  },
  {
    name: "the UNMEASURED branch is unreachable",
    from: "  if (single.fraction < UNMEASURED_BELOW_FRACTION) {",
    to: "  if (false && single.fraction < UNMEASURED_BELOW_FRACTION) {",
  },
  {
    name: "the covered-pixel FAIL branch is unreachable",
    from: "  if (coveredRatio < MIN_COVERED_RATIO) {",
    to: "  if (false && coveredRatio < MIN_COVERED_RATIO) {",
  },
  {
    name: "the mean-luma FAIL branch is unreachable",
    from: "  if (meanLumaRatio < MIN_MEAN_LUMA_RATIO) {",
    to: "  if (false && meanLumaRatio < MIN_MEAN_LUMA_RATIO) {",
  },
  {
    name: "the outcome never folds to FAIL",
    from: '    outcome: reasons.length > 0 ? "FAIL" : "PASS",',
    to: '    outcome: false && reasons.length > 0 ? "FAIL" : "PASS",',
  },
  {
    name: "the size mismatch guard is unreachable",
    from: "  if (single.total !== populations.total) {",
    to: "  if (false && single.total !== populations.total) {",
  },
]);

test("e: the behaviours pass on the unmutated module", async () => {
  behaviours(await importMutated(METRIC_MODULE, []));
});

for (const mutant of MUTANTS) {
  test(`e: mutant, ${mutant.name}, goes red`, async () => {
    const mutated = await importMutated(METRIC_MODULE, [
      [mutant.from, mutant.to],
    ]);
    assert.throws(() => behaviours(mutated), assert.AssertionError);
  });
}
