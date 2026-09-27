// solar-wind-flare-ingest.spec.mjs — the real-time solar-wind and X-ray ingest,
// its normalizers, the coupling estimate, and how it composes around the oval
// authority. Pure Node: no browser, no GPU, no network.
// @purpose Output contract for the solar-wind and flare ingest: frozen-fixture normalization, descending/ascending order normalization, active-source filtering, fill-by-name refusal, gaps and dropouts, instrument-source discovery, flare classification, coupling estimate, ownership gating, flare wall, time-regression and clock refusals, row-level exclusion of unreadable and future-stamped minutes, history, per-product requests and the request timeout, provider replacement, backoff under a fixed composition tick, the stop and destroy fences including from a listener or the transport, the composition key over the estimate's window, and zero cost on the render read.
// @status ACTIVE
//
// WHAT THIS SPEC IS FOR. Every assertion reads a value that came out of the real
// modules against the real captured bytes, or against a payload derived from
// them by a stated edit: a reading, a count, a refusal code, a packet field, an
// event. None greps source, and none asserts the shape of the implementation.
//
// THE CLAIMS, and why each is phrased the way it is:
//
//   1. THE FROZEN FIXTURES are the four captures served on 2026-09-26, pinned
//      by SHA-256 in their sidecar README. Their counts, instants and values are
//      asserted exactly, because each is a place a silent re-reading of the wire
//      format would move.
//   2. ORDER is asserted as output: the wire's first magnetometer row is its
//      newest, the normalized series is strictly ascending, and a reversed
//      payload normalizes to the identical series.
//   3. THE FILL is asserted by the name the refusal carries: a measured -9999
//      is excluded as "fill-value", not as a range fault, while the fill every
//      active magnetometer row carries in a flag column excludes nothing.
//   4. THE FLARE WALL is asserted as an equality: two compositions that differ
//      only in the X-ray payload publish identical geomagnetic channels and the
//      same oval object.
//   5. THE OWNERSHIP GATE is asserted against an authority packet that still
//      carries a model oval after the decision disowned it: nothing is drawn.
//   6. THE ESTIMATE is asserted against an independent recomputation from the
//      raw rows inside this spec, not against the module's own helpers.
//   7. THE PRODUCTS ARE INDEPENDENT: one product that answers later than the
//      poll interval is asserted to hold back no other product's channel, in
//      both directions, over the frozen payloads.
//   8. THE LIFECYCLE is asserted from outside: a stop, a destroy or a thrown
//      listener raised at each point the ingest calls out (the transport, a
//      listener, the timer) is followed by what the caller can observe - the
//      requests issued, the packet held, the refusals counted.
//
// RUNNER REQUIREMENT: Node >= 22.18 (built-in TypeScript stripping).
//   node --test Tools/visual-regression/solar-wind-flare-ingest.spec.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { enableEngineTsResolution } from "./lib/engine-ts-resolver.mjs";

enableEngineTsResolution();

const ENGINE = "../../packages/engine/Source/Scene/SpaceWeather/";
const {
  REAL_TIME_SOLAR_WIND_CADENCE_SECONDS,
  RealTimeSolarWindExclusion,
  RealTimeSolarWindRejectionCode,
  mergeRealTimeSolarWindHistory,
  normalizeRealTimeSolarWindPayload,
} = await import(`${ENGINE}RealTimeSolarWindNormalizer.ts`);
const {
  GoesInstrumentSourceRejectionCode,
  GoesXrayExclusion,
  GoesXrayRejectionCode,
  classifySolarXrayFlux,
  goesXrayPrimaryAt,
  normalizeGoesInstrumentSources,
  normalizeGoesXrayPayload,
} = await import(`${ENGINE}GoesXrayNormalizer.ts`);
const { estimateSolarWindActivity, newellCouplingRate, newellPlanetaryIndex } =
  await import(`${ENGINE}SolarWindCouplingEstimate.ts`);
const {
  FlareOmission,
  SOLAR_WIND_FLARE_MAX_BACKOFF_SECONDS,
  SOLAR_WIND_FLARE_REQUEST_TIMEOUT_SECONDS,
  SOLAR_WIND_VALIDITY_SECONDS,
  SolarWindFlareEventType,
  SolarWindFlareFeedIngest,
  SolarWindFlareIngestCode,
  SolarWindFlareProduct,
} = await import(`${ENGINE}SolarWindFlareFeedIngest.ts`);
const { transitionsBetween } = await import(
  `${ENGINE}SolarWindFlareFeedIngestHelpers.ts`
);
const { SpaceWeatherFeedIngest } = await import(
  `${ENGINE}SpaceWeatherFeedIngest.ts`
);
const { SPACE_WEATHER_CLOCK_SKEW_TOLERANCE_SECONDS, ovalForcingMultiplier } =
  await import(`${ENGINE}SpaceWeatherSourceAuthority.ts`);
const { auroraOvalIntensityScale, validateSpaceWeatherPacket } = await import(
  `${ENGINE}SpaceWeatherPacket.ts`
);

// ---------------------------------------------------------------------------
// The frozen captures.
// ---------------------------------------------------------------------------

const DATA_DIR = fileURLToPath(
  new URL("../../Specs/Data/SpaceWeather/", import.meta.url),
);

function readFixture(name) {
  return JSON.parse(readFileSync(`${DATA_DIR}${name}`, "utf8"));
}

/** A fresh deep copy, so a derived payload never edits the shared capture. */
function copy(value) {
  return JSON.parse(JSON.stringify(value));
}

const MAG = readFixture("rtsw_mag_1m.json");
const WIND = readFixture("rtsw_wind_1m.json");
const XRAYS = readFixture("xrays-1-day.json");
const SOURCES = readFixture("instrument-sources.json");
const OVATION = readFixture("ovation_aurora_latest.json");

/** Just after the last of the four fetches. */
const NOW = Date.parse("2026-09-26T16:23:04Z");
const MAG_NEWEST = Date.parse("2026-09-26T16:14:00Z");
const WIND_NEWEST = Date.parse("2026-09-26T16:13:00Z");
const XRAY_NEWEST = Date.parse("2026-09-26T16:17:00Z");
const OLDEST = Date.parse("2026-09-25T16:20:00Z");
const MINUTE = 60000;

const utc = (tag) => Date.parse(/Z$/.test(tag) ? tag : `${tag}Z`);

/** The payload as it would have been served at an instant: rows after it removed. */
function asServedAt(payload, instantMs) {
  return copy(payload).filter((row) => utc(row.time_tag) <= instantMs);
}

/** Every row's time_tag moved by a fixed interval, in the wire's own format. */
function shifted(payload, deltaMs) {
  return copy(payload).map((row) => {
    const zoned = /Z$/.test(row.time_tag);
    const moved = new Date(utc(row.time_tag) + deltaMs)
      .toISOString()
      .replace(/\.\d{3}Z$/, zoned ? "Z" : "");
    return { ...row, time_tag: moved };
  });
}

function activeRowIndex(payload, instantMs) {
  return payload.findIndex(
    (row) => row.active === true && utc(row.time_tag) === instantMs,
  );
}

function magnetometer(payload) {
  return normalizeRealTimeSolarWindPayload(payload, "magnetometer");
}

function plasma(payload) {
  return normalizeRealTimeSolarWindPayload(payload, "plasma");
}

// ---------------------------------------------------------------------------
// 1. The solar-wind normalizer over the frozen capture.
// ---------------------------------------------------------------------------

test("the frozen magnetometer capture normalizes to the active source's 1,435 minutes", () => {
  const result = magnetometer(MAG);
  assert.equal(result.status, "ok");
  const series = result.series;
  assert.equal(series.rowsRead, 3860);
  assert.equal(series.inactiveRows, 2425);
  assert.equal(series.readings.length, 1435);
  assert.deepEqual(
    { ...series.excluded },
    {
      "row-shape": 0,
      "active-flag": 0,
      "time-tag": 0,
      "ahead-of-clock": 0,
      "bad-quality": 0,
      "fill-value": 0,
      "missing-value": 0,
      "out-of-range": 0,
      "source-name": 0,
      "ambiguous-instant": 0,
    },
  );
  assert.deepEqual(series.gaps, []);
  assert.equal(series.sourceHandoffs, 0);
  assert.equal(series.readings[0].timeTagMs, OLDEST);
  assert.deepEqual(series.newest, {
    timeTagMs: MAG_NEWEST,
    sourceName: "SOLAR1",
    overallQuality: 0,
    btNanoTesla: 4.51,
    byGsmNanoTesla: 3.22,
    bzGsmNanoTesla: 2.82,
  });
});

test("the fill every active magnetometer row carries in a flag column excludes none of them", () => {
  const activeWithFlagFill = MAG.filter(
    (row) => row.active === true && row.max_data_flag === -9999,
  ).length;
  assert.equal(
    activeWithFlagFill,
    1435,
    "the capture no longer carries the case",
  );
  assert.equal(magnetometer(MAG).series.readings.length, activeWithFlagFill);
});

test("the frozen plasma capture keeps its three measured two-minute gaps", () => {
  const series = plasma(WIND).series;
  assert.equal(series.rowsRead, 3852);
  assert.equal(series.inactiveRows, 2421);
  assert.equal(series.readings.length, 1431);
  assert.deepEqual(series.gaps, [{ seconds: 120, count: 3 }]);
  assert.deepEqual(series.newest, {
    timeTagMs: WIND_NEWEST,
    sourceName: "SOLAR1",
    overallQuality: 0,
    speedKmPerSecond: 470.6,
    densityPerCubicCm: 5.39,
    temperatureKelvin: 157188,
  });
});

test("the gap histogram the 2026-08-06 day measured is reproduced from the frozen bytes", () => {
  // Eleven single active minutes and one pair of consecutive ones are removed
  // from stretches the capture has unbroken, which adds eleven 120 s gaps and
  // one 180 s gap to the three the capture already has.
  const payload = copy(WIND);
  const removed = [];
  const base = Date.parse("2026-09-25T18:00:00Z");
  for (let i = 0; i < 11; ++i) {
    removed.push(base + i * 10 * MINUTE);
  }
  removed.push(Date.parse("2026-09-25T22:00:00Z"));
  removed.push(Date.parse("2026-09-25T22:01:00Z"));
  for (const instant of removed) {
    const index = activeRowIndex(payload, instant);
    assert.ok(
      index >= 0,
      `no active row at ${new Date(instant).toISOString()}`,
    );
    payload.splice(index, 1);
  }
  const series = plasma(payload).series;
  assert.deepEqual(series.gaps, [
    { seconds: 120, count: 14 },
    { seconds: 180, count: 1 },
  ]);
  assert.equal(series.readings.length, 1431 - 13);
});

test("rows arrive newest first and the series is ascending; a reversed payload normalizes identically", () => {
  assert.equal(utc(MAG[0].time_tag) >= utc(MAG[MAG.length - 1].time_tag), true);
  const series = magnetometer(MAG).series;
  for (let i = 1; i < series.readings.length; ++i) {
    assert.ok(series.readings[i].timeTagMs > series.readings[i - 1].timeTagMs);
  }
  const reversed = magnetometer(copy(MAG).reverse()).series;
  assert.deepEqual(reversed.readings, series.readings);
  assert.equal(reversed.newest.timeTagMs, MAG_NEWEST);
});

test("a zoneless tag is read as UTC, whatever the host's offset", () => {
  const newestTag = MAG.find((row) => row.active === true).time_tag;
  assert.equal(/Z$|[+-]\d\d:?\d\d$/.test(newestTag), false);
  assert.equal(
    magnetometer(MAG).series.newest.timeTagMs,
    Date.parse(`${newestTag}Z`),
  );
});

test("a measured fill value is excluded by name, a range fault by range, a null as missing", () => {
  const cases = [
    ["bz_gsm", -9999, RealTimeSolarWindExclusion.FILL_VALUE, magnetometer, MAG],
    ["bt", -9999, RealTimeSolarWindExclusion.FILL_VALUE, magnetometer, MAG],
    [
      "proton_temperature",
      -9999,
      RealTimeSolarWindExclusion.FILL_VALUE,
      plasma,
      WIND,
    ],
    ["bz_gsm", 250, RealTimeSolarWindExclusion.OUT_OF_RANGE, magnetometer, MAG],
    [
      "proton_density",
      null,
      RealTimeSolarWindExclusion.MISSING_VALUE,
      plasma,
      WIND,
    ],
  ];
  for (const [field, value, code, normalize, fixture] of cases) {
    const payload = copy(fixture);
    const index = payload.findIndex((row) => row.active === true);
    payload[index][field] = value;
    const series = normalize(payload).series;
    const expected = normalize(fixture).series.readings.length - 1;
    assert.equal(series.excluded[code], 1, `${field}=${value}`);
    assert.equal(series.readings.length, expected, `${field}=${value}`);
    const others = Object.entries(series.excluded)
      .filter(([name]) => name !== code)
      .reduce((sum, [, count]) => sum + count, 0);
    assert.equal(others, 0, `${field}=${value} was also counted elsewhere`);
  }
});

test("a row whose quality is not the good value is excluded and counted", () => {
  const payload = copy(MAG);
  let flipped = 0;
  for (const row of payload) {
    if (row.active === true && flipped < 5) {
      row.overall_quality = 1;
      ++flipped;
    }
  }
  const series = magnetometer(payload).series;
  assert.equal(series.excluded["bad-quality"], 5);
  assert.equal(series.readings.length, 1430);
});

test("only the active spacecraft is read, and two active rows at one instant are both left out", () => {
  const demoted = copy(MAG);
  demoted[activeRowIndex(demoted, MAG_NEWEST)].active = false;
  const demotedSeries = magnetometer(demoted).series;
  assert.equal(demotedSeries.inactiveRows, 2426);
  assert.equal(demotedSeries.newest.timeTagMs, MAG_NEWEST - MINUTE);

  const doubled = copy(MAG);
  const standby = doubled.findIndex(
    (row) => row.active === false && utc(row.time_tag) === MAG_NEWEST - MINUTE,
  );
  assert.ok(standby >= 0);
  doubled[standby].active = true;
  const doubledSeries = magnetometer(doubled).series;
  assert.equal(doubledSeries.excluded["ambiguous-instant"], 2);
  assert.equal(doubledSeries.readings.length, 1434);
  assert.equal(doubledSeries.gaps[0].seconds, 120);
});

test("a change of active spacecraft is counted along the series", () => {
  const payload = copy(MAG);
  let renamed = 0;
  for (const row of payload) {
    if (row.active === true && renamed < 30) {
      row.source = "ACE";
      ++renamed;
    }
  }
  const series = magnetometer(payload).series;
  assert.equal(series.sourceHandoffs, 1);
  assert.equal(series.newest.sourceName, "ACE");
  assert.equal(
    series.readings[series.readings.length - 31].sourceName,
    "SOLAR1",
  );
});

test("a payload whose shape is wrong, or that has nothing usable, is refused with its own code", () => {
  const row = copy(MAG[0]);
  const cases = [
    [{}, RealTimeSolarWindRejectionCode.NOT_AN_ARRAY],
    [[], RealTimeSolarWindRejectionCode.EMPTY],
    [[7, "row", null], RealTimeSolarWindRejectionCode.ROW_SHAPE],
    [[{ ...row, active: "true" }], RealTimeSolarWindRejectionCode.ACTIVE_FLAG],
    [
      copy(MAG).map((r) => ({ ...r, active: false })),
      RealTimeSolarWindRejectionCode.NO_USABLE_ROWS,
    ],
  ];
  for (const [payload, code] of cases) {
    const result = magnetometer(payload);
    assert.equal(result.status, "refused");
    assert.equal(result.error.code, code);
    assert.equal(result.series, undefined);
  }
});

test("an unreadable time tag costs its row: counted on an active row, never read on a standby one", () => {
  const payload = copy(MAG);
  const standby = payload.findIndex((row) => row.active === false);
  payload[standby].time_tag = null;
  const active = activeRowIndex(payload, MAG_NEWEST - 30 * MINUTE);
  payload[active].time_tag = "yesterday";
  const series = magnetometer(payload).series;
  assert.equal(series.inactiveRows, 2425);
  assert.equal(series.readings.length, 1434);
  assert.equal(series.excluded[RealTimeSolarWindExclusion.TIME_TAG], 1);
  assert.equal(series.newest.timeTagMs, MAG_NEWEST);
  const unreadable = magnetometer(
    copy(MAG).map((row) => ({ ...row, time_tag: "yesterday" })),
  );
  assert.equal(unreadable.status, "refused");
  assert.equal(
    unreadable.error.code,
    RealTimeSolarWindRejectionCode.NO_USABLE_ROWS,
  );

  const xrays = copy(XRAYS);
  const long = xrays.findIndex(
    (row) => row.energy === "0.1-0.8nm" && utc(row.time_tag) === XRAY_NEWEST,
  );
  xrays[long].time_tag = null;
  const xraySeries = normalizeGoesXrayPayload(xrays, 18).series;
  assert.equal(xraySeries.excluded[GoesXrayExclusion.TIME_TAG], 1);
  assert.equal(xraySeries.longBand.length, 1351);
  assert.equal(xraySeries.newest.timeTagMs, XRAY_NEWEST - MINUTE);
});

test("history is merged by instant and trimmed to the window measured from its newest reading", () => {
  const today = plasma(WIND).series;
  const tomorrow = plasma(shifted(WIND, 86400000)).series;
  const twoDays = mergeRealTimeSolarWindHistory(today, tomorrow, 2 * 86400);
  assert.equal(twoDays.readings.length, 2862);
  assert.equal(twoDays.readings[0].timeTagMs, OLDEST);
  assert.equal(twoDays.newest.timeTagMs, WIND_NEWEST + 86400000);
  // One day back from tomorrow's newest reaches exactly today's newest minute.
  const oneDay = mergeRealTimeSolarWindHistory(today, tomorrow, 86400);
  assert.equal(oneDay.readings[0].timeTagMs, WIND_NEWEST);
  assert.equal(oneDay.readings.length, 1432);
  // A held reading the caller can no longer credit is not carried forward.
  const bounded = mergeRealTimeSolarWindHistory(
    tomorrow,
    today,
    86400,
    (timeTagMs) => timeTagMs <= WIND_NEWEST,
  );
  assert.equal(bounded.newest.timeTagMs, WIND_NEWEST);
  assert.equal(bounded.readings.length, 1431);
});

