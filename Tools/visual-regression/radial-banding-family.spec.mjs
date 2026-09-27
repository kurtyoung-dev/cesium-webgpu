// radial-banding-family.spec.mjs — the ring-family estimator. Pure Node: no browser, no GPU.
//
// @purpose Drives ringFamily (lib/metrics/radial-banding-family.mjs, re-exported by radial-banding.mjs) over synthetic discs whose families are known by construction and over checked-in reductions of banked orbital frames, asserting the centre, law, period, amplitude, refusal and verdict it returns.
// @status ACTIVE
//
// WHAT IS BEING CERTIFIED. Every synthetic case plants rings whose answer is
// known by construction (a centre, a law, a period, an amplitude) over a
// stated background, or plants something that is not a ring family and says
// so, and asserts what comes back. The banked cases run on the checked-in
// reductions of real orbital frames. No case reads the estimator's source;
// radial-banding-family-mutants.spec.mjs makes one construct at a time
// unreachable and asserts that the case here that guards it then fails. The
// frames themselves are built in lib/radial-banding-family-cases.mjs.
//
// THE GEOMETRY. A 720 px frame, a disc of radius 340 about (360.3, 356.8), a
// window of rho 30 to 230 about the family centre and a centre search of
// 36 px. Planted families sit 33 px from the stated disc centre, as the
// orbital family sits 36 to 40 px from its disc, at the measured orbital ring
// RMS of 0.0435 in luminance unless a case says otherwise.

import assert from "node:assert/strict";
import test from "node:test";

import {
  CENTRE_AT_SEARCH_BOUNDARY,
  RING_AMPLITUDE_CLASSES,
  RING_DETECTION_SNR,
  RING_FAMILY_REFUSALS,
  ringFamily,
  ringFamilyFromProfile,
  ringFamilyProfile,
} from "./lib/metrics/radial-banding.mjs";
import {
  DENSE,
  FAMILY_DISC,
  FAMILY_WINDOW,
  LATTICES,
  M0,
  MEASURED_DECK_VARIANCE,
  PAST_SECOND,
  PLANTED_RMS,
  RADII,
  SECOND_CENTRE,
  discStatistics,
  distance,
  familyField,
  familyResult,
  frame,
  linearPhase,
  measured,
  plantedPeriod,
  rigged,
  withRings,
  withinPercent,
} from "./lib/radial-banding-family-cases.mjs";
import RIG from "./rigs/orbital-fulldisc-6608km.mjs";

/** Every result says where it measured, beside the centre it was told. */
function assertReportsCentre(result, what) {
  assert.ok(
    Number.isFinite(result.centre.x) && Number.isFinite(result.centre.y),
    `${what}: no centre in the result`,
  );
  assert.deepEqual(
    result.centre.stated,
    { x: FAMILY_DISC.centreX, y: FAMILY_DISC.centreY },
    `${what}: the stated centre is not reported`,
  );
  assert.equal(result.centre.source, "refined", `${what}: centre source`);
}

/** A family's period at the window's ends and middle, against a planted law. */
function assertPeriods(family, periodAtRho, what, tolerance = 0.05) {
  for (const [key, rho] of Object.entries(RADII)) {
    const truth = periodAtRho(rho);
    const error = Math.abs(family.periodPx[key] - truth) / truth;
    assert.ok(
      error < tolerance,
      `${what}: period ${family.periodPx[key]} px at rho ${rho.toFixed(1)} against the planted ${truth.toFixed(3)} (${(error * 100).toFixed(2)} %)`,
    );
  }
}

// ===========================================================================
// F. The four regimes, the controls and the refusals
// ===========================================================================

