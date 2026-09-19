// aurora-geomagnetic-oval.spec.mjs — the Node twin of the geomagnetic frame and
// synthetic auroral oval. Pure Node: no browser, no GPU, no network.
//
// @purpose Asserts the centred-dipole frame and the synthetic oval against CPU reference vectors — the pole to its published figures, geomagnetic against geographic latitude, geocentric against geodetic, north against south, and quiet against storm geometry.
// @status ACTIVE
//
// WHAT THIS SPEC IS FOR. Auroral geometry has four discriminations that are
// easy to get wrong and invisible once rendered, because a wrong oval still
// looks like an oval:
//
//   1. geomagnetic latitude against geographic latitude,
//   2. the geocentric pole figure against the geodetic one,
//   3. the northern oval against the southern,
//   4. quiet geometry against storm geometry.
//
// Every assertion below reads a NUMBER out of the real modules — a latitude, an
// hour, a dot product — rather than checking that the source contains a term.
// The four mutations named in the packet each change one of those numbers, and
// each one turns a named test here red.
//
// REFERENCE VECTORS AND THEIR SOURCES.
//
//   Centred-dipole tilt 9.21 deg; north geomagnetic pole 80.79 deg N geocentric,
//   80.85 deg N geodetic, 72.76 deg W, at epoch 2025.0 — the World Magnetic
//   Model issue for that epoch, https://www.ncei.noaa.gov/products/world-magnetic-model
//   and https://www.ncei.noaa.gov/products/wandering-geomagnetic-poles.
//
//   Geodetic-to-geocentric conversion on the WGS 84 ellipsoid
//   (a = 6378137 m, 1/f = 298.257223563): tan(geocentric) = (1-f)^2 tan(geodetic),
//   so 80.85 deg geodetic is 80.789387 deg geocentric and the two forms of the
//   pole differ by 0.0606 deg. That is the "0.06 deg" the two published figures
//   differ by, and it is reproduced here from the ellipsoid rather than restated.
//
//   Equatorward edge of the auroral oval in geomagnetic latitude, 66 deg at
//   K 0 falling about 2 deg per step to 48 deg at K 9. NOAA SWPC states this in
//   prose, not as a table: https://www.spaceweather.gov/content/tips-viewing-aurora.
//
//   Site coordinates are the sites' own published positions and are used only to
//   show that a geographic latitude and a geomagnetic latitude are different
//   numbers at the same place.
//
// THE MODULE SEAM. The two modules under test are loaded from a directory that
// defaults to the engine source and can be redirected with
// CESIUM_AURORA_MODULE_DIR. That seam exists so a mutation run can point this
// same spec at a mutated copy under the OS temp directory; nothing in the engine
// reads the variable, and the default path is what every ordinary run uses.
//
// Run: node --test Tools/visual-regression/aurora-geomagnetic-oval.spec.mjs

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import Cartesian3 from "../../packages/engine/Source/Core/Cartesian3.js";
import Cartographic from "../../packages/engine/Source/Core/Cartographic.js";
import CesiumMath from "../../packages/engine/Source/Core/Math.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_MODULE_DIR = path.resolve(
  HERE,
  "..",
  "..",
  "packages",
  "engine",
  "Source",
  "Scene",
  "SpaceWeather",
);
const MODULE_DIR = process.env.CESIUM_AURORA_MODULE_DIR ?? DEFAULT_MODULE_DIR;

const frameModule = await import(
  pathToFileURL(path.join(MODULE_DIR, "GeomagneticFrame.ts")).href
);
const ovalModule = await import(
  pathToFileURL(path.join(MODULE_DIR, "AuroralOvalModel.ts")).href
);

const GeomagneticFrame = frameModule.default;
const AuroralOvalModel = ovalModule.default;
const {
  AURORAL_VIEWLINE_LATITUDES_DEGREES,
  AuroralOvalHemisphere,
  auroralActivityIndex,
  auroralViewlineLatitude,
} = ovalModule;

const degrees = CesiumMath.toDegrees;
const radians = CesiumMath.toRadians;

const frame = new GeomagneticFrame();
const oval = new AuroralOvalModel();

/** A Sun direction with no special relationship to the dipole meridian. */
const SUN_DIRECTION = Cartesian3.normalize(
  new Cartesian3(0.9, 0.3, 0.32),
  new Cartesian3(),
);