// ---------------------------------------------------------------------------
// 2. The X-ray normalizer and the instrument-source mapping.
// ---------------------------------------------------------------------------

test("the frozen X-ray capture splits into two bands and reports its two measured dropouts", () => {
  const result = normalizeGoesXrayPayload(XRAYS, 18);
  assert.equal(result.status, "ok");
  const series = result.series;
  assert.equal(series.rowsRead, 2876);
  assert.equal(series.longBand.length, 1352);
  assert.equal(series.shortBand.length, 1352);
  assert.equal(series.excluded.dropout, 172);
  assert.equal(series.excluded["not-primary"], 0);
  assert.deepEqual(
    series.dropouts.map((run) => [
      new Date(run.startMs).toISOString(),
      new Date(run.endMs).toISOString(),
      run.minutes,
    ]),
    [
      ["2026-09-25T17:13:00.000Z", "2026-09-25T17:32:00.000Z", 20],
      ["2026-09-26T08:26:00.000Z", "2026-09-26T09:31:00.000Z", 66],
    ],
  );
  assert.deepEqual(series.newest, {
    timeTagMs: XRAY_NEWEST,
    satellite: 18,
    flux: 4.905103878627415e-7,
    electronContaminated: false,
  });
  assert.equal(series.primarySatellite, 18);
});

test("the X-ray bands are ascending on the wire and a reversed payload normalizes identically", () => {
  assert.ok(utc(XRAYS[0].time_tag) < utc(XRAYS[XRAYS.length - 1].time_tag));
  const series = normalizeGoesXrayPayload(XRAYS).series;
  const reversed = normalizeGoesXrayPayload(copy(XRAYS).reverse()).series;
  assert.deepEqual(reversed.longBand, series.longBand);
  assert.deepEqual(reversed.shortBand, series.shortBand);
  assert.equal(reversed.newest.timeTagMs, XRAY_NEWEST);
});

test("the contamination flag is read under the payload's own spelling", () => {
  // The long band carries no usable contaminated minute in this capture; the
  // short band carries 1,246, so that is where the spelling is exercised.
  const raw = XRAYS.filter(
    (row) =>
      row.energy === "0.05-0.4nm" && row.flux > 0 && row.electron_contaminaton,
  ).length;
  assert.equal(raw, 1246);
  const series = normalizeGoesXrayPayload(XRAYS).series;
  assert.equal(
    series.shortBand.filter((reading) => reading.electronContaminated).length,
    raw,
  );
  const respelled = copy(XRAYS).map(({ electron_contaminaton, ...rest }) => ({
    ...rest,
    electron_contamination: electron_contaminaton,
  }));
  assert.equal(
    normalizeGoesXrayPayload(respelled).series.shortBand.filter(
      (reading) => reading.electronContaminated,
    ).length,
    0,
  );
});

test("a fill flux is excluded by name and is not mistaken for an eclipse minute", () => {
  const payload = copy(XRAYS);
  const index = payload.findIndex(
    (row) => row.energy === "0.1-0.8nm" && row.flux > 0,
  );
  payload[index].flux = -9999;
  const series = normalizeGoesXrayPayload(payload).series;
  assert.equal(series.excluded[GoesXrayExclusion.FILL_VALUE], 1);
  assert.equal(series.excluded[GoesXrayExclusion.DROPOUT], 172);
  assert.equal(series.longBand.length, 1351);
});

test("the instrument-source mapping is a history read at an instant, not a first row", () => {
  const result = normalizeGoesInstrumentSources(SOURCES);
  assert.equal(result.status, "ok");
  assert.equal(SOURCES.length, 6);
  assert.equal(result.sources.entries.length, 5);
  assert.equal(result.sources.ambiguousInstants, 0);
  assert.equal(goesXrayPrimaryAt(result.sources, NOW), 18);
  assert.equal(
    goesXrayPrimaryAt(result.sources, Date.parse("2026-09-22T15:00:00Z")),
    19,
  );
  assert.equal(
    goesXrayPrimaryAt(result.sources, Date.parse("2026-09-22T14:00:00Z")),
    undefined,
  );

  const disagreeing = copy(SOURCES);
  disagreeing[1].xrays.primary = 19;
  const ambiguous = normalizeGoesInstrumentSources(disagreeing).sources;
  assert.equal(ambiguous.ambiguousInstants, 1);
  assert.equal(ambiguous.entries.length, 4);

  assert.equal(
    normalizeGoesInstrumentSources([{ time_tag: "2026-09-22T18:43:22Z" }]).error
      .code,
    GoesInstrumentSourceRejectionCode.FIELD_MISSING,
  );
});

test("rows from a spacecraft that is not the discovered primary are excluded, and all of them refuse the payload", () => {
  const result = normalizeGoesXrayPayload(XRAYS, 19);
  assert.equal(result.status, "refused");
  assert.equal(result.error.code, GoesXrayRejectionCode.NO_USABLE_ROWS);
  const unfiltered = normalizeGoesXrayPayload(XRAYS);
  assert.equal(unfiltered.series.primarySatellite, undefined);
  assert.equal(unfiltered.series.longBand.length, 1352);
});

test("flux is classified on the standard decade scale", () => {
  assert.deepEqual(classifySolarXrayFlux(1e-8), {
    flareClass: "A",
    magnitude: 1,
  });
  assert.deepEqual(classifySolarXrayFlux(4.905103878627415e-7), {
    flareClass: "B",
    magnitude: 4.905103878627415,
  });
  assert.deepEqual(
    classifySolarXrayFlux(1.6022980844354606e-6).flareClass,
    "C",
  );
  assert.deepEqual(classifySolarXrayFlux(1e-5), {
    flareClass: "M",
    magnitude: 1,
  });
  assert.deepEqual(classifySolarXrayFlux(2.5e-4).flareClass, "X");
  assert.ok(Math.abs(classifySolarXrayFlux(1.2e-3).magnitude - 12) < 1e-12);
  assert.equal(classifySolarXrayFlux(5e-9), undefined);
  const max = normalizeGoesXrayPayload(XRAYS).series.longBand.reduce((a, b) =>
    b.flux > a.flux ? b : a,
  );
  assert.equal(
    new Date(max.timeTagMs).toISOString(),
    "2026-09-26T13:27:00.000Z",
  );
  assert.equal(classifySolarXrayFlux(max.flux).flareClass, "C");
});

// ---------------------------------------------------------------------------
// 3. The coupling estimate.
// ---------------------------------------------------------------------------

test("the estimate over the frozen capture equals an independent recomputation from the raw rows", () => {
  const estimate = estimateSolarWindActivity(
    plasma(WIND).series.readings,
    magnetometer(MAG).series.readings,
    WIND_NEWEST,
  );
  // Independent: straight from the wire rows, no module helper.
  const windowStart = WIND_NEWEST - 3 * 3600 * 1000;
  const fields = new Map();
  for (const row of MAG) {
    const t = utc(row.time_tag);
    if (row.active === true && t > windowStart && t <= WIND_NEWEST) {
      fields.set(Math.floor(t / MINUTE), row);
    }
  }
  let n = 0;
  let merging = 0;
  let viscous = 0;
  for (const row of WIND) {
    const t = utc(row.time_tag);
    if (row.active !== true || t <= windowStart || t > WIND_NEWEST) {
      continue;
    }
    const field = fields.get(Math.floor(t / MINUTE));
    if (field === undefined) {
      continue;
    }
    const transverse = Math.sqrt(field.by_gsm ** 2 + field.bz_gsm ** 2);
    const clock = Math.atan2(field.by_gsm, field.bz_gsm);
    merging +=
      row.proton_speed ** (4 / 3) *
      transverse ** (2 / 3) *
      Math.abs(Math.sin(clock / 2)) ** (8 / 3);
    viscous += Math.sqrt(row.proton_density) * row.proton_speed ** 2;
    ++n;
  }
  const kp = 0.05 + (2.244e-4 * merging) / n + (2.844e-6 * viscous) / n;
  assert.equal(estimate.pairedMinutes, n);
  assert.equal(n, 179);
  assert.ok(Math.abs(estimate.estimatedKpIndex - kp) < 1e-12);
  assert.ok(Math.abs(estimate.estimatedKpIndex - 1.8944571571040658) < 1e-12);
  assert.ok(Math.abs(estimate.activity - kp / 9) < 1e-12);
  assert.equal(estimate.newestMs, WIND_NEWEST);
});

test("the coupling rate is zero for a northward field and ignores the sunward component", () => {
  assert.equal(newellCouplingRate(400, 0, 5), 0);
  assert.equal(newellCouplingRate(400, 0, 0), 0);
  const southward = newellCouplingRate(400, 0, -5);
  assert.ok(Math.abs(southward - 400 ** (4 / 3) * 5 ** (2 / 3)) < 1e-9);
  const reading = (t, bt) => ({
    timeTagMs: t,
    sourceName: "S",
    overallQuality: 0,
    btNanoTesla: bt,
    byGsmNanoTesla: 0,
    bzGsmNanoTesla: 5,
    speedKmPerSecond: 400,
    densityPerCubicCm: 4,
    temperatureKelvin: 1e5,
  });
  const quiet = estimateSolarWindActivity([reading(0, 5)], [reading(0, 5)], 0);
  const sunward = estimateSolarWindActivity(
    [reading(0, 40)],
    [reading(0, 40)],
    0,
  );
  assert.equal(sunward.estimatedKpIndex, quiet.estimatedKpIndex);
  assert.ok(
    Math.abs(quiet.estimatedKpIndex - newellPlanetaryIndex(0, 4, 400)) < 1e-12,
  );
});

// ---------------------------------------------------------------------------
// 4. The ingest.
// ---------------------------------------------------------------------------

const URL_MAG = "test://mag";
const URL_WIND = "test://wind";
const URL_XRAY = "test://xray";
const URL_SOURCES = "test://sources";

/** Let every settled answer and the work it queues run. */
async function flush() {
  for (let i = 0; i < 4; ++i) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise: promise, resolve: resolve, reject: reject };
}

/**
 * A transport serving one payload per product, like a cache, until a product's
 * answer is replaced. A function answer is called per request.
 */
function feed(answers) {
  const calls = [];
  const current = { ...answers };
  return {
    calls: calls,
    set(url, answer) {
      current[url] = answer;
    },
    fetchJson(url, signal) {
      calls.push({ url: url, signal: signal });
      const answer = current[url];
      if (answer === undefined) {
        return Promise.reject(new Error(`nothing served at ${url}`));
      }
      if (typeof answer === "function") {
        return answer();
      }
      return Promise.resolve(answer);
    },
  };
}

function capturedFeed() {
  return feed({
    [URL_MAG]: MAG,
    [URL_WIND]: WIND,
    [URL_XRAY]: XRAYS,
    [URL_SOURCES]: SOURCES,
  });
}

function makeIngest(transport, overrides) {
  const timers = [];
  const ingest = new SolarWindFlareFeedIngest({
    fetchJson: transport.fetchJson,
    magnetometerUrl: URL_MAG,
    plasmaUrl: URL_WIND,
    xrayUrl: URL_XRAY,
    instrumentSourcesUrl: URL_SOURCES,
    setTimeoutFunction: (handler, delay) => {
      timers.push({ handler: handler, delay: delay, cleared: false });
      return timers.length;
    },
    clearTimeoutFunction: (handle) => {
      timers[handle - 1].cleared = true;
    },
    ...overrides,
  });
  return { ingest: ingest, timers: timers };
}

function liveTimer(timers) {
  const live = timers.filter((timer) => !timer.cleared);
  return live[live.length - 1];
}

/** An authority that reports whatever decision and packet it is given. */
function fixedAuthority(packet, owner) {
  return {
    latest: () => packet,
    latestOwnership: () =>
      owner === undefined
        ? undefined
        : Object.freeze({
            owner: owner,
            reason: "ovation-current",
            previousOwner: owner,
            changed: false,
            kpVisible: false,
          }),
  };
}

/** The frozen auroral capture restamped so it is current at NOW; 62-minute lead kept. */
function currentOvation() {
  return {
    ...OVATION,
    "Observation Time": "2026-09-26T16:10:00Z",
    "Forecast Time": "2026-09-26T17:12:00Z",
  };
}

function kpRowsAt(instantMs, kp) {
  const tag = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "");
  return [
    {
      time_tag: tag(instantMs - 10800000),
      Kp: kp,
      a_running: 5,
      station_count: 8,
    },
    { time_tag: tag(instantMs), Kp: kp, a_running: 5, station_count: 8 },
  ];
}

/** The real auroral ingest, current at NOW, as the authority. */
async function realAuthority(kp) {
  const answers = {
    "test://ovation": currentOvation(),
    "test://kp":
      kp === undefined ? [] : kpRowsAt(Date.parse("2026-09-26T15:00:00Z"), kp),
  };
  const authority = new SpaceWeatherFeedIngest({
    fetchJson: (url) => Promise.resolve(answers[url]),
    ovationUrl: "test://ovation",
    planetaryKpUrl: "test://kp",
    setTimeoutFunction: () => 1,
    clearTimeoutFunction: () => {},
  });
  const errors = console.error;
  console.error = () => {};
  try {
    await authority.refreshOnce(NOW);
  } finally {
    console.error = errors;
  }
  return authority;
}

const RTSW_ACTIVITY = 1.8944571571040658 / 9;

test("constructing the ingest issues nothing; the first request comes from start", async () => {
  const transport = capturedFeed();
  const { ingest, timers } = makeIngest(transport);
  assert.equal(transport.calls.length, 0);
  assert.equal(timers.length, 0);
  assert.equal(ingest.latest(), undefined);
  assert.equal(ingest.diagnostics.packetsBuilt, 0);
  await ingest.start(NOW);
  assert.equal(transport.calls.length, 4);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 60000);
  ingest.destroy();
});

test("with no authority the solar wind is the activity scalar, stamped as such, and there is no oval", async () => {
  const { ingest } = makeIngest(capturedFeed());
  await ingest.start(NOW);
  const packet = ingest.latest();
  assert.equal(validateSpaceWeatherPacket(packet).valid, true);
  assert.ok(packet.oval === undefined, "an oval was drawn");
  assert.equal(packet.geomagnetic.authority, "rtsw");
  assert.ok(Math.abs(packet.geomagnetic.activity - RTSW_ACTIVITY) < 1e-12);
  assert.equal(packet.geomagnetic.bzNanoTesla, 2.82);
  assert.equal(packet.geomagnetic.kpIndex, undefined);
  assert.equal(packet.provenance.kind, "model");
  assert.equal(packet.provenance.validitySeconds, SOLAR_WIND_VALIDITY_SECONDS);
  assert.equal(packet.observedTimeMs, WIND_NEWEST);
  assert.deepEqual(
    { ...packet.solarWind },
    {
      authority: "rtsw",
      sourceName: "SOLAR1",
      speedKmPerSecond: 470.6,
      densityPerCubicCm: 5.39,
      temperatureKelvin: 157188,
      btNanoTesla: 4.51,
      bzGsmNanoTesla: 2.82,
      overallQuality: 0,
    },
  );
  const shortBand = XRAYS.find(
    (row) => row.energy === "0.05-0.4nm" && utc(row.time_tag) === XRAY_NEWEST,
  ).flux;
  assert.deepEqual(
    { ...packet.flare },
    {
      authority: "goes",
      flareClass: "B",
      magnitude: 4.905103878627415,
      longBandFluxWattsPerSquareMeter: 4.905103878627415e-7,
      shortBandFluxWattsPerSquareMeter: shortBand,
      observedTimeMs: XRAY_NEWEST,
    },
  );
  const diagnostics = ingest.diagnostics;
  assert.equal(diagnostics.activityAuthority, "rtsw");
  assert.equal(diagnostics.primarySatellite, 18);
  assert.equal(diagnostics.solarWindFreshness, "fresh");
  assert.equal(diagnostics.flareFreshness, "fresh");
  assert.equal(diagnostics.payloadsRefused, 0);
  ingest.destroy();
});

test("a model-owned oval is carried through by identity and nothing from the solar wind touches it", async () => {
  const authority = await realAuthority(3);
  const base = authority.latest();
  assert.equal(authority.latestOwnership().owner, "ovation");
  const { ingest } = makeIngest(capturedFeed(), { authority: authority });
  await ingest.start(NOW);
  const packet = ingest.latest();
  assert.ok(packet.oval === base.oval, "the grid was rebuilt or replaced");
  assert.deepEqual({ ...packet.geomagnetic }, { ...base.geomagnetic });
  assert.equal(packet.geomagnetic.authority, "kp");
  assert.ok(Math.abs(packet.geomagnetic.activity - 3 / 9) < 1e-15);
  assert.notEqual(packet.geomagnetic.activity, RTSW_ACTIVITY);
  assert.equal(auroraOvalIntensityScale(packet), 1);
  assert.equal(ovalForcingMultiplier("ovation", RTSW_ACTIVITY), 1);
  assert.deepEqual({ ...packet.provenance }, { ...base.provenance });
  assert.equal(packet.observedTimeMs, base.observedTimeMs);
  assert.equal(packet.solarWind.bzGsmNanoTesla, 2.82);
  assert.equal(packet.flare.flareClass, "B");
  assert.equal(validateSpaceWeatherPacket(packet).valid, true);
  assert.equal(ingest.diagnostics.ovalOwner, "ovation");
  ingest.destroy();
  authority.destroy();
});

test("under the planetary index the index keeps the scalar; the estimate is only a diagnostic", async () => {
  const base = {
    version: 1,
    provenance: {
      sourceId: "noaa-planetary-kp",
      kind: "observed",
      validitySeconds: 10800,
    },
    observedTimeMs: NOW - 3600000,
    forecastTimeMs: NOW - 3600000,
    geomagnetic: { activity: 3 / 9, authority: "kp", kpIndex: 3 },
  };
  const { ingest } = makeIngest(capturedFeed(), {
    authority: fixedAuthority(base, "kp"),
  });
  await ingest.start(NOW);
  const packet = ingest.latest();
  assert.equal(packet.geomagnetic.authority, "kp");
  assert.equal(packet.geomagnetic.activity, 3 / 9);
  assert.ok(packet.oval === undefined, "an oval was drawn");
  assert.ok(
    Math.abs(ingest.diagnostics.estimate.activity - RTSW_ACTIVITY) < 1e-12,
  );
  ingest.destroy();
});