test("F1. in all four regimes the planted family's centre, law, period and amplitude come back", () => {
  for (const regime of ["black", "sparse", "dense", "dense-fbm"]) {
    const field = familyField(regime, "quadratic");
    // The backgrounds are what they claim to be before anything is scored.
    const { duty, variance } = discStatistics(field);
    if (regime === "sparse") {
      assert.ok(Math.abs(duty - 0.11) < 0.02, `sparse duty ${duty}`);
    }
    if (regime === "dense") {
      assert.ok(Math.abs(duty - 0.72) < 0.02, `dense duty ${duty}`);
    }
    if (regime === "dense-fbm") {
      assert.ok(
        Math.abs(variance / MEASURED_DECK_VARIANCE - 1) < 0.1,
        `dense-fbm per-pixel variance ${variance} against ${MEASURED_DECK_VARIANCE}`,
      );
    }
    const result = familyResult(regime, "quadratic");
    assert.ok(
      distance(result.centre) < 1,
      `${regime}: centre (${result.centre.x}, ${result.centre.y}) is ${distance(result.centre).toFixed(3)} px from the planted one`,
    );
    assertReportsCentre(result, regime);
    assert.equal(result.detected, true, `${regime}: no family found`);
    assert.equal(result.familyCount, 1, `${regime}: family count`);
    assert.equal(result.family.law, "quadratic", `${regime}: law`);
    assertPeriods(
      result.family,
      (rho) => plantedPeriod("quadratic", rho),
      regime,
    );
    assert.ok(
      result.family.snr >= 2 * RING_DETECTION_SNR,
      `${regime}: SNR ${result.family.snr} is within a factor of two of the threshold`,
    );
    assert.ok(
      result.family.concentricity.inPhase >=
        result.family.concentricity.required,
      `${regime}: carried in ${result.family.concentricity.inPhase} octants`,
    );
    assert.equal(result.refusal, null, `${regime}: a refusal`);
    assert.equal(result.verdict, "PRESENT", `${regime}: verdict`);
    // The amplitude is a luminance, not a share of the deck's variance: the
    // same planted rings read the same number over a black disc and over a
    // textured deck. The sparse regime's rings ARE its deck, so its amplitude
    // is the bands' own and is not the planted wave's.
    if (regime !== "sparse") {
      assert.ok(
        Math.abs(result.bandPassRms / PLANTED_RMS - 1) < 0.1,
        `${regime}: band-passed RMS ${result.bandPassRms} against the planted ${PLANTED_RMS}`,
      );
    }
  }
});

test("F2. the law is measured, not assumed: linear and logarithmic families on the textured dense deck", () => {
  for (const law of ["linear", "logarithmic"]) {
    const result = familyResult("dense-fbm", law);
    assertReportsCentre(result, law);
    assert.ok(distance(result.centre) < 1, `${law}: centre error`);
    assert.equal(result.family?.law, law, `${law}: law`);
    assertPeriods(result.family, (rho) => plantedPeriod(law, rho), law);
  }
});

test("F3. ring-free controls in all four regimes return no family, and say where they looked", () => {
  for (const regime of ["black", "sparse", "dense", "dense-fbm"]) {
    const result = familyResult(regime, null);
    if (regime !== "black") {
      assertReportsCentre(result, `${regime} control`);
    }
    assert.equal(result.detected, false, `${regime} control: a family`);
    assert.equal(result.familyCount, 0);
    assert.equal(result.family, null);
    assert.equal(result.refusal, null, `${regime} control: a refusal`);
    assert.equal(result.verdict, "ABSENT", `${regime} control: verdict`);
    assert.ok(
      (result.strongestInBandLine?.snr ?? 0) < RING_DETECTION_SNR / 2,
      `${regime} control: in-band SNR ${result.strongestInBandLine?.snr} is within a factor of two of the threshold`,
    );
  }
  assert.equal(familyResult("black", null).bandPassRms, 0);
});

test("F4. a family outside the declared band is refused by name, with its period and centre", () => {
  // A family slower than the band has a shallower radial gradient, so its
  // centre is found less sharply; the refusal still has to say where it is.
  const cases = [
    ["dense", 48, RING_FAMILY_REFUSALS.slowerThanBand, 2],
    ["dense-fbm", 48, RING_FAMILY_REFUSALS.slowerThanBand, 2],
    ["dense", 2, RING_FAMILY_REFUSALS.fasterThanBand, 1],
  ];
  for (const [regime, period, name, centreTolerance] of cases) {
    const what = `${regime} P ${period}`;
    const result = familyResult(
      regime,
      `linear-${period}`,
      linearPhase(period),
    );
    assertReportsCentre(result, what);
    assert.equal(result.verdict, "REFUSED", `${what}: verdict`);
    assert.equal(result.refusal?.name, name, `${what}: refusal name`);
    assert.equal(result.detected, false);
    assert.ok(
      withinPercent(result.refusal.periodAtMidPx, period, 5),
      `${what}: refused period ${result.refusal.periodAtMidPx} against the planted ${period}`,
    );
    assert.equal(result.refusal.law, "linear", `${what}: refused law`);
    assert.ok(
      distance(result.refusal.centre) < centreTolerance,
      `${what}: the refused family's centre is ${distance(result.refusal.centre).toFixed(3)} px off`,
    );
    assert.deepEqual(result.refusal.band, FAMILY_DISC.visiblePeriodBand);
  }
});

