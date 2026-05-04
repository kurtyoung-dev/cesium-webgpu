/**
 * @module WebGPUDevicePool
 *
 * Strategy B: WebGPU Device Sharing — One GPUDevice, Multiple Canvases.
 *
 * AUDIT_2026_05_02 C.1 — **Status: ACTIVE (adopted Batch 135).**
 * `WebGPUContext._initialize` routes adapter + device acquisition
 * through `WebGPUDevicePool.instance.acquireDevice(...)`. The pool owns
 * the adaptive limit / feature negotiation that used to live inline in
 * the context init: it inspects the adapter's exposed ceilings, scales
 * the requested limits up (capped at sane upper bounds), and merges the
 * `WebGPUFeatureFlags.DESIRED_FEATURES` list with any user-supplied
 * `requiredFeatures` before calling `requestDevice`.
 *
 * Batch 135 re-audit fixes (Path A — full correctness on the
 * capability-keyed sharing model):
 *
 *   1. **Concurrent-acquire race**: in-flight `_pendingPrimary` Promise
 *      dedups concurrent first-time acquires. Without this, two
 *      `WebGPUContext._initialize` calls in the same tick would both
 *      observe `_primaryDevice === null` and both create a device,
 *      orphaning one with refCount=1 nobody pool-references.
 *
 *   2. **featureLevel in compat check**: a `"core"` requester never
 *      shares a `"compatibility"` primary (or vice-versa) — those have
 *      fundamentally different adapter capability sets.
 *
 *   3. **Lost-primary eviction**: the device-loss handler clears the
 *      slot so a new acquire replaces the lost primary instead of
 *      being relegated to `_additionalDevices` forever.
 *
 *   4. **Full-spec limits snapshot**: tracks every WebGPU spec limit
 *      (~30 entries) on the pooled device so a context requiring
 *      `maxColorAttachments: 8` against a primary with default 4
 *      gets its own device instead of sharing one that doesn't meet
 *      the requirement. Min-style limits
 *      (`minUniformBufferOffsetAlignment`, etc.) are compared
 *      `enabled <= required` (smaller alignment = more capable);
 *      max-style limits are `enabled >= required`.
 *
 *   5. **Recovery routes through the pool**: `WebGPUDeviceLossRecovery`
 *      calls `pool.acquireDevice(originalOptions)` when the lost
 *      device was pool-managed. Concurrent per-context recoveries
 *      dedup via `_pendingPrimary` to a single new shared primary,
 *      preserving cross-context sharing across the loss event.
 *
 * WebGPU allows a single GPUDevice to configure multiple GPUCanvasContexts.
 * GPU resources (buffers, textures, pipelines, bind groups) created on
 * one device are usable from every canvas configured with that device.
 *
 * This is the optimal strategy for multi-view WebGPU scenarios:
 * - Split-screen: Two canvases, one device → ~50% GPU memory savings
 * - Multi-monitor: Each output canvas configured with the same device
 * - Picture-in-picture: Main canvas + thumbnail canvas sharing resources
 *
 * ## How It Works
 * ```
 * GPUAdapter → GPUDevice (ONE instance)
 *   ├─ Canvas A → canvasA.getContext('webgpu').configure({ device })
 *   ├─ Canvas B → canvasB.getContext('webgpu').configure({ device })
 *   └─ All GPU resources (buffers, textures, pipelines) shared automatically
 * ```
 *
 * ## Usage
 * ```typescript
 * const pool = WebGPUDevicePool.instance;
 *
 * // First context requests a device — pool creates it
 * const { device, adapter } = await pool.acquireDevice();
 *
 * // Second context requests a device — pool returns the SAME one
 * const { device: sameDevice } = await pool.acquireDevice();
 * console.assert(device === sameDevice); // true!
 *
 * // Configure each canvas with the shared device
 * canvasA.getContext('webgpu').configure({ device, format });
 * canvasB.getContext('webgpu').configure({ device, format });
 *
 * // When the context tears down, release the reference. Device is
 * // destroyed only when refCount hits zero.
 * pool.releaseDevice(device);
 * ```
 *
 * @see SharedResourcePool
 * @see ContextRegistry
 */

