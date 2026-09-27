/**
 * The vocabulary, policies and pure composition rules of
 * {@link SolarWindFlareFeedIngest}, kept beside it so the class holds only the
 * lifecycle and the state.
 *
 * Everything here is a constant, a type or a function of its arguments. Nothing
 * reads a clock, performs I/O, imports a renderer, or branches on the active
 * backend.
 *
 * @module Scene/SpaceWeather/SolarWindFlareFeedIngestHelpers
 */
import {
  SPACE_WEATHER_PACKET_VERSION,
  SpaceWeatherAuthority,
  SpaceWeatherFreshness,
  SpaceWeatherSourceKind,
  type SolarFlareState,
  type SolarWindDiagnostics,
  type SpaceWeatherAuthorityValue,
  type SpaceWeatherFreshnessValue,
  type SpaceWeatherPacket,
} from "./SpaceWeatherTypes.js";
import {
  freezeSpaceWeatherPacket,
  spaceWeatherFreshness,
  spaceWeatherFreshnessForAge,
  validateSolarFlareState,
  validateSpaceWeatherPacket,
} from "./SpaceWeatherPacket.js";
import {
  SpaceWeatherOvalOwner,
  ovalAuthorityFor,
  spaceWeatherObservationIsPlausible,
  type OvalOwnership,
  type SpaceWeatherOvalOwnerValue,
} from "./SpaceWeatherSourceAuthority.js";
import {
  SpaceWeatherIngestCode,
  type SpaceWeatherFetchJson,
} from "./SpaceWeatherFeedIngest.js";
import {
  REAL_TIME_SOLAR_WIND_CADENCE_SECONDS,
  realTimeSolarWindReadingAt,
  type RealTimeSolarWindReading,
  type RealTimeSolarWindSeries,
} from "./RealTimeSolarWindNormalizer.js";
import {
  classifySolarXrayFlux,
  goesXrayReadingAt,
  type GoesXrayReading,
  type GoesXraySeries,
} from "./GoesXrayNormalizer.js";
import type { SolarWindActivityEstimate } from "./SolarWindCouplingEstimate.js";

/** The active-source magnetometer product. */
export const RTSW_MAGNETOMETER_PRODUCT_URL =
  "https://services.swpc.noaa.gov/json/rtsw/rtsw_mag_1m.json";

/** The active-source plasma product. */
export const RTSW_PLASMA_PRODUCT_URL =
  "https://services.swpc.noaa.gov/json/rtsw/rtsw_wind_1m.json";

/** The primary-spacecraft X-ray product, one day at one-minute cadence. */
export const GOES_XRAY_PRODUCT_URL =
  "https://services.swpc.noaa.gov/json/goes/primary/xrays-1-day.json";

/** The mapping of each instrument to its primary spacecraft. */
export const GOES_INSTRUMENT_SOURCES_URL =
  "https://services.swpc.noaa.gov/json/goes/instrument-sources.json";

/**
 * How long a solar-wind reading is credited as current, in seconds.
 *
 * A policy, not a product fact. The products publish a row a minute, but the
 * newest row of each is several minutes behind the instant it is served at (nine
 * and ten minutes on the frozen capture) and a missing minute is ordinary (up to
 * three measured). Fifteen minutes covers the measured lag plus the longest
 * measured gap with margin; the freshness bands then call the channel stale
 * after half an hour without a row, which is an outage rather than a lag.
 */
export const SOLAR_WIND_VALIDITY_SECONDS = 900;

/**
 * How long an X-ray reading is credited as current, in seconds. The same policy
 * and reasoning as {@link SOLAR_WIND_VALIDITY_SECONDS}: the newest row was six
 * minutes behind the serving instant on the frozen capture. A dropout run longer
 * than twice this — an eclipse can run over an hour — leaves the flare channel
 * stale, which is the truth about it.
 */
export const GOES_XRAY_VALIDITY_SECONDS = 900;

/**
 * Longest interval between polls after repeated transport failures, in seconds.
 * Tied to the solar-wind horizon so a recovering feed is asked again before the
 * state it last delivered could have gone from fresh to stale unasked.
 */
export const SOLAR_WIND_FLARE_MAX_BACKOFF_SECONDS = SOLAR_WIND_VALIDITY_SECONDS;

/**
 * Longest a request is left outstanding before it is abandoned as a transport
 * failure and asked again, in seconds. Tied to the backoff ceiling, so a peer
 * that never answers is asked again no less often than one that refuses, and at
 * most one request per product is ever outstanding.
 */
