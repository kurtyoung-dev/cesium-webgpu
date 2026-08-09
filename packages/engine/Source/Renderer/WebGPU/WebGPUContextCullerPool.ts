/**
 * GPU frustum-culler pool helpers extracted from `WebGPUContext`.
 *
 * Holds the compute-culler pool as a self-contained module rather than inside
 * the much larger `WebGPUContext.ts`, whose getters and methods of the same
 * names are one-line delegators to these functions:
 *
 *   - `getGpuCuller(host)` — lazily initialize the main opaque frustum culler
 *     (frustum 0). Async-loads `WebGPUGPUCuller` and `FrustumCull.wgsl`.
 *   - `getGpuCullerForOpaqueFrustum(host, idx)` — per-frustum culler pool.
 *     Frustum 0 reuses the main culler; 1..N get their own instances so
 *     same-encoder `prepareReadback` calls do not clobber each other's staging
 *     buffers.
 *   - `getGpuCullerForCascade(host, idx)` — per-cascade CSM-shadow culler pool.
 *   - `getGpuCullerTranslucent(host)` — dedicated translucent-pass culler.
 *   - `reapIdleAuxCullers(host)` — idle-decay reaper. Destroys instances idle
 *     for at least `IDLE_DECAY_FRAMES`.
 *   - `reapAllAuxCullers(host)` — immediate teardown of every auxiliary
 *     culler, used by `setGpuCullingHint('never')`.
 *
 * Culling is opt-in and gated by `_gpuCullingHint` and the feature-renderer
 * gates, and the hint defaults to `'never'`, so touching the getter chain
 * cannot allocate a culler until the owning Scene selects `auto` or `always`.
 *
 * @module WebGPUContextCullerPool
 */

import type { AsyncResourceMonitor } from "./AsyncResourceMonitor.js";

/**
 * Minimal interface for the GPU culler (lazy-loaded). Owned here now that the
 * pool logic lives in this module; `WebGPUContext` imports it type-only.
 */
export interface GPUCullerInstance {
  initialized: boolean;
  destroy(): void;
  uploadBoundingSpheres(data: Float32Array): void;
  uploadFrustumPlanes(data: Float32Array): void;
  dispatch(encoder: GPUCommandEncoder, count: number, mode: number): void;
  prepareReadback(encoder: GPUCommandEncoder, count: number): void;
  readResults(count: number): Promise<GPUCullResults>;
  initialize(code: string): Promise<void>;
}

/**
 * Defensive cap on auxiliary culler allocation. Real Cesium scenes top out at
 * six frustums plus four CSM cascades, so 16 is a generous bound. Without the
 * cap a malformed scene reporting an unreasonable `frustumCommandsList.length`
 * allocates hundreds of cullers at roughly 1 MB of VRAM each.
 */
export const MAX_AUX_CULLER_INDEX = 16;

/**
 * Reap auxiliary cullers idle for this many internal frames, about 10 seconds
 * at 60 fps.
 */
export const IDLE_DECAY_FRAMES = 600;

/**
 * The `WebGPUContext` surface the culler-pool helpers reach into. All fields
 * use the public-underscore convention already established on `WebGPUContext`
 * (`public _device`, `public _id`, `public _isDestroyed`). The culler slots +
 * their initializing/last-used bookkeeping are read+write; `asyncResources`
 * and `onDeviceInvalidated` are the two behaviors the lazy-init path needs.
 */
export interface CullerPoolHost {
  _device: GPUDevice | null;
  _id: string;
  _isDestroyed: boolean;
  _gpuCullingHint: "auto" | "always" | "never";
  _internalFrameId: number;
  _gpuCuller: GPUCullerInstance | null;
  _gpuCullerInitializing: boolean;
  _gpuCullerLastUsed: number;
  _gpuCullerTranslucent: GPUCullerInstance | null;
  _gpuCullerTranslucentInitializing: boolean;
  _gpuCullerTranslucentLastUsed: number;
  _gpuCullerByFrustum: Map<number, GPUCullerInstance>;
  _gpuCullerByFrustumInitializing: Set<number>;
  _gpuCullerByFrustumLastUsed: Map<number, number>;
  _gpuCullerByCascade: Map<number, GPUCullerInstance>;
  _gpuCullerByCascadeInitializing: Set<number>;
  _gpuCullerByCascadeLastUsed: Map<number, number>;
  readonly asyncResources: AsyncResourceMonitor;
  onDeviceInvalidated(callback: () => void): () => void;
}

