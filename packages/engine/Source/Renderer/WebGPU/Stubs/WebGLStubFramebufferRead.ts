/**
 * What the WebGL compatibility stub's framebuffer readers share: which
 * framebuffer a read or a draw uses, the GPU texture behind an attachment,
 * whether an attachment is the base level of a 2D texture, and the name of
 * the reason a texture copy was refused.
 *
 * The readers are the framebuffer-to-texture copy, the blit and the async
 * pixel read. Each follows WebGL's bindings: a read uses the
 * `READ_FRAMEBUFFER` binding and a blit draws into the `DRAW_FRAMEBUFFER`
 * binding, and a null binding is the default framebuffer, never an earlier
 * binding left in another slot.
 *
 * @module WebGLStubFramebufferRead
 */

/// <reference types="@webgpu/types" />

import type {
  StubAttachment,
  StubFramebuffer,
  WebGLStubState,
} from "./WebGLStubTypes.js";

/** WebGL's `TEXTURE_2D`, the only copy target and attachment target a copy honours. */
export const GL_TEXTURE_2D = 0x0de1;

/**
 * The framebuffer bound for reading. A state that does not keep the split
 * read binding (a host shaped for WebGL1) reads the single binding instead.
 *
 * @param state The live stub state.
 * @returns The read framebuffer, or null for the default framebuffer.
 */
export function readFramebufferOf(
  state: WebGLStubState,
): StubFramebuffer | null {
  return state.boundReadFramebuffer === undefined
    ? (state.boundFramebuffer ?? null)
    : state.boundReadFramebuffer;
}

/**
 * The framebuffer bound for drawing, with the same fallback as
 * {@link readFramebufferOf}.
 *
 * @param state The live stub state.
 * @returns The draw framebuffer, or null for the default framebuffer.
 */
export function drawFramebufferOf(
  state: WebGLStubState,
): StubFramebuffer | null {
  return state.boundDrawFramebuffer === undefined
    ? (state.boundFramebuffer ?? null)
    : state.boundDrawFramebuffer;
}

/**
 * A framebuffer's color attachment 0, as `framebufferTexture2D` or
 * `framebufferRenderbuffer` recorded it.
 *
 * @param framebuffer The framebuffer.
 * @returns The attachment, or null.
 */
export function colorAttachmentOf(
  framebuffer: StubFramebuffer,
): StubAttachment {
  // `colorAttachment` is the alias the type declares for other writers.
  return framebuffer._colorAttachment ?? framebuffer.colorAttachment ?? null;
}

/**
 * The GPU texture behind an attachment: a texture wrapper's current native
 * texture, or a renderbuffer's storage.
 *
 * @param attachment The attachment.
 * @returns The GPU texture, or null when none is allocated.
 */
export function attachmentTexture(
  attachment: StubAttachment,
): GPUTexture | null {
  if (!attachment) {
    return null;
  }
  const wrapped = (attachment as { _webgpuTexture?: { texture: GPUTexture } })
    ._webgpuTexture?.texture;
  return (
    wrapped ?? (attachment as { _texture?: GPUTexture | null })._texture ?? null
  );
}

/**
 * Whether a framebuffer's color attachment 0 is level 0 of a 2D texture (or a
 * renderbuffer), the only source a copy can read without a mip level or an
 * array layer. A cube map face or a higher level is not: the copy would read
 * level 0, layer 0 instead.
 *
 * @param framebuffer The framebuffer.
 * @returns Whether the attachment can be read as recorded.
 */
export function colorAttachmentIsBaseLevel2D(
  framebuffer: StubFramebuffer,
): boolean {
  const target = framebuffer._colorAttachmentTarget;
  const level = framebuffer._colorAttachmentLevel;
  return (
    (target === undefined || target === null || target === GL_TEXTURE_2D) &&
    (level === undefined || level === 0)
  );
}

/** Why a context-validated texture copy was refused. */
export type CopyRefusalReason =
  | "openRenderPass"
  | "sameTexture"
  | "sourceUsage"
  | "destinationUsage"
  | "formatMismatch"
  | "sampleCount"
  | "outOfBounds"
  | "contextRefused";

/** Formats a copy may convert between: each one's sRGB twin. */
const SRGB_TWINS: Readonly<Record<string, string>> = Object.freeze({
  rgba8unorm: "rgba8unorm-srgb",
  "rgba8unorm-srgb": "rgba8unorm",
  bgra8unorm: "bgra8unorm-srgb",
  "bgra8unorm-srgb": "bgra8unorm",
});

/**
 * Name the first rule a refused copy breaks, for a receipt. It reads the same
 * fields the context's copy validates, after the context refused, so it never
 * decides whether a copy happens.
 *
 * @param state The live stub state.
 * @param source The copy's source texture.
 * @param destination The copy's destination texture.
 * @param region The copy's origins and size.
 * @param callerEncoder Whether the copy was offered a caller-owned encoder.
 * @returns The reason.
 */
export function describeCopyRefusal(
  state: WebGLStubState,
  source: GPUTexture,
  destination: GPUTexture,
  region: {
    readonly x: number;
    readonly y: number;
    readonly destinationX: number;
    readonly destinationY: number;
    readonly width: number;
    readonly height: number;
  },
  callerEncoder: boolean,
): CopyRefusalReason {
  if (!callerEncoder && state.currentRenderPassEncoder) {
    return "openRenderPass";
  }
  if (source === destination) {
    return "sameTexture";
  }
  if ((source.usage & GPUTextureUsage.COPY_SRC) === 0) {
    return "sourceUsage";
  }
  if ((destination.usage & GPUTextureUsage.COPY_DST) === 0) {
    return "destinationUsage";
  }
  if (
    source.format !== destination.format &&
    SRGB_TWINS[source.format] !== destination.format
  ) {
    return "formatMismatch";
  }
  if (source.sampleCount !== 1 || destination.sampleCount !== 1) {
    return "sampleCount";
  }
  if (
    region.x + region.width > source.width ||
    region.y + region.height > source.height ||
    region.destinationX + region.width > destination.width ||
    region.destinationY + region.height > destination.height
  ) {
    return "outOfBounds";
  }
  return "contextRefused";
}
