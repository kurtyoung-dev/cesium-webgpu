/**
 * Asynchronous ingest of the auroral-precipitation and planetary-index products
 * into {@link SpaceWeatherPacket}s.
 *
 * Everything expensive happens between frames. A request is issued from a timer,
 * the response is decoded and normalized in the promise that completes it, and
 * the packet that results is stored whole. The render-side read,
 * {@link SpaceWeatherFeedIngest#latest}, returns that stored packet and does
 * nothing else — it opens no request, awaits nothing, parses nothing, and
 * allocates nothing, so calling it from a command path costs a property read.
 *
 * Disabled is the default and it is free. Constructing the ingest issues no
 * request and arms no timer; both begin at {@link SpaceWeatherFeedIngest#start}
 * and stop again at {@link SpaceWeatherFeedIngest#stop}.
 *
 * **Supersession is enforced, not hoped for.** Every request cycle carries a
 * generation number and its own abort signal. A response whose generation is no
 * longer current is discarded before it is decoded, so a slow response that
 * lands after a newer one cannot walk the state backwards — the ordering
 * guarantee holds against out-of-order completion, which aborting alone does not
 * provide, because an abort signalled to a transport does not unresolve a
 * promise that has already been settled. Stopping ends the current generation
 * for the same reason: the generation is what abandons a cycle, not the abort.
 *
 * **Cycle order is not content order.** The products are cached, so a later
 * request may be answered with an earlier snapshot. A payload observed before
 * the one already held is refused rather than applied — while the instant being
 * defended is one an observation could have produced. Any refusal that compares
 * a payload against held state is bounded that way, because a rule that is not
 * turns one wrong timestamp into a permanent refusal of everything true.
 *
 * **Both instants are checked against the clock, in the way each one earns.** An
 * observation instant names a moment that has already happened, so one that
 * leads the clock past the skew two clocks are allowed is refused, and one
 * already held stops being counted as current. A forecast instant leads the
 * clock by design and is never refused for it — but the interval between the
 * two is what decides how long the observation goes on being believed, so it is
 * bounded rather than taken on the payload's word. Nothing here is ever wedged
 * by state that only `destroy` can clear: every refusal names what lifts it.
 *
 * **The owner is re-decided by the clock, not only by a response.** A snapshot
 * goes stale where it sits, so each poll tick resolves ownership at the instant
 * it fires and hands off if the instant says to, whether or not a cycle
 * completes. A cycle that never completes would otherwise hold the last
 * decision in place for the life of the object, and the two published reads
 * would go on reporting a snapshot as current for as long as it was held.
 *
 * **A refused payload changes nothing.** Validation runs before any state is
 * written, and a refusal leaves the last good packet in place and reports the
 * typed reason. There is no partially-applied update: the alternative is a
 * renderer drawing half of one snapshot over half of another. What is published
 * is checked against the packet schema as well as against the wire format, and a
 * source that cannot produce a valid packet is the absent source it is.
 *
 * The transport is injected. The ingest never references a global fetch, timer
 * or clock, so a spec drives an entire storm, staleness handoff and reissue
 * sequence deterministically with no network and no elapsed time.
 *
 * @module Scene/SpaceWeather/SpaceWeatherFeedIngest
 */
import DeveloperError from "../../Core/DeveloperError.js";
import {
  SPACE_WEATHER_PACKET_VERSION,
  SpaceWeatherAuthority,
  SpaceWeatherSourceKind,
  type SpaceWeatherPacket,
} from "./SpaceWeatherTypes.js";
import {
  freezeSpaceWeatherPacket,
  validateSpaceWeatherPacket,
} from "./SpaceWeatherPacket.js";
import {
  OVATION_VALIDITY_CEILING_SECONDS,
  PLANETARY_KP_CADENCE_SECONDS,
  SPACE_WEATHER_CLOCK_SKEW_TOLERANCE_SECONDS,
  SpaceWeatherOvalOwner,
  ovationValiditySeconds,
  resolveOvalOwnership,
  spaceWeatherObservationIsPlausible,
  type OvalOwnership,
  type SpaceWeatherOvalOwnerValue,
} from "./SpaceWeatherSourceAuthority.js";
import {
  normalizeOvationPayload,
  type OvationPolePolicyValue,
  type OvationSnapshot,
} from "./OvationGridNormalizer.js";
import {
  PlanetaryKpProduct,
  isPlanetaryKpCurrent,
  normalizePlanetaryKpPayload,
  planetaryKpActivity,
  planetaryKpReadingAt,
  type PlanetaryKpReading,
  type PlanetaryKpSeries,
} from "./PlanetaryKpNormalizer.js";

