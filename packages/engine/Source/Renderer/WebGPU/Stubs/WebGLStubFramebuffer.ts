/**
 * WebGL framebuffer and renderbuffer method stubs for the WebGPU
 * compatibility layer. Maps framebuffer/renderbuffer lifecycle operations
 * to WebGPU texture creation and state tracking.
 *
 * The bindings and attachments follow WebGL. `FRAMEBUFFER` binds read and
 * draw, `READ_FRAMEBUFFER` and `DRAW_FRAMEBUFFER` one each, and null is the
 * default framebuffer. An attachment is recorded on the framebuffer its
 * target names, color attachment 0 with the texture target and level it was
 * attached at. Deleting a framebuffer never destroys what is attached to it:
 * the attachments belong to their `Texture`, `Renderbuffer` or cube map,
 * and `Framebuffer.js` destroys them itself when it owns them.
 *
 * @see WebGLCompatibilityStub (nexus)
 * @module WebGLStubFramebuffer
 */

/// <reference types="@webgpu/types" />

import createGuid from "../../../Core/createGuid.js";
import type {
  WebGLStubState,
  LogUsageFn,
  StubFramebuffer,
  StubRenderbuffer,
  StubAttachment,
  StubTextureWrapper,
} from "./WebGLStubTypes.js";
import { recordStubTextureTrace } from "./WebGLStubTextureTrace.js";

// WebGL framebuffer target, attachment and status constants
const GL_FRAMEBUFFER = 0x8d40;
const GL_READ_FRAMEBUFFER = 0x8ca8;
const GL_DRAW_FRAMEBUFFER = 0x8ca9;
const GL_RENDERBUFFER = 0x8d41;
const GL_COLOR_ATTACHMENT0 = 0x8ce0;
const GL_DEPTH_ATTACHMENT = 0x8d00;
const GL_STENCIL_ATTACHMENT = 0x8d20;
const GL_DEPTH_STENCIL_ATTACHMENT = 0x821a;
const GL_FRAMEBUFFER_COMPLETE = 0x8cd5;

/** WebGL2's highest color attachment index is 15 (`COLOR_ATTACHMENT15`). */
const GL_COLOR_ATTACHMENT_COUNT = 16;

/**
 * WebGL framebuffer constants, read by `Framebuffer.js`,
 * `MultisampleFramebuffer.js` and `Renderbuffer.js` from the context's `_gl`.
 * `NEAREST` is the blit filter `MultisampleFramebuffer.js` passes.
 */
export const FRAMEBUFFER_CONSTANTS = Object.freeze({
  FRAMEBUFFER: GL_FRAMEBUFFER,
  READ_FRAMEBUFFER: GL_READ_FRAMEBUFFER,
  DRAW_FRAMEBUFFER: GL_DRAW_FRAMEBUFFER,
  RENDERBUFFER: GL_RENDERBUFFER,
  COLOR_ATTACHMENT0: GL_COLOR_ATTACHMENT0,
  DEPTH_ATTACHMENT: GL_DEPTH_ATTACHMENT,
  STENCIL_ATTACHMENT: GL_STENCIL_ATTACHMENT,
  DEPTH_STENCIL_ATTACHMENT: GL_DEPTH_STENCIL_ATTACHMENT,
  FRAMEBUFFER_COMPLETE: GL_FRAMEBUFFER_COMPLETE,
  NEAREST: 0x2600,
});

/** Where an attachment enum attaches. */
type AttachmentPoint =
  | "colour"
  | "colourMrt"
  | "depth"
  | "depthStencil"
  | "stencil"
  | "unrecognised";

/**
 * Classify an attachment enum. Color attachment 0 is the only color
 * attachment a reader uses; a higher one (multiple render targets) never
 * replaces it.
 */
function attachmentPoint(attachment: number): AttachmentPoint {
  const colorIndex = attachment - GL_COLOR_ATTACHMENT0;
  if (
    Number.isInteger(colorIndex) &&
    colorIndex >= 0 &&
    colorIndex < GL_COLOR_ATTACHMENT_COUNT
  ) {
    return colorIndex === 0 ? "colour" : "colourMrt";
  }
  if (attachment === GL_DEPTH_ATTACHMENT) {
    return "depth";
  }
  if (attachment === GL_DEPTH_STENCIL_ATTACHMENT) {
    return "depthStencil";
  }
  if (attachment === GL_STENCIL_ATTACHMENT) {
    return "stencil";
  }
  return "unrecognised";
}

/**
 * The framebuffer an attachment call targets: `READ_FRAMEBUFFER` names the
 * read binding, `FRAMEBUFFER` and `DRAW_FRAMEBUFFER` the draw binding. A
 * state that keeps only the single binding uses it.
 */
