/**
 * C11-193 environment-map consumer demand telemetry.
 *
 * This registry is deliberately observe-only. It records what Scene producers
 * know about consumers of a {@link DynamicEnvironmentMapManager}, but it does
 * not gate refresh work, change update ordering, or retain GPU resources. The
 * later shared-job-scheduler slice can use the same classifications after its
 * visibility and ordering gates are proven.
 *
 * A manager is a WeakMap key, so the registry never extends its lifetime. Each
 * entry also carries the current logical-frame stamp; a request-render idle,
 * context recovery, or ordinary frame transition cannot reuse stale demand.
 */

/** Conservative demand classification, ordered from least to most certain. */
export const WebGPUEnvironmentDemand = Object.freeze({
  UNKNOWN: "unknown",
  PROVEN_NONE: "proven-none",
  DEMANDED: "demanded",
} as const);

export type WebGPUEnvironmentDemandValue =
  (typeof WebGPUEnvironmentDemand)[keyof typeof WebGPUEnvironmentDemand];

/** Known registration sites. Add-only so telemetry stays comparable. */
export const WebGPUEnvironmentDemandReason = Object.freeze({
  TILESET_SELECTION: 1 << 0,
  STANDALONE_OWNER: 1 << 1,
} as const);

export type WebGPUEnvironmentDemandReasonValue =
  (typeof WebGPUEnvironmentDemandReason)[keyof typeof WebGPUEnvironmentDemandReason];

interface EnvironmentDemandEntry {
  frameId: number;
  demand: WebGPUEnvironmentDemandValue;
  reasonMask: number;
  consumerCount: number;
  registrationCount: number;
  updateReadCount: number;
}

/** Plain, JSON-safe per-frame counters exposed through renderer statistics. */
export interface WebGPUEnvironmentDemandTelemetry {
  frameId: number;
  resourceGeneration: number;
  registrations: number;
  registeredConsumers: number;
  uniqueManagers: number;
  demanded: number;
  provenNone: number;
  unknown: number;
  updateReads: number;
  updateReadsDemanded: number;
  updateReadsProvenNone: number;
  updateReadsUnknown: number;
  unregisteredUpdateReads: number;
}

/** Debug-only immutable view of one current-frame manager entry. */
export interface WebGPUEnvironmentDemandRecord {
  demand: WebGPUEnvironmentDemandValue;
  reasonMask: number;
  consumerCount: number;
  registrationCount: number;
  updateReadCount: number;
}

function createTelemetry(
  frameId: number,
  resourceGeneration: number,
): WebGPUEnvironmentDemandTelemetry {
  return {
    frameId,
    resourceGeneration,
    registrations: 0,
    registeredConsumers: 0,
    uniqueManagers: 0,
    demanded: 0,
    provenNone: 0,
    unknown: 0,
    updateReads: 0,
    updateReadsDemanded: 0,
    updateReadsProvenNone: 0,
    updateReadsUnknown: 0,
    unregisteredUpdateReads: 0,
  };
}

/**
 * Per-context, GPU-free environment demand ledger.
 *
 * UNKNOWN is intentionally sticky over PROVEN_NONE: one producer's proof of
 * no demand cannot suppress another producer whose visibility is uncertain.
 * DEMANDED is strongest and cannot be downgraded within the frame.
 */
export class WebGPUEnvironmentDemandRegistry {
  private _entries = new WeakMap<object, EnvironmentDemandEntry>();
  private _frameId = 0;
  private _resourceGeneration = 0;
  private _telemetry = createTelemetry(0, 0);

  /** Start a fresh logical render frame. */
  beginFrame(resourceGeneration = this._resourceGeneration): void {
    if (this._frameId === Number.MAX_SAFE_INTEGER) {
      this._entries = new WeakMap<object, EnvironmentDemandEntry>();
      this._frameId = 1;
    } else {
      this._frameId += 1;
    }
    this._resourceGeneration = resourceGeneration;
    this._telemetry = createTelemetry(this._frameId, this._resourceGeneration);
  }

  /**
   * Invalidate all current registrations, including after device recovery.
   * No manager or GPU resource is destroyed; the registry owns neither.
   */
  reset(resourceGeneration = this._resourceGeneration): void {
    this._entries = new WeakMap<object, EnvironmentDemandEntry>();
    this._resourceGeneration = resourceGeneration;
    this._frameId = 0;
    this._telemetry = createTelemetry(0, this._resourceGeneration);
  }

  registerDemand(
    manager: object,
    reason: WebGPUEnvironmentDemandReasonValue,
    consumerCount = 1,
  ): void {
    const entry = this._getOrCreateEntry(manager);
    this._recordRegistration(entry, reason, consumerCount);
    this._transition(entry, WebGPUEnvironmentDemand.DEMANDED);
  }

