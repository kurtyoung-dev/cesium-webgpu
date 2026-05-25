/**
 * WebGPUSceneFBTargetHelpers — centralized fragment-target-array builders
 * for pipelines that draw into the scene framebuffer render pass.
 *
 * # Why this exists (Slice 5c-B Phase 1, Batch 105)
 *
 * WebGPU requires a pipeline's color-target count to match the render
 * pass's color-attachment count exactly. To wire up MRT G-buffer output
 * on the globe (Slice 5c-B Phase 2), the scene-FB render pass needs a
 * 2nd color attachment (the G-buffer normal-roughness texture). That
 * means EVERY pipeline that draws into the scene-FB pass must declare 2
 * targets — slot 0 is the existing scene color, slot 1 is either:
 *
 *   - The actual MRT output (globe terrain — populated with eye-space
 *     normal + roughness)
 *   - Or `null` (every other primitive — declared so the descriptor
 *     count matches, but the shader doesn't write to it)
 *
 * Today (`mrtMode === false`) all pipelines stay single-target. The
 * Phase 2 atomic batch flips `setSceneFBMrtMode(true)`, at which point
 * every consumer of this helper automatically produces 2-target
 * descriptors. No per-renderer edits needed at flip time.
 *
 * # Usage pattern
 *
 *     import { makeSceneFBTargets } from "./WebGPUSceneFBTargetHelpers.js";
 *
 *     // In a pipeline descriptor builder:
 *     fragment: {
 *       module: shaderModule,
 *       entryPoint: "fragmentMain",
 *       targets: makeSceneFBTargets(canvasFormat, { translucent, writeMask }),
 *     }
 *
 * # Behavior matrix
 *
 *   |  mrtMode  | translucent | writeMask | Result                              |
 *   |  ------   |  ---------  |  ------   |  ---------------                    |
 *   |  off      |   false     |  0xf      | [{format, writeMask: 0xf}]          |
 *   |  off      |   true      |  0xf      | [{format, blend: alpha, mask: 0xf}] |
 *   |  off      |   false     |  0x0      | [{format, writeMask: 0x0}]          |
 *   |  on       |   any       |  any      | [<above>, null]                     |
 *
 * # Restrictions
 *
 *   - DO NOT use this helper for pipelines whose color target is NOT
 *     the scene framebuffer. Pick FB, OIT accumulation FB, shadow maps,
 *     post-process intermediate textures, BRDF LUT generation, etc. all
 *     have their own render passes with their own attachment counts.
 *     Using this helper there would produce wrong-shaped target arrays
 *     when MRT mode flips on.
 *
 *   - For globe terrain (the ONLY pipeline that populates slot 1 with
 *     real data), use `makeSceneFBTargetsMRT(format, mrtFormat, ...)`
 *     which always returns 2 targets — globe should populate slot 1
 *     unconditionally (even in mrtMode=off, the slot is just a
 *     placeholder write).
 *
 * @module WebGPUSceneFBTargetHelpers
 */

// Module-scoped MRT mode flag. Default off — Phase 1 conversions are
// behavior-preserving (1-target arrays). Phase 2 flips this to true,
// at which point every consumer of `makeSceneFBTargets` produces
// 2-target arrays without per-file edits.
//
// SUB-C INVESTIGATION (Slice 5c-B, currently DEBUG): flipped to true
// with probe-mrt-validation.mjs hooked to capture the actual WebGPU
// validation error. DO NOT ship this flip without the matching globe
// pipeline 2-target declaration AND render pass 2-attachment setup.
let _mrtMode = true;

/**
 * Format of the G-buffer normal-roughness texture (slot 1 in the
 * scene-FB render pass when MRT is on). Matches
 * `GBufferFramebuffer.js`'s `rgba16float` allocation.
 */
export const MRT_NORMAL_ROUGHNESS_FORMAT: GPUTextureFormat = "rgba16float";

