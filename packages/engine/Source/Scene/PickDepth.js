import Cartesian4 from "../Core/Cartesian4.js";
import defined from "../Core/defined.js";
import destroyObject from "../Core/destroyObject.js";
import FramebufferManager from "../Renderer/FramebufferManager.js";
import RenderState from "../Renderer/RenderState.js";

const scratchPackedDepth = new Cartesian4();
const packedDepthScale = new Cartesian4(
  1.0,
  1.0 / 255.0,
  1.0 / 65025.0,
  1.0 / 16581375.0,
);

// Staging buffer size: 256 bytes (minimum alignment for WebGPU buffer mapping)
const STAGING_BUFFER_SIZE = 256;

// Sync-cache validity window for the async (WebGPU) getDepth path. The
// cached value is only
// returned when the query is within this many pixels of the readback's
// coordinate (depth varies slowly across adjacent globe pixels; a moving
// cursor re-arms the readback and converges next frame)...
const ASYNC_DEPTH_COORD_TOLERANCE = 4;
// ...and when no more than this many frames have rendered since the readback
// was armed. Staleness is counted in RENDERED frames (update() calls), not
// wall time, so requestRenderMode / paused scenes keep a valid cache
// indefinitely — depth can't change without a render. A short window bounds
// how far a continuously-moving camera can drift from the cached value
// (one-frame-stale is the contract; a few frames is the tolerance).
const ASYNC_DEPTH_MAX_STALE_FRAMES = 4;

function updateFramebuffers(pickDepth, context, depthTexture) {
  const { width, height } = depthTexture;
  pickDepth._framebuffer.update(context, width, height);
}

function updateCopyCommands(pickDepth, context, depthTexture) {
  if (!defined(pickDepth._copyDepthCommand)) {
    pickDepth._copyDepthCommand = context.createViewportQuadCommand(
      `uniform highp sampler2D colorTexture;

in vec2 v_textureCoordinates;

void main()
{
  vec4 globeDepthPacked = texture(czm_globeDepthTexture, v_textureCoordinates);
  float globeDepth = czm_unpackDepth(globeDepthPacked);
  float depth = texture(colorTexture, v_textureCoordinates).r;
  out_FragColor = czm_branchFreeTernary(globeDepth <= 0.0 || globeDepth >= 1.0 || depth < globeDepth && depth > 0.0 && depth < 1.0,
    czm_packDepth(depth), globeDepthPacked);
}
`,
      {
        renderState: RenderState.fromCache(),
        uniformMap: {
          colorTexture: function () {
            return pickDepth._textureToCopy;
          },
        },
        owner: pickDepth,
      },
    );
  }

  pickDepth._textureToCopy = depthTexture;
  pickDepth._copyDepthCommand.framebuffer = pickDepth.framebuffer;
}

/**
 * Unpack a depth value from RGBA bytes (matching the WebGPUGlobeDepth
 * packing: r = floor(d*255)/255, g = frac*255 portion, b = deeper frac).
 * Uses the same dot-product unpacking as the WebGL path, except the alpha
 * channel: WebGPUGlobeDepth's pack shader writes only THREE channels
 * (a = 1.0 constant), so including `a` would add a constant one-quantum
 * (~6e-8) bias that pushes far-plane depth (1.0 exactly) above the
 * `depth >= 1.0` sky rejection threshold's intent. Zero it out.
 * @private
 */
function unpackDepthFromRGBA(r, g, b) {
  scratchPackedDepth.x = r;
  scratchPackedDepth.y = g;
  scratchPackedDepth.z = b;
  scratchPackedDepth.w = 0.0;
  Cartesian4.divideByScalar(scratchPackedDepth, 255.0, scratchPackedDepth);
  return Cartesian4.dot(scratchPackedDepth, packedDepthScale);
}

/**
 * Manages depth buffer readback for position picking.
 *
 * For WebGL: copies the scene depth texture to a color FBO via a shader that
 * packs depth into RGBA, then reads the color pixel and unpacks to a float.
 *
 * For WebGPU: receives packed-depth-as-color texture (RGBA8) from
 * WebGPUGlobeDepth, copies a single pixel to a staging buffer via
 * copyTextureToBuffer + mapAsync, and unpacks RGBA → float.
 *
 * @alias PickDepth
 * @private
 */
