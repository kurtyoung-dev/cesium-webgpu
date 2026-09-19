/**
 * Turns a planetary-index payload into an ordered series of readings, or
 * refuses it with a typed reason.
 *
 * Two published products carry this index and they are not interchangeable:
 *
 *   - **The observed product spells the value `Kp`; the forecast product spells
 *     it `kp`.** The case is the only difference in that field's name, so a
 *     reader that guesses, or that tries one and falls back to the other, will
 *     happily accept a forecast where an observation was asked for and label it
 *     as measured. The product is therefore a required argument, the field name
 *     is derived from it, and a payload that does not carry the field that
 *     product is supposed to carry is refused rather than salvaged.
 *   - **The forecast product also carries its own observation state** — whether
 *     a row is observed, estimated or predicted — which the observed product has
 *     no equivalent of. It is preserved verbatim so a consumer can tell a
 *     measurement from a projection without re-deriving it from a timestamp.
 *
 * Both products stamp `time_tag` **without a zone designator**. ECMAScript reads
 * a date-time string with no offset as local time, so parsing one directly is
 * wrong by the host's UTC offset — several hours of error that a spec run in one
 * timezone will never see. Every tag is normalized to UTC before it is parsed.
 *
 * Row order is normalized before anything is concluded from it. Both products
 * are published ascending today, but the campaign's other feeds are published
 * descending, and a rule about time that runs before the sort is a rule that
 * depends on which feed it was pointed at.
 *
 * Nothing here fetches, reads a clock, imports a renderer, or branches on the
 * active backend.
 *
 * @module Scene/SpaceWeather/PlanetaryKpNormalizer
 */
import {
  SPACE_WEATHER_FILL_VALUE,
  SPACE_WEATHER_RANGES,
} from "./SpaceWeatherTypes.js";
import { PLANETARY_KP_CADENCE_SECONDS } from "./SpaceWeatherSourceAuthority.js";

/** Which published product a payload came from. */
export type PlanetaryKpProductValue = "observed" | "forecast";

/** Enumerated {@link PlanetaryKpProductValue} constants. */
export const PlanetaryKpProduct = Object.freeze({
  OBSERVED: "observed",
  FORECAST: "forecast",
});

/**
 * The value field each product uses.
 *
 * Declared as a table rather than chosen at the call site, so the case trap is
 * resolved in exactly one place and a spec can assert the mapping directly.
 */
export const PLANETARY_KP_FIELD: Readonly<
  Record<PlanetaryKpProductValue, string>
> = Object.freeze({
  observed: "Kp",
  forecast: "kp",
});

/** Why a payload was refused. */
export type PlanetaryKpRejectionCodeValue =
  | "not-an-array"
  | "empty"
  | "row-shape"
  | "time-tag"
  | "field-missing"
  | "field-type"
  | "fill-value"
  | "out-of-range";

/** Enumerated {@link PlanetaryKpRejectionCodeValue} constants. */
export const PlanetaryKpRejectionCode = Object.freeze({
  NOT_AN_ARRAY: "not-an-array",
  EMPTY: "empty",
  ROW_SHAPE: "row-shape",
  TIME_TAG: "time-tag",
  FIELD_MISSING: "field-missing",
  FIELD_TYPE: "field-type",
  FILL_VALUE: "fill-value",
  OUT_OF_RANGE: "out-of-range",
});

/** A refusal: the rule that was violated, and where. */
export interface PlanetaryKpRejection {
  code: PlanetaryKpRejectionCodeValue;
  message: string;
}

/** One three-hour bin. */
export interface PlanetaryKpReading {
  /** Bin instant, in ms since the Unix epoch. */
  timeTagMs: number;
  /** Planetary index in `[0,9]`. */
  kpIndex: number;
  /** Which product the reading came from. */
  product: PlanetaryKpProductValue;
  /**
   * The forecast product's own statement about a row — observed, estimated or
   * predicted — carried verbatim and absent for the observed product.
   */
  observationState?: string;
}

/** A normalized, ascending series. */
export interface PlanetaryKpSeries {
  /** Which product produced it. */
  product: PlanetaryKpProductValue;
  /** Every accepted reading, ascending in time. */
  readings: readonly PlanetaryKpReading[];
  /** The newest reading in the series. */
  newest: PlanetaryKpReading;
}

/**
 * The outcome of {@link normalizePlanetaryKpPayload}.
 *
 * The discriminant is a string for the same reason it is in the sibling
 * normalizer: the engine compiles with `strict` off, and a boolean-literal
 * discriminant only narrows when `strictNullChecks` is on.
 */
export type PlanetaryKpResult =
  | { status: "ok"; series: PlanetaryKpSeries }
  | { status: "refused"; error: PlanetaryKpRejection };

function rejection(
  code: PlanetaryKpRejectionCodeValue,
  message: string,
): PlanetaryKpResult {
  return { status: "refused", error: { code: code, message: message } };
}

/**
 * Parse a feed timestamp as UTC.
 *
 * A tag that already declares a zone is parsed as it stands; a bare one has `Z`
 * appended first. Without that step a bare tag is read as host-local time, which
 * is an error the size of the host's offset and invisible to a machine sitting
 * at UTC.
 *
 * @param timeTag The feed's `time_tag` value.
 * @returns Milliseconds since the Unix epoch, or `NaN` when unparseable.
 */