/**
 * GPU frustum culler for compute-shader-based visibility testing.
 * Lazy-initialized on first access. Async init loads the FrustumCull.wgsl
 * shader. Returns the instance (may not be initialized yet — check
 * `.initialized`).
 */
export function getGpuCuller(host: CullerPoolHost): GPUCullerInstance | null {
  // Touch the usage timestamp for the idle-decay reaper.
  host._gpuCullerLastUsed = host._internalFrameId;
  if (
    !host._gpuCuller &&
    host._device &&
    !host._gpuCullerInitializing &&
    host._gpuCullingHint !== "never"
  ) {
    host._gpuCullerInitializing = true;
    import("./WebGPUGPUCuller.js").then(({ WebGPUGPUCuller }) => {
      const culler = new WebGPUGPUCuller(host._device!, {
        maxObjects: 65536,
        label: `ctx-${host._id}`,
        asyncResourceMonitor: host.asyncResources,
      });
      import("../../Shaders/WebGPU/Compute/FrustumCull.js")
        .then((mod: { default?: string | object }) => {
          const code = mod.default || mod;
          return culler.initialize(typeof code === "string" ? code : "");
        })
        .then(() => {
          host._gpuCuller = culler;
          host._gpuCullerInitializing = false;
          // Re-touch LastUsed on resolve.
          host._gpuCullerLastUsed = host._internalFrameId;
          // Clear on device loss so the lazy getter re-creates against the
          // recovered device. Without this the JS instance persists with dead
          // GPU buffer handles and the next dispatch fails.
          host.onDeviceInvalidated(() => {
            host._gpuCuller = null;
          });
        })
        .catch((e: unknown) => {
          //>>includeStart('debug', pragmas.debug);
          console.warn(
            `[CesiumJS:webgpu:ctx-${host._id}] GPU culler init failed:`,
            e,
          );
          //>>includeEnd('debug');
          host._gpuCullerInitializing = false;
        });
    });
  }
  return host._gpuCuller;
}

/**
 * Return the GPU culler instance for opaque-pass frustum `idx`. Frustum 0
 * reuses the original `gpuCuller` so
 * single-frustum scenes don't pay extra VRAM; frustums 1..N get their own
 * lazy-init instances so their `prepareReadback` calls in the same encoder
 * don't clobber each other's staging buffers.
 *
 * Returns `null` if init is still pending or the device is gone.
 */
export function getGpuCullerForOpaqueFrustum(
  host: CullerPoolHost,
  idx: number,
): GPUCullerInstance | null {
  if (idx === 0) return getGpuCuller(host);
  if (!host._device || host._isDestroyed) return null;
  // Refuse allocation when the hint forbids it.
  if (host._gpuCullingHint === "never") return null;
  // Defensive cap. Real Cesium scenes top out around six frustums, driven by
  // `Scene.farToNearRatio` — typically one to four with log depth, up to six
  // without. Refusing allocation beyond a sane maximum keeps a runaway value
  // from burning unbounded VRAM.
  if (idx >= MAX_AUX_CULLER_INDEX) return null;
  // Touch the usage timestamp for the idle-decay reaper.
  host._gpuCullerByFrustumLastUsed.set(idx, host._internalFrameId);
  if (host._gpuCullerByFrustum.has(idx)) {
    return host._gpuCullerByFrustum.get(idx) ?? null;
  }
  if (host._gpuCullerByFrustumInitializing.has(idx)) return null;
  host._gpuCullerByFrustumInitializing.add(idx);
  import("./WebGPUGPUCuller.js").then(({ WebGPUGPUCuller }) => {
    const culler = new WebGPUGPUCuller(host._device!, {
      maxObjects: 65536,
      label: `ctx-${host._id}-frustum-${idx}`,
      asyncResourceMonitor: host.asyncResources,
    });
    import("../../Shaders/WebGPU/Compute/FrustumCull.js")
      .then((mod: { default?: string | object }) => {
        const code = mod.default || mod;
        return culler.initialize(typeof code === "string" ? code : "");
      })
      .then(() => {
        host._gpuCullerByFrustum.set(idx, culler);
        host._gpuCullerByFrustumInitializing.delete(idx);
        // Re-touch LastUsed on resolve so a post-init reaper iteration sees
        // the slot. The first `set` happens at invoke time, and a reaper that
        // fires between invoke and resolve deletes that entry, leaving the
        // freshly installed instance orphaned in the reap walk.
        host._gpuCullerByFrustumLastUsed.set(idx, host._internalFrameId);
        // Clear on device loss.
        host.onDeviceInvalidated(() => {
          host._gpuCullerByFrustum.delete(idx);
        });
      })
      .catch((e: unknown) => {
        //>>includeStart('debug', pragmas.debug);
        console.warn(
          `[CesiumJS:webgpu:ctx-${host._id}] GPU culler frustum-${idx} init failed:`,
          e,
        );
        //>>includeEnd('debug');
        host._gpuCullerByFrustumInitializing.delete(idx);
      });
  });
  return null;
}

