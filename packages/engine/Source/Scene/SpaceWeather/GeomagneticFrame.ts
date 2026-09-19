import Cartesian3 from "../../Core/Cartesian3.js";
import Cartographic from "../../Core/Cartographic.js";
import Check from "../../Core/Check.js";
import Ellipsoid from "../../Core/Ellipsoid.js";
import CesiumMath from "../../Core/Math.js";

/**
 * Centred-dipole geomagnetic coordinates, in the backend-agnostic Scene layer.
 *
 * Auroral geometry is organised by the geomagnetic field, not by geography: an
 * oval drawn on parallels of geographic latitude is in the wrong place by up to
 * the dipole tilt, and it fails to move with the Sun the way the real oval
 * does. This module supplies the frame that {@link AuroralOvalModel} and the
 * emission shell are expressed in, and nothing else — it performs no ingest, it
 * reads no network, and it holds no renderer state.
 *
 * The model is the centred dipole: the first three Gauss coefficients of the
 * World Magnetic Model reduced to a single tilted dipole through the centre of
 * the ellipsoid. It is the coarsest useful magnetic frame and it is enough for
 * a synthetic oval; it is deliberately not a full spherical-harmonic field, so
 * it must not be used for navigation, declination, or dip-pole questions. The
 * geomagnetic poles it defines are the axis poles of that dipole and are a
 * different thing from the magnetic dip poles, which wander far from them.
 *
 * Coordinates. Geomagnetic latitude is measured from the plane normal to the
 * dipole axis, so the north geomagnetic pole is at +90 degrees. Geomagnetic
 * longitude is measured in the plane normal to the axis from the meridian
 * containing the geographic north pole, eastward about the axis. That choice of
 * prime meridian is a convention; magnetic local time is defined as a
 * difference of geomagnetic longitudes and is therefore independent of it.
 *
 * Geodetic against geocentric. The dipole axis is a geocentric direction, so
 * the pole is stated as a geocentric latitude and the transform runs through
 * the geocentric direction of a position, which is what
 * {@link Ellipsoid#cartographicToCartesian} produces. A site's geodetic
 * latitude — the one a map prints — differs from its geocentric latitude by up
 * to about 0.19 degrees, and using the geodetic value where the geocentric one
 * belongs moves the pole by about 0.06 degrees. The two forms of the pole
 * latitude are both exposed so a caller can never silently take the wrong one.
 *
 * @see {@link https://www.ncei.noaa.gov/products/world-magnetic-model}
 * @see {@link https://www.ncei.noaa.gov/products/wandering-geomagnetic-poles}
 */

/** Hours in a day, the period magnetic local time is expressed in. */
const HOURS_PER_DAY = 24.0;

/** Radians per hour of magnetic local time. */
const RADIANS_PER_HOUR = CesiumMath.TWO_PI / HOURS_PER_DAY;

/**
 * A centred-dipole axis, stated the way the model that produced it states it.
 *
 * `epoch` and `validYears` are carried rather than folded into the numbers
 * because the World Magnetic Model is reissued on a five-year cycle and the
 * axis moves between issues; a caller that needs a different epoch supplies a
 * different definition instead of editing a constant.
 */
export interface GeomagneticPoleDefinition {
  /** Decimal year the pole position is stated for. */
  readonly epoch: number;
  /** Years after `epoch` the issuing model is valid for. */
  readonly validYears: number;
  /** Geocentric latitude of the north geomagnetic pole, in radians. */
  readonly poleGeocentricLatitude: number;
  /** East longitude of the north geomagnetic pole, in radians. */
  readonly poleLongitude: number;
}

/**
 * The centred dipole of the World Magnetic Model issue for epoch 2025.0: the
 * axis is tilted 9.21 degrees from the rotation axis and the north geomagnetic
 * pole sits at 80.79 degrees north geocentric, 72.76 degrees west. The tilt is
 * the geocentric colatitude of that pole and is derived rather than stored, so
 * the two can never disagree.
 *
 * @see {@link https://www.ncei.noaa.gov/products/world-magnetic-model}
 */
export const WMM2025_DIPOLE: GeomagneticPoleDefinition = Object.freeze({
  epoch: 2025.0,
  validYears: 5.0,
  poleGeocentricLatitude: CesiumMath.toRadians(80.79),
  poleLongitude: CesiumMath.toRadians(-72.76),
});

/** A position in centred-dipole coordinates, in radians. */
export interface GeomagneticCoordinates {
  /** Geomagnetic latitude, +PI/2 at the north geomagnetic pole. */
  latitude: number;
  /** Geomagnetic longitude, eastward about the dipole axis. */
  longitude: number;
}

