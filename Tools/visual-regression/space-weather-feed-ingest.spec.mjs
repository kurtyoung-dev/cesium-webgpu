// space-weather-feed-ingest.spec.mjs — the auroral-precipitation and
// planetary-index ingest, its normalizers, and the source-authority contract.
// Pure Node: no browser, no GPU, no network.
// @purpose Output contract for space-weather ingest: frozen-fixture normalization, schema-mutation refusal, measured forecast lead, antimeridian rotation, pole policy, Kp/kp case trap, staleness handoff, abort/reissue, non-double-count, and zero cost on the render read.
// @status ACTIVE
//
// WHAT THIS SPEC IS FOR. The queue row's exit gate is a list of behaviours that
// must be REFUSED, MEASURED or UNAFFECTED, so every assertion below reads a
// value that came out of the real modules against the real captured bytes: a
// sample at a named grid cell, a rejection code, a counter, a packet field. None
// of them greps the source, and none asserts the shape of the implementation.
//
// THE CLAIMS, and why each is phrased the way it is:
//
//   1. THE FROZEN FIXTURE is the capture served on 2026-09-19, pinned by SHA-256
//      in its sidecar README. Its numbers are asserted exactly — times, lead,
//      counts, maximum, bounds — because every one of them is a place a silent
//      re-interpretation of the wire format would move.
//   2. THE FORECAST LEAD is asserted to equal the difference of the payload's
//      own two instants, and to be a value (3,720 s) that no constant named
//      after the product would produce. A second, synthetic payload with a
//      different lead must yield that different lead.
//   3. THE ANTIMERIDIAN claim is asserted as cell provenance, not as a boundary
//      condition: four named columns must carry the samples of four named wire
//      longitudes. A grid read without the rotation fails three of the four.
//   4. THE POLE claim is asserted against a capture whose 360 south-pole
//      duplicates DISAGREE — six distinct values, measured. Each policy is
//      pinned to the exact number it produces, and `require-agreement` must
//      refuse this capture, which is the evidence that the choice is real.
//   5. NON-DOUBLE-COUNT is asserted as an identity: the samples in the published
//      packet equal the integers in the payload, and both multiplier functions
//      return the literal 1, under an activity scalar deliberately set to
//      something that would be visible if it were applied.
//   6. THE RENDER READ is asserted by counting seams: a thousand reads with
//      fetch, the timer family, the animation frame and both clocks replaced by
//      counting spies, after which every counter and every ingest statistic must
//      be unchanged and the returned packet must be the same object.
//
// RUNNER REQUIREMENT: Node >= 22.18 (built-in TypeScript stripping).
//   node --test Tools/visual-regression/space-weather-feed-ingest.spec.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { enableEngineTsResolution } from "./lib/engine-ts-resolver.mjs";

enableEngineTsResolution();

const {
  OVATION_LATITUDE_COUNT,
  OVATION_LONGITUDE_COUNT,
  OVATION_SAMPLE_COUNT,
  OvationPolePolicy,
  OvationRejectionCode,
  normalizeOvationPayload,
  ovationColumnForLongitude,
  ovationSourceIndex,
} =
  await import("../../packages/engine/Source/Scene/SpaceWeather/OvationGridNormalizer.ts");
const {
  PLANETARY_KP_FIELD,
  PlanetaryKpProduct,
  PlanetaryKpRejectionCode,
  isPlanetaryKpCurrent,
  normalizePlanetaryKpPayload,
  parseSpaceWeatherTimeTag,
  planetaryKpActivity,
  planetaryKpReadingAt,
} =
  await import("../../packages/engine/Source/Scene/SpaceWeather/PlanetaryKpNormalizer.ts");
const {
  OVATION_VALIDITY_CEILING_SECONDS,
  OVATION_VALIDITY_FLOOR_SECONDS,
  PLANETARY_KP_CADENCE_SECONDS,
  SPACE_WEATHER_CLOCK_SKEW_TOLERANCE_SECONDS,
  SpaceWeatherOvalOwner,
  SpaceWeatherOwnershipReason,
  ovalAuthorityFor,
  ovalForcingMultiplier,
  ovationFreshness,
  ovationValiditySeconds,
  resolveOvalOwnership,
  spaceWeatherForecastLeadSeconds,
  spaceWeatherObservationIsPlausible,
} =
  await import("../../packages/engine/Source/Scene/SpaceWeather/SpaceWeatherSourceAuthority.ts");
const { SpaceWeatherFeedIngest, SpaceWeatherIngestCode } =
  await import("../../packages/engine/Source/Scene/SpaceWeather/SpaceWeatherFeedIngest.ts");
const { auroraOvalIntensityScale, validateSpaceWeatherPacket } =
  await import("../../packages/engine/Source/Scene/SpaceWeather/SpaceWeatherPacket.ts");

// ---------------------------------------------------------------------------
// The frozen captures.
// ---------------------------------------------------------------------------

const DATA_DIR = fileURLToPath(
  new URL("../../Specs/Data/SpaceWeather/", import.meta.url),
);

function readFixture(name) {
  return JSON.parse(readFileSync(`${DATA_DIR}${name}`, "utf8"));
}

const OVATION_FIXTURE = readFixture("ovation_aurora_latest.json");
const KP_OBSERVED_FIXTURE = readFixture("noaa-planetary-k-index.json");
const KP_FORECAST_FIXTURE = readFixture("noaa-planetary-k-index-forecast.json");

/** Instants the capture declares, as milliseconds. */
const OBSERVED_MS = Date.parse("2026-09-19T12:40:00Z");
const FORECAST_MS = Date.parse("2026-09-19T13:42:00Z");
/** The measured lead: 62 minutes, which is neither of the durations the product is named after. */
const MEASURED_LEAD_SECONDS = 3720;

/** Sample of one wire cell, straight out of the payload. */
function wireSample(payload, longitudeDegrees, latitudeDegrees) {
  return payload.coordinates[
    ovationSourceIndex(longitudeDegrees, latitudeDegrees)
  ][2];
}

/** Sample of one normalized cell. */
function gridSample(field, row, column) {
  return field.intensity[row * field.gridWidth + column];
}

/**
 * A complete, deterministic wire grid, emitted in the payload's own
 * longitude-major order.
 */
function syntheticOvationPayload(options) {
  const sample = options.sample;
  const coordinates = [];
  for (let longitude = 0; longitude < OVATION_LONGITUDE_COUNT; ++longitude) {
    for (let latitude = -90; latitude <= 90; ++latitude) {
      coordinates.push([longitude, latitude, sample(longitude, latitude)]);
    }
  }
  return {
    "Observation Time": options.observationTime ?? "2026-09-19T12:40:00Z",
    "Forecast Time": options.forecastTime ?? "2026-09-19T13:42:00Z",
    "Data Format": "[Longitude, Latitude, Aurora]",
    coordinates: coordinates,
    type: "MultiPoint",
  };
}

// ---------------------------------------------------------------------------
// 1. The frozen fixture.
// ---------------------------------------------------------------------------

test("the captured snapshot normalizes to its declared grid, times and range", () => {
  const result = normalizeOvationPayload(OVATION_FIXTURE);
  assert.equal(result.status, "ok");
  const snapshot = result.snapshot;

  assert.equal(snapshot.observedTimeMs, OBSERVED_MS);
  assert.equal(snapshot.forecastTimeMs, FORECAST_MS);
  assert.equal(snapshot.leadSeconds, MEASURED_LEAD_SECONDS);

  const field = snapshot.field;
  assert.equal(field.gridWidth, OVATION_LONGITUDE_COUNT);
  assert.equal(field.gridHeight, OVATION_LATITUDE_COUNT);
  assert.equal(field.intensity.length, OVATION_SAMPLE_COUNT);
  assert.equal(field.intensity.length, 65160);
  assert.equal(field.authority, "ovation");
  assert.equal(field.frame, "geographic");
  assert.equal(field.hemisphere, "both");

  // The unit is not published, so the samples are carried raw and the ceiling
  // declared is the one this snapshot contained — not an assumed percentage.
  assert.equal(field.intensityScale, "raw");
  assert.equal(snapshot.observedMaximum, 16);
  assert.equal(field.rawMaximum, 16);
  assert.equal(snapshot.nonZeroSampleCount, 15897);

  assert.equal(field.bounds.west, -Math.PI);
  assert.equal(field.bounds.north, Math.PI / 2);
  assert.equal(field.bounds.south, -Math.PI / 2);
  assert.equal((field.bounds.east * 180) / Math.PI, 179);

  // Every sample survives the packet schema, including the raw integers and the
  // declared ceiling.
  assert.equal(
    validateSpaceWeatherPacket({
      version: 1,
      provenance: {
        sourceId: "fixture",
        kind: "forecast",
        validitySeconds: 3720,
      },
      observedTimeMs: snapshot.observedTimeMs,
      forecastTimeMs: snapshot.forecastTimeMs,
      geomagnetic: { activity: 0.5, authority: "kp" },
      oval: field,
    }).valid,
    true,
  );
});

test("the captured planetary-index products normalize to their declared series", () => {
  const observed = normalizePlanetaryKpPayload(
    KP_OBSERVED_FIXTURE,
    PlanetaryKpProduct.OBSERVED,
  );
  assert.equal(observed.status, "ok");
  assert.equal(observed.series.readings.length, 60);
  assert.equal(
    observed.series.newest.timeTagMs,
    Date.parse("2026-09-19T09:00:00Z"),
  );
  assert.equal(observed.series.newest.kpIndex, 1.33);
  assert.equal(observed.series.newest.observationState, undefined);

  const forecast = normalizePlanetaryKpPayload(
    KP_FORECAST_FIXTURE,
    PlanetaryKpProduct.FORECAST,
  );
  assert.equal(forecast.status, "ok");
  assert.equal(forecast.series.readings.length, 81);
  assert.equal(forecast.series.newest.kpIndex, 1.67);
  // The forecast product states, per row, whether it is measured or projected.
  assert.equal(forecast.series.newest.observationState, "predicted");
  assert.equal(forecast.series.readings[0].observationState, "observed");
});

// ---------------------------------------------------------------------------
// 2. The forecast lead is measured.
// ---------------------------------------------------------------------------

test("the forecast lead is read from the payload and is not a constant", () => {
  const snapshot = normalizeOvationPayload(OVATION_FIXTURE).snapshot;

  // 62 minutes. A constant taken from the product's name would be 30; the
  // previously measured lead for the same product was 94.
  assert.equal(snapshot.leadSeconds, 3720);
  assert.notEqual(snapshot.leadSeconds, 30 * 60);
  assert.notEqual(snapshot.leadSeconds, 94 * 60);
  assert.equal(
    snapshot.leadSeconds,
    (snapshot.forecastTimeMs - snapshot.observedTimeMs) / 1000,
  );
  assert.equal(ovationValiditySeconds(snapshot), 3720);

  // A different payload yields a different lead, so nothing has memorized one.
  const longer = normalizeOvationPayload(
    syntheticOvationPayload({
      observationTime: "2026-09-19T00:00:00Z",
      forecastTime: "2026-09-19T01:34:00Z",
      sample: () => 0,
    }),
  ).snapshot;
  assert.equal(longer.leadSeconds, 94 * 60);
  assert.equal(ovationValiditySeconds(longer), 5640);

  // The documented zero-lead fallback is a legitimate snapshot and must not be
  // born expired, so the floor — and only then — applies.
  const zeroLead = normalizeOvationPayload(
    syntheticOvationPayload({
      observationTime: "2026-09-19T00:00:00Z",
      forecastTime: "2026-09-19T00:00:00Z",
      sample: () => 0,
    }),
  ).snapshot;
  assert.equal(zeroLead.leadSeconds, 0);
  assert.equal(
    ovationValiditySeconds(zeroLead),
    OVATION_VALIDITY_FLOOR_SECONDS,
  );
  assert.equal(OVATION_VALIDITY_FLOOR_SECONDS, 1800);
});

