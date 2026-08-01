import BoundingSphere from "../../Core/BoundingSphere.js";
import Cartesian4 from "../../Core/Cartesian4.js";
import CullingVolume from "../../Core/CullingVolume.js";
import Intersect from "../../Core/Intersect.js";
import CesiumMath from "../../Core/Math.js";
import SceneMode from "../../Scene/SceneMode.js";
import ShadowMode from "../../Scene/ShadowMode.js";

/**
 * Conservative preparation demands for the native WebGPU model path.
 *
 * REJECTED is deliberately much narrower than VIEW. Every unsupported or
 * uncertain lane returns CONSERVATIVE so the existing renderer runs unchanged.
 *
 * @private
 */
const WebGPUModelPreparationDemand = Object.freeze({
  VIEW: "view",
  SHADOW: "shadow",
  CAPTURE: "capture",
  CONSERVATIVE: "conservative",
  REJECTED: "rejected",
} as const);

const WebGPUModelPreparationReason = Object.freeze({
  VIEW_INTERSECTING: "view_intersecting",
  SHADOW_CAST: "shadow_cast",
  CAPTURE_ENABLED: "capture_enabled",
  FRUSTUM_OUTSIDE: "frustum_outside",
  NON_3D_MODE: "non_3d_mode",
  NON_RENDER_PASS: "non_render_pass",
  PICK_PASS: "pick_pass",
  OFFSCREEN_PASS: "offscreen_pass",
  STEREO_UNCERTAIN: "stereo_uncertain",
  CAPTURE_UNCERTAIN: "capture_uncertain",
  SHADOW_STATE_UNCERTAIN: "shadow_state_uncertain",
  SHADOW_MODE_UNCERTAIN: "shadow_mode_uncertain",
  CLASSIFIER: "classifier",
  TILE_OWNED: "tile_owned",
  CULL_DISABLED: "cull_disabled",
  MINIMUM_PIXEL_SIZE: "minimum_pixel_size",
  BOUNDS_MISSING: "bounds_missing",
  BOUNDS_INVALID: "bounds_invalid",
  CULLING_VOLUME_INVALID: "culling_volume_invalid",
} as const);

type PreparationDemand =
  (typeof WebGPUModelPreparationDemand)[keyof typeof WebGPUModelPreparationDemand];
type PreparationReason =
  (typeof WebGPUModelPreparationReason)[keyof typeof WebGPUModelPreparationReason];

interface ModelPreparationDecision {
  demand: PreparationDemand;
  reason: PreparationReason;
}

interface PreparationModelLike {
  _cull?: boolean;
  _content?: unknown;
  _boundingSphere?: BoundingSphere | null;
  _webgpuPreparationAdmissionGap?: boolean;
  _minimumPixelSize?: number;
  boundingSphere?: BoundingSphere;
  classificationType?: number;
  shadows?: number;
}

interface PreparationPassesLike {
  render?: boolean;
  pick?: boolean;
  pickVoxel?: boolean;
  offscreen?: boolean;
}

interface CullingPlaneLike {
  x: number;
  y: number;
  z: number;
  w: number;
}

interface CullingVolumeLike {
  planes?: ArrayLike<CullingPlaneLike>;
}

interface PreparationFrameStateLike {
  frameNumber?: number;
  mode?: number;
  passes?: PreparationPassesLike;
  shadowMaps?: unknown[];
  cullingVolume?: CullingVolumeLike;
  _webgpuModelPreparationCullingVolume?: PreparedFivePlaneCullingVolume;
  _webgpuModelPreparationStatistics?: WebGPUModelPreparationStatistics;
}

interface PreparationContextLike {
  sceneCaptureReflections?: boolean;
  supportsStereoViewport?: boolean;
  _webgpuModelPreparationDiagnosticsEnabled?: boolean;
}

interface WebGPUModelPreparationWorkStatistics {
  preparationRuns: number;
  temporalHistoryResets: number;
  customShaderPreparations: number;
  cameraPacks: number;
  cameraWrites: number;
  effectsPreparations: number;
  materialPacks: number;
  materialUploads: number;
  /**
   * C11-195 — light blocks packed this frame. ONE per model per view since the
   * block moved to the group-0 arena; it was one per PRIMITIVE before, so a
   * count that tracks primitive count again is a regression, not a workload
   * change.
   */
  lightPacks: number;
  /**
   * C11-195 — light blocks staged into the per-frame ring. No longer a count
   * of `queue.writeBuffer` calls: the ring emits one write per dirty page for
   * the whole frame. Equals `lightPacks` by construction (a staged block is
   * never suppressed — its camera-relative contents change with the camera).
   */
  lightWrites: number;
  commandsEmitted: number;
}