test("an oval the decision disowned is not drawn, even though the authority's packet still carries it", async () => {
  const authority = await realAuthority(undefined);
  const disowned = fixedAuthority(authority.latest(), "none");
  assert.ok(authority.latest().oval !== undefined);
  const { ingest } = makeIngest(capturedFeed(), { authority: disowned });
  await ingest.start(NOW);
  const packet = ingest.latest();
  assert.ok(packet.oval === undefined, "an oval was drawn");
  assert.equal(packet.geomagnetic.authority, "rtsw");
  assert.ok(Math.abs(packet.geomagnetic.activity - RTSW_ACTIVITY) < 1e-12);
  assert.equal(ingest.diagnostics.ovalOwner, "none");

  // The index owns the oval but the packet in hand is still the model's: the
  // decision governs, so the scalar is the packet's own and no grid is drawn.
  const byIndex = makeIngest(capturedFeed(), {
    authority: fixedAuthority(authority.latest(), "kp"),
  }).ingest;
  await byIndex.start(NOW);
  assert.ok(byIndex.latest().oval === undefined, "an oval was drawn");
  assert.deepEqual(
    { ...byIndex.latest().geomagnetic },
    { ...authority.latest().geomagnetic },
  );
  byIndex.destroy();

  // A synthetic shape stamped for the index is the index's to draw.
  const model = authority.latest();
  const synthetic = {
    ...model,
    geomagnetic: { activity: 3 / 9, authority: "kp", kpIndex: 3 },
    oval: { ...model.oval, authority: "synthetic" },
  };
  const shaped = makeIngest(capturedFeed(), {
    authority: fixedAuthority(synthetic, "kp"),
  }).ingest;
  await shaped.start(NOW);
  assert.ok(shaped.latest().oval === synthetic.oval);
  assert.equal(auroraOvalIntensityScale(shaped.latest()), 3 / 9);
  shaped.destroy();
  ingest.destroy();
  authority.destroy();
});

test("a product re-serving the same minutes does not republish the packet", async () => {
  const transport = capturedFeed();
  const { ingest } = makeIngest(transport);
  await ingest.start(NOW);
  const first = ingest.latest();
  transport.set(URL_MAG, copy(MAG));
  transport.set(URL_WIND, copy(WIND));
  transport.set(URL_XRAY, copy(XRAYS));
  await ingest.refreshOnce(NOW + MINUTE);
  assert.ok(ingest.latest() === first, "identical minutes rebuilt the packet");
  assert.equal(ingest.diagnostics.packetsBuilt, 1);
  ingest.destroy();
});

test("a decision whose packet is past its own declared horizon is not composed", async () => {
  const authority = await realAuthority(3);
  const base = authority.latest();
  // The same decision read ten hours on, as a stopped authority would report it.
  const later = NOW + 10 * 3600 * 1000;
  const { ingest } = makeIngest(
    feed({
      [URL_MAG]: shifted(MAG, 10 * 3600 * 1000),
      [URL_WIND]: shifted(WIND, 10 * 3600 * 1000),
      [URL_XRAY]: shifted(XRAYS, 10 * 3600 * 1000),
      [URL_SOURCES]: SOURCES,
    }),
    { authority: fixedAuthority(base, "ovation") },
  );
  await ingest.start(later);
  const packet = ingest.latest();
  assert.equal(ingest.diagnostics.authorityPacketFreshness, "stale");
  assert.ok(packet.oval === undefined, "an oval was drawn");
  assert.equal(packet.geomagnetic.authority, "rtsw");
  ingest.destroy();
  authority.destroy();
});

test("a flare changes the flare channel and nothing else, under every owner", async () => {
  const flaring = copy(XRAYS);
  for (const row of flaring) {
    if (row.energy === "0.1-0.8nm" && utc(row.time_tag) === XRAY_NEWEST) {
      row.flux = 5e-4;
    }
  }
  const authority = await realAuthority(3);
  for (const make of [() => undefined, () => authority]) {
    const quiet = makeIngest(capturedFeed(), { authority: make() }).ingest;
    const events = [];
    const loud = makeIngest(
      feed({
        [URL_MAG]: MAG,
        [URL_WIND]: WIND,
        [URL_XRAY]: flaring,
        [URL_SOURCES]: SOURCES,
      }),
      { authority: make() },
    ).ingest;
    loud.addEventListener((event) => events.push(event));
    await quiet.start(NOW);
    await loud.start(NOW);
    const a = quiet.latest();
    const b = loud.latest();
    assert.equal(a.flare.flareClass, "B");
    assert.equal(b.flare.flareClass, "X");
    assert.ok(Math.abs(b.flare.magnitude - 5) < 1e-12);
    assert.deepEqual({ ...b.geomagnetic }, { ...a.geomagnetic });
    assert.ok(a.oval === b.oval);
    assert.deepEqual({ ...b.solarWind }, { ...a.solarWind });
    assert.ok(
      events.some(
        (event) =>
          event.type === SolarWindFlareEventType.FLARE_CLASS_CHANGE &&
          event.current === "X",
      ),
    );
    quiet.destroy();
    loud.destroy();
  }
  authority.destroy();
});

test("a flux the packet cannot carry costs the flare channel, not the geomagnetic state", async () => {
  const extreme = copy(XRAYS);
  for (const row of extreme) {
    if (row.energy === "0.1-0.8nm" && utc(row.time_tag) === XRAY_NEWEST) {
      row.flux = 1.2e-3;
    }
  }
  const errors = [];
  const saved = console.error;
  console.error = (message) => errors.push(message);
  const { ingest } = makeIngest(
    feed({
      [URL_MAG]: MAG,
      [URL_WIND]: WIND,
      [URL_XRAY]: extreme,
      [URL_SOURCES]: SOURCES,
    }),
  );
  try {
    await ingest.start(NOW);
  } finally {
    console.error = saved;
  }
  const packet = ingest.latest();
  assert.equal(packet.flare, undefined);
  assert.equal(packet.geomagnetic.authority, "rtsw");
  assert.equal(ingest.diagnostics.flareOmission, FlareOmission.INVALID_PACKET);
  assert.equal(ingest.diagnostics.lastFailure.product, "goes-xray");
  assert.equal(ingest.diagnostics.lastFailure.code, "invalid-packet");
  assert.equal(errors.length, 1);
  assert.match(errors[0], /goes-xray payload refused \(invalid-packet\)/);

  const dim = copy(XRAYS);
  for (const row of dim) {
    if (row.energy === "0.1-0.8nm" && utc(row.time_tag) === XRAY_NEWEST) {
      row.flux = 5e-9;
    }
  }
  const second = makeIngest(
    feed({
      [URL_MAG]: MAG,
      [URL_WIND]: WIND,
      [URL_XRAY]: dim,
      [URL_SOURCES]: SOURCES,
    }),
  ).ingest;
  await second.start(NOW);
  assert.equal(second.latest().flare, undefined);
  assert.equal(
    second.diagnostics.flareOmission,
    FlareOmission.BELOW_CLASS_FLOOR,
  );
  assert.equal(second.diagnostics.payloadsRefused, 0);
  ingest.destroy();
  second.destroy();
});

test("inside the eclipse dropout the flare channel goes stale while the solar wind carries on", async () => {
  const at = Date.parse("2026-09-26T09:00:00Z");
  const { ingest } = makeIngest(
    feed({
      [URL_MAG]: asServedAt(MAG, at),
      [URL_WIND]: asServedAt(WIND, at),
      [URL_XRAY]: asServedAt(XRAYS, at),
      [URL_SOURCES]: SOURCES,
    }),
  );
  await ingest.start(at);
  const packet = ingest.latest();
  assert.equal(packet.flare, undefined);
  assert.equal(ingest.diagnostics.flareOmission, FlareOmission.STALE);
  assert.equal(ingest.diagnostics.flareFreshness, "stale");
  assert.equal(
    ingest.diagnostics.xray.newest.timeTagMs,
    Date.parse("2026-09-26T08:25:00Z"),
  );
  assert.equal(packet.geomagnetic.authority, "rtsw");
  assert.equal(ingest.diagnostics.solarWindFreshness, "fresh");
  ingest.destroy();
});

test("a payload older than the one held is refused and the held series stays", async () => {
  const transport = capturedFeed();
  const { ingest } = makeIngest(transport);
  await ingest.start(NOW);
  const errors = [];
  const saved = console.error;
  console.error = (message) => errors.push(message);
  try {
    transport.set(URL_MAG, asServedAt(MAG, MAG_NEWEST - 60 * MINUTE));
    transport.set(URL_XRAY, asServedAt(XRAYS, XRAY_NEWEST - 60 * MINUTE));
    await ingest.refreshOnce(NOW + MINUTE);
  } finally {
    console.error = saved;
  }
  const diagnostics = ingest.diagnostics;
  assert.equal(diagnostics.payloadsRefused, 2);
  assert.equal(
    diagnostics.lastFailure.code,
    SolarWindFlareIngestCode.TIME_REGRESSION,
  );
  assert.equal(
    diagnostics.lastFailure.product,
    SolarWindFlareProduct.GOES_XRAY,
  );
  assert.equal(diagnostics.magnetometer.newest.timeTagMs, MAG_NEWEST);
  assert.equal(diagnostics.xray.newest.timeTagMs, XRAY_NEWEST);
  assert.equal(ingest.latest().flare.observedTimeMs, XRAY_NEWEST);
  assert.equal(errors.length, 1);
  ingest.destroy();
});

test("a payload stamped ahead of the clock is refused, and one the clock contradicts no longer defends itself", async () => {
  const transport = capturedFeed();
  const { ingest } = makeIngest(transport);
  const saved = console.error;
  console.error = () => {};
  try {
    // Two days ahead: every minute the payload carries is past the tolerance,
    // so nothing in it is credible.
    transport.set(URL_WIND, shifted(WIND, 2 * 86400000));
    await ingest.start(NOW);
    assert.equal(ingest.diagnostics.lastFailure.code, "implausible-time");
    assert.equal(ingest.diagnostics.lastFailure.product, "rtsw-plasma");
    assert.equal(ingest.diagnostics.plasma, undefined);

    // The clock steps back an hour: the held magnetometer instant is now one
    // the clock cannot believe, so an older payload is taken rather than
    // refused as a regression.
    const earlier = NOW - 3600000;
    transport.set(URL_WIND, asServedAt(WIND, earlier));
    transport.set(URL_MAG, asServedAt(MAG, earlier));
    await ingest.refreshOnce(earlier);
  } finally {
    console.error = saved;
  }
  // Held minutes past the tolerance are dropped; the ones inside it are kept.
  assert.equal(
    ingest.diagnostics.magnetometer.newest.timeTagMs,
    Date.parse("2026-09-26T15:28:00Z"),
  );
  assert.equal(
    ingest.diagnostics.plasma.newest.timeTagMs,
    Date.parse("2026-09-26T15:23:00Z"),
  );
  assert.equal(
    ingest.latest().observedTimeMs,
    Date.parse("2026-09-26T15:23:00Z"),
  );
  ingest.destroy();
});

test("a minute stamped ahead of the clock costs that minute, not the day", async () => {
  // One active magnetometer minute with a mistyped year, and one X-ray minute
  // likewise; the rest of each payload is the frozen capture.
  const typo = (tag) => tag.replace(/^2026/, "2027");
  const mag = copy(MAG);
  const magIndex = activeRowIndex(mag, MAG_NEWEST - 30 * MINUTE);
  mag[magIndex].time_tag = typo(mag[magIndex].time_tag);
  const xrays = copy(XRAYS);
  const xrayIndex = xrays.findIndex(
    (row) =>
      row.energy === "0.1-0.8nm" &&
      utc(row.time_tag) === XRAY_NEWEST - 30 * MINUTE,
  );
  xrays[xrayIndex].time_tag = typo(xrays[xrayIndex].time_tag);
  const { ingest } = makeIngest(
    feed({
      [URL_MAG]: mag,
      [URL_WIND]: WIND,
      [URL_XRAY]: xrays,
      [URL_SOURCES]: SOURCES,
    }),
  );
  await ingest.start(NOW);
  const diagnostics = ingest.diagnostics;
  assert.equal(diagnostics.payloadsRefused, 0);
  assert.equal(diagnostics.magnetometer.newest.timeTagMs, MAG_NEWEST);
  assert.equal(diagnostics.magnetometer.readings.length, 1434);
  assert.equal(
    diagnostics.magnetometer.excluded[
      RealTimeSolarWindExclusion.AHEAD_OF_CLOCK
    ],
    1,
  );
  assert.equal(diagnostics.xray.newest.timeTagMs, XRAY_NEWEST);
  assert.equal(diagnostics.xray.longBand.length, 1351);
  assert.equal(diagnostics.xray.excluded[GoesXrayExclusion.AHEAD_OF_CLOCK], 1);
  assert.equal(ingest.latest().geomagnetic.authority, "rtsw");
  assert.equal(ingest.latest().flare.observedTimeMs, XRAY_NEWEST);

  // An hour ahead: the minutes past the tolerance are set aside and the ones
  // inside it are read.
  const hourAhead = plasma(shifted(WIND, 3600000)).series;
  const kept = hourAhead.readings.filter(
    (reading) =>
      reading.timeTagMs <=
      NOW + SPACE_WEATHER_CLOCK_SKEW_TOLERANCE_SECONDS * 1000,
  ).length;
  const later = makeIngest(
    feed({
      [URL_MAG]: MAG,
      [URL_WIND]: shifted(WIND, 3600000),
      [URL_XRAY]: XRAYS,
      [URL_SOURCES]: SOURCES,
    }),
  ).ingest;
  await later.start(NOW);
  assert.equal(later.diagnostics.payloadsRefused, 0);
  assert.equal(
    later.diagnostics.plasma.newest.timeTagMs,
    Date.parse("2026-09-26T16:28:00Z"),
  );
  assert.equal(later.diagnostics.plasma.readings.length, kept);
  assert.equal(
    later.diagnostics.plasma.excluded[
      RealTimeSolarWindExclusion.AHEAD_OF_CLOCK
    ],
    hourAhead.readings.length - kept,
  );
  assert.equal(hourAhead.readings.length - kept, 45);
  ingest.destroy();
  later.destroy();
});

test("a history longer than the product carries is accumulated across cycles", async () => {
  const transport = capturedFeed();
  const { ingest } = makeIngest(transport, { historySeconds: 2 * 86400 });
  await ingest.start(NOW);
  transport.set(URL_WIND, shifted(WIND, 86400000));
  transport.set(URL_MAG, shifted(MAG, 86400000));
  await ingest.refreshOnce(NOW + 86400000);
  assert.equal(ingest.diagnostics.plasma.readings.length, 2862);
  assert.equal(ingest.diagnostics.magnetometer.readings.length, 2870);
  assert.equal(ingest.diagnostics.plasma.readings[0].timeTagMs, OLDEST);
  ingest.destroy();
});

test("a product still being asked is not asked again, and its answer is applied when it comes", async () => {
  const slow = deferred();
  const transport = capturedFeed();
  transport.set(URL_WIND, () => slow.promise);
  const { ingest } = makeIngest(transport);
  const first = ingest.refreshOnce(NOW);
  await flush();
  // The three prompt products are already applied while the fourth is out.
  assert.equal(ingest.diagnostics.magnetometer.newest.timeTagMs, MAG_NEWEST);
  assert.equal(ingest.diagnostics.xray.newest.timeTagMs, XRAY_NEWEST);
  assert.equal(ingest.diagnostics.plasma, undefined);
  await ingest.refreshOnce(NOW + MINUTE);
  const windCalls = transport.calls.filter((call) => call.url === URL_WIND);
  assert.equal(windCalls.length, 1);
  assert.equal(windCalls[0].signal.aborted, false);
  assert.equal(transport.calls.length, 7);
  slow.resolve(WIND);
  await first;
  assert.equal(ingest.diagnostics.plasma.newest.timeTagMs, WIND_NEWEST);
  assert.equal(ingest.diagnostics.supersededResultsDiscarded, 0);
  assert.equal(ingest.diagnostics.payloadsRefused, 0);
  assert.equal(ingest.latest().observedTimeMs, WIND_NEWEST);
  assert.equal(ingest.diagnostics.packetsBuilt, 1);
  ingest.destroy();
});

test("a request outstanding past the timeout is abandoned, named, asked again, and its late answer discarded", async () => {
  const slow = deferred();
  const transport = capturedFeed();
  transport.set(URL_WIND, () => slow.promise);
  const { ingest } = makeIngest(transport);
  const errors = [];
  const saved = console.error;
  console.error = (message) => errors.push(message);
  let first;
  try {
    first = ingest.refreshOnce(NOW);
    await flush();
    const timeout = SOLAR_WIND_FLARE_REQUEST_TIMEOUT_SECONDS * 1000;
    // Just inside the timeout the request is left alone.
    transport.set(URL_WIND, WIND);
    await ingest.refreshOnce(NOW + timeout - 1);
    assert.equal(
      transport.calls.filter((call) => call.url === URL_WIND).length,
      1,
    );
    await ingest.refreshOnce(NOW + timeout);
  } finally {
    console.error = saved;
  }
  const windCalls = transport.calls.filter((call) => call.url === URL_WIND);
  assert.equal(windCalls.length, 2);
  assert.equal(windCalls[0].signal.aborted, true);
  assert.equal(ingest.diagnostics.lastFailure.product, "rtsw-plasma");
  assert.equal(ingest.diagnostics.lastFailure.code, "transport");
  assert.match(ingest.diagnostics.lastFailure.message, /request timeout/);
  assert.equal(errors.length, 1);
  assert.equal(ingest.diagnostics.plasma.newest.timeTagMs, WIND_NEWEST);
  // The abandoned request answers after all, with an older day: discarded.
  slow.resolve(asServedAt(WIND, NOW - 3600000));
  await first;
  assert.equal(ingest.diagnostics.supersededResultsDiscarded, 1);
  assert.equal(ingest.diagnostics.plasma.newest.timeTagMs, WIND_NEWEST);
  ingest.destroy();
});

