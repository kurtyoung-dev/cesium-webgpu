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
    if (!resolvedPickVariant && !isDedicatedPick) {
      continue;
    }

    if (dispatched.isWebGPUDrawCommand === true) {
      dispatched.execute(pickRenderPass, context);
    } else if (dispatched.execute) {
      dispatched.execute(context, passState);
    }

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
        pass2.execute(pickRenderPass, context);
      } else if (pass2.execute) {
        pass2.execute(context, passState);
      }
    }
  }
}