interface WebGPUModelPreparationStatistics {
  frameNumber: number;
  candidates: number;
  viewAdmitted: number;
  shadowAdmitted: number;
  captureAdmitted: number;
  conservativeFallbacks: number;
  rejected: number;
  reasons: Record<PreparationReason, number>;
  work: WebGPUModelPreparationWorkStatistics;
}

interface PreparedFivePlaneCullingVolume {
  frameNumber: number;
  valid: boolean;
  volume: CullingVolume;
}

const demandValues = WebGPUModelPreparationDemand;
const reasonValues = WebGPUModelPreparationReason;
const allReasons = Object.freeze(Object.values(reasonValues));

function makeDecision(
  demand: PreparationDemand,
  reason: PreparationReason,
): ModelPreparationDecision {
  return Object.freeze({ demand, reason });
}

// Singleton decisions keep the per-model hot path allocation-free.
const decisions: Record<PreparationReason, ModelPreparationDecision> = {
  [reasonValues.VIEW_INTERSECTING]: makeDecision(
    demandValues.VIEW,
    reasonValues.VIEW_INTERSECTING,
  ),
  [reasonValues.SHADOW_CAST]: makeDecision(
    demandValues.SHADOW,
    reasonValues.SHADOW_CAST,
  ),
  [reasonValues.CAPTURE_ENABLED]: makeDecision(
    demandValues.CAPTURE,
    reasonValues.CAPTURE_ENABLED,
  ),
  [reasonValues.FRUSTUM_OUTSIDE]: makeDecision(
    demandValues.REJECTED,
    reasonValues.FRUSTUM_OUTSIDE,
  ),
  [reasonValues.NON_3D_MODE]: makeDecision(
    demandValues.CONSERVATIVE,
    reasonValues.NON_3D_MODE,
  ),
  [reasonValues.NON_RENDER_PASS]: makeDecision(
    demandValues.CONSERVATIVE,
    reasonValues.NON_RENDER_PASS,
  ),
  [reasonValues.PICK_PASS]: makeDecision(
    demandValues.CONSERVATIVE,
    reasonValues.PICK_PASS,
  ),
  [reasonValues.OFFSCREEN_PASS]: makeDecision(
    demandValues.CONSERVATIVE,
    reasonValues.OFFSCREEN_PASS,
  ),
  [reasonValues.STEREO_UNCERTAIN]: makeDecision(
    demandValues.CONSERVATIVE,
    reasonValues.STEREO_UNCERTAIN,
  ),
  [reasonValues.CAPTURE_UNCERTAIN]: makeDecision(
    demandValues.CONSERVATIVE,
    reasonValues.CAPTURE_UNCERTAIN,
  ),
  [reasonValues.SHADOW_STATE_UNCERTAIN]: makeDecision(
    demandValues.CONSERVATIVE,
    reasonValues.SHADOW_STATE_UNCERTAIN,
  ),
  [reasonValues.SHADOW_MODE_UNCERTAIN]: makeDecision(
    demandValues.CONSERVATIVE,
    reasonValues.SHADOW_MODE_UNCERTAIN,
  ),
  [reasonValues.CLASSIFIER]: makeDecision(
    demandValues.CONSERVATIVE,
    reasonValues.CLASSIFIER,
  ),
  [reasonValues.TILE_OWNED]: makeDecision(
    demandValues.CONSERVATIVE,
    reasonValues.TILE_OWNED,
  ),
  [reasonValues.CULL_DISABLED]: makeDecision(
    demandValues.CONSERVATIVE,
    reasonValues.CULL_DISABLED,
  ),
  [reasonValues.MINIMUM_PIXEL_SIZE]: makeDecision(
    demandValues.CONSERVATIVE,
    reasonValues.MINIMUM_PIXEL_SIZE,
  ),
  [reasonValues.BOUNDS_MISSING]: makeDecision(
    demandValues.CONSERVATIVE,
    reasonValues.BOUNDS_MISSING,
  ),
  [reasonValues.BOUNDS_INVALID]: makeDecision(
    demandValues.CONSERVATIVE,
    reasonValues.BOUNDS_INVALID,
  ),
  [reasonValues.CULLING_VOLUME_INVALID]: makeDecision(
    demandValues.CONSERVATIVE,
    reasonValues.CULLING_VOLUME_INVALID,
  ),
};

