// Gaussian Splat shader for WebGPU
// Renders Gaussian splat primitives (3D Gaussian Splatting for real-time radiance field rendering).
// Each splat is a 2D oriented Gaussian projected from 3D.
// Uses RTE (Relative-To-Eye) positioning for planetary-scale precision.

struct VertexInput {
  // Per-vertex quad corner
  @location(0) quadVertex: vec2<f32>,
  // Per-instance splat data
  @location(1) positionHigh: vec3<f32>,
  @location(2) positionLow: vec3<f32>,
  @location(3) covA: vec3<f32>,       // Upper triangle of 3D covariance (a, b, c)
  @location(4) covB: vec3<f32>,       // Lower triangle of 3D covariance (d, e, f)
  @location(5) colorAndAlpha: vec4<f32>, // Spherical harmonics band 0 color + opacity
};

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec4<f32>,
  @location(1) conic: vec3<f32>,      // 2D conic section (inverse 2D covariance)
  @location(2) centerOffset: vec2<f32>,
  // FEAT-GAP-09 (Batch 101) — eye-space position of the splat center
  // for the aerial-perspective fog block. Sampled at the splat's
  // RTE-projected center; the per-quad-vertex spread doesn't shift
  // it enough to matter for atmospheric falloff (the splat is small
  // relative to fog scale).
  @location(3) eyePosition: vec3<f32>,
};

struct SplatUniforms {
  mvpRelativeToEye: mat4x4<f32>,
  modelViewRelativeToEye: mat4x4<f32>,
  encodedCameraHigh: vec3<f32>,
  _pad0: f32,
  encodedCameraLow: vec3<f32>,
  _pad1: f32,
  viewportSize: vec2<f32>,
  focalX: f32,
  focalY: f32,
};

@group(0) @binding(0) var<uniform> uniforms: SplatUniforms;

// FEAT-GAP-09 (Batch 101) — truncated EffectsUniforms (480-byte UBO,
// truncated to reach `atmosphereLutControl` at byte offset 240 — see
// `WebGPUEffectsBindGroup.js`) + aerial-perspective LUT bindings at
// @group(1). GaussianSplat pipelines previously had a single bind
// group; the new effects BGL is appended in
// `WebGPUGaussianSplatRenderer.ts`.
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

