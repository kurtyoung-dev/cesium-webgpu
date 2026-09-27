/**
 * Turns a real-time solar-wind payload — the magnetometer product or the plasma
 * product — into an ascending series of usable readings from the active
 * spacecraft, or refuses it with a typed reason.
 *
 * Four properties of these products decide the shape of this module, and each
 * one breaks a reader written from the product description rather than from the
 * bytes:
 *
 *   - **Rows are published newest first.** Every time conclusion in this folder
 *     is drawn from a normalized ascending series, so the sort happens before the
 *     newest instant, the gaps or the handoffs are read. A rule about time that
 *     runs before the sort discards the whole feed.
 *   - **Every instant appears once per spacecraft**, and only one of them is the
 *     operational source. Rows are filtered on the feed's own `active` flag before
 *     cadence or gaps mean anything, and the spacecraft is never named in code:
 *     the active source is read per row and reported.
 *   - **The flag columns carry the fill value on healthy rows.** The active
 *     magnetometer's `max_data_flag` is the fill on every row measured, so no flag
 *     column is read here. The feed's `overall_quality` is the gate.
 *   - **`time_tag` carries no zone designator**, and is parsed through the
 *     folder's one timestamp rule.
 *
 * A measured value equal to the fill is refused by name rather than by range.
 * Several ranges contain it, so a range check would accept it for some fields and
 * report it as the wrong fault for the others.
 *
 * Row-level faults exclude the row and are counted by reason; they never refuse
 * the payload, because the product carries a day of minutes and one bad minute
 * is not a reason to discard the other fourteen hundred. A row that is not an
 * object, a row whose `active` flag is not a boolean and an unreadable
 * `time_tag` are among them, and a standby spacecraft's row is set aside
 * before its tag is read at all. A payload is refused only when it is not an
 * array of rows, when no row carries the flag at all, or when nothing in it is
 * usable.
 *
 * Nothing here fetches, reads a clock, imports a renderer, or branches on the
 * active backend.
 *
 * @module Scene/SpaceWeather/RealTimeSolarWindNormalizer
 */
import {
  SPACE_WEATHER_FILL_VALUE,
  SPACE_WEATHER_RANGES,
  type SpaceWeatherRange,
} from "./SpaceWeatherTypes.js";
import { parseSpaceWeatherTimeTag } from "./PlanetaryKpNormalizer.js";

/** Which of the two real-time solar-wind products a payload came from. */
export type RealTimeSolarWindProductValue = "magnetometer" | "plasma";

/** Enumerated {@link RealTimeSolarWindProductValue} constants. */
export const RealTimeSolarWindProduct = Object.freeze({
  MAGNETOMETER: "magnetometer",
  PLASMA: "plasma",
});

/**
 * Publication cadence of the active source, in seconds.
 *
 * Measured on both captures of both products: after filtering to the active
 * source, every interval between rows is this long except where a row is
 * missing. An interval longer than this is a gap.
 */
export const REAL_TIME_SOLAR_WIND_CADENCE_SECONDS = 60;

/**
 * The `overall_quality` value a usable row carries.
 *
 * It is the only value measured on any row of either product in either capture.
 * The feed does not publish the meaning of the other values, so a row carrying
 * one is excluded and counted rather than interpreted.
 */
export const REAL_TIME_SOLAR_WIND_QUALITY_GOOD = 0;

/** One measured field: its wire name, where it lands, and its bound. */
interface MeasuredField {
  wire: string;
  key: keyof RealTimeSolarWindMeasurements;
  range: SpaceWeatherRange;
}

/**
 * The measured fields each product must carry on a usable row.
 *
 * The magnetometer's `bt` is the magnitude of all three components; the
 * transverse magnitude a coupling function uses is derived from `by_gsm` and
 * `bz_gsm`, which is why both are carried. The plasma names are the proton
 * fields the product was renamed to.
 */
export const REAL_TIME_SOLAR_WIND_FIELDS: Readonly<
  Record<RealTimeSolarWindProductValue, readonly MeasuredField[]>
