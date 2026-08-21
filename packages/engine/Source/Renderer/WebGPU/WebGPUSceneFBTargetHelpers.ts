/**
 * Centralized fragment-target-array builders for pipelines that draw into the
 * scene framebuffer render pass.
 *
 * WebGPU requires a pipeline's color-target slots to match the render pass's
 * color attachments. The scene framebuffer normally uses two slots: scene
 * color at slot 0 and the normal-roughness G-buffer at slot 1. A pipeline that
 * emits G-buffer data enables writes to slot 1; other scene pipelines declare
 * the same slot with a zero write mask so their shaders need no second output.
 * Disabling MRT mode produces a single slot-0 target for a matching
 * single-attachment render pass.
 *
 * Example:
 *
 *     import { makeSceneFBTargets } from "./WebGPUSceneFBTargetHelpers.js";
 *
 *     fragment: {
 *       module: shaderModule,
 *       entryPoint: "fragmentMain",
 *       targets: makeSceneFBTargets(canvasFormat, { translucent, writeMask }),
 *     }
 *
 * This helper is only for the scene framebuffer. Pick, order-independent
 * transparency, shadow, post-process, and lookup-texture render passes have
 * different attachment layouts and must declare targets that match those
 * layouts. A shader that always emits normal-roughness data may use
 * {@link makeSceneFBTargetsMRT}, but only with a two-attachment render pass.
 *
 * @module WebGPUSceneFBTargetHelpers
 */

// The scene pass starts in MRT mode, so every helper consumer declares the two
// target slots expected by that pass. Changing this mode requires a matching
// render-pass topology and invalidation of pipelines cached for the old shape.
let _mrtMode = true;

/**
 * Format of the G-buffer normal-roughness texture (slot 1 in the
 * scene-FB render pass when MRT is on). Matches
 * `GBufferFramebuffer.js`'s `rgba16float` allocation.
 */
export const MRT_NORMAL_ROUGHNESS_FORMAT: GPUTextureFormat = "rgba16float";

/**
 * Enables or disables scene-framebuffer MRT target generation. The operation
 * only changes the module flag; the caller must also provide a matching render
 * pass and invalidate cached pipelines whose target count has changed.
 */
export function setSceneFBMrtMode(enabled: boolean): void {
  _mrtMode = enabled;
}

/**
 * Returns whether scene-framebuffer pipelines and render passes use the MRT
 * attachment layout.
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
   * When true, the slot-1 G-buffer target uses `writeMask: 0xf` instead of
   * the zero-mask placeholder. The fragment shader must emit
   * `@location(1) normalRoughness: vec4<f32>` when this is enabled; otherwise
   * WebGPU rejects pipeline creation because the color target has no matching
   * fragment output. The default is false so pipelines can declare the slot
   * for render-pass compatibility without writing to it.
   */
  emitsGBuffer?: boolean;
}

/**
 * Builds a `targets:` array for a pipeline that draws into the scene
 * framebuffer. Slot 0 carries scene color. When MRT mode is enabled, slot 1 is
 * a non-null normal-roughness target whose write mask is zero unless
 * `options.emitsGBuffer` is true.
 *
 * @param format - The scene framebuffer color format, normally
 *   `context.scenePipelineFormat`.
 * @param options - See {@link SceneFBTargetOptions}.
 * @returns A pipeline target array with one slot when MRT is disabled and two
 *   slots when it is enabled.
 */
export function makeSceneFBTargets(
  format: GPUTextureFormat,
  options: SceneFBTargetOptions = {},
): Array<GPUColorTargetState | null> {
  const slot0 = _buildSlot0(format, options);
  if (!_mrtMode) {
    return [slot0];
  }
  // A trailing null target is treated as an absent slot and is incompatible
  // with a two-attachment render pass. The non-null zero-mask target declares
  // slot 1 without requiring a matching fragment output and preserves the
  // value loaded into the attachment. Pipelines that emit `@location(1)` use a
  // full write mask instead.
  const slot1WriteMask = options.emitsGBuffer ? 0xf : 0;
  return [
    slot0,
    { format: MRT_NORMAL_ROUGHNESS_FORMAT, writeMask: slot1WriteMask },
  ];
}

/**
 * Builds a two-target descriptor for a shader that always emits scene color at
 * slot 0 and normal-roughness data at slot 1. This function is independent of
 * the module MRT flag, so callers must use it only with a two-attachment render
 * pass and a fragment shader that provides both outputs.
 *
 * @param format - The scene framebuffer color format at slot 0.
 * @param options - See {@link SceneFBTargetOptions}.
 * @returns A two-target array with writes enabled for slot 1.
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
 * Builds the shared scene-color target descriptor used at slot 0.
 *
 * @private
 */
function _buildSlot0(
  format: GPUTextureFormat,
  options: SceneFBTargetOptions,
): GPUColorTargetState {
  // WebGPU defaults an omitted write mask to 0xf. Omitting that default keeps
  // equivalent descriptors in the same serialized shape for pipeline-cache
  // keys.
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
