/**
 * Turns an auroral-precipitation snapshot into a normalized
 * {@link AuroraOvalField}, or refuses it with a typed reason.
 *
 * The wire grid and the engine's grid disagree on three things at once, and each
 * disagreement is a silent corruption if it is handled by assumption:
 *
 *   - **Axis order.** The payload is longitude-major — latitude runs south to
 *     north within a fixed longitude, then the longitude advances — while the
 *     engine's grid is row-major with row zero at the north edge. Reading the
 *     wire order as row-major transposes the globe, which produces a picture
 *     that is wrong everywhere and implausible nowhere.
 *   - **Longitude origin.** The payload runs 0 to 359 degrees east, so the two
 *     ends of the array are the two sides of the prime meridian and the
 *     antimeridian sits in the middle. The engine's grid starts at the
 *     antimeridian. Copying the array across unrotated puts the discontinuity
 *     half a world away from where a consumer wraps.
 *   - **The poles.** Every pole is emitted once per longitude, 360 times, as if
 *     it were 360 places. Measured against the live product those duplicates
 *     **disagree** — one snapshot carried six distinct values across the 360
 *     south-pole entries while the whole ring one degree away was uniform — so a
 *     normalizer that takes whichever it reaches last picks a value by array
 *     order. {@link OvationPolePolicy} makes the choice explicit instead.
 *
 * Sample values are copied through unchanged. The product declares no unit for
 * them and states no ceiling, so the field is emitted at `"raw"` scale carrying
 * the integers as they arrived and the maximum this snapshot happened to
 * contain; inventing a percentage from a quiet sample would fabricate a unit the
 * source never published.
 *
 * Validation runs to completion before a single sample is written, so a refused
 * payload costs one pass and leaves no partially-built field for a caller to
 * mistake for a good one.
 *
 * Nothing here fetches, reads a clock, imports a renderer, or branches on the
 * active backend.
 *
 * @module Scene/SpaceWeather/OvationGridNormalizer
 */
import { parseSpaceWeatherTimeTag } from "./PlanetaryKpNormalizer.js";
import {
  AuroraHemisphere,
  AuroraIntensityScale,
  AuroraOvalFrame,
  SpaceWeatherAuthority,
  type AuroraOvalField,
} from "./SpaceWeatherTypes.js";

/** Distinct longitudes in the wire grid, one per degree. */
export const OVATION_LONGITUDE_COUNT = 360;

/** Distinct latitudes in the wire grid, one per degree from -90 to +90 inclusive. */
export const OVATION_LATITUDE_COUNT = 181;

/** Total cells in a complete wire grid. */
export const OVATION_SAMPLE_COUNT =
  OVATION_LONGITUDE_COUNT * OVATION_LATITUDE_COUNT;

/**
 * Smallest step the product's integer samples can take.
 *
 * It stands in for the observed ceiling of a snapshot that contains no non-zero
 * sample at all, which is a real state on a quiet night. A consumer normalizing
 * such a field by it gets an all-zero field rather than a division by zero, and
 * no ceiling is asserted that the source did not publish.
 */
export const OVATION_VALUE_QUANTUM = 1;

/**
 * How the 360 duplicate entries of a pole are reduced to the one value the pole
 * physically has.
 *
 * `"mean"` is the default because the duplicates are repeated estimates of a
 * single point: averaging them adds no structure the product did not report,
 * where `"maximum"` biases every pole toward the brightest of 360 draws.
 * `"require-agreement"` refuses a snapshot whose duplicates differ — correct in
 * principle, and measured to reject the live product, so it is offered for
 * fixtures and diagnostics rather than set as the default.
 */
export type OvationPolePolicyValue =
  "mean" | "maximum" | "minimum" | "require-agreement";

/** Enumerated {@link OvationPolePolicyValue} constants. */
export const OvationPolePolicy = Object.freeze({
  MEAN: "mean",
  MAXIMUM: "maximum",
  MINIMUM: "minimum",
  REQUIRE_AGREEMENT: "require-agreement",
});

/** Why a payload was refused. */
export type OvationRejectionCodeValue =
  | "not-an-object"
  | "observation-time"
  | "forecast-time"
  | "forecast-before-observation"
  | "coordinates-missing"
  | "coordinate-count"
  | "triple-shape"
  | "non-integer"
  | "negative-sample"
  | "grid-order"
  | "pole-disagreement";

