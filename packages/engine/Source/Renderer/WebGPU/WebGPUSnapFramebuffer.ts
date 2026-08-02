/// <reference types="@webgpu/types" />
/**
 * WebGPU Snap Framebuffer — the RGBA32F target behind {@link Scene#snap}.
 *
 * UP144-SNAP-WEBGPU (Campaign 11 row C11-212). WebGPU twin of upstream's
 * `Scene/SnapFramebuffer.js`, which the v1.144 merge left WebGL-only: on WebGPU
 * `Scene.snap()` rendered an empty framebuffer and resolved `undefined` because
 * `SceneRenderer.executeCommand`'s alternate-renderer early-return precedes the
 * snap branch and `Scene.updateDerivedCommands` returns early for WebGPU
 * commands.
 *
 * ## Payload
 *
 * One RGBA32F pixel per fragment, written by `ModelPBRComplete.wgsl`'s
 * `fragmentSnapMain` (see {@link decodeSnapHits} for the reader):
 *
 * | Channel | Meaning                                                       |
 * | ------- | ------------------------------------------------------------- |
 * | R       | pick key — the uint32 repacked from the RGBA8 pick color, cast to f32 |
 * | G       | isEdge flag (0.0 surface / 1.0 edge)                          |
 * | B       | linear EYE-SPACE depth in meters (`-positionEC.z`)            |
 * | A       | unused (0.0)                                                  |
 *
 * Byte-for-byte the same layout upstream's `getSnapObjectsFromPixels` reads, so
 * `Snapping.selectBestHit` / `Snapping.snapHitToWorld` consume both backends'
 * hits without a branch.
 *
 * ## Two-phase render
 *
 * WebGL runs ONE snap pass: commands with a `snapId` render their snap-derived
 * shader, and snapless commands (globe, primitives, collections) render their
 * DEPTH-ONLY derived command so they still occlude. WebGPU cannot express that
 * in one pass: a pipeline's color-target formats are validated against the
 * render pass's attachments at draw time, so an RGBA8 pick pipeline dispatched
 * into an RGBA32F pass invalidates the entire command buffer (the FORK-34
 * failure mode) — and building a snap-format depth-only twin of every pick
 * producer in the fleet would be a fleet-wide rewrite.
 *
 * So this framebuffer publishes TWO color attachments over ONE shared depth
 * attachment, and `WebGPUSceneRendererPickPass` runs each frustum slice twice:
 *
 *   1. **Occluder phase** — color = `_occluderTexture` (the ordinary
 *      `pickPipelineFormat` target), depth = `_depthTexture` (cleared). The
 *      UNMODIFIED pick fleet renders here, exactly as during `scene.pick`.
 *      Its color output is discarded; what matters is the depth every pick
 *      producer writes. This IS upstream's depth-only fallback, realized with
 *      pipelines that already exist.
 *   2. **Payload phase** — color = `_snapTexture` (RGBA32F), depth =
 *      `_depthTexture` loaded, not cleared. Only commands carrying a snap
 *      variant draw, testing `less-equal` against the depth the occluder phase
 *      established. A model behind terrain therefore fails the depth test and
 *      never claims a snap hit.
 *
 * The extra full-viewport RGBA8 attachment is the price of that reuse. It is
 * allocated lazily with the rest of this object — `View.snapFramebuffer` stays
 * `undefined` until the first `Scene.snap()` call, so applications that never
 * snap pay nothing.
 *
 * ## Readback
 *
 * WebGPU has no synchronous texture readback, so `end()` follows the same
 * contract as `WebGPUPickFramebuffer.end()`: it arms an async copy for the
 * current query and returns the most recent COMPLETED readback for the same
 * logical region and attachment generation. A cold snap at a fresh location
 * returns `[]` and converges on a subsequent call at the same spot;
 * {@link WebGPUSnapFramebuffer#endAsync} always returns the current frame's
 * result.
 *
 * @private
 */

