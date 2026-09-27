/**
 * Turns the geostationary X-ray payload and its instrument-source mapping into
 * two ascending passband series and a flare classification, or refuses them with
 * a typed reason.
 *
 * What the bytes require, as measured:
 *
 *   - **Both passbands are interleaved in one array**, one row per band per
 *     minute, and are split on the row's own `energy` value. The long band is the
 *     one flares are classified on.
 *   - **Rows are published oldest first**, the opposite of the solar-wind
 *     products, and the order is normalized here anyway: a rule about time that
 *     depends on which feed it is pointed at is a rule waiting to be pointed at
 *     the other one.
 *   - **A dropout is published as a zero flux**, on both bands at once, for the
 *     minutes a sensor is calibrating or the spacecraft is in eclipse. A zero is
 *     not a measurement of a dark Sun; those minutes are excluded and reported as
 *     runs so a consumer can say why the channel went quiet.
 *   - **The contamination field is spelled `electron_contaminaton`** in the
 *     payload and is read under that spelling.
 *   - **Which spacecraft is primary changes**, per instrument and not globally,
 *     and the mapping that says so is itself a history published newest first.
 *     It is read at an instant, never as "the first row".
 *
 * The flux unit is not stated in the payload. The classification below uses the
 * standard soft X-ray scale, whose thresholds are defined in W/m^2 on this long
 * band, and states that it does.
 *
 * Nothing here fetches, reads a clock, imports a renderer, or branches on the
 * active backend.
 *
 * @module Scene/SpaceWeather/GoesXrayNormalizer
 */
import {
  SOLAR_FLARE_CLASSES,
  SPACE_WEATHER_FILL_VALUE,
  type SolarFlareClassValue,
} from "./SpaceWeatherTypes.js";
import { parseSpaceWeatherTimeTag } from "./PlanetaryKpNormalizer.js";

/** The long passband, 0.1 to 0.8 nm, as the payload names it. */
export const GOES_XRAY_LONG_BAND = "0.1-0.8nm";

/** The short passband, 0.05 to 0.4 nm, as the payload names it. */
export const GOES_XRAY_SHORT_BAND = "0.05-0.4nm";

/**
 * Publication cadence of each band, in seconds. Every interval measured between
 * consecutive rows of one band is this long.
 */
export const GOES_XRAY_CADENCE_SECONDS = 60;

/**
 * Lower edge of each flare class on the long band, in W/m^2, ascending with
 * {@link SOLAR_FLARE_CLASSES}: each class is one decade of flux.
 */
export const SOLAR_FLARE_CLASS_FLOORS: Readonly<
  Record<SolarFlareClassValue, number>
> = Object.freeze({
  A: 1e-8,
  B: 1e-7,
  C: 1e-6,
  M: 1e-5,
  X: 1e-4,
});

/** Why a payload was refused. */
export type GoesXrayRejectionCodeValue =
  "not-an-array" | "empty" | "row-shape" | "field-type" | "no-usable-rows";

/** Enumerated {@link GoesXrayRejectionCodeValue} constants. */
export const GoesXrayRejectionCode = Object.freeze({
  NOT_AN_ARRAY: "not-an-array",
  EMPTY: "empty",
  ROW_SHAPE: "row-shape",
  FIELD_TYPE: "field-type",
  NO_USABLE_ROWS: "no-usable-rows",
});

/**
 * Why a row was left out of its band. Like the solar-wind products, the X-ray
 * product carries a day of minutes, so a fault in one row costs that row only,
 * a row that is not an object or whose spacecraft or band cannot be read
 * included.
 */
export type GoesXrayExclusionValue =
  | "row-shape"
  | "field-type"
  | "time-tag"
  | "ahead-of-clock"
  | "dropout"
  | "fill-value"
  | "missing-value"
  | "unknown-band"
  | "not-primary";

