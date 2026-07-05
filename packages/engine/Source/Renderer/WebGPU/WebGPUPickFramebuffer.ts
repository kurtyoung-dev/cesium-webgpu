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
 * (they target `context.scenePipelineFormat`), otherwise WebGPU drops every
 * pick draw with "Attachment state of [RenderPipeline] is not compatible with
 * [RenderPassEncoder Pick render pass]" and the pick FBO stays empty — the
 * actual cause of FORK-34 (all picking returns undefined). Only 8-bit unorm
 * formats support the byte-readback path below; an HDR/float scene format
 * falls back to rgba8unorm here (HDR pick needs LDR pick pipelines — a
 * separate follow-up; the mismatch only re-appears in HDR mode).
 * @private
 */
function pickColorFormat(context: CesiumGraphicsContext): GPUTextureFormat {
  const f = (context as unknown as { scenePipelineFormat?: GPUTextureFormat })
    ?.scenePipelineFormat;
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

      // A pick hit is any pixel whose reconstructed key (RGB, little-endian)
      // is nonzero. Pick-ID colors come from `Color.fromRgba(key)`, which
      // packs the incrementing integer key into the bytes low-to-high on a
      // little-endian host: red = key & 0xff, green = (key >> 8) & 0xff,
      // blue = (key >> 16) & 0xff, ALPHA = (key >> 24) & 0xff. So every pick
      // id below 2^24 (i.e. essentially all of them) has alpha 0. The old
      // `a > 0` gate therefore rejected virtually every real pick — the true
      // cause of FORK-34 once the pick pass itself was fixed. The cleared
      // pick FBO is (0,0,0,0) → key 0, which `getObjectByPickColor` maps to
      // undefined (pick ids start at 1), so "RGB != 0" is the correct
      // "something was drawn here" test and matches WebGL's decode.
      if (r !== 0 || g !== 0 || b !== 0) {
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

export class WebGPUPickFramebuffer {
  private _context: CesiumGraphicsContext;
  private _device: GPUDevice | null = null;
  private _colorTexture: GPUTexture | null = null;
  private _depthTexture: GPUTexture | null = null;
  private _width: number = 0;
  private _height: number = 0;
  // Pick color attachment format — must match the pick pipelines
  // (context.scenePipelineFormat). Recreated when it changes (e.g. HDR toggle).
  private _colorFormat: GPUTextureFormat = "rgba8unorm";
  private _passState: CesiumPassState;
  private _isDestroyed: boolean = false;

  // Cached texture views — recreated only when textures are reallocated on
  // resize. begin() used to call createView() on every frame which leaked
  // ~60 view objects/sec under continuous picking.
  private _colorView: GPUTextureView | null = null;
  private _depthView: GPUTextureView | null = null;

  // Staging buffer for color readback
  private _stagingBuffer: GPUBuffer | null = null;
  private _stagingBufferSize: number = 0;
  private _lastReadPixels: Uint8Array | null = null;

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

  // Origin of the current pick rectangle within the full-viewport color
  // texture. Captured in begin() and consumed by the copyTextureToBuffer
  // calls in end / endAsync / _startReadback so the copy reads the pixels
  // the scene actually rendered into (the scissor region) rather than the
  // top-left corner of the FBO. Without this, picking only returned results
  // when clicks happened near (0, 0) on the canvas.
  private _pickOriginX: number = 0;
  private _pickOriginY: number = 0;

  // Depth readback resources (separate depth32float target for copyable depth)
  private _readableDepthTexture: GPUTexture | null = null;
  private _depthStagingBuffer: GPUBuffer | null = null;

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
    const device = this._context._device;
    if (!device) {
      return this._passState;
    }
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

    // Record the scissor origin so readback paths copy from the right region
    // of the full-viewport color texture (see _pickOriginX/Y field comment).
    this._pickOriginX = Math.max(0, Math.floor(screenSpaceRectangle.x ?? 0));
    this._pickOriginY = Math.max(0, Math.floor(screenSpaceRectangle.y ?? 0));

    // The pick color attachment MUST match the pick pipelines' target format
    // (context.scenePipelineFormat) or WebGPU drops every pick draw — FORK-34.
    const colorFormat = pickColorFormat(this._context);

    // Create or recreate render targets
    if (
      width !== this._width ||
      height !== this._height ||
      colorFormat !== this._colorFormat
    ) {
      this._destroyTextures();
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
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });

      // Separate depth32float texture for readable depth (pickPosition).
      // depth24plus-stencil8 cannot be copied — depth32float can.
      this._readableDepthTexture = device.createTexture({
        label: "Pick readable depth texture (depth32float)",
        size: [width, height],
        format: "depth32float",
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      });

      this._width = width;
      this._height = height;

      // Cache texture views once per resize — see field comment above.
      this._colorView = this._colorTexture.createView();
      this._depthView = this._depthTexture.createView();

      // Create staging buffer for readback
      // Row alignment: WebGPU requires rows to be aligned to 256 bytes
      const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
      const bufferSize = bytesPerRow * height;
      if (bufferSize !== this._stagingBufferSize) {
        if (this._stagingBuffer) {
          this._stagingBuffer.destroy();
        }
        this._stagingBuffer = device.createBuffer({
          label: "Pick staging buffer",
          size: bufferSize,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });
        this._stagingBufferSize = bufferSize;
        // Any in-flight readback is now targeting the destroyed buffer; its
        // .then() will hit the identity guard. Clear the flag so we don't
        // gate the new buffer's first readback on the dead one.
        this._readbackInFlight = false;
      }
    }

    // Store the pick framebuffer info so the context can use it
    this._passState.framebuffer = {
      _isWebGPUPickFBO: true,
      colorTexture: this._colorTexture,
      depthTexture: this._depthTexture,
      colorView: this._colorView ?? undefined,
      depthView: this._depthView ?? undefined,
      width: this._width,
      height: this._height,
    };

    this._passState.viewport.width = width;
    this._passState.viewport.height = height;

    return this._passState;
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

    if (!device || !this._colorTexture || !this._stagingBuffer) {
      return [];
    }

    const width = screenSpaceRectangle.width ?? 1;
    const height = screenSpaceRectangle.height ?? 1;

    // Start async readback for the current frame
    this._startReadback(width, height);

    // Return previous frame's results if available
    if (this._lastReadPixels) {
      return pickObjectsFromPixels(
        context,
        this._lastReadPixels,
        width,
        height,
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

    if (!device || !this._colorTexture || !this._stagingBuffer) {
      return [];
    }

    const width = screenSpaceRectangle.width ?? 1;
    const height = screenSpaceRectangle.height ?? 1;

    // Copy texture to staging buffer
    const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
    const encoder = device.createCommandEncoder({
      label: "Pick readback encoder",
    });

    encoder.copyTextureToBuffer(
      {
        texture: this._colorTexture!,
        // Read from the pick region, not the top-left corner — and convert
        // the vertical origin (METADATA-TABLE-SOURCES, same conversion as
        // readCenterPixel / C-R9-VOXEL-CELL-PICK): the caller's rectangle is
        // GL-convention (`y` measured from the BOTTOM, per
        // computePickingDrawingBufferRectangle) while `_colorTexture` is
        // stored TOP-DOWN. Copying at the unconverted `y` read the
        // vertically MIRRORED region — center-screen picks are
        // self-symmetric, which is how the bug hid; every off-vertical-
        // center pick resolved the wrong object.
        origin: [
          this._pickOriginX,
          this._flipPickOriginY(this._pickOriginY, height),
          0,
        ],
      },
      {
        buffer: this._stagingBuffer!,
        bytesPerRow,
        rowsPerImage: height,
      },
      [width, height],
    );

    device.queue.submit([encoder.finish()]);

    // Wait for GPU to finish and map the buffer. Guard against destruction
    // during the await — viewer teardown can race here.
    const stagingBuffer = this._stagingBuffer!;
    await stagingBuffer.mapAsync(GPUMapMode.READ);
    if (this._isDestroyed || this._stagingBuffer !== stagingBuffer) {
      return [];
    }
    const mappedData = new Uint8Array(stagingBuffer.getMappedRange());

    // Copy data accounting for row padding
    const pixels = new Uint8Array(width * height * 4);
    for (let row = 0; row < height; row++) {
      const srcOffset = row * bytesPerRow;
      const dstOffset = row * width * 4;
      pixels.set(
        mappedData.subarray(srcOffset, srcOffset + width * 4),
        dstOffset,
      );
    }

    stagingBuffer.unmap();
    this._lastReadPixels = pixels;

    return pickObjectsFromPixels(
      context,
      pixels,
      width,
      height,
      limit,
      this._colorFormat === "bgra8unorm",
    );
  }

  /**
   * METADATA-TABLE-SOURCES — convert the pick rectangle's GL-convention
   * bottom-origin row (`computePickingDrawingBufferRectangle` measures `y`
   * from the BOTTOM because WebGL's `readPixels` is bottom-origin) to the
   * top-down row of `_colorTexture` for a copy of `height` rows. The visual
   * region rows are `[H - (y + height), H - y)`. Clamped so a rectangle
   * hugging the screen edge can't produce a negative / out-of-bounds copy
   * origin. Sibling of the single-pixel conversion in
   * {@link readCenterPixel} (C-R9-VOXEL-CELL-PICK).
   */
  private _flipPickOriginY(glOriginY: number, height: number): number {
    const flipped = this._height - glOriginY - height;
    return Math.max(0, Math.min(flipped, Math.max(0, this._height - height)));
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
    const width = screenSpaceRectangle.width ?? 1;
    const height = screenSpaceRectangle.height ?? 1;
    const halfWidth = Math.floor(width * 0.5);
    const halfHeight = Math.floor(height * 0.5);

    // Absolute center coordinate within the full-viewport `_colorTexture`:
    // the pick rectangle starts at (pickOriginX, pickOriginY) and the center
    // pixel sits (halfWidth, halfHeight) inside it (matches the JS path's
    // `4 * (halfHeight * width + halfWidth)` slice into a rect-local buffer).
    const px = this._pickOriginX + halfWidth;
    // C-R9-VOXEL-CELL-PICK — vertical-origin conversion. The caller's
    // rectangle comes from `computePickingDrawingBufferRectangle`, which is
    // GL-convention (`y` measured from the BOTTOM: `drawingBufferHeight -
    // pos.y - ...`) because WebGL's `readPixels` is bottom-origin. The WebGPU
    // `_colorTexture` is stored TOP-DOWN (row 0 = top of the frame), so the
    // GL row must be converted to the visual row WebGL actually reads:
    // WebGL's readCenterPixel returns visual row `H - 1 - (rect.y +
    // halfHeight)`, which IS the top-down texture row here. Without this
    // flip every off-vertical-center metadata/voxel pick read the MIRRORED
    // pixel (center-screen picks are self-symmetric, which is how the bug
    // hid through the Batch 285 probes).
    const py = this._height - 1 - (this._pickOriginY + halfHeight);

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
   * Start an async readback without waiting for the result.
   * The result will be available in the next frame via _lastReadPixels.
   */
  private _startReadback(width: number, height: number): void {
    const device = this._device;
    if (!device || !this._colorTexture || !this._stagingBuffer) {
      return;
    }
    // Skip if the previous frame's mapAsync hasn't unmapped yet — the
    // staging buffer is still mapping-pending or mapped, and submitting
    // a copy that targets it throws "used in submit while mapped".
    if (this._readbackInFlight) {
      return;
    }
    if (!(width > 0) || !(height > 0)) {
      return;
    }

    const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
    const encoder = device.createCommandEncoder({
      label: "Pick readback encoder (async)",
    });

    encoder.copyTextureToBuffer(
      {
        texture: this._colorTexture!,
        // Copy from the pick region (see the paired comment on the async
        // readback path above), with the same GL-bottom-origin → top-down
        // vertical conversion (METADATA-TABLE-SOURCES).
        origin: [
          this._pickOriginX,
          this._flipPickOriginY(this._pickOriginY, height),
          0,
        ],
      },
      {
        buffer: this._stagingBuffer!,
        bytesPerRow,
        rowsPerImage: height,
      },
      [width, height],
    );

    device.queue.submit([encoder.finish()]);

    // Fire-and-forget async mapping — result will be used next frame.
    // The destroyed-guard catches the tab-close / viewer-teardown race
    // where destroy() runs between mapAsync() initiation and resolution
    // (would otherwise throw "cannot read getMappedRange of destroyed
    // buffer" on the unmap path).
    const stagingBuffer = this._stagingBuffer!;
    this._readbackInFlight = true;
    stagingBuffer
      .mapAsync(GPUMapMode.READ)
      .then(() => {
        if (this._isDestroyed || this._stagingBuffer !== stagingBuffer) {
          // Either the framebuffer was destroyed or the staging buffer
          // got swapped on resize. Either way, the buffer we mapped is
          // either gone or no longer canonical — skip.
          this._readbackInFlight = false;
          return;
        }
        const mappedData = new Uint8Array(stagingBuffer.getMappedRange());

        const pixels = new Uint8Array(width * height * 4);
        for (let row = 0; row < height; row++) {
          const srcOffset = row * bytesPerRow;
          const dstOffset = row * width * 4;
          pixels.set(
            mappedData.subarray(srcOffset, srcOffset + width * 4),
            dstOffset,
          );
        }

        stagingBuffer.unmap();
        this._lastReadPixels = pixels;
        this._readbackInFlight = false;
      })
      .catch(() => {
        // Readback failed, likely buffer already mapped or destroyed
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
    if (!this._depthStagingBuffer) {
      this._depthStagingBuffer = device.createBuffer({
        label: "Pick depth staging buffer",
        size: bufferSize,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
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
   * Get the readable depth texture view for use as a second depth attachment.
   * Scene renderers can attach this alongside the primary stencil depth.
   */
  get readableDepthView(): GPUTextureView | null {
    return this._readableDepthTexture?.createView() ?? null;
  }

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
    this._colorView = null;
    this._depthView = null;
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
    if (this._depthStagingBuffer) {
      this._depthStagingBuffer.destroy();
      this._depthStagingBuffer = null;
    }
    this._lastReadPixels = null;
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
