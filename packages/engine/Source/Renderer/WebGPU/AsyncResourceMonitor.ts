/**
 * NEW-WEBGPU-PIPELINE-READY-SIGNAL — Phase 1 scaffolding.
 *
 * Per-`GraphicsContext` registry that tracks inflight asynchronous
 * GPU/CPU resource work (render pipelines, compute pipelines, shader
 * compiles, image decodes, texture uploads, buffer mapAsync, ...) and
 * emits `started` / `resolved` / `rejected` events to subscribers
 * (typically the attached Scene's render-request handler).
 *
 * Why this exists: WebGPU's `device.createRenderPipelineAsync()` and
 * sibling APIs are async, but Cesium's render loop hibernates when
 * `Scene.requestRenderMode === true` and nothing is "dirty". An async
 * pipeline that resolves AFTER the scene hibernates lands silently —
 * the canvas freezes mid-warmup with the new resource never drawn.
 *
 * The fix shape: any cache or loader that issues async GPU work calls
 * `monitor.begin({ kind, key })` when starting and `monitor.resolve(token)`
 * (or `reject`) when done. Scene subscribes once; on `resolved` it calls
 * `requestRender()` to wake itself up. Hibernation is preserved because
 * the wake-up is one-shot per resolution — once nothing is inflight
 * and nothing else is dirty, the scene re-idles naturally.
 *
 * Design properties:
 *   - Per-context (one monitor per `GraphicsContext`). Cross-context
 *     wake-ups are impossible by construction.
 *   - Idempotent `begin()` — second call with same key returns the
 *     existing token. Cache layers that already de-dupe pending
 *     promises keep their semantics.
 *   - Idempotent `resolve()` / `reject()` — calling twice for the
 *     same token is a no-op. Tolerant of teardown races.
 *   - Synchronous fan-out — subscribers fire inside `_emit`. Scene's
 *     subscriber just sets `_renderRequested = true`, which is safe
 *     to call inside an `await` chain. Subscribers that throw are
 *     caught and logged so a misbehaving subscriber can't poison the
 *     fan-out for the others.
 *   - Optional `ownerSceneIds` field is plumbed through the token
 *     shape but is unused in Phase 1; reserved for the multi-context
 *     attribution pass (Phase 6) so Scene B doesn't wake when only
 *     Scene A's per-renderer work landed.
 *
 * @internal
 */

const PERF_NOW: () => number =
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? () => performance.now()
    : () => Date.now();

export type AsyncResourceKind =
  | "render-pipeline"
  | "compute-pipeline"
  | "shader-module"
  | "texture-upload"
  | "image-decode"
  | "buffer-map";

/**
 * Token priority. `"foreground"` (the default) is work the scene is
 * actively waiting for — keeps frames rendering until it lands.
 * `"background"` is speculative warmup — the scene should hibernate
 * normally during background work, only waking when it resolves so
 * the caller can use it on the *next* user-driven frame.
 */
export type AsyncResourcePriority = "foreground" | "background";

/**
 * Caller-supplied fields for `begin()`. Everything except `key` and
 * `kind` is optional.
 */
export interface AsyncResourceTokenInit {
  /** Resource category — used by `pendingByKind` and debug overlays. */
  readonly kind: AsyncResourceKind;
  /**
   * Unique key for de-duplication. Cache layers should pass their own
   * cache key here so a second `begin()` for the same in-flight work
   * returns the original token instead of double-counting.
   */
  readonly key: string;
  /**
   * Optional human-readable label for logs (e.g., the descriptor's
   * `name` field for pipeline tokens). Has no effect on dispatch.
   */
  readonly label?: string;
  /**
   * Optional set of scene IDs (`Scene.id` / GUID strings) that care
   * about this resource. When present, only subscribers whose
   * `subscribe(cb, sceneId)` registration matches one of these IDs
   * fire on resolution. When absent (the default), every subscriber
   * fires — correct for shared resources and the single-scene case.
   *
   * Used by Phase 6 to keep Scene B hibernated when a per-scene
   * resource for Scene A lands.
   */
  readonly ownerSceneIds?: ReadonlySet<string> | null;
  /**
   * Token priority. Defaults to `"foreground"`. Background-priority
   * tokens DO NOT keep `Scene.shouldRender` open — they're speculative
   * warmup work that shouldn't burn frames; they DO still wake the
   * scene on resolution so the warmed resource is consumable on the
   * next user-driven frame.
   */
  readonly priority?: AsyncResourcePriority;
}

/**
 * Live token returned from `begin()`. The numeric `id` is unique per
 * monitor across its lifetime; the `key` may be reused after the
 * inflight slot clears. `priority` is normalized to its concrete
 * value (no `undefined`) so consumers can switch on it directly.
 */
export interface AsyncResourceToken extends Omit<
  AsyncResourceTokenInit,
  "priority"
