/**
 * GPU frustum-culler pool helpers extracted from `WebGPUContext`.
 *
 * Second slice of the audit-recommended Context decomposition
 * (`migration_doc/WEBGPU_CONTEXT_DECOMPOSITION_PLAN.md`, Q35 epic — follows
 * the Batch 593 HDR canvas-output extraction). Peels the compute-culler pool
 * cluster off the ~5.4K-LOC `WebGPUContext.ts` into a self-contained module:
 *
 *   - `getGpuCuller(host)` — lazy-init the main opaque frustum culler
 *     (frustum 0). Async-loads `WebGPUGPUCuller` + `FrustumCull.wgsl`.
 *   - `getGpuCullerForOpaqueFrustum(host, idx)` — per-frustum culler pool
 *     (NEW-MULTIFRUSTUM-CULL-RESULTS, Batch 220). Frustum 0 reuses the main
 *     culler; 1..N get their own instances so same-encoder `prepareReadback`
 *     calls don't clobber each other's staging buffers.
 *   - `getGpuCullerForCascade(host, idx)` — per-cascade CSM-shadow culler pool
 *     (NEW-SHADOW-CAST-GPU-CULL, Batch 221).
 *   - `getGpuCullerTranslucent(host)` — dedicated translucent-pass culler
 *     (B216-N1, Batch 218).
 *   - `reapIdleAuxCullers(host)` — idle-decay reaper (NEW-AUX-CULLER-IDLE-DECAY,
 *     Batch 229). Destroys instances idle >= IDLE_DECAY_FRAMES.
 *   - `reapAllAuxCullers(host)` — immediate teardown of every aux culler
 *     (B225-N1, Batch 230). Used by `setGpuCullingHint('never')`.
 *
 * The extraction is behavior-preserving: the `WebGPUContext` getters/methods of
 * the same names become one-line delegators; the moved bodies are byte-for-byte
 * equivalent (identical lazy-import paths, identical debug pragmas, identical
 * device-loss re-touch ordering, identical defensive caps). Culling is opt-in
 * and gated (`_gpuCullingHint`, feature-renderer gates). FAR-003 changes the
 * default to `'never'`, so merely touching the getter chain cannot allocate a
 * culler until the owning Scene explicitly selects `auto` or `always`.
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
 * B220-O1 (Batch 225) — defensive cap on auxiliary culler allocation. Real
 * Cesium scenes top out at 6 frustums + 4 CSM cascades; 16 is a generous
 * safety bound. Without this cap a malformed scene that reports an
 * unreasonable `frustumCommandsList.length` could allocate hundreds of
 * cullers (~1 MB VRAM each).
 */
export const MAX_AUX_CULLER_INDEX = 16;

