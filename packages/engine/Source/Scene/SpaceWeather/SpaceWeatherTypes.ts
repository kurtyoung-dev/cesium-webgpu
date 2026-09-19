/**
 * Space-weather state types, in the backend-agnostic Scene layer.
 *
 * A {@link SpaceWeatherPacket} is the only thing an aurora renderer reads. It is
 * a normalized, versioned, provenance-carrying description of geomagnetic
 * activity, an optional auroral oval field, optional solar-wind diagnostics and
 * a separate solar-flare channel — so a manual preset, a recorded replay and a
 * live feed are interchangeable and a renderer never touches a network payload.
 *
 * Three contracts are encoded here rather than described:
 *
 *   - **Every field declares its own authority.** The marker lives next to the
 *     value it governs, so the two cannot drift apart. A live auroral-oval grid
 *     owns spatial extent and intensity on its own; it must not be multiplied by
 *     the activity scalar a second time, because the model producing it already
 *     consumed the solar-wind and planetary-index inputs that scalar summarizes.
 *   - **The solar-flare channel is separate from the geomagnetic one.** An X-ray
 *     flare is observed at light speed; the coronal mass ejection that may follow
 *     it takes a day or more to arrive. Nothing here lets a flare move the oval.
 *   - **Age is derived, never stored.** A stored age needs a clock inside the
 *     packet, and a clock inside the packet makes a scripted timeline
 *     irreproducible. Every freshness helper takes the instant as an argument.
 *
 * Nothing in this folder imports a renderer, branches on the active backend, or
 * performs I/O.
 *
 * @module Scene/SpaceWeather/SpaceWeatherTypes
 */

/**
 * Packet schema version. An integer, bumped on any change that would make an
 * older consumer misread a newer packet.
 *
 * Producers stamp this constant rather than a literal, so a packet built against
 * one schema and validated against another is rejected by
 * {@link validateSpaceWeatherPacket} instead of being silently misinterpreted.
 */
export const SPACE_WEATHER_PACKET_VERSION = 1;

/**
 * Who established a value.
 *
 * `"manual"` is the deterministic driver, `"synthetic"` an in-engine model,
 * `"caller"` a value the application supplied and whose provenance and usage
 * rights the application owns. The remaining members name the upstream products
 * an ingest adapter may carry: the auroral-precipitation model, the planetary
 * index, the real-time solar wind, and the geostationary X-ray sensors.
 */
export type SpaceWeatherAuthorityValue =
  "manual" | "synthetic" | "ovation" | "kp" | "rtsw" | "goes" | "caller";

/**
 * Enumerated {@link SpaceWeatherAuthorityValue} constants. Frozen so a typo in a
 * producer fails validation rather than quietly disabling an authority rule.
 */
export const SpaceWeatherAuthority = Object.freeze({
  MANUAL: "manual",
  SYNTHETIC: "synthetic",
  OVATION: "ovation",
  KP: "kp",
  RTSW: "rtsw",
  GOES: "goes",
  CALLER: "caller",
});

/** Every {@link SpaceWeatherAuthorityValue}, for validation and iteration. */
export const SPACE_WEATHER_AUTHORITIES: readonly SpaceWeatherAuthorityValue[] =
  Object.freeze([
    "manual",
    "synthetic",
    "ovation",
    "kp",
    "rtsw",
    "goes",
    "caller",
  ] as SpaceWeatherAuthorityValue[]);

/**
 * What a packet is: a hand-authored state, a model evaluation, an observation,
 * a forecast, or a replay of a recorded one.
 */
export type SpaceWeatherSourceKindValue =
  "manual" | "model" | "observed" | "forecast" | "replay";

/** Enumerated {@link SpaceWeatherSourceKindValue} constants. */
export const SpaceWeatherSourceKind = Object.freeze({
  MANUAL: "manual",
  MODEL: "model",
  OBSERVED: "observed",
  FORECAST: "forecast",
  REPLAY: "replay",
});

/** Every {@link SpaceWeatherSourceKindValue}, for validation and iteration. */
export const SPACE_WEATHER_SOURCE_KINDS: readonly SpaceWeatherSourceKindValue[] =
  Object.freeze([
    "manual",
    "model",
    "observed",
    "forecast",
    "replay",
  ] as SpaceWeatherSourceKindValue[]);

