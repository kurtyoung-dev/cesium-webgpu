import Cartesian3 from "../../Source/Core/Cartesian3.js";
import {
  computeMoonPhysicalDepthGap,
  shouldPrewarmMoonPhysicalDepth,
  updateMoonPhysicalDepthDemand,
} from "../../Source/Scene/Moon.js";

describe("Scene/MoonDepthRoute", function () {
  it("compares the nearest Moon surface with the farthest Earth surface in f64", function () {
    const earthRadius = 6378137.0;
    const moonRadius = 1737400.0;

    // Camera on the far side of the Moon: the lunar near surface can precede
    // some Earth pixels, so a background-only command is no longer valid.
    const moonNearCamera = new Cartesian3(1.0e9, 0.0, 0.0);
    const moonCenter = new Cartesian3(1.0e9 + moonRadius + 1.0, 0.0, 0.0);
    expect(
      computeMoonPhysicalDepthGap(
        moonNearCamera,
        moonCenter,
        moonRadius,
        earthRadius,
      ),
    ).toBeLessThan(0.0);

    // Earth-near default view: even the nearest lunar point is beyond every
    // Earth point. This remains the historical ENVIRONMENT route.
    expect(
      computeMoonPhysicalDepthGap(
        Cartesian3.ZERO,
        new Cartesian3(384400000.0, 0.0, 0.0),
        moonRadius,
        earthRadius,
      ),
    ).toBeGreaterThan(0.0);

    // At the ~188 Mm route boundary, a +/-0.25 m camera move changes
    // the gap by -/+0.5 m. That is far below float32's ULP here and pins the
    // binary64 decision before either backend/RTE representation exists.
    const moonDistance = 384400000.0;
    const boundary = (moonDistance - moonRadius - earthRadius) * 0.5;
    expect(
      computeMoonPhysicalDepthGap(
        new Cartesian3(boundary - 0.25, 0.0, 0.0),
        new Cartesian3(moonDistance, 0.0, 0.0),
        moonRadius,
        earthRadius,
      ),
    ).toBe(0.5);
    expect(
      computeMoonPhysicalDepthGap(
        new Cartesian3(boundary + 0.25, 0.0, 0.0),
        new Cartesian3(moonDistance, 0.0, 0.0),
        moonRadius,
        earthRadius,
      ),
    ).toBe(-0.5);
  });

  it("enters exactly at overlap and exits one lunar radius later", function () {
    const radius = 1737400.0;

    expect(updateMoonPhysicalDepthDemand(false, Number.EPSILON, radius)).toBe(
      false,
    );
    expect(updateMoonPhysicalDepthDemand(false, 0.0, radius)).toBe(true);
    expect(updateMoonPhysicalDepthDemand(true, radius, radius)).toBe(true);
    expect(updateMoonPhysicalDepthDemand(true, radius + 1.0e-6, radius)).toBe(
      false,
    );
  });

  it("prewarms at the exit margin without changing exact route entry", function () {
    const radius = 1737400.0;
    expect(shouldPrewarmMoonPhysicalDepth(radius + 1.0e-6, radius)).toBe(false);
    expect(shouldPrewarmMoonPhysicalDepth(radius, radius)).toBe(true);
    expect(updateMoonPhysicalDepthDemand(false, radius, radius)).toBe(false);
  });

  it("fails closed for non-finite state and invalid radii", function () {
    expect(updateMoonPhysicalDepthDemand(true, Number.NaN, 1.0)).toBe(false);
    expect(updateMoonPhysicalDepthDemand(true, 0.0, 0.0)).toBe(false);
    expect(updateMoonPhysicalDepthDemand(true, 0.0, Number.NaN)).toBe(false);

    expect(
      computeMoonPhysicalDepthGap(
        new Cartesian3(Number.POSITIVE_INFINITY, 0.0, 0.0),
        Cartesian3.ZERO,
        1.0,
        1.0,
      ),
    ).toBeNaN();
  });
});