class PickDepth {
  constructor() {
    this._framebuffer = new FramebufferManager();
    this._textureToCopy = undefined;
    this._copyDepthCommand = undefined;

    // Async depth readback state (used when sync readPixels is unavailable).
    // `_lastDepthValue` is the one-frame-stale sync cache that bridges the
    // async GPU readback to getDepth's synchronous consumers; the coordinate
    // + frame stamp bound its validity (see getDepth).
    this._lastDepthValue = undefined;
    this._lastDepthX = -1;
    this._lastDepthY = -1;
    this._lastDepthStamp = -1;
    this._updateCount = 0;
    this._asyncDepthTexture = undefined;
    this._depthStagingBuffer = null;
    this._pendingReadback = false;
  }

  get framebuffer() {
    return this._framebuffer.framebuffer;
  }

  update(context, depthTexture) {
    // If context supports SYNCHRONOUS readback (WebGL), use the framebuffer +
    // readPixels path. Otherwise (WebGPU) store the packed-depth texture for
    // async buffer readback. NOTE: must branch on `supportsSynchronousReadback`,
    // NOT `defined(context.readPixels)` — `readPixels` is a required abstract
    // method BOTH backends implement (WebGPU's returns null), so `defined()`
    // is true on WebGPU and wrongly took the sync branch, leaving
    // `_asyncDepthTexture` unset → pickPosition/sampleHeight/clampToHeight
    // returned undefined on WebGPU.
    if (context.supportsSynchronousReadback) {
      updateFramebuffers(this, context, depthTexture);
      updateCopyCommands(this, context, depthTexture);
    } else {
      // Async path: store packed-depth RGBA texture for buffer readback.
      // The update count is the staleness clock for the sync cache — it
      // advances once per RENDERED frame (the WebGPU frustum loop calls
      // update() once per frame per PickDepth instance), so cache age is
      // measured in renders, not wall time.
      this._asyncDepthTexture = depthTexture;
      this._updateCount++;
    }
  }

  /**
   * Read the depth at the given coordinate. Uses sync readPixels when
   * available (WebGL), otherwise returns a cached async value and kicks
   * off a background readback for the next frame.
   *
   * @param {Context} context
   * @param {number} x The x-coordinate at which to read the depth.
   * @param {number} y The y-coordinate at which to read the depth.
   * @returns {number|undefined} The depth read from the framebuffer.
   * @private
   */
  getDepth(context, x, y) {
    // Sync path: framebuffer + readPixels (WebGL). Gate on the capability,
    // not `defined(context.readPixels)` (see update() — WebGPU defines it too).
    if (defined(this.framebuffer) && context.supportsSynchronousReadback) {
      const pixels = context.readPixels({
        x: x,
        y: y,
        width: 1,
        height: 1,
        framebuffer: this.framebuffer,
      });

      // On WebGPU `context.readPixels` is a stub that returns undefined
      // because the underlying readback is async-only. Fall through to
      // the async path instead of crashing in Cartesian4.unpack.
      if (defined(pixels) && pixels.length >= 4) {
        const packedDepth = Cartesian4.unpack(pixels, 0, scratchPackedDepth);
        Cartesian4.divideByScalar(packedDepth, 255.0, packedDepth);
        return Cartesian4.dot(packedDepth, packedDepthScale);
      }
    }

    // WebGPU async path. The contract:
    //  1. Every consumer of getDepth is synchronous and cannot await it:
    //     scene.pickPosition / scene.pickPositionWorldCoordinates
    //     (Picking.js, Scene.js) and camera zoom/tilt-to-cursor
    //     (CameraHelpers.js, SSCCInputHelpers.js). So this returns a
    //     number|undefined — never a Promise (a Promise silently breaks all
    //     of them: callers would treat the Promise object as a depth value).
    //  2. GPU buffer mapping cannot resolve within the calling frame, so the
    //     value returned is the one-frame-stale cached result of an earlier
    //     call's readback. The first query at a new location returns
    //     undefined (callers fall back to ray picking, which stays correct)
    //     and arms the readback; queries converge 1-2 frames later.
    //  3. The cached value is only trusted near the readback's own pixel and
    //     for a few rendered frames (see the ASYNC_DEPTH_* constants) so a
    //     long-dead readback can't anchor camera-to-cursor to garbage.
    //
    // The value itself is full-frustum log depth (the shared packed
    // `globeDepth.globeDepthTexture` — every WebGPU depth producer encodes
    // against the full camera frustum). The matching reconstruction lives
    // in Picking.pickPositionWorldCoordinates, gated on
    // `context.pickDepthFullFrustumLogEncode`.
    if (!defined(this._asyncDepthTexture)) {
      return undefined;
    }

    // Arm/refresh the background readback for this coordinate. Errors are
    // swallowed inside (_pendingReadback also dedupes overlapping requests).
    this._readDepthAsync(context, x, y);

    const cached = this._lastDepthValue;
    if (!defined(cached)) {
      return undefined;
    }
    if (
      Math.abs(x - this._lastDepthX) > ASYNC_DEPTH_COORD_TOLERANCE ||
      Math.abs(y - this._lastDepthY) > ASYNC_DEPTH_COORD_TOLERANCE
    ) {
      return undefined;
    }
    if (
      this._updateCount - this._lastDepthStamp >
      ASYNC_DEPTH_MAX_STALE_FRAMES
    ) {
      return undefined;
    }
    return cached;
  }

