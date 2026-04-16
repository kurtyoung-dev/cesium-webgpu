/**
 * @module WebGPUDeviceLossRecovery
 *
 * Encapsulates GPU device loss detection and automatic recovery logic.
 * When the GPU device is lost (driver crash, tab backgrounding, etc.),
 * this module handles retry with exponential backoff and state cleanup.
 *
 * Extracted from WebGPUContext to keep the main context file focused on
 * core frame and rendering management.
 *
 * @see WebGPUContext
 */

/// <reference types="@webgpu/types" />

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
  /** Context options (power preference, features, limits) */
  readonly _options: {
    powerPreference?: GPUPowerPreference;
    requiredFeatures?: GPUFeatureName[];
    requiredLimits?: Record<string, number>;
  };
  /** Canvas context for reconfiguration */
  readonly _context: GPUCanvasContext | null;

  /** Set new adapter reference after recovery */
  _setAdapter(adapter: GPUAdapter): void;
  /** Set new device reference after recovery */
  _setDevice(device: GPUDevice): void;
  /** Re-initialize context limits from new device */
  _initializeContextLimits(): void;
  /** Re-configure canvas context with new device */
  _reconfigureCanvas(): void;
  /** Re-initialize default textures with new device */
  _initializeDefaultTextures(): void;
  /** Clear all stale GPU caches after device loss */
  _clearAllCaches(): void;
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

  /**
   * @param host - The owning context that implements recovery hooks
   * @param maxAttempts - Maximum number of recovery attempts (default: 3)
   */
  constructor(host: DeviceLossRecoveryHost, maxAttempts: number = 3) {
    this._host = host;
    this._maxAttempts = maxAttempts;
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

      console.error(`[WebGPU] Device lost (reason: ${reason}): ${message}`);

      // Intentional destruction — no recovery
      if (reason === "destroyed") {
        this._state = DeviceLossState.FATAL;
        this._host._isDestroyed = true;
        this._notify(reason, message, DeviceLossState.FATAL, false);
        return;
      }

      // Skip recovery if a destroy() has already been requested while we
      // were waiting for the device-lost promise. Without this, recovery
      // would resurrect a context the caller has already torn down.
      if (this._aborted || this._host._isDestroyed) {
        this._state = DeviceLossState.FATAL;
        return;
      }

      // Attempt recovery — store the promise so destroy() can await it
      this._state = DeviceLossState.RECOVERING;
      this._notify(reason, message, DeviceLossState.RECOVERING, true);
      this._activeRecovery = this._runRecovery(reason);
    });
  }

  /**
   * Internal recovery driver. Wraps _attemptRecovery so the in-flight
   * promise can be tracked and awaited from destroy().
   */
  private async _runRecovery(reason: string): Promise<void> {
    try {
      const recovered = await this._attemptRecovery();

      if (this._aborted) {
        // Caller torn down during recovery; do not promote new device
        this._state = DeviceLossState.FATAL;
        return;
      }

      if (recovered) {
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
        this._host._isDestroyed = true;
        console.error(
          "[WebGPU] Device recovery failed — context is permanently lost",
        );
        this._notify(
          reason,
          "Recovery failed after maximum attempts",
          DeviceLossState.FATAL,
          false,
        );
      }
    } finally {
      this._activeRecovery = null;
    }
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
    for (let attempt = 1; attempt <= this._maxAttempts; attempt++) {
      this._attempts = attempt;
      //>>includeStart('debug', pragmas.debug);
      console.log(
        `[WebGPU] Recovery attempt ${attempt}/${this._maxAttempts}...`,
      );
      //>>includeEnd('debug');

      try {
        // Exponential backoff
        await new Promise((resolve) =>
          setTimeout(resolve, 500 * Math.pow(2, attempt - 1)),
        );

        // Re-request adapter
        const adapter = await navigator.gpu.requestAdapter({
          powerPreference:
            this._host._options.powerPreference ?? "high-performance",
        });

        if (!adapter) {
          console.warn(
            `[WebGPU] Recovery attempt ${attempt}: No adapter available`,
          );
          continue;
        }

        // Re-request device
        const device = await adapter.requestDevice({
          requiredFeatures: this._host._options.requiredFeatures ?? [],
          requiredLimits: this._host._options.requiredLimits ?? {},
        });

        // Store new references via host interface
        this._host._setAdapter(adapter);
        this._host._setDevice(device);
        this._host._isDestroyed = false;

        // Set up handler for the NEW device
        this.setupHandler(device);

        // Re-initialize everything via host
        this._host._initializeContextLimits();
        this._host._reconfigureCanvas();
        this._host._initializeDefaultTextures();
        this._host._clearAllCaches();

        //>>includeStart('debug', pragmas.debug);
        console.log(`[WebGPU] Recovery attempt ${attempt}: SUCCESS`);
        //>>includeEnd('debug');
        return true;
      } catch (error) {
        console.warn(
          `[WebGPU] Recovery attempt ${attempt} failed:`,
          (error as Error).message,
        );
      }
    }

    return false;
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
