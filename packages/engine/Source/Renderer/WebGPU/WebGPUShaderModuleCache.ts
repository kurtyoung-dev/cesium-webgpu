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
 *   - High 32 bits: the complete active-defines lo-word Uint32 bitmask.
 *
 * A 40-bit integer is exactly representable by JavaScript's 53-bit safe
 * integer range. This keeps the fast, allocation-free numeric `Map` lookup
 * while ensuring define bits 24-31 cannot alias the no-define variant. A
 * non-zero generated-source `keySalt` still uses a string key because that
 * is a separate identity dimension, not an overflow escape hatch.
 *
 * # Hi-word widening
 *
 * The define space is the two-word `(defines, definesHi)` pair; see
 * `ShaderDefineHi` in `WebGPUShaderDefines`. The hi word is a second
 * cache level, not a wider packed integer — packing 64 define bits plus 8
 * source-id bits into one number would exceed the 53-bit safe-integer
 * range and force string keys (allocation on the hot path, the design
 * point this cache exists to avoid). Instead:
 *
 *   - `definesHi === 0` (every legacy caller and the overwhelmingly
 *     common path): the lookup is the SAME single `Map.get` against the
 *     same `_modules` field with the same 40-bit key as before —
 *     structurally identical to the pre-widening hot path.
 *   - `definesHi !== 0`: a lazily-created outer `Map` keyed by the hi
 *     word selects an inner level with the identical 40-bit lo-key
 *     scheme. Two map hops, numeric keys throughout, still
 *     allocation-free.
 *
 * No `(defines, definesHi, sourceId, keySalt)` tuple can alias another:
 * the hi word selects the level and the lo key is collision-free within
 * a level (proven in `WebGPUShaderModuleCacheSpec`).
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
import type { ShaderDefineLoMask } from "./WebGPUShaderDefines.js";

/**
 * Pure lo-level key packing: `((defines >>> 0) * 0x100) + sourceId`, with
 * the string form `"<numericKey>#<salt>"` when a non-zero
 * `keySalt` is supplied. Exported so `WebGPUShaderModuleCacheSpec` can
 * pin the hi=0 key against the formula without reaching into cache
 * internals. Callers must validate ranges first — this helper only packs.
 *
 * @private
 */
export function computeShaderModuleCacheLoKey(
  sourceId: number,
  defines: number,
  keySalt = 0,
): number | string {
  // Multiplication, rather than a bitwise shift, is intentional: JavaScript
  // bitwise operators truncate to 32 bits and would discard define bits
  // 24-31 after reserving the low source-id byte.
  const numericKey = (defines >>> 0) * 0x100 + sourceId;
  return keySalt === 0 ? numericKey : `${numericKey}#${keySalt >>> 0}`;
}

export class WebGPUShaderModuleCache {
  private _device: GPUDevice;
  // Keys are exact numeric `(sourceId, full Uint32 defines)` identities for
  // the common, source-stable path. When a caller passes a non-zero
  // `keySalt` — a per-source content fingerprint, such as the metadata-class
  // hash for the generated `struct Metadata` chunk — the key becomes the
  // string `"<numericKey>#<salt>"`, so two callers sharing
  // `(sourceId, defines)` but supplying different source content do not alias
  // one compiled module. `keySalt === 0`, the default, keeps the
  // allocation-free numeric path.
  //
  // `_modules` is the `definesHi === 0` level of the two-level (hi, loKey)
  // scheme. Keeping it as its own field rather than an entry of
  // `_modulesByHi` keeps the hi=0 hot path down to one integer compare and a
  // single `Map.get`.
  private _modules = new Map<number | string, GPUShaderModule>();
  // Outer level for `definesHi !== 0` variants, keyed by the hi word. Lazily
  // created, so a caller that never passes a hi word never allocates it.
  private _modulesByHi: Map<
    number,
    Map<number | string, GPUShaderModule>
  > | null = null;

  constructor(device: GPUDevice) {
    this._device = device;
  }

