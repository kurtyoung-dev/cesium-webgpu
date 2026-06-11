import Check from "../Core/Check.js";
import Color from "../Core/Color.js";
import Frozen from "../Core/Frozen.js";
import JulianDate from "../Core/JulianDate.js";
import defined from "../Core/defined.js";
import destroyObject from "../Core/destroyObject.js";
import FeatureRendererKey from "../Renderer/FeatureRendererKey.js";

// Earth's gravitational parameter (m^3/s^2) — used to derive the default
// circular-orbit mean motion n = sqrt(GM / a^3) when the caller doesn't
// supply one.
const GRAVITATIONAL_PARAMETER = 3.986004418e14;

/**
 * A GPU-resident catalog of objects on circular orbits (Phase 3 of the
 * Large Dynamic Objects roadmap — NEW-ORBITAL-CATALOG-COLLECTION).
 *
 * Unlike {@link PointPrimitiveCollection}, positions are never computed on
 * the CPU: the orbital element set uploads to the GPU once (re-uploaded only
 * when the catalog changes), a compute shader propagates every object each
 * frame, and the instanced point draw reads the propagated positions
 * directly from GPU memory. The CPU's per-frame upload is one scalar — the
 * simulation time.
 *
 * Simulation time is derived from <code>frameState.time</code> each frame,
 * as seconds elapsed since {@link OrbitalCatalogCollection#epoch} (which
 * defaults to the first frame's time). Driving the scene clock — e.g.
 * <code>viewer.clock.multiplier</code> — therefore speeds up or rewinds the
 * catalog like any other time-dynamic primitive.
 *
 * MVP scope: closed-form CIRCULAR orbits only (no eccentricity / Kepler
 * solver), ECI treated as ECEF (Earth rotation skipped). J2/SGP4 kernels,
 * the WebGL2 fallback (SGP4-on-worker WASM), and picking are tracked
 * follow-ups — see NEW-ORBITAL-* entries in migration_doc/DEFERRED_WORK.md.
 * On a WebGL context this collection currently renders nothing.
 *
 * @alias OrbitalCatalogCollection
 *
 * @param {object} [options] Object with the following properties:
 * @param {boolean} [options.show=true] Whether to display the catalog.
 * @param {JulianDate} [options.epoch] The catalog epoch that simulation time
 *        is measured from. Defaults to the first rendered frame's time.
 *
 * @example
 * const catalog = scene.primitives.add(new Cesium.OrbitalCatalogCollection());
 * catalog.add({
 *   semiMajorAxis: 7.0e6,                       // meters
 *   inclination: Cesium.Math.toRadians(51.6),   // radians
 *   raan: 0.3,                                  // radians
 *   phase: 1.2,                                 // radians
 *   color: Cesium.Color.CYAN,
 *   pixelSize: 3,
 * });
 */
class OrbitalCatalogCollection {
  constructor(options) {
    options = options ?? Frozen.EMPTY_OBJECT;

    /**
     * Determines if primitives in this collection will be shown.
     * @type {boolean}
     * @default true
     */
    this.show = options.show ?? true;

    this._epoch = defined(options.epoch)
      ? JulianDate.clone(options.epoch)
      : undefined;
    this._objects = [];
    // Consumed by the feature renderer after each catalog upload
    // (Phase-0 dirty-consume discipline — see _consumeDirtyState).
    this._catalogDirty = true;
    // Seconds since _epoch, computed from frameState.time each frame and
    // read by the feature renderer (the only per-frame CPU→GPU scalar).
    this._simulationTimeSeconds = 0;
    this._featureRenderer = undefined;
    this._webgpuCache = undefined;
  }

  /**
   * The number of objects in the catalog.
   * @memberof OrbitalCatalogCollection.prototype
   * @type {number}
   * @readonly
   */
  get length() {
    return this._objects.length;
  }

  /**
   * The catalog epoch that simulation time is measured from. Undefined
   * until set explicitly or until the first frame renders.
   * @memberof OrbitalCatalogCollection.prototype
   * @type {JulianDate|undefined}
   */
  get epoch() {
    return this._epoch;
  }

  set epoch(value) {
    this._epoch = defined(value) ? JulianDate.clone(value) : undefined;
  }

