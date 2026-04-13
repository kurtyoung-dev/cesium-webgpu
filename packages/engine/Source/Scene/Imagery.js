import defined from "../Core/defined.js";
import destroyObject from "../Core/destroyObject.js";
import ImageryState from "./ImageryState.js";

/**
 * Stores details about a tile of imagery.
 *
 * @alias Imagery
 * @private
 */
class Imagery {
  constructor(imageryLayer, x, y, level, rectangle) {
    this.imageryLayer = imageryLayer;
    this.x = x;
    this.y = y;
    this.level = level;
    this.request = undefined;

    if (level !== 0) {
      const parentX = (x / 2) | 0;
      const parentY = (y / 2) | 0;
      const parentLevel = level - 1;
      this.parent = imageryLayer.getImageryFromCache(
        parentX,
        parentY,
        parentLevel,
      );
    }

    this.state = ImageryState.UNLOADED;
    this.imageUrl = undefined;
    this.image = undefined;
    this.texture = undefined;
    this.textureWebMercator = undefined;
    this.credits = undefined;
    this.referenceCount = 0;

    if (!defined(rectangle) && imageryLayer.ready) {
      const tilingScheme = imageryLayer.imageryProvider.tilingScheme;
      rectangle = tilingScheme.tileXYToRectangle(x, y, level);
    }

    this.rectangle = rectangle;
  }

  addReference() {
    ++this.referenceCount;
  }

  releaseReference() {
    --this.referenceCount;

    if (this.referenceCount === 0) {
      this.imageryLayer.removeImageryFromCache(this);

      if (defined(this.parent)) {
        this.parent.releaseReference();
      }

      if (defined(this.image) && defined(this.image.destroy)) {
        this.image.destroy();
      }

      if (defined(this.texture)) {
        this.texture.destroy();
      }

      if (
        defined(this.textureWebMercator) &&
        this.texture !== this.textureWebMercator
      ) {
        this.textureWebMercator.destroy();
      }

      destroyObject(this);

      return 0;
    }

    return this.referenceCount;
  }

  processStateMachine(frameState, needGeographicProjection, skipLoading) {
    if (this.state === ImageryState.UNLOADED && !skipLoading) {
      this.state = ImageryState.TRANSITIONING;
      this.imageryLayer._requestImagery(this);
    }

    if (this.state === ImageryState.RECEIVED) {
      this.state = ImageryState.TRANSITIONING;
      try {
        this.imageryLayer._createTexture(frameState.context, this);
      } catch (e) {
        console.error("[WebGPU:Imagery] _createTexture failed:", e);
        this.state = ImageryState.FAILED;
        return;
      }
    }

    // If the imagery is already ready, but we need a geographic version and don't have it yet,
    // we still need to do the reprojection step. This can happen if the Web Mercator version
    // is fine initially, but the geographic one is needed later.
    const needsReprojection =
      this.state === ImageryState.READY &&
      needGeographicProjection &&
      !this.texture;

    if (this.state === ImageryState.TEXTURE_LOADED || needsReprojection) {
      this.state = ImageryState.TRANSITIONING;
      try {
        this.imageryLayer._reprojectTexture(
          frameState,
          this,
          needGeographicProjection,
        );
      } catch (e) {
        console.error("[WebGPU:Imagery] _reprojectTexture failed:", e);
        // Reset to TEXTURE_LOADED so reprojection is retried on the next frame.
        // Previous code left state as TRANSITIONING which was a dead-end —
        // neither TEXTURE_LOADED nor READY conditions would re-enter this block.
        this.state = ImageryState.TEXTURE_LOADED;
      }
    }
  }
}

Imagery.createPlaceholder = function (imageryLayer) {
  const result = new Imagery(imageryLayer, 0, 0, 0);
  result.addReference();
  result.state = ImageryState.PLACEHOLDER;
  return result;
};

export default Imagery;