/** Every quarter hour of magnetic local time, for the sweeps. */
const LOCAL_TIMES = Array.from({ length: 96 }, (unused, index) => index * 0.25);

function assertClose(actual, expected, tolerance, what) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${what}: expected ${expected} +/- ${tolerance}, got ${actual}`,
  );
}

// ---------------------------------------------------------------------------
// The dipole, against the published figures
// ---------------------------------------------------------------------------

test("the centred dipole is tilted 9.21 degrees from the rotation axis", () => {
  assertClose(degrees(frame.dipoleTilt), 9.21, 1e-9, "dipole tilt");
});

test("the north geomagnetic pole is at 80.79 N geocentric, 72.76 W", () => {
  assertClose(
    degrees(frame.northPoleGeocentricLatitude),
    80.79,
    1e-9,
    "pole geocentric latitude",
  );
  assertClose(
    degrees(frame.northPoleLongitude),
    -72.76,
    1e-9,
    "pole longitude",
  );
});

test("the same pole read geodetically is 80.85 N, 0.06 degrees from the geocentric figure", () => {
  const geodetic = degrees(frame.northPoleGeodeticLatitude);
  const geocentric = degrees(frame.northPoleGeocentricLatitude);
  assertClose(geodetic, 80.850609, 1e-4, "pole geodetic latitude");
  assertClose(
    geodetic - geocentric,
    0.060609,
    1e-4,
    "geodetic minus geocentric",
  );
});

test("the model epoch and its validity window are carried, not folded into the numbers", () => {
  assert.equal(frame.epoch, 2025.0);
  assert.equal(frame.epochEnd, 2030.0);
  assert.equal(frame.isWithinValidity(2027.5), true);
  assert.equal(frame.isWithinValidity(2031.0), false);
});

// ---------------------------------------------------------------------------
// Geomagnetic latitude is not geographic latitude
// ---------------------------------------------------------------------------

test("a site at the geomagnetic pole reads 90 degrees geomagnetic while its geographic latitude does not", () => {
  const site = Cartographic.fromDegrees(-72.76, 80.85, 0.0);
  const geomagnetic = frame.cartographicToGeomagnetic(site);
  assertClose(
    degrees(geomagnetic.latitude),
    90.0,
    0.01,
    "geomagnetic latitude at the pole site",
  );
  assert.equal(degrees(site.latitude).toFixed(6), "80.850000");
  assert.ok(
    degrees(geomagnetic.latitude) - degrees(site.latitude) > 9.0,
    "the two latitudes at the pole site must differ by about the dipole tilt",
  );
});

test("the geographic north pole is 80.79 degrees geomagnetic, not 90", () => {
  const atPole = frame.directionToGeomagnetic(Cartesian3.UNIT_Z);
  assertClose(
    degrees(atPole.latitude),
    80.79,
    1e-9,
    "geomagnetic latitude of the geographic north pole",
  );
});

test("geomagnetic and geographic latitude differ at ordinary sites, in both hemispheres", () => {
  const sites = [
    { longitude: -147.716, latitude: 64.8378, geomagnetic: 65.520579 },
    { longitude: 18.955, latitude: 69.6492, geomagnetic: 67.377962 },
    { longitude: 170.5028, latitude: -45.8788, geomagnetic: -49.165965 },
  ];
  for (const site of sites) {
    const geomagnetic = frame.cartographicToGeomagnetic(
      Cartographic.fromDegrees(site.longitude, site.latitude, 0.0),
    );
    assertClose(
      degrees(geomagnetic.latitude),
      site.geomagnetic,
      1e-4,
      `geomagnetic latitude at longitude ${site.longitude}`,
    );
    assert.ok(
      Math.abs(degrees(geomagnetic.latitude) - site.latitude) > 0.5,
      `geomagnetic latitude at longitude ${site.longitude} must not be the geographic one`,
    );
  }
});

// ---------------------------------------------------------------------------
// Magnetic local time
// ---------------------------------------------------------------------------

test("magnetic noon is the subsolar geomagnetic meridian and magnetic midnight is its antipode", () => {
  const noon = frame.magneticNoonLongitude(SUN_DIRECTION);
  const midnight = frame.magneticMidnightLongitude(SUN_DIRECTION);
  assertClose(
    frame.magneticLocalTime(noon, SUN_DIRECTION),
    12.0,
    1e-9,
    "magnetic local time of the subsolar meridian",
  );
  assertClose(
    frame.magneticLocalTime(midnight, SUN_DIRECTION),
    0.0,
    1e-9,
    "magnetic local time of the antisolar meridian",
  );
  assertClose(
    Math.abs(degrees(CesiumMath.negativePiToPi(midnight - noon))),
    180.0,
    1e-9,
    "separation of magnetic noon and midnight",
  );
});

test("magnetic local time round-trips through the geomagnetic longitude it names", () => {
  for (const hours of LOCAL_TIMES) {
    const longitude = frame.geomagneticLongitudeAtLocalTime(
      hours,
      SUN_DIRECTION,
    );
    assertClose(
      frame.magneticLocalTime(longitude, SUN_DIRECTION),
      hours % 24.0,
      1e-9,
      `round trip at magnetic local time ${hours}`,
    );
  }
});

test("geomagnetic longitude runs eastward, so dawn and dusk are not interchanged", () => {
  // Ten degrees east of a site, at the same latitude, must be about ten degrees
  // east in geomagnetic longitude and later in magnetic local time. The oval's
  // shape terms are even in magnetic local time, so a frame whose longitude ran
  // westward would mirror the dawn and dusk sectors and still satisfy every
  // other assertion in this file.
  for (const latitude of [10.0, 45.0, -30.0, 60.0]) {
    const west = frame.cartographicToGeomagnetic(
      Cartographic.fromDegrees(0.0, latitude),
    );
    const east = frame.cartographicToGeomagnetic(
      Cartographic.fromDegrees(10.0, latitude),
    );
    const step = degrees(
      CesiumMath.negativePiToPi(east.longitude - west.longitude),
    );
    assert.ok(
      step > 8.0 && step < 12.0,
      `ten degrees east must be about ten degrees of geomagnetic longitude east at latitude ${latitude}, got ${step}`,
    );
    assert.ok(
      frame.magneticLocalTime(east.longitude, SUN_DIRECTION) >
        frame.magneticLocalTime(west.longitude, SUN_DIRECTION),
      `moving east must be moving later in magnetic local time at latitude ${latitude}`,
    );
  }
});

// ---------------------------------------------------------------------------
// The oval: anchor, asymmetry, activity
// ---------------------------------------------------------------------------

test("the magnetic-midnight equatorward boundary reproduces the published viewline latitudes", () => {
  for (let index = 0; index < 10; index++) {
    const boundaries = oval.boundaries(index, 0.0);
    assertClose(
      degrees(boundaries.equatorwardLatitude),
      AURORAL_VIEWLINE_LATITUDES_DEGREES[index],
      1e-9,
      `midnight equatorward boundary at activity ${index}`,
    );
  }
  assertClose(
    degrees(auroralViewlineLatitude(2.5)),
    61.0,
    1e-9,
    "the table interpolates between its steps",
  );
});

test("the oval reaches furthest equatorward at magnetic midnight and furthest poleward on the day side", () => {
  let lowest = Number.POSITIVE_INFINITY;
  let lowestHour = -1.0;
  let highest = Number.NEGATIVE_INFINITY;
  let highestHour = -1.0;
  for (const hours of LOCAL_TIMES) {
    const latitude = degrees(oval.boundaries(3.0, hours).equatorwardLatitude);
    if (latitude < lowest) {
      lowest = latitude;
      lowestHour = hours;
    }
    if (latitude > highest) {
      highest = latitude;
      highestHour = hours;
    }
  }
  assert.equal(lowestHour, 0.0);
  assert.ok(
    highestHour > 9.0 && highestHour < 16.0,
    `the poleward extreme belongs to the noon sector, found ${highestHour}`,
  );
  assert.ok(
    highest - lowest > 5.0,
    `the noon-midnight displacement must be several degrees, found ${highest - lowest}`,
  );
});

test("the oval is not a circle offset from the geomagnetic pole", () => {
  const colatitude = (hours) =>
    90.0 - degrees(oval.boundaries(3.0, hours).equatorwardLatitude);
  const firstHarmonicPrediction = (colatitude(0.0) + colatitude(12.0)) / 2.0;
  // A shape carrying only the first harmonic would put dawn and dusk exactly
  // halfway between midnight and noon. Both sectors miss that by degrees.
  assert.ok(
    Math.abs(colatitude(6.0) - firstHarmonicPrediction) > 1.0,
    "the dawn sector must not sit halfway between midnight and noon",
  );
  assert.ok(
    Math.abs(colatitude(18.0) - firstHarmonicPrediction) > 1.0,
    "the dusk sector must not sit halfway between midnight and noon",
  );
});

test("the oval is wider on the night side than on the day side", () => {
  const midnight = degrees(oval.boundaries(3.0, 0.0).width);
  const noon = degrees(oval.boundaries(3.0, 12.0).width);
  assert.ok(
    midnight > 2.0 * noon,
    `night width ${midnight} must exceed twice the day width ${noon}`,
  );
  for (const hours of LOCAL_TIMES) {
    for (let activity = 0; activity <= 9; activity++) {
      assert.ok(
        oval.boundaries(activity, hours).width > 0.0,
        `width must stay positive at activity ${activity}, hour ${hours}`,
      );
    }
  }
});

test("the quiet oval lies poleward of the storm oval at every magnetic local time, in both hemispheres", () => {
  for (const hours of LOCAL_TIMES) {
    const quietNorth = oval.boundaries(0.0, hours, AuroralOvalHemisphere.NORTH);
    const stormNorth = oval.boundaries(9.0, hours, AuroralOvalHemisphere.NORTH);
    assert.ok(
      quietNorth.equatorwardLatitude > stormNorth.equatorwardLatitude,
      `northern equatorward edge at hour ${hours}`,
    );
    assert.ok(
      quietNorth.polewardLatitude > stormNorth.polewardLatitude,
      `northern poleward edge at hour ${hours}`,
    );

    const quietSouth = oval.boundaries(0.0, hours, AuroralOvalHemisphere.SOUTH);
    const stormSouth = oval.boundaries(9.0, hours, AuroralOvalHemisphere.SOUTH);
    assert.ok(
      quietSouth.equatorwardLatitude < stormSouth.equatorwardLatitude,
      `southern equatorward edge at hour ${hours}`,
    );
    assert.ok(
      quietSouth.polewardLatitude < stormSouth.polewardLatitude,
      `southern poleward edge at hour ${hours}`,
    );
  }
});

test("the oval expands equatorward at every step of activity, at every magnetic local time", () => {
  for (const hours of LOCAL_TIMES) {
    for (let step = 0; step < 90; step++) {
      const lower = oval.boundaries(step / 10.0, hours).equatorwardLatitude;
      const higher = oval.boundaries(
        (step + 1) / 10.0,
        hours,
      ).equatorwardLatitude;
      assert.ok(
        lower - higher > 1e-6,
        `activity ${step / 10} to ${(step + 1) / 10} at hour ${hours} must move the edge equatorward`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Two hemispheres, mirrored in geomagnetic latitude only
// ---------------------------------------------------------------------------

test("the two ovals are exact mirrors in geomagnetic latitude", () => {
  for (const hours of LOCAL_TIMES) {
    const north = oval.boundaries(5.0, hours, AuroralOvalHemisphere.NORTH);
    const south = oval.boundaries(5.0, hours, AuroralOvalHemisphere.SOUTH);
    assert.equal(south.equatorwardLatitude, -north.equatorwardLatitude);
    assert.equal(south.polewardLatitude, -north.polewardLatitude);
    assert.equal(south.width, north.width);
    assert.ok(
      Math.abs(south.polewardLatitude) > Math.abs(south.equatorwardLatitude),
      `the southern poleward edge must be nearer the pole at hour ${hours}`,
    );
  }
});

test("the two ovals are NOT mirrors in geographic latitude", () => {
  // On the geomagnetic meridian through the geographic north pole the tilt is
  // seen at full strength, and it moves the two ovals in the same geographic
  // direction rather than opposite ones.
  const north = frame.geomagneticToCartographic(radians(67.0), 0.0);
  const south = frame.geomagneticToCartographic(radians(-67.0), 0.0);
  assertClose(
    degrees(north.latitude),
    76.298825,
    1e-4,
    "geographic latitude under geomagnetic +67 on the dipole meridian",
  );
  assertClose(
    degrees(south.latitude),
    -57.963311,
    1e-4,
    "geographic latitude under geomagnetic -67 on the dipole meridian",
  );
  assert.ok(
    Math.abs(degrees(north.latitude) + degrees(south.latitude)) > 15.0,
    "the geographic latitudes of the mirrored ovals must not mirror",
  );
});

// ---------------------------------------------------------------------------
// Curtain direction
// ---------------------------------------------------------------------------

test("the dipole field points into the surface at the north geomagnetic pole and out of it at the south", () => {
  const north = frame.geomagneticToFixed(CesiumMath.PI_OVER_TWO, 0.0, 0.0);
  const south = frame.geomagneticToFixed(-CesiumMath.PI_OVER_TWO, 0.0, 0.0);
  const normal = new Cartesian3();

  frame.ellipsoid.geodeticSurfaceNormal(north, normal);
  assertClose(
    Cartesian3.dot(frame.dipoleFieldDirection(north), normal),
    -1.0,
    1e-5,
    "field against the local normal at the north geomagnetic pole",
  );

  frame.ellipsoid.geodeticSurfaceNormal(south, normal);
  assertClose(
    Cartesian3.dot(frame.dipoleFieldDirection(south), normal),
    1.0,
    1e-5,
    "field against the local normal at the south geomagnetic pole",
  );
});

test("the dipole field is horizontal on the geomagnetic equator", () => {
  const position = frame.geomagneticToFixed(0.0, radians(40.0), 0.0);
  const geocentric = Cartesian3.normalize(position, new Cartesian3());
  assertClose(
    Cartesian3.dot(frame.dipoleFieldDirection(position), geocentric),
    0.0,
    1e-12,
    "field against the geocentric radius on the geomagnetic equator",
  );
});

// ---------------------------------------------------------------------------
// The activity seam
// ---------------------------------------------------------------------------

test("a state packet's normalized activity becomes the activity index the oval reads", () => {
  // The manual driver's three presets normalize to these activities, so the
  // seam has to land them back on the planetary K values they came from.
  assertClose(
    auroralActivityIndex({ geomagnetic: { activity: 1.0 / 9.0 } }),
    1.0,
    1e-12,
    "the quiet preset",
  );
  assertClose(
    auroralActivityIndex({ geomagnetic: { activity: 5.0 / 9.0 } }),
    5.0,
    1e-12,
    "the moderate preset",
  );
  assertClose(
    auroralActivityIndex({ geomagnetic: { activity: 8.0 / 9.0 } }),
    8.0,
    1e-12,
    "the severe preset",
  );

  assert.equal(auroralActivityIndex({ geomagnetic: { activity: 1.0 } }), 9.0);
  assert.equal(auroralActivityIndex({ geomagnetic: { activity: 4.2 } }), 9.0);
  assert.equal(auroralActivityIndex({ geomagnetic: { activity: -3.0 } }), 0.0);
  assert.equal(auroralActivityIndex({ geomagnetic: { activity: NaN } }), 0.0);
  assert.equal(auroralActivityIndex({}), 0.0);
  assert.equal(auroralActivityIndex(), 0.0);
});

test("the three preset activities produce three ordered ovals", () => {
  const ovals = [1.0 / 9.0, 5.0 / 9.0, 8.0 / 9.0].map((activity) =>
    oval.boundaries(
      auroralActivityIndex({ geomagnetic: { activity: activity } }),
      0.0,
    ),
  );
  assert.ok(
    ovals[0].equatorwardLatitude > ovals[1].equatorwardLatitude,
    "the moderate oval must sit equatorward of the quiet one",
  );
  assert.ok(
    ovals[1].equatorwardLatitude > ovals[2].equatorwardLatitude,
    "the severe oval must sit equatorward of the moderate one",
  );
  assertClose(
    degrees(ovals[0].equatorwardLatitude),
    AURORAL_VIEWLINE_LATITUDES_DEGREES[1],
    1e-9,
    "the quiet preset's midnight boundary",
  );
  assertClose(
    degrees(ovals[2].equatorwardLatitude),
    AURORAL_VIEWLINE_LATITUDES_DEGREES[8],
    1e-9,
    "the severe preset's midnight boundary",
  );
});
