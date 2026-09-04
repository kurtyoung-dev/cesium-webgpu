import buildModuleUrl from "./buildModuleUrl.js";
import CesiumMath from "./Math.js";
import defined from "./defined.js";
import DeveloperError from "./DeveloperError.js";
import Resource from "./Resource.js";

/**
 * GeoidUndulationGrid — geoid-undulation lookup over a bundled coarse grid.
 *
 * The undulation N is the height of the geoid above the WGS84 ellipsoid. Real
 * elevation data is orthometric: a terrain provider that publishes "sea level"
 * publishes the GEOID, not ellipsoidal zero, and those disagree by up to
 * ±107 m. `probe-ocean-datum.mjs` measured Cesium World Terrain's
 * ocean lid at six open-ocean sites and classified it GEOID; the shipped FFT
 * ocean anchored its patch at ellipsoidal 0 and therefore floated a measured
 * 101.64 m above the baked sea at the Sri Lanka coast. This grid is the model
 * that closes that gap.
 *
 * Data. EGM2008 (Pavlis, Holmes, Kenyon & Factor, "The development and
 * evaluation of the Earth Gravitational Model 2008 (EGM2008)", J. Geophys.
 * Res. 117, B04406, 2012), decimated from the NGA 2.5-arcminute geoid grid
 * (`us_nga_egm08_25.tif`, whose own TIFF copyright tag reads "Derived from
 * work by NGA. Public Domain") to 0.5° by `Tools/build-geoid-undulation-grid.mjs`.
 * See LICENSE.md "Bundled Engine Assets".
 *
 * ACCURACY. Bilinear interpolation of the 0.5° grid, measured against all
 * 37,333,440 nodes of the 2.5' source: global RMS 0.195 m / max 6.64 m;
 * over open water (the consumer) RMS 0.110 m / max 3.60 m, with 99.9955% of
 * open-water nodes inside 2 m. Both global extrema are on land in extreme
 * relief. The int16-centimetre encoding contributes ≤0.005 m.
 *
 * FORMAT. See the header block of `Tools/build-geoid-undulation-grid.mjs`.
 * 32-byte little-endian header + `nx*ny` int16 centimetres, row-major from
 * the north row south, each row from the west node east. Both longitude seams
 * are present (column `nx-1` duplicates column 0), so sampling is a clamp with
 * no wrap branch.
 *
 * @alias GeoidUndulationGrid
 * @constructor
 *
 * @param {ArrayBuffer} buffer The raw asset bytes.
 *
 * @private
 */
function GeoidUndulationGrid(buffer) {
  //>>includeStart('debug', pragmas.debug);
  if (!defined(buffer)) {
    throw new DeveloperError("buffer is required.");
  }
  //>>includeEnd('debug');

  const view = new DataView(buffer);
  if (view.byteLength < 32) {
    throw new DeveloperError("geoid grid buffer is truncated");
  }
  const magic = view.getUint32(0, true);
  if (magic !== GeoidUndulationGrid.MAGIC) {
    throw new DeveloperError(
      `geoid grid magic 0x${magic.toString(16)} is not "EGM1"`,
    );
  }
  const version = view.getUint16(4, true);
  if (version !== 1) {
    throw new DeveloperError(`unsupported geoid grid version ${version}`);
  }

  this._unitsPerMetre = view.getUint16(6, true);
  this._nx = view.getUint32(8, true);
  this._ny = view.getUint32(12, true);
  this._westDegrees = view.getInt32(16, true) * 1.0e-6;
  this._northDegrees = view.getInt32(20, true) * 1.0e-6;
  this._stepDegrees = view.getUint32(24, true) * 1.0e-6;

  const expected = 32 + this._nx * this._ny * 2;
  if (view.byteLength < expected) {
    throw new DeveloperError(
      `geoid grid buffer is ${view.byteLength} bytes; ${expected} required for ${this._nx}x${this._ny}`,
    );
  }
  // Degenerate dimensions must fail HERE. `sampleDegrees` clamps `x0` to
  // `nx - 2`, so nx or ny of 0/1 clamps to -1, reads past the typed-array start
  // as `undefined` and returns NaN — which downstream code treats as "no
  // undulation" and silently re-introduces the ~100 m defect. The loader's
  // contract is fail-loudly.
  if (
    !(this._unitsPerMetre > 0) ||
    !(this._stepDegrees > 0) ||
    !(this._nx >= 2) ||
    !(this._ny >= 2)
  ) {
    throw new DeveloperError(
      `geoid grid header is malformed: ${this._nx}x${this._ny} nodes, ` +
        `step ${this._stepDegrees} deg, ${this._unitsPerMetre} units/m`,
    );
  }

  // The payload is 2-byte aligned at offset 32, so an Int16Array view over the
  // original buffer is safe and avoids a 500 KiB copy.
  this._values = new Int16Array(buffer, 32, this._nx * this._ny);
  this._inverseStep = 1.0 / this._stepDegrees;
  this._inverseUnits = 1.0 / this._unitsPerMetre;
}