function isFiniteBoundingSphere(value: unknown): value is BoundingSphere {
  if (!(value instanceof BoundingSphere)) {
    return false;
  }

  const center = value.center;
  return (
    Number.isFinite(center?.x) &&
    Number.isFinite(center?.y) &&
    Number.isFinite(center?.z) &&
    Number.isFinite(value.radius) &&
    value.radius >= 0.0
  );
}

function createPreparedFivePlaneCullingVolume(): PreparedFivePlaneCullingVolume {
  return {
    frameNumber: Number.NaN,
    valid: false,
    volume: new CullingVolume([
      new Cartesian4(),
      new Cartesian4(),
      new Cartesian4(),
      new Cartesian4(),
      new Cartesian4(),
    ]),
  };
}

/**
 * Validate and copy View's five-plane volume once for all candidate models in
 * this Scene/frame. The source frustum owns mutable plane objects, so model
 * admission must retain its own exact snapshot; doing the normalization check
 * and copy per candidate previously paid five square roots plus twenty field
 * writes for every standalone model.
 */
function getPreparedFivePlaneCullingVolume(
  frameState: PreparationFrameStateLike,
): CullingVolume | undefined {
  let prepared = frameState._webgpuModelPreparationCullingVolume;
  if (!prepared) {
    prepared = createPreparedFivePlaneCullingVolume();
    frameState._webgpuModelPreparationCullingVolume = prepared;
  }

  const frameNumber = frameState.frameNumber ?? -1;
  if (prepared.frameNumber === frameNumber) {
    return prepared.valid ? prepared.volume : undefined;
  }

  prepared.frameNumber = frameNumber;
  prepared.valid = false;
  const cullingVolume = frameState.cullingVolume;
  const planes = cullingVolume?.planes;
  if (!planes || planes.length < 5) {
    return undefined;
  }

  const fivePlaneScratch = prepared.volume.planes;
  for (let i = 0; i < 5; i++) {
    const plane = planes[i];
    const normalMagnitude = plane
      ? Math.sqrt(plane.x * plane.x + plane.y * plane.y + plane.z * plane.z)
      : Number.NaN;
    if (
      !plane ||
      !Number.isFinite(plane.x) ||
      !Number.isFinite(plane.y) ||
      !Number.isFinite(plane.z) ||
      !Number.isFinite(plane.w) ||
      !CesiumMath.equalsEpsilon(normalMagnitude, 1.0, CesiumMath.EPSILON6)
    ) {
      return undefined;
    }
    const scratchPlane = fivePlaneScratch[i];
    scratchPlane.x = plane.x;
    scratchPlane.y = plane.y;
    scratchPlane.z = plane.z;
    scratchPlane.w = plane.w;
  }
  // View's scratch CullingVolume contains exactly these five planes. Never let
  // a stale sixth (far) plane survive a previous call.
  fivePlaneScratch.length = 5;
  prepared.valid = true;
  return prepared.volume;
}

/**
 * Classify whether a model must enter native preparation this frame.
 *
 * The only reject is a finite standalone WC BoundingSphere outside View's
 * five-plane (far-plane-free) camera volume during an ordinary SCENE3D render.
 * Everything else preserves the existing renderer as a conservative fallback.
 *
 * @private
 */