import { WebGPUFeatureFlags, DESIRED_FEATURES } from "./WebGPUFeatureFlags.js";

/**
 * Adaptive limit ceilings used by the pool's negotiator. Values match
 * the inline negotiation that used to live in `WebGPUContext._initialize`:
 * the request is `min(adapter.limits[name], cap)` whenever the adapter's
 * value exceeds the WebGPU spec default. The caps prevent pathologically
 * large requests on adapters that expose huge ceilings (e.g., Pascal
 * exposes maxBindingsPerBindGroup=1000) — Cesium's actual usage today
 * fits within the per-cap limit and the cap leaves headroom for the
 * next-tier expansion without re-tuning per-stage budgets.
 *
 * Origin: `WebGPUContext._initialize` adaptive opt-in block (2026-04-30).
 * Hoisted to `WebGPUDevicePool` in Batch 135 per AUDIT_2026_05_02 C.1.
 */
const ADAPTIVE_LIMIT_CAPS: Readonly<Record<string, number>> = Object.freeze({
  maxSampledTexturesPerShaderStage: 64,
  maxBindingsPerBindGroup: 1000,
  // Model PBR pipeline needs ≤4 today; 8 is the next-tier upper bound.
  maxBindGroups: 8,
  maxUniformBuffersPerShaderStage: 24,
  maxStorageBuffersPerShaderStage: 16,
  maxSamplersPerShaderStage: 32,
});

/**
 * WebGPU spec defaults for the limits the pool adaptively scales. Used
 * to decide whether the adapter exposes "more than default" headroom
 * worth opting into. Spec source: WebGPU Working Draft, "Limits"
 * table (current as of 2026-04-30). Re-verify on Chromium version bumps.
 */
const SPEC_DEFAULT_LIMITS: Readonly<Record<string, number>> = Object.freeze({
  maxSampledTexturesPerShaderStage: 16,
  maxBindingsPerBindGroup: 640,
  maxBindGroups: 4,
  maxUniformBuffersPerShaderStage: 12,
  maxStorageBuffersPerShaderStage: 8,
  maxSamplersPerShaderStage: 16,
});

/**
 * Full enumeration of WebGPU spec limit names. Used by `snapshotLimits`
 * to capture every limit the device exposes, so the compat check can
 * answer "does this primary device meet a candidate's requirement?" for
 * any limit the user might pass (not just the ones we adaptively
 * negotiate). Sourced from the `GPUSupportedLimits` interface in the
 * WebGPU spec (current as of 2026-04-30); re-verify on spec revisions.
 *
 * Audit fix #4 (Batch 135) — previously only 9 limits were snapshotted,
 * leaving silent compat gaps for the other ~20.
 */
const ALL_WEBGPU_LIMITS: readonly string[] = Object.freeze([
  "maxTextureDimension1D",
  "maxTextureDimension2D",
  "maxTextureDimension3D",
  "maxTextureArrayLayers",
  "maxBindGroups",
  "maxBindGroupsPlusVertexBuffers",
  "maxBindingsPerBindGroup",
  "maxDynamicUniformBuffersPerPipelineLayout",
  "maxDynamicStorageBuffersPerPipelineLayout",
  "maxSampledTexturesPerShaderStage",
  "maxSamplersPerShaderStage",
  "maxStorageBuffersPerShaderStage",
  "maxStorageTexturesPerShaderStage",
  "maxUniformBuffersPerShaderStage",
  "maxUniformBufferBindingSize",
  "maxStorageBufferBindingSize",
  "minUniformBufferOffsetAlignment",
  "minStorageBufferOffsetAlignment",
  "maxVertexBuffers",
  "maxBufferSize",
  "maxVertexAttributes",
  "maxVertexBufferArrayStride",
  "maxInterStageShaderVariables",
  "maxColorAttachments",
  "maxColorAttachmentBytesPerSample",
  "maxComputeWorkgroupStorageSize",
  "maxComputeInvocationsPerWorkgroup",
  "maxComputeWorkgroupSizeX",
  "maxComputeWorkgroupSizeY",
  "maxComputeWorkgroupSizeZ",
  "maxComputeWorkgroupsPerDimension",
]);

