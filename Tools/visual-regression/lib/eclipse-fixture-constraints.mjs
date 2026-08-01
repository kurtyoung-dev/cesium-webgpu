// Fixture selection for the eclipse sky probe — the CONSTRAINT SET, in one
// pure place.
//
// ★ THE RULE, earned at Batch 766: A FIXTURE SELECTOR MUST BE CONSTRAINED BY
// EVERY REQUIREMENT ITS LANES IMPOSE, NOT JUST THE HEADLINE ONE.
//
// `probe-eclipse-sky-totality` picked ONE vantage by MAXIMUM OBSCURATION and
// then demanded three instants at it — deepest, clear, and night. Those are
// jointly unsatisfiable for the vantage that rule picks: the sweep visits all
// nine Iceland vantages before any Spain vantage and the comparison is
// strictly-greater, so the first vantage to reach obscuration 1.0 wins and
// nothing later can displace it — but at 62-66N in mid-August the sun never
// gets below about -12.7 deg, so NO Iceland vantage has a dark-enough night,
// while every Spain vantage does and four of them also reach 1.0. Selecting on
// the headline constraint alone silently stranded the other lanes, and the
// failure surfaced as a bare `no astronomical-night instant at this vantage`
// an Edge cycle later.
//
// So: the predicates live here, they are evaluated PER CANDIDATE, the winner is
// chosen among candidates that satisfy ALL of them, and every rejection is
// reported with the constraint that eliminated it. If nothing satisfies
// everything, the structural error names which constraint killed the field.
//
// This module is pure data validation over a table the in-page derivation
// returns — the same shape as `eclipse-ladder-rungs.mjs`, and for the same
// reason: a predicate behind the `page.evaluate` boundary cannot be unit
// tested, so it only fails in front of an executor.
//
// ── HOW MUCH OF THE UNBLOCKING THIS ARCHITECTURE ACTUALLY DID: honestly, ──
// ── none of it. Say so rather than let the shape imply otherwise.        ──
//
// On the real 18-vantage 2026-08-12 grid the full rejection tally is
// `{ totalEclipse: 3 }`. Five of the six predicates — `sunHighAtEclipse`,
// `nightReachable`, `deepestInstant`, `clearInstant`, `nightInstant` — reject
// NOTHING on this field. What actually unblocked the probe was the -8 deg
// relaxation of the night threshold (see `FIXTURE_NIGHT_MAX_SUN_ELEV_DEG`);
// against the old -18 deg rule `nightReachable` would have rejected all nine
// Iceland vantages, which is the only reason it looks load-bearing.
//
// The architecture is kept anyway, and the reason is not that it is currently
// filtering: it is that the FAILURE REPORT is only meaningful if every
// requirement is represented as a predicate. The old selector's diagnostic was
// `no astronomical-night instant at this vantage` — a symptom, from a rule
// that existed only in prose. This one names the constraint, its tally, and
// its rationale. A constraint that rejects nothing today still earns its place
// by being the thing that will name itself the day the grid, the date or a
// lane's needs change. `eclipse-sky-totality.spec.mjs` therefore drives EVERY
// predicate's rejection path on synthetic fields, so they have demonstrated
// teeth rather than assumed ones.
//
// @module eclipse-fixture-constraints

/**
 * Deepest obscuration a candidate must reach. Lanes B and C need a genuinely
 * total eclipse: lane B's reveal is anchored on the S2 totality factor, and
 * lane C's 360-degree twilight is gated by the angular-radius classifier, which
 * only opens for a total geometry.
 */
export const FIXTURE_MIN_OBSCURATION = 0.98;

/**
 * Minimum solar elevation at the eclipse instants, degrees. Below this the
 * lit-ground band and the sky band stop being separable at a ground camera.
 */
export const FIXTURE_MIN_SUN_ELEV_DEG = 8.0;