function classifyWebGPUModelPreparationDemand(
  model: PreparationModelLike,
  frameState: PreparationFrameStateLike,
  context: PreparationContextLike,
): ModelPreparationDecision {
  if (frameState.mode !== SceneMode.SCENE3D) {
    return decisions[reasonValues.NON_3D_MODE];
  }

  const passes = frameState.passes;
  if (!passes || passes.render !== true) {
    return decisions[reasonValues.NON_RENDER_PASS];
  }
  if (passes.pick !== false || passes.pickVoxel !== false) {
    return decisions[reasonValues.PICK_PASS];
  }
  if (passes.offscreen !== false) {
    return decisions[reasonValues.OFFSCREEN_PASS];
  }

  // WebGPU currently reports false. If stereo viewport support ever appears,
  // retain the old path until per-eye admission/preparation is designed.
  if (context.supportsStereoViewport !== false) {
    return decisions[reasonValues.STEREO_UNCERTAIN];
  }

  if (context.sceneCaptureReflections === true) {
    return decisions[reasonValues.CAPTURE_ENABLED];
  }
  if (context.sceneCaptureReflections !== false) {
    return decisions[reasonValues.CAPTURE_UNCERTAIN];
  }

  const shadowMaps = frameState.shadowMaps;
  if (!Array.isArray(shadowMaps)) {
    return decisions[reasonValues.SHADOW_STATE_UNCERTAIN];
  }
  const shadowMode = model.shadows;
  if (
    typeof shadowMode !== "number" ||
    !Number.isInteger(shadowMode) ||
    shadowMode < ShadowMode.DISABLED ||
    shadowMode > ShadowMode.RECEIVE_ONLY
  ) {
    return decisions[reasonValues.SHADOW_MODE_UNCERTAIN];
  }
  const castsShadows =
    shadowMode === ShadowMode.ENABLED || shadowMode === ShadowMode.CAST_ONLY;
  if (shadowMaps.length > 0 && castsShadows) {
    return decisions[reasonValues.SHADOW_CAST];
  }

  if (model.classificationType !== undefined) {
    return decisions[reasonValues.CLASSIFIER];
  }
  if (model._content !== undefined && model._content !== null) {
    return decisions[reasonValues.TILE_OWNED];
  }
  if (model._cull !== true) {
    return decisions[reasonValues.CULL_DISABLED];
  }
  // Model's public bounding sphere intentionally excludes the runtime scale
  // applied by minimumPixelSize. Until the native command/culling bounds own
  // that same scale, rejecting against the smaller sphere could hide a model
  // whose enlarged pixels intersect the view.
  if ((model._minimumPixelSize ?? 0.0) > 0.0) {
    return decisions[reasonValues.MINIMUM_PIXEL_SIZE];
  }

  // Model.update() refreshes `_boundingSphere` through
  // updateBoundingSphereAndScale immediately before updateSceneGraph() and
  // submitDrawCommands(). Reading the public getter here would repeat the
  // BoundingSphere.transform for every candidate. Structural/spec hosts that
  // do not expose the internal current sphere retain a conservative getter
  // fallback.
  let boundingSphere = model._boundingSphere;
  if (boundingSphere === undefined) {
    try {
      boundingSphere = model.boundingSphere;
    } catch {
      return decisions[reasonValues.BOUNDS_MISSING];
    }
  }
  if (boundingSphere === undefined || boundingSphere === null) {
    return decisions[reasonValues.BOUNDS_MISSING];
  }
  if (!isFiniteBoundingSphere(boundingSphere)) {
    return decisions[reasonValues.BOUNDS_INVALID];
  }

  const preparedCullingVolume = getPreparedFivePlaneCullingVolume(frameState);
  if (!preparedCullingVolume) {
    return decisions[reasonValues.CULLING_VOLUME_INVALID];
  }

  return preparedCullingVolume.computeVisibility(boundingSphere) ===
    Intersect.OUTSIDE
    ? decisions[reasonValues.FRUSTUM_OUTSIDE]
    : decisions[reasonValues.VIEW_INTERSECTING];
}

function createReasonCounts(): Record<PreparationReason, number> {
  const counts = {} as Record<PreparationReason, number>;
  for (let i = 0; i < allReasons.length; i++) {
    counts[allReasons[i]] = 0;
  }
  return counts;
}

function createWorkStatistics(): WebGPUModelPreparationWorkStatistics {
  return {
    preparationRuns: 0,
    temporalHistoryResets: 0,
    customShaderPreparations: 0,
    cameraPacks: 0,
    cameraWrites: 0,
    effectsPreparations: 0,
    materialPacks: 0,
    materialUploads: 0,
    lightPacks: 0,
    lightWrites: 0,
    commandsEmitted: 0,
  };
}

