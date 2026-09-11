// @purpose Pins the C13-42 characterization contract: the released controlled-ray obligation, the calibration-not-acceptance disposition, and the per-subject served-response budget.
// @status ACTIVE

import assert from "node:assert/strict";
import test from "node:test";

import {
  C13_42_GODRAY_FIXTURE,
  UNIFORM_SKY_CONTROL,
  traceF32Ray,
} from "./lib/c13-42-godray-fixture.mjs";
import {
  C13_42_OBSERVED_SERVED_OVERFLOW,
  C13_42_SERVED_RESPONSE_BUDGET,
  CHARACTERIZATION_THRESHOLDS,
  CHARACTERIZATION_THRESHOLD_DERIVATION,
  CONTROLLED_RAY_FIXTURE_OBLIGATION,
  CONTROLLED_RAY_PROVIDER_OBLIGATION,
  assessC13_42ServedResponseBudget,
  assessControlledRayFixture,
  buildC13_42Schedule,
  characterizationDisposition,
  computeC13_42CellMetrics,
  deriveCharacterizationThresholds,
  deriveServedResponseBudget,
  foldReceipt,
  initialCoreSubjects,
  servedResponseBudgetFor,
  servedResponseBudgetMs,
  validateReceipt,
} from "./lib/c13-42-reproduction-contract.mjs";

const SAMPLE_COUNTS = [16, 32, 64, 128];

/**
 * The banked table is f64 ("direct JavaScript arithmetic", per the source
 * notes) and `traceF32Ray` accumulates in f32, so the two agree to within f32
 * accumulation roundoff and not exactly.
 *
 * Derived, not fitted: each tap costs one rounding for the decay chain step,
 * one for the weight product, and one for the running sum, and the final
 * exposure product costs one more. Standard Wilkinson accumulation gives a
 * relative bound of gamma(k) = k*u / (1 - k*u) for k roundings at unit roundoff
 * u = 2^-24; k = 2N + 2 bounds the chain above. No measurement enters this
 * number, so it cannot be tuned to whatever the implementation happens to do.
 */
const F32_UNIT_ROUNDOFF = 2 ** -24;
function f32AccumulationTolerance(sampleCount, magnitude) {
  const roundings = 2 * sampleCount + 2;
  return (
    ((roundings * F32_UNIT_ROUNDOFF) / (1 - roundings * F32_UNIT_ROUNDOFF)) *
    magnitude
  );
}

function uniformSkyMultiplier(sampleCount) {
  const trace = traceF32Ray(100, 100, {
    emitterHull: UNIFORM_SKY_CONTROL.emitterHull,
    occluderHull: UNIFORM_SKY_CONTROL.occluderHull,
    exposure: UNIFORM_SKY_CONTROL.exposure,
    sampleCount,
  });
  assert.equal(trace.status, "analytic", `N=${sampleCount} was not analytic`);
  return trace.diagnostics.main / UNIFORM_SKY_CONTROL.C;
}

// ---------------------------------------------------------------------------
// The fixture release (maintainer ruling M6 part 2)
// ---------------------------------------------------------------------------

test("the uniform-sky control reproduces the banked additive multipliers", () => {
  for (const sampleCount of SAMPLE_COUNTS) {
    const measured = uniformSkyMultiplier(sampleCount);
    const banked = UNIFORM_SKY_CONTROL.bankedAdditiveMultipliers[sampleCount];
    assert.ok(
      typeof banked === "number",
      `no banked multiplier for N=${sampleCount}`,
    );
    const tolerance = f32AccumulationTolerance(sampleCount, banked);
    assert.ok(
      Math.abs(measured - banked) <= tolerance,
      `N=${sampleCount}: fixture gives ${measured}, source notes banked ${banked}, difference ${Math.abs(measured - banked)} exceeds the derived f32 bound ${tolerance}. These four numbers are the DEFECT, not a target — report a REFUTED premise rather than editing them.`,
    );
  }
});