> {
  readonly id: number;
  readonly startTime: number;
  readonly priority: AsyncResourcePriority;
}

export type AsyncResourceEventKind = "started" | "resolved" | "rejected";

export interface AsyncResourceEvent {
  readonly kind: AsyncResourceEventKind;
  readonly token: AsyncResourceToken;
  /** Wall-clock duration from `begin()` to terminal event, ms. */
  readonly durationMs?: number;
  /** Populated only for `rejected`. */
  readonly error?: unknown;
}

export type AsyncResourceSubscriber = (event: AsyncResourceEvent) => void;

/**
 * Phase 6 — subscriber registration metadata. When `sceneId` is set
 * AND a token was issued with `ownerSceneIds`, the monitor only
 * dispatches to subscribers whose `sceneId` is in the owner set.
 * Subscribers without a `sceneId` (or against tokens without an owner
 * set) always fire — that's the legacy / shared-resource path.
 */
export interface AsyncResourceSubscriberOptions {
  readonly sceneId?: string;
}

export interface AsyncResourceMonitorStats {
  readonly resolved: number;
  readonly rejected: number;
  readonly peakInflight: number;
  readonly currentInflight: number;
  readonly subscribers: number;
}

interface SubscriberEntry {
  cb: AsyncResourceSubscriber;
  sceneId: string | null;
}

export class AsyncResourceMonitor {
  private readonly _contextId: string | number;
  private _nextTokenId = 1;
  private readonly _inflight = new Map<string, AsyncResourceToken>();
  private readonly _subscribers = new Set<SubscriberEntry>();
  private _resolvedCount = 0;
  private _rejectedCount = 0;
  private _peakInflight = 0;

  constructor(contextId: string | number) {
    this._contextId = contextId;
  }

  /**
   * Register an inflight resource. Returns the live token. If a token
   * with the same `key` is already inflight, returns the existing one
   * (idempotent). Producers should treat the returned token as opaque
   * and pass it back to `resolve()` / `reject()`.
   */
  begin(init: AsyncResourceTokenInit): AsyncResourceToken {
    const existing = this._inflight.get(init.key);
    if (existing) return existing;

    const token: AsyncResourceToken = {
      kind: init.kind,
      key: init.key,
      label: init.label,
      ownerSceneIds: init.ownerSceneIds ?? null,
      priority: init.priority ?? "foreground",
      id: this._nextTokenId++,
      startTime: PERF_NOW(),
    };
    this._inflight.set(init.key, token);
    if (this._inflight.size > this._peakInflight) {
      this._peakInflight = this._inflight.size;
    }
    this._emit({ kind: "started", token });
    return token;
  }

  /**
   * Mark an inflight resource as complete. Idempotent — calling for an
   * already-resolved key is a no-op (tolerant of teardown races).
   * Accepts either the original token or its key string.
   */
  resolve(tokenOrKey: AsyncResourceToken | string): void {
    const key = typeof tokenOrKey === "string" ? tokenOrKey : tokenOrKey.key;
    const token = this._inflight.get(key);
    if (!token) return;
    this._inflight.delete(key);
    this._resolvedCount++;
    this._emit({
      kind: "resolved",
      token,
      durationMs: PERF_NOW() - token.startTime,
    });
  }

  /**
   * Mark an inflight resource as failed. Idempotent. Subscribers
   * receive a `rejected` event carrying the original error so they
   * can decide whether to re-issue or surface a user-visible warning.
   */
  reject(tokenOrKey: AsyncResourceToken | string, error: unknown): void {
    const key = typeof tokenOrKey === "string" ? tokenOrKey : tokenOrKey.key;
    const token = this._inflight.get(key);
    if (!token) return;
    this._inflight.delete(key);
    this._rejectedCount++;
    this._emit({
      kind: "rejected",
      token,
      durationMs: PERF_NOW() - token.startTime,
      error,
    });
  }

  /**
   * Reject every currently inflight token in one sweep. Used by the
   * device-loss handler so producers re-issue against the recovered
   * device. Subscribers stay attached; only inflight state is cleared.
   */
  reset(reason?: string): void {
    if (this._inflight.size === 0) return;
    const tokens = Array.from(this._inflight.values());
    this._inflight.clear();
    this._rejectedCount += tokens.length;
    const error = new Error(
      `AsyncResourceMonitor reset: ${reason ?? "unspecified"}`,
    );
    const now = PERF_NOW();
    for (const token of tokens) {
      this._emit({
        kind: "rejected",
        token,
        durationMs: now - token.startTime,
        error,
      });
    }
  }