export function parseSpaceWeatherTimeTag(timeTag: unknown): number {
  if (typeof timeTag !== "string" || timeTag.length === 0) {
    return Number.NaN;
  }
  const zoned = /(?:[Zz]|[+-]\d\d:?\d\d)$/.test(timeTag)
    ? timeTag
    : `${timeTag}Z`;
  return Date.parse(zoned);
}

/**
 * Normalize a decoded planetary-index payload, or refuse it.
 *
 * The payload is `unknown` because this is the engine's boundary against a
 * network response. The product is required: it selects the value field, and
 * guessing that field is how a forecast becomes an observation.
 *
 * @param payload The decoded JSON payload.
 * @param product Which published product the payload came from.
 * @returns The ascending series, or a typed refusal.
 */
export function normalizePlanetaryKpPayload(
  payload: unknown,
  product: PlanetaryKpProductValue,
): PlanetaryKpResult {
  if (!Array.isArray(payload)) {
    return rejection(
      PlanetaryKpRejectionCode.NOT_AN_ARRAY,
      "payload: must be an array of row objects",
    );
  }
  if (payload.length === 0) {
    return rejection(
      PlanetaryKpRejectionCode.EMPTY,
      "payload: carries no rows",
    );
  }

  const field = PLANETARY_KP_FIELD[product];
  const range = SPACE_WEATHER_RANGES.kpIndex;
  const readings: PlanetaryKpReading[] = [];

  for (let index = 0; index < payload.length; ++index) {
    const row: unknown = payload[index];
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      return rejection(
        PlanetaryKpRejectionCode.ROW_SHAPE,
        `payload[${index}]: must be an object`,
      );
    }
    const record = row as Record<string, unknown>;

    const timeTagMs = parseSpaceWeatherTimeTag(record.time_tag);
    if (!Number.isFinite(timeTagMs)) {
      return rejection(
        PlanetaryKpRejectionCode.TIME_TAG,
        `payload[${index}].time_tag: must be a parseable instant, received ${JSON.stringify(record.time_tag)}`,
      );
    }

    if (!Object.hasOwn(record, field)) {
      return rejection(
        PlanetaryKpRejectionCode.FIELD_MISSING,
        `payload[${index}]: the ${product} product carries its value in "${field}", which this row does not have`,
      );
    }
    const value = record[field];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return rejection(
        PlanetaryKpRejectionCode.FIELD_TYPE,
        `payload[${index}].${field}: must be a finite number, received ${JSON.stringify(value)}`,
      );
    }
    if (value === SPACE_WEATHER_FILL_VALUE) {
      return rejection(
        PlanetaryKpRejectionCode.FILL_VALUE,
        `payload[${index}].${field}: ${SPACE_WEATHER_FILL_VALUE} is the feed fill value, not an observation`,
      );
    }
    if (value < range.minimum || value > range.maximum) {
      return rejection(
        PlanetaryKpRejectionCode.OUT_OF_RANGE,
        `payload[${index}].${field}: ${value} is outside [${range.minimum}, ${range.maximum}]`,
      );
    }

    const reading: PlanetaryKpReading = {
      timeTagMs: timeTagMs,
      kpIndex: value,
      product: product,
    };
    if (
      product === PlanetaryKpProduct.FORECAST &&
      typeof record.observed === "string"
    ) {
      reading.observationState = record.observed;
    }
    readings.push(reading);
  }

  // Ordering is normalized before the series is published, so a consumer's
  // "newest" is a property of time rather than of the order the publisher chose.
  readings.sort((a, b) => a.timeTagMs - b.timeTagMs);

  return {
    status: "ok",
    series: {
      product: product,
      readings: readings,
      newest: readings[readings.length - 1],
    },
  };
}

/**
 * The newest reading at or before an instant.
 *
 * A forecast series extends past the present, so taking its last row would read
 * a projection as if it were now. The instant is a parameter for the same reason
 * it is everywhere else in this folder: a scripted timeline must evaluate the
 * same way on every run.
 *
 * @param series The normalized series.
 * @param nowMs The instant, in ms since the Unix epoch.
 * @returns The reading, or `undefined` when the series begins after the instant.
 */
export function planetaryKpReadingAt(
  series: PlanetaryKpSeries,
  nowMs: number,
): PlanetaryKpReading | undefined {
  let found: PlanetaryKpReading | undefined;
  for (const reading of series.readings) {
    if (reading.timeTagMs > nowMs) {
      break;
    }
    found = reading;
  }
  return found;
}

/**
 * Whether a reading is recent enough to stand in for the present.
 *
 * The product publishes one three-hour bin at a time, so a reading is current
 * while the bin it belongs to and the one after it are the only ones that could
 * have been published since.
 *
 * @param reading The reading.
 * @param nowMs The instant, in ms since the Unix epoch.
 * @returns Whether the reading is within two publication intervals of the instant.
 */
export function isPlanetaryKpCurrent(
  reading: PlanetaryKpReading,
  nowMs: number,
): boolean {
  const ageSeconds = (nowMs - reading.timeTagMs) / 1000;
  return ageSeconds >= 0 && ageSeconds <= PLANETARY_KP_CADENCE_SECONDS * 2;
}

/**
 * The normalized activity scalar an index stands for.
 *
 * The index is defined on a 0-to-9 scale, so the conversion is division by its
 * own maximum and nothing else. It is a named function because the scalar and
 * the index must never disagree in a packet that carries both.
 *
 * @param kpIndex The planetary index.
 * @returns The scalar in `[0,1]`.
 */
export function planetaryKpActivity(kpIndex: number): number {
  return kpIndex / SPACE_WEATHER_RANGES.kpIndex.maximum;
}
