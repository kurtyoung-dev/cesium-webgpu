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
 * @module WebGLStubFramebufferCopy
 */

/// <reference types="@webgpu/types" />

import type {
  LogUsageFn,
  StubFramebuffer,
  WebGLStubState,
} from "./WebGLStubTypes.js";
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

/**
 * The texture a copy reads: the read framebuffer's color attachment, or the
 * canvas when the default framebuffer is bound. The canvas texture exists only
 * inside a frame, so outside one the default framebuffer has nothing to read.
 */
function readSourceTexture(
  state: WebGLStubState,
  inFrame: boolean,
): GPUTexture | null {
  const framebuffer: StubFramebuffer | null =
    state.boundReadFramebuffer ?? state.boundFramebuffer ?? null;
  if (framebuffer) {
    // `framebufferTexture2D` records the attachment as `_colorAttachment`;
    // `colorAttachment` is the alias the type declares for other writers.
    const attachment =
      framebuffer._colorAttachment ?? framebuffer.colorAttachment ?? null;
    return attachment?._texture ?? null;
  }
  return inFrame ? (state.context?.getCurrentTexture() ?? null) : null;
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
 * @param level The destination mip level the caller named.
 * @param region The texels to copy.
 */
export function copyFramebufferToBoundTexture(
  state: WebGLStubState,
  frameEncodedBaseCopies: WeakMap<GPUTexture, GPUCommandEncoder>,
  logUsage: LogUsageFn,
  entryPoint: FramebufferCopyEntryPoint,
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
  const frameEncoder = state.currentCommandEncoder;
  const source = readSourceTexture(state, frameEncoder !== null);
  if (!source) {
    //>>includeStart('debug', pragmas.debug);
    recordStubTextureTrace(`${entryPoint}.noSource`, {
      inFrame: frameEncoder !== null,
      hasReadFramebuffer: !!(
        state.boundReadFramebuffer ?? state.boundFramebuffer
      ),
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