test("F4b. the slower band states its reach and refuses nothing past it", () => {
  // Three cycles of the window is the least a period is read from; this
  // geometry's window gives 200 / 3 px.
  const reach = familyResult("dense-fbm", "linear-70", linearPhase(70));
  assert.ok(
    reach.visiblePeriodBand.slowerReachPx < 70,
    `reach ${reach.visiblePeriodBand.slowerReachPx} px`,
  );
  assert.ok(withinPercent(reach.visiblePeriodBand.slowerReachPx, 200 / 3, 1));
  assert.equal(reach.refusal, null, "a family past the reach was refused");
  assert.equal(reach.detected, false);
  assert.notEqual(
    reach.verdict,
    "ABSENT",
    "a family past the reach reads ABSENT",
  );
  // A 90 px family clipped by the textured deck gains a 45 px overtone inside
  // the reach; the overtone is the unreachable family's, not a family.
  const echo = familyResult("dense-fbm", "linear-90", linearPhase(90));
  assert.equal(
    echo.refusal,
    null,
    "an overtone of a family past the reach was refused",
  );
  assert.equal(echo.detected, false);
});

// ===========================================================================
// G. What a planted frame the estimator was not built around returns
// ===========================================================================

test("G1. a family on either edge of the band is reported by one band, with its period", () => {
  for (const period of [3, 40, 41]) {
    const result = familyResult(
      "dense",
      `linear-${period}`,
      linearPhase(period),
    );
    const found = result.family ?? result.refusal;
    assert.ok(found !== null, `P ${period}: neither a family nor a refusal`);
    const reported =
      result.family?.periodPx.atMid ?? result.refusal.periodAtMidPx;
    assert.ok(
      withinPercent(reported, period, 5),
      `P ${period}: reported ${reported}`,
    );
    if (result.family !== null) {
      assert.equal(result.family.law, "linear", `P ${period}: law`);
      assertPeriods(result.family, () => period, `P ${period}`);
    }
  }
  assert.equal(
    familyResult("dense", "linear-40", linearPhase(40)).familyCount,
    1,
  );
});

test("G2. a chirp that leaves the band inside the window keeps its law and its periods", () => {
  // P = 4000 / rho: 133 px at rho 30, 48 px at the middle, 17 px at rho 230,
  // in the band over two thirds of the window.
  const result = measured("chirp-4000");
  assert.equal(result.familyCount, 1);
  assert.equal(result.family.law, "quadratic");
  assert.ok(
    result.family.bandCoverage > 0.6 && result.family.bandCoverage < 0.75,
  );
  assertPeriods(result.family, (rho) => 4000 / rho, "q 4000");
});

test("G3. two families about one centre are both reported", () => {
  const result = measured("same-centre");
  assert.equal(result.familyCount, 2, "family count");
  const laws = Object.fromEntries(
    result.families.map((family) => [family.law, family]),
  );
  assertPeriods(laws.quadratic, (rho) => 1000 / rho, "quadratic");
  assertPeriods(laws.linear, () => 9, "linear");
  for (const family of result.families) {
    assert.ok(distance(family.centre) < 1, `${family.law}: centre`);
  }
});

test("G4. two families about two centres are both reported, each with its own centre", () => {
  const result = measured("two-centres");
  assert.equal(result.familyCount, 2, "family count");
  const laws = Object.fromEntries(
    result.families.map((family) => [family.law, family]),
  );
  assert.ok(distance(laws.quadratic.centre) < 1, "the first centre");
  assert.ok(
    distance(laws.linear.centre, SECOND_CENTRE) < 1,
    "the second centre",
  );
  assertPeriods(laws.linear, () => 9, "linear");
});

