/**
 * Coarse temporal-history validity contract for procedural clouds.
 *
 * C13-05 owns camera-relative reprojection and correctness-preserving history
 * invalidation. This classifier deliberately handles only discontinuities that
 * make the previous transform or cloud-shell topology unusable. Continuous
 * bounded camera motion and ordinary clock/wind evolution preserve history;
 * C13-12 owns wind-aware reprojection, reactive masks, variance clipping, and
 * selective invalidation for richer reconstruction attachments.
 *
 * The caller owns both mutable records and reuses them every frame. Neither
 * classifier nor commit function creates arrays, objects, or typed-array views.
 */

export const CLOUD_TEMPORAL_TELEPORT_THRESHOLD_METERS = 50_000.0;

export const CLOUD_TEMPORAL_RESET_NONE = 0;
export const CLOUD_TEMPORAL_RESET_INITIAL = 1 << 0;
export const CLOUD_TEMPORAL_RESET_MISSING_TRANSFORM = 1 << 1;
export const CLOUD_TEMPORAL_RESET_FRAME_GAP = 1 << 2;
export const CLOUD_TEMPORAL_RESET_TELEPORT = 1 << 3;
export const CLOUD_TEMPORAL_RESET_SCENE_MODE = 1 << 4;
export const CLOUD_TEMPORAL_RESET_MORPH = 1 << 5;
export const CLOUD_TEMPORAL_RESET_PROJECTION = 1 << 6;
export const CLOUD_TEMPORAL_RESET_REACTIVATED = 1 << 7;
export const CLOUD_TEMPORAL_RESET_DECK_BOUNDS = 1 << 8;
export const CLOUD_TEMPORAL_RESET_MULTI_DECK = 1 << 9;
// Resource allocation/reallocation is owned by the renderer rather than this
// pure classifier, but shares the same probe-visible reset mask.
export const CLOUD_TEMPORAL_RESET_RESOURCE = 1 << 10;

/**
 * Return true when a reset episode introduces at least one reason that was not
 * already latched. This lets adjacent distinct cuts advance diagnostics while a
 * persistent reason such as MORPH increments only once.
 */
export function cloudTemporalResetStartsGeneration(
  latchedReasons: number,
  currentReasons: number,
): boolean {
  return (
    currentReasons !== CLOUD_TEMPORAL_RESET_NONE &&
    (currentReasons & ~latchedReasons) !== 0
  );
}

/**
 * State from the last frame that successfully wrote temporal cloud history.
 *
 * `temporalActive` is also observed on inactive frames so an inactive→active
 * transition cannot reuse a stale allocation. All remaining fields describe
 * the last successful history write, not merely the last Scene frame.
 */
export interface CloudTemporalHistoryState {
  initialized: boolean;
  temporalActive: boolean;
  transformValid: boolean;
  lastHistoryFrameNumber: number;
  cameraX: number;
  cameraY: number;
  cameraZ: number;
  sceneMode: number;
  morphing: boolean;
  projectionType: number;
  deckBottom: number;
  deckTop: number;
  multiDeck: boolean;
}

/**
 * Current frame inputs required by the coarse C13-05 classifier.
 *
 * Time, wind, weather, and appearance controls are intentionally absent:
 * ordinary continuous evolution must not flush history. Advanced change
 * classification and wind-aware reconstruction remain C13-12 work.
 */
export interface CloudTemporalHistorySample {
  frameNumber: number;
  temporalActive: boolean;
  transformValid: boolean;
  cameraX: number;
  cameraY: number;
  cameraZ: number;
  sceneMode: number;
  morphing: boolean;
  projectionType: number;
  deckBottom: number;
  deckTop: number;
  multiDeck: boolean;
}

export function createCloudTemporalHistoryState(): CloudTemporalHistoryState {
  return {
    initialized: false,
    temporalActive: false,
    transformValid: false,
    lastHistoryFrameNumber: -1,
    cameraX: 0.0,
    cameraY: 0.0,
    cameraZ: 0.0,
    sceneMode: -1,
    morphing: false,
    projectionType: -1,
    deckBottom: Number.NaN,
    deckTop: Number.NaN,
    multiDeck: false,
  };
}

export function createCloudTemporalHistorySample(): CloudTemporalHistorySample {
  return {
    frameNumber: -1,
    temporalActive: false,
    transformValid: false,
    cameraX: 0.0,
    cameraY: 0.0,
    cameraZ: 0.0,
    sceneMode: -1,
    morphing: false,
    projectionType: -1,
    deckBottom: Number.NaN,
    deckTop: Number.NaN,
    multiDeck: false,
  };
}