  /**
   * Fetch or create the shader module for `(sourceId, defines, definesHi)`.
   * Preprocesses the source string against the defines bitmasks on
   * miss, then caches the compiled `GPUShaderModule` keyed by a
   * compact safe integer. Subsequent calls for the same key are a single
   * `Map.get` (two for hi-word variants).
   *
   * @param sourceId `ShaderSourceId` integer identifying which source
   *   file this is. Must fit in the low 8 bits of the cache key.
   * @param source Raw WGSL source as imported from the `.wgsl` module.
   *   Build-time debug pragma stripping is already applied.
   * @param defines Active lo-word defines bitmask (`ShaderDefine` bits
   *   OR'd together). The complete Uint32 is retained. Pass `0` for no
   *   conditional blocks. Typed as `ShaderDefineLoMask` so a branded
   *   `ShaderDefineHi` bit passed here is a compile error.
   * @param label Devtools label for `createShaderModule`. Callers
   *   should include the define set in the label (see `prewarm`) for
   *   easier browser-side diagnostic output.
   * @param keySalt Optional per-source content fingerprint. When
   *   non-zero, it is folded into the cache key so two callers that share
   *   `(sourceId, defines)` but pass different `source` strings — two
   *   metadata classes whose generated `Metadata` chunk differs, say — get
   *   distinct compiled modules. Defaults to `0`, which leaves the numeric
   *   key unchanged.
   * @param definesHi Active hi-word defines bitmask,
   *   `ShaderDefineHi` bits OR'd together. Defaults to `0`, which keeps
   *   the lookup on the hi=0 hot path. Unlike `defines`, the hi
   *   word is a fresh namespace with no signed legacy, so only
   *   `0..0x7fffffff` is accepted (hi bit 31 is reserved — see
   *   `ShaderDefineHi`).
   */
  getOrCreate(
    sourceId: number,
    source: string,
    defines: ShaderDefineLoMask,
    label: string,
    keySalt = 0,
    definesHi: number = 0,
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
    if (
      !Number.isInteger(definesHi) ||
      definesHi < 0 ||
      definesHi > 0x7fffffff
    ) {
      throw new RangeError(
        "definesHi must be an integer mask using hi-word bits 0..30 (bit 31 is reserved)",
      );
    }

    // Select the cache level. `definesHi === 0` is the hot path: the
    // `_modules` field, a 40-bit key, one `Map.get`.
    let level: Map<number | string, GPUShaderModule>;
    if (definesHi === 0) {
      level = this._modules;
    } else {
      let byHi = this._modulesByHi;
      if (byHi === null) {
        byHi = new Map();
        this._modulesByHi = byHi;
      }
      let hiLevel = byHi.get(definesHi);
      if (hiLevel === undefined) {
        hiLevel = new Map();
        byHi.set(definesHi, hiLevel);
      }
      level = hiLevel;
    }

    const key = computeShaderModuleCacheLoKey(sourceId, defines, keySalt);
    let module = level.get(key);
    if (module !== undefined) return module;

    const processed = preprocess(source, defines, definesHi);
    module = this._device.createShaderModule({ code: processed, label });
    level.set(key, module);
    return module;
  }

  /**
   * Precompile a list of shader-module variants so the first-frame
   * render path doesn't pay for `createShaderModule` cost. Call at the
   * end of renderer `_initDevice` with the define sets that your first
   * 30 frames are known to exercise.
   *
   * Each entry is either a lo-word mask, which implies hi = 0, or a
   * `[definesLo, definesHi]` pair for a hi-word variant, whose label carries
   * both hex masks.
   *
   * Idempotent — already-cached entries are a no-op.
   */
  prewarm(
    sourceId: number,
    source: string,
    defineSets: readonly (number | readonly [number, number])[],
    labelPrefix: string,
  ): void {
    for (let i = 0; i < defineSets.length; i++) {
      const entry = defineSets[i];
      const defines = typeof entry === "number" ? entry : entry[0];
      const definesHi = typeof entry === "number" ? 0 : entry[1];
      const loHex = (defines >>> 0).toString(16).padStart(8, "0");
      const label =
        definesHi === 0
          ? `${labelPrefix} (defines=0x${loHex})`
          : `${labelPrefix} (defines=0x${loHex},hi=0x${(definesHi >>> 0)
              .toString(16)
              .padStart(8, "0")})`;
      this.getOrCreate(sourceId, source, defines, label, 0, definesHi);
    }
  }

  /**
   * Diagnostic: number of compiled modules currently cached, across the
   * hi=0 level and every hi-word level.
   */
  size(): number {
    let n = this._modules.size;
    if (this._modulesByHi !== null) {
      for (const level of this._modulesByHi.values()) {
        n += level.size;
      }
    }
    return n;
  }

  /**
   * Drop all cached module references. Call on device loss; modules
   * tied to a destroyed device are unusable and keeping them rooted
   * blocks GC.
   */
  destroy(): void {
    this._modules.clear();
    if (this._modulesByHi !== null) {
      this._modulesByHi.clear();
      this._modulesByHi = null;
    }
  }
}
