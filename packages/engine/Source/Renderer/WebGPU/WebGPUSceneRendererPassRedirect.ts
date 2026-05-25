/**
 * Scene-framebuffer render-pass redirect extracted from
 * `WebGPUSceneRenderer.executeCommands`.
 *
 * Batch 138 of the audit-recommended SceneRenderer decomposition —
 * Slice A of the executeCommands four-slice plan (see
 * `migration_doc/BATCH_138_PLAN_EXECUTE_COMMANDS_SLICE_PLAN.md`).
 *
 * Responsibility: end the canvas swap-chain render pass that
 * `WebGPUContext.beginFrame()` opened, and begin a new one targeting
 * the scene framebuffer's color + depth attachments. The post-process
 * pipeline reads from the scene framebuffer and blits to the canvas
 * later in `_runPostProcessing`.
 *
 * Three branches:
 *
 *   1. Happy path — `usePostProcess && _sceneFramebuffer.colorTarget`:
 *      end canvas pass, build attachments, begin scene-FB pass, set
 *      viewport + scissor.
 *   2. Bad config — `usePostProcess` is true but no scene framebuffer:
 *      log a critical error (the canvas will end up black).
 *   3. `usePostProcess` is false: do nothing — the canvas pass stays
 *      open and commands draw directly to it.
 *
 * Errors that the diag logs catch:
 *   - Scene framebuffer with no color attachments (broken
 *     `WebGPUSceneFramebuffer.update`).
 *   - Scene framebuffer with no depth/stencil (depth-test disabled
 *     for all draws — usually means a resize race).
 *
 * @module WebGPUSceneRendererPassRedirect
 */

import { isSceneFBMrtMode } from "./WebGPUSceneFBTargetHelpers.js";
import type { WebGPUContext } from "./WebGPUContext.js";
import type { WebGPUSceneFramebuffer } from "./WebGPUSceneFramebuffer.js";
import type { WebGPURenderFrameConfig } from "./WebGPUSceneRenderer.js";

/**
 * The SceneRenderer surface the pass-redirect helper reaches back to.
 */
export interface PassRedirectHost {
  _sceneFramebuffer: WebGPUSceneFramebuffer | null;
  _width: number;
  _height: number;
  // Pragma-stripped log-once guard (production builds elide the field
  // declaration AND the read/write inside this module — both sides are
  // wrapped in debug pragma blocks). NOTE: do not paste the literal
  // pragma directive text into this comment — `stripPragmaPlugin` in
  // `scripts/build.js` matches the regex `//>>includeStart('debug', …)`
  // anywhere in source (it has no comment-awareness), so a mention of
  // the directive in a string or comment becomes a fake pragma start
  // and strips everything down to the next real `//>>includeEnd`.
  _renderPassRedirectLogged: boolean;
}

/**
 * Redirect the active render pass from the canvas swap chain to the
 * scene framebuffer. Idempotent within a frame — caller decides
 * whether to invoke (typically gated on `!picking`).
 *
 * @param host - The owning SceneRenderer.
 * @param context - The active WebGPU context (carries the encoder and
 *   render-pass-encoder slots).
 * @param config - The render-frame config from `executeCommands`.
 */
