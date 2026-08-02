/**
 * Pick-pass orchestration extracted from `WebGPUSceneRenderer`.
 *
 * Batch 133 of the audit-recommended SceneRenderer decomposition. See
 * `migration_doc/WEBGPU_CONTEXT_DECOMPOSITION_PLAN.md` (SceneRenderer
 * candidate "Pick path") and
 * `migration_doc/BATCH_133_PLAN_PICK_PASS_EXTRACTION.md` for context.
 *
 * Responsibilities:
 *   - Open a render pass against the WebGPU pick framebuffer that
 *     `WebGPUPickFramebuffer.begin()` published into
 *     `passState.framebuffer`.
 *   - Walk every frustum back-to-front and dispatch every pickable
 *     pass (GLOBE → 3D-tile → 3D-tile-classification → OPAQUE →
 *     TRANSLUCENT → VOXELS → GAUSSIAN_SPLATS). Each independently
 *     projected frustum gets its own render pass: ID color accumulates across
 *     slices while non-comparable depth/stencil is cleared for every slice.
 *   - For each command, route through `selectCommandVariant(...,
 *     isPickPass=true)` so commands carrying a `derivedCommands.picking`
 *     entry render their pick variant (writes pick IDs) instead of
 *     the base material.
 *   - End the pick pass and leave the pick mini-frame ready for
 *     `pickEnd → context.endFrame()` submission.
 *   - UP144-SNAP-WEBGPU (C11-212) — when `passState.framebuffer` is a
 *     `WebGPUSnapFramebuffer` (`_isWebGPUSnapFBO`), run each frustum slice
 *     TWICE: the ordinary pick sequence above into the snap FBO's occluder
 *     attachment (this is what populates depth, i.e. WebGL's depth-only
 *     fallback for snapless commands), then a payload pass into the RG32Uint
 *     snap attachment over that same depth, drawing only commands that carry
 *     `derivedCommands.snapping.snapCommand`.
 *
 * What it deliberately does NOT do:
 *   - Pick-FBO allocation lives in `WebGPUPickFramebuffer.ts`.
 *   - Pick-result decode runs after this returns, in
 *     `WebGPUPickFramebuffer.end()` / `Picking.js`.
 *
 * The host interface keeps the dependency arrow pointing
 * `WebGPUSceneRenderer → WebGPUSceneRendererPickPass`. The pick pass
 * reaches back via {@link PickPassHost.updateFrustumUniforms} only.
 *
 * @module WebGPUSceneRendererPickPass
 */

import DeveloperError from "../../Core/DeveloperError.js";
import Pass from "../../Renderer/Pass.js";
import type { WebGPUContext } from "./WebGPUContext.js";
import type { WebGPUDynamicStateOverride } from "./WebGPUDrawCommand.js";
import {
  publishCurrentFrustumState,
  publishLogDepthEncodeNearFar,
} from "./WebGPUSceneRendererFrustumState.js";
import {
  selectCommandVariant,
  sortCommandsBackToFront,
  sortCommandsFrontToBack,
  sortGaussianSplatsBackToFront,
  type WebGPURenderFrameConfig,
} from "./WebGPUSceneRenderer.js";

/**
 * C10-12-PICK-DEPTH-PLANE-GATE-FLIP (2026-07-18) — ENABLED. The depth-plane
 * pick draw writes a horizon far-depth into the shared pick FBO so picks
 * BEYOND the visible terrain limb (behind the globe) are correctly occluded,
 * while front/visible picks still resolve. This closes C9-02B and audit P0-1.
 *
 * Why the gate was held OFF until now (kept for history): flipping it requires
 * the WHOLE native pick fleet to write log `@builtin(frag_depth)` against the
 * SAME full-frustum encode the depth plane uses. Before C10-11 every native
 * pick producer (globe/model/collection/primitive/voxel/ellipsoid/splat/buffer
 * pick shaders) wrote update-time camera-frustum HYPERBOLIC z. Hyperbolic depth
 * cannot discriminate the depth plane from a just-beyond-horizon marker at
 * 5,000 km (sub-ulp Δz), and a log-depth plane over a hyperbolic fleet
 * OVER-OCCLUDED every pick cohort across the globe disk (Run-1, 2026-07-16).
 *
 * Prerequisites now met:
 *  - Scene half (Batch 673): `WebGPUDepthPlane.update()` encodes log depth from
 *    the FULL camera frustum stash `uniformState._logDepthEncodeNearFar`, and
 *    the dedicated `_pickPipeline` writes log `frag_depth` from the same pair.
 *  - Fleet half (C10-11, Batch 709): every native pick producer writes log
 *    `frag_depth` against that same encode, gated on `isWebGPUPickLogDepthActive`
 *    (`WebGPUContext._pickLogDepthWriteEnabled`, default TRUE). The shared pick
 *    FBO is now uniformly log — coherent with the plane (INV-1/INV-2).
 *
 * Kill switch: set this back to `false` to disable ONLY the depth-plane pick
 * draw (the fleet stays log-encoded — harmless, WebGL-parity). The fleet-wide
 * kill switch is `WebGPUContext._pickLogDepthWriteEnabled = false`.
 * Verified by `probe-depth-plane-horizon-oracle.mjs` (normal/diagnostic-skip/
 * restored = on/off/restored discipline) at 20/500/5,000 km.
 */