/** Little-endian uint32 of the ASCII bytes "EGM1". @type {number} */
GeoidUndulationGrid.MAGIC = 0x314d4745;

/**
 * Module-relative path of the bundled EGM2008 grid.
 * @type {string}
 */
GeoidUndulationGrid.ASSET_PATH = "Assets/Geoid/egm2008-0p5deg.i16";

Object.defineProperties(GeoidUndulationGrid.prototype, {
  /** @memberof GeoidUndulationGrid.prototype @type {number} @readonly */
  longitudeCount: {
    get: function () {
      return this._nx;
    },
  },
  /** @memberof GeoidUndulationGrid.prototype @type {number} @readonly */
  latitudeCount: {
    get: function () {
      return this._ny;
    },
  },
  /** @memberof GeoidUndulationGrid.prototype @type {number} @readonly */
  stepDegrees: {
    get: function () {
      return this._stepDegrees;
    },
  },
});

/**
 * Geoid undulation at a position, in metres above the WGS84 ellipsoid,
 * bilinearly interpolated. Allocation-free.
 *
 * @param {number} longitudeDegrees Longitude in degrees. Values outside
 *   [-180, 180] are wrapped.
 * @param {number} latitudeDegrees Latitude in degrees, clamped to [-90, 90].
 * @returns {number} Undulation in metres.
 */
GeoidUndulationGrid.prototype.sampleDegrees = function (
  longitudeDegrees,
  latitudeDegrees,
) {
  let lon = longitudeDegrees;
  if (!(lon >= -180.0 && lon <= 180.0)) {
    // Wrap into [-180, 180]. NaN falls through to the west seam rather than
    // poisoning the anchor with NaN.
    lon = ((((lon + 180.0) % 360.0) + 360.0) % 360.0) - 180.0;
    if (!(lon >= -180.0 && lon <= 180.0)) {
      lon = -180.0;
    }
  }
  let lat = latitudeDegrees;
  if (!(lat >= -90.0)) {
    lat = -90.0;
  } else if (lat > 90.0) {
    lat = 90.0;
  }

  const x = (lon - this._westDegrees) * this._inverseStep;
  const y = (this._northDegrees - lat) * this._inverseStep;

  let x0 = Math.floor(x);
  let y0 = Math.floor(y);
  const nx = this._nx;
  if (x0 < 0) {
    x0 = 0;
  } else if (x0 > nx - 2) {
    x0 = nx - 2;
  }
  if (y0 < 0) {
    y0 = 0;
  } else if (y0 > this._ny - 2) {
    y0 = this._ny - 2;
  }
  const fx = x - x0;
  const fy = y - y0;

  const v = this._values;
  const r0 = y0 * nx + x0;
  const r1 = r0 + nx;
  const h =
    v[r0] * (1.0 - fx) * (1.0 - fy) +
    v[r0 + 1] * fx * (1.0 - fy) +
    v[r1] * (1.0 - fx) * fy +
    v[r1 + 1] * fx * fy;
  return h * this._inverseUnits;
};

