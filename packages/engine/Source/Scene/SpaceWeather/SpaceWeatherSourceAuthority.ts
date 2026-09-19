/**
 * The source-authority contract: which upstream product owns the auroral oval
 * at any instant, what the other products may still say, and what no product is
 * ever allowed to do to a field it did not produce.
 *
 * A {@link SpaceWeatherPacket} records an authority beside every value, but a
 * marker only says who spoke — it cannot say who should have. That second
 * question appears the moment two products describe the same thing: the auroral
 * precipitation model publishes an oval directly, and the planetary index can be
 * turned into one. Answering it per call site produces a different answer per
 * call site, so it is answered once, here, as a pure function over declared
 * state.
 *
 * Three rules, in the order they bind:
 *
 *   - **A valid, current model grid owns oval position and intensity outright.**
 *     It is the only source that measures the oval rather than inferring it.
 *   - **The planetary index may own the oval only in the model's absence** — no
 *     snapshot yet, a refused payload, or a snapshot past its own declared
 *     horizon. It produces a synthetic shape, and it says so in the authority
 *     marker it stamps, so a consumer can label the difference.
 *   - **No index and no field component ever multiplies a model-owned grid.**
 *     The model behind that grid already consumed those inputs; applying them
 *     again counts the same physics twice. {@link ovalForcingMultiplier} is
 *     where the rule becomes a number, and it returns exactly one.
 *
 * Ownership changes are transitions, not side effects: every evaluation reports
 * the owner it replaced and whether this call moved it, so a caller raises one
 * event per change instead of re-deriving the change from two snapshots.
 *
 * Nothing here reads a clock, performs I/O, imports a renderer, or branches on
 * the active backend. The instant is always a parameter.
 *
 * @module Scene/SpaceWeather/SpaceWeatherSourceAuthority
 */
import {
  SpaceWeatherAuthority,
  SpaceWeatherFreshness,
  type SpaceWeatherAuthorityValue,
  type SpaceWeatherFreshnessValue,
  type SpaceWeatherPacket,
} from "./SpaceWeatherTypes.js";

/**
 * Smallest horizon an auroral-precipitation snapshot is credited with, in
 * seconds.
 *
 * The snapshot states its own horizon — the interval between the observation
 * and forecast instants it carries — and that interval is what
 * {@link ovationValiditySeconds} normally returns. This floor exists for one
 * documented case: when the upstream solar-wind inputs are unavailable the model
 * falls back to the planetary index and publishes **no forecast lead at all**,
 * which would otherwise make a perfectly usable snapshot expire the instant it
 * arrived.
 *
 * The value is the product's own nominal horizon, the half hour named in the
 * title of the SWPC Aurora 30-Minute Forecast. It is never used in place of a
 * lead the payload actually declares.
 */
export const OVATION_VALIDITY_FLOOR_SECONDS = 1800;

/**
 * Longest horizon a snapshot is credited with, in seconds.
 *
 * The lead is read from the payload because it is measurably variable, and that
 * is the right rule for every lead a publisher stamps correctly. It is also the
 * number that decides how long an observation goes on being believed, so a
 * payload declaring its own horizon is a payload trusted to say how long to
 * trust it: a `Forecast Time` whose year is mistyped buys a year of trust, and
 * the snapshot reads current for that year with nothing else objecting.
 *
 * Like {@link SPACE_WEATHER_CLOCK_SKEW_TOLERANCE_SECONDS} this is a policy and
 * not a physical quantity. It has to sit far enough above every lead these
 * products have ever been measured to declare that no healthy payload is
 * bounded by it, and close enough that a mislabelled one is believed for hours
 * rather than for years. Six times the product's own nominal half-hour horizon
 * meets both: three hours is nearly twice the longest lead ever measured from
 * it (94 minutes), and since the freshness bands run to twice the horizon, a
 * snapshot is current for at most six hours after the instant it declares.
 *
 * A bounded snapshot is kept and published, not refused — a wrong forecast
 * instant says nothing about the grid beside it. What is refused is the trust
 * the label asks for.
 */
export const OVATION_VALIDITY_CEILING_SECONDS = 10800;

/**
 * Publication interval of the planetary index, in seconds.
 *
 * Both the observed and the forecast product are binned into three-hour
 * intervals, and every measured interval in both is exactly that. A consumer
 * that polls faster learns nothing, and a consumer that treats a row as expired
 * sooner discards the only row there is.
 */