/**
 * Min-style WebGPU limits where SMALLER values are MORE capable. The
 * device's enabled value must be `<=` the candidate's required value
 * for compat (e.g., a primary device with
 * `minUniformBufferOffsetAlignment = 32` satisfies any candidate
 * requiring `<= 64`). All other limits in `ALL_WEBGPU_LIMITS` are
 * max-style and use the inverse comparison.
 */
const MIN_STYLE_LIMITS: ReadonlySet<string> = new Set([
  "minUniformBufferOffsetAlignment",
  "minStorageBufferOffsetAlignment",
]);

/**
 * Options for device acquisition.
 */
export interface DeviceAcquisitionOptions {
  /**
   * Power preference for the GPU adapter.
   * @default 'high-performance'
   */
  powerPreference?: GPUPowerPreference;

  /**
   * WebGPU feature level. `"compatibility"` runs WebGPU on WebGL2
   * hardware via a restricted feature set; otherwise `"core"`.
   * @default 'core'
   */
  featureLevel?: "core" | "compatibility";

  /**
   * Required WebGPU features for the device. Merged with
   * `WebGPUFeatureFlags.DESIRED_FEATURES`; if the shared device doesn't
   * support a required feature, a new device is created.
   */
  requiredFeatures?: readonly GPUFeatureName[];

  /**
   * User-supplied required limits. Merged with the pool's adaptive
   * negotiation: any limit not present here is auto-scaled when the
   * adapter exposes more than the WebGPU spec default. User-supplied
   * values are NEVER lowered by the negotiator.
   */
  requiredLimits?: Record<string, number>;

  /**
   * When true, skip the adaptive limit/feature negotiation and pass
   * `requiredFeatures` + `requiredLimits` through verbatim. Use when a
   * caller wants byte-exact control (testing, benchmarking specific
   * limit configurations). Defaults to false (negotiation enabled).
   * @default false
   */
  skipAdaptiveNegotiation?: boolean;

  /**
   * Force creation of a NEW device instead of sharing.
   * Use when you need an isolated GPU context (e.g., for testing).
   * @default false
   */
  forceNewDevice?: boolean;
}

/**
 * Resolved acquisition result returned to callers.
 */
interface AcquireResult {
  device: GPUDevice;
  adapter: GPUAdapter;
  preferredFormat: GPUTextureFormat;
  isShared: boolean;
}

/**
 * A managed device entry in the pool.
 */
interface PooledDevice {
  device: GPUDevice;
  adapter: GPUAdapter;
  refCount: number;
  features: ReadonlySet<string>;
  /**
   * Snapshot of `device.limits` taken at creation. Used by the
   * compatibility check (see `limitsAreCompatible`) to verify a sharing
   * candidate's required limits are satisfied by the primary device's
   * actual enabled limits. Covers every WebGPU spec limit, not just the
   * ones we adaptively negotiate.
   */
  enabledLimits: Readonly<Record<string, number>>;
  /**
   * The featureLevel the device was created with. Tracked so the compat
   * check can refuse to share a `"compatibility"` device with a
   * `"core"` requester (and vice versa) — the two have fundamentally
   * different adapter capability sets and silently sharing produces
   * incorrect feature/limit assumptions in the requester.
   */
  featureLevel: "core" | "compatibility";
  /**
   * The full options used to create this device. Stored so the recovery
   * path can re-acquire with the same negotiation parameters when the
   * primary device is lost — preserving features + limits across the
   * recovery event so contexts that rebuild caches against the new
   * device see the same capabilities they did before.
   */
  originalOptions: DeviceAcquisitionOptions;
  isLost: boolean;
  lostReason?: string;
}

