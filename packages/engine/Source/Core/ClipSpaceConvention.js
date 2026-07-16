import DeveloperError from "./DeveloperError.js";

/**
 * Immutable description of the clip-space depth convention used to construct
 * projection matrices.
 *
 * WebGL maps the near and far planes to -1 and 1 in normalized device
 * coordinates. WebGPU maps them to 0 and 1. Keeping this value explicit avoids
 * renderer construction order changing process-global math behavior.
 *
 * @typedef {object} ClipSpaceConventionRecord
 * @property {number} id Stable integer used by projection caches.
 * @property {string} name Human-readable backend convention name.
 * @property {number} nearDepth Normalized-device-coordinate depth at the near plane.
 * @property {number} farDepth Normalized-device-coordinate depth at the far plane.
 * @property {boolean} depthRangeZeroToOne Whether depth is in the 0-to-1 range.
 */

const webgl = Object.freeze({
  id: 0,
  name: "webgl",
  nearDepth: -1.0,
  farDepth: 1.0,
  depthRangeZeroToOne: false,
});

const webgpu = Object.freeze({
  id: 1,
  name: "webgpu",
  nearDepth: 0.0,
  farDepth: 1.0,
  depthRangeZeroToOne: true,
});

/**
 * Canonical clip-space conventions. The records are frozen singletons so they
 * are safe to retain on a graphics context and cheap to use as cache identity.
 *
 * @namespace ClipSpaceConvention
 */
const ClipSpaceConvention = Object.freeze({
  WEBGL: webgl,
  WEBGPU: webgpu,

  /**
   * Returns the canonical convention for a depth-range capability.
   *
   * @param {boolean} depthRangeZeroToOne Whether the context uses 0-to-1 depth.
   * @returns {ClipSpaceConventionRecord} The canonical immutable record.
   */
  fromDepthRangeZeroToOne: function (depthRangeZeroToOne) {
    return depthRangeZeroToOne ? webgpu : webgl;
  },

  /**
   * Validates and canonicalizes a convention supplied to a projection builder.
   * Undefined deliberately means WebGL for public API compatibility.
   *
   * @param {ClipSpaceConventionRecord} [convention] The convention to normalize.
   * @returns {ClipSpaceConventionRecord} A canonical immutable record.
   * @private
   */
  normalize: function (convention) {
    if (convention === undefined || convention === webgl) {
      return webgl;
    }
    if (convention === webgpu) {
      return webgpu;
    }

    throw new DeveloperError(
      "clipSpaceConvention must be ClipSpaceConvention.WEBGL or ClipSpaceConvention.WEBGPU.",
    );
  },
});

export default ClipSpaceConvention;