export function setupSceneFramebufferRenderPass(
  host: PassRedirectHost,
  context: WebGPUContext,
  config: WebGPURenderFrameConfig,
): void {
  // ── Redirect the render pass from the canvas to the scene framebuffer ──
  //
  // The WebGPU context's beginFrame() opens a default render pass
  // targeting the canvas swap chain. But we need commands to draw into
  // the scene framebuffer's color + depth textures so the post-process
  // pipeline can read from them and blit to the canvas later.
  //
  // End the default (canvas) render pass and begin a new one targeting
  // the scene framebuffer. After the frustum loop + environment passes,
  // _runPostProcessing will read from the scene framebuffer and write
  // to the canvas.
  if (host._sceneFramebuffer?.colorTarget && config.usePostProcess) {
    context.endCurrentRenderPass?.();

    const colorTarget = host._sceneFramebuffer.colorTarget;
    const bg = config.backgroundColor;
    let colorAttachments = colorTarget.getColorAttachments?.([
      {
        r: bg?.red ?? 0,
        g: bg?.green ?? 0,
        b: bg?.blue ?? 0,
        a: bg?.alpha ?? 0,
      },
    ]);
    const depthStencilAttachment = colorTarget.getDepthStencilAttachment?.();

    if (!colorAttachments?.length) {
      context.log(
        "error",
        `[SceneRenderer] CRITICAL — scene framebuffer has no color ` +
          `attachments. Commands will draw to nothing and the canvas ` +
          `will be BLACK. Check WebGPUSceneFramebuffer.update().`,
      );
    }
    if (!depthStencilAttachment) {
      context.log(
        "warn",
        `[SceneRenderer] Scene framebuffer has no depth/stencil ` +
          `attachment. Depth testing will be disabled for all commands.`,
      );
    }

    // SUB-C INVESTIGATION (Slice 5c-B): when MRT mode is on, append the
    // G-buffer normal-roughness view as a 2nd color attachment. The
    // Phase 1 converted pipelines (including globe per the same batch)
    // already declare 2 color targets, so the pass MUST have a matching
    // attachment count.
    //
    // Probe goal: capture the WebGPU validation error if any of the
    // following fail —
    //   - sampleCount mismatch between scene FB MSAA and G-buffer MSAA
    //   - missing resolveTarget when MSAA is on
    //   - frozen array push on `colorAttachments` (some renderers may
    //     have hardened the return value as `Object.freeze`)
    //   - format incompatibility between pipeline target[1] (rgba16float)
    //     and the slot-1 attachment.
    if (colorAttachments?.length && isSceneFBMrtMode()) {
      const sceneAny = config.scene as unknown as {
        _view?: {
          gBufferFramebuffer?: {
            renderAttachmentView?: GPUTextureView | null;
            resolveTargetView?: GPUTextureView | null;
            sampleCount?: number;
          };
        };
      };
      const gb = sceneAny?._view?.gBufferFramebuffer;
      if (gb?.renderAttachmentView) {
        // Build the slot-1 attachment. loadOp=clear with a sentinel
        // (0,0,0,1) so the depth-derived consumer fallback fires for
        // any fragment the producer doesn't overwrite (sky, edges,
        // primitives that haven't been wired for slot-1 writes yet).
        const slot1: GPURenderPassColorAttachment = {
          view: gb.renderAttachmentView,
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          ...(gb.resolveTargetView
            ? { resolveTarget: gb.resolveTargetView }
            : {}),
        };
        // Defensive: build a NEW array rather than mutating in place,
        // in case the producer returns a frozen one (was one of the
        // 6 suspect causes from the postmortem).
        colorAttachments = [...colorAttachments, slot1];
      }
    }
    if (colorAttachments?.length && context._currentCommandEncoder) {
      const passDesc: GPURenderPassDescriptor = {
        label: "Scene Framebuffer Render Pass",
        colorAttachments,
        depthStencilAttachment,
      };
      context._currentRenderPassEncoder =
        context._currentCommandEncoder.beginRenderPass(passDesc);
      context._currentRenderPassEncoder.setViewport(
        0,
        0,
        host._width,
        host._height,
        0,
        1,
      );
      context._currentRenderPassEncoder.setScissorRect(
        0,
        0,
        host._width,
        host._height,
      );
      //>>includeStart('debug', pragmas.debug);
      if (!host._renderPassRedirectLogged) {
        host._renderPassRedirectLogged = true;
        const ca0 = colorAttachments[0];
        console.warn(
          `[WebGPU:SceneRenderer] RENDER PASS REDIRECT — ` +
            `sceneFB pass OPENED. viewport=${host._width}x${host._height} ` +
            `colorView=${!!ca0?.view} resolveTarget=${!!ca0?.resolveTarget} ` +
            `depthView=${!!depthStencilAttachment?.view} ` +
            `loadOp=${ca0?.loadOp} storeOp=${ca0?.storeOp} ` +
            `clearColor=${JSON.stringify(ca0?.clearValue)}`,
        );
      }
      //>>includeEnd('debug');
    } else if (!host._renderPassRedirectLogged) {
      host._renderPassRedirectLogged = true;
      console.error(
        `[WebGPU:SceneRenderer] RENDER PASS REDIRECT FAILED — ` +
          `colorAttachments=${colorAttachments?.length} encoder=${!!context._currentCommandEncoder}`,
      );
    }
  } else if (config.usePostProcess) {
    // usePostProcess is true but no scene framebuffer — commands will
    // draw to the canvas directly and the post-process blit will
    // overwrite them with the empty scene framebuffer.
    context.log(
      "error",
      `[SceneRenderer] CRITICAL — usePostProcess=true but no scene ` +
        `framebuffer color target exists. The post-process blit will ` +
        `overwrite the canvas with black. ` +
        `sceneFramebuffer=${!!host._sceneFramebuffer} ` +
        `colorTarget=${!!host._sceneFramebuffer?.colorTarget}`,
    );
  }
}
