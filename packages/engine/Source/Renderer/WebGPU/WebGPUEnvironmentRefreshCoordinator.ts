/**
 * Same-frame collection and priority drain for dynamic-environment managers.
 *
 * Scene traversal discovers final consumer demand after a tileset-owned
 * manager has already asked to update. This GPU-free coordinator delays only
 * the WebGPU manager tick until primitive collection is complete, then invokes
 * the unchanged updater in stable HIGH-before-NORMAL order. It owns no manager
 * output and never submits GPU work itself.
 *
 * @module WebGPUEnvironmentRefreshCoordinator
 */

import type { WebGPUEnvironmentDemandValue } from "./WebGPUEnvironmentDemandRegistry.js";

// Literal mirror avoids a runtime dependency in this GPU-free policy unit.
const ENVIRONMENT_DEMAND_PROVEN_NONE = "proven-none";

type EnvironmentRefreshUpdate = (manager: never, frameState: never) => void;

interface EnvironmentRefreshEntry {
  manager: object | undefined;
  frameState: unknown;
  update: EnvironmentRefreshUpdate | undefined;
  expectedContext: object | undefined;
  queuedFrameId: number;
  updatedFrameId: number;
  resourceGeneration: number;
}

interface EnvironmentDemandClassifier {
  classify(manager: object): WebGPUEnvironmentDemandValue;
}

/**
 * Per-context, per-logical-frame collection queue.
 *
 * Collection is explicitly opened by Scene around ground and ordinary
 * primitive updates. Calls made anywhere else are rejected so their caller can
 * retain the historical immediate/off-frame path.
 */
export class WebGPUEnvironmentRefreshCoordinator {
  private _entries = new WeakMap<object, EnvironmentRefreshEntry>();
  private readonly _jobs: EnvironmentRefreshEntry[] = [];
  private readonly _highScratch: EnvironmentRefreshEntry[] = [];
  private readonly _normalScratch: EnvironmentRefreshEntry[] = [];
  private _frameId = 0;
  private _resourceGeneration = 0;
  private _collectionDepth = 0;

  get frameId(): number {
    return this._frameId;
  }

  get pendingCount(): number {
    return this._jobs.length;
  }

  get collectionActive(): boolean {
    return this._collectionDepth > 0;
  }

  /** Start a fresh logical frame and release any abandoned prior-frame jobs. */
  beginFrame(resourceGeneration = this._resourceGeneration): void {
    if (
      resourceGeneration !== this._resourceGeneration ||
      this._frameId === Number.MAX_SAFE_INTEGER
    ) {
      // Generation and frame-counter discontinuities invalidate every cached
      // entry stamp. Ordinary frames retain the WeakMap and allocate nothing.
      this._entries = new WeakMap<object, EnvironmentRefreshEntry>();
      this._frameId = 1;
    } else {
      this._frameId += 1;
    }
    this._resourceGeneration = resourceGeneration;
    this._releaseEntries(this._jobs);
    this._releaseEntries(this._highScratch);
    this._releaseEntries(this._normalScratch);
    this._jobs.length = 0;
    this._highScratch.length = 0;
    this._normalScratch.length = 0;
    this._collectionDepth = 0;
  }

  /** Drop every queued job, including across recovery or context teardown. */
  reset(resourceGeneration = this._resourceGeneration): void {
    this._resourceGeneration = resourceGeneration;
    this._frameId = 0;
    this._releaseEntries(this._jobs);
    this._releaseEntries(this._highScratch);
    this._releaseEntries(this._normalScratch);
    this._jobs.length = 0;
    this._highScratch.length = 0;
    this._normalScratch.length = 0;
    this._entries = new WeakMap<object, EnvironmentRefreshEntry>();
    this._collectionDepth = 0;
  }

  /** Open one Scene-owned primitive-collection scope. */
  beginCollection(resourceGeneration: number): boolean {
    if (resourceGeneration !== this._resourceGeneration) {
      return false;
    }
    this._collectionDepth += 1;
    return true;
  }

  /** Close the matching Scene-owned primitive-collection scope. */
  endCollection(resourceGeneration: number): void {
    if (
      resourceGeneration !== this._resourceGeneration ||
      this._collectionDepth === 0
    ) {
      return;
    }
    this._collectionDepth -= 1;
  }