function attachTargetFramebuffer(
  state: WebGLStubState,
  target: number,
): StubFramebuffer | null {
  const slot =
    target === GL_READ_FRAMEBUFFER
      ? state.boundReadFramebuffer
      : state.boundDrawFramebuffer;
  return slot === undefined ? (state.boundFramebuffer ?? null) : slot;
}

// WebGL internal format constants for renderbuffer storage
const GL_DEPTH_COMPONENT16 = 0x81a5;
const GL_DEPTH_COMPONENT24 = 0x81a6;
const GL_DEPTH24_STENCIL8 = 0x88f0;

/**
 * Resolves a WebGL renderbuffer internal format to a GPUTextureFormat.
 */
function resolveRenderbufferFormat(internalformat: number): GPUTextureFormat {
  if (
    internalformat === GL_DEPTH_COMPONENT16 ||
    internalformat === GL_DEPTH_COMPONENT24
  ) {
    return "depth24plus";
  }
  if (internalformat === GL_DEPTH24_STENCIL8) {
    return "depth24plus-stencil8";
  }
  return "rgba8unorm";
}

/**
 * Creates framebuffer and renderbuffer stub methods.
 *
 * @param state - Shared mutable state from WebGPUContext
 * @param logUsage - Debug logging function for calls the stub refuses
 * @returns Object containing all framebuffer/renderbuffer stub methods
 */