test("a packet reports the lead its producer stamped", () => {
  assert.equal(
    spaceWeatherForecastLeadSeconds({
      observedTimeMs: OBSERVED_MS,
      forecastTimeMs: FORECAST_MS,
    }),
    MEASURED_LEAD_SECONDS,
  );
  assert.equal(
    spaceWeatherForecastLeadSeconds({
      observedTimeMs: 5000,
      forecastTimeMs: 5000,
    }),
    0,
  );
});

// ---------------------------------------------------------------------------
// 3. The antimeridian.
// ---------------------------------------------------------------------------

test("the grid begins at the antimeridian, so the wire array is rotated by half its width", () => {
  const field = normalizeOvationPayload(OVATION_FIXTURE).snapshot.field;

  // The column map, asserted directly at the four positions that matter.
  assert.equal(ovationColumnForLongitude(180), 0);
  assert.equal(ovationColumnForLongitude(359), 179);
  assert.equal(ovationColumnForLongitude(0), 180);
  assert.equal(ovationColumnForLongitude(179), 359);

  // Cell provenance at a latitude the capture has structure at. Without the
  // rotation, columns 0 and 359 carry the prime-meridian samples instead.
  const latitude = -65;
  const row = 90 - latitude;
  assert.equal(
    gridSample(field, row, 0),
    wireSample(OVATION_FIXTURE, 180, latitude),
  );
  assert.equal(
    gridSample(field, row, 179),
    wireSample(OVATION_FIXTURE, 359, latitude),
  );
  assert.equal(
    gridSample(field, row, 180),
    wireSample(OVATION_FIXTURE, 0, latitude),
  );
  assert.equal(
    gridSample(field, row, 359),
    wireSample(OVATION_FIXTURE, 179, latitude),
  );

  // Those four are not all the same value in this capture, so the assertions
  // above can actually fail.
  assert.equal(gridSample(field, row, 0), 6);
  assert.equal(gridSample(field, row, 179), 0);

  // The wire array's own 359-to-0 boundary is an ordinary interior neighbour
  // pair one degree apart, not a seam.
  assert.equal(
    ovationColumnForLongitude(0) - ovationColumnForLongitude(359),
    1,
  );

  // The bounds run west to east with no straddle: the grid starts at the
  // antimeridian rather than wrapping across it.
  assert.ok(field.bounds.west < field.bounds.east);
  assert.equal(field.bounds.west, -Math.PI);
});

test("a grid whose only structure sits at the prime meridian lands mid-array", () => {
  // A synthetic payload that is non-zero at exactly one wire longitude proves
  // the placement without depending on the capture's content.
  const field = normalizeOvationPayload(
    syntheticOvationPayload({ sample: (lon) => (lon === 0 ? 7 : 0) }),
  ).snapshot.field;

  assert.equal(gridSample(field, 45, 180), 7);
  assert.equal(gridSample(field, 45, 0), 0);
  assert.equal(gridSample(field, 45, 179), 0);
  assert.equal(gridSample(field, 45, 181), 0);
});

// ---------------------------------------------------------------------------
// 4. The poles.
// ---------------------------------------------------------------------------

test("the captured south pole's 360 duplicates disagree, and each policy resolves them to a stated number", () => {
  const south = [];
  const north = [];
  for (let longitude = 0; longitude < OVATION_LONGITUDE_COUNT; ++longitude) {
    south.push(wireSample(OVATION_FIXTURE, longitude, -90));
    north.push(wireSample(OVATION_FIXTURE, longitude, 90));
  }
  // The premise, measured rather than assumed: the live product disagrees with
  // itself at the south pole.
  assert.equal(new Set(south).size, 6);
  assert.equal(new Set(north).size, 1);
  assert.equal(
    south.reduce((a, b) => a + b, 0),
    1418,
  );

  const byPolicy = (policy) =>
    normalizeOvationPayload(OVATION_FIXTURE, { polePolicy: policy });

  const mean = byPolicy(OvationPolePolicy.MEAN).snapshot;
  assert.equal(mean.southPoleAgreed, false);
  assert.equal(mean.northPoleAgreed, true);
  assert.equal(mean.polePolicy, "mean");
  assert.equal(gridSample(mean.field, 180, 0), Math.fround(1418 / 360));

  assert.equal(
    gridSample(byPolicy(OvationPolePolicy.MAXIMUM).snapshot.field, 180, 0),
    5,
  );
  assert.equal(
    gridSample(byPolicy(OvationPolePolicy.MINIMUM).snapshot.field, 180, 0),
    0,
  );

  // The default is the mean, and it is not merely the last duplicate reached.
  assert.equal(
    gridSample(normalizeOvationPayload(OVATION_FIXTURE).snapshot.field, 180, 0),
    Math.fround(1418 / 360),
  );
  assert.notEqual(Math.fround(1418 / 360), south[south.length - 1]);
  assert.notEqual(Math.fround(1418 / 360), south[0]);

  // Whatever the policy, the resolved pole is written to all 360 columns, so the
  // pole is one place in the normalized grid.
  for (const policy of ["mean", "maximum", "minimum"]) {
    const field = byPolicy(policy).snapshot.field;
    const northRow = new Set();
    const southRow = new Set();
    for (let column = 0; column < OVATION_LONGITUDE_COUNT; ++column) {
      northRow.add(gridSample(field, 0, column));
      southRow.add(gridSample(field, 180, column));
    }
    assert.equal(northRow.size, 1, `north pole not uniform under ${policy}`);
    assert.equal(southRow.size, 1, `south pole not uniform under ${policy}`);
  }
});

test("require-agreement refuses the captured snapshot with a typed reason", () => {
  const result = normalizeOvationPayload(OVATION_FIXTURE, {
    polePolicy: OvationPolePolicy.REQUIRE_AGREEMENT,
  });
  assert.equal(result.status, "refused");
  assert.equal(result.error.code, OvationRejectionCode.POLE_DISAGREEMENT);
  assert.match(result.error.message, /south-pole duplicates/);

  // And accepts one whose duplicates do agree, so the refusal is about the data.
  const agreeing = normalizeOvationPayload(
    syntheticOvationPayload({ sample: (lon, lat) => (lat === -90 ? 3 : 0) }),
    { polePolicy: OvationPolePolicy.REQUIRE_AGREEMENT },
  );
  assert.equal(agreeing.status, "ok");
  assert.equal(gridSample(agreeing.snapshot.field, 180, 0), 3);
  assert.equal(agreeing.snapshot.southPoleAgreed, true);
});

// ---------------------------------------------------------------------------
// 5. Grid completeness and schema mutation.
// ---------------------------------------------------------------------------

test("an incomplete, reordered or non-integer grid is refused and builds nothing", () => {
  const complete = syntheticOvationPayload({ sample: () => 1 });

  const short = { ...complete, coordinates: complete.coordinates.slice(0, -1) };
  const shortResult = normalizeOvationPayload(short);
  assert.equal(shortResult.status, "refused");
  assert.equal(shortResult.error.code, OvationRejectionCode.COORDINATE_COUNT);
  assert.match(shortResult.error.message, /65160/);
  assert.equal(shortResult.snapshot, undefined);

  const long = {
    ...complete,
    coordinates: [...complete.coordinates, [0, -90, 0]],
  };
  assert.equal(
    normalizeOvationPayload(long).error.code,
    OvationRejectionCode.COORDINATE_COUNT,
  );

  // Two adjacent cells transposed: the count is right and the ordering is not.
  const reordered = { ...complete, coordinates: [...complete.coordinates] };
  const a = reordered.coordinates[0];
  reordered.coordinates[0] = reordered.coordinates[1];
  reordered.coordinates[1] = a;
  const reorderedResult = normalizeOvationPayload(reordered);
  assert.equal(reorderedResult.status, "refused");
  assert.equal(reorderedResult.error.code, OvationRejectionCode.GRID_ORDER);
  assert.match(reorderedResult.error.message, /longitude-major/);

  const fractional = { ...complete, coordinates: [...complete.coordinates] };
  fractional.coordinates[500] = [2, -52, 3.5];
  const fractionalResult = normalizeOvationPayload(fractional);
  assert.equal(fractionalResult.status, "refused");
  assert.equal(fractionalResult.error.code, OvationRejectionCode.NON_INTEGER);

  const malformedTriple = {
    ...complete,
    coordinates: [...complete.coordinates],
  };
  malformedTriple.coordinates[900] = [4, -85];
  assert.equal(
    normalizeOvationPayload(malformedTriple).error.code,
    OvationRejectionCode.TRIPLE_SHAPE,
  );
});

test("every required auroral key removed, renamed or retyped is refused with its own code", () => {
  const complete = syntheticOvationPayload({ sample: () => 1 });
  const cases = [
    ["Observation Time", OvationRejectionCode.OBSERVATION_TIME],
    ["Forecast Time", OvationRejectionCode.FORECAST_TIME],
    ["coordinates", OvationRejectionCode.COORDINATES_MISSING],
  ];

  for (const [key, code] of cases) {
    const removed = { ...complete };
    delete removed[key];
    assert.equal(
      normalizeOvationPayload(removed).error.code,
      code,
      `removing ${key}`,
    );

    const renamed = { ...complete };
    renamed[`${key}_v2`] = renamed[key];
    delete renamed[key];
    assert.equal(
      normalizeOvationPayload(renamed).error.code,
      code,
      `renaming ${key}`,
    );

    const retyped = { ...complete, [key]: 12345 };
    assert.equal(
      normalizeOvationPayload(retyped).error.code,
      code,
      `retyping ${key}`,
    );
  }

  assert.equal(
    normalizeOvationPayload({
      ...complete,
      "Forecast Time": "2026-09-19T00:00:00Z",
      "Observation Time": "2026-09-19T12:40:00Z",
    }).error.code,
    OvationRejectionCode.FORECAST_BEFORE_OBSERVATION,
  );

  assert.equal(
    normalizeOvationPayload([]).error.code,
    OvationRejectionCode.NOT_AN_OBJECT,
  );
  assert.equal(
    normalizeOvationPayload(null).error.code,
    OvationRejectionCode.NOT_AN_OBJECT,
  );
});

test("every required planetary-index field removed, renamed or retyped is refused with its own code", () => {
  const rows = [
    { time_tag: "2026-09-19T00:00:00", Kp: 2, a_running: 7, station_count: 8 },
    { time_tag: "2026-09-19T03:00:00", Kp: 3, a_running: 9, station_count: 8 },
  ];
  assert.equal(
    normalizePlanetaryKpPayload(rows, PlanetaryKpProduct.OBSERVED).status,
    "ok",
  );

  const withoutTime = [{ ...rows[0] }];
  delete withoutTime[0].time_tag;
  assert.equal(
    normalizePlanetaryKpPayload(withoutTime, PlanetaryKpProduct.OBSERVED).error
      .code,
    PlanetaryKpRejectionCode.TIME_TAG,
  );

  const renamedTime = [{ ...rows[0], timeTag: rows[0].time_tag }];
  delete renamedTime[0].time_tag;
  assert.equal(
    normalizePlanetaryKpPayload(renamedTime, PlanetaryKpProduct.OBSERVED).error
      .code,
    PlanetaryKpRejectionCode.TIME_TAG,
  );

  const withoutKp = [{ ...rows[0] }];
  delete withoutKp[0].Kp;
  assert.equal(
    normalizePlanetaryKpPayload(withoutKp, PlanetaryKpProduct.OBSERVED).error
      .code,
    PlanetaryKpRejectionCode.FIELD_MISSING,
  );

  assert.equal(
    normalizePlanetaryKpPayload(
      [{ ...rows[0], Kp: "2" }],
      PlanetaryKpProduct.OBSERVED,
    ).error.code,
    PlanetaryKpRejectionCode.FIELD_TYPE,
  );
  assert.equal(
    normalizePlanetaryKpPayload(
      [{ ...rows[0], Kp: -9999 }],
      PlanetaryKpProduct.OBSERVED,
    ).error.code,
    PlanetaryKpRejectionCode.FILL_VALUE,
  );
  assert.equal(
    normalizePlanetaryKpPayload(
      [{ ...rows[0], Kp: 11 }],
      PlanetaryKpProduct.OBSERVED,
    ).error.code,
    PlanetaryKpRejectionCode.OUT_OF_RANGE,
  );
  assert.equal(
    normalizePlanetaryKpPayload({}, PlanetaryKpProduct.OBSERVED).error.code,
    PlanetaryKpRejectionCode.NOT_AN_ARRAY,
  );
  assert.equal(
    normalizePlanetaryKpPayload([], PlanetaryKpProduct.OBSERVED).error.code,
    PlanetaryKpRejectionCode.EMPTY,
  );
  assert.equal(
    normalizePlanetaryKpPayload([7], PlanetaryKpProduct.OBSERVED).error.code,
    PlanetaryKpRejectionCode.ROW_SHAPE,
  );
});

