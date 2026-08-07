/**
 * C13-16 — the MARCH TRANSFER model, pinned. Maintainer ruling R3, 2026-08-06
 * (`migration_doc/DEFERRED_WORK.md#RULING-2026-08-06`).
 *
 * R3 asked for a model that predicts the INTEGRATED IMAGE rather than the field,
 * and for that model to be checked against real product data before anyone
 * touches an authored aspect or a gate threshold. This spec is the model's
 * permanent home so the answer cannot rot into an undated claim in a report.
 *
 * THE GROUND TRUTH is `probe-cloud-genus-morphology.mjs --phase=direction`,
 * run 2026-08-06 22:46 UTC (`output/cloud-genus-morphology/manifest-direction.json`).
 * Five lanes, `acceptedLines` 16/16 and `saturatedFraction` 0 on every one, so
 * none of the instrument's blindness floors were near. The numbers are copied
 * into `MEASURED_SCREEN_ELONGATION` in the model module.
 *
 * THE MUTATION GROUP is the part that makes this a test rather than a
 * restatement. R3's premise is that a model which measures the FIELD cannot
 * predict the IMAGE; the group requires that to be TRUE — every way of
 * simplifying the model back toward a field measurement has to lose the four
 * ground-truth points. Five independent simplifications are exercised and each
 * must fail. If a future edit lets one of them pass, the model has stopped
 * depending on the stage that mutation removes, and the validation above has
 * stopped meaning anything.
 *
 * That group was VACUOUS as first written and was REBUILT 2026-08-07: it scored
 * a max over all four genera against the THIN lanes' bar, which the optically
 * thick CUMULUS lane's own 0.135 residual already exceeded, so every subtest
 * passed with NO mutation applied. Each subtest now scores displacement from the
 * un-mutated model AND ground-truth loss at each lane's own regime tolerance,
 * and a meta-mutant requires both predicates to go RED on a mutation the model
 * cannot read. Details in the group's docstring.
 *
 * TOLERANCES, AND WHY THEY ARE SPLIT BY OPTICAL REGIME. Nothing here is fitted:
 * every input is read from a shipped artifact. The three cirriform lanes are
 * optically thin (modelled column `tau` 0.21 .. 0.56) and the model reproduces
 * them to 0.054 in elongation. CUMULUS is optically THICK (`tau` ~9.9), where
 * the image is made of the holes in a saturated deck and the two stages this
 * model deliberately omits — tone mapping and the 8-bit canvas clip — act
 * hardest; the model reproduces it to 0.135. The tolerances are set to admit
 * that difference honestly rather than to hide it, and the achieved margins are
 * recorded beside each assertion.
 *
 * Run: node --test Tools/visual-regression/cloud-march-transfer.spec.mjs
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  CLOUD_COVERAGE_ANCHOR,
  CLOUD_COVERAGE_EXPONENT,
  CLOUD_DENSITY_WORLD_TO_NOISE,
  cloudEffectiveCoverage as shippedCloudEffectiveCoverage,
} from "../../packages/engine/Source/Renderer/WebGPU/WebGPUCloudDensityDomain.ts";
import { fibreElongation } from "./lib/cloud-genus-morphology-model.mjs";
import { fixtureById } from "./lib/cloud-tour-fixtures.mjs";
import {
  ABSORPTION_COEFF,
  BASE_FIELD_MEAN,
  BUDGET_DOWN_WEIGHT_SYMMETRIC,
  BUDGET_DOWN_WEIGHT_UP_ONLY,
  COVERAGE_ANCHOR,
  COVERAGE_EXPONENT,
  CloudType,
  CloudTypeProfile,
  FIXTURE_MARCH_INPUTS,
  MEASURED_SCREEN_ELONGATION,
  PROBE_ESTIMATOR,
  PROBE_GEOMETRY,
  PROBE_MARCH,
  TOUR_CIRRUS_FIXTURE,
  U2_CANDIDATE,
  WORLD_TO_NOISE,
  baseVarianceBudgetWeight,
  buildModelParameters,
  cloudEffectiveCoverage,
  columnOpticalDepth,
  gateMean,
  gateMeanQuantile,
  genusMarchParameters,
  invertTransfer,
  meanColumnOpacity,
  metersPerPixel,
  scoreBudgetCandidate,
  screenAnisotropy,
  transferCurve,
} from "./lib/cloud-march-transfer-model.mjs";

/** Elongation tolerance for the optically THIN cirriform lanes. */
const THIN_ELONGATION_TOLERANCE = 0.1;
/** Elongation tolerance for the optically THICK CUMULUS lane. See the header. */
const THICK_ELONGATION_TOLERANCE = 0.2;
/** Relative tolerance on every reported correlation half-length. */
const HALF_LENGTH_RELATIVE_TOLERANCE = 0.15;

const THIN_GENERA = ["CIRRUS", "CIRROSTRATUS", "CIRROCUMULUS"];
const ALL_GENERA = ["CUMULUS", ...THIN_GENERA];

function toleranceFor(name) {
  return name === "CUMULUS"
    ? THICK_ELONGATION_TOLERANCE
    : THIN_ELONGATION_TOLERANCE;
}

/**
 * How far a mutation must move the model's OWN output before the removed stage
 * counts as load-bearing.
 *
 * NOT a new tolerance: it is the SAME band the VALIDATION group scores the thin
 * lanes against. A mutation that moves the model by less than the validation
 * tolerance could not have been detected by the validation at all, so accepting
 * it would be accepting a mutation the group cannot see.
 */
const MUTATION_ELONGATION_DISCRIMINATION = THIN_ELONGATION_TOLERANCE;

// One model evaluation is ~1.3 s (4 genera x 2 directions x 16 lines x 256
// samples x 32 steps), and the rebuilt mutation group needs the un-mutated
// baseline alongside every mutant. Memoised so the baseline is computed once and
// the `{}` no-op in the meta-mutant is free.
const MODEL_CACHE = new Map();

function modelled(name, overrides = {}) {
  const key = `${name}|${JSON.stringify(overrides)}`;
  let hit = MODEL_CACHE.get(key);
  if (hit === undefined) {
    hit = screenAnisotropy({ cloudType: CloudType[name], ...overrides });
    MODEL_CACHE.set(key, hit);
  }
  return hit;
}

/**
 * How far a mutation moves the model away from the UN-MUTATED model.
 *
 * This is the quantity the MUTATION group scores, and it replaces a comparison
 * against an absolute ground-truth bar. The bar was `worst.elongation > 0.1`
 * taken over a max that INCLUDES the optically-thick CUMULUS lane, whose
 * un-mutated residual is 0.135 — so the assertion was satisfied before any
 * mutation was applied and all five subtests passed on the baseline residual
 * rather than on the mutation's effect (audit 2026-08-07, `confirmed[4]`).
 * A displacement is immune to that: the baseline's displacement from itself is
 * exactly 0, by construction.
 *
 * @param {object} overrides The mutation.
 * @param {object} [reference] What the mutation is scored AGAINST. Defaults to
 *   the un-mutated model; an R7 lever that only modifies an already-active
 *   candidate has to be scored against that candidate instead, or the lever it
 *   rides on would carry the displacement and the subtest would prove nothing.
 * @returns {{elongation:number,halfLength:number}} Worst move over ALL_GENERA.
 */
function displacementFromBaseline(overrides, reference = {}) {
  let elongation = 0;
  let halfLength = 0;
  for (const name of ALL_GENERA) {
    const mutant = modelled(name, overrides);
    const base = modelled(name, reference);
    elongation = Math.max(
      elongation,
      Math.abs(mutant.elongation - base.elongation),
    );
    halfLength = Math.max(
      halfLength,
      Math.abs(mutant.alongLength - base.alongLength) / base.alongLength,
      Math.abs(mutant.acrossLength - base.acrossLength) / base.acrossLength,
    );
  }
  return { elongation, halfLength };
}

/**
 * The single mutation predicate. Shared with the meta-mutant so the two cannot
 * drift — a meta-mutant that tested a different predicate would prove nothing
 * about the one the subtests use.
 *
 * @param {{elongation:number,halfLength:number}} displacement
 * @returns {boolean}
 */
function discriminates(displacement) {
  return (
    displacement.elongation > MUTATION_ELONGATION_DISCRIMINATION ||
    displacement.halfLength > HALF_LENGTH_RELATIVE_TOLERANCE
  );
}

/**
 * Does the mutant LOSE the ground truth, scored at each lane's OWN optical
 * regime tolerance?
 *
 * The corroborating half of the rebuild, and the reason `toleranceFor` exists.
 * Comparing a max-over-all-genera against the THIN bar is what made the old
 * group vacuous; comparing each genus against its own bar is the same claim
 * stated correctly, and it discriminates all five mutations.
 *
 * @param {object} overrides The mutation.
 * @returns {boolean}
 */
function losesGroundTruth(overrides) {
  for (const name of ALL_GENERA) {
    const model = modelled(name, overrides);
    const measured = MEASURED_SCREEN_ELONGATION[name];
    if (Math.abs(model.elongation - measured.elongation) > toleranceFor(name)) {
      return true;
    }
    for (const axis of ["alongLength", "acrossLength"]) {
      if (
        Math.abs(model[axis] - measured[axis]) / measured[axis] >
        HALF_LENGTH_RELATIVE_TOLERANCE
      ) {
        return true;
      }
    }
  }
  return false;
}

/** Worst absolute elongation error and worst relative half-length error. */
function worstErrors(overrides = {}) {
  let elongation = 0;
  let halfLength = 0;
  for (const name of ALL_GENERA) {
    const model = modelled(name, overrides);
    const measured = MEASURED_SCREEN_ELONGATION[name];
    elongation = Math.max(
      elongation,
      Math.abs(model.elongation - measured.elongation),
    );
    halfLength = Math.max(
      halfLength,
      Math.abs(model.alongLength - measured.alongLength) / measured.alongLength,
      Math.abs(model.acrossLength - measured.acrossLength) /
        measured.acrossLength,
    );
  }
  return { elongation, halfLength };
}

