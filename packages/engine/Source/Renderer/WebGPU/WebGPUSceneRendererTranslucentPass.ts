/**
 * Dispatches the translucent pass for `WebGPUSceneRenderer` through one of
 * two paths:
 *
 *   1. Full MRT OIT (McGuire & Bavoil 2013) when the renderer safety gate is
 *      enabled, `WebGPUOIT` is supported, `useOIT` is on, the frame is not a
 *      pick frame, and commands carry `_oitPipeline` variants. Commands that
 *      retain `_shaderCode` can build their OIT variant lazily. The path runs
 *      an accumulation pass and composites it over the scene framebuffer.
 *   2. Back-to-front alpha blending through per-command `executeBatch` when
 *      OIT is unavailable.
 *
 * The host supplies the OIT instance and safety state, scene-color resolve,
 * translucent culling, and any Gaussian splats deferred from the opaque pass.
 * Deferred splats are consumed exactly once, either by OIT accumulation or by
 * the inline fallback.
 *
 * @module WebGPUSceneRendererTranslucentPass
 */

import Pass from "../../Renderer/Pass.js";
import WebGPUBuffer from "./WebGPUBuffer.js";
import type { WebGPUOIT } from "./WebGPUOIT.js";
import type { WebGPUContext } from "./WebGPUContext.js";
import {
  executeBatch,
  sortCommandsBackToFront,
  sortGaussianSplatsBackToFront,
  type WebGPURenderFrameConfig,
} from "./WebGPUSceneRenderer.js";

// Draw commands may carry either a `WebGPUBuffer` wrapper from a primitive or
// collection renderer, or a raw `GPUBuffer` from a model renderer. OIT must
// resolve both forms just like `WebGPUDrawCommand.execute()`; reading
// `.buffer` unconditionally turns a raw model buffer into `undefined`.
function resolveOITBuffer(
  buf: { buffer: GPUBuffer } | GPUBuffer | undefined,
): GPUBuffer | undefined {
  if (!buf) {
    return undefined;
  }
  return buf instanceof WebGPUBuffer
    ? buf.buffer
    : ((buf as { buffer?: GPUBuffer }).buffer ?? (buf as GPUBuffer));
}

/**
 * The SceneRenderer surface used by the translucent pass.
 */
export interface TranslucentPassHost {
  _oit: WebGPUOIT | null;
  _webgpuOITEnabled: boolean;
  _webgpuOITActiveThisFrame: boolean;
  _deferredOITSplats: {
    commands: CesiumAnyDrawCommand[];
    count: number;
  } | null;
  // Returns the command array and matching count after optional translucent
  // GPU culling. The input array is returned unchanged when the gate is off.
  _maybeGPUCullTranslucent: (
    commands: CesiumAnyDrawCommand[],
    count: number,
    config: WebGPURenderFrameConfig,
  ) => { commands: CesiumAnyDrawCommand[]; count: number };
  // Resolves multisampled scene color only when a consumer needs it.
  _ensureSceneColorResolved: (context: WebGPUContext) => void;
  // OIT depth testing needs the scene framebuffer's combined depth-stencil
  // render-pass view. `context._depthStencilView` is a depth-only view intended
  // for shader sampling.
  _sceneFramebuffer?: {
    colorTarget?: {
      getDepthStencilTextureView?: () => GPUTextureView | undefined;
    } | null;
  } | null;
}