/**
 * Per-cascade GPU culler instances for the CSM shadow cast. Each cascade gets
 * its own `_visibilityBuffer` and `_readbackBuffer` so the per-cascade
 * `prepareReadback` calls do not collide in one encoder. Lazily initialized on
 * the first request per cascade index.
 *
 * `WebGPUCSMCastPass` packs per-cascade cull planes, runs the hysteresis gate,
 * dispatches this culler, and filters the cast list by the prior frame's
 * readback.
 */
export function getGpuCullerForCascade(
  host: CullerPoolHost,
  idx: number,
): GPUCullerInstance | null {
  if (!host._device || host._isDestroyed) return null;
  // Refuse allocation when the hint forbids it.
  if (host._gpuCullingHint === "never") return null;
  // Defensive cap. CSM cascades top out at four in stock Cesium; the cap
  // matches the frustum cap for simplicity. See
  // `getGpuCullerForOpaqueFrustum`.
  if (idx < 0 || idx >= MAX_AUX_CULLER_INDEX) return null;
  // Touch the usage timestamp for the idle-decay reaper.
  host._gpuCullerByCascadeLastUsed.set(idx, host._internalFrameId);
  if (host._gpuCullerByCascade.has(idx)) {
    return host._gpuCullerByCascade.get(idx) ?? null;
  }
  if (host._gpuCullerByCascadeInitializing.has(idx)) return null;
  host._gpuCullerByCascadeInitializing.add(idx);
  import("./WebGPUGPUCuller.js").then(({ WebGPUGPUCuller }) => {
    const culler = new WebGPUGPUCuller(host._device!, {
      maxObjects: 65536,
      label: `ctx-${host._id}-cascade-${idx}`,
      asyncResourceMonitor: host.asyncResources,
    });
    import("../../Shaders/WebGPU/Compute/FrustumCull.js")
      .then((mod: { default?: string | object }) => {
        const code = mod.default || mod;
        return culler.initialize(typeof code === "string" ? code : "");
      })
      .then(() => {
        host._gpuCullerByCascade.set(idx, culler);
        host._gpuCullerByCascadeInitializing.delete(idx);
        // Re-touch LastUsed on resolve.
        host._gpuCullerByCascadeLastUsed.set(idx, host._internalFrameId);
        // Clear on device loss.
        host.onDeviceInvalidated(() => {
          host._gpuCullerByCascade.delete(idx);
        });
      })
      .catch((e: unknown) => {
        //>>includeStart('debug', pragmas.debug);
        console.warn(
          `[CesiumJS:webgpu:ctx-${host._id}] GPU culler cascade-${idx} init failed:`,
          e,
        );
        //>>includeEnd('debug');
        host._gpuCullerByCascadeInitializing.delete(idx);
      });
  });
  return null;
}

/**
 * Second GPU frustum culler, used exclusively for the translucent pass. Gives
 * translucent its own `_visibilityBuffer` and
 * `_readbackBuffer` so its `prepareReadback` doesn't clobber the opaque pass's
 * pending readback in the same encoder. Same lazy-init pattern as `gpuCuller`.
 */
export function getGpuCullerTranslucent(
  host: CullerPoolHost,
): GPUCullerInstance | null {
  // Touch the usage timestamp for the idle-decay reaper.
  host._gpuCullerTranslucentLastUsed = host._internalFrameId;
  if (
    !host._gpuCullerTranslucent &&
    host._device &&
    !host._gpuCullerTranslucentInitializing &&
    host._gpuCullingHint !== "never"
  ) {
    host._gpuCullerTranslucentInitializing = true;
    import("./WebGPUGPUCuller.js").then(({ WebGPUGPUCuller }) => {
      const culler = new WebGPUGPUCuller(host._device!, {
        maxObjects: 65536,
        label: `ctx-${host._id}-translucent`,
        asyncResourceMonitor: host.asyncResources,
      });
      import("../../Shaders/WebGPU/Compute/FrustumCull.js")
        .then((mod: { default?: string | object }) => {
          const code = mod.default || mod;
          return culler.initialize(typeof code === "string" ? code : "");
        })
        .then(() => {
          host._gpuCullerTranslucent = culler;
          host._gpuCullerTranslucentInitializing = false;
          // Re-touch LastUsed on resolve.
          host._gpuCullerTranslucentLastUsed = host._internalFrameId;
          // Clear on device loss.
          host.onDeviceInvalidated(() => {
            host._gpuCullerTranslucent = null;
          });
        })
        .catch((e: unknown) => {
          //>>includeStart('debug', pragmas.debug);
          console.warn(
            `[CesiumJS:webgpu:ctx-${host._id}] GPU culler (translucent) init failed:`,
            e,
          );
          //>>includeEnd('debug');
          host._gpuCullerTranslucentInitializing = false;
        });
    });
  }
  return host._gpuCullerTranslucent;
}

