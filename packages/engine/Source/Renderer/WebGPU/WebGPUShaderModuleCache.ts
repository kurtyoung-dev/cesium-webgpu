/**
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
 * Common-path keys are exact 40-bit JavaScript integers packed as
 * `((defines >>> 0) * 0x100) + sourceId`:
 *
 *   - Low 8 bits: `ShaderSourceId` (256 shader sources engine-wide).
 *   - High 32 bits: the complete active-defines Uint32 bitmask.
 *
 * A 40-bit integer is exactly representable by JavaScript's 53-bit safe
 * integer range. This keeps the fast, allocation-free numeric `Map` lookup
 * while ensuring define bits 24-31 cannot alias the no-define variant. A
 * non-zero generated-source `keySalt` still uses a string key because that
 * is a separate identity dimension, not an overflow escape hatch.
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
 * @module WebGPUShaderModuleCache
 */

import { preprocess } from "./WebGPUShaderPreprocessor.js";

export class WebGPUShaderModuleCache {
  private _device: GPUDevice;
  // Keys are exact numeric `(sourceId, full Uint32 defines)` identities for
  // the common, source-stable path. DP-H46b — when a caller passes a non-zero
  // `keySalt` (a per-source content fingerprint, e.g. the metadata-class hash
  // for the GENERATED `struct Metadata` chunk), the key becomes the STRING
  // `"<numericKey>#<salt>"` so two callers that share `(sourceId, defines)`
  // but supply DIFFERENT source content don't alias one compiled module.
  // `keySalt === 0` (the default) keeps the allocation-free numeric path.
  private _modules = new Map<number | string, GPUShaderModule>();

  constructor(device: GPUDevice) {
    this._device = device;
  }

  /**
   * Fetch or create the shader module for `(sourceId, defines)`.
   * Preprocesses the source string against the defines bitmask on
   * miss, then caches the compiled `GPUShaderModule` keyed by a
   * compact safe integer. Subsequent calls for the same key are a single
   * `Map.get`.
   *
   * @param sourceId `ShaderSourceId` integer identifying which source
   *   file this is. Must fit in the low 8 bits of the cache key.
   * @param source Raw WGSL source as imported from the `.wgsl` module.
   *   Build-time debug pragma stripping is already applied.
   * @param defines Active-defines bitmask (`ShaderDefine` bits OR'd
   *   together). The complete Uint32 is retained. Pass `0` for no
   *   conditional blocks.
   * @param label Devtools label for `createShaderModule`. Callers
   *   should include the define set in the label (see `prewarm`) for
   *   easier browser-side diagnostic output.
   * @param keySalt DP-H46b — optional per-source content fingerprint. When
   *   non-zero, it's folded into the cache key so two callers that share
   *   `(sourceId, defines)` but pass DIFFERENT `source` strings (e.g. two
   *   metadata classes whose generated `Metadata` chunk differs) get
   *   distinct compiled modules. Defaults to `0` → numeric key unchanged
   *   (parity for all existing callers).
   */
  getOrCreate(
    sourceId: number,
    source: string,
    defines: number,
    label: string,
    keySalt = 0,
  ): GPUShaderModule {
    if (!Number.isInteger(sourceId) || sourceId < 0 || sourceId > 0xff) {
      throw new RangeError("sourceId must be an integer in the range 0..255");
    }
    if (
      !Number.isInteger(defines) ||
      defines < -0x80000000 ||
      defines > 0xffffffff
    ) {
      throw new RangeError("defines must be a signed or unsigned Uint32 mask");
    }

    const unsignedDefines = defines >>> 0;
    // Multiplication, rather than a bitwise shift, is intentional: JavaScript
    // bitwise operators truncate to 32 bits and would discard define bits
    // 24-31 after reserving the low source-id byte.
    const numericKey = unsignedDefines * 0x100 + sourceId;
    const key = keySalt === 0 ? numericKey : `${numericKey}#${keySalt >>> 0}`;
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
        `${labelPrefix} (defines=0x${(defines >>> 0)
          .toString(16)
          .padStart(8, "0")})`,
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