/** Enumerated {@link OvationRejectionCodeValue} constants. */
export const OvationRejectionCode = Object.freeze({
  NOT_AN_OBJECT: "not-an-object",
  OBSERVATION_TIME: "observation-time",
  FORECAST_TIME: "forecast-time",
  FORECAST_BEFORE_OBSERVATION: "forecast-before-observation",
  COORDINATES_MISSING: "coordinates-missing",
  COORDINATE_COUNT: "coordinate-count",
  TRIPLE_SHAPE: "triple-shape",
  NON_INTEGER: "non-integer",
  NEGATIVE_SAMPLE: "negative-sample",
  GRID_ORDER: "grid-order",
  POLE_DISAGREEMENT: "pole-disagreement",
});

/** A refusal: the rule that was violated, and where. */
export interface OvationRejection {
  /** Which rule refused the payload. */
  code: OvationRejectionCodeValue;
  /** Diagnostic text naming the offending value or position. */
  message: string;
}

/** A normalized snapshot, and what was measured while normalizing it. */
export interface OvationSnapshot {
  /** Observation instant the payload declares, in ms since the Unix epoch. */
  observedTimeMs: number;
  /** Forecast instant the payload declares, in ms since the Unix epoch. */
  forecastTimeMs: number;
  /** Measured forecast lead in seconds, from the payload's own two instants. */
  leadSeconds: number;
  /** The normalized field, ready to be carried in a packet. */
  field: AuroraOvalField;
  /** Largest sample in the snapshot, before the quantum floor is applied. */
  observedMaximum: number;
  /** How many of the samples were non-zero. */
  nonZeroSampleCount: number;
  /** Which pole policy produced the pole rows. */
  polePolicy: OvationPolePolicyValue;
  /** Whether the 360 north-pole duplicates all carried one value. */
  northPoleAgreed: boolean;
  /** Whether the 360 south-pole duplicates all carried one value. */
  southPoleAgreed: boolean;
}

/**
 * The outcome of {@link normalizeOvationPayload}.
 *
 * The discriminant is a string rather than a boolean because the engine compiles
 * with `strict` off, and TypeScript only narrows a union by a boolean-literal
 * discriminant when `strictNullChecks` is on. A string discriminant narrows
 * under both settings, so a consumer reads `error` or `snapshot` without a cast
 * whichever way it is compiled.
 */
export type OvationNormalizeResult =
  | { status: "ok"; snapshot: OvationSnapshot }
  | { status: "refused"; error: OvationRejection };

/** Options for {@link normalizeOvationPayload}. */
export interface OvationNormalizeOptions {
  /** How to reduce the pole duplicates. Defaults to `"mean"`. */
  polePolicy?: OvationPolePolicyValue;
}

/**
 * Index of one cell in the wire array.
 *
 * The ordering is longitude-major, so the latitude term is the fast axis. The
 * formula is exported because the spec, the fixtures and any future adapter must
 * all agree on it, and three private copies of it would not.
 *
 * @param longitudeDegrees Integer degrees east, 0 to 359.
 * @param latitudeDegrees Integer degrees, -90 to 90.
 * @returns The index into the payload's `coordinates` array.
 */
export function ovationSourceIndex(
  longitudeDegrees: number,
  latitudeDegrees: number,
): number {
  return longitudeDegrees * OVATION_LATITUDE_COUNT + (latitudeDegrees + 90);
}

/**
 * Column a wire longitude occupies in the normalized grid.
 *
 * The normalized grid begins at the antimeridian, so the wire array is rotated
 * by half its width. This is the whole of the seam handling: after the rotation
 * the two array ends meet at the antimeridian, which is where a consumer of a
 * whole-globe grid wraps, and the 359-to-0 boundary the wire array happens to
 * contain becomes an ordinary interior neighbour pair one degree apart.
 *
 * @param longitudeDegrees Integer degrees east, 0 to 359.
 * @returns The column index, 0 to 359.
 */
export function ovationColumnForLongitude(longitudeDegrees: number): number {
  return (longitudeDegrees + 180) % OVATION_LONGITUDE_COUNT;
}

function rejection(
  code: OvationRejectionCodeValue,
  message: string,
): OvationNormalizeResult {
  return { status: "refused", error: { code: code, message: message } };
}

// One zone-aware parser for the whole folder. This product stamps Z today, but a
// second parser that leaves a bare tag to ECMAScript's host-local default is an
// error the size of the host's offset, waiting for the day it stops.
function parseInstant(value: unknown): number {
  return parseSpaceWeatherTimeTag(value);
}

