/**
 * Asynchronous ingest of the real-time solar wind and the geostationary X-ray
 * flux into {@link SpaceWeatherPacket}s, keeping the geomagnetic and the flare
 * channels apart.
 *
 * The two channels never meet:
 *
 *   - **Geomagnetic.** The solar-wind magnetometer and plasma products become
 *     solar-wind diagnostics and, through the published coupling relation, an
 *     estimated activity scalar. That scalar is the only thing the solar wind
 *     can move, and it moves it only when no product that measures or indexes
 *     the oval owns it. It never touches an oval grid.
 *   - **Flare.** The X-ray long band becomes a flare class and magnitude on the
 *     packet's separate flare channel. An X-ray flare arrives in minutes and any
 *     auroral consequence a day or more later, so nothing here lets the flare
 *     reach the oval or the activity scalar.
 *
 * **Ownership is read, not decided.** The auroral-model and planetary-index
 * ingest publishes who owns the oval; this ingest reads that decision and
 * composes around it. A model-owned grid is carried through untouched, by
 * identity, and never multiplied by anything. The decision is what gates the
 * oval, never the presence of an oval in a packet, because the other ingest
 * deliberately keeps a disowned packet in place. The decision's packet is also
 * checked against its own declared horizon before it is composed, because a
 * stopped ingest freezes its decision while the instant moves on.
 *
 * **Row order is normalized before any time conclusion.** The solar-wind
 * products arrive newest first and the X-ray product oldest first; both are
 * sorted by their normalizers before a newest instant exists. A payload whose
 * newest instant is older than the one held is refused, while the held instant
 * is itself one an observation could have produced; a payload whose newest
 * instant leads the clock past the folder's skew tolerance is refused at the
 * door.
 *
 * **History is kept locally.** The solar-wind products carry one day and the
 * longer products are gone, so a caller asking for more gets it by accumulation.
 *
 * **Each product is asked on its own.** The four products share a host but not
 * a fate: each answer is applied, judged at the instant it arrives and published
 * as soon as the answers arriving with it are applied; a product whose answer is
 * still outstanding is not asked again until it answers or runs past the
 * request timeout; and any answer resets the request backoff at once. A slow
 * product therefore delays only itself, never the channel another product
 * feeds.
 *
 * **The composition follows the clock, the requests follow the host.** The poll
 * tick re-composes the packet at the poll interval whatever the transport is
 * doing, so a decision the authority changes, or a reading that ages out, is
 * reflected within one interval; only the requests back off when the host
 * fails.
 *
 * Everything expensive happens between frames, off a timer and an injected
 * transport; {@link SolarWindFlareFeedIngest#latest} is a property read. Nothing
 * is requested, armed or built before {@link SolarWindFlareFeedIngest#start}.
 *
 * @module Scene/SpaceWeather/SolarWindFlareFeedIngest
 */
import DeveloperError from "../../Core/DeveloperError.js";
import {
  SpaceWeatherFreshness,
  type SolarFlareState,
  type SpaceWeatherAuthorityValue,
  type SpaceWeatherFreshnessValue,
  type SpaceWeatherPacket,
} from "./SpaceWeatherTypes.js";
import {
  SpaceWeatherOvalOwner,
  type SpaceWeatherOvalOwnerValue,
} from "./SpaceWeatherSourceAuthority.js";
import {
  SPACE_WEATHER_POLL_INTERVAL_SECONDS,
  type SpaceWeatherFetchJson,
} from "./SpaceWeatherFeedIngest.js";
import {
  REAL_TIME_SOLAR_WIND_CADENCE_SECONDS,
  RealTimeSolarWindProduct,
  type RealTimeSolarWindSeries,
} from "./RealTimeSolarWindNormalizer.js";
import {
  goesXrayPrimaryAt,
  type GoesInstrumentSources,
  type GoesXraySeries,
} from "./GoesXrayNormalizer.js";
import {
  SOLAR_WIND_ESTIMATE_WINDOW_SECONDS,
  estimateSolarWindActivity,
  type SolarWindActivityEstimate,
} from "./SolarWindCouplingEstimate.js";
import {
  FAILURE_LOG_INTERVAL_MS,
  FlareOmission,
  GOES_INSTRUMENT_SOURCES_URL,
  GOES_XRAY_PRODUCT_URL,
  MILLISECONDS_PER_SECOND,
  RTSW_MAGNETOMETER_PRODUCT_URL,
  RTSW_PLASMA_PRODUCT_URL,
  SOLAR_WIND_FLARE_REQUEST_TIMEOUT_SECONDS,
  SOLAR_WIND_HISTORY_SECONDS,
  SolarWindFlareIngestCode,
  SolarWindFlareProduct,
  abandonablePromise,
  authorityPacketFreshness,
  composeValidatedSolarWindFlarePacket,
  currentSolarWindReading,
  describeReason,
  flareReadingAt,
  invokeTransport,
  isSolarWindHistoryWindow,
  readOvalAuthority,
  requestDelayMs,
  sameKey,
  solarFlareStateFrom,
  solarWindDiagnosticsFrom,
  solarWindFreshnessOf,
  transitionsBetween,
  valueFingerprint,
  type CompositionKey,
  type FlareOmissionValue,
  type SolarFlareStateResult,
  type SolarWindFlareEvent,
  type SolarWindFlareFailureSourceValue,
  type SolarWindFlareFeedIngestOptions,
  type SolarWindFlareIngestDiagnostics,
  type SolarWindFlareIngestFailure,
  type SolarWindFlareProductValue,
  type SpaceWeatherOvalAuthoritySource,
} from "./SolarWindFlareFeedIngestHelpers.js";
import {
  admitInstrumentSources,
  admitSolarWind,
  admitXray,
  type SolarWindFlareAdmission,
} from "./SolarWindFlareAdmission.js";