test("G5. a refusal is reported beside the visible family, not instead of it", () => {
  for (const [period, name] of [
    [2, RING_FAMILY_REFUSALS.fasterThanBand],
    [50, RING_FAMILY_REFUSALS.slowerThanBand],
  ]) {
    const result = measured(`beside-${period}`);
    assert.equal(
      result.family?.law,
      "quadratic",
      `P ${period}: the visible family`,
    );
    assertPeriods(result.family, (rho) => 1000 / rho, `P ${period}`);
    assert.equal(result.refusal?.name, name, `P ${period}: refusal`);
    assert.ok(withinPercent(result.refusal.periodAtMidPx, period, 5));
    assert.equal(result.verdict, "PRESENT", `P ${period}: verdict`);
  }
});

test("G6. a low-duty family is not hidden by its own harmonics", () => {
  for (const period of [25, 36]) {
    const result = measured(`duty-${period}`);
    assert.equal(result.family?.law, "linear", `P ${period}: no family`);
    assertPeriods(result.family, () => period, `P ${period}`);
  }
});

test("G7. stripes, a checkerboard and a vignette are not ring families and refuse nothing", () => {
  for (const name of [
    "stripes",
    "checkerboard",
    "deck checkerboard",
    "vignette",
  ]) {
    const result = measured(name);
    assert.equal(result.detected, false, `${name}: a family`);
    assert.equal(result.refusal, null, `${name}: a refusal`);
    assert.notEqual(result.verdict, "REFUSED", `${name}: verdict`);
  }
});

test("G8. a family below the ABSENT class is not called a family, however clean it is", () => {
  const result = measured("faint");
  // With no noise at all the line clears the SNR threshold many times over;
  // only its amplitude stops it.
  assert.ok(result.strongestInBandLine.snr > 10 * RING_DETECTION_SNR);
  assert.ok(result.strongestInBandLine.lineRms < RING_AMPLITUDE_CLASSES.absent);
  assert.equal(result.detected, false);
  assert.equal(result.verdict, "ABSENT");
});

/**
 * A reduction of a synthetic frame about the centre `ringFamily` found, with
 * only the octant frame, as the checked-in banked reductions carry it.
 */
function octantOnly(key) {
  const { centre } = measured(key);
  const profile = ringFamilyProfile(
    frame(key),
    { x: centre.x, y: centre.y },
    FAMILY_DISC,
    FAMILY_WINDOW,
  );
  for (const array of [
    "sectorSums",
    "sectorCounts",
    "fineSectorSums",
    "fineSectorCounts",
  ]) {
    assert.ok(Array.isArray(profile[array]), `the reduction lacks ${array}`);
    delete profile[array];
  }
  return profile;
}

test("G9. rings on one side of their centre are not a concentric family", () => {
  const result = measured("sector");
  assert.ok(
    result.strongestInBandLine.lineRms >= RING_AMPLITUDE_CLASSES.absent,
  );
  assert.ok(
    result.strongestInBandLine.concentricOctants < 6,
    `carried in ${result.strongestInBandLine.concentricOctants} octants`,
  );
  assert.equal(result.detected, false);
  // A reduction that carries only the octant frame is judged by it alone.
  const octants = ringFamilyFromProfile(
    octantOnly("sector"),
    FAMILY_DISC,
    FAMILY_WINDOW,
  );
  assert.equal(octants.strongestInBandLine.concentricSectors, null);
  assert.equal(octants.detected, false, "octant frame alone");
});

test("G17. axis-aligned plaids, a hexagonal lattice and a strong checkerboard are not ring families and refuse nothing", () => {
  for (const name of LATTICES) {
    const result = measured(name);
    assert.equal(result.familyCount, 0, `${name}: a family`);
    assert.equal(result.refusal, null, `${name}: a refusal`);
    assert.ok(
      !["PRESENT", "REFUSED"].includes(result.verdict),
      `${name}: verdict ${result.verdict}`,
    );
    // Each lattice's line clears the SNR threshold and the amplitude floor and
    // is carried in phase in every octant, so only the sixteen-sector frame
    // declines it: in too few sectors, or against its phase in some.
    const line =
      name === "checkerboard 0.3"
        ? result.neighbours.faster
        : result.strongestInBandLine;
    assert.ok(line.snr >= RING_DETECTION_SNR, `${name}: SNR ${line.snr}`);
    assert.ok(line.lineRms >= RING_AMPLITUDE_CLASSES.absent, `${name}`);
    assert.equal(line.concentricOctants, 8, `${name}: octants`);
    assert.ok(
      line.concentricSectors < 12 || line.opposedSectors > 0,
      `${name}: ${line.concentricSectors} sectors in phase, ${line.opposedSectors} against`,
    );
  }
});

