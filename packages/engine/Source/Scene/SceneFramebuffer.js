import Color from "../Core/Color.js";
import destroyObject from "../Core/destroyObject.js";
import ClearCommand from "../Renderer/ClearCommand.js";
import FramebufferManager from "../Renderer/FramebufferManager.js";
import PixelDatatype from "../Renderer/PixelDatatype.js";

/**
 * @private
 */
class SceneFramebuffer {
  constructor() {
    this._numSamples = 1;
    this._colorFramebuffer = new FramebufferManager({
      depthStencil: true,
      supportsDepthTexture: true,
    });
    this._idFramebuffer = new FramebufferManager({
      depthStencil: true,
      supportsDepthTexture: true,
    });

    this._idClearColor = new Color(0.0, 0.0, 0.0, 0.0);

    this._clearCommand = new ClearCommand({
      color: new Color(0.0, 0.0, 0.0, 0.0),
      depth: 1.0,
      owner: this,
    });
  }

  update(context, viewport, hdr, numSamples) {
    const width = viewport.width;
    const height = viewport.height;
    const pixelDatatype = hdr
      ? context.halfFloatingPointTexture
        ? PixelDatatype.HALF_FLOAT
        : PixelDatatype.FLOAT
      : PixelDatatype.UNSIGNED_BYTE;
    this._numSamples = numSamples;
    this._colorFramebuffer.update(
      context,
      width,
      height,
      numSamples,
      pixelDatatype,
    );
    this._idFramebuffer.update(context, width, height);
  }

  clear(context, passState, clearColor) {
    Color.clone(clearColor, this._clearCommand.color);
    Color.clone(this._idClearColor, this._clearCommand.color);
    this._colorFramebuffer.clear(context, this._clearCommand, passState);
    this._idFramebuffer.clear(context, this._clearCommand, passState);
  }

  getFramebuffer() {
    return this._colorFramebuffer.framebuffer;
  }

  getIdFramebuffer() {
    return this._idFramebuffer.framebuffer;
  }

  prepareColorTextures(context) {
    if (this._numSamples > 1) {
      this._colorFramebuffer.prepareTextures(context);
    }
  }

  isDestroyed() {
    return false;
  }

  destroy() {
    destroyResources(this);
    return destroyObject(this);
  }

  get framebuffer() {
    return this._colorFramebuffer.framebuffer;
  }

  get idFramebuffer() {
    return this._idFramebuffer.framebuffer;
  }

  get depthStencilTexture() {
    return this._colorFramebuffer.getDepthStencilTexture();
  }
}

function destroyResources(post) {
  post._colorFramebuffer.destroy();
  post._idFramebuffer.destroy();
}

export default SceneFramebuffer;