test("the derived tolerance is far smaller than the effect it must not hide", () => {
  // A tolerance wide enough to swallow the count-dependence would make the
  // assertion above pass on an implementation that had already been repaired.
  for (let index = 1; index < SAMPLE_COUNTS.length; index += 1) {
    const previous = SAMPLE_COUNTS[index - 1];
    const current = SAMPLE_COUNTS[index];
    const step = Math.abs(
      UNIFORM_SKY_CONTROL.bankedAdditiveMultipliers[current] -
        UNIFORM_SKY_CONTROL.bankedAdditiveMultipliers[previous],
    );
    const tolerance = f32AccumulationTolerance(
      current,
      UNIFORM_SKY_CONTROL.bankedAdditiveMultipliers[current],
    );
    assert.ok(
      tolerance * 100 < step,
      `N=${previous}->${current}: tolerance ${tolerance} is not two orders below the ${step} step it must leave visible`,
    );
  }
});

test("sample count is a brightness control — the defect C13-45 must move", () => {
  // The observable statement of the defect, asserted against behaviour rather
  // than against any shader's shape: raising N raises brightness.
  const measured = SAMPLE_COUNTS.map((n) => uniformSkyMultiplier(n));
  for (let index = 1; index < measured.length; index += 1) {
    assert.ok(
      measured[index] > measured[index - 1],
      `N=${SAMPLE_COUNTS[index]} did not exceed N=${SAMPLE_COUNTS[index - 1]}`,
    );
  }
  assert.ok(
    measured.at(-1) / measured[0] > 1.5,
    `128 samples are only ${measured.at(-1) / measured[0]}x brighter than 16; the characterised defect is not present`,
  );
});

test("traceF32Ray takes the sample count as an input and defaults unchanged", () => {
  assert.equal(
    traceF32Ray(100, 100, { emitterHull: UNIFORM_SKY_CONTROL.emitterHull }).taps
      .length,
    C13_42_GODRAY_FIXTURE.config.sampleCount,
  );
  for (const sampleCount of SAMPLE_COUNTS) {
    assert.equal(
      traceF32Ray(100, 100, {
        emitterHull: UNIFORM_SKY_CONTROL.emitterHull,
        sampleCount,
      }).taps.length,
      sampleCount,
    );
  }
  assert.throws(
    () =>
      traceF32Ray(100, 100, {
        emitterHull: UNIFORM_SKY_CONTROL.emitterHull,
        sampleCount: 0,
      }),
    RangeError,
  );
});

test("the controlled-ray geometry obligation is released and stays derived", () => {
  assert.equal(CONTROLLED_RAY_FIXTURE_OBLIGATION.status, "FROZEN");
  assert.deepEqual(CONTROLLED_RAY_FIXTURE_OBLIGATION.unfrozen, []);
  assert.deepEqual(CONTROLLED_RAY_FIXTURE_OBLIGATION.frozen, [
    "emitter",
    "projectedShaftDirection",
    "occluder",
    "camera",
    "imageMasks",
    "sampleCount",
  ]);
});

test("NEGATIVE CONTROL: an unfrozen member returns the obligation to STRUCTURAL", () => {
  // Not a deletion — the assessment is made to look at a fixture whose emitter
  // is mutable, which is the exact condition the original reason asserted.
  const thawed = {
    ...C13_42_GODRAY_FIXTURE,
    emitter: { ...C13_42_GODRAY_FIXTURE.emitter },
  };
  const verdict = assessControlledRayFixture(thawed);
  assert.equal(verdict.status, "STRUCTURAL");
  assert.deepEqual(verdict.unfrozen, ["emitter"]);
});

test("NEGATIVE CONTROL: a march that ignores its sample count is not a controlled ray", () => {
  // A fixture can be perfectly frozen and still be useless to C13-45 if the
  // amplitude does not respond to N. The release must not survive that.
  const countBlind = (x, y, options = {}) =>
    traceF32Ray(x, y, { ...options, sampleCount: 64 });
  const verdict = assessControlledRayFixture(C13_42_GODRAY_FIXTURE, countBlind);
  assert.equal(verdict.status, "STRUCTURAL");
  assert.deepEqual(verdict.unfrozen, ["sampleCount"]);
});

test("provider, scene and browser integration remain a named STRUCTURAL obligation", () => {
  // Releasing the geometry must not release the half that is genuinely absent.
  assert.equal(CONTROLLED_RAY_PROVIDER_OBLIGATION.status, "STRUCTURAL");
  assert.equal(C13_42_GODRAY_FIXTURE.providerIntegration.implemented, false);
});