/** Enumerated {@link GoesXrayExclusionValue} constants. */
export const GoesXrayExclusion = Object.freeze({
  ROW_SHAPE: "row-shape",
  FIELD_TYPE: "field-type",
  TIME_TAG: "time-tag",
  AHEAD_OF_CLOCK: "ahead-of-clock",
  DROPOUT: "dropout",
  FILL_VALUE: "fill-value",
  MISSING_VALUE: "missing-value",
  UNKNOWN_BAND: "unknown-band",
  NOT_PRIMARY: "not-primary",
});

/** A refusal: the rule that was violated, and where. */
export interface GoesXrayRejection {
  code: GoesXrayRejectionCodeValue;
  message: string;
}

/** One usable minute of one band. */
export interface GoesXrayReading {
  /** Row instant, in ms since the Unix epoch. */
  timeTagMs: number;
  /** The reporting spacecraft number. */
  satellite: number;
  /** Electron-corrected flux, positive. */
  flux: number;
  /** The payload's contamination flag, read under the payload's spelling. */
  electronContaminated: boolean;
}

/** A run of consecutive dropout minutes. */
export interface GoesXrayDropout {
  /** First dropout instant, in ms since the Unix epoch. */
  startMs: number;
  /** Last dropout instant, in ms since the Unix epoch. */
  endMs: number;
  /** Dropout minutes in the run. */
  minutes: number;
}

/** Both passbands, normalized and ascending. */
export interface GoesXraySeries {
  /** Long-band readings, ascending. */
  longBand: readonly GoesXrayReading[];
  /** Short-band readings, ascending. */
  shortBand: readonly GoesXrayReading[];
  /** The newest long-band reading. */
  newest: GoesXrayReading;
  /** Rows the payload carried, both bands. */
  rowsRead: number;
  /** Rows left out, by reason. */
  excluded: Readonly<Record<GoesXrayExclusionValue, number>>;
  /** Runs of long-band dropout minutes, ascending. */
  dropouts: readonly GoesXrayDropout[];
  /** The primary spacecraft the rows were filtered to, when one was known. */
  primarySatellite?: number;
}

/**
 * The outcome of {@link normalizeGoesXrayPayload}. A string discriminant, for
 * the reason given in the sibling normalizers.
 */
export type GoesXrayResult =
  | { status: "ok"; series: GoesXraySeries }
  | { status: "refused"; error: GoesXrayRejection };

function rejection(
  code: GoesXrayRejectionCodeValue,
  message: string,
): GoesXrayResult {
  return { status: "refused", error: { code: code, message: message } };
}

function dropoutRuns(instantsMs: number[]): GoesXrayDropout[] {
  const sorted = [...new Set(instantsMs)].sort((a, b) => a - b);
  const runs: GoesXrayDropout[] = [];
  for (const instant of sorted) {
    const last = runs[runs.length - 1];
    if (
      last !== undefined &&
      instant - last.endMs === GOES_XRAY_CADENCE_SECONDS * 1000
    ) {
      last.endMs = instant;
      ++last.minutes;
    } else {
      runs.push({ startMs: instant, endMs: instant, minutes: 1 });
    }
  }
  return runs;
}

/**
 * Normalize a decoded X-ray payload, or refuse it.
 *
 * @param payload The decoded JSON payload.
 * @param primarySatellite The X-ray primary spacecraft the instrument-source
 *   mapping names at the deciding instant, or `undefined` when no mapping is
 *   held. When given, rows from any other spacecraft are excluded; when not, the
 *   rows are taken as published and the series says no primary was known.
 * @returns Both ascending bands, or a typed refusal.
 */