export const SOLAR_WIND_FLARE_REQUEST_TIMEOUT_SECONDS =
  SOLAR_WIND_FLARE_MAX_BACKOFF_SECONDS;

/** Solar-wind history kept by default, in seconds: the day the products carry. */
export const SOLAR_WIND_HISTORY_SECONDS = 86400;

/**
 * Whether a declared history window can be kept: a finite number of seconds no
 * shorter than the products' one-minute cadence.
 *
 * @param seconds The declared window.
 * @returns `true` when it can be kept.
 */
export function isSolarWindHistoryWindow(seconds: number): boolean {
  return (
    Number.isFinite(seconds) && seconds >= REAL_TIME_SOLAR_WIND_CADENCE_SECONDS
  );
}

/**
 * Attribution carried into every packet this ingest builds. The estimate is a
 * transformation of the service's output, which the publisher's terms forbid
 * presenting as official material, so the credit says so.
 */
export const SOLAR_WIND_FLARE_ATTRIBUTION =
  "NOAA Space Weather Prediction Center real-time solar wind and GOES X-ray flux. Activity estimated by CesiumJS from the Newell et al. (2008) solar wind relation; not official government material.";

/** The four products this ingest reads. */
export type SolarWindFlareProductValue =
  "rtsw-magnetometer" | "rtsw-plasma" | "goes-xray" | "goes-instrument-sources";

/** Enumerated {@link SolarWindFlareProductValue} constants. */
export const SolarWindFlareProduct = Object.freeze({
  RTSW_MAGNETOMETER: "rtsw-magnetometer",
  RTSW_PLASMA: "rtsw-plasma",
  GOES_XRAY: "goes-xray",
  GOES_INSTRUMENT_SOURCES: "goes-instrument-sources",
});

/**
 * The oval authority, named as the source of a refusal its packet caused. It is
 * not one of the four products: its packet arrives through its own ingest.
 */
export const OVAL_AUTHORITY_FAILURE_SOURCE = "oval-authority";

/** What a refusal is attributed to: one of the four products, or the authority. */
export type SolarWindFlareFailureSourceValue =
  SolarWindFlareProductValue | typeof OVAL_AUTHORITY_FAILURE_SOURCE;

/**
 * Codes this ingest raises itself, beside the ones its normalizers return. It is
 * the auroral ingest's vocabulary by reference, so a consumer renders one set of
 * codes and the two ingests cannot drift apart.
 */
export const SolarWindFlareIngestCode = SpaceWeatherIngestCode;

/** Why the flare channel is absent from a packet. */
export type FlareOmissionValue =
  "no-series" | "stale" | "below-class-floor" | "invalid-packet";

/** Enumerated {@link FlareOmissionValue} constants. */
export const FlareOmission = Object.freeze({
  NO_SERIES: "no-series",
  STALE: "stale",
  BELOW_CLASS_FLOOR: "below-class-floor",
  INVALID_PACKET: "invalid-packet",
});

/** What a listener hears about. */
export type SolarWindFlareEventTypeValue =
  "activity-authority-change" | "active-source-handoff" | "flare-class-change";

/** Enumerated {@link SolarWindFlareEventTypeValue} constants. */
export const SolarWindFlareEventType = Object.freeze({
  ACTIVITY_AUTHORITY_CHANGE: "activity-authority-change",
  ACTIVE_SOURCE_HANDOFF: "active-source-handoff",
  FLARE_CLASS_CHANGE: "flare-class-change",
});

/** One transition, raised once, from a request cycle or a poll tick. */
export interface SolarWindFlareEvent {
  type: SolarWindFlareEventTypeValue;
  /** The deciding instant, in ms since the Unix epoch. */
  atMs: number;
  /** What it was before; `undefined` for none. */
  previous: string | undefined;
  /** What it is now; `undefined` for none. */
  current: string | undefined;
}

/**
 * The two published reads of the auroral-model and planetary-index ingest this
 * ingest composes around. That ingest satisfies it as it stands.
 *
 * A packet it returns must not change afterwards: each one is judged once, by
 * identity, as the composition key reads it.
 */
export interface SpaceWeatherOvalAuthoritySource {
  latest(): SpaceWeatherPacket | undefined;
  latestOwnership(): OvalOwnership | undefined;
}

