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
//   depthTexture — rg32float: eye-space metres + exact device depth (slot 1)
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
// `depthTexture` is the rg32float attachment written by
// PointCloudEDLDepth.wgsl — `.r` is raw positive eye depth in metres and `.g`
// is the exact log/hyperbolic scene-device depth for the point.
fn neighborContribution(
  centerLog2: f32,
  centerUv: vec2<f32>,
  texelDirection: vec2<f32>,
) -> vec2<f32> {
  // WebGL samples the adjacent integer radii and interpolates their depths.
  // Sampling once at a fractional coordinate with a nearest sampler instead
  // snaps the radius and makes high-DPI/non-integer controls visibly jump.
  let radius0 = floor(params.radius);
  let radius1 = ceil(params.radius);
  let depth0 = textureSampleLevel(
    depthTexture, edlSampler, centerUv + texelDirection * radius0, 0.0,
  ).r;
  let depth1 = textureSampleLevel(
    depthTexture, edlSampler, centerUv + texelDirection * radius1, 0.0,
  ).r;
  if (depth0 <= 0.0 || depth1 <= 0.0) {
    return vec2<f32>(0.0, 0.0); // background — ignore (clear-depth guard)
  }
  let d = mix(depth0, depth1, fract(params.radius));
  let neighborLog2 = log2(max(d, 0.001));
  return vec2<f32>(max(0.0, centerLog2 - neighborLog2), 1.0);
}

struct CompositeOutput {
  @location(0) color: vec4<f32>,
  @builtin(frag_depth) depth: f32,
}

@fragment
fn fragmentMain(input: VertexOutput) -> CompositeOutput {
  let centerDepthSample = textureSampleLevel(
    depthTexture, edlSampler, input.uv, 0.0,
  ).rg;
  let centerDepth = centerDepthSample.r;
  // A transparent return would still write full-screen depth. Discard the
  // clear sentinel so non-point pixels leave scene color and depth untouched.
  if (centerDepth <= 0.0) {
    discard;
  }

  let color = textureSampleLevel(colorTexture, edlSampler, input.uv, 0.0);
  let centerLog2 = log2(max(centerDepth, 0.001));

  // Sample the 4 axial neighbors (left/right/down/up) — matches WebGL.
  var responseAndCount = vec2<f32>(0.0, 0.0);
  responseAndCount += neighborContribution(
    centerLog2, input.uv, vec2<f32>(-params.texelSize.x, 0.0),
  );
  responseAndCount += neighborContribution(
    centerLog2, input.uv, vec2<f32>(params.texelSize.x, 0.0),
  );
  responseAndCount += neighborContribution(
    centerLog2, input.uv, vec2<f32>(0.0, -params.texelSize.y),
  );
  responseAndCount += neighborContribution(
    centerLog2, input.uv, vec2<f32>(0.0, params.texelSize.y),
  );

  // Average over the VALID (non-background) neighbor count. When every
  // neighbor is background (a fully isolated point) count is 0 → no
  // darkening, matching WebGL where the same fragment has no valid
  // neighbors and `response` stays 0.
  let response = responseAndCount.x / max(responseAndCount.y, 1.0);
  let shade = exp(-response * 300.0 * params.strength);

  // Alpha-blended composite back to the scene FB: shaded color, original alpha.
  return CompositeOutput(
    vec4<f32>(color.rgb * shade, color.a),
    centerDepthSample.g,
  );
}
