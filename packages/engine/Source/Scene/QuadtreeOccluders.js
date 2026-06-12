import Cartesian3 from "../Core/Cartesian3.js";
import EllipsoidalOccluder from "../Core/EllipsoidalOccluder.js";

/**
 * A set of occluders that can be used to test quadtree tiles for occlusion.
 *
 * @alias QuadtreeOccluders
 * @constructor
 * @private
 *
 * @param {Ellipsoid} [options.ellipsoid=Ellipsoid.WGS84] The ellipsoid that potentially occludes tiles.
 */
class QuadtreeOccluders {
  constructor(options) {
    this._ellipsoid = new EllipsoidalOccluder(
      options.ellipsoid,
      Cartesian3.ZERO,
    );
  }

  /**
   * Gets the {@link EllipsoidalOccluder} that can be used to determine if a point is
   * occluded by an {@link Ellipsoid}.
   * @type {EllipsoidalOccluder}
   */
  get ellipsoid() {
    return this._ellipsoid;
  }
}

export default QuadtreeOccluders;
