/**
 * @module WebGPUShaderModuleCache
 *
 * Deduplicates `GPUShaderModule` compilation across pipelines that
 * share the same `(shader source, active defines)` tuple. Today the
 * globe terrain renderer produces 3+ pipelines from the same shader
 * source (production + wireframe + debug fragment variants); before
 * this cache each call to `device.createShaderModule` re-compiled the
 * same WGSL, for no benefit.
 *
 * # Two-tier caching model
 *
 * This is **Tier 1** — module-level caching. Tier 2 is the per-
 * renderer pipeline cache (`_pipelineCache` / `_wireframePipelineCache`
 * / `_debugFragmentPipelineCache` on each renderer) which caches
 * `GPURenderPipeline` under a key that now includes the defines
 * bitmask as a `|0xNN` suffix.
 *
 * # Cache key encoding
 *
 * Keys are Uint32 packed as `(sourceId & 0xff) | ((defines & 0xffffff) << 8)`:
 *
 *   - Low 8 bits: `ShaderSourceId` (256 shader sources engine-wide).
 *   - High 24 bits: active-defines bitmask (24 possible defines).
 *
 * Numeric keys give us the fastest possible `Map` lookup — no string
 * hashing, no allocation per lookup. Debuggability is preserved through
 * `defineKeyToNames` (in `WebGPUShaderDefines`) for diagnostic paths;
 * the hot path stays numeric.
 *
 * # Prewarm
 *
 * Renderers call `prewarm(sourceId, source, defineSets, labelPrefix)`
 * at the end of their device-init to compile all "expected common"
 * variants ahead of the first frame. This moves 10–20 ms of shader
 * compile off the render path. The list is each renderer's own
 * responsibility — no central heuristic — so each owner knows exactly
 * which variants their first 30 frames will touch.
 *
 * # Lifecycle
 *
 * One cache per `GPUDevice`. Modules are GC'd when the device is
 * destroyed, so clearing the cache on device loss is sufficient.
 *
 * @private
 */

import { preprocess } from "./WebGPUShaderPreprocessor.js";

export class WebGPUShaderModuleCache {
  private _device: GPUDevice;
  private _modules = new Map<number, GPUShaderModule>();

  constructor(device: GPUDevice) {
    this._device = device;
  }

  /**
   * Fetch or create the shader module for `(sourceId, defines)`.
   * Preprocesses the source string against the defines bitmask on
   * miss, then caches the compiled `GPUShaderModule` keyed by a
   * compact Uint32. Subsequent calls for the same key are a single
   * `Map.get`.
   *
   * @param sourceId `ShaderSourceId` integer identifying which source
   *   file this is. Low 8 bits of the cache key.
   * @param source Raw WGSL source as imported from the `.wgsl` module.
   *   Build-time debug pragma stripping is already applied.
   * @param defines Active-defines bitmask (`ShaderDefine` bits OR'd
   *   together). High 24 bits of the cache key. Pass `0` for no
   *   conditional blocks.
   * @param label Devtools label for `createShaderModule`. Callers
   *   should include the define set in the label (see `prewarm`) for
   *   easier browser-side diagnostic output.
   */
  getOrCreate(
    sourceId: number,
    source: string,
    defines: number,
    label: string,
  ): GPUShaderModule {
    const key = (sourceId & 0xff) | ((defines & 0xffffff) << 8);
    let module = this._modules.get(key);
    if (module !== undefined) return module;

    const processed = preprocess(source, defines);
    module = this._device.createShaderModule({ code: processed, label });
    this._modules.set(key, module);
    return module;
  }

  /**
   * Precompile a list of shader-module variants so the first-frame
   * render path doesn't pay for `createShaderModule` cost. Call at the
   * end of renderer `_initDevice` with the define sets that your first
   * 30 frames are known to exercise.
   *
   * Idempotent — already-cached entries are a no-op.
   */
  prewarm(
    sourceId: number,
    source: string,
    defineSets: readonly number[],
    labelPrefix: string,
  ): void {
    for (let i = 0; i < defineSets.length; i++) {
      const defines = defineSets[i];
      this.getOrCreate(
        sourceId,
        source,
        defines,
        `${labelPrefix} (defines=0x${defines.toString(16).padStart(6, "0")})`,
      );
    }
  }

  /**
   * Diagnostic: number of compiled modules currently cached.
   */
  size(): number {
    return this._modules.size;
  }

  /**
   * Drop all cached module references. Call on device loss; modules
   * tied to a destroyed device are unusable and keeping them rooted
   * blocks GC.
   */
  destroy(): void {
    this._modules.clear();
  }
}