export const PLANETARY_KP_CADENCE_SECONDS = 10800;

/**
 * How far ahead of the deciding instant an observation instant may still be
 * credited, in seconds.
 *
 * A **forecast** instant lies ahead of the clock by design — that interval is
 * the lead this contract measures, and this tolerance never applies to it;
 * {@link OVATION_VALIDITY_CEILING_SECONDS} is what bounds that one. An
 * **observation** instant does not lead the clock: it names a moment that has
 * already happened. One that arrives ahead of the clock is either two clocks
 * disagreeing or a publisher stamping the wrong instant, and only the first
 * deserves to be tolerated.
 *
 * Five minutes is what that tolerance is conventionally set to wherever two
 * clocks are meant to agree and one of them cannot be trusted to: it is the
 * default acceptable clock skew named in RFC 4120 §10, and the leeway a token
 * validator conventionally allows a `nbf` or `iat` claim. Nothing about these
 * products sets it — it is not a physical quantity but a statement of how wrong
 * two clocks may be about each other before the difference has to be called an
 * error. Every healthy observation instant is already in the past, so the
 * tolerance costs a well-behaved feed nothing.
 */
export const SPACE_WEATHER_CLOCK_SKEW_TOLERANCE_SECONDS = 300;

/**
 * Whether an instant can be one at which something was observed.
 *
 * The question behind this is which of two disagreeing clocks to believe, and
 * the answer is: neither, past a stated tolerance. Inside it the instant is
 * credited, because the disagreement is ordinary skew. Outside it the instant is
 * refused, because nothing is observed after the present — and an instant that
 * cannot be real must not be allowed to describe the present, nor to outrank the
 * instants that can.
 *
 * Pass observation instants only. A forecast instant is expected to lead the
 * clock, and this predicate would refuse every healthy one.
 *
 * @param observedTimeMs The instant something was observed at, in ms since the Unix epoch.
 * @param nowMs The instant being decided at, in ms since the Unix epoch.
 * @returns Whether the observation instant is credible against that clock.
 */
export function spaceWeatherObservationIsPlausible(
  observedTimeMs: number,
  nowMs: number,
): boolean {
  return (
    observedTimeMs <= nowMs + SPACE_WEATHER_CLOCK_SKEW_TOLERANCE_SECONDS * 1000
  );
}

/**
 * Who owns the oval.
 *
 * `"none"` is a real state and not an error: it is what a caller sees before the
 * first snapshot resolves and after every source has been refused, and it is the
 * state in which nothing auroral is drawn.
 */
export type SpaceWeatherOvalOwnerValue = "ovation" | "kp" | "none";

/** Enumerated {@link SpaceWeatherOvalOwnerValue} constants. */
export const SpaceWeatherOvalOwner = Object.freeze({
  OVATION: "ovation",
  KP: "kp",
  NONE: "none",
});

/**
 * Why {@link resolveOvalOwnership} returned the owner it did.
 *
 * `"ovation-ahead-of-clock"` is separated from `"ovation-stale"` because the two
 * look identical from the oval — nothing model-owned is drawn under either — and
 * are diagnosed completely differently. One says the feed has stopped arriving;
 * the other says it is arriving and one of the two clocks involved is wrong.
 */
export type SpaceWeatherOwnershipReasonValue =
  | "ovation-current"
  | "ovation-stale"
  | "ovation-ahead-of-clock"
  | "ovation-absent"
  | "no-source";

/** Enumerated {@link SpaceWeatherOwnershipReasonValue} constants. */
export const SpaceWeatherOwnershipReason = Object.freeze({
  OVATION_CURRENT: "ovation-current",
  OVATION_STALE: "ovation-stale",
  OVATION_AHEAD_OF_CLOCK: "ovation-ahead-of-clock",
  OVATION_ABSENT: "ovation-absent",
  NO_SOURCE: "no-source",
});

/**
 * What a caller knows about the model snapshot it is holding, if any.
 *
 * These are the two instants the payload declares, not instants a consumer
 * chose. A snapshot that failed validation is not described here at all — the
 * caller passes `undefined`, which is the same state as never having fetched
 * one, because a refused payload must leave no trace on the ownership decision.
 */
export interface OvationSnapshotState {
  /** Observation instant the snapshot declares, in ms since the Unix epoch. */
  observedTimeMs: number;
  /** Forecast instant the snapshot declares, in ms since the Unix epoch. */
  forecastTimeMs: number;
}

