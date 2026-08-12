/**
 * Context-owned bounded environment-refresh job drain.
 *
 * A dynamic-environment refresh is six cube-face compute dispatches plus an
 * IBL prefilter chain plus an SH projection. With several managers alive, every
 * one of them can fall dirty on the same frame (the sun moves once for all of
 * them), so the default path pays N complete refreshes in one frame. This
 * scheduler bounds how many *deferrable* refreshes may start per logical frame
 * and drains the rest across the following frames.
 *
 * ## The hard constraint this module is built around
 *
 * Gating an environment-map tick on consumer selection freezes a partially
 * generated map the moment a tileset is hidden, and suppresses the regeneration
 * its consumers need on re-show. Scheduling authority here may therefore only
 * ever **reorder and bound** work. It may never drop it. Concretely:
 *
 * 1. **Deferral is never a skip.** A deferred request keeps its pending entry,
 *    ages, and is re-offered every frame the producer still wants it.
 * 2. **Hard escalation cap.** After {@link MAX_DEFERRAL_FRAMES} consecutive
 *    deferrals a request becomes MANDATORY and runs regardless of budget. Every
 *    requested refresh therefore starts within `MAX_DEFERRAL_FRAMES + 1` frames
 *    of its first request, independent of arrival order or manager count.
 * 3. **Nothing unpublished is deferrable.** A manager that has never completed a
 *    refresh, or whose cube was just (re)created, or whose device generation
 *    just advanced, requests MANDATORY — it has no valid resources to keep
 *    publishing while it waits.
 * 4. **Every deferral carries an explicit resume path.** The caller must arm a
 *    render request on DEFER, so a `requestRenderMode` scene cannot idle with
 *    pending refresh work.
 * 5. **The producer's dirty predicate is level-triggered, never edge-consumed.**
 *    The caller must not commit any `last*` bookkeeping on the deferred path, so
 *    the identical predicate re-fires next frame. No dirty edge can be lost
 *    inside a deferral window.
 *
 * With `<= budget` managers requesting on a frame, every request is granted on
 * the frame it arrives — the single-manager default viewer is unchanged.
 *
 * This module is GPU-free: it holds no device, no texture, and no buffer, and a
 * manager is only ever a {@link WeakMap} key, so it never extends a lifetime.
 * The pending order list stores entries, not managers, for the same reason.
 *
 * @module WebGPUEnvironmentRefreshScheduler
 */

/**
 * Refresh urgency, ordered from most to least urgent.
 *
 * MANDATORY bypasses the per-frame budget. It is reserved for requests that
 * cannot wait without publishing invalid or absent resources, and for requests
 * the anti-starvation cap has escalated.
 */
export const WebGPUEnvironmentRefreshUrgency = Object.freeze({
  MANDATORY: 0,
  HIGH: 1,
  NORMAL: 2,
} as const);

export type WebGPUEnvironmentRefreshUrgencyValue =
  (typeof WebGPUEnvironmentRefreshUrgency)[keyof typeof WebGPUEnvironmentRefreshUrgency];

export const WebGPUEnvironmentRefreshDecision = Object.freeze({
  RUN: "run",
  DEFER: "defer",
} as const);

export type WebGPUEnvironmentRefreshDecisionValue =
  (typeof WebGPUEnvironmentRefreshDecision)[keyof typeof WebGPUEnvironmentRefreshDecision];

/**
 * Deferrable refreshes allowed to start per logical frame. One is deliberate:
 * a refresh is already a multi-dispatch burst, and the whole point of the drain
 * is that the second and later managers land on later frames. MANDATORY work is
 * not subject to this number.
 */
export const DEFAULT_ENVIRONMENT_REFRESH_BUDGET = 1;

/**
 * Consecutive deferrals after which a request escalates to MANDATORY. This is
 * the anti-starvation bound: worst-case latency from first request to start is
 * `MAX_DEFERRAL_FRAMES + 1` frames.
 */
export const MAX_DEFERRAL_FRAMES = 3;

/**
 * Frames a pending entry survives without being re-requested before it is
 * retired. A producer whose dirty predicate went false stopped asking; retiring
 * its entry is not starvation, because the predicate is level-triggered and
 * would re-request the moment it goes true again.
 */
const PENDING_EXPIRY_FRAMES = 2;

interface RefreshEntry {
  firstRequestFrameId: number;
  lastRequestFrameId: number;
  lastGrantFrameId: number;
  lastSubmitFrameId: number;
  deferredFrames: number;
  maxDeferredFrames: number;
  pending: boolean;
  lastUrgency: WebGPUEnvironmentRefreshUrgencyValue;
}