const scratchCartesian = new Cartesian3();
const scratchDirection = new Cartesian3();
const scratchAxisTerm = new Cartesian3();
const scratchCartographic = new Cartographic();
const scratchCoordinates: GeomagneticCoordinates = {
  latitude: 0.0,
  longitude: 0.0,
};

/** Wrap an hour count into `[0, 24)`. */
function zeroToTwentyFourHours(hours: number): number {
  const wrapped = hours % HOURS_PER_DAY;
  return wrapped < 0.0 ? wrapped + HOURS_PER_DAY : wrapped;
}

/**
 * The centred-dipole frame of one geomagnetic model epoch, on one ellipsoid.
 *
 * Instances are immutable: the basis is built once in the constructor, so every
 * per-sample call is three dot products and no allocation.
 */
class GeomagneticFrame {
  private readonly _definition: GeomagneticPoleDefinition;
  private readonly _ellipsoid: Ellipsoid;
  private readonly _axis: Cartesian3;
  private readonly _primeMeridian: Cartesian3;
  private readonly _eastward: Cartesian3;
  private readonly _dipoleTilt: number;
  private readonly _poleGeodeticLatitude: number;

  /**
   * @param definition The dipole axis to use.
   * @param ellipsoid The ellipsoid geodetic positions are stated on.
   */
  constructor(
    definition: GeomagneticPoleDefinition = WMM2025_DIPOLE,
    ellipsoid: Ellipsoid = Ellipsoid.default,
  ) {
    //>>includeStart('debug', pragmas.debug);
    Check.typeOf.number("definition.epoch", definition.epoch);
    Check.typeOf.number(
      "definition.poleGeocentricLatitude",
      definition.poleGeocentricLatitude,
    );
    Check.typeOf.number("definition.poleLongitude", definition.poleLongitude);
    //>>includeEnd('debug');

    this._definition = definition;
    this._ellipsoid = ellipsoid;

    const colatitude =
      CesiumMath.PI_OVER_TWO - definition.poleGeocentricLatitude;
    const sinColatitude = Math.sin(colatitude);
    const axis = new Cartesian3(
      sinColatitude * Math.cos(definition.poleLongitude),
      sinColatitude * Math.sin(definition.poleLongitude),
      Math.cos(colatitude),
    );
    Cartesian3.normalize(axis, axis);
    this._axis = axis;
    this._dipoleTilt = Math.acos(CesiumMath.clamp(axis.z, -1.0, 1.0));

    // The prime meridian is the one containing the geographic north pole, so
    // the eastward basis vector is normal to both axes. When the dipole is not
    // tilted at all the two axes are parallel and that cross product vanishes;
    // the geographic prime meridian is then the only meaningful choice, and
    // taking it keeps a zero-tilt definition usable instead of producing a
    // frame full of NaN.
    const eastward = Cartesian3.cross(
      axis,
      Cartesian3.UNIT_Z,
      new Cartesian3(),
    );
    if (Cartesian3.magnitude(eastward) < CesiumMath.EPSILON10) {
      Cartesian3.clone(Cartesian3.UNIT_Y, eastward);
    } else {
      Cartesian3.normalize(eastward, eastward);
    }
    this._eastward = eastward;
    this._primeMeridian = Cartesian3.cross(eastward, axis, new Cartesian3());
    Cartesian3.normalize(this._primeMeridian, this._primeMeridian);

    // The geodetic latitude of the pole is not a second datum to keep in step
    // with the geocentric one; it is that datum read on this ellipsoid.
    const polePosition = ellipsoid.scaleToGeocentricSurface(
      Cartesian3.clone(axis, scratchCartesian),
      scratchCartesian,
    );
    const poleCartographic = ellipsoid.cartesianToCartographic(
      polePosition,
      scratchCartographic,
    );
    this._poleGeodeticLatitude = poleCartographic.latitude;
  }

  /** The dipole definition this frame was built from. */
  get definition(): GeomagneticPoleDefinition {
    return this._definition;
  }

  /** The ellipsoid geodetic positions are stated on. */
  get ellipsoid(): Ellipsoid {
    return this._ellipsoid;
  }

  /** Decimal year the dipole axis is stated for. */
  get epoch(): number {
    return this._definition.epoch;
  }

  /** Decimal year the issuing model's validity ends. */
  get epochEnd(): number {
    return this._definition.epoch + this._definition.validYears;
  }

  /** Angle between the dipole axis and the rotation axis, in radians. */
  get dipoleTilt(): number {
    return this._dipoleTilt;
  }

