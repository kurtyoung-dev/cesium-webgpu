import CesiumMath from "./Math.js";
import DeveloperError from "./DeveloperError.js";
import HarmonicTideModel from "./HarmonicTideModel.js";
import TidalConstituents from "./TidalConstituents.js";
import defined from "./defined.js";

/**
 * TideConstituentGrid — reader for a baked global tide-constituent atlas, and
 * the concrete shape of the loader seam described in {@link HarmonicTideModel}.
 *
 * Maintainer ruling **T5** makes EOT20 the default data tier. EOT20 ships as
 * ~2 GB of per-constituent NetCDF at 0.125 deg; nothing like that gets bundled.
 * `Tools/build-eot20-constituent-grid.mjs` decimates it to the format below and
 * documents the download URL, the CC BY 4.0 licence and the attribution string.
 * THE ASSET IS NOT BAKED YET — this reader and the tool define the contract so
 * the bake is a build step rather than a redesign.
 *
 * WHY REAL/IMAGINARY AND NOT AMPLITUDE/PHASE. Phase wraps at 2pi. Interpolating
 * phase directly produces a full-turn excursion wherever a cell straddles the
 * wrap, which lands as a spurious tide reversal — and near an amphidromic point,
 * where phase sweeps the entire circle around a node of zero amplitude, the
 * wrap is unavoidable. Storing `re = A cos(g)`, `im = A sin(g)` makes
 * interpolation linear in a quantity with no branch cut, and the amplitude
 * correctly collapses toward zero at an amphidrome instead of interpolating to
 * some average of 0 and 2pi.
 *
 * NO-DATA. Land nodes carry `re = -32768` (int16 minimum) as a sentinel. A
 * bilinear sample renormalises over whatever corners are present and reports
 * the fraction that were, so a caller can fall back to the equilibrium station
 * at a coast rather than reading a silent zero tide. `re = -32768` is
 * unreachable as data because the bake tool clamps amplitudes to +-32.767 m.
 *
 * FORMAT (little-endian throughout; both longitude seams present so sampling is
 * a clamp with no wrap branch, exactly as {@link GeoidUndulationGrid}):
 *
 * | offset | size | field |
 * |---|---|---|
 * | 0  | 4 | magic `"TCG1"` |
 * | 4  | 2 | version, 1 |
 * | 6  | 2 | unitsPerMetre (1000 = millimetres) |
 * | 8  | 4 | nx |
 * | 12 | 4 | ny |
 * | 16 | 4 | west edge, int32 micro-degrees |
 * | 20 | 4 | north edge, int32 micro-degrees |
 * | 24 | 4 | step, uint32 micro-degrees |
 * | 28 | 2 | constituentCount |
 * | 30 | 2 | reserved, 0 |
 * | 32 | 4*count | constituent ids, ASCII, NUL-padded to 4 bytes |
 * | 32+4*count | 4*nx*ny*count | int16 (re, im) pairs, per constituent, row-major from the NORTH row south, each row west to east |
 *
 * The id table sits before the payload so a loader can reject an atlas baked
 * for constituents it does not know WITHOUT reading the payload.
 *
 * @alias TideConstituentGrid
 * @constructor
 *
 * @param {ArrayBuffer} buffer The raw asset bytes.
 *
 * @private
 */