const PICK_DEPTH_PLANE_ENABLED = true;

/**
 * The SceneRenderer surface that the extracted pick pass reaches
 * back to. Today's only callback is the frustum-uniform refresh; the
 * interface gives us a single place to grow if more callbacks become
 * necessary.
 */
export interface PickPassHost {
  _currentFrustumIndex: number;
  _globeDepth: {
    executeCopyDepthToView(
      encoder: GPUCommandEncoder,
      destinationView: GPUTextureView,
      depthTexture: GPUTexture,
      scissor?: { x: number; y: number; width: number; height: number },
    ): void;
  } | null;
  /**
   * Apply the given near/far to the camera frustum and refresh the
   * uniform state's projection matrix. Stores originals before the
   * apply, restores afterwards so the camera frustum stays unchanged
   * for downstream systems.
   */
  _updateFrustumUniforms(
    uniformState: CesiumUniformState,
    near: number,
    far: number,
    scene: CesiumScene,
  ): void;
  _renderDepthPlane(
    config: WebGPURenderFrameConfig,
    passKind: "scene" | "pick",
  ): void;
}

/**
 * Type-narrowed view of the pick framebuffer that
 * `WebGPUPickFramebuffer.begin()` publishes into `passState.framebuffer`.
 * The `_isWebGPUPickFBO` discriminator is the marker the SceneRenderer
 * uses to confirm it isn't being handed a generic Cesium framebuffer
 * by accident.
 */
type WebGPUPickFBOShape = CesiumOpaqueFramebuffer & {
  _isWebGPUPickFBO?: boolean;
  colorView?: GPUTextureView;
  depthView?: GPUTextureView;
  depthTexture?: GPUTexture;
  width?: number;
  height?: number;
  pickScissor?: { x: number; y: number; width: number; height: number };
  ensureClassificationDepth?: () => {
    texture: GPUTexture;
    view: GPUTextureView;
  } | null;
  // UP144-SNAP-WEBGPU (C11-212) — present only on a `WebGPUSnapFramebuffer`.
  // `snapColorView` is the RG32Uint payload attachment the second phase of each
  // frustum slice renders into; `colorView`/`depthView` above are that object's
  // occluder attachments, which the FIRST phase drives exactly as an ordinary
  // pick pass would.
  _isWebGPUSnapFBO?: boolean;
  snapColorView?: GPUTextureView;
  resetSnapPayloadCoverage?: (renderPass: GPURenderPassEncoder) => void;
};

/**
 * Apply the caller's target sub-viewport and intersect it with the small pick
 * rectangle.
 * Cesium rectangles use a bottom-left origin while WebGPU scissor coordinates
 * use a top-left origin, matching the readback conversion in
 * `WebGPUPickFramebuffer`.
 */
function resolvePickDynamicState(
  pickFBO: WebGPUPickFBOShape,
  passState: CesiumPassState,
): WebGPUDynamicStateOverride {
  const passViewport = passState.viewport;
  const targetWidth = Math.max(
    1,
    Math.floor(pickFBO.width ?? passViewport?.width ?? 1),
  );
  const targetHeight = Math.max(
    1,
    Math.floor(pickFBO.height ?? passViewport?.height ?? 1),
  );
  const viewportX = Math.max(
    0,
    Math.min(targetWidth, Math.floor(passViewport?.x ?? 0)),
  );
  const viewportY = Math.max(
    0,
    Math.min(targetHeight, Math.floor(passViewport?.y ?? 0)),
  );
  const viewport = {
    x: viewportX,
    y: viewportY,
    width: Math.max(
      0,
      Math.min(
        Math.floor(passViewport?.width ?? targetWidth),
        targetWidth - viewportX,
      ),
    ),
    height: Math.max(
      0,
      Math.min(
        Math.floor(passViewport?.height ?? targetHeight),
        targetHeight - viewportY,
      ),
    ),
  };

  const normalized = pickFBO.pickScissor;
  const passScissor = passState.scissorTest;
  const rectangle = passScissor?.enabled ? passScissor.rectangle : undefined;
  const query =
    normalized ??
    (rectangle
      ? {
          x: Math.max(0, Math.min(targetWidth - 1, Math.floor(rectangle.x))),
          y: Math.max(
            0,
            Math.min(
              targetHeight - 1,
              targetHeight -
                Math.floor(rectangle.y) -
                Math.max(1, Math.floor(rectangle.height)),
            ),
          ),
          width: Math.max(1, Math.floor(rectangle.width)),
          height: Math.max(1, Math.floor(rectangle.height)),
        }
      : { x: 0, y: 0, width: targetWidth, height: targetHeight });

  const x = Math.max(viewport.x, query.x);
  const y = Math.max(viewport.y, query.y);
  const right = Math.min(viewport.x + viewport.width, query.x + query.width);
  const bottom = Math.min(viewport.y + viewport.height, query.y + query.height);
  return {
    viewport,
    scissor: {
      x,
      y,
      width: Math.max(0, right - x),
      height: Math.max(0, bottom - y),
    },
  };
}

