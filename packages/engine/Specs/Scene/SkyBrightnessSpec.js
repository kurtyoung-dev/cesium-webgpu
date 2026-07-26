import {
  computeAtmosphericColumnFactor,
  computeSkyBrightness,
} from "../../Source/Scene/SkyBrightness.js";
import Cartesian3 from "../../Source/Core/Cartesian3.js";
import { computeStarDayFade } from "../../Source/Scene/StarFieldMath.js";

// Helpers — build a camera position on the WGS84 surface and the matching
// "local up" direction at that point. The sky brightness estimator only
// reads the camera position vector (it normalizes internally), so we can
// keep the values in nice round km units instead of meters.
const EARTH_KM = 6378.137;

function cameraAt(lat, lon, altKm = 0) {
  const r = EARTH_KM + altKm;
  const cosLat = Math.cos(lat);
  return new Cartesian3(
    r * cosLat * Math.cos(lon),
    r * cosLat * Math.sin(lon),
    r * Math.sin(lat),
  );
}

// A unit vector in the same direction as `cameraAt(lat, lon, …)` —
// represents "the sun directly overhead at this lat/lon".
function directionAbove(lat, lon) {
  const cosLat = Math.cos(lat);
  return new Cartesian3(
    cosLat * Math.cos(lon),
    cosLat * Math.sin(lon),
    Math.sin(lat),
  );
}

