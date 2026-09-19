/**
 * Validation and derived reads for a {@link SpaceWeatherPacket}.
 *
 * Everything a consumer needs to know about a packet that is not literally
 * stored in it is computed here, from the packet and an explicitly supplied
 * instant. Nothing in this module reads a clock, allocates a renderer resource,
 * or performs I/O.
 *
 * @module Scene/SpaceWeather/SpaceWeatherPacket
 */
import {
  SPACE_WEATHER_AUTHORITIES,
  SPACE_WEATHER_FILL_VALUE,
  SPACE_WEATHER_PACKET_VERSION,
  SPACE_WEATHER_RANGES,
  SPACE_WEATHER_SOURCE_KINDS,
  SOLAR_FLARE_CLASSES,
  SpaceWeatherAuthority,
  SpaceWeatherFreshness,
  type AuroraOvalField,
  type SpaceWeatherAuthorityValue,
  type SpaceWeatherFieldValue,
  type SpaceWeatherFreshnessValue,
  type SpaceWeatherPacket,
  type SpaceWeatherRange,
  type SpaceWeatherValidation,
} from "./SpaceWeatherTypes.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Check one optional numeric field: present means finite, inside its range, and
 * not the feed fill value.
 */
function checkOptionalNumber(
  errors: string[],
  container: Record<string, unknown>,
  path: string,
  key: string,
  range: SpaceWeatherRange,
): void {
  const value = container[key];
  if (value === undefined) {
    return;
  }
  if (!isFiniteNumber(value)) {
    errors.push(`${path}: must be a finite number`);
    return;
  }
  if (value === SPACE_WEATHER_FILL_VALUE) {
    errors.push(
      `${path}: ${SPACE_WEATHER_FILL_VALUE} is the feed fill value, not an observation`,
    );
    return;
  }
  if (value < range.minimum || value > range.maximum) {
    errors.push(
      `${path}: ${value} is outside [${range.minimum}, ${range.maximum}]`,
    );
  }
}

function checkAuthority(errors: string[], value: unknown, path: string): void {
  if (
    typeof value !== "string" ||
    !SPACE_WEATHER_AUTHORITIES.includes(value as SpaceWeatherAuthorityValue)
  ) {
    errors.push(
      `${path}: must be one of ${SPACE_WEATHER_AUTHORITIES.join(", ")}`,
    );
  }
}

function validateProvenance(errors: string[], value: unknown): void {
  if (!isRecord(value)) {
    errors.push("provenance: must be an object");
    return;
  }
  const sourceId = value.sourceId;
  if (typeof sourceId !== "string" || sourceId.length === 0) {
    errors.push("provenance.sourceId: must be a non-empty string");
  }
  const kind = value.kind;
  if (
    typeof kind !== "string" ||
    !SPACE_WEATHER_SOURCE_KINDS.includes(
      kind as (typeof SPACE_WEATHER_SOURCE_KINDS)[number],
    )
  ) {
    errors.push(
      `provenance.kind: must be one of ${SPACE_WEATHER_SOURCE_KINDS.join(", ")}`,
    );
  }
  const validitySeconds = value.validitySeconds;
  if (!isFiniteNumber(validitySeconds) || validitySeconds <= 0) {
    errors.push("provenance.validitySeconds: must be a finite positive number");
  }
}

function validateGeomagnetic(errors: string[], value: unknown): void {
  if (!isRecord(value)) {
    errors.push("geomagnetic: must be an object");
    return;
  }
  const activity = value.activity;
  const activityRange = SPACE_WEATHER_RANGES.activity;
  if (!isFiniteNumber(activity)) {
    errors.push("geomagnetic.activity: must be a finite number");
  } else if (
    activity < activityRange.minimum ||
    activity > activityRange.maximum
  ) {
    errors.push(
      `geomagnetic.activity: ${activity} is outside [${activityRange.minimum}, ${activityRange.maximum}]`,
    );
  }
  checkAuthority(errors, value.authority, "geomagnetic.authority");
  checkOptionalNumber(
    errors,
    value,
    "geomagnetic.kpIndex",
    "kpIndex",
    SPACE_WEATHER_RANGES.kpIndex,
  );
  checkOptionalNumber(
    errors,
    value,
    "geomagnetic.bzNanoTesla",
    "bzNanoTesla",
    SPACE_WEATHER_RANGES.bzNanoTesla,
  );
  checkOptionalNumber(
    errors,
    value,
    "geomagnetic.dstNanoTesla",
    "dstNanoTesla",
    SPACE_WEATHER_RANGES.dstNanoTesla,
  );
  if (value.dstNanoTesla !== undefined) {
    if (value.dstAuthority !== SpaceWeatherAuthority.CALLER) {
      errors.push(
        `geomagnetic.dstAuthority: must be "${SpaceWeatherAuthority.CALLER}" when a ring-current index is present, because no built-in provider supplies one`,
      );
    }
  } else if (value.dstAuthority !== undefined) {
    errors.push(
      "geomagnetic.dstAuthority: present without a ring-current index",
    );
  }
}