// ---------------------------------------------------------------------------
// 6. The Kp/kp case trap, and the timezone trap.
// ---------------------------------------------------------------------------

test("each product is read through its own field name, and the swap is refused", () => {
  assert.equal(PLANETARY_KP_FIELD.observed, "Kp");
  assert.equal(PLANETARY_KP_FIELD.forecast, "kp");

  const observedAsForecast = normalizePlanetaryKpPayload(
    KP_OBSERVED_FIXTURE,
    PlanetaryKpProduct.FORECAST,
  );
  assert.equal(observedAsForecast.status, "refused");
  assert.equal(
    observedAsForecast.error.code,
    PlanetaryKpRejectionCode.FIELD_MISSING,
  );
  assert.match(observedAsForecast.error.message, /"kp"/);

  const forecastAsObserved = normalizePlanetaryKpPayload(
    KP_FORECAST_FIXTURE,
    PlanetaryKpProduct.OBSERVED,
  );
  assert.equal(forecastAsObserved.status, "refused");
  assert.equal(
    forecastAsObserved.error.code,
    PlanetaryKpRejectionCode.FIELD_MISSING,
  );
  assert.match(forecastAsObserved.error.message, /"Kp"/);

  // Correctly paired, both captures are accepted, so the refusals above are
  // about the pairing and not about the bytes.
  assert.equal(
    normalizePlanetaryKpPayload(
      KP_OBSERVED_FIXTURE,
      PlanetaryKpProduct.OBSERVED,
    ).status,
    "ok",
  );
  assert.equal(
    normalizePlanetaryKpPayload(
      KP_FORECAST_FIXTURE,
      PlanetaryKpProduct.FORECAST,
    ).status,
    "ok",
  );
});

test("a zoneless feed timestamp is read as UTC, not as host-local time", () => {
  // The captured products stamp no zone designator. Read as local time on a host
  // west of Greenwich this is hours late; the assertion is the absolute instant.
  assert.equal(
    parseSpaceWeatherTimeTag("2026-09-19T09:00:00"),
    Date.parse("2026-09-19T09:00:00Z"),
  );
  assert.equal(
    KP_OBSERVED_FIXTURE[KP_OBSERVED_FIXTURE.length - 1].time_tag,
    "2026-09-19T09:00:00",
  );
  assert.equal(
    parseSpaceWeatherTimeTag("2026-09-19T09:00:00Z"),
    parseSpaceWeatherTimeTag("2026-09-19T09:00:00"),
  );
  // An explicit offset is honoured rather than overwritten.
  assert.equal(
    parseSpaceWeatherTimeTag("2026-09-19T09:00:00+02:00"),
    Date.parse("2026-09-19T07:00:00Z"),
  );
  assert.ok(Number.isNaN(parseSpaceWeatherTimeTag(undefined)));
  assert.ok(Number.isNaN(parseSpaceWeatherTimeTag("not a time")));
});

test("row order is normalized before anything is concluded from time", () => {
  const ascending = normalizePlanetaryKpPayload(
    KP_OBSERVED_FIXTURE,
    PlanetaryKpProduct.OBSERVED,
  ).series;
  const descending = normalizePlanetaryKpPayload(
    [...KP_OBSERVED_FIXTURE].reverse(),
    PlanetaryKpProduct.OBSERVED,
  ).series;

  assert.equal(descending.readings.length, ascending.readings.length);
  assert.equal(descending.newest.timeTagMs, ascending.newest.timeTagMs);
  assert.deepEqual(
    descending.readings.map((r) => r.timeTagMs),
    ascending.readings.map((r) => r.timeTagMs),
  );
});

test("the reading at an instant is the newest bin at or before it", () => {
  const series = normalizePlanetaryKpPayload(
    KP_OBSERVED_FIXTURE,
    PlanetaryKpProduct.OBSERVED,
  ).series;
  const newestMs = Date.parse("2026-09-19T09:00:00Z");

  assert.equal(planetaryKpReadingAt(series, newestMs).timeTagMs, newestMs);
  assert.equal(
    planetaryKpReadingAt(series, newestMs - 1).timeTagMs,
    newestMs - PLANETARY_KP_CADENCE_SECONDS * 1000,
  );
  assert.equal(
    planetaryKpReadingAt(series, Date.parse("2026-09-01T00:00:00Z")),
    undefined,
  );

  assert.equal(isPlanetaryKpCurrent(series.newest, newestMs), true);
  assert.equal(
    isPlanetaryKpCurrent(
      series.newest,
      newestMs + PLANETARY_KP_CADENCE_SECONDS * 2000,
    ),
    true,
  );
  assert.equal(
    isPlanetaryKpCurrent(
      series.newest,
      newestMs + PLANETARY_KP_CADENCE_SECONDS * 2000 + 1,
    ),
    false,
  );
  // A caller holding this reading from elsewhere may ask about an instant the
  // bin precedes. A bin the product cannot have published yet is not the
  // present, whichever direction the difference runs in.
  assert.equal(isPlanetaryKpCurrent(series.newest, newestMs - 1), false);
  assert.equal(PLANETARY_KP_CADENCE_SECONDS, 10800);
  assert.equal(planetaryKpActivity(9), 1);
  assert.equal(planetaryKpActivity(0), 0);
});

// ---------------------------------------------------------------------------
// 7. Staleness and the ownership handoff.
// ---------------------------------------------------------------------------

test("a snapshot's freshness is measured against the horizon it declares itself", () => {
  const snapshot = normalizeOvationPayload(OVATION_FIXTURE).snapshot;
  const lead = MEASURED_LEAD_SECONDS * 1000;

  assert.equal(ovationFreshness(snapshot, OBSERVED_MS), "fresh");
  assert.equal(ovationFreshness(snapshot, OBSERVED_MS + lead), "fresh");
  assert.equal(ovationFreshness(snapshot, OBSERVED_MS + lead + 1), "aging");
  assert.equal(ovationFreshness(snapshot, OBSERVED_MS + 2 * lead), "aging");
  assert.equal(ovationFreshness(snapshot, OBSERVED_MS + 2 * lead + 1), "stale");
});

test("ownership moves in both directions and reports each transition", () => {
  const snapshot = normalizeOvationPayload(OVATION_FIXTURE).snapshot;
  const stale = OBSERVED_MS + 2 * MEASURED_LEAD_SECONDS * 1000 + 1;

  const acquired = resolveOvalOwnership({
    previousOwner: SpaceWeatherOvalOwner.NONE,
    ovation: snapshot,
    kpAvailable: true,
    nowMs: OBSERVED_MS,
  });
  assert.equal(acquired.owner, "ovation");
  assert.equal(acquired.reason, SpaceWeatherOwnershipReason.OVATION_CURRENT);
  assert.equal(acquired.changed, true);
  assert.equal(acquired.previousOwner, "none");
  assert.equal(acquired.ovationFreshness, "fresh");
  assert.equal(acquired.kpVisible, true);

  const held = resolveOvalOwnership({
    previousOwner: SpaceWeatherOvalOwner.OVATION,
    ovation: snapshot,
    kpAvailable: true,
    nowMs: OBSERVED_MS,
  });
  assert.equal(held.changed, false);

  const handedOff = resolveOvalOwnership({
    previousOwner: SpaceWeatherOvalOwner.OVATION,
    ovation: snapshot,
    kpAvailable: true,
    nowMs: stale,
  });
  assert.equal(handedOff.owner, "kp");
  assert.equal(handedOff.reason, SpaceWeatherOwnershipReason.OVATION_STALE);
  assert.equal(handedOff.changed, true);
  assert.equal(handedOff.ovationFreshness, "stale");

  const returned = resolveOvalOwnership({
    previousOwner: SpaceWeatherOvalOwner.KP,
    ovation: snapshot,
    kpAvailable: true,
    nowMs: OBSERVED_MS,
  });
  assert.equal(returned.owner, "ovation");
  assert.equal(returned.changed, true);

  // A refused payload leaves no snapshot, which is the same state as never
  // having fetched one.
  const absent = resolveOvalOwnership({
    previousOwner: SpaceWeatherOvalOwner.OVATION,
    ovation: undefined,
    kpAvailable: true,
    nowMs: OBSERVED_MS,
  });
  assert.equal(absent.owner, "kp");
  assert.equal(absent.reason, SpaceWeatherOwnershipReason.OVATION_ABSENT);

  const nothing = resolveOvalOwnership({
    previousOwner: SpaceWeatherOvalOwner.KP,
    ovation: undefined,
    kpAvailable: false,
    nowMs: OBSERVED_MS,
  });
  assert.equal(nothing.owner, "none");
  assert.equal(nothing.reason, SpaceWeatherOwnershipReason.NO_SOURCE);
  assert.equal(nothing.kpVisible, false);

  // Aging is not stale: a measurement inside twice its own horizon is still the
  // better answer than an index-derived one.
  const aging = resolveOvalOwnership({
    previousOwner: SpaceWeatherOvalOwner.OVATION,
    ovation: snapshot,
    kpAvailable: true,
    nowMs: OBSERVED_MS + MEASURED_LEAD_SECONDS * 1000 + 1,
  });
  assert.equal(aging.owner, "ovation");
  assert.equal(aging.ovationFreshness, "aging");

  assert.equal(ovalAuthorityFor("ovation"), "ovation");
  assert.equal(ovalAuthorityFor("kp"), "synthetic");
  assert.equal(ovalAuthorityFor("none"), undefined);
});

// ---------------------------------------------------------------------------
// 8. Non-double-count.
// ---------------------------------------------------------------------------

test("nothing multiplies an active auroral field, on either path", () => {
  for (const activity of [0, 0.25, 0.5, 1 / 3, 0.9999, 1]) {
    assert.equal(ovalForcingMultiplier("ovation", activity), 1);
    assert.equal(ovalForcingMultiplier("kp", activity), activity);
    assert.equal(ovalForcingMultiplier("none", activity), activity);
  }

  const field = normalizeOvationPayload(OVATION_FIXTURE).snapshot.field;
  assert.equal(
    auroraOvalIntensityScale({
      geomagnetic: { activity: 0.5, authority: "kp" },
      oval: field,
    }),
    1,
  );
  assert.equal(
    auroraOvalIntensityScale({
      geomagnetic: { activity: 0.5, authority: "kp" },
      oval: { ...field, authority: "synthetic" },
    }),
    0.5,
  );
});

// ---------------------------------------------------------------------------
// 9. The ingest: cost, supersession, refusal, handoff.
// ---------------------------------------------------------------------------

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise: promise, resolve: resolve, reject: reject };
}

