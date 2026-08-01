/// <reference types="@webgpu/types" />

/**
 * Minimal context surface needed by feature renderers that can record work on
 * the scene frame's command encoder.
 *
 * The public getter is preferred. The underscore fields keep compatibility
 * with older test doubles and renderer call sites that predate the getter.
 *
 * @private
 */
export interface WebGPUFrameCommandEncoderContext {
  readonly currentCommandEncoder?: GPUCommandEncoder | null;
  readonly _currentCommandEncoder?: GPUCommandEncoder | null;
  readonly hasActiveRenderPass?: boolean;
  readonly _currentRenderPassEncoder?: GPURenderPassEncoder | null;
}

/**
 * Return the frame-owned command encoder when it is safe to open another pass.
 *
 * Feature updates run after `beginFrame()` and before the scene render pass, so
 * their compute work can normally join the frame submission. An off-frame
 * caller, or a caller reached while a render pass is already open, receives
 * `null` and must retain its existing private-encoder fallback.
 *
 * @param context WebGPU context or a compatible test double.
 * @returns The available frame encoder, or null when the caller must fall back.
 * @private
 */
export function getAvailableFrameCommandEncoder(
  context: unknown,
): GPUCommandEncoder | null {
  if (!context) {
    return null;
  }

  const frameContext = context as WebGPUFrameCommandEncoderContext;

  if (
    frameContext.hasActiveRenderPass === true ||
    frameContext._currentRenderPassEncoder != null
  ) {
    return null;
  }

  return (
    frameContext.currentCommandEncoder ??
    frameContext._currentCommandEncoder ??
    null
  );
}

export default getAvailableFrameCommandEncoder;