// The vocabulary is re-exported so a consumer has one import site for the ingest.
export {
  FlareOmission,
  GOES_INSTRUMENT_SOURCES_URL,
  GOES_XRAY_PRODUCT_URL,
  GOES_XRAY_VALIDITY_SECONDS,
  OVAL_AUTHORITY_FAILURE_SOURCE,
  RTSW_MAGNETOMETER_PRODUCT_URL,
  RTSW_PLASMA_PRODUCT_URL,
  SOLAR_WIND_FLARE_ATTRIBUTION,
  SOLAR_WIND_FLARE_MAX_BACKOFF_SECONDS,
  SOLAR_WIND_FLARE_REQUEST_TIMEOUT_SECONDS,
  SOLAR_WIND_HISTORY_SECONDS,
  SOLAR_WIND_VALIDITY_SECONDS,
  SolarWindFlareEventType,
  SolarWindFlareIngestCode,
  SolarWindFlareProduct,
} from "./SolarWindFlareFeedIngestHelpers.js";
export type {
  FlareOmissionValue,
  SolarWindFlareEvent,
  SolarWindFlareEventTypeValue,
  SolarWindFlareFailureSourceValue,
  SolarWindFlareFeedIngestOptions,
  SolarWindFlareIngestDiagnostics,
  SolarWindFlareIngestFailure,
  SolarWindFlareProductValue,
  SpaceWeatherOvalAuthoritySource,
} from "./SolarWindFlareFeedIngestHelpers.js";

/** An instant in the caller's frame, with what the ingest's clock read then. */
interface InstantMark {
  /** The instant, in ms since the Unix epoch. */
  atMs: number;
  /** The injected clock's reading when the instant was taken. */
  clockMs: number;
  /** The poll ticks run before it was taken. */
  ticks: number;
}

/** The one backoff decision the requests of a cycle share. */
interface RequestCycle {
  answered: boolean;
  failureCounted: boolean;
}

/** One product's outstanding request. */
interface ProductRequest {
  controller: AbortController;
  issued: InstantMark;
  cycle: RequestCycle;
  /** Settles the request's place in its cycle when it is abandoned. */
  abandon: () => void;
}

/** The order the products are asked and applied in within one cycle. */
const PRODUCT_ORDER: readonly SolarWindFlareProductValue[] = Object.freeze([
  SolarWindFlareProduct.GOES_INSTRUMENT_SOURCES,
  SolarWindFlareProduct.RTSW_MAGNETOMETER,
  SolarWindFlareProduct.RTSW_PLASMA,
  SolarWindFlareProduct.GOES_XRAY,
] as SolarWindFlareProductValue[]);

/**
 * Drives the solar-wind and X-ray products and publishes the packet a renderer
 * reads.
 *
 * @alias SolarWindFlareFeedIngest
 */