import BoundingRectangle from "../../Core/BoundingRectangle.js";
import { getWebGPUPickColorFormat } from "./WebGPUPickFramebuffer.js";
import {
  alignedSnapBytesPerRow,
  decodeSnapHits,
  SNAP_CHANNELS,
  SNAP_PAYLOAD_FORMAT,
  unpackSnapPixels,
  type SnapReadbackRegion,
  type WebGPUSnapHit,
} from "./WebGPUSnapPayload.js";

export class WebGPUSnapFramebuffer {
  private _context: CesiumGraphicsContext;
  private _device: GPUDevice | null = null;
  private _isDestroyed: boolean = false;

  // Attachments. `_occluderTexture` receives the ordinary pick fleet's color
  // output during the occluder phase and is never read back; `_snapTexture` is
  // the RGBA32F payload the readback decodes; `_depthTexture` is shared by both
  // phases and is what carries occlusion from phase 1 into phase 2.
  private _occluderTexture: GPUTexture | null = null;
  private _snapTexture: GPUTexture | null = null;
  private _depthTexture: GPUTexture | null = null;
  private _occluderView: GPUTextureView | null = null;
  private _snapView: GPUTextureView | null = null;
  private _depthView: GPUTextureView | null = null;
  private _occluderFormat: GPUTextureFormat = "rgba8unorm";
  private _width: number = 0;
  private _height: number = 0;

  // Device-generation lifecycle, mirroring WebGPUPickFramebuffer: a device
  // change invalidates every GPU object and every cached readback, and the
  // generation counter is what lets an in-flight `mapAsync` recognize that its
  // bytes belong to a destroyed attachment.
  private _attachmentDevice: GPUDevice | null = null;
  private _attachmentGeneration: number = 0;

  private _passState: CesiumPassState;

  // Logical query geometry (top-down attachment coordinates).
  private _snapOriginX: number = 0;
  private _snapOriginTopY: number = 0;
  private _snapWidth: number = 1;
  private _snapHeight: number = 1;
  private _copyOriginX: number = 0;
  private _copyOriginTopY: number = 0;
  private _copyWidth: number = 1;
  private _copyHeight: number = 1;
  private _copyOffsetX: number = 0;
  private _copyOffsetY: number = 0;

  // Synchronous-readback cache (see the class docstring's Readback section).
  private _lastReadPixels: Float32Array | null = null;
  private _lastReadRegion: SnapReadbackRegion | null = null;
  private _readbackInFlight: boolean = false;
  private _nextReadbackSequence: number = 0;
  private _lastPublishedReadbackSequence: number = -1;
  private _stagingBuffer: GPUBuffer | null = null;
  private _stagingBufferSize: number = 0;
  private _stagingBufferDevice: GPUDevice | null = null;
  private _coldSnapWarned: boolean = false;

  constructor(context: CesiumGraphicsContext) {
    this._context = context;
    this._device = context._device ?? null;

    // Latch the context so the model feature renderer materializes snap
    // commands from now on. Snapping is opt-in: this object is constructed
    // lazily on the first `Scene.snap()` call, BEFORE `pickBegin` runs the
    // scene update that rebuilds model commands, so the very first snap frame
    // already carries them.
    const snapContext = this._context as CesiumGraphicsContext & {
      _snapEnabled?: boolean;
    };
    snapContext._snapEnabled = true;

    this._passState = {
      context: context,
      framebuffer: undefined,
      blendingEnabled: false,
      scissorTest: {
        enabled: true,
        rectangle: new BoundingRectangle(),
      },
      viewport: new BoundingRectangle(),
    };
  }

