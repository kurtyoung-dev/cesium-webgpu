/**
 * Encapsulates GPU device loss detection and automatic recovery logic.
 * When the GPU device is lost (driver crash, tab backgrounding, etc.),
 * this module handles retry with exponential backoff and state cleanup.
 *
 * Extracted from WebGPUContext to keep the main context file focused on
 * core frame and rendering management.
 *
 * @see WebGPUContext
 * @module WebGPUDeviceLossRecovery
 */

/// <reference types="@webgpu/types" />

import { WebGPUDevicePool } from "./WebGPUDevicePool.js";

// ============================================================================
// Types & Enums
// ============================================================================

/**
 * Device loss recovery state
 */
export enum DeviceLossState {
  /** Device is healthy and operational */
  HEALTHY = "healthy",
  /** Device was lost, attempting recovery */
  RECOVERING = "recovering",
  /** Device recovery failed, context is dead */
  FATAL = "fatal",
}

/**
 * Callback type for device loss events
 */
export type DeviceLostCallback = (info: {
  reason: string;
  message: string;
  state: DeviceLossState;
  willRecover: boolean;
}) => void;

/**
 * Interface that the owning context must implement so the recovery manager
 * can re-initialize GPU state after a successful recovery.
 */
export interface DeviceLossRecoveryHost {
  /** The current GPU adapter */
  readonly _adapter: GPUAdapter | null;
  /** The current GPU device */
  readonly _device: GPUDevice | null;
  /** Whether the context has been destroyed */
  _isDestroyed: boolean;
  /** Device is permanently unusable, but resource teardown has not run yet. */
  _isTerminallyLost: boolean;
  /** Context options (power preference, features, limits) */
  readonly _options: {
    powerPreference?: GPUPowerPreference;
    featureLevel?: "core" | "compatibility";
    requiredFeatures?: GPUFeatureName[];
    requiredLimits?: Record<string, number>;
    useDevicePool?: boolean;
  };
  /**
   * True when the pre-loss device came from `WebGPUDevicePool`. The recovery
   * path
   * routes through the pool when this is set so concurrent per-context
   * recoveries dedup to a single new shared primary, preserving
   * cross-context sharing across the loss event. False contexts
   * recover via the legacy `adapter.requestDevice` direct path.
   * Writable because the recovery class flips it based on which path
   * was actually taken (pool fallback to direct on pool failure).
   */
  _deviceFromPool: boolean;
  /** Canvas context for reconfiguration */
  readonly _context: GPUCanvasContext | null;

  /** Set new adapter reference after recovery */
  _setAdapter(adapter: GPUAdapter | null): void;
  /** Set new device reference after recovery */
  _setDevice(device: GPUDevice | null): void;
  /** Re-initialize context limits from new device */
  _initializeContextLimits(): void;
  /** Re-configure canvas context with new device */
  _reconfigureCanvas(): void;
  /** Re-initialize default textures with new device */
  _initializeDefaultTextures(): void;
  /** Clear all stale GPU caches after device loss */
  _clearAllCaches(previousDevice?: GPUDevice | null): void;
  /**
   * Dispose context-owned resources created while initializing a candidate
   * that could not be committed. The candidate lease itself remains owned by
   * this recovery manager and is released separately.
   */
  _rollbackRecoveredDevice?(candidateDevice: GPUDevice): void;
  /** Drain the terminally-lost context after the active recovery settles. */
  _finalizeTerminalLoss?(): void;
}

interface RecoveryDeviceRequest {
  powerPreference?: GPUPowerPreference;
  featureLevel?: "core" | "compatibility";
  requiredFeatures?: GPUFeatureName[];
  requiredLimits?: Record<string, number>;
}

interface RecoveryAcquireResult {
  adapter: GPUAdapter;
  device: GPUDevice;
}

/**
 * Injectable async/device boundary used by deterministic lifecycle tests.
 * Production callers use the browser + singleton-pool defaults below.
 */