function TideConstituentGrid(buffer) {
  //>>includeStart('debug', pragmas.debug);
  if (!defined(buffer)) {
    throw new DeveloperError("buffer is required.");
  }
  //>>includeEnd('debug');

  const view = new DataView(buffer);
  if (view.byteLength < TideConstituentGrid.HEADER_BYTES) {
    throw new DeveloperError("tide constituent grid buffer is truncated");
  }
  const magic = view.getUint32(0, true);
  if (magic !== TideConstituentGrid.MAGIC) {
    throw new DeveloperError(
      `tide constituent grid magic 0x${magic.toString(16)} is not "TCG1"`,
    );
  }
  const version = view.getUint16(4, true);
  if (version !== 1) {
    throw new DeveloperError(
      `unsupported tide constituent grid version ${version}`,
    );
  }

  this._unitsPerMetre = view.getUint16(6, true);
  this._nx = view.getUint32(8, true);
  this._ny = view.getUint32(12, true);
  this._westDegrees = view.getInt32(16, true) * 1.0e-6;
  this._northDegrees = view.getInt32(20, true) * 1.0e-6;
  this._stepDegrees = view.getUint32(24, true) * 1.0e-6;
  const count = view.getUint16(28, true);

  // Same contract as GeoidUndulationGrid: a degenerate header must fail HERE.
  // `sampleInto` clamps the cell origin to nx - 2, which for nx < 2 clamps to
  // -1, reads past the typed array as `undefined` and produces NaN — and a NaN
  // amplitude is skipped by HarmonicTideModel.predict, so the tide would
  // silently become zero instead of loudly failing.
  if (
    !(this._unitsPerMetre > 0) ||
    !(this._stepDegrees > 0) ||
    !(this._nx >= 2) ||
    !(this._ny >= 2) ||
    !(count >= 1)
  ) {
    throw new DeveloperError(
      `tide constituent grid header is malformed: ${this._nx}x${this._ny} nodes, ` +
        `step ${this._stepDegrees} deg, ${this._unitsPerMetre} units/m, ` +
        `${count} constituents`,
    );
  }

  // SIZE CHECK BEFORE ANY TYPED-ARRAY VIEW. `count` is attacker-or-corruption
  // controlled up to 65535, and `new Uint8Array(buffer, 32, count * 4)` on a
  // short buffer throws a raw `RangeError: Invalid typed array length` — an
  // opaque failure from the middle of a constructor instead of the
  // DeveloperError this class contracts to throw. Everything below is derived
  // from the header only, so it can all be validated before a byte is viewed.
  const payloadOffset = TideConstituentGrid.HEADER_BYTES + count * 4;
  const samplesPerConstituent = this._nx * this._ny * 2;
  const expected = payloadOffset + samplesPerConstituent * count * 2;
  if (view.byteLength < expected) {
    throw new DeveloperError(
      `tide constituent grid buffer is ${view.byteLength} bytes; ${expected} required for ` +
        `${this._nx}x${this._ny} x ${count} constituents`,
    );
  }

  const idBytes = new Uint8Array(
    buffer,
    TideConstituentGrid.HEADER_BYTES,
    count * 4,
  );
  const ids = [];
  const constituents = [];
  for (let i = 0; i < count; i++) {
    let id = "";
    for (let b = 0; b < 4; b++) {
      const code = idBytes[i * 4 + b];
      if (code !== 0) {
        id += String.fromCharCode(code);
      }
    }
    ids.push(id);
    const constituent = TidalConstituents.fromId(id);
    if (!defined(constituent)) {
      throw new DeveloperError(
        `tide constituent grid names constituent "${id}", which TidalConstituents does not define`,
      );
    }
    constituents.push(constituent);
  }

  this._ids = ids;
  this._constituents = constituents;
  // 4-byte aligned by construction (header is 32, id table is a multiple of 4),
  // so an Int16Array view avoids copying the whole payload.
  this._values = new Int16Array(
    buffer,
    payloadOffset,
    samplesPerConstituent * count,
  );
  this._stride = samplesPerConstituent;
  this._inverseStep = 1.0 / this._stepDegrees;
  this._inverseUnits = 1.0 / this._unitsPerMetre;
}

/** Little-endian uint32 of the ASCII bytes "TCG1". @type {number} */
TideConstituentGrid.MAGIC = 0x31474354;

/** Fixed header size in bytes, before the constituent id table. @type {number} */
TideConstituentGrid.HEADER_BYTES = 32;

/**
 * Sentinel stored in the REAL channel of a node with no data (land). Chosen as
 * the int16 minimum, which the bake tool's amplitude clamp makes unreachable.
 * @type {number}
 */
TideConstituentGrid.NO_DATA = -32768;

Object.defineProperties(TideConstituentGrid.prototype, {
  /** @memberof TideConstituentGrid.prototype @type {number} @readonly */
  longitudeCount: {
    get: function () {
      return this._nx;
    },
  },
  /** @memberof TideConstituentGrid.prototype @type {number} @readonly */
  latitudeCount: {
    get: function () {
      return this._ny;
    },
  },
  /** @memberof TideConstituentGrid.prototype @type {number} @readonly */
  stepDegrees: {
    get: function () {
      return this._stepDegrees;
    },
  },
  /**
   * The constituent ids this atlas carries, in payload order.
   * @memberof TideConstituentGrid.prototype @type {string[]} @readonly
   */
  constituentIds: {
    get: function () {
      return this._ids.slice();
    },
  },
  /**
   * The resolved constituents, in payload order — the array to hand to
   * {@link HarmonicTideModel.createStation} so the station's arrays line up.
   * @memberof TideConstituentGrid.prototype @type {object[]} @readonly
   */
  constituents: {
    get: function () {
      return this._constituents.slice();
    },
  },
});