  /** Unit vector toward the north geomagnetic pole, in the fixed frame. */
  get axis(): Cartesian3 {
    return this._axis;
  }

  /** Geocentric latitude of the north geomagnetic pole, in radians. */
  get northPoleGeocentricLatitude(): number {
    return this._definition.poleGeocentricLatitude;
  }

  /** Geodetic latitude of the north geomagnetic pole, in radians. */
  get northPoleGeodeticLatitude(): number {
    return this._poleGeodeticLatitude;
  }

  /** East longitude of the north geomagnetic pole, in radians. */
  get northPoleLongitude(): number {
    return this._definition.poleLongitude;
  }

  /**
   * Whether a decimal year falls inside the issuing model's validity window.
   *
   * @param decimalYear The year to test.
   * @returns True while the epoch's coefficients still apply.
   */
  isWithinValidity(decimalYear: number): boolean {
    return decimalYear >= this.epoch && decimalYear <= this.epochEnd;
  }

  /**
   * Geomagnetic coordinates of a geocentric direction.
   *
   * @param direction A direction from the centre of the ellipsoid; need not be
   *        unit length.
   * @param result The object to store the result in.
   * @returns The geomagnetic latitude and longitude, in radians.
   */
  directionToGeomagnetic(
    direction: Cartesian3,
    result?: GeomagneticCoordinates,
  ): GeomagneticCoordinates {
    //>>includeStart('debug', pragmas.debug);
    Check.defined("direction", direction);
    //>>includeEnd('debug');

    const unit = Cartesian3.normalize(direction, scratchDirection);
    const alongAxis = CesiumMath.clamp(
      Cartesian3.dot(unit, this._axis),
      -1.0,
      1.0,
    );
    const latitude = Math.asin(alongAxis);
    const longitude = Math.atan2(
      Cartesian3.dot(unit, this._eastward),
      Cartesian3.dot(unit, this._primeMeridian),
    );

    if (result === undefined) {
      return { latitude: latitude, longitude: longitude };
    }
    result.latitude = latitude;
    result.longitude = longitude;
    return result;
  }

  /**
   * Geomagnetic coordinates of a geodetic position.
   *
   * The height matters: a point raised along the geodetic normal is not on the
   * geocentric ray through the surface point below it, so an emission sample at
   * shell altitude has a slightly different geomagnetic latitude from its
   * ground footprint.
   *
   * @param cartographic The geodetic position.
   * @param result The object to store the result in.
   * @returns The geomagnetic latitude and longitude, in radians.
   */
  cartographicToGeomagnetic(
    cartographic: Cartographic,
    result?: GeomagneticCoordinates,
  ): GeomagneticCoordinates {
    //>>includeStart('debug', pragmas.debug);
    Check.defined("cartographic", cartographic);
    //>>includeEnd('debug');

    const position = this._ellipsoid.cartographicToCartesian(
      cartographic,
      scratchCartesian,
    );
    return this.directionToGeomagnetic(position, result);
  }

  /**
   * The fixed-frame position of a geomagnetic coordinate at a height above the
   * ellipsoid.
   *
   * Height is measured along the geodetic normal, as everywhere else in the
   * Scene layer, so a shell at a constant height is the ellipsoid offset
   * outward rather than a sphere.
   *
   * @param latitude Geomagnetic latitude, in radians.
   * @param longitude Geomagnetic longitude, in radians.
   * @param height Height above the ellipsoid, in metres.
   * @param result The object to store the result in.
   * @returns The position in the fixed frame.
   */
  geomagneticToFixed(
    latitude: number,
    longitude: number,
    height: number,
    result?: Cartesian3,
  ): Cartesian3 {
    const cartographic = this.geomagneticToCartographic(
      latitude,
      longitude,
      scratchCartographic,
    );
    cartographic.height = height;
    return this._ellipsoid.cartographicToCartesian(
      cartographic,
      result ?? new Cartesian3(),
    );
  }

  /**
   * The geodetic position under a geomagnetic coordinate.
   *
   * @param latitude Geomagnetic latitude, in radians.
   * @param longitude Geomagnetic longitude, in radians.
   * @param result The object to store the result in.
   * @returns The geodetic longitude and latitude at zero height.
   */
  geomagneticToCartographic(
    latitude: number,
    longitude: number,
    result?: Cartographic,
  ): Cartographic {
    const cosLatitude = Math.cos(latitude);
    const direction = scratchDirection;
    Cartesian3.multiplyByScalar(
      this._primeMeridian,
      cosLatitude * Math.cos(longitude),
      direction,
    );
    Cartesian3.add(
      direction,
      Cartesian3.multiplyByScalar(
        this._eastward,
        cosLatitude * Math.sin(longitude),
        scratchAxisTerm,
      ),
      direction,
    );
    Cartesian3.add(
      direction,
      Cartesian3.multiplyByScalar(
        this._axis,
        Math.sin(latitude),
        scratchAxisTerm,
      ),
      direction,
    );

    const surface = this._ellipsoid.scaleToGeocentricSurface(
      direction,
      scratchCartesian,
    );
    return this._ellipsoid.cartesianToCartographic(
      surface,
      result ?? new Cartographic(),
    );
  }