export function normalizeGoesXrayPayload(
  payload: unknown,
  primarySatellite?: number,
): GoesXrayResult {
  if (!Array.isArray(payload)) {
    return rejection(
      GoesXrayRejectionCode.NOT_AN_ARRAY,
      "payload: must be an array of row objects",
    );
  }
  if (payload.length === 0) {
    return rejection(GoesXrayRejectionCode.EMPTY, "payload: carries no rows");
  }

  const excluded: Record<GoesXrayExclusionValue, number> = {
    "row-shape": 0,
    "field-type": 0,
    "time-tag": 0,
    "ahead-of-clock": 0,
    dropout: 0,
    "fill-value": 0,
    "missing-value": 0,
    "unknown-band": 0,
    "not-primary": 0,
  };
  const longBand: GoesXrayReading[] = [];
  const shortBand: GoesXrayReading[] = [];
  const longDropouts: number[] = [];
  let objectRows = 0;
  let typedRows = 0;

  for (const row of payload as unknown[]) {
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      ++excluded[GoesXrayExclusion.ROW_SHAPE];
      continue;
    }
    ++objectRows;
    const record = row as Record<string, unknown>;
    if (
      typeof record.satellite !== "number" ||
      !Number.isInteger(record.satellite) ||
      typeof record.energy !== "string"
    ) {
      ++excluded[GoesXrayExclusion.FIELD_TYPE];
      continue;
    }
    ++typedRows;
    const band =
      record.energy === GOES_XRAY_LONG_BAND
        ? longBand
        : record.energy === GOES_XRAY_SHORT_BAND
          ? shortBand
          : undefined;
    if (band === undefined) {
      ++excluded[GoesXrayExclusion.UNKNOWN_BAND];
      continue;
    }
    if (
      primarySatellite !== undefined &&
      record.satellite !== primarySatellite
    ) {
      ++excluded[GoesXrayExclusion.NOT_PRIMARY];
      continue;
    }
    const timeTagMs = parseSpaceWeatherTimeTag(record.time_tag);
    if (!Number.isFinite(timeTagMs)) {
      ++excluded[GoesXrayExclusion.TIME_TAG];
      continue;
    }
    const flux = record.flux;
    if (typeof flux !== "number" || !Number.isFinite(flux)) {
      ++excluded[GoesXrayExclusion.MISSING_VALUE];
      continue;
    }
    // By name and first: the fill is negative, and the dropout test below would
    // otherwise report it as an eclipse minute.
    if (flux === SPACE_WEATHER_FILL_VALUE) {
      ++excluded[GoesXrayExclusion.FILL_VALUE];
      continue;
    }
    if (flux <= 0) {
      ++excluded[GoesXrayExclusion.DROPOUT];
      if (band === longBand) {
        longDropouts.push(timeTagMs);
      }
      continue;
    }
    band.push({
      timeTagMs: timeTagMs,
      satellite: record.satellite,
      flux: flux,
      electronContaminated: record.electron_contaminaton === true,
    });
  }

  // Normalized before any conclusion about time, whatever order the publisher
  // chose today.
  longBand.sort((a, b) => a.timeTagMs - b.timeTagMs);
  shortBand.sort((a, b) => a.timeTagMs - b.timeTagMs);

  if (objectRows === 0) {
    return rejection(
      GoesXrayRejectionCode.ROW_SHAPE,
      "payload: none of its rows is an object",
    );
  }
  if (typedRows === 0) {
    return rejection(
      GoesXrayRejectionCode.FIELD_TYPE,
      'payload: no row carries an integer "satellite" and a string "energy"',
    );
  }
  if (longBand.length === 0) {
    return rejection(
      GoesXrayRejectionCode.NO_USABLE_ROWS,
      `payload: no usable ${GOES_XRAY_LONG_BAND} row among ${payload.length} (exclusions ${JSON.stringify(excluded)})`,
    );
  }

  return {
    status: "ok",
    series: {
      longBand: longBand,
      shortBand: shortBand,
      newest: longBand[longBand.length - 1],
      rowsRead: payload.length,
      excluded: Object.freeze(excluded),
      dropouts: dropoutRuns(longDropouts),
      primarySatellite: primarySatellite,
    },
  };
}

/**
 * The series without the readings whose instant the caller's predicate does not
 * credit.
 *
 * The caller passes the folder's plausibility rule at the deciding instant; a
 * minute it does not credit is excluded and counted rather than allowed to
 * become the newest instant, for the reason the solar-wind series gives.
 *
 * @param series A normalized series.
 * @param isCredible Whether a reading's instant may be kept.
 * @returns The series, the same object when every reading is credited, or
 *   `undefined` when no long-band reading is.
 */
