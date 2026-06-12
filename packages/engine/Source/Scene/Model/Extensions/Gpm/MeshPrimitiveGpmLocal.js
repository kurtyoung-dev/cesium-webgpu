/**
 * Local Generic Point-cloud Model information about a glTF primitive.
 *
 * @param {PpeTexture[]} ppeTextures The Per-Point Error textures
 *
 * @constructor
 * @private
 */
class MeshPrimitiveGpmLocal {
  constructor(ppeTextures) {
    this._ppeTextures = ppeTextures;
  }

  /**
   * An array of ppe textures.
   *
   * @type {PpeTexture[]|undefined}
   * @readonly
   */
  get ppeTextures() {
    return this._ppeTextures;
  }
}

export default MeshPrimitiveGpmLocal;
