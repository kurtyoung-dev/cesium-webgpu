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
 * Slice 5c-B Batch 117 — build the MRT slot-1 (G-buffer normal-roughness)
 * color attachment for the scene framebuffer render pass. Returns null
 * when MRT mode is off OR when the G-buffer view isn't yet allocated.
 * Shared between this module and the two re-open sites in
 * `WebGPUSceneRenderer.ts` (`_resumeScenePass` and `_clearDepthStencil`)
 * so all three pass-open paths produce the same attachment shape.
 *
 * @param scene - The Scene whose `_view.gBufferFramebuffer` holds the
 *   target views. Typed as unknown because Scene is JS-side and lives
 *   outside the .ts boundary.
 * @param loadOp - "clear" for the initial frame open (sentinel value
 *   loads via `clearValue`); "load" for re-opens after a sub-pass
 *   (preserves whatever the producer + globe writes accumulated).
 * @returns A GPURenderPassColorAttachment for slot 1, or null to
 *   indicate the caller should leave the pass at 1 attachment.
 */
export function buildMrtSlot1Attachment(
  scene: unknown,
  loadOp: GPULoadOp,
): GPURenderPassColorAttachment | null {
  if (!isSceneFBMrtMode()) {
    return null;
  }
  const sceneAny = scene as {
    _view?: {
      gBufferFramebuffer?: {
        renderAttachmentView?: GPUTextureView | null;
        resolveTargetView?: GPUTextureView | null;
        sampleCount?: number;
      };
    };
  };
  const gb = sceneAny?._view?.gBufferFramebuffer;
  if (!gb?.renderAttachmentView) {
    return null;
  }
  return {
    view: gb.renderAttachmentView,
    loadOp,
    storeOp: "store",
    clearValue: { r: 0, g: 0, b: 0, a: 1 },
    ...(gb.resolveTargetView ? { resolveTarget: gb.resolveTargetView } : {}),
  };
}

/**
 * The SceneRenderer surface the pass-redirect helper reaches back to.
 */
export interface PassRedirectHost {
  _sceneFramebuffer: WebGPUSceneFramebuffer | null;
  _width: number;
  _height: number;
  // Per-frame cached viewport (set from `passState.viewport` at the top of
  // `executeCommands`). Equals the full canvas for normal renders; equals the
  // per-half sub-rect during the SCENE2D infinite-scroll wrap (BUG-3). The
  // scene-FB pass opens with THIS viewport/scissor so the wrap's two halves
  // each draw only into their screen sub-rect.
  _viewportX: number;
  _viewportY: number;
  _viewportWidth: number;
  _viewportHeight: number;
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

    // Slice 5c-B Batch 117 — when MRT mode is on, append the G-buffer
    // normal-roughness view as a 2nd color attachment. The MRT slot-1
    // attachment is shared between this initial open and the two
    // re-open sites (`_resumeScenePass` + `_clearDepthStencil`) via
    // `buildMrtSlot1Attachment`. loadOp="clear" here because this is
    // the FIRST open of the scene-FB pass per frame; the re-open
    // sites pass "load" to preserve accumulated G-buffer writes.
    // BUG-3 — SCENE2D infinite-scroll wrap accumulation. On the SECOND
    // viewport half (`config.sceneFbLoad`), open the scene-FB pass with
    // color loadOp="load" so the first half's draws (and the cleared
    // background everywhere else) survive. The first half / single render
    // keeps the default "clear". (loadOp=clear/load applies to the whole
    // attachment regardless of viewport, so the first half's clear still
    // covers the full FB; the per-half viewport below only confines DRAWS.)
    const sceneFbLoad = config.sceneFbLoad === true;
    if (sceneFbLoad && colorAttachments?.length) {
      colorAttachments = colorAttachments.map((a) => ({
        ...a,
        loadOp: "load" as GPULoadOp,
      }));
    }
    if (colorAttachments?.length) {
      const slot1 = buildMrtSlot1Attachment(
        config.scene,
        sceneFbLoad ? "load" : "clear",
      );
      if (slot1) {
        // Defensive: build a NEW array rather than mutating in place,
        // in case the producer returns a frozen one (was one of the
        // 6 suspect causes from the Batch 116 postmortem).
        colorAttachments = [...colorAttachments, slot1];
      }
    }
    if (colorAttachments?.length && context._currentCommandEncoder) {
      const passDesc: GPURenderPassDescriptor = {
        label: "Scene Framebuffer Render Pass",
        colorAttachments,
        depthStencilAttachment,
      };
      const passEncoder = context.beginRenderPass(passDesc);
      if (!passEncoder) {
        return;
      }
      // Use the per-frame cached viewport (= full canvas for normal renders;
      // = the per-half sub-rect during the SCENE2D wrap, BUG-3) so each wrap
      // half's draws are confined to its screen region. Clamp to a valid,
      // non-zero extent — a degenerate (0-width/height) viewport trips a
      // WebGPU validation error.
      const vx = host._viewportX || 0;
      const vy = host._viewportY || 0;
      const vw = host._viewportWidth > 0 ? host._viewportWidth : host._width;
      const vh = host._viewportHeight > 0 ? host._viewportHeight : host._height;
      passEncoder.setViewport(vx, vy, vw, vh, 0, 1);
      passEncoder.setScissorRect(vx, vy, vw, vh);
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