export interface DeviceLossRecoveryOperations {
  delay(milliseconds: number): Promise<void>;
  recoverPooledDevice(
    options: RecoveryDeviceRequest,
  ): Promise<RecoveryAcquireResult>;
  requestAdapter(options: GPURequestAdapterOptions): Promise<GPUAdapter | null>;
  releasePooledDevice(device: GPUDevice): void;
}

const defaultRecoveryOperations: DeviceLossRecoveryOperations = {
  delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  },
  recoverPooledDevice(
    options: RecoveryDeviceRequest,
  ): Promise<RecoveryAcquireResult> {
    return WebGPUDevicePool.instance.recoverDevice(options);
  },
  requestAdapter(
    options: GPURequestAdapterOptions,
  ): Promise<GPUAdapter | null> {
    return navigator.gpu.requestAdapter(options);
  },
  releasePooledDevice(device: GPUDevice): void {
    WebGPUDevicePool.instance.releaseDevice(device);
  },
};

type RecoveryCandidateState = "owned" | "committed" | "released";

/**
 * One exact ownership token for an acquired recovery candidate. Pool-backed
 * tokens return one refcount; isolated tokens destroy one device. Marking the
 * state before teardown makes cleanup idempotent even if a driver throws.
 */
class RecoveryCandidateLease {
  readonly adapter: GPUAdapter;
  readonly device: GPUDevice;
  readonly pooled: boolean;
  private readonly _operations: DeviceLossRecoveryOperations;
  private _state: RecoveryCandidateState = "owned";

  constructor(
    adapter: GPUAdapter,
    device: GPUDevice,
    pooled: boolean,
    operations: DeviceLossRecoveryOperations,
  ) {
    this.adapter = adapter;
    this.device = device;
    this.pooled = pooled;
    this._operations = operations;
  }

  commit(): void {
    if (this._state === "owned") {
      this._state = "committed";
    }
  }

  release(): void {
    if (this._state !== "owned") {
      return;
    }
    this._state = "released";
    if (this.pooled) {
      this._operations.releasePooledDevice(this.device);
    } else {
      this.device.destroy();
    }
  }
}

interface RecoveryHostSnapshot {
  adapter: GPUAdapter | null;
  device: GPUDevice | null;
  deviceFromPool: boolean;
  isDestroyed: boolean;
  isTerminallyLost: boolean;
}

// ============================================================================
// Recovery Manager
// ============================================================================

/**
 * Manages GPU device loss detection, notification, and automatic recovery.
 *
 * Usage:
 * ```ts
 * const recovery = new WebGPUDeviceLossRecovery(host);
 * recovery.setupHandler(device);
 *
 * const unsub = recovery.onDeviceLost((info) => {
 *   console.log(info.state, info.message);
 * });
 * ```
 */
export class WebGPUDeviceLossRecovery {
  private _host: DeviceLossRecoveryHost;
  private _state: DeviceLossState = DeviceLossState.HEALTHY;
  private _callbacks: DeviceLostCallback[] = [];
  private _maxAttempts: number;
  private _attempts: number = 0;
  /**
   * The currently-in-flight recovery promise, if any. Stored so destroy()
   * can await or signal cancellation rather than detaching mid-recovery
   * (which would leave the recovered device alive without an owner —
   * latent memory + crash-on-write hazard).
   */
  private _activeRecovery: Promise<void> | null = null;
  private _aborted: boolean = false;
  private _queuedRecovery: boolean = false;
  private _terminalFinalizationPending: boolean = false;
  private readonly _operations: DeviceLossRecoveryOperations;

