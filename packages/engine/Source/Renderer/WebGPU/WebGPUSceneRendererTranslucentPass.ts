/**
 * Translucent-pass dispatch extracted from `WebGPUSceneRenderer`.
 *
 * Batch 136 of the audit-recommended SceneRenderer decomposition.
 * Covers both dispatch paths:
 *
 *   1. Full MRT OIT (McGuire & Bavoil 2013) — only when the internal
 *      FAR-003 comparison gate is forced, WebGPUOIT is supported,
 *      `useOIT` is on, this isn't a pick frame, and
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
import WebGPUBuffer from "./WebGPUBuffer.js";
import type { WebGPUOIT } from "./WebGPUOIT.js";
import type { WebGPUContext } from "./WebGPUContext.js";
import {
  executeBatch,
  sortCommandsBackToFront,
  sortGaussianSplatsBackToFront,
  type WebGPURenderFrameConfig,
} from "./WebGPUSceneRenderer.js";

// C11-157 Slice C — a vertex/index buffer on a draw command can be EITHER our
// `WebGPUBuffer` wrapper (`.buffer` accessor — primitives/collections) OR a raw
// `GPUBuffer` (models). `executeOITCommand` must resolve both, exactly like the
// canonical `WebGPUDrawCommand.execute()` path. Before this, the OIT
// accumulation path assumed the wrapper and threw `setIndexBuffer: parameter 1
// is not of type 'GPUBuffer'` on model commands (raw GPUBuffer → `.buffer`
// undefined) — latent until Slice C made translucent models OIT-reachable.
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
 * The SceneRenderer surface that the extracted translucent pass
 * reaches back to.
 */
export interface TranslucentPassHost {
  _oit: WebGPUOIT | null;
  _webgpuOITEnabled: boolean;
  _webgpuOITActiveThisFrame: boolean;
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
  // C10-03-MSAA-BOUNDARY-BYTES — demand-driven scene-COLOR MSAA resolve.
  _ensureSceneColorResolved: (context: WebGPUContext) => void;
  // C11-157 Slice A — the scene framebuffer's color target exposes the
  // all-aspects render-pass depth-stencil view the OIT accumulation pass must
  // depth-test against (NOT the depth-only sampleable view carried by
  // `context._depthStencilView`, which is for shader sampling only).
  _sceneFramebuffer?: {
    colorTarget?: {
      getDepthStencilTextureView?: () => GPUTextureView | undefined;
    } | null;
  } | null;
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

  // C7-SPLAT-DEPTH-COMPOSE — never-drop seatbelt for deferred GS-WSR splats.
  // Only relevant when the opt-in `_splatOITDeferral` flag is armed (default
  // off = splats already drew inline in pass 11). Pre-fix, the `count === 0`
  // early return below dropped `_deferredOITSplats` silently whenever the
  // frame had zero TRANSLUCENT commands (the common bare-globe + splat scene),
  // so the deferred splat never rendered. Flushing them inline preserves
  // WebGL-parity semantics: back-to-front sorted, scene-pass depth test,
  // executed in GAUSSIAN_SPLATS-before-TRANSLUCENT order.
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

  // Batch 216 — gate-controlled translucent GPU cull. The gate
  // (`_gpuCullActive`) is updated in the opaque pass each frame; if
  // active, this re-tests translucent commands against the same
  // cullingVolume and replaces the array with a filtered subset.
  // Order is preserved (same iteration), so OIT accumulation and
  // back-to-front alpha both stay correct. No-op when the gate is
  // off, on pick, or when no readback is fresh yet.
  // C7-SPLAT-DEPTH-COMPOSE — only cull when there are translucent commands;
  // with count === 0 but deferred splats pending we still need to reach the
  // flush below rather than early-returning here.
  if (count > 0) {
    const culled = host._maybeGPUCullTranslucent(commands, count, config);
    if (culled.commands !== commands) {
      commands = culled.commands;
      count = culled.count;
    }
  }

