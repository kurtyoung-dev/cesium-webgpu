import {
  fractionalPart,
  OCEAN_WAVE_FRAME_SPEED,
  OCEAN_WAVE_TIME_PERIOD,
} from "../../../Source/Renderer/WebGPU/WebGPUGlobeSurfaceTileUB.js";

describe("Renderer/WebGPU/WebGPUGlobeSurfaceTileUB", function () {
  const advectionComponents = [0.012, 0.008, -0.008, 0.018, 0.03, -0.012];

  function circularDistance(left, right) {
    const direct = Math.abs(left - right);
    return Math.min(direct, 1.0 - direct);
  }

  it("uses a wave-clock period commensurate with every shader advection rate", function () {
    for (const rate of advectionComponents) {
      const cycles = OCEAN_WAVE_TIME_PERIOD * rate;
      expect(Math.abs(cycles - Math.round(cycles))).toBeLessThan(1e-12);
    }
  });

  it("preserves wave phase across the f32 clock wrap", function () {
    const wrapFrame = Math.ceil(
      OCEAN_WAVE_TIME_PERIOD / OCEAN_WAVE_FRAME_SPEED,
    );
    const before = Math.fround(
      ((wrapFrame - 1) * OCEAN_WAVE_FRAME_SPEED) % OCEAN_WAVE_TIME_PERIOD,
    );
    const after = Math.fround(
      (wrapFrame * OCEAN_WAVE_FRAME_SPEED) % OCEAN_WAVE_TIME_PERIOD,
    );

    for (const rate of advectionComponents) {
      const rateF32 = Math.fround(rate);
      const actual = fractionalPart(Math.fround(after * rateF32));
      const previous = fractionalPart(Math.fround(before * rateF32));
      const expected = fractionalPart(
        previous + Math.fround(Math.fround(OCEAN_WAVE_FRAME_SPEED) * rateF32),
      );
      expect(circularDistance(actual, expected)).toBeLessThan(1.1e-5);
    }
  });

  it("computes the WGSL-style fractional part without allocating a closure", function () {
    expect(fractionalPart(2.75)).toBe(0.75);
    expect(fractionalPart(-2.25)).toBe(0.75);
  });
});