/**
 * Geoid undulation at a position given in radians.
 *
 * @param {number} longitude Longitude in radians.
 * @param {number} latitude Latitude in radians.
 * @returns {number} Undulation in metres above the WGS84 ellipsoid.
 */
GeoidUndulationGrid.prototype.sample = function (longitude, latitude) {
  return this.sampleDegrees(
    longitude * CesiumMath.DEGREES_PER_RADIAN,
    latitude * CesiumMath.DEGREES_PER_RADIAN,
  );
};

// ── Bundled-asset singleton ───────────────────────────────────────────────
// One instance per page: the grid is immutable global data, so multi-context
// scenes share it. `_loadPromise` doubles as the in-flight guard.
let _instance;
let _loadPromise;
let _loadFailed = false;

/**
 * Starts (or joins) the lazy fetch of the bundled EGM2008 grid.
 *
 * The ~508 KiB asset is only fetched when something actually asks for a geoid
 * datum, so scenes that never enable the ocean — or that pin the ellipsoid
 * datum — download nothing.
 *
 * FAILURE IS STICKY, BUT RETRYABLE. After a failed attempt the per-frame path
 * must not re-fetch every frame, so the failure latches. It cannot latch for
 * the page lifetime, though: a single transient network error would otherwise
 * re-introduce the ~100 m datum defect permanently after one console.error.
 * `allowRetry` clears the latch, and the facade passes it on every explicit
 * `ocean.enabled = true` / datum change — one bounded attempt per user action,
 * each failure still loud.
 *
 * @param {boolean} [allowRetry=false] Clear a latched failure and try again.
 * @returns {Promise<GeoidUndulationGrid|undefined>} Resolves with the grid, or
 *   with `undefined` if the asset could not be loaded (the caller then falls
 *   back to a zero undulation, i.e. the pre-fix behaviour).
 */
GeoidUndulationGrid.loadEgm2008Async = function (allowRetry) {
  if (defined(_instance)) {
    return Promise.resolve(_instance);
  }
  if (_loadFailed) {
    if (allowRetry !== true) {
      return Promise.resolve(undefined);
    }
    _loadFailed = false;
  }
  if (!defined(_loadPromise)) {
    _loadPromise = Resource.fetchArrayBuffer(
      buildModuleUrl(GeoidUndulationGrid.ASSET_PATH),
    )
      .then(function (buffer) {
        _instance = new GeoidUndulationGrid(buffer);
        return _instance;
      })
      .catch(function (error) {
        _loadFailed = true;
        _loadPromise = undefined;
        console.error(
          `[CesiumJS] GeoidUndulationGrid: failed to load ${GeoidUndulationGrid.ASSET_PATH}: ${error}`,
        );
        return undefined;
      });
  }
  return _loadPromise;
};

/**
 * The loaded grid, or `undefined` while the asset is still in flight (or if it
 * failed). Synchronous and allocation-free — safe on the per-frame path.
 *
 * @returns {GeoidUndulationGrid|undefined} The grid.
 */
GeoidUndulationGrid.getEgm2008 = function () {
  return _instance;
};

/**
 * Whether a load attempt has failed and is currently latched. Diagnostic only.
 *
 * @returns {boolean} True when the next non-retry call short-circuits.
 * @private
 */
GeoidUndulationGrid.hasEgm2008LoadFailed = function () {
  return _loadFailed;
};

/**
 * Test hook: install a grid instance (or clear it with `undefined`) without
 * going through the network path.
 *
 * @param {GeoidUndulationGrid|undefined} grid The grid.
 * @private
 */
GeoidUndulationGrid.setEgm2008ForTesting = function (grid) {
  _instance = grid;
  _loadPromise = undefined;
  _loadFailed = false;
};

/**
 * Test hook: latch the failure state without touching the network.
 *
 * @param {boolean} failed Whether the load is considered failed.
 * @private
 */
GeoidUndulationGrid.setEgm2008LoadFailedForTesting = function (failed) {
  _loadFailed = failed === true;
};

export default GeoidUndulationGrid;