  /**
   * @param host - The owning context that implements recovery hooks
   * @param maxAttempts - Maximum number of recovery attempts (default: 3)
   * @param operations - Optional async/device seams for deterministic tests
   */
  constructor(
    host: DeviceLossRecoveryHost,
    maxAttempts: number = 3,
    operations: Partial<DeviceLossRecoveryOperations> = {},
  ) {
    this._host = host;
    this._maxAttempts = maxAttempts;
    this._operations = {
      delay: operations.delay ?? defaultRecoveryOperations.delay,
      recoverPooledDevice:
        operations.recoverPooledDevice ??
        defaultRecoveryOperations.recoverPooledDevice,
      requestAdapter:
        operations.requestAdapter ?? defaultRecoveryOperations.requestAdapter,
      releasePooledDevice:
        operations.releasePooledDevice ??
        defaultRecoveryOperations.releasePooledDevice,
    };
  }

  /** Current device loss state */
  get state(): DeviceLossState {
    return this._state;
  }

  /** Number of recovery attempts made so far */
  get attempts(): number {
    return this._attempts;
  }

  /**
   * Set up the device lost event handler with recovery strategy.
   *
   * Recovery strategy:
   * 1. Notify all registered callbacks immediately
   * 2. If reason is "destroyed" (intentional), mark as FATAL — no recovery
   * 3. Otherwise, attempt recovery up to maxAttempts times
   * 4. On successful recovery, re-initialize context limits, textures, and caches
   * 5. On failure, mark as FATAL and notify callbacks
   *
   * @param device - The GPU device to monitor
   */
  setupHandler(device: GPUDevice): void {
    device.lost.then((info: GPUDeviceLostInfo) => {
      const reason = (info.reason as string) ?? "unknown";
      const message = info.message ?? "Device lost";

      // Context.destroy() flips `_aborted` before destroying the device and
      // performs the actual teardown synchronously. Its eventual lost Promise
      // must not relabel that already-drained context as merely terminal-lost.
      if (this._aborted || this._host._isDestroyed) {
        this._state = DeviceLossState.FATAL;
        return;
      }

      console.error(`[WebGPU] Device lost (reason: ${reason}): ${message}`);

      // A device can also be destroyed externally through context.device.
      // That makes rendering terminally unavailable, but it is not equivalent
      // to WebGPUContext.destroy(): explicit context teardown must still run.
      if (reason === "destroyed") {
        this._state = DeviceLossState.FATAL;
        this._host._isTerminallyLost = true;
        this._notify(reason, message, DeviceLossState.FATAL, false);
        this._requestTerminalFinalization();
        return;
      }

      // Skip recovery if another terminal loss was already published while we
      // were waiting for this device-lost promise.
      if (this._host._isTerminallyLost) {
        this._state = DeviceLossState.FATAL;
        return;
      }

      // Attempt recovery — store the promise so destroy() can await it
      this._state = DeviceLossState.RECOVERING;
      this._notify(reason, message, DeviceLossState.RECOVERING, true);
      this._scheduleRecovery(reason);
    });
  }

  /**
   * Start recovery after any generation that is still committing. A newly
   * acquired device can itself be lost before the prior `_runRecovery`
   * continuation publishes HEALTHY; serializing here prevents that older
   * continuation from overwriting/clobbering the newer recovery state.
   */
  private _scheduleRecovery(reason: string): void {
    const active = this._activeRecovery;
    if (active) {
      this._queuedRecovery = true;
      const startAfterActive = (): void => {
        if (!this._shouldAbort()) {
          this._queuedRecovery = false;
          this._startRecovery(reason);
        }
      };
      void active.then(startAfterActive, startAfterActive);
      return;
    }
    this._queuedRecovery = false;
    this._startRecovery(reason);
  }

  private _startRecovery(reason: string): void {
    if (this._shouldAbort()) {
      this._state = DeviceLossState.FATAL;
      return;
    }

    this._state = DeviceLossState.RECOVERING;
    const active = this._runRecovery(reason);
    this._activeRecovery = active;
    const clearIfCurrent = (): void => {
      if (this._activeRecovery === active) {
        this._activeRecovery = null;
        if (this._terminalFinalizationPending) {
          this._terminalFinalizationPending = false;
          this._finalizeTerminalLoss();
        }
      }
    };
    void active.then(clearIfCurrent, clearIfCurrent);
  }