> = Object.freeze({
  magnetometer: Object.freeze([
    { wire: "bt", key: "btNanoTesla", range: SPACE_WEATHER_RANGES.btNanoTesla },
    {
      wire: "by_gsm",
      key: "byGsmNanoTesla",
      // The same component envelope as the north-south component: both exist to
      // catch a unit error or a fill, not to bound a storm.
      range: SPACE_WEATHER_RANGES.bzGsmNanoTesla,
    },
    {
      wire: "bz_gsm",
      key: "bzGsmNanoTesla",
      range: SPACE_WEATHER_RANGES.bzGsmNanoTesla,
    },
  ] as MeasuredField[]),
  plasma: Object.freeze([
    {
      wire: "proton_speed",
      key: "speedKmPerSecond",
      range: SPACE_WEATHER_RANGES.solarWindSpeedKmPerSecond,
    },
    {
      wire: "proton_density",
      key: "densityPerCubicCm",
      range: SPACE_WEATHER_RANGES.solarWindDensityPerCubicCm,
    },
    {
      wire: "proton_temperature",
      key: "temperatureKelvin",
      range: SPACE_WEATHER_RANGES.solarWindTemperatureKelvin,
    },
  ] as MeasuredField[]),
});

/** Why a payload was refused. */
export type RealTimeSolarWindRejectionCodeValue =
  "not-an-array" | "empty" | "row-shape" | "active-flag" | "no-usable-rows";

/** Enumerated {@link RealTimeSolarWindRejectionCodeValue} constants. */
export const RealTimeSolarWindRejectionCode = Object.freeze({
  NOT_AN_ARRAY: "not-an-array",
  EMPTY: "empty",
  ROW_SHAPE: "row-shape",
  ACTIVE_FLAG: "active-flag",
  NO_USABLE_ROWS: "no-usable-rows",
});

/**
 * Why a row was left out of the series: an active row for most reasons, and a
 * row whose shape or flag cannot be read before it can be told active or not.
 */
export type RealTimeSolarWindExclusionValue =
  | "row-shape"
  | "active-flag"
  | "time-tag"
  | "ahead-of-clock"
  | "bad-quality"
  | "fill-value"
  | "missing-value"
  | "out-of-range"
  | "source-name"
  | "ambiguous-instant";

/** Enumerated {@link RealTimeSolarWindExclusionValue} constants. */
export const RealTimeSolarWindExclusion = Object.freeze({
  ROW_SHAPE: "row-shape",
  ACTIVE_FLAG: "active-flag",
  TIME_TAG: "time-tag",
  AHEAD_OF_CLOCK: "ahead-of-clock",
  BAD_QUALITY: "bad-quality",
  FILL_VALUE: "fill-value",
  MISSING_VALUE: "missing-value",
  OUT_OF_RANGE: "out-of-range",
  SOURCE_NAME: "source-name",
  AMBIGUOUS_INSTANT: "ambiguous-instant",
});

/** A refusal: the rule that was violated, and where. */
export interface RealTimeSolarWindRejection {
  code: RealTimeSolarWindRejectionCodeValue;
  message: string;
}

/** The measured values one reading may carry; each product fills its own. */
export interface RealTimeSolarWindMeasurements {
  btNanoTesla?: number;
  byGsmNanoTesla?: number;
  bzGsmNanoTesla?: number;
  speedKmPerSecond?: number;
  densityPerCubicCm?: number;
  temperatureKelvin?: number;
}

/** One usable minute from the active source. */
export interface RealTimeSolarWindReading extends RealTimeSolarWindMeasurements {
  /** Row instant, in ms since the Unix epoch. */
  timeTagMs: number;
  /** The reporting spacecraft, as the feed names it. */
  sourceName: string;
  /** The feed's own quality value for the row. */
  overallQuality: number;
}

/** How many intervals of one length the series contains. */
export interface RealTimeSolarWindGap {
  /** Interval between consecutive usable readings, in seconds. */
  seconds: number;
  /** How many times it occurs. */
  count: number;
}