function validateFlare(errors: string[], value: unknown): void {
  if (!isRecord(value)) {
    errors.push("flare: must be an object");
    return;
  }
  checkAuthority(errors, value.authority, "flare.authority");
  const flareClass = value.flareClass;
  if (
    typeof flareClass !== "string" ||
    !SOLAR_FLARE_CLASSES.includes(
      flareClass as (typeof SOLAR_FLARE_CLASSES)[number],
    )
  ) {
    errors.push(
      `flare.flareClass: must be one of ${SOLAR_FLARE_CLASSES.join(", ")}`,
    );
  }
  const magnitude = value.magnitude;
  const magnitudeRange = SPACE_WEATHER_RANGES.flareMagnitude;
  if (!isFiniteNumber(magnitude)) {
    errors.push("flare.magnitude: must be a finite number");
  } else if (
    magnitude < magnitudeRange.minimum ||
    magnitude >= magnitudeRange.maximum
  ) {
    errors.push(
      `flare.magnitude: ${magnitude} is outside [${magnitudeRange.minimum}, ${magnitudeRange.maximum})`,
    );
  }
  for (const key of [
    "longBandFluxWattsPerSquareMeter",
    "shortBandFluxWattsPerSquareMeter",
  ]) {
    const flux = value[key];
    if (flux === undefined) {
      continue;
    }
    if (!isFiniteNumber(flux) || flux <= 0) {
      errors.push(`flare.${key}: must be a finite positive number`);
    }
  }
  if (
    value.observedTimeMs !== undefined &&
    !isFiniteNumber(value.observedTimeMs)
  ) {
    errors.push("flare.observedTimeMs: must be a finite number");
  }
}

function validateSolarWind(errors: string[], value: unknown): void {
  if (!isRecord(value)) {
    errors.push("solarWind: must be an object");
    return;
  }
  checkAuthority(errors, value.authority, "solarWind.authority");
  if (value.sourceName !== undefined && typeof value.sourceName !== "string") {
    errors.push("solarWind.sourceName: must be a string");
  }
  checkOptionalNumber(
    errors,
    value,
    "solarWind.speedKmPerSecond",
    "speedKmPerSecond",
    SPACE_WEATHER_RANGES.solarWindSpeedKmPerSecond,
  );
  checkOptionalNumber(
    errors,
    value,
    "solarWind.densityPerCubicCm",
    "densityPerCubicCm",
    SPACE_WEATHER_RANGES.solarWindDensityPerCubicCm,
  );
  checkOptionalNumber(
    errors,
    value,
    "solarWind.temperatureKelvin",
    "temperatureKelvin",
    SPACE_WEATHER_RANGES.solarWindTemperatureKelvin,
  );
  checkOptionalNumber(
    errors,
    value,
    "solarWind.btNanoTesla",
    "btNanoTesla",
    SPACE_WEATHER_RANGES.btNanoTesla,
  );
  checkOptionalNumber(
    errors,
    value,
    "solarWind.bzGsmNanoTesla",
    "bzGsmNanoTesla",
    SPACE_WEATHER_RANGES.bzGsmNanoTesla,
  );
  if (
    value.overallQuality !== undefined &&
    !isFiniteNumber(value.overallQuality)
  ) {
    errors.push("solarWind.overallQuality: must be a finite number");
  }
}

function validateOvalBounds(errors: string[], value: unknown): void {
  if (!isRecord(value)) {
    errors.push("oval.bounds: must be an object");
    return;
  }
  for (const key of ["west", "south", "east", "north"]) {
    if (!isFiniteNumber(value[key])) {
      errors.push(`oval.bounds.${key}: must be a finite number`);
    }
  }
  const south = value.south;
  const north = value.north;
  if (isFiniteNumber(south) && isFiniteNumber(north) && south >= north) {
    errors.push("oval.bounds: south must be less than north");
  }
}