/** Construction options. */
export interface SolarWindFlareFeedIngestOptions {
  /** Fetches and decodes one JSON document. Required; there is no global fallback. */
  fetchJson: SpaceWeatherFetchJson;
  /** The oval authority to compose around; without one, no product owns the oval. */
  authority?: SpaceWeatherOvalAuthoritySource;
  magnetometerUrl?: string;
  plasmaUrl?: string;
  xrayUrl?: string;
  instrumentSourcesUrl?: string;
  /**
   * Solar-wind history to keep, in seconds: a finite number no shorter than the
   * products' one-minute cadence, 60 s. A shorter window holds one minute per
   * product, and the estimate forms only while those two minutes coincide.
   * Defaults to {@link SOLAR_WIND_HISTORY_SECONDS}.
   */
  historySeconds?: number;
  /** Seconds between polls when nothing is failing. */
  pollIntervalSeconds?: number;
  setTimeoutFunction?: (handler: () => void, timeoutMs: number) => number;
  clearTimeoutFunction?: (handle: number) => void;
  nowFunction?: () => number;
  /** Source id stamped into a solar-wind packet. Defaults to `"noaa-rtsw"`. */
  solarWindSourceId?: string;
}

/** The most recent refusal. */
export interface SolarWindFlareIngestFailure {
  product: SolarWindFlareFailureSourceValue;
  code: string;
  message: string;
  atMs: number;
}

/** What the ingest reports about itself. */
export interface SolarWindFlareIngestDiagnostics {
  running: boolean;
  /** Requests issued, one per product asked. */
  requestsIssued: number;
  payloadsParsed: number;
  packetsBuilt: number;
  /** Answers dropped because their request had been abandoned. */
  supersededResultsDiscarded: number;
  /**
   * Refusals recorded. A refusal decided when the packet is composed, such as
   * an authority packet or a flare the packet cannot carry, is counted at each
   * composition that decides it, not once per payload.
   */
  payloadsRefused: number;
  lastFailure?: SolarWindFlareIngestFailure;
  /**
   * Request cycles in a row whose requests failed in transport with none
   * answered. Any answer, from any cycle, resets it the moment it arrives.
   */
  consecutiveTransportFailures: number;
  /**
   * The interval between request cycles after this outcome, in ms. The poll
   * tick that re-composes the packet keeps the poll interval regardless.
   */
  nextPollDelayMs: number;
  /**
   * The owner the composing authority's decision named at the last publish;
   * `none` when it named none, could not be read, or named an owner outside
   * the vocabulary.
   */
  ovalOwner: SpaceWeatherOvalOwnerValue;
  /** Who established the published activity scalar, or `"none"` with no packet. */
  activityAuthority: SpaceWeatherAuthorityValue | "none";
  /** The authority packet's band against its own declared validity. */
  authorityPacketFreshness?: SpaceWeatherFreshnessValue;
  solarWindFreshness?: SpaceWeatherFreshnessValue;
  plasma?: RealTimeSolarWindSeries;
  magnetometer?: RealTimeSolarWindSeries;
  estimate?: SolarWindActivityEstimate;
  flareFreshness?: SpaceWeatherFreshnessValue;
  xray?: GoesXraySeries;
  primarySatellite?: number;
  flareOmission?: FlareOmissionValue;
}

export const MILLISECONDS_PER_SECOND = 1000;

/** Throttle on the refusal log, so a persistently broken feed logs once a minute. */
export const FAILURE_LOG_INTERVAL_MS = 60000;

/**
 * The packet's own three freshness bands, applied to a reading that is not yet a
 * packet.
 *
 * @param observedMs The reading's instant, in ms since the Unix epoch.
 * @param nowMs The deciding instant, in ms since the Unix epoch.
 * @param validitySeconds The horizon the reading is credited with.
 * @returns The band.
 */
export function bandFor(
  observedMs: number,
  nowMs: number,
  validitySeconds: number,
): SpaceWeatherFreshnessValue {
  return spaceWeatherFreshnessForAge(
    (nowMs - observedMs) / MILLISECONDS_PER_SECOND,
    validitySeconds,
  );
}

/**
 * The interval between request cycles after a run of transport failures: the
 * poll interval doubled per failure, up to the backoff ceiling.
 *
 * @param pollIntervalMs The poll interval, in ms.
 * @param consecutiveFailures Request cycles in a row that failed in transport.
 * @returns The interval, in ms.
 */