/** A transport that answers from a queue, recording every call. */
function scriptedTransport() {
  const calls = [];
  const queue = new Map();
  return {
    calls: calls,
    enqueue(url, value) {
      if (!queue.has(url)) {
        queue.set(url, []);
      }
      queue.get(url).push(value);
    },
    fetchJson(url, signal) {
      calls.push({ url: url, signal: signal });
      const pending = queue.get(url);
      const next =
        pending !== undefined && pending.length > 0
          ? pending.shift()
          : undefined;
      if (next === undefined) {
        return Promise.reject(new Error(`no scripted response for ${url}`));
      }
      if (next && typeof next.then === "function") {
        return next;
      }
      return Promise.resolve(next);
    },
  };
}

const OVATION_URL = "test://ovation";
const KP_URL = "test://kp";

/** Planetary-index rows current at the capture's observation instant. */
function kpRowsAt(instantMs, kp) {
  return [
    {
      time_tag: new Date(instantMs - PLANETARY_KP_CADENCE_SECONDS * 1000)
        .toISOString()
        .replace(/\.\d{3}Z$/, ""),
      Kp: kp,
      a_running: 5,
      station_count: 8,
    },
    {
      time_tag: new Date(instantMs).toISOString().replace(/\.\d{3}Z$/, ""),
      Kp: kp,
      a_running: 5,
      station_count: 8,
    },
  ];
}

function makeIngest(transport, overrides) {
  return new SpaceWeatherFeedIngest({
    fetchJson: transport.fetchJson,
    ovationUrl: OVATION_URL,
    planetaryKpUrl: KP_URL,
    setTimeoutFunction: () => 1,
    clearTimeoutFunction: () => {},
    ...overrides,
  });
}

test("constructing the ingest issues nothing; the first request comes from an explicit start", async () => {
  const transport = scriptedTransport();
  const ingest = makeIngest(transport);

  assert.equal(transport.calls.length, 0);
  assert.equal(ingest.isRunning, false);
  assert.equal(ingest.latest(), undefined);
  assert.equal(ingest.diagnostics.requestsIssued, 0);
  assert.equal(ingest.diagnostics.packetsBuilt, 0);
  assert.equal(ingest.diagnostics.ovalOwner, "none");

  transport.enqueue(OVATION_URL, OVATION_FIXTURE);
  transport.enqueue(KP_URL, kpRowsAt(OBSERVED_MS, 3));
  await ingest.start(OBSERVED_MS);

  assert.equal(transport.calls.length, 2);
  assert.equal(ingest.diagnostics.requestsIssued, 1);
  assert.equal(ingest.diagnostics.packetsBuilt, 1);
  assert.equal(ingest.diagnostics.ovalOwner, "ovation");
  ingest.destroy();
});

test("the render read issues no request, parses nothing and returns the same packet", async () => {
  const transport = scriptedTransport();
  const ingest = makeIngest(transport);
  transport.enqueue(OVATION_URL, OVATION_FIXTURE);
  transport.enqueue(KP_URL, kpRowsAt(OBSERVED_MS, 3));
  await ingest.start(OBSERVED_MS);

  const before = ingest.diagnostics;
  const first = ingest.latest();
  assert.notEqual(first, undefined);
  const firstOwnership = ingest.latestOwnership();
  assert.notEqual(firstOwnership, undefined);

  const seams = {
    fetch: 0,
    setTimeout: 0,
    setInterval: 0,
    requestAnimationFrame: 0,
    dateNow: 0,
    performanceNow: 0,
  };
  const saved = {
    fetch: globalThis.fetch,
    setTimeout: globalThis.setTimeout,
    setInterval: globalThis.setInterval,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    dateNow: Date.now,
    performanceNow: globalThis.performance?.now,
  };
  globalThis.fetch = () => {
    ++seams.fetch;
    return Promise.reject(new Error("no"));
  };
  globalThis.setTimeout = () => {
    ++seams.setTimeout;
    return 0;
  };
  globalThis.setInterval = () => {
    ++seams.setInterval;
    return 0;
  };
  globalThis.requestAnimationFrame = () => {
    ++seams.requestAnimationFrame;
    return 0;
  };
  Date.now = () => {
    ++seams.dateNow;
    return 0;
  };
  if (globalThis.performance !== undefined) {
    globalThis.performance.now = () => {
      ++seams.performanceNow;
      return 0;
    };
  }

  try {
    for (let i = 0; i < 1000; ++i) {
      // Identity, not equality: a read that rebuilt the packet would allocate.
      // Compared as a boolean so a failure reports the claim rather than dumping
      // two 65,160-sample grids.
      assert.ok(
        ingest.latest() === first,
        "the render read rebuilt the packet",
      );
      // The ownership decision is read on the same path and must cost the same.
      assert.ok(
        ingest.latestOwnership() === firstOwnership,
        "the ownership read rebuilt the decision",
      );
    }
  } finally {
    globalThis.fetch = saved.fetch;
    globalThis.setTimeout = saved.setTimeout;
    globalThis.setInterval = saved.setInterval;
    globalThis.requestAnimationFrame = saved.requestAnimationFrame;
    Date.now = saved.dateNow;
    if (globalThis.performance !== undefined && saved.performanceNow) {
      globalThis.performance.now = saved.performanceNow;
    }
  }

  for (const [name, count] of Object.entries(seams)) {
    assert.equal(count, 0, `${name} was reached from the render read`);
  }
  const after = ingest.diagnostics;
  assert.equal(after.requestsIssued, before.requestsIssued);
  assert.equal(after.payloadsParsed, before.payloadsParsed);
  assert.equal(after.gridsAllocated, before.gridsAllocated);
  assert.equal(after.packetsBuilt, before.packetsBuilt);
  assert.equal(transport.calls.length, 2);
  ingest.destroy();
});

test("a superseded request cannot overwrite a newer result when it completes out of order", async () => {
  const transport = scriptedTransport();
  const ingest = makeIngest(transport);

  const oldOvation = deferred();
  const oldKp = deferred();
  transport.enqueue(OVATION_URL, oldOvation.promise);
  transport.enqueue(KP_URL, oldKp.promise);
  const firstCycle = ingest.refreshOnce(OBSERVED_MS);

  // A second cycle supersedes the first while the first is still in flight.
  transport.enqueue(OVATION_URL, OVATION_FIXTURE);
  transport.enqueue(KP_URL, kpRowsAt(OBSERVED_MS, 3));
  await ingest.refreshOnce(OBSERVED_MS);

  const newest = ingest.latest();
  assert.notEqual(newest, undefined);
  assert.equal(newest.observedTimeMs, OBSERVED_MS);
  assert.equal(ingest.diagnostics.packetsBuilt, 1);

  // Now the superseded cycle lands, carrying an older and perfectly valid
  // snapshot. It must be discarded rather than applied.
  oldOvation.resolve(
    syntheticOvationPayload({
      observationTime: "2026-09-19T06:00:00Z",
      forecastTime: "2026-09-19T07:00:00Z",
      sample: () => 9,
    }),
  );
  oldKp.resolve(kpRowsAt(Date.parse("2026-09-19T06:00:00Z"), 8));
  await firstCycle;

  assert.ok(
    ingest.latest() === newest,
    "a superseded result replaced a newer one",
  );
  assert.equal(ingest.latest().observedTimeMs, OBSERVED_MS);
  assert.equal(ingest.diagnostics.supersededResultsDiscarded, 1);
  assert.equal(ingest.diagnostics.packetsBuilt, 1);
  assert.equal(ingest.diagnostics.ovationLeadSeconds, MEASURED_LEAD_SECONDS);
  ingest.destroy();
});

test("a refused payload keeps the last good packet and reports the typed reason", async () => {
  const transport = scriptedTransport();
  const ingest = makeIngest(transport);
  transport.enqueue(OVATION_URL, OVATION_FIXTURE);
  transport.enqueue(KP_URL, kpRowsAt(OBSERVED_MS, 3));
  await ingest.refreshOnce(OBSERVED_MS);
  const good = ingest.latest();
  assert.equal(good.oval.intensity.length, OVATION_SAMPLE_COUNT);

  const errors = [];
  const savedError = console.error;
  console.error = (message) => errors.push(String(message));
  try {
    transport.enqueue(OVATION_URL, {
      "Observation Time": "2026-09-19T12:45:00Z",
    });
    transport.enqueue(KP_URL, kpRowsAt(OBSERVED_MS, 3));
    await ingest.refreshOnce(OBSERVED_MS + 1000);
  } finally {
    console.error = savedError;
  }

  assert.ok(
    ingest.latest().oval === good.oval,
    "a refusal replaced the good grid",
  );
  const failure = ingest.diagnostics.lastFailure;
  assert.equal(failure.product, "ovation");
  assert.equal(failure.code, OvationRejectionCode.FORECAST_TIME);
  assert.equal(ingest.diagnostics.payloadsRefused, 1);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /payload refused/);
  assert.match(errors[0], /Keeping the last good state/);
  ingest.destroy();
});

test("the ingest hands the oval to the index when the snapshot goes stale, and takes it back", async () => {
  const transport = scriptedTransport();
  const ingest = makeIngest(transport);
  const staleMs = OBSERVED_MS + 2 * MEASURED_LEAD_SECONDS * 1000 + 1;

  transport.enqueue(OVATION_URL, OVATION_FIXTURE);
  transport.enqueue(KP_URL, kpRowsAt(OBSERVED_MS, 3));
  await ingest.refreshOnce(OBSERVED_MS);
  assert.equal(ingest.diagnostics.ovalOwner, "ovation");
  const owned = ingest.latest();
  assert.equal(owned.oval.authority, "ovation");
  assert.equal(owned.geomagnetic.authority, "kp");
  assert.equal(owned.geomagnetic.kpIndex, 3);
  assert.equal(owned.geomagnetic.activity, 3 / 9);
  assert.equal(owned.provenance.kind, "forecast");
  assert.match(owned.provenance.attribution, /Johns Hopkins/);
  assert.equal(validateSpaceWeatherPacket(owned).valid, true);

  // The published samples are the payload's integers, unscaled: the activity
  // scalar above would have visibly reduced them if it had been applied.
  assert.equal(owned.oval.intensity[144 * OVATION_LONGITUDE_COUNT + 314], 16);
  assert.equal(auroraOvalIntensityScale(owned), 1);

  // The snapshot ages past twice its own horizon with no newer one arriving.
  transport.enqueue(OVATION_URL, Promise.reject(new Error("503")));
  transport.enqueue(KP_URL, kpRowsAt(staleMs, 6));
  const savedError = console.error;
  console.error = () => {};
  try {
    await ingest.refreshOnce(staleMs);
  } finally {
    console.error = savedError;
  }

  assert.equal(ingest.diagnostics.ovalOwner, "kp");
  assert.equal(ingest.diagnostics.ownershipTransitions, 2);
  const fallback = ingest.latest();
  assert.equal(fallback.oval, undefined);
  assert.equal(fallback.geomagnetic.authority, "kp");
  assert.equal(fallback.geomagnetic.kpIndex, 6);
  assert.equal(fallback.geomagnetic.activity, 6 / 9);
  assert.equal(fallback.provenance.kind, "observed");
  assert.equal(
    fallback.provenance.validitySeconds,
    PLANETARY_KP_CADENCE_SECONDS,
  );
  assert.equal(validateSpaceWeatherPacket(fallback).valid, true);

  // A fresh snapshot arrives and takes ownership back.
  transport.enqueue(OVATION_URL, OVATION_FIXTURE);
  transport.enqueue(KP_URL, kpRowsAt(OBSERVED_MS, 3));
  await ingest.refreshOnce(OBSERVED_MS);
  assert.equal(ingest.diagnostics.ovalOwner, "ovation");
  assert.equal(ingest.diagnostics.ownershipTransitions, 3);
  assert.equal(ingest.latest().oval.authority, "ovation");
  ingest.destroy();
});