function validateOval(errors: string[], value: unknown): void {
  if (!isRecord(value)) {
    errors.push("oval: must be an object");
    return;
  }
  checkAuthority(errors, value.authority, "oval.authority");
  const gridWidth = value.gridWidth;
  const gridHeight = value.gridHeight;
  const widthValid = Number.isInteger(gridWidth) && (gridWidth as number) >= 2;
  const heightValid =
    Number.isInteger(gridHeight) && (gridHeight as number) >= 2;
  if (!widthValid) {
    errors.push("oval.gridWidth: must be an integer of at least 2");
  }
  if (!heightValid) {
    errors.push("oval.gridHeight: must be an integer of at least 2");
  }
  const intensity = value.intensity;
  if (!(intensity instanceof Float32Array)) {
    errors.push("oval.intensity: must be a Float32Array");
  } else if (widthValid && heightValid) {
    const expected = (gridWidth as number) * (gridHeight as number);
    if (intensity.length !== expected) {
      errors.push(
        `oval.intensity: length ${intensity.length} does not equal gridWidth * gridHeight (${expected})`,
      );
    }
  }
  const scale = value.intensityScale;
  if (scale !== "normalized" && scale !== "raw") {
    errors.push('oval.intensityScale: must be "normalized" or "raw"');
  }
  if (scale === "raw") {
    const rawMaximum = value.rawMaximum;
    if (!isFiniteNumber(rawMaximum) || rawMaximum <= 0) {
      errors.push(
        "oval.rawMaximum: a raw grid must declare a finite positive ceiling, because the source unit is not stated",
      );
    }
  }
  if (intensity instanceof Float32Array) {
    const normalizedRange = SPACE_WEATHER_RANGES.intensityNormalized;
    for (let i = 0; i < intensity.length; ++i) {
      const sample = intensity[i];
      if (!Number.isFinite(sample)) {
        errors.push(`oval.intensity[${i}]: must be a finite number`);
        break;
      }
      if (
        scale === "normalized" &&
        (sample < normalizedRange.minimum || sample > normalizedRange.maximum)
      ) {
        errors.push(
          `oval.intensity[${i}]: ${sample} is outside [${normalizedRange.minimum}, ${normalizedRange.maximum}] for a normalized grid`,
        );
        break;
      }
    }
  }
  if (value.frame !== "geomagnetic" && value.frame !== "geographic") {
    errors.push('oval.frame: must be "geomagnetic" or "geographic"');
  }
  if (
    value.hemisphere !== "north" &&
    value.hemisphere !== "south" &&
    value.hemisphere !== "both"
  ) {
    errors.push('oval.hemisphere: must be "north", "south" or "both"');
  }
  if (value.frameEpoch !== undefined && !isFiniteNumber(value.frameEpoch)) {
    errors.push("oval.frameEpoch: must be a finite decimal year");
  } else if (value.frameEpoch === undefined && value.frame === "geomagnetic") {
    // A centred-dipole frame is only defined relative to the epoch of the field
    // model that placed the pole, and that model is revised every five years. An
    // epoch-less geomagnetic grid is a grid whose pole cannot be replaced, so it
    // is refused rather than silently pinned to whatever epoch happened to be
    // current when it was produced.
    errors.push(
      "oval.frameEpoch: a geomagnetic frame must declare its field-model epoch as a decimal year",
    );
  }
  validateOvalBounds(errors, value.bounds);
}

/**
 * Check a candidate packet against the schema.
 *
 * The parameter is `unknown` on purpose: the values this guards are the ones
 * that arrive from outside the engine, and a signature that assumes the shape
 * would type-check exactly the packets that never needed checking.
 *
 * @param packet The candidate.
 * @returns Whether it is usable, and one message per violated rule.
 */
export function validateSpaceWeatherPacket(
  packet: unknown,
): SpaceWeatherValidation {
  const errors: string[] = [];
  if (!isRecord(packet)) {
    return {
      valid: false,
      errors: Object.freeze(["packet: must be an object"]),
    };
  }
  if (packet.version !== SPACE_WEATHER_PACKET_VERSION) {
    errors.push(
      `version: expected ${SPACE_WEATHER_PACKET_VERSION}, received ${String(packet.version)}`,
    );
  }
  validateProvenance(errors, packet.provenance);
  const observedTimeMs = packet.observedTimeMs;
  const forecastTimeMs = packet.forecastTimeMs;
  if (!isFiniteNumber(observedTimeMs)) {
    errors.push("observedTimeMs: must be a finite number");
  }
  if (!isFiniteNumber(forecastTimeMs)) {
    errors.push("forecastTimeMs: must be a finite number");
  }
  if (
    isFiniteNumber(observedTimeMs) &&
    isFiniteNumber(forecastTimeMs) &&
    forecastTimeMs < observedTimeMs
  ) {
    errors.push("forecastTimeMs: must not be earlier than observedTimeMs");
  }
  validateGeomagnetic(errors, packet.geomagnetic);
  if (packet.flare !== undefined) {
    validateFlare(errors, packet.flare);
  }
  if (packet.solarWind !== undefined) {
    validateSolarWind(errors, packet.solarWind);
  }
  if (packet.oval !== undefined) {
    validateOval(errors, packet.oval);
  }
  return { valid: errors.length === 0, errors: Object.freeze(errors) };
}