/** The inputs {@link resolveOvalOwnership} decides from. */
export interface OvalOwnershipQuery {
  /** The owner in force before this evaluation. */
  previousOwner: SpaceWeatherOvalOwnerValue;
  /** The held model snapshot, or `undefined` when there is none to hold. */
  ovation?: OvationSnapshotState;
  /** Whether a usable planetary-index reading is available as a fallback. */
  kpAvailable: boolean;
  /** The instant to decide at, in ms since the Unix epoch. */
  nowMs: number;
}

/** The decision, and everything a caller needs to report it. */
export interface OvalOwnership {
  /** Who owns oval position and intensity from now on. */
  owner: SpaceWeatherOvalOwnerValue;
  /** Which rule produced `owner`. */
  reason: SpaceWeatherOwnershipReasonValue;
  /** The owner this decision replaces. */
  previousOwner: SpaceWeatherOvalOwnerValue;
  /** Whether this evaluation moved the owner; the caller's event condition. */
  changed: boolean;
  /**
   * Where the held model snapshot sits against its own declared horizon, or
   * `undefined` when no snapshot is held.
   */
  ovationFreshness?: SpaceWeatherFreshnessValue;
  /**
   * Whether the planetary index stays readable as a diagnostic. It does whenever
   * one is available, including while the model owns the oval: an index the
   * consumer can display is not an index that drives anything.
   */
  kpVisible: boolean;
}

/**
 * How long a model snapshot stays current, from the horizon it declares itself.
 *
 * The lead is read from the snapshot's two instants on every evaluation and is
 * never inferred from the product's name. It is measurably variable: leads of 94
 * and 62 minutes were recorded from the same product six weeks apart, so any
 * constant standing in for it is wrong on most snapshots.
 *
 * Both ends are bounded, for opposite reasons: a snapshot that declares no lead
 * would otherwise expire on arrival, and one that declares an impossible lead
 * would otherwise never expire at all.
 *
 * @param snapshot The held snapshot.
 * @returns The horizon in seconds, between {@link OVATION_VALIDITY_FLOOR_SECONDS} and {@link OVATION_VALIDITY_CEILING_SECONDS}.
 */
export function ovationValiditySeconds(snapshot: OvationSnapshotState): number {
  const leadSeconds =
    (snapshot.forecastTimeMs - snapshot.observedTimeMs) / 1000;
  if (!Number.isFinite(leadSeconds) || leadSeconds < 0) {
    return OVATION_VALIDITY_FLOOR_SECONDS;
  }
  return Math.min(
    Math.max(leadSeconds, OVATION_VALIDITY_FLOOR_SECONDS),
    OVATION_VALIDITY_CEILING_SECONDS,
  );
}

/**
 * Forecast lead a packet declares, in seconds.
 *
 * The canonical read of the measured lead: the difference between the two
 * instants the producer stamped, and nothing else. A consumer needing the lead
 * calls this rather than reaching for a number named after a product.
 *
 * @param packet The packet.
 * @returns The lead in seconds; zero for a packet that forecasts its own observation instant.
 */
export function spaceWeatherForecastLeadSeconds(
  packet: SpaceWeatherPacket,
): number {
  return (packet.forecastTimeMs - packet.observedTimeMs) / 1000;
}

/**
 * Where a held snapshot sits against its own horizon.
 *
 * Fresh inside the horizon, stale past twice it, aging in between — the same
 * three bands the packet's own freshness helper reports, applied to the horizon
 * the snapshot declares rather than to one a consumer picked.
 *
 * A snapshot observed further ahead of the instant than
 * {@link spaceWeatherObservationIsPlausible} allows is reported stale, and the
 * reason is arithmetic rather than policy: its age is negative, so it would
 * otherwise sit inside every horizon for ever and be drawn as current for as
 * long as it was held. Stale is the band that means "do not own the oval", which
 * is the correct answer for an instant that cannot have happened;
 * {@link resolveOvalOwnership} is where the two are told apart by name.
 *
 * @param snapshot The held snapshot.
 * @param nowMs The instant to measure against, in ms since the Unix epoch.
 * @returns The freshness band.
 */
