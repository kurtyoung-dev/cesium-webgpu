/**
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
 * `_logDepthWriteEnabled` master switch now defaults TRUE — Batch 251
 * (NEW-COLLECTIONS-LOG-DEPTH master-switch) flipped it on, so renderer-wide
 * log depth is LIVE by default. Historically the switch defaulted FALSE while
 * the epic was landed slice-by-slice so each producer/consumer change stayed
 * inert until the flip (the lanes below are packed regardless — they only fill
 * previously-zero pads — but no shader read them and no pipeline set the
 * define until the switch flipped). Keeping the switch gives a one-line kill
 * switch: flipping it false restores hyperbolic NDC depth everywhere.
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
 * True when the WebGPU PICK fleet should write log-encoded `@builtin(frag_depth)`
 * this frame. This is a SEPARATE flip point from {@link isWebGPULogDepthActive}
 * because the pick mini-frame owns its own single shared depth attachment
 * (`WebGPUSceneRendererPickPass` `depthView`, INV-2): the whole pick fleet must
 * be uniformly hyperbolic OR uniformly log — a mixed FBO depth-tests
 * incoherently (a log producer at ~0.4 over-occludes a hyperbolic producer at
 * ~0.999 over the entire disk). The scene half (`_logDepthWriteEnabled`) is
 * already TRUE by default, but the pick fleet is still uniformly hyperbolic, so
 * this master switch defaults FALSE and stays there until EVERY native pick
 * producer writes log frag_depth in one coordinated change (C10-11,
 * `NEW-WEBGPU-PICK-FLEET-LOG-DEPTH`). The voxel pick
 * (`NEW-WEBGPU-VOXEL-PICK-LOG-DEPTH`) is the first producer wired to this gate —
 * it was the fleet blocker because it had ZERO log-depth infrastructure. With
 * the switch FALSE the voxel pick module carries no `LOG_DEPTH` define and its
 * pick pipelines keep `depthWriteEnabled:false` → byte-identical to the
 * pre-conversion pick FBO. C10-11 flips this true after converting the rest of
 * the fleet.
 */
export function isWebGPUPickLogDepthActive(
  context: (LogDepthContext & PickLogDepthContext) | null | undefined,
  frameState: LogDepthFrameState | null | undefined,
): boolean {
  return !!context?._pickLogDepthWriteEnabled && !!frameState?.useLogDepth;
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