test("destroy disarms the timer, abandons the in-flight cycle and refuses to restart", async () => {
  const transport = scriptedTransport();
  const armed = [];
  const cleared = [];
  const ingest = makeIngest(transport, {
    setTimeoutFunction: (handler, timeoutMs) => {
      armed.push(timeoutMs);
      return armed.length;
    },
    clearTimeoutFunction: (handle) => cleared.push(handle),
  });

  transport.enqueue(OVATION_URL, OVATION_FIXTURE);
  transport.enqueue(KP_URL, kpRowsAt(OBSERVED_MS, 3));
  await ingest.start(OBSERVED_MS);
  assert.equal(armed.length, 1);
  assert.equal(armed[0], 60000);
  assert.equal(ingest.isRunning, true);

  const pending = deferred();
  transport.enqueue(OVATION_URL, pending.promise);
  transport.enqueue(KP_URL, kpRowsAt(OBSERVED_MS, 3));
  const cycle = ingest.refreshOnce(OBSERVED_MS);

  ingest.destroy();
  assert.equal(cleared.length, 1);
  assert.equal(ingest.isRunning, false);
  assert.equal(ingest.isDestroyed, true);
  assert.equal(ingest.latest(), undefined);

  pending.resolve(OVATION_FIXTURE);
  await cycle;
  assert.equal(ingest.latest(), undefined, "a cycle completed after destroy");

  const callsAfterDestroy = transport.calls.length;
  await ingest.start(OBSERVED_MS);
  await ingest.refreshOnce(OBSERVED_MS);
  assert.equal(transport.calls.length, callsAfterDestroy);
  assert.equal(armed.length, 1);
});

test("destroy releases the ownership decision it published, not only the packet", async () => {
  const transport = scriptedTransport();
  const ingest = makeIngest(transport);
  transport.enqueue(OVATION_URL, OVATION_FIXTURE);
  transport.enqueue(KP_URL, kpRowsAt(OBSERVED_MS, 3));
  await ingest.refreshOnce(OBSERVED_MS);
  assert.equal(ingest.latestOwnership().owner, "ovation");
  assert.equal(ingest.diagnostics.ovalOwner, "ovation");

  ingest.destroy();

  // The decision is read beside the packet, so the pair has to agree about
  // whether anything is held. Releasing one and keeping the other reports a
  // model authority owning an oval that no longer exists.
  assert.equal(ingest.latest(), undefined);
  assert.equal(ingest.latestOwnership(), undefined);
  assert.equal(ingest.diagnostics.ovalOwner, "none");
});

test("stop disarms the timer and keeps the last good packet", async () => {
  const transport = scriptedTransport();
  const ingest = makeIngest(transport);
  transport.enqueue(OVATION_URL, OVATION_FIXTURE);
  transport.enqueue(KP_URL, kpRowsAt(OBSERVED_MS, 3));
  await ingest.start(OBSERVED_MS);
  const held = ingest.latest();

  ingest.stop();
  assert.equal(ingest.isRunning, false);
  assert.equal(ingest.isDestroyed, false);
  assert.ok(ingest.latest() === held, "stop discarded the last good packet");
  ingest.destroy();
});

// ---------------------------------------------------------------------------
// 10. The lifecycle and the clock.
//
// The eight cases below cover the half of the exit list the ingest reaches
// through its timer and its transport rather than through a normalizer: the
// abort that pairs with the reissue, the timer's own identity, a transport that
// fails before it returns, the instant a tick happens at, and the three ways a
// published state can move backwards. Each drives a real observable -- a
// signal's `aborted` flag, a transport call count, a held observation instant, a
// typed refusal code -- so none of them can pass against an inert guard.
// ---------------------------------------------------------------------------

test("the cycle a stop, a destroy or a reissue abandons has its signal aborted", async () => {
  // Reissue: the superseded cycle's signal is raised when the next one begins.
  const transport = scriptedTransport();
  const reissue = makeIngest(transport);
  const heldOvation = deferred();
  transport.enqueue(OVATION_URL, heldOvation.promise);
  transport.enqueue(KP_URL, deferred().promise);
  void reissue.refreshOnce(OBSERVED_MS);
  const firstCycle = transport.calls.slice(0, 2);
  assert.deepEqual(
    firstCycle.map((call) => call.signal.aborted),
    [false, false],
    "a live cycle was already aborted",
  );

  transport.enqueue(OVATION_URL, OVATION_FIXTURE);
  transport.enqueue(KP_URL, kpRowsAt(OBSERVED_MS, 3));
  await reissue.refreshOnce(OBSERVED_MS + 1000);
  assert.deepEqual(
    firstCycle.map((call) => call.signal.aborted),
    [true, true],
    "a superseded cycle was left running",
  );
  heldOvation.resolve(OVATION_FIXTURE);
  reissue.destroy();

  // Stop.
  const stopTransport = scriptedTransport();
  const onStop = makeIngest(stopTransport);
  stopTransport.enqueue(OVATION_URL, deferred().promise);
  stopTransport.enqueue(KP_URL, deferred().promise);
  void onStop.refreshOnce(OBSERVED_MS);
  assert.deepEqual(
    stopTransport.calls.map((call) => call.signal.aborted),
    [false, false],
  );
  onStop.stop();
  assert.deepEqual(
    stopTransport.calls.map((call) => call.signal.aborted),
    [true, true],
    "stop left the request in flight running",
  );
  onStop.destroy();

  // Destroy.
  const destroyTransport = scriptedTransport();
  const onDestroy = makeIngest(destroyTransport);
  destroyTransport.enqueue(OVATION_URL, deferred().promise);
  destroyTransport.enqueue(KP_URL, deferred().promise);
  void onDestroy.refreshOnce(OBSERVED_MS);
  onDestroy.destroy();
  assert.deepEqual(
    destroyTransport.calls.map((call) => call.signal.aborted),
    [true, true],
    "destroy left the request in flight running",
  );
});

test("starting twice leaves one timer, and stopping it stops the ingest", async () => {
  const transport = scriptedTransport();
  const armed = new Map();
  const cleared = new Set();
  const fired = new Set();
  let nextHandle = 1;
  const ingest = makeIngest(transport, {
    setTimeoutFunction: (handler) => {
      const handle = nextHandle++;
      armed.set(handle, handler);
      return handle;
    },
    clearTimeoutFunction: (handle) => cleared.add(handle),
  });
  const liveHandles = () =>
    [...armed.keys()].filter(
      (handle) => !cleared.has(handle) && !fired.has(handle),
    );

  for (let start = 0; start < 2; ++start) {
    transport.enqueue(OVATION_URL, OVATION_FIXTURE);
    transport.enqueue(KP_URL, kpRowsAt(OBSERVED_MS, 3));
    await ingest.start(OBSERVED_MS);
  }
  assert.equal(
    liveHandles().length,
    1,
    "a second start left the first timer armed",
  );

  const callsAtStop = transport.calls.length;
  ingest.stop();
  assert.equal(ingest.isRunning, false);
  assert.deepEqual(liveHandles(), [], "stop left a timer armed");

  // Fire whatever the injected timer left live. A leaked handle re-arms itself
  // through the same path, so an orphan would issue requests here and flip
  // isRunning back with no start() call; the chain is bounded so a leak reports
  // as a failed assertion rather than as a spec that never returns.
  for (let chain = 0; chain < 5 && liveHandles().length > 0; ++chain) {
    const handle = liveHandles()[0];
    fired.add(handle);
    armed.get(handle)();
    await Promise.resolve();
    await Promise.resolve();
  }
  assert.equal(
    transport.calls.length,
    callsAtStop,
    "a stopped ingest issued a request",
  );
  assert.equal(ingest.isRunning, false, "a stopped ingest re-armed itself");
  ingest.destroy();
});

test("a transport that throws where it stands is refused, not raised into the caller", async () => {
  const thrown = new TypeError("options.url is required, actual value was 7");
  const ingest = makeIngest(scriptedTransport(), {
    fetchJson: () => {
      throw thrown;
    },
  });

  const errors = [];
  const savedError = console.error;
  console.error = (message) => errors.push(String(message));
  let raised;
  try {
    await ingest.refreshOnce(OBSERVED_MS).catch((error) => {
      raised = error;
    });
  } finally {
    console.error = savedError;
  }

  assert.equal(raised, undefined, "the cycle raised the throw into its caller");
  assert.equal(ingest.diagnostics.payloadsRefused, 2);
  assert.equal(ingest.diagnostics.lastFailure.code, "transport");
  assert.match(ingest.diagnostics.lastFailure.message, /options\.url/);
  assert.equal(errors.length, 1, "the refusal was not reported once");
  assert.equal(ingest.latest(), undefined);
  ingest.destroy();
});

test("the poll tick reads the instant it happened at, so a suspended host hands off", async () => {
  const transport = scriptedTransport();
  let tick;
  let wallMs = OBSERVED_MS;
  const ingest = makeIngest(transport, {
    setTimeoutFunction: (handler) => {
      tick = handler;
      return 1;
    },
    nowFunction: () => wallMs,
  });

  const answer = () => {
    transport.enqueue(OVATION_URL, OVATION_FIXTURE);
    transport.enqueue(KP_URL, kpRowsAt(OBSERVED_MS, 3));
  };
  answer();
  await ingest.start(OBSERVED_MS);
  assert.equal(ingest.diagnostics.ovalOwner, "ovation");

  // The host sleeps: the 60 s timer fires three times across 135 minutes. Each
  // tick re-fetches the same unchanged snapshot, so the only thing that moves is
  // the wall clock, and a tick that counted the interval forward instead would
  // still be reading 12:43.
  const observed = [];
  for (const minutes of [45, 90, 135]) {
    wallMs = OBSERVED_MS + minutes * 60000;
    answer();
    tick();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    observed.push([
      minutes,
      ingest.diagnostics.ovalOwner,
      ingest.latestOwnership().ovationFreshness,
    ]);
  }

  assert.deepEqual(observed, [
    [45, "ovation", "fresh"],
    [90, "ovation", "aging"],
    [135, "kp", "stale"],
  ]);
  assert.equal(ingest.diagnostics.ownershipTransitions, 2);
  assert.equal(ingest.latestOwnership().reason, "ovation-stale");
  ingest.destroy();
});

test("a response carrying an older snapshot is refused rather than applied", async () => {
  const transport = scriptedTransport();
  const ingest = makeIngest(transport);
  transport.enqueue(OVATION_URL, OVATION_FIXTURE);
  transport.enqueue(KP_URL, kpRowsAt(OBSERVED_MS, 3));
  await ingest.refreshOnce(OBSERVED_MS);
  const held = ingest.latest();

  const errors = [];
  const savedError = console.error;
  console.error = (message) => errors.push(String(message));
  try {
    // A cached edge answers a later request with the previous snapshot.
    transport.enqueue(
      OVATION_URL,
      syntheticOvationPayload({
        observationTime: "2026-09-19T11:40:00Z",
        forecastTime: "2026-09-19T12:42:00Z",
        sample: () => 9,
      }),
    );
    transport.enqueue(KP_URL, kpRowsAt(OBSERVED_MS, 3));
    await ingest.refreshOnce(OBSERVED_MS + 60000);
  } finally {
    console.error = savedError;
  }

  // The cycle still republishes from the snapshot it already holds, so the test
  // of what was refused is the grid's identity and the instant it declares.
  assert.ok(
    ingest.latest().oval === held.oval,
    "an older snapshot replaced a newer one",
  );
  assert.equal(ingest.latest().observedTimeMs, OBSERVED_MS);
  assert.equal(ingest.diagnostics.lastFailure.product, "ovation");
  assert.equal(ingest.diagnostics.lastFailure.code, "time-regression");
  assert.equal(ingest.diagnostics.payloadsRefused, 1);
  assert.equal(ingest.diagnostics.supersededResultsDiscarded, 0);
  assert.equal(errors.length, 1);

  // The same rule holds for the index series, whose newest bin is its instant.
  transport.enqueue(OVATION_URL, OVATION_FIXTURE);
  transport.enqueue(KP_URL, kpRowsAt(OBSERVED_MS - 6 * 3600 * 1000, 8));
  await ingest.refreshOnce(OBSERVED_MS + 120000);
  assert.equal(ingest.diagnostics.lastFailure.product, "kp");
  assert.equal(ingest.diagnostics.lastFailure.code, "time-regression");
  assert.equal(
    ingest.latest().geomagnetic.kpIndex,
    3,
    "an older index reading applied",
  );
  ingest.destroy();
});