  /**
   * Internal recovery driver. Wraps _attemptRecovery so the in-flight
   * promise can be tracked and awaited from destroy().
   */
  private async _runRecovery(reason: string): Promise<void> {
    const recovered = await this._attemptRecovery();

    if (this._shouldAbort()) {
      // Caller torn down during recovery, or the candidate was itself
      // intentionally destroyed before commit publication.
      this._state = DeviceLossState.FATAL;
      return;
    }

    // The candidate's loss handler ran before this generation could publish
    // HEALTHY. Leave the already-published RECOVERING state intact; the queued
    // generation starts as soon as this promise settles.
    if (this._queuedRecovery) {
      return;
    }

    if (recovered) {
      this._host._isTerminallyLost = false;
      this._state = DeviceLossState.HEALTHY;
      this._attempts = 0;
      //>>includeStart('debug', pragmas.debug);
      console.log("[WebGPU] Device recovery successful");
      //>>includeEnd('debug');
      this._notify(
        "recovered",
        "Device recovered successfully",
        DeviceLossState.HEALTHY,
        false,
      );
    } else {
      this._state = DeviceLossState.FATAL;
      // FATAL describes device availability, not completed context teardown.
      // Keep `_isDestroyed` false so the public destroy() path can drain old-
      // generation wrappers, listeners, pool refs, and canvas state once.
      this._host._isTerminallyLost = true;
      console.error(
        "[WebGPU] Device recovery failed — context is permanently lost",
      );
      this._notify(
        reason,
        "Recovery failed after maximum attempts",
        DeviceLossState.FATAL,
        false,
      );
      this._requestTerminalFinalization();
    }
  }

  private _requestTerminalFinalization(): void {
    if (!this._host._finalizeTerminalLoss) {
      return;
    }
    if (this._activeRecovery) {
      this._terminalFinalizationPending = true;
      return;
    }
    queueMicrotask(() => this._finalizeTerminalLoss());
  }

  private _finalizeTerminalLoss(): void {
    if (this._host._isDestroyed || !this._host._isTerminallyLost) {
      return;
    }
    this._host._finalizeTerminalLoss?.();
  }

  /**
   * Cancel any in-flight recovery and wait for it to settle. Called from
   * the host's destroy() so we don't leak a half-recovered device.
   */
  async dispose(): Promise<void> {
    this._aborted = true;
    const active = this._activeRecovery;
    if (active) {
      await active.catch(() => {
        /* swallow — we're being destroyed */
      });
    }
    this._callbacks.length = 0;
  }

  /**
   * Register a callback for device loss events.
   *
   * @param callback - Callback to invoke on device loss
   * @returns A function to unregister the callback
   */
  onDeviceLost(callback: DeviceLostCallback): () => void {
    this._callbacks.push(callback);
    return () => {
      const index = this._callbacks.indexOf(callback);
      if (index >= 0) this._callbacks.splice(index, 1);
    };
  }

  // --------------------------------------------------------------------------
  // Private
  // --------------------------------------------------------------------------