  /**
   * Register a subscriber. Returns an unsubscribe function. Scene
   * stores the unsubscribe in its destroy path so the monitor doesn't
   * accumulate dead callbacks across the lifetime of long-lived
   * contexts.
   *
   * Phase 6: pass `options.sceneId` (typically `scene.id`) so the
   * monitor can filter events scoped to other scenes' work. Without
   * `sceneId`, the subscriber fires on every event (correct for the
   * single-scene case and for resources shared across scenes).
   */
  subscribe(
    cb: AsyncResourceSubscriber,
    options?: AsyncResourceSubscriberOptions,
  ): () => void {
    const entry: SubscriberEntry = {
      cb,
      sceneId: options?.sceneId ?? null,
    };
    this._subscribers.add(entry);
    return () => {
      this._subscribers.delete(entry);
    };
  }

  /** True when a token with this key is currently inflight. */
  isInflight(key: string): boolean {
    return this._inflight.has(key);
  }

  /**
   * Total number of currently inflight tokens (foreground + background).
   * Read by debug overlays. Scene's `shouldRender` gate uses
   * `pendingForegroundCount` instead so background warmup work doesn't
   * keep frames rendering.
   */
  get pendingCount(): number {
    return this._inflight.size;
  }

  /**
   * Number of currently inflight foreground-priority tokens. This is
   * what Scene's `shouldRender` gate reads as the defense-in-depth
   * check that keeps frames rendering until foreground work resolves.
   * Background warmup work is excluded so the scene can hibernate
   * during speculative pre-cooking and wake only on resolution.
   */
  get pendingForegroundCount(): number {
    let count = 0;
    for (const token of this._inflight.values()) {
      if (token.priority === "foreground") count++;
    }
    return count;
  }

  /**
   * Per-kind inflight breakdown. Allocates a fresh object per call;
   * suitable for debug overlays, not for per-frame hot paths.
   */
  get pendingByKind(): Record<AsyncResourceKind, number> {
    const counts: Record<AsyncResourceKind, number> = {
      "render-pipeline": 0,
      "compute-pipeline": 0,
      "shader-module": 0,
      "texture-upload": 0,
      "image-decode": 0,
      "buffer-map": 0,
    };
    for (const token of this._inflight.values()) {
      counts[token.kind]++;
    }
    return counts;
  }

  getStats(): AsyncResourceMonitorStats {
    return {
      resolved: this._resolvedCount,
      rejected: this._rejectedCount,
      peakInflight: this._peakInflight,
      currentInflight: this._inflight.size,
      subscribers: this._subscribers.size,
    };
  }

  private _emit(event: AsyncResourceEvent): void {
    if (this._subscribers.size === 0) return;
    // Snapshot subscribers so a callback that unsubscribes itself
    // mid-fanout doesn't mutate the iteration.
    const subs = Array.from(this._subscribers);
    const owners = event.token.ownerSceneIds;
    for (let i = 0; i < subs.length; i++) {
      const entry = subs[i];
      // Phase 6 — filter dispatch when both sides have an attribution
      // claim. If the token specifies owners AND the subscriber has a
      // sceneId, only fire when the subscriber's id is in the owner
      // set. Either side missing → always fire (matches the legacy /
      // shared-resource semantics).
      if (owners && entry.sceneId !== null && !owners.has(entry.sceneId)) {
        continue;
      }
      try {
        entry.cb(event);
      } catch (err) {
        console.error(
          `[CesiumJS:webgpu:ctx-${this._contextId}] AsyncResourceMonitor subscriber threw:`,
          err,
        );
      }
    }
  }
}

/**
 * Wrap a direct `device.createComputePipelineAsync` call with monitor
 * begin/resolve/reject. Used by renderers that don't go through the
 * central `WebGPUComputePipelineCache` (gpu culler, decoupled scan,
 * point-cloud LOD, compute engine's freeform pipeline factory) so
 * their inflight pipelines still publish wakeup events.
 *
 * `keyHint` is a stable per-call-site label appended to a monotonic
 * counter. Concurrent calls from the same site never dedupe — they
 * are independent units of work even when descriptor labels match.
 *
 * @internal
 */
let _directComputeCounter = 0;
export async function trackComputePipelineCreation(
  monitor: AsyncResourceMonitor | null | undefined,
  device: GPUDevice,
  descriptor: GPUComputePipelineDescriptor,
  keyHint: string,
): Promise<GPUComputePipeline> {
  const id = ++_directComputeCounter;
  const token = monitor?.begin({
    kind: "compute-pipeline",
    key: `compute-direct|${keyHint}|${id}`,
    label:
      typeof descriptor.label === "string" && descriptor.label.length > 0
        ? descriptor.label
        : keyHint,
  });
  try {
    const pipeline = await device.createComputePipelineAsync(descriptor);
    if (token) monitor!.resolve(token);
    return pipeline;
  } catch (error) {
    if (token) monitor!.reject(token, error);
    throw error;
  }
}

export default AsyncResourceMonitor;
