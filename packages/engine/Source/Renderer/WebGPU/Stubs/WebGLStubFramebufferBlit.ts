/**
 * `blitFramebuffer` and the source of `readPixelsAsync` for the WebGL
 * compatibility stub.
 *
 * A blit copies color attachment 0 of the `READ_FRAMEBUFFER` binding into
 * color attachment 0 of the `DRAW_FRAMEBUFFER` binding, inside the current
 * frame's encoder and through the context's validated copy, so a copy WebGPU
 * would reject is never recorded. A texture copy can only be a blit WebGL
 * would do without filtering or resolving: the same size, unflipped, between
 * two different single-sample textures of compatible formats. Everything else
 * is refused by name and records nothing, among them a multisample resolve,
 * which needs a resolve pass rather than a copy. The depth and stencil bits
 * of the mask are never honoured, and each one present is refused by name
 * whether or not the color part records.
 *
 * `readPixelsAsync` reads color attachment 0 of the `READ_FRAMEBUFFER`
 * binding. The default framebuffer, an attachment that is a cube map face or
 * a level other than 0, a renderbuffer without copy usage and a multisample
 * attachment are refused by name.
 *
 * @module WebGLStubFramebufferBlit
 */

/// <reference types="@webgpu/types" />

import type { LogUsageFn, WebGLStubState } from "./WebGLStubTypes.js";
import {
  attachmentTexture,
  colorAttachmentIsBaseLevel2D,
  colorAttachmentOf,
  describeCopyRefusal,
  drawFramebufferOf,
  readFramebufferOf,
} from "./WebGLStubFramebufferRead.js";
import { recordStubTextureTrace } from "./WebGLStubTextureTrace.js";

const GL_COLOR_BUFFER_BIT = 0x4000;
const GL_DEPTH_BUFFER_BIT = 0x0100;
const GL_STENCIL_BUFFER_BIT = 0x0400;

/** A blit's source and destination rectangles, as WebGL passes them. */
export interface BlitRectangles {
  readonly srcX0: number;
  readonly srcY0: number;
  readonly srcX1: number;
  readonly srcY1: number;
  readonly dstX0: number;
  readonly dstY0: number;
  readonly dstX1: number;
  readonly dstY1: number;
}

/** Why a blit's color copy was refused. */
type BlitRefusal =
  | "openRenderPass"
  | "defaultFramebuffer"
  | "noColorAttachment"
  | "sourceTarget"
  | "destinationTarget"
  | "noTexture"
  | "sameTexture"
  | "sampleCount"
  | "flipped"
  | "scaled";

const BLIT_REFUSAL_REASONS: Readonly<Record<BlitRefusal, string>> =
  Object.freeze({
    openRenderPass:
      "called while a render pass is open; an encoder-level copy cannot be recorded inside a pass",
    defaultFramebuffer:
      "the read or draw binding is the default framebuffer, which a texture copy cannot read or write",
    noColorAttachment: "the read or draw framebuffer has no color attachment 0",
    sourceTarget:
      "the read framebuffer's color attachment is a cube map face or a level other than 0",
    destinationTarget:
      "the draw framebuffer's color attachment is a cube map face or a level other than 0",
    noTexture: "a color attachment has no GPU texture allocated",
    sameTexture:
      "the read and draw color attachments are the same texture; a copy cannot read and write one texture",
    sampleCount:
      "the attachments are not both single-sample; a multisample resolve needs a resolve pass, not a copy",
    flipped: "the rectangles are flipped, which a texture copy cannot do",
    scaled: "the rectangles differ in size, which a texture copy cannot scale",
  });

/** Refuse a blit by name: a receipt, and the usage diagnostic. */
function refuseBlit(
  logUsage: LogUsageFn,
  reason: BlitRefusal | "depthMask" | "stencilMask",
  message: string,
): void {
  //>>includeStart('debug', pragmas.debug);
  recordStubTextureTrace(`blitFramebuffer.refused.${reason}`);
  //>>includeEnd('debug');
  logUsage("blitFramebuffer", message);
}

/**
 * Serve `gl.blitFramebuffer`.
 *
 * @param state The live stub state.
 * @param logUsage Usage diagnostic sink.
 * @param rectangles The source and destination rectangles.
 * @param mask The buffers to copy (`COLOR_BUFFER_BIT` and the rest).
 */
