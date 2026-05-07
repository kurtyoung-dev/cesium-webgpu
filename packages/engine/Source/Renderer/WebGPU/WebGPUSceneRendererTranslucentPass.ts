/**
 * Translucent-pass dispatch extracted from `WebGPUSceneRenderer`.
 *
 * Batch 136 of the audit-recommended SceneRenderer decomposition.
 * Covers both dispatch paths:
 *
 *   1. Full MRT OIT (McGuire & Bavoil 2013) — when WebGPUOIT is
 *      supported, `useOIT` is on, this isn't a pick frame, and
 *      commands carry `_oitPipeline` variants. Auto-builds OIT
 *      pipelines for any command with `_shaderCode` that hasn't yet
 *      been wired. Runs accumulation pass + composite over the scene
 *      framebuffer.
 *   2. Alpha-blend fallback — back-to-front sort + per-command
 *      `executeBatch` when the OIT path bails for any reason.
 *
 * The function reaches back to the SceneRenderer host for two pieces
 * of state:
 *
 *   - `_oit`: the WebGPUOIT instance (read for support / pipeline
 *     factory / composite call).
 *   - `_deferredOITSplats`: GS-WSR splat commands deferred from the
 *     opaque-pass dispatcher to be folded into the OIT accumulation
 *     pass. Read AND nulled (consumed once per frame).
 *
 * @module WebGPUSceneRendererTranslucentPass
 */

import Pass from "../../Renderer/Pass.js";
import type { WebGPUOIT } from "./WebGPUOIT.js";
import {
  executeBatch,
  sortCommandsBackToFront,
  type WebGPURenderFrameConfig,
} from "./WebGPUSceneRenderer.js";

/**
 * The SceneRenderer surface that the extracted translucent pass
 * reaches back to.
 */
export interface TranslucentPassHost {
  _oit: WebGPUOIT | null;
  _deferredOITSplats: {
    commands: CesiumAnyDrawCommand[];
    count: number;
  } | null;
  // Batch 216 — gate-controlled GPU cull for translucent commands.
  // Returns the (possibly filtered) command array + matching count.
  // Hot-path safe: returns the input array when the gate is off.
  _maybeGPUCullTranslucent: (
    commands: CesiumAnyDrawCommand[],
    count: number,
    config: WebGPURenderFrameConfig,
  ) => { commands: CesiumAnyDrawCommand[]; count: number };
}

/**
 * Dispatch the TRANSLUCENT pass for a single frustum.
 *
 * @param host - The owning SceneRenderer (for `_oit` +
 *   `_deferredOITSplats` access).
 * @param frustumCommands - Per-frustum command list bucket.
 * @param config - Render-frame config from `executeCommands`.
 */