function resetStatistics(
  statistics: WebGPUModelPreparationStatistics,
  frameNumber: number,
): void {
  statistics.frameNumber = frameNumber;
  statistics.candidates = 0;
  statistics.viewAdmitted = 0;
  statistics.shadowAdmitted = 0;
  statistics.captureAdmitted = 0;
  statistics.conservativeFallbacks = 0;
  statistics.rejected = 0;
  for (let i = 0; i < allReasons.length; i++) {
    statistics.reasons[allReasons[i]] = 0;
  }
  const work = statistics.work;
  work.preparationRuns = 0;
  work.temporalHistoryResets = 0;
  work.customShaderPreparations = 0;
  work.cameraPacks = 0;
  work.cameraWrites = 0;
  work.effectsPreparations = 0;
  work.materialPacks = 0;
  work.materialUploads = 0;
  work.lightPacks = 0;
  work.lightWrites = 0;
  work.commandsEmitted = 0;
}

/** @private */
function getWebGPUModelPreparationStatistics(
  frameState: PreparationFrameStateLike,
  context: PreparationContextLike,
): WebGPUModelPreparationStatistics | undefined {
  if (context._webgpuModelPreparationDiagnosticsEnabled !== true) {
    return undefined;
  }
  let statistics = frameState._webgpuModelPreparationStatistics;
  if (!statistics) {
    statistics = {
      frameNumber: -1,
      candidates: 0,
      viewAdmitted: 0,
      shadowAdmitted: 0,
      captureAdmitted: 0,
      conservativeFallbacks: 0,
      rejected: 0,
      reasons: createReasonCounts(),
      work: createWorkStatistics(),
    };
    frameState._webgpuModelPreparationStatistics = statistics;
  }

  const frameNumber = frameState.frameNumber ?? -1;
  if (statistics.frameNumber !== frameNumber) {
    resetStatistics(statistics, frameNumber);
  }
  return statistics;
}

/** @private */
function recordWebGPUModelPreparationDecision(
  statistics: WebGPUModelPreparationStatistics | undefined,
  decision: ModelPreparationDecision,
): void {
  if (!statistics) {
    return;
  }
  statistics.candidates++;
  statistics.reasons[decision.reason]++;
  switch (decision.demand) {
    case demandValues.VIEW:
      statistics.viewAdmitted++;
      break;
    case demandValues.SHADOW:
      statistics.shadowAdmitted++;
      break;
    case demandValues.CAPTURE:
      statistics.captureAdmitted++;
      break;
    case demandValues.REJECTED:
      statistics.rejected++;
      break;
    default:
      statistics.conservativeFallbacks++;
      break;
  }
}

/** @private */
function markWebGPUModelPreparationRejected(model: PreparationModelLike): void {
  if (model._webgpuPreparationAdmissionGap !== true) {
    model._webgpuPreparationAdmissionGap = true;
  }
}

/** @private */
function consumeWebGPUModelPreparationAdmissionGap(
  model: PreparationModelLike,
): boolean {
  if (model._webgpuPreparationAdmissionGap !== true) {
    return false;
  }
  model._webgpuPreparationAdmissionGap = false;
  return true;
}

declare global {
  interface CesiumFrameState {
    _webgpuModelPreparationCullingVolume?: PreparedFivePlaneCullingVolume;
    _webgpuModelPreparationStatistics?: WebGPUModelPreparationStatistics;
  }
}

export {
  WebGPUModelPreparationDemand,
  WebGPUModelPreparationReason,
  classifyWebGPUModelPreparationDemand,
  consumeWebGPUModelPreparationAdmissionGap,
  getWebGPUModelPreparationStatistics,
  markWebGPUModelPreparationRejected,
  recordWebGPUModelPreparationDecision,
};
export type {
  ModelPreparationDecision,
  PreparationContextLike,
  PreparationFrameStateLike,
  PreparationModelLike,
  WebGPUModelPreparationStatistics,
  WebGPUModelPreparationWorkStatistics,
};

export default {
  WebGPUModelPreparationDemand,
  WebGPUModelPreparationReason,
  classifyWebGPUModelPreparationDemand,
  consumeWebGPUModelPreparationAdmissionGap,
  getWebGPUModelPreparationStatistics,
  markWebGPUModelPreparationRejected,
  recordWebGPUModelPreparationDecision,
};
