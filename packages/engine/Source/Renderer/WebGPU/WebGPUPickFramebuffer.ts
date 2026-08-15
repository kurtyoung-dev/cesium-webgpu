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

// NEW-PICK-METADATA-READBACK (Batch 285) — no more than this many picks may
// render before a typed center-pixel result expires. Coordinates and logical
// rectangles are exact: a nearby pixel can be a different voxel or metadata
// value and must arm its own readback rather than borrow its neighbor's bytes.
const CENTER_PIXEL_MAX_STALE_FRAMES = 4;
// Distinct typed queries that may converge concurrently. A multi-property
// `pickMetadata` sweep arms one readback per property inside a single task, so a
// single-slot cache let only the last-armed identity ever publish and starved
// every earlier one forever. Small and LRU-evicted: the working set is the
// number of properties a caller reads per pick, not a pixel history.
const CENTER_PIXEL_CACHE_CAPACITY = 8;
// In-flight readbacks. Bounded so a device that stops resolving `mapAsync`
// cannot grow the list without limit; an evicted request simply declines to
// publish, which is the same outcome a superseded request already had.
const CENTER_PIXEL_PENDING_CAPACITY = 16;
// 256-byte minimum mapping alignment for a 1x1 RGBA8 copy.
const CENTER_STAGING_BUFFER_SIZE = 256;
const VOXEL_CENTER_PIXEL_CLEAR_VALUE: GPUColorDict = Object.freeze({
  r: 1.0,
  g: 1.0,
  b: 1.0,
  a: 1.0,
});

type CenterPixelPassDomain = "metadata" | "voxel";

interface CenterPixelReadbackIdentity {
  domain: CenterPixelPassDomain;
  queryIdentityA: unknown;
  queryIdentityB: unknown;
  queryIdentityC: unknown;
  queryVersion: unknown;
  viewProvenance: unknown;
  logicalOriginX: number;
  logicalOriginTopY: number;
  logicalWidth: number;
  logicalHeight: number;
  pixelX: number;
  pixelY: number;
  device: GPUDevice;
  resourceGeneration: number;
  attachmentGeneration: number;
  colorTexture: GPUTexture;
}

interface CenterPixelCacheEntry extends CenterPixelReadbackIdentity {
  value: Uint8Array;
  stamp: number;
  requestSequence: number;
}

interface CenterPixelPendingRequest {
  identity: CenterPixelReadbackIdentity;
  requestSequence: number;
}

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

