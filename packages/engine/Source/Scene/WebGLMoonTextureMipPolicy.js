import CesiumMath from "../Core/Math.js";
import Sampler from "../Renderer/Sampler.js";
import TextureMinificationFilter from "../Renderer/TextureMinificationFilter.js";
import TextureWrap from "../Renderer/TextureWrap.js";

// Moon-owned samplers are shared by every albedo and normal realization. The
// fallback remains the historical single-level LINEAR policy, while legal
// mip chains use trilinear filtering. Keeping these out of Material avoids
// changing the sampling policy of unrelated image uniforms.
const webGLMoonLinearSampler = Object.freeze(
  new Sampler({
    minificationFilter: TextureMinificationFilter.LINEAR,
  }),
);

const webGLMoonTrilinearSampler = Object.freeze(
  new Sampler({
    // Longitude is periodic. REPEAT lets bilinear/trilinear footprints cross
    // the equirectangular seam at model -X instead of sampling a clamped edge
    // texel. Latitude remains clamped so the poles never wrap north/south.
    wrapS: TextureWrap.REPEAT,
    wrapT: TextureWrap.CLAMP_TO_EDGE,
    minificationFilter: TextureMinificationFilter.LINEAR_MIPMAP_LINEAR,
  }),
);

// Debug/acceptance evidence without exposing Texture handles. Weak ownership
// means this cannot extend a GPU realization's lifetime.
const webGLMoonTextureMipLevelCounts = new WeakMap();

/**
 * WebGL 2 provides explicit gradients and permits mipmaps for non-power-of-
 * two 2D textures. WebGL 1 needs power-of-two dimensions plus both derivative
 * and explicit-LOD extensions. This is intentionally the single capability
 * predicate used by texture realization and Moon shader define selection, so
 * a texture can never acquire mips without the seam-safe sampling path that
 * consumes them.
 *
 * @param {object} context
 * @param {number} width
 * @param {number} height
 * @returns {boolean}
 * @private
 */
function canGenerateWebGLMoonMipmaps(context, width, height) {
  if (context?.webgl2 === true) {
    return true;
  }

  return (
    context?.standardDerivatives === true &&
    context?.supportsTextureLod === true &&
    CesiumMath.isPowerOfTwo(width) &&
    CesiumMath.isPowerOfTwo(height)
  );
}

/**
 * Generate a complete Moon texture mip chain when legal and install the
 * matching Moon-only sampler. The texture is already fully uploaded when
 * this runs, and callers invoke it only from the frame-owned realization
 * point rather than an asynchronous callback.
 *
 * @param {Texture} texture
 * @param {object} context
 * @returns {boolean} Whether a mip chain was generated.
 * @private
 */
function configureWebGLMoonTextureMipmaps(texture, context) {
  if (canGenerateWebGLMoonMipmaps(context, texture.width, texture.height)) {
    texture.generateMipmap();
    texture.sampler = webGLMoonTrilinearSampler;
    webGLMoonTextureMipLevelCounts.set(
      texture,
      Math.floor(Math.log2(Math.max(texture.width, texture.height))) + 1,
    );
    return true;
  }

  texture.sampler = webGLMoonLinearSampler;
  webGLMoonTextureMipLevelCounts.set(texture, 1);
  return false;
}

/**
 * Returns the realized level count recorded by the Moon-only policy without
 * exposing the underlying Texture through diagnostics.
 *
 * @param {Texture|undefined} texture
 * @returns {number|null}
 * @private
 */
function getWebGLMoonTextureMipLevelCount(texture) {
  if (texture === undefined) {
    return null;
  }
  return webGLMoonTextureMipLevelCounts.get(texture) ?? 1;
}

const WebGLMoonTextureMipPolicy = Object.freeze({
  canGenerateWebGLMoonMipmaps,
  configureWebGLMoonTextureMipmaps,
  getWebGLMoonTextureMipLevelCount,
  webGLMoonLinearSampler,
  webGLMoonTrilinearSampler,
});

export {
  canGenerateWebGLMoonMipmaps,
  configureWebGLMoonTextureMipmaps,
  getWebGLMoonTextureMipLevelCount,
  webGLMoonLinearSampler,
  webGLMoonTrilinearSampler,
};

export default WebGLMoonTextureMipPolicy;