export class SolarWindFlareFeedIngest {
  private _fetchJson: SpaceWeatherFetchJson;
  private readonly _authority: SpaceWeatherOvalAuthoritySource | undefined;
  private readonly _urls: Readonly<Record<SolarWindFlareProductValue, string>>;
  private readonly _historySeconds: number;
  private readonly _pollIntervalMs: number;
  private readonly _setTimeout: (
    handler: () => void,
    timeoutMs: number,
  ) => number;
  private readonly _clearTimeout: (handle: number) => void;
  private readonly _now: () => number;
  private readonly _solarWindSourceId: string;

  private _destroyed = false;
  private _stopped = true;
  private _timerHandle: number | undefined;
  private _epoch = 0;
  private readonly _inFlight = new Map<
    SolarWindFlareProductValue,
    ProductRequest
  >();
  private _lastCycleMs: number | undefined;
  private _ticks = 0;
  private _lastTickMs = 0;
  private _consecutiveTransportFailures = 0;
  private readonly _newProvider = new Set<SolarWindFlareProductValue>();
  // Transports are numbered by replacement, and each held solar-wind series
  // and the named spacecraft carry the number of the one that delivered them.
  private _provider = 0;
  private _magnetometerProvider = 0;
  private _plasmaProvider = 0;
  private _publishQueued = false;
  private _queuedPublishMs = 0;
  private _queuedPublishEpoch = 0;

  private _magnetometer: RealTimeSolarWindSeries | undefined;
  private _plasma: RealTimeSolarWindSeries | undefined;
  private _xray: GoesXraySeries | undefined;
  private _sources: GoesInstrumentSources | undefined;

  private _packet: SpaceWeatherPacket | undefined;
  private _key: CompositionKey | undefined;
  private _owner: SpaceWeatherOvalOwnerValue = SpaceWeatherOvalOwner.NONE;
  private _activityAuthority: SpaceWeatherAuthorityValue | "none" = "none";
  private _authorityFreshness: SpaceWeatherFreshnessValue | undefined;
  private _solarWindFreshness: SpaceWeatherFreshnessValue | undefined;
  private _estimate: SolarWindActivityEstimate | undefined;
  private _flareFreshness: SpaceWeatherFreshnessValue | undefined;
  private _flareClass: string | undefined;
  private _flareOmission: FlareOmissionValue | undefined;
  private _primary: number | undefined;
  private _activeSource: string | undefined;
  private _activeSourceProvider: number | undefined;
  private readonly _listeners = new Set<(event: SolarWindFlareEvent) => void>();

  private _requestsIssued = 0;
  private _payloadsParsed = 0;
  private _packetsBuilt = 0;
  private _supersededResultsDiscarded = 0;
  private _payloadsRefused = 0;
  private _lastFailure: SolarWindFlareIngestFailure | undefined;
  private _lastFailureLogMs = Number.NEGATIVE_INFINITY;

  /**
   * @param options Transport, authority, product URLs and injected timers.
   */
  constructor(options: SolarWindFlareFeedIngestOptions) {
    //>>includeStart('debug', pragmas.debug);
    if (typeof options?.fetchJson !== "function") {
      throw new DeveloperError("options.fetchJson is required");
    }
    // A window shorter than the cadence holds one minute per product, so the
    // estimate starves, and one that cannot be measured keeps every minute.
    const history = options.historySeconds;
    if (history !== undefined && !isSolarWindHistoryWindow(history)) {
      throw new DeveloperError(
        `options.historySeconds must be a finite number of seconds, at least the ${REAL_TIME_SOLAR_WIND_CADENCE_SECONDS} s cadence`,
      );
    }
    //>>includeEnd('debug');
    this._fetchJson = options.fetchJson;
    this._authority = options.authority;
    this._urls = Object.freeze({
      "rtsw-magnetometer":
        options.magnetometerUrl ?? RTSW_MAGNETOMETER_PRODUCT_URL,
      "rtsw-plasma": options.plasmaUrl ?? RTSW_PLASMA_PRODUCT_URL,
      "goes-xray": options.xrayUrl ?? GOES_XRAY_PRODUCT_URL,
      "goes-instrument-sources":
        options.instrumentSourcesUrl ?? GOES_INSTRUMENT_SOURCES_URL,
    });
    this._historySeconds = options.historySeconds ?? SOLAR_WIND_HISTORY_SECONDS;
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
    this._solarWindSourceId = options.solarWindSourceId ?? "noaa-rtsw";
  }

