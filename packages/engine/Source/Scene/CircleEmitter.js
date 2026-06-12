import Cartesian3 from "../Core/Cartesian3.js";
import Check from "../Core/Check.js";
import CesiumMath from "../Core/Math.js";

/**
 * A ParticleEmitter that emits particles from a circle.
 * Particles will be positioned within a circle and have initial velocities going along the z vector.
 *
 * @alias CircleEmitter
 * @constructor
 *
 * @param {number} [radius=1.0] The radius of the circle in meters.
 */
class CircleEmitter {
  constructor(radius) {
    radius = radius ?? 1.0;

    //>>includeStart('debug', pragmas.debug);
    Check.typeOf.number.greaterThan("radius", radius, 0.0);
    //>>includeEnd('debug');

    this._radius = radius ?? 1.0;
  }

  /**
   * Initializes the given {@link Particle} by setting it's position and velocity.
   *
   * @private
   * @param {Particle} particle The particle to initialize.
   */
  emit(particle) {
    const theta = CesiumMath.randomBetween(0.0, CesiumMath.TWO_PI);
    const rad = CesiumMath.randomBetween(0.0, this._radius);

    const x = rad * Math.cos(theta);
    const y = rad * Math.sin(theta);
    const z = 0.0;

    particle.position = Cartesian3.fromElements(x, y, z, particle.position);
    particle.velocity = Cartesian3.clone(Cartesian3.UNIT_Z, particle.velocity);
  }

  /**
   * The radius of the circle in meters.
   * @type {number}
   * @default 1.0
   */
  get radius() {
    return this._radius;
  }

  set radius(value) {
    //>>includeStart('debug', pragmas.debug);
    Check.typeOf.number.greaterThan("value", value, 0.0);
    //>>includeEnd('debug');
    this._radius = value;
  }
}

export default CircleEmitter;