/**
 * Check the payload's structure and ordering without building anything.
 *
 * Returns a refusal, or `undefined` when every cell is in its declared place.
 */
function validateGrid(
  coordinates: readonly unknown[],
): OvationNormalizeResult | undefined {
  for (let index = 0; index < coordinates.length; ++index) {
    const triple = coordinates[index];
    if (!Array.isArray(triple) || triple.length !== 3) {
      return rejection(
        OvationRejectionCode.TRIPLE_SHAPE,
        `coordinates[${index}]: expected a [longitude, latitude, aurora] triple`,
      );
    }
    const longitude = triple[0];
    const latitude = triple[1];
    const sample = triple[2];
    if (
      !Number.isInteger(longitude) ||
      !Number.isInteger(latitude) ||
      !Number.isInteger(sample)
    ) {
      return rejection(
        OvationRejectionCode.NON_INTEGER,
        `coordinates[${index}]: every member of a triple must be an integer, received [${String(longitude)}, ${String(latitude)}, ${String(sample)}]`,
      );
    }
    if (sample < 0) {
      // The sample is an amount of precipitating energy and has no negative
      // branch; the published range of this product begins at zero. It matters
      // beyond tidiness because the field is carried on the raw scale, where a
      // consumer divides by the snapshot's own maximum: one negative sample
      // among positives yields a negative normalized intensity, and the maximum
      // that would have revealed it stays positive.
      return rejection(
        OvationRejectionCode.NEGATIVE_SAMPLE,
        `coordinates[${index}]: the aurora sample must not be negative, received ${sample}`,
      );
    }
    const expectedLongitude = Math.floor(index / OVATION_LATITUDE_COUNT);
    const expectedLatitude = (index % OVATION_LATITUDE_COUNT) - 90;
    if (longitude !== expectedLongitude || latitude !== expectedLatitude) {
      return rejection(
        OvationRejectionCode.GRID_ORDER,
        `coordinates[${index}]: longitude-major ordering places [${expectedLongitude}, ${expectedLatitude}] here, received [${longitude}, ${latitude}]`,
      );
    }
  }
  return undefined;
}

/**
 * Reduce one pole's 360 duplicates to the single value the pole has.
 *
 * Returns `undefined` under `"require-agreement"` when they differ, which the
 * caller turns into a refusal.
 */
function reducePole(
  duplicates: readonly number[],
  policy: OvationPolePolicyValue,
): number | undefined {
  const first = duplicates[0];
  let agreed = true;
  let total = first;
  let maximum = first;
  let minimum = first;
  for (let i = 1; i < duplicates.length; ++i) {
    const value = duplicates[i];
    if (value !== first) {
      agreed = false;
    }
    total += value;
    if (value > maximum) {
      maximum = value;
    }
    if (value < minimum) {
      minimum = value;
    }
  }
  switch (policy) {
    case OvationPolePolicy.REQUIRE_AGREEMENT:
      return agreed ? first : undefined;
    case OvationPolePolicy.MAXIMUM:
      return maximum;
    case OvationPolePolicy.MINIMUM:
      return minimum;
    default:
      return total / duplicates.length;
  }
}

/**
 * Normalize a decoded auroral-precipitation payload, or refuse it.
 *
 * The parameter is `unknown` because this is the engine's boundary against a
 * network payload: a signature that assumed the shape would type-check exactly
 * the inputs that never needed checking.
 *
 * @param payload The decoded JSON payload.
 * @param options Pole policy.
 * @returns The normalized snapshot, or a typed refusal.
 */