for (const [late, laggard] of [
  ["X-ray", URL_XRAY],
  ["plasma", URL_WIND],
]) {
  test(`a ${late} answer slower than the poll interval holds back no other product`, async () => {
    // The laggard answers only when its request is aborted, the way fetch does.
    const transport = capturedFeed();
    const slowFetch = transport.fetchJson;
    transport.fetchJson = (url, signal) => {
      if (url !== laggard) {
        return slowFetch(url, signal);
      }
      transport.calls.push({ url: url, signal: signal });
      return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });
    };
    const base = {
      version: 1,
      provenance: {
        sourceId: "noaa-planetary-kp",
        kind: "observed",
        validitySeconds: 10800,
      },
      observedTimeMs: NOW - 3600000,
      forecastTimeMs: NOW - 3600000,
      geomagnetic: { activity: 3 / 9, authority: "kp", kpIndex: 3 },
    };
    const clock = { now: NOW };
    const { ingest, timers } = makeIngest(transport, {
      authority: fixedAuthority(base, "kp"),
      nowFunction: () => clock.now,
    });
    void ingest.start(NOW);
    await flush();
    for (let minute = 1; minute <= 3; ++minute) {
      clock.now = NOW + minute * MINUTE;
      liveTimer(timers).handler();
      await flush();
    }
    const diagnostics = ingest.diagnostics;
    const packet = ingest.latest();
    assert.ok(packet !== undefined, "nothing was published");
    if (laggard === URL_XRAY) {
      assert.equal(diagnostics.xray, undefined);
      assert.equal(diagnostics.plasma.newest.timeTagMs, WIND_NEWEST);
      assert.equal(packet.solarWind.speedKmPerSecond, 470.6);
      assert.ok(
        Math.abs(diagnostics.estimate.activity - RTSW_ACTIVITY) < 1e-12,
      );
      assert.equal(packet.flare, undefined);
    } else {
      assert.equal(diagnostics.plasma, undefined);
      assert.equal(packet.flare.flareClass, "B");
      assert.equal(packet.flare.observedTimeMs, XRAY_NEWEST);
    }
    assert.equal(packet.geomagnetic.authority, "kp");
    assert.equal(
      transport.calls.filter((call) => call.url === laggard).length,
      1,
    );
    assert.equal(diagnostics.payloadsRefused, 0);
    ingest.destroy();
  });
}

test("replacing the transport abandons the old requests and releases the old provider's history", async () => {
  const transport = capturedFeed();
  const { ingest } = makeIngest(transport);
  await ingest.start(NOW);
  const slow = deferred();
  transport.set(URL_WIND, () => slow.promise);
  const abandoned = ingest.refreshOnce(NOW + MINUTE);
  const replacement = feed({
    [URL_MAG]: asServedAt(MAG, NOW - 3600000),
    [URL_WIND]: asServedAt(WIND, NOW - 3600000),
    [URL_XRAY]: XRAYS,
    [URL_SOURCES]: SOURCES,
  });
  ingest.replaceTransport(replacement.fetchJson);
  assert.deepEqual(
    transport.calls.slice(-4).map((call) => call.signal.aborted),
    [true, true, true, true],
  );
  slow.resolve(WIND);
  await abandoned;
  // Each of the four answers that arrived for the old transport is discarded.
  assert.equal(ingest.diagnostics.supersededResultsDiscarded, 4);
  await ingest.refreshOnce(NOW + 2 * MINUTE);
  assert.equal(ingest.diagnostics.payloadsRefused, 0);
  assert.ok(ingest.diagnostics.plasma.newest.timeTagMs <= NOW - 3600000);
  assert.equal(replacement.calls.length, 4);
  ingest.destroy();
});

test("repeated transport failures space the requests out to the ceiling while the tick keeps the poll interval, and one success resets it", async () => {
  const transport = feed({});
  const clock = { now: NOW };
  const { ingest, timers } = makeIngest(transport, {
    nowFunction: () => clock.now,
  });
  const saved = console.error;
  console.error = () => {};
  const cycles = [];
  const delays = new Set();
  try {
    await ingest.start(NOW);
    cycles.push(0);
    for (let minute = 1; minute <= 45; ++minute) {
      clock.now = NOW + minute * MINUTE;
      const before = transport.calls.length;
      const tick = liveTimer(timers);
      delays.add(tick.delay);
      tick.cleared = true;
      tick.handler();
      await flush();
      if (transport.calls.length !== before) {
        cycles.push(minute);
      }
    }
  } finally {
    console.error = saved;
  }
  assert.deepEqual(cycles, [0, 2, 6, 14, 29, 44]);
  assert.deepEqual([...delays], [60000]);
  assert.equal(SOLAR_WIND_FLARE_MAX_BACKOFF_SECONDS, 900);
  assert.equal(ingest.diagnostics.consecutiveTransportFailures, 6);
  assert.equal(ingest.diagnostics.nextPollDelayMs, 900000);
  assert.equal(ingest.diagnostics.lastFailure.code, "transport");
  transport.set(URL_MAG, MAG);
  transport.set(URL_WIND, WIND);
  await ingest.refreshOnce(NOW + 46 * MINUTE);
  assert.equal(ingest.diagnostics.consecutiveTransportFailures, 0);
  assert.equal(ingest.diagnostics.nextPollDelayMs, 60000);
  assert.equal(timers.filter((timer) => !timer.cleared).length, 1);
  ingest.destroy();
});

test("a new transport is asked at the next tick, whatever the old one's backoff", async () => {
  const transport = feed({});
  const clock = { now: NOW };
  const { ingest, timers } = makeIngest(transport, {
    nowFunction: () => clock.now,
  });
  const saved = console.error;
  console.error = () => {};
  try {
    await ingest.start(NOW);
    await ingest.refreshOnce(NOW + MINUTE);
    assert.equal(ingest.diagnostics.nextPollDelayMs, 240000);
    const replacement = capturedFeed();
    ingest.replaceTransport(replacement.fetchJson);
    assert.equal(ingest.diagnostics.nextPollDelayMs, 60000);
    clock.now = NOW + 2 * MINUTE;
    liveTimer(timers).handler();
    await flush();
    assert.equal(replacement.calls.length, 4);
  } finally {
    console.error = saved;
  }
  assert.equal(ingest.latest().geomagnetic.authority, "rtsw");
  ingest.destroy();
});

test("the poll tick re-composes against the clock even when nothing arrives", async () => {
  const transport = capturedFeed();
  const clock = { now: NOW };
  const { ingest, timers } = makeIngest(transport, {
    nowFunction: () => clock.now,
  });
  const events = [];
  ingest.addEventListener((event) => events.push(event));
  await ingest.start(NOW);
  const first = ingest.latest();
  transport.set(URL_MAG, () => new Promise(() => {}));
  transport.set(URL_WIND, () => new Promise(() => {}));
  transport.set(URL_XRAY, () => new Promise(() => {}));
  transport.set(URL_SOURCES, () => new Promise(() => {}));

  clock.now = NOW + 60000;
  liveTimer(timers).handler();
  assert.ok(ingest.latest() === first, "an unchanged composition was rebuilt");

  clock.now = WIND_NEWEST + 20 * MINUTE;
  liveTimer(timers).handler();
  assert.ok(ingest.latest() === first);
  assert.equal(ingest.diagnostics.solarWindFreshness, "aging");

  clock.now = WIND_NEWEST + 40 * MINUTE;
  liveTimer(timers).handler();
  assert.equal(ingest.latest(), undefined);
  assert.equal(ingest.diagnostics.activityAuthority, "none");
  assert.equal(ingest.diagnostics.solarWindFreshness, "stale");
  assert.deepEqual(
    events
      .filter(
        (e) => e.type === SolarWindFlareEventType.ACTIVITY_AUTHORITY_CHANGE,
      )
      .map((e) => [e.previous, e.current]),
    [
      ["none", "rtsw"],
      ["rtsw", "none"],
    ],
  );
  assert.equal(ingest.diagnostics.packetsBuilt, 1);
  assert.equal(ingest.isRunning, true);
  ingest.destroy();
});

test("a change of active spacecraft between cycles raises one handoff event", async () => {
  const transport = capturedFeed();
  const { ingest } = makeIngest(transport);
  const events = [];
  ingest.addEventListener((event) => events.push(event));
  await ingest.start(NOW);
  const handed = copy(WIND);
  const next = activeRowIndex(handed, WIND_NEWEST);
  const row = {
    ...handed[next],
    time_tag: "2026-09-26T16:14:00",
    source: "ACE",
  };
  handed.unshift(row);
  handed[next + 1].active = true;
  transport.set(URL_WIND, handed);
  await ingest.refreshOnce(NOW + MINUTE);
  const handoffs = events.filter(
    (event) => event.type === SolarWindFlareEventType.ACTIVE_SOURCE_HANDOFF,
  );
  assert.deepEqual(
    handoffs.map((event) => [event.previous, event.current]),
    [["SOLAR1", "ACE"]],
  );
  assert.equal(ingest.latest().solarWind.sourceName, "ACE");
  ingest.destroy();
});

test("destroy disarms the timer, abandons the requests in flight and refuses to restart", async () => {
  const transport = capturedFeed();
  const { ingest, timers } = makeIngest(transport);
  await ingest.start(NOW);
  const slow = deferred();
  transport.set(URL_WIND, () => slow.promise);
  const inFlight = ingest.refreshOnce(NOW + MINUTE);
  ingest.destroy();
  slow.resolve(WIND);
  await inFlight;
  assert.equal(ingest.latest(), undefined);
  assert.equal(
    timers.every((timer) => timer.cleared),
    true,
  );
  const calls = transport.calls.length;
  await ingest.start(NOW + 2 * MINUTE);
  assert.equal(transport.calls.length, calls);
  assert.equal(ingest.isRunning, false);
  assert.equal(ingest.diagnostics.supersededResultsDiscarded, 4);
});

test("destroy releases the decisions with the state, so the diagnostics stop describing a live channel", async () => {
  const authority = await realAuthority(3);
  const { ingest } = makeIngest(capturedFeed(), { authority: authority });
  await ingest.start(NOW);
  const live = ingest.diagnostics;
  assert.equal(live.ovalOwner, "ovation");
  assert.equal(live.activityAuthority, "kp");
  assert.equal(live.authorityPacketFreshness, "fresh");
  assert.equal(live.flareFreshness, "fresh");
  ingest.destroy();
  const released = ingest.diagnostics;
  assert.equal(released.ovalOwner, "none");
  assert.equal(released.activityAuthority, "none");
  assert.equal(released.authorityPacketFreshness, undefined);
  assert.equal(released.solarWindFreshness, undefined);
  assert.equal(released.flareFreshness, undefined);
  assert.equal(released.flareOmission, undefined);
  assert.equal(released.estimate, undefined);
  assert.equal(released.primarySatellite, undefined);
  assert.equal(released.plasma, undefined);
  assert.equal(released.xray, undefined);
  authority.destroy();
});

test("the render read issues no request, reads no clock and returns the same packet", async () => {
  const transport = capturedFeed();
  const { ingest } = makeIngest(transport);
  await ingest.start(NOW);
  const first = ingest.latest();
  const before = ingest.diagnostics;
  const seams = { fetch: 0, setTimeout: 0, dateNow: 0, performanceNow: 0 };
  const saved = {
    fetch: globalThis.fetch,
    setTimeout: globalThis.setTimeout,
    dateNow: Date.now,
    performanceNow: globalThis.performance.now,
  };
  globalThis.fetch = () => {
    ++seams.fetch;
    return Promise.reject(new Error("no"));
  };
  globalThis.setTimeout = () => {
    ++seams.setTimeout;
    return 0;
  };
  Date.now = () => {
    ++seams.dateNow;
    return 0;
  };
  globalThis.performance.now = () => {
    ++seams.performanceNow;
    return 0;
  };
  try {
    for (let i = 0; i < 1000; ++i) {
      assert.ok(
        ingest.latest() === first,
        "the render read rebuilt the packet",
      );
    }
  } finally {
    globalThis.fetch = saved.fetch;
    globalThis.setTimeout = saved.setTimeout;
    Date.now = saved.dateNow;
    globalThis.performance.now = saved.performanceNow;
  }
  for (const [name, count] of Object.entries(seams)) {
    assert.equal(count, 0, `${name} was reached from the render read`);
  }
  const after = ingest.diagnostics;
  assert.equal(after.requestsIssued, before.requestsIssued);
  assert.equal(after.packetsBuilt, before.packetsBuilt);
  assert.equal(transport.calls.length, 4);
  ingest.destroy();
});

test("the cadence constant is the measured interval of the active source", () => {
  const series = magnetometer(MAG).series;
  const intervals = new Set();
  for (let i = 1; i < series.readings.length; ++i) {
    intervals.add(
      (series.readings[i].timeTagMs - series.readings[i - 1].timeTagMs) / 1000,
    );
  }
  assert.deepEqual([...intervals], [REAL_TIME_SOLAR_WIND_CADENCE_SECONDS]);
});

test("the authority packet's freshness is its bounded validitySeconds, not the lead its forecast instant declares", async () => {
  // A Forecast Time with a mistyped year declares a year of lead; the authority
  // bounds the credited horizon, and that bounded horizon is what is read here.
  const answers = {
    "test://ovation": {
      ...OVATION,
      "Observation Time": "2026-09-26T16:10:00Z",
      "Forecast Time": "2027-09-26T17:12:00Z",
    },
    "test://kp": [],
  };
  const authority = new SpaceWeatherFeedIngest({
    fetchJson: (url) => Promise.resolve(answers[url]),
    ovationUrl: "test://ovation",
    planetaryKpUrl: "test://kp",
    setTimeoutFunction: () => 1,
    clearTimeoutFunction: () => {},
  });
  const errors = console.error;
  console.error = () => {};
  try {
    await authority.refreshOnce(NOW);
  } finally {
    console.error = errors;
  }
  const base = authority.latest();
  assert.equal(base.provenance.validitySeconds, 10800);
  assert.ok(base.forecastTimeMs - base.observedTimeMs > 3e10);
  // Seven hours on: past twice the bounded horizon, well inside the declared lead.
  const shift = 7 * 3600 * 1000;
  const { ingest } = makeIngest(
    feed({
      [URL_MAG]: shifted(MAG, shift),
      [URL_WIND]: shifted(WIND, shift),
      [URL_XRAY]: shifted(XRAYS, shift),
      [URL_SOURCES]: SOURCES,
    }),
    { authority: fixedAuthority(base, "ovation") },
  );
  await ingest.start(NOW + shift);
  assert.equal(ingest.diagnostics.authorityPacketFreshness, "stale");
  assert.ok(ingest.latest().oval === undefined);
  assert.equal(ingest.latest().geomagnetic.authority, "rtsw");
  ingest.destroy();
  authority.destroy();
});

test("a short band from another minute is not carried beside the long band", async () => {
  const gapped = copy(XRAYS).filter(
    (row) =>
      !(row.energy === "0.05-0.4nm" && utc(row.time_tag) === XRAY_NEWEST),
  );
  const { ingest } = makeIngest(
    feed({
      [URL_MAG]: MAG,
      [URL_WIND]: WIND,
      [URL_XRAY]: gapped,
      [URL_SOURCES]: SOURCES,
    }),
  );
  await ingest.start(NOW);
  const flare = ingest.latest().flare;
  assert.equal(flare.observedTimeMs, XRAY_NEWEST);
  assert.equal(flare.longBandFluxWattsPerSquareMeter, 4.905103878627415e-7);
  assert.equal(flare.shortBandFluxWattsPerSquareMeter, undefined);
  ingest.destroy();
});

test("a mapping that retracts an entry is taken as the publisher's current statement", async () => {
  // The newest entry names spacecraft 19 from 16:00, while the X-ray product
  // still carries 18's rows; then the publisher retracts that entry.
  const mistaken = [
    {
      ...copy(SOURCES[0]),
      time_tag: "2026-09-26T16:00:00Z",
      xrays: { ...SOURCES[0].xrays, primary: 19 },
    },
    ...copy(SOURCES),
  ];
  const transport = capturedFeed();
  transport.set(URL_SOURCES, mistaken);
  const { ingest } = makeIngest(transport);
  const saved = console.error;
  console.error = () => {};
  try {
    await ingest.start(NOW);
    assert.equal(ingest.diagnostics.primarySatellite, 19);
    assert.equal(ingest.latest().flare, undefined);
    assert.equal(ingest.diagnostics.lastFailure.product, "goes-xray");
    assert.equal(ingest.diagnostics.lastFailure.code, "no-usable-rows");
    transport.set(URL_SOURCES, SOURCES);
    await ingest.refreshOnce(NOW + MINUTE);
  } finally {
    console.error = saved;
  }
  assert.equal(ingest.diagnostics.primarySatellite, 18);
  assert.equal(ingest.diagnostics.payloadsRefused, 1);
  assert.equal(ingest.latest().flare.flareClass, "B");
  assert.equal(ingest.latest().flare.observedTimeMs, XRAY_NEWEST);
  ingest.destroy();
});

test("a mapping entry scheduled ahead of the clock is kept and read only from its instant", async () => {
  const scheduled = [
    {
      ...copy(SOURCES[0]),
      time_tag: new Date(NOW + 20 * 3600000).toISOString(),
      xrays: { ...SOURCES[0].xrays, primary: 19 },
    },
    ...copy(SOURCES),
  ];
  const transport = capturedFeed();
  transport.set(URL_SOURCES, scheduled);
  const { ingest } = makeIngest(transport);
  await ingest.start(NOW);
  assert.equal(ingest.diagnostics.payloadsRefused, 0);
  assert.equal(ingest.diagnostics.primarySatellite, 18);
  assert.equal(ingest.latest().flare.flareClass, "B");
  ingest.destroy();
});

