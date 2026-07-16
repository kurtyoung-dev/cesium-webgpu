/// <reference types="@webgpu/types" />
/**
 * WebGPU Pick Framebuffer — Renders pick-color pass and reads back pixel data
 *
 * Equivalent of PickFramebuffer.js for WebGPU. Creates an offscreen render
 * target (rgba8unorm + depth24plus-stencil8), renders the scene's pick pass
 * into it, then uses copyTextureToBuffer + mapAsync for GPU readback.
 *
 * Because WebGPU readback is inherently async, synchronous `end()` uses a
 * pre-mapped staging buffer that was mapped in a previous frame. The first
 * call may return empty results. `endAsync()` always works correctly.
 *
 * @private
 */

import BoundingRectangle from "../../Core/BoundingRectangle.js";
import Color from "../../Core/Color.js";
import defined from "../../Core/defined.js";
import {
  WebGPUFeatureIdTexture,
  type FeatureIdResolveResult,
} from "./WebGPUFeatureIdTexture.js";

// NEW-PICK-METADATA-READBACK (Batch 285) — validity window for the cached
// center pixel (pickMetadata / pickVoxelCoordinate). The cache is only
// returned when the query is within this many pixels of the readback's own
// coordinate (a moving cursor re-arms and converges next frame)...
const CENTER_PIXEL_COORD_TOLERANCE = 2;
// ...and when no more than this many picks have rendered since the readback
// was armed (the pixel content can't change without a new metadata/voxel
// pass, so a short window bounds drift on a continuously-moving cursor).
const CENTER_PIXEL_MAX_STALE_FRAMES = 4;
// 256-byte minimum mapping alignment for a 1x1 RGBA8 copy.
const CENTER_STAGING_BUFFER_SIZE = 256;

/**
 * The pick color attachment MUST use the same format the pick PIPELINES target
 * (`context.pickPipelineFormat`), otherwise WebGPU drops every
 * pick draw with "Attachment state of [RenderPipeline] is not compatible with
 * [RenderPassEncoder Pick render pass]" and the pick FBO stays empty — the
 * actual cause of FORK-34 (all picking returns undefined). Only 8-bit unorm
 * formats support the byte-readback path below; an HDR/float scene format
 * therefore uses an LDR rgba8unorm pick attachment and matching pipelines.
 * @private
 */
export function getWebGPUPickColorFormat(
  context: CesiumGraphicsContext,
): GPUTextureFormat {
  const typedContext = context as unknown as {
    pickPipelineFormat?: GPUTextureFormat;
    scenePipelineFormat?: GPUTextureFormat;
  };
  const canonical = typedContext.pickPipelineFormat;
  if (canonical) {
    return canonical;
  }
  const f = typedContext.scenePipelineFormat;
  return f === "bgra8unorm" || f === "rgba8unorm" ? f : "rgba8unorm";
}

/**
 * Spiral search pattern for finding picked objects from center outward.
 * `bgra` swaps R/B because `bgra8unorm` stores bytes as [B,G,R,A] while the
 * pickId color comparison is in [R,G,B,A].
 */
function pickObjectsFromPixels(
  context: CesiumGraphicsContext,
  pixels: Uint8Array,
  width: number,
  height: number,
  limit: number = 1,
  bgra: boolean = false,
): CesiumOpaqueObject[] {
  const max = Math.max(width, height);
  const length = max * max;
  const halfWidth = Math.floor(width * 0.5);
  const halfHeight = Math.floor(height * 0.5);

  let x = 0;
  let y = 0;
  let dx = 0;
  let dy = -1;

  const objects = new Set<CesiumOpaqueObject>();
  for (let i = 0; i < length; ++i) {
    if (
      -halfWidth <= x &&
      x <= halfWidth &&
      -halfHeight <= y &&
      y <= halfHeight
    ) {
      const index = 4 * ((halfHeight - y) * width + x + halfWidth);
      const r = bgra ? pixels[index + 2] : pixels[index];
      const g = pixels[index + 1];
      const b = bgra ? pixels[index] : pixels[index + 2];
      const a = pixels[index + 3];

      // A pick hit is any pixel whose reconstructed key (RGBA, little-endian)
      // is nonzero. Pick-ID colors come from `Color.fromRgba(key)`, which
      // packs the incrementing integer key into the bytes low-to-high on a
      // little-endian host: red = key & 0xff, green = (key >> 8) & 0xff,
      // blue = (key >> 16) & 0xff, ALPHA = (key >> 24) & 0xff. So every pick
      // id below 2^24 (i.e. essentially all of them) has alpha 0. The old
      // `a > 0` gate therefore rejected virtually every real pick — the true
      // cause of FORK-34 once the pick pass itself was fixed. The cleared
      // pick FBO is (0,0,0,0) → key 0, which `getObjectByPickColor` maps to
      // undefined (pick ids start at 1). Include alpha in the gate so valid
      // keys above 0x00ffffff remain decodable; this also prepares the path
      // for contiguous PickId ranges without changing ordinary low-key IDs.
      if (r !== 0 || g !== 0 || b !== 0 || a !== 0) {
        const pickColor = Color.bytesToRgba(r, g, b, a);
        const object = context.getObjectByPickColor(pickColor);
        if (defined(object)) {
          objects.add(object);
          if (objects.size >= limit) {
            break;
          }
        }
      }
    }

    // Spiral direction changes
    if (x === y || (x < 0 && -x === y) || (x > 0 && x === 1 - y)) {
      const temp = dx;
      dx = -dy;
      dy = temp;
    }

    x += dx;
    y += dy;
  }
  return [...objects];
}

interface PickReadbackRegion {
  logicalOriginX: number;
  logicalOriginTopY: number;
  logicalWidth: number;
  logicalHeight: number;
  copyOriginX: number;
  copyOriginTopY: number;
  copyWidth: number;
  copyHeight: number;
  copyOffsetX: number;
  copyOffsetY: number;
  attachmentGeneration: number;
}