// ---------------------------------------------------------------------------
// Calibration, not acceptance (maintainer ruling M6 part 3)
// ---------------------------------------------------------------------------

test("a null-threshold apparatus reports calibration, not acceptance", () => {
  assert.equal(CHARACTERIZATION_THRESHOLDS, null);
  assert.equal(characterizationDisposition(), "calibration");
  assert.equal(buildC13_42Schedule().disposition, "calibration");
  assert.equal(
    characterizationDisposition({ godRaySupportFraction: 0.1 }),
    "acceptance",
  );
});

test("thresholds are never derived from a calibration too thin to derive from", () => {
  for (const thin of [[], [{ cells: [] }], [{ cells: [] }, { cells: [] }]]) {
    const outcome = deriveCharacterizationThresholds(thin);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.thresholds, null);
  }
});

// ---------------------------------------------------------------------------
// The POSITIVE derivation path.
//
// There was no test here, and that is why the first key table shipped naming
// four receipt paths — `metrics.support.fraction`, `metrics.radial.contrast`,
// `metrics.delta.fraction`, `metrics.repeatOff.meanAbsoluteDelta` — that no
// produced receipt has ever carried. Every test exercised a REFUSAL, and a
// derivation that can never derive refuses exactly like one that is merely
// short of runs.
//
// The receipts below get their `metrics` from the real producer,
// `computeC13_42CellMetrics`, called with the same input shape the probe builds.
// A hand-written metrics literal would assert my notion of the receipt shape —
// the same mistake in a new place. Because the producer is in the loop, a
// renamed producer field turns these tests red instead of quietly unmooring the
// freeze again.
// ---------------------------------------------------------------------------

const CALIBRATION_IMAGE_WIDTH = 8;
const CALIBRATION_IMAGE_HEIGHT = 8;

function calibrationImage(seed) {
  const data = new Uint8ClampedArray(
    CALIBRATION_IMAGE_WIDTH * CALIBRATION_IMAGE_HEIGHT * 4,
  );
  for (let offset = 0; offset < data.length; offset += 4) {
    data[offset] = (seed * 37 + offset) % 256;
    data[offset + 1] = (seed * 11 + offset * 3) % 256;
    data[offset + 2] = (seed * 53 + offset * 7) % 256;
    data[offset + 3] = 255;
  }
  return {
    width: CALIBRATION_IMAGE_WIDTH,
    height: CALIBRATION_IMAGE_HEIGHT,
    channels: 4,
    data,
  };
}

/** A cell whose metrics come from the producer, exactly as the probe calls it. */
function calibrationCell(subject, run) {
  const off = calibrationImage(1 + run);
  const on = calibrationImage(40 + run);
  const repeatOff = calibrationImage(70 + run);
  const repeatOn = calibrationImage(90 + run);
  return {
    id: subject.id,
    leg: subject.leg,
    metrics: computeC13_42CellMetrics({
      kind: subject.id === "R-god-rays" ? "godRay" : "cloud",
      offImage: off,
      onImage: on,
      repeatOffImage: repeatOff,
      repeatOnImage: repeatOn,
      frames: [off.data, on.data, repeatOff.data],
    }),
  };
}

function calibrationReceipt(run) {
  return {
    cells: initialCoreSubjects().map((subject) =>
      calibrationCell(subject, run),
    ),
  };
}

test("the threshold derivation derives from the receipt the apparatus actually produces", () => {
  const outcome = deriveCharacterizationThresholds(
    [0, 1, 2].map(calibrationReceipt),
  );
  assert.equal(
    outcome.ok,
    true,
    `the derivation refused a real-shaped calibration: ${outcome.reason}`,
  );
  for (const entry of CHARACTERIZATION_THRESHOLD_DERIVATION.keys) {
    assert.ok(
      Number.isFinite(outcome.thresholds[entry.key]),
      `${entry.key} did not derive to a finite number (got ${outcome.thresholds[entry.key]})`,
    );
  }
  assert.equal(
    outcome.derivation.length,
    CHARACTERIZATION_THRESHOLD_DERIVATION.keys.length,
  );
  for (const record of outcome.derivation) {
    assert.ok(
      record.sampleCount >=
        CHARACTERIZATION_THRESHOLD_DERIVATION.minimumCalibrationRuns,
      `${record.key} derived from only ${record.sampleCount} samples`,
    );
  }
});

