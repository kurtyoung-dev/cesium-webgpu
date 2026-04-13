import BoundingRectangle from "../Core/BoundingRectangle.js";
import destroyObject from "../Core/destroyObject.js";
import FramebufferManager from "../Renderer/FramebufferManager.js";
import PassState from "../Renderer/PassState.js";

/**
 * @private
 */
class PickDepthFramebuffer {
  constructor() {
    this._framebuffer = new FramebufferManager({
      color: false,
      depthStencil: true,
      supportsDepthTexture: true,
    });
    this._passState = undefined;
  }

  update(context, drawingBufferPosition, viewport) {
    const width = viewport.width;
    const height = viewport.height;

    if (this._framebuffer.isDirty(width, height)) {
      createResources(this, context);
    }

    const framebuffer = this.framebuffer;
    const passState = this._passState;
    passState.framebuffer = framebuffer;
    passState.viewport.width = width;
    passState.viewport.height = height;
    passState.scissorTest.rectangle.x = drawingBufferPosition.x;
    passState.scissorTest.rectangle.y = height - drawingBufferPosition.y;
    passState.scissorTest.rectangle.width = 1;
    passState.scissorTest.rectangle.height = 1;

    return passState;
  }

  isDestroyed() {
    return false;
  }

  destroy() {
    destroyResources(this);
    return destroyObject(this);
  }

  get framebuffer() {
    return this._framebuffer.framebuffer;
  }
}

function destroyResources(pickDepth) {
  pickDepth._framebuffer.destroy();
}

function createResources(pickDepth, context) {
  const width = context.drawingBufferWidth;
  const height = context.drawingBufferHeight;

  pickDepth._framebuffer.update(context, width, height);

  const passState = new PassState(context);
  passState.blendingEnabled = false;
  passState.scissorTest = {
    enabled: true,
    rectangle: new BoundingRectangle(),
  };
  passState.viewport = new BoundingRectangle();
  pickDepth._passState = passState;
}

export default PickDepthFramebuffer;