/** Plain, JSON-safe per-frame counters exposed through renderer statistics. */
export interface WebGPUEnvironmentRefreshTelemetry {
  frameId: number;
  resourceGeneration: number;
  budget: number;
  requests: number;
  granted: number;
  deferrableGrants: number;
  deferred: number;
  mandatoryGrants: number;
  escalatedGrants: number;
  yieldDeferrals: number;
  budgetDeferrals: number;
  overBudgetGrants: number;
  resumeRequests: number;
  submissions: number;
  pendingAtFrameEnd: number;
  retiredPending: number;
  maxDeferredFramesObserved: number;
}

/** Debug-only immutable view of one manager's scheduling entry. */
export interface WebGPUEnvironmentRefreshRecord {
  pending: boolean;
  deferredFrames: number;
  maxDeferredFrames: number;
  firstRequestFrameId: number;
  lastRequestFrameId: number;
  lastGrantFrameId: number;
  lastSubmitFrameId: number;
  lastUrgency: WebGPUEnvironmentRefreshUrgencyValue;
}

function createTelemetry(
  frameId: number,
  resourceGeneration: number,
  budget: number,
): WebGPUEnvironmentRefreshTelemetry {
  return {
    frameId,
    resourceGeneration,
    budget,
    requests: 0,
    granted: 0,
    deferrableGrants: 0,
    deferred: 0,
    mandatoryGrants: 0,
    escalatedGrants: 0,
    yieldDeferrals: 0,
    budgetDeferrals: 0,
    overBudgetGrants: 0,
    resumeRequests: 0,
    submissions: 0,
    pendingAtFrameEnd: 0,
    retiredPending: 0,
    maxDeferredFramesObserved: 0,
  };
}

/**
 * Per-context bounded drain queue for dynamic-environment refreshes.
 *
 * The scheduler is an online admission controller, not an offline sorter:
 * producers call it one at a time during traversal, so it cannot know which
 * managers will request later in the same frame. Fairness therefore comes from
 * two mechanisms that need no lookahead — a one-frame yield by whoever ran last
 * while somebody else is waiting, and the hard escalation cap that bounds the
 * worst case for everyone.
 */
export class WebGPUEnvironmentRefreshScheduler {
  private _entries = new WeakMap<object, RefreshEntry>();
  private _pending: RefreshEntry[] = [];
  private _frameId = 0;
  private _resourceGeneration = 0;
  private _budget: number;
  private _grantedThisFrame = 0;
  private _deferrableGrantedThisFrame = 0;
  private _resumeArmed = false;
  private _resumeConsumedThisFrame = false;
  private _telemetry: WebGPUEnvironmentRefreshTelemetry;

  constructor(budget: number = DEFAULT_ENVIRONMENT_REFRESH_BUDGET) {
    this._budget = WebGPUEnvironmentRefreshScheduler._normalizeBudget(budget);
    this._telemetry = createTelemetry(0, 0, this._budget);
  }

  /** Deferrable grants allowed per frame. Never less than one. */
  get budget(): number {
    return this._budget;
  }

  set budget(value: number) {
    this._budget = WebGPUEnvironmentRefreshScheduler._normalizeBudget(value);
    this._telemetry.budget = this._budget;
  }

  get frameId(): number {
    return this._frameId;
  }

  /** True while at least one deferred request is still owed a frame. */
  hasPendingWork(): boolean {
    return this._pending.length > 0;
  }

  get pendingCount(): number {
    return this._pending.length;
  }

  /**
   * Start a fresh logical render frame.
   *
   * A device-generation change drops every entry: those requests described work
   * against resources that no longer exist, and each producer re-derives its own
   * MANDATORY post-recovery request from its own invalidated cache.
   */
  beginFrame(resourceGeneration = this._resourceGeneration): void {
    if (resourceGeneration !== this._resourceGeneration) {
      this._entries = new WeakMap<object, RefreshEntry>();
      this._pending.length = 0;
      this._resourceGeneration = resourceGeneration;
    }

    if (this._frameId === Number.MAX_SAFE_INTEGER) {
      // Wrapping the counter would make every `lastGrantFrameId` comparison
      // meaningless, so start over from a clean ledger rather than compare
      // across the discontinuity.
      this._entries = new WeakMap<object, RefreshEntry>();
      this._pending.length = 0;
      this._frameId = 1;
    } else {
      this._frameId += 1;
    }

    this._grantedThisFrame = 0;
    this._deferrableGrantedThisFrame = 0;
    this._resumeArmed = false;
    this._resumeConsumedThisFrame = false;
    this._telemetry = createTelemetry(
      this._frameId,
      this._resourceGeneration,
      this._budget,
    );

    this._retireStalePending();
  }

