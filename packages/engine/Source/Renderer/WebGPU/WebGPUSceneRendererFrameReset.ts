/**
 * Per-frame state reset extracted from
 * `WebGPUSceneRenderer.executeCommands`.
 *
 * Batch 139 of the audit-recommended SceneRenderer decomposition —
 * Slice B of the executeCommands four-slice plan (see
 * `migration_doc/BATCH_138_PLAN_EXECUTE_COMMANDS_SLICE_PLAN.md`).
 *
 * Resets six per-frame slots between frames so stale data from the
 * previous frame doesn't bleed into the next one. Runs after the
 * scene-FB render-pass redirect (Batch 138's slice) and before the
 * 2D-camera-altitude capture + per-frustum loop:
 *
 *   1. `_capturedFrustumRanges` — debug-overlay frustum tint list,
 *      cleared so the post-process overlay only tints with this
 *      frame's frustums.
 *   2. `_invertClassStencilReady` — flag set true by Batch 137's
 *      3D-tile passes when CLASSIFICATION_IGNORE_SHOW writes stencil
 *      bits inside the invert FBO. Reset so a frame without invert
 *      activity composites via the single-pass fallback.
 *   3. `_edgeTexturesPopulated` — flag set true by 3D-tile-edge
 *      pass when it actually produces edge views. Reset so frames
 *      without edge commands skip the overlay.
 *   4. `context._globeDepthView` — published each frame after the
 *      globe-depth copy. Cleared so a stale view from the previous
 *      frame doesn't bleed into the model effects bind group on
 *      frames that skip the copy (picking, debug paths,
 *      `useGlobeDepthFramebuffer` off).
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
  // C-R8-EDGE-FBO (Batch 44) — reset per-frame edge-populated flag
  // so `_runEdgeComposite` skips the overlay on frames where no
  // edge commands ran (typical frame for scenes without model edge
  // geometry).
  host._edgeTexturesPopulated = false;
  // C-R8-EDGE-INLINE — clear per-frame globe-depth view publication
  // so a stale view from the previous frame doesn't bleed into the
  // model effects bind group on frames that skip the globe-depth
  // copy (e.g., picking, debug paths, useGlobeDepthFramebuffer off).
  context._globeDepthView = null;
  context._pickClassificationDepthView = null;
  // Migration Session 2 — clear per-frame packed-translucent-depth
  // view so a stale view from the previous frame doesn't get
  // sampled by the classifier when this frame has no translucent
  // tiles. Republished by `tcc.executePackDepth` below when there
  // IS translucent depth available.
  context._packedTranslucentDepthView = null;
  // C-R8-TRANSLUCENT-TILE-CLASS (Batch 47) — clear per-frame
  // translucent-depth flag; set when the post-translucent depth
  // capture succeeds (single-sample scenes).
  host._translucentTileClassification?.prepareForFrame();
}