/** A normalized, ascending series from the active source. */
export interface RealTimeSolarWindSeries {
  /** Which product produced it. */
  product: RealTimeSolarWindProductValue;
  /** Every usable reading, ascending in time, one per instant. */
  readings: readonly RealTimeSolarWindReading[];
  /** The newest usable reading. */
  newest: RealTimeSolarWindReading;
  /** Rows the payload carried, from every spacecraft. */
  rowsRead: number;
  /** Rows from a spacecraft the feed did not mark active. */
  inactiveRows: number;
  /** Rows left out, by reason. */
  excluded: Readonly<Record<RealTimeSolarWindExclusionValue, number>>;
  /**
   * Every interval longer than the cadence between consecutive readings,
   * ascending by length. Empty for an unbroken series.
   */
  gaps: readonly RealTimeSolarWindGap[];
  /** How many times the reporting spacecraft changes along the series. */
  sourceHandoffs: number;
}

/**
 * The outcome of {@link normalizeRealTimeSolarWindPayload}.
 *
 * The discriminant is a string, as in the sibling normalizers: the engine
 * compiles with `strict` off, and a boolean-literal discriminant only narrows
 * when `strictNullChecks` is on.
 */
export type RealTimeSolarWindResult =
  | { status: "ok"; series: RealTimeSolarWindSeries }
  | { status: "refused"; error: RealTimeSolarWindRejection };

function rejection(
  code: RealTimeSolarWindRejectionCodeValue,
  message: string,
): RealTimeSolarWindResult {
  return { status: "refused", error: { code: code, message: message } };
}

function emptyExclusions(): Record<RealTimeSolarWindExclusionValue, number> {
  return {
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
  };
}

/**
 * Read one active row's measured fields, or name the first reason it cannot be
 * used.
 */
function readMeasurements(
  record: Record<string, unknown>,
  fields: readonly MeasuredField[],
  reading: RealTimeSolarWindReading,
): RealTimeSolarWindExclusionValue | undefined {
  for (const field of fields) {
    const value = record[field.wire];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return RealTimeSolarWindExclusion.MISSING_VALUE;
    }
    // By name, and before the range: the fill sits inside some of the ranges
    // and outside others, so only this comparison reports it as what it is.
    if (value === SPACE_WEATHER_FILL_VALUE) {
      return RealTimeSolarWindExclusion.FILL_VALUE;
    }
    if (value < field.range.minimum || value > field.range.maximum) {
      return RealTimeSolarWindExclusion.OUT_OF_RANGE;
    }
    reading[field.key] = value;
  }
  return undefined;
}

/**
 * Describe the intervals of an ascending series that exceed the cadence.
 *
 * @param readings Ascending readings.
 * @returns One entry per distinct interval length, ascending.
 */