export function requestDelayMs(
  pollIntervalMs: number,
  consecutiveFailures: number,
): number {
  const backedOff = pollIntervalMs * Math.pow(2, consecutiveFailures);
  return Math.min(
    backedOff,
    Math.max(
      pollIntervalMs,
      SOLAR_WIND_FLARE_MAX_BACKOFF_SECONDS * MILLISECONDS_PER_SECOND,
    ),
  );
}

/**
 * Call a transport, turning a synchronous throw into a rejection.
 *
 * @param fetchJson The transport.
 * @param url The product's URL.
 * @param signal The request's abort signal.
 * @returns The answer, or the rejection.
 */
export function invokeTransport(
  fetchJson: SpaceWeatherFetchJson,
  url: string,
  signal: AbortSignal,
): Promise<unknown> {
  // A transport may raise its own argument check synchronously; that throw
  // must reach the product as a rejection, not escape the cycle.
  try {
    return Promise.resolve(fetchJson(url, signal));
  } catch (error) {
    return Promise.reject(error);
  }
}

/**
 * A promise that settles only when told to.
 *
 * @returns The promise, and the function that settles it.
 */
export function abandonablePromise(): {
  promise: Promise<void>;
  abandon: () => void;
} {
  let abandon = (): void => {};
  const promise = new Promise<void>((resolve) => {
    abandon = () => resolve();
  });
  return { promise: promise, abandon: abandon };
}

/**
 * Describe a rejection reason without trusting it to describe itself.
 *
 * Every read of the reason is inside the `try`, because each can throw: an
 * Error whose `message` getter throws or whose `name` is a Symbol, and a revoked
 * Proxy, which throws even when asked whether it is an Error. Such a value is
 * described by its type alone, which `typeof` reads without touching it.
 *
 * @param reason The rejection reason.
 * @returns Diagnostic text, always.
 */
export function describeReason(reason: unknown): string {
  try {
    if (reason instanceof Error) {
      return `${reason.name}: ${reason.message}`;
    }
    return String(reason);
  } catch {
    return `a ${typeof reason} that cannot be described`;
  }
}

/** The inputs a published packet was built from, compared element by element. */
export type CompositionKey = readonly unknown[];

/**
 * A plain value reduced to one that compares equal exactly when the value
 * does, so two decodes of the same minutes compose the same packet.
 *
 * @param value A decoded reading, an estimate or a flare result, or `undefined`.
 * @returns Its serialized form, or `undefined`.
 */
export function valueFingerprint(
  value: object | undefined,
): string | undefined {
  return value === undefined ? undefined : JSON.stringify(value);
}

/**
 * One frozen transition.
 *
 * @param type What changed.
 * @param atMs The deciding instant, in ms since the Unix epoch.
 * @param previous What it was; `undefined` for none.
 * @param current What it is now; `undefined` for none.
 * @returns The event.
 */
export function transition(
  type: SolarWindFlareEventTypeValue,
  atMs: number,
  previous: string | undefined,
  current: string | undefined,
): SolarWindFlareEvent {
  return Object.freeze({
    type: type,
    atMs: atMs,
    previous: previous,
    current: current,
  });
}

/**
 * Whether two compositions were built from the same inputs, element by element
 * and by identity.
 *
 * @param a The previous key, if any.
 * @param b The candidate key.
 * @returns Whether nothing changed.
 */