/**
 * Destroy auxiliary culler instances idle for at least `IDLE_DECAY_FRAMES`.
 * Called at `IDLE_DECAY_CHECK_INTERVAL`-frame intervals from `beginFrame()`.
 *
 * Sweep order: per-frustum for `idx >= 1`, since 0 reuses `_gpuCuller`, then
 * per-cascade, then the translucent culler, then the main `_gpuCuller`. Each
 * destroy nullifies its slot so the lazy getter reallocates on demand.
 */
export function reapIdleAuxCullers(host: CullerPoolHost): void {
  const now = host._internalFrameId;
  const threshold = IDLE_DECAY_FRAMES;

  // Per-frustum (frustum 0 is _gpuCuller, handled separately).
  for (const [idx, lastUsed] of host._gpuCullerByFrustumLastUsed) {
    if (now - lastUsed >= threshold) {
      const culler = host._gpuCullerByFrustum.get(idx);
      if (culler) {
        try {
          culler.destroy();
        } catch (_) {
          /* defensive */
        }
        host._gpuCullerByFrustum.delete(idx);
      }
      host._gpuCullerByFrustumLastUsed.delete(idx);
    }
  }

  // Per-cascade.
  for (const [idx, lastUsed] of host._gpuCullerByCascadeLastUsed) {
    if (now - lastUsed >= threshold) {
      const culler = host._gpuCullerByCascade.get(idx);
      if (culler) {
        try {
          culler.destroy();
        } catch (_) {
          /* defensive */
        }
        host._gpuCullerByCascade.delete(idx);
      }
      host._gpuCullerByCascadeLastUsed.delete(idx);
    }
  }

  // Translucent.
  if (
    host._gpuCullerTranslucent &&
    now - host._gpuCullerTranslucentLastUsed >= threshold
  ) {
    try {
      host._gpuCullerTranslucent.destroy();
    } catch (_) {
      /* defensive */
    }
    host._gpuCullerTranslucent = null;
  }

  // Main opaque culler (frustum 0). Only reap if EVERY auxiliary
  // is also idle — otherwise we keep the cheap lazy-getter
  // re-init path warm.
  if (
    host._gpuCuller &&
    now - host._gpuCullerLastUsed >= threshold &&
    host._gpuCullerByFrustum.size === 0 &&
    host._gpuCullerByCascade.size === 0 &&
    !host._gpuCullerTranslucent
  ) {
    try {
      host._gpuCuller.destroy();
    } catch (_) {
      /* defensive */
    }
    host._gpuCuller = null;
  }
}

/**
 * Destroy every auxiliary culler instance immediately. Used by
 * `setGpuCullingHint('never')` to honour the opt-out without waiting for idle
 * decay, unlike `reapIdleAuxCullers`, which is selective by last-used age.
 */
export function reapAllAuxCullers(host: CullerPoolHost): void {
  for (const culler of host._gpuCullerByFrustum.values()) {
    try {
      culler.destroy();
    } catch (_) {
      /* defensive */
    }
  }
  host._gpuCullerByFrustum.clear();
  host._gpuCullerByFrustumLastUsed.clear();
  for (const culler of host._gpuCullerByCascade.values()) {
    try {
      culler.destroy();
    } catch (_) {
      /* defensive */
    }
  }
  host._gpuCullerByCascade.clear();
  host._gpuCullerByCascadeLastUsed.clear();
  if (host._gpuCullerTranslucent) {
    try {
      host._gpuCullerTranslucent.destroy();
    } catch (_) {
      /* defensive */
    }
    host._gpuCullerTranslucent = null;
  }
  if (host._gpuCuller) {
    try {
      host._gpuCuller.destroy();
    } catch (_) {
      /* defensive */
    }
    host._gpuCuller = null;
  }
}