export function executeTranslucentPass(
  host: TranslucentPassHost,
  frustumCommands: CesiumFrustumCommands,
  config: WebGPURenderFrameConfig,
): void {
  const { scene, context, passState } = config;
  let commands = frustumCommands.commands[Pass.TRANSLUCENT];
  let count: number = frustumCommands.indices[Pass.TRANSLUCENT];
  if (count === 0) {
    return;
  }

  context.uniformState?.updatePass(Pass.TRANSLUCENT);

  // Batch 216 — gate-controlled translucent GPU cull. The gate
  // (`_gpuCullActive`) is updated in the opaque pass each frame; if
  // active, this re-tests translucent commands against the same
  // cullingVolume and replaces the array with a filtered subset.
  // Order is preserved (same iteration), so OIT accumulation and
  // back-to-front alpha both stay correct. No-op when the gate is
  // off, on pick, or when no readback is fresh yet.
  const culled = host._maybeGPUCullTranslucent(commands, count, config);
  if (culled.commands !== commands) {
    commands = culled.commands;
    count = culled.count;
    if (count === 0) return;
  }

  // OIT accumulation + composite path.
  // Full MRT OIT (McGuire & Bavoil 2013) requires 2-target pipeline variants
  // for each renderer (accumulation rgba16float + revealage r8unorm).
  // Pipeline variant support is implemented per-renderer by checking
  // command._oitPipeline. When available, we use the MRT accumulation pass;
  // otherwise fall back to standard alpha blending.
  if (host._oit && host._oit.isSupported && config.useOIT && !config.picking) {
    // Auto-create OIT pipeline variants for commands that have shader code
    // but no OIT pipeline yet. This enables OIT for any command that opts in
    // by storing its WGSL source in _shaderCode.
    let hasOITPipelines = false;
    for (let ci = 0; ci < count; ci++) {
      const cmd = commands[ci];
      if (!cmd) continue;
      if (cmd._oitPipeline) {
        hasOITPipelines = true;
      } else if (cmd._shaderCode && cmd.isWebGPUDrawCommand && host._oit) {
        const pipelineConfig = cmd._pipelineConfig as
          | {
              label?: string;
              layout: GPUPipelineLayout | "auto";
              vertexBuffers?: GPUVertexBufferLayout[];
              vertexEntryPoint?: string;
              fragmentEntryPoint?: string;
              primitive?: GPUPrimitiveState;
              depthStencil?: GPUDepthStencilState;
              multisample?: GPUMultisampleState;
            }
          | undefined;
        const oitPipeline = host._oit.createOITPipeline(
          context.device,
          cmd._shaderCode,
          pipelineConfig ?? {
            label: cmd.owner?.constructor?.name ?? "auto",
            layout: "auto",
            primitive: { topology: "triangle-list" },
            depthStencil: context.depthFormat
              ? {
                  format: context.depthFormat,
                  depthWriteEnabled: false,
                  depthCompare: "less-equal" as GPUCompareFunction,
                }
              : undefined,
          },
        );
        if (oitPipeline) {
          cmd._oitPipeline = oitPipeline;
          hasOITPipelines = true;
        }
      }
    }

    if (hasOITPipelines) {
      // Full OIT path: end opaque render pass → accumulation → composite
      const encoder: GPUCommandEncoder | undefined =
        context._currentCommandEncoder;
      const depthView = context._depthStencilView;
      if (encoder && depthView) {
        context.endCurrentRenderPass?.();

        // Begin OIT accumulation render pass (2 MRT targets, depth read-only)
        const accPassDesc = host._oit.getAccumulationPassDescriptor(depthView);
        if (accPassDesc) {
          const accPass = encoder.beginRenderPass(accPassDesc);
          // Helper to execute a single OIT command in the accumulation pass
          const executeOITCommand = (cmd: CesiumAnyDrawCommand) => {
            if (!cmd?._oitPipeline) return;
            accPass.setPipeline(cmd._oitPipeline);
            for (let bi = 0; bi < cmd.bindGroups.length; bi++) {
              accPass.setBindGroup(bi, cmd.bindGroups[bi]);
            }
            for (let vi = 0; vi < cmd.vertexBuffers.length; vi++) {
              accPass.setVertexBuffer(
                vi,
                (cmd.vertexBuffers[vi] as { buffer: GPUBuffer })?.buffer,
              );
            }
            if (cmd.indexBuffer && cmd.indexCount) {
              accPass.setIndexBuffer(
                (cmd.indexBuffer as { buffer: GPUBuffer }).buffer,
                cmd.indexFormat ?? "uint16",
              );
              accPass.drawIndexed(cmd.indexCount, cmd.instanceCount ?? 1);
            } else if (cmd.vertexCount) {
              accPass.draw(cmd.vertexCount, cmd.instanceCount ?? 1);
            }
          };

          // Execute translucent commands with OIT pipeline variants
          for (let ci = 0; ci < count; ci++) {
            const cmd = commands[ci];
            if (cmd?.isWebGPUDrawCommand && cmd._oitPipeline) {
              executeOITCommand(cmd);
            }
          }

          // GS-WSR: Include deferred Gaussian splat commands in OIT accumulation
          const deferredSplats = host._deferredOITSplats;
          if (deferredSplats) {
            for (let si = 0; si < deferredSplats.count; si++) {
              executeOITCommand(deferredSplats.commands[si]);
            }
            host._deferredOITSplats = null;
          }

          accPass.end();

          // Composite OIT result over opaque scene
          const sceneColorView = context._sceneColorView;
          const sceneColorFormat = context._sceneColorFormat ?? "bgra8unorm";
          if (sceneColorView) {
            host._oit.executeComposite(
              encoder,
              sceneColorView,
              sceneColorFormat,
            );
          }
        }

        // Resume default render pass for subsequent passes
        context.resumeDefaultRenderPass?.();
        return;
      }
    }
  }

  // Fallback: render translucent commands with standard alpha blending.
  // Without OIT, alpha compositing is order-dependent — commands MUST be
  // drawn back-to-front for correct results. Without this sort, overlapping
  // translucent UI (labels through buildings, semi-transparent layers, etc.)
  // composites in command-push order and shows visibly wrong occlusion.
  //
  // We sort a slice rather than the full backing array so pooled slots at
  // [count, length) keep their last-frame contents for the next frame's
  // reuse logic, and `frustumCommands.indices` stays authoritative.
  sortCommandsBackToFront(commands, count, scene);
  executeBatch(commands, count, scene, context, passState);
}