export function createFramebufferStubs(
  state: WebGLStubState,
  logUsage: LogUsageFn,
) {
  return {
    // ==== Framebuffer methods ====

    createFramebuffer: (): StubFramebuffer => {
      const fboId = createGuid();
      const fbo: StubFramebuffer = {
        _id: fboId,
        _colorAttachment: null,
        _depthAttachment: null,
        _isWebGPU: true,
      };
      state.framebuffers.set(fbo, {
        colorAttachment: null,
        depthAttachment: null,
      });
      return fbo;
    },

    bindFramebuffer: (target: number, framebuffer: StubFramebuffer | null) => {
      // WebGL2 targets:
      //   GL_FRAMEBUFFER      = 0x8D40 → sets BOTH read and draw
      //   GL_READ_FRAMEBUFFER = 0x8CA8 → read only (for blitFramebuffer src)
      //   GL_DRAW_FRAMEBUFFER = 0x8CA9 → draw only (for blitFramebuffer dst)
      // Pre-WebGL2 callers always pass GL_FRAMEBUFFER, so the legacy
      // `boundFramebuffer` field stays in sync with both specific slots.
      // Any other target is WebGL's INVALID_ENUM: no binding changes.
      if (target === GL_READ_FRAMEBUFFER) {
        state.boundReadFramebuffer = framebuffer;
      } else if (target === GL_DRAW_FRAMEBUFFER) {
        state.boundDrawFramebuffer = framebuffer;
      } else if (target === GL_FRAMEBUFFER) {
        state.boundFramebuffer = framebuffer;
        state.boundReadFramebuffer = framebuffer;
        state.boundDrawFramebuffer = framebuffer;
      } else {
        //>>includeStart('debug', pragmas.debug);
        recordStubTextureTrace("bindFramebuffer.refused.target", {
          target: String(target),
        });
        //>>includeEnd('debug');
        logUsage(
          "bindFramebuffer",
          `target ${String(target)} is not a framebuffer target; nothing was bound`,
        );
      }
    },

    deleteFramebuffer: (framebuffer: StubFramebuffer | null) => {
      if (!framebuffer) return;
      const fboData = state.framebuffers.get(framebuffer);
      //>>includeStart('debug', pragmas.debug);
      if (fboData && (fboData.colorAttachment || fboData.depthAttachment)) {
        recordStubTextureTrace("deleteFramebuffer.withAttachments", {
          color: !!fboData.colorAttachment,
          depth: !!fboData.depthAttachment,
        });
      }
      //>>includeEnd('debug');
      if (fboData) {
        // The attachments are not destroyed: as in WebGL, they belong to
        // their owners, which may outlive this framebuffer.
        state.framebuffers.delete(framebuffer);
      }
      // Deleting a bound framebuffer binds the default one, as in WebGL.
      if (state.boundFramebuffer === framebuffer) {
        state.boundFramebuffer = null;
      }
      if (state.boundReadFramebuffer === framebuffer) {
        state.boundReadFramebuffer = null;
      }
      if (state.boundDrawFramebuffer === framebuffer) {
        state.boundDrawFramebuffer = null;
      }
    },

    framebufferTexture2D: (
      target: number,
      attachment: number,
      textarget: number,
      texture: StubTextureWrapper | null,
      level: number,
    ) => {
      const point = attachmentPoint(attachment);
      const framebuffer = attachTargetFramebuffer(state, target);
      //>>includeStart('debug', pragmas.debug);
      recordStubTextureTrace(`framebufferTexture2D.${point}`, {
        attachment: String(attachment),
        textarget: String(textarget),
        level,
        bound: !!framebuffer,
      });
      //>>includeEnd('debug');
      if (point === "unrecognised") {
        logUsage(
          "framebufferTexture2D",
          `attachment ${String(attachment)} is not an attachment point; nothing was attached`,
        );
        return;
      }
      if (!framebuffer) {
        return;
      }
      const fboData = state.framebuffers.get(framebuffer);
      if (!fboData) {
        return;
      }
      if (point === "colour") {
        fboData.colorAttachment = texture;
        framebuffer._colorAttachment = texture;
        framebuffer._colorAttachmentTarget = textarget;
        framebuffer._colorAttachmentLevel = level;
      } else if (point === "depth" || point === "depthStencil") {
        fboData.depthAttachment = texture;
        framebuffer._depthAttachment = texture;
      }
    },

    framebufferRenderbuffer: (
      target: number,
      attachment: number,
      _renderbuffertarget: number,
      renderbuffer: StubRenderbuffer | null,
    ) => {
      const point = attachmentPoint(attachment);
      const framebuffer = attachTargetFramebuffer(state, target);
      //>>includeStart('debug', pragmas.debug);
      recordStubTextureTrace(`framebufferRenderbuffer.${point}`, {
        attachment: String(attachment),
        bound: !!framebuffer,
      });
      //>>includeEnd('debug');
      if (point === "unrecognised") {
        logUsage(
          "framebufferRenderbuffer",
          `attachment ${String(attachment)} is not an attachment point; nothing was attached`,
        );
        return;
      }
      if (!framebuffer) {
        return;
      }
      const fboData = state.framebuffers.get(framebuffer);
      if (!fboData || !renderbuffer) {
        return;
      }
      if (point === "colour") {
        fboData.colorAttachment = renderbuffer;
        framebuffer._colorAttachment = renderbuffer;
        framebuffer._colorAttachmentTarget = null;
        framebuffer._colorAttachmentLevel = 0;
      } else if (point === "depth" || point === "depthStencil") {
        fboData.depthAttachment = renderbuffer;
        framebuffer._depthAttachment = renderbuffer;
      }
    },

    checkFramebufferStatus: (_target: number) => GL_FRAMEBUFFER_COMPLETE,

    // ==== Renderbuffer methods ====

    createRenderbuffer: () => {
      if (!state.device) return {};
      return {
        _id: createGuid(),
        _texture: null as GPUTexture | null,
        _format: null as GPUTextureFormat | null,
        _width: 0,
        _height: 0,
        _isWebGPU: true,
      };
    },

    bindRenderbuffer: (
      _target: number,
      renderbuffer: StubRenderbuffer | null,
    ) => {
      state.boundRenderbuffer = renderbuffer;
    },

    deleteRenderbuffer: (renderbuffer: StubRenderbuffer | null) => {
      if (renderbuffer?._texture) renderbuffer._texture.destroy();
    },

    renderbufferStorage: (
      _target: number,
      internalformat: number,
      width: number,
      height: number,
    ) => {
      if (!state.boundRenderbuffer || !state.device) return;
      if (state.boundRenderbuffer._texture) {
        state.boundRenderbuffer._texture.destroy();
      }
      const gpuFormat = resolveRenderbufferFormat(internalformat);
      state.boundRenderbuffer._texture = state.device.createTexture({
        size: { width, height },
        format: gpuFormat,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
        label: "Renderbuffer Storage",
      });
      state.boundRenderbuffer._format = gpuFormat;
      state.boundRenderbuffer._width = width;
      state.boundRenderbuffer._height = height;
    },

    renderbufferStorageMultisample: (
      _target: number,
      samples: number,
      internalformat: number,
      width: number,
      height: number,
    ) => {
      if (!state.boundRenderbuffer || !state.device) return;
      if (state.boundRenderbuffer._texture) {
        state.boundRenderbuffer._texture.destroy();
      }
      const gpuFormat = resolveRenderbufferFormat(internalformat);
      state.boundRenderbuffer._texture = state.device.createTexture({
        size: { width, height },
        format: gpuFormat,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
        sampleCount: samples,
        label: `Renderbuffer Storage (${samples}x MSAA)`,
      });
      state.boundRenderbuffer._format = gpuFormat;
      state.boundRenderbuffer._width = width;
      state.boundRenderbuffer._height = height;
    },
  };
}
