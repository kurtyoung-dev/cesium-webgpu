/**
 * @module WebGPULogDepth
 *
 * Shared infrastructure for renderer-wide logarithmic depth (Approach A for
 * NEW-WEBGPU-GLOBE-CLASSIFY-DEPTH-PRECISION). This module is the single point
 * that decides whether log depth is active and packs the per-frustum log-depth
 * scalars into the reserved `.w` lanes of the shared `CameraUniforms` struct.
 *
 * # Why this exists
 *
 * The WebGPU globe (and every other depth producer) currently writes standard
 * hyperbolic NDC z. In a single ~[near, far] log-depth frustum spanning the
 * planet, one 24-bit quantum is ~73 km of reconstructed eye-z at a 350 km
 * surface — far larger than a classified polygon, so textured-material
 * classification reconstructs a banded (flat) UV and far-distance picking is
 * imprecise. Writing logarithmic depth (matching WebGL's `#ifdef LOG_DEPTH`)
 * redistributes precision to ~0.42 m/quantum. See the `LOG_DEPTH` entry in
 * `WebGPUShaderDefines.ts` and the `csm_*LogDepth` chunk family.
 *
 * # Gating — single flip point
 *
 * Producers set the `LOG_DEPTH` shader define, and consumers reverse the
 * encoding, exactly when {@link isWebGPULogDepthActive} returns true. That is
 * `context._logDepthWriteEnabled && frameState.useLogDepth`. The
 * `_logDepthWriteEnabled` master switch defaults FALSE so each slice of the
 * epic lands inert (the lanes below are packed regardless — they only fill
 * previously-zero pads — but no shader reads them and no pipeline sets the
 * define until the switch flips). The final epic commit flips the default to
 * TRUE. Keeping the switch afterwards gives a one-line kill switch.
 *
 * # CameraUniforms `.w`-lane convention
 *
 * The 368-byte `CameraUniforms` struct reserves three `.w` pad lanes that have
 * always carried zero. Log depth repurposes them with NO struct-size or offset
 * change (so every existing packer keeps its float indices):
 *
 *   float 51  cameraPosition.w               = oneOverLog2FarDepthFromNearPlusOne
 *   float 55  encodedCameraPositionMCHigh.w  = frustum near
 *   float 59  encodedCameraPositionMCLow.w   = frustum far
 *
 * Producers using the shared struct call {@link packCameraLogDepthLanes} after
 * packing their `CameraUniforms`; the globe (bespoke 116-float layout) and the
 * handful of custom classifier UBs carry the same three scalars in their own
 * reserved lanes (wired alongside their `frag_depth` write).
 */

/** Float index of `cameraPosition.w` within the CameraUniforms struct. */
export const CAMERA_LOG_FACTOR_FLOAT = 51;
/** Float index of `encodedCameraPositionMCHigh.w` — frustum near. */
export const CAMERA_LOG_NEAR_FLOAT = 55;
/** Float index of `encodedCameraPositionMCLow.w` — frustum far. */
export const CAMERA_LOG_FAR_FLOAT = 59;

interface LogDepthUniformState {
  readonly oneOverLog2FarDepthFromNearPlusOne?: number;
  readonly currentFrustum?: { x: number; y: number };
}

interface LogDepthContext {
  readonly _logDepthWriteEnabled?: boolean;
}

interface LogDepthFrameState {
  readonly useLogDepth?: boolean;
}

/**
 * True when depth producers should write log depth and consumers should reverse
 * it this frame. The master switch (`context._logDepthWriteEnabled`) gates the
 * whole epic; `frameState.useLogDepth` mirrors WebGL's per-frame LOG_DEPTH
 * decision (already true on WebGPU via `Scene.defaultLogDepthBuffer`).
 */
export function isWebGPULogDepthActive(
  context: LogDepthContext | null | undefined,
  frameState: LogDepthFrameState | null | undefined,
): boolean {
  return !!context?._logDepthWriteEnabled && !!frameState?.useLogDepth;
}

/**
 * Pack the per-frustum log-depth scalars into the reserved `.w` lanes of a
 * `CameraUniforms`-layout Float32Array. Safe to call unconditionally — it only
 * fills previously-zero pad lanes, so it is inert until a shader reads them and
 * a pipeline activates the `LOG_DEPTH` define.
 *
 * @param data   the Float32Array holding the CameraUniforms struct
 * @param floatBase  float index where the CameraUniforms struct begins (0 for
 *                   a dedicated camera UB; non-zero only if embedded in a larger
 *                   buffer)
 * @param uniformState  source of the frustum near/far + the precomputed factor
 */
export function packCameraLogDepthLanes(
  data: Float32Array,
  floatBase: number,
  uniformState: LogDepthUniformState | null | undefined,
): void {
  if (!uniformState) {
    return;
  }
  const frustum = uniformState.currentFrustum;
  const near = frustum?.x ?? 0.0;
  const far = frustum?.y ?? 0.0;
  // Prefer the precomputed reciprocal; derive it if the UniformState hasn't
  // populated it yet (very early frame). log2((far - near) + 1) matches
  // czm_oneOverLog2FarDepthFromNearPlusOne.
  let factor = uniformState.oneOverLog2FarDepthFromNearPlusOne ?? 0.0;
  if (!(factor > 0.0) && far > near) {
    const log2Far = Math.log2(far - near + 1.0);
    factor = log2Far > 0.0 ? 1.0 / log2Far : 0.0;
  }
  data[floatBase + CAMERA_LOG_FACTOR_FLOAT] = factor;
  data[floatBase + CAMERA_LOG_NEAR_FLOAT] = near;
  data[floatBase + CAMERA_LOG_FAR_FLOAT] = far;
}