/**
 * Maximum solar elevation for the NIGHT instant, degrees — the constraint that
 * was missing from the selector.
 *
 * DERIVED, not picked: lanes D and B4 need the star field at FULL strength, and
 * `StarFieldMath.computeStarDayFade` reaches exactly 1 once `sin(elevation) <=
 * -0.1`, i.e. at elevation <= -5.7392 deg. `computeSkyBrightness`'s sun term
 * saturates to 0 at the same edge, so the modulation factor is 1 there too.
 * -8 deg is that edge plus margin (`sin(-8 deg) = -0.139`), and it is the
 * HONEST requirement: the earlier -18 deg (astronomical night) was far stricter
 * than anything the lanes actually need, and it is what made the Iceland
 * showcase vantages unsatisfiable in mid-August.
 */
export const FIXTURE_NIGHT_MAX_SUN_ELEV_DEG = -8.0;

/**
 * How many surviving candidates the in-page derivation may refine to
 * instant-level resolution. Bounds the work; the survivors are refined in
 * descending obscuration order, so the winner is always among them.
 */
export const FIXTURE_MAX_REFINED = 6;

/**
 * The constraint list, in evaluation order. Each entry is `{ id, describe,
 * test }`; `test` receives one candidate row and returns true when satisfied.
 *
 * A candidate row is what the in-page derivation returns per vantage:
 * `{ name, lat, lon, maxObscuration, maxSunElevationDeg, minNightSunElevationDeg,
 *    deepest?, clear?, night? }`
 * where the three instant fields are present only for refined candidates.
 */
export const FIXTURE_CONSTRAINTS = [
  {
    id: "totalEclipse",
    describe: `maxObscuration >= ${FIXTURE_MIN_OBSCURATION}`,
    test: (c) => (c?.maxObscuration ?? 0) >= FIXTURE_MIN_OBSCURATION,
  },
  {
    id: "sunHighAtEclipse",
    describe: `sun elevation at the deepest instant > ${FIXTURE_MIN_SUN_ELEV_DEG} deg`,
    test: (c) => (c?.maxSunElevationDeg ?? -90) > FIXTURE_MIN_SUN_ELEV_DEG,
  },
  {
    id: "nightReachable",
    describe: `sun reaches <= ${FIXTURE_NIGHT_MAX_SUN_ELEV_DEG} deg within 24 h (lanes D + B4 need dayFade === 1)`,
    test: (c) =>
      (c?.minNightSunElevationDeg ?? 90) <= FIXTURE_NIGHT_MAX_SUN_ELEV_DEG,
  },
];

/**
 * Constraints that can only be checked once a candidate has been refined to
 * instants. Kept separate so the cheap pass can shrink the field first.
 */
export const FIXTURE_INSTANT_CONSTRAINTS = [
  {
    id: "deepestInstant",
    describe: "a deepest instant was located above the elevation floor",
    test: (c) => (c?.deepest?.obscuration ?? 0) >= FIXTURE_MIN_OBSCURATION,
  },
  {
    id: "clearInstant",
    describe: "a zero-obscuration instant exists with the sun still up",
    test: (c) =>
      c?.clear != null &&
      c.clear.obscuration === 0 &&
      c.clear.sunElevationDeg > FIXTURE_MIN_SUN_ELEV_DEG,
  },
  {
    id: "nightInstant",
    describe: `a night instant exists at <= ${FIXTURE_NIGHT_MAX_SUN_ELEV_DEG} deg`,
    test: (c) =>
      c?.night != null &&
      c.night.sunElevationDeg <= FIXTURE_NIGHT_MAX_SUN_ELEV_DEG,
  },
];

/**
 * Evaluate every constraint against one candidate.
 *
 * @param {object} candidate
 * @param {Array} [constraints] Defaults to the cheap set.
 * @returns {{ok: boolean, failed: string[]}}
 */
export function evaluateVantage(candidate, constraints = FIXTURE_CONSTRAINTS) {
  const failed = [];
  for (const c of constraints) {
    let ok;
    try {
      ok = c.test(candidate) === true;
    } catch {
      ok = false;
    }
    if (!ok) {
      failed.push(c.id);
    }
  }
  return { ok: failed.length === 0, failed };
}