  // OIT accumulation + composite path.
  // Full MRT OIT (McGuire & Bavoil 2013) requires 2-target pipeline variants
  // for each renderer (accumulation rgba16float + revealage r8unorm).
  // Pipeline variant support is implemented per-renderer by checking
  // command._oitPipeline. When available, we use the MRT accumulation pass;
  // otherwise fall back to standard alpha blending.
  if (
    host._webgpuOITEnabled &&
    host._oit &&
    host._oit.isSupported &&
    config.useOIT &&
    !config.picking
  ) {
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
      // C11-157 Slice A — the OIT accumulation pass depth-tests against the
      // opaque scene depth, so it needs the scene FB's ALL-ASPECTS render-pass
      // depth-stencil view. `context._depthStencilView` is the depth-ONLY
      // sampleable view (for env/AO/DoF shader sampling); using it as a
      // depthStencilAttachment on a depth24plus-stencil8 target fails WebGPU's
      // "must encompass all aspects" validation. Fall back to it only if the
      // scene FB view is unavailable (defensive; shouldn't happen in practice).
      const depthView =
        host._sceneFramebuffer?.colorTarget?.getDepthStencilTextureView?.() ??
        context._depthStencilView;
      if (encoder && depthView) {
        context.endCurrentRenderPass?.();

        // Begin OIT accumulation render pass (2 MRT targets, depth read-only)
        const accPassDesc = host._oit.getAccumulationPassDescriptor(depthView);
        if (accPassDesc) {
          const accPass = encoder.beginRenderPass(
            context.withRenderPassTimestamps(
              accPassDesc,
              "OIT-Accumulation-Pass",
            ),
          );
          host._webgpuOITActiveThisFrame = true;
          // Helper to execute a single OIT command in the accumulation pass
          const executeOITCommand = (cmd: CesiumAnyDrawCommand) => {
            if (!cmd?._oitPipeline) return;
            accPass.setPipeline(cmd._oitPipeline);
            // NEW-COLLECTIONS-2DCV-COPLANAR-DEPTH — honor per-index bind-group
            // resolvers, mirroring `WebGPUDrawCommand.execute()` (L515-519).
            // Collection FRs (billboard/point/label/polyline/cloud) deliver
            // their per-slice camera UB — repacked against the live per-slice
            // projection (WebGPU depth range, this band's near/far) — ONLY via
            // a resolver; the static `cmd.bindGroups[bi]` holds the stale
            // FR-update-time bake (WebGL clip-z range). In SCENE2D that stale
            // bake puts a map-surface overlay at NDC z ≈ 7.3 (outside [0,1]),
            // so the OIT accumulation draw clipped every fragment — the
            // all-zero 2D billboard/point/label state. Resolving here routes
            // the in-range per-slice UB into the OIT path too. A resolver
            // returning null falls back to the static group (single-frustum /
            // first frame), unchanged.
            const resolvers = (
              cmd as unknown as {
                bindGroupResolvers?: Array<
                  undefined | (() => GPUBindGroup | null)
                >;
              }
            ).bindGroupResolvers;
            for (let bi = 0; bi < cmd.bindGroups.length; bi++) {
              const resolver = resolvers?.[bi];
              const resolved = resolver ? resolver() : null;
              accPass.setBindGroup(bi, resolved ?? cmd.bindGroups[bi]);
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

          // C10-03 — resolve the accumulated opaque scene color on demand
          // before the OIT composite writes over it (the eager per-segment
          // resolve was elided). Inert under MSAA-off (I5). MSAA×OIT
          // compositing ordering is the pre-existing FAR-003 adjacency, not
          // this slice's concern.
          host._ensureSceneColorResolved(context);

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
        // C7-SPLAT-DEPTH-COMPOSE — if the accumulation pass didn't run
        // (accPassDesc null) the deferred splats are still pending; draw
        // them inline on the resumed scene pass rather than dropping them.
        executeDeferredSplatsInline();
        return;
      }
    }
  }

  // C7-SPLAT-DEPTH-COMPOSE — the OIT accumulation path didn't run (no OIT
  // pipelines this frame, or OIT unsupported/picking); consume any deferred
  // splats inline FIRST. WebGL pass order draws GAUSSIAN_SPLATS before
  // TRANSLUCENT (`SceneRenderer.js`), so the splats compose under the
  // translucent fallback that follows.
  executeDeferredSplatsInline();
  if (count === 0) {
    return;
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
