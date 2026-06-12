/// <reference types="@webgpu/types" />
/**
 * WebGPU mirror of WebGL's centralized DerivedCommand factory — SCAFFOLD,
 * factory half not yet wired (status re-documented Batch 239; tracked as
 * NEW-DERIVEDCOMMAND-VARIANT-FACTORY in migration_doc/DEFERRED_WORK.md).
 *
 * The architecture has two halves:
 *
 * **Live half — variant STRUCTURE + dispatch.** Commands carry a
 * `derivedCommands.{picking,depth,shadows}.*` structure, and
 * `selectCommandVariant` (WebGPUSceneRenderer.ts) dispatches through it
 * every frame for pick/depth/shadow passes. That half does not live in
 * this file, but it is the consumer the factory below was designed for.
 *
 * **Scaffold half — THIS file (currently no-op-pending, per CLAUDE.md
 * Principle 7 these are not dead code):**
 * - `create{DepthOnly,LogDepth,Pick,HDR,Shadow}DerivedCommand` and the
 *   `WebGPUSceneRenderer.createDerivedCommand` wrapper have ZERO callers —
 *   the fork matured around PER-RENDERER variant creation instead (each
 *   collection/model/classifier renderer builds its own pick/depth/velocity
 *   pipelines inline).
 * - The `_depthOnly`/`_logDepth`/`_pickMode`/`_hdrMode`/`_shadowMode`/
 *   `_colorWriteMask`/`_cullMode`/`_depthBias*` flags the factories set are
 *   read by nothing yet — they await the pipeline-build layer that turns
 *   them into mutated GPURenderPipeline descriptors.
 * - `_pipelineCache`/`_shaderCache` are never populated; `clearCache()` and
 *   `getCacheStats()` run against empty maps.
 *
 * Why the centralized factory stays (planned fill-in order):
 * 1. **First consumer: the NEW-COLLECTIONS-LOG-DEPTH epic** — porting czm
 *    log-depth needs ONE uniform depth transformation applied across EVERY
 *    collection + globe pipeline; a descriptor-variant layer is exactly
 *    that, vs. hand-editing each renderer's pipeline creation.
 * 2. Deduplicating the per-renderer pick/velocity/depth pipeline-variant
 *    code (~the same descriptor surgery re-implemented per renderer).
 * 3. Enforcing invariants centrally, e.g. the MSAA-bake rule — every
 *    scene-FB pipeline must bake `multisample.count = context._msaaSamples`
 *    (the Batch-228 Cloud pass-kill bug class becomes impossible when one
 *    factory stamps every variant).
 *
 * Design (unchanged from the original skeleton): in WebGL, DerivedCommand
 * mutates ShaderPrograms by injecting defines and replacing fragment shader
 * code. In WebGPU, variants are pipeline-descriptor mutations
 * (colorWriteMask, depthBias, formats, …) plus shader-module swaps.
 *
 * @private
 */

/** Types of derived command variants */
export enum DerivedCommandType {
  LOG_DEPTH = "logDepth",
  DEPTH_ONLY = "depthOnly",
  PICK = "pick",
  HDR = "hdr",
  SHADOW = "shadow",
}

/** A cached derived command with dirty tracking */
export interface DerivedCommandResult {
  command: CesiumAnyDrawCommand | undefined;
  shaderModuleId?: number;
  pipelineKey?: string;
}

/**
 * Cache key for derived pipeline variants.
 * Combines the base pipeline key with the derived type.
 */
function makeDerivedKey(
  basePipelineKey: string,
  type: DerivedCommandType,
): string {
  return `${basePipelineKey}__${type}`;
}

export class WebGPUDerivedCommand {
  // Pipeline variant cache: derivedKey → GPURenderPipeline
  private static _pipelineCache = new Map<string, GPURenderPipeline>();

  // Shader module cache: shaderKey → GPUShaderModule
  private static _shaderCache = new Map<string, GPUShaderModule>();

  /**
   * Create a depth-only derived command from a base WebGPU draw command.
   *
   * In WebGL, this replaces the fragment shader with a pass-through and
   * sets colorMask to all false. In WebGPU, we modify the pipeline descriptor:
   * - colorTargets[*].writeMask = 0 (no color writes)
   * - depthWriteEnabled = true
   *
   * @param command The base WebGPU draw command
   * @param result Optional cached result to reuse
   * @returns The derived command result
   */
  static createDepthOnlyDerivedCommand(
    command: CesiumAnyDrawCommand,
    result?: DerivedCommandResult,
  ): DerivedCommandResult {
    if (!result) {
      result = { command: undefined };
    }

    // Clone the draw command with depth-only overrides
    const derived = command.clone
      ? command.clone()
      : Object.assign({}, command);

    // Override pipeline state for depth-only rendering
    derived._depthOnly = true;
    derived._colorWriteMask = 0; // GPUColorWrite.NONE
    derived._depthWriteEnabled = true;

    result.command = derived;
    return result;
  }