/**
 * NEW-AUX-CULLER-IDLE-DECAY (Batch 229) — reap auxiliary cullers idle for
 * this many internal frames. ≈10s at 60fps.
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
  // Batch 229 — touch usage timestamp for idle-decay reaper.
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
          // B229-N1 (Batch 230 audit) — re-touch LastUsed on resolve.
          host._gpuCullerLastUsed = host._internalFrameId;
          // B219-A1 (Batch 225 audit fix) — clear on device loss
          // so the lazy getter re-creates against the recovered
          // device. Without this the JS instance persists with
          // dead GPU buffer handles and next dispatch fails.
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
 * NEW-MULTIFRUSTUM-CULL-RESULTS (Batch 220) — return the GPU culler instance
 * for opaque-pass frustum `idx`. Frustum 0 reuses the original `gpuCuller` so
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
  // B219-N3 (Batch 225) — refuse allocation when hint forbids.
  if (host._gpuCullingHint === "never") return null;
  // B220-O1 (Batch 225) — defensive cap. Real Cesium scenes top
  // out at ~6 frustums (`Scene.farToNearRatio` driven; typical
  // 1-4 with log-depth, up to 6 without). Refuse allocation
  // beyond a sane max so a runaway value (bug or malformed
  // input) can't burn unbounded VRAM.
  if (idx >= MAX_AUX_CULLER_INDEX) return null;
  // Batch 229 — touch usage timestamp for idle-decay reaper.
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
        // B229-N1 (Batch 230 audit) — re-touch LastUsed on
        // resolve so post-init reaper iterations see the slot.
        // The first-call `set` happened at INVOKE time; if the
        // reaper fired between invoke + resolve it would have
        // deleted that entry, leaving the freshly-installed
        // instance orphaned in the reap walk.
        host._gpuCullerByFrustumLastUsed.set(idx, host._internalFrameId);
        // B219-A1 (Batch 225) — clear on device loss.
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
 * NEW-SHADOW-CAST-GPU-CULL Phase 1 (Batch 221) — per-cascade GPU culler
 * instances for CSM shadow cast. Each cascade gets its own `_visibilityBuffer`
 * + `_readbackBuffer` so the per-cascade `prepareReadback` calls don't collide
 * in the same encoder. Lazy-init on first request per cascade index.
 *
 * Phase 2 (Batches 225-230) wired the live dispatch — `WebGPUCSMCastPass`
 * packs per-cascade cull planes, runs the hysteresis gate, dispatches this
 * culler, and filters the cast list by the prior-frame readback.
 */
export function getGpuCullerForCascade(
  host: CullerPoolHost,
  idx: number,
): GPUCullerInstance | null {
  if (!host._device || host._isDestroyed) return null;
  // B219-N3 (Batch 225) — refuse allocation when hint forbids.
  if (host._gpuCullingHint === "never") return null;
  // B220-O1 (Batch 225) — defensive cap. CSM cascades top out
  // at 4 in stock Cesium; the cap matches frustum cap for
  // simplicity. See `getGpuCullerForOpaqueFrustum`.
  if (idx < 0 || idx >= MAX_AUX_CULLER_INDEX) return null;
  // Batch 229 — touch usage timestamp for idle-decay reaper.
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
        // B229-N1 (Batch 230 audit) — re-touch LastUsed on resolve.
        host._gpuCullerByCascadeLastUsed.set(idx, host._internalFrameId);
        // B219-A1 (Batch 225) — clear on device loss.
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
 * B216-N1 (Batch 218 audit fix) — second GPU frustum culler used exclusively
 * for the translucent pass. Gives translucent its own `_visibilityBuffer` +
 * `_readbackBuffer` so its `prepareReadback` doesn't clobber the opaque pass's
 * pending readback in the same encoder. Same lazy-init pattern as `gpuCuller`.
 */
export function getGpuCullerTranslucent(
  host: CullerPoolHost,
): GPUCullerInstance | null {
  // Batch 229 — touch usage timestamp for idle-decay reaper.
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
          // B229-N1 (Batch 230 audit) — re-touch LastUsed on resolve.
          host._gpuCullerTranslucentLastUsed = host._internalFrameId;
          // B219-A1 (Batch 225) — clear on device loss.
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
 * NEW-AUX-CULLER-IDLE-DECAY (Batch 229) — destroy auxiliary culler instances
 * idle for >= IDLE_DECAY_FRAMES. Called at IDLE_DECAY_CHECK_INTERVAL-frame
 * intervals from `beginFrame()`.
 *
 * Sweep order: per-frustum (idx >= 1, since 0 reuses _gpuCuller), per-cascade,
 * then translucent culler, then the main _gpuCuller. Each destroy nullifies
 * the slot so the lazy getter reallocates on demand.
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
 * B225-N1 (Batch 230 audit fix) — destroy every auxiliary culler instance
 * immediately. Used by `setGpuCullingHint('never')` to honor the opt-out
 * without waiting for idle-decay. Distinct from `reapIdleAuxCullers`
 * (Batch 229) which is selective by last-used age.
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