function getPickResourceGeneration(context: CesiumGraphicsContext): number {
  return "resourceGeneration" in context &&
    typeof context.resourceGeneration === "number"
    ? context.resourceGeneration
    : 0;
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
  resourceGeneration: number;
  attachmentGeneration: number;
  viewProvenance: unknown;
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
  private _attachmentResourceGeneration: number = -1;

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
  private _ordinaryPickViewProvenance: unknown = undefined;

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
  // pixel and returns a one-frame-stale cache only for the exact typed query,
  // rectangle, device/resource tuple, attachment, and owner version. A cold
  // query is invalid (`undefined`), never a fabricated all-zero pixel.
  //
  // Cache slots and in-flight requests are BOTH keyed by that same structural
  // identity, so distinct concurrent queries converge independently. The
  // single-identity caller still costs one comparison: its entry stays at the
  // head of the MRU list.
  private _centerPixelCacheEntries: CenterPixelCacheEntry[] = [];
  private _centerPendingRequests: CenterPixelPendingRequest[] = [];
  private _nextCenterReadbackSequence: number = 0;
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
    centerPixelDomain?: CenterPixelPassDomain,
    viewProvenance?: unknown,
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
    const resourceGeneration = getPickResourceGeneration(this._context);
    const resourceGenerationChanged =
      resourceGeneration !== this._attachmentResourceGeneration;
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
    if (centerPixelDomain === undefined) {
      this._ordinaryPickViewProvenance = viewProvenance;
    }

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
      deviceChanged ||
      resourceGenerationChanged
    ) {
      this._destroyTextures();
      if (deviceChanged || resourceGenerationChanged) {
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
      this._attachmentResourceGeneration = resourceGeneration;
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
      // Voxel coordinate zero is valid. Clear its dedicated pass to a value
      // outside base-255's representable low-byte domain so a no-command or
      // no-fragment pass cannot masquerade as root tile / sample zero.
      pickClearValue:
        centerPixelDomain === "voxel"
          ? VOXEL_CENTER_PIXEL_CLEAR_VALUE
          : undefined,
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
      resourceGeneration: this._attachmentResourceGeneration,
      attachmentGeneration: this._attachmentGeneration,
      viewProvenance: this._ordinaryPickViewProvenance,
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
      left.resourceGeneration === right.resourceGeneration &&
      left.attachmentGeneration === right.attachmentGeneration &&
      left.viewProvenance === right.viewProvenance
    );
  }

  /**
   * Sync-pick cache gate, fail-closed on any view change. A cached readback is
   * reusable only when it carries the SAME view provenance as the current
   * query — the caller derives that string from the scene mode, morph time,
   * drawing-buffer size, near/far, view and projection matrices, and the pick
   * owner's model matrix and visibility. Any camera movement therefore mints a
   * fresh provenance and this gate declines, so synchronous `end()` returns
   * empty for the whole duration of a motion and only warms once the view is
   * exactly static again.
   *
   * The spatial reprojection below is what remains reachable under that gate:
   * with provenance equal, a cursor that moved WITHIN the previous readback's
   * region still decodes. The cached pixels are tightly packed rows of
   * `cached.logicalWidth` (unpackPickPixels already stripped the GPU copy's
   * 256-byte bytesPerRow padding), so both buffers are indexed in absolute
   * top-down attachment coordinates via their logical origins. Query pixels
   * outside the cached region stay zero, which decodes as no-hit —
   * conservative for the outer spiral taps while keeping the center pixel (the
   * actual cursor) exact.
   *
   * Whether picking SHOULD stay fail-closed through motion, or should instead
   * reuse a spatially-overlapping readback taken under a different view, is an
   * open maintainer decision. Do not relax the provenance comparison without
   * it: the exact gate is what guarantees a returned hit was rendered from the
   * view the caller is asking about.
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
      cached.resourceGeneration !== region.resourceGeneration ||
      cached.attachmentGeneration !== region.attachmentGeneration ||
      cached.viewProvenance !== region.viewProvenance
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
      this._attachmentResourceGeneration !== region.resourceGeneration ||
      this._colorTexture !== colorTexture ||
      this._attachmentGeneration !== region.attachmentGeneration ||
      this._ordinaryPickViewProvenance !== region.viewProvenance ||
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
   * + a frame stamp. A cold query returns `undefined` and arms the readback;
   * the same exact query 1-2 frames later returns the correct value. This
   * replaces the old `_lastReadPixels.slice()` which returned
   * the STALE pixel from the most recent regular scene.pick() COLOR pass.
   */
  readCenterPixel(
    screenSpaceRectangle: CesiumBoundingRectangle,
    domain: CenterPixelPassDomain = "metadata",
    queryIdentityA?: unknown,
    queryIdentityB?: unknown,
    queryVersion?: unknown,
    queryIdentityC?: unknown,
    viewProvenance?: unknown,
  ): Uint8Array | undefined {
    const device = this._device;
    const colorTexture = this._colorTexture;
    if (!device || !colorTexture) {
      return undefined;
    }
    const width = this._pickWidth;
    const height = this._pickHeight;
    const halfWidth = Math.floor(width * 0.5);
    const halfHeight = Math.floor(height * 0.5);

    // Absolute center coordinate within the full-viewport `_colorTexture`.
    // begin() already normalized the rectangle to top-down texture space.
    const px = Math.max(
      0,
      Math.min(this._pickOriginX + halfWidth, this._width - 1),
    );
    const py = Math.max(
      0,
      Math.min(this._pickOriginTopY + halfHeight, this._height - 1),
    );

    const voxelLifecycle = queryIdentityB as
      { contentRevision?: unknown } | undefined;
    const resolvedQueryIdentityC =
      domain === "voxel" && queryIdentityC === undefined
        ? voxelLifecycle?.contentRevision
        : queryIdentityC;
    const identity: CenterPixelReadbackIdentity = {
      domain,
      queryIdentityA,
      queryIdentityB,
      queryIdentityC: resolvedQueryIdentityC,
      queryVersion,
      viewProvenance,
      logicalOriginX: this._pickOriginX,
      logicalOriginTopY: this._pickOriginTopY,
      logicalWidth: width,
      logicalHeight: height,
      pixelX: px,
      pixelY: py,
      device,
      resourceGeneration: getPickResourceGeneration(this._context),
      attachmentGeneration: this._attachmentGeneration,
      colorTexture,
    };

    // Arm/refresh the readback for this center pixel. The guard inside dedupes
    // overlapping requests and swallows teardown races.
    this._readCenterPixelAsync(identity);

    const cached = this._takeCenterPixelCacheEntry(identity);
    if (
      cached &&
      this._updateCount - cached.stamp >= 0 &&
      this._updateCount - cached.stamp <= CENTER_PIXEL_MAX_STALE_FRAMES
    ) {
      return cached.value.slice(0, 4);
    }
    return undefined;
  }

  /**
   * Return this identity's cache entry and promote it to the head of the MRU
   * list. Lookup is a linear scan of at most CENTER_PIXEL_CACHE_CAPACITY
   * entries; a caller reading one identity hits on the first comparison.
   */
  private _takeCenterPixelCacheEntry(
    identity: CenterPixelReadbackIdentity,
  ): CenterPixelCacheEntry | undefined {
    const entries = this._centerPixelCacheEntries;
    for (let i = 0; i < entries.length; ++i) {
      const entry = entries[i];
      if (!this._centerPixelIdentitiesEqual(entry, identity)) {
        continue;
      }
      if (i > 0) {
        entries.splice(i, 1);
        entries.unshift(entry);
      }
      return entry;
    }
    return undefined;
  }

  /**
   * Publish a decoded pixel into this identity's slot, replacing any prior
   * value for the same identity and evicting the least recently used entry once
   * the bound is exceeded.
   */
  private _publishCenterPixelCacheEntry(entry: CenterPixelCacheEntry): void {
    const entries = this._centerPixelCacheEntries;
    for (let i = 0; i < entries.length; ++i) {
      if (this._centerPixelIdentitiesEqual(entries[i], entry)) {
        entries.splice(i, 1);
        break;
      }
    }
    entries.unshift(entry);
    if (entries.length > CENTER_PIXEL_CACHE_CAPACITY) {
      entries.length = CENTER_PIXEL_CACHE_CAPACITY;
    }
  }

  private _centerPixelIdentitiesEqual(
    left: CenterPixelReadbackIdentity,
    right: CenterPixelReadbackIdentity,
  ): boolean {
    return (
      left.domain === right.domain &&
      left.queryIdentityA === right.queryIdentityA &&
      left.queryIdentityB === right.queryIdentityB &&
      left.queryIdentityC === right.queryIdentityC &&
      left.queryVersion === right.queryVersion &&
      left.viewProvenance === right.viewProvenance &&
      left.logicalOriginX === right.logicalOriginX &&
      left.logicalOriginTopY === right.logicalOriginTopY &&
      left.logicalWidth === right.logicalWidth &&
      left.logicalHeight === right.logicalHeight &&
      left.pixelX === right.pixelX &&
      left.pixelY === right.pixelY &&
      left.device === right.device &&
      left.resourceGeneration === right.resourceGeneration &&
      left.attachmentGeneration === right.attachmentGeneration &&
      left.colorTexture === right.colorTexture
    );
  }

  private _centerPixelIdentityIsCurrent(
    identity: CenterPixelReadbackIdentity,
  ): boolean {
    if (
      this._isDestroyed ||
      this._context._device !== identity.device ||
      this._device !== identity.device ||
      this._attachmentDevice !== identity.device ||
      getPickResourceGeneration(this._context) !==
        identity.resourceGeneration ||
      this._attachmentResourceGeneration !== identity.resourceGeneration ||
      this._attachmentGeneration !== identity.attachmentGeneration ||
      this._colorTexture !== identity.colorTexture
    ) {
      return false;
    }
    if (identity.domain !== "voxel") {
      return true;
    }
    const lifecycle = identity.queryIdentityB as
      | {
          atlasReuseEpoch?: unknown;
          detached?: boolean;
          device?: unknown;
          resourceGeneration?: unknown;
          contentRevision?: unknown;
        }
      | undefined;
    return (
      identity.queryIdentityA !== undefined &&
      lifecycle !== undefined &&
      lifecycle?.detached !== true &&
      lifecycle.device === identity.device &&
      lifecycle.resourceGeneration === identity.resourceGeneration &&
      lifecycle.atlasReuseEpoch === identity.queryVersion &&
      lifecycle.contentRevision === identity.queryIdentityC
    );
  }

  /**
   * True only while `requestSequence` is still the newest armed readback for
   * its own identity. A newer request for a DIFFERENT identity no longer
   * cancels this one — that global "latest wins" rule is what starved every
   * identity but the last-armed one.
   */
  private _isLatestCenterPixelRequest(
    identity: CenterPixelReadbackIdentity,
    requestSequence: number,
  ): boolean {
    const pending = this._centerPendingRequests;
    for (let i = 0; i < pending.length; ++i) {
      if (this._centerPixelIdentitiesEqual(pending[i].identity, identity)) {
        return pending[i].requestSequence === requestSequence;
      }
    }
    return false;
  }

  private _finishCenterPixelRequest(requestSequence: number): void {
    const pending = this._centerPendingRequests;
    for (let i = 0; i < pending.length; ++i) {
      if (pending[i].requestSequence === requestSequence) {
        pending.splice(i, 1);
        return;
      }
    }
  }

  /**
   * Asynchronously read a single RGBA8 pixel from `_colorTexture` at the
   * given texture coordinate, caching it for the next synchronous
   * readCenterPixel() call. NEW-PICK-METADATA-READBACK (Batch 285).
   *
   * Uses a fresh staging buffer per readback (destroyed after unmap), so
   * different typed queries may overlap safely. Monotonic request identity
   * prevents an older completion from publishing over a newer request.
   */
  private _readCenterPixelAsync(identity: CenterPixelReadbackIdentity): void {
    if (!this._centerPixelIdentityIsCurrent(identity)) {
      return;
    }
    // Dedupe per identity, not globally: a readback already in flight for THIS
    // identity is the one that will publish, while an unrelated identity's
    // in-flight readback must not suppress this one.
    for (const pending of this._centerPendingRequests) {
      if (this._centerPixelIdentitiesEqual(pending.identity, identity)) {
        return;
      }
    }

    // Stamp with the CURRENT pick count — the pixel decoded below corresponds
    // to the metadata/voxel pass that rendered into `_colorTexture` this pick.
    const requestStamp = this._updateCount;
    const bgra = this._colorFormat === "bgra8unorm";
    const requestSequence = this._nextCenterReadbackSequence++;
    this._centerPendingRequests.push({ identity, requestSequence });
    if (this._centerPendingRequests.length > CENTER_PIXEL_PENDING_CAPACITY) {
      this._centerPendingRequests.shift();
    }
    const { device, colorTexture } = identity;

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
          origin: [identity.pixelX, identity.pixelY, 0],
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
          try {
            if (
              !this._isLatestCenterPixelRequest(identity, requestSequence) ||
              !this._centerPixelIdentityIsCurrent(identity)
            ) {
              return;
            }
            const data = new Uint8Array(buffer.getMappedRange(0, 4));
            // Normalize to [R,G,B,A] regardless of the texture's byte order so
            // downstream decoders see the same layout as WebGL readPixels.
            const value = bgra
              ? new Uint8Array([data[2], data[1], data[0], data[3]])
              : new Uint8Array([data[0], data[1], data[2], data[3]]);
            this._publishCenterPixelCacheEntry({
              ...identity,
              value,
              stamp: requestStamp,
              requestSequence,
            });
          } finally {
            try {
              buffer.unmap();
            } catch {
              // Teardown may destroy a mapped buffer before this callback.
            }
            buffer.destroy();
            this._finishCenterPixelRequest(requestSequence);
          }
        })
        .catch(() => {
          buffer.destroy();
          this._finishCenterPixelRequest(requestSequence);
        });
    } catch {
      if (stagingBuffer) {
        stagingBuffer.destroy();
      }
      this._finishCenterPixelRequest(requestSequence);
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
    const frameContext = this._context as CesiumGraphicsContext & {
      currentCommandEncoder?: GPUCommandEncoder | null;
      enqueueAfterFrameSubmit?: (
        callback: (submitted: boolean) => void,
      ) => boolean;
    };
    const encoder = frameContext.currentCommandEncoder;
    if (
      !encoder ||
      typeof frameContext.enqueueAfterFrameSubmit !== "function"
    ) {
      return;
    }

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

    // The copy belongs to the SAME encoder as the pick draw. Starting a
    // private submit here would run before Picking.completePickFrame submits
    // that encoder, copying the previous pass's bytes and falsely labelling
    // them with this request's view provenance. Map only after endFrame has
    // submitted the draw+copy command buffer in-order.
    const accepted = frameContext.enqueueAfterFrameSubmit((submitted) => {
      if (!submitted) {
        this._readbackInFlight = false;
        return;
      }

      // Fire-and-forget async mapping — result will be used by a later
      // synchronous pick. The destroyed guard catches the tab-close /
      // viewer-teardown race between mapAsync and resolution.
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
              // The attachment/device generation changed while the copy was
              // in flight. Its bytes cannot warm the replacement target.
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
    });
    this._readbackInFlight = accepted;
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

  private _invalidateCenterPixelReadback(): void {
    this._centerPixelCache = null;
    this._centerPendingIdentity = null;
    this._centerPendingRequestSequence = -1;
    // Reserve a sequence that no outstanding request captured. Older
    // completions then fail the latest-request check without touching state
    // belonging to a replacement attachment.
    this._latestCenterReadbackSequence = this._nextCenterReadbackSequence++;
  }

  private _destroyTextures(): void {
    this._invalidateCenterPixelReadback();
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
    this._attachmentResourceGeneration = -1;
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
    // R-2b UNIFIED-FEATURE-ID-TEXTURE — release the resolve helper's output
    // texture + pipeline if one was ever constructed.
    if (this._featureIdTexture) {
      this._featureIdTexture.destroy();
      this._featureIdTexture = null;
    }
  }
}

export default WebGPUPickFramebuffer;