function sampleHasFiniteTransform(sample: CloudTemporalHistorySample): boolean {
  return (
    sample.transformValid &&
    Number.isFinite(sample.cameraX) &&
    Number.isFinite(sample.cameraY) &&
    Number.isFinite(sample.cameraZ)
  );
}

/**
 * Return a bit mask of all discontinuities observed this frame.
 *
 * Multiple simultaneous causes still describe one logical reset. The caller
 * invalidates history once when the returned mask is nonzero, seeds the current
 * result, and then commits that successful write.
 */
export function classifyCloudTemporalHistoryReset(
  state: CloudTemporalHistoryState,
  sample: CloudTemporalHistorySample,
): number {
  if (!sample.temporalActive) {
    return CLOUD_TEMPORAL_RESET_NONE;
  }

  let reasons = CLOUD_TEMPORAL_RESET_NONE;
  const currentTransformValid = sampleHasFiniteTransform(sample);

  if (!state.initialized) {
    reasons |= CLOUD_TEMPORAL_RESET_INITIAL;
    if (!currentTransformValid) {
      reasons |= CLOUD_TEMPORAL_RESET_MISSING_TRANSFORM;
    }
    return reasons;
  }

  if (!currentTransformValid || !state.transformValid) {
    reasons |= CLOUD_TEMPORAL_RESET_MISSING_TRANSFORM;
  }
  if (sample.frameNumber !== state.lastHistoryFrameNumber + 1) {
    reasons |= CLOUD_TEMPORAL_RESET_FRAME_GAP;
  }
  if (!state.temporalActive) {
    reasons |= CLOUD_TEMPORAL_RESET_REACTIVATED;
  }

  if (currentTransformValid && state.transformValid) {
    const deltaX = sample.cameraX - state.cameraX;
    const deltaY = sample.cameraY - state.cameraY;
    const deltaZ = sample.cameraZ - state.cameraZ;
    const distanceSquared = deltaX * deltaX + deltaY * deltaY + deltaZ * deltaZ;
    const teleportThresholdSquared =
      CLOUD_TEMPORAL_TELEPORT_THRESHOLD_METERS *
      CLOUD_TEMPORAL_TELEPORT_THRESHOLD_METERS;
    if (distanceSquared > teleportThresholdSquared) {
      reasons |= CLOUD_TEMPORAL_RESET_TELEPORT;
    }
  }

  if (sample.sceneMode !== state.sceneMode) {
    reasons |= CLOUD_TEMPORAL_RESET_SCENE_MODE;
  }
  // Never reproject while either side of the history pair belongs to a morph.
  // A persistent morph therefore remains current-only; the first stable frame
  // also seeds once before normal accumulation resumes.
  if (sample.morphing || state.morphing) {
    reasons |= CLOUD_TEMPORAL_RESET_MORPH;
  }
  if (sample.projectionType !== state.projectionType) {
    reasons |= CLOUD_TEMPORAL_RESET_PROJECTION;
  }
  if (
    sample.deckBottom !== state.deckBottom ||
    sample.deckTop !== state.deckTop
  ) {
    reasons |= CLOUD_TEMPORAL_RESET_DECK_BOUNDS;
  }
  if (sample.multiDeck !== state.multiDeck) {
    reasons |= CLOUD_TEMPORAL_RESET_MULTI_DECK;
  }

  return reasons;
}

/**
 * Record the result of the current frame without allocating.
 *
 * Call with `historyWritten=false` when temporal reconstruction is inactive so
 * reactivation is observable, or when the resolve did not execute. A successful
 * seed/resolve passes `historyWritten=true` and becomes the sole previous-frame
 * transform represented by this state.
 */
export function commitCloudTemporalHistoryState(
  state: CloudTemporalHistoryState,
  sample: CloudTemporalHistorySample,
  historyWritten: boolean,
): void {
  state.temporalActive = sample.temporalActive;
  if (!historyWritten) {
    return;
  }

  state.initialized = true;
  state.transformValid = sampleHasFiniteTransform(sample);
  state.lastHistoryFrameNumber = sample.frameNumber;
  state.cameraX = sample.cameraX;
  state.cameraY = sample.cameraY;
  state.cameraZ = sample.cameraZ;
  state.sceneMode = sample.sceneMode;
  state.morphing = sample.morphing;
  state.projectionType = sample.projectionType;
  state.deckBottom = sample.deckBottom;
  state.deckTop = sample.deckTop;
  state.multiDeck = sample.multiDeck;
}