/**
 * A field of a packet, for {@link spaceWeatherAuthorityOf}. The authority marker
 * itself is stored beside the value; this enum exists so a caller can ask the
 * question by name without knowing the packet's shape.
 */
export type SpaceWeatherFieldValue =
  "activity" | "oval" | "solarWind" | "flare" | "dst";

/** Enumerated {@link SpaceWeatherFieldValue} constants. */
export const SpaceWeatherField = Object.freeze({
  ACTIVITY: "activity",
  OVAL: "oval",
  SOLAR_WIND: "solarWind",
  FLARE: "flare",
  DST: "dst",
});

/** How old a packet is relative to its declared validity window. */
export type SpaceWeatherFreshnessValue = "fresh" | "aging" | "stale";

/** Enumerated {@link SpaceWeatherFreshnessValue} constants. */
export const SpaceWeatherFreshness = Object.freeze({
  FRESH: "fresh",
  AGING: "aging",
  STALE: "stale",
});

/** The coordinate frame an {@link AuroraOvalField} grid is expressed in. */
export type AuroraOvalFrameValue = "geomagnetic" | "geographic";

/** Enumerated {@link AuroraOvalFrameValue} constants. */
export const AuroraOvalFrame = Object.freeze({
  GEOMAGNETIC: "geomagnetic",
  GEOGRAPHIC: "geographic",
});

/** Which auroral oval an {@link AuroraOvalField} describes. */
export type AuroraHemisphereValue = "north" | "south" | "both";

/** Enumerated {@link AuroraHemisphereValue} constants. */
export const AuroraHemisphere = Object.freeze({
  NORTH: "north",
  SOUTH: "south",
  BOTH: "both",
});

/**
 * How an {@link AuroraOvalField}'s samples are scaled.
 *
 * `"normalized"` samples are in `[0,1]`. `"raw"` samples are in the producing
 * product's own unit, with `rawMaximum` declaring the observed ceiling — the
 * option exists because a source may publish an index whose upper bound it never
 * states, and inventing a percentage for it would be a fabricated unit.
 */
export type AuroraIntensityScaleValue = "normalized" | "raw";

/** Enumerated {@link AuroraIntensityScaleValue} constants. */
export const AuroraIntensityScale = Object.freeze({
  NORMALIZED: "normalized",
  RAW: "raw",
});

/** Soft X-ray flare class letter, each step a decade of long-band flux. */
export type SolarFlareClassValue = "A" | "B" | "C" | "M" | "X";

/** Enumerated {@link SolarFlareClassValue} constants. */
export const SolarFlareClass = Object.freeze({
  A: "A",
  B: "B",
  C: "C",
  M: "M",
  X: "X",
});

/** Every {@link SolarFlareClassValue}, ascending in energy. */
export const SOLAR_FLARE_CLASSES: readonly SolarFlareClassValue[] =
  Object.freeze(["A", "B", "C", "M", "X"] as SolarFlareClassValue[]);

/** An inclusive numeric interval. */
export interface SpaceWeatherRange {
  minimum: number;
  maximum: number;
}

/**
 * Every bound {@link validateSpaceWeatherPacket} enforces, exported so a
 * producer clamps against the same numbers rather than a second copy of them.
 *
 * The planetary index runs 0 to 9 by definition. Solar-wind bounds are generous
 * physical envelopes, not expected values: they exist to catch a fill value or a
 * unit error, not to reject a real storm.
 */
export const SPACE_WEATHER_RANGES = Object.freeze({
  activity: Object.freeze({ minimum: 0, maximum: 1 }),
  kpIndex: Object.freeze({ minimum: 0, maximum: 9 }),
  bzNanoTesla: Object.freeze({ minimum: -200, maximum: 200 }),
  dstNanoTesla: Object.freeze({ minimum: -1000, maximum: 200 }),
  flareMagnitude: Object.freeze({ minimum: 1, maximum: 10 }),
  solarWindSpeedKmPerSecond: Object.freeze({ minimum: 0, maximum: 5000 }),
  solarWindDensityPerCubicCm: Object.freeze({ minimum: 0, maximum: 200 }),
  solarWindTemperatureKelvin: Object.freeze({ minimum: 0, maximum: 1e8 }),
  btNanoTesla: Object.freeze({ minimum: 0, maximum: 200 }),
  bzGsmNanoTesla: Object.freeze({ minimum: -200, maximum: 200 }),
  intensityNormalized: Object.freeze({ minimum: 0, maximum: 1 }),
});