  /** Whether a poll timer is armed. */
  get isRunning(): boolean {
    return this._timerHandle !== undefined;
  }

  /** Whether {@link SolarWindFlareFeedIngest#destroy} has been called. */
  get isDestroyed(): boolean {
    return this._destroyed;
  }

  /**
   * The most recently published packet, or `undefined` when no geomagnetic
   * source can back one. A property read, safe once per frame or per command.
   *
   * @returns The packet.
   */
  latest(): SpaceWeatherPacket | undefined {
    return this._packet;
  }

  /**
   * Listen for transitions. Listeners run inside a request cycle or a poll
   * tick, never inside {@link SolarWindFlareFeedIngest#latest}.
   *
   * @param listener Called once per transition.
   * @returns A function that removes the listener.
   */
  addEventListener(listener: (event: SolarWindFlareEvent) => void): () => void {
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  }

  /** What the ingest reports about itself. */
  get diagnostics(): SolarWindFlareIngestDiagnostics {
    return {
      running: this.isRunning,
      requestsIssued: this._requestsIssued,
      payloadsParsed: this._payloadsParsed,
      packetsBuilt: this._packetsBuilt,
      supersededResultsDiscarded: this._supersededResultsDiscarded,
      payloadsRefused: this._payloadsRefused,
      lastFailure: this._lastFailure,
      consecutiveTransportFailures: this._consecutiveTransportFailures,
      nextPollDelayMs: this._nextDelayMs(),
      ovalOwner: this._owner,
      activityAuthority: this._activityAuthority,
      authorityPacketFreshness: this._authorityFreshness,
      solarWindFreshness: this._solarWindFreshness,
      plasma: this._plasma,
      magnetometer: this._magnetometer,
      estimate: this._estimate,
      flareFreshness: this._flareFreshness,
      xray: this._xray,
      primarySatellite: this._primary,
      flareOmission: this._flareOmission,
    };
  }

  /**
   * Begin polling, starting with an immediate cycle.
   *
   * @param nowMs The instant, in ms since the Unix epoch.
   * @returns The first cycle.
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

  /** Stop polling and abandon every request in flight; the last packet is kept. */
  stop(): void {
    // A state, not an event: a stop raised from inside a tick, from the
    // transport the tick has just called or from a listener the tick's publish
    // told, has no handle left to clear, so the tick checks this before it asks
    // or re-arms.
    this._stopped = true;
    // Aborting cannot unsettle an answer the transport has already resolved,
    // so the requests are also taken out of the ones in flight and each answer
    // is discarded when it arrives, an abort rejection included, which would
    // otherwise report a deliberate stop as a refused payload. The epoch ends
    // the cycle they belonged to, so it neither asks nor publishes any more.
    ++this._epoch;
    this._disarm();
    this._abortInFlight();
  }

  /** Stop, release the held state and the decisions, and refuse to start again. */
  destroy(): void {
    this.stop();
    this._destroyed = true;
    this._magnetometer = undefined;
    this._plasma = undefined;
    this._xray = undefined;
    this._sources = undefined;
    this._newProvider.clear();
    this._packet = undefined;
    this._key = undefined;
    this._activeSource = undefined;
    this._activeSourceProvider = undefined;
    // The decisions are held state too; left behind they describe an owner, a
    // scalar and a flare that nothing is publishing any more.
    this._owner = SpaceWeatherOvalOwner.NONE;
    this._activityAuthority = "none";
    this._authorityFreshness = undefined;
    this._solarWindFreshness = undefined;
    this._estimate = undefined;
    this._flareFreshness = undefined;
    this._flareClass = undefined;
    this._flareOmission = undefined;
    this._primary = undefined;
    this._listeners.clear();
  }

  /**
   * Replace the transport the products are fetched through.
   *
   * The requests in flight belong to the old transport and are abandoned. What
   * the old provider delivered stays in place, and the packet with it, until the
   * new provider answers for each product, so a switch raises no transition of
   * its own; a product the new provider never answers ages out by its own
   * bands. The new provider's first answer for a product is admitted against
   * nothing held: a different provider's instants are not comparable with the
   * ones held, so the old newest instant neither refuses it as a regression nor
   * merges into its history. A spacecraft the new provider names is never
   * compared with one the old provider named, so the switch is not a handoff.
   * The backoff is the old provider's too and is reset.
   *
   * @param fetchJson The new transport.
   */
  replaceTransport(fetchJson: SpaceWeatherFetchJson): void {
    if (this._destroyed) {
      return;
    }
    ++this._epoch;
    this._abortInFlight();
    this._fetchJson = fetchJson;
    ++this._provider;
    for (const product of PRODUCT_ORDER) {
      this._newProvider.add(product);
    }
    this._consecutiveTransportFailures = 0;
  }