  /**
   * Offer one refresh request to the drain.
   *
   * @param manager The producer's manager object; a WeakMap key only.
   * @param urgency The producer's own classification. MANDATORY must be used
   *   whenever deferring would leave a consumer without valid resources.
   * @returns RUN when the caller must perform the refresh this frame, DEFER
   *   when the caller must skip the refresh AND commit no bookkeeping AND arm
   *   the resume path.
   */
  requestRefresh(
    manager: object,
    urgency: WebGPUEnvironmentRefreshUrgencyValue = WebGPUEnvironmentRefreshUrgency.HIGH,
  ): WebGPUEnvironmentRefreshDecisionValue {
    const entry = this._getOrCreateEntry(manager);
    const telemetry = this._telemetry;
    telemetry.requests += 1;

    entry.lastRequestFrameId = this._frameId;
    entry.lastUrgency = urgency;
    if (!entry.pending) {
      entry.firstRequestFrameId = this._frameId;
      entry.pending = true;
      this._pending.push(entry);
    }

    // Anti-starvation escalation. Checked before every other rule so no policy
    // below can hold a request past the cap.
    const escalated = entry.deferredFrames >= MAX_DEFERRAL_FRAMES;
    if (escalated || urgency === WebGPUEnvironmentRefreshUrgency.MANDATORY) {
      if (escalated) {
        telemetry.escalatedGrants += 1;
      } else {
        telemetry.mandatoryGrants += 1;
      }
      // MANDATORY and anti-starvation grants bypass the deferrable quota; an
      // urgent unpublished manager must not consume the one ordinary slot.
      return this._grant(entry, false);
    }

    // One-frame yield: whoever ran on the immediately preceding frame steps
    // aside while somebody else is still waiting. The yielder is itself a
    // deferred request, so it inherits aging, escalation, and the resume path —
    // yielding can never freeze it.
    const othersPending = this._pending.length > 1;
    if (othersPending && entry.lastGrantFrameId === this._frameId - 1) {
      telemetry.yieldDeferrals += 1;
      return this._defer(entry);
    }

    if (this._deferrableGrantedThisFrame < this._budget) {
      return this._grant(entry, true);
    }

    telemetry.budgetDeferrals += 1;
    return this._defer(entry);
  }

  /**
   * Record that a granted refresh actually reached `queue.submit`.
   *
   * Grants are cleared from the pending set optimistically, so a refresh that
   * throws mid-encode simply re-requests next frame through the unchanged
   * level-triggered predicate. Only a real submission updates the yield anchor,
   * so a repeatedly failing producer is never demoted for work it never did.
   */
  noteRefreshSubmitted(manager: object): void {
    const entry = this._entries.get(manager);
    if (!entry) {
      return;
    }
    entry.lastSubmitFrameId = this._frameId;
    entry.lastGrantFrameId = this._frameId;
    this._telemetry.submissions += 1;
  }

  /**
   * True exactly once per frame, for the first deferral of that frame. The
   * caller uses it to arm a single render request rather than one per deferral.
   */
  consumeResumeRequest(): boolean {
    if (!this._resumeArmed || this._resumeConsumedThisFrame) {
      return false;
    }
    this._resumeArmed = false;
    this._resumeConsumedThisFrame = true;
    this._telemetry.resumeRequests += 1;
    return true;
  }

  /** Allocation-bearing debug read; never called from the render hot path. */
  getRecord(manager: object): WebGPUEnvironmentRefreshRecord | undefined {
    const entry = this._entries.get(manager);
    if (!entry) {
      return undefined;
    }
    return {
      pending: entry.pending,
      deferredFrames: entry.deferredFrames,
      maxDeferredFrames: entry.maxDeferredFrames,
      firstRequestFrameId: entry.firstRequestFrameId,
      lastRequestFrameId: entry.lastRequestFrameId,
      lastGrantFrameId: entry.lastGrantFrameId,
      lastSubmitFrameId: entry.lastSubmitFrameId,
      lastUrgency: entry.lastUrgency,
    };
  }

  /** Allocation-bearing debug snapshot; never called from the render hot path. */
  getTelemetry(): WebGPUEnvironmentRefreshTelemetry {
    const telemetry = this._telemetry;
    telemetry.pendingAtFrameEnd = this._pending.length;
    let worst = 0;
    for (let i = 0; i < this._pending.length; i++) {
      const deferred = this._pending[i].deferredFrames;
      if (deferred > worst) {
        worst = deferred;
      }
    }
    telemetry.maxDeferredFramesObserved = worst;
    return { ...telemetry };
  }