test("a stop raised by a listener inside the poll tick asks nothing more and publishes nothing after it", async () => {
  const transport = capturedFeed();
  const clock = { now: NOW };
  const { ingest, timers } = makeIngest(transport, {
    nowFunction: () => clock.now,
  });
  await ingest.start(NOW);
  let callsAtStop;
  ingest.addEventListener((event) => {
    if (
      event.type === SolarWindFlareEventType.ACTIVITY_AUTHORITY_CHANGE &&
      event.current === "none"
    ) {
      ingest.stop();
      callsAtStop = transport.calls.length;
    }
  });
  // The held solar wind goes stale at this tick, and the feed would now answer
  // with minutes that are current.
  clock.now = WIND_NEWEST + 40 * MINUTE;
  transport.set(URL_MAG, shifted(MAG, 30 * MINUTE));
  transport.set(URL_WIND, shifted(WIND, 30 * MINUTE));
  transport.set(URL_XRAY, shifted(XRAYS, 30 * MINUTE));
  liveTimer(timers).handler();
  await flush();
  assert.equal(transport.calls.length - callsAtStop, 0);
  assert.equal(ingest.isRunning, false);
  assert.equal(ingest.latest(), undefined);
  ingest.destroy();
});

test("a destroy raised by a listener inside a publish leaves no packet behind", async () => {
  const { ingest } = makeIngest(capturedFeed());
  const heard = [];
  ingest.addEventListener((event) => {
    heard.push(event.type);
    if (event.type === SolarWindFlareEventType.FLARE_CLASS_CHANGE) {
      ingest.destroy();
    }
  });
  await ingest.start(NOW);
  assert.equal(ingest.isDestroyed, true);
  assert.equal(ingest.latest(), undefined);
  assert.equal(ingest.diagnostics.activityAuthority, "none");
  assert.deepEqual(heard, [SolarWindFlareEventType.FLARE_CLASS_CHANGE]);
});

test("a solar-wind revision inside the estimate's window is published on its own, whatever the X-ray product does", async () => {
  // The magnetometer re-served a minute later: the same newest minute, with the
  // two hours before it revised southward.
  const revised = copy(MAG);
  for (const row of revised) {
    const t = utc(row.time_tag);
    if (row.active && t < MAG_NEWEST && t >= MAG_NEWEST - 120 * MINUTE) {
      row.bz_gsm = -15;
      row.by_gsm = -3;
    }
  }
  const fresh = makeIngest(
    feed({
      [URL_MAG]: revised,
      [URL_WIND]: WIND,
      [URL_XRAY]: XRAYS,
      [URL_SOURCES]: SOURCES,
    }),
  ).ingest;
  await fresh.start(NOW + MINUTE);
  const truth = fresh.latest().geomagnetic.activity;
  fresh.destroy();
  assert.ok(Math.abs(truth - RTSW_ACTIVITY) > 0.1);

  const transport = capturedFeed();
  const { ingest } = makeIngest(transport);
  await ingest.start(NOW);
  const first = ingest.latest();
  transport.set(URL_MAG, revised);
  transport.set(URL_XRAY, copy(XRAYS));
  await ingest.refreshOnce(NOW + MINUTE);
  assert.ok(ingest.latest() !== first, "the revision was not published");
  assert.equal(ingest.latest().geomagnetic.activity, truth);
  assert.equal(ingest.latest().flare.observedTimeMs, XRAY_NEWEST);
  assert.equal(ingest.diagnostics.packetsBuilt, 2);
  ingest.destroy();
});

test("an authority packet observed ahead of a clock that stepped back is stale, not fresh", async () => {
  const authority = await realAuthority(3);
  authority.stop();
  const base = authority.latest();
  assert.equal(authority.latestOwnership().owner, "ovation");
  // The host clock is corrected to half an hour before the snapshot's
  // observation, past the skew tolerance.
  const corrected = base.observedTimeMs - 30 * MINUTE;
  const { ingest } = makeIngest(
    feed({
      [URL_MAG]: asServedAt(MAG, corrected),
      [URL_WIND]: asServedAt(WIND, corrected),
      [URL_XRAY]: asServedAt(XRAYS, corrected),
      [URL_SOURCES]: SOURCES,
    }),
    { authority: authority },
  );
  await ingest.start(corrected);
  assert.equal(ingest.diagnostics.authorityPacketFreshness, "stale");
  const packet = ingest.latest();
  assert.ok(
    packet.oval === undefined,
    "a model grid from the future was drawn",
  );
  assert.equal(packet.geomagnetic.authority, "rtsw");
  ingest.destroy();
  authority.destroy();
});

test("the composition keeps the poll interval while the requests back off, so a withdrawn decision leaves within one interval", async () => {
  const model = (await realAuthority(3)).latest();
  const decision = { owner: "ovation" };
  const authority = {
    latest: () => model,
    latestOwnership: () =>
      Object.freeze({
        owner: decision.owner,
        reason: "ovation-current",
        previousOwner: decision.owner,
        changed: false,
        kpVisible: false,
      }),
  };
  // A scheduler that fires a timer only once the clock reaches it.
  const clock = { now: NOW };
  const pending = [];
  const transport = capturedFeed();
  const ingest = new SolarWindFlareFeedIngest({
    fetchJson: transport.fetchJson,
    magnetometerUrl: URL_MAG,
    plasmaUrl: URL_WIND,
    xrayUrl: URL_XRAY,
    instrumentSourcesUrl: URL_SOURCES,
    authority: authority,
    nowFunction: () => clock.now,
    setTimeoutFunction: (handler, delay) => {
      pending.push({ handler: handler, due: clock.now + delay, live: true });
      return pending.length;
    },
    clearTimeoutFunction: (handle) => {
      pending[handle - 1].live = false;
    },
  });
  await ingest.start(NOW);
  assert.ok(ingest.latest().oval === model.oval);
  for (const url of [URL_MAG, URL_WIND, URL_XRAY, URL_SOURCES]) {
    transport.set(url, () => Promise.reject(new TypeError("Failed to fetch")));
  }
  const saved = console.error;
  console.error = () => {};
  let withdrawnAt;
  let leftAt;
  try {
    for (let minute = 1; minute <= 17; ++minute) {
      clock.now = NOW + minute * MINUTE;
      if (minute === 16) {
        decision.owner = "none";
        withdrawnAt = minute;
      }
      for (const timer of pending.filter((t) => t.live && t.due <= clock.now)) {
        timer.live = false;
        timer.handler();
        await flush();
      }
      if (
        withdrawnAt !== undefined &&
        leftAt === undefined &&
        ingest.latest()?.oval === undefined
      ) {
        leftAt = minute;
      }
    }
  } finally {
    console.error = saved;
  }
  assert.ok(ingest.diagnostics.nextPollDelayMs >= 480000);
  assert.equal(leftAt, withdrawnAt);
  assert.equal(ingest.latest().geomagnetic.authority, "rtsw");
  ingest.destroy();
});

test("an authority that goes stale by its own horizon while nothing else changes is composed away at the tick", async () => {
  const base = {
    version: 1,
    provenance: {
      sourceId: "noaa-planetary-kp",
      kind: "observed",
      validitySeconds: 10800,
    },
    observedTimeMs: NOW - 3600000,
    forecastTimeMs: NOW - 3600000,
    geomagnetic: { activity: 3 / 9, authority: "kp", kpIndex: 3 },
  };
  const clock = { now: NOW };
  const { ingest, timers } = makeIngest(feed({}), {
    authority: fixedAuthority(base, "kp"),
    nowFunction: () => clock.now,
  });
  const saved = console.error;
  console.error = () => {};
  try {
    await ingest.start(NOW);
    const first = ingest.latest();
    assert.equal(first.geomagnetic.authority, "kp");
    clock.now = base.observedTimeMs + 2 * 10800 * 1000 - MINUTE;
    liveTimer(timers).handler();
    await flush();
    assert.ok(ingest.latest() === first);
    assert.equal(ingest.diagnostics.authorityPacketFreshness, "aging");
    clock.now = base.observedTimeMs + 2 * 10800 * 1000 + MINUTE;
    liveTimer(timers).handler();
    await flush();
  } finally {
    console.error = saved;
  }
  assert.equal(ingest.diagnostics.authorityPacketFreshness, "stale");
  assert.equal(ingest.latest(), undefined);
  ingest.destroy();
});

test("a change of decision alone re-composes the packet", async () => {
  const model = (await realAuthority(3)).latest();
  const decision = { owner: "kp" };
  const authority = {
    latest: () => model,
    latestOwnership: () =>
      Object.freeze({
        owner: decision.owner,
        reason: "ovation-current",
        previousOwner: decision.owner,
        changed: false,
        kpVisible: false,
      }),
  };
  const clock = { now: NOW };
  const { ingest, timers } = makeIngest(feed({}), {
    authority: authority,
    nowFunction: () => clock.now,
  });
  const saved = console.error;
  console.error = () => {};
  try {
    await ingest.start(NOW);
    assert.ok(
      ingest.latest().oval === undefined,
      "an index owner drew the grid",
    );
    decision.owner = "ovation";
    clock.now = NOW + MINUTE;
    liveTimer(timers).handler();
    await flush();
  } finally {
    console.error = saved;
  }
  assert.ok(ingest.latest().oval === model.oval);
  ingest.destroy();
});

test("a cycle whose answer straggles past a tick does not move the packet back to the cycle's older instant", async () => {
  const transport = capturedFeed();
  const clock = { now: NOW };
  const { ingest, timers } = makeIngest(transport, {
    nowFunction: () => clock.now,
  });
  await ingest.start(NOW);
  const slow = deferred();
  transport.set(URL_MAG, () => slow.promise);
  // The cycle begins while the solar wind is fresh, and its magnetometer answer
  // arrives only after a tick fourteen minutes later, when it is aging.
  const straggling = ingest.refreshOnce(NOW + MINUTE);
  await flush();
  assert.equal(ingest.diagnostics.solarWindFreshness, "fresh");
  clock.now = NOW + 15 * MINUTE;
  const tick = liveTimer(timers);
  tick.cleared = true;
  tick.handler();
  await flush();
  assert.equal(ingest.diagnostics.solarWindFreshness, "aging");
  slow.resolve(MAG);
  await straggling;
  assert.equal(ingest.diagnostics.solarWindFreshness, "aging");
  assert.equal(ingest.diagnostics.payloadsRefused, 0);
  ingest.destroy();
});

test("a revised short band at the long band's minute is published on its own", async () => {
  const transport = capturedFeed();
  const { ingest } = makeIngest(transport);
  await ingest.start(NOW);
  const first = ingest.latest();
  const revised = copy(XRAYS);
  const index = revised.findIndex(
    (row) => row.energy === "0.05-0.4nm" && utc(row.time_tag) === XRAY_NEWEST,
  );
  revised[index].flux = 2.5e-8;
  transport.set(URL_XRAY, revised);
  await ingest.refreshOnce(NOW + MINUTE);
  assert.ok(
    ingest.latest() !== first,
    "the revised short band was not published",
  );
  assert.equal(ingest.latest().flare.shortBandFluxWattsPerSquareMeter, 2.5e-8);
  assert.equal(
    ingest.latest().flare.longBandFluxWattsPerSquareMeter,
    first.flare.longBandFluxWattsPerSquareMeter,
  );
  ingest.destroy();
});

test("a tick that fires a moment early against the clock still asks", async () => {
  const transport = capturedFeed();
  const clock = { now: NOW };
  const { ingest, timers } = makeIngest(transport, {
    nowFunction: () => clock.now,
  });
  await ingest.start(NOW);
  clock.now = NOW + 60000 - 1;
  const tick = liveTimer(timers);
  tick.cleared = true;
  tick.handler();
  await flush();
  assert.equal(transport.calls.length, 8);
  ingest.destroy();
});

test("a stopped ingest neither polls nor re-composes from a tick it had already been handed", async () => {
  const transport = capturedFeed();
  const clock = { now: NOW };
  const { ingest, timers } = makeIngest(transport, {
    nowFunction: () => clock.now,
  });
  await ingest.start(NOW);
  const first = ingest.latest();
  // The stop is only visible against an ingest that asked and published.
  assert.ok(first !== undefined, "nothing was published before the stop");
  assert.equal(transport.calls.length, 4);
  const handed = liveTimer(timers).handler;
  ingest.stop();
  assert.equal(ingest.isRunning, false);
  const calls = transport.calls.length;
  // Late enough that a re-composition would find the solar wind stale.
  clock.now = WIND_NEWEST + 40 * MINUTE;
  handed();
  await flush();
  assert.equal(transport.calls.length, calls);
  assert.ok(ingest.latest() === first, "a stopped ingest re-composed");
  assert.equal(ingest.isRunning, false);
  assert.equal(
    timers.filter((timer) => !timer.cleared).length,
    0,
    "a stopped ingest re-armed",
  );
  ingest.destroy();
});

test("a stop raised by the transport inside a tick neither re-arms nor asks the products after it", async () => {
  const transport = capturedFeed();
  const clock = { now: NOW };
  const { ingest, timers } = makeIngest(transport, {
    nowFunction: () => clock.now,
  });
  await ingest.start(NOW);
  const calls = transport.calls.length;
  transport.set(URL_MAG, () => {
    ingest.stop();
    return Promise.resolve(MAG);
  });
  clock.now = NOW + MINUTE;
  const tick = liveTimer(timers);
  tick.cleared = true;
  tick.handler();
  await flush();
  // The mapping and the magnetometer were asked; the stop came inside the
  // second, so the other two never were.
  assert.equal(transport.calls.length - calls, 2);
  assert.equal(ingest.isRunning, false);
  assert.equal(timers.filter((timer) => !timer.cleared).length, 0);
  assert.equal(ingest.diagnostics.payloadsRefused, 0);
  ingest.destroy();
});

test("stop aborts every request in flight; a late answer is discarded and an abort is not a refusal", async () => {
  const transport = capturedFeed();
  const { ingest } = makeIngest(transport);
  await ingest.start(NOW);
  const first = ingest.latest();
  // The plasma answer ignores the signal and arrives anyway; the magnetometer
  // answer rejects on it, as fetch does.
  const slow = deferred();
  transport.set(URL_WIND, () => slow.promise);
  const magSignal = {};
  const honouring = transport.fetchJson;
  transport.fetchJson = (url, signal) => {
    if (url !== URL_MAG) {
      return honouring(url, signal);
    }
    transport.calls.push({ url: url, signal: signal });
    magSignal.signal = signal;
    return new Promise((resolve, reject) => {
      signal.addEventListener("abort", () =>
        reject(new DOMException("aborted", "AbortError")),
      );
    });
  };
  const errors = [];
  const saved = console.error;
  console.error = (message) => errors.push(message);
  try {
    const inFlight = ingest.refreshOnce(NOW + MINUTE);
    ingest.stop();
    assert.deepEqual(
      transport.calls.slice(-4).map((call) => call.signal.aborted),
      [true, true, true, true],
    );
    slow.resolve(shifted(WIND, MINUTE));
    await inFlight;
    await flush();
  } finally {
    console.error = saved;
  }
  assert.equal(ingest.diagnostics.plasma.newest.timeTagMs, WIND_NEWEST);
  assert.equal(ingest.diagnostics.payloadsRefused, 0);
  assert.equal(errors.length, 0);
  assert.equal(ingest.diagnostics.supersededResultsDiscarded, 4);
  assert.ok(ingest.latest() === first, "stopping withdrew the packet");
  ingest.destroy();
});

test("a transport that throws synchronously is refused like a failed request", async () => {
  const transport = capturedFeed();
  transport.set(URL_XRAY, () => {
    throw new TypeError("xray: bad argument");
  });
  const { ingest } = makeIngest(transport);
  const saved = console.error;
  console.error = () => {};
  try {
    await ingest.start(NOW);
  } finally {
    console.error = saved;
  }
  assert.equal(ingest.diagnostics.lastFailure.product, "goes-xray");
  assert.equal(ingest.diagnostics.lastFailure.code, "transport");
  assert.equal(
    ingest.diagnostics.lastFailure.message,
    "TypeError: xray: bad argument",
  );
  assert.equal(ingest.latest().geomagnetic.authority, "rtsw");
  ingest.destroy();
});

test("a rejection reason that cannot describe itself is still refused by name", async () => {
  const transport = capturedFeed();
  transport.set(URL_XRAY, () => Promise.reject(Object.create(null)));
  const { ingest } = makeIngest(transport);
  const saved = console.error;
  console.error = () => {};
  try {
    await ingest.start(NOW);
  } finally {
    console.error = saved;
  }
  assert.equal(
    ingest.diagnostics.lastFailure.message,
    "a object that cannot be described",
  );
  assert.equal(ingest.latest().geomagnetic.authority, "rtsw");
  ingest.destroy();
});

test("the refusal log is throttled by the clock, and a clock stepped back logs again", async () => {
  const transport = capturedFeed();
  transport.set(URL_XRAY, () => Promise.reject(new Error("down")));
  const { ingest } = makeIngest(transport);
  const errors = [];
  const saved = console.error;
  console.error = (message) => errors.push(message);
  try {
    await ingest.start(NOW);
    await ingest.refreshOnce(NOW + 30000);
    assert.equal(errors.length, 1);
    await ingest.refreshOnce(NOW - 10 * MINUTE);
  } finally {
    console.error = saved;
  }
  assert.equal(errors.length, 2);
  assert.equal(ingest.diagnostics.payloadsRefused, 3);
  ingest.destroy();
});

test("a listener that throws neither silences the listeners after it nor stops the cycle", async () => {
  const { ingest } = makeIngest(capturedFeed());
  const heard = [];
  ingest.addEventListener(() => {
    throw new Error("consumer bug");
  });
  ingest.addEventListener((event) => heard.push(event.type));
  const errors = [];
  const saved = console.error;
  console.error = (message) => errors.push(message);
  try {
    await ingest.start(NOW);
  } finally {
    console.error = saved;
  }
  assert.deepEqual(heard, [
    SolarWindFlareEventType.FLARE_CLASS_CHANGE,
    SolarWindFlareEventType.ACTIVITY_AUTHORITY_CHANGE,
  ]);
  assert.equal(errors.length, 2);
  assert.match(errors[0], /listener threw: Error: consumer bug/);
  assert.equal(ingest.latest().geomagnetic.authority, "rtsw");
  ingest.destroy();
});