describe("Scene/SkyBrightness", function () {
  describe("computeSkyBrightness", function () {
    it("returns full brightness when the sun is directly overhead", function () {
      const camera = cameraAt(0, 0); // equator
      const sun = directionAbove(0, 0); // sun overhead
      const brightness = computeSkyBrightness(sun, undefined, 0, camera);
      expect(brightness).toBeGreaterThan(0.99);
    });

    it("returns near-zero when the sun is well below the horizon and no moon", function () {
      const camera = cameraAt(0, 0);
      // Sun on the opposite side of the planet — antipodal direction.
      const sun = new Cartesian3(-1, 0, 0);
      const brightness = computeSkyBrightness(sun, undefined, 0, camera);
      expect(brightness).toBeLessThan(0.01);
    });

    it("returns a small but nonzero value at full moon overhead with no sun", function () {
      const camera = cameraAt(0, 0);
      // Sun antipodal — daylight contribution clamped to zero.
      const sun = new Cartesian3(-1, 0, 0);
      const moon = directionAbove(0, 0); // moon overhead
      const brightness = computeSkyBrightness(sun, moon, 1.0, camera);
      // Full moon overhead → ~4% sky brightness per the model.
      expect(brightness).toBeGreaterThan(0.03);
      expect(brightness).toBeLessThan(0.05);
    });

    it("scales the moon contribution by the phase fraction", function () {
      const camera = cameraAt(0, 0);
      const sun = new Cartesian3(-1, 0, 0); // night side
      const moon = directionAbove(0, 0); // overhead
      const newMoon = computeSkyBrightness(sun, moon, 0.0, camera);
      const halfMoon = computeSkyBrightness(sun, moon, 0.5, camera);
      const fullMoon = computeSkyBrightness(sun, moon, 1.0, camera);
      expect(newMoon).toBeLessThan(0.001);
      expect(halfMoon).toBeGreaterThan(newMoon);
      expect(fullMoon).toBeGreaterThan(halfMoon);
      // Approximate linearity — half moon should be ~half of full moon.
      expect(halfMoon).toBeCloseTo(fullMoon * 0.5, 2);
    });

    it("transitions smoothly through twilight", function () {
      const camera = cameraAt(0, 0);
      // Sweep the sun from below horizon to above horizon and verify
      // the curve is monotonically increasing.
      const samples = [];
      for (let cosTheta = -0.2; cosTheta <= 0.5; cosTheta += 0.05) {
        const sun = new Cartesian3(cosTheta, 0, 0);
        // Normalize so we don't bias the dot product.
        Cartesian3.normalize(sun, sun);
        samples.push(computeSkyBrightness(sun, undefined, 0, camera));
      }
      for (let i = 1; i < samples.length; i++) {
        expect(samples[i]).toBeGreaterThanOrEqual(samples[i - 1] - 1e-6);
      }
    });

    it("returns 1.0 when the camera position is undefined", function () {
      const sun = new Cartesian3(1, 0, 0);
      expect(computeSkyBrightness(sun, undefined, 1, undefined)).toBe(1.0);
    });

    it("returns 1.0 when the camera position is degenerate (origin)", function () {
      const sun = new Cartesian3(1, 0, 0);
      const origin = new Cartesian3(0, 0, 0);
      expect(computeSkyBrightness(sun, undefined, 1, origin)).toBe(1.0);
    });

    it("clamps to <= 1.0 even with sun and full moon both overhead", function () {
      const camera = cameraAt(0, 0);
      const overhead = directionAbove(0, 0);
      const brightness = computeSkyBrightness(overhead, overhead, 1.0, camera);
      expect(brightness).toBeLessThanOrEqual(1.0);
    });

    // C12-29 S6 / ruling E3. Sky brightness is produced by sunlight
    // scattering in the air ABOVE the observer; above the atmosphere there is
    // none, the sky is black, and the stars are visible on the day side. The
    // helpers above deliberately work in kilometre-scale units, so these
    // cases build metre-scale positions of their own.
    it("goes to zero above the engine's scattering shell", function () {
      const sunOverhead = new Cartesian3(1.0, 0.0, 0.0);
      const at = function (altitudeMeters) {
        return computeSkyBrightness(
          sunOverhead,
          undefined,
          0.0,
          new Cartesian3(6371000.0 + altitudeMeters, 0.0, 0.0),
          altitudeMeters,
        );
      };
      expect(at(0.0)).toBeGreaterThan(0.99);
      expect(at(50000.0)).toBeGreaterThan(0.99);
      // Above ATMOSPHERE_THICKNESS neither sky shader integrates anything.
      expect(at(111000.0)).toBe(0.0);
      expect(at(400000.0)).toBe(0.0);
    });
  });

  describe("computeAtmosphericColumnFactor", function () {
    const at = function (altitudeMeters) {
      return computeAtmosphericColumnFactor(altitudeMeters);
    };

    it("is exactly 1.0 for every in-atmosphere camera", function () {
      expect(at(0.0)).toBe(1.0);
      expect(at(-1000.0)).toBe(1.0);
      expect(at(59999.0)).toBe(1.0);
    });

    it("is exactly 0.0 at and above the shell top", function () {
      expect(at(111000.0)).toBe(0.0);
      expect(at(1.0e6)).toBe(0.0);
    });

    it("ramps monotonically between the two anchors", function () {
      let previous = 1.0;
      for (let h = 60000.0; h <= 111000.0; h += 1000.0) {
        const value = at(h);
        expect(value).toBeLessThanOrEqual(previous + 1.0e-12);
        expect(value).toBeGreaterThanOrEqual(0.0);
        previous = value;
      }
    });

    it("returns 1.0 for missing or non-finite heights", function () {
      expect(computeAtmosphericColumnFactor(undefined)).toBe(1.0);
      expect(computeAtmosphericColumnFactor(Number.NaN)).toBe(1.0);
      expect(computeAtmosphericColumnFactor(Number.POSITIVE_INFINITY)).toBe(
        1.0,
      );
    });

    it("uses ellipsoidal height instead of Earth-centered distance", function () {
      const sunEquator = new Cartesian3(1.0, 0.0, 0.0);
      const sunPole = new Cartesian3(0.0, 0.0, 1.0);
      const wgs84Equator = new Cartesian3(6378137.0 + 111000.0, 0.0, 0.0);
      const wgs84Pole = new Cartesian3(0.0, 0.0, 6356752.314245 + 111000.0);
      const marsLike = new Cartesian3(3396200.0 + 111000.0, 0.0, 0.0);

      for (const [camera, sun] of [
        [wgs84Equator, sunEquator],
        [wgs84Pole, sunPole],
        [marsLike, sunEquator],
      ]) {
        expect(
          computeSkyBrightness(sun, undefined, 0.0, camera, 111000.0),
        ).toBe(0.0);
      }
    });
  });

  describe("computeStarDayFade", function () {
    const noon = new Cartesian3(1.0, 0.0, 0.0);
    const camera = new Cartesian3(3396200.0, 0.0, 0.0);

    it("shares the continuous ellipsoidal-height column law", function () {
      expect(computeStarDayFade(noon, camera, 0.0)).toBe(0.0);
      expect(computeStarDayFade(noon, camera, 60000.0)).toBe(0.0);
      expect(computeStarDayFade(noon, camera, 85500.0)).toBeCloseTo(0.5, 12);
      expect(computeStarDayFade(noon, camera, 111000.0)).toBe(1.0);
      expect(computeStarDayFade(noon, camera, 400000.0)).toBe(1.0);
    });
  });
});