export function normalizeOvationPayload(
  payload: unknown,
  options?: OvationNormalizeOptions,
): OvationNormalizeResult {
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload)
  ) {
    return rejection(
      OvationRejectionCode.NOT_AN_OBJECT,
      "payload: must be an object",
    );
  }
  const record = payload as Record<string, unknown>;

  const observedTimeMs = parseInstant(record["Observation Time"]);
  if (!Number.isFinite(observedTimeMs)) {
    return rejection(
      OvationRejectionCode.OBSERVATION_TIME,
      `Observation Time: must be a parseable instant, received ${JSON.stringify(record["Observation Time"])}`,
    );
  }
  const forecastTimeMs = parseInstant(record["Forecast Time"]);
  if (!Number.isFinite(forecastTimeMs)) {
    return rejection(
      OvationRejectionCode.FORECAST_TIME,
      `Forecast Time: must be a parseable instant, received ${JSON.stringify(record["Forecast Time"])}`,
    );
  }
  if (forecastTimeMs < observedTimeMs) {
    return rejection(
      OvationRejectionCode.FORECAST_BEFORE_OBSERVATION,
      "Forecast Time: must not be earlier than Observation Time",
    );
  }

  const coordinates = record.coordinates;
  if (!Array.isArray(coordinates)) {
    return rejection(
      OvationRejectionCode.COORDINATES_MISSING,
      "coordinates: must be an array",
    );
  }
  if (coordinates.length !== OVATION_SAMPLE_COUNT) {
    return rejection(
      OvationRejectionCode.COORDINATE_COUNT,
      `coordinates: a complete grid is ${OVATION_SAMPLE_COUNT} cells, received ${coordinates.length}`,
    );
  }
  const structural = validateGrid(coordinates);
  if (structural !== undefined) {
    return structural;
  }

  const policy = options?.polePolicy ?? OvationPolePolicy.MEAN;
  const northDuplicates: number[] = [];
  const southDuplicates: number[] = [];
  for (let longitude = 0; longitude < OVATION_LONGITUDE_COUNT; ++longitude) {
    northDuplicates.push(
      (coordinates[ovationSourceIndex(longitude, 90)] as number[])[2],
    );
    southDuplicates.push(
      (coordinates[ovationSourceIndex(longitude, -90)] as number[])[2],
    );
  }
  const northPole = reducePole(northDuplicates, policy);
  const southPole = reducePole(southDuplicates, policy);
  if (northPole === undefined || southPole === undefined) {
    const which = northPole === undefined ? "north" : "south";
    return rejection(
      OvationRejectionCode.POLE_DISAGREEMENT,
      `coordinates: the ${OVATION_LONGITUDE_COUNT} ${which}-pole duplicates carry more than one value, and the pole policy requires agreement`,
    );
  }
  const northPoleAgreed = northDuplicates.every(
    (v) => v === northDuplicates[0],
  );
  const southPoleAgreed = southDuplicates.every(
    (v) => v === southDuplicates[0],
  );

  const intensity = new Float32Array(OVATION_SAMPLE_COUNT);
  let observedMaximum = 0;
  let nonZeroSampleCount = 0;
  for (let row = 0; row < OVATION_LATITUDE_COUNT; ++row) {
    const latitude = 90 - row;
    for (let longitude = 0; longitude < OVATION_LONGITUDE_COUNT; ++longitude) {
      const source = coordinates[
        ovationSourceIndex(longitude, latitude)
      ] as number[];
      let sample = source[2];
      if (latitude === 90) {
        sample = northPole;
      } else if (latitude === -90) {
        sample = southPole;
      }
      intensity[
        row * OVATION_LONGITUDE_COUNT + ovationColumnForLongitude(longitude)
      ] = sample;
      if (sample !== 0) {
        ++nonZeroSampleCount;
      }
      if (sample > observedMaximum) {
        observedMaximum = sample;
      }
    }
  }

  const field: AuroraOvalField = {
    authority: SpaceWeatherAuthority.OVATION,
    frame: AuroraOvalFrame.GEOGRAPHIC,
    hemisphere: AuroraHemisphere.BOTH,
    gridWidth: OVATION_LONGITUDE_COUNT,
    gridHeight: OVATION_LATITUDE_COUNT,
    intensity: intensity,
    bounds: {
      west: -Math.PI,
      south: -Math.PI / 2,
      east:
        ((OVATION_LONGITUDE_COUNT / 2 - 1) * Math.PI) /
        (OVATION_LONGITUDE_COUNT / 2),
      north: Math.PI / 2,
    },
    intensityScale: AuroraIntensityScale.RAW,
    rawMaximum: Math.max(observedMaximum, OVATION_VALUE_QUANTUM),
  };

  return {
    status: "ok",
    snapshot: {
      observedTimeMs: observedTimeMs,
      forecastTimeMs: forecastTimeMs,
      leadSeconds: (forecastTimeMs - observedTimeMs) / 1000,
      field: field,
      observedMaximum: observedMaximum,
      nonZeroSampleCount: nonZeroSampleCount,
      polePolicy: policy,
      northPoleAgreed: northPoleAgreed,
      southPoleAgreed: southPoleAgreed,
    },
  };
}