test("a new authority packet under an unchanged decision is published even when nothing else moves", async () => {
  const kpPacket = (hoursAgo, kp) => ({
    version: 1,
    provenance: {
      sourceId: "noaa-planetary-kp",
      kind: "observed",
      validitySeconds: 10800,
    },
    observedTimeMs: NOW - hoursAgo * 3600000,
    forecastTimeMs: NOW - hoursAgo * 3600000,
    geomagnetic: { activity: kp / 9, authority: "kp", kpIndex: kp },
  });
  const held = { packet: kpPacket(1, 3) };
  const authority = {
    latest: () => held.packet,
    latestOwnership: () =>
      Object.freeze({
        owner: "kp",
        reason: "ovation-absent",
        previousOwner: "kp",
        changed: false,
        kpVisible: true,
      }),
  };
  const clock = { now: NOW };
  const { ingest, timers } = makeIngest(feed({}), {
    authority: authority,
    nowFunction: () => clock.now,
  });
  const saved = console.error;
  console.error = () => {};
  try {
    await ingest.start(NOW);
    assert.equal(ingest.latest().geomagnetic.kpIndex, 3);
    held.packet = kpPacket(0, 5);
    clock.now = NOW + MINUTE;
    liveTimer(timers).handler();
    await flush();
  } finally {
    console.error = saved;
  }
  assert.equal(ingest.latest().geomagnetic.kpIndex, 5);
  assert.equal(ingest.latest().geomagnetic.activity, 5 / 9);
  assert.equal(ingest.latest().observedTimeMs, NOW);
  assert.equal(ingest.diagnostics.packetsBuilt, 2);
  ingest.destroy();
});

test("a request issued at an instant the clock has since stepped back behind is abandoned and asked again", async () => {
  const slow = deferred();
  const transport = capturedFeed();
  transport.set(URL_WIND, () => slow.promise);
  const { ingest } = makeIngest(transport);
  const saved = console.error;
  console.error = () => {};
  let first;
  try {
    first = ingest.refreshOnce(NOW);
    await flush();
    transport.set(URL_WIND, WIND);
    await ingest.refreshOnce(NOW - 3600000);
  } finally {
    console.error = saved;
  }
  const windCalls = transport.calls.filter((call) => call.url === URL_WIND);
  assert.equal(windCalls.length, 2);
  assert.equal(windCalls[0].signal.aborted, true);
  assert.equal(ingest.diagnostics.lastFailure.product, "rtsw-plasma");
  assert.equal(ingest.diagnostics.lastFailure.code, "transport");
  slow.resolve(WIND);
  await first;
  assert.equal(ingest.diagnostics.supersededResultsDiscarded, 1);
  ingest.destroy();
});

test("a tick at a clock stepped back behind the last cycle asks every product again", async () => {
  const transport = capturedFeed();
  const clock = { now: NOW };
  const { ingest, timers } = makeIngest(transport, {
    nowFunction: () => clock.now,
  });
  const saved = console.error;
  console.error = () => {};
  try {
    await ingest.start(NOW);
    assert.equal(transport.calls.length, 4);
    clock.now = NOW - 3600000;
    liveTimer(timers).handler();
    await flush();
  } finally {
    console.error = saved;
  }
  assert.equal(transport.calls.length, 8);
  ingest.destroy();
});

test("a flare channel that returns after the eclipse dropout clears its omission", async () => {
  const at = Date.parse("2026-09-26T09:00:00Z");
  const after = Date.parse("2026-09-26T09:40:00Z");
  const transport = feed({
    [URL_MAG]: asServedAt(MAG, at),
    [URL_WIND]: asServedAt(WIND, at),
    [URL_XRAY]: asServedAt(XRAYS, at),
    [URL_SOURCES]: SOURCES,
  });
  const clock = { now: at };
  const { ingest, timers } = makeIngest(transport, {
    nowFunction: () => clock.now,
  });
  await ingest.start(at);
  assert.equal(ingest.diagnostics.flareOmission, FlareOmission.STALE);
  transport.set(URL_MAG, asServedAt(MAG, after));
  transport.set(URL_WIND, asServedAt(WIND, after));
  transport.set(URL_XRAY, asServedAt(XRAYS, after));
  clock.now = after;
  liveTimer(timers).handler();
  await flush();
  const packet = ingest.latest();
  assert.equal(packet.flare.observedTimeMs, after);
  assert.equal(ingest.diagnostics.flareFreshness, "fresh");
  assert.equal(ingest.diagnostics.flareOmission, undefined);
  ingest.destroy();
});

test("two active rows at one instant are found however far apart the wire carries them", () => {
  const doubled = copy(MAG);
  const standby = doubled.findIndex(
    (row) => row.active === false && utc(row.time_tag) === MAG_NEWEST - MINUTE,
  );
  const [promoted] = doubled.splice(standby, 1);
  promoted.active = true;
  doubled.push(promoted);
  const series = magnetometer(doubled).series;
  assert.equal(series.excluded["ambiguous-instant"], 2);
  assert.equal(series.readings.length, 1434);
  assert.equal(
    series.readings.some(
      (reading) => reading.timeTagMs === MAG_NEWEST - MINUTE,
    ),
    false,
  );
});

// ---------------------------------------------------------------------------
// 5. What one product's answer does to the others, to the backoff and to a
//    provider switch; rows that cannot be read; where a refusal is attributed.
// ---------------------------------------------------------------------------

/** An index-owned authority packet observed an hour before NOW. */
function kpAuthorityPacket() {
  return {
    version: 1,
    provenance: {
      sourceId: "noaa-planetary-kp",
      kind: "observed",
      validitySeconds: 10800,
    },
    observedTimeMs: NOW - 3600000,
    forecastTimeMs: NOW - 3600000,
    geomagnetic: { activity: 3 / 9, authority: "kp", kpIndex: 3 },
  };
}

/** The frozen X-ray day with an X5 flare at its newest long-band minute. */
function flaringXrays() {
  return copy(XRAYS).map((row) =>
    row.energy === "0.1-0.8nm" && utc(row.time_tag) === XRAY_NEWEST
      ? { ...row, flux: 5e-4 }
      : row,
  );
}

/** Collect console.error until restored. */
function silenced() {
  const errors = [];
  const saved = console.error;
  console.error = (message) => errors.push(String(message));
  return {
    errors: errors,
    restore() {
      console.error = saved;
    },
  };
}

for (const honoursAbort of [true, false]) {
  test(`an answer ends the request backoff at once while a sibling hangs (abort ${honoursAbort ? "honoured" : "ignored"})`, async () => {
    // The host refuses every request for twenty minutes, then recovers except
    // for the magnetometer, which never answers.
    const clock = { now: NOW };
    const host = { up: false };
    const asked = [];
    const transport = {
      fetchJson(url, signal) {
        asked.push({ url: url, minute: (clock.now - NOW) / MINUTE });
        if (!host.up) {
          return Promise.reject(new Error("503"));
        }
        if (url === URL_MAG) {
          return new Promise((resolve, reject) => {
            if (honoursAbort) {
              signal.addEventListener("abort", () =>
                reject(new DOMException("aborted", "AbortError")),
              );
            }
          });
        }
        const lag = clock.now - NOW;
        return Promise.resolve(
          url === URL_WIND
            ? shifted(WIND, lag)
            : url === URL_XRAY
              ? shifted(XRAYS, lag)
              : SOURCES,
        );
      },
    };
    const { ingest, timers } = makeIngest(transport, {
      nowFunction: () => clock.now,
    });
    const quiet = silenced();
    const seen = {};
    try {
      void ingest.start(NOW);
      await flush();
      for (let minute = 1; minute <= 31; ++minute) {
        host.up = minute > 20;
        clock.now = NOW + minute * MINUTE;
        liveTimer(timers).handler();
        await flush();
        if (minute === 28) {
          seen.backedOff = ingest.diagnostics.nextPollDelayMs;
        }
        if (minute === 29) {
          seen.recovered = {
            failures: ingest.diagnostics.consecutiveTransportFailures,
            delay: ingest.diagnostics.nextPollDelayMs,
          };
        }
      }
    } finally {
      quiet.restore();
    }
    assert.equal(seen.backedOff, 900000);
    assert.deepEqual(seen.recovered, { failures: 0, delay: 60000 });
    assert.deepEqual(
      asked
        .filter((call) => call.url === URL_XRAY && call.minute > 20)
        .map((call) => call.minute),
      [29, 30, 31],
    );
    assert.equal(ingest.diagnostics.flareFreshness, "fresh");
    assert.equal(
      ingest.diagnostics.xray.newest.timeTagMs,
      XRAY_NEWEST + 31 * MINUTE,
    );
    ingest.destroy();
  });
}

for (const [label, authority] of [
  ["no authority", () => undefined],
  ["an index owner", () => fixedAuthority(kpAuthorityPacket(), "kp")],
]) {
  test(`a replaced transport leaves the packet in place and raises nothing until the new provider answers (${label})`, async () => {
    const answers = {
      [URL_MAG]: MAG,
      [URL_WIND]: WIND,
      [URL_XRAY]: flaringXrays(),
      [URL_SOURCES]: SOURCES,
    };
    const clock = { now: NOW };
    const { ingest, timers } = makeIngest(feed(answers), {
      authority: authority(),
      nowFunction: () => clock.now,
    });
    await ingest.start(NOW);
    const before = ingest.latest();
    assert.equal(before.flare.flareClass, "X");
    const events = [];
    ingest.addEventListener((event) => events.push(event));
    const pending = [];
    ingest.replaceTransport((url) => {
      const answer = deferred();
      pending.push({ url: url, answer: answer });
      return answer.promise;
    });
    clock.now = NOW + MINUTE;
    liveTimer(timers).handler();
    await flush();
    assert.equal(pending.length, 4);
    assert.ok(ingest.latest() === before, "the switch withdrew the packet");
    assert.deepEqual(events, []);
    for (const { url, answer } of pending) {
      answer.resolve(answers[url]);
    }
    await flush();
    assert.ok(ingest.latest() === before);
    assert.deepEqual(events, []);
    assert.equal(ingest.diagnostics.payloadsRefused, 0);
    ingest.destroy();
  });
}

test("a new provider that names the spacecraft differently is not a handoff", async () => {
  const renamed = (payload) =>
    copy(payload).map((row) =>
      row.active ? { ...row, source: "DSCOVR" } : row,
    );
  const { ingest } = makeIngest(capturedFeed());
  const events = [];
  ingest.addEventListener((event) => events.push(event));
  await ingest.start(NOW);
  ingest.replaceTransport(
    feed({
      [URL_MAG]: renamed(MAG),
      [URL_WIND]: renamed(WIND),
      [URL_XRAY]: XRAYS,
      [URL_SOURCES]: SOURCES,
    }).fetchJson,
  );
  await ingest.refreshOnce(NOW + MINUTE);
  assert.equal(ingest.latest().solarWind.sourceName, "DSCOVR");
  assert.deepEqual(
    events.filter(
      (event) => event.type === SolarWindFlareEventType.ACTIVE_SOURCE_HANDOFF,
    ),
    [],
  );
  ingest.destroy();
});

test("a destroy while a cycle is out leaves no packet and no owner when its last answer arrives", async () => {
  const slow = deferred();
  const transport = capturedFeed();
  transport.set(URL_WIND, () => slow.promise);
  const { ingest } = makeIngest(transport, {
    authority: fixedAuthority(kpAuthorityPacket(), "kp"),
  });
  const cycle = ingest.refreshOnce(NOW);
  await flush();
  assert.equal(ingest.latest().geomagnetic.authority, "kp");
  ingest.destroy();
  slow.resolve(WIND);
  await cycle;
  await flush();
  assert.ok(ingest.latest() === undefined);
  assert.equal(ingest.diagnostics.ovalOwner, "none");
  assert.equal(ingest.diagnostics.activityAuthority, "none");
  assert.equal(ingest.diagnostics.supersededResultsDiscarded, 1);
});

test("a refresh asked of a destroyed ingest asks nothing and publishes nothing", async () => {
  const transport = capturedFeed();
  const { ingest } = makeIngest(transport, {
    authority: fixedAuthority(kpAuthorityPacket(), "kp"),
  });
  await ingest.start(NOW);
  ingest.destroy();
  await ingest.refreshOnce(NOW + MINUTE);
  await flush();
  assert.equal(transport.calls.length, 4);
  assert.equal(ingest.diagnostics.requestsIssued, 4);
  assert.ok(ingest.latest() === undefined);
  assert.equal(ingest.diagnostics.packetsBuilt, 1);
});

test("two refusals exactly one throttle interval apart are both logged", async () => {
  const transport = capturedFeed();
  transport.set(URL_XRAY, () => Promise.reject(new Error("down")));
  const { ingest } = makeIngest(transport, { nowFunction: () => NOW });
  const quiet = silenced();
  try {
    await ingest.refreshOnce(NOW);
    await ingest.refreshOnce(NOW + 60000);
  } finally {
    quiet.restore();
  }
  assert.equal(quiet.errors.length, 2);
  assert.equal(ingest.diagnostics.lastFailure.atMs, NOW + 60000);
  ingest.destroy();
});

test("a row whose shape or type cannot be read costs that row, not the day", () => {
  const standbyFlag = copy(MAG);
  standbyFlag[standbyFlag.findIndex((row) => row.active === false)].active =
    null;
  const standbyNull = copy(MAG);
  standbyNull[standbyNull.findIndex((row) => row.active === false)] = null;
  const activeFlag = copy(MAG);
  activeFlag[activeRowIndex(activeFlag, MAG_NEWEST)].active = "true";
  for (const [payload, code, readings, newest] of [
    [standbyFlag, "active-flag", 1435, MAG_NEWEST],
    [standbyNull, "row-shape", 1435, MAG_NEWEST],
    [activeFlag, "active-flag", 1434, MAG_NEWEST - MINUTE],
  ]) {
    const result = magnetometer(payload);
    assert.equal(result.status, "ok", code);
    assert.equal(result.series.excluded[code], 1, code);
    assert.equal(result.series.readings.length, readings, code);
    assert.equal(result.series.newest.timeTagMs, newest, code);
  }
  assert.equal(
    magnetometer(copy(MAG).map((row) => ({ ...row, active: 1 }))).error.code,
    RealTimeSolarWindRejectionCode.ACTIVE_FLAG,
  );

  const newestLong = (rows) =>
    rows.findIndex(
      (row) => row.energy === "0.1-0.8nm" && utc(row.time_tag) === XRAY_NEWEST,
    );
  const cases = [];
  for (const [field, value] of [
    ["satellite", null],
    ["satellite", "18"],
    ["energy", null],
  ]) {
    const rows = copy(XRAYS);
    rows[newestLong(rows)][field] = value;
    cases.push([rows, "field-type"]);
  }
  const nullRow = copy(XRAYS);
  nullRow[newestLong(nullRow)] = null;
  cases.push([nullRow, "row-shape"]);
  for (const [rows, code] of cases) {
    const result = normalizeGoesXrayPayload(rows, 18);
    assert.equal(result.status, "ok", code);
    assert.equal(result.series.excluded[code], 1, code);
    assert.equal(result.series.longBand.length, 1351, code);
    assert.equal(result.series.newest.timeTagMs, XRAY_NEWEST - MINUTE, code);
  }
  assert.equal(
    normalizeGoesXrayPayload([null, 7]).error.code,
    GoesXrayRejectionCode.ROW_SHAPE,
  );
  assert.equal(
    normalizeGoesXrayPayload(
      copy(XRAYS).map((row) => ({ ...row, satellite: "18" })),
    ).error.code,
    GoesXrayRejectionCode.FIELD_TYPE,
  );
});

for (const [late, laggard] of [
  ["X-ray", URL_XRAY],
  ["plasma", URL_WIND],
]) {
  test(`a ${late} answer still out holds back no other product's publication, even for one poll interval`, async () => {
    const slow = deferred();
    const transport = capturedFeed();
    transport.set(laggard, () => slow.promise);
    const { ingest, timers } = makeIngest(transport, {
      authority:
        laggard === URL_WIND
          ? fixedAuthority(kpAuthorityPacket(), "kp")
          : undefined,
      pollIntervalSeconds: 300,
    });
    void ingest.start(NOW);
    await flush();
    const packet = ingest.latest();
    assert.ok(packet !== undefined, "nothing was published before the tick");
    assert.equal(timers.length, 1);
    if (laggard === URL_XRAY) {
      assert.equal(packet.geomagnetic.authority, "rtsw");
      assert.ok(Math.abs(packet.geomagnetic.activity - RTSW_ACTIVITY) < 1e-12);
      assert.equal(packet.flare, undefined);
    } else {
      assert.equal(packet.geomagnetic.authority, "kp");
      assert.equal(packet.flare.flareClass, "B");
      assert.equal(packet.solarWind.speedKmPerSecond, undefined);
    }
    slow.resolve(laggard === URL_XRAY ? XRAYS : WIND);
    await flush();
    assert.ok(ingest.latest() !== packet);
    assert.equal(ingest.latest().flare.flareClass, "B");
    assert.equal(ingest.latest().solarWind.speedKmPerSecond, 470.6);
    assert.equal(ingest.diagnostics.packetsBuilt, 2);
    ingest.destroy();
  });
}

test("an answer is judged at the instant it arrives, not the one it was asked at", async () => {
  const asked = Date.parse("2026-09-26T16:10:00Z");
  const arrived = Date.parse("2026-09-26T16:18:00Z");
  const clock = { now: asked };
  const slow = deferred();
  const transport = capturedFeed();
  transport.set(URL_XRAY, () => slow.promise);
  const { ingest } = makeIngest(transport, { nowFunction: () => clock.now });
  const cycle = ingest.refreshOnce(asked);
  await flush();
  clock.now = arrived;
  slow.resolve(XRAYS);
  await cycle;
  const xray = ingest.diagnostics.xray;
  assert.equal(xray.newest.timeTagMs, XRAY_NEWEST);
  assert.equal(xray.excluded["ahead-of-clock"], 0);
  assert.equal(ingest.latest().flare.observedTimeMs, XRAY_NEWEST);
  ingest.destroy();
});

test("a refusal is recorded at the instant its answer arrived", async () => {
  const clock = { now: NOW };
  const slow = deferred();
  const transport = capturedFeed();
  transport.set(URL_WIND, () => slow.promise);
  const { ingest } = makeIngest(transport, { nowFunction: () => clock.now });
  const quiet = silenced();
  try {
    const cycle = ingest.refreshOnce(NOW);
    await flush();
    clock.now = NOW + 90000;
    slow.reject(new Error("504"));
    await cycle;
  } finally {
    quiet.restore();
  }
  assert.equal(ingest.diagnostics.lastFailure.product, "rtsw-plasma");
  assert.equal(ingest.diagnostics.lastFailure.atMs, NOW + 90000);
  ingest.destroy();
});

