/**
 * @module WebGPUGroundPolylineRenderer
 *
 * Migration Session 4 (Batch 84) — WebGPU classifier for
 * `GroundPolylinePrimitive`. Parallel of `WebGPUGroundPrimitiveRenderer`
 * specialized for line-shaped shadow volumes (extruded swept-rectangle
 * with miter joins). Sits beside the rectangle / polygon classifier in
 * the depth-sample architecture (ADR-2026-04-28); reuses the same
 * `_packedTranslucentDepthView` / `_globeDepthView` plumbing
 * (Migration Session 2) and the same per-frustum bind-group resolver
 * pattern (Migration Session 3) so polyline classification picks up
 * runtime depth-source swap and multi-frustum correctness for free.
 *
 * **What this batch ships:**
 *   - `FeatureRendererKey.GROUND_POLYLINE` slot (= 41) registered in
 *     `Source/Renderer/FeatureRendererKey.js`.
 *   - This module's structural skeleton: the public
 *     `createWebGPUGroundPolylineCommands` entry point matching
 *     `WebGPUGroundPrimitiveRenderer`'s shape, the per-primitive
 *     `_webgpuPolylineCache` slot, and a delegation hook in
 *     `Scene/GroundPolylinePrimitive.js` (Session 4b) that prefers
 *     this renderer when registered.
 *
 * **What's currently a no-op until follow-ups land:**
 *   - WGSL port of `PolylineShadowVolumeVS.glsl` (~170 lines —
 *     per-vertex volume extrusion, miter offset along normalEC,
 *     `czm_metersPerPixel`-driven width adjustment, depth clamp).
 *   - WGSL port of `PolylineShadowVolumeFS.glsl` (~85 lines — 5
 *     plane-distance tests for fragment culling, aligned-plane
 *     reconstruction for texture coords, per-instance color and
 *     material output).
 *   - Vertex format with 5 vec4 attributes (startHi+forwardX,
 *     startLo+forwardY, startNormal+forwardZ, endNormal+texNormX,
 *     rightNormal+texNormY) + batchId. Stride 84 bytes.
 *   - Materials path (czm_getMaterial integration).
 *   - 2D / Columbus View projection support.
 *   - DEBUG_SHOW_VOLUME / WIDTH_VARYING / ANGLE_VARYING flags.
 *
 * Until Session 4b ships, `createWebGPUGroundPolylineCommands` returns
 * a `null`-command result so the consumer's WebGL fall-through fires
 * (matching the `WebGPUGroundPrimitiveRenderer` pattern when
 * `_webgpuGeometryData` isn't yet populated). Registering the feature
 * renderer with this stub is the right minimum because:
 *
 *   1. It lets the registry-side wiring land cleanly in one batch.
 *   2. It makes `getFeatureRenderer(GROUND_POLYLINE)` return a real
 *      object so downstream code can feature-detect ("is the renderer
 *      registered?") even before the shader port lands.
 *   3. The WebGL fall-through continues to render polylines correctly
 *      until the WGSL port lands in Session 4b.
 *
 * @private
 */

import defined from "../../Core/defined.js";

/**
 * Feature-detection getter — returns true once the WGSL port lands in
 * Session 4b. Consumers that want to gate on "WebGPU polyline classifier
 * available" should call this rather than just checking
 * `getFeatureRenderer(GROUND_POLYLINE)` (which returns the stub
 * registration regardless of port state).
 *
 * @returns {boolean}
 * @private
 */
function isFullyImplemented() {
  return false;
}

/**
 * Stub command builder — returns null commands so the consumer falls
 * through to WebGL until the WGSL port lands. Mirrors the return shape
 * of `WebGPUGroundPrimitiveRenderer.createWebGPUGroundPrimitiveCommands`
 * so consumers can swap implementations without changing call-sites.
 *
 * @param {GroundPolylinePrimitive} primitive
 * @param {FrameState} frameState
 * @returns {{stencilCommand: null, colorCommand: null, pickCommand: null}}
 * @private
 */
function createWebGPUGroundPolylineCommands(primitive, frameState) {
  // Avoid unused-arg lint when params arrive but the stub doesn't use
  // them yet. Once the WGSL port lands, `primitive._webgpuGeometryData`
  // (walked through the Polyline → ClassificationPrimitive → Primitive
  // chain, same pattern as Batch 81's GroundPrimitive fix) becomes the
  // input to the buffer-build helpers below.
  void primitive;
  void frameState;

  return {
    stencilCommand: null,
    colorCommand: null,
    pickCommand: null,
  };
}

/**
 * Cleanup hook — releases per-primitive cache resources. No-op until
 * Session 4b populates `primitive._webgpuPolylineCache`.
 *
 * @param {GroundPolylinePrimitive} primitive
 * @private
 */
function destroyWebGPUGroundPolylineResources(primitive) {
  if (!defined(primitive._webgpuPolylineCache)) {
    return;
  }
  // Session 4b: release vertex/index buffers, uniform buffer, sampler,
  // pick IDs. Mirror `destroyWebGPUGroundPrimitiveResources`.
  primitive._webgpuPolylineCache = undefined;
}

/**
 * Public renderer object registered as the GROUND_POLYLINE feature
 * renderer. Exposes the same surface shape as
 * `WebGPUGroundPrimitiveRenderer` so consumers can dispatch uniformly.
 *
 * @private
 */
const WebGPUGroundPolylineRenderer = {
  /**
   * Build draw commands for a `GroundPolylinePrimitive`. Returns
   * `{ stencilCommand: null, colorCommand: null, pickCommand: null }`
   * until Session 4b lands the WGSL port; consumer falls through to
   * WebGL in that case.
   */
  createCommands: createWebGPUGroundPolylineCommands,
  destroy: destroyWebGPUGroundPolylineResources,
  isFullyImplemented,
};

export {
  createWebGPUGroundPolylineCommands,
  destroyWebGPUGroundPolylineResources,
  isFullyImplemented,
};
export default WebGPUGroundPolylineRenderer;