/**
 * Expand a clipped, row-padded GPU copy back into the caller's logical pick
 * rectangle. Pixels outside the attachment are intentionally left zero. This
 * keeps the requested cursor at the logical center instead of shifting the
 * entire query inward at canvas edges.
 */
function unpackPickPixels(
  mappedData: Uint8Array,
  bytesPerRow: number,
  region: PickReadbackRegion,
): Uint8Array {
  const pixels = new Uint8Array(region.logicalWidth * region.logicalHeight * 4);
  const copyRowBytes = region.copyWidth * 4;
  for (let row = 0; row < region.copyHeight; row++) {
    const srcOffset = row * bytesPerRow;
    const dstOffset =
      ((region.copyOffsetY + row) * region.logicalWidth + region.copyOffsetX) *
      4;
    pixels.set(
      mappedData.subarray(srcOffset, srcOffset + copyRowBytes),
      dstOffset,
    );
  }
  return pixels;
}

export class WebGPUPickFramebuffer {
  private _context: CesiumGraphicsContext;
  private _device: GPUDevice | null = null;
  private _colorTexture: GPUTexture | null = null;
  private _depthTexture: GPUTexture | null = null;
  private _width: number = 0;
  private _height: number = 0;
  // Pick color attachment format — must match context.pickPipelineFormat.
  private _colorFormat: GPUTextureFormat = "rgba8unorm";
  private _passState: CesiumPassState;
  private _isDestroyed: boolean = false;

  // Cached texture views — recreated only when textures are reallocated on
  // resize. begin() used to call createView() on every frame which leaked
  // ~60 view objects/sec under continuous picking.
  private _colorView: GPUTextureView | null = null;
  private _depthView: GPUTextureView | null = null;
  private _attachmentDevice: GPUDevice | null = null;

  // Staging buffer for color readback
  private _stagingBuffer: GPUBuffer | null = null;
  private _stagingBufferSize: number = 0;
  private _stagingBufferDevice: GPUDevice | null = null;
  private _lastReadPixels: Uint8Array | null = null;
  private _lastReadRegion: PickReadbackRegion | null = null;
  // Monotonic request IDs prevent an older overlapping async completion from
  // overwriting the shared synchronous cache after a newer request finishes.
  private _nextReadbackSequence: number = 0;
  private _lastPublishedReadbackSequence: number = -1;

  // NEW-WEBGPU-PICK-COLD-SYNC-STALENESS (Batch 361) — one-time latch for the
  // cold-pick guidance warning. WebGPU has no synchronous readback, so the
  // FIRST synchronous `scene.pick()` against a fresh pick FBO returns nothing
  // (the async readback hasn't completed; there is no previous-frame result to
  // return). This is intrinsic, not a bug — but a one-off / click-driven sync
  // pick that comes back undefined is confusing, so we emit a single guidance
  // line steering callers to `scene.pickAsync` (which awaits the readback).
  // Latched so it fires exactly once per framebuffer, never per-frame.
  private _coldPickWarned: boolean = false;
  // True between submit-of-copyTextureToBuffer and the unmap that follows
  // mapAsync's resolution. While true, we must not encode another copy to
  // the same staging buffer or the queue will reject the submit with
  // "Buffer used in submit while mapped" (the buffer transitions through
  // mapping-pending → mapped before unmap clears it). sampleHeight in
  // continuous CallbackProperty demos hits this every frame.
  private _readbackInFlight: boolean = false;

  // Logical top-down pick rectangle. Its origin may be outside the attachment
  // at canvas edges; keeping it unshifted preserves the caller's cursor at the
  // center of the spiral search. GPU rendering/copying uses the separately
  // clipped source rectangle below, then readback zero-pads the missing area.
  private _pickOriginX: number = 0;
  private _pickOriginTopY: number = 0;
  private _pickWidth: number = 1;
  private _pickHeight: number = 1;
  private _copyOriginX: number = 0;
  private _copyOriginTopY: number = 0;
  private _copyWidth: number = 1;
  private _copyHeight: number = 1;
  private _copyOffsetX: number = 0;
  private _copyOffsetY: number = 0;
  private _attachmentGeneration: number = 0;

  // Depth readback resources (separate depth32float target for copyable depth)
  private _readableDepthTexture: GPUTexture | null = null;
  private _readableDepthView: GPUTextureView | null = null;
  private _classificationDepthTexture: GPUTexture | null = null;
  private _classificationDepthView: GPUTextureView | null = null;
  private _classificationDepthPlaceholderTexture: GPUTexture | null = null;
  private _classificationDepthPlaceholderView: GPUTextureView | null = null;
  private _depthStagingBuffer: GPUBuffer | null = null;
  private _depthStagingBufferDevice: GPUDevice | null = null;

  // R-2b UNIFIED-FEATURE-ID-TEXTURE — lazily-constructed helper that samples
  // `_colorTexture` (the unified, source-agnostic per-fragment feature-ID
  // G-buffer) inside a fullscreen post-process pass. Default-OFF: stays null
  // unless resolveFeatureIdRecolorAsync() is explicitly called.
  private _featureIdTexture: WebGPUFeatureIdTexture | null = null;

  // NEW-PICK-METADATA-READBACK (Batch 285) — center-pixel readback state for
  // pickMetadata / pickVoxelCoordinate. These callers render their own pass
  // into `_colorTexture` then call readCenterPixel() SYNCHRONOUSLY, so they
  // cannot consume `_lastReadPixels` (which holds the most recent regular
  // scene.pick() color pass — a STALE pixel from a different pass). Instead
  // readCenterPixel arms its OWN 1x1 readback of the just-rendered center
  // pixel and returns a one-frame-stale cached value keyed to the query
  // coordinate + frame stamp, mirroring PickDepth.getDepth's async contract:
  // the first query at a new spot returns the cleared pixel (caller gets
  // undefined / no voxel) and arms the readback; a re-pick at the same spot
  // 1-2 frames later returns the correct metadata/voxel value.
  private _centerPixelValue: Uint8Array | null = null;
  private _centerPixelX: number = -1;
  private _centerPixelY: number = -1;
  private _centerPixelStamp: number = -1;
  // Re-entrancy guard: true between submit-of-copyTextureToBuffer and the
  // unmap that follows mapAsync's resolution. Prevents a rapid re-pick from
  // re-reading a half-written staging buffer (the metadata/voxel analogue of
  // _readbackInFlight on the color path).
  private _centerReadbackInFlight: boolean = false;
  // Staleness clock — advanced once per begin() (one metadata/voxel pick is
  // one begin → render → readCenterPixel cycle). Measured in picks, not wall
  // time, so a paused scene keeps a valid cache indefinitely.
  private _updateCount: number = 0;

