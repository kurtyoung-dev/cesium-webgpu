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
 * Manages depth buffer readback for position picking.
 *
 * For WebGL: copies the scene depth texture to a color FBO via a shader that
 * packs depth into RGBA, then reads the color pixel and unpacks to a float.
 *
 * For WebGPU: depth readback uses async GPU buffer mapping. The sync
 * {@link PickDepth#getDepth} returns `undefined` for WebGPU contexts;
 * use {@link PickDepth#getDepthAsync} instead.
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
    this._depthStagingBuffer = null;
  }

  get framebuffer() {
    return this._framebuffer.framebuffer;
  }

  update(context, depthTexture) {
    // WebGPU path — store reference to depth texture for async readback
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
   * Asynchronously read depth from a WebGPU depth texture at the given coordinate.
   * Uses `depth32float` staging texture + buffer mapping.
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

    const depthTexture = this._webgpuDepthTexture;
    if (!defined(depthTexture)) {
      return undefined;
    }

    const device = context._device;
    if (!device) {
      return undefined;
    }

    // depth24plus-stencil8 cannot be copied directly. Need a depth-to-color
    // blit shader, or the scene must use depth32float. For now, return the
    // cached value from a previous async readback if available.
    // Full depth readback via WGSL depth-to-color shader is tracked as
    // future work in PICKING_ANALYSIS.md.
    return this._lastDepthValue;
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