  /**
   * Ask every product that is not already being asked, and apply and publish
   * each answer as it arrives.
   *
   * A product whose request is still outstanding is not asked again: its answer
   * is applied when it comes, so a slow product costs nothing but its own
   * freshness. A request outstanding for longer than
   * {@link SOLAR_WIND_FLARE_REQUEST_TIMEOUT_SECONDS} is abandoned as a
   * transport failure and asked again, at the next tick or the next call. An
   * ingest that was never started has no tick, so a caller that awaits this
   * promise before it calls again waits on a transport that never answers until
   * a stop, a destroy or a transport replacement.
   *
   * @param nowMs The instant, in ms since the Unix epoch.
   * @returns A promise that settles when every request this call issued has
   *   been applied, or abandoned by a stop, a destroy, a transport replacement
   *   or the request timeout, whether or not the transport honours the abort.
   */
  async refreshOnce(nowMs: number): Promise<void> {
    if (this._destroyed) {
      return;
    }
    const epoch = this._epoch;
    const issuedAt = this._mark(nowMs);
    this._abandonOverdue(nowMs);
    this._lastCycleMs = nowMs;
    const cycle: RequestCycle = { answered: false, failureCounted: false };
    const issued: Promise<void>[] = [];
    for (const product of PRODUCT_ORDER) {
      // The transport is called synchronously and may stop or destroy the
      // ingest; nothing is asked under an epoch that has ended.
      if (epoch !== this._epoch) {
        break;
      }
      if (!this._inFlight.has(product)) {
        issued.push(this._request(product, issuedAt, cycle));
      }
    }
    await Promise.all(issued);
    if (epoch !== this._epoch) {
      return;
    }
    // Each answer was published as it arrived. A cycle that asked nothing, or
    // whose requests all failed, still re-composes, at the instant it ends.
    this._publish(this._instantSince(issuedAt));
  }

  /** Issue one product's request; its answer is applied when it settles. */
  private _request(
    product: SolarWindFlareProductValue,
    issued: InstantMark,
    cycle: RequestCycle,
  ): Promise<void> {
    // A transport without an abort signal may never settle, so an abandoned
    // request settles its cycle itself; its answer is discarded if it comes.
    const abandonment = abandonablePromise();
    const request: ProductRequest = {
      controller: new AbortController(),
      issued: issued,
      cycle: cycle,
      abandon: abandonment.abandon,
    };
    this._inFlight.set(product, request);
    ++this._requestsIssued;
    const answered = invokeTransport(
      this._fetchJson,
      this._urls[product],
      request.controller.signal,
    ).then(
      (value) =>
        this._settle(product, request, { status: "fulfilled", value: value }),
      (reason: unknown) =>
        this._settle(product, request, { status: "rejected", reason: reason }),
    );
    return Promise.race([answered, abandonment.promise]);
  }

