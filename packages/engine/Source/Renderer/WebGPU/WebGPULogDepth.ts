/**
 * Shared infrastructure for WebGPU logarithmic depth. This module provides the
 * common gate for participating scene and pick paths and packs per-frustum
 * log-depth scalars into reserved `.w` lanes of the shared `CameraUniforms`
 * struct.
 *
 * # Why this exists
 *
 * Across a single [near, far] frustum spanning the planet, one 24-bit
 * hyperbolic-depth quantum is about 73 km of reconstructed eye-z at a 350 km
 * surface. That is wider than a classified polygon, so textured-material
 * classification can reconstruct banded UV coordinates and far-distance
 * picking loses precision. Logarithmic depth redistributes the same precision
 * to about 0.42 m per quantum. Producers and depth consumers must select the
 * same encoding.
 *
 * # Gating
 *
 * Participating producers set `LOG_DEPTH`, and matching consumers reverse the
 * encoding, exactly when {@link isWebGPULogDepthActive} returns true:
 * `context._logDepthWriteEnabled && frameState.useLogDepth`. The context master
 * switch defaults to true. Setting it false selects the participating paths'
 * hyperbolic branches.
 *
 * # CameraUniforms `.w`-lane convention
 *
 * The 368-byte `CameraUniforms` struct reserves three `.w` padding lanes. Log
 * depth uses them without a struct-size or offset change, so every packer keeps
 * its float indices:
 *
 *   float 51  cameraPosition.w               = oneOverLog2FarDepthFromNearPlusOne
 *   float 55  encodedCameraPositionMCHigh.w  = frustum near
 *   float 59  encodedCameraPositionMCLow.w   = frustum far
 *
 * Producers using the shared struct call {@link packCameraLogDepthLanes} after
 * packing their `CameraUniforms`; the globe (bespoke 116-float layout) and the
 * handful of custom classifier UBs carry the same three scalars in their own
 * reserved lanes (wired alongside their `frag_depth` write).
 * @module WebGPULogDepth
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

interface PickLogDepthContext {
  readonly _pickLogDepthWriteEnabled?: boolean;
}

interface LogDepthFrameState {
  readonly useLogDepth?: boolean;
}

/**
 * True when participating scene producers should write logarithmic depth and
 * matching consumers should reverse it this frame. The context master switch
 * defaults to true; `frameState.useLogDepth` carries the scene's per-frame
 * depth decision.
 */
export function isWebGPULogDepthActive(
  context: LogDepthContext | null | undefined,
  frameState: LogDepthFrameState | null | undefined,
): boolean {
  return !!context?._logDepthWriteEnabled && !!frameState?.useLogDepth;
}

/**
 * True when the native WebGPU pick fleet's shared depth attachment uses
 * logarithmic encoding. Picking has a separate gate from
 * {@link isWebGPULogDepthActive} because the pick mini-frame owns one shared
 * depth attachment: every producer must use the same encoding or depth tests
 * become incoherent. A logarithmic value near 0.4 can over-occlude a
 * hyperbolic value near 0.999 across the disk. The context defaults this gate
 * to true; false selects uniformly hyperbolic picking. Opaque and masked
 * producers write logarithmic depth, while blended and translucent picks
 * remain depth-test-only.
 */
export function isWebGPUPickLogDepthActive(
  context: (LogDepthContext & PickLogDepthContext) | null | undefined,
  frameState: LogDepthFrameState | null | undefined,
): boolean {
  return !!context?._pickLogDepthWriteEnabled && !!frameState?.useLogDepth;
}

/**
 * Debug-only recorder for the exact near, far, and factor values a log-depth
 * producer bakes.
 *
 * Comparing the source fields each producer reads does not establish the
 * runtime values it packed. A post-render `UniformState` sample also contains
 * only the last frustum slice, not necessarily the values packed during each
 * producer's update. Collection and depth-plane paths can use the stashed
 * full-camera encode while globe and Gaussian-splat paths use the live current
 * frustum; those values agree only when no intervening re-slice occurs.
 * Recording the triple at write time exposes divergent encoders directly.
 *
 * The call sites and this body are stripped from release builds.
 *
 * @param uniformState  the shared UniformState the probe reads back from
 * @param producer      short producer key ("splat", "globe", "collection", ...)
 * @param near          the near plane baked into that producer's buffer
 * @param far           the far plane the factor was derived from
 * @param factor        the baked `oneOverLog2FarDepthFromNearPlusOne`
 */
export function recordLogDepthEncoder(
  uniformState: unknown,
  producer: string,
  near: number,
  far: number,
  factor: number,
): void {
  //>>includeStart('debug', pragmas.debug);
  if (!uniformState) {
    return;
  }
  const state = uniformState as {
    _diagLogDepthEncoders?: Record<string, [number, number, number]>;
  };
  state._diagLogDepthEncoders ??= {};
  state._diagLogDepthEncoders[producer] = [near, far, factor];
  //>>includeEnd('debug');
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