export function ovationFreshness(
  snapshot: OvationSnapshotState,
  nowMs: number,
): SpaceWeatherFreshnessValue {
  if (!spaceWeatherObservationIsPlausible(snapshot.observedTimeMs, nowMs)) {
    return SpaceWeatherFreshness.STALE;
  }
  const validitySeconds = ovationValiditySeconds(snapshot);
  const ageSeconds = (nowMs - snapshot.observedTimeMs) / 1000;
  if (ageSeconds <= validitySeconds) {
    return SpaceWeatherFreshness.FRESH;
  }
  if (ageSeconds > validitySeconds * 2) {
    return SpaceWeatherFreshness.STALE;
  }
  return SpaceWeatherFreshness.AGING;
}

/**
 * Decide who owns the oval, and report the transition.
 *
 * Pure: the same query always yields the same decision, so a handoff in either
 * direction is reproducible from its inputs rather than from the order calls
 * happened to arrive in.
 *
 * @param query The held state and the instant to decide at.
 * @returns The owner, the rule behind it, and whether this call moved it.
 */
export function resolveOvalOwnership(query: OvalOwnershipQuery): OvalOwnership {
  const previousOwner = query.previousOwner;
  const kpVisible = query.kpAvailable;
  let owner: SpaceWeatherOvalOwnerValue;
  let reason: SpaceWeatherOwnershipReasonValue;
  let freshness: SpaceWeatherFreshnessValue | undefined;

  if (query.ovation === undefined) {
    reason = SpaceWeatherOwnershipReason.OVATION_ABSENT;
    owner = kpVisible ? SpaceWeatherOvalOwner.KP : SpaceWeatherOvalOwner.NONE;
    if (!kpVisible) {
      reason = SpaceWeatherOwnershipReason.NO_SOURCE;
    }
  } else {
    freshness = ovationFreshness(query.ovation, query.nowMs);
    if (freshness === SpaceWeatherFreshness.STALE) {
      reason = spaceWeatherObservationIsPlausible(
        query.ovation.observedTimeMs,
        query.nowMs,
      )
        ? SpaceWeatherOwnershipReason.OVATION_STALE
        : SpaceWeatherOwnershipReason.OVATION_AHEAD_OF_CLOCK;
      owner = kpVisible ? SpaceWeatherOvalOwner.KP : SpaceWeatherOvalOwner.NONE;
    } else {
      // Aging counts as current. The band exists so a consumer can warn, not so
      // it can hand a still-valid measurement to a model that infers the same
      // quantity from an index.
      reason = SpaceWeatherOwnershipReason.OVATION_CURRENT;
      owner = SpaceWeatherOvalOwner.OVATION;
    }
  }

  return {
    owner: owner,
    reason: reason,
    previousOwner: previousOwner,
    changed: owner !== previousOwner,
    ovationFreshness: freshness,
    kpVisible: kpVisible,
  };
}

/**
 * The factor an oval grid's samples are multiplied by before rendering.
 *
 * Exactly `1` for a model-owned grid, and the activity scalar for every other
 * owner. The model consumed the solar-wind and planetary-index inputs the scalar
 * summarizes before it produced the grid, so scaling by the scalar afterwards
 * applies the same physics a second time; returning a literal one is what makes
 * that impossible rather than merely discouraged.
 *
 * This is the ingest-side statement of the rule the packet states for a built
 * packet, and the two agree by construction: an oval whose authority marker is
 * the model resolves to one on both paths.
 *
 * @param owner Who owns the oval.
 * @param activity Normalized geomagnetic activity in `[0,1]`.
 * @returns `1` for a model-owned oval, otherwise `activity`.
 */
export function ovalForcingMultiplier(
  owner: SpaceWeatherOvalOwnerValue,
  activity: number,
): number {
  if (owner === SpaceWeatherOvalOwner.OVATION) {
    return 1;
  }
  return activity;
}

/**
 * The authority marker a grid produced under this ownership must carry.
 *
 * Pairing the two here keeps the decision and the marker from drifting: a
 * producer stamps what the resolver decided rather than a constant it chose.
 *
 * @param owner Who owns the oval.
 * @returns The marker, or `undefined` when no oval is produced.
 */
export function ovalAuthorityFor(
  owner: SpaceWeatherOvalOwnerValue,
): SpaceWeatherAuthorityValue | undefined {
  switch (owner) {
    case SpaceWeatherOvalOwner.OVATION:
      return SpaceWeatherAuthority.OVATION;
    case SpaceWeatherOvalOwner.KP:
      return SpaceWeatherAuthority.SYNTHETIC;
    default:
      return undefined;
  }
}
