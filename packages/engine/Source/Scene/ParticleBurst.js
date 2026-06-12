import Frozen from "../Core/Frozen.js";

/**
 * Represents a burst of {@link Particle}s from a {@link ParticleSystem} at a given time in the systems lifetime.
 *
 * @alias ParticleBurst
 * @constructor
 *
 * @param {object} [options] An object with the following properties:
 * @param {number} [options.time=0.0] The time in seconds after the beginning of the particle system's lifetime that the burst will occur.
 * @param {number} [options.minimum=0.0] The minimum number of particles emmitted in the burst.
 * @param {number} [options.maximum=50.0] The maximum number of particles emitted in the burst.
 */
class ParticleBurst {
  constructor(options) {
    options = options ?? Frozen.EMPTY_OBJECT;

    /**
     * The time in seconds after the beginning of the particle system's lifetime that the burst will occur.
     * @type {number}
     * @default 0.0
     */
    this.time = options.time ?? 0.0;
    /**
     * The minimum number of particles emitted.
     * @type {number}
     * @default 0.0
     */
    this.minimum = options.minimum ?? 0.0;
    /**
     * The maximum number of particles emitted.
     * @type {number}
     * @default 50.0
     */
    this.maximum = options.maximum ?? 50.0;

    this._complete = false;
  }

  /**
   * <code>true</code> if the burst has been completed; <code>false</code> otherwise.
   * @type {boolean}
   */
  get complete() {
    return this._complete;
  }
}

export default ParticleBurst;