describe("C13-16 march transfer — the model reads its inputs from shipped artifacts", () => {
  it("takes the genus rows from CloudTypeProfile, not from a local copy", () => {
    for (const name of ALL_GENERA) {
      const parameters = genusMarchParameters(CloudType[name]);
      assert.deepEqual(
        parameters.row,
        CloudTypeProfile.getFibreMorphology(CloudType[name]),
        `${name} fibre row must be the shipped one`,
      );
      assert.equal(
        parameters.profileShape,
        CloudTypeProfile.get(CloudType[name]).shape,
      );
    }
    // The four authored aspects R3's question is about.
    assert.equal(genusMarchParameters(CloudType.CIRRUS).row.anisotropy, 9);
    assert.equal(
      genusMarchParameters(CloudType.CIRROSTRATUS).row.anisotropy,
      5,
    );
    assert.equal(
      genusMarchParameters(CloudType.CIRROCUMULUS).row.anisotropy,
      2,
    );
    assert.equal(genusMarchParameters(CloudType.CUMULUS).row.anisotropy, 1);
  });

  it("derives the CUMULUS-relative density and extinction scales the renderer packs", () => {
    const cirrus = genusMarchParameters(CloudType.CIRRUS);
    // WebGPUProceduralCloudRenderer.ts:2179 / 2187 — slots 102 and 103.
    assert.ok(Math.abs(cirrus.profileDensityScale - 0.15 / 0.7) < 1e-12);
    assert.ok(Math.abs(cirrus.profileExtinction - 0.1 / 0.6) < 1e-12);
    const cumulus = genusMarchParameters(CloudType.CUMULUS);
    assert.equal(cumulus.profileDensityScale, 1);
    assert.equal(cumulus.profileExtinction, 1);
  });

  it("reproduces the probe's pixel scale from the probe's camera", () => {
    const p = buildModelParameters({ cloudType: CloudType.CIRRUS });
    // fov 60 deg is HORIZONTAL at aspect 4:3, so fovy = 46.83 deg.
    assert.ok(Math.abs((p.tanHalfFovX / p.tanHalfFovY) * 1 - 4 / 3) < 1e-9);
    const mpp = metersPerPixel(p);
    assert.ok(
      mpp > 278 && mpp < 279,
      `metres per pixel at the shell mid-height should be ~278.8, got ${mpp}`,
    );
    // 1 noise unit = 1 / WORLD_TO_NOISE metres = 3333.3 m = ~11.96 px. This is
    // the number that makes the whole finding legible: the fibre domain's
    // ACROSS-wind cell is 1/3 of a noise unit, i.e. ~4 px, while the base fBm's
    // first octave is a full noise unit, ~12 px.
    const pixelsPerNoiseUnit = 3333.333 / mpp;
    assert.ok(pixelsPerNoiseUnit > 11.9 && pixelsPerNoiseUnit < 12.0);
  });

  it("marches the SHIPPED single shell — every genus gets the same 2500 m slab", () => {
    // The renderer's cloudLayerBottom/Top defaults; the probe overrides neither,
    // and `cloudMultiDeck` is opt-in. A per-genus deck would change the answer,
    // so this is asserted rather than assumed.
    assert.equal(PROBE_GEOMETRY.shellBottomMeters, 1500);
    assert.equal(PROBE_GEOMETRY.shellTopMeters, 4000);
    assert.equal(PROBE_MARCH.steps, 32);
    assert.equal(ABSORPTION_COEFF, 0.04);
    assert.equal(PROBE_ESTIMATOR.sampleCount, 256);
  });

  it("reads the coverage response and the world->noise scale from the ENGINE, not a copy", () => {
    // The model used to declare `WORLD_TO_NOISE`, `COVERAGE_ANCHOR`,
    // `COVERAGE_EXPONENT` and a whole re-statement of `cloudEffectiveCoverage`
    // as local literals, while the engine shipped all four as an importable CPU
    // twin — and nothing in this "reads its inputs from shipped artifacts" group
    // checked the coverage response at all. `CLOUD_COVERAGE_ANCHOR` and
    // `CLOUD_COVERAGE_EXPONENT` have already been re-derived once in the product
    // (`CLOUD-LOW-COVERAGE-CUTOFF`), so a copy is a live drift risk, not a
    // hypothetical one.
    //
    // Identity, not equality: an equal-valued re-copy would satisfy `===` on the
    // numbers but is exactly what this asserts against for the FUNCTION.
    assert.equal(cloudEffectiveCoverage, shippedCloudEffectiveCoverage);
    assert.equal(WORLD_TO_NOISE, CLOUD_DENSITY_WORLD_TO_NOISE);
    assert.equal(COVERAGE_ANCHOR, CLOUD_COVERAGE_ANCHOR);
    assert.equal(COVERAGE_EXPONENT, CLOUD_COVERAGE_EXPONENT);
    // And the SHAPE of the response the model marches against, so a re-derivation
    // that keeps the symbol names but changes the curve is still visible here.
    assert.equal(cloudEffectiveCoverage(0), 0);
    assert.equal(cloudEffectiveCoverage(1), 1);
    // At and above the anchor the response reproduces the historical
    // `1 - coverage` threshold; below it the coverage is LIFTED.
    assert.ok(cloudEffectiveCoverage(0.55) >= 0.55);
    assert.ok(cloudEffectiveCoverage(0.8) >= 0.8);
    assert.ok(cloudEffectiveCoverage(0.3) > 0.3);
    // The probe's own coverage, i.e. the one every number in this spec marches
    // at, sits at or above the anchor and is therefore NOT lifted.
    assert.ok(PROBE_MARCH.coverage >= COVERAGE_ANCHOR);
  });

  it("puts the four genera in the optical regimes the tolerances assume", () => {
    // Median over a coarse sweep of the frame, not one pixel: a single column
    // lands wherever the base fBm happens to be and says nothing about regime.
    const medianTau = (name) => {
      const p = buildModelParameters({ cloudType: CloudType[name] });
      const samples = [];
      for (let y = -7; y <= 7; y++) {
        for (let x = -7; x <= 7; x++) {
          samples.push(columnOpticalDepth(x * 34, y * 34, p));
        }
      }
      samples.sort((a, b) => a - b);
      return samples[(samples.length - 1) >> 1];
    };
    for (const name of THIN_GENERA) {
      const value = medianTau(name);
      assert.ok(
        value > 0.05 && value < 1.5,
        `${name} should be optically thin, median tau = ${value}`,
      );
    }
    const thick = medianTau("CUMULUS");
    // ~9.9 as measured; the bar is set at 5 so the assertion tests the REGIME
    // (1 - exp(-5) = 0.993, i.e. saturated) rather than a fitted value.
    assert.ok(
      thick > 5,
      `CUMULUS should be optically thick, median tau = ${thick}`,
    );
  });
});

describe("C13-16 march transfer — VALIDATION against the measured probe run", () => {
  for (const name of ALL_GENERA) {
    it(`reproduces the ${name} lane`, () => {
      const model = modelled(name);
      const measured = MEASURED_SCREEN_ELONGATION[name];
      const tolerance = toleranceFor(name);
      assert.ok(
        Math.abs(model.elongation - measured.elongation) <= tolerance,
        `${name}: model ${model.elongation.toFixed(3)} vs measured ` +
          `${measured.elongation.toFixed(3)} exceeds ${tolerance}`,
      );
      for (const axis of ["alongLength", "acrossLength"]) {
        const relative =
          Math.abs(model[axis] - measured[axis]) / measured[axis];
        assert.ok(
          relative <= HALF_LENGTH_RELATIVE_TOLERANCE,
          `${name} ${axis}: model ${model[axis].toFixed(2)} px vs measured ` +
            `${measured[axis].toFixed(2)} px is ${(relative * 100).toFixed(1)}% off`,
        );
      }
    });
  }

  it("reproduces the wind-rotated CIRRUS control as an independent point", () => {
    // manifest-direction.json `cirrusRotated`: wind (0,1), alongDeg 90,
    // along 8.107 / across 6.442 / elongation 1.2585. This lane is not in
    // MEASURED_SCREEN_ELONGATION because it is a control, not a genus.
    const model = screenAnisotropy(
      { cloudType: CloudType.CIRRUS, windDirection: [0, 1] },
      { alongDeg: 90 },
    );
    assert.ok(
      Math.abs(model.elongation - 1.2585) <= THIN_ELONGATION_TOLERANCE,
      `rotated CIRRUS: model ${model.elongation.toFixed(3)} vs measured 1.2585`,
    );
  });

  it("records the achieved margins so a drift is visible, not silent", () => {
    const worst = worstErrors();
    // Achieved 2026-08-06: elongation 0.135 (CUMULUS, the thick lane; 0.054
    // across the three thin ones), half-length 13.0%.
    assert.ok(
      worst.elongation <= THICK_ELONGATION_TOLERANCE,
      `worst elongation error ${worst.elongation.toFixed(3)}`,
    );
    assert.ok(
      worst.halfLength <= HALF_LENGTH_RELATIVE_TOLERANCE,
      `worst half-length error ${(worst.halfLength * 100).toFixed(1)}%`,
    );
    let thin = 0;
    for (const name of THIN_GENERA) {
      thin = Math.max(
        thin,
        Math.abs(
          modelled(name).elongation -
            MEASURED_SCREEN_ELONGATION[name].elongation,
        ),
      );
    }
    assert.ok(
      thin <= THIN_ELONGATION_TOLERANCE,
      `worst THIN elongation error ${thin.toFixed(3)}`,
    );
  });
});

