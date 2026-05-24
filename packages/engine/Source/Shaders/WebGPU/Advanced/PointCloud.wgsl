// Point Cloud shader for WebGPU
// Renders point cloud data (LiDAR, photogrammetry) as instanced quads.
// Supports per-point color, position, and size attributes.
// Uses RTE (Relative-To-Eye) positioning for planetary-scale precision.

struct VertexInput {
  // Per-vertex quad corner
  @location(0) quadVertex: vec2<f32>,
  // Per-instance point data
  @location(1) positionHigh: vec3<f32>,
  @location(2) positionLow: vec3<f32>,
  @location(3) colorAndSize: vec4<f32>, // rgb=color, a=pointSize
  @location(4) normalOrAttr: vec3<f32>, // optional normal or custom attribute
};

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec3<f32>,
  @location(1) pointUV: vec2<f32>,
  @location(2) normal: vec3<f32>,
  // FEAT-GAP-09 (Batch 102) — eye-space position of the point center
  // for the aerial-perspective fog block. Per-quad-vertex spread is
  // tiny (~point size in pixels) relative to fog scale.
  @location(3) eyePosition: vec3<f32>,
};

struct PointCloudUniforms {
  mvpRelativeToEye: mat4x4<f32>,
  modelViewRelativeToEye: mat4x4<f32>,
  encodedCameraHigh: vec3<f32>,
  _pad0: f32,
  encodedCameraLow: vec3<f32>,
  _pad1: f32,
  viewportSize: vec2<f32>,
  pointSizeMultiplier: f32,
  attenuationMaxSize: f32,
  attenuationBaseResolution: f32,
  attenuationGeometricErrorScale: f32,
  time: f32,
  hasNormals: f32,
};

@group(0) @binding(0) var<uniform> uniforms: PointCloudUniforms;

// FEAT-GAP-09 (Batch 102) — truncated EffectsUniforms (480-byte UBO,
// truncated to reach `atmosphereLutControl` at byte offset 240 — see
// `WebGPUEffectsBindGroup.js`) + aerial-perspective LUT bindings at
// @group(1). PointCloud pipelines previously had a single bind group;
// the new effects BGL is appended in `WebGPUPointCloudRenderer.ts`
// for all 4+ draw variants (basic, LOD, velocity, lodVelocity, EDL).
struct EffectsUniforms {
    shadowMatrix: mat4x4<f32>,
    shadowMapSize: vec2<f32>,
    shadowDarkness: f32,
    shadowSoftShadows: f32,
    clippingPlaneCount: u32,
    clippingUnionMode: u32,
    clippingEdgeWidth: f32,
    clippingPolygonCount: u32,
    clippingEdgeColor: vec4<f32>,
    clipPlaneEqHW: array<vec4<f32>, 8>,
    atmosphereLutControl: vec4<f32>,
}
@group(1) @binding(0) var<uniform> effects: EffectsUniforms;
@group(1) @binding(7) var atmosphereTransmittanceLut: texture_2d<f32>;
@group(1) @binding(8) var atmosphereInscatterLut: texture_2d<f32>;
@group(1) @binding(9) var atmosphereLutSampler: sampler;

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;

  // RTE positioning
  let posRTE = (input.positionHigh - uniforms.encodedCameraHigh) +
               (input.positionLow - uniforms.encodedCameraLow);

  // Eye-space position for attenuation
  let eyePos = uniforms.modelViewRelativeToEye * vec4<f32>(posRTE, 1.0);
  let dist = length(eyePos.xyz);

  // Point size with distance attenuation
  var pointSize = input.colorAndSize.a * uniforms.pointSizeMultiplier;
  if (uniforms.attenuationBaseResolution > 0.0) {
    // Geometric error-based attenuation
    let factor = uniforms.attenuationBaseResolution / max(dist, 0.001);
    pointSize = clamp(pointSize * factor * uniforms.attenuationGeometricErrorScale,
                      1.0, uniforms.attenuationMaxSize);
  }

  // Billboard offset in clip space
  let clipPos = uniforms.mvpRelativeToEye * vec4<f32>(posRTE, 1.0);
  let pixelSizeX = pointSize / uniforms.viewportSize.x * clipPos.w;
  let pixelSizeY = pointSize / uniforms.viewportSize.y * clipPos.w;

  var finalPos = clipPos;
  finalPos.x = finalPos.x + input.quadVertex.x * pixelSizeX;
  finalPos.y = finalPos.y + input.quadVertex.y * pixelSizeY;

  output.position = finalPos;
  output.color = input.colorAndSize.rgb;
  output.pointUV = input.quadVertex;
  output.normal = input.normalOrAttr;
  // FEAT-GAP-09 (Batch 102) — eye-space point-center position. Use
  // the same `eyePos` already computed above for attenuation.
  output.eyePosition = eyePos.xyz;

  return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  // Circular point shape
  let dist = length(input.pointUV);
  if (dist > 1.0) {
    discard;
  }

  // Smooth edge
  let alpha = 1.0 - smoothstep(0.8, 1.0, dist);

  var color = input.color;

  // Simple lighting if normals are present
  if (uniforms.hasNormals > 0.5) {
    let lightDir = normalize(vec3<f32>(0.5, 0.5, 1.0));
    let n = normalize(input.normal);
    let nDotL = max(dot(n, lightDir), 0.0);
    let ambient = 0.3;
    color = color * (ambient + (1.0 - ambient) * nDotL);
  }

  var finalColor = vec4<f32>(color, alpha);

  // FEAT-GAP-09 (Batch 102) — Aerial-perspective fog blend. Mirrors
  // `PrimitiveBasicColor.wgsl::fragmentMain`. Distant point clouds
  // (LiDAR scans, photogrammetry assets) fade toward inscatter when
  // atmosphere is active.
  if (effects.atmosphereLutControl.x > 0.5) {
    let innerRadius = effects.atmosphereLutControl.y;
    let thickness = max(1.0, effects.atmosphereLutControl.z);
    let cameraWC = uniforms.encodedCameraHigh + uniforms.encodedCameraLow;
    let viewDirWS = normalize(input.eyePosition);
    let upDir = normalize(cameraWC);
    let cosViewZenith = clamp(dot(viewDirWS, upDir), -1.0, 1.0);
    let cameraAltitude = max(0.0, length(cameraWC) - innerRadius);
    let uCoord = clamp(cosViewZenith * 0.5 + 0.5, 0.0, 1.0);
    let vCoord = clamp(cameraAltitude / thickness, 0.0, 1.0);

    let tSample = textureSampleLevel(
      atmosphereTransmittanceLut, atmosphereLutSampler,
      vec2<f32>(uCoord, vCoord), 0.0,
    );
    let iSample = textureSampleLevel(
      atmosphereInscatterLut, atmosphereLutSampler,
      vec2<f32>(uCoord, vCoord), 0.0,
    );
    let transmittance =
      clamp((tSample.r + tSample.g + tSample.b) / 3.0, 0.0, 1.0);

    let excessAltitude = max(0.0, cameraAltitude - thickness);
    let orbitFalloff = exp(-excessAltitude / thickness);

    let fogWeight = clamp(iSample.a, 0.0, 1.0) * orbitFalloff;
    finalColor = vec4<f32>(
      mix(finalColor.rgb, iSample.rgb, fogWeight),
      finalColor.a,
    );
    if (effects.atmosphereLutControl.w > 0.5) {
      finalColor = vec4<f32>(
        finalColor.rgb * mix(1.0, transmittance, fogWeight),
        finalColor.a,
      );
    }
  }

  return finalColor;
}