  /**
   * Attempt to recover from device loss by re-requesting the adapter and device.
   * Uses exponential backoff: 500ms, 1s, 2s, etc.
   */
  private async _attemptRecovery(): Promise<boolean> {
    // This snapshot remains the rollback target for every attempt. In
    // particular, never snapshot after a candidate is published: doing so
    // turns a failed retry into its own "previous" generation and loses the
    // only reference to the original host state.
    const previous: RecoveryHostSnapshot = {
      adapter: this._host._adapter,
      device: this._host._device,
      deviceFromPool: this._host._deviceFromPool,
      isDestroyed: this._host._isDestroyed,
      isTerminallyLost: this._host._isTerminallyLost,
    };

    for (let attempt = 1; attempt <= this._maxAttempts; attempt++) {
      if (this._shouldAbort()) {
        return false;
      }

      this._attempts = attempt;
      //>>includeStart('debug', pragmas.debug);
      console.log(
        `[WebGPU] Recovery attempt ${attempt}/${this._maxAttempts}...`,
      );
      //>>includeEnd('debug');

      let candidate: RecoveryCandidateLease | null = null;
      let hostMutated = false;
      try {
        // Exponential backoff
        await this._operations.delay(500 * Math.pow(2, attempt - 1));

        // dispose() flips `_aborted` synchronously. Check immediately after
        // every await so destroy-during-backoff never even starts acquisition.
        if (this._shouldAbort()) {
          return false;
        }

        candidate = await this._acquireCandidate(
          attempt,
          previous.deviceFromPool,
        );
        if (!candidate) {
          if (this._shouldAbort()) {
            return false;
          }
          continue;
        }

        // Acquisition itself is asynchronous. A candidate that arrives after
        // destroy is still our lease, but it must be returned/destroyed before
        // any host field, cache, canvas, or effects owner can observe it.
        if (this._shouldAbort()) {
          this._releaseCandidate(candidate);
          return false;
        }

        // Candidate promotion is synchronous from here through commit. Mark
        // the first write so any throwing setter/hook restores the complete
        // prior host tuple before the candidate lease is released.
        hostMutated = true;
        this._host._setAdapter(candidate.adapter);
        this._host._setDevice(candidate.device);
        this._host._deviceFromPool = candidate.pooled;
        this._host._isDestroyed = false;
        this._host._isTerminallyLost = false;

        // Re-initialize against the candidate. No device-lost handler is
        // attached until every hook succeeds, so destroying a failed isolated
        // candidate cannot recursively start another recovery.
        this._host._initializeContextLimits();
        this._throwIfAbortedDuringPromotion();
        this._host._reconfigureCanvas();
        this._throwIfAbortedDuringPromotion();
        this._host._initializeDefaultTextures();
        this._throwIfAbortedDuringPromotion();
        this._host._clearAllCaches(previous.device);
        this._throwIfAbortedDuringPromotion();

        // Only a fully initialized generation becomes host-owned. Context
        // destroy now performs the eventual pool release/direct destroy.
        this.setupHandler(candidate.device);
        candidate.commit();

        //>>includeStart('debug', pragmas.debug);
        console.log(
          `[WebGPU] Recovery attempt ${attempt}: SUCCESS ` +
            `(${candidate.pooled ? "pool-shared" : "isolated"} device)`,
        );
        //>>includeEnd('debug');
        return true;
      } catch (error) {
        if (candidate) {
          if (
            hostMutated &&
            this._candidateWasReleasedByDestroyedHost(candidate)
          ) {
            // A synchronous invalidation subscriber called Context.destroy().
            // That path already consumed the published candidate exactly once.
            candidate.commit();
          } else if (hostMutated) {
            this._rollbackPromotion(candidate, previous);
          } else {
            this._releaseCandidate(candidate);
          }
        }

        if (this._shouldAbort()) {
          return false;
        }

        // lint-debug-pragmas-allow: permanent device-loss recovery-attempt sentinel (CLAUDE.md)
        console.warn(
          `[WebGPU] Recovery attempt ${attempt} failed:`,
          (error as Error).message,
        );
      }
    }

    return false;
  }