/**
 * Which candidates survive the cheap constraints, in the order the in-page
 * derivation should refine them (deepest first, bounded).
 *
 * @param {object[]} candidates
 * @returns {{survivors: object[], rejections: Array<{name: string, lat: number, lon: number, failed: string[]}>}}
 */
export function shortlistVantages(candidates) {
  const survivors = [];
  const rejections = [];
  for (const c of candidates ?? []) {
    const { ok, failed } = evaluateVantage(c);
    if (ok) {
      survivors.push(c);
    } else {
      rejections.push({ name: c?.name, lat: c?.lat, lon: c?.lon, failed });
    }
  }
  survivors.sort((a, b) => (b.maxObscuration ?? 0) - (a.maxObscuration ?? 0));
  return { survivors: survivors.slice(0, FIXTURE_MAX_REFINED), rejections };
}

/**
 * Choose the fixture from refined candidates, or explain why nothing qualifies.
 *
 * The returned `structuralError` names the constraint that eliminated the whole
 * field, which is the difference between "no astronomical-night instant at this
 * vantage" and "every candidate failed `nightReachable`; the Iceland arm cannot
 * satisfy it in August".
 *
 * @param {object[]} refined Candidates carrying `deepest`/`clear`/`night`.
 * @param {Array<object>} [cheapRejections] Rejections from {@link shortlistVantages}.
 * @returns {{chosen: object|null, rejections: Array, structuralError: string|null, constraintTable: Array}}
 */
export function selectEclipseFixture(refined, cheapRejections = []) {
  const rejections = [...cheapRejections];
  const constraintTable = [];
  let chosen = null;

  const all = [...FIXTURE_CONSTRAINTS, ...FIXTURE_INSTANT_CONSTRAINTS];
  for (const c of refined ?? []) {
    const { ok, failed } = evaluateVantage(c, all);
    constraintTable.push({
      name: c?.name,
      lat: c?.lat,
      lon: c?.lon,
      maxObscuration: c?.maxObscuration,
      minNightSunElevationDeg: c?.minNightSunElevationDeg,
      ok,
      failed,
    });
    if (
      ok &&
      (chosen === null ||
        (c.maxObscuration ?? 0) > (chosen.maxObscuration ?? 0))
    ) {
      chosen = c;
    }
    if (!ok) {
      rejections.push({ name: c?.name, lat: c?.lat, lon: c?.lon, failed });
    }
  }

  let structuralError = null;
  if (chosen === null) {
    // Name the constraint that eliminated the field, rather than the symptom.
    const tally = new Map();
    for (const r of rejections) {
      for (const id of r.failed ?? []) {
        tally.set(id, (tally.get(id) ?? 0) + 1);
      }
    }
    const ranked = [...tally.entries()].sort((a, b) => b[1] - a[1]);
    const worst = ranked.length > 0 ? ranked[0] : null;
    const describe = (id) => all.find((c) => c.id === id)?.describe ?? id;
    structuralError =
      rejections.length === 0
        ? "no vantage candidates were produced at all"
        : `no vantage satisfies every lane constraint; ` +
          `dominant failure: ${worst ? `${worst[0]} (${worst[1]} of ${rejections.length} candidates) — ${describe(worst[0])}` : "unknown"}; ` +
          `full tally: ${ranked.map(([id, n]) => `${id}x${n}`).join(", ")}`;
  }

  return { chosen, rejections, structuralError, constraintTable };
}

export default {
  FIXTURE_MIN_OBSCURATION,
  FIXTURE_MIN_SUN_ELEV_DEG,
  FIXTURE_NIGHT_MAX_SUN_ELEV_DEG,
  FIXTURE_MAX_REFINED,
  FIXTURE_CONSTRAINTS,
  FIXTURE_INSTANT_CONSTRAINTS,
  evaluateVantage,
  shortlistVantages,
  selectEclipseFixture,
};
