/**
 * Per-frame state reset extracted from
 * `WebGPUSceneRenderer.executeCommands`.
 *
 * Resets per-frame slots so stale data from the previous frame does not bleed
 * into the next one. Runs after the scene-framebuffer render-pass redirect and
 * before the 2D camera-altitude capture and per-frustum loop:
 *
 *   1. `_capturedFrustumRanges` — debug-overlay frustum tint list,
 *      cleared so the post-process overlay only tints with this
 *      frame's frustums.
 *   2. `_invertClassStencilReady` — flag set true by the 3D Tiles passes when
 *      `CLASSIFICATION_IGNORE_SHOW` writes stencil
 *      bits inside the invert FBO. Reset so a frame without invert
 *      activity composites via the single-pass fallback.
 *   3. `_edgeTexturesPopulated` — flag set true by 3D-tile-edge
 *      pass when it actually produces edge views. Reset so frames
 *      without edge commands skip the overlay.
 *   4. `context._globeDepthView` and `_pickClassificationDepthView` —
 *      published by their respective depth passes. Cleared so a stale view
 *      cannot leak into a frame that skips its producer.
 *   5. `context._packedTranslucentDepthView` — published when
 *      `tcc.executePackDepth` runs. Cleared for the same reason as
 *      `_globeDepthView`.
 *   6. `_translucentTileClassification?.prepareForFrame()` — clears
 *      the classifier's internal `_hasTranslucentDepth` flag so the
 *      post-translucent depth-capture gate evaluates fresh each
 *      frame.
 *
 * @module WebGPUSceneRendererFrameReset
 */

import type { WebGPUContext } from "./WebGPUContext.js";
import type { WebGPUTranslucentTileClassification } from "./WebGPUTranslucentTileClassification.js";

/** SceneRenderer surface the frame-reset helper reaches back to. */
export interface FrameResetHost {
  _capturedFrustumRanges: { near: number; far: number }[];
  _invertClassStencilReady: boolean;
  _edgeTexturesPopulated: boolean;
  _translucentTileClassification: WebGPUTranslucentTileClassification | null;
}

/**
 * Reset the SceneRenderer's per-frame state slots and clear the
 * matching context-side view publications.
 *
 * @param host - The owning SceneRenderer.
 * @param context - The active WebGPU context (carries the per-frame
 *   view publication slots).
 */
export function resetPerFrameState(
  host: FrameResetHost,
  context: WebGPUContext,
): void {
  // Reset captured ranges — the debug frustum overlay reads this list
  // in `_runPostProcessing` to tint pixels by which frustum drew them.
  host._capturedFrustumRanges.length = 0;
  // Reset per-frame stencil-ready flag. `_execute3DTilePasses` flips
  // it to true when the CLASSIFICATION_IGNORE_SHOW pass runs inside
  // the invert FBO. `_runInvertClassificationComposite` reads it to
  // decide whether to use the stencil-gated two-pass composite or
  // the single-pass fallback.
  host._invertClassStencilReady = false;
  // Reset the edge-populated flag so `_runEdgeComposite` skips the overlay on
  // frames where no model-edge commands ran.
  host._edgeTexturesPopulated = false;
  // Clear per-frame depth-view publications so stale views cannot bleed into
  // consumers on frames that skip their producer, such as picking and debug
  // paths or scenes with `useGlobeDepthFramebuffer` disabled.
  context._globeDepthView = null;
  context._pickClassificationDepthView = null;
  // Clear the packed-translucent-depth view so a stale view does not get
  // sampled by the classifier when this frame has no translucent tiles. It is
  // republished by `executePackDepth` later in a frame that has translucent
  // depth.
  context._packedTranslucentDepthView = null;
  // Clear the translucent-depth flag. The post-translucent capture sets it
  // when depth is available in either single-sample or MSAA mode.
  host._translucentTileClassification?.prepareForFrame();
}