/**
 * Enable / disable MRT mode globally. Phase 2 atomic batch will call
 * `setSceneFBMrtMode(true)` once; Phase 1 batches leave it off.
 *
 * Idempotent and cheap — just sets the module variable. Caller must
 * ensure pipeline cache is invalidated after a flip so cached
 * 1-target pipelines are rebuilt with 2 targets.
 */
export function setSceneFBMrtMode(enabled: boolean): void {
  _mrtMode = enabled;
}

/**
 * Query the current MRT mode. Used by Phase 2 wiring (render pass
 * setup, G-buffer allocation, globe pipeline target population).
 * Phase 1 callers don't need to check — they just use `makeSceneFBTargets`.
 */
export function isSceneFBMrtMode(): boolean {
  return _mrtMode;
}

/**
 * Per-pipeline options for {@link makeSceneFBTargets}.
 *
 * @property translucent - When true, the slot-0 target includes the
 *   standard "src-alpha over" blend descriptor. Default false (opaque).
 * @property writeMask - GPU color write mask for slot 0. Default 0xf
 *   (all channels). Set 0 for depth-only / stencil-only passes that
 *   share the scene-FB shader module but don't emit color.
 * @property blend - Custom blend descriptor to override the default
 *   alpha blend selected by `translucent: true`. Pass when the pipeline
 *   needs additive, premultiplied, or other non-standard blending.
 */
export interface SceneFBTargetOptions {
  translucent?: boolean;
  writeMask?: GPUColorWriteFlags;
  blend?: GPUBlendState;
  /**
   * Slice 5c-B Batch 118 — when true, the slot-1 G-buffer target uses
   * `writeMask: 0xf` (real emit) instead of the default `writeMask: 0`
   * (placeholder). Use this for pipelines whose shader DOES emit
   * `@location(1) normalRoughness: vec4<f32>` via the `FragOutput`
   * struct pattern (see GlobeTerrain.wgsl for the reference). When
   * the shader doesn't emit @location(1) but you set this to true,
   * WebGPU rejects pipeline creation with `GPUPipelineError: Color
   * target has no corresponding fragment output` (the Batch 116 bisect
   * failure mode). Default false — keeps the placeholder so the
   * pipeline declares the slot for pass-compatibility but doesn't
   * write to it.
   */
  emitsGBuffer?: boolean;
}

/**
 * Build a `targets:` array for a render pipeline that draws into the
 * scene framebuffer. The slot-0 target carries the actual color output;
 * slot 1 (when MRT mode is on) is `null` because most primitives do
 * NOT populate the G-buffer normal-roughness attachment — only globe
 * terrain does, and it should use {@link makeSceneFBTargetsMRT} below.
 *
 * @param format - The scene framebuffer color format. Always the value
 *   of `context.scenePipelineFormat` for scene-FB consumers.
 * @param options - See {@link SceneFBTargetOptions}.
 * @returns A `targets` array suitable for the pipeline descriptor.
 *   Length 1 when MRT is off, length 2 (with null at slot 1) when on.
 */