/** The auroral-precipitation snapshot published by the space-weather service. */
export const OVATION_PRODUCT_URL =
  "https://services.swpc.noaa.gov/json/ovation_aurora_latest.json";

/** The observed planetary-index product. */
export const PLANETARY_KP_PRODUCT_URL =
  "https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json";

/**
 * Attribution carried into every packet this ingest builds.
 *
 * The service's output is a United States Government work, but the auroral model
 * behind it is not the service's: it is an empirical model developed at the
 * Johns Hopkins University Applied Physics Laboratory. A normalized grid is also
 * modified content, which the publisher's terms forbid presenting as official
 * material, so the credit names the transformation as well as the source.
 */
export const SPACE_WEATHER_ATTRIBUTION =
  "NOAA Space Weather Prediction Center; auroral precipitation from the OVATION Prime model (Johns Hopkins University Applied Physics Laboratory). Regridded by CesiumJS; not official government material.";

/**
 * Polling interval, in seconds.
 *
 * The products are served with a one-minute cache lifetime, so a shorter
 * interval re-downloads bytes that cannot have changed. This is the cache
 * lifetime, not a guess at how often the model runs.
 */
export const SPACE_WEATHER_POLL_INTERVAL_SECONDS = 60;

/**
 * How a payload is fetched and decoded.
 *
 * The signal is not advisory. A superseded or stopped cycle is abandoned by
 * aborting it, and a transport that ignores the signal leaves its request
 * outstanding for as long as the peer takes to answer, which is unbounded
 * against a wedged one. `fetch` honours it.
 *
 * A synchronous throw is accepted as a rejection, so a transport that raises its
 * own argument check before returning a promise is refused like any other
 * failed request rather than escaping into the caller.
 */
export type SpaceWeatherFetchJson = (
  url: string,
  signal: AbortSignal,
) => Promise<unknown>;

/** Construction options. */
export interface SpaceWeatherFeedIngestOptions {
  /** Fetches and decodes one JSON document. Required; there is no global fallback. */
  fetchJson: SpaceWeatherFetchJson;
  /** Auroral-precipitation product. Defaults to {@link OVATION_PRODUCT_URL}. */
  ovationUrl?: string;
  /** Observed planetary-index product. Defaults to {@link PLANETARY_KP_PRODUCT_URL}. */
  planetaryKpUrl?: string;
  /** How the pole duplicates are reduced. Defaults to the normalizer's own default. */
  polePolicy?: OvationPolePolicyValue;
  /** Seconds between polls. Defaults to {@link SPACE_WEATHER_POLL_INTERVAL_SECONDS}. */
  pollIntervalSeconds?: number;
  /** Arms the poll timer. Defaults to `setTimeout`, and is injected by specs. */
  setTimeoutFunction?: (handler: () => void, timeoutMs: number) => number;
  /** Disarms it. Defaults to `clearTimeout`. */
  clearTimeoutFunction?: (handle: number) => void;
  /**
   * Reads the instant a poll tick happens at. Defaults to `Date.now`, and is
   * injected by specs so a timeline stays deterministic.
   */
  nowFunction?: () => number;
  /** Source id stamped into an auroral-model packet. Defaults to `"ovation"`. */
  ovationSourceId?: string;
  /** Source id stamped into a planetary-index packet. Defaults to `"noaa-planetary-kp"`. */
  planetaryKpSourceId?: string;
}

/**
 * Codes the ingest raises itself, alongside the ones its normalizers return.
 *
 * `transport` is a request that failed. The rest are payloads a normalizer
 * accepted and the ingest refused, for the three reasons only it can see: what
 * it already holds, what the clock says of the instant the payload declares, and
 * the schema the packet it would build must satisfy.
 */
export const SpaceWeatherIngestCode = Object.freeze({
  TRANSPORT: "transport",
  TIME_REGRESSION: "time-regression",
  IMPLAUSIBLE_TIME: "implausible-time",
  INVALID_PACKET: "invalid-packet",
});

/** Why the most recent cycle refused a payload. */
export interface SpaceWeatherIngestFailure {
  /** Which product. */
  product: "ovation" | "kp";
  /** A normalizer's code, or one of {@link SpaceWeatherIngestCode}. */
  code: string;
  /** Diagnostic text. */
  message: string;
  /** When it was recorded, in ms since the Unix epoch, as the caller supplied it. */
  atMs: number;
}