  private async _acquireCandidate(
    attempt: number,
    previousDeviceFromPool: boolean,
  ): Promise<RecoveryCandidateLease | null> {
    // Pool routing preserves cross-context sharing. Each successful acquire is
    // one refcount lease, even when another recovering context created the
    // underlying replacement device.
    if (previousDeviceFromPool && this._host._options.useDevicePool !== false) {
      try {
        const acquired = await this._operations.recoverPooledDevice({
          powerPreference: this._host._options.powerPreference,
          featureLevel: this._host._options.featureLevel,
          requiredFeatures: this._host._options.requiredFeatures,
          requiredLimits: this._host._options.requiredLimits,
        });
        return new RecoveryCandidateLease(
          acquired.adapter,
          acquired.device,
          true,
          this._operations,
        );
      } catch (poolError) {
        if (this._shouldAbort()) {
          return null;
        }
        // lint-debug-pragmas-allow: permanent device-loss recovery-attempt sentinel (CLAUDE.md — recovery failures must reach the console)
        console.warn(
          `[WebGPU] Pool-routed recovery failed, falling back to direct: ${(poolError as Error).message}`,
        );
      }
    }

    if (this._shouldAbort()) {
      return null;
    }

    // Direct path — used for externally-owned/unpooled contexts or as the
    // best-effort fallback when pool acquisition fails.
    const adapter = await this._operations.requestAdapter({
      powerPreference:
        this._host._options.powerPreference ?? "high-performance",
    });

    // Adapters have no destroy/release API. If teardown landed while the
    // request was pending, stop before requesting a device.
    if (this._shouldAbort()) {
      return null;
    }
    if (!adapter) {
      // lint-debug-pragmas-allow: permanent device-loss recovery-attempt sentinel (CLAUDE.md)
      console.warn(
        `[WebGPU] Recovery attempt ${attempt}: No adapter available`,
      );
      return null;
    }

    const device = await adapter.requestDevice({
      requiredFeatures: this._host._options.requiredFeatures ?? [],
      requiredLimits: this._host._options.requiredLimits ?? {},
    });
    return new RecoveryCandidateLease(adapter, device, false, this._operations);
  }

  private _shouldAbort(): boolean {
    return (
      this._aborted || this._host._isDestroyed || this._host._isTerminallyLost
    );
  }

  private _throwIfAbortedDuringPromotion(): void {
    if (this._shouldAbort()) {
      throw new Error("Device recovery aborted during candidate promotion");
    }
  }

  private _candidateWasReleasedByDestroyedHost(
    candidate: RecoveryCandidateLease,
  ): boolean {
    return (
      this._aborted &&
      this._host._isDestroyed &&
      this._host._device !== candidate.device
    );
  }

  private _rollbackPromotion(
    candidate: RecoveryCandidateLease,
    previous: RecoveryHostSnapshot,
  ): void {
    try {
      try {
        this._host._rollbackRecoveredDevice?.(candidate.device);
      } catch (rollbackError) {
        // lint-debug-pragmas-allow: permanent device-loss recovery cleanup sentinel (CLAUDE.md)
        console.warn(
          "[WebGPU] Candidate resource rollback failed:",
          (rollbackError as Error).message,
        );
      }

      this._host._setAdapter(previous.adapter);
      this._host._setDevice(previous.device);
      this._host._deviceFromPool = previous.deviceFromPool;
      this._host._isDestroyed = previous.isDestroyed;
      this._host._isTerminallyLost = previous.isTerminallyLost;
    } finally {
      this._releaseCandidate(candidate);
    }
  }

  private _releaseCandidate(candidate: RecoveryCandidateLease): void {
    try {
      candidate.release();
    } catch (releaseError) {
      // The lease marks itself released before invoking the driver/pool, so a
      // throwing teardown is reported but never retried as a double release.
      // lint-debug-pragmas-allow: permanent device-loss recovery cleanup sentinel (CLAUDE.md)
      console.warn(
        "[WebGPU] Candidate device release failed:",
        (releaseError as Error).message,
      );
    }
  }

  /** Notify all registered callbacks */
  private _notify(
    reason: string,
    message: string,
    state: DeviceLossState,
    willRecover: boolean,
  ): void {
    const info = { reason, message, state, willRecover };
    for (const callback of this._callbacks) {
      try {
        callback(info);
      } catch (err) {
        console.error("[WebGPU] Error in device lost callback:", err);
      }
    }
  }
}

export default WebGPUDeviceLossRecovery;