  /**
   * Asynchronously read depth from a packed-depth-as-color texture at the
   * given coordinate. Copies a 1x1 pixel to a staging buffer via
   * copyTextureToBuffer + mapAsync, then unpacks RGBA -> float depth.
   * Updates _lastDepthValue for the next sync getDepth() call.
   *
   * @param {object} context The graphics context.
   * @param {number} x The x-coordinate at which to read the depth.
   * @param {number} y The y-coordinate at which to read the depth.
   * @private
   */
  async _readDepthAsync(context, x, y) {
    const packedTexture = this._asyncDepthTexture;
    if (!defined(packedTexture)) {
      return undefined;
    }

    const device = context._device;
    if (!device) {
      return undefined;
    }

    // Avoid overlapping readbacks — return last known value
    if (this._pendingReadback) {
      return this._lastDepthValue;
    }

    // Clamp coordinates to texture bounds. Callers pass bottom-left-origin
    // coordinates (Picking.js flips `drawingBufferPosition.y` for WebGL's
    // readPixels convention before calling getDepth), but the packed depth
    // texture is screen-oriented (row 0 = top of screen) and WebGPU's
    // copyTextureToBuffer origin is top-left — flip y back.
    const texWidth = packedTexture.width;
    const texHeight = packedTexture.height;
    const px = Math.max(0, Math.min(Math.floor(x), texWidth - 1));
    const py =
      texHeight - 1 - Math.max(0, Math.min(Math.floor(y), texHeight - 1));

    // Stamp the request with the CURRENT update count — the depth decoded
    // below corresponds to the texture content as of this frame, and the
    // staleness window in getDepth is measured from here.
    const requestStamp = this._updateCount;

    this._pendingReadback = true;

    try {
      // Create a fresh staging buffer each readback to avoid "still mapped"
      // errors from overlapping mapAsync calls. The old buffer is destroyed
      // after unmap to prevent GPU memory leaks.
      const stagingBuffer = device.createBuffer({
        label: "Pick staging buffer",
        size: STAGING_BUFFER_SIZE,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });

      const encoder = device.createCommandEncoder({
        label: "PickDepth readback",
      });
      encoder.copyTextureToBuffer(
        {
          texture: packedTexture,
          origin: { x: px, y: py, z: 0 },
        },
        {
          buffer: stagingBuffer,
          bytesPerRow: STAGING_BUFFER_SIZE,
          rowsPerImage: 1,
        },
        { width: 1, height: 1, depthOrArrayLayers: 1 },
      );
      device.queue.submit([encoder.finish()]);

      await stagingBuffer.mapAsync(GPUMapMode.READ, 0, 4);
      const data = new Uint8Array(stagingBuffer.getMappedRange(0, 4));
      const depth = unpackDepthFromRGBA(data[0], data[1], data[2]);
      stagingBuffer.unmap();
      stagingBuffer.destroy();

      this._lastDepthValue = depth;
      // Cache validity key: the BOTTOM-LEFT-origin coordinates the caller
      // queried with (getDepth compares against the same convention).
      this._lastDepthX = x;
      this._lastDepthY = y;
      this._lastDepthStamp = requestStamp;
      this._pendingReadback = false;
      return depth;
    } catch (e) {
      // Buffer may have been destroyed or device lost
      this._pendingReadback = false;
      return undefined;
    }
  }

  executeCopyDepth(context, passState) {
    if (!defined(this._copyDepthCommand)) {
      return;
    }
    this._copyDepthCommand.execute(context, passState);
  }

  isDestroyed() {
    return false;
  }

  destroy() {
    this._framebuffer.destroy();
    if (defined(this._copyDepthCommand)) {
      this._copyDepthCommand.shaderProgram =
        defined(this._copyDepthCommand.shaderProgram) &&
        this._copyDepthCommand.shaderProgram.destroy();
    }

    if (this._depthStagingBuffer) {
      this._depthStagingBuffer.destroy();
      this._depthStagingBuffer = null;
    }

    return destroyObject(this);
  }
}

export default PickDepth;