  /**
   * Create a log-depth derived command.
   *
   * Log depth is critical for multi-frustum rendering - it writes
   * logarithmic depth values that map better to the 0-1 depth range.
   *
   * In WebGPU with 0-1 depth range, log depth has slightly different
   * characteristics than WebGL's -1..1 range. The log depth fragment
   * writes: fragDepth = log2(1 + w) / log2(1 + far)
   *
   * @param command The base WebGPU draw command
   * @param result Optional cached result to reuse
   * @returns The derived command result with log depth enabled
   */
  static createLogDepthCommand(
    command: CesiumAnyDrawCommand,
    result?: DerivedCommandResult,
  ): DerivedCommandResult {
    if (!result) {
      result = { command: undefined };
    }

    const derived = command.clone
      ? command.clone()
      : Object.assign({}, command);

    // Mark the command for log depth rendering
    derived._logDepth = true;

    result.command = derived;
    return result;
  }

  /**
   * Create a pick derived command.
   *
   * Replaces material color output with the pick color (unique ID per object).
   * Used for GPU-based object identification via readPixels.
   *
   * @param command The base WebGPU draw command
   * @param pickId The pick color as [r, g, b, a] normalized
   * @param result Optional cached result to reuse
   * @returns The derived command result
   */
  static createPickDerivedCommand(
    command: CesiumAnyDrawCommand,
    pickId: number[],
    result?: DerivedCommandResult,
  ): DerivedCommandResult {
    if (!result) {
      result = { command: undefined };
    }

    const derived = command.clone
      ? command.clone()
      : Object.assign({}, command);

    derived._pickMode = true;
    derived._pickColor = pickId;

    result.command = derived;
    return result;
  }

  /**
   * Create an HDR derived command.
   *
   * When rendering to HDR render targets, the fragment output format
   * changes from rgba8unorm to rgba16float. The pipeline must match.
   *
   * @param command The base WebGPU draw command
   * @param result Optional cached result to reuse
   * @returns The derived command result
   */
  static createHDRDerivedCommand(
    command: CesiumAnyDrawCommand,
    result?: DerivedCommandResult,
  ): DerivedCommandResult {
    if (!result) {
      result = { command: undefined };
    }

    const derived = command.clone
      ? command.clone()
      : Object.assign({}, command);

    derived._hdrMode = true;
    derived._colorTargetFormat = "rgba16float";

    result.command = derived;
    return result;
  }

  /**
   * Create a shadow-casting derived command.
   *
   * Renders to the shadow map depth texture from the light's perspective.
   * Uses depth-only rendering with front-face culling (to reduce shadow acne).
   *
   * @param command The base WebGPU draw command
   * @param result Optional cached result to reuse
   * @returns The derived command result
   */
  static createShadowDerivedCommand(
    command: CesiumAnyDrawCommand,
    result?: DerivedCommandResult,
  ): DerivedCommandResult {
    if (!result) {
      result = { command: undefined };
    }

    const derived = command.clone
      ? command.clone()
      : Object.assign({}, command);

    derived._shadowMode = true;
    derived._depthOnly = true;
    derived._colorWriteMask = 0;
    derived._depthWriteEnabled = true;
    // Use front-face culling for shadow casting to reduce shadow acne
    derived._cullMode = "front";
    // Apply depth bias to further reduce shadow acne
    derived._depthBias = 1;
    derived._depthBiasSlopeScale = 1.0;

    result.command = derived;
    return result;
  }

  /**
   * Clear all cached derived pipelines and shaders.
   * Should be called when the device is lost or context changes.
   */
  static clearCache(): void {
    WebGPUDerivedCommand._pipelineCache.clear();
    WebGPUDerivedCommand._shaderCache.clear();
  }

  /**
   * Get cache statistics for debugging.
   */
  static getCacheStats(): { pipelines: number; shaders: number } {
    return {
      pipelines: WebGPUDerivedCommand._pipelineCache.size,
      shaders: WebGPUDerivedCommand._shaderCache.size,
    };
  }
}