describe("C13-16 march transfer — MUTATION: a model that stops being an IMAGE model must fail", () => {
  /**
   * Each entry removes ONE stage that stands between the anisotropic domain and
   * a pixel. Every one must lose the ground truth. `why` states what a pass
   * would mean, because a mutation that silently starts passing is worse than
   * no mutation at all.
   *
   * REBUILT 2026-08-07. Every entry here was VACUOUS as originally written: the
   * predicate was `worstErrors(overrides).elongation > THIN_ELONGATION_TOLERANCE`,
   * i.e. a max taken over ALL_GENERA — CUMULUS included — compared against the
   * bar for the THIN lanes. CUMULUS's un-mutated residual is 0.135 and the bar
   * is 0.100, so the assertion was satisfied before any mutation was applied and
   * all five subtests passed on the baseline residual. Renaming any of the five
   * override keys (which `buildModelParameters` silently ignores) left every
   * subtest green. Each subtest now scores TWO things — displacement from the
   * un-mutated model, and loss of the ground truth at each lane's OWN regime
   * tolerance — and the meta-mutant below requires both predicates to go RED on
   * a mutation the model cannot read.
   */
  const mutations = [
    {
      label: "the isotropic base field is replaced by its mean",
      overrides: { includeBaseField: false },
      why: "the fBm base no longer sets the image's correlation length",
    },
    {
      label: "the march is reduced to a single sample",
      overrides: { steps: 1 },
      why: "the column integral no longer exists",
    },
    {
      label: "the subtractive Worley erosion is removed",
      overrides: { includeErosion: false },
      why: "the fine isotropic detail no longer competes with the carve",
    },
    {
      label: "the fibre carve is removed entirely",
      overrides: { includeFibre: false },
      why: "the morphology row would not be load-bearing in the model",
    },
    {
      label: "the march's saturating transfer is removed",
      overrides: { saturate: false },
      why: "optical depth is no longer mapped through 1 - exp(-tau)",
    },
  ];

  for (const mutation of mutations) {
    it(`fails when ${mutation.label}`, () => {
      // (a) The mutation must MOVE the model relative to the un-mutated model.
      //     Scored against the baseline, never against an absolute bar the
      //     baseline itself already clears.
      const moved = displacementFromBaseline(mutation.overrides);
      assert.ok(
        discriminates(moved),
        `the mutation did not move the model (elongation ${moved.elongation.toFixed(3)} <= ` +
          `${MUTATION_ELONGATION_DISCRIMINATION}, half-length ${(moved.halfLength * 100).toFixed(1)}% <= ` +
          `${HALF_LENGTH_RELATIVE_TOLERANCE * 100}%) — either the override key is no longer read, ` +
          `or ${mutation.why}`,
      );
      // (b) And it must land OUTSIDE the ground truth at each lane's own
      //     optical-regime tolerance, which is the claim the group's docstring
      //     actually makes.
      assert.ok(
        losesGroundTruth(mutation.overrides),
        `the mutation still reproduces the measured run at every lane's own ` +
          `tolerance — ${mutation.why}`,
      );
    });
  }

  it("the mutation predicate goes RED on a no-op mutation (the meta-mutant)", () => {
    // THE GUARD ON THE GUARD. `buildModelParameters` reads every field as
    // `overrides.X ?? default` with no unknown-key validation, so renaming one
    // of the five override keys silently turns its mutation into a no-op. That
    // is exactly how the previous group went vacuous without anyone noticing:
    // the subtests kept passing while measuring nothing. Feed the SAME two
    // predicates a mutation the model cannot read and require both to reject it.
    const noops = [
      { label: "the empty mutation", overrides: {} },
      {
        label: "all five keys renamed (a future rename, verbatim)",
        overrides: {
          includeBaseFeild: false,
          stepCount: 1,
          includeErrosion: false,
          includeFiber: false,
          saturateTransfer: false,
        },
      },
    ];
    for (const noop of noops) {
      const moved = displacementFromBaseline(noop.overrides);
      assert.equal(
        discriminates(moved),
        false,
        `${noop.label}: the displacement predicate accepted a mutation that ` +
          `changes nothing (elongation ${moved.elongation}, half-length ${moved.halfLength}) ` +
          `— every "fails when ..." subtest above is therefore vacuous`,
      );
      assert.equal(
        losesGroundTruth(noop.overrides),
        false,
        `${noop.label}: the ground-truth predicate reported a loss with no ` +
          `mutation applied — it is scoring the baseline residual, which is the ` +
          `defect this rebuild removed`,
      );
    }
  });

  it("fails when the FIELD is measured instead of the image (the CPU twin)", () => {
    // This is R3's premise stated as a test. `fibreElongation` is the existing
    // twin's field metric; it recovers the authored aspect and is nowhere near
    // the measured screen value. Both numbers are correct — they are answers to
    // different questions, which is the whole finding.
    const field = fibreElongation(
      CloudTypeProfile.getFibreMorphology(CloudType.CIRRUS),
    ).elongation;
    assert.ok(
      field > 5,
      `the field metric should still recover the authored aspect, got ${field}`,
    );
    assert.ok(
      Math.abs(field - MEASURED_SCREEN_ELONGATION.CIRRUS.elongation) >
        THIN_ELONGATION_TOLERANCE,
      "the field metric must not be able to stand in for the image metric",
    );
  });

  it("removing the base field restores very nearly the AUTHORED aspect", () => {
    // The positive half of the first mutation, and the attribution that answers
    // R3: with the isotropic base gone, the same march, the same 32 steps, the
    // same saturating transfer and the same estimator deliver ~9:1 on screen
    // from a 9:1 domain. The march is therefore NOT the attenuator.
    const stripped = modelled("CIRRUS", { includeBaseField: false });
    assert.ok(
      stripped.elongation > 7,
      `expected the authored 9:1 to survive the march, got ${stripped.elongation}`,
    );
  });
});