/** What the ingest reports about itself. */
export interface SpaceWeatherIngestDiagnostics {
  /** Whether a poll timer is armed. */
  running: boolean;
  /** Who currently owns the oval. */
  ovalOwner: SpaceWeatherOvalOwnerValue;
  /** Request cycles begun. */
  requestsIssued: number;
  /** Payloads handed to a normalizer. */
  payloadsParsed: number;
  /** Sample grids allocated. */
  gridsAllocated: number;
  /** Packets built. */
  packetsBuilt: number;
  /** Results dropped because a newer cycle had already begun. */
  supersededResultsDiscarded: number;
  /** Payloads refused by a normalizer or a transport error. */
  payloadsRefused: number;
  /** Ownership handoffs, in either direction. */
  ownershipTransitions: number;
  /** The most recent refusal, if there has been one. */
  lastFailure?: SpaceWeatherIngestFailure;
  /** Forecast lead of the held auroral snapshot in seconds, as measured from it. */
  ovationLeadSeconds?: number;
  /**
   * How long that snapshot is credited for, in seconds. It is the measured lead
   * unless the lead falls outside the contract's bounds, and the two disagreeing
   * is how a mislabelled forecast instant becomes visible.
   */
  ovationHorizonSeconds?: number;
}

const MILLISECONDS_PER_SECOND = 1000;

/** Throttle on the refusal log, so a persistently broken feed logs once a minute. */
const FAILURE_LOG_INTERVAL_MS = 60000;

/**
 * Describe a rejection reason without trusting it to describe itself.
 *
 * `String(value)` runs the value's own `toString`, and a reason that has none —
 * or one that throws — raises from inside the cycle that was catching it, which
 * is the failure the transport fence exists to prevent. A rejection is not
 * required to be an `Error`, or to be describable at all.
 *
 * @param reason The rejection reason.
 * @returns Diagnostic text, always.
 */
function describeReason(reason: unknown): string {
  if (reason instanceof Error) {
    return `${reason.name}: ${reason.message}`;
  }
  try {
    return String(reason);
  } catch {
    return `a ${typeof reason} that cannot be described`;
  }
}

/**
 * Drives the two products and publishes the packet a renderer reads.
 *
 * @alias SpaceWeatherFeedIngest
 */
export class SpaceWeatherFeedIngest {
  private readonly _fetchJson: SpaceWeatherFetchJson;
  private readonly _ovationUrl: string;
  private readonly _planetaryKpUrl: string;
  private readonly _polePolicy: OvationPolePolicyValue | undefined;
  private readonly _pollIntervalMs: number;
  private readonly _setTimeout: (
    handler: () => void,
    timeoutMs: number,
  ) => number;
  private readonly _clearTimeout: (handle: number) => void;
  private readonly _now: () => number;
  private readonly _ovationSourceId: string;
  private readonly _planetaryKpSourceId: string;

  private _destroyed = false;
  private _stopped = true;
  private _timerHandle: number | undefined;
  private _generation = 0;
  private _controller: AbortController | undefined;

  private _ovation: OvationSnapshot | undefined;
  private _kpSeries: PlanetaryKpSeries | undefined;
  private _owner: SpaceWeatherOvalOwnerValue = SpaceWeatherOvalOwner.NONE;
  private _ownership: OvalOwnership | undefined;
  private _packet: SpaceWeatherPacket | undefined;

  private _requestsIssued = 0;
  private _payloadsParsed = 0;
  private _gridsAllocated = 0;
  private _packetsBuilt = 0;
  private _supersededResultsDiscarded = 0;
  private _payloadsRefused = 0;
  private _ownershipTransitions = 0;
  private _lastFailure: SpaceWeatherIngestFailure | undefined;
  private _lastFailureLogMs = Number.NEGATIVE_INFINITY;
  private _lastHorizonLogMs = Number.NEGATIVE_INFINITY;

