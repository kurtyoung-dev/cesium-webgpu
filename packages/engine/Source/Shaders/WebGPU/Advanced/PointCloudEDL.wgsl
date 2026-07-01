// Point Cloud Eye-Dome Lighting (EDL) blend/composite shader for WebGPU
// (PARITY-PC-EDL). Applies eye-dome lighting as a post-process over the
// point-cloud off-screen framebuffer: darkens edges based on depth
// discontinuities, then writes the darkened point color back to the scene
// framebuffer (alpha-blended so non-point pixels are untouched).
// Reference: "Eye-Dome Lighting: A Non-Photorealistic Shading Technique"
// (Boucheny, 2009) and Scene/PointCloudEyeDomeLighting.js (WebGL parity).
//
// Inputs (from the off-screen FBO written by PointCloudEDLDepth.wgsl):
//   colorTexture — point color (slot 0)
//   depthTexture — r32float raw eye-space depth in metres (slot 1); 0 = background
//
// The eye depth is read directly and fed through the neighbor-depth EDL
// response identical in spirit to the WebGL PointCloudEyeDomeLighting.glsl
// (log-space depth difference, exp darkening scaled by u_distanceAndEdlStrength).

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

struct EDLUniforms {
  texelSize: vec2<f32>,   // 1.0 / textureSize
  strength: f32,          // EDL strength (pointCloudShading.eyeDomeLightingStrength)
  radius: f32,            // Sample radius in pixels (eyeDomeLightingRadius * pixelRatio)
  nearPlane: f32,
  farPlane: f32,
  _pad0: f32,
  _pad1: f32,
};

@group(0) @binding(0) var colorTexture: texture_2d<f32>;
@group(0) @binding(1) var depthTexture: texture_2d<f32>;
@group(0) @binding(2) var edlSampler: sampler;
@group(0) @binding(3) var<uniform> params: EDLUniforms;

@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  var output: VertexOutput;
  let x = f32(i32(vertexIndex & 1u) * 4 - 1);
  let y = f32(i32(vertexIndex >> 1u) * 4 - 1);
  output.position = vec4<f32>(x, y, 0.0, 1.0);
  output.uv = vec2<f32>((x + 1.0) * 0.5, (1.0 - y) * 0.5);
  return output;
}

// Neighbor EDL contribution — mirrors the WebGL `neighborContribution`
// (PointCloudEyeDomeLighting.glsl). Returns (response, count): a BACKGROUND
// neighbor (eye depth 0) contributes (0, 0) so it is excluded from the
// average, exactly like WebGL's clear-depth guard. A valid neighbor
// contributes (max(0, centerLog2 - neighborLog2), 1). This is what keeps
// isolated / silhouette points from being crushed to black — background
// around a point is NOT treated as an infinitely-near occluder.
//
// `depthTexture` is the r32float eye-space-depth attachment written by
// PointCloudEDLDepth.wgsl — `.r` is the raw positive eye depth in metres.
fn neighborContribution(centerLog2: f32, uv: vec2<f32>) -> vec2<f32> {
  let d = textureSampleLevel(depthTexture, edlSampler, uv, 0.0).r;
  if (d <= 0.0) {
    return vec2<f32>(0.0, 0.0); // background — ignore (clear-depth guard)
  }
  let neighborLog2 = log2(max(d, 0.001));
  return vec2<f32>(max(0.0, centerLog2 - neighborLog2), 1.0);
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  // Background pixels contribute nothing — return fully transparent so the
  // alpha-blend against the scene FB is a no-op there (WebGL discards).
  let centerDepth = textureSampleLevel(depthTexture, edlSampler, input.uv, 0.0).r;
  if (centerDepth <= 0.0) {
    return vec4<f32>(0.0);
  }

  let color = textureSampleLevel(colorTexture, edlSampler, input.uv, 0.0);
  let centerLog2 = log2(max(centerDepth, 0.001));

  // Sample the 4 axial neighbors (left/right/down/up) — matches WebGL.
  let tx = params.texelSize.x * params.radius;
  let ty = params.texelSize.y * params.radius;
  var responseAndCount = vec2<f32>(0.0, 0.0);
  responseAndCount += neighborContribution(centerLog2, input.uv + vec2<f32>(-tx, 0.0));
  responseAndCount += neighborContribution(centerLog2, input.uv + vec2<f32>( tx, 0.0));
  responseAndCount += neighborContribution(centerLog2, input.uv + vec2<f32>(0.0, -ty));
  responseAndCount += neighborContribution(centerLog2, input.uv + vec2<f32>(0.0,  ty));

  // Average over the VALID (non-background) neighbor count. When every
  // neighbor is background (a fully isolated point) count is 0 → no
  // darkening, matching WebGL where the same fragment has no valid
  // neighbors and `response` stays 0.
  let response = responseAndCount.x / max(responseAndCount.y, 1.0);
  let shade = exp(-response * 300.0 * params.strength);

  // Alpha-blended composite back to the scene FB: shaded color, original alpha.
  return vec4<f32>(color.rgb * shade, color.a);
}
