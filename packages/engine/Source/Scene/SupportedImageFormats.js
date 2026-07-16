import Frozen from "../Core/Frozen.js";
import GraphicsCapabilities from "../Renderer/GraphicsCapabilities.js";

/**
 * Image formats supported by the browser.
 *
 * @param {object} [options] Object with the following properties:
 * @param {boolean} [options.webp=false] Whether the browser supports WebP images.
 * @param {boolean} [options.basis=false] Whether the browser supports compressed textures required to view KTX2 + Basis Universal images.
 * @param {object} [options.ktx2TranscodeTargets] Context-owned KTX2 target formats.
 *
 * @private
 */
function SupportedImageFormats(options) {
  options = options ?? Frozen.EMPTY_OBJECT;
  this.webp = options.webp ?? false;
  this.basis = options.basis ?? false;
  this.ktx2TranscodeTargets =
    options.ktx2TranscodeTargets ??
    GraphicsCapabilities.EMPTY.ktx2TranscodeTargets;
  this.ktx2TranscodeTargetKey = this.ktx2TranscodeTargets.cacheKey;
}

export default SupportedImageFormats;