function applyPickDynamicState(
  renderPass: GPURenderPassEncoder,
  dynamicState: WebGPUDynamicStateOverride,
): void {
  const viewport = dynamicState.viewport!;
  const scissor = dynamicState.scissor!;
  renderPass.setViewport(
    viewport.x,
    viewport.y,
    viewport.width,
    viewport.height,
    0,
    1,
  );
  renderPass.setScissorRect(
    scissor.x,
    scissor.y,
    scissor.width,
    scissor.height,
  );
}

function beginPickRenderPass(
  context: WebGPUContext,
  encoder: GPUCommandEncoder,
  pickFBO: WebGPUPickFBOShape,
  dynamicState: WebGPUDynamicStateOverride,
  label: string,
  colorLoadOp: GPULoadOp,
  depthLoadOp: GPULoadOp,
  stencilLoadOp: GPULoadOp,
  storeForContinuation: boolean,
): GPURenderPassEncoder {
  const descriptor: GPURenderPassDescriptor = {
    label,
    colorAttachments: [
      {
        view: pickFBO.colorView as GPUTextureView,
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        loadOp: colorLoadOp,
        // A snap occluder pass binds the RGBA8 pick target solely to keep the
        // existing pick fleet's pipelines attachment-compatible. No snap
        // consumer reads that color; only the shared depth/stencil attachment
        // crosses into the payload phase. Discarding avoids preserving a
        // full-viewport throwaway target. Ordinary pick ID color still stores
        // and accumulates across frustum slices exactly as before.
        storeOp:
          pickFBO._isWebGPUSnapFBO === true && !!pickFBO.snapColorView
            ? "discard"
            : "store",
      },
    ],
    depthStencilAttachment: {
      view: pickFBO.depthView as GPUTextureView,
      depthClearValue: 1.0,
      depthLoadOp,
      depthStoreOp: storeForContinuation ? "store" : "discard",
      stencilClearValue: 0,
      stencilLoadOp,
      stencilStoreOp: storeForContinuation ? "store" : "discard",
    },
  };
  const renderPass = encoder.beginRenderPass(
    context.withRenderPassTimestamps(descriptor, label),
  );
  context._currentRenderPassEncoder = renderPass;
  applyPickDynamicState(renderPass, dynamicState);
  return renderPass;
}

/**
 * UP144-SNAP-WEBGPU (C11-212) — open the SNAP PAYLOAD render pass for one
 * frustum slice.
 *
 * Color is the compact RG32Uint payload attachment; depth/stencil is the SAME attachment
 * the occluder phase just wrote, loaded rather than cleared. That depth rejects
 * payload fragments behind current-slice snapless commands; the coverage-reset
 * draw below also erases any farther-slice payload at those pixels. WebGL runs
 * each snapless command's depth-only derived command inside its single snap
 * pass, which WebGPU cannot do because pipeline color-target formats are
 * validated against the pass's attachments at draw time.
 *
 * Payload color accumulates across slices (cleared once on the far slice,
 * loaded afterwards) exactly like the pick pass's ID color. Before drawing a
 * nearer slice, the framebuffer's coverage-reset draw zeros the accumulated
 * payload wherever this slice established depth; a nearer snapless winner can
 * therefore erase a farther snap hit. Depth is not stored past the payload
 * phase because the next slice clears it anyway.
 */
function beginSnapPayloadRenderPass(
  context: WebGPUContext,
  encoder: GPUCommandEncoder,
  snapFBO: WebGPUPickFBOShape,
  dynamicState: WebGPUDynamicStateOverride,
  label: string,
  colorLoadOp: GPULoadOp,
): GPURenderPassEncoder {
  const descriptor: GPURenderPassDescriptor = {
    label,
    colorAttachments: [
      {
        view: snapFBO.snapColorView as GPUTextureView,
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        loadOp: colorLoadOp,
        storeOp: "store",
      },
    ],
    depthStencilAttachment: {
      view: snapFBO.depthView as GPUTextureView,
      depthClearValue: 1.0,
      depthLoadOp: "load",
      depthStoreOp: "discard",
      stencilClearValue: 0,
      stencilLoadOp: "load",
      stencilStoreOp: "discard",
    },
  };
  const renderPass = encoder.beginRenderPass(
    context.withRenderPassTimestamps(descriptor, label),
  );
  context._currentRenderPassEncoder = renderPass;
  applyPickDynamicState(renderPass, dynamicState);
  return renderPass;
}

