import Cartesian3 from "../../Source/Core/Cartesian3.js";
import Atmosphere from "../../Source/Scene/Atmosphere.js";
import computeAtmosphereExtinction, {
  createAtmosphereExtinctionCache,
  computeAtmosphereExtinctionCached,
} from "../../Source/Scene/computeAtmosphereExtinction.js";

describe("Scene/computeAtmosphereExtinction", function () {
  const innerRadius = 6378137.0;

  function createFixture() {
    return {
      camera: new Cartesian3(innerRadius + 1000.0, 0.0, 0.0),
      body: new Cartesian3(innerRadius + 1000.0, 384400000.0, 0.0),
      atmosphere: new Atmosphere(),
      innerRadius,
    };
  }

  function computeCached(cache, result, fixture, enabled = true) {
    return computeAtmosphereExtinctionCached(
      cache,
      result,
      enabled,
      fixture.camera,
      fixture.body,
      fixture.atmosphere,
      fixture.innerRadius,
    );
  }

  it("matches the default integrator and hits on identical scalar inputs", function () {
    const fixture = createFixture();
    const cache = createAtmosphereExtinctionCache();
    const result = new Cartesian3();
    const expected = computeAtmosphereExtinction(
      new Cartesian3(),
      fixture.camera,
      fixture.body,
      fixture.atmosphere,
      fixture.innerRadius,
    );

    expect(computeCached(cache, result, fixture)).toBe(result);
    expect(result).toEqual(expected);
    expect(cache.computations).toBe(1);
    expect(cache.hits).toBe(0);

    result.x = -1.0;
    result.y = -1.0;
    result.z = -1.0;
    expect(computeCached(cache, result, fixture)).toBe(result);
    expect(result).toEqual(expected);
    expect(cache.computations).toBe(1);
    expect(cache.hits).toBe(1);
  });

  it("misses for every exact scalar input family", function () {
    const fixture = createFixture();
    const cache = createAtmosphereExtinctionCache();
    const result = new Cartesian3();
    computeCached(cache, result, fixture);

    const mutations = [
      function () {
        fixture.camera.x += 1.0;
      },
      function () {
        fixture.camera.y += 1.0;
      },
      function () {
        fixture.camera.z += 1.0;
      },
      function () {
        fixture.body.x += 1.0;
      },
      function () {
        fixture.body.y += 1.0;
      },
      function () {
        fixture.body.z += 1.0;
      },
      function () {
        fixture.innerRadius += 1.0;
      },
      function () {
        fixture.atmosphere.rayleighCoefficient.x += 1e-9;
      },
      function () {
        fixture.atmosphere.rayleighCoefficient.y += 1e-9;
      },
      function () {
        fixture.atmosphere.rayleighCoefficient.z += 1e-9;
      },
      function () {
        fixture.atmosphere.mieCoefficient.x += 1e-9;
      },
      function () {
        fixture.atmosphere.mieCoefficient.y += 1e-9;
      },
      function () {
        fixture.atmosphere.mieCoefficient.z += 1e-9;
      },
      function () {
        fixture.atmosphere.rayleighScaleHeight += 1.0;
      },
      function () {
        fixture.atmosphere.mieScaleHeight += 1.0;
      },
    ];

    for (let i = 0; i < mutations.length; ++i) {
      mutations[i]();
      computeCached(cache, result, fixture);
      expect(cache.computations)
        .withContext(`mutation ${i} must invalidate the exact-input cache`)
        .toBe(i + 2);
      expect(cache.hits).toBe(0);
    }
  });

  it("observes direct atmosphere vector mutation and restoration", function () {
    const fixture = createFixture();
    const cache = createAtmosphereExtinctionCache();
    const result = new Cartesian3();
    computeCached(cache, result, fixture);
    const original = Cartesian3.clone(result);
    const originalRayleighX = fixture.atmosphere.rayleighCoefficient.x;

    fixture.atmosphere.rayleighCoefficient.x *= 2.0;
    computeCached(cache, result, fixture);
    expect(cache.computations).toBe(2);
    expect(result.x).not.toBe(original.x);

    fixture.atmosphere.rayleighCoefficient.x = originalRayleighX;
    computeCached(cache, result, fixture);
    expect(cache.computations).toBe(3);
    expect(result).toEqual(original);
  });

  it("keeps disabled and enabled cache states separate", function () {
    const fixture = createFixture();
    const cache = createAtmosphereExtinctionCache();
    const result = new Cartesian3();

    computeCached(cache, result, fixture);
    const enabledResult = Cartesian3.clone(result);
    expect(enabledResult).not.toEqual(Cartesian3.ONE);

    expect(computeCached(cache, result, fixture, false)).toBe(result);
    expect(result).toEqual(Cartesian3.ONE);
    expect(cache.computations).toBe(1);
    expect(cache.hits).toBe(0);

    computeCached(cache, result, fixture, false);
    expect(result).toEqual(Cartesian3.ONE);
    expect(cache.computations).toBe(1);
    expect(cache.hits).toBe(1);

    computeCached(cache, result, fixture, true);
    expect(result).toEqual(enabledResult);
    expect(cache.computations).toBe(2);
    expect(cache.hits).toBe(1);
  });

  it("returns exact identity for missing inputs and recomputes after restoration", function () {
    const missingCases = [
      function (fixture) {
        fixture.camera = undefined;
      },
      function (fixture) {
        fixture.body = undefined;
      },
      function (fixture) {
        fixture.camera.x = undefined;
      },
      function (fixture) {
        fixture.body.y = undefined;
      },
      function (fixture) {
        fixture.atmosphere = undefined;
      },
      function (fixture) {
        fixture.innerRadius = undefined;
      },
      function (fixture) {
        fixture.innerRadius = 0.0;
      },
      function (fixture) {
        fixture.atmosphere.rayleighCoefficient = undefined;
      },
      function (fixture) {
        fixture.atmosphere.mieCoefficient = undefined;
      },
      function (fixture) {
        fixture.atmosphere.rayleighCoefficient.z = undefined;
      },
      function (fixture) {
        fixture.atmosphere.mieCoefficient.x = undefined;
      },
      function (fixture) {
        fixture.atmosphere.rayleighScaleHeight = undefined;
      },
      function (fixture) {
        fixture.atmosphere.mieScaleHeight = undefined;
      },
    ];

    for (let i = 0; i < missingCases.length; ++i) {
      const fixture = createFixture();
      const cache = createAtmosphereExtinctionCache();
      const result = new Cartesian3(-1.0, -1.0, -1.0);
      missingCases[i](fixture);

      expect(computeCached(cache, result, fixture)).toBe(result);
      expect(result)
        .withContext(`missing-input case ${i} must return exact identity`)
        .toEqual(Cartesian3.ONE);
      expect(cache.computations).toBe(0);
    }

    const fixture = createFixture();
    const cache = createAtmosphereExtinctionCache();
    const result = new Cartesian3();
    computeCached(cache, result, fixture);
    fixture.body = undefined;
    computeCached(cache, result, fixture);
    expect(result).toEqual(Cartesian3.ONE);
    fixture.body = createFixture().body;
    computeCached(cache, result, fixture);
    expect(result).not.toEqual(Cartesian3.ONE);
    expect(cache.computations).toBe(2);
  });

  it("writes cache hits into each caller-owned result", function () {
    const fixture = createFixture();
    const cache = createAtmosphereExtinctionCache();
    const firstResult = new Cartesian3();
    const secondResult = new Cartesian3(-1.0, -1.0, -1.0);

    expect(computeCached(cache, firstResult, fixture)).toBe(firstResult);
    expect(computeCached(cache, secondResult, fixture)).toBe(secondResult);
    expect(secondResult).toEqual(firstResult);
    expect(cache.computations).toBe(1);
    expect(cache.hits).toBe(1);
  });
});