  /**
   * Geomagnetic longitude of the subsolar direction — magnetic noon.
   *
   * @param sunDirectionFixed Direction to the Sun in the fixed frame.
   * @returns The geomagnetic longitude of magnetic noon, in radians.
   */
  magneticNoonLongitude(sunDirectionFixed: Cartesian3): number {
    return this.directionToGeomagnetic(sunDirectionFixed, scratchCoordinates)
      .longitude;
  }

  /**
   * Geomagnetic longitude of the antisolar direction — magnetic midnight, the
   * meridian the oval reaches furthest equatorward on.
   *
   * @param sunDirectionFixed Direction to the Sun in the fixed frame.
   * @returns The geomagnetic longitude of magnetic midnight, in radians.
   */
  magneticMidnightLongitude(sunDirectionFixed: Cartesian3): number {
    return CesiumMath.negativePiToPi(
      this.magneticNoonLongitude(sunDirectionFixed) + CesiumMath.PI,
    );
  }

  /**
   * Magnetic local time of a geomagnetic longitude.
   *
   * Magnetic local time is the Sun's hour angle about the dipole axis rather
   * than about the rotation axis: noon is the subsolar geomagnetic meridian and
   * midnight is its antipode, so the oval stays fixed relative to the Sun while
   * the ellipsoid turns underneath it.
   *
   * @param geomagneticLongitude The longitude to convert, in radians.
   * @param sunDirectionFixed Direction to the Sun in the fixed frame.
   * @returns Magnetic local time in hours, in `[0, 24)`.
   */
  magneticLocalTime(
    geomagneticLongitude: number,
    sunDirectionFixed: Cartesian3,
  ): number {
    const noon = this.magneticNoonLongitude(sunDirectionFixed);
    return zeroToTwentyFourHours(
      12.0 + (geomagneticLongitude - noon) / RADIANS_PER_HOUR,
    );
  }

  /**
   * The geomagnetic longitude a magnetic local time falls on — the inverse of
   * {@link GeomagneticFrame#magneticLocalTime}.
   *
   * @param magneticLocalTime Magnetic local time in hours.
   * @param sunDirectionFixed Direction to the Sun in the fixed frame.
   * @returns The geomagnetic longitude, in radians.
   */
  geomagneticLongitudeAtLocalTime(
    magneticLocalTime: number,
    sunDirectionFixed: Cartesian3,
  ): number {
    const noon = this.magneticNoonLongitude(sunDirectionFixed);
    return CesiumMath.negativePiToPi(
      noon + (magneticLocalTime - 12.0) * RADIANS_PER_HOUR,
    );
  }

  /**
   * Unit vector along the centred-dipole field at a position, pointing the way
   * the field does — down into the surface near the north geomagnetic pole,
   * horizontal and geomagnetic-northward at the geomagnetic equator, and up out
   * of the surface near the south geomagnetic pole.
   *
   * Auroral curtains are field-aligned sheets, so this is the direction a
   * curtain is extruded along; using the local geodetic normal instead would
   * hold the curtains vertical and lose the dip that makes them read as
   * hanging rays away from the poles.
   *
   * @param positionFixed A position in the fixed frame.
   * @param result The object to store the result in.
   * @returns The unit field direction.
   */
  dipoleFieldDirection(
    positionFixed: Cartesian3,
    result?: Cartesian3,
  ): Cartesian3 {
    //>>includeStart('debug', pragmas.debug);
    Check.defined("positionFixed", positionFixed);
    //>>includeEnd('debug');

    const out = result ?? new Cartesian3();
    const unit = Cartesian3.normalize(positionFixed, scratchDirection);
    const alongAxis = Cartesian3.dot(this._axis, unit);

    // The geomagnetic north pole is a magnetic south pole, so the moment points
    // opposite the axis and the dipole field reduces to axis - 3 (axis . r) r.
    Cartesian3.multiplyByScalar(unit, 3.0 * alongAxis, scratchAxisTerm);
    Cartesian3.subtract(this._axis, scratchAxisTerm, out);
    return Cartesian3.normalize(out, out);
  }
}

export default GeomagneticFrame;