function endPickRenderPass(
  context: WebGPUContext,
  renderPass: GPURenderPassEncoder | null,
): void {
  if (!renderPass) {
    return;
  }
  try {
    renderPass.end();
  } finally {
    if (context._currentRenderPassEncoder === renderPass) {
      context._currentRenderPassEncoder = null;
    }
  }
}

/**
 * Run the WebGPU pick pass for the current frame. Mirrors the WebGL
 * `Picking.pickRectangle` orchestration but over the WebGPU pick FBO
 * + WebGPU command-execution path.
 *
 * @param host - The owning SceneRenderer (or any object satisfying
 *   {@link PickPassHost}).
 * @param config - The current frame's render-frame config. The
 *   `passState.framebuffer` slot must carry the WebGPU pick FBO
 *   established by {@link WebGPUPickFramebuffer}.
 */
export function executePickPass(
  host: PickPassHost,
  config: WebGPURenderFrameConfig,
): void {
  const { scene, context, passState } = config;
  const view = scene._view;
  const { frustumCommandsList } = view;
  const numFrustums: number = frustumCommandsList.length;
  const { uniformState } = context;

  if (numFrustums === 0) {
    return;
  }

  // Get pick framebuffer from passState (set by WebGPUPickFramebuffer.begin())
  const pickFBORaw = passState?.framebuffer;
  const pickFBO = pickFBORaw as WebGPUPickFBOShape | undefined;
  if (!pickFBO || !pickFBO._isWebGPUPickFBO) {
    // No WebGPU pick framebuffer — fall back to rendering normally
    // (this shouldn't happen, but be safe)
    return;
  }

  // UP144-SNAP-WEBGPU (C11-212) — a `WebGPUSnapFramebuffer` sets BOTH markers.
  // In snap mode every frustum slice runs twice: the ordinary pick sequence
  // below (the OCCLUDER phase, unchanged, writing depth into the shared
  // attachment), then a payload phase that draws only snap variants against
  // that depth. `snapColorView` is required — without a payload attachment
  // there is nothing to upgrade to, so fall back to the plain pick schedule
  // rather than opening a pass with a null color view.
  const snapMode = pickFBO._isWebGPUSnapFBO === true && !!pickFBO.snapColorView;
  const resetSnapPayloadCoverage = pickFBO.resetSnapPayloadCoverage;
  if (
    snapMode &&
    (numFrustums > 1 || config.sceneFbLoad) &&
    typeof resetSnapPayloadCoverage !== "function"
  ) {
    throw new DeveloperError(
      "A loaded WebGPU snap payload requires resetSnapPayloadCoverage.",
    );
  }

  const device: GPUDevice | undefined = context._device;
  if (!device) {
    return;
  }
  // The pick render runs via `pickBegin → updateAndExecuteCommands`, NOT the
  // normal `render()` path, so `context.beginFrame()` never ran and there is no
  // command encoder yet. Create the off-screen pick mini-frame encoder (+ the
  // uniform-allocator page) here; `pickEnd → context.endFrame()` submits +
  // finalizes it. Without this the pick pass renders nothing and every
  // scene.pick / pickAsync returns undefined (FORK-34). No-op if an encoder
  // already exists (e.g. pick nested inside a normal frame).
  context.beginPickFrame?.();
  const encoder: GPUCommandEncoder | undefined = context._currentCommandEncoder;
  if (!encoder) {
    return;
  }

  // End the current render pass so we can start the pick render pass
  context.endCurrentRenderPass?.();
  const pickDynamicState = resolvePickDynamicState(pickFBO, passState);
  publishLogDepthEncodeNearFar(scene, uniformState);
  const scene2DCamera = scene.camera as unknown as {
    position: { z: number };
  };
  const initialHeight2D =
    scene.mode === 2 /* SceneMode.SCENE2D */ ? scene2DCamera.position.z : 0;
  const opaqueFrustumNearOffset = scene.opaqueFrustumNearOffset ?? 0.9999;
  let completed = false;

  // Execute all pickable passes across all frustums. Cesium frustum depths are
  // encoded against each slice's projection, so values from two slices are not
  // comparable. Mirroring WebGL, use one render pass per far-to-near slice:
  // clear ID color once, load it for later slices, and clear depth/stencil for
  // every slice. A single pass with one depth clear lets a near-slice depth
  // incorrectly reject or preserve a far-slice fragment.
  try {
    for (let i = 0; i < numFrustums; i++) {
      const index = numFrustums - i - 1;
      const frustumCommands = frustumCommandsList[index];

      let near: number;
      let far: number;
      if (scene.mode === 2 /* SceneMode.SCENE2D */ && numFrustums > 1) {
        scene2DCamera.position.z = initialHeight2D - frustumCommands.near + 1.0;
        near = 1.0;
        far = Math.max(1.0, frustumCommands.far - frustumCommands.near);
        const state = uniformState as unknown as {
          update?: (frameState: typeof scene._frameState) => void;
        };
        state.update?.(scene._frameState);
      } else if (scene.mode === 2 /* SceneMode.SCENE2D */) {
        const cameraFrustum = scene._frameState.camera?.frustum as
          { near?: number; far?: number } | undefined;
        near = cameraFrustum?.near ?? frustumCommands.near;
        far = cameraFrustum?.far ?? frustumCommands.far;
      } else {
        near =
          index !== 0
            ? frustumCommands.near * opaqueFrustumNearOffset
            : frustumCommands.near;
        far = frustumCommands.far;
      }
      host._updateFrustumUniforms(uniformState, near, far, scene);
      publishCurrentFrustumState(host, context, uniformState, i, near, far);

      const terrainClassificationCount =
        frustumCommands.indices[Pass.TERRAIN_CLASSIFICATION] ?? 0;
      const tileClassificationCount =
        frustumCommands.indices[Pass.CESIUM_3D_TILE_CLASSIFICATION] ?? 0;
      const requestsClassificationDepth =
        terrainClassificationCount > 0 || tileClassificationCount > 0;
      const classificationTarget =
        requestsClassificationDepth && host._globeDepth && pickFBO.depthTexture
          ? (pickFBO.ensureClassificationDepth?.() ?? null)
          : null;
      if (classificationTarget) {
        context._pickClassificationDepthView = classificationTarget.view;
      }
      const terrainCheckpoint =
        terrainClassificationCount > 0 && classificationTarget !== null;
      const tileCheckpoint =
        tileClassificationCount > 0 && classificationTarget !== null;
      const clearGlobeDepth = config.clearGlobeDepth === true;
      let pickRenderPass: GPURenderPassEncoder | null = beginPickRenderPass(
        context,
        encoder,
        pickFBO,
        pickDynamicState,
        `Pick render pass frustum ${i}`,
        i === 0 && !config.sceneFbLoad ? "clear" : "load",
        "clear",
        "clear",
        // In snap mode the payload phase LOADS this depth, so it must survive
        // the end of the occluder phase.
        terrainCheckpoint || clearGlobeDepth || tileCheckpoint || snapMode,
      );
      const execute = (passIndex: number): void => {
        executePickBatch(
          frustumCommands,
          passIndex,
          scene,
          context,
          passState,
          pickRenderPass!,
          pickDynamicState,
        );
      };
      const reopen = (
        label: string,
        depthLoadOp: GPULoadOp,
        stencilLoadOp: GPULoadOp,
        storeForContinuation: boolean,
      ): void => {
        const previousPass = pickRenderPass;
        pickRenderPass = null;
        endPickRenderPass(context, previousPass);
        pickRenderPass = beginPickRenderPass(
          context,
          encoder,
          pickFBO,
          pickDynamicState,
          label,
          "load",
          depthLoadOp,
          stencilLoadOp,
          storeForContinuation,
        );
      };
      const packDepthAndReopen = (
        label: string,
        storeForContinuation: boolean,
      ): void => {
        endPickRenderPass(context, pickRenderPass);
        pickRenderPass = null;
        host._globeDepth!.executeCopyDepthToView(
          encoder,
          classificationTarget!.view,
          pickFBO.depthTexture!,
          pickDynamicState.scissor,
        );
        context._pickClassificationDepthView = classificationTarget!.view;
        pickRenderPass = beginPickRenderPass(
          context,
          encoder,
          pickFBO,
          pickDynamicState,
          label,
          "load",
          "load",
          "load",
          storeForContinuation,
        );
      };

      try {
        // Skip ENVIRONMENT pass — sky/sun/moon/atmosphere don't generate pick IDs

        // GLOBE pass
        execute(Pass.GLOBE);

        // Classification samples packed depth and therefore needs a real pass
        // boundary. Ordinary picks skip both the pack and the continuation.
        if (terrainCheckpoint) {
          packDepthAndReopen(
            `Pick terrain classification frustum ${i}`,
            clearGlobeDepth || tileCheckpoint || snapMode,
          );
          execute(Pass.TERRAIN_CLASSIFICATION);
        }

        if (clearGlobeDepth) {
          reopen(
            `Pick post-globe depth-clear frustum ${i}`,
            "clear",
            "load",
            tileCheckpoint || snapMode,
          );
          if (PICK_DEPTH_PLANE_ENABLED && config.useDepthPlane) {
            host._renderDepthPlane(config, "pick");
          }
        }

        execute(Pass.CESIUM_3D_TILE);
        if (tileCheckpoint) {
          packDepthAndReopen(
            `Pick 3D-tile classification frustum ${i}`,
            snapMode,
          );
          execute(Pass.CESIUM_3D_TILE_CLASSIFICATION);
        }

        // H-R3 (Batch 35) — VOXELS and GAUSSIAN_SPLATS pick passes. WebGL
        // includes them in the pick-pass command list via
        // `performIdPass`; WebGPU previously skipped them so voxel media
        // and Gaussian splat primitives were unpickable. Commands without
        // a pick variant fall through to the base command via
        // `selectCommandVariant` (Batch 29), same as other passes.
        const voxelCount = frustumCommands.indices[Pass.VOXELS] ?? 0;
        if (voxelCount > 1) {
          sortCommandsBackToFront(
            frustumCommands.commands[Pass.VOXELS],
            voxelCount,
            scene,
          );
        }
        execute(Pass.VOXELS);

        // OPAQUE follows voxels, matching the normal/WebGL frustum loop.
        const splatCount = frustumCommands.indices[Pass.GAUSSIAN_SPLATS] ?? 0;
        if (splatCount > 1) {
          sortGaussianSplatsBackToFront(
            frustumCommands.commands[Pass.GAUSSIAN_SPLATS],
            splatCount,
            scene,
          );
        }
        execute(Pass.OPAQUE);

        execute(Pass.GAUSSIAN_SPLATS);

        // Match the normal loop's exact-near translucent projection. Opaque
        // slices use a slight near offset to avoid seams, but translucent depth
        // and blending must use the raw slice boundary.
        if (
          index !== 0 &&
          scene.mode !== 2 /* SceneMode.SCENE2D */ &&
          (frustumCommands.indices[Pass.TRANSLUCENT] ?? 0) > 0
        ) {
          host._updateFrustumUniforms(
            uniformState,
            frustumCommands.near,
            far,
            scene,
          );
          publishCurrentFrustumState(
            host,
            context,
            uniformState,
            i,
            frustumCommands.near,
            far,
          );
        }

        // TRANSLUCENT pass runs last so opaque/voxel/splat depth is established.
        const translucentCount = frustumCommands.indices[Pass.TRANSLUCENT] ?? 0;
        if (translucentCount > 1) {
          sortCommandsFrontToBack(
            frustumCommands.commands[Pass.TRANSLUCENT],
            translucentCount,
            scene,
          );
        }
        execute(Pass.TRANSLUCENT);
      } finally {
        // A thrown command must not leave the command encoder with an open
        // render pass; otherwise endFrame cannot finish or submit it.
        endPickRenderPass(context, pickRenderPass);
      }

      // UP144-SNAP-WEBGPU (C11-212) — payload phase for this slice. The
      // occluder phase above has ended and stored its depth; open the RG32Uint
      // payload pass over that same depth and draw only the snap variants.
      if (snapMode) {
        const snapRenderPass: GPURenderPassEncoder = beginSnapPayloadRenderPass(
          context,
          encoder,
          pickFBO,
          pickDynamicState,
          `Snap payload pass frustum ${i}`,
          i === 0 && !config.sceneFbLoad ? "clear" : "load",
        );
        try {
          // A loaded payload may contain a farther slice's hit. Depth was
          // cleared and rebuilt for this slice, so erase that prior payload
          // wherever the current slice has an occluder before drawing current
          // snap variants. The callback records one fullscreen triangle into
          // THIS pass; beginSnapPayloadRenderPass already restricted it to the
          // query viewport/scissor. No reset is needed for the first fresh
          // slice because its payload attachment was just cleared.
          if (i > 0 || config.sceneFbLoad) {
            resetSnapPayloadCoverage!(snapRenderPass);
          }

          // Same pass order as the occluder phase minus the classification
          // checkpoints: classification draws carry no snap payload, and their
          // packed-depth reopen would clear the depth the payload phase is
          // reading. Sorting already happened in the occluder phase, so the
          // command arrays are in the order this phase wants. The two edge
          // passes join at the tail (UP144-SNAP-WEBGPU-EDGES, rationale
          // below).
          executeSnapPayloadBatch(
            frustumCommands,
            Pass.GLOBE,
            scene,
            context,
            snapRenderPass,
            pickDynamicState,
          );
          executeSnapPayloadBatch(
            frustumCommands,
            Pass.CESIUM_3D_TILE,
            scene,
            context,
            snapRenderPass,
            pickDynamicState,
          );
          executeSnapPayloadBatch(
            frustumCommands,
            Pass.VOXELS,
            scene,
            context,
            snapRenderPass,
            pickDynamicState,
          );
          executeSnapPayloadBatch(
            frustumCommands,
            Pass.OPAQUE,
            scene,
            context,
            snapRenderPass,
            pickDynamicState,
          );
          executeSnapPayloadBatch(
            frustumCommands,
            Pass.GAUSSIAN_SPLATS,
            scene,
            context,
            snapRenderPass,
            pickDynamicState,
          );
          executeSnapPayloadBatch(
            frustumCommands,
            Pass.TRANSLUCENT,
            scene,
            context,
            snapRenderPass,
            pickDynamicState,
          );

          // UP144-SNAP-WEBGPU-EDGES — edge snap candidates. The edge
          // emitter's commands live in the two edge passes (which the
          // occluder phase never visits — edges carry no pick variant), and
          // only commands whose `derivedCommands.snapping.snapCommand`
          // resolved are drawn, so the strict admission above is unchanged.
          // Deliberately LAST: an edge lies exactly on its surface's
          // silhouette, so with the snap family's `less-equal` depth test the
          // later edge draw wins the tie and stamps the edge-flagged payload
          // over the surface hit — the WebGPU realization of WebGL's
          // `u_isEdgePass = true` second model draw.
          executeSnapPayloadBatch(
            frustumCommands,
            Pass.CESIUM_3D_TILE_EDGES,
            scene,
            context,
            snapRenderPass,
            pickDynamicState,
          );
          executeSnapPayloadBatch(
            frustumCommands,
            Pass.CESIUM_3D_TILE_EDGES_DIRECT,
            scene,
            context,
            snapRenderPass,
            pickDynamicState,
          );
        } finally {
          // Same contract as the occluder phase: a throwing command must never
          // leave the encoder with an open render pass.
          endPickRenderPass(context, snapRenderPass);
        }
      }
    }
    completed = true;
  } finally {
    if (scene.mode === 2 /* SceneMode.SCENE2D */) {
      scene2DCamera.position.z = initialHeight2D;
    }
    // The pick branch is terminal for this mini-frame. Clear the ended
    // encoder slot and let `pickEnd → context.endFrame()` resolve timestamps,
    // finish, and submit. A pick mini-frame has no canvas texture to resume.
    context._currentRenderPassEncoder = null;
    if (!config.deferComposite || !completed) {
      context._pickClassificationDepthView = null;
    }
  }
}