/**
 * Dispatches `Pass.TRANSLUCENT` for a single frustum.
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

  // The optional splat-to-OIT path can defer Gaussian splats even when the
  // frame has no ordinary translucent commands. Consume them before any early
  // return so they cannot disappear in a bare-globe splat scene. The inline
  // path preserves WebGL semantics: back-to-front order, scene-pass depth
  // testing, and `Pass.GAUSSIAN_SPLATS` before `Pass.TRANSLUCENT`.
  const executeDeferredSplatsInline = (): void => {
    const deferred = host._deferredOITSplats;
    if (!deferred) {
      return;
    }
    host._deferredOITSplats = null;
    sortGaussianSplatsBackToFront(deferred.commands, deferred.count, scene);
    executeBatch(deferred.commands, deferred.count, scene, context, passState);
  };

  if (count === 0 && !host._deferredOITSplats) {
    return;
  }

  context.uniformState?.updatePass(Pass.TRANSLUCENT);

  // Translucent GPU culling uses its own command-count gate and re-tests
  // commands against the current culling volume. Filtering preserves input
  // order, so both OIT accumulation and back-to-front alpha sorting remain
  // valid. The helper is a no-op during picking, while disabled, or before a
  // fresh readback exists. Deferred splats still need the flush below when the
  // ordinary translucent count is zero.
  if (count > 0) {
    const culled = host._maybeGPUCullTranslucent(commands, count, config);
    if (culled.commands !== commands) {
      commands = culled.commands;
      count = culled.count;
    }
  }

  // Full MRT OIT requires two-target pipeline variants: `rgba16float`
  // accumulation and `r8unorm` revealage. A command without `_oitPipeline`
  // uses the alpha-blended fallback.
  if (
    host._webgpuOITEnabled &&
    host._oit &&
    host._oit.isSupported &&
    config.useOIT &&
    !config.picking
  ) {
    // Retaining WGSL in `_shaderCode` opts a command into lazy OIT pipeline
    // creation.
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
      // The OIT path ends the opaque pass, accumulates, and then composites.
      const encoder: GPUCommandEncoder | undefined =
        context._currentCommandEncoder;
      // OIT accumulation depth-tests against opaque scene depth and therefore
      // needs the combined render-pass depth-stencil view. A depth-only
      // sampleable view does not encompass every aspect of a
      // `depth24plus-stencil8` attachment and fails WebGPU validation. The
      // context view remains a defensive fallback for formats without a
      // published combined view.
      const depthView =
        host._sceneFramebuffer?.colorTarget?.getDepthStencilTextureView?.() ??
        context._depthStencilView;
      if (encoder && depthView) {
        context.endCurrentRenderPass?.();

        // The accumulation pass has two color targets and read-only depth.
        const accPassDesc = host._oit.getAccumulationPassDescriptor(depthView);
        if (accPassDesc) {
          const accPass = encoder.beginRenderPass(
            context.withRenderPassTimestamps(
              accPassDesc,
              "OIT-Accumulation-Pass",
            ),
          );
          host._webgpuOITActiveThisFrame = true;
          // Encode one OIT command into the accumulation pass.
          const executeOITCommand = (cmd: CesiumAnyDrawCommand) => {
            if (!cmd?._oitPipeline) return;
            accPass.setPipeline(cmd._oitPipeline);
            // Collection renderers publish a camera uniform block repacked for
            // each live frustum slice only through bind-group resolvers. The
            // static bind group retains the renderer-update projection, whose
            // WebGL clip range lies outside WebGPU's [0, 1] range in 2D. Using
            // the resolver keeps billboards, points, labels, polylines, and
            // clouds inside the current slice. A null result falls back to the
            // static group for single-frustum and first-frame cases.
            const commandBindings = cmd as unknown as {
              bindGroupResolvers?: Array<
                undefined | (() => GPUBindGroup | null)
              >;
              bindGroupDynamicOffsets?: Array<number[] | undefined>;
            };
            const resolvers = commandBindings.bindGroupResolvers;
            // The OIT variant uses the color pipeline's layout. A group with
            // `hasDynamicOffset` must therefore carry the same offset here;
            // omitting it is invalid, while binding offset zero can select
            // another draw's camera block.
            const dynamicOffsets = commandBindings.bindGroupDynamicOffsets;
            for (let bi = 0; bi < cmd.bindGroups.length; bi++) {
              const resolver = resolvers?.[bi];
              const resolved = resolver ? resolver() : null;
              const offsets = dynamicOffsets?.[bi];
              if (offsets !== undefined) {
                accPass.setBindGroup(
                  bi,
                  resolved ?? cmd.bindGroups[bi],
                  offsets,
                );
              } else {
                accPass.setBindGroup(bi, resolved ?? cmd.bindGroups[bi]);
              }
            }
            for (let vi = 0; vi < cmd.vertexBuffers.length; vi++) {
              accPass.setVertexBuffer(
                vi,
                resolveOITBuffer(cmd.vertexBuffers[vi]),
              );
            }
            if (cmd.indexBuffer && cmd.indexCount) {
              accPass.setIndexBuffer(
                resolveOITBuffer(cmd.indexBuffer)!,
                cmd.indexFormat ?? "uint16",
              );
              accPass.drawIndexed(cmd.indexCount, cmd.instanceCount ?? 1);
            } else if (cmd.vertexCount) {
              accPass.draw(cmd.vertexCount, cmd.instanceCount ?? 1);
            }
          };

          // Encode translucent commands that carry OIT variants.
          for (let ci = 0; ci < count; ci++) {
            const cmd = commands[ci];
            if (cmd?.isWebGPUDrawCommand && cmd._oitPipeline) {
              executeOITCommand(cmd);
            }
          }

          // Include deferred Gaussian splats in OIT accumulation.
          const deferredSplats = host._deferredOITSplats;
          if (deferredSplats) {
            for (let si = 0; si < deferredSplats.count; si++) {
              executeOITCommand(deferredSplats.commands[si]);
            }
            host._deferredOITSplats = null;
          }

          accPass.end();

          // Resolve accumulated opaque color before the OIT composite writes
          // over it. The call is inert for single-sample color and preserves
          // the established multisample/OIT ordering.
          host._ensureSceneColorResolved(context);

          // Composite the OIT result over opaque scene color.
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

        // Resume the default render pass for subsequent work.
        context.resumeDefaultRenderPass?.();
        // A missing accumulation descriptor leaves deferred splats pending, so
        // draw them inline on the resumed scene pass.
        executeDeferredSplatsInline();
        return;
      }
    }
  }

  // When OIT does not run, consume deferred splats inline before translucent
  // alpha blending. This matches WebGL pass order and composes splats under
  // the fallback that follows.
  executeDeferredSplatsInline();
  if (count === 0) {
    return;
  }

  // Alpha compositing is order-dependent, so the fallback must draw commands
  // back-to-front. Command-push order gives visibly wrong occlusion for
  // overlapping labels, buildings, and semi-transparent layers.
  //
  // Sort only the active prefix so pooled slots at [count, length) retain
  // their contents for reuse and `frustumCommands.indices` remains
  // authoritative.
  sortCommandsBackToFront(commands, count, scene);
  executeBatch(commands, count, scene, context, passState);
}