  /**
   * @param options Transport, product URLs and injected timers.
   */
  constructor(options: SpaceWeatherFeedIngestOptions) {
    //>>includeStart('debug', pragmas.debug);
    if (typeof options?.fetchJson !== "function") {
      throw new DeveloperError("options.fetchJson is required");
    }
    //>>includeEnd('debug');
    this._fetchJson = options.fetchJson;
    this._ovationUrl = options.ovationUrl ?? OVATION_PRODUCT_URL;
    this._planetaryKpUrl = options.planetaryKpUrl ?? PLANETARY_KP_PRODUCT_URL;
    this._polePolicy = options.polePolicy;
    this._pollIntervalMs =
      (options.pollIntervalSeconds ?? SPACE_WEATHER_POLL_INTERVAL_SECONDS) *
      MILLISECONDS_PER_SECOND;
    this._setTimeout =
      options.setTimeoutFunction ??
      ((handler, timeoutMs) =>
        setTimeout(handler, timeoutMs) as unknown as number);
    this._clearTimeout =
      options.clearTimeoutFunction ??
      ((handle) =>
        clearTimeout(handle as unknown as ReturnType<typeof setTimeout>));
    this._now = options.nowFunction ?? (() => Date.now());
    this._ovationSourceId = options.ovationSourceId ?? "ovation";
    this._planetaryKpSourceId =
      options.planetaryKpSourceId ?? "noaa-planetary-kp";
  }

  /** Whether a poll timer is armed. */
  get isRunning(): boolean {
    return this._timerHandle !== undefined;
  }

  /** Whether {@link SpaceWeatherFeedIngest#destroy} has been called. */
  get isDestroyed(): boolean {
    return this._destroyed;
  }

  /**
   * The most recently published packet, or `undefined` before the first one.
   *
   * This is the render-side read: one property access, no allocation, no I/O. It
   * is safe to call once per frame or once per command.
   *
   * @returns The packet.
   */
  latest(): SpaceWeatherPacket | undefined {
    return this._packet;
  }

  /**
   * The ownership decision the last completed cycle reached, or `undefined`
   * before the first one.
   *
   * It is published beside the packet because the two can disagree. When no
   * source owns the oval the last good packet deliberately stays in place, so a
   * packet carrying an auroral-model oval outlives the authority that produced
   * it. A consumer learns that from here rather than by re-deriving freshness
   * against an instant it does not have.
   *
   * Like {@link SpaceWeatherFeedIngest#latest} this is a property read.
   *
   * @returns The decision.
   */
  latestOwnership(): OvalOwnership | undefined {
    return this._ownership;
  }

  /** What the ingest reports about itself. */
  get diagnostics(): SpaceWeatherIngestDiagnostics {
    return {
      running: this.isRunning,
      ovalOwner: this._owner,
      requestsIssued: this._requestsIssued,
      payloadsParsed: this._payloadsParsed,
      gridsAllocated: this._gridsAllocated,
      packetsBuilt: this._packetsBuilt,
      supersededResultsDiscarded: this._supersededResultsDiscarded,
      payloadsRefused: this._payloadsRefused,
      ownershipTransitions: this._ownershipTransitions,
      lastFailure: this._lastFailure,
      ovationLeadSeconds: this._ovation?.leadSeconds,
      ovationHorizonSeconds:
        this._ovation === undefined
          ? undefined
          : ovationValiditySeconds(this._ovation),
    };
  }

  /**
   * Begin polling, starting with an immediate cycle.
   *
   * @param nowMs The instant, in ms since the Unix epoch.
   * @returns The first cycle, so a caller that wants to await it can.
   */
  start(nowMs: number): Promise<void> {
    if (this._destroyed) {
      return Promise.resolve();
    }
    this._stopped = false;
    const first = this.refreshOnce(nowMs);
    this._arm();
    return first;
  }

  /**
   * Stop polling and abandon any request in flight.
   *
   * The last good packet is kept: stopping is a decision to stop updating, not a
   * decision to stop being able to draw.
   */
  stop(): void {
    // Stopping is a state and not an event. A stop that lands between a tick
    // starting and that tick re-arming -- from a host delivering a callback
    // whose handle was already cleared, or from the transport the tick has just
    // called, which it calls synchronously -- has no handle left to clear, so
    // only a state can refuse the re-arm that follows it.
    this._stopped = true;
    // The cycle in flight belongs to a generation this call ends. Aborting the
    // controller cannot unsettle a promise the transport has already resolved,
    // so the generation is what abandons the cycle; and without it an abort
    // rejection arrives as a transport failure, which would make a deliberate
    // stop report a refused payload and log a production error.
    ++this._generation;
    if (this._timerHandle !== undefined) {
      this._clearTimeout(this._timerHandle);
      this._timerHandle = undefined;
    }
    this._abortInFlight();
  }

