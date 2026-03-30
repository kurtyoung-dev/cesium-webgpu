import defined from "../Core/defined.js";
import destroyObject from "../Core/destroyObject.js";

/**
 * @private
 */
class TextureCache {
  constructor() {
    this._textures = {};
    this._numberOfTextures = 0;
    this._texturesToRelease = {};
  }

  get numberOfTextures() {
    return this._numberOfTextures;
  }

  getTexture(keyword) {
    const cachedTexture = this._textures[keyword];
    if (!defined(cachedTexture)) {
      return undefined;
    }

    // No longer want to release this if it was previously released.
    delete this._texturesToRelease[keyword];

    ++cachedTexture.count;
    return cachedTexture.texture;
  }

  addTexture(keyword, texture) {
    const cachedTexture = {
      texture: texture,
      count: 1,
    };

    texture.finalDestroy = texture.destroy;

    const that = this;
    texture.destroy = function () {
      if (--cachedTexture.count === 0) {
        that._texturesToRelease[keyword] = cachedTexture;
      }
    };

    this._textures[keyword] = cachedTexture;
    ++this._numberOfTextures;
  }

  destroyReleasedTextures() {
    const texturesToRelease = this._texturesToRelease;

    for (const keyword in texturesToRelease) {
      if (Object.hasOwn(texturesToRelease, keyword)) {
        const cachedTexture = texturesToRelease[keyword];
        delete this._textures[keyword];
        cachedTexture.texture.finalDestroy();
        --this._numberOfTextures;
      }
    }

    this._texturesToRelease = {};
  }

  isDestroyed() {
    return false;
  }

  destroy() {
    const textures = this._textures;
    for (const keyword in textures) {
      if (Object.hasOwn(textures, keyword)) {
        textures[keyword].texture.finalDestroy();
      }
    }
    return destroyObject(this);
  }
}

export default TextureCache;
