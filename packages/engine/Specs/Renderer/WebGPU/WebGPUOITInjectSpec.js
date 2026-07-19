import { WebGPUOIT } from "../../../Source/Renderer/WebGPU/WebGPUOIT.js";

describe("Renderer/WebGPU/WebGPUOIT.injectOITOutput", function () {
  // `injectOITOutput` is a pure WGSL string transform (no GPU device needed):
  // it turns a single-target fragment shader into the weighted-blended OIT MRT
  // variant consumed by the accumulation pass. C11-157 Slice A added a struct-
  // return branch (lit / MRT-G-buffer primitive shaders that return a named
  // `FragOutput` struct) while keeping the pre-existing single-`@location(0)`
  // path BYTE-IDENTICAL — Gaussian splats + flat primitives depend on it. This
  // spec is the static-analysis guard for both branches; the end-to-end OIT
  // reachability is covered by Tools/visual-regression/probe-oit-transparency.mjs.

  const FLAT = `struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) color: vec4<f32>,
}
@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
    return input.color;
}
`;

  // Golden output for the single-`@location(0)` shape, captured from the
  // pre-Slice-A implementation. Any drift here is a regression against the
  // splat-critical path — treat a failure as "the legacy branch changed."
  const FLAT_GOLDEN = `
// ─── OIT Weighted Blended Output ───
struct OITFragOutput {
  @location(0) accumulation: vec4<f32>,
  @location(1) revealage: vec4<f32>,
}

fn csm_oitWeight(a: f32, z: f32) -> f32 {
  return clamp(a * max(1e-2, min(3e3, 10.0 / (1e-5 + pow(z / 5.0, 2.0) + pow(z / 200.0, 6.0)))), 1e-2, 3e2);
}

fn csm_oitOutput(color: vec4<f32>, clipZ: f32) -> OITFragOutput {
  let alpha = color.a;
  let weight = csm_oitWeight(alpha, clipZ);
  var out: OITFragOutput;
  out.accumulation = vec4<f32>(color.rgb * alpha * weight, alpha * weight);
  out.revealage = vec4<f32>(alpha, 0.0, 0.0, 0.0);
  return out;
}
struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) color: vec4<f32>,
}
fn _oit_base_fragmentMain(input: VertexOutput) -> vec4<f32> {
    return input.color;
}

@fragment
fn fragmentMain(input: VertexOutput) -> OITFragOutput {
  let _oitBaseColor = _oit_base_fragmentMain(input);
  return csm_oitOutput(_oitBaseColor, input.position.z);
}
`;

  const LIT = `struct VertexOutput {
    @builtin(position) clipPosition: vec4<f32>,
    @location(0) color: vec4<f32>,
    @location(1) worldNormal: vec3<f32>,
}
struct FragOutput {
    @location(0) color: vec4<f32>,
    @location(1) normalRoughness: vec4<f32>,
};
@fragment
fn fragmentMain(input: VertexOutput) -> FragOutput {
    var o: FragOutput;
    o.color = input.color;
    o.normalRoughness = vec4<f32>(normalize(input.worldNormal), 0.5);
    return o;
}
`;

  it("keeps the single-@location(0) transform byte-identical (splat-critical)", function () {
    expect(WebGPUOIT.injectOITOutput(FLAT, "fragmentMain")).toBe(FLAT_GOLDEN);
  });

  it("wraps a struct-returning (lit / MRT) fragment shader into OIT MRT", function () {
    const out = WebGPUOIT.injectOITOutput(LIT, "fragmentMain");
    // Base fn renamed, keeps its struct return type.
    expect(out).toContain(
      "fn _oit_base_fragmentMain(input: VertexOutput) -> FragOutput",
    );
    // The output struct MUST be stripped of I/O attributes — a non-entry fn's
    // return struct cannot carry @location/@builtin or WGSL rejects the module.
    expect(/struct FragOutput \{[\s\S]*?\}/.exec(out)[0]).not.toContain(
      "@location",
    );
    // Members survive the strip.
    expect(out).toContain("color: vec4<f32>");
    expect(out).toContain("normalRoughness: vec4<f32>");
    // Wrapper is the sole entry point; extracts the @location(0) color member
    // and samples the correct builtin-position field name (clipPosition here).
    expect(out).toContain(
      "fn fragmentMain(input: VertexOutput) -> OITFragOutput",
    );
    expect(out).toContain(
      "csm_oitOutput(_oitBase.color, input.clipPosition.z)",
    );
    expect((out.match(/@fragment/g) || []).length).toBe(1);
  });

  it("does not strip the input struct's @location (still entry-point I/O)", function () {
    const out = WebGPUOIT.injectOITOutput(LIT, "fragmentMain");
    // VertexOutput is used by the wrapper entry point, so its @location stays.
    expect(/struct VertexOutput \{[\s\S]*?\}/.exec(out)[0]).toContain(
      "@location(0) color",
    );
  });

  it("returns the source unchanged when the entry point is absent", function () {
    const src = "fn other() -> f32 { return 1.0; }\n";
    expect(WebGPUOIT.injectOITOutput(src, "fragmentMain")).toBe(src);
  });
});