  registerProvenNoDemand(
    manager: object,
    reason: WebGPUEnvironmentDemandReasonValue,
  ): void {
    const entry = this._getOrCreateEntry(manager);
    this._recordRegistration(entry, reason, 0);
    if (entry.demand !== WebGPUEnvironmentDemand.DEMANDED) {
      this._transition(entry, WebGPUEnvironmentDemand.PROVEN_NONE);
    }
  }

  registerUnknown(
    manager: object,
    reason: WebGPUEnvironmentDemandReasonValue,
    consumerCount = 1,
  ): void {
    const entry = this._getOrCreateEntry(manager);
    this._recordRegistration(entry, reason, consumerCount);
    if (entry.demand === WebGPUEnvironmentDemand.PROVEN_NONE) {
      this._transition(entry, WebGPUEnvironmentDemand.UNKNOWN);
    }
  }

  /**
   * Record the classification observed by today's unconditional update path.
   * The return value is telemetry only; callers must not gate work on it in
   * this slice.
   */
  observeUpdate(manager: object): WebGPUEnvironmentDemandValue {
    const entry = this._getCurrentEntry(manager);
    const telemetry = this._telemetry;
    telemetry.updateReads += 1;

    if (!entry) {
      telemetry.updateReadsUnknown += 1;
      telemetry.unregisteredUpdateReads += 1;
      return WebGPUEnvironmentDemand.UNKNOWN;
    }

    entry.updateReadCount += 1;
    if (entry.demand === WebGPUEnvironmentDemand.DEMANDED) {
      telemetry.updateReadsDemanded += 1;
    } else if (entry.demand === WebGPUEnvironmentDemand.PROVEN_NONE) {
      telemetry.updateReadsProvenNone += 1;
    } else {
      telemetry.updateReadsUnknown += 1;
    }
    return entry.demand;
  }

  classify(manager: object): WebGPUEnvironmentDemandValue {
    return (
      this._getCurrentEntry(manager)?.demand ?? WebGPUEnvironmentDemand.UNKNOWN
    );
  }

  /** Allocation-bearing debug read; never called from the render hot path. */
  getRecord(manager: object): WebGPUEnvironmentDemandRecord | undefined {
    const entry = this._getCurrentEntry(manager);
    if (!entry) {
      return undefined;
    }
    return {
      demand: entry.demand,
      reasonMask: entry.reasonMask,
      consumerCount: entry.consumerCount,
      registrationCount: entry.registrationCount,
      updateReadCount: entry.updateReadCount,
    };
  }

  /** Allocation-bearing debug snapshot; never called from the render hot path. */
  getTelemetry(): WebGPUEnvironmentDemandTelemetry {
    return { ...this._telemetry };
  }

  private _getCurrentEntry(
    manager: object,
  ): EnvironmentDemandEntry | undefined {
    const entry = this._entries.get(manager);
    return entry?.frameId === this._frameId ? entry : undefined;
  }

  private _getOrCreateEntry(manager: object): EnvironmentDemandEntry {
    let entry = this._getCurrentEntry(manager);
    if (entry) {
      return entry;
    }

    entry = {
      frameId: this._frameId,
      demand: WebGPUEnvironmentDemand.UNKNOWN,
      reasonMask: 0,
      consumerCount: 0,
      registrationCount: 0,
      updateReadCount: 0,
    };
    this._entries.set(manager, entry);
    this._telemetry.uniqueManagers += 1;
    this._telemetry.unknown += 1;
    return entry;
  }

  private _recordRegistration(
    entry: EnvironmentDemandEntry,
    reason: WebGPUEnvironmentDemandReasonValue,
    consumerCount: number,
  ): void {
    const normalizedCount =
      Number.isFinite(consumerCount) && consumerCount > 0
        ? Math.floor(consumerCount)
        : 0;
    entry.reasonMask |= reason;
    entry.consumerCount += normalizedCount;
    entry.registrationCount += 1;
    this._telemetry.registrations += 1;
    this._telemetry.registeredConsumers += normalizedCount;
  }

  private _transition(
    entry: EnvironmentDemandEntry,
    next: WebGPUEnvironmentDemandValue,
  ): void {
    const previous = entry.demand;
    if (previous === next) {
      return;
    }

    if (previous === WebGPUEnvironmentDemand.DEMANDED) {
      this._telemetry.demanded -= 1;
    } else if (previous === WebGPUEnvironmentDemand.PROVEN_NONE) {
      this._telemetry.provenNone -= 1;
    } else {
      this._telemetry.unknown -= 1;
    }

    entry.demand = next;
    if (next === WebGPUEnvironmentDemand.DEMANDED) {
      this._telemetry.demanded += 1;
    } else if (next === WebGPUEnvironmentDemand.PROVEN_NONE) {
      this._telemetry.provenNone += 1;
    } else {
      this._telemetry.unknown += 1;
    }
  }
}

export default WebGPUEnvironmentDemandRegistry;