/**
 * The fill value the real-time solar-wind products write when a field is
 * unavailable. It is inside several of the ranges above, so it is rejected by
 * name: an adapter that forwards it unstripped fails validation instead of
 * delivering a plausible-looking number to a renderer.
 */
export const SPACE_WEATHER_FILL_VALUE = -9999;

/** Where a packet came from, and how long it stays current. */
export interface SpaceWeatherProvenance {
  /** Stable, non-empty source identifier, unique per producer. */
  sourceId: string;
  /** What kind of statement the packet is. */
  kind: SpaceWeatherSourceKindValue;
  /** Human-readable label for a diagnostic or a credit line. */
  label?: string;
  /** Attribution the data owner requires, carried verbatim from the source. */
  attribution?: string;
  /**
   * How long after `observedTimeMs` the packet is still considered fresh, in
   * seconds. Finite and positive; it is the producer's statement about its own
   * cadence, not a guess a consumer makes.
   */
  validitySeconds: number;
}

/**
 * The geomagnetic channel: how disturbed the magnetosphere is, and the optional
 * indices behind that judgement.
 *
 * `activity` is the single scalar a renderer reads. `kpIndex` and `bzNanoTesla`
 * are diagnostics, and a producer that carries both keeps them consistent with
 * `activity` rather than offering a second, disagreeing answer.
 */
export interface GeomagneticState {
  /** Normalized geomagnetic activity in `[0,1]`. */
  activity: number;
  /** Who established `activity`. */
  authority: SpaceWeatherAuthorityValue;
  /** Planetary index in `[0,9]`, when carried. */
  kpIndex?: number;
  /** Interplanetary field north-south component in nT; negative is southward. */
  bzNanoTesla?: number;
  /**
   * Ring-current index in nT, when the application supplies one.
   *
   * There is no built-in provider and no bundled snapshot for this value: the
   * indices that define it are published under terms that forbid commercial
   * redistribution, so the only route is an application-owned number whose
   * provenance and rights the application carries. `dstAuthority` must therefore
   * be `"caller"` whenever this is present, and validation enforces it.
   */
  dstNanoTesla?: number;
  /** Who established `dstNanoTesla`; `"caller"` is the only valid value. */
  dstAuthority?: SpaceWeatherAuthorityValue;
}

/**
 * The solar-flare channel, deliberately separate from {@link GeomagneticState}.
 *
 * A soft X-ray flare is an electromagnetic observation and arrives in about
 * eight minutes. Any auroral consequence travels with the plasma that may follow
 * it, a day or more later, and needs a time-of-flight model that does not exist
 * here. Nothing in this module lets this state reach the geomagnetic scalar or
 * the oval.
 */
export interface SolarFlareState {
  /** Who established the flare state. */
  authority: SpaceWeatherAuthorityValue;
  /** Class letter; each step is a decade of long-band flux. */
  flareClass: SolarFlareClassValue;
  /** Magnitude within the class, in `[1,10)`. */
  magnitude: number;
  /** Long-band (0.1 to 0.8 nm) flux in W/m^2, when carried. Finite, positive. */
  longBandFluxWattsPerSquareMeter?: number;
  /** Short-band (0.05 to 0.4 nm) flux in W/m^2, when carried. Finite, positive. */
  shortBandFluxWattsPerSquareMeter?: number;
  /** Observation or peak instant, in ms since the Unix epoch. */
  observedTimeMs?: number;
}

/**
 * Optional solar-wind diagnostics. They inform a synthetic activity estimate and
 * a diagnostic readout; they are never a second forcing term on an oval field
 * whose own model already consumed them.
 */