test("a request outstanding past the timeout is abandoned at the first tick past it, whatever the backoff", async () => {
  // The magnetometer never answers while the other three refuse, so the
  // requests back off to the ceiling around a request that stays out.
  const clock = { now: NOW };
  const magRequests = [];
  const transport = {
    fetchJson(url, signal) {
      if (url === URL_MAG) {
        const request = { askedAt: (clock.now - NOW) / MINUTE };
        signal.addEventListener("abort", () => {
          request.abortedAt = (clock.now - NOW) / MINUTE;
        });
        magRequests.push(request);
        return new Promise(() => {});
      }
      return Promise.reject(new Error("503"));
    },
  };
  const { ingest, timers } = makeIngest(transport, {
    nowFunction: () => clock.now,
  });
  const quiet = silenced();
  try {
    void ingest.start(NOW);
    await flush();
    for (let minute = 1; minute <= 60; ++minute) {
      clock.now = NOW + minute * MINUTE;
      liveTimer(timers).handler();
      await flush();
    }
  } finally {
    quiet.restore();
  }
  assert.equal(ingest.diagnostics.nextPollDelayMs, 900000);
  const abandoned = magRequests.filter(
    (request) => request.abortedAt !== undefined,
  );
  assert.ok(abandoned.length >= 3, JSON.stringify(magRequests));
  const timeoutMinutes = SOLAR_WIND_FLARE_REQUEST_TIMEOUT_SECONDS / 60;
  assert.deepEqual(
    abandoned.map((request) => request.abortedAt - request.askedAt),
    abandoned.map(() => timeoutMinutes),
    JSON.stringify(magRequests),
  );
  ingest.destroy();
});

test("an authority packet that does not validate is an absent authority, and the flare stays", async () => {
  const invalid = {
    ...kpAuthorityPacket(),
    geomagnetic: { activity: 1.5, authority: "kp", kpIndex: 13.5 },
  };
  const { ingest } = makeIngest(capturedFeed(), {
    authority: fixedAuthority(invalid, "kp"),
  });
  const quiet = silenced();
  try {
    await ingest.start(NOW);
  } finally {
    quiet.restore();
  }
  const packet = ingest.latest();
  assert.equal(packet.geomagnetic.authority, "rtsw");
  assert.ok(Math.abs(packet.geomagnetic.activity - RTSW_ACTIVITY) < 1e-12);
  assert.equal(packet.flare.flareClass, "B");
  assert.equal(ingest.diagnostics.flareOmission, undefined);
  assert.equal(ingest.diagnostics.lastFailure.product, "oval-authority");
  assert.equal(ingest.diagnostics.lastFailure.code, "invalid-packet");
  assert.equal(ingest.diagnostics.payloadsRefused, 1);
  assert.equal(quiet.errors.length, 1);
  assert.match(quiet.errors[0], /oval-authority/);
  ingest.destroy();
});

test("a mapping entry whose primary is the fill value names no primary, and the rows are read as published", async () => {
  const filled = copy(SOURCES);
  filled[0].xrays.primary = -9999;
  filled[1].xrays.primary = -9999;
  const result = normalizeGoesInstrumentSources(filled);
  assert.equal(result.status, "ok");
  assert.equal(result.sources.fillPrimaries, 2);
  assert.equal(result.sources.entries.length, 5);
  assert.equal(goesXrayPrimaryAt(result.sources, NOW), undefined);
  assert.equal(
    goesXrayPrimaryAt(result.sources, Date.parse("2026-09-22T15:00:00Z")),
    19,
  );
  const transport = capturedFeed();
  transport.set(URL_SOURCES, filled);
  const { ingest } = makeIngest(transport);
  await ingest.start(NOW);
  assert.equal(ingest.diagnostics.primarySatellite, undefined);
  assert.equal(ingest.diagnostics.xray.primarySatellite, undefined);
  assert.equal(ingest.diagnostics.xray.newest.timeTagMs, XRAY_NEWEST);
  assert.equal(ingest.latest().flare.flareClass, "B");
  assert.equal(ingest.diagnostics.payloadsRefused, 0);
  ingest.destroy();
});

test("after a switch, the new provider's own series is held to the regression rule", async () => {
  const { ingest } = makeIngest(capturedFeed());
  await ingest.start(NOW);
  const next = capturedFeed();
  ingest.replaceTransport(next.fetchJson);
  await ingest.refreshOnce(NOW + MINUTE);
  assert.equal(ingest.diagnostics.payloadsRefused, 0);
  next.set(URL_WIND, asServedAt(WIND, NOW - 3600000));
  const quiet = silenced();
  try {
    await ingest.refreshOnce(NOW + 2 * MINUTE);
  } finally {
    quiet.restore();
  }
  assert.equal(ingest.diagnostics.payloadsRefused, 1);
  assert.equal(ingest.diagnostics.lastFailure.code, "time-regression");
  assert.equal(ingest.diagnostics.plasma.newest.timeTagMs, WIND_NEWEST);
  ingest.destroy();
});

test("a stop raised before the answers arriving together are published publishes nothing", async () => {
  const { ingest } = makeIngest(capturedFeed());
  void ingest.start(NOW);
  // Queued behind the four answers and ahead of the publish they queue.
  queueMicrotask(() => ingest.stop());
  await flush();
  assert.ok(ingest.latest() === undefined);
  assert.equal(ingest.diagnostics.packetsBuilt, 0);
  assert.equal(ingest.diagnostics.magnetometer.newest.timeTagMs, MAG_NEWEST);
  ingest.destroy();
});

test("an answer to a refresh asked behind the clock does not compose behind a tick that ran while it was out", async () => {
  const transport = capturedFeed();
  const clock = { now: NOW + 14 * MINUTE };
  const { ingest, timers } = makeIngest(transport, {
    nowFunction: () => clock.now,
  });
  await ingest.start(NOW);
  assert.equal(ingest.diagnostics.solarWindFreshness, "fresh");
  const slow = deferred();
  transport.set(URL_MAG, () => slow.promise);
  const straggling = ingest.refreshOnce(NOW + MINUTE);
  await flush();
  assert.equal(ingest.diagnostics.solarWindFreshness, "fresh");
  const tick = liveTimer(timers);
  tick.cleared = true;
  tick.handler();
  await flush();
  assert.equal(ingest.diagnostics.solarWindFreshness, "aging");
  slow.resolve(MAG);
  await straggling;
  assert.equal(ingest.diagnostics.solarWindFreshness, "aging");
  ingest.destroy();
});

test("a cycle is counted in the backoff at its first failure, and never after one of its answers", async () => {
  // Every request fails but the magnetometer's, which never settles: the
  // cycle cannot finish, and its failures still count.
  const hanging = feed({});
  hanging.set(URL_MAG, () => new Promise(() => {}));
  const first = makeIngest(hanging).ingest;
  // Answers arrive before the cycle's last request fails.
  const mixed = capturedFeed();
  mixed.set(URL_XRAY, () => Promise.reject(new Error("503")));
  const second = makeIngest(mixed).ingest;
  const quiet = silenced();
  try {
    void first.refreshOnce(NOW);
    await flush();
    await second.refreshOnce(NOW);
  } finally {
    quiet.restore();
  }
  assert.equal(first.diagnostics.consecutiveTransportFailures, 1);
  assert.equal(first.diagnostics.nextPollDelayMs, 120000);
  assert.equal(second.diagnostics.consecutiveTransportFailures, 0);
  assert.equal(second.diagnostics.nextPollDelayMs, 60000);
  first.destroy();
  second.destroy();
});

test("an authority packet that does not validate stays absent in every later composition around it", async () => {
  const invalid = {
    ...kpAuthorityPacket(),
    geomagnetic: { activity: 1.5, authority: "kp", kpIndex: 13.5 },
  };
  const transport = capturedFeed();
  const { ingest } = makeIngest(transport, {
    authority: fixedAuthority(invalid, "kp"),
  });
  const quiet = silenced();
  let first;
  let second;
  try {
    await ingest.start(NOW);
    first = ingest.latest();
    // A new solar-wind minute composes again around the same authority packet.
    transport.set(URL_MAG, shifted(MAG, MINUTE));
    transport.set(URL_WIND, shifted(WIND, MINUTE));
    await ingest.refreshOnce(NOW + MINUTE);
    second = ingest.latest();
  } finally {
    quiet.restore();
  }
  assert.ok(second !== undefined, "the second composition published nothing");
  assert.notEqual(second, first);
  assert.equal(second.geomagnetic.authority, "rtsw");
  assert.equal(second.observedTimeMs, WIND_NEWEST + MINUTE);
  assert.equal(second.flare.flareClass, "B");
  assert.equal(ingest.diagnostics.lastFailure.product, "oval-authority");
  assert.equal(ingest.diagnostics.lastFailure.code, "invalid-packet");
  assert.equal(ingest.diagnostics.payloadsRefused, 2);
  ingest.destroy();
});

test("a new provider whose first answer is refused is still not held to the old provider's series", async () => {
  const { ingest } = makeIngest(capturedFeed());
  await ingest.start(NOW);
  const next = feed({
    [URL_MAG]: MAG,
    [URL_WIND]: [],
    [URL_XRAY]: XRAYS,
    [URL_SOURCES]: SOURCES,
  });
  ingest.replaceTransport(next.fetchJson);
  const quiet = silenced();
  try {
    await ingest.refreshOnce(NOW + MINUTE);
    assert.equal(ingest.diagnostics.lastFailure.code, "empty");
    assert.equal(ingest.diagnostics.plasma.newest.timeTagMs, WIND_NEWEST);
    next.set(URL_WIND, asServedAt(WIND, NOW - 3600000));
    await ingest.refreshOnce(NOW + 2 * MINUTE);
  } finally {
    quiet.restore();
  }
  assert.equal(ingest.diagnostics.payloadsRefused, 1);
  assert.ok(ingest.diagnostics.plasma.newest.timeTagMs <= NOW - 3600000);
  ingest.destroy();
});

test("an answer the ingest refuses still ends the request backoff, because the host is serving", async () => {
  const transport = feed({});
  const { ingest } = makeIngest(transport);
  const quiet = silenced();
  try {
    await ingest.start(NOW);
    await ingest.refreshOnce(NOW + 2 * MINUTE);
    assert.equal(ingest.diagnostics.consecutiveTransportFailures, 2);
    transport.set(URL_WIND, { not: "rows" });
    await ingest.refreshOnce(NOW + 6 * MINUTE);
  } finally {
    quiet.restore();
  }
  assert.equal(ingest.diagnostics.payloadsParsed, 1);
  assert.equal(ingest.diagnostics.consecutiveTransportFailures, 0);
  assert.equal(ingest.diagnostics.nextPollDelayMs, 60000);
  ingest.destroy();
});

test("the X-ray primary is read from the mapping entry in force when the answer arrives", async () => {
  const tag = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
  const entry = (ms, primary) => ({
    ...copy(SOURCES[0]),
    time_tag: tag(ms),
    xrays: { secondary: primary === 18 ? 19 : 18, primary: primary },
  });
  // 19 is primary when the request is asked; 18 from the minute after.
  const mapping = [
    entry(NOW + MINUTE, 18),
    entry(NOW - 3600000, 19),
    ...copy(SOURCES),
  ];
  const clock = { now: NOW };
  const slow = deferred();
  const transport = capturedFeed();
  transport.set(URL_SOURCES, mapping);
  transport.set(URL_XRAY, () => slow.promise);
  const { ingest } = makeIngest(transport, { nowFunction: () => clock.now });
  const cycle = ingest.refreshOnce(NOW);
  await flush();
  clock.now = NOW + 2 * MINUTE;
  slow.resolve(XRAYS);
  await cycle;
  assert.equal(ingest.diagnostics.primarySatellite, 18);
  assert.equal(ingest.diagnostics.payloadsRefused, 0);
  assert.equal(ingest.diagnostics.xray.newest.timeTagMs, XRAY_NEWEST);
  assert.equal(ingest.latest().flare.flareClass, "B");
  ingest.destroy();
});

test("an X-ray row whose spacecraft number is not an integer costs that row", () => {
  const rows = copy(XRAYS);
  const index = rows.findIndex(
    (row) => row.energy === "0.1-0.8nm" && utc(row.time_tag) === XRAY_NEWEST,
  );
  rows[index] = { ...rows[index], satellite: 18.5 };
  const result = normalizeGoesXrayPayload(rows);
  assert.equal(result.status, "ok");
  assert.equal(result.series.excluded["field-type"], 1);
  assert.equal(result.series.newest.timeTagMs, XRAY_NEWEST - MINUTE);
});

// ---------------------------------------------------------------------------
// 6. An authority that hands back what cannot be read, cycles that must settle
//    whatever the transport does, a provider that answers for only part of the
//    solar wind, and the history window a caller declares.
// ---------------------------------------------------------------------------

/** Fire the live poll timer once per minute, from one minute after `fromMs`. */
async function tickMinutes(ingest, timers, clock, fromMs, minutes) {
  for (let minute = 1; minute <= minutes; ++minute) {
    clock.now = fromMs + minute * MINUTE;
    const timer = liveTimer(timers);
    assert.ok(timer !== undefined, `no timer armed before minute ${minute}`);
    timer.cleared = true;
    timer.handler();
    await flush();
  }
}

// Each with the refusal message that names why the authority is absent.
const unreadableAuthorities = [
  [
    "hands back a packet with no provenance",
    () => {
      const { provenance, ...rest } = kpAuthorityPacket();
      assert.ok(provenance !== undefined);
      return fixedAuthority(rest, "kp");
    },
    /^provenance: must be an object$/,
  ],
  [
    "hands back a packet whose provenance is null",
    () => fixedAuthority({ ...kpAuthorityPacket(), provenance: null }, "kp"),
    /^provenance: must be an object$/,
  ],
  [
    "hands back null for its packet",
    () => fixedAuthority(null, "kp"),
    /^packet: must be an object$/,
  ],
  [
    "throws when its decision is read",
    () => ({
      latest: () => kpAuthorityPacket(),
      latestOwnership: () => {
        throw new Error("the authority is not reachable");
      },
    }),
    /could not be read: Error: the authority is not reachable$/,
  ],
  [
    "throws when its packet is read",
    () => ({
      latest: () => {
        throw new Error("the authority is not reachable");
      },
      latestOwnership: fixedAuthority(undefined, "kp").latestOwnership,
    }),
    /could not be read: Error: the authority is not reachable$/,
  ],
];

for (const [label, authorityOf, refusal] of unreadableAuthorities) {
  test(`an authority that ${label} is an absent authority named as such, and polling carries on`, async () => {
    const clock = { now: NOW };
    const transport = capturedFeed();
    const { ingest, timers } = makeIngest(transport, {
      authority: authorityOf(),
      nowFunction: () => clock.now,
    });
    const quiet = silenced();
    try {
      await ingest.start(NOW);
      await tickMinutes(ingest, timers, clock, NOW, 5);
    } finally {
      quiet.restore();
    }
    assert.equal(ingest.isRunning, true);
    assert.equal(transport.calls.length, 24);
    const packet = ingest.latest();
    assert.ok(packet !== undefined, "nothing was published");
    assert.equal(packet.geomagnetic.authority, "rtsw");
    assert.ok(packet.oval === undefined);
    assert.equal(packet.flare.flareClass, "B");
    assert.equal(ingest.diagnostics.lastFailure.product, "oval-authority");
    assert.equal(
      ingest.diagnostics.lastFailure.code,
      SolarWindFlareIngestCode.INVALID_PACKET,
    );
    assert.match(ingest.diagnostics.lastFailure.message, refusal);
    assert.equal(ingest.diagnostics.authorityPacketFreshness, undefined);
    assert.ok(
      quiet.errors.some((message) => message.includes("oval-authority")),
      "the refusal was not logged",
    );
    ingest.destroy();
  });
}

test("an authority that becomes unreadable is named at the next tick, though nothing else it reports changed", async () => {
  const clock = { now: NOW };
  const state = { reachable: true };
  const authority = {
    latest: () => undefined,
    latestOwnership: () => {
      if (!state.reachable) {
        throw new Error("the authority is not reachable");
      }
      return undefined;
    },
  };
  const { ingest, timers } = makeIngest(capturedFeed(), {
    authority: authority,
    nowFunction: () => clock.now,
  });
  const quiet = silenced();
  try {
    await ingest.start(NOW);
    assert.equal(ingest.diagnostics.payloadsRefused, 0);
    state.reachable = false;
    await tickMinutes(ingest, timers, clock, NOW, 1);
  } finally {
    quiet.restore();
  }
  assert.equal(ingest.diagnostics.payloadsRefused, 1);
  assert.equal(ingest.diagnostics.lastFailure.product, "oval-authority");
  assert.equal(ingest.latest().geomagnetic.authority, "rtsw");
  ingest.destroy();
});

test("a new provider's first X-ray answer is admitted against nothing the old provider delivered", async () => {
  const { ingest } = makeIngest(capturedFeed(), {
    nowFunction: () => NOW + MINUTE,
  });
  await ingest.start(NOW);
  // An hour behind the X-ray minute the old provider delivered.
  const behind = XRAY_NEWEST - 3600000;
  const next = capturedFeed();
  next.set(URL_XRAY, asServedAt(XRAYS, behind));
  ingest.replaceTransport(next.fetchJson);
  await ingest.refreshOnce(NOW + MINUTE);
  assert.equal(ingest.diagnostics.payloadsRefused, 0);
  assert.equal(ingest.diagnostics.xray.newest.timeTagMs, behind);
  ingest.destroy();
});

