import { packColorGradingUniforms } from "../../../Source/Renderer/WebGPU/WebGPUPostProcessPipeline.js";

// ── Test fixtures ───────────────────────────────────────────────────
//
// The color grading stage itself owns GPU resources (uniform buffer +
// pipeline), so `addColorGrading` / `updateColorGradingUniforms` need
// a live GPUDevice. This spec covers the pure-JS uniform packer that
// converts a sparse `ColorGradingConfig` into the 20-float layout
// required by `ColorGrading.wgsl`.
//
// The layout is:
//   [0..3]:  exposure, brightness, contrast, saturation
//   [4..7]:  temperature, tint, gamma, _pad
//   [8..11]: shadows tint RGBA
//   [12..15]: midtones tint RGBA
//   [16..19]: highlights tint RGBA

describe("Renderer/WebGPU/packColorGradingUniforms", function () {
  it("produces exactly 20 floats (80 bytes)", function () {
    const u = packColorGradingUniforms({});
    expect(u.length).toBe(20);
    expect(u.byteLength).toBe(80);
  });

  it("defaults to an identity pass-through config", function () {
    const u = packColorGradingUniforms({});
    // exposure = 0, brightness = 0
    expect(u[0]).toBe(0);
    expect(u[1]).toBe(0);
    // contrast = 1 (pass-through), saturation = 1
    expect(u[2]).toBe(1);
    expect(u[3]).toBe(1);
    // temperature = 0, tint = 0
    expect(u[4]).toBe(0);
    expect(u[5]).toBe(0);
    // gamma = 1 (identity)
    expect(u[6]).toBe(1);
    // All tint RGBAs are zero.
    for (let i = 8; i < 20; i++) {
      expect(u[i]).toBe(0);
    }
  });

  it("packs scalar fields in the documented order", function () {
    const u = packColorGradingUniforms({
      exposure: 0.5,
      brightness: 0.1,
      contrast: 1.3,
      saturation: 0.8,
      temperature: -0.2,
      tint: 0.15,
      gamma: 2.2,
    });
    expect(u[0]).toBeCloseTo(0.5, 5);
    expect(u[1]).toBeCloseTo(0.1, 5);
    expect(u[2]).toBeCloseTo(1.3, 5);
    expect(u[3]).toBeCloseTo(0.8, 5);
    expect(u[4]).toBeCloseTo(-0.2, 5);
    expect(u[5]).toBeCloseTo(0.15, 5);
    expect(u[6]).toBeCloseTo(2.2, 5);
    // _pad is always 0.
    expect(u[7]).toBe(0);
  });

  it("packs shadows / midtones / highlights tints correctly", function () {
    const u = packColorGradingUniforms({
      shadowsTint: { r: 0.2, g: 0.1, b: 0.0, w: 0.5 },
      midtonesTint: { r: 0.0, g: 0.3, b: 0.2, w: 0.7 },
      highlightsTint: { r: 0.9, g: 0.8, b: 0.1, w: 0.25 },
    });
    expect(u[8]).toBeCloseTo(0.2, 5);
    expect(u[9]).toBeCloseTo(0.1, 5);
    expect(u[10]).toBe(0);
    expect(u[11]).toBeCloseTo(0.5, 5);
    expect(u[12]).toBe(0);
    expect(u[13]).toBeCloseTo(0.3, 5);
    expect(u[14]).toBeCloseTo(0.2, 5);
    expect(u[15]).toBeCloseTo(0.7, 5);
    expect(u[16]).toBeCloseTo(0.9, 5);
    expect(u[17]).toBeCloseTo(0.8, 5);
    expect(u[18]).toBeCloseTo(0.1, 5);
    expect(u[19]).toBeCloseTo(0.25, 5);
  });

  it("accepts a sparse config — omitted fields fall back to defaults", function () {
    const u = packColorGradingUniforms({ exposure: 1.0 });
    // exposure overridden
    expect(u[0]).toBeCloseTo(1.0, 5);
    // everything else is the default pass-through.
    expect(u[1]).toBe(0);
    expect(u[2]).toBe(1);
    expect(u[3]).toBe(1);
    expect(u[6]).toBe(1);
  });

  it("is pure — repeated calls return independent Float32Arrays", function () {
    const a = packColorGradingUniforms({ exposure: 0.1 });
    const b = packColorGradingUniforms({ exposure: 0.2 });
    expect(a).not.toBe(b);
    expect(a[0]).toBeCloseTo(0.1, 5);
    expect(b[0]).toBeCloseTo(0.2, 5);
  });
});
