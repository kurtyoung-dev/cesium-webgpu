import Cartesian3 from "../Core/Cartesian3.js";
import Check from "../Core/Check.js";
import CesiumMath from "../Core/Math.js";

const defaultAngle = CesiumMath.toRadians(30.0);

/**
 * A ParticleEmitter that emits particles within a cone.
 * Particles will be positioned at the tip of the cone and have initial velocities going towards the base.
 *
 * @alias ConeEmitter
 * @constructor
 *
 * @param {number} [angle=Cesium.Math.toRadians(30.0)] The angle of the cone in radians.
 */
class ConeEmitter {
  constructor(angle) {
    this._angle = angle ?? defaultAngle;
  }

  /**
   * Initializes the given {Particle} by setting it's position and velocity.
   *
   * @private
   * @param {Particle} particle The particle to initialize
   */
  emit(particle) {
    const radius = Math.tan(this._angle);

    // Compute a random point on the cone's base
    const theta = CesiumMath.randomBetween(0.0, CesiumMath.TWO_PI);
    const rad = CesiumMath.randomBetween(0.0, radius);

    const x = rad * Math.cos(theta);
    const y = rad * Math.sin(theta);
    const z = 1.0;

    particle.velocity = Cartesian3.fromElements(x, y, z, particle.velocity);
    Cartesian3.normalize(particle.velocity, particle.velocity);
    particle.position = Cartesian3.clone(Cartesian3.ZERO, particle.position);
  }

  /**
   * The angle of the cone in radians.
   * @memberof CircleEmitter.prototype
   * @type {number}
   * @default Cesium.Math.toRadians(30.0)
   */
  get angle() {
    return this._angle;
  }

  /**
   * The angle of the cone in radians.
   * @memberof CircleEmitter.prototype
   * @type {number}
   * @default Cesium.Math.toRadians(30.0)
   */
  set angle(value) {
    //>>includeStart('debug', pragmas.debug);
    Check.typeOf.number("value", value);
    //>>includeEnd('debug');
    this._angle = value;
  }
}

export default ConeEmitter;