  /**
   * Apply one answer, unless the request it answers has been abandoned: a stop,
   * a destroy, a transport replacement and the request timeout each take a
   * request out of the ones in flight, and an answer to one that is no longer
   * there is discarded.
   *
   * An answer is judged at the instant it arrives, not the one it was asked at:
   * the minutes observed while it was on its way are as credible as the clock
   * now says they are.
   */
  private _settle(
    product: SolarWindFlareProductValue,
    request: ProductRequest,
    settled: PromiseSettledResult<unknown>,
  ): void {
    if (this._inFlight.get(product) !== request) {
      ++this._supersededResultsDiscarded;
      return;
    }
    this._inFlight.delete(product);
    const atMs = this._instantSince(request.issued);
    const cycle = request.cycle;
    if (settled.status === "rejected") {
      this._recordFailure(
        product,
        SolarWindFlareIngestCode.TRANSPORT,
        describeReason(settled.reason),
        atMs,
      );
      // One step of backoff per cycle whose requests fail with none answered;
      // counted when the first fails, so a sibling that hangs cannot hold it.
      if (!cycle.answered && !cycle.failureCounted) {
        cycle.failureCounted = true;
        ++this._consecutiveTransportFailures;
      }
      return;
    }
    // The host is serving: the backoff ends with this answer, whatever the
    // products still outstanding do.
    cycle.answered = true;
    this._consecutiveTransportFailures = 0;
    ++this._payloadsParsed;
    const payload = settled.value;
    // A new provider's first answer is admitted against nothing held.
    const fresh = this._newProvider.has(product);
    let admitted: boolean;
    switch (product) {
      case SolarWindFlareProduct.GOES_INSTRUMENT_SOURCES:
        admitted = this._hold(
          product,
          admitInstrumentSources(payload),
          atMs,
          (value) => {
            this._sources = value;
          },
        );
        break;
      case SolarWindFlareProduct.RTSW_MAGNETOMETER:
        admitted = this._hold(
          product,
          admitSolarWind(
            payload,
            RealTimeSolarWindProduct.MAGNETOMETER,
            fresh ? undefined : this._magnetometer,
            this._historySeconds,
            atMs,
          ),
          atMs,
          (value) => {
            this._magnetometer = value;
            this._magnetometerProvider = this._provider;
          },
        );
        break;
      case SolarWindFlareProduct.RTSW_PLASMA:
        admitted = this._hold(
          product,
          admitSolarWind(
            payload,
            RealTimeSolarWindProduct.PLASMA,
            fresh ? undefined : this._plasma,
            this._historySeconds,
            atMs,
          ),
          atMs,
          (value) => {
            this._plasma = value;
            this._plasmaProvider = this._provider;
          },
        );
        break;
      default:
        // Read against the mapping held when the answer arrives, so a slow
        // mapping delays nothing; a changed mapping applies from the next answer.
        this._primary =
          this._sources === undefined
            ? undefined
            : goesXrayPrimaryAt(this._sources, atMs);
        admitted = this._hold(
          product,
          admitXray(
            payload,
            this._primary,
            fresh ? undefined : this._xray,
            atMs,
          ),
          atMs,
          (value) => {
            this._xray = value;
          },
        );
        break;
    }
    if (admitted && fresh) {
      this._newProvider.delete(product);
    }
    this._queuePublish(atMs);
  }

  /** Hold what an answer admitted, or record why it was refused. */
  private _hold<T>(
    product: SolarWindFlareProductValue,
    admission: SolarWindFlareAdmission<T>,
    nowMs: number,
    store: (value: T) => void,
  ): boolean {
    if (admission.status === "ok") {
      store(admission.value);
      return true;
    }
    this._recordFailure(product, admission.code, admission.message, nowMs);
    return false;
  }

  /** Take an instant in the caller's frame, with the clock's reading at it. */
  private _mark(atMs: number): InstantMark {
    return { atMs: atMs, clockMs: this._now(), ticks: this._ticks };
  }

  /**
   * The instant now, in the frame of a mark: the mark's instant moved by what
   * the ingest's clock has moved since it was taken, a step back included. A
   * caller's explicit instant stays the frame, so an answer is judged when it
   * arrives without two clocks being mixed. A tick run since the mark has
   * published its own instant already, and nothing composes behind it.
   */
  private _instantSince(mark: InstantMark): number {
    const arrivedMs = mark.atMs + (this._now() - mark.clockMs);
    return this._ticks !== mark.ticks
      ? Math.max(arrivedMs, this._lastTickMs)
      : arrivedMs;
  }

  /**
   * Publish once the answers arriving together are applied, at the instant the
   * last of them arrived, rather than once per answer: a batch of answers is
   * one composition, not four.
   */
  private _queuePublish(atMs: number): void {
    this._queuedPublishMs = atMs;
    this._queuedPublishEpoch = this._epoch;
    if (this._publishQueued) {
      return;
    }
    this._publishQueued = true;
    queueMicrotask(() => {
      this._publishQueued = false;
      // A stop, a destroy or a transport replacement since ends the epoch the
      // answers were applied under; what they composed is not published.
      if (this._queuedPublishEpoch === this._epoch) {
        this._publish(this._queuedPublishMs);
      }
    });
  }

