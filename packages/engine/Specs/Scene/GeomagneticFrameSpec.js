import Cartesian3 from "../../Source/Core/Cartesian3.js";
import Cartographic from "../../Source/Core/Cartographic.js";
import CesiumMath from "../../Source/Core/Math.js";
import GeomagneticFrame, {
  WMM2025_DIPOLE,
} from "../../Source/Scene/SpaceWeather/GeomagneticFrame.js";

describe("Scene/SpaceWeather/GeomagneticFrame", function () {
  // Reference vectors. The dipole tilt, the two forms of the pole latitude and
  // the pole longitude are the World Magnetic Model figures for epoch 2025.0
  // (https://www.ncei.noaa.gov/products/world-magnetic-model,
  // https://www.ncei.noaa.gov/products/wandering-geomagnetic-poles). The
  // geodetic figure is also derivable from the geocentric one on the WGS 84
  // ellipsoid through tan(geocentric) = (1-f)^2 tan(geodetic), which is the
  // check that the frame reads the ellipsoid rather than assuming a sphere.
  const degrees = CesiumMath.toDegrees;
  let frame;

  beforeEach(function () {
    frame = new GeomagneticFrame();
  });

  it("is tilted 9.21 degrees from the rotation axis", function () {
    expect(degrees(frame.dipoleTilt)).toBeCloseTo(9.21, 9);
  });

  it("places the north geomagnetic pole at 80.79 N geocentric, 72.76 W", function () {
    expect(degrees(frame.northPoleGeocentricLatitude)).toBeCloseTo(80.79, 9);
    expect(degrees(frame.northPoleLongitude)).toBeCloseTo(-72.76, 9);
  });

  it("reads the same pole geodetically as 80.85 N, 0.06 degrees away", function () {
    const geodetic = degrees(frame.northPoleGeodeticLatitude);
    expect(geodetic).toBeCloseTo(80.850609, 4);
    expect(geodetic - degrees(frame.northPoleGeocentricLatitude)).toBeCloseTo(
      0.060609,
      4,
    );
  });

  it("carries the model epoch and its validity window", function () {
    expect(frame.epoch).toBe(2025.0);
    expect(frame.epochEnd).toBe(2030.0);
    expect(frame.isWithinValidity(2027.5)).toBe(true);
    expect(frame.isWithinValidity(2031.0)).toBe(false);
    expect(WMM2025_DIPOLE.validYears).toBe(5.0);
  });

  it("accepts a replacement dipole rather than hiding one", function () {
    const shifted = new GeomagneticFrame({
      epoch: 2030.0,
      validYears: 5.0,
      poleGeocentricLatitude: CesiumMath.toRadians(80.0),
      poleLongitude: CesiumMath.toRadians(-70.0),
    });
    expect(degrees(shifted.dipoleTilt)).toBeCloseTo(10.0, 9);
    expect(shifted.epochEnd).toBe(2035.0);
  });

  it("reads 90 degrees geomagnetic at a site whose geographic latitude is 80.85", function () {
    const site = Cartographic.fromDegrees(-72.76, 80.85, 0.0);
    const geomagnetic = frame.cartographicToGeomagnetic(site);
    expect(degrees(geomagnetic.latitude)).toBeCloseTo(90.0, 2);
    expect(degrees(site.latitude)).toBeCloseTo(80.85, 9);
    expect(
      degrees(geomagnetic.latitude) - degrees(site.latitude),
    ).toBeGreaterThan(9.0);
  });

  it("puts the geographic north pole at 80.79 degrees geomagnetic", function () {
    const atPole = frame.directionToGeomagnetic(Cartesian3.UNIT_Z);
    expect(degrees(atPole.latitude)).toBeCloseTo(80.79, 9);
    expect(degrees(atPole.longitude)).toBeCloseTo(0.0, 9);
  });

  it("separates geomagnetic from geographic latitude at ordinary sites", function () {
    const sites = [
      { longitude: -147.716, latitude: 64.8378, geomagnetic: 65.520579 },
      { longitude: 18.955, latitude: 69.6492, geomagnetic: 67.377962 },
      { longitude: 170.5028, latitude: -45.8788, geomagnetic: -49.165965 },
    ];
    for (const site of sites) {
      const geomagnetic = frame.cartographicToGeomagnetic(
        Cartographic.fromDegrees(site.longitude, site.latitude, 0.0),
      );
      expect(degrees(geomagnetic.latitude)).toBeCloseTo(site.geomagnetic, 4);
      expect(
        Math.abs(degrees(geomagnetic.latitude) - site.latitude),
      ).toBeGreaterThan(0.5);
    }
  });

  it("round-trips a geomagnetic coordinate through the ellipsoid", function () {
    const latitude = CesiumMath.toRadians(63.0);
    const longitude = CesiumMath.toRadians(115.0);

    const onSurface = frame.directionToGeomagnetic(
      frame.geomagneticToFixed(latitude, longitude, 0.0),
    );
    expect(degrees(onSurface.latitude)).toBeCloseTo(63.0, 9);
    expect(degrees(onSurface.longitude)).toBeCloseTo(115.0, 9);

    // Height is measured along the geodetic normal, so a sample raised to shell
    // altitude is not on the geocentric ray through its footprint and its
    // geomagnetic latitude shifts by a few thousandths of a degree.
    const raised = frame.directionToGeomagnetic(
      frame.geomagneticToFixed(latitude, longitude, 110000.0),
    );
    expect(degrees(raised.latitude)).toBeCloseTo(63.002818, 4);
    expect(degrees(raised.longitude)).toBeCloseTo(114.998229, 4);
  });

  it("defines magnetic noon and midnight from the subsolar direction", function () {
    const sun = Cartesian3.normalize(
      new Cartesian3(0.9, 0.3, 0.32),
      new Cartesian3(),
    );
    const noon = frame.magneticNoonLongitude(sun);
    const midnight = frame.magneticMidnightLongitude(sun);
    expect(frame.magneticLocalTime(noon, sun)).toBeCloseTo(12.0, 9);
    expect(frame.magneticLocalTime(midnight, sun)).toBeCloseTo(0.0, 9);

    for (let hours = 0.0; hours < 24.0; hours += 0.25) {
      const longitude = frame.geomagneticLongitudeAtLocalTime(hours, sun);
      expect(frame.magneticLocalTime(longitude, sun)).toBeCloseTo(hours, 9);
    }
  });

  it("runs geomagnetic longitude eastward, so dawn and dusk are not interchanged", function () {
    const sun = Cartesian3.normalize(
      new Cartesian3(0.9, 0.3, 0.32),
      new Cartesian3(),
    );
    [10.0, 45.0, -30.0, 60.0].forEach(function (latitude) {
      const west = frame.cartographicToGeomagnetic(
        Cartographic.fromDegrees(0.0, latitude),
      );
      const east = frame.cartographicToGeomagnetic(
        Cartographic.fromDegrees(10.0, latitude),
      );
      const step = degrees(
        CesiumMath.negativePiToPi(east.longitude - west.longitude),
      );
      expect(step).toBeGreaterThan(8.0);
      expect(step).toBeLessThan(12.0);
      expect(frame.magneticLocalTime(east.longitude, sun)).toBeGreaterThan(
        frame.magneticLocalTime(west.longitude, sun),
      );
    });
  });

  it("points the dipole field into the surface at the north pole and out at the south", function () {
    const north = frame.geomagneticToFixed(CesiumMath.PI_OVER_TWO, 0.0, 0.0);
    const south = frame.geomagneticToFixed(-CesiumMath.PI_OVER_TWO, 0.0, 0.0);
    const normal = new Cartesian3();

    frame.ellipsoid.geodeticSurfaceNormal(north, normal);
    expect(
      Cartesian3.dot(frame.dipoleFieldDirection(north), normal),
    ).toBeCloseTo(-1.0, 5);

    frame.ellipsoid.geodeticSurfaceNormal(south, normal);
    expect(
      Cartesian3.dot(frame.dipoleFieldDirection(south), normal),
    ).toBeCloseTo(1.0, 5);
  });

  it("holds the dipole field horizontal on the geomagnetic equator", function () {
    const position = frame.geomagneticToFixed(
      0.0,
      CesiumMath.toRadians(40.0),
      0.0,
    );
    const geocentric = Cartesian3.normalize(position, new Cartesian3());
    expect(
      Cartesian3.dot(frame.dipoleFieldDirection(position), geocentric),
    ).toBeCloseTo(0.0, 12);
  });
});