test("G18. a second family whose centre the further search pins to its edge is named and withheld, never reported", () => {
  const result = measured("past-second");
  assert.equal(result.familyCount, 1, "the pinned family was reported");
  assert.equal(result.family.law, "quadratic");
  assert.equal(result.family.boundary, null);
  assert.equal(result.further.boundary, CENTRE_AT_SEARCH_BOUNDARY);
  assert.equal(result.further.familyCount, 0);
  assert.equal(result.further.verdict, "INCONCLUSIVE");
  // What was measured there is kept, named, beside the result.
  const [withheld] = result.further.withheld;
  assert.equal(withheld?.boundary, CENTRE_AT_SEARCH_BOUNDARY);
  assert.equal(withheld.law, "linear");
  assert.ok(distance(withheld.centre, PAST_SECOND) > 2);
  // The same search about a centre inside it reports what it finds.
  const inside = measured("two-centres");
  assert.equal(inside.further.boundary, null);
  assert.equal(inside.further.familyCount, 1);
  assert.equal(inside.families[1].boundary, null);
});

test("G10. a centre stopped at the edge of its search is named, and never reads ABSENT", () => {
  const result = measured("outside");
  assert.equal(result.centre.boundary, CENTRE_AT_SEARCH_BOUNDARY);
  assert.notEqual(result.verdict, "ABSENT");
});

test("G11. a visible line that is the alias of a finer family is not a visible family", () => {
  const result = measured("alias");
  const fold = result.inBandLines.find((line) =>
    withinPercent(line.periodAtMidPx, 3.5, 2),
  );
  assert.ok(fold !== undefined, "the fold into the band was not measured");
  assert.equal(fold.aliasOfFaster, true);
  assert.equal(result.familyCount, 0, "the alias was reported as a family");
  assert.equal(result.refusal?.name, RING_FAMILY_REFUSALS.fasterThanBand);
  assert.ok(withinPercent(result.refusal.periodAtMidPx, 1.4, 5));
});

test("G12. a family finer than the fastest reach is not refused at the edge of the search", () => {
  const result = measured("past-fastest");
  assert.equal(
    result.refusal,
    null,
    "refused at a period the search cannot resolve",
  );
  assert.equal(result.familyCount, 0, "its alias was reported as a family");
});

// ---------------------------------------------------------------------------
// The banked dense-deck frames
// ---------------------------------------------------------------------------

test("F5. every banked frame in the calibration table classifies as the ring legs registered it", () => {
  // The rig's declared disc block IS the camera the fixture was scored with.
  assert.deepEqual(DENSE.camera, {
    centreX: RIG.disc.centreX,
    centreY: RIG.disc.centreY,
    discRadiusPixels: RIG.disc.discRadiusPixels,
    visiblePeriodBand: RIG.disc.visiblePeriodBand,
  });
  assert.deepEqual(
    DENSE.frames.map((frame) => frame.id),
    ["M0", "M1", "R0", "R6", "R3", "raw-q32", "raw-q128"],
  );
  for (const frame of DENSE.frames) {
    const result = ringFamilyFromProfile(
      frame.profile,
      RIG.disc,
      DENSE.options,
    );
    assert.equal(
      result.verdict,
      frame.preRegistered.verdict,
      `${frame.id} verdict`,
    );
    if (frame.preRegistered.bandPassRms !== null) {
      assert.ok(
        Math.abs(result.bandPassRms - frame.preRegistered.bandPassRms) <= 5e-4,
        `${frame.id}: ${result.bandPassRms} against the registered ${frame.preRegistered.bandPassRms}`,
      );
    }
    assert.ok(
      Math.abs(result.bandPassRms / frame.measured.bandPassRms - 1) < 1e-6,
      `${frame.id}: the reduction no longer reproduces the full-pixel figure`,
    );
    // The reduction carries no quarter-pixel arrays, so the faster neighbour
    // is unmeasured here rather than measured and empty.
    assert.equal(result.neighbours.faster, null);
    if (result.verdict === "PRESENT") {
      assert.equal(result.familyCount, 1, `${frame.id} families`);
      assert.equal(result.family.law, "quadratic", `${frame.id} law`);
      assert.ok(result.family.snr >= 2 * RING_DETECTION_SNR);
    } else {
      assert.equal(result.detected, false, `${frame.id}: a family`);
      assert.ok(result.strongestInBandLine.snr < RING_DETECTION_SNR / 2);
      assert.ok(result.bandPassRms <= RING_AMPLITUDE_CLASSES.absent);
    }
  }
  // M0 carries its octant reduction, so its concentricity is measured here.
  const m0 = ringFamilyFromProfile(M0.profile, RIG.disc, DENSE.options);
  assert.equal(m0.family.concentricity.inPhase, 8);
});

