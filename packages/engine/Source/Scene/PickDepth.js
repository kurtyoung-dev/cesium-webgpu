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

    // WebGPU async depth state
    this._lastDepthValue = undefined;
    this._webgpuDepthTexture = undefined;
    this._depthStagingBuffer = null;
    this._pendingReadback = false;
  }

  get framebuffer() {
    return this._framebuffer.framebuffer;
  }

  update(context, depthTexture) {
    // WebGPU path — store reference to the packed-depth RGBA texture
    if (context.isWebGPU) {
      this._webgpuDepthTexture = depthTexture;
      return;
    }
    updateFramebuffers(this, context, depthTexture);
    updateCopyCommands(this, context, depthTexture);
  }

  /**
   * Read the depth from the framebuffer at the given coordinate (sync).
   * Returns `undefined` for WebGPU contexts — use {@link getDepthAsync}.
   *
   * @param {Context} context
   * @param {number} x The x-coordinate at which to read the depth.
   * @param {number} y The y-coordinate at which to read the depth.
   * @returns {number|undefined} The depth read from the framebuffer.
   * @private
   */
  getDepth(context, x, y) {
    // WebGPU: sync readback not possible — return cached value or undefined
    if (context.isWebGPU) {
      return this._lastDepthValue;
    }

    if (!defined(this.framebuffer)) {
      return undefined;
    }

    const pixels = context.readPixels({
      x: x,
      y: y,
      width: 1,
      height: 1,
      framebuffer: this.framebuffer,
    });

    const packedDepth = Cartesian4.unpack(pixels, 0, scratchPackedDepth);
    Cartesian4.divideByScalar(packedDepth, 255.0, packedDepth);
    return Cartesian4.dot(packedDepth, packedDepthScale);
  }

  /**
   * Asynchronously read depth from a WebGPU packed-depth-as-color texture
   * at the given coordinate. Copies a 1×1 pixel to a staging buffer via
   * copyTextureToBuffer + mapAsync, then unpacks RGBA → float depth.
   *
   * @param {object} context The graphics context (WebGPU).
   * @param {number} x The x-coordinate at which to read the depth.
   * @param {number} y The y-coordinate at which to read the depth.
   * @returns {Promise<number|undefined>} The depth value, or undefined if unavailable.
   * @private
   */
  async getDepthAsync(context, x, y) {
    if (!context.isWebGPU) {
      return this.getDepth(context, x, y);
    }

    const packedTexture = this._webgpuDepthTexture;
    if (!defined(packedTexture)) {
      return this._lastDepthValue;
    }

    const device = context._device;
    if (!device) {
      return this._lastDepthValue;
    }

    // Avoid overlapping readbacks
    if (this._pendingReadback) {
      return this._lastDepthValue;
    }

    // Clamp coordinates to texture bounds
    const texWidth = packedTexture.width;
    const texHeight = packedTexture.height;
    const px = Math.max(0, Math.min(Math.floor(x), texWidth - 1));
    const py = Math.max(0, Math.min(Math.floor(y), texHeight - 1));

    // Ensure staging buffer exists (reuse across frames)
    if (!this._depthStagingBuffer) {
      this._depthStagingBuffer = device.createBuffer({
        label: "PickDepth staging",
        size: STAGING_BUFFER_SIZE,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
    }

    this._pendingReadback = true;

    try {
      // Copy 1 pixel from the packed-depth-as-color texture to staging buffer
      const encoder = device.createCommandEncoder({
        label: "PickDepth readback",
      });
      encoder.copyTextureToBuffer(
        {
          texture: packedTexture,
          origin: { x: px, y: py, z: 0 },
        },
        {
          buffer: this._depthStagingBuffer,
          bytesPerRow: STAGING_BUFFER_SIZE, // must be ≥256 for WebGPU alignment
          rowsPerImage: 1,
        },
        { width: 1, height: 1, depthOrArrayLayers: 1 },
      );
      device.queue.submit([encoder.finish()]);

      // Map and read the pixel
      await this._depthStagingBuffer.mapAsync(GPUMapMode.READ, 0, 4);
      const data = new Uint8Array(
        this._depthStagingBuffer.getMappedRange(0, 4),
      );
      const depth = unpackDepthFromRGBA(data[0], data[1], data[2], data[3]);
      this._depthStagingBuffer.unmap();

      this._lastDepthValue = depth;
      this._pendingReadback = false;
      return depth;
    } catch (e) {
      // Buffer may have been destroyed or device lost
      this._pendingReadback = false;
      return this._lastDepthValue;
    }
  }

  executeCopyDepth(context, passState) {
    // WebGPU doesn't use the GLSL copy command
    if (context.isWebGPU) {
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