test("one key spans both cell shapes, because the same quantity lives at two paths", () => {
  // `repeatOffDrift` is published under `metrics.toggle.*` on the god-ray cell
  // and under `metrics.cloud.repeat.*` on every other cell. A single-path key
  // would silently characterize only one of the two shapes.
  const receipts = [0, 1, 2].map(calibrationReceipt);
  const outcome = deriveCharacterizationThresholds(receipts);
  const record = outcome.derivation.find(
    (entry) => entry.key === "repeatOffDrift",
  );
  assert.ok(record, "repeatOffDrift did not derive at all");
  assert.equal(
    record.sampleCount,
    receipts.length * initialCoreSubjects().length,
  );
});

test("NEGATIVE CONTROL: the derivation refuses when a metric is not where the producer puts it", () => {
  // The exact defect being repaired, pinned so it cannot come back: move the
  // god-ray metrics to the paths the first key table imagined, and the
  // derivation must refuse BY NAME rather than derive from a coincidence.
  const moved = [0, 1, 2].map((run) => ({
    cells: calibrationReceipt(run).cells.map((cell) =>
      cell.id === "R-god-rays"
        ? {
            ...cell,
            metrics: { support: { fraction: 0.5 }, radial: { contrast: 2 } },
          }
        : cell,
    ),
  }));
  const outcome = deriveCharacterizationThresholds(moved);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.thresholds, null);
  assert.match(outcome.reason, /godRayToggleChangedFraction/u);
  assert.match(outcome.reason, /godRayToggleMeanAbsRgbDelta/u);
});

test("a degenerate calibration is floored at the metric's own quantum, never at zero margin", () => {
  // Three runs that agree exactly do not show that the true variation is zero,
  // only that it is below what three samples resolve. Widening by the observed
  // spread alone would freeze a bar the observed value only exactly meets, and
  // the next run fails it on the first flicker in either direction.
  const identical = [0, 0, 0].map(calibrationReceipt);
  const outcome = deriveCharacterizationThresholds(identical);
  assert.equal(outcome.ok, true, outcome.reason ?? "");
  for (const record of outcome.derivation) {
    assert.equal(record.spread, 0, `${record.key} was not degenerate`);
    assert.equal(record.degenerate, true);
    assert.equal(
      record.margin,
      CHARACTERIZATION_THRESHOLD_DERIVATION.marginFloor,
    );
    if (record.bound === "lower") {
      assert.ok(
        record.threshold < record.lowest,
        `${record.key} froze a lower bound the observed minimum only exactly meets`,
      );
    } else {
      assert.ok(
        record.threshold > record.highest,
        `${record.key} froze an upper bound the observed maximum only exactly meets`,
      );
    }
  }
});

test("the margin floor is the metric's own quantisation step, not a chosen epsilon", () => {
  // Ties the constant to its source: every field the keys read is published
  // through `imageDeltaMetrics`, which rounds with `toFixed(6)`. If the producer
  // ever publishes at a finer resolution, this floor is no longer the smallest
  // expressible difference and this test says so.
  const floor = CHARACTERIZATION_THRESHOLD_DERIVATION.marginFloor;
  const subjects = initialCoreSubjects();
  const godRays = calibrationCell(
    subjects.find((subject) => subject.id === "R-god-rays"),
    0,
  );
  const cloud = calibrationCell(
    subjects.find((subject) => subject.leg === "offline"),
    0,
  );
  const published = [
    godRays.metrics.toggle.offOn.changedFraction,
    godRays.metrics.toggle.offOn.meanAbsRgbDelta,
    godRays.metrics.toggle.repeatOff.meanAbsRgbDelta,
    cloud.metrics.cloud.offOn.changedFraction,
    cloud.metrics.cloud.repeat.residual.meanAbsRgbDelta,
  ];
  for (const value of published) {
    assert.ok(Number.isFinite(value), `a published metric was ${value}`);
    const steps = value / floor;
    assert.ok(
      Math.abs(steps - Math.round(steps)) < 1e-3,
      `${value} is not an integer multiple of the claimed quantum ${floor}`,
    );
  }
});