export function goesXraySeriesCredited(
  series: GoesXraySeries,
  isCredible: (timeTagMs: number) => boolean,
): GoesXraySeries | undefined {
  const credible = (reading: GoesXrayReading) => isCredible(reading.timeTagMs);
  const longBand = series.longBand.filter(credible);
  const shortBand = series.shortBand.filter(credible);
  if (
    longBand.length === series.longBand.length &&
    shortBand.length === series.shortBand.length
  ) {
    return series;
  }
  if (longBand.length === 0) {
    return undefined;
  }
  const excluded = { ...series.excluded };
  excluded[GoesXrayExclusion.AHEAD_OF_CLOCK] +=
    series.longBand.length -
    longBand.length +
    series.shortBand.length -
    shortBand.length;
  return {
    ...series,
    longBand: longBand,
    shortBand: shortBand,
    newest: longBand[longBand.length - 1],
    excluded: Object.freeze(excluded),
  };
}

/** Why an instrument-source mapping was refused. */
export type GoesInstrumentSourceRejectionCodeValue =
  "not-an-array" | "empty" | "row-shape" | "time-tag" | "field-missing";

/** Enumerated {@link GoesInstrumentSourceRejectionCodeValue} constants. */
export const GoesInstrumentSourceRejectionCode = Object.freeze({
  NOT_AN_ARRAY: "not-an-array",
  EMPTY: "empty",
  ROW_SHAPE: "row-shape",
  TIME_TAG: "time-tag",
  FIELD_MISSING: "field-missing",
});

/** One statement of which spacecraft is the X-ray primary, from when. */
export interface GoesXrayPrimaryEntry {
  /** Instant the mapping took effect, in ms since the Unix epoch. */
  timeTagMs: number;
  /**
   * The X-ray primary spacecraft, or `undefined` where the mapping published
   * the fill value: from that instant it names no primary.
   */
  primary: number | undefined;
}

/** The mapping's X-ray history, ascending. */
export interface GoesInstrumentSources {
  /** Every entry, ascending, with ambiguous instants removed. */
  entries: readonly GoesXrayPrimaryEntry[];
  /** Instants at which two entries named different primaries. */
  ambiguousInstants: number;
  /** Mapping rows whose X-ray primary was the fill value. */
  fillPrimaries: number;
}

/** The outcome of {@link normalizeGoesInstrumentSources}. */
export type GoesInstrumentSourcesResult =
  | { status: "ok"; sources: GoesInstrumentSources }
  | {
      status: "refused";
      error: { code: GoesInstrumentSourceRejectionCodeValue; message: string };
    };

/**
 * Normalize the instrument-source mapping to its X-ray history, or refuse it.
 *
 * The mapping is an array of dated entries. Two entries at one instant that
 * name the same primary are one statement published twice; two that disagree
 * say nothing, and that instant is dropped rather than resolved by position. A
 * primary equal to the fill value is refused by name: the entry states that no
 * primary is named from its instant, so neither the fill nor an older entry's
 * spacecraft is used to filter the X-ray rows then.
 *
 * @param payload The decoded JSON payload.
 * @returns The ascending history, or a typed refusal.
 */