// Compute 2D covariance from 3D covariance + view transform
fn computeCov2D(
  mean3D: vec3<f32>,
  cov3D_a: vec3<f32>,
  cov3D_b: vec3<f32>,
) -> vec3<f32> {
  // Jacobian of the projection (perspective)
  let t = uniforms.modelViewRelativeToEye * vec4<f32>(mean3D, 1.0);
  let limx = 1.3 * uniforms.focalX / uniforms.viewportSize.x;
  let limy = 1.3 * uniforms.focalY / uniforms.viewportSize.y;
  let txtz = clamp(t.x / t.z, -limx, limx);
  let tytz = clamp(t.y / t.z, -limy, limy);

  // Jacobian
  let J00 = uniforms.focalX / t.z;
  let J02 = -(uniforms.focalX * txtz) / t.z;
  let J11 = uniforms.focalY / t.z;
  let J12 = -(uniforms.focalY * tytz) / t.z;

  // Rotate 3D covariance by the modelView 3x3 block so splats follow
  // modelMatrix rotation/scale (Σ_view = R * Σ * R^T, matching GLSL's
  // `mat3(czm_modelView)`). Translation column of modelViewRelativeToEye
  // is zeroed CPU-side, so its 3x3 is the pure rotation*scale.
  let R = mat3x3<f32>(
    uniforms.modelViewRelativeToEye[0].xyz,
    uniforms.modelViewRelativeToEye[1].xyz,
    uniforms.modelViewRelativeToEye[2].xyz,
  );
  // Σ symmetric: covA = (Σ00, Σ01, Σ02), covB = (Σ11, Σ12, Σ22)
  let Sigma = mat3x3<f32>(
    vec3<f32>(cov3D_a.x, cov3D_a.y, cov3D_a.z),
    vec3<f32>(cov3D_a.y, cov3D_b.x, cov3D_b.y),
    vec3<f32>(cov3D_a.z, cov3D_b.y, cov3D_b.z),
  );
  let SV = R * Sigma * transpose(R);
  let a = SV[0][0]; let b = SV[1][0]; let c = SV[2][0];
  let d = SV[1][1]; let e = SV[2][1]; let f = SV[2][2];

  // J * Σ_view * J^T (2x2 result). Low-rank terms 0.3 regularize.
  let cov2D_00 = J00 * J00 * a + 2.0 * J00 * J02 * c + J02 * J02 * f + 0.3;
  let cov2D_01 = J00 * J11 * b + J02 * J11 * e + J00 * J12 * c + J02 * J12 * f;
  let cov2D_11 = J11 * J11 * d + 2.0 * J11 * J12 * e + J12 * J12 * f + 0.3;

  return vec3<f32>(cov2D_00, cov2D_01, cov2D_11);
}

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;

  // RTE positioning
  let posRTE = (input.positionHigh - uniforms.encodedCameraHigh) +
               (input.positionLow - uniforms.encodedCameraLow);

  // Project center to clip space
  let clipPos = uniforms.mvpRelativeToEye * vec4<f32>(posRTE, 1.0);

  // Compute 2D covariance
  let cov2D = computeCov2D(posRTE, input.covA, input.covB);

  // Invert 2D covariance for the conic
  let det = cov2D.x * cov2D.z - cov2D.y * cov2D.y;
  if (det <= 0.0) {
    output.position = vec4<f32>(0.0, 0.0, 2.0, 1.0); // Behind camera
    output.color = vec4<f32>(0.0);
    output.conic = vec3<f32>(0.0);
    output.centerOffset = vec2<f32>(0.0);
    output.eyePosition = vec3<f32>(0.0);
    return output;
  }

  let invDet = 1.0 / det;
  let conic = vec3<f32>(cov2D.z * invDet, -cov2D.y * invDet, cov2D.x * invDet);

  // Compute splat radius (3-sigma)
  let eigenMax = 0.5 * (cov2D.x + cov2D.z + sqrt((cov2D.x - cov2D.z) * (cov2D.x - cov2D.z) + 4.0 * cov2D.y * cov2D.y));
  let radius = ceil(3.0 * sqrt(eigenMax));

  // Offset quad corners by radius in screen space
  let pixelOffset = input.quadVertex * radius;
  let ndcOffset = pixelOffset / uniforms.viewportSize * 2.0 * clipPos.w;

  var finalPos = clipPos;
  finalPos.x = finalPos.x + ndcOffset.x;
  finalPos.y = finalPos.y + ndcOffset.y;

  output.position = finalPos;
  output.color = input.colorAndAlpha;
  output.conic = conic;
  output.centerOffset = pixelOffset;
  // FEAT-GAP-09 (Batch 101) — eye-space center for the fog block.
  // Per-quad-vertex spread is tiny relative to fog scale; using the
  // splat-center eye position is accurate enough for atmospheric
  // attenuation.
  let eyePos = uniforms.modelViewRelativeToEye * vec4<f32>(posRTE, 1.0);
  output.eyePosition = eyePos.xyz;

  return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  // Evaluate Gaussian
  let offset = input.centerOffset;
  let power = -0.5 * (input.conic.x * offset.x * offset.x +
                       input.conic.z * offset.y * offset.y) -
              input.conic.y * offset.x * offset.y;

  if (power > 0.0) {
    discard;
  }

  let alpha = min(0.99, input.color.a * exp(power));
  if (alpha < 1.0 / 255.0) {
    discard;
  }

  var finalColor = vec4<f32>(input.color.rgb * alpha, alpha);

  // FEAT-GAP-09 (Batch 101) — Aerial-perspective fog blend. Mirrors
  // `PrimitiveBasicColor.wgsl::fragmentMain`. Distant splat clusters
  // (urban scans, satellite photogrammetry) will fade toward the
  // inscatter color when atmosphere is active.
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