export function realTimeSolarWindGaps(
  readings: readonly RealTimeSolarWindReading[],
): RealTimeSolarWindGap[] {
  const counts = new Map<number, number>();
  for (let i = 1; i < readings.length; ++i) {
    const seconds = (readings[i].timeTagMs - readings[i - 1].timeTagMs) / 1000;
    if (seconds > REAL_TIME_SOLAR_WIND_CADENCE_SECONDS) {
      counts.set(seconds, (counts.get(seconds) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([seconds, count]) => ({ seconds: seconds, count: count }));
}

function countHandoffs(readings: readonly RealTimeSolarWindReading[]): number {
  let handoffs = 0;
  for (let i = 1; i < readings.length; ++i) {
    if (readings[i].sourceName !== readings[i - 1].sourceName) {
      ++handoffs;
    }
  }
  return handoffs;
}

/**
 * Normalize a decoded real-time solar-wind payload, or refuse it.
 *
 * @param payload The decoded JSON payload; `unknown` because this is the
 *   engine's boundary against a network response.
 * @param product Which product the payload came from; it selects the fields a
 *   usable row must carry.
 * @returns The ascending series, or a typed refusal.
 */
export function normalizeRealTimeSolarWindPayload(
  payload: unknown,
  product: RealTimeSolarWindProductValue,
): RealTimeSolarWindResult {
  if (!Array.isArray(payload)) {
    return rejection(
      RealTimeSolarWindRejectionCode.NOT_AN_ARRAY,
      "payload: must be an array of row objects",
    );
  }
  if (payload.length === 0) {
    return rejection(
      RealTimeSolarWindRejectionCode.EMPTY,
      "payload: carries no rows",
    );
  }

  const fields = REAL_TIME_SOLAR_WIND_FIELDS[product];
  const excluded = emptyExclusions();
  const candidates: RealTimeSolarWindReading[] = [];
  let inactiveRows = 0;
  let objectRows = 0;
  let flaggedRows = 0;

  for (const row of payload as unknown[]) {
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      ++excluded[RealTimeSolarWindExclusion.ROW_SHAPE];
      continue;
    }
    ++objectRows;
    const record = row as Record<string, unknown>;
    if (typeof record.active !== "boolean") {
      // A row that cannot be told from a standby spacecraft's is not read; the
      // row that declares itself active at that minute still is.
      ++excluded[RealTimeSolarWindExclusion.ACTIVE_FLAG];
      continue;
    }
    ++flaggedRows;
    if (!record.active) {
      ++inactiveRows;
      continue;
    }
    const timeTagMs = parseSpaceWeatherTimeTag(record.time_tag);
    if (!Number.isFinite(timeTagMs)) {
      ++excluded[RealTimeSolarWindExclusion.TIME_TAG];
      continue;
    }
    if (typeof record.source !== "string" || record.source.length === 0) {
      ++excluded[RealTimeSolarWindExclusion.SOURCE_NAME];
      continue;
    }
    if (record.overall_quality !== REAL_TIME_SOLAR_WIND_QUALITY_GOOD) {
      ++excluded[RealTimeSolarWindExclusion.BAD_QUALITY];
      continue;
    }
    const reading: RealTimeSolarWindReading = {
      timeTagMs: timeTagMs,
      sourceName: record.source,
      overallQuality: REAL_TIME_SOLAR_WIND_QUALITY_GOOD,
    };
    const exclusion = readMeasurements(record, fields, reading);
    if (exclusion !== undefined) {
      ++excluded[exclusion];
      continue;
    }
    candidates.push(reading);
  }

  // Normalized before any conclusion about time: the product is published
  // newest first, and the newest reading, the gaps and the handoffs are all
  // properties of the ascending series, not of the order the rows arrived in.
  candidates.sort((a, b) => a.timeTagMs - b.timeTagMs);

  // Two active rows at one instant cannot both be the operational source. Both
  // are left out rather than one chosen, and the instant ages out of the
  // product's window by itself.
  const readings: RealTimeSolarWindReading[] = [];
  for (let i = 0; i < candidates.length;) {
    let j = i + 1;
    while (
      j < candidates.length &&
      candidates[j].timeTagMs === candidates[i].timeTagMs
    ) {
      ++j;
    }
    if (j - i === 1) {
      readings.push(candidates[i]);
    } else {
      excluded[RealTimeSolarWindExclusion.AMBIGUOUS_INSTANT] += j - i;
    }
    i = j;
  }

  if (objectRows === 0) {
    return rejection(
      RealTimeSolarWindRejectionCode.ROW_SHAPE,
      "payload: none of its rows is an object",
    );
  }
  if (flaggedRows === 0) {
    // With the flag on no row, no row can be told from a standby spacecraft's:
    // the payload is a different product, not a degraded one.
    return rejection(
      RealTimeSolarWindRejectionCode.ACTIVE_FLAG,
      "payload: no row carries a boolean active flag",
    );
  }
  if (readings.length === 0) {
    return rejection(
      RealTimeSolarWindRejectionCode.NO_USABLE_ROWS,
      `payload: none of its ${payload.length} rows is a usable active ${product} row (${inactiveRows} inactive, exclusions ${JSON.stringify(excluded)})`,
    );
  }

  return {
    status: "ok",
    series: seriesFrom(
      product,
      readings,
      payload.length,
      inactiveRows,
      excluded,
    ),
  };
}

function seriesFrom(
  product: RealTimeSolarWindProductValue,
  readings: RealTimeSolarWindReading[],
  rowsRead: number,
  inactiveRows: number,
  excluded: Record<RealTimeSolarWindExclusionValue, number>,
): RealTimeSolarWindSeries {
  return {
    product: product,
    readings: readings,
    newest: readings[readings.length - 1],
    rowsRead: rowsRead,
    inactiveRows: inactiveRows,
    excluded: Object.freeze(excluded),
    gaps: realTimeSolarWindGaps(readings),
    sourceHandoffs: countHandoffs(readings),
  };
}

/**
 * Merge a newer series into the history already held, keeping the window a
 * caller asked for.
 *
 * The product carries one day. Longer horizons are no longer published, so they
 * exist only if a consumer keeps them: this is where that happens. Where the two
 * series share an instant the incoming reading wins, since it is the later
 * statement about that minute. The result is trimmed to the window measured
 * back from its own newest reading, so a history never grows without bound.
 *
 * A held reading the caller's predicate does not credit is not carried forward.
 * The caller passes the folder's plausibility rule at the deciding instant, so a
 * history accumulated under a clock that has since stepped back cannot go on
 * describing minutes the present has not reached — the same rule the
 * time-regression rule is held to.
 *
 * The incoming series' row accounting describes the latest payload, and is what
 * the merged series reports; the gaps and handoffs are recomputed over the
 * merged readings.
 *
 * @param held The history already held, or `undefined`.
 * @param incoming The newly normalized series.
 * @param historySeconds How far back from the newest reading to keep.
 * @param heldIsCredible Whether a held reading's instant may still be carried;
 *   every held reading is carried when it is omitted.
 * @returns The merged, ascending, trimmed series.
 */
export function mergeRealTimeSolarWindHistory(
  held: RealTimeSolarWindSeries | undefined,
  incoming: RealTimeSolarWindSeries,
  historySeconds: number,
  heldIsCredible?: (timeTagMs: number) => boolean,
): RealTimeSolarWindSeries {
  const byInstant = new Map<number, RealTimeSolarWindReading>();
  if (held !== undefined && held.product === incoming.product) {
    for (const reading of held.readings) {
      if (heldIsCredible === undefined || heldIsCredible(reading.timeTagMs)) {
        byInstant.set(reading.timeTagMs, reading);
      }
    }
  }
  for (const reading of incoming.readings) {
    byInstant.set(reading.timeTagMs, reading);
  }
  const merged = [...byInstant.values()].sort(
    (a, b) => a.timeTagMs - b.timeTagMs,
  );
  const newestMs = merged[merged.length - 1].timeTagMs;
  const earliestMs = newestMs - historySeconds * 1000;
  let first = 0;
  while (first < merged.length && merged[first].timeTagMs < earliestMs) {
    ++first;
  }
  return seriesFrom(
    incoming.product,
    merged.slice(first),
    incoming.rowsRead,
    incoming.inactiveRows,
    { ...incoming.excluded },
  );
}

/**
 * The series without the readings whose instant the caller's predicate does not
 * credit.
 *
 * The caller passes the folder's plausibility rule at the deciding instant. A
 * row it does not credit is a row-level fault like any other: it is excluded
 * and counted, so one mistyped minute neither refuses the day around it nor
 * becomes the newest instant every later payload is measured against.
 *
 * @param series A normalized series.
 * @param isCredible Whether a reading's instant may be kept.
 * @returns The series, the same object when every reading is credited, or
 *   `undefined` when none is.
 */
export function realTimeSolarWindSeriesCredited(
  series: RealTimeSolarWindSeries,
  isCredible: (timeTagMs: number) => boolean,
): RealTimeSolarWindSeries | undefined {
  const kept = series.readings.filter((reading) =>
    isCredible(reading.timeTagMs),
  );
  if (kept.length === series.readings.length) {
    return series;
  }
  if (kept.length === 0) {
    return undefined;
  }
  const excluded = { ...series.excluded };
  excluded[RealTimeSolarWindExclusion.AHEAD_OF_CLOCK] +=
    series.readings.length - kept.length;
  return seriesFrom(
    series.product,
    kept,
    series.rowsRead,
    series.inactiveRows,
    excluded,
  );
}

/**
 * The newest reading at or before an instant.
 *
 * @param series The normalized series.
 * @param nowMs The instant, in ms since the Unix epoch.
 * @returns The reading, or `undefined` when the series begins after the instant.
 */
export function realTimeSolarWindReadingAt(
  series: RealTimeSolarWindSeries,
  nowMs: number,
): RealTimeSolarWindReading | undefined {
  let found: RealTimeSolarWindReading | undefined;
  for (const reading of series.readings) {
    if (reading.timeTagMs > nowMs) {
      break;
    }
    found = reading;
  }
  return found;
}
