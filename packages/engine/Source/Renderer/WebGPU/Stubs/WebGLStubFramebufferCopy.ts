/**
 * `copyTexImage2D` / `copyTexSubImage2D` for the WebGL compatibility stub: a
 * region of the read framebuffer's color attachment copied into the texture
 * bound to the active unit.
 *
 * There are two ways in. Inside a frame the copy is recorded in the frame's
 * command encoder, after whatever the frame has already encoded, because a
 * WebGL copy may read pixels rendered earlier in the same frame. Outside a
 * frame there is no encoder: a scene's after-render callbacks run after
 * `endFrame` has submitted and dropped it, and that is where a `TextureAtlas`
 * grows and copies its existing images into the larger texture. Such a copy
 * is recorded in an encoder of its own and submitted before this returns.
 * Submitting at once keeps WebGL's order for whatever the caller does next: a
 * later queue upload runs after the copy, and destroying the source texture
 * straight afterwards is legal because WebGPU defers the destruction until
 * the submitted copy has completed.
 *
 * The copy reads the `READ_FRAMEBUFFER` binding as WebGL does: a bound
 * framebuffer's color attachment 0, or the default framebuffer (the canvas,
 * which exists only inside a frame) when the binding is null. It writes level
 * 0 of a 2D texture only. The context's copy carries no mip level and no array
 * layer, so a destination level other than 0, a cube map face, or a source
 * attached at a face or a higher level would land on level 0, layer 0; each is
 * refused by name instead, and nothing is recorded.
 *
 * @module WebGLStubFramebufferCopy
 */

/// <reference types="@webgpu/types" />

import type {
  LogUsageFn,
  StubFramebuffer,
  WebGLStubState,
} from "./WebGLStubTypes.js";
import {
  GL_TEXTURE_2D,
  attachmentTexture,
  colorAttachmentIsBaseLevel2D,
  colorAttachmentOf,
  describeCopyRefusal,
  readFramebufferOf,
} from "./WebGLStubFramebufferRead.js";
import {
  describeTraceTexture,
  recordStubTextureTrace,
} from "./WebGLStubTextureTrace.js";

/** The WebGL entry point a copy came through, for usage diagnostics. */
export type FramebufferCopyEntryPoint = "copyTexImage2D" | "copyTexSubImage2D";

/** One framebuffer-to-texture copy, in texels. */
export interface FramebufferCopyRegion {
  /** Read-framebuffer column of the region's first texel. */
  readonly x: number;
  /** Read-framebuffer row of the region's first texel. */
  readonly y: number;
  /** Destination column the region lands on. */
  readonly destinationX: number;
  /** Destination row the region lands on. */
  readonly destinationY: number;
  readonly width: number;
  readonly height: number;
}

const NOT_COPY_COMPATIBLE =
  "source/destination usages or formats are not copy-compatible";

/** Why a copy was refused before the context was asked. */
type CopyAddressRefusal =
  "destinationLevel" | "destinationTarget" | "sourceTarget";

const ADDRESS_REFUSAL_REASONS: Readonly<Record<CopyAddressRefusal, string>> =
  Object.freeze({
    destinationLevel:
      "the destination mip level is not 0, and the copy can only write level 0",
    destinationTarget:
      "the destination is not TEXTURE_2D, and the copy cannot address a cube map face",
    sourceTarget:
      "the read framebuffer's color attachment is a cube map face or a level other than 0, which the copy cannot address",
  });

/**
 * The texture a copy reads: the read framebuffer's color attachment, or the
 * canvas when the default framebuffer is bound. The canvas texture exists only
 * inside a frame, so outside one the default framebuffer has nothing to read.
 * An attachment the copy cannot address as recorded is a refusal, not a
 * source.
 */
function readSourceTexture(
  state: WebGLStubState,
  inFrame: boolean,
): GPUTexture | "sourceTarget" | null {
  const framebuffer: StubFramebuffer | null = readFramebufferOf(state);
  if (framebuffer) {
    if (!colorAttachmentIsBaseLevel2D(framebuffer)) {
      return "sourceTarget";
    }
    return attachmentTexture(colorAttachmentOf(framebuffer));
  }
  return inFrame ? (state.context?.getCurrentTexture() ?? null) : null;
}

/** Refuse a copy by name: a receipt, and the usage diagnostic. */
function refuseAddress(
  logUsage: LogUsageFn,
  entryPoint: FramebufferCopyEntryPoint,
  reason: CopyAddressRefusal,
  detail: Record<string, unknown>,
): void {
  //>>includeStart('debug', pragmas.debug);
  recordStubTextureTrace(`${entryPoint}.refused.${reason}`, detail);
  //>>includeEnd('debug');
  logUsage(entryPoint, ADDRESS_REFUSAL_REASONS[reason]);
}