/**
 * Snapshot every WebGPU spec limit from the device's enabled limits.
 * Returns a plain Record so the compat check can do straight key
 * lookups without going back through the GPUSupportedLimits accessor.
 *
 * Limits the device doesn't enable (returned as 0 or undefined by the
 * accessor — implementation-defined) are stored as-is. The compat
 * check treats missing keys as 0 for max-style limits (failing closed
 * if a candidate requires > 0) and as +Infinity for min-style limits
 * (failing closed if a candidate requires a finite minimum).
 */
function snapshotLimits(
  deviceLimits: GPUSupportedLimits,
): Record<string, number> {
  const snapshot: Record<string, number> = {};
  for (const key of ALL_WEBGPU_LIMITS) {
    const value = (deviceLimits as unknown as Record<string, number>)[key];
    if (typeof value === "number") {
      snapshot[key] = value;
    }
  }
  return snapshot;
}

/**
 * Return true when every entry in `required` is satisfied by `enabled`.
 * Missing keys in `required` are treated as "no requirement" (pass).
 *
 * Comparison direction depends on limit kind:
 *   - **Max-style limits** (default): enabled value must be `>=`
 *     required value (a primary supporting `maxBindGroups=8` satisfies
 *     a candidate needing `>=4`).
 *   - **Min-style limits** (`MIN_STYLE_LIMITS`): enabled value must be
 *     `<=` required value (a primary requiring alignment of 32
 *     satisfies a candidate that can tolerate `<=64`).
 *
 * Audit fix #4 (Batch 135) — adds min-style handling. Previously all
 * limits used `enabled >= required`, which was wrong for the two
 * min-style alignment limits.
 */