  /**
   * Abandon every request that has been outstanding for the request timeout,
   * so a peer that never answers is asked again rather than waited on for ever.
   */
  private _abandonOverdue(nowMs: number): void {
    const timeoutMs =
      SOLAR_WIND_FLARE_REQUEST_TIMEOUT_SECONDS * MILLISECONDS_PER_SECOND;
    for (const [product, request] of [...this._inFlight]) {
      const outstandingMs = nowMs - request.issued.atMs;
      // A clock stepped back leaves the age negative and unmeasurable, so that
      // request is abandoned as well.
      if (outstandingMs >= 0 && outstandingMs < timeoutMs) {
        continue;
      }
      this._inFlight.delete(product);
      request.controller.abort();
      request.abandon();
      this._recordFailure(
        product,
        SolarWindFlareIngestCode.TRANSPORT,
        `no answer within the ${SOLAR_WIND_FLARE_REQUEST_TIMEOUT_SECONDS} s request timeout; asked again`,
        nowMs,
      );
    }
  }

  private _nextDelayMs(): number {
    return requestDelayMs(
      this._pollIntervalMs,
      this._consecutiveTransportFailures,
    );
  }

  /**
   * Whether the requests are due at a tick. Half a poll interval of slack
   * absorbs a timer that fires a little early against the injected clock, which
   * would otherwise skip a whole interval.
   */
  private _requestsDue(tickMs: number): boolean {
    if (this._lastCycleMs === undefined || tickMs < this._lastCycleMs) {
      return true;
    }
    return (
      tickMs - this._lastCycleMs >=
      this._nextDelayMs() - this._pollIntervalMs / 2
    );
  }

  private _disarm(): void {
    if (this._timerHandle !== undefined) {
      this._clearTimeout(this._timerHandle);
      this._timerHandle = undefined;
    }
  }

  private _arm(): void {
    if (this._destroyed || this._stopped) {
      return;
    }
    this._disarm();
    this._timerHandle = this._setTimeout(() => {
      this._timerHandle = undefined;
      if (this._destroyed || this._stopped) {
        return;
      }
      const tickMs = this._now();
      ++this._ticks;
      this._lastTickMs = tickMs;
      // Staleness and the authority's decision move with the instant whether or
      // not a response arrives, so the packet is re-composed at every tick,
      // before a request whose answer may never come.
      this._publish(tickMs);
      // A listener told of that publish may have stopped or destroyed the ingest.
      if (this._destroyed || this._stopped) {
        return;
      }
      // Kept at every tick, not only when the requests are due, so no request
      // outlives the timeout by more than one poll interval under backoff.
      this._abandonOverdue(tickMs);
      if (this._requestsDue(tickMs)) {
        void this.refreshOnce(tickMs);
      }
      this._arm();
    }, this._pollIntervalMs);
  }

  private _abortInFlight(): void {
    for (const request of this._inFlight.values()) {
      request.controller.abort();
      request.abandon();
    }
    this._inFlight.clear();
  }

