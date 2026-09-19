import CesiumMath from "../../Source/Core/Math.js";
import AuroralOvalModel, {
  AURORAL_VIEWLINE_LATITUDES_DEGREES,
  AuroralOvalHemisphere,
  auroralActivityIndex,
  auroralViewlineLatitude,
} from "../../Source/Scene/SpaceWeather/AuroralOvalModel.js";
import GeomagneticFrame from "../../Source/Scene/SpaceWeather/GeomagneticFrame.js";

describe("Scene/SpaceWeather/AuroralOvalModel", function () {
  // The magnetic-midnight equatorward boundary is anchored to the aurora
  // viewline latitudes NOAA publishes against the planetary K index
  // (https://www.spaceweather.gov/content/tips-viewing-aurora); everything else
  // here is a property of the shape — antisunward displacement, a wider night
  // sector, monotonic equatorward expansion, and two mirrored hemispheres.
  const degrees = CesiumMath.toDegrees;
  const localTimes = [];
  for (let hours = 0.0; hours < 24.0; hours += 0.25) {
    localTimes.push(hours);
  }

  let oval;

  beforeEach(function () {
    oval = new AuroralOvalModel();
  });

  it("reproduces the published viewline latitudes at magnetic midnight", function () {
    for (let activity = 0; activity < 10; activity++) {
      expect(
        degrees(oval.boundaries(activity, 0.0).equatorwardLatitude),
      ).toBeCloseTo(AURORAL_VIEWLINE_LATITUDES_DEGREES[activity], 9);
    }
    expect(degrees(auroralViewlineLatitude(2.5))).toBeCloseTo(61.0, 9);
  });

  it("reaches furthest equatorward at magnetic midnight and furthest poleward on the day side", function () {
    let lowest = Number.POSITIVE_INFINITY;
    let lowestHour = -1.0;
    let highest = Number.NEGATIVE_INFINITY;
    let highestHour = -1.0;
    for (const hours of localTimes) {
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
    expect(lowestHour).toBe(0.0);
    expect(highestHour).toBeGreaterThan(9.0);
    expect(highestHour).toBeLessThan(16.0);
    expect(highest - lowest).toBeGreaterThan(5.0);
  });

  it("is not a circle offset from the geomagnetic pole", function () {
    const colatitude = function (hours) {
      return 90.0 - degrees(oval.boundaries(3.0, hours).equatorwardLatitude);
    };
    const firstHarmonicPrediction = (colatitude(0.0) + colatitude(12.0)) / 2.0;
    expect(Math.abs(colatitude(6.0) - firstHarmonicPrediction)).toBeGreaterThan(
      1.0,
    );
    expect(
      Math.abs(colatitude(18.0) - firstHarmonicPrediction),
    ).toBeGreaterThan(1.0);
  });

  it("is wider on the night side than on the day side, and never degenerate", function () {
    expect(degrees(oval.boundaries(3.0, 0.0).width)).toBeGreaterThan(
      2.0 * degrees(oval.boundaries(3.0, 12.0).width),
    );
    for (const hours of localTimes) {
      for (let activity = 0; activity <= 9; activity++) {
        expect(oval.boundaries(activity, hours).width).toBeGreaterThan(0.0);
      }
    }
  });

  it("keeps the quiet oval poleward of the storm oval at every magnetic local time", function () {
    for (const hours of localTimes) {
      const quietNorth = oval.boundaries(
        0.0,
        hours,
        AuroralOvalHemisphere.NORTH,
      );
      const stormNorth = oval.boundaries(
        9.0,
        hours,
        AuroralOvalHemisphere.NORTH,
      );
      expect(quietNorth.equatorwardLatitude).toBeGreaterThan(
        stormNorth.equatorwardLatitude,
      );
      expect(quietNorth.polewardLatitude).toBeGreaterThan(
        stormNorth.polewardLatitude,
      );

      const quietSouth = oval.boundaries(
        0.0,
        hours,
        AuroralOvalHemisphere.SOUTH,
      );
      const stormSouth = oval.boundaries(
        9.0,
        hours,
        AuroralOvalHemisphere.SOUTH,
      );
      expect(quietSouth.equatorwardLatitude).toBeLessThan(
        stormSouth.equatorwardLatitude,
      );
      expect(quietSouth.polewardLatitude).toBeLessThan(
        stormSouth.polewardLatitude,
      );
    }
  });

  it("expands equatorward at every step of activity, at every magnetic local time", function () {
    for (const hours of localTimes) {
      for (let step = 0; step < 90; step++) {
        const lower = oval.boundaries(step / 10.0, hours).equatorwardLatitude;
        const higher = oval.boundaries(
          (step + 1) / 10.0,
          hours,
        ).equatorwardLatitude;
        expect(lower - higher).toBeGreaterThan(1e-6);
      }
    }
  });

  it("mirrors the two hemispheres exactly in geomagnetic latitude", function () {
    for (const hours of localTimes) {
      const north = oval.boundaries(5.0, hours, AuroralOvalHemisphere.NORTH);
      const south = oval.boundaries(5.0, hours, AuroralOvalHemisphere.SOUTH);
      expect(south.equatorwardLatitude).toBe(-north.equatorwardLatitude);
      expect(south.polewardLatitude).toBe(-north.polewardLatitude);
      expect(south.width).toBe(north.width);
      expect(Math.abs(south.polewardLatitude)).toBeGreaterThan(
        Math.abs(south.equatorwardLatitude),
      );
    }
  });

  it("does not mirror the two hemispheres in geographic latitude", function () {
    // On the geomagnetic meridian through the geographic north pole the tilt
    // moves both ovals the same geographic way rather than opposite ways.
    const frame = new GeomagneticFrame();
    const north = frame.geomagneticToCartographic(
      CesiumMath.toRadians(67.0),
      0.0,
    );
    const south = frame.geomagneticToCartographic(
      CesiumMath.toRadians(-67.0),
      0.0,
    );
    expect(degrees(north.latitude)).toBeCloseTo(76.298825, 4);
    expect(degrees(south.latitude)).toBeCloseTo(-57.963311, 4);
    expect(
      Math.abs(degrees(north.latitude) + degrees(south.latitude)),
    ).toBeGreaterThan(15.0);
  });

  it("turns a state packet's normalized activity into the index it reads", function () {
    // The manual driver's three presets normalize to these activities, so the
    // seam has to land them back on the planetary K values they came from.
    expect(
      auroralActivityIndex({ geomagnetic: { activity: 1.0 / 9.0 } }),
    ).toBeCloseTo(1.0, 12);
    expect(
      auroralActivityIndex({ geomagnetic: { activity: 5.0 / 9.0 } }),
    ).toBeCloseTo(5.0, 12);
    expect(
      auroralActivityIndex({ geomagnetic: { activity: 8.0 / 9.0 } }),
    ).toBeCloseTo(8.0, 12);

    expect(auroralActivityIndex({ geomagnetic: { activity: 1.0 } })).toBe(9.0);
    expect(auroralActivityIndex({ geomagnetic: { activity: 4.2 } })).toBe(9.0);
    expect(auroralActivityIndex({ geomagnetic: { activity: -3.0 } })).toBe(0.0);
    expect(auroralActivityIndex({ geomagnetic: { activity: NaN } })).toBe(0.0);
    expect(auroralActivityIndex({})).toBe(0.0);
    expect(auroralActivityIndex()).toBe(0.0);
  });

  it("produces three ordered ovals from the three preset activities", function () {
    const ovals = [1.0 / 9.0, 5.0 / 9.0, 8.0 / 9.0].map(function (activity) {
      return oval.boundaries(
        auroralActivityIndex({ geomagnetic: { activity: activity } }),
        0.0,
      );
    });
    expect(ovals[0].equatorwardLatitude).toBeGreaterThan(
      ovals[1].equatorwardLatitude,
    );
    expect(ovals[1].equatorwardLatitude).toBeGreaterThan(
      ovals[2].equatorwardLatitude,
    );
    expect(degrees(ovals[0].equatorwardLatitude)).toBeCloseTo(
      AURORAL_VIEWLINE_LATITUDES_DEGREES[1],
      9,
    );
    expect(degrees(ovals[2].equatorwardLatitude)).toBeCloseTo(
      AURORAL_VIEWLINE_LATITUDES_DEGREES[8],
      9,
    );
  });

  it("accepts a replacement shape rather than hiding one", function () {
    const flat = new AuroralOvalModel({
      noonMidnightAmplitudeDegrees: 0.0,
      noonMidnightAmplitudePerActivity: 0.0,
      secondHarmonicDegrees: 0.0,
      secondHarmonicPerActivity: 0.0,
      widthDegrees: 4.0,
      widthPerActivity: 0.0,
      widthAsymmetryDegrees: 0.0,
      widthAsymmetryPerActivity: 0.0,
    });
    expect(degrees(flat.boundaries(3.0, 0.0).equatorwardLatitude)).toBeCloseTo(
      degrees(flat.boundaries(3.0, 12.0).equatorwardLatitude),
      9,
    );
    expect(degrees(flat.boundaries(3.0, 7.0).width)).toBeCloseTo(4.0, 9);
  });
});
