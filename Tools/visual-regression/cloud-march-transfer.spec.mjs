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
import { describe, it } from "node:test";

import {
  CLOUD_COVERAGE_ANCHOR,
  CLOUD_COVERAGE_EXPONENT,
  CLOUD_DENSITY_WORLD_TO_NOISE,
  cloudEffectiveCoverage as shippedCloudEffectiveCoverage,
} from "../../packages/engine/Source/Renderer/WebGPU/WebGPUCloudDensityDomain.ts";
import { fibreElongation } from "./lib/cloud-genus-morphology-model.mjs";
import {
  ABSORPTION_COEFF,
  COVERAGE_ANCHOR,
  COVERAGE_EXPONENT,
  CloudType,
  CloudTypeProfile,
  MEASURED_SCREEN_ELONGATION,
  PROBE_ESTIMATOR,
  PROBE_GEOMETRY,
  PROBE_MARCH,
  WORLD_TO_NOISE,
  buildModelParameters,
  cloudEffectiveCoverage,
  columnOpticalDepth,
  genusMarchParameters,
  invertTransfer,
  metersPerPixel,
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
 * @returns {{elongation:number,halfLength:number}} Worst move over ALL_GENERA.
 */
function displacementFromBaseline(overrides) {
  let elongation = 0;
  let halfLength = 0;
  for (const name of ALL_GENERA) {
    const mutant = modelled(name, overrides);
    const base = modelled(name);
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