/**
 * The authority marker governing one field, or `undefined` when the packet does
 * not carry that field.
 *
 * @param packet The packet.
 * @param field Which field to ask about.
 * @returns The authority, or `undefined`.
 */
export function spaceWeatherAuthorityOf(
  packet: SpaceWeatherPacket,
  field: SpaceWeatherFieldValue,
): SpaceWeatherAuthorityValue | undefined {
  switch (field) {
    case "activity":
      return packet.geomagnetic.authority;
    case "dst":
      return packet.geomagnetic.dstNanoTesla === undefined
        ? undefined
        : packet.geomagnetic.dstAuthority;
    case "oval":
      return packet.oval?.authority;
    case "solarWind":
      return packet.solarWind?.authority;
    case "flare":
      return packet.flare?.authority;
    default:
      return undefined;
  }
}

/**
 * How much to scale an oval field's samples by before rendering.
 *
 * A field produced by the auroral-precipitation model is authoritative for its
 * own intensity: that model already consumed the solar-wind and planetary-index
 * inputs the activity scalar summarizes, so multiplying by the scalar would
 * count them twice. Every other field carries shape only and is scaled by
 * activity.
 *
 * @param packet The packet.
 * @returns `1` for a model-authoritative oval, otherwise the activity scalar.
 */
export function auroraOvalIntensityScale(packet: SpaceWeatherPacket): number {
  if (packet.oval?.authority === SpaceWeatherAuthority.OVATION) {
    return 1;
  }
  return packet.geomagnetic.activity;
}

/**
 * Seconds between a packet's observation and a supplied instant.
 *
 * The instant is a parameter rather than a clock read, so a scripted timeline
 * evaluates to the same answer on every run.
 *
 * @param packet The packet.
 * @param nowMs The instant to measure against, in ms since the Unix epoch.
 * @returns The age in seconds; negative for an observation still in the future.
 */
export function spaceWeatherPacketAgeSeconds(
  packet: SpaceWeatherPacket,
  nowMs: number,
): number {
  return (nowMs - packet.observedTimeMs) / 1000;
}

/**
 * Where a packet sits relative to the validity window it declares: fresh within
 * that window, stale past twice it, aging in between.
 *
 * @param packet The packet.
 * @param nowMs The instant to measure against, in ms since the Unix epoch.
 * @returns The freshness band.
 */
export function spaceWeatherFreshness(
  packet: SpaceWeatherPacket,
  nowMs: number,
): SpaceWeatherFreshnessValue {
  const ageSeconds = spaceWeatherPacketAgeSeconds(packet, nowMs);
  const validitySeconds = packet.provenance.validitySeconds;
  if (ageSeconds <= validitySeconds) {
    return SpaceWeatherFreshness.FRESH;
  }
  if (ageSeconds > validitySeconds * 2) {
    return SpaceWeatherFreshness.STALE;
  }
  return SpaceWeatherFreshness.AGING;
}

/**
 * Whether a replacement packet should be refused because it moves the same
 * source backwards in time.
 *
 * This is a rule about successive packets from one source, not about the row
 * order inside a feed: the real-time solar-wind products are served newest
 * first, so an adapter that applied a time-regression rule to rows would discard
 * the entire response. A candidate from a different source is never stale here —
 * choosing between sources is an authority question, not a freshness one.
 *
 * @param current The packet in use.
 * @param candidate The proposed replacement.
 * @returns True when the candidate is an out-of-order push from the same source.
 */
export function isStaleSpaceWeatherUpdate(
  current: SpaceWeatherPacket,
  candidate: SpaceWeatherPacket,
): boolean {
  if (current.provenance.sourceId !== candidate.provenance.sourceId) {
    return false;
  }
  return candidate.observedTimeMs < current.observedTimeMs;
}

/**
 * Deep-freeze a packet so a consumer cannot mutate shared state.
 *
 * The oval's sample buffer is left writable: freezing a typed array would make
 * every later read go through a frozen-object check for no safety gain, since
 * the buffer's length and identity are already fixed by the freeze on its owner.
 *
 * @param packet The packet to freeze, modified in place.
 * @returns The same packet.
 */
export function freezeSpaceWeatherPacket(
  packet: SpaceWeatherPacket,
): SpaceWeatherPacket {
  Object.freeze(packet.provenance);
  Object.freeze(packet.geomagnetic);
  if (packet.flare !== undefined) {
    Object.freeze(packet.flare);
  }
  if (packet.solarWind !== undefined) {
    Object.freeze(packet.solarWind);
  }
  if (packet.oval !== undefined) {
    Object.freeze((packet.oval as AuroraOvalField).bounds);
    Object.freeze(packet.oval);
  }
  return Object.freeze(packet);
}