test("F6. the banked family's centre and period law agree with measurements made by other means", () => {
  const result = ringFamilyFromProfile(M0.profile, RIG.disc, DENSE.options);
  // Fringe normals, Hough coherence and ring-energy maxima put the family at
  // (1058, 1031) to (1061, 1033); the reduction's centre must sit among them.
  assert.ok(
    Math.hypot(M0.profile.centreX - 1058, M0.profile.centreY - 1031) < 4,
    `the fixture was reduced about (${M0.profile.centreX}, ${M0.profile.centreY})`,
  );
  // An independent wedge periodogram about (1058.5, 1030.8) measured 13.18 px
  // at rho 180 and 7.32 px at rho 300. The law this reduction recovers has to
  // reproduce both from its own exponent and period.
  const { lawExponent, periodPx } = result.family;
  const mid = Math.sqrt(DENSE.options.rhoMinPx * DENSE.options.rhoMaxPx);
  for (const [rho, wedge] of [
    [180, 13.18],
    [300, 7.32],
  ]) {
    const period = periodPx.atMid * (rho / mid) ** (1 - lawExponent);
    assert.ok(
      withinPercent(period, wedge, 5),
      `at rho ${rho} the recovered law gives ${period.toFixed(3)} px against ${wedge}`,
    );
  }
});

test("F7. about the stated disc centre the same banked frame loses its family", () => {
  const stated = ringFamilyFromProfile(
    DENSE.statedCentre.profile,
    RIG.disc,
    DENSE.options,
  );
  const found = ringFamilyFromProfile(M0.profile, RIG.disc, DENSE.options);
  assert.deepEqual(
    { x: stated.centre.x, y: stated.centre.y, source: stated.centre.source },
    { x: RIG.disc.centreX, y: RIG.disc.centreY, source: "profile" },
  );
  assert.equal(stated.detected, false);
  assert.equal(stated.verdict, "ABSENT");
  assert.ok(stated.strongestInBandLine.snr < RING_DETECTION_SNR);
  assert.ok(
    found.bandPassRms > 4 * stated.bandPassRms,
    `only ${(found.bandPassRms / stated.bandPassRms).toFixed(2)}x between the family's centre and the disc's`,
  );
});

test("F9. ringFamily takes the rig's disc block as its camera and refuses what it cannot measure", () => {
  assert.equal(
    ringFamilyFromProfile(M0.profile, RIG.disc, DENSE.options).bandPassRms,
    ringFamilyFromProfile(M0.profile, DENSE.camera, DENSE.options).bandPassRms,
  );
  // The declared centre keeps the declared disc inside the frame.
  const { centreX, centreY, discRadiusPixels } = RIG.disc;
  assert.ok(
    Math.min(
      centreX,
      centreY,
      RIG.viewport.width - centreX,
      RIG.viewport.height - centreY,
    ) >= discRadiusPixels,
  );
  const field = familyField("black", null);
  const { visiblePeriodBand, ...noBand } = FAMILY_DISC;
  assert.ok(visiblePeriodBand.maxPx > visiblePeriodBand.minPx);
  assert.throws(
    () => ringFamily(field, noBand, FAMILY_WINDOW),
    /visiblePeriodBand/,
  );
  assert.throws(
    () =>
      ringFamily(
        field,
        { ...FAMILY_DISC, visiblePeriodBand: { minPx: 2, maxPx: 41 } },
        FAMILY_WINDOW,
      ),
    /cannot resolve/,
  );
  assert.throws(
    () => ringFamily(field, FAMILY_DISC, { ...FAMILY_WINDOW, rhoMaxPx: 100 }),
    /fewer than two cycles/,
  );
  assert.throws(
    () =>
      ringFamily(
        field,
        { ...FAMILY_DISC, discRadiusPixels: 250 },
        FAMILY_WINDOW,
      ),
    /past discRadiusPixels/,
  );
});