export function blitFramebufferThroughContext(
  state: WebGLStubState,
  logUsage: LogUsageFn,
  rectangles: BlitRectangles,
  mask: number,
): void {
  //>>includeStart('debug', pragmas.debug);
  recordStubTextureTrace("blitFramebuffer.enter", {
    mask: String(mask),
    inFrame: state.currentCommandEncoder !== null,
  });
  //>>includeEnd('debug');
  if ((mask & GL_DEPTH_BUFFER_BIT) !== 0) {
    refuseBlit(
      logUsage,
      "depthMask",
      "DEPTH_BUFFER_BIT is not copied; WebGPU has no general depth copy between attachments",
    );
  }
  if ((mask & GL_STENCIL_BUFFER_BIT) !== 0) {
    refuseBlit(
      logUsage,
      "stencilMask",
      "STENCIL_BUFFER_BIT is not copied; WebGPU has no general stencil copy between attachments",
    );
  }
  if ((mask & GL_COLOR_BUFFER_BIT) === 0) {
    return;
  }
  if (!state.device || !state.currentCommandEncoder) {
    //>>includeStart('debug', pragmas.debug);
    recordStubTextureTrace("blitFramebuffer.noEncoder");
    //>>includeEnd('debug');
    return;
  }
  const refuse = (reason: BlitRefusal) =>
    refuseBlit(logUsage, reason, BLIT_REFUSAL_REASONS[reason]);
  if (state.currentRenderPassEncoder) {
    refuse("openRenderPass");
    return;
  }
  const readFramebuffer = readFramebufferOf(state);
  const drawFramebuffer = drawFramebufferOf(state);
  if (!readFramebuffer || !drawFramebuffer) {
    refuse("defaultFramebuffer");
    return;
  }
  const readAttachment = colorAttachmentOf(readFramebuffer);
  const drawAttachment = colorAttachmentOf(drawFramebuffer);
  if (!readAttachment || !drawAttachment) {
    refuse("noColorAttachment");
    return;
  }
  if (!colorAttachmentIsBaseLevel2D(readFramebuffer)) {
    refuse("sourceTarget");
    return;
  }
  if (!colorAttachmentIsBaseLevel2D(drawFramebuffer)) {
    refuse("destinationTarget");
    return;
  }
  const source = attachmentTexture(readAttachment);
  const destination = attachmentTexture(drawAttachment);
  if (!source || !destination) {
    refuse("noTexture");
    return;
  }
  if (source === destination) {
    refuse("sameTexture");
    return;
  }
  if (source.sampleCount !== 1 || destination.sampleCount !== 1) {
    refuse("sampleCount");
    return;
  }
  const { srcX0, srcY0, srcX1, srcY1, dstX0, dstY0, dstX1, dstY1 } = rectangles;
  if (srcX0 > srcX1 || srcY0 > srcY1 || dstX0 > dstX1 || dstY0 > dstY1) {
    refuse("flipped");
    return;
  }
  const width = srcX1 - srcX0;
  const height = srcY1 - srcY0;
  if (width !== dstX1 - dstX0 || height !== dstY1 - dstY0) {
    refuse("scaled");
    return;
  }
  if (width === 0 || height === 0) {
    //>>includeStart('debug', pragmas.debug);
    recordStubTextureTrace("blitFramebuffer.empty");
    //>>includeEnd('debug');
    return;
  }
  const copied = state.copyTextureRegion(
    source,
    destination,
    srcX0,
    srcY0,
    dstX0,
    dstY0,
    width,
    height,
  );
  //>>includeStart('debug', pragmas.debug);
  recordStubTextureTrace(
    copied
      ? "blitFramebuffer.recorded"
      : `blitFramebuffer.refused.${describeCopyRefusal(
          state,
          source,
          destination,
          {
            x: srcX0,
            y: srcY0,
            destinationX: dstX0,
            destinationY: dstY0,
            width,
            height,
          },
          false,
        )}`,
    { width, height },
  );
  //>>includeEnd('debug');
  if (!copied) {
    logUsage(
      "blitFramebuffer",
      "source/destination usages or formats are not copy-compatible",
    );
  }
}

/**
 * The texture `readPixelsAsync` reads, or null after refusing by name.
 *
 * @param state The live stub state.
 * @param logUsage Usage diagnostic sink.
 * @returns The read framebuffer's color attachment texture, or null.
 */
export function readPixelsSourceTexture(
  state: WebGLStubState,
  logUsage: LogUsageFn,
): GPUTexture | null {
  const refuse = (reason: string, message: string): null => {
    //>>includeStart('debug', pragmas.debug);
    recordStubTextureTrace(`readPixelsAsync.refused.${reason}`);
    //>>includeEnd('debug');
    logUsage("readPixelsAsync", message);
    return null;
  };
  const framebuffer = readFramebufferOf(state);
  if (!framebuffer) {
    return refuse(
      "defaultFramebuffer",
      "the read binding is the default framebuffer, which is not read back",
    );
  }
  const attachment = colorAttachmentOf(framebuffer);
  if (!attachment) {
    return refuse(
      "noColorAttachment",
      "the read framebuffer has no color attachment 0",
    );
  }
  if (!colorAttachmentIsBaseLevel2D(framebuffer)) {
    return refuse(
      "sourceTarget",
      "the read framebuffer's color attachment is a cube map face or a level other than 0",
    );
  }
  const texture = attachmentTexture(attachment);
  if (!texture) {
    return refuse("noTexture", "the color attachment has no GPU texture");
  }
  if ((texture.usage & GPUTextureUsage.COPY_SRC) === 0) {
    return refuse(
      "sourceUsage",
      "the color attachment cannot be copied from (a renderbuffer has no copy usage)",
    );
  }
  if (texture.sampleCount !== 1) {
    return refuse(
      "sampleCount",
      "the color attachment is multisample and cannot be read back",
    );
  }
  return texture;
}