test("an answer that straggles long past a tick is judged at the instant it arrives, not at the tick", async () => {
  const clock = { now: NOW };
  const transport = capturedFeed();
  const slow = deferred();
  transport.set(URL_WIND, () => slow.promise);
  const { ingest, timers } = makeIngest(transport, {
    nowFunction: () => clock.now,
    pollIntervalSeconds: 600,
  });
  const started = ingest.start(NOW);
  await flush();
  clock.now = NOW + 600000;
  liveTimer(timers).handler();
  await flush();
  // It arrives 400 s after that tick, carrying minutes up to ten seconds
  // before it arrives: every one is behind the clock when it is judged.
  clock.now = NOW + 1000000;
  const newestServed = NOW + 990000;
  slow.resolve(shifted(WIND, newestServed - WIND_NEWEST));
  await started;
  await flush();
  assert.equal(ingest.diagnostics.plasma.newest.timeTagMs, newestServed);
  assert.equal(ingest.diagnostics.plasma.excluded["ahead-of-clock"], 0);
  assert.equal(ingest.diagnostics.payloadsRefused, 0);
  ingest.destroy();
});

test("a cycle whose request the timeout abandons settles then, though the transport never answers it", async () => {
  const clock = { now: NOW };
  const transport = capturedFeed();
  // A transport that ignores the abort, as one without an AbortSignal does.
  transport.set(URL_MAG, () => new Promise(() => {}));
  const { ingest, timers } = makeIngest(transport, {
    nowFunction: () => clock.now,
  });
  const settled = [];
  ingest.start(NOW).then(
    () => settled.push("start"),
    () => settled.push("start rejected"),
  );
  await flush();
  const settledAtMinute = [];
  const quiet = silenced();
  try {
    for (let minute = 1; minute <= 16; ++minute) {
      await tickMinutes(ingest, timers, clock, NOW + (minute - 1) * MINUTE, 1);
      if (settled.length > 0 && settledAtMinute.length === 0) {
        settledAtMinute.push(minute);
      }
    }
  } finally {
    quiet.restore();
  }
  assert.deepEqual(settled, ["start"]);
  assert.deepEqual(settledAtMinute, [15]);
  assert.equal(ingest.diagnostics.lastFailure.product, "rtsw-magnetometer");
  assert.equal(
    ingest.diagnostics.lastFailure.code,
    SolarWindFlareIngestCode.TRANSPORT,
  );
  ingest.destroy();
});

for (const end of ["stop", "destroy", "replaceTransport"]) {
  test(`a ${end} settles every cycle still waiting on a transport that ignores the abort`, async () => {
    const transport = capturedFeed();
    transport.set(URL_WIND, () => new Promise(() => {}));
    const { ingest } = makeIngest(transport);
    const settled = [];
    ingest.start(NOW).then(() => settled.push("start"));
    ingest.refreshOnce(NOW + MINUTE).then(() => settled.push("refresh"));
    await flush();
    // The second cycle asked nothing, because every product was still being
    // asked or had answered; only the first waits on the product that hangs.
    assert.deepEqual(settled, ["refresh"]);
    if (end === "replaceTransport") {
      ingest.replaceTransport(capturedFeed().fetchJson);
    } else {
      ingest[end]();
    }
    await flush();
    assert.deepEqual(settled, ["refresh", "start"]);
    ingest.destroy();
  });
}

for (const [answered, refused] of [
  ["magnetometer", "plasma"],
  ["plasma", "magnetometer"],
]) {
  test(`a new provider that answers for its ${answered} alone raises no handoff against the old provider's name`, async () => {
    const urls = { magnetometer: URL_MAG, plasma: URL_WIND };
    const payloads = { magnetometer: MAG, plasma: WIND };
    const renamed = (product, minutes, name) =>
      shifted(payloads[product], minutes * MINUTE).map((row) =>
        row.active ? { ...row, source: name } : row,
      );
    const clock = { now: NOW };
    const { ingest, timers } = makeIngest(capturedFeed(), {
      nowFunction: () => clock.now,
    });
    const handoffs = [];
    ingest.addEventListener((event) => {
      if (event.type === SolarWindFlareEventType.ACTIVE_SOURCE_HANDOFF) {
        handoffs.push(`${event.previous}->${event.current}`);
      }
    });
    await ingest.start(NOW);
    // The new provider names the spacecraft DSCOVR and its other product is
    // refused, so the two series come from two providers until the old one's
    // ages out and the new one's is the only one left.
    const next = capturedFeed();
    next.set(urls[answered], renamed(answered, 0, "DSCOVR"));
    next.set(urls[refused], []);
    ingest.replaceTransport(next.fetchJson);
    const quiet = silenced();
    try {
      for (let minute = 1; minute <= 25; ++minute) {
        next.set(urls[answered], renamed(answered, minute, "DSCOVR"));
        await tickMinutes(
          ingest,
          timers,
          clock,
          NOW + (minute - 1) * MINUTE,
          1,
        );
      }
      assert.equal(ingest.diagnostics[refused].newest.sourceName, "SOLAR1");
      assert.equal(ingest.diagnostics[answered].newest.sourceName, "DSCOVR");
      assert.ok(
        ingest.latest() === undefined,
        "the old series did not age out",
      );
      // Its other product answers at last, and then its own change of
      // spacecraft is a handoff like any other.
      next.set(urls[answered], renamed(answered, 26, "DSCOVR"));
      next.set(urls[refused], renamed(refused, 26, "DSCOVR"));
      await tickMinutes(ingest, timers, clock, NOW + 25 * MINUTE, 1);
      assert.equal(ingest.latest().solarWind.sourceName, "DSCOVR");
      next.set(urls[answered], renamed(answered, 27, "ACE"));
      next.set(urls[refused], renamed(refused, 27, "ACE"));
      await tickMinutes(ingest, timers, clock, NOW + 26 * MINUTE, 1);
    } finally {
      quiet.restore();
    }
    assert.equal(ingest.latest().solarWind.sourceName, "ACE");
    assert.deepEqual(handoffs, ["DSCOVR->ACE"]);
    ingest.destroy();
  });
}

test("a history window that is not a positive finite number of seconds is refused by name at construction", async () => {
  for (const historySeconds of [
    -1,
    0,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    "86400",
  ]) {
    assert.throws(
      () => makeIngest(capturedFeed(), { historySeconds: historySeconds }),
      (error) =>
        error.name === "DeveloperError" &&
        /options\.historySeconds/.test(error.message),
      `historySeconds ${String(historySeconds)} was accepted`,
    );
  }
  // A declared window bounds what is kept, measured from the newest minute.
  const { ingest } = makeIngest(capturedFeed(), { historySeconds: 3600 });
  await ingest.refreshOnce(NOW);
  const readings = ingest.diagnostics.plasma.readings;
  assert.ok(readings.length > 0 && readings.length <= 61);
  assert.ok(readings[0].timeTagMs >= WIND_NEWEST - 3600000);
  ingest.destroy();
});

test("a handoff needs a spacecraft named before it, by the same transport", () => {
  const state = (activeSource, activeSourceProvider) => ({
    flareClass: undefined,
    activityAuthority: "none",
    activeSource: activeSource,
    activeSourceProvider: activeSourceProvider,
  });
  const handoffs = (previous, next) =>
    transitionsBetween(previous, next, NOW)
      .events.filter(
        (event) => event.type === SolarWindFlareEventType.ACTIVE_SOURCE_HANDOFF,
      )
      .map((event) => `${event.previous}->${event.current}`);
  assert.deepEqual(handoffs(state("SOLAR1", 0), state("ACE", 0)), [
    "SOLAR1->ACE",
  ]);
  // Nothing named before it, even under the same transport.
  assert.deepEqual(handoffs(state(undefined, 0), state("SOLAR1", 0)), []);
  // Named by another transport.
  assert.deepEqual(handoffs(state("SOLAR1", 0), state("DSCOVR", 1)), []);
  // A composition that names nothing keeps the name and its transport.
  const kept = transitionsBetween(state("SOLAR1", 0), state(undefined, 1), NOW);
  assert.deepEqual(kept.events, []);
  assert.equal(kept.state.activeSource, "SOLAR1");
  assert.equal(kept.state.activeSourceProvider, 0);
  // A new name is kept with the transport that gave it.
  const moved = transitionsBetween(state("SOLAR1", 0), state("DSCOVR", 1), NOW);
  assert.equal(moved.state.activeSource, "DSCOVR");
  assert.equal(moved.state.activeSourceProvider, 1);
});

test("the solar-wind band is absent until a product delivers, and stale once neither product is current", async () => {
  const transport = feed({});
  const { ingest } = makeIngest(transport, { nowFunction: () => NOW });
  const quiet = silenced();
  try {
    await ingest.refreshOnce(NOW);
    assert.equal(ingest.diagnostics.solarWindFreshness, undefined);
    transport.set(URL_MAG, MAG);
    transport.set(URL_WIND, WIND);
    await ingest.refreshOnce(NOW);
    assert.equal(ingest.diagnostics.solarWindFreshness, "fresh");
    // The same minutes, an hour on: held, and no longer current.
    await ingest.refreshOnce(NOW + 3600000);
  } finally {
    quiet.restore();
  }
  assert.equal(ingest.diagnostics.plasma.newest.timeTagMs, WIND_NEWEST);
  assert.equal(ingest.diagnostics.solarWindFreshness, "stale");
  ingest.destroy();
});

// ---------------------------------------------------------------------------
// 7. A thrown value that cannot describe itself, the order of the refusals one
//    composition decides, the owners a decision may name, and the shortest
//    history window a caller may declare.
// ---------------------------------------------------------------------------

const { describeReason } = await import(
  `${ENGINE}SolarWindFlareFeedIngestHelpers.ts`
);

/** An Error whose message cannot be read. */
function unreadableMessageError() {
  const error = new Error("never read");
  Object.defineProperty(error, "message", {
    get() {
      throw new Error("the message cannot be read");
    },
  });
  return error;
}

/** An Error whose name is a Symbol, which no template literal can turn into text. */
function symbolNamedError() {
  const error = new Error("never read");
  error.name = Symbol("name");
  return error;
}

/** A revoked Proxy of an Error, on which even `instanceof` throws. */
function revokedError() {
  const { proxy, revoke } = Proxy.revocable(new Error("never read"), {});
  revoke();
  return proxy;
}

test("a thrown value that cannot describe itself is described by its type, and one that can by itself", () => {
  for (const [label, value] of [
    ["an Error whose message getter throws", unreadableMessageError()],
    ["an Error whose name is a Symbol", symbolNamedError()],
    ["a revoked Proxy of an Error", revokedError()],
  ]) {
    assert.equal(
      describeReason(value),
      "a object that cannot be described",
      label,
    );
  }
  assert.equal(describeReason(new Error("plain")), "Error: plain");
  assert.equal(describeReason(new TypeError("typed")), "TypeError: typed");
  assert.equal(describeReason("refused"), "refused");
  assert.equal(describeReason(Symbol("reason")), "Symbol(reason)");
});

test("an authority that throws a value that cannot describe itself is still an absent authority named as such, and polling carries on", async () => {
  const clock = { now: NOW };
  const transport = capturedFeed();
  const { ingest, timers } = makeIngest(transport, {
    authority: {
      latest: () => {
        throw unreadableMessageError();
      },
      latestOwnership: () => undefined,
    },
    nowFunction: () => clock.now,
  });
  const quiet = silenced();
  try {
    await ingest.start(NOW);
    await tickMinutes(ingest, timers, clock, NOW, 5);
  } finally {
    quiet.restore();
  }
  assert.equal(ingest.isRunning, true);
  assert.equal(transport.calls.length, 24);
  assert.equal(ingest.latest().geomagnetic.authority, "rtsw");
  assert.equal(ingest.diagnostics.lastFailure.product, "oval-authority");
  assert.equal(
    ingest.diagnostics.lastFailure.message,
    "the authority could not be read: a object that cannot be described",
  );
  ingest.destroy();
});

test("a listener that throws a value that cannot describe itself at a tick's own transition neither silences the listeners after it nor stops the polling", async () => {
  const clock = { now: NOW };
  const transport = capturedFeed();
  const packet = kpAuthorityPacket();
  const decision = { owner: undefined };
  const { ingest, timers } = makeIngest(transport, {
    authority: {
      latest: () => packet,
      latestOwnership: () =>
        fixedAuthority(packet, decision.owner).latestOwnership(),
    },
    nowFunction: () => clock.now,
  });
  ingest.addEventListener((event) => {
    if (
      event.type === SolarWindFlareEventType.ACTIVITY_AUTHORITY_CHANGE &&
      event.current === "kp"
    ) {
      throw unreadableMessageError();
    }
  });
  const heard = [];
  ingest.addEventListener((event) =>
    heard.push(`${event.type}:${event.current}`),
  );
  const quiet = silenced();
  try {
    await ingest.start(NOW);
    await tickMinutes(ingest, timers, clock, NOW, 1);
    assert.ok(!heard.includes("activity-authority-change:kp"));
    // The decision moves before the second tick, so that tick's own publish
    // raises the transition, inside the timer's handler.
    decision.owner = "kp";
    await tickMinutes(ingest, timers, clock, NOW + MINUTE, 4);
  } finally {
    quiet.restore();
  }
  assert.equal(ingest.isRunning, true);
  assert.equal(transport.calls.length, 24);
  assert.ok(
    heard.includes("activity-authority-change:kp"),
    JSON.stringify(heard),
  );
  assert.ok(
    quiet.errors.some((message) =>
      message.includes("listener threw: a object that cannot be described"),
    ),
    "the listener's throw was not logged",
  );
  ingest.destroy();
});

test("the refusals one composition decides are recorded in the order it decides them: the flare's, then the authority's", async () => {
  const invalid = {
    ...kpAuthorityPacket(),
    geomagnetic: { activity: 1.5, authority: "kp", kpIndex: 13.5 },
  };
  const transport = capturedFeed();
  transport.set(
    URL_XRAY,
    copy(XRAYS).map((row) =>
      row.energy === "0.1-0.8nm" && utc(row.time_tag) === XRAY_NEWEST
        ? { ...row, flux: 1.5e-3 }
        : row,
    ),
  );
  const { ingest } = makeIngest(transport, {
    authority: fixedAuthority(invalid, "kp"),
  });
  const quiet = silenced();
  try {
    await ingest.start(NOW);
  } finally {
    quiet.restore();
  }
  const packet = ingest.latest();
  assert.equal(packet.geomagnetic.authority, "rtsw");
  assert.equal(packet.flare, undefined);
  assert.equal(ingest.diagnostics.payloadsRefused, 2);
  // The last recorded is the authority's; the one logged, the first, is the
  // flare's, because the second falls inside the log's throttle interval.
  assert.equal(ingest.diagnostics.lastFailure.product, "oval-authority");
  assert.equal(quiet.errors.length, 1);
  assert.match(quiet.errors[0], /goes-xray payload refused \(invalid-packet\)/);
  ingest.destroy();
});

test("an authority whose packet cannot be read names no owner, whatever its decision said", async () => {
  const clock = { now: NOW };
  const state = { readable: true };
  const packet = kpAuthorityPacket();
  const { ingest, timers } = makeIngest(capturedFeed(), {
    authority: {
      latest: () => {
        if (!state.readable) {
          throw new Error("the authority is not reachable");
        }
        return packet;
      },
      latestOwnership: fixedAuthority(packet, "kp").latestOwnership,
    },
    nowFunction: () => clock.now,
  });
  const quiet = silenced();
  try {
    await ingest.start(NOW);
    assert.equal(ingest.diagnostics.ovalOwner, "kp");
    assert.equal(ingest.latest().geomagnetic.authority, "kp");
    state.readable = false;
    await tickMinutes(ingest, timers, clock, NOW, 1);
  } finally {
    quiet.restore();
  }
  assert.equal(ingest.diagnostics.ovalOwner, "none");
  assert.equal(ingest.latest().geomagnetic.authority, "rtsw");
  assert.equal(ingest.diagnostics.lastFailure.product, "oval-authority");
  ingest.destroy();
});

test("a decision naming an owner outside the vocabulary is refused by name, and composes neither the authority's scalar nor its oval", async () => {
  // The control: the same packet under an owner the vocabulary names.
  const control = makeIngest(capturedFeed(), {
    authority: fixedAuthority(kpAuthorityPacket(), "kp"),
  }).ingest;
  await control.start(NOW);
  assert.equal(control.latest().geomagnetic.authority, "kp");
  control.destroy();
  for (const [owner, named] of [
    ["OVATION", '"OVATION"'],
    [42, "42"],
    ["kp ", '"kp "'],
  ]) {
    const { ingest } = makeIngest(capturedFeed(), {
      authority: fixedAuthority(kpAuthorityPacket(), owner),
    });
    const quiet = silenced();
    try {
      await ingest.start(NOW);
    } finally {
      quiet.restore();
    }
    const packet = ingest.latest();
    assert.equal(packet.geomagnetic.authority, "rtsw", `owner ${named}`);
    assert.ok(packet.oval === undefined);
    assert.equal(ingest.diagnostics.ovalOwner, "none");
    assert.equal(ingest.diagnostics.authorityPacketFreshness, undefined);
    assert.equal(ingest.diagnostics.lastFailure.product, "oval-authority");
    assert.equal(
      ingest.diagnostics.lastFailure.code,
      SolarWindFlareIngestCode.INVALID_PACKET,
    );
    assert.equal(
      ingest.diagnostics.lastFailure.message,
      `the authority's decision names an owner outside the vocabulary: ${named}`,
    );
    assert.equal(quiet.errors.length, 1);
    ingest.destroy();
  }
});

test("a history window shorter than the one-minute cadence is refused by name at construction, and a window of one minute forms the estimate", async () => {
  for (const historySeconds of [59, 30, 0.5, 1e-9, Number.MIN_VALUE]) {
    assert.throws(
      () => makeIngest(capturedFeed(), { historySeconds: historySeconds }),
      (error) =>
        error.name === "DeveloperError" &&
        /options\.historySeconds.*at least the 60 s cadence/.test(
          error.message,
        ),
      `historySeconds ${historySeconds} was accepted`,
    );
  }
  const { ingest } = makeIngest(capturedFeed(), { historySeconds: 60 });
  await ingest.refreshOnce(NOW);
  const readings = ingest.diagnostics.plasma.readings;
  assert.ok(readings.length >= 1 && readings.length <= 2);
  assert.ok(readings[0].timeTagMs >= WIND_NEWEST - MINUTE);
  assert.equal(ingest.latest().geomagnetic.authority, "rtsw");
  ingest.destroy();
});