describe("C13-16 march transfer — the answer R3 asked for", () => {
  it("is step-count invariant, so the step count is not the attenuator", () => {
    const at = (steps) => modelled("CIRRUS", { steps }).elongation;
    const values = [8, 16, 32, 96].map(at);
    const spread = Math.max(...values) - Math.min(...values);
    assert.ok(
      spread < 0.02,
      `elongation moved ${spread.toFixed(3)} across a 12x step-count range`,
    );
  });

  it("the authored-aspect transfer curve SATURATES below gate C's 1.6 floor", () => {
    const curve = transferCurve(
      [1, 2, 3, 5, 7, 9, 12, 16, 24, 32, 48, 64, 96],
      {
        cloudType: CloudType.CIRRUS,
      },
    );
    const ceiling = curve.reduce((top, entry) =>
      entry.elongation > top.elongation ? entry : top,
    );
    assert.ok(
      ceiling.elongation < 1.6,
      `the curve reached ${ceiling.elongation.toFixed(3)} at aspect ${ceiling.aspect}; ` +
        "if this ever passes, raising the aspect HAS become a way to reach the gate",
    );
    const inverted = invertTransfer(curve, 1.6);
    assert.equal(
      inverted.reachable,
      false,
      "gate C's floor must remain unreachable by authored aspect alone",
    );
    // And the curve is not merely slow — it turns over. Doubling past the
    // ceiling buys nothing, because the along-wind fibre scale has already
    // outrun the base field's own decorrelation length.
    const last = curve[curve.length - 1];
    assert.ok(
      last.elongation <= ceiling.elongation,
      "the curve should be flat or falling past its ceiling",
    );
  });

  it("the fibre STRENGTH, not the aspect, is the lever that reaches 1.6", () => {
    const row = buildModelParameters({ cloudType: CloudType.CIRRUS }).row;
    const at = (strength) =>
      modelled("CIRRUS", { row: { ...row, strength } }).elongation;
    // Shipped strength is 0.6. The crossing sits between 0.70 and 0.75 at the
    // SHIPPED aspect 9 — i.e. the gate is reachable without touching the aspect
    // at all, which is precisely the finding R3's two rejected first moves would
    // have hidden.
    assert.ok(at(0.6) < 1.6, `shipped strength already passes: ${at(0.6)}`);
    assert.ok(at(0.7) < 1.6, `strength 0.70 should still be short: ${at(0.7)}`);
    assert.ok(at(0.75) >= 1.6, `strength 0.75 should clear 1.6: ${at(0.75)}`);
  });

  it("prices the strength lever in deck brightness, which is its cost", () => {
    const row = buildModelParameters({ cloudType: CloudType.CIRRUS }).row;
    const meanAlpha = (strength) => {
      const p = buildModelParameters({
        cloudType: CloudType.CIRRUS,
        row: { ...row, strength },
      });
      let sum = 0;
      let count = 0;
      for (let y = -10; y <= 10; y++) {
        for (let x = -10; x <= 10; x++) {
          sum += 1 - Math.exp(-columnOpticalDepth(x * 24, y * 24, p));
          count++;
        }
      }
      return sum / count;
    };
    const shipped = meanAlpha(0.6);
    const raised = meanAlpha(0.75);
    assert.ok(
      raised < shipped,
      "a deeper carve must remove density, not add it",
    );
    // ~17% of the deck's integrated opacity, which is the number that collides
    // with the recorded `northatlantic-cirrus-fibratus` floor risk.
    const loss = (shipped - raised) / shipped;
    assert.ok(
      loss > 0.1 && loss < 0.3,
      `strength 0.6 -> 0.75 should cost 10-30% of mean opacity, cost ${(loss * 100).toFixed(1)}%`,
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
// R7 (maintainer, 2026-08-07) — OPTION 3, the genus-conditioned base-field
// variance budget, DESIGNED IN THE MODEL.
//
// R7 required candidate budgets to be evaluated here, with predicted elongation
// AND opacity numbers, BEFORE any shader edit. They were, and the answer is that
// no candidate satisfies R7's four conditions while leaving the tour fixture's
// coverage floor intact — so nothing shipped, and this is where the frontier
// lives. Every number below is reproducible by `node --test` with no browser.
// ───────────────────────────────────────────────────────────────────────────

/** Tolerance on a pinned elongation. The model has no RNG; this only absorbs
 *  f64 re-association from an unrelated refactor. */
const R7_ELONGATION_PIN = 0.01;
/** Tolerance on a pinned RELATIVE opacity delta, in relative points. */
const R7_OPACITY_PIN = 0.015;

/** R7's own bars, verbatim: gate C's floor and ratio, gate E's ordering step,
 *  gate D's window, and the opacity budget. NOT re-derived here — re-derivation
 *  is exactly what R7 forbade. */
const GATE_C_FLOOR = 1.6;
const GATE_C_RATIO = 1.4;
const GATE_E_STEP = 1.1;
const GATE_D_WINDOW = Object.freeze([60, 120]);
const R7_OPACITY_BUDGET = 0.03;
/** How much of the tour fixture's opacity a candidate may spend before the
 *  `minChangedFraction` floor is in play. The recorded ground value is 0.0028
 *  against a 0.002 floor — 29% of headroom on a TAIL statistic — so 5% is the
 *  generous reading, not the strict one. */
const FIXTURE_OPACITY_ALLOWANCE = -0.05;

const CANDIDATE_CACHE = new Map();
function candidate(overrides, options = {}) {
  const key = `${JSON.stringify(overrides)}|${JSON.stringify(options)}`;
  let hit = CANDIDATE_CACHE.get(key);
  if (hit === undefined) {
    hit = scoreBudgetCandidate(overrides, options);
    CANDIDATE_CACHE.set(key, hit);
  }
  return hit;
}

function fixtureOpacityDelta(overrides) {
  const base = meanColumnOpacity(FIXTURE_MARCH_INPUTS);
  return (
    (meanColumnOpacity({ ...FIXTURE_MARCH_INPUTS, ...overrides }) - base) / base
  );
}

/**
 * The measured frontier. `budget` is chosen per row so every row sits near the
 * SAME on-screen elongation (~1.8-2.0), which is what makes the two opacity
 * columns a like-for-like trade rather than four unrelated operating points.
 */
const R7_FRONTIER = [
  {
    downWeight: 1.0,
    budget: 0.85,
    cirrus: 1.959,
    stepCirrusCirrostratus: 1.878,
    stepCirrostratusCirrocumulus: 1.109,
    probeOpacityDelta: 0.012,
    fixtureOpacityDelta: -0.475,
    fixtureTailDelta: -0.431,
    scan: true,
    argmaxMargin: 1.591,
  },
  {
    downWeight: 0.5,
    budget: 1.0,
    cirrus: 1.841,
    stepCirrusCirrostratus: 1.749,
    stepCirrostratusCirrocumulus: 1.109,
    probeOpacityDelta: 0.105,
    fixtureOpacityDelta: -0.27,
    fixtureTailDelta: -0.219,
    scan: false,
  },
  {
    downWeight: 0.25,
    budget: 1.1,
    cirrus: 1.831,
    stepCirrusCirrostratus: 1.729,
    stepCirrostratusCirrocumulus: 1.11,
    probeOpacityDelta: 0.164,
    fixtureOpacityDelta: -0.139,
    fixtureTailDelta: -0.114,
    scan: false,
  },
  {
    downWeight: 0.0,
    budget: 1.35,
    cirrus: 1.984,
    stepCirrusCirrostratus: 1.84,
    stepCirrostratusCirrocumulus: 1.118,
    probeOpacityDelta: 0.261,
    fixtureOpacityDelta: 0.029,
    fixtureTailDelta: 0.01,
    scan: true,
    argmaxMargin: 1.565,
  },
];

describe("C13-16 R7 budget — the candidate reads its inputs from shipped artifacts", () => {
  it("takes the tour fixture's march inputs from the shipped fixture table", () => {
    // The second configuration is not a restatement: it is the fixture whose
    // `minChangedFraction` floor checklist item 6 names, and a copy of it here
    // would let the floor move without the frontier noticing.
    const shipped = fixtureById("northatlantic-cirrus-fibratus");
    assert.equal(
      TOUR_CIRRUS_FIXTURE.coverage,
      shipped.volumetric.cloudCoverage,
    );
    assert.equal(
      TOUR_CIRRUS_FIXTURE.densityMultiplier,
      shipped.volumetric.cloudDensity,
    );
    assert.equal(
      TOUR_CIRRUS_FIXTURE.geometry.shellBottomMeters,
      shipped.volumetric.cloudLayerBottom,
    );
    assert.equal(
      TOUR_CIRRUS_FIXTURE.geometry.shellTopMeters,
      shipped.volumetric.cloudLayerTop,
    );
    assert.equal(
      TOUR_CIRRUS_FIXTURE.minChangedFraction,
      shipped.gate.minChangedFraction,
    );
    // And it is a DIFFERENT operating point from the one the gates are scored
    // at. If these ever coincide the whole frontier collapses to one column and
    // the reader must be told, loudly.
    assert.notEqual(TOUR_CIRRUS_FIXTURE.coverage, PROBE_MARCH.coverage);
    assert.ok(TOUR_CIRRUS_FIXTURE.coverage < COVERAGE_ANCHOR);
    assert.ok(PROBE_MARCH.coverage >= COVERAGE_ANCHOR);
  });

  it("derives the base field's mean rather than measuring it", () => {
    // (0.5 + 0.25 + 0.125 + 0.0625 + 0.03125) * 0.5 — the octave amplitudes of
    // `fbmNoise` times `valueNoise`'s exact mean. Exact, so `assert.equal`.
    const amplitudes = [0.5, 0.25, 0.125, 0.0625, 0.03125];
    assert.equal(
      BASE_FIELD_MEAN,
      amplitudes.reduce((sum, a) => sum + a, 0) * 0.5,
    );
  });

  it("gives the identity genus a weight of exactly zero, by both factors", () => {
    // This is what would keep a default CUMULUS render byte-identical: the
    // shipped identity row is `(0, 1, 0)`, so `strength` is 0 AND `1 - 1/aspect`
    // is 0.
    const cumulus = CloudTypeProfile.getFibreMorphology(CloudType.CUMULUS);
    assert.equal(cumulus.strength, 0);
    assert.equal(cumulus.anisotropy, 1);
    assert.equal(baseVarianceBudgetWeight(cumulus, 1), 0);
    assert.equal(baseVarianceBudgetWeight(cumulus, 1e6), 0);
    // Either factor alone would do it; both is deliberate, so a future row that
    // gives a puffy genus a nonzero aspect still cannot wake the budget.
    assert.equal(
      baseVarianceBudgetWeight({ strength: 0, anisotropy: 9 }, 1),
      0,
    );
    assert.equal(
      baseVarianceBudgetWeight({ strength: 0.6, anisotropy: 1 }, 1),
      0,
    );
  });

  it("orders the fibrous genera by how much directional signal they have", () => {
    const weightFor = (name, options) =>
      baseVarianceBudgetWeight(
        CloudTypeProfile.getFibreMorphology(CloudType[name]),
        1,
        options,
      );
    // The shipped conditioner: CIRRUS > CIRROSTRATUS > CIRROCUMULUS.
    assert.ok(weightFor("CIRRUS") > weightFor("CIRROSTRATUS"));
    assert.ok(weightFor("CIRROSTRATUS") > weightFor("CIRROCUMULUS"));
    // The REJECTED strength-only conditioner inverts the last pair, which is
    // the direction gate E's second ordering step cannot afford. Pinned rather
    // than argued in prose.
    const noAspect = { useAspect: false };
    assert.ok(
      weightFor("CIRROCUMULUS", noAspect) > weightFor("CIRROSTRATUS", noAspect),
      "the strength-only conditioner should be the one that inverts the pair",
    );
  });

  it("is NOT a twin of shipped code — the shader implements none of it", () => {
    // THE NEGATIVE IDENTITY PIN. Everywhere else in this fleet a model function
    // is pinned to the shader expression it mirrors. Here the claim is the
    // opposite one and it is just as load-bearing: the budget is a CANDIDATE,
    // R7's evaluation of it is the deliverable, and nothing was shipped. If
    // someone later lands the mechanism, this test fails and forces the model to
    // be repointed at the real expression instead of quietly becoming a fiction.
    const shaderPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../packages/engine/Source/Shaders/WebGPU/Environment/ProceduralClouds.wgsl",
    );
    const source = fs.readFileSync(shaderPath, "utf8");
    for (const symbol of [
      "baseVarianceBudget",
      "genusBaseVarianceBudget",
      "budgetPivot",
      "gateMeanQuantile",
    ]) {
      assert.equal(
        source.includes(symbol),
        false,
        `${symbol} appeared in ProceduralClouds.wgsl — the budget has been ` +
          `SHIPPED. Repoint this model at the shipped expression and replace ` +
          `this negative pin with a real identity pin.`,
      );
    }
    // And the three morphology functions the row DID ship are still there, so a
    // path typo cannot make the assertion above pass vacuously.
    for (const symbol of [
      "fn genusFibreFactor",
      "fn genusErosionHeightWeight",
      "fn genusForwardG",
    ]) {
      assert.ok(source.includes(symbol), `${symbol} missing — wrong file?`);
    }
  });
});

describe("C13-16 R7 budget — the candidate is inert at its default", () => {
  it("leaves every pinned lane byte-identical with the budget off", () => {
    // The whole validation group above still has to mean what it meant before
    // the levers existed. `baseVarianceBudget` 0 and `erosionScale` 1 must be
    // the SAME arithmetic, not merely close: `x * 1` is exact in f32.
    for (const name of ALL_GENERA) {
      const off = modelled(name);
      const explicit = modelled(name, {
        baseVarianceBudget: 0,
        erosionScale: 1,
      });
      assert.equal(explicit.elongation, off.elongation, name);
      assert.equal(explicit.alongLength, off.alongLength, name);
      assert.equal(explicit.acrossLength, off.acrossLength, name);
    }
  });

  it("never moves CUMULUS, at any point on the frontier", () => {
    // The default genus must be untouched by every candidate, or the budget is
    // not genus-conditioned and the whole design is a global appearance change.
    const reference = modelled("CUMULUS").elongation;
    for (const row of R7_FRONTIER) {
      const scored = candidate(
        { baseVarianceBudget: row.budget, budgetDownWeight: row.downWeight },
        { scan: false },
      );
      assert.equal(
        scored.elongation.CUMULUS,
        reference,
        `CUMULUS moved at budget ${row.budget} / downWeight ${row.downWeight}`,
      );
    }
  });
});

describe("C13-16 R7 budget — the PIVOT a mean-neutral budget needs cannot be a constant", () => {
  it("measures the gate's own mean, and it moves with coverage", () => {
    const probe = gateMean(cloudEffectiveCoverage(PROBE_MARCH.coverage));
    const fixture = gateMean(
      cloudEffectiveCoverage(TOUR_CIRRUS_FIXTURE.coverage),
    );
    // ~0.304 against ~0.056: the tour fixture's deck carries a fifth of the
    // gated density the gate probe's does, before extinction and deck depth.
    assert.ok(Math.abs(probe - 0.3044) < 0.01, `probe gate mean ${probe}`);
    assert.ok(
      Math.abs(fixture - 0.0556) < 0.005,
      `fixture gate mean ${fixture}`,
    );
    assert.ok(probe > fixture * 4);
  });

  it("the mean-neutral pivot quantile runs 0.605 -> 0.485 across the coverage range", () => {
    const at = (cEff) => gateMeanQuantile(cEff);
    // Monotone DECREASING in coverage: at low coverage the gate's mean is
    // carried by the field's upper tail, so the mean-equivalent quantile sits
    // high; at full coverage the ramp is symmetric about the field and the
    // quantile collapses onto the field's own mean.
    const samples = [0.4271, 0.5231, 0.6, 0.8, 1.0].map(at);
    for (let i = 1; i < samples.length; i++) {
      assert.ok(
        samples[i] < samples[i - 1],
        `pivot quantile not monotone: ${samples}`,
      );
    }
    assert.ok(Math.abs(samples[0] - 0.6049) < 0.01);
    assert.ok(Math.abs(samples[3] - 0.4931) < 0.005);
    assert.ok(Math.abs(samples[4] - BASE_FIELD_MEAN) < 0.005);
    // The spread is what refutes the constant: 0.12 of base-field value across
    // a field whose own sigma is ~0.115.
    assert.ok(samples[0] - samples[4] > 0.1);
  });

  it("shipping the probe's pivot as a constant costs the fixture another 14 points", () => {
    const exactDelta = fixtureOpacityDelta({ baseVarianceBudget: 0.85 });
    const constantDelta = fixtureOpacityDelta({
      baseVarianceBudget: 0.85,
      budgetPivotQuantile: gateMeanQuantile(
        cloudEffectiveCoverage(PROBE_MARCH.coverage),
      ),
    });
    // -47.5% with the exact per-coverage pivot, -61.9% with the constant one.
    assert.ok(Math.abs(exactDelta + 0.475) < R7_OPACITY_PIN, `${exactDelta}`);
    assert.ok(
      Math.abs(constantDelta + 0.619) < R7_OPACITY_PIN,
      `${constantDelta}`,
    );
    assert.ok(
      constantDelta < exactDelta - 0.1,
      "the constant pivot must be materially worse, or the refutation is empty",
    );
  });
});

describe("C13-16 R7 budget — ATTRIBUTION: the blocker is the EROSION ZERO CLAMP", () => {
  it("the same budget is mean-positive at the fixture once the clamp is removed", () => {
    // The decisive experiment, and the reason `erosionScale` exists. `max(base *
    // gradient - erosion, 0)` is convex in the base, so shrinking the base's
    // variance shrinks the mass that survives it. At the fixture's coverage the
    // mean erosion EXCEEDS the mean gated density, so that deck IS the base
    // field's upper tail. Take the erosion away and the identical budget stops
    // costing anything.
    const withErosion = fixtureOpacityDelta({ baseVarianceBudget: 0.85 });
    const strippedBase = meanColumnOpacity({
      ...FIXTURE_MARCH_INPUTS,
      erosionScale: 0,
    });
    const without =
      (meanColumnOpacity({
        ...FIXTURE_MARCH_INPUTS,
        baseVarianceBudget: 0.85,
        erosionScale: 0,
      }) -
        strippedBase) /
      strippedBase;
    assert.ok(Math.abs(withErosion + 0.475) < R7_OPACITY_PIN, `${withErosion}`);
    assert.ok(Math.abs(without - 0.057) < R7_OPACITY_PIN, `${without}`);
    assert.ok(
      without > 0 && withErosion < -0.3,
      "the clamp attribution must flip the SIGN, not merely soften the number",
    );
  });

  it("the erosion depth is a strong MASS lever and a weak ELONGATION lever", () => {
    // Which is why it cannot be the compensator: to give the fixture its 47
    // points back it has to be moved far enough to add 10-12 points at the gate
    // configuration, and it buys almost no elongation on the way.
    const stripped = modelled("CIRRUS", { erosionScale: 0 }).elongation;
    const base = modelled("CIRRUS").elongation;
    assert.ok(
      stripped - base < 0.2,
      `removing the erosion entirely moved elongation ${stripped - base}`,
    );
    assert.ok(stripped < GATE_C_FLOOR);
    const probeBase = meanColumnOpacity({ cloudType: CloudType.CIRRUS });
    const probeMass =
      (meanColumnOpacity({ cloudType: CloudType.CIRRUS, erosionScale: 0 }) -
        probeBase) /
      probeBase;
    const fixtureMass = fixtureOpacityDelta({ erosionScale: 0 });
    assert.ok(
      probeMass > 0.2 && fixtureMass > 0.6,
      `${probeMass} ${fixtureMass}`,
    );
    // ~2.2x stronger where the floor is than where the opacity budget is.
    assert.ok(
      fixtureMass / probeMass > 2,
      "the compensator must overshoot the gate configuration",
    );
  });
});

describe("C13-16 R7 budget — THE FRONTIER, and why nothing shipped", () => {
  for (const row of R7_FRONTIER) {
    it(`downWeight ${row.downWeight} / budget ${row.budget} lands where the table says`, () => {
      const scored = candidate(
        { baseVarianceBudget: row.budget, budgetDownWeight: row.downWeight },
        { scan: row.scan },
      );
      const near = (actual, expected, tolerance, label) =>
        assert.ok(
          Math.abs(actual - expected) <= tolerance,
          `${label}: ${actual} vs pinned ${expected}`,
        );
      near(scored.cirrus, row.cirrus, R7_ELONGATION_PIN, "gate C elongation");
      near(
        scored.stepCirrusCirrostratus,
        row.stepCirrusCirrostratus,
        R7_ELONGATION_PIN,
        "gate E step 1",
      );
      near(
        scored.stepCirrostratusCirrocumulus,
        row.stepCirrostratusCirrocumulus,
        R7_ELONGATION_PIN,
        "gate E step 2",
      );
      near(
        scored.probeOpacityDelta,
        row.probeOpacityDelta,
        R7_OPACITY_PIN,
        "gate-configuration opacity delta",
      );
      near(
        scored.fixtureOpacityDelta,
        row.fixtureOpacityDelta,
        R7_OPACITY_PIN,
        "fixture opacity delta",
      );
      near(
        scored.fixtureTailDelta,
        row.fixtureTailDelta,
        R7_OPACITY_PIN,
        "fixture TAIL delta",
      );
      if (row.scan) {
        assert.ok(
          scored.argmaxDeg >= GATE_D_WINDOW[0] &&
            scored.argmaxDeg <= GATE_D_WINDOW[1],
          `gate D argmax ${scored.argmaxDeg} outside ${GATE_D_WINDOW}`,
        );
        near(
          scored.argmaxMargin,
          row.argmaxMargin,
          0.05,
          "gate D argmax margin",
        );
      }
    });
  }

  it("every row on the frontier clears gate C, so the mechanism WORKS", () => {
    // The positive half, and it is worth stating plainly: R7's option 3 does
    // reach a gate that the aspect could never reach and that strength could
    // only reach at -17% opacity. The 1.6 floor is met here at +1.2%.
    for (const row of R7_FRONTIER) {
      const scored = candidate(
        { baseVarianceBudget: row.budget, budgetDownWeight: row.downWeight },
        { scan: false },
      );
      assert.ok(
        scored.cirrus >= GATE_C_FLOOR,
        `${row.budget}: ${scored.cirrus}`,
      );
      assert.ok(scored.cirrusOverCumulus >= GATE_C_RATIO);
      assert.ok(scored.stepCirrusCirrostratus >= GATE_E_STEP);
      assert.ok(scored.stepCirrostratusCirrocumulus >= GATE_E_STEP);
    }
  });

  it("and NO row holds both opacity surfaces — this is the STOP", () => {
    // The whole finding in one assertion. R7's opacity constraint is written
    // against the gate configuration; checklist item 6's floor lives at the tour
    // fixture. Every candidate that clears gate C pays on one or the other.
    for (const row of R7_FRONTIER) {
      const scored = candidate(
        { baseVarianceBudget: row.budget, budgetDownWeight: row.downWeight },
        { scan: false },
      );
      const holdsProbe =
        Math.abs(scored.probeOpacityDelta) <= R7_OPACITY_BUDGET;
      const holdsFixture =
        scored.fixtureOpacityDelta >= FIXTURE_OPACITY_ALLOWANCE &&
        scored.fixtureTailDelta >= FIXTURE_OPACITY_ALLOWANCE;
      assert.equal(
        holdsProbe && holdsFixture,
        false,
        `budget ${row.budget} / downWeight ${row.downWeight} satisfies BOTH ` +
          `surfaces (probe ${scored.probeOpacityDelta}, fixture ` +
          `${scored.fixtureOpacityDelta}). The R7 STOP is no longer justified — ` +
          `re-read DEFERRED_WORK's C13-16 R7 section before shipping anything.`,
      );
    }
  });

  it("is a monotone trade, not two isolated points", () => {
    // Stated because a frontier given as two endpoints invites "you did not look
    // in between". Spending downWeight moves BOTH surfaces, in opposite
    // directions, at every intermediate value.
    const rows = R7_FRONTIER.map((row) =>
      candidate(
        { baseVarianceBudget: row.budget, budgetDownWeight: row.downWeight },
        { scan: false },
      ),
    );
    for (let i = 1; i < rows.length; i++) {
      assert.ok(
        rows[i].probeOpacityDelta > rows[i - 1].probeOpacityDelta,
        `gate-configuration opacity not monotone at row ${i}`,
      );
      assert.ok(
        rows[i].fixtureOpacityDelta > rows[i - 1].fixtureOpacityDelta,
        `fixture opacity not monotone at row ${i}`,
      );
    }
    // And the exchange rate is ~1:-2, which is why no interior point works:
    // buying back 47 points of fixture costs ~25 points at the gate camera.
    const first = rows[0];
    const last = rows[rows.length - 1];
    const rate =
      (last.fixtureOpacityDelta - first.fixtureOpacityDelta) /
      (last.probeOpacityDelta - first.probeOpacityDelta);
    assert.ok(rate > 1.5 && rate < 3, `exchange rate ${rate}`);
  });
});

describe("C13-16 R7 budget — MUTATION: every new lever must be READ", () => {
  /**
   * The Batch-869 discipline, applied to the levers R7 added. That rebuild found
   * five mutation subtests passing on a baseline residual rather than on any
   * mutation, and found the mechanism: `buildModelParameters` reads every field
   * as `overrides.X ?? default` with NO unknown-key validation, so a renamed key
   * is a silent no-op. Four new keys have just been added to that same reader.
   */
  const levers = [
    {
      label: "baseVarianceBudget",
      overrides: { baseVarianceBudget: 0.85 },
      reference: {},
    },
    {
      label: "budgetDownWeight",
      overrides: {
        baseVarianceBudget: 0.85,
        budgetDownWeight: BUDGET_DOWN_WEIGHT_UP_ONLY,
      },
      // Scored against the SYMMETRIC budget at the same strength, not against
      // the un-mutated model — otherwise `baseVarianceBudget` alone would carry
      // the displacement and this subtest would prove nothing about the weight.
      reference: {
        baseVarianceBudget: 0.85,
        budgetDownWeight: BUDGET_DOWN_WEIGHT_SYMMETRIC,
      },
    },
    {
      label: "budgetPivotQuantile",
      overrides: { baseVarianceBudget: 0.85, budgetPivotQuantile: 0.2 },
      reference: { baseVarianceBudget: 0.85 },
    },
    {
      label: "budgetUseAspect",
      overrides: { baseVarianceBudget: 0.85, budgetUseAspect: false },
      reference: { baseVarianceBudget: 0.85 },
    },
  ];

  for (const lever of levers) {
    it(`${lever.label} moves the model away from its reference`, () => {
      const moved = displacementFromBaseline(lever.overrides, lever.reference);
      assert.ok(
        discriminates(moved),
        `${lever.label} did not move the model (elongation ${moved.elongation}, ` +
          `half-length ${moved.halfLength}) — the override key is not being read`,
      );
    });
  }

  it("erosionScale moves the OPACITY, which is the statistic it exists for", () => {
    // Scored on mass rather than on shape: the attribution lever's whole job is
    // to move the fixture's column opacity, and it barely moves elongation (that
    // IS the finding). Scoring it on elongation would be scoring the wrong axis.
    const moved = fixtureOpacityDelta({ erosionScale: 0 });
    assert.ok(
      Math.abs(moved) > 0.2,
      `erosionScale did not move the fixture's opacity (${moved})`,
    );
  });

  it("the predicates go RED on mutations the model cannot read (the meta-mutant)", () => {
    // THE GUARD ON THE GUARD, extended to the four new keys. Renaming each of
    // them must leave BOTH predicates rejecting, or the subtests above are
    // measuring the baseline again.
    const noops = [
      { label: "the empty mutation", overrides: {} },
      {
        label: "all four new keys renamed (a future rename, verbatim)",
        overrides: {
          baseVarianceBudgt: 0.85,
          budgetDownWeigth: 0,
          budgetPivotQuantil: 0.2,
          budgetUsesAspect: false,
        },
      },
    ];
    for (const noop of noops) {
      const moved = displacementFromBaseline(noop.overrides);
      assert.equal(
        discriminates(moved),
        false,
        `${noop.label}: the displacement predicate accepted a mutation that ` +
          `changes nothing (elongation ${moved.elongation}) — every lever ` +
          `subtest above is therefore vacuous`,
      );
      assert.equal(
        losesGroundTruth(noop.overrides),
        false,
        `${noop.label}: the ground-truth predicate reported a loss with no ` +
          `mutation applied`,
      );
    }
    // And the same for the erosion lever's own predicate.
    assert.equal(
      fixtureOpacityDelta({ erosionScal: 0 }),
      0,
      "a renamed erosionScale still moved the model — the key is being read " +
        "under two spellings",
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
// U2 (2026-08-07) — the two unblockers Batch 896 named, EVALUATED.
//
// Batch 896 ended at a STOP and listed what would lift it. Both items are now
// levers in the model and both have been swept. The STOP lifts for the PAIR
// (reorder + genus-conditioned erosion compensation), and the R7 unblocker U1
// turns out not to be needed at all. Nothing is shipped: this is still a design
// instrument, and the negative shader pin below is extended to say so.
// ───────────────────────────────────────────────────────────────────────────

/** R7's bars again, so the U2 groups score against the SAME numbers. */
const U2_GATE_C_FLOOR = 1.6;
const U2_GATE_C_RATIO = 1.4;
const U2_GATE_E_STEP = 1.1;
const U2_GATE_D_WINDOW = Object.freeze([60, 120]);

/**
 * The recorded tour value the floor prediction is scaled from. `probe-cloud-tour`
 * measured ground `changedFraction` 0.0028 for this fixture after
 * CLOUD-LOW-COVERAGE-CUTOFF; the authored floor is 0.002.
 */
const FIXTURE_RECORDED_GROUND_FRACTION = 0.0028;

describe("U2-REORDER — the composition change, defined against the SHIPPED order", () => {
  it("the SHIPPED shader still carves AFTER the erosion clamp", () => {
    // The reorder is only a delta if the thing it is a delta FROM is still
    // there. `legacyCloudDensity` must still clamp to zero and only then
    // multiply the fibre factor in its trailing product. If this order ever
    // changes in the shader, `carveBeforeErosion: false` has stopped meaning
    // "shipped" and every number in these groups is measured against a fiction.
    const shaderPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../packages/engine/Source/Shaders/WebGPU/Environment/ProceduralClouds.wgsl",
    );
    const source = fs.readFileSync(shaderPath, "utf8");
    const start = source.indexOf("fn legacyCloudDensity(");
    assert.ok(start > 0, "legacyCloudDensity not found");
    const body = source.slice(start, source.indexOf("\nfn ", start + 10));
    const clampAt = body.indexOf("density = max(density, 0.0);");
    const carveAt = body.indexOf("genusFibreFactor(samplePos, heightFraction)");
    assert.ok(clampAt > 0, "the subtractive erosion's zero clamp is gone");
    assert.ok(carveAt > 0, "the fibre carve is gone from legacyCloudDensity");
    assert.ok(
      clampAt < carveAt,
      "legacyCloudDensity now carves BEFORE the clamp — the U2 reorder has " +
        "been SHIPPED. Repoint the model's default and re-baseline these groups.",
    );
    // And the BAKED route's remap spelling is still the other shipped one, which
    // is what `erosionMode` exists to express.
    assert.ok(source.includes("remap(density, erosionLo, 1.0, 0.0, 1.0)"));
  });

  it("is byte-identical on every non-fibrous genus, structurally", () => {
    // THE GENUS GATE, and it is not a branch. `genusFibreFactor` early-returns
    // exactly 1.0 at `strength` 0, and `x * 1` is exact in f32, so
    // `max(x*1 - e, 0) * 1` and `max(x - e, 0) * 1` are the same arithmetic.
    // Asserted with `assert.equal` and no tolerance, on the lane that matters.
    const shipped = modelled("CUMULUS");
    const reordered = modelled("CUMULUS", { carveBeforeErosion: true });
    assert.equal(reordered.elongation, shipped.elongation);
    assert.equal(reordered.alongLength, shipped.alongLength);
    assert.equal(reordered.acrossLength, shipped.acrossLength);
    // Including with the compensation on, which is conditioned on the same
    // `strength` and is therefore also exactly inert here.
    const compensated = modelled("CUMULUS", {
      carveBeforeErosion: true,
      erosionCompensation: 1,
    });
    assert.equal(compensated.elongation, shipped.elongation);
    // The raw `erosionScale` attribution lever is deliberately NOT gated — it
    // has to keep moving CUMULUS or "turn the erosion off entirely" would stop
    // being expressible, and the Batch-896 attribution is scored with it.
    assert.notEqual(
      modelled("CUMULUS", { erosionScale: 0 }).elongation,
      shipped.elongation,
    );
  });

  it("can only REMOVE mass pointwise, so it is not a free lunch", () => {
    // `f * max(x - e, 0) = max(f*x - f*e, 0) >= max(f*x - e, 0)` for f in [0,1].
    // Stated as a measurement rather than as algebra: at zero budget the reorder
    // costs -15.2% at the gate configuration and -26.9% at the tour fixture.
    const probeBase = meanColumnOpacity({ cloudType: CloudType.CIRRUS });
    const probe =
      (meanColumnOpacity({
        cloudType: CloudType.CIRRUS,
        carveBeforeErosion: true,
      }) -
        probeBase) /
      probeBase;
    const fixtureBase = meanColumnOpacity(FIXTURE_MARCH_INPUTS);
    const fixture =
      (meanColumnOpacity({
        ...FIXTURE_MARCH_INPUTS,
        carveBeforeErosion: true,
      }) -
        fixtureBase) /
      fixtureBase;
    assert.ok(probe < 0 && fixture < 0, "the reorder must not ADD mass");
    assert.ok(Math.abs(probe + 0.152) < R7_OPACITY_PIN, `${probe}`);
    assert.ok(Math.abs(fixture + 0.269) < R7_OPACITY_PIN, `${fixture}`);
  });

  it("buys 0.31 of elongation at zero budget — the free half of the result", () => {
    // Carving before the clamp means a filament GAP has to clear the erosion
    // floor after being carved, so the gaps are driven to exactly zero instead
    // of merely scaled down. That is a harder streak edge for no budget at all.
    const shipped = modelled("CIRRUS").elongation;
    const reordered = modelled("CIRRUS", {
      carveBeforeErosion: true,
    }).elongation;
    assert.ok(Math.abs(shipped - 1.2323) < R7_ELONGATION_PIN);
    assert.ok(Math.abs(reordered - 1.5414) < R7_ELONGATION_PIN, `${reordered}`);
    // Most of the way to gate C, and still short of it — which is why the pair
    // still needs a budget on top.
    assert.ok(reordered < U2_GATE_C_FLOOR);
  });
});

describe("U2-COMPENSATION — the erosion lever, and why the PAIR cancels", () => {
  it("is genus-conditioned on the same axis the shipped height weight uses", () => {
    // `genusErosionHeightWeight` conditions on `strength` alone; so does this,
    // so the two cannot disagree about which genera are fibrous.
    const cirrus = CloudTypeProfile.getFibreMorphology(CloudType.CIRRUS);
    const cumulus = CloudTypeProfile.getFibreMorphology(CloudType.CUMULUS);
    const scaleFor = (row, compensation) =>
      buildModelParameters({ row, erosionCompensation: compensation })
        .erosionDepthScale;
    assert.equal(scaleFor(cumulus, 1), 1);
    assert.equal(scaleFor(cirrus, 0), 1);
    assert.ok(Math.abs(scaleFor(cirrus, 1) - 0.4) < 1e-6);
    // And it still composes with the raw attribution lever.
    assert.equal(
      buildModelParameters({
        row: cirrus,
        erosionCompensation: 1,
        erosionScale: 0,
      }).erosionDepthScale,
      0,
    );
  });

  it("cancels the reorder at BOTH configurations at once — the coincidence", () => {
    // THE RESULT. Batch 896's blocker was an exchange rate: the erosion's mass
    // leverage is ~2.2x stronger at the fixture than at the gate configuration,
    // so compensating one overshot the other. The reorder's mass LOSS carries
    // almost the same ratio (26.9 / 15.2 = 1.77), so a single compensation
    // setting lands both within a quarter of a point of zero.
    const probeBase = meanColumnOpacity({ cloudType: CloudType.CIRRUS });
    const fixtureBase = meanColumnOpacity(FIXTURE_MARCH_INPUTS);
    const paired = { carveBeforeErosion: true, erosionCompensation: 0.667 };
    const probe =
      (meanColumnOpacity({ cloudType: CloudType.CIRRUS, ...paired }) -
        probeBase) /
      probeBase;
    const fixture =
      (meanColumnOpacity({ ...FIXTURE_MARCH_INPUTS, ...paired }) -
        fixtureBase) /
      fixtureBase;
    assert.ok(Math.abs(probe) < 0.01, `gate configuration ${probe}`);
    assert.ok(Math.abs(fixture) < 0.01, `tour fixture ${fixture}`);
    // Neither half does this alone: the compensation on the SHIPPED composition
    // is the Batch-896 overshoot, +15.4% / +36.0%.
    const soloProbe =
      (meanColumnOpacity({
        cloudType: CloudType.CIRRUS,
        erosionCompensation: 1,
      }) -
        probeBase) /
      probeBase;
    assert.ok(
      soloProbe > 0.1,
      `compensation alone should overshoot: ${soloProbe}`,
    );
  });
});

describe("U2 — the EROSION MODE finding: the two shipped routes disagree", () => {
  it("the BAKED remap is not byte-neutral if brought to the LIVE route", () => {
    // Not a candidate — a finding. `cloudDensityFromMacro` erodes by a remap the
    // renderer's uniform table calls "mean-preserving"; `legacyCloudDensity`
    // subtracts. They are not the same image: switching this model's LIVE chain
    // to the remap moves the DEFAULT CUMULUS lane, which alone disqualifies it
    // as a quiet alignment, and it adds opacity rather than reaching a gate.
    const shipped = modelled("CUMULUS").elongation;
    const remapped = modelled("CUMULUS", { erosionMode: "remap" }).elongation;
    assert.notEqual(remapped, shipped);
    assert.ok(Math.abs(remapped - 0.8328) < R7_ELONGATION_PIN, `${remapped}`);
    const base = meanColumnOpacity({ cloudType: CloudType.CIRRUS });
    const delta =
      (meanColumnOpacity({
        cloudType: CloudType.CIRRUS,
        erosionMode: "remap",
      }) -
        base) /
      base;
    assert.ok(delta > 0.03, `the remap should ADD mass, got ${delta}`);
    // And it does not rescue the fixture under a budget — the point of testing it.
    const fixtureBase = meanColumnOpacity(FIXTURE_MARCH_INPUTS);
    const fixture =
      (meanColumnOpacity({
        ...FIXTURE_MARCH_INPUTS,
        erosionMode: "remap",
        carveBeforeErosion: true,
        baseVarianceBudget: 0.5,
      }) -
        fixtureBase) /
      fixtureBase;
    assert.ok(fixture < -0.3, `remap should not rescue the floor: ${fixture}`);
  });
});

describe("U2 — the SIGN-OFF candidate clears every R7 bar", () => {
  const scored = () => candidate(U2_CANDIDATE, { scan: true });

  it("gate C: CIRRUS 1.733 against the 1.6 floor, ratio 2.072 against 1.4", () => {
    const s = scored();
    assert.ok(Math.abs(s.cirrus - 1.733) < R7_ELONGATION_PIN, `${s.cirrus}`);
    assert.ok(s.cirrus >= U2_GATE_C_FLOOR);
    assert.ok(s.cirrusOverCumulus >= U2_GATE_C_RATIO);
    assert.ok(
      Math.abs(s.cirrusOverCumulus - 2.072) < R7_ELONGATION_PIN,
      `${s.cirrusOverCumulus}`,
    );
  });

  it("gate D: the argmax sits on the true wind axis with a 1.38x margin", () => {
    const s = scored();
    assert.ok(
      s.argmaxDeg >= U2_GATE_D_WINDOW[0] && s.argmaxDeg <= U2_GATE_D_WINDOW[1],
      `argmax ${s.argmaxDeg}`,
    );
    assert.ok(Math.abs(s.argmaxMargin - 1.456) < 0.05, `${s.argmaxMargin}`);
    // The baseline is a 1.02x near-tie, i.e. the shipped composition is one
    // percent of noise away from the 60 deg the probe actually measured. The
    // candidate is not.
    const baseline = candidate({}, { scan: true });
    assert.ok(s.argmaxMargin > baseline.argmaxMargin * 1.3);
  });

  it("gate E: both ordering steps clear x1.1", () => {
    const s = scored();
    assert.ok(s.stepCirrusCirrostratus >= U2_GATE_E_STEP);
    assert.ok(s.stepCirrostratusCirrocumulus >= U2_GATE_E_STEP);
    assert.ok(
      Math.abs(s.stepCirrusCirrostratus - 1.644) < R7_ELONGATION_PIN,
      `${s.stepCirrusCirrostratus}`,
    );
    assert.ok(
      Math.abs(s.stepCirrostratusCirrocumulus - 1.121) < R7_ELONGATION_PIN,
      `${s.stepCirrostratusCirrocumulus}`,
    );
  });

  it("opacity: +4.4% at the gate configuration, -10.2% at the tour fixture", () => {
    const s = scored();
    assert.ok(
      Math.abs(s.probeOpacityDelta - 0.044) < R7_OPACITY_PIN,
      `${s.probeOpacityDelta}`,
    );
    assert.ok(
      Math.abs(s.fixtureOpacityDelta + 0.102) < R7_OPACITY_PIN,
      `${s.fixtureOpacityDelta}`,
    );
    // Both are "a few percent" in R7's wording, and NEITHER is within a strict
    // 3%. The candidate is not the cheapest point on the frontier — it is the
    // cheapest one whose gate-C margin clears the model's own validated band,
    // which is the constraint that actually decides whether an Edge run is worth
    // spending. The cheaper balanced point is pinned in the frontier group.
    assert.ok(s.probeOpacityDelta > 0 && s.fixtureOpacityDelta < 0);
  });

  it("the tour fixture's FLOOR is predicted to hold with margin", () => {
    const s = scored();
    assert.ok(
      Math.abs(s.fixtureTailDelta + 0.078) < R7_OPACITY_PIN,
      `${s.fixtureTailDelta}`,
    );
    const predicted =
      FIXTURE_RECORDED_GROUND_FRACTION * (1 + s.fixtureTailDelta);
    assert.ok(
      predicted > TOUR_CIRRUS_FIXTURE.minChangedFraction,
      `predicted ground changedFraction ${predicted} is under the floor`,
    );
    // ~0.00258 against 0.002, i.e. 29% of margin. Batch 896's best gate-C point
    // predicted 0.00159 — UNDER the floor. That reversal is the whole result.
    assert.ok(predicted > 0.00255, `${predicted}`);
  });

  it("leaves CUMULUS byte-identical", () => {
    assert.equal(scored().elongation.CUMULUS, modelled("CUMULUS").elongation);
  });
});

describe("U2 — U1 is a refinement, not a prerequisite", () => {
  it("the exact per-coverage pivot buys margin, and the candidate passes without it", () => {
    // R7's unblocker U1 was "ship a `cloudGateMean(cEff)` response so the budget
    // can be mean-neutral at every coverage". At Batch 896's budget weight
    // (0.45) that was load-bearing: a constant pivot cost another 14 points at
    // the fixture. At the PAIR's much smaller weight (0.24) it is worth ~3.6
    // points of fixture tail, and every gate still passes without it — so U1
    // comes off the critical path.
    const exact = candidate(U2_CANDIDATE, { scan: false });
    const plain = candidate(
      { ...U2_CANDIDATE, budgetPivotQuantile: BASE_FIELD_MEAN },
      { scan: false },
    );
    assert.ok(plain.cirrus >= U2_GATE_C_FLOOR, `${plain.cirrus}`);
    assert.ok(plain.stepCirrostratusCirrocumulus >= U2_GATE_E_STEP);
    const predicted =
      FIXTURE_RECORDED_GROUND_FRACTION * (1 + plain.fixtureTailDelta);
    assert.ok(
      predicted > TOUR_CIRRUS_FIXTURE.minChangedFraction,
      `plain-pivot floor prediction ${predicted}`,
    );
    // The exact pivot is BETTER at the fixture — that is its value, stated as a
    // number so "U1 is optional" is a measured claim and not a shrug.
    assert.ok(
      exact.fixtureTailDelta > plain.fixtureTailDelta,
      "the exact pivot should spare the fixture",
    );
  });
});

describe("U2 — VALIDATION splits: shipped matches measurements, reordered is PRE-REGISTERED", () => {
  it("the SHIPPED-composition model still reproduces the measured run", () => {
    // MUST HOLD. `carveBeforeErosion` defaults to false, so the Batch-857
    // five-lane validation is untouched by any of this; re-asserted here because
    // the composition lever is exactly the kind of thing that silently
    // re-baselines a validation.
    const worst = worstErrors();
    assert.ok(worst.elongation <= THICK_ELONGATION_TOLERANCE);
    assert.ok(worst.halfLength <= HALF_LENGTH_RELATIVE_TOLERANCE);
    for (const name of ALL_GENERA) {
      assert.equal(
        modelled(name, { carveBeforeErosion: false }).elongation,
        modelled(name).elongation,
      );
    }
  });

  it("the REORDERED predictions are NOT validated, and must not be compared to the measured run", () => {
    // The reordered model predicts a DIFFERENT IMAGE from the one the product
    // renders today, so agreement with `MEASURED_SCREEN_ELONGATION` would mean
    // the composition change had done nothing. This asserts the DISagreement, so
    // nobody later reads the reordered numbers as validated.
    const reordered = candidate(U2_CANDIDATE, { scan: false });
    for (const name of THIN_GENERA) {
      const measured = MEASURED_SCREEN_ELONGATION[name].elongation;
      const model = reordered.elongation[name];
      if (name === "CIRRUS") {
        assert.ok(
          Math.abs(model - measured) > THIN_ELONGATION_TOLERANCE,
          `${name}: the reordered prediction must NOT match the shipped ` +
            `measurement, or the composition change is a no-op`,
        );
      }
    }
    // CUMULUS is the exception and must still match — it is the byte-identity
    // lane, so the reordered model has to keep reproducing the measured run
    // there exactly as the shipped model does.
    assert.ok(
      Math.abs(
        reordered.elongation.CUMULUS -
          MEASURED_SCREEN_ELONGATION.CUMULUS.elongation,
      ) <= THICK_ELONGATION_TOLERANCE,
    );
  });
});

describe("U2 — the RESIDUAL frontier: the STOP lifted, it did not vanish", () => {
  /**
   * Batch 896's frontier ran from (+1.2%, -47.5%) to (+26.1%, +2.9%) with no
   * feasible point. The pair moves the whole curve, but a curve is still what it
   * is: at gate-C-passing elongation the two opacity surfaces still trade, at
   * about 1:1.7. These rows are the new shape.
   */
  const U2_FRONTIER = [
    { compensation: 0.55, probe: 0.029, fixture: -0.126 },
    { compensation: 0.6, probe: 0.044, fixture: -0.102 },
    { compensation: 0.65, probe: 0.058, fixture: -0.079 },
  ];

  for (const row of U2_FRONTIER) {
    it(`erosionCompensation ${row.compensation} lands where the table says`, () => {
      const s = candidate(
        { ...U2_CANDIDATE, erosionCompensation: row.compensation },
        { scan: false },
      );
      assert.ok(s.cirrus >= U2_GATE_C_FLOOR, `gate C ${s.cirrus}`);
      assert.ok(
        Math.abs(s.probeOpacityDelta - row.probe) < R7_OPACITY_PIN,
        `probe ${s.probeOpacityDelta}`,
      );
      assert.ok(
        Math.abs(s.fixtureOpacityDelta - row.fixture) < R7_OPACITY_PIN,
        `fixture ${s.fixtureOpacityDelta}`,
      );
    });
  }

  it("no point is within 3% at BOTH configurations — the residual", () => {
    // Honest about what did NOT close. R7's opacity wording is "a few percent";
    // the candidate is +4.8 / -5.8, which is a few percent on both. A STRICT 3%
    // reading is still not reachable, and saying so here stops the candidate
    // from being sold as tighter than it is.
    for (const row of U2_FRONTIER) {
      const s = candidate(
        { ...U2_CANDIDATE, erosionCompensation: row.compensation },
        { scan: false },
      );
      const both =
        Math.abs(s.probeOpacityDelta) <= R7_OPACITY_BUDGET &&
        Math.abs(s.fixtureOpacityDelta) <= R7_OPACITY_BUDGET;
      assert.equal(
        both,
        false,
        `compensation ${row.compensation} is within 3% at both surfaces — the ` +
          `residual frontier has closed and the docs must be re-read`,
      );
    }
  });
});

describe("U2 — MUTATION: the composition levers must be READ", () => {
  const levers = [
    {
      label: "carveBeforeErosion",
      overrides: { carveBeforeErosion: true },
      reference: {},
    },
    {
      label: "erosionCompensation",
      overrides: { carveBeforeErosion: true, erosionCompensation: 1 },
      reference: { carveBeforeErosion: true },
    },
  ];

  for (const lever of levers) {
    it(`${lever.label} moves the model away from its reference`, () => {
      const moved = displacementFromBaseline(lever.overrides, lever.reference);
      assert.ok(
        discriminates(moved),
        `${lever.label} did not move the model (elongation ${moved.elongation}, ` +
          `half-length ${moved.halfLength}) — the override key is not being read`,
      );
    });
  }

  it("erosionMode moves the MASS and the byte-identity, which is its axis", () => {
    // Scored like `erosionScale` and for the same reason: the remap's effect is
    // on how much density survives the floor, not on the shape of what does.
    // Its elongation displacement is ~0.009, under the shape predicate's floor —
    // which is a true statement about the lever, not a defect in it, so the
    // predicate is chosen to match the claim instead of the claim being bent to
    // match a shared predicate.
    const base = meanColumnOpacity({ cloudType: CloudType.CIRRUS });
    const moved =
      (meanColumnOpacity({
        cloudType: CloudType.CIRRUS,
        erosionMode: "remap",
      }) -
        base) /
      base;
    assert.ok(Math.abs(moved) > 0.03, `erosionMode moved opacity by ${moved}`);
    // And it breaks the default genus's byte-identity, which `carveBeforeErosion`
    // does not — the discriminator between "a composition change that can be
    // genus-gated" and one that cannot.
    assert.notEqual(
      modelled("CUMULUS", { erosionMode: "remap" }).elongation,
      modelled("CUMULUS").elongation,
    );
  });

  it("the predicates go RED on the U2 keys renamed (the meta-mutant)", () => {
    // Same guard-on-the-guard as the R7 group, extended to the three keys U2
    // added to `buildModelParameters`'s unvalidated `overrides.X ?? default`.
    const renamed = {
      carveBeforeErrosion: true,
      erosionCompensationn: 1,
      erosionModes: "remap",
    };
    const moved = displacementFromBaseline(renamed);
    assert.equal(
      discriminates(moved),
      false,
      `renaming the three U2 keys still moved the model (${moved.elongation}) ` +
        `— the lever subtests above are vacuous`,
    );
    assert.equal(losesGroundTruth(renamed), false);
    // And the mass predicate too, or `erosionMode`'s subtest is the unguarded one.
    const base = meanColumnOpacity({ cloudType: CloudType.CIRRUS });
    assert.equal(
      meanColumnOpacity({ cloudType: CloudType.CIRRUS, erosionModes: "remap" }),
      base,
      "a renamed erosionMode still moved the model",
    );
  });
});
