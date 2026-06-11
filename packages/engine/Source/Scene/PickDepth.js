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
 * Uses the same dot-product unpacking as the WebGL path.
 * @private
 */
function unpackDepthFromRGBA(r, g, b, a) {
  scratchPackedDepth.x = r;
  scratchPackedDepth.y = g;
  scratchPackedDepth.z = b;
  scratchPackedDepth.w = a;
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

    // Async depth readback state (used when sync readPixels is unavailable)
    this._lastDepthValue = undefined;
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
      // Async path: store packed-depth RGBA texture for buffer readback
      this._asyncDepthTexture = depthTexture;
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

    // WebGPU async path. Two contracts matter here:
    //  1. EVERY consumer of getDepth is SYNCHRONOUS and cannot await it:
    //     scene.pickPosition / scene.pickPositionWorldCoordinates
    //     (Picking.js:608, Scene.js:4069) AND camera zoom/tilt-to-cursor
    //     (CameraHelpers.js:247, SSCCInputHelpers.js:65). So this must return a
    //     number|undefined — NEVER a Promise (a Promise silently broke all of
    //     them: callers treated the Promise object as a depth value).
    //  2. The reconstruction is NOT yet correct on WebGPU. All frustums share
    //     the single packed `globeDepth.globeDepthTexture`
    //     (WebGPUSceneRendererFrustumLoop.ts:641), but `unprojectDepth` rebuilds
    //     the world position with each frustum's OWN near/far — so the depth's
    //     frustum-space doesn't match the reconstruction and the result is a
    //     garbage world position (e.g. the antipode at ~85,000 km). A garbage
    //     position is WORSE than undefined (camera-to-cursor would jump to it).
    //
    // Until per-frustum WebGPU pick-depth reconstruction lands
    // (DEFERRED_WORK: NEW-PICK-WEBGPU-DEPTH-RECONSTRUCTION), return undefined so
    // callers fall back to ray pick — the same safe result as before, but now
    // via the correct async architecture (the WebGL pick framebuffer is no
    // longer wrongly allocated on WebGPU, and InstancingPipelineStage keeps the
    // typed array WebGPU instanced models need). `_readDepthAsync` +
    // `_lastDepthValue` are the scaffolding that fix switches on.
    return undefined;
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

    // Clamp coordinates to texture bounds
    const texWidth = packedTexture.width;
    const texHeight = packedTexture.height;
    const px = Math.max(0, Math.min(Math.floor(x), texWidth - 1));
    const py = Math.max(0, Math.min(Math.floor(y), texHeight - 1));

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
      const depth = unpackDepthFromRGBA(data[0], data[1], data[2], data[3]);
      stagingBuffer.unmap();
      stagingBuffer.destroy();

      this._lastDepthValue = depth;
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