  constructor(context: CesiumGraphicsContext) {
    this._context = context;
    this._device = context._device ?? null;

    // Create pass state with scissor/viewport
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
   * Begin a pick rendering pass.
   * Creates/resizes the offscreen render targets and returns a pass state.
   */
  begin(
    screenSpaceRectangle: CesiumBoundingRectangle,
    viewport: CesiumBoundingRectangle,
  ): CesiumPassState {
    // Start the off-screen frame before any pick commands are rebuilt.
    // Globe.updateForPick and other feature renderers allocate uniform-ring
    // slices during the scene update that follows this call; starting only in
    // executePickPass is too late and makes those commands reference the
    // previous normal frame's page. The renderer's later beginPickFrame call
    // remains a harmless idempotent guard.
    const pickFrameContext = this._context as CesiumGraphicsContext & {
      beginPickFrame?: () => void;
    };
    pickFrameContext.beginPickFrame?.();

    const device = this._context._device;
    if (!device) {
      return this._passState;
    }
    const deviceChanged = device !== this._attachmentDevice;
    this._device = device;

    const rawWidth = viewport?.width;
    const rawHeight = viewport?.height;
    // Defensive guard — viewport.width/height arrive undefined/NaN during
    // teardown or if a caller passes a partially-initialized rect. Falling
    // through with NaN propagates to bytesPerRow/bufferSize and surfaces as
    // "createBuffer Failed to read 'size' property: Value is null".
    const width =
      typeof rawWidth === "number" && rawWidth > 0 ? Math.floor(rawWidth) : 1;
    const height =
      typeof rawHeight === "number" && rawHeight > 0
        ? Math.floor(rawHeight)
        : 1;

    // Advance the staleness clock once per pick pass (NEW-PICK-METADATA-READBACK).
    this._updateCount++;

    BoundingRectangle.clone(
      screenSpaceRectangle,
      this._passState.scissorTest.rectangle,
    );

    // Resolve the caller's logical query and its clipped GPU source rectangle.
    // Cesium supplies a GL-style bottom-origin y; WebGPU render-pass scissors
    // and texture copies are top-origin. Do not shift the logical origin to
    // keep its full extent in bounds: doing so moves the cursor away from the
    // center pixel at a canvas edge. Instead copy only the intersection and
    // zero-pad it back into the logical rectangle during readback.
    const pickWidth = Math.max(
      1,
      Math.min(width, Math.floor(screenSpaceRectangle.width ?? 1)),
    );
    const pickHeight = Math.max(
      1,
      Math.min(height, Math.floor(screenSpaceRectangle.height ?? 1)),
    );
    const glOriginX = Math.floor(screenSpaceRectangle.x ?? 0);
    const glOriginY = Math.floor(screenSpaceRectangle.y ?? 0);
    this._pickOriginX = glOriginX;
    this._pickOriginTopY = height - glOriginY - pickHeight;
    this._pickWidth = pickWidth;
    this._pickHeight = pickHeight;

    const copyRight = Math.max(
      0,
      Math.min(width, this._pickOriginX + pickWidth),
    );
    const copyBottom = Math.max(
      0,
      Math.min(height, this._pickOriginTopY + pickHeight),
    );
    this._copyOriginX = Math.max(0, Math.min(width, this._pickOriginX));
    this._copyOriginTopY = Math.max(0, Math.min(height, this._pickOriginTopY));
    this._copyWidth = Math.max(0, copyRight - this._copyOriginX);
    this._copyHeight = Math.max(0, copyBottom - this._copyOriginTopY);
    this._copyOffsetX = this._copyOriginX - this._pickOriginX;
    this._copyOffsetY = this._copyOriginTopY - this._pickOriginTopY;

    // The pick color attachment MUST match the pick pipelines' canonical
    // target format or WebGPU drops every pick draw — FORK-34.
    const colorFormat = getWebGPUPickColorFormat(this._context);

    // Create or recreate render targets
    if (
      width !== this._width ||
      height !== this._height ||
      colorFormat !== this._colorFormat ||
      deviceChanged
    ) {
      this._destroyTextures();
      if (deviceChanged) {
        if (this._depthStagingBuffer) {
          this._depthStagingBuffer.destroy();
          this._depthStagingBuffer = null;
        }
        this._depthStagingBufferDevice = null;
        if (this._featureIdTexture) {
          this._featureIdTexture.destroy();
          this._featureIdTexture = null;
        }
      }
      this._colorFormat = colorFormat;

      this._colorTexture = device.createTexture({
        label: "Pick color texture",
        size: [width, height],
        format: colorFormat,
        usage:
          GPUTextureUsage.RENDER_ATTACHMENT |
          GPUTextureUsage.COPY_SRC |
          GPUTextureUsage.TEXTURE_BINDING,
      });

      this._depthTexture = device.createTexture({
        label: "Pick depth texture",
        size: [width, height],
        format: "depth24plus-stencil8",
        usage:
          GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });

      this._width = width;
      this._height = height;
      this._attachmentDevice = device;
      this._attachmentGeneration++;

      // Cache texture views once per resize — see field comment above.
      this._colorView = this._colorTexture.createView();
      this._depthView = this._depthTexture.createView();

      // A 1x1 packed-depth sentinel lets classification renderers build their
      // commands before the pick executor knows whether this query contains
      // classification work. The full-viewport packed target remains lazy and
      // is allocated only by ensureClassificationDepth below.
      this._classificationDepthPlaceholderTexture = device.createTexture({
        label: "Pick classification depth placeholder",
        size: [1, 1],
        format: "rgba8unorm",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      this._classificationDepthPlaceholderView =
        this._classificationDepthPlaceholderTexture.createView();
      device.queue.writeTexture(
        { texture: this._classificationDepthPlaceholderTexture },
        new Uint8Array(4),
        { bytesPerRow: 4, rowsPerImage: 1 },
        [1, 1],
      );
    }

    const pickDepthContext = this._context as CesiumGraphicsContext & {
      _pickClassificationDepthView?: GPUTextureView | null;
    };
    pickDepthContext._pickClassificationDepthView =
      this._classificationDepthPlaceholderView;

    // Store the pick framebuffer info so the context can use it
    this._passState.framebuffer = {
      _isWebGPUPickFBO: true,
      colorTexture: this._colorTexture,
      depthTexture: this._depthTexture,
      colorView: this._colorView ?? undefined,
      depthView: this._depthView ?? undefined,
      width: this._width,
      height: this._height,
      pickScissor: {
        x: this._copyOriginX,
        y: this._copyOriginTopY,
        width: this._copyWidth,
        height: this._copyHeight,
      },
      ensureClassificationDepth: this._ensureClassificationDepthTarget,
    } as CesiumOpaqueFramebuffer;

    this._passState.viewport.width = width;
    this._passState.viewport.height = height;

    return this._passState;
  }

  private _captureReadbackRegion(): PickReadbackRegion {
    return {
      logicalOriginX: this._pickOriginX,
      logicalOriginTopY: this._pickOriginTopY,
      logicalWidth: this._pickWidth,
      logicalHeight: this._pickHeight,
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
    left: PickReadbackRegion | null,
    right: PickReadbackRegion,
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

  /**
   * Widened sync-pick cache gate. When the current query's center pixel lies
   * inside the most recent completed readback's logical region and the
   * attachment generation matches, reproject the cached rows into the current
   * query's logical rectangle so `end()` can decode a result during cursor
   * motion instead of returning empty.
   *
   * The cached pixels are tightly packed rows of `cached.logicalWidth`
   * (unpackPickPixels already stripped the GPU copy's 256-byte bytesPerRow
   * padding), so both buffers are indexed in absolute top-down attachment
   * coordinates via their logical origins. Query pixels outside the cached
   * region stay zero, which decodes as no-hit — conservative for the outer
   * spiral taps while keeping the center pixel (the actual cursor) exact.
   *
   * Returns null when the gate does not apply (caller falls through to the
   * cold-pick path).
   */
  private _extractPixelsFromCachedRegion(
    region: PickReadbackRegion,
  ): Uint8Array | null {
    const cached = this._lastReadRegion;
    const cachedPixels = this._lastReadPixels;
    if (
      !cached ||
      !cachedPixels ||
      cached.attachmentGeneration !== region.attachmentGeneration
    ) {
      return null;
    }

    // Center pixel of the current query in absolute top-down coordinates —
    // matches pickObjectsFromPixels' spiral origin (floor(w/2), floor(h/2)).
    const centerX = region.logicalOriginX + Math.floor(region.logicalWidth / 2);
    const centerY =
      region.logicalOriginTopY + Math.floor(region.logicalHeight / 2);
    if (
      centerX < cached.logicalOriginX ||
      centerX >= cached.logicalOriginX + cached.logicalWidth ||
      centerY < cached.logicalOriginTopY ||
      centerY >= cached.logicalOriginTopY + cached.logicalHeight
    ) {
      return null;
    }

    const overlapLeft = Math.max(region.logicalOriginX, cached.logicalOriginX);
    const overlapRight = Math.min(
      region.logicalOriginX + region.logicalWidth,
      cached.logicalOriginX + cached.logicalWidth,
    );
    const overlapTop = Math.max(
      region.logicalOriginTopY,
      cached.logicalOriginTopY,
    );
    const overlapBottom = Math.min(
      region.logicalOriginTopY + region.logicalHeight,
      cached.logicalOriginTopY + cached.logicalHeight,
    );
    const overlapWidth = overlapRight - overlapLeft;
    if (overlapWidth <= 0 || overlapBottom <= overlapTop) {
      return null;
    }

    const pixels = new Uint8Array(
      region.logicalWidth * region.logicalHeight * 4,
    );
    for (let absY = overlapTop; absY < overlapBottom; absY++) {
      const srcOffset =
        ((absY - cached.logicalOriginTopY) * cached.logicalWidth +
          (overlapLeft - cached.logicalOriginX)) *
        4;
      const dstOffset =
        ((absY - region.logicalOriginTopY) * region.logicalWidth +
          (overlapLeft - region.logicalOriginX)) *
        4;
      pixels.set(
        cachedPixels.subarray(srcOffset, srcOffset + overlapWidth * 4),
        dstOffset,
      );
    }
    return pixels;
  }

  private _publishReadbackCache(
    pixels: Uint8Array,
    region: PickReadbackRegion,
    requestSequence: number,
    requestDevice: GPUDevice,
    colorTexture: GPUTexture,
  ): void {
    if (
      this._isDestroyed ||
      this._device !== requestDevice ||
      this._attachmentDevice !== requestDevice ||
      this._colorTexture !== colorTexture ||
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
   * End the pick pass and synchronously read back picked objects.
   * Note: On WebGPU, synchronous readback may return empty results on the first call
   * because GPU readback is inherently async. Use endAsync() for reliable results.
   *
   * For practical use, this returns the result from the previous frame's readback
   * if available, while starting a new readback for the current frame.
   */
  end(
    screenSpaceRectangle: CesiumBoundingRectangle,
    limit: number = 1,
  ): CesiumOpaqueObject[] {
    const context = this._context;
    const device = this._device;

    if (!device || !this._colorTexture) {
      return [];
    }

    const region = this._captureReadbackRegion();

    // Start async readback for the current frame
    this._startReadback(region);

    // Return a previous result for this exact logical query and attachment
    // generation (fast path — no copy needed).
    if (
      this._lastReadPixels &&
      this._readbackRegionsEqual(this._lastReadRegion, region)
    ) {
      return pickObjectsFromPixels(
        context,
        this._lastReadPixels,
        region.logicalWidth,
        region.logicalHeight,
        limit,
        this._colorFormat === "bgra8unorm",
      );
    }

    // Widened cache gate — a moving cursor produces a slightly different
    // logical region every frame, so the exact-match path above would return
    // [] for every synchronous pick during cursor motion. When the current
    // query's center pixel lies inside the cached region (same attachment
    // generation), reproject the cached rows into the current query rectangle
    // and decode from that instead of returning empty. Result staleness is
    // identical to the exact-match path (one frame).
    const reprojected = this._extractPixelsFromCachedRegion(region);
    if (reprojected) {
      return pickObjectsFromPixels(
        context,
        reprojected,
        region.logicalWidth,
        region.logicalHeight,
        limit,
        this._colorFormat === "bgra8unorm",
      );
    }

    // Cold pick — no readback has completed yet. WebGPU can't read the pixels
    // back synchronously, so the very first sync pick returns nothing. Warn
    // once steering one-off callers to the async path. (Permanent, latched —
    // app developers NEED this to understand why a first sync pick came back
    // empty; it never repeats once the readback warms.)
    if (!this._coldPickWarned) {
      this._coldPickWarned = true;
      console.warn(
        "[CesiumJS:WebGPU] scene.pick() returned no result on its first call " +
          "because WebGPU reads the pick buffer asynchronously (one-frame " +
          "stale). This is expected for a standalone pick at a fresh location. " +
          "Use scene.pickAsync() for one-off / click-driven picks; the " +
          "continuous-hover scene.pick() pattern warms up after the first frame.",
      );
    }

    return [];
  }

  /**
   * End the pick pass and asynchronously read back picked objects.
   * This is the recommended path for WebGPU — always returns correct results.
   */
  async endAsync(
    screenSpaceRectangle: CesiumBoundingRectangle,
    frameState: CesiumFrameState,
    limit: number = 1,
  ): Promise<object[]> {
    const context = this._context;
    const device = this._device;

    if (!device || !this._colorTexture) {
      return [];
    }

    const region = this._captureReadbackRegion();
    const colorTexture = this._colorTexture;
    const requestDevice = device;
    const requestSequence = this._nextReadbackSequence++;
    const bgra = this._colorFormat === "bgra8unorm";

    // A query can be entirely outside the attachment at a canvas boundary.
    // Its logical result is still well-defined: every pixel is the clear key.
    if (region.copyWidth === 0 || region.copyHeight === 0) {
      const pixels = new Uint8Array(
        region.logicalWidth * region.logicalHeight * 4,
      );
      this._publishReadbackCache(
        pixels,
        region,
        requestSequence,
        requestDevice,
        colorTexture,
      );
      return pickObjectsFromPixels(
        context,
        pixels,
        region.logicalWidth,
        region.logicalHeight,
        limit,
        bgra,
      );
    }

    // Each async request owns its exact-size staging buffer. Sharing the sync
    // path's persistent buffer allowed overlapping end()/endAsync() calls to
    // encode into a buffer that was mapping-pending or already mapped.
    const bytesPerRow = Math.ceil((region.copyWidth * 4) / 256) * 256;
    const bufferSize = bytesPerRow * region.copyHeight;
    let stagingBuffer: GPUBuffer | null = null;
    let mapped = false;
    try {
      stagingBuffer = device.createBuffer({
        label: "Pick async staging buffer",
        size: bufferSize,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      const encoder = device.createCommandEncoder({
        label: "Pick readback encoder",
      });

      encoder.copyTextureToBuffer(
        {
          texture: colorTexture,
          // Read from the pick region, not the top-left corner — and convert
          // the vertical origin (METADATA-TABLE-SOURCES, same conversion as
          // readCenterPixel / C-R9-VOXEL-CELL-PICK): the caller's rectangle is
          // GL-convention (`y` measured from the BOTTOM, per
          // computePickingDrawingBufferRectangle) while `_colorTexture` is
          // stored TOP-DOWN.
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
      const mappedData = new Uint8Array(stagingBuffer.getMappedRange());
      const pixels = unpackPickPixels(mappedData, bytesPerRow, region);
      this._publishReadbackCache(
        pixels,
        region,
        requestSequence,
        requestDevice,
        colorTexture,
      );

      return pickObjectsFromPixels(
        context,
        pixels,
        region.logicalWidth,
        region.logicalHeight,
        limit,
        bgra,
      );
    } finally {
      if (mapped) {
        stagingBuffer?.unmap();
      }
      stagingBuffer?.destroy();
    }
  }

  /**
   * Read the center pixel of the pick rectangle.
   * Used for voxel coordinate picking and metadata picking.
   *
   * NEW-PICK-METADATA-READBACK (Batch 285) — synchronized async readback.
   * The metadata/voxel callers (Picking.pickMetadata / pickVoxelCoordinate)
   * render their pass into `_colorTexture`, submit it via context.endFrame(),
   * then call this SYNCHRONOUSLY expecting the just-rendered center pixel.
   * Because WebGPU readback is async, we arm a fresh 1x1 readback of the
   * current center pixel (guarded so a re-pick can't read a half-written
   * buffer) and return a one-frame-stale cache keyed to the query coordinate
   * + a frame stamp. A cold query returns (0,0,0,0) (caller decodes to
   * "no metadata / no voxel") and arms the readback; the same query 1-2 frames
   * later returns the correct value — identical to PickDepth.getDepth's
   * contract. This replaces the old `_lastReadPixels.slice()` which returned
   * the STALE pixel from the most recent regular scene.pick() COLOR pass.
   */
  readCenterPixel(screenSpaceRectangle: CesiumBoundingRectangle): Uint8Array {
    const width = this._pickWidth;
    const height = this._pickHeight;
    const halfWidth = Math.floor(width * 0.5);
    const halfHeight = Math.floor(height * 0.5);

    // Absolute center coordinate within the full-viewport `_colorTexture`.
    // begin() already normalized the rectangle to top-down texture space.
    const px = this._pickOriginX + halfWidth;
    const py = this._pickOriginTopY + halfHeight;

    // Arm/refresh the readback for this center pixel. The guard inside dedupes
    // overlapping requests and swallows teardown races.
    this._readCenterPixelAsync(px, py);

    const cached = this._centerPixelValue;
    if (
      cached &&
      Math.abs(px - this._centerPixelX) <= CENTER_PIXEL_COORD_TOLERANCE &&
      Math.abs(py - this._centerPixelY) <= CENTER_PIXEL_COORD_TOLERANCE &&
      this._updateCount - this._centerPixelStamp <=
        CENTER_PIXEL_MAX_STALE_FRAMES
    ) {
      return cached.slice(0, 4);
    }
    return new Uint8Array([0, 0, 0, 0]);
  }

  /**
   * Asynchronously read a single RGBA8 pixel from `_colorTexture` at the
   * given texture coordinate, caching it for the next synchronous
   * readCenterPixel() call. NEW-PICK-METADATA-READBACK (Batch 285).
   *
   * Uses a fresh staging buffer per readback (destroyed after unmap) so it
   * never collides with the color-path `_stagingBuffer` used by end()/
   * endAsync(), and so an in-flight readback can't be re-read mid-write
   * (the `_centerReadbackInFlight` guard enforces the latter).
   */
  private _readCenterPixelAsync(x: number, y: number): void {
    const device = this._device;
    const colorTexture = this._colorTexture;
    if (!device || !colorTexture) {
      return;
    }

    // Re-entrancy guard: a readback is still mapping/mapped — don't submit a
    // second copy nor read the half-written buffer. The current cached value
    // (if any) is returned by the caller; this query converges next frame.
    if (this._centerReadbackInFlight) {
      return;
    }

    const px = Math.max(0, Math.min(Math.floor(x), this._width - 1));
    const py = Math.max(0, Math.min(Math.floor(y), this._height - 1));

    // Stamp with the CURRENT pick count — the pixel decoded below corresponds
    // to the metadata/voxel pass that rendered into `_colorTexture` this pick.
    const requestStamp = this._updateCount;
    const bgra = this._colorFormat === "bgra8unorm";

    this._centerReadbackInFlight = true;

    let stagingBuffer: GPUBuffer | null = null;
    try {
      stagingBuffer = device.createBuffer({
        label: "Pick center-pixel staging buffer",
        size: CENTER_STAGING_BUFFER_SIZE,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });

      const encoder = device.createCommandEncoder({
        label: "Pick center-pixel readback",
      });
      encoder.copyTextureToBuffer(
        {
          texture: colorTexture,
          origin: [px, py, 0],
        },
        {
          buffer: stagingBuffer,
          bytesPerRow: CENTER_STAGING_BUFFER_SIZE,
          rowsPerImage: 1,
        },
        [1, 1],
      );
      device.queue.submit([encoder.finish()]);

      const buffer = stagingBuffer;
      buffer
        .mapAsync(GPUMapMode.READ, 0, 4)
        .then(() => {
          if (this._isDestroyed) {
            buffer.destroy();
            this._centerReadbackInFlight = false;
            return;
          }
          const data = new Uint8Array(buffer.getMappedRange(0, 4));
          // Normalize to [R,G,B,A] regardless of the texture's byte order so
          // downstream decoders (MetadataPicking, voxel tile/sample unpack)
          // see the same layout the WebGL readPixels path produces.
          const value = bgra
            ? new Uint8Array([data[2], data[1], data[0], data[3]])
            : new Uint8Array([data[0], data[1], data[2], data[3]]);
          buffer.unmap();
          buffer.destroy();

          this._centerPixelValue = value;
          this._centerPixelX = x;
          this._centerPixelY = y;
          this._centerPixelStamp = requestStamp;
          this._centerReadbackInFlight = false;
        })
        .catch(() => {
          buffer.destroy();
          this._centerReadbackInFlight = false;
        });
    } catch {
      if (stagingBuffer) {
        stagingBuffer.destroy();
      }
      this._centerReadbackInFlight = false;
    }
  }

  /**
   * Return the persistent staging buffer used only by synchronous end(). The
   * allocation follows the requested copy extent, never the viewport extent.
   * A mapping-pending buffer cannot be replaced; the current sync request is
   * skipped and the next one retries after the previous map completes.
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

    // Allocate first so a device/OOM failure leaves the existing usable slot
    // intact rather than retaining a pointer to an already-destroyed buffer.
    const replacement = device.createBuffer({
      label: "Pick sync staging buffer",
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
   * Start an async readback without waiting for the result.
   * The result will be available in the next frame via _lastReadPixels.
   */
  private _startReadback(region: PickReadbackRegion): void {
    const device = this._device;
    const colorTexture = this._colorTexture;
    if (!device || !colorTexture) {
      return;
    }
    // Skip if the previous frame's mapAsync hasn't unmapped yet — the
    // staging buffer is still mapping-pending or mapped, and submitting
    // a copy that targets it throws "used in submit while mapped".
    if (this._readbackInFlight) {
      return;
    }

    const requestSequence = this._nextReadbackSequence++;
    if (region.copyWidth === 0 || region.copyHeight === 0) {
      this._publishReadbackCache(
        new Uint8Array(region.logicalWidth * region.logicalHeight * 4),
        region,
        requestSequence,
        device,
        colorTexture,
      );
      return;
    }

    const bytesPerRow = Math.ceil((region.copyWidth * 4) / 256) * 256;
    const stagingBuffer = this._ensureSyncStagingBuffer(
      bytesPerRow * region.copyHeight,
    );
    if (!stagingBuffer) {
      return;
    }
    const encoder = device.createCommandEncoder({
      label: "Pick readback encoder (async)",
    });

    encoder.copyTextureToBuffer(
      {
        texture: colorTexture,
        // Copy from the pick region (see the paired comment on the async
        // readback path above), with the same GL-bottom-origin → top-down
        // vertical conversion (METADATA-TABLE-SOURCES).
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

    // Fire-and-forget async mapping — result will be used next frame.
    // The destroyed-guard catches the tab-close / viewer-teardown race
    // where destroy() runs between mapAsync() initiation and resolution
    // (would otherwise throw "cannot read getMappedRange of destroyed
    // buffer" on the unmap path).
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
            this._colorTexture !== colorTexture
          ) {
            // The attachment/device generation changed while the copy was in
            // flight. Its bytes must not warm the shared synchronous cache for
            // the replacement target.
            return;
          }

          const mappedData = new Uint8Array(stagingBuffer.getMappedRange());
          const pixels = unpackPickPixels(mappedData, bytesPerRow, region);
          this._publishReadbackCache(
            pixels,
            region,
            requestSequence,
            device,
            colorTexture,
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
        // A map or unpack failure is non-authoritative for synchronous pick.
        // The `then` finally above already unmapped when mapping succeeded.
        this._readbackInFlight = false;
      });
  }

  /**
   * Asynchronously read a single depth value from the pick framebuffer.
   * Uses the depth32float readable depth texture (not depth24plus-stencil8).
   *
   * @param x The x pixel coordinate.
   * @param y The y pixel coordinate.
   * @returns The depth value (0.0–1.0), or undefined if readback fails.
   */
  async readDepthPixelAsync(x: number, y: number): Promise<number | undefined> {
    const device = this._device;
    if (!device || !this._readableDepthTexture) {
      return undefined;
    }

    if (x < 0 || x >= this._width || y < 0 || y >= this._height) {
      return undefined;
    }

    // depth32float is 4 bytes per pixel; row must be 256-byte aligned
    const bytesPerPixel = 4;
    const bytesPerRow = 256; // minimum for a single-pixel copy
    const bufferSize = bytesPerRow;

    // Create or reuse depth staging buffer
    if (
      !this._depthStagingBuffer ||
      this._depthStagingBufferDevice !== device
    ) {
      this._depthStagingBuffer?.destroy();
      this._depthStagingBuffer = device.createBuffer({
        label: "Pick depth staging buffer",
        size: bufferSize,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      this._depthStagingBufferDevice = device;
    }

    const encoder = device.createCommandEncoder({
      label: "Pick depth readback encoder",
    });

    encoder.copyTextureToBuffer(
      {
        texture: this._readableDepthTexture,
        origin: [x, y, 0],
      },
      {
        buffer: this._depthStagingBuffer,
        bytesPerRow,
      },
      [1, 1],
    );

    device.queue.submit([encoder.finish()]);

    try {
      const depthStaging = this._depthStagingBuffer;
      await depthStaging.mapAsync(GPUMapMode.READ);
      if (this._isDestroyed || this._depthStagingBuffer !== depthStaging) {
        return undefined;
      }
      const mapped = new Float32Array(
        depthStaging.getMappedRange(0, bytesPerPixel),
      );
      const depth = mapped[0];
      depthStaging.unmap();
      return depth;
    } catch {
      // Buffer may already be mapped or destroyed
      return undefined;
    }
  }

  /**
   * Get the readable depth texture view for a dedicated copyable-depth pass.
   * WebGPU permits only one depth/stencil attachment per render pass, so a
   * consumer must populate this in its own pass before requesting readback.
   */
  get readableDepthView(): GPUTextureView | null {
    const device = this._device;
    if (
      !device ||
      device !== this._attachmentDevice ||
      this._width <= 0 ||
      this._height <= 0
    ) {
      return null;
    }
    if (!this._readableDepthTexture) {
      // This compatibility facility is intentionally on demand. The regular
      // ID pick pass uses depth24plus-stencil8 and never populates readable
      // depth, so eagerly allocating another full-viewport depth texture paid
      // substantial memory for every picker without making the API useful.
      // A depth consumer can request this view, attach it in its own pass, and
      // then use readDepthPixelAsync without burdening ordinary object picks.
      this._readableDepthTexture = device.createTexture({
        label: "Pick readable depth texture (depth32float)",
        size: [this._width, this._height],
        format: "depth32float",
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      });
      this._readableDepthView = this._readableDepthTexture.createView();
    }
    return this._readableDepthView;
  }

  private readonly _ensureClassificationDepthTarget = (): {
    texture: GPUTexture;
    view: GPUTextureView;
  } | null => {
    const device = this._device;
    if (
      !device ||
      device !== this._attachmentDevice ||
      this._width <= 0 ||
      this._height <= 0
    ) {
      return null;
    }
    if (!this._classificationDepthTexture) {
      this._classificationDepthTexture = device.createTexture({
        label: "Pick packed classification depth texture",
        size: [this._width, this._height],
        format: "rgba8unorm",
        usage:
          GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
      this._classificationDepthView =
        this._classificationDepthTexture.createView();
    }
    return {
      texture: this._classificationDepthTexture,
      view: this._classificationDepthView!,
    };
  };

  /**
   * The unified, source-agnostic per-fragment feature-ID texture — the pick
   * pass's color target, into which every source rasterizes its 24-bit
   * object/feature ID. `null` until the first `begin()` allocates it.
   *
   * R-2b UNIFIED-FEATURE-ID-TEXTURE — exposed so post-process consumers can
   * sample cross-source feature IDs inside a shader (historically the target
   * was only ever read back on the CPU).
   */
  get featureIdTexture(): GPUTexture | null {
    return this._colorTexture;
  }

  /** Memory format of {@link featureIdTexture} (`rgba8unorm` / `bgra8unorm`). */
  get featureIdFormat(): GPUTextureFormat {
    return this._colorFormat;
  }

  /**
   * R-2b UNIFIED-FEATURE-ID-TEXTURE — resolve the unified feature-ID G-buffer
   * inside a fullscreen post-process pass and read the recolored result back.
   *
   * The most recent pick render (`scene.pick` / `scene.pickAsync`) must have
   * populated `_colorTexture`; this samples that shared, source-agnostic ID
   * target on the GPU, decodes each 24-bit key, and hashes it to a distinct
   * color. Distinct colors at fragments covered by DIFFERENT sources prove that
   * cross-source feature IDs are resolvable inside a PP pass — the enabling
   * primitive for the R-2a cross-source attribute join.
   *
   * Default-OFF: constructs the helper lazily, so this is a no-op cost until an
   * app/probe calls it. Returns `null` if no pick target exists yet.
   */
  async resolveFeatureIdRecolorAsync(): Promise<FeatureIdResolveResult | null> {
    const device = this._device;
    if (!device || !this._colorTexture || this._isDestroyed) {
      return null;
    }
    if (!this._featureIdTexture) {
      this._featureIdTexture = new WebGPUFeatureIdTexture(device);
    }
    return this._featureIdTexture.resolveAsync(
      this._colorTexture,
      this._width,
      this._height,
    );
  }

  /**
   * R-2b UNIFIED-FEATURE-ID-TEXTURE (residual a — standing per-frame PP wiring).
   * Record the feature-ID recolor pass into a caller-provided per-frame command
   * encoder, sampling the unified pick-ID G-buffer and writing the recolor into
   * the helper's persistent output texture. Unlike
   * {@link resolveFeatureIdRecolorAsync} this performs NO separate submit and NO
   * CPU readback — the recolor lives inside the caller's own command stream and
   * its result view ({@link featureIdRecolorView}) is immediately sample-able by a
   * downstream same-frame post-process stage (the R-2a cross-source join) or a
   * feature-ID debug overlay.
   *
   * The most recent pick render (`scene.pick` / `scene.pickAsync`) must have
   * populated `_colorTexture`. Default-OFF: the helper is still lazily constructed,
   * so untouched scenes never allocate it and the standing pass is never recorded
   * unless a consumer explicitly calls this.
   *
   * @param encoder - The per-frame command encoder to record into (not submitted here).
   * @returns The persistent recolor output view, or `null` if no pick target exists yet.
   */
  recordFeatureIdResolve(encoder: GPUCommandEncoder): GPUTextureView | null {
    const device = this._device;
    if (!device || !this._colorTexture || this._isDestroyed) {
      return null;
    }
    if (!this._featureIdTexture) {
      this._featureIdTexture = new WebGPUFeatureIdTexture(device);
    }
    return this._featureIdTexture.record(
      encoder,
      this._colorTexture,
      this._width,
      this._height,
    );
  }

  /**
   * The persistent feature-ID recolor output texture written by
   * {@link recordFeatureIdResolve} / {@link resolveFeatureIdRecolorAsync}, or
   * `null` if the resolve helper has never been constructed (default-OFF state).
   */
  get featureIdRecolorTexture(): GPUTexture | null {
    return this._featureIdTexture?.outputTexture ?? null;
  }

  /** Sample-able view over {@link featureIdRecolorTexture}, or `null` when off. */
  get featureIdRecolorView(): GPUTextureView | null {
    return this._featureIdTexture?.outputView ?? null;
  }

  private _destroyTextures(): void {
    if (this._colorTexture) {
      this._colorTexture.destroy();
      this._colorTexture = null;
    }
    if (this._depthTexture) {
      this._depthTexture.destroy();
      this._depthTexture = null;
    }
    if (this._readableDepthTexture) {
      this._readableDepthTexture.destroy();
      this._readableDepthTexture = null;
    }
    if (this._classificationDepthTexture) {
      this._classificationDepthTexture.destroy();
      this._classificationDepthTexture = null;
    }
    if (this._classificationDepthPlaceholderTexture) {
      this._classificationDepthPlaceholderTexture.destroy();
      this._classificationDepthPlaceholderTexture = null;
    }
    this._readableDepthView = null;
    this._classificationDepthView = null;
    this._classificationDepthPlaceholderView = null;
    this._attachmentDevice = null;
    this._colorView = null;
    this._depthView = null;
    // Cached bytes belong to the destroyed color target/format and cannot be
    // decoded as the first result of the replacement target.
    this._lastReadPixels = null;
    this._lastReadRegion = null;
  }

  isDestroyed(): boolean {
    return this._isDestroyed;
  }

  destroy(): void {
    this._isDestroyed = true;
    this._destroyTextures();
    const pickDepthContext = this._context as CesiumGraphicsContext & {
      _pickClassificationDepthView?: GPUTextureView | null;
    };
    pickDepthContext._pickClassificationDepthView = null;
    if (this._stagingBuffer) {
      this._stagingBuffer.destroy();
      this._stagingBuffer = null;
    }
    this._stagingBufferSize = 0;
    this._stagingBufferDevice = null;
    this._readbackInFlight = false;
    if (this._depthStagingBuffer) {
      this._depthStagingBuffer.destroy();
      this._depthStagingBuffer = null;
    }
    this._depthStagingBufferDevice = null;
    this._lastReadPixels = null;
    this._lastReadRegion = null;
    // NEW-PICK-METADATA-READBACK — drop the center cache so a destroyed FBO
    // can't hand a stale pixel to a new pick after recreation. Any in-flight
    // center readback hits the `_isDestroyed` guard in its .then().
    this._centerPixelValue = null;
    this._centerReadbackInFlight = false;
    // R-2b UNIFIED-FEATURE-ID-TEXTURE — release the resolve helper's output
    // texture + pipeline if one was ever constructed.
    if (this._featureIdTexture) {
      this._featureIdTexture.destroy();
      this._featureIdTexture = null;
    }
  }
}

export default WebGPUPickFramebuffer;