/**
 * Copy a region of the read framebuffer into the texture bound to the active
 * unit, inside the current frame's encoder when there is one and as an
 * immediately submitted copy of its own when there is not.
 *
 * @param state The live stub state.
 * @param frameEncodedBaseCopies Destination textures whose level-0 copy is
 *   recorded in a frame encoder, so a following `generateMipmap` can append
 *   its passes to that same encoder.
 * @param logUsage Usage diagnostic sink.
 * @param entryPoint The WebGL entry point being served.
 * @param target The destination texture target the caller named.
 * @param level The destination mip level the caller named.
 * @param region The texels to copy.
 */
export function copyFramebufferToBoundTexture(
  state: WebGLStubState,
  frameEncodedBaseCopies: WeakMap<GPUTexture, GPUCommandEncoder>,
  logUsage: LogUsageFn,
  entryPoint: FramebufferCopyEntryPoint,
  target: number,
  level: number,
  region: FramebufferCopyRegion,
): void {
  const binding = state.textureBindings.get(state.activeTextureUnit);
  const destination = binding?.texture?._webgpuTexture?.texture;
  const device = state.device;
  //>>includeStart('debug', pragmas.debug);
  recordStubTextureTrace(`${entryPoint}.enter`, {
    level,
    region: { ...region },
    inFrame: state.currentCommandEncoder !== null,
    hasDestination: !!destination,
    hasDevice: !!device,
  });
  //>>includeEnd('debug');
  if (!destination || !device) {
    //>>includeStart('debug', pragmas.debug);
    recordStubTextureTrace(`${entryPoint}.noDestinationOrDevice`);
    //>>includeEnd('debug');
    return;
  }
  if (level !== 0) {
    refuseAddress(logUsage, entryPoint, "destinationLevel", { level });
    return;
  }
  if (target !== GL_TEXTURE_2D) {
    refuseAddress(logUsage, entryPoint, "destinationTarget", {
      target: String(target),
    });
    return;
  }
  const frameEncoder = state.currentCommandEncoder;
  const source = readSourceTexture(state, frameEncoder !== null);
  if (source === "sourceTarget") {
    const framebuffer = readFramebufferOf(state);
    refuseAddress(logUsage, entryPoint, "sourceTarget", {
      textarget: String(framebuffer?._colorAttachmentTarget),
      level: framebuffer?._colorAttachmentLevel ?? null,
    });
    return;
  }
  if (!source) {
    //>>includeStart('debug', pragmas.debug);
    recordStubTextureTrace(`${entryPoint}.noSource`, {
      inFrame: frameEncoder !== null,
      hasReadFramebuffer: !!readFramebufferOf(state),
    });
    //>>includeEnd('debug');
    logUsage(
      entryPoint,
      frameEncoder
        ? "the read framebuffer has no color attachment"
        : "outside a frame only a framebuffer color attachment can be read",
    );
    return;
  }
  const { x, y, destinationX, destinationY, width, height } = region;

  if (frameEncoder) {
    const copied = state.copyTextureRegion(
      source,
      destination,
      x,
      y,
      destinationX,
      destinationY,
      width,
      height,
    );
    //>>includeStart('debug', pragmas.debug);
    recordStubTextureTrace(
      `${entryPoint}.inFrame.${copied ? "recorded" : "refused"}`,
      {
        source: describeTraceTexture(source),
        destination: describeTraceTexture(destination),
      },
    );
    if (!copied) {
      recordStubTextureTrace(
        `${entryPoint}.refused.${describeCopyRefusal(state, source, destination, region, false)}`,
        { readsDefaultFramebuffer: readFramebufferOf(state) === null },
      );
    }
    //>>includeEnd('debug');
    if (copied && level === 0) {
      frameEncodedBaseCopies.set(destination, frameEncoder);
    } else if (!copied) {
      logUsage(entryPoint, NOT_COPY_COMPATIBLE);
    }
    return;
  }

  const encoder = device.createCommandEncoder({
    label: "GLStub_OffFrameTextureCopy",
  });
  const copied = state.copyTextureRegion(
    source,
    destination,
    x,
    y,
    destinationX,
    destinationY,
    width,
    height,
    encoder,
  );
  //>>includeStart('debug', pragmas.debug);
  recordStubTextureTrace(
    `${entryPoint}.offFrame.${copied ? "submitted" : "refused"}`,
    {
      source: describeTraceTexture(source),
      destination: describeTraceTexture(destination),
    },
  );
  if (!copied) {
    recordStubTextureTrace(
      `${entryPoint}.refused.${describeCopyRefusal(state, source, destination, region, true)}`,
    );
  }
  //>>includeEnd('debug');
  if (!copied) {
    // Nothing was recorded; the unfinished encoder is simply dropped.
    logUsage(entryPoint, NOT_COPY_COMPATIBLE);
    return;
  }
  device.queue.submit([encoder.finish()]);
  // The copy is already on the queue, so a later generateMipmap for this
  // texture belongs on the preparation path, not on a frame encoder it was
  // once copied in.
  frameEncodedBaseCopies.delete(destination);
}