test("stop abandons the cycle in flight rather than letting it publish", async () => {
  const transport = scriptedTransport();
  const ingest = makeIngest(transport);
  transport.enqueue(OVATION_URL, OVATION_FIXTURE);
  transport.enqueue(KP_URL, kpRowsAt(OBSERVED_MS, 3));
  await ingest.refreshOnce(OBSERVED_MS);
  const held = ingest.latest();

  const inFlight = deferred();
  transport.enqueue(OVATION_URL, inFlight.promise);
  transport.enqueue(KP_URL, kpRowsAt(OBSERVED_MS, 3));
  const cycle = ingest.refreshOnce(OBSERVED_MS + 1000);

  const errors = [];
  const savedError = console.error;
  console.error = (message) => errors.push(String(message));
  try {
    ingest.stop();
    // An abort cannot unsettle a promise the transport has already resolved, so
    // the result still arrives after the stop and the generation is what has to
    // discard it.
    inFlight.resolve(
      syntheticOvationPayload({
        observationTime: "2026-09-19T14:00:00Z",
        forecastTime: "2026-09-19T15:00:00Z",
        sample: () => 9,
      }),
    );
    await cycle;
  } finally {
    console.error = savedError;
  }

  assert.ok(ingest.latest() === held, "a stopped cycle published");
  assert.equal(ingest.diagnostics.packetsBuilt, 1);
  assert.equal(ingest.diagnostics.supersededResultsDiscarded, 1);
  assert.equal(ingest.diagnostics.payloadsRefused, 0);
  assert.equal(ingest.diagnostics.lastFailure, undefined);
  assert.deepEqual(errors, [], "a deliberate stop reported a production error");
  ingest.destroy();
});

test("a snapshot whose packet fails the schema is refused, and the index takes the oval", async () => {
  const transport = scriptedTransport();
  const ingest = makeIngest(transport);

  // An integer too large for a Float32Array element: Number.isInteger accepts
  // 1e308 and the grid then stores Infinity, which the packet schema refuses.
  transport.enqueue(
    OVATION_URL,
    syntheticOvationPayload({
      sample: (longitude, latitude) =>
        longitude === 12 && latitude === 30 ? 1e308 : 1,
    }),
  );
  transport.enqueue(KP_URL, kpRowsAt(OBSERVED_MS, 3));

  const errors = [];
  const savedError = console.error;
  console.error = (message) => errors.push(String(message));
  try {
    await ingest.refreshOnce(OBSERVED_MS);
  } finally {
    console.error = savedError;
  }

  const failure = ingest.diagnostics.lastFailure;
  assert.equal(failure.product, "ovation");
  assert.equal(failure.code, "invalid-packet");
  assert.match(
    failure.message,
    /oval\.intensity\[\d+\]: must be a finite number/,
  );
  assert.equal(errors.length, 1);

  // An unpublishable snapshot is an absent source, so the index owns the oval
  // and what reaches a consumer satisfies the schema.
  const published = ingest.latest();
  assert.equal(ingest.diagnostics.ovalOwner, "kp");
  assert.equal(ingest.latestOwnership().reason, "ovation-absent");
  assert.equal(published.oval, undefined);
  assert.equal(published.provenance.sourceId, "noaa-planetary-kp");
  assert.equal(validateSpaceWeatherPacket(published).valid, true);
  assert.equal(ingest.diagnostics.packetsBuilt, 1);
  ingest.destroy();
});

test("a negative aurora sample is refused, maximum and all", () => {
  // The published range of this product begins at zero, and the capture agrees:
  // its samples run 0 to 16. A negative one is carried on the raw scale, where a
  // consumer divides by the snapshot's own maximum -- which stays positive, so
  // nothing downstream reveals it.
  let smallest = Infinity;
  for (const triple of OVATION_FIXTURE.coordinates) {
    if (triple[2] < smallest) {
      smallest = triple[2];
    }
  }
  assert.equal(smallest, 0);

  const result = normalizeOvationPayload(
    syntheticOvationPayload({
      sample: (longitude, latitude) =>
        longitude === 200 && latitude === -65 ? -7 : 4,
    }),
  );
  assert.equal(result.status, "refused");
  assert.equal(result.error.code, OvationRejectionCode.NEGATIVE_SAMPLE);
  assert.match(result.error.message, /must not be negative, received -7/);
  assert.equal(result.snapshot, undefined);
});

test("the ownership decision is published beside the packet, including when nobody owns", async () => {
  const transport = scriptedTransport();
  const ingest = makeIngest(transport);
  assert.equal(ingest.latestOwnership(), undefined);

  transport.enqueue(OVATION_URL, OVATION_FIXTURE);
  transport.enqueue(KP_URL, kpRowsAt(OBSERVED_MS, 3));
  await ingest.refreshOnce(OBSERVED_MS);
  const owned = ingest.latestOwnership();
  assert.equal(owned.owner, "ovation");
  assert.equal(owned.reason, "ovation-current");
  assert.equal(owned.changed, true);
  assert.equal(Object.isFrozen(owned), true);

  // The snapshot goes stale, and the index reading held beside it is by now
  // older than the cadence it is published on, so neither source owns the oval.
  // The last good packet deliberately stays, which makes the decision the only
  // thing reporting that its producer has disowned what a consumer is handed.
  const disownedMs = OBSERVED_MS + 10 * 3600 * 1000;
  const errors = [];
  const savedError = console.error;
  console.error = (message) => errors.push(String(message));
  try {
    transport.enqueue(OVATION_URL, undefined);
    transport.enqueue(KP_URL, undefined);
    await ingest.refreshOnce(disownedMs);
  } finally {
    console.error = savedError;
  }

  const disowned = ingest.latestOwnership();
  assert.equal(disowned.owner, "none");
  assert.equal(disowned.previousOwner, "ovation");
  assert.equal(disowned.reason, "ovation-stale");
  assert.equal(disowned.ovationFreshness, "stale");
  assert.equal(disowned.kpVisible, false);
  assert.equal(disowned.changed, true);
  assert.equal(ingest.latest().oval.authority, "ovation");
  assert.equal(ingest.diagnostics.packetsBuilt, 1);
  ingest.destroy();
});

test("a disagreeing north pole is resolved by the same policy as the south", () => {
  // The capture disagrees at the south pole and is uniformly 0 at the north, so
  // the fixture alone cannot tell a north-pole substitution from the wire row it
  // would have read anyway. This grid varies the north duplicates instead: 120
  // each of 0, 1 and 2, so the mean is exactly 1 and every policy lands on a
  // different number.
  const payload = syntheticOvationPayload({
    sample: (longitude, latitude) => (latitude === 90 ? longitude % 3 : 0),
  });

  for (const [policy, expected] of [
    [OvationPolePolicy.MEAN, 1],
    [OvationPolePolicy.MAXIMUM, 2],
    [OvationPolePolicy.MINIMUM, 0],
  ]) {
    const result = normalizeOvationPayload(payload, { polePolicy: policy });
    assert.equal(result.status, "ok");
    const field = result.snapshot.field;
    const row = 0;
    for (let column = 0; column < OVATION_LONGITUDE_COUNT; ++column) {
      assert.equal(
        gridSample(field, row, column),
        expected,
        `${policy} left column ${column} of the north pole row unresolved`,
      );
    }
    assert.equal(result.snapshot.northPoleAgreed, false);
    assert.equal(result.snapshot.southPoleAgreed, true);
  }

  const refused = normalizeOvationPayload(payload, {
    polePolicy: OvationPolePolicy.REQUIRE_AGREEMENT,
  });
  assert.equal(refused.status, "refused");
  assert.equal(refused.error.code, OvationRejectionCode.POLE_DISAGREEMENT);
  assert.match(refused.error.message, /north/);
});
test("a payload stamped ahead of the clock is refused, and the next real one is taken", async () => {
  const transport = scriptedTransport();
  const ingest = makeIngest(transport);
  const errors = [];
  const savedError = console.error;
  console.error = (message) => errors.push(String(message));
  try {
    // A publisher clock in the wrong year, which is what a time tag typo looks
    // like from here. Every sample is a valid integer and the grid is complete,
    // so no normalizer refuses it: the instant is the only thing wrong with it.
    transport.enqueue(
      OVATION_URL,
      syntheticOvationPayload({
        observationTime: "2027-09-19T12:40:00Z",
        forecastTime: "2027-09-19T13:42:00Z",
        sample: () => 9,
      }),
    );
    transport.enqueue(KP_URL, kpRowsAt(OBSERVED_MS, 3));
    await ingest.refreshOnce(OBSERVED_MS);

    assert.equal(ingest.diagnostics.lastFailure.product, "ovation");
    assert.equal(
      ingest.diagnostics.lastFailure.code,
      SpaceWeatherIngestCode.IMPLAUSIBLE_TIME,
    );
    // Nothing model-owned is drawn from it, and the index -- the fallback the
    // contract names -- owns the oval instead.
    assert.equal(ingest.diagnostics.ovalOwner, "kp");
    assert.equal(ingest.latest().oval, undefined);

    // The real product, from here on. A rule that let the year-ahead instant
    // stand would make every one of these "older" and refuse it.
    for (let cycle = 1; cycle <= 3; ++cycle) {
      transport.enqueue(OVATION_URL, OVATION_FIXTURE);
      transport.enqueue(KP_URL, kpRowsAt(OBSERVED_MS, 3));
      await ingest.refreshOnce(OBSERVED_MS + cycle * 1000);
    }
    assert.equal(
      ingest.latest().oval.authority,
      "ovation",
      "the ingest went on refusing real snapshots",
    );
    assert.equal(ingest.latest().observedTimeMs, OBSERVED_MS);
    assert.equal(ingest.diagnostics.ovalOwner, "ovation");
    assert.equal(ingest.diagnostics.payloadsRefused, 1);

    // The index product, stamped the same way: a bin that cannot have been
    // published yet must neither replace the held series nor outrank the bins
    // that follow it.
    transport.enqueue(OVATION_URL, OVATION_FIXTURE);
    transport.enqueue(KP_URL, kpRowsAt(Date.parse("2027-09-19T12:00:00Z"), 8));
    await ingest.refreshOnce(OBSERVED_MS + 180000);
    assert.equal(ingest.diagnostics.lastFailure.product, "kp");
    assert.equal(
      ingest.diagnostics.lastFailure.code,
      SpaceWeatherIngestCode.IMPLAUSIBLE_TIME,
    );
    assert.equal(ingest.latest().geomagnetic.kpIndex, 3);

    transport.enqueue(OVATION_URL, OVATION_FIXTURE);
    transport.enqueue(KP_URL, kpRowsAt(OBSERVED_MS + 240000, 7));
    await ingest.refreshOnce(OBSERVED_MS + 300000);
    assert.equal(
      ingest.latest().geomagnetic.kpIndex,
      7,
      "the real series was refused after the bad one",
    );
    assert.equal(ingest.diagnostics.payloadsRefused, 2);
  } finally {
    console.error = savedError;
  }
  assert.equal(errors.length, 2, "a refused payload was not reported");
  ingest.destroy();
});

