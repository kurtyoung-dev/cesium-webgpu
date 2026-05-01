/**
 * WebGPU optional-feature plumbing for `WebGPUContext`.
 *
 * Extracted from `WebGPUContext.DESIRED_FEATURES` /
 * `_buildFeatureList` / `_updateFeatureFlags` / `_enabledFeatures` /
 * `hasFeature` / `enabledFeatures` as Batch 132 of the audit-
 * recommended Context decomposition. See
 * `migration_doc/WEBGPU_CONTEXT_DECOMPOSITION_PLAN.md` for the
 * roadmap and `migration_doc/BATCH_132_PLAN_FEATURE_FLAGS.md` for
 * this specific extraction.
 *
 * Responsibilities:
 *   - Owns `DESIRED_FEATURES` — the priority-ordered list of
 *     CesiumJS-relevant WebGPU optional features.
 *   - Builds the `requiredFeatures` array passed to
 *     `adapter.requestDevice` by merging user-requested features
 *     with auto-detected adapter-supported entries from
 *     DESIRED_FEATURES.
 *   - Records which features the device actually granted (so
 *     `has(name)` can answer cheaply later).
 *
 * What it deliberately does NOT do:
 *   - It does NOT mutate Context cap flags (`textureFloatLinear`,
 *     `_s3tc`, etc.). Those are read across the renderer; moving
 *     them is a separate multi-batch refactor. Context's
 *     `_updateFeatureFlags()` keeps the flag-mapping logic and just
 *     reads through `this._featureFlags.has(...)` instead of
 *     `this._enabledFeatures.has(...)`.
 *
 * @module WebGPUFeatureFlags
 */

/**
 * Priority-ordered list of optional WebGPU features that CesiumJS
 * benefits from. Each is only requested if the adapter supports it.
 * Comments below pair each entry with the work item that consumes
 * it; keep these in sync when capability flags get added or
 * retired.
 */
export const DESIRED_FEATURES: GPUFeatureName[] = [
  // C1: Terrain heightmaps use float32 textures — enables HW
  // bilinear filtering.
  "float32-filterable" as GPUFeatureName,
  // C3: Native GPU clip planes for ClippingPlaneCollection
  // (Chrome 128+).
  "clip-distances" as GPUFeatureName,
  // C4: Weighted-average OIT in single render pass (Chrome 128+).
  "dual-source-blending" as GPUFeatureName,
  // I4: HDR render targets for post-processing (Chrome 121+).
  "rg11b10ufloat-renderable" as GPUFeatureName,
  // I6: GPU-side performance profiling (Chrome 121+).
  "timestamp-query" as GPUFeatureName,
  // I5: Half-precision floats in shaders.
  "shader-f16" as GPUFeatureName,
  // I1: GPU-driven rendering with indirect draw calls (Chrome 128+).
  "indirect-first-instance" as GPUFeatureName,
  // S4: SIMD-like subgroup operations for compute shaders
  // (Chrome 132+).
  "subgroups" as GPUFeatureName,
  // BGRA8 storage textures for compute-based post-processing.
  "bgra8unorm-storage" as GPUFeatureName,
  // Texture compression formats (requested if adapter supports them).
  "texture-compression-bc" as GPUFeatureName,
  "texture-compression-etc2" as GPUFeatureName,
  "texture-compression-astc" as GPUFeatureName,
];

export class WebGPUFeatureFlags {
  private _enabled: Set<string> = new Set();

  /**
   * Build the `requiredFeatures` array to pass to
   * `adapter.requestDevice({ requiredFeatures: ... })`. Merges the
   * user-requested features with auto-detected adapter-supported
   * entries from {@link DESIRED_FEATURES}.
   *
   * Pure function over its inputs — no internal state is touched.
   * Call after the adapter is acquired and before requestDevice.
   *
   * @param adapter - The acquired GPUAdapter.
   * @param userRequested - Optional user-supplied required features
   *   (typically `WebGPUContextOptions.requiredFeatures`). Forwarded
   *   verbatim into the result.
   */
  buildRequestList(
    adapter: GPUAdapter,
    userRequested?: readonly GPUFeatureName[],
  ): GPUFeatureName[] {
    const features = new Set<GPUFeatureName>(userRequested ?? []);
    for (const feature of DESIRED_FEATURES) {
      if (adapter.features.has(feature)) {
        features.add(feature);
      }
    }
    return Array.from(features);
  }

  /**
   * Record which features the freshly-created device actually
   * granted. Replaces any prior recorded state — call once per
   * device init (and again after device-loss recovery to refresh
   * from the new device).
   *
   * @param deviceFeatures - The `device.features` Set from the
   *   newly-created GPUDevice.
   */
  markEnabled(deviceFeatures: ReadonlySet<string>): void {
    this._enabled = new Set(deviceFeatures);
  }

  /**
   * Check if a specific WebGPU feature is enabled on the device.
   *
   * @param featureName - Feature name (e.g. `'float32-filterable'`,
   *   `'clip-distances'`, `'dual-source-blending'`,
   *   `'timestamp-query'`, `'shader-f16'`).
   */
  has(featureName: string): boolean {
    return this._enabled.has(featureName);
  }

  /** All currently-enabled feature names, in arbitrary order. */
  get enabledList(): string[] {
    return Array.from(this._enabled);
  }

  /**
   * Read-only view of the enabled set. Useful for callers that want
   * to do their own bulk filtering (e.g. "list every requested
   * feature that was actually granted").
   */
  get enabled(): ReadonlySet<string> {
    return this._enabled;
  }

  /** Drop the enabled set. Used by the Context's destroy path. */
  clear(): void {
    this._enabled = new Set();
  }
}

export default WebGPUFeatureFlags;