test("no receipt folds to a certification PASS while the disposition is calibration", () => {
  // BOUNDED CLAIM, stated so a reader does not over-read it. A receipt complete
  // enough to reach foldReceipt's disposition branch needs identity,
  // environment, per-cell rawControls, pre/post state, metrics and a PNG digest
  // that no capture has ever produced — fabricating one here would certify the
  // fabrication, not the apparatus. What IS provable without a capture is the
  // invariant: while thresholds are null, nothing folds to PASS.
  assert.equal(characterizationDisposition(), "calibration");
  const receipts = [
    {
      controlledRay: { ...CONTROLLED_RAY_FIXTURE_OBLIGATION },
      thresholds: null,
      cells: [],
    },
    {
      controlledRay: { ...CONTROLLED_RAY_FIXTURE_OBLIGATION },
      thresholds: null,
      cells: initialCoreSubjects().map((subject) => ({
        id: subject.id,
        status: "PASS",
      })),
    },
  ];
  for (const receipt of receipts) {
    assert.notEqual(foldReceipt(receipt).status, "PASS");
  }
});

test("validateReceipt tracks the contract's disposition instead of pinning STRUCTURAL", () => {
  // The pin is what made a PASS unreachable: validateReceipt demanded
  // STRUCTURAL while foldReceipt refused to publish because it was STRUCTURAL.
  const stale = validateReceipt({
    contractVersion: "c13-42-reproduction-contract/1",
    thresholds: null,
    controlledRay: {
      id: "controlled-ray-geometry",
      status: "STRUCTURAL",
      reason: "stale",
    },
    cells: [],
  });
  assert.ok(
    stale.reasons.some((reason) =>
      reason.includes("controlled-ray geometry must be carried"),
    ),
    `a receipt carrying the superseded STRUCTURAL disposition was accepted: ${stale.reasons.join("; ")}`,
  );
  const current = validateReceipt({
    contractVersion: "c13-42-reproduction-contract/1",
    thresholds: null,
    controlledRay: { ...CONTROLLED_RAY_FIXTURE_OBLIGATION },
    cells: [],
  });
  assert.ok(
    !current.reasons.some((reason) =>
      reason.includes("controlled-ray geometry must be carried"),
    ),
    `a receipt carrying the current disposition was rejected: ${current.reasons.join("; ")}`,
  );
});

// ---------------------------------------------------------------------------
// The provider obligation's enforcement point (maintainer ruling R-2026-09-11-3)
// ---------------------------------------------------------------------------

const RECEIPT_SHA256 = "a".repeat(64);

/**
 * A receipt complete enough to clear `validateReceipt` and reach the gates
 * beyond it.
 *
 * WHAT THIS IS AND IS NOT. It is not a capture and it certifies no PASS — the
 * assertions below are all REFUSALS, and a synthetic receipt cannot manufacture
 * a refusal the code does not produce. The distinction matters because the
 * disposition test above deliberately declines to fabricate a receipt: there
 * the claim would have been "this folds to PASS", which a fabrication could
 * only certify about itself. Here the claim is "this is refused, and refused
 * for THIS reason", which is a property of the gate.
 */
function completeReceipt() {
  let elementId = 0;
  return {
    contractVersion: "c13-42-reproduction-contract/1",
    thresholds: null,
    identity: {
      source: { sha256: RECEIPT_SHA256 },
      build: { sha256: RECEIPT_SHA256 },
      served: { sha256: RECEIPT_SHA256 },
      fixtureHash: RECEIPT_SHA256,
      metricHash: RECEIPT_SHA256,
    },
    environment: {
      browser: "edge",
      adapter: "synthetic-adapter",
      canvas: { width: 1280, height: 720 },
      dpr: 1,
    },
    controlledRay: { ...CONTROLLED_RAY_FIXTURE_OBLIGATION },
    cells: initialCoreSubjects().map((subject) => {
      elementId++;
      return {
        id: subject.id,
        pageId: subject.pageId,
        fixtureId: subject.fixtureId,
        stationId: subject.stationId,
        leg: subject.leg,
        bracket: [...subject.bracket],
        status: "PASS",
        rawControls: [
          {
            name: `toggle-${subject.id}`,
            selector: `#toggle-${subject.id}`,
            property: "checked",
            event: "change",
            value: true,
            dataBind: "checked: enabled",
            elementId,
          },
        ],
        preState: { restored: true },
        postState: { restored: true },
        metrics: { ok: true },
        pngSha256: RECEIPT_SHA256,
      };
    }),
  };
}