/**
 * Allocate a station whose constituent order matches this atlas.
 *
 * @returns {object} A {@link HarmonicTideModel.createStation}.
 */
TideConstituentGrid.prototype.createStation = function () {
  const station = HarmonicTideModel.createStation(this._constituents);
  station.source = HarmonicTideModel.SOURCE_EOT20;
  return station;
};

/**
 * Sample the atlas at a position, filling a station. Allocation-free.
 *
 * Bilinear in the real/imaginary parts, renormalised over whichever of the four
 * corners carry data. `station.coverage` reports that fraction: 1 in open
 * water, between 0 and 1 within one cell of a coast, and 0 on land — where the
 * station is marked invalid so the caller falls back rather than rendering a
 * flat sea.
 *
 * @param {number} longitudeDegrees East longitude in degrees; wrapped.
 * @param {number} latitudeDegrees Latitude in degrees; clamped to [-90, 90], in
 *   whatever graticule the atlas was baked on. EOT20 publishes GEODETIC, so the
 *   bake tool keeps geodetic and the header records it; no conversion happens
 *   here. It only affects WHICH node is read, never the returned amplitude —
 *   the geodetic/geocentric difference peaks at 0.19 deg of latitude, an eighth
 *   of one 1.5 deg cell.
 * @param {object} station A station from {@link TideConstituentGrid#createStation}.
 * @returns {object} `station`, mutated in place.
 */
TideConstituentGrid.prototype.sampleInto = function (
  longitudeDegrees,
  latitudeDegrees,
  station,
) {
  //>>includeStart('debug', pragmas.debug);
  if (!defined(station)) {
    throw new DeveloperError("station is required.");
  }
  //>>includeEnd('debug');

  station.valid = false;
  station.coverage = 0.0;
  station.amplitudeM.fill(0.0);
  station.phaseLagRadians.fill(0.0);

  let lon = longitudeDegrees;
  if (!(lon >= -180.0 && lon <= 180.0)) {
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
  const nx = this._nx;
  let x0 = Math.floor(x);
  let y0 = Math.floor(y);
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
  const w00 = (1.0 - fx) * (1.0 - fy);
  const w10 = fx * (1.0 - fy);
  const w01 = (1.0 - fx) * fy;
  const w11 = fx * fy;

  const values = this._values;
  const base0 = (y0 * nx + x0) * 2;
  const base1 = base0 + nx * 2;
  const scale = this._inverseUnits;
  let coverage = 0.0;

  for (let c = 0; c < station.constituents.length; c++) {
    const offset = c * this._stride;
    let re = 0.0;
    let im = 0.0;
    let weight = 0.0;
    // Unrolled over the four corners so the no-data test is a single compare
    // per corner and nothing is allocated.
    let index = offset + base0;
    if (values[index] !== TideConstituentGrid.NO_DATA) {
      re += w00 * values[index];
      im += w00 * values[index + 1];
      weight += w00;
    }
    index = offset + base0 + 2;
    if (values[index] !== TideConstituentGrid.NO_DATA) {
      re += w10 * values[index];
      im += w10 * values[index + 1];
      weight += w10;
    }
    index = offset + base1;
    if (values[index] !== TideConstituentGrid.NO_DATA) {
      re += w01 * values[index];
      im += w01 * values[index + 1];
      weight += w01;
    }
    index = offset + base1 + 2;
    if (values[index] !== TideConstituentGrid.NO_DATA) {
      re += w11 * values[index];
      im += w11 * values[index + 1];
      weight += w11;
    }
    if (weight > 0.0) {
      const inverseWeight = scale / weight;
      re *= inverseWeight;
      im *= inverseWeight;
      station.amplitudeM[c] = Math.sqrt(re * re + im * im);
      station.phaseLagRadians[c] = CesiumMath.zeroToTwoPi(Math.atan2(im, re));
      if (weight > coverage) {
        coverage = weight;
      }
    }
  }

  station.longitude = lon * CesiumMath.RADIANS_PER_DEGREE;
  station.latitude = lat * CesiumMath.RADIANS_PER_DEGREE;
  station.coverage = coverage;
  station.valid = coverage > 0.0;
  return station;
};

export default TideConstituentGrid;