export function sameKey(
  a: CompositionKey | undefined,
  b: CompositionKey,
): boolean {
  if (a === undefined || a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; ++i) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

/** A flare state, or the reason there is none. */
export type SolarFlareStateResult =
  | { status: "ok"; flare: SolarFlareState }
  | { status: "omitted"; omission: FlareOmissionValue };

/**
 * The flare channel for one long-band reading.
 *
 * The short band is carried only when it was read at the same minute; a short
 * band from another minute describes a different Sun.
 *
 * @param reading The long-band reading.
 * @param series The series it came from, for the matching short-band minute.
 * @returns The state, or why there is none.
 */
export function solarFlareStateFrom(
  reading: GoesXrayReading,
  series: GoesXraySeries | undefined,
): SolarFlareStateResult {
  const classification = classifySolarXrayFlux(reading.flux);
  if (classification === undefined) {
    return { status: "omitted", omission: FlareOmission.BELOW_CLASS_FLOOR };
  }
  const shortBand =
    series === undefined
      ? undefined
      : goesXrayReadingAt(series.shortBand, reading.timeTagMs);
  return {
    status: "ok",
    flare: {
      authority: SpaceWeatherAuthority.GOES,
      flareClass: classification.flareClass,
      magnitude: classification.magnitude,
      longBandFluxWattsPerSquareMeter: reading.flux,
      shortBandFluxWattsPerSquareMeter:
        shortBand !== undefined && shortBand.timeTagMs === reading.timeTagMs
          ? shortBand.flux
          : undefined,
      observedTimeMs: reading.timeTagMs,
    },
  };
}

/**
 * The solar-wind diagnostics for the newest current reading of each product.
 *
 * @param plasma The newest current plasma reading, if any.
 * @param field The newest current magnetometer reading, if any.
 * @returns The diagnostics, or `undefined` when neither product is current.
 */
export function solarWindDiagnosticsFrom(
  plasma: RealTimeSolarWindReading | undefined,
  field: RealTimeSolarWindReading | undefined,
): SolarWindDiagnostics | undefined {
  const named = plasma ?? field;
  if (named === undefined) {
    return undefined;
  }
  return {
    authority: SpaceWeatherAuthority.RTSW,
    sourceName: named.sourceName,
    speedKmPerSecond: plasma?.speedKmPerSecond,
    densityPerCubicCm: plasma?.densityPerCubicCm,
    temperatureKelvin: plasma?.temperatureKelvin,
    btNanoTesla: field?.btNanoTesla,
    bzGsmNanoTesla: field?.bzGsmNanoTesla,
    overallQuality: named.overallQuality,
  };
}

/** Everything one composition is built from. */
export interface SolarWindFlareComposition {
  /** Who owns the oval, as the authority decided it. */
  owner: SpaceWeatherOvalOwnerValue;
  /**
   * The authority's packet when it is usable, `undefined` otherwise. Only a
   * packet {@link readOvalAuthority} admitted is usable.
   */
  base: SpaceWeatherPacket | undefined;
  /** Why the authority is absent although it answered, if it is. */
  authorityRefusal?: string;
  /** The solar-wind estimate, when both products are current. */
  estimate: SolarWindActivityEstimate | undefined;
  /** The newest current magnetometer reading, for the north-south diagnostic. */
  field: RealTimeSolarWindReading | undefined;
  solarWind: SolarWindDiagnostics | undefined;
  flare: SolarFlareState | undefined;
  /** Source id stamped into a packet this composition originates. */
  sourceId: string;
}

/**
 * Build the packet for one composition.
 *
 * With a usable authority packet the geomagnetic channel, the instants and the
 * provenance are the authority's own, copied rather than re-derived; the oval is
 * carried by identity, and only when the grid carries the marker the decision
 * requires — the model's own under a model owner, a synthetic shape under an
 * index owner. Nothing here multiplies it.
 *
 * Without one, the solar-wind estimate is the activity scalar, stamped with its
 * own authority, and there is no oval at all. With neither there is nothing to
 * publish: the flare channel is not a geomagnetic state, and a packet that
 * invented one to carry it would describe a quiet magnetosphere nobody measured.
 *
 * @param composition The inputs.
 * @returns The frozen packet, or `undefined`.
 */
export function composeSolarWindFlarePacket(
  composition: SolarWindFlareComposition,
): SpaceWeatherPacket | undefined {
  const base = composition.base;
  if (base !== undefined) {
    const owner = composition.owner;
    // The marker is checked against the decision, not merely present: a packet
    // kept in place after its producer lost the oval still carries that
    // producer's marker, and it is the decision that says whether to draw it.
    const oval =
      owner !== SpaceWeatherOvalOwner.NONE &&
      base.oval !== undefined &&
      base.oval.authority === ovalAuthorityFor(owner)
        ? base.oval
        : undefined;
    return freezeSpaceWeatherPacket({
      version: SPACE_WEATHER_PACKET_VERSION,
      provenance: { ...base.provenance },
      observedTimeMs: base.observedTimeMs,
      forecastTimeMs: base.forecastTimeMs,
      geomagnetic: { ...base.geomagnetic },
      solarWind: composition.solarWind,
      flare: composition.flare,
      oval: oval,
    });
  }
  const estimate = composition.estimate;
  if (estimate === undefined) {
    return undefined;
  }
  return freezeSpaceWeatherPacket({
    version: SPACE_WEATHER_PACKET_VERSION,
    provenance: {
      sourceId: composition.sourceId,
      kind: SpaceWeatherSourceKind.MODEL,
      label: "Activity estimated from the real-time solar wind",
      attribution: SOLAR_WIND_FLARE_ATTRIBUTION,
      validitySeconds: SOLAR_WIND_VALIDITY_SECONDS,
    },
    observedTimeMs: estimate.newestMs,
    forecastTimeMs: estimate.newestMs,
    geomagnetic: {
      activity: estimate.activity,
      authority: SpaceWeatherAuthority.RTSW,
      bzNanoTesla: composition.field?.bzGsmNanoTesla,
    },
    solarWind: composition.solarWind,
    flare: composition.flare,
  });
}

/** A refusal one composition raised, and what it is attributed to. */
export interface SolarWindFlareCompositionRefusal {
  source: SolarWindFlareFailureSourceValue;
  message: string;
}

/** A composition after validation: what may be published, and what was not. */
export interface ValidatedSolarWindFlareComposition {
  /** The packet to publish, or `undefined`. */
  packet: SpaceWeatherPacket | undefined;
  /** The flare channel that survived its own check, or `undefined`. */
  flare: SolarFlareState | undefined;
  /** Whether the flare was refused by the packet's own flare rule. */
  flareRefused: boolean;
  /** Each refusal, in the order it was decided. */
  refusals: readonly SolarWindFlareCompositionRefusal[];
}

// An authority packet is read by identity, as the composition key reads it, so
// each one is checked once however many compositions are built around it.
const authorityPacketErrors = new WeakMap<object, readonly string[]>();

function authorityErrorsOf(packet: unknown): readonly string[] {
  // Only an object can be a packet, or a key; anything else is refused as is.
  if (typeof packet !== "object" || packet === null) {
    return validateSpaceWeatherPacket(packet).errors;
  }
  const known = authorityPacketErrors.get(packet);
  if (known !== undefined) {
    return known;
  }
  const errors = validateSpaceWeatherPacket(packet).errors;
  authorityPacketErrors.set(packet, errors);
  return errors;
}

// The owners a decision may name. A decision naming anything else names none.
const OVAL_OWNERS: readonly unknown[] = Object.values(SpaceWeatherOvalOwner);

function isOvalOwner(value: unknown): value is SpaceWeatherOvalOwnerValue {
  return OVAL_OWNERS.includes(value);
}

/** What an oval authority reported for one composition. */
export interface OvalAuthorityRead {
  /**
   * The owner its decision names; `none` when it names none, cannot be read, or
   * names an owner outside the vocabulary.
   */
  owner: SpaceWeatherOvalOwnerValue;
  /** Its packet, only when the packet validates. */
  packet: SpaceWeatherPacket | undefined;
  /** What it handed back as its packet, valid or not, compared by identity. */
  offered: unknown;
  /** Why it is an absent authority although it answered, or `undefined`. */
  refusal: string | undefined;
}

/**
 * Read an oval authority's decision and packet.
 *
 * The authority is caller code behind a structural interface, so nothing it
 * hands back is read before it is judged. A packet that does not validate,
 * `null` and a packet without its provenance included, is an absent authority
 * refused by name, and so is an authority whose read throws and one whose
 * decision names an owner outside the vocabulary; either way the composition
 * carries on without it, and composes neither its scalar nor its oval.
 *
 * @param authority The authority, if any.
 * @returns Its decision, its packet when that validates, and any refusal.
 */
export function readOvalAuthority(
  authority: SpaceWeatherOvalAuthoritySource | undefined,
): OvalAuthorityRead {
  let owner: unknown;
  let offered: SpaceWeatherPacket | undefined;
  let errors: readonly string[];
  try {
    owner = authority?.latestOwnership()?.owner ?? SpaceWeatherOvalOwner.NONE;
    offered = authority?.latest();
    errors = offered === undefined ? [] : authorityErrorsOf(offered);
  } catch (error) {
    return {
      owner: SpaceWeatherOvalOwner.NONE,
      packet: undefined,
      offered: undefined,
      refusal: `the authority could not be read: ${describeReason(error)}`,
    };
  }
  if (!isOvalOwner(owner)) {
    // Quoted when it is a string, so a stray space or case is visible.
    const named =
      typeof owner === "string" ? JSON.stringify(owner) : describeReason(owner);
    return {
      owner: SpaceWeatherOvalOwner.NONE,
      packet: undefined,
      offered: offered,
      refusal: `the authority's decision names an owner outside the vocabulary: ${named}`,
    };
  }
  if (errors.length > 0) {
    return {
      owner: owner,
      packet: undefined,
      offered: offered,
      refusal: errors[0],
    };
  }
  return {
    owner: owner,
    packet: offered,
    offered: offered,
    refusal: undefined,
  };
}

/**
 * An authority packet's band against its own declared validity.
 *
 * @param packet A packet {@link readOvalAuthority} admitted, if any.
 * @param nowMs The deciding instant, in ms since the Unix epoch.
 * @returns The band, or `undefined` without a packet.
 */
export function authorityPacketFreshness(
  packet: SpaceWeatherPacket | undefined,
  nowMs: number,
): SpaceWeatherFreshnessValue | undefined {
  if (packet === undefined) {
    return undefined;
  }
  // An observation instant the clock cannot credit is stale, whatever its
  // age says: the folder's one rule for what an observation can be.
  return spaceWeatherObservationIsPlausible(packet.observedTimeMs, nowMs)
    ? spaceWeatherFreshness(packet, nowMs)
    : SpaceWeatherFreshness.STALE;
}

/**
 * Build the packet for one composition and validate it before it is stored,
 * attributing each refusal to the part that caused it.
 *
 *   - **The flare** is checked on its own. A value its range cannot carry costs
 *     the flare channel and nothing else, and is the X-ray product's refusal.
 *   - **The authority** was judged before the composition, by
 *     {@link readOvalAuthority}. One that did not hand back a valid packet is an
 *     absent authority: the composition falls back to the solar-wind estimate,
 *     and the refusal is the authority's, not a product's.
 *   - **What remains** is the solar wind's, and a composition that still does
 *     not validate publishes nothing.
 *
 * @param composition The inputs.
 * @returns The packet, the flare it carries, and the refusals.
 */
export function composeValidatedSolarWindFlarePacket(
  composition: SolarWindFlareComposition,
): ValidatedSolarWindFlareComposition {
  const refusals: SolarWindFlareCompositionRefusal[] = [];
  let flare = composition.flare;
  let flareRefused = false;
  if (flare !== undefined) {
    const check = validateSolarFlareState(flare);
    if (!check.valid) {
      refusals.push({
        source: SolarWindFlareProduct.GOES_XRAY,
        message: check.errors[0],
      });
      flare = undefined;
      flareRefused = true;
    }
  }
  if (composition.authorityRefusal !== undefined) {
    refusals.push({
      source: OVAL_AUTHORITY_FAILURE_SOURCE,
      message: composition.authorityRefusal,
    });
  }
  let packet = composeSolarWindFlarePacket({
    ...composition,
    flare: flare,
  });
  if (packet !== undefined) {
    const check = validateSpaceWeatherPacket(packet);
    if (!check.valid) {
      refusals.push({
        source: SolarWindFlareProduct.RTSW_PLASMA,
        message: check.errors[0],
      });
      packet = undefined;
    }
  }
  return {
    packet: packet,
    flare: flare,
    flareRefused: flareRefused,
    refusals: refusals,
  };
}

/**
 * The newest reading of a solar-wind series at or before an instant, while it is
 * not stale.
 *
 * @param series The held series, if any.
 * @param nowMs The deciding instant, in ms since the Unix epoch.
 * @returns The reading, or `undefined`.
 */
export function currentSolarWindReading(
  series: RealTimeSolarWindSeries | undefined,
  nowMs: number,
): RealTimeSolarWindReading | undefined {
  if (series === undefined) {
    return undefined;
  }
  const reading = realTimeSolarWindReadingAt(series, nowMs);
  if (
    reading === undefined ||
    bandFor(reading.timeTagMs, nowMs, SOLAR_WIND_VALIDITY_SECONDS) ===
      SpaceWeatherFreshness.STALE
  ) {
    return undefined;
  }
  return reading;
}

/**
 * The solar-wind channel's band: the newer of the two current readings against
 * the solar-wind horizon, stale once neither product has a current reading.
 *
 * @param held Whether either product has delivered a series.
 * @param plasma The newest current plasma reading, if any.
 * @param field The newest current magnetometer reading, if any.
 * @param nowMs The deciding instant, in ms since the Unix epoch.
 * @returns The band, or `undefined` before either product has delivered.
 */
export function solarWindFreshnessOf(
  held: boolean,
  plasma: RealTimeSolarWindReading | undefined,
  field: RealTimeSolarWindReading | undefined,
  nowMs: number,
): SpaceWeatherFreshnessValue | undefined {
  if (!held) {
    return undefined;
  }
  if (plasma === undefined && field === undefined) {
    return SpaceWeatherFreshness.STALE;
  }
  const newestMs = Math.max(
    plasma?.timeTagMs ?? Number.NEGATIVE_INFINITY,
    field?.timeTagMs ?? Number.NEGATIVE_INFINITY,
  );
  return bandFor(newestMs, nowMs, SOLAR_WIND_VALIDITY_SECONDS);
}

/** The long-band reading the flare channel is read from, or why there is none. */
export interface FlareReadingAt {
  reading: GoesXrayReading | undefined;
  freshness: SpaceWeatherFreshnessValue | undefined;
  omission: FlareOmissionValue | undefined;
}

/**
 * The newest long-band reading at or before an instant, its band, and the
 * omission to report while it cannot be carried.
 *
 * @param series The held X-ray series, if any.
 * @param nowMs The deciding instant, in ms since the Unix epoch.
 * @returns The reading while it is not stale, with its band and omission.
 */
export function flareReadingAt(
  series: GoesXraySeries | undefined,
  nowMs: number,
): FlareReadingAt {
  const reading =
    series === undefined
      ? undefined
      : goesXrayReadingAt(series.longBand, nowMs);
  if (reading === undefined) {
    return {
      reading: undefined,
      freshness: undefined,
      omission: FlareOmission.NO_SERIES,
    };
  }
  const freshness = bandFor(
    reading.timeTagMs,
    nowMs,
    GOES_XRAY_VALIDITY_SECONDS,
  );
  return freshness === SpaceWeatherFreshness.STALE
    ? {
        reading: undefined,
        freshness: freshness,
        omission: FlareOmission.STALE,
      }
    : { reading: reading, freshness: freshness, omission: undefined };
}

/** What the transitions are measured against: the state as last published. */
export interface SolarWindFlareTransitionState {
  flareClass: string | undefined;
  activityAuthority: SpaceWeatherAuthorityValue | "none";
  /** The spacecraft last named; a composition that names none leaves it. */
  activeSource: string | undefined;
  /** The transport that named it, as the ingest numbers its replacements. */
  activeSourceProvider: number | undefined;
}

/**
 * The events one publish raises against the state last published, and the
 * state it leaves.
 *
 * Only a change between two spacecraft one provider named is a handoff; a
 * channel going stale and coming back is not, and neither is a transport switch,
 * because two providers may name the same spacecraft differently.
 *
 * @param previous The state as last published.
 * @param next The state this publish composes; its `activeSource` is the
 *   spacecraft it names, or `undefined` for none.
 * @param atMs The deciding instant, in ms since the Unix epoch.
 * @returns The events, in the order they are raised, and the state to keep.
 */
export function transitionsBetween(
  previous: SolarWindFlareTransitionState,
  next: SolarWindFlareTransitionState,
  atMs: number,
): { events: SolarWindFlareEvent[]; state: SolarWindFlareTransitionState } {
  const events: SolarWindFlareEvent[] = [];
  if (next.flareClass !== previous.flareClass) {
    events.push(
      transition(
        SolarWindFlareEventType.FLARE_CLASS_CHANGE,
        atMs,
        previous.flareClass,
        next.flareClass,
      ),
    );
  }
  if (next.activityAuthority !== previous.activityAuthority) {
    events.push(
      transition(
        SolarWindFlareEventType.ACTIVITY_AUTHORITY_CHANGE,
        atMs,
        previous.activityAuthority,
        next.activityAuthority,
      ),
    );
  }
  const named = next.activeSource !== undefined;
  const sameProvider =
    next.activeSourceProvider === previous.activeSourceProvider;
  if (
    named &&
    sameProvider &&
    previous.activeSource !== undefined &&
    previous.activeSource !== next.activeSource
  ) {
    events.push(
      transition(
        SolarWindFlareEventType.ACTIVE_SOURCE_HANDOFF,
        atMs,
        previous.activeSource,
        next.activeSource,
      ),
    );
  }
  return {
    events: events,
    state: {
      flareClass: next.flareClass,
      activityAuthority: next.activityAuthority,
      activeSource: named ? next.activeSource : previous.activeSource,
      activeSourceProvider: named
        ? next.activeSourceProvider
        : previous.activeSourceProvider,
    },
  };
}