test("an observation instant ahead of the clock is not credited, and is named apart from a stale one", async () => {
  const snapshot = {
    observedTimeMs: OBSERVED_MS,
    forecastTimeMs: FORECAST_MS,
  };
  const toleranceMs = SPACE_WEATHER_CLOCK_SKEW_TOLERANCE_SECONDS * 1000;

  // Inside the tolerance the disagreement is ordinary skew and changes nothing.
  const skewedMs = OBSERVED_MS - toleranceMs;
  assert.equal(spaceWeatherObservationIsPlausible(OBSERVED_MS, skewedMs), true);
  assert.equal(ovationFreshness(snapshot, skewedMs), "fresh");

  // One second past it, the instant cannot be one anything was observed at.
  const impossibleMs = skewedMs - 1000;
  assert.equal(
    spaceWeatherObservationIsPlausible(OBSERVED_MS, impossibleMs),
    false,
  );
  assert.equal(ovationFreshness(snapshot, impossibleMs), "stale");

  // The forecast instant is ahead of the clock in every one of these cases and
  // is never what is bounded: it is the lead itself.
  assert.ok(FORECAST_MS > OBSERVED_MS);
  assert.equal(ovationFreshness(snapshot, OBSERVED_MS), "fresh");

  const impossible = resolveOvalOwnership({
    previousOwner: SpaceWeatherOvalOwner.OVATION,
    ovation: snapshot,
    kpAvailable: true,
    nowMs: impossibleMs,
  });
  assert.equal(impossible.owner, "kp");
  assert.equal(
    impossible.reason,
    SpaceWeatherOwnershipReason.OVATION_AHEAD_OF_CLOCK,
  );
  assert.equal(impossible.ovationFreshness, "stale");

  // A snapshot that is merely old keeps the reason that describes it, so the
  // two failures stay diagnosable apart.
  const old = resolveOvalOwnership({
    previousOwner: SpaceWeatherOvalOwner.OVATION,
    ovation: snapshot,
    kpAvailable: true,
    nowMs: OBSERVED_MS + 3 * MEASURED_LEAD_SECONDS * 1000,
  });
  assert.equal(old.reason, SpaceWeatherOwnershipReason.OVATION_STALE);

  // ...and the same holds through the ingest, for state accepted while the clock
  // agreed and still held when the clock is corrected backwards. Both products
  // stop being credited rather than reading current for ever off a negative age.
  const transport = scriptedTransport();
  const ingest = makeIngest(transport);
  transport.enqueue(OVATION_URL, OVATION_FIXTURE);
  transport.enqueue(KP_URL, kpRowsAt(OBSERVED_MS, 3));
  await ingest.refreshOnce(OBSERVED_MS);
  assert.equal(ingest.latestOwnership().reason, "ovation-current");

  const correctedMs = OBSERVED_MS - 2 * 3600 * 1000;
  const errors = [];
  const savedError = console.error;
  console.error = (message) => errors.push(String(message));
  try {
    // The product does not answer this cycle, so the held snapshot is all there
    // is to judge, and the index answers with the bins that exist on the
    // corrected clock -- every one of them older than the bin being held.
    transport.enqueue(OVATION_URL, undefined);
    transport.enqueue(KP_URL, kpRowsAt(correctedMs - 3600 * 1000, 5));
    await ingest.refreshOnce(correctedMs);

    const decided = ingest.latestOwnership();
    assert.equal(decided.owner, "kp");
    assert.equal(decided.reason, "ovation-ahead-of-clock");
    assert.equal(decided.ovationFreshness, "stale");
    assert.notEqual(
      ingest.latest(),
      undefined,
      "the last good packet was dropped",
    );
    assert.equal(
      ingest.latest().geomagnetic.kpIndex,
      5,
      "a bin the clock cannot believe went on refusing the bins it can",
    );

    // A held instant that cannot be real must not outrank the instants that
    // can, so the next snapshot replaces it even though it is the older of the
    // two. This is the whole of the recovery: nothing waits for destroy().
    const recoveredMs = correctedMs - 600000;
    transport.enqueue(
      OVATION_URL,
      syntheticOvationPayload({
        observationTime: new Date(recoveredMs).toISOString(),
        forecastTime: new Date(
          recoveredMs + MEASURED_LEAD_SECONDS * 1000,
        ).toISOString(),
        sample: () => 5,
      }),
    );
    transport.enqueue(KP_URL, kpRowsAt(correctedMs - 3600 * 1000, 5));
    await ingest.refreshOnce(correctedMs + 1000);
  } finally {
    console.error = savedError;
  }

  assert.equal(
    ingest.latest().observedTimeMs,
    correctedMs - 600000,
    "the held snapshot went on refusing every instant the clock can believe",
  );
  assert.equal(ingest.latestOwnership().owner, "ovation");
  assert.equal(ingest.latestOwnership().reason, "ovation-current");
  assert.equal(ingest.diagnostics.lastFailure.code, "transport");
  ingest.destroy();
});

test("a stop raised inside the tick's own cycle stops the ingest, and a late callback cannot restart it", async () => {
  const armed = new Map();
  const cleared = new Set();
  let nextHandle = 1;
  let calls = 0;
  let stopOnNextCall = false;
  let ingest;
  const timers = {
    setTimeoutFunction: (handler) => {
      const handle = nextHandle++;
      armed.set(handle, handler);
      return handle;
    },
    clearTimeoutFunction: (handle) => cleared.add(handle),
  };
  const answer = (url) => {
    ++calls;
    // The transport is called synchronously from the tick, so anything it does
    // to the ingest happens while that tick is still between clearing its handle
    // and arming the next one.
    if (stopOnNextCall) {
      stopOnNextCall = false;
      ingest.stop();
    }
    return Promise.resolve(
      url === OVATION_URL ? OVATION_FIXTURE : kpRowsAt(OBSERVED_MS, 3),
    );
  };
  ingest = makeIngest(scriptedTransport(), {
    ...timers,
    fetchJson: answer,
  });

  await ingest.start(OBSERVED_MS);
  stopOnNextCall = true;
  armed.get(1)();
  for (let turn = 0; turn < 6; ++turn) {
    await Promise.resolve();
  }

  assert.equal(ingest.isRunning, false, "a stopped ingest is still running");
  const liveAfterStop = [...armed.keys()].filter(
    (handle) => handle !== 1 && !cleared.has(handle),
  );
  assert.deepEqual(liveAfterStop, [], "the stopped tick armed a successor");

  // The second door: a host delivering a callback whose handle was cleared. The
  // injected timer functions are public options and nothing in their contract
  // forbids it.
  const callsAfterStop = calls;
  armed.get(1)();
  for (let turn = 0; turn < 6; ++turn) {
    await Promise.resolve();
  }
  assert.equal(calls, callsAfterStop, "a stopped ingest issued a request");
  assert.equal(ingest.isRunning, false, "a late callback restarted the ingest");

  // A manual refresh is not a restart, and does not re-arm.
  await ingest.refreshOnce(OBSERVED_MS + 60000);
  assert.ok(calls > callsAfterStop, "an explicit refresh was refused");
  assert.equal(ingest.isRunning, false);
  ingest.destroy();
});