function limitsAreCompatible(
  required: Record<string, number> | undefined,
  enabled: Readonly<Record<string, number>>,
): boolean {
  if (!required) return true;
  for (const [key, requiredValue] of Object.entries(required)) {
    if (MIN_STYLE_LIMITS.has(key)) {
      // Min-style: smaller is more capable. Enabled must be <= required.
      // Missing key in `enabled` defaults to +Infinity (no value =
      // worst possible alignment), failing the check.
      const enabledValue = enabled[key] ?? Number.POSITIVE_INFINITY;
      if (enabledValue > requiredValue) {
        return false;
      }
    } else {
      // Max-style: larger is more capable. Enabled must be >= required.
      // Missing key defaults to 0, failing the check unless requirement
      // is also 0.
      const enabledValue = enabled[key] ?? 0;
      if (enabledValue < requiredValue) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Pool that manages shared GPUDevice instances for multi-canvas WebGPU rendering.
 *
 * When multiple WebGPU contexts are needed (e.g., split-screen), this pool
 * ensures they share the same GPUDevice when their feature + limit
 * requirements are compatible. Sharing means GPU resources (buffers,
 * textures, pipelines) are usable across canvases — saving ~50% of GPU
 * memory compared to creating separate devices.
 */
export class WebGPUDevicePool {
  private static _instance: WebGPUDevicePool | null = null;

  /**
   * The primary shared device (most contexts will use this).
   */
  private _primaryDevice: PooledDevice | null = null;

  /**
   * Additional devices for special cases (e.g., different feature requirements).
   */
  private _additionalDevices: PooledDevice[] = [];

  /**
   * Audit fix #1 (Batch 135) — in-flight Promise for primary device
   * creation. Set when the first acquireDevice call starts creating the
   * primary; cleared when creation resolves (success or failure).
   * Concurrent acquireDevice callers see this set and await it instead
   * of starting their own creation, preventing the "two contexts
   * created simultaneously each spawn their own device" race that
   * defeats sharing exactly when it matters.
   */
  private _pendingPrimary: Promise<AcquireResult> | null = null;

  /**
   * Internal feature-flags helper used by the adaptive negotiator. The
   * pool keeps its own instance because per-context `WebGPUFeatureFlags`
   * are tied to that context's lifecycle; the pool's instance is only
   * used during negotiation and never exposed.
   */
  private _negotiatorFlags: WebGPUFeatureFlags = new WebGPUFeatureFlags();

  /**
   * Get the singleton instance.
   */
  static get instance(): WebGPUDevicePool {
    if (!WebGPUDevicePool._instance) {
      WebGPUDevicePool._instance = new WebGPUDevicePool();
    }
    return WebGPUDevicePool._instance;
  }

  /**
   * Check if WebGPU is available in this environment.
   */
  static get isWebGPUAvailable(): boolean {
    return typeof navigator !== "undefined" && "gpu" in navigator;
  }

  /**
   * Acquire a GPUDevice. If a shared device already exists and its
   * features + enabled limits + featureLevel cover the caller's
   * requirements, the same device is returned (refcount incremented).
   * Otherwise the pool negotiates against the adapter and creates a
   * new device.
   *
   * Concurrent first-time acquires deduplicate via `_pendingPrimary` so
   * two `WebGPUContext._initialize` calls in the same tick share the
   * same primary device instead of each creating their own.
   *
   * @param options - Device acquisition options
   * @returns The device and adapter, plus the preferred canvas format
   */
  async acquireDevice(
    options?: DeviceAcquisitionOptions,
  ): Promise<AcquireResult> {
    const opts = options ?? {};
    const requiredFeatures = opts.requiredFeatures ?? [];
    const requestedFeatureLevel: "core" | "compatibility" =
      opts.featureLevel ?? "core";

    // If forced new device, skip sharing entirely.
    if (opts.forceNewDevice) {
      return await this._createNewDevice(opts, false);
    }

    // Audit fix #1 (Batch 135) — if a primary creation is in flight,
    // wait for it then re-enter so we re-evaluate against the
    // (now-resolved) primary. This prevents the race where two
    // concurrent first-time acquires both observe `_primaryDevice ===
    // null` and both kick off their own _createNewDevice. The
    // re-entrant call path picks up the freshly-created primary on the
    // sharing path and increments refcount the normal way.
    if (this._pendingPrimary) {
      await this._pendingPrimary.catch(() => {
        /* swallow — recovery handled by initiator */
      });
      // Re-enter; if creation failed, primary stays null and the
      // re-entrant call will start a fresh creation below.
      return await this.acquireDevice(options);
    }

    // Try to reuse the primary device. Compatibility = featureLevel
    // match AND features subset AND limits subset. The limits check
    // covers the case where a second context requires a higher ceiling
    // than the first negotiated for — e.g., a Voxel-heavy Viewer
    // needing a larger maxBufferSize than the primary's negotiated
    // value. featureLevel must match exactly because "core" and
    // "compatibility" expose fundamentally different adapter
    // capability sets (audit fix #2, Batch 135).
    //
    // Acknowledged race window: between the browser's internal
    // device-loss decision and the resolution of `device.lost`
    // (microtask), `isLost` reads false. A concurrent `acquireDevice`
    // landing in this window grabs the dying device as a sharing
    // candidate. WebGPU's API gives no synchronous "device dying"
    // signal; the lost Promise IS the only signal and it resolves on
    // the microtask queue. In practice the window is sub-microsecond
    // (Promises resolve before subsequent JS turns) and the affected
    // context's own `device.lost` handler will trigger recovery the
    // next tick. We accept the window as an unfixable artifact of the
    // WebGPU async loss model.
    if (this._primaryDevice && !this._primaryDevice.isLost) {
      const featureLevelMatches =
        this._primaryDevice.featureLevel === requestedFeatureLevel;
      const supportsAllFeatures = requiredFeatures.every((f) =>
        this._primaryDevice!.features.has(f),
      );
      const supportsAllLimits = limitsAreCompatible(
        opts.requiredLimits,
        this._primaryDevice.enabledLimits,
      );

      if (featureLevelMatches && supportsAllFeatures && supportsAllLimits) {
        this._primaryDevice.refCount++;
        return {
          device: this._primaryDevice.device,
          adapter: this._primaryDevice.adapter,
          preferredFormat: navigator.gpu.getPreferredCanvasFormat(),
          isShared: true,
        };
      }
    }

    // Audit fix #3 (Batch 135) — treat lost primary as missing for
    // promotion. Without this, a primary that's been marked lost stays
    // in the slot and every subsequent acquire takes the
    // `isPrimary=false` branch, relegating new devices to
    // `_additionalDevices` forever (sharing never recovers post-loss).
    const isPrimary =
      this._primaryDevice === null || this._primaryDevice.isLost;

    if (isPrimary) {
      // Audit fix #1 (Batch 135) — capture the in-flight Promise so
      // concurrent callers can dedup. Resolved Promise is cleared in
      // the finally to allow subsequent acquires after this one
      // completes.
      this._pendingPrimary = this._createNewDevice(opts, true);
      try {
        return await this._pendingPrimary;
      } finally {
        this._pendingPrimary = null;
      }
    }

    return await this._createNewDevice(opts, false);
  }

  /**
   * Audit fix #5 (Batch 135) — recovery entry point used by
   * `WebGPUDeviceLossRecovery` after a pool-managed device is lost.
   * Routes through the pool so concurrent per-context recoveries
   * deduplicate: the first recovering context creates the new shared
   * primary; other contexts whose recovery handler fires concurrently
   * await the same `_pendingPrimary` Promise and (on re-entry) take
   * the sharing path against the freshly-created primary, each
   * incrementing refcount.
   *
   * Refcount accounting across loss + recovery:
   *
   *   - The lost device's `device.lost.then` handler in
   *     `_createNewDevice` already cleared the pool slot (set
   *     `_primaryDevice = null` if it WAS the primary, or removed the
   *     entry from `_additionalDevices`). So there's no stale
   *     refcount lingering in the pool — the slot is empty when the
   *     first recovering context arrives.
   *
   *   - Each recovering context calls `acquireDevice` once and gets
   *     one new refcount slot. N concurrent recoveries → 1 new shared
   *     primary with refCount=N. Each context's destroy will call
   *     `releaseDevice` on the new device handle, decrementing
   *     correctly. Destroying the last context destroys the new
   *     primary.
   *
   *   - The dead device handle held in each context's `_device` field
   *     is overwritten by `_setDevice(newDevice)` during recovery. No
   *     dangling references to the old dead handle remain.
   *
   * Pass the lost device's `originalOptions` (snapshotted at creation
   * and stored on the lost `PooledDevice`) so the new primary
   * negotiates with the same parameters — features + limits stay
   * consistent across the loss event so the rebuilt pipeline caches
   * will compile against the same capability set.
   *
   * @param originalOptions - The acquisition options used when the
   *   lost device was originally created. The recovering context
   *   reads these from its own stored options and forwards them.
   * @returns The recovered (possibly newly-created) device.
   */
  async recoverDevice(
    originalOptions: DeviceAcquisitionOptions,
  ): Promise<AcquireResult> {
    return await this.acquireDevice(originalOptions);
  }

  /**
   * Release a reference to a device. When refCount reaches zero,
   * the device is destroyed.
   *
   * @param device - The GPUDevice to release
   */
  releaseDevice(device: GPUDevice): void {
    // Check primary
    if (this._primaryDevice && this._primaryDevice.device === device) {
      this._primaryDevice.refCount--;
      if (this._primaryDevice.refCount <= 0) {
        // Skip `device.destroy()` if the device is already lost — the
        // browser destroyed it before the lost event fired and a
        // double-destroy throws on some implementations.
        if (!this._primaryDevice.isLost) {
          this._primaryDevice.device.destroy();
        }
        this._primaryDevice = null;
      }
      return;
    }

    // Check additional devices
    const idx = this._additionalDevices.findIndex((d) => d.device === device);
    if (idx >= 0) {
      this._additionalDevices[idx].refCount--;
      if (this._additionalDevices[idx].refCount <= 0) {
        if (!this._additionalDevices[idx].isLost) {
          this._additionalDevices[idx].device.destroy();
        }
        this._additionalDevices.splice(idx, 1);
      }
    }
  }

  /**
   * Get the number of active device references.
   */
  get activeDeviceCount(): number {
    let count = this._primaryDevice ? 1 : 0;
    count += this._additionalDevices.length;
    return count;
  }

  /**
   * Get the total reference count across all devices.
   */
  get totalRefCount(): number {
    let total = this._primaryDevice?.refCount ?? 0;
    for (const d of this._additionalDevices) {
      total += d.refCount;
    }
    return total;
  }

  /**
   * Check if the primary shared device is available and not lost.
   */
  get hasSharedDevice(): boolean {
    return this._primaryDevice !== null && !this._primaryDevice.isLost;
  }

  /**
   * Get diagnostic info about the device pool.
   */
  getDiagnostics(): {
    primaryDevice: {
      refCount: number;
      features: string[];
      enabledLimits: Readonly<Record<string, number>>;
      featureLevel: "core" | "compatibility";
      isLost: boolean;
    } | null;
    additionalDevices: number;
    totalRefCount: number;
    pendingPrimary: boolean;
  } {
    return {
      primaryDevice: this._primaryDevice
        ? {
            refCount: this._primaryDevice.refCount,
            features: Array.from(this._primaryDevice.features),
            enabledLimits: this._primaryDevice.enabledLimits,
            featureLevel: this._primaryDevice.featureLevel,
            isLost: this._primaryDevice.isLost,
          }
        : null,
      additionalDevices: this._additionalDevices.length,
      totalRefCount: this.totalRefCount,
      pendingPrimary: this._pendingPrimary !== null,
    };
  }

  /**
   * Run the adaptive limit + feature negotiator against an adapter.
   * Pure function over its inputs.
   *
   * @param adapter - The acquired GPUAdapter to inspect.
   * @param userOpts - User-supplied features + limits.
   * @returns Resolved features + limits ready for `requestDevice`.
   */
  private _negotiate(
    adapter: GPUAdapter,
    userOpts: DeviceAcquisitionOptions,
  ): {
    requiredFeatures: GPUFeatureName[];
    requiredLimits: Record<string, number>;
  } {
    // Features: merge user-required + DESIRED_FEATURES that the adapter
    // supports. WebGPUFeatureFlags.buildRequestList is the source of
    // truth — keeps a single canonical list across the codebase.
    const requiredFeatures = this._negotiatorFlags.buildRequestList(
      adapter,
      userOpts.requiredFeatures,
    );

    // Limits: start from user-supplied (never lowered), scale up the
    // negotiable limits when the adapter exposes more than spec default.
    const requiredLimits: Record<string, number> = {
      ...(userOpts.requiredLimits ?? {}),
    };

    if (!userOpts.skipAdaptiveNegotiation) {
      for (const [name, cap] of Object.entries(ADAPTIVE_LIMIT_CAPS)) {
        // Skip if the user already pinned this limit explicitly — caller
        // intent wins over auto-scaling.
        if (requiredLimits[name] !== undefined) continue;
        const adapterValue =
          (adapter.limits as unknown as Record<string, number>)[name] ??
          SPEC_DEFAULT_LIMITS[name];
        const specDefault = SPEC_DEFAULT_LIMITS[name];
        if (adapterValue > specDefault) {
          requiredLimits[name] = Math.min(adapterValue, cap);
        }
      }
    }

    return { requiredFeatures, requiredLimits };
  }

  /**
   * Create a new GPUDevice with the given options. Runs the adaptive
   * negotiator unless `opts.skipAdaptiveNegotiation` is set.
   * @private
   */
  private async _createNewDevice(
    opts: DeviceAcquisitionOptions,
    isPrimary: boolean,
  ): Promise<AcquireResult> {
    if (!WebGPUDevicePool.isWebGPUAvailable) {
      throw new Error("WebGPU is not available in this environment.");
    }

    const adapterOptions: GPURequestAdapterOptions = {
      powerPreference: opts.powerPreference ?? "high-performance",
    };
    if (opts.featureLevel === "compatibility") {
      // `featureLevel` is not yet in the @webgpu/types definitions but
      // Chromium accepts it on the request object. Stays type-correct
      // via the cast.
      (
        adapterOptions as GPURequestAdapterOptions & { featureLevel?: string }
      ).featureLevel = "compatibility";
    }

    const adapter = await navigator.gpu.requestAdapter(adapterOptions);

    if (!adapter) {
      throw new Error("Failed to get GPU adapter.");
    }

    const { requiredFeatures, requiredLimits } = this._negotiate(adapter, opts);

    const device = await adapter.requestDevice({
      requiredFeatures,
      requiredLimits,
    });

    const enabledLimits = snapshotLimits(device.limits);
    const featureLevel: "core" | "compatibility" = opts.featureLevel ?? "core";

    const pooled: PooledDevice = {
      device,
      adapter,
      refCount: 1,
      features: device.features,
      enabledLimits,
      featureLevel,
      // Snapshot the originating options so recovery can re-negotiate
      // with the same parameters. Audit fix #5 (Batch 135).
      originalOptions: { ...opts },
      isLost: false,
    };

    // Listen for device loss. Audit fix #3 (Batch 135) — clear the
    // primary slot when the lost device IS the primary so subsequent
    // acquires promote a fresh device into the slot. Other contexts
    // still hold pool references to the lost device; their
    // `releaseDevice` calls fall through to no-ops (device not in
    // primary slot, not in additionals — silently dropped, which is
    // correct since the underlying GPUDevice is already destroyed by
    // the browser).
    device.lost.then((info) => {
      pooled.isLost = true;
      pooled.lostReason = info.message;
      console.error(
        `[CesiumJS:WebGPUDevicePool] Device lost: ${info.reason} — ${info.message}`,
      );
      if (this._primaryDevice === pooled) {
        this._primaryDevice = null;
      } else {
        const idx = this._additionalDevices.indexOf(pooled);
        if (idx >= 0) {
          this._additionalDevices.splice(idx, 1);
        }
      }
    });

    if (isPrimary) {
      this._primaryDevice = pooled;
    } else {
      this._additionalDevices.push(pooled);
    }

    return {
      device,
      adapter,
      preferredFormat: navigator.gpu.getPreferredCanvasFormat(),
      isShared: false,
    };
  }

  /**
   * Destroy all devices and reset the pool.
   */
  destroyAll(): void {
    if (this._primaryDevice) {
      if (!this._primaryDevice.isLost) {
        this._primaryDevice.device.destroy();
      }
      this._primaryDevice = null;
    }
    for (const d of this._additionalDevices) {
      if (!d.isLost) {
        d.device.destroy();
      }
    }
    this._additionalDevices = [];
    this._pendingPrimary = null;
  }

  /**
   * Reset the singleton (for testing).
   * @private
   */
  static _resetInstance(): void {
    if (WebGPUDevicePool._instance) {
      WebGPUDevicePool._instance.destroyAll();
      WebGPUDevicePool._instance = null;
    }
  }
}

// Re-export DESIRED_FEATURES so external tests / docs can introspect
// the canonical list without reaching into WebGPUFeatureFlags.
export { DESIRED_FEATURES };

export default WebGPUDevicePool;