  /**
   * Adds an object to the catalog.
   *
   * @param {object} [options] Object with the following properties:
   * @param {number} [options.semiMajorAxis=7.0e6] Orbit radius in meters.
   * @param {number} [options.inclination=0.0] Inclination in radians.
   * @param {number} [options.raan=0.0] Right ascension of the ascending node in radians.
   * @param {number} [options.phase=0.0] Argument of latitude at epoch in radians.
   * @param {number} [options.meanMotion] Angular rate in radians/second.
   *        Defaults to the physical circular-orbit rate sqrt(GM / a^3).
   * @param {number} [options.epochOffset=0.0] Per-object epoch offset in seconds.
   * @param {Color} [options.color=Color.WHITE] Point color.
   * @param {number} [options.pixelSize=3.0] Point diameter in pixels.
   * @returns {object} The catalog record that was added.
   */
  add(options) {
    options = options ?? Frozen.EMPTY_OBJECT;
    const semiMajorAxis = options.semiMajorAxis ?? 7.0e6;
    //>>includeStart('debug', pragmas.debug);
    Check.typeOf.number.greaterThan("semiMajorAxis", semiMajorAxis, 0.0);
    //>>includeEnd('debug');
    const record = {
      semiMajorAxis: semiMajorAxis,
      inclination: options.inclination ?? 0.0,
      raan: options.raan ?? 0.0,
      phase: options.phase ?? 0.0,
      meanMotion:
        options.meanMotion ??
        Math.sqrt(
          GRAVITATIONAL_PARAMETER /
            (semiMajorAxis * semiMajorAxis * semiMajorAxis),
        ),
      epochOffset: options.epochOffset ?? 0.0,
      color: Color.clone(options.color ?? Color.WHITE),
      pixelSize: options.pixelSize ?? 3.0,
    };
    this._objects.push(record);
    this._catalogDirty = true;
    return record;
  }

  /**
   * Removes an object from the catalog.
   *
   * @param {object} record The record returned by {@link OrbitalCatalogCollection#add}.
   * @returns {boolean} <code>true</code> if the object was removed.
   */
  remove(record) {
    const index = this._objects.indexOf(record);
    if (index === -1) {
      return false;
    }
    this._objects.splice(index, 1);
    this._catalogDirty = true;
    return true;
  }

  /**
   * Removes all objects from the catalog.
   */
  removeAll() {
    this._objects.length = 0;
    this._catalogDirty = true;
  }

  /**
   * Returns the catalog record at the specified index.
   *
   * @param {number} index The zero-based index.
   * @returns {object} The record at the specified index.
   */
  get(index) {
    //>>includeStart('debug', pragmas.debug);
    Check.typeOf.number("index", index);
    //>>includeEnd('debug');
    return this._objects[index];
  }

  /**
   * Marks the catalog dirty so element edits made directly on a record
   * returned by {@link OrbitalCatalogCollection#add} re-upload next frame.
   */
  markDirty() {
    this._catalogDirty = true;
  }

  /**
   * Consumed by the feature renderer after the catalog upload each frame so
   * settled catalogs never re-upload (Phase-0 dirty-consume discipline —
   * mirrors BillboardCollection._consumeDirtyState).
   * @private
   */
  _consumeDirtyState() {
    this._catalogDirty = false;
  }

  /**
   * @private
   */
  update(frameState) {
    if (!this.show || this._objects.length === 0) {
      return;
    }

    // Shared scene logic BEFORE the backend branch (scene-logic-extractor
    // pattern): derive simulation time from the scene clock so both
    // backends agree on the time source.
    if (!defined(this._epoch)) {
      this._epoch = JulianDate.clone(frameState.time);
    }
    this._simulationTimeSeconds = JulianDate.secondsDifference(
      frameState.time,
      this._epoch,
    );

    const fr = frameState.context.getFeatureRenderer(
      FeatureRendererKey.ORBITAL_CATALOG_COLLECTION,
    );
    if (fr) {
      fr.update(this, frameState);
      this._featureRenderer = fr;
      return;
    }

    // WebGL2 has no compute — the fallback (SGP4-on-worker WASM writing the
    // same SoA RTE buffer) is tracked as NEW-ORBITAL-SGP4-WASM-WORKER in
    // migration_doc/DEFERRED_WORK.md. Until it lands, the catalog renders
    // nothing on WebGL.
  }

  /**
   * Returns true if this object was destroyed; otherwise, false.
   *
   * @returns {boolean} <code>true</code> if this object was destroyed; otherwise, <code>false</code>.
   */
  isDestroyed() {
    return false;
  }

  /**
   * Destroys the WebGPU resources held by this collection. Once destroyed,
   * the object should not be used; calling any function other than
   * <code>isDestroyed</code> will result in a {@link DeveloperError}.
   *
   * @example
   * catalog = catalog && catalog.destroy();
   */
  destroy() {
    if (defined(this._featureRenderer)) {
      this._featureRenderer.destroy(this);
      this._featureRenderer = undefined;
    }
    return destroyObject(this);
  }
}

export default OrbitalCatalogCollection;