test("a certification PASS is refused while the provider integration is unimplemented", () => {
  // Splitting the controlled-ray obligation in two released the geometry
  // honestly and removed the provider half's only enforcement point. Nothing
  // was released the day it landed, because the calibration disposition refuses
  // everything anyway — which is exactly why this needs its OWN assertion: a
  // test that only checked "no PASS" would stay green with the provider gate
  // deleted.
  assert.equal(C13_42_GODRAY_FIXTURE.providerIntegration.implemented, false);
  assert.equal(CONTROLLED_RAY_PROVIDER_OBLIGATION.status, "STRUCTURAL");

  const receipt = completeReceipt();
  // The premise: everything BEFORE the provider gate is satisfied, so the
  // refusal below is attributable to the gate and not to an incomplete receipt.
  assert.equal(
    validateReceipt(receipt).status,
    "PASS",
    `the receipt did not reach the provider gate: ${validateReceipt(receipt).reasons.join("; ")}`,
  );

  const verdict = foldReceipt(receipt);
  assert.notEqual(verdict.status, "PASS");
  assert.ok(
    verdict.reasons.some((reason) =>
      reason.includes("provider integration remains an unmet required"),
    ),
    `the refusal did not name the provider obligation: ${verdict.reasons.join("; ")}`,
  );
  // Attribution, not just refusal: with the provider gate inert this receipt is
  // still refused, by the disposition branch, so a test that stopped at
  // "not PASS" would survive the gate's removal.
  assert.ok(
    !verdict.reasons.some((reason) =>
      reason.includes("calibration, not acceptance"),
    ),
    "the disposition branch answered first; the provider gate was not reached",
  );
});

test("threshold agreement is compared by value, so a frozen threshold survives JSON", () => {
  // Identity comparison reads correctly only while the thresholds are null. A
  // receipt is JSON; the day M6's freeze lands, a round-tripped copy would never
  // be `===` the module's object and every receipt would fail validation.
  const roundTripped = JSON.parse(JSON.stringify({ thresholds: null }));
  const verdict = validateReceipt({
    contractVersion: "c13-42-reproduction-contract/1",
    thresholds: roundTripped.thresholds,
    controlledRay: { ...CONTROLLED_RAY_FIXTURE_OBLIGATION },
    cells: [],
  });
  assert.ok(
    !verdict.reasons.some((reason) => reason.includes("thresholds must match")),
    verdict.reasons.join("; "),
  );
});

// ---------------------------------------------------------------------------
// The scoped response budget (maintainer ruling M6 part 1)
// ---------------------------------------------------------------------------

test("the response budget is derived from the observed overflow, not chosen", () => {
  const ceiling = Math.max(
    ...C13_42_OBSERVED_SERVED_OVERFLOW.map(
      (entry) => entry.retained + entry.overflow,
    ),
  );
  assert.equal(ceiling, 173);
  assert.equal(deriveServedResponseBudget(), 231);
  assert.equal(C13_42_SERVED_RESPONSE_BUDGET.reported, 231);
});

test("NEGATIVE CONTROL: the derivation moves when its evidence moves", () => {
  // A "derivation" that returns the same number whatever it is given is a
  // constant wearing a function's clothes.
  const withoutWorstRun = C13_42_OBSERVED_SERVED_OVERFLOW.filter(
    (entry) => entry.overflow !== 125,
  );
  assert.ok(
    deriveServedResponseBudget(withoutWorstRun) <
      deriveServedResponseBudget(C13_42_OBSERVED_SERVED_OVERFLOW),
    "dropping the worst observed overflow did not lower the derived budget",
  );
});