export function normalizeGoesInstrumentSources(
  payload: unknown,
): GoesInstrumentSourcesResult {
  const refuse = (
    code: GoesInstrumentSourceRejectionCodeValue,
    message: string,
  ): GoesInstrumentSourcesResult => ({
    status: "refused",
    error: { code: code, message: message },
  });
  if (!Array.isArray(payload)) {
    return refuse(
      GoesInstrumentSourceRejectionCode.NOT_AN_ARRAY,
      "payload: must be an array of mapping objects",
    );
  }
  if (payload.length === 0) {
    return refuse(
      GoesInstrumentSourceRejectionCode.EMPTY,
      "payload: carries no mapping",
    );
  }
  const byInstant = new Map<number, Set<number | undefined>>();
  let fillPrimaries = 0;
  for (let index = 0; index < payload.length; ++index) {
    const row: unknown = payload[index];
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      return refuse(
        GoesInstrumentSourceRejectionCode.ROW_SHAPE,
        `payload[${index}]: must be an object`,
      );
    }
    const record = row as Record<string, unknown>;
    const timeTagMs = parseSpaceWeatherTimeTag(record.time_tag);
    if (!Number.isFinite(timeTagMs)) {
      return refuse(
        GoesInstrumentSourceRejectionCode.TIME_TAG,
        `payload[${index}].time_tag: must be a parseable instant, received ${JSON.stringify(record.time_tag)}`,
      );
    }
    const xrays = record.xrays;
    const primary =
      typeof xrays === "object" && xrays !== null
        ? (xrays as Record<string, unknown>).primary
        : undefined;
    if (typeof primary !== "number" || !Number.isInteger(primary)) {
      return refuse(
        GoesInstrumentSourceRejectionCode.FIELD_MISSING,
        `payload[${index}].xrays.primary: must be an integer spacecraft number`,
      );
    }
    const named = byInstant.get(timeTagMs) ?? new Set<number | undefined>();
    if (primary === SPACE_WEATHER_FILL_VALUE) {
      ++fillPrimaries;
      named.add(undefined);
    } else {
      named.add(primary);
    }
    byInstant.set(timeTagMs, named);
  }
  const entries: GoesXrayPrimaryEntry[] = [];
  let ambiguousInstants = 0;
  for (const [timeTagMs, named] of byInstant) {
    if (named.size !== 1) {
      ++ambiguousInstants;
      continue;
    }
    entries.push({ timeTagMs: timeTagMs, primary: [...named][0] });
  }
  entries.sort((a, b) => a.timeTagMs - b.timeTagMs);
  return {
    status: "ok",
    sources: {
      entries: entries,
      ambiguousInstants: ambiguousInstants,
      fillPrimaries: fillPrimaries,
    },
  };
}

/**
 * The X-ray primary in effect at an instant.
 *
 * @param sources The normalized mapping.
 * @param nowMs The instant, in ms since the Unix epoch.
 * @returns The spacecraft number, or `undefined` before the first entry and
 *   while the entry in force names no primary.
 */
export function goesXrayPrimaryAt(
  sources: GoesInstrumentSources,
  nowMs: number,
): number | undefined {
  let found: number | undefined;
  for (const entry of sources.entries) {
    if (entry.timeTagMs > nowMs) {
      break;
    }
    found = entry.primary;
  }
  return found;
}

/** A flare class and the magnitude within it. */
export interface SolarFlareClassification {
  flareClass: SolarFlareClassValue;
  /** Flux over the class floor; in `[1,10)` for every class but the top one. */
  magnitude: number;
}

/**
 * Classify a long-band flux on the standard soft X-ray scale.
 *
 * The top class is open-ended on that scale, so its magnitude can reach ten and
 * beyond; the packet's own range decides whether such a value can be carried.
 *
 * @param longBandFlux Long-band flux in W/m^2.
 * @returns The classification, or `undefined` below the floor of the lowest
 *   class, where the scale assigns none.
 */
export function classifySolarXrayFlux(
  longBandFlux: number,
): SolarFlareClassification | undefined {
  if (!Number.isFinite(longBandFlux)) {
    return undefined;
  }
  for (let i = SOLAR_FLARE_CLASSES.length - 1; i >= 0; --i) {
    const flareClass = SOLAR_FLARE_CLASSES[i];
    const floor = SOLAR_FLARE_CLASS_FLOORS[flareClass];
    if (longBandFlux >= floor) {
      return { flareClass: flareClass, magnitude: longBandFlux / floor };
    }
  }
  return undefined;
}

/**
 * The newest reading of one band at or before an instant.
 *
 * @param readings Ascending readings of one band.
 * @param nowMs The instant, in ms since the Unix epoch.
 * @returns The reading, or `undefined`.
 */
export function goesXrayReadingAt(
  readings: readonly GoesXrayReading[],
  nowMs: number,
): GoesXrayReading | undefined {
  let found: GoesXrayReading | undefined;
  for (const reading of readings) {
    if (reading.timeTagMs > nowMs) {
      break;
    }
    found = reading;
  }
  return found;
}