  /**
   * Queue one exact manager tick. Duplicate aliases and later split-viewport
   * updates are consumed without invoking the raw updater more than once.
   */
  enqueue<TManager extends object, TFrameState>(
    manager: TManager,
    frameState: TFrameState,
    update: (manager: TManager, frameState: TFrameState) => void,
    resourceGeneration: number,
    expectedContext?: object,
  ): boolean {
    if (
      resourceGeneration !== this._resourceGeneration ||
      this._collectionDepth === 0
    ) {
      return false;
    }

    let entry = this._entries.get(manager);
    if (!entry) {
      entry = {
        manager: undefined,
        frameState: undefined,
        update: undefined,
        expectedContext: undefined,
        queuedFrameId: 0,
        updatedFrameId: 0,
        resourceGeneration,
      };
      this._entries.set(manager, entry);
    }

    if (
      entry.resourceGeneration === resourceGeneration &&
      (entry.updatedFrameId === this._frameId ||
        entry.queuedFrameId === this._frameId)
    ) {
      return true;
    }

    entry.manager = manager;
    entry.frameState = frameState;
    entry.update = update;
    entry.expectedContext = expectedContext;
    entry.queuedFrameId = this._frameId;
    entry.resourceGeneration = resourceGeneration;
    this._jobs.push(entry);
    return true;
  }

  /**
   * Drain final same-frame demand in stable priority order.
   *
   * In a split 2D frame, the first viewport passes `includeNormal=false`.
   * NORMAL work remains queued and is reclassified after the second viewport,
   * so late DEMANDED evidence can promote it before the final drain.
   *
   * @returns Number of raw manager updates invoked successfully.
   */
  drain(
    classifier: EnvironmentDemandClassifier,
    resourceGeneration: number,
    includeNormal = true,
  ): number {
    if (
      resourceGeneration !== this._resourceGeneration ||
      this._collectionDepth !== 0 ||
      this._jobs.length === 0
    ) {
      return 0;
    }

    const high = this._highScratch;
    const normal = this._normalScratch;
    high.length = 0;
    normal.length = 0;
    for (let i = 0; i < this._jobs.length; i++) {
      const job = this._jobs[i];
      const manager = job.manager;
      if (!manager) {
        continue;
      }
      if (classifier.classify(manager) === ENVIRONMENT_DEMAND_PROVEN_NONE) {
        normal.push(job);
      } else {
        // UNKNOWN is deliberately conservative and shares HIGH priority with
        // explicit DEMANDED evidence.
        high.push(job);
      }
    }

    this._jobs.length = 0;
    if (!includeNormal) {
      for (let i = 0; i < normal.length; i++) {
        this._jobs.push(normal[i]);
      }
    }

    let updateCount = 0;
    let completed = false;
    try {
      for (let i = 0; i < high.length; i++) {
        updateCount += this._runJob(high[i], resourceGeneration);
      }
      if (includeNormal) {
        for (let i = 0; i < normal.length; i++) {
          updateCount += this._runJob(normal[i], resourceGeneration);
        }
      }
      completed = true;
      return updateCount;
    } finally {
      // Preserve array capacity but release every completed or abandoned HIGH
      // entry immediately. NORMAL entries stay live only across the deliberate
      // first-to-final split-viewport handoff.
      this._releaseEntries(high);
      high.length = 0;
      if (includeNormal || !completed) {
        this._releaseEntries(normal);
        if (!completed) {
          this._jobs.length = 0;
        }
      }
      normal.length = 0;
    }
  }

  private _runJob(
    job: EnvironmentRefreshEntry,
    resourceGeneration: number,
  ): number {
    const manager = job.manager;
    const update = job.update;
    const frameState = job.frameState;
    if (
      resourceGeneration !== this._resourceGeneration ||
      job.resourceGeneration !== resourceGeneration ||
      job.updatedFrameId === this._frameId ||
      !manager ||
      !update
    ) {
      this._releaseEntry(job);
      return 0;
    }

    if (
      job.expectedContext &&
      (frameState as { context?: unknown } | undefined)?.context !==
        job.expectedContext
    ) {
      this._releaseEntry(job);
      return 0;
    }

    const isDestroyed = (manager as { isDestroyed?: () => boolean })
      .isDestroyed;
    if (typeof isDestroyed === "function") {
      let destroyed = true;
      try {
        destroyed = isDestroyed.call(manager) === true;
      } catch {
        // A broken destruction sentinel is not permission to resurrect native
        // resources on an owner whose lifetime cannot be established.
      }
      if (destroyed) {
        this._releaseEntry(job);
        return 0;
      }
    }

    // Mark only after success. A thrown updater commits no coordinator state;
    // its level-triggered dirty predicate can re-enlist on the next frame.
    let succeeded = false;
    try {
      update(manager as never, frameState as never);
      succeeded = true;
    } finally {
      if (succeeded && resourceGeneration === this._resourceGeneration) {
        job.updatedFrameId = this._frameId;
      }
      this._releaseEntry(job);
    }
    return succeeded && resourceGeneration === this._resourceGeneration ? 1 : 0;
  }

  private _releaseEntry(entry: EnvironmentRefreshEntry): void {
    entry.manager = undefined;
    entry.frameState = undefined;
    entry.update = undefined;
    entry.expectedContext = undefined;
  }

  private _releaseEntries(entries: EnvironmentRefreshEntry[]): void {
    for (let i = 0; i < entries.length; i++) {
      this._releaseEntry(entries[i]);
    }
  }
}

export default WebGPUEnvironmentRefreshCoordinator;