export function makeSceneFBTargets(
  format: GPUTextureFormat,
  options: SceneFBTargetOptions = {},
): Array<GPUColorTargetState | null> {
  const slot0 = _buildSlot0(format, options);
  if (!_mrtMode) {
    return [slot0];
  }
  // Slot 1: non-null with writeMask=0. WebGPU's validator treats
  // trailing `null` in a pipeline's targets array as "slot absent" —
  // a pipeline `[scene, null]` is effectively length 1 from the
  // pass-vs-pipeline compatibility check's perspective, so against a
  // 2-attachment render pass the validator rejects with "attachment
  // state not compatible" (Batch 117 discovery — original Batch 116
  // never tripped this because the only converted renderer that
  // actually drew on the test view was the globe, which Batch 116
  // also wrapped with explicit 2 targets).
  //
  // The non-null placeholder shape `{format, writeMask: 0}` declares
  // the target slot WITHOUT requiring the shader to emit
  // @location(1) — writeMask=0 means "don't write" so the validator
  // doesn't enforce the "color target has no corresponding fragment
  // output" check that bites writeMask=0xf without the shader emit.
  // The pipeline's target count is then 2 (matches the pass), and
  // the slot stays at whatever the attachment loaded with (the
  // (0,0,0,1) sentinel set by `buildMrtSlot1Attachment`).
  //
  // Slice 5c-B Batch 118 — `options.emitsGBuffer = true` flips slot 1
  // to writeMask=0xf for pipelines whose shader DOES emit @location(1)
  // (currently only converted primitive renderers; see
  // NEW-GBUFFER-MRT-PRIMITIVE-EMIT in DEFERRED_WORK.md for the arc).
  const slot1WriteMask = options.emitsGBuffer ? 0xf : 0;
  return [
    slot0,
    { format: MRT_NORMAL_ROUGHNESS_FORMAT, writeMask: slot1WriteMask },
  ];
}

/**
 * Build a `targets:` array for the GLOBE pipeline — always 2 targets,
 * slot 0 = scene color, slot 1 = G-buffer normal-roughness. Used only
 * by `WebGPUGlobeSurfacePipelines.ts::buildPipelineDescriptor`.
 *
 * Note: in mrtMode=off, this STILL returns 2 targets — but the globe
 * isn't actually populating slot 1 with real data yet (the slot-1
 * value is whatever the fragment shader writes, which today is nothing
 * because the shader still declares a single @location(0) output).
 * Phase 2 flips both the MRT mode AND the globe shader together, so
 * mrtMode=off + this helper called = the globe pipeline carries an
 * extra-target descriptor but the render pass still has 1 attachment
 * → pipeline validation would fail. Don't call this until Phase 2.
 *
 * @param format - The scene framebuffer color format (slot 0).
 * @param options - See {@link SceneFBTargetOptions}.
 * @returns A 2-target array.
 */
export function makeSceneFBTargetsMRT(
  format: GPUTextureFormat,
  options: SceneFBTargetOptions = {},
): Array<GPUColorTargetState | null> {
  const slot0 = _buildSlot0(format, options);
  const slot1: GPUColorTargetState = {
    format: MRT_NORMAL_ROUGHNESS_FORMAT,
    writeMask: 0xf,
  };
  return [slot0, slot1];
}

/**
 * Shared slot-0 builder. Mirrors the local `makeFragmentTarget` that
 * lives in `WebGPUPrimitiveCommands.js:396` so callers converted from
 * that pattern get byte-identical descriptors.
 *
 * @private
 */
function _buildSlot0(
  format: GPUTextureFormat,
  options: SceneFBTargetOptions,
): GPUColorTargetState {
  // Only emit writeMask when it's non-default — WebGPU defaults to 0xf
  // when omitted, and emitting the explicit value would change the
  // descriptor's serialized shape, shifting pipeline-cache hashes for
  // every converted file. Omit-when-default keeps the cache stable
  // across Phase 1 conversions.
  const wm = options.writeMask;
  const includeWriteMask = wm !== undefined && wm !== 0xf;
  if (options.blend) {
    return includeWriteMask
      ? { format, blend: options.blend, writeMask: wm }
      : { format, blend: options.blend };
  }
  if (options.translucent) {
    const alphaBlend: GPUBlendState = {
      color: {
        srcFactor: "src-alpha",
        dstFactor: "one-minus-src-alpha",
        operation: "add",
      },
      alpha: {
        srcFactor: "one",
        dstFactor: "one-minus-src-alpha",
        operation: "add",
      },
    };
    return includeWriteMask
      ? { format, blend: alphaBlend, writeMask: wm }
      : { format, blend: alphaBlend };
  }
  return includeWriteMask ? { format, writeMask: wm } : { format };
}
