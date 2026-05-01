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
 *     TRANSLUCENT → VOXELS → GAUSSIAN_SPLATS) into that render pass.
 *   - For each command, route through `selectCommandVariant(...,
 *     isPickPass=true)` so commands carrying a `derivedCommands.picking`
 *     entry render their pick variant (writes pick IDs) instead of
 *     the base material.
 *   - End the pick pass and resume the default canvas pass when done.
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

import Pass from "../../Renderer/Pass.js";
import type { WebGPUContext } from "./WebGPUContext.js";
import {
  selectCommandVariant,
  type WebGPURenderFrameConfig,
} from "./WebGPUSceneRenderer.js";

/**
 * The SceneRenderer surface that the extracted pick pass reaches
 * back to. Today's only callback is the frustum-uniform refresh; the
 * interface gives us a single place to grow if more callbacks become
 * necessary.
 */
export interface PickPassHost {
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
};

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

  const device: GPUDevice | undefined = context._device;
  const encoder: GPUCommandEncoder | undefined = context._currentCommandEncoder;
  if (!device || !encoder) {
    return;
  }

  // End the current render pass so we can start the pick render pass
  context.endCurrentRenderPass?.();

  // Create the pick render pass targeting the pick FBO textures
  const pickPassDescriptor: GPURenderPassDescriptor = {
    label: "Pick render pass",
    colorAttachments: [
      {
        view: pickFBO.colorView as GPUTextureView,
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        loadOp: "clear" as GPULoadOp,
        storeOp: "store" as GPUStoreOp,
      },
    ],
    depthStencilAttachment: {
      view: pickFBO.depthView as GPUTextureView,
      depthClearValue: 1.0,
      depthLoadOp: "clear" as GPULoadOp,
      depthStoreOp: "store" as GPUStoreOp,
      stencilClearValue: 0,
      stencilLoadOp: "clear" as GPULoadOp,
      stencilStoreOp: "store" as GPUStoreOp,
    },
  };

  const pickRenderPass = encoder.beginRenderPass(pickPassDescriptor);

  // Set the pick render pass as the active pass on the context so that
  // executeWebGPUCommand() dispatches commands to it
  const savedRenderPass = context.currentRenderPassEncoder;
  context._currentRenderPassEncoder = pickRenderPass;

  // Execute all pickable passes across all frustums
  for (let i = 0; i < numFrustums; i++) {
    const index = numFrustums - i - 1;
    const frustumCommands = frustumCommandsList[index];

    const near = frustumCommands.near;
    const far = frustumCommands.far;
    host._updateFrustumUniforms(uniformState, near, far, scene);

    // Skip ENVIRONMENT pass — sky/sun/moon/atmosphere don't generate pick IDs

    // GLOBE pass
    executePickBatch(
      frustumCommands,
      Pass.GLOBE,
      scene,
      context,
      passState,
      pickRenderPass,
    );

    // 3D Tiles passes
    const tilePasses = [
      Pass.CESIUM_3D_TILE,
      Pass.CESIUM_3D_TILE_CLASSIFICATION,
    ];
    for (const passIndex of tilePasses) {
      executePickBatch(
        frustumCommands,
        passIndex,
        scene,
        context,
        passState,
        pickRenderPass,
      );
    }

    // OPAQUE pass
    executePickBatch(
      frustumCommands,
      Pass.OPAQUE,
      scene,
      context,
      passState,
      pickRenderPass,
    );

    // TRANSLUCENT pass
    executePickBatch(
      frustumCommands,
      Pass.TRANSLUCENT,
      scene,
      context,
      passState,
      pickRenderPass,
    );

    // H-R3 (Batch 35) — VOXELS and GAUSSIAN_SPLATS pick passes. WebGL
    // includes them in the pick-pass command list via
    // `performIdPass`; WebGPU previously skipped them so voxel media
    // and Gaussian splat primitives were unpickable. Commands without
    // a pick variant fall through to the base command via
    // `selectCommandVariant` (Batch 29), same as other passes.
    executePickBatch(
      frustumCommands,
      Pass.VOXELS,
      scene,
      context,
      passState,
      pickRenderPass,
    );
    executePickBatch(
      frustumCommands,
      Pass.GAUSSIAN_SPLATS,
      scene,
      context,
      passState,
      pickRenderPass,
    );
  }

  pickRenderPass.end();

  // Restore the original render pass
  context._currentRenderPassEncoder = savedRenderPass;

  // Resume the default render pass if needed
  context.resumeDefaultRenderPass?.();
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
    // output, not base-material output) into the pick FBO. Commands
    // without a pick variant fall through to the base command — same
    // as WebGL. WebGPU-native feature renderers (Globe, GltfModel,
    // GroundPrimitive) typically emit pick commands through their own
    // path and don't populate derivedCommands.picking; those still
    // take the fallback branch.
    const dispatched = selectCommandVariant(command, scene, true);
    if (dispatched.isWebGPUDrawCommand === true) {
      dispatched.execute(pickRenderPass, context);
    } else if (dispatched.execute) {
      dispatched.execute(context, passState);
    }
  }
}