test("both legs carry the derived bound, because a reported-only raise still refuses", () => {
  // Maintainer ruling R-2026-09-11-2. The behaviour that forced it: the
  // refusal is zero-tolerance and `validateReceipt` requires ALL SEVEN core
  // subjects, so leaving the offline leg at the baseline means the worst
  // ATTRIBUTABLE overflow (`O-above-deck`, 58, on three separate runs) still
  // refuses its cell and no complete receipt is producible at all.
  const subjects = initialCoreSubjects();
  const reported = subjects.filter((subject) => subject.leg === "reported");
  const offline = subjects.filter((subject) => subject.leg === "offline");
  assert.ok(reported.length > 0 && offline.length > 0);
  for (const subject of [...reported, ...offline]) {
    assert.equal(
      servedResponseBudgetFor(subject),
      deriveServedResponseBudget(),
      `${subject.id} is not on the derived bound`,
    );
  }
  // The worst attributable offline observation must now fit inside the bound —
  // this is the whole point of the ruling, so it is asserted, not assumed.
  const worstOffline = Math.max(
    ...C13_42_OBSERVED_SERVED_OVERFLOW.filter(
      (entry) => entry.leg === "offline",
    ).map((entry) => entry.retained + entry.overflow),
  );
  assert.ok(
    worstOffline <= servedResponseBudgetFor(offline[0]),
    `the worst offline observation ${worstOffline} still exceeds the offline bound`,
  );
});

test("the work budget charges each subject its OWN bound, not the largest across every cell", () => {
  // Multiplying the largest bound across every cell is how raising a cap
  // silently disarms the deadline that was supposed to bound the run. The
  // mechanism is per-subject; whether the per-subject sum is BELOW the global
  // form depends on the data, and at today's values it is not — both named legs
  // carry the derived bound, so the two coincide. That is stated here rather
  // than hidden behind a comparison that would quietly stop meaning anything.
  const subjects = initialCoreSubjects();
  const perResponseMs = 30_000;
  const expected = subjects.reduce(
    (total, subject) =>
      total + servedResponseBudgetFor(subject) * perResponseMs,
    0,
  );
  assert.equal(servedResponseBudgetMs(perResponseMs, subjects), expected);
  assert.equal(
    servedResponseBudgetMs(perResponseMs, subjects),
    subjects.length * C13_42_SERVED_RESPONSE_BUDGET.reported * perResponseMs,
    "both legs are on the derived bound, so the per-subject sum should equal the global form",
  );
  // The per-subject mechanism is still load-bearing: a subject that is not on a
  // raised leg is charged the baseline, so the sum is strictly below the global
  // form the moment the legs differ again.
  const mixed = [
    ...subjects,
    { ...subjects[0], id: "X-unraised", leg: "baseline" },
  ];
  assert.equal(
    servedResponseBudgetFor(mixed.at(-1)),
    C13_42_SERVED_RESPONSE_BUDGET.baseline,
  );
  assert.ok(
    servedResponseBudgetMs(perResponseMs, mixed) <
      mixed.length * C13_42_SERVED_RESPONSE_BUDGET.reported * perResponseMs,
    "an unraised subject was charged the raised bound",
  );
});

test("any overflow still refuses, and the refusal names the subject's bound", () => {
  const godRays = initialCoreSubjects().find(
    (subject) => subject.id === "R-god-rays",
  );
  assert.ok(godRays, "R-god-rays is not in the core subject list");
  const clean = assessC13_42ServedResponseBudget({
    subject: godRays,
    retained: 200,
    overflow: 0,
  });
  assert.equal(clean.ok, true);
  assert.equal(clean.budget, 231);
  const over = assessC13_42ServedResponseBudget({
    subject: godRays,
    retained: 231,
    overflow: 1,
  });
  assert.equal(over.ok, false);
  assert.match(over.reason, /231-response budget for R-god-rays/u);
});

test("R-god-rays is the only four-phase subject, which is why the bound scales", () => {
  const subjects = initialCoreSubjects();
  const fourPhase = subjects.filter((subject) => subject.bracket.length === 4);
  assert.deepEqual(
    fourPhase.map((subject) => subject.id),
    ["R-god-rays"],
  );
});