/**
 * UP144-SNAP-WEBGPU (C11-212) — dispatch one pass's SNAP variants into the
 * payload render pass.
 *
 * Strictly narrower than {@link executePickBatch}: a command draws here ONLY
 * when `selectCommandVariant(..., snapVariant = true)` resolved it to a real
 * snap variant. Three consequences, all deliberate:
 *
 *   - A command with no snap payload is skipped rather than falling through to
 *     its base or pick command. Its pipeline targets an RGBA8 (or MRT scene)
 *     attachment, and WebGPU validates attachment state at draw time, so
 *     dispatching it would invalidate the whole snap command buffer — the
 *     FORK-34 failure mode. Its occlusion contribution was already made in the
 *     occluder phase.
 *   - `pickOnly` / `_isPickCommand` are NOT admission markers here (unlike the
 *     pick batch): those mark pipelines that target the PICK attachment, which
 *     is exactly what the payload pass must not receive.
 *   - The precise-pick 2-pass coordination has no snap analogue; snapping runs
 *     one draw per snappable command.
 */
function executeSnapPayloadBatch(
  frustumCommands: CesiumFrustumCommands,
  passIndex: number,
  scene: CesiumScene,
  context: WebGPUContext,
  snapRenderPass: GPURenderPassEncoder,
  pickDynamicState: WebGPUDynamicStateOverride,
): void {
  const commands = frustumCommands.commands[passIndex];
  const count: number = frustumCommands.indices[passIndex];
  if (count === 0) {
    return;
  }
  context.uniformState?.updatePass(passIndex);

  for (let i = 0; i < count; i++) {
    const command = commands[i];
    if (!command) {
      continue;
    }
    if (scene.debugCommandFilter && !scene.debugCommandFilter(command)) {
      continue;
    }
    const dispatched = selectCommandVariant(command, scene, true, true);
    if (dispatched === command || dispatched.isWebGPUDrawCommand !== true) {
      continue;
    }
    dispatched.execute(snapRenderPass, pickDynamicState);
  }
}