test("G14. on the rig's window a slower family is refused at its own period, and one past the reach is not refused at a search edge", () => {
  const slow = rigged("slow-90");
  assert.equal(slow.refusal?.name, RING_FAMILY_REFUSALS.slowerThanBand);
  assert.ok(
    withinPercent(slow.refusal.periodAtMidPx, 90, 2),
    `refused at ${slow.refusal.periodAtMidPx}`,
  );
  // 150 px completes 2.3 cycles of the slower window, past its reach; the
  // visible band's series sees only the edge of its search range.
  const past = rigged("past-reach-150");
  assert.ok(past.visiblePeriodBand.slowerReachPx < 150);
  assert.equal(past.refusal, null, "refused at the edge of a search");
  assert.notEqual(past.verdict, "ABSENT");
});

test("G16. on the rig's window a chirp four times the detrend wide at its inner edge keeps its law", () => {
  // The law is fitted over the radii the detrend passes, so the flattened
  // inner stretch does not tilt it.
  const result = rigged("chirp-6800");
  assert.equal(result.family?.law, "quadratic");
  const { rhoMinPx, rhoMaxPx } = DENSE.options;
  for (const [key, rho] of [
    ["atRhoMin", rhoMinPx],
    ["atMid", Math.sqrt(rhoMinPx * rhoMaxPx)],
    ["atRhoMax", rhoMaxPx],
  ]) {
    assert.ok(
      withinPercent(result.family.periodPx[key], 6800 / rho, 2),
      `${key}: ${result.family.periodPx[key]} against ${6800 / rho}`,
    );
  }
});

test("G15. a low-duty family past the reach is not refused through its overtones", () => {
  // 130 px at duty 0.2: its second and third harmonics, 65 and 43 px, lie
  // inside the slower band's reach.
  const result = rigged("pulse-130");
  assert.equal(
    result.refusal,
    null,
    `refused at ${result.refusal?.periodAtMidPx}`,
  );
  assert.equal(result.detected, false);
});

test("G13. on the banked M0 frame a second family is found and a neighbour's family refused, beside M0's own", () => {
  const own = ringFamilyFromProfile(M0.profile, RIG.disc, DENSE.options).family;
  const slower = ringFamilyFromProfile(
    withRings(M0.profile, 70, 0.06),
    RIG.disc,
    DENSE.options,
  );
  assert.equal(slower.refusal?.name, RING_FAMILY_REFUSALS.slowerThanBand);
  assert.ok(withinPercent(slower.refusal.periodAtMidPx, 70, 5));
  assert.equal(slower.family?.law, "quadratic");
  assert.ok(withinPercent(slower.family.periodPx.atMid, own.periodPx.atMid, 2));
  assert.equal(slower.verdict, "PRESENT");
  // A weaker neighbour is refused too, from the neighbour's series with M0's
  // fitted rings removed; M0's residue biases its period by up to a tenth.
  const weak = ringFamilyFromProfile(
    withRings(M0.profile, 70, 0.03),
    RIG.disc,
    DENSE.options,
  );
  assert.equal(weak.refusal?.name, RING_FAMILY_REFUSALS.slowerThanBand);
  assert.ok(withinPercent(weak.refusal.periodAtMidPx, 70, 15));
  const second = ringFamilyFromProfile(
    withRings(M0.profile, 9, PLANTED_RMS),
    RIG.disc,
    DENSE.options,
  );
  assert.equal(second.familyCount, 2, "M0 plus a 9 px family about its centre");
  const laws = Object.fromEntries(
    second.families.map((family) => [family.law, family]),
  );
  assert.ok(
    withinPercent(laws.quadratic.periodPx.atMid, own.periodPx.atMid, 2),
  );
  assert.ok(withinPercent(laws.linear.periodPx.atMid, 9, 2));
});