test("a rejection reason that cannot describe itself is refused like any other", async () => {
  const shapes = [
    ["a reason with no prototype", () => Object.create(null)],
    [
      "a reason whose toString throws",
      () => ({
        toString() {
          throw new Error("this reason refuses to be read");
        },
      }),
    ],
  ];

  for (const [label, makeReason] of shapes) {
    let tick;
    const ingest = makeIngest(scriptedTransport(), {
      fetchJson: () => Promise.reject(makeReason()),
      setTimeoutFunction: (handler) => {
        tick = handler;
        return 1;
      },
      // Both cycles land inside one throttle window, so the single diagnostic
      // asserted below is the throttle behaving and not the clock drifting.
      nowFunction: () => OBSERVED_MS,
    });
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    const errors = [];
    const savedError = console.error;
    console.error = (message) => errors.push(String(message));
    let raised;
    try {
      await ingest.start(OBSERVED_MS).catch((error) => {
        raised = error;
      });
      // And through the poll tick, which discards the promise it starts, so a
      // throw two frames inside the cycle has no caller left to reach.
      tick();
      for (let turn = 0; turn < 8; ++turn) {
        await Promise.resolve();
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      console.error = savedError;
      process.off("unhandledRejection", onUnhandled);
    }

    assert.equal(raised, undefined, `${label} was raised into the caller`);
    assert.deepEqual(unhandled, [], `${label} escaped the poll tick`);
    assert.equal(ingest.diagnostics.payloadsRefused, 4, label);
    assert.equal(ingest.diagnostics.lastFailure.code, "transport");
    assert.equal(typeof ingest.diagnostics.lastFailure.message, "string");
    assert.equal(errors.length, 1, `${label} was not reported once`);
    assert.equal(ingest.latest(), undefined);
    ingest.destroy();
  }
});

test("every poll tick leaves its successor armed, so the chain continues", async () => {
  const transport = scriptedTransport();
  const armed = [];
  const cleared = new Set();
  const fired = new Set();
  let nextHandle = 1;
  const ingest = makeIngest(transport, {
    setTimeoutFunction: (handler) => {
      const handle = nextHandle++;
      armed.push({ handle: handle, handler: handler });
      return handle;
    },
    clearTimeoutFunction: (handle) => cleared.add(handle),
  });
  const live = () =>
    armed.filter(
      (entry) => !cleared.has(entry.handle) && !fired.has(entry.handle),
    );

  transport.enqueue(OVATION_URL, OVATION_FIXTURE);
  transport.enqueue(KP_URL, kpRowsAt(OBSERVED_MS, 3));
  await ingest.start(OBSERVED_MS);
  assert.equal(armed.length, 1);

  // Fire only what is currently armed, which is how a timer behaves and is the
  // only way to observe whether a tick produced a successor. Re-using one
  // captured handler cannot: it reports what a tick reads, never whether ticks
  // go on arriving.
  for (let round = 1; round <= 3; ++round) {
    const pending = live();
    assert.equal(
      pending.length,
      1,
      `the poll chain stopped after tick ${round - 1}`,
    );
    transport.enqueue(OVATION_URL, OVATION_FIXTURE);
    transport.enqueue(KP_URL, kpRowsAt(OBSERVED_MS, 3));
    fired.add(pending[0].handle);
    pending[0].handler();
    for (let turn = 0; turn < 6; ++turn) {
      await Promise.resolve();
    }
    assert.equal(armed.length, round + 1, `tick ${round} armed no successor`);
    assert.equal(ingest.diagnostics.requestsIssued, round + 1);
  }

  assert.equal(ingest.isRunning, true, "the ingest stopped polling by itself");
  assert.equal(live().length, 1);
  ingest.destroy();
});

test("the refusal diagnostic goes on reporting across cycles, and a clock step cannot silence it", async () => {
  const ingest = makeIngest(scriptedTransport(), {
    fetchJson: () => Promise.reject(new Error("the product is unreachable")),
  });
  const errors = [];
  const savedError = console.error;
  console.error = (message) => errors.push(String(message));
  try {
    await ingest.refreshOnce(OBSERVED_MS);
    assert.equal(errors.length, 1, "the first refusal was not reported");

    // Inside the window the feed is refused and not reported again.
    await ingest.refreshOnce(OBSERVED_MS + 30000);
    assert.equal(errors.length, 1);

    // At the window the throttle opens again. The poll interval and the
    // throttle interval are the same 60 s, so a broken feed that only reported
    // strictly past the window would report exactly once and then never.
    await ingest.refreshOnce(OBSERVED_MS + 60000);
    assert.equal(errors.length, 2, "the throttle opened once and never again");
    await ingest.refreshOnce(OBSERVED_MS + 120000);
    assert.equal(errors.length, 3);

    // A clock correction steps the instant a day forward and then back. The
    // stamp is an instant on that clock, so an unbounded throttle would sit a
    // day in the future and silence the feed for a day.
    await ingest.refreshOnce(OBSERVED_MS + 24 * 3600 * 1000);
    assert.equal(errors.length, 4);
    await ingest.refreshOnce(OBSERVED_MS + 180000);
    assert.equal(errors.length, 5, "a forward clock step silenced the feed");
    await ingest.refreshOnce(OBSERVED_MS + 240000);
    assert.equal(errors.length, 6);
  } finally {
    console.error = savedError;
  }
  assert.equal(ingest.diagnostics.payloadsRefused, 14);
  ingest.destroy();
});

test("a revision at the same observation instant is applied, on both products", async () => {
  const transport = scriptedTransport();
  const ingest = makeIngest(transport);
  transport.enqueue(OVATION_URL, syntheticOvationPayload({ sample: () => 2 }));
  transport.enqueue(KP_URL, kpRowsAt(OBSERVED_MS, 3));
  await ingest.refreshOnce(OBSERVED_MS);
  assert.equal(gridSample(ingest.latest().oval, 90, 0), 2);
  assert.equal(ingest.latest().geomagnetic.kpIndex, 3);

  // Both products revise a value in place rather than only appending: the
  // observed index capture carries a station_count that differs between bins
  // (7 for sixteen of its sixty rows, 8 for the rest), so a bin's value is one
  // the product firms up as stations report. The refusal is about instants
  // moving backwards, and an instant that repeats has not moved.
  transport.enqueue(OVATION_URL, syntheticOvationPayload({ sample: () => 7 }));
  transport.enqueue(KP_URL, kpRowsAt(OBSERVED_MS, 8));
  await ingest.refreshOnce(OBSERVED_MS + 60000);

  assert.equal(
    gridSample(ingest.latest().oval, 90, 0),
    7,
    "a corrected snapshot at the same instant was refused",
  );
  assert.equal(
    ingest.latest().geomagnetic.kpIndex,
    8,
    "a corrected index bin at the same instant was refused",
  );
  assert.equal(ingest.latest().observedTimeMs, OBSERVED_MS);
  assert.equal(ingest.diagnostics.payloadsRefused, 0);
  assert.equal(ingest.diagnostics.packetsBuilt, 2);
  ingest.destroy();
});

test("the pole policy the ingest was constructed with reaches the grid it publishes", async () => {
  // The capture's south pole disagrees with itself, so the policy the caller
  // chose is readable in the sample the ingest publishes -- and
  // require-agreement refuses this capture outright, which is the evidence that
  // the option is carried rather than defaulted.
  const errors = [];
  const savedError = console.error;
  console.error = (message) => errors.push(String(message));

  const byPolicy = async (policy) => {
    const transport = scriptedTransport();
    const ingest = makeIngest(transport, { polePolicy: policy });
    transport.enqueue(OVATION_URL, OVATION_FIXTURE);
    transport.enqueue(KP_URL, kpRowsAt(OBSERVED_MS, 3));
    await ingest.start(OBSERVED_MS);
    const published = ingest.latest();
    const read = {
      owner: ingest.diagnostics.ovalOwner,
      code: ingest.diagnostics.lastFailure?.code,
      sample:
        published.oval === undefined
          ? undefined
          : gridSample(published.oval, 180, 0),
    };
    ingest.destroy();
    return read;
  };

  try {
    assert.equal((await byPolicy(OvationPolePolicy.MAXIMUM)).sample, 5);
    assert.equal((await byPolicy(OvationPolePolicy.MINIMUM)).sample, 0);
    assert.equal(
      (await byPolicy(OvationPolePolicy.MEAN)).sample,
      Math.fround(1418 / 360),
    );
    assert.equal((await byPolicy(undefined)).sample, Math.fround(1418 / 360));

    const required = await byPolicy(OvationPolePolicy.REQUIRE_AGREEMENT);
    assert.equal(required.owner, "kp");
    assert.equal(required.code, OvationRejectionCode.POLE_DISAGREEMENT);
    assert.equal(required.sample, undefined);
  } finally {
    console.error = savedError;
  }

  // A capture refused over its poles is a refused payload like any other, so it
  // reaches the console once and only the refusing policy produces one.
  assert.equal(errors.length, 1);
  assert.ok(errors[0].includes(OvationRejectionCode.POLE_DISAGREEMENT));
});

test("the published model packet carries the provenance the snapshot declares", async () => {
  const transport = scriptedTransport();
  const ingest = makeIngest(transport);
  transport.enqueue(OVATION_URL, OVATION_FIXTURE);
  transport.enqueue(KP_URL, kpRowsAt(OBSERVED_MS, 3));
  await ingest.start(OBSERVED_MS);

  const published = ingest.latest();
  assert.equal(published.provenance.sourceId, "ovation");
  assert.equal(published.provenance.kind, "forecast");
  assert.equal(published.observedTimeMs, OBSERVED_MS);
  assert.equal(published.forecastTimeMs, FORECAST_MS);
  assert.equal(
    spaceWeatherForecastLeadSeconds(published),
    MEASURED_LEAD_SECONDS,
  );
  // The horizon every downstream freshness read measures against is the lead
  // this payload declared -- not the floor, and not a constant named after the
  // product.
  assert.equal(published.provenance.validitySeconds, MEASURED_LEAD_SECONDS);
  assert.notEqual(MEASURED_LEAD_SECONDS, OVATION_VALIDITY_FLOOR_SECONDS);
  ingest.destroy();
});

test("a declared horizon is credited between the two bounds, and a bounded one is reported", async () => {
  // The rule first, as arithmetic: a snapshot that declares no lead would
  // expire on arrival, one that declares an impossible lead would never expire,
  // and the capture's own measured lead is between the two and untouched.
  assert.equal(
    ovationValiditySeconds({
      observedTimeMs: OBSERVED_MS,
      forecastTimeMs: FORECAST_MS,
    }),
    MEASURED_LEAD_SECONDS,
  );
  assert.equal(
    ovationValiditySeconds({
      observedTimeMs: OBSERVED_MS,
      forecastTimeMs: OBSERVED_MS,
    }),
    OVATION_VALIDITY_FLOOR_SECONDS,
  );
  assert.ok(MEASURED_LEAD_SECONDS < OVATION_VALIDITY_CEILING_SECONDS);

  // A year typo in Forecast Time: the lead reads 31,539,720 s, which is the
  // number that would otherwise say how long to keep believing the observation.
  const TYPO_LEAD_SECONDS = 31539720;
  const errors = [];
  const savedError = console.error;
  console.error = (message) => errors.push(String(message));
  const transport = scriptedTransport();
  const ingest = makeIngest(transport);
  try {
    transport.enqueue(
      OVATION_URL,
      syntheticOvationPayload({
        sample: () => 4,
        forecastTime: "2027-09-19T13:42:00Z",
      }),
    );
    transport.enqueue(KP_URL, kpRowsAt(OBSERVED_MS, 3));
    await ingest.refreshOnce(OBSERVED_MS);

    // The capture is kept and published whole -- a wrong forecast instant says
    // nothing about the grid beside it, and both instants are published as they
    // were declared. What is bounded is how long the observation is believed.
    const published = ingest.latest();
    assert.equal(ingest.diagnostics.payloadsRefused, 0);
    assert.equal(ingest.diagnostics.ovalOwner, "ovation");
    assert.equal(gridSample(published.oval, 90, 0), 4);
    assert.equal(published.forecastTimeMs, Date.parse("2027-09-19T13:42:00Z"));
    assert.equal(spaceWeatherForecastLeadSeconds(published), TYPO_LEAD_SECONDS);
    assert.equal(ingest.diagnostics.ovationLeadSeconds, TYPO_LEAD_SECONDS);
    assert.equal(
      ingest.diagnostics.ovationHorizonSeconds,
      OVATION_VALIDITY_CEILING_SECONDS,
    );
    assert.equal(
      published.provenance.validitySeconds,
      OVATION_VALIDITY_CEILING_SECONDS,
    );

    // And it expires on the bounded horizon rather than a year on: twice the
    // ceiling past the observation, the model no longer owns the oval.
    const expiredMs =
      OBSERVED_MS + 2 * OVATION_VALIDITY_CEILING_SECONDS * 1000 + 1;
    transport.enqueue(
      OVATION_URL,
      syntheticOvationPayload({
        sample: () => 4,
        forecastTime: "2027-09-19T13:42:00Z",
      }),
    );
    transport.enqueue(KP_URL, kpRowsAt(expiredMs, 3));
    await ingest.refreshOnce(expiredMs);

    assert.equal(ingest.diagnostics.ovalOwner, "kp");
    assert.equal(ingest.latestOwnership().reason, "ovation-stale");
    assert.equal(ingest.latestOwnership().ovationFreshness, "stale");
    assert.equal(ingest.latest().oval, undefined);
  } finally {
    console.error = savedError;
    ingest.destroy();
  }

  // Once per cycle that declares it, at the refusal log's rate: the operator is
  // told which number was declared and which one is being credited instead.
  assert.equal(errors.length, 2);
  assert.ok(errors[0].includes(`${TYPO_LEAD_SECONDS} s forecast lead`));
  assert.ok(errors[0].includes(`${OVATION_VALIDITY_CEILING_SECONDS} s`));
});

test("a transport that never settles cannot freeze the published decision", async () => {
  // One good cycle, then a transport that ignores its abort signal and never
  // answers. Nothing completes again, so every statement the ingest makes about
  // its own freshness from here on comes from the clock alone.
  const scripted = scriptedTransport();
  let settles = true;
  let hungRequests = 0;
  let tick;
  let wallMs = OBSERVED_MS;
  const ingest = makeIngest(scripted, {
    fetchJson: (url, signal) => {
      if (settles) {
        return scripted.fetchJson(url, signal);
      }
      ++hungRequests;
      return new Promise(() => {});
    },
    setTimeoutFunction: (handler) => {
      tick = handler;
      return 1;
    },
    nowFunction: () => wallMs,
  });

  scripted.enqueue(OVATION_URL, OVATION_FIXTURE);
  scripted.enqueue(KP_URL, kpRowsAt(OBSERVED_MS, 3));
  await ingest.start(OBSERVED_MS);
  assert.equal(ingest.diagnostics.ovalOwner, "ovation");
  assert.equal(ingest.diagnostics.payloadsParsed, 2);
  settles = false;

  // 62 minutes of declared horizon, stale past twice it, and the index bin
  // stops being current past twice its own three-hour cadence -- so the three
  // readings below are the three states a month of silence passes through,
  // every one of them reached without a single response.
  const seen = [];
  for (const minutes of [60, 130, 400]) {
    wallMs = OBSERVED_MS + minutes * 60000;
    tick();
    for (let turn = 0; turn < 6; ++turn) {
      await Promise.resolve();
    }
    const ownership = ingest.latestOwnership();
    seen.push([
      minutes,
      ingest.diagnostics.ovalOwner,
      ownership.ovationFreshness,
      ownership.reason,
    ]);
  }

  assert.deepEqual(seen, [
    [60, "ovation", "fresh", "ovation-current"],
    [130, "kp", "stale", "ovation-stale"],
    [400, "none", "stale", "ovation-stale"],
  ]);
  assert.equal(ingest.diagnostics.ownershipTransitions, 3);
  // Nothing arrived: no payload was parsed after the first cycle, and every
  // request issued since is still outstanding.
  assert.equal(ingest.diagnostics.payloadsParsed, 2);
  assert.equal(hungRequests, 6);
  // The handoff republishes once, so the grid the model has disowned stops
  // being served; the dark state has nothing to publish and keeps the last one.
  assert.equal(ingest.diagnostics.packetsBuilt, 2);
  assert.equal(ingest.latest().oval, undefined);
  assert.equal(ingest.latest().geomagnetic.kpIndex, 3);
  // Nothing was stopped: it is still polling, and it is still wrong about
  // nothing.
  assert.equal(ingest.isRunning, true);
  ingest.destroy();
});