  /**
   * Begin a snapping pass: allocate/resize the attachments and publish them on
   * the pass state so `WebGPUSceneRendererPickPass` can find them.
   *
   * Signature-compatible with `SnapFramebuffer.begin` and
   * `WebGPUPickFramebuffer.begin` — `Picking.pickBegin` calls all three
   * interchangeably.
   */
  begin(
    screenSpaceRectangle: CesiumBoundingRectangle,
    viewport: CesiumBoundingRectangle,
  ): CesiumPassState {
    // Start the off-screen mini-frame before any command rebuild, for the same
    // reason WebGPUPickFramebuffer.begin does: feature renderers allocate
    // uniform-ring slices during the scene update that follows.
    const snapFrameContext = this._context as CesiumGraphicsContext & {
      beginPickFrame?: () => void;
    };
    snapFrameContext.beginPickFrame?.();

    const device = this._context._device;
    if (!device) {
      return this._passState;
    }
    const deviceChanged = device !== this._attachmentDevice;
    this._device = device;

    const rawWidth = viewport?.width;
    const rawHeight = viewport?.height;
    const width =
      typeof rawWidth === "number" && rawWidth > 0 ? Math.floor(rawWidth) : 1;
    const height =
      typeof rawHeight === "number" && rawHeight > 0
        ? Math.floor(rawHeight)
        : 1;

    BoundingRectangle.clone(
      screenSpaceRectangle,
      this._passState.scissorTest.rectangle,
    );

    // Cesium supplies a GL-style bottom-origin y; WebGPU scissors and texture
    // copies are top-origin. Same conversion (and same deliberate refusal to
    // shift the logical origin at a canvas edge) as WebGPUPickFramebuffer.
    const snapWidth = Math.max(
      1,
      Math.min(width, Math.floor(screenSpaceRectangle.width ?? 1)),
    );
    const snapHeight = Math.max(
      1,
      Math.min(height, Math.floor(screenSpaceRectangle.height ?? 1)),
    );
    const glOriginX = Math.floor(screenSpaceRectangle.x ?? 0);
    const glOriginY = Math.floor(screenSpaceRectangle.y ?? 0);
    this._snapOriginX = glOriginX;
    this._snapOriginTopY = height - glOriginY - snapHeight;
    this._snapWidth = snapWidth;
    this._snapHeight = snapHeight;

    const copyRight = Math.max(
      0,
      Math.min(width, this._snapOriginX + snapWidth),
    );
    const copyBottom = Math.max(
      0,
      Math.min(height, this._snapOriginTopY + snapHeight),
    );
    this._copyOriginX = Math.max(0, Math.min(width, this._snapOriginX));
    this._copyOriginTopY = Math.max(0, Math.min(height, this._snapOriginTopY));
    this._copyWidth = Math.max(0, copyRight - this._copyOriginX);
    this._copyHeight = Math.max(0, copyBottom - this._copyOriginTopY);
    this._copyOffsetX = this._copyOriginX - this._snapOriginX;
    this._copyOffsetY = this._copyOriginTopY - this._snapOriginTopY;

    // The occluder attachment MUST match the pick pipelines' canonical target
    // format for the same reason the pick FBO's does (FORK-34).
    const occluderFormat = getWebGPUPickColorFormat(this._context);

    if (
      width !== this._width ||
      height !== this._height ||
      occluderFormat !== this._occluderFormat ||
      deviceChanged
    ) {
      this._destroyTextures();
      this._occluderFormat = occluderFormat;

      this._occluderTexture = device.createTexture({
        label: "Snap occluder color texture",
        size: [width, height],
        format: occluderFormat,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
      this._snapTexture = device.createTexture({
        label: "Snap payload texture",
        size: [width, height],
        format: SNAP_PAYLOAD_FORMAT,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      });
      this._depthTexture = device.createTexture({
        label: "Snap depth texture",
        size: [width, height],
        format: "depth24plus-stencil8",
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });

      this._occluderView = this._occluderTexture.createView();
      this._snapView = this._snapTexture.createView();
      this._depthView = this._depthTexture.createView();

      this._width = width;
      this._height = height;
      this._attachmentDevice = device;
      this._attachmentGeneration++;
    }

    // `_isWebGPUPickFBO` is set alongside `_isWebGPUSnapFBO` on purpose: the
    // occluder phase IS the ordinary pick pass, and every downstream consumer
    // that checks for a WebGPU pick FBO (the pass executor's guard, the
    // classification-depth negotiation) must accept this object. The snap
    // marker is what upgrades the pass executor to the two-phase schedule.
    this._passState.framebuffer = {
      _isWebGPUPickFBO: true,
      _isWebGPUSnapFBO: true,
      colorTexture: this._occluderTexture,
      depthTexture: this._depthTexture,
      colorView: this._occluderView ?? undefined,
      depthView: this._depthView ?? undefined,
      snapColorView: this._snapView ?? undefined,
      snapColorFormat: SNAP_PAYLOAD_FORMAT,
      width: this._width,
      height: this._height,
      pickScissor: {
        x: this._copyOriginX,
        y: this._copyOriginTopY,
        width: this._copyWidth,
        height: this._copyHeight,
      },
    } as CesiumOpaqueFramebuffer;

    this._passState.viewport.width = width;
    this._passState.viewport.height = height;

    return this._passState;
  }

  private _captureReadbackRegion(): SnapReadbackRegion {
    return {
      logicalOriginX: this._snapOriginX,
      logicalOriginTopY: this._snapOriginTopY,
      logicalWidth: this._snapWidth,
      logicalHeight: this._snapHeight,
      copyOriginX: this._copyOriginX,
      copyOriginTopY: this._copyOriginTopY,
      copyWidth: this._copyWidth,
      copyHeight: this._copyHeight,
      copyOffsetX: this._copyOffsetX,
      copyOffsetY: this._copyOffsetY,
      attachmentGeneration: this._attachmentGeneration,
    };
  }

  private _readbackRegionsEqual(
    left: SnapReadbackRegion | null,
    right: SnapReadbackRegion,
  ): boolean {
    return (
      left !== null &&
      left.logicalOriginX === right.logicalOriginX &&
      left.logicalOriginTopY === right.logicalOriginTopY &&
      left.logicalWidth === right.logicalWidth &&
      left.logicalHeight === right.logicalHeight &&
      left.copyOriginX === right.copyOriginX &&
      left.copyOriginTopY === right.copyOriginTopY &&
      left.copyWidth === right.copyWidth &&
      left.copyHeight === right.copyHeight &&
      left.copyOffsetX === right.copyOffsetX &&
      left.copyOffsetY === right.copyOffsetY &&
      left.attachmentGeneration === right.attachmentGeneration
    );
  }

  private _publishReadbackCache(
    pixels: Float32Array,
    region: SnapReadbackRegion,
    requestSequence: number,
    requestDevice: GPUDevice,
    snapTexture: GPUTexture,
  ): void {
    if (
      this._isDestroyed ||
      this._device !== requestDevice ||
      this._attachmentDevice !== requestDevice ||
      this._snapTexture !== snapTexture ||
      this._attachmentGeneration !== region.attachmentGeneration ||
      requestSequence < this._lastPublishedReadbackSequence
    ) {
      return;
    }
    this._lastReadPixels = pixels;
    this._lastReadRegion = region;
    this._lastPublishedReadbackSequence = requestSequence;
  }

  /**
   * End the snapping pass and return the decoded hits.
   *
   * Signature-compatible with `SnapFramebuffer.end`, but one-frame-stale — see
   * the Readback section of the class docstring. A cold snap returns `[]`.
   */
  end(screenSpaceRectangle: CesiumBoundingRectangle): WebGPUSnapHit[] {
    void screenSpaceRectangle;
    if (!this._device || !this._snapTexture) {
      return [];
    }

    const region = this._captureReadbackRegion();
    this._startReadback(region);

    if (
      this._lastReadPixels &&
      this._readbackRegionsEqual(this._lastReadRegion, region)
    ) {
      return decodeSnapHits(
        this._context,
        this._lastReadPixels,
        region.logicalWidth,
        region.logicalHeight,
      );
    }

    // Cold snap. Permanent, latched: an application developer whose first
    // `Scene.snap()` came back undefined needs to know this is the WebGPU
    // readback contract, not a missing feature.
    if (!this._coldSnapWarned) {
      this._coldSnapWarned = true;
      console.warn(
        "[CesiumJS:WebGPU] Scene.snap() returned no result on its first call " +
          "at this location because WebGPU reads the snap buffer " +
          "asynchronously (one-frame stale). Call snap() again at the same " +
          "window position — a continuous-hover snap converges after the " +
          "first frame.",
      );
    }
    return [];
  }

  /**
   * End the snapping pass and await the readback. Always reflects the frame
   * that was just rendered; this is the reliable path for one-off snaps and
   * the path the acceptance probes use.
   */
  async endAsync(
    screenSpaceRectangle: CesiumBoundingRectangle,
  ): Promise<WebGPUSnapHit[]> {
    void screenSpaceRectangle;
    const device = this._device;
    const snapTexture = this._snapTexture;
    if (!device || !snapTexture) {
      return [];
    }

    const region = this._captureReadbackRegion();
    const requestSequence = this._nextReadbackSequence++;

    // A query entirely outside the attachment still has a well-defined result:
    // every pixel is the clear key, which decodes to no hits.
    if (region.copyWidth === 0 || region.copyHeight === 0) {
      const pixels = new Float32Array(
        region.logicalWidth * region.logicalHeight * SNAP_CHANNELS,
      );
      this._publishReadbackCache(
        pixels,
        region,
        requestSequence,
        device,
        snapTexture,
      );
      return [];
    }

    const bytesPerRow = alignedSnapBytesPerRow(region.copyWidth);
    const bufferSize = bytesPerRow * region.copyHeight;
    let stagingBuffer: GPUBuffer | null = null;
    let mapped = false;
    try {
      stagingBuffer = device.createBuffer({
        label: "Snap async staging buffer",
        size: bufferSize,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      const encoder = device.createCommandEncoder({
        label: "Snap readback encoder",
      });
      encoder.copyTextureToBuffer(
        {
          texture: snapTexture,
          origin: [region.copyOriginX, region.copyOriginTopY, 0],
        },
        {
          buffer: stagingBuffer,
          bytesPerRow,
          rowsPerImage: region.copyHeight,
        },
        [region.copyWidth, region.copyHeight],
      );
      device.queue.submit([encoder.finish()]);

      await stagingBuffer.mapAsync(GPUMapMode.READ);
      mapped = true;
      if (this._isDestroyed) {
        return [];
      }
      const mappedData = new Float32Array(stagingBuffer.getMappedRange());
      const pixels = unpackSnapPixels(mappedData, bytesPerRow, region);
      this._publishReadbackCache(
        pixels,
        region,
        requestSequence,
        device,
        snapTexture,
      );
      return decodeSnapHits(
        this._context,
        pixels,
        region.logicalWidth,
        region.logicalHeight,
      );
    } finally {
      if (mapped) {
        stagingBuffer?.unmap();
      }
      stagingBuffer?.destroy();
    }
  }

  /**
   * Return the persistent staging buffer used by the synchronous path. A
   * mapping-pending buffer cannot be replaced; the current request is skipped
   * and the next one retries once the map resolves.
   */
  private _ensureSyncStagingBuffer(bufferSize: number): GPUBuffer | null {
    const device = this._device;
    if (!device || !(bufferSize > 0)) {
      return null;
    }
    if (
      this._stagingBuffer &&
      this._stagingBufferDevice === device &&
      this._stagingBufferSize === bufferSize
    ) {
      return this._stagingBuffer;
    }
    if (this._readbackInFlight) {
      return null;
    }
    const replacement = device.createBuffer({
      label: "Snap sync staging buffer",
      size: bufferSize,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const previous = this._stagingBuffer;
    this._stagingBuffer = replacement;
    this._stagingBufferSize = bufferSize;
    this._stagingBufferDevice = device;
    previous?.destroy();
    return replacement;
  }

  /**
   * Arm an async readback whose result the NEXT synchronous `end()` for the
   * same region can consume.
   */
  private _startReadback(region: SnapReadbackRegion): void {
    const device = this._device;
    const snapTexture = this._snapTexture;
    if (!device || !snapTexture) {
      return;
    }
    // Submitting a copy into a mapping-pending buffer throws
    // "Buffer used in submit while mapped".
    if (this._readbackInFlight) {
      return;
    }

    const requestSequence = this._nextReadbackSequence++;
    if (region.copyWidth === 0 || region.copyHeight === 0) {
      this._publishReadbackCache(
        new Float32Array(
          region.logicalWidth * region.logicalHeight * SNAP_CHANNELS,
        ),
        region,
        requestSequence,
        device,
        snapTexture,
      );
      return;
    }

    const bytesPerRow = alignedSnapBytesPerRow(region.copyWidth);
    const stagingBuffer = this._ensureSyncStagingBuffer(
      bytesPerRow * region.copyHeight,
    );
    if (!stagingBuffer) {
      return;
    }

    const encoder = device.createCommandEncoder({
      label: "Snap readback encoder (async)",
    });
    encoder.copyTextureToBuffer(
      {
        texture: snapTexture,
        origin: [region.copyOriginX, region.copyOriginTopY, 0],
      },
      {
        buffer: stagingBuffer,
        bytesPerRow,
        rowsPerImage: region.copyHeight,
      },
      [region.copyWidth, region.copyHeight],
    );
    device.queue.submit([encoder.finish()]);

    this._readbackInFlight = true;
    stagingBuffer
      .mapAsync(GPUMapMode.READ)
      .then(() => {
        try {
          if (
            this._isDestroyed ||
            this._stagingBuffer !== stagingBuffer ||
            this._stagingBufferDevice !== device ||
            this._device !== device ||
            this._snapTexture !== snapTexture
          ) {
            // The attachment/device generation changed while the copy was in
            // flight; its bytes must not warm the cache for the replacement.
            return;
          }
          const mappedData = new Float32Array(stagingBuffer.getMappedRange());
          const pixels = unpackSnapPixels(mappedData, bytesPerRow, region);
          this._publishReadbackCache(
            pixels,
            region,
            requestSequence,
            device,
            snapTexture,
          );
        } finally {
          try {
            stagingBuffer.unmap();
          } catch {
            // A destroyed buffer cannot be unmapped; teardown already owns it.
          }
          this._readbackInFlight = false;
        }
      })
      .catch(() => {
        this._readbackInFlight = false;
      });
  }

  private _destroyTextures(): void {
    this._occluderTexture?.destroy();
    this._snapTexture?.destroy();
    this._depthTexture?.destroy();
    this._occluderTexture = null;
    this._snapTexture = null;
    this._depthTexture = null;
    this._occluderView = null;
    this._snapView = null;
    this._depthView = null;
    this._attachmentDevice = null;
    // Cached bytes belong to the destroyed payload target and cannot be decoded
    // as the first result of its replacement.
    this._lastReadPixels = null;
    this._lastReadRegion = null;
  }

  isDestroyed(): boolean {
    return this._isDestroyed;
  }

  destroy(): void {
    this._isDestroyed = true;
    this._destroyTextures();
    if (this._stagingBuffer) {
      this._stagingBuffer.destroy();
      this._stagingBuffer = null;
    }
    this._stagingBufferSize = 0;
    this._stagingBufferDevice = null;
    this._readbackInFlight = false;
  }
}

export default WebGPUSnapFramebuffer;