/**
 * Execute a batch of commands for a specific pass during pick rendering.
 * Commands are executed on the pick render pass encoder.
 */
function executePickBatch(
  frustumCommands: CesiumFrustumCommands,
  passIndex: number,
  scene: CesiumScene,
  context: WebGPUContext,
  passState: CesiumPassState,
  pickRenderPass: GPURenderPassEncoder,
  pickDynamicState: WebGPUDynamicStateOverride,
): void {
  const commands = frustumCommands.commands[passIndex];
  const count: number = frustumCommands.indices[passIndex];
  if (count === 0) {
    return;
  }
  context.uniformState?.updatePass(passIndex);

  for (let i = 0; i < count; i++) {
    const command = commands[i];
    if (!command) {
      continue;
    }

    // Skip commands that don't participate in picking
    if (scene.debugCommandFilter && !scene.debugCommandFilter(command)) {
      continue;
    }

    // C-R2: pick pass consults derivedCommands.picking/pickingMetadata
    // so commands that pre-built pick variants render those (pick color
    // output, not base-material output) into the pick FBO. WebGPU-native
    // feature renderers (Globe, GltfModel, GroundPrimitive) typically emit
    // dedicated pick commands through their own path (flagged `pickOnly` /
    // `_isPickCommand`) instead of populating derivedCommands.picking.
    const dispatched = selectCommandVariant(command, scene, true);

    // FORK-34 fix (Batch 207) — a command that `selectCommandVariant`
    // returns UNCHANGED has no pick variant. In WebGPU a pipeline is
    // validated against the render pass's attachment formats at draw time,
    // so dispatching a base COLOR command (whose pipeline targets the MRT
    // scene framebuffer) into the single-target pick render pass raises an
    // "attachment state not compatible" validation error that invalidates
    // the ENTIRE pick command buffer — discarding even the correctly-built
    // pick variants, so every pick returns undefined. WebGL tolerates this
    // (no attachment-count validation at draw time), which is why the old
    // "fall through to the base command, same as WebGL" behavior was wrong
    // for WebGPU. Skip such commands unless they are dedicated pick
    // commands (`pickOnly`) whose pipelines already target the single pick
    // attachment. The skipped base commands (globe tiles, the model's
    // secondary translucent draw, edge/velocity draws) carry no pick ID,
    // so dropping them loses no pick coverage — the geometry's real pick
    // command is either its resolved variant or a sibling pickOnly draw.
    const resolvedPickVariant = dispatched !== command;
    const cmdMarkers = command as {
      pickOnly?: boolean;
      _isPickCommand?: boolean;
    };
    // Two established dedicated-pick markers: `pickOnly` (collections,
    // mirrors WebGL `DrawCommand.pickOnly`) and `_isPickCommand`
    // (geometry-primitive path in WebGPUPrimitiveCommands.js). Either
    // means the command's pipeline already targets the single pick
    // attachment, so it is safe to dispatch into the pick render pass.
    const isDedicatedPick =
      cmdMarkers.pickOnly === true || cmdMarkers._isPickCommand === true;
    // The WebGPU mini-frame can encode only native WebGPU draw commands.
    // Legacy WebGL DrawCommands can also carry `pickOnly`; dispatching one
    // through WebGPUContext.draw eventually calls
    // `GPURenderPassEncoder.draw(DrawCommand, PassState)` and fails WebIDL's
    // unsigned-long conversion. Standalone ClassificationPrimitive retains
    // such compatibility commands alongside its native feature-renderer
    // command, so the marker alone is not a sufficient admission test.
    const isNativeWebGPU = dispatched.isWebGPUDrawCommand === true;
    if (!isNativeWebGPU || (!resolvedPickVariant && !isDedicatedPick)) {
      continue;
    }

    dispatched.execute(pickRenderPass, pickDynamicState);

    // C-R9-MODEL-PICK-TRANSLUCENT (Batch 192) — Option C precise pick
    // 2-pass coordination. When `pickMode === "precise"`, the dispatcher
    // returns pass 1 (depth-only). Pass 2 (depth-EQUAL color winner)
    // must follow within the SAME render pass so the depth + stencil
    // attachments persist between passes. Per-primitive interleaving
    // (prim1.pass1 → prim1.pass2 → prim2.pass1 → prim2.pass2) is the
    // simplest correct ordering — pass 2's depth-EQUAL test compares
    // against the depth pass 1 just wrote for THIS primitive, so a
    // later primitive's pass 1 (closer depth) doesn't invalidate this
    // primitive's pass 2 winner.
    //
    // Note: this per-primitive interleave is correct AS LONG AS pass 2
    // runs immediately after the same primitive's pass 1. Cross-
    // primitive ordering (which fragment ultimately writes pickColor at
    // a given pixel) follows the standard depth-test winner — closer
    // translucent fragment wins.
    if (
      scene.frameState?.passes?.pickMode === "precise" &&
      command.derivedCommands?.picking?.pickPrecisePass2Command
    ) {
      const pass2 = command.derivedCommands.picking.pickPrecisePass2Command;
      if (pass2.isWebGPUDrawCommand === true) {
        pass2.execute(pickRenderPass, pickDynamicState);
      }
    }
  }
}