  /**
   * Stop, release the held state, and refuse to start again.
   *
   * No timer survives this call and no in-flight response can reach the state
   * afterwards, because the generation every pending cycle was issued under is
   * no longer current.
   */
  destroy(): void {
    this.stop();
    this._destroyed = true;
    this._ovation = undefined;
    this._kpSeries = undefined;
    this._packet = undefined;
    // The decision is held state too. Left behind it reports a model authority
    // owning an oval that no longer exists, which is the inverse of the
    // disagreement latestOwnership exists to report.
    this._owner = SpaceWeatherOvalOwner.NONE;
    this._ownership = undefined;
  }

  /**
   * Run one request cycle: fetch both products, normalize what arrives, resolve
   * ownership and publish a packet.
   *
   * Issuing a cycle supersedes any cycle still in flight, whose result is then
   * discarded whenever it arrives.
   *
   * @param nowMs The instant, in ms since the Unix epoch.
   * @returns A promise that settles when this cycle has been applied or discarded.
   */
  async refreshOnce(nowMs: number): Promise<void> {
    if (this._destroyed) {
      return;
    }
    this._abortInFlight();
    const generation = ++this._generation;
    const controller = new AbortController();
    this._controller = controller;
    ++this._requestsIssued;

    const settled = await Promise.allSettled([
      this._invoke(this._ovationUrl, controller.signal),
      this._invoke(this._planetaryKpUrl, controller.signal),
    ]);

    // A response from a superseded cycle is dropped before it is decoded, so an
    // out-of-order completion cannot overwrite a newer result.
    if (this._destroyed || generation !== this._generation) {
      ++this._supersededResultsDiscarded;
      return;
    }

    this._applyOvation(settled[0], nowMs);
    this._applyPlanetaryKp(settled[1], nowMs);
    this._publish(nowMs);
  }