  /**
   * Drop every registration, including after device recovery or destruction.
   * No manager, texture, or buffer is owned here, so nothing is destroyed.
   */
  reset(resourceGeneration = this._resourceGeneration): void {
    this._entries = new WeakMap<object, RefreshEntry>();
    this._pending.length = 0;
    this._resourceGeneration = resourceGeneration;
    this._frameId = 0;
    this._grantedThisFrame = 0;
    this._deferrableGrantedThisFrame = 0;
    this._resumeArmed = false;
    this._resumeConsumedThisFrame = false;
    this._telemetry = createTelemetry(
      0,
      this._resourceGeneration,
      this._budget,
    );
  }

  private static _normalizeBudget(value: number): number {
    if (!Number.isFinite(value)) {
      return DEFAULT_ENVIRONMENT_REFRESH_BUDGET;
    }
    // A zero or negative budget would make every deferrable request wait for
    // the escalation cap — a permanent stutter, not a freeze, but never
    // intended. Clamp so the drain always makes forward progress.
    return Math.max(1, Math.floor(value));
  }

  private _grant(
    entry: RefreshEntry,
    countsAgainstDeferrableBudget: boolean,
  ): WebGPUEnvironmentRefreshDecisionValue {
    if (entry.deferredFrames > entry.maxDeferredFrames) {
      entry.maxDeferredFrames = entry.deferredFrames;
    }
    entry.deferredFrames = 0;
    this._removePending(entry);
    this._grantedThisFrame += 1;
    if (countsAgainstDeferrableBudget) {
      this._deferrableGrantedThisFrame += 1;
      this._telemetry.deferrableGrants += 1;
    }
    this._telemetry.granted += 1;
    if (this._grantedThisFrame > this._budget) {
      this._telemetry.overBudgetGrants += 1;
    }
    return WebGPUEnvironmentRefreshDecision.RUN;
  }

  private _defer(entry: RefreshEntry): WebGPUEnvironmentRefreshDecisionValue {
    entry.deferredFrames += 1;
    if (entry.deferredFrames > entry.maxDeferredFrames) {
      entry.maxDeferredFrames = entry.deferredFrames;
    }
    this._telemetry.deferred += 1;
    if (!this._resumeConsumedThisFrame) {
      this._resumeArmed = true;
    }

    // Permanent sentinel. The escalation cap makes this unreachable; if it ever
    // fires, an ordering rule above has swallowed the cap and a producer is
    // being starved, which is exactly the failure this module exists to
    // prevent.
    if (entry.deferredFrames > MAX_DEFERRAL_FRAMES) {
      console.error(
        `[CesiumJS:webgpu] Environment refresh deferred ${entry.deferredFrames} frames, past the ${MAX_DEFERRAL_FRAMES}-frame escalation cap. A refresh is being starved.`,
      );
    }
    return WebGPUEnvironmentRefreshDecision.DEFER;
  }

  private _removePending(entry: RefreshEntry): void {
    if (!entry.pending) {
      return;
    }
    entry.pending = false;
    const index = this._pending.indexOf(entry);
    if (index >= 0) {
      this._pending.splice(index, 1);
    }
  }

  private _retireStalePending(): void {
    const cutoff = this._frameId - PENDING_EXPIRY_FRAMES;
    for (let i = this._pending.length - 1; i >= 0; i--) {
      const entry = this._pending[i];
      if (entry.lastRequestFrameId < cutoff) {
        entry.pending = false;
        entry.deferredFrames = 0;
        this._pending.splice(i, 1);
        this._telemetry.retiredPending += 1;
      }
    }
  }

  private _getOrCreateEntry(manager: object): RefreshEntry {
    let entry = this._entries.get(manager);
    if (entry) {
      return entry;
    }
    entry = {
      firstRequestFrameId: this._frameId,
      lastRequestFrameId: this._frameId,
      // Sentinels chosen so a brand-new entry can never look like it ran on the
      // previous frame and yield its very first request.
      lastGrantFrameId: -1,
      lastSubmitFrameId: -1,
      deferredFrames: 0,
      maxDeferredFrames: 0,
      pending: false,
      lastUrgency: WebGPUEnvironmentRefreshUrgency.HIGH,
    };
    this._entries.set(manager, entry);
    return entry;
  }
}

export default WebGPUEnvironmentRefreshScheduler;