  /**
   * Compose the packet from the authority's decision, the solar wind and the
   * flare channel, and publish it if anything it was built from has changed.
   */
  private _publish(nowMs: number): void {
    // Judged before any of it is read: an authority that hands back what is not
    // a valid packet, or throws, is an absent authority named as such.
    const authority = readOvalAuthority(this._authority);
    const owner = authority.owner;
    const base = authority.packet;
    this._owner = owner;
    this._authorityFreshness = authorityPacketFreshness(base, nowMs);
    // The decision governs; the packet beside it must still be inside its own
    // declared horizon, because a stopped authority freezes its decision while
    // the instant moves on.
    const authorityUsable =
      owner !== SpaceWeatherOvalOwner.NONE &&
      base !== undefined &&
      this._authorityFreshness !== SpaceWeatherFreshness.STALE;

    const plasma = currentSolarWindReading(this._plasma, nowMs);
    const field = currentSolarWindReading(this._magnetometer, nowMs);
    const flareAt = flareReadingAt(this._xray, nowMs);
    const flareReading = flareAt.reading;
    this._flareFreshness = flareAt.freshness;
    if (flareReading === undefined) {
      this._flareOmission = flareAt.omission;
    }

    this._solarWindFreshness = solarWindFreshnessOf(
      this._plasma !== undefined || this._magnetometer !== undefined,
      plasma,
      field,
      nowMs,
    );

    // Averaged over the window that ends at the newest plasma minute rather
    // than at the instant, so the same held readings always give the same
    // estimate. It is part of the key below because the window holds more than
    // the newest minutes: a revised or backfilled minute inside it moves the
    // estimate without moving either newest reading.
    const estimate =
      plasma === undefined || field === undefined
        ? undefined
        : estimateSolarWindActivity(
            this._plasma.readings,
            this._magnetometer.readings,
            plasma.timeTagMs,
            SOLAR_WIND_ESTIMATE_WINDOW_SECONDS,
          );
    const flareResult: SolarFlareStateResult | undefined =
      flareReading === undefined
        ? undefined
        : solarFlareStateFrom(flareReading, this._xray);

    // Compared by value: every cycle decodes fresh objects, and a product
    // re-serving the same minutes must not republish the packet.
    const key: CompositionKey = [
      owner,
      authorityUsable,
      authority.offered,
      authority.refusal,
      valueFingerprint(plasma),
      valueFingerprint(field),
      valueFingerprint(estimate),
      valueFingerprint(flareResult),
    ];
    if (sameKey(this._key, key)) {
      return;
    }
    this._key = key;
    this._estimate = estimate;

    const solarWind = solarWindDiagnosticsFrom(plasma, field);
    let candidate: SolarFlareState | undefined;
    if (flareResult !== undefined) {
      if (flareResult.status === "ok") {
        candidate = flareResult.flare;
        this._flareOmission = undefined;
      } else {
        this._flareOmission = flareResult.omission;
      }
    }

    const composed = composeValidatedSolarWindFlarePacket({
      owner: owner,
      base: authorityUsable ? base : undefined,
      authorityRefusal: authority.refusal,
      estimate: estimate,
      field: field,
      solarWind: solarWind,
      flare: candidate,
      sourceId: this._solarWindSourceId,
    });
    for (const refusal of composed.refusals) {
      this._recordFailure(
        refusal.source,
        SolarWindFlareIngestCode.INVALID_PACKET,
        refusal.message,
        nowMs,
      );
    }
    if (composed.flareRefused) {
      this._flareOmission = FlareOmission.INVALID_PACKET;
    }
    const flare = composed.flare;
    const packet = composed.packet;

    // Everything is committed before any listener hears about it. A listener is
    // caller code, and one that destroys the ingest releases the state it was
    // told about; nothing may write that state back after it returns, and the
    // destroy's cleared listeners hear none of the events still to come.
    const moved = transitionsBetween(
      {
        flareClass: this._flareClass,
        activityAuthority: this._activityAuthority,
        activeSource: this._activeSource,
        activeSourceProvider: this._activeSourceProvider,
      },
      {
        flareClass: flare?.flareClass,
        activityAuthority: packet?.geomagnetic.authority ?? "none",
        // The spacecraft named is the plasma's when there is one, as the
        // diagnostics name it, so the provider is that series' provider.
        activeSource: solarWind?.sourceName,
        activeSourceProvider:
          plasma !== undefined
            ? this._plasmaProvider
            : this._magnetometerProvider,
      },
      nowMs,
    );
    this._flareClass = moved.state.flareClass;
    this._activityAuthority = moved.state.activityAuthority;
    this._activeSource = moved.state.activeSource;
    this._activeSourceProvider = moved.state.activeSourceProvider;
    if (packet !== undefined) {
      ++this._packetsBuilt;
    }
    this._packet = packet;
    for (const event of moved.events) {
      this._raise(event);
    }
  }

  private _raise(event: SolarWindFlareEvent): void {
    //>>includeStart('debug', pragmas.debug);
    console.log(
      `[SpaceWeather] ${event.type} ${event.previous ?? "none"} -> ${event.current ?? "none"}`,
    );
    //>>includeEnd('debug');
    for (const listener of [...this._listeners]) {
      // A listener is caller code; one that throws must neither keep the event
      // from the listeners after it nor escape into the cycle or the tick that
      // raised it, which would end the polling.
      try {
        listener(event);
      } catch (error) {
        console.error(
          `[SpaceWeather] a ${event.type} listener threw: ${describeReason(error)}`,
        );
      }
    }
  }

  private _recordFailure(
    product: SolarWindFlareFailureSourceValue,
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
    if (
      atMs - this._lastFailureLogMs >= FAILURE_LOG_INTERVAL_MS ||
      atMs < this._lastFailureLogMs
    ) {
      this._lastFailureLogMs = atMs;
      console.error(
        `[SpaceWeather] ${product} payload refused (${code}): ${message}. Keeping the last good state.`,
      );
    }
  }
}

export default SolarWindFlareFeedIngest;
