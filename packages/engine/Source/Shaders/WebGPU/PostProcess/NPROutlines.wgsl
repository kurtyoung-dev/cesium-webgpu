// NPROutlines.wgsl — cheap silhouette and crease edge detector.
//
// Cheap silhouette + crease edge detector. Reads the G-buffer normal-
// roughness texture (slot 1) + the scene depth texture, samples each
// fragment's 4 cardinal neighbors, and paints the fragment as an edge
// when either:
//
//   1. The maximum eye-space normal divergence (1 - dot(N_center, N_n))
//      across the 4 neighbors exceeds `normalThreshold` → crease edge.
//   2. The maximum depth gradient across the 4 neighbors exceeds
//      `depthThreshold * centerDepth` → silhouette / occluder edge.
//      (Scaled by depth so distant objects don't trip the test.)
//
// Sentinel-aware: when the center fragment's G-buffer normal is the
// (0,0,0,*) loadOp-clear sentinel (Phase 1 non-emitting pipelines
// like sky / billboards / labels), the shader emits the source color
// unchanged. Same applies to neighbor samples — sentinel neighbors are
// skipped from the normal-divergence test. Without this, every
// boundary between an emitting and a non-emitting primitive would
// false-positive as a crease.
//
// Output: input color when no edge; mix(input color, edge color,
// edge strength) when an edge fires. Designed to composite over the
// existing scene color so the effect is purely additive.

struct VertexOutput {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

struct NPRUniforms {
  // .x = normalThreshold (default 0.2 — 1 - dot threshold; smaller =
  //   more sensitive). .y = depthThreshold (default 0.02 — fractional
  //   per-depth gradient). .z = edgeStrength (0-1 mix factor).
  //   .w = unused.
  params: vec4<f32>,
  // edgeColor.rgba — typically opaque black for ink-line style.
  edgeColor: vec4<f32>,
  // .xy = 1/width, 1/height (texel size for neighbor offsets). .z/.w
  //   unused.
  texelSize: vec4<f32>,
};

@group(0) @binding(0) var colorTex: texture_2d<f32>;
// Depth arrives as an r16float colour texture from SceneFramebuffer's
// depth-resolve pass in MSAA mode, or directly as the depth-only-aspect view
// of the single-sample depth texture, which is also bindable as
// `texture_2d<f32>` under either an unfilterable-float or a filterable-float
// sample type. Sampled as f32, reading `.r` for the depth value.
@group(0) @binding(1) var depthTex: texture_2d<f32>;
@group(0) @binding(2) var normalRoughTex: texture_2d<f32>;
@group(0) @binding(3) var texSampler: sampler;
@group(0) @binding(4) var<uniform> uniforms: NPRUniforms;

@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  // Full-screen triangle (3 verts forming an oversized triangle that
  // covers the [-1,1] viewport).
  var output: VertexOutput;
  let x = f32(i32(vertexIndex & 1u) * 4 - 1);
  let y = f32(i32(vertexIndex >> 1u) * 4 - 1);
  output.clipPos = vec4<f32>(x, y, 0.0, 1.0);
  output.uv = vec2<f32>(x * 0.5 + 0.5, 1.0 - (y * 0.5 + 0.5));
  return output;
}

// Helper: sample G-buffer normal at uv. Returns the .xyz; caller checks
// length < 0.1 for sentinel.
fn sampleNormal(uv: vec2<f32>) -> vec3<f32> {
  // textureSampleLevel because the post-process pass runs on a full-
  // screen quad — depth-and-derivative computation is identity-OK but
  // the explicit level form matches the rest of the post-process
  // shaders in this directory and is byte-identical.
  return textureSampleLevel(normalRoughTex, texSampler, uv, 0.0).xyz;
}

// Helper: sample raw depth at uv. Returns z in [0, 1] post-perspective
// (NDC depth, NOT linear eye-space). The depth texture is bound as
// texture_2d<f32> (r16float in MSAA, depth-aspect view in single-
// sample) so we sample with f32 level and read .r.
fn sampleDepth(uv: vec2<f32>) -> f32 {
  return textureSampleLevel(depthTex, texSampler, uv, 0.0).r;
}

@fragment
fn fragmentMain(in: VertexOutput) -> @location(0) vec4<f32> {
  let baseColor = textureSampleLevel(colorTex, texSampler, in.uv, 0.0);

  let centerN = sampleNormal(in.uv);
  // Sentinel center → no edge, return base color unchanged. This lets
  // the sky / billboards / labels stay outline-free even when adjacent
  // to surface geometry. They'd otherwise trip the silhouette edge.
  if (length(centerN) < 0.1) {
    return baseColor;
  }
  let nCenter = normalize(centerN);
  let centerDepth = sampleDepth(in.uv);

  let dx = uniforms.texelSize.x;
  let dy = uniforms.texelSize.y;
  let uvL = in.uv + vec2<f32>(-dx, 0.0);
  let uvR = in.uv + vec2<f32>( dx, 0.0);
  let uvU = in.uv + vec2<f32>(0.0, -dy);
  let uvD = in.uv + vec2<f32>(0.0,  dy);

  // Normal divergence — max over the 4 neighbors. Skip sentinels.
  var maxNormalDiv = 0.0;
  let nl = sampleNormal(uvL);
  if (length(nl) >= 0.1) {
    maxNormalDiv = max(maxNormalDiv, 1.0 - dot(nCenter, normalize(nl)));
  }
  let nr = sampleNormal(uvR);
  if (length(nr) >= 0.1) {
    maxNormalDiv = max(maxNormalDiv, 1.0 - dot(nCenter, normalize(nr)));
  }
  let nu = sampleNormal(uvU);
  if (length(nu) >= 0.1) {
    maxNormalDiv = max(maxNormalDiv, 1.0 - dot(nCenter, normalize(nu)));
  }
  let nd = sampleNormal(uvD);
  if (length(nd) >= 0.1) {
    maxNormalDiv = max(maxNormalDiv, 1.0 - dot(nCenter, normalize(nd)));
  }

  // Depth gradient — max over the 4 neighbors, scaled by center depth
  // so distance doesn't bias the test.
  let dL = sampleDepth(uvL);
  let dR = sampleDepth(uvR);
  let dU = sampleDepth(uvU);
  let dD = sampleDepth(uvD);
  let maxDepthGrad = max(
    max(abs(dL - centerDepth), abs(dR - centerDepth)),
    max(abs(dU - centerDepth), abs(dD - centerDepth)),
  );
  // Scale so the threshold is a fraction of the center depth value.
  // Depth in [0,1] near→1, far→1−ε, so dividing makes the test
  // distance-invariant.
  let depthGradScaled = maxDepthGrad / max(centerDepth, 1e-6);

  let normalEdge = step(uniforms.params.x, maxNormalDiv);
  let depthEdge = step(uniforms.params.y, depthGradScaled);
  let edgeMask = max(normalEdge, depthEdge);
  if (edgeMask < 0.5) {
    return baseColor;
  }
  // Mix base color toward the edge color. `edgeStrength = 1.0` produces
  // a fully opaque edge; 0.5 ink-wash over the source color, etc.
  let strength = clamp(uniforms.params.z, 0.0, 1.0);
  return vec4<f32>(
    mix(baseColor.rgb, uniforms.edgeColor.rgb, strength),
    baseColor.a,
  );
}
