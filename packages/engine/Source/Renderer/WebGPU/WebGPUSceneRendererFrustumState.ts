/**
 * Shared publication of state derived from the currently executing Cesium
 * frustum slice. Normal rendering and auxiliary pick rendering both feed
 * collection/classification bind-group resolvers through these fields.
 *
 * @module WebGPUSceneRendererFrustumState
 */

import type { WebGPUContext } from "./WebGPUContext.js";

export interface FrustumStateHost {
  _currentFrustumIndex: number;
}

/** Publish the full camera range used to encode logarithmic globe depth. */
export function publishLogDepthEncodeNearFar(
  scene: CesiumScene,
  uniformState: CesiumUniformState,
): void {
  const cameraFrustum = scene.camera?.frustum as
    { near?: number; far?: number } | undefined;
  if (
    typeof cameraFrustum?.near !== "number" ||
    typeof cameraFrustum.far !== "number"
  ) {
    return;
  }
  const state = uniformState as unknown as {
    _logDepthEncodeNearFar: Float32Array | null;
  };
  state._logDepthEncodeNearFar ??= new Float32Array(2);
  state._logDepthEncodeNearFar[0] = cameraFrustum.near;
  state._logDepthEncodeNearFar[1] = cameraFrustum.far;
}

/**
 * Publish the projection/range/index for the slice whose commands are about
 * to execute. The arrays are allocated once per context and overwritten.
 */
export function publishCurrentFrustumState(
  host: FrustumStateHost,
  context: WebGPUContext,
  uniformState: CesiumUniformState,
  executionIndex: number,
  near: number,
  far: number,
): void {
  host._currentFrustumIndex = executionIndex;
  const contextState = context as unknown as {
    _currentFrustumInvProj: Float32Array | null;
    _currentFrustumNearFar: Float32Array | null;
    _currentFrustumIndex: number;
  };
  contextState._currentFrustumInvProj ??= new Float32Array(16);
  contextState._currentFrustumNearFar ??= new Float32Array(2);

  const inverseProjection = uniformState.inverseProjection as
    { [index: number]: number } | undefined;
  if (inverseProjection) {
    for (let column = 0; column < 16; ++column) {
      contextState._currentFrustumInvProj[column] = inverseProjection[column];
    }
  }
  contextState._currentFrustumNearFar[0] = near;
  contextState._currentFrustumNearFar[1] = far;
  contextState._currentFrustumIndex = executionIndex;
  (
    uniformState as unknown as { _currentSliceIndex: number }
  )._currentSliceIndex = executionIndex;
}