  /**
   * Call the transport so a synchronous throw arrives as a rejection.
   *
   * `Promise.allSettled` converts a rejected promise, not a throw raised before
   * it is entered, and a transport is allowed to raise its own argument check
   * that way. Without this the throw leaves the cycle uncaught, and the poll
   * tick — which discards the promise it starts — turns it into an unhandled
   * rejection no caller can reach.
   */
  private _invoke(url: string, signal: AbortSignal): Promise<unknown> {
    try {
      return Promise.resolve(this._fetchJson(url, signal));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  private _arm(): void {
    if (this._destroyed || this._stopped) {
      return;
    }
    // Arming over a live handle loses it, and the orphan re-arms itself through
    // this same method, so nothing can reach it again and a stopped ingest goes
    // on polling. Starting twice is the ordinary way to get here.
    if (this._timerHandle !== undefined) {
      this._clearTimeout(this._timerHandle);
      this._timerHandle = undefined;
    }
    this._timerHandle = this._setTimeout(() => {
      this._timerHandle = undefined;
      // A callback delivered after the handle it belongs to was cleared is the
      // same event as a stop landing inside the cycle: there is nothing left to
      // clear, so the state is what decides whether this tick happens.
      if (this._destroyed || this._stopped) {
        return;
      }
      // The tick reads the instant it actually happened at. Deriving it by
      // adding the interval to the previous one assumes every timer fired on
      // schedule, and a throttled or suspended host then leaves this clock
      // permanently behind wall time -- which is the clock staleness is
      // measured against, so the handoff would stop firing exactly when it is
      // needed.
      const tickMs = this._now();
      // The instant moved even if nothing arrives, and the owner is a question
      // about the instant -- so it is answered here, before a request whose
      // answer may never come.
      this._refreshOwnership(tickMs);
      void this.refreshOnce(tickMs);
      this._arm();
    }, this._pollIntervalMs);
  }

  private _abortInFlight(): void {
    if (this._controller !== undefined) {
      this._controller.abort();
      this._controller = undefined;
    }
  }

  private _applyOvation(
    settled: PromiseSettledResult<unknown>,
    nowMs: number,
  ): void {
    if (settled.status === "rejected") {
      this._recordFailure(
        "ovation",
        SpaceWeatherIngestCode.TRANSPORT,
        describeReason(settled.reason),
        nowMs,
      );
      return;
    }
    ++this._payloadsParsed;
    const result = normalizeOvationPayload(settled.value, {
      polePolicy: this._polePolicy,
    });
    if (result.status !== "ok") {
      this._recordFailure(
        "ovation",
        result.error.code,
        result.error.message,
        nowMs,
      );
      return;
    }
    ++this._gridsAllocated;
    if (
      !spaceWeatherObservationIsPlausible(result.snapshot.observedTimeMs, nowMs)
    ) {
      // An observation instant ahead of the clock is a wrong timestamp, and
      // accepting one is what would make every later real snapshot look older
      // than what is held. Refusing it at the door keeps the rule below about
      // cache ordering and nothing else.
      this._recordFailure(
        "ovation",
        SpaceWeatherIngestCode.IMPLAUSIBLE_TIME,
        `Observation Time ${new Date(result.snapshot.observedTimeMs).toISOString()} is ahead of ${new Date(nowMs).toISOString()} by more than the ${SPACE_WEATHER_CLOCK_SKEW_TOLERANCE_SECONDS} s clock-skew tolerance`,
        nowMs,
      );
      return;
    }
    if (
      this._ovation !== undefined &&
      result.snapshot.observedTimeMs < this._ovation.observedTimeMs &&
      // ...and only while what is being defended could itself be an
      // observation. A held instant ahead of this cycle's makes every real
      // payload "older" than it, so an unbounded rule would defend a bad
      // timestamp against the feed for as long as the object lived.
      spaceWeatherObservationIsPlausible(this._ovation.observedTimeMs, nowMs)
    ) {
      // The generation guard orders cycles, not content, and the products are
      // served with a one-minute cache lifetime -- so an edge answering a later
      // request with the previous snapshot is ordinary. This is the packet's own
      // rule for successive updates from one source (isStaleSpaceWeatherUpdate)
      // applied to the series of snapshots that produces them.
      this._recordFailure(
        "ovation",
        SpaceWeatherIngestCode.TIME_REGRESSION,
        `Observation Time ${new Date(result.snapshot.observedTimeMs).toISOString()} is older than the held snapshot's ${new Date(this._ovation.observedTimeMs).toISOString()}`,
        nowMs,
      );
      return;
    }
    if (result.snapshot.leadSeconds > OVATION_VALIDITY_CEILING_SECONDS) {
      this._reportBoundedHorizon(result.snapshot, nowMs);
    }
    this._ovation = result.snapshot;
  }

  private _applyPlanetaryKp(
    settled: PromiseSettledResult<unknown>,
    nowMs: number,
  ): void {
    if (settled.status === "rejected") {
      this._recordFailure(
        "kp",
        SpaceWeatherIngestCode.TRANSPORT,
        describeReason(settled.reason),
        nowMs,
      );
      return;
    }
    ++this._payloadsParsed;
    const result = normalizePlanetaryKpPayload(
      settled.value,
      PlanetaryKpProduct.OBSERVED,
    );
    if (result.status !== "ok") {
      this._recordFailure("kp", result.error.code, result.error.message, nowMs);
      return;
    }
    if (
      !spaceWeatherObservationIsPlausible(result.series.newest.timeTagMs, nowMs)
    ) {
      // A bin the product cannot have published yet would take the series'
      // newest instant into the future, and a reading is never taken from a bin
      // later than the instant asked for -- so accepting one would silently
      // retire the fallback authority as well as refusing every real series
      // after it.
      this._recordFailure(
        "kp",
        SpaceWeatherIngestCode.IMPLAUSIBLE_TIME,
        `newest bin ${new Date(result.series.newest.timeTagMs).toISOString()} is ahead of ${new Date(nowMs).toISOString()} by more than the ${SPACE_WEATHER_CLOCK_SKEW_TOLERANCE_SECONDS} s clock-skew tolerance`,
        nowMs,
      );
      return;
    }
    if (
      this._kpSeries !== undefined &&
      result.series.newest.timeTagMs < this._kpSeries.newest.timeTagMs &&
      // Same bound, same reason: a held bin that cannot yet exist must not be
      // allowed to refuse the ones that do.
      spaceWeatherObservationIsPlausible(this._kpSeries.newest.timeTagMs, nowMs)
    ) {
      // Same rule, same reason: replacing the held series with one that ends
      // earlier moves the reading a consumer sees backwards, and the index
      // product is cached exactly as the auroral one is.
      this._recordFailure(
        "kp",
        SpaceWeatherIngestCode.TIME_REGRESSION,
        `newest bin ${new Date(result.series.newest.timeTagMs).toISOString()} is older than the held series' ${new Date(this._kpSeries.newest.timeTagMs).toISOString()}`,
        nowMs,
      );
      return;
    }
    this._kpSeries = result.series;
  }

  private _currentKpReading(nowMs: number): PlanetaryKpReading | undefined {
    if (this._kpSeries === undefined) {
      return undefined;
    }
    const reading = planetaryKpReadingAt(this._kpSeries, nowMs);
    if (reading === undefined || !isPlanetaryKpCurrent(reading, nowMs)) {
      return undefined;
    }
    return reading;
  }

  /**
   * Re-resolve ownership and publish the packet it implies.
   *
   * Called from a completed request cycle, and from the poll tick when the
   * clock alone has moved the owner. Never from a render path.
   */
  private _publish(nowMs: number): void {
    let kpReading = this._currentKpReading(nowMs);
    let ownership = this._resolveOwnership(nowMs, kpReading);
    let candidate = this._buildPacket(ownership, kpReading);
    let packet =
      candidate === undefined
        ? undefined
        : this._accept(candidate, ownership, nowMs);
    if (candidate !== undefined && packet === undefined) {
      // A source whose packet fails the schema is a refused payload, and the
      // contract leaves a refused payload to the next authority down. Dropping
      // it and resolving once more is what makes that true here; the second
      // pass terminates because the source that failed is gone.
      this._dropSource(ownership.owner);
      kpReading = this._currentKpReading(nowMs);
      ownership = this._resolveOwnership(nowMs, kpReading);
      candidate = this._buildPacket(ownership, kpReading);
      packet =
        candidate === undefined
          ? undefined
          : this._accept(candidate, ownership, nowMs);
    }

    this._commitOwnership(ownership);

    if (packet !== undefined) {
      ++this._packetsBuilt;
      this._packet = packet;
    }
  }

  /**
   * Re-resolve ownership against the clock alone.
   *
   * A held snapshot expires where it sits, so the decision has to be able to
   * move without a response arriving. Only a handoff republishes: an unchanged
   * owner leaves the packet, and the object identity a consumer may be keying an
   * upload on, exactly where it was, while the decision beside it still reports
   * the freshness measured at this instant.
   */
  private _refreshOwnership(nowMs: number): void {
    const ownership = this._resolveOwnership(
      nowMs,
      this._currentKpReading(nowMs),
    );
    if (ownership.changed) {
      // A handoff changes which source the packet must come from, so it is
      // rebuilt through the one path that builds packets rather than left
      // describing the authority that has just lost the oval.
      this._publish(nowMs);
      return;
    }
    this._commitOwnership(ownership);
  }

  /**
   * Take a decision as the one in force, and count it if it moved the owner.
   *
   * Ownership is committed once per evaluation, so the transition a consumer
   * sees is the one that evaluation ended on rather than an intermediate it
   * passed through.
   */
  private _commitOwnership(ownership: OvalOwnership): void {
    if (ownership.changed) {
      ++this._ownershipTransitions;
      this._logTransition(ownership);
    }
    this._owner = ownership.owner;
    this._ownership = Object.freeze(ownership);
  }

  private _resolveOwnership(
    nowMs: number,
    kpReading: PlanetaryKpReading | undefined,
  ): OvalOwnership {
    return resolveOvalOwnership({
      previousOwner: this._owner,
      ovation: this._ovation,
      kpAvailable: kpReading !== undefined,
      nowMs: nowMs,
    });
  }

  /**
   * Return the packet if it satisfies the schema, and record a refusal if not.
   *
   * The normalizers check the wire format; the schema is a separate statement,
   * and a sample no `Float32Array` can hold satisfies the first and fails the
   * second. Publishing is the last place to catch that, and a grid of infinities
   * is worse than the half-parsed field this ingest exists to refuse.
   */
  private _accept(
    packet: SpaceWeatherPacket,
    ownership: OvalOwnership,
    nowMs: number,
  ): SpaceWeatherPacket | undefined {
    const validation = validateSpaceWeatherPacket(packet);
    if (validation.valid) {
      return packet;
    }
    this._recordFailure(
      ownership.owner === SpaceWeatherOvalOwner.OVATION ? "ovation" : "kp",
      SpaceWeatherIngestCode.INVALID_PACKET,
      validation.errors[0],
      nowMs,
    );
    return undefined;
  }

  private _dropSource(owner: SpaceWeatherOvalOwnerValue): void {
    if (owner === SpaceWeatherOvalOwner.OVATION) {
      this._ovation = undefined;
      return;
    }
    this._kpSeries = undefined;
  }

  private _buildPacket(
    ownership: OvalOwnership,
    kpReading: PlanetaryKpReading | undefined,
  ): SpaceWeatherPacket | undefined {
    const activity =
      kpReading === undefined ? 0 : planetaryKpActivity(kpReading.kpIndex);
    const geomagneticAuthority =
      kpReading === undefined
        ? SpaceWeatherAuthority.SYNTHETIC
        : SpaceWeatherAuthority.KP;

    if (
      ownership.owner === SpaceWeatherOvalOwner.OVATION &&
      this._ovation !== undefined
    ) {
      const snapshot = this._ovation;
      return freezeSpaceWeatherPacket({
        version: SPACE_WEATHER_PACKET_VERSION,
        provenance: {
          sourceId: this._ovationSourceId,
          kind: SpaceWeatherSourceKind.FORECAST,
          label: "OVATION Prime auroral precipitation",
          attribution: SPACE_WEATHER_ATTRIBUTION,
          validitySeconds: ovationValiditySeconds(snapshot),
        },
        observedTimeMs: snapshot.observedTimeMs,
        forecastTimeMs: snapshot.forecastTimeMs,
        geomagnetic: {
          // The scalar is a diagnostic here and nothing multiplies the grid by
          // it: the model already consumed the inputs it summarizes.
          activity: activity,
          authority: geomagneticAuthority,
          kpIndex: kpReading?.kpIndex,
        },
        oval: snapshot.field,
      });
    }

    if (
      ownership.owner === SpaceWeatherOvalOwner.KP &&
      kpReading !== undefined
    ) {
      return freezeSpaceWeatherPacket({
        version: SPACE_WEATHER_PACKET_VERSION,
        provenance: {
          sourceId: this._planetaryKpSourceId,
          kind: SpaceWeatherSourceKind.OBSERVED,
          label: "NOAA planetary K-index",
          attribution: SPACE_WEATHER_ATTRIBUTION,
          validitySeconds: PLANETARY_KP_CADENCE_SECONDS,
        },
        observedTimeMs: kpReading.timeTagMs,
        forecastTimeMs: kpReading.timeTagMs,
        geomagnetic: {
          activity: activity,
          authority: SpaceWeatherAuthority.KP,
          kpIndex: kpReading.kpIndex,
        },
      });
    }

    // No source owns the oval. The last good packet stays in place rather than
    // being replaced by an unlabelled empty state.
    return undefined;
  }

  /**
   * Report a declared forecast lead the contract will not honour in full.
   *
   * The payload is kept: a wrong forecast instant says nothing about the grid
   * beside it, and refusing the capture would discard a good observation over a
   * bad label. What is refused is the trust the label asks for, and that has to
   * be visible — the snapshot stops being current hours after its observation
   * instead of whenever the label said, and nothing else would say why.
   */
  private _reportBoundedHorizon(snapshot: OvationSnapshot, atMs: number): void {
    // The same window and the same backward-step term as the refusal log, for
    // the same reasons, on a stamp of its own so neither diagnostic can silence
    // the other.
    if (
      atMs - this._lastHorizonLogMs < FAILURE_LOG_INTERVAL_MS &&
      atMs >= this._lastHorizonLogMs
    ) {
      return;
    }
    this._lastHorizonLogMs = atMs;
    console.error(
      `[SpaceWeather] ovation declared a ${snapshot.leadSeconds} s forecast lead from ${new Date(snapshot.observedTimeMs).toISOString()}; crediting ${OVATION_VALIDITY_CEILING_SECONDS} s. The snapshot is kept and expires on the bounded horizon.`,
    );
  }

  private _logTransition(ownership: OvalOwnership): void {
    //>>includeStart('debug', pragmas.debug);
    console.log(
      `[SpaceWeather] oval ownership ${ownership.previousOwner} -> ${ownership.owner} (${ownership.reason})`,
    );
    //>>includeEnd('debug');
  }

  private _recordFailure(
    product: "ovation" | "kp",
    code: string,
    message: string,
    atMs: number,
  ): void {
    ++this._payloadsRefused;
    this._lastFailure = {
      product: product,
      code: code,
      message: message,
      atMs: atMs,
    };
    // A refused feed is a production diagnostic: the state a renderer shows is
    // now older than it looks, and nothing else reports that.
    if (
      atMs - this._lastFailureLogMs >= FAILURE_LOG_INTERVAL_MS ||
      // The stamp is an instant on the caller's clock, and a clock that steps
      // forward once -- a correction, a resumed host -- would otherwise put the
      // stamp beyond every later instant and silence the diagnostic until real
      // time caught up with the step.
      atMs < this._lastFailureLogMs
    ) {
      this._lastFailureLogMs = atMs;
      console.error(
        `[SpaceWeather] ${product} payload refused (${code}): ${message}. Keeping the last good state.`,
      );
    }
  }
}

export default SpaceWeatherFeedIngest;