export interface SolarWindDiagnostics {
  /** Who established these values. */
  authority: SpaceWeatherAuthorityValue;
  /**
   * Reporting spacecraft, as the feed names it. Carried rather than assumed: the
   * active source of the real-time stream changes, and a hard-coded name silently
   * reads a standby instrument.
   */
  sourceName?: string;
  /** Bulk proton speed in km/s. */
  speedKmPerSecond?: number;
  /** Proton number density per cubic centimetre. */
  densityPerCubicCm?: number;
  /** Proton temperature in kelvin. */
  temperatureKelvin?: number;
  /** Field magnitude in nT. */
  btNanoTesla?: number;
  /** Field north-south component in geocentric solar magnetospheric nT. */
  bzGsmNanoTesla?: number;
  /** Quality indicator as the feed reports it; lower is better. */
  overallQuality?: number;
}

/** Sample extent in radians, in an {@link AuroraOvalField}'s declared frame. */
export interface AuroraOvalBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

/**
 * A sampled auroral oval.
 *
 * `intensity[y * gridWidth + x]`: row 0 is the north edge and column 0 the west
 * edge, matching the weather-field grid in the sibling folder so the two
 * resample identically. `west > east` means the rectangle straddles the
 * antimeridian.
 *
 * An `"ovation"` field owns both extent and intensity: the model behind it has
 * already consumed the solar-wind and planetary-index inputs, so scaling it by
 * the activity scalar would count them twice. A `"synthetic"` field carries shape
 * only and expects that scaling. {@link auroraOvalIntensityScale} is where that
 * distinction becomes a number.
 */
export interface AuroraOvalField {
  /** Who produced the grid. */
  authority: SpaceWeatherAuthorityValue;
  /** The frame `bounds` and the sample axes are expressed in. */
  frame: AuroraOvalFrameValue;
  /** Which oval the grid covers. */
  hemisphere: AuroraHemisphereValue;
  /** Samples along the longitude axis; at least 2. */
  gridWidth: number;
  /** Samples along the latitude axis; at least 2. */
  gridHeight: number;
  /** Row-major samples, `gridWidth * gridHeight` of them. */
  intensity: Float32Array;
  /** Sample extent in radians. */
  bounds: AuroraOvalBounds;
  /** How `intensity` is scaled. */
  intensityScale: AuroraIntensityScaleValue;
  /** Observed ceiling of a `"raw"` grid; required for that scale, finite and positive. */
  rawMaximum?: number;
  /**
   * Epoch of a geomagnetic frame as a decimal year. The field model behind a
   * centred-dipole frame is valid for a five-year epoch, and carrying the epoch
   * here is what keeps it replaceable rather than frozen into a shader constant.
   *
   * Required when {@link AuroraOvalField#frame} is `"geomagnetic"`: validation
   * refuses such a grid without one, because a pole with no epoch is a pole that
   * cannot be replaced. Optional for a geographic frame, which no field model
   * places.
   */
  frameEpoch?: number;
}

/**
 * The normalized state a renderer consumes. Every other module in this folder
 * either produces one of these or answers a question about one.
 */
export interface SpaceWeatherPacket {
  /** Schema version; must equal {@link SPACE_WEATHER_PACKET_VERSION}. */
  version: number;
  /** Where the packet came from and how long it stays current. */
  provenance: SpaceWeatherProvenance;
  /** Observation instant, in ms since the Unix epoch. */
  observedTimeMs: number;
  /** Instant the state is valid for, in ms since the Unix epoch; never earlier than `observedTimeMs`. */
  forecastTimeMs: number;
  /** The geomagnetic channel. */
  geomagnetic: GeomagneticState;
  /** The separate solar-flare channel, when carried. */
  flare?: SolarFlareState;
  /** Optional solar-wind diagnostics. */
  solarWind?: SolarWindDiagnostics;
  /** Optional sampled oval; absent means a consumer derives its own geometry. */
  oval?: AuroraOvalField;
}

/** The outcome of {@link validateSpaceWeatherPacket}. */
export interface SpaceWeatherValidation {
  /** True when `errors` is empty. */
  valid: boolean;
  /** One message per violated rule, in declaration order. */
  errors: readonly string[];
}
