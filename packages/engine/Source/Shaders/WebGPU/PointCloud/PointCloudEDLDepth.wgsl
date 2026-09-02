// Point Cloud Eye-Dome Lighting — depth-writing draw variant.
//
// This is the WGSL sibling of the WebGL "EC" derived shader built by
// Scene/PointCloudEyeDomeLighting.js::getECShaderProgram. It rasterizes the
// same instanced point quads as the default PointCloud draw shader
// (WebGPUPointCloudRenderer POINT_CLOUD_WGSL) using identical RTE 64-bit
// precision math (positionHigh/Low, mvpRelativeToEye), but emits a SECOND
// color output at @location(1) carrying linear eye-space depth plus the exact
// device-depth value emitted by the normal color path. The EDL off-screen
// framebuffer has two color attachments:
//   slot 0 — point color (same as the on-screen draw)
//   slot 1 — eye depth + device depth (sampled by the blend pass)
//
// The @location(1) output + the pack write are gated behind the
// POINT_CLOUD_EDL_DEPTH define. When the define is clear the shader is
// byte-identical to a single-target color shader — the //>>else branch strips
// the second output entirely. Only WebGPUPointCloudEyeDomeLighting compiles
// this shader (with the define set) into the off-screen depth pipeline.

struct VertexInput {
  @location(0) quadVertex: vec2<f32>,
  @location(1) positionHigh: vec3<f32>,
  @location(2) positionLow: vec3<f32>,
  @location(3) colorAndAlpha: vec4<f32>,
};

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec4<f32>,
  @location(1) pointUV: vec2<f32>,
  // Current point-center RTE world direction for the same atmosphere-LUT
  // calculation used by the normal default and LOD color shaders.
  @location(2) worldPos: vec3<f32>,
  // Linear depth-from-near used by the renderer-wide log-depth encoding.
  @location(3) vLogDepth: f32,
  // Linear eye-space depth (positive metres) of the point CENTER.
  @location(4) eyeDepth: f32,
};

// Layout is byte-identical to WebGPUPointCloudRenderer's POINT_CLOUD_WGSL
// `Uniforms` (304 bytes) so this depth variant BINDS THE SAME uniform buffer
// the color draw already populated — no separate pack. We read the frustum
// far plane from `logDepth.y` (floats 60..63 in that layout) to normalise the
// packed eye-space depth into [0,1].
struct Uniforms {
  mvpRelativeToEye: mat4x4<f32>,
  encodedCameraHigh: vec3<f32>,
  _pad0: f32,
  encodedCameraLow: vec3<f32>,
  _pad1: f32,
  viewportSize: vec2<f32>,
  pointSizeMultiplier: f32,
  // Attenuation scale (geomError * scale * drawingBufferHeight /
  // sseDenominator; 0 = off). Must mirror WebGPUPointCloudRenderer's
  // Uniforms so the shared UB stays layout-identical (formerly _pad2).
  attenuation: f32,
  previousMvpRelativeToEye: mat4x4<f32>,
  modelMatrix: mat4x4<f32>,
  // x = frustum near, y = frustum far, z = log factor, w = useLogDepth flag.
  logDepth: vec4<f32>,
  highlightColor: vec4<f32>,
  previousEncodedCameraHigh: vec3<f32>,
  _pad3: f32,
  previousEncodedCameraLow: vec3<f32>,
  _pad4: f32,
};

@group(0) @binding(0) var<uniform> u: Uniforms;

// Bind the exact effects group used by the normal point-cloud command. This
// keeps atmosphere LUT/fog shading identical when EDL replays the draw.
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

// LOD commands fetch the same 40-byte instance records through storage and a
// compacted visible-index indirection. The default entry point does not use
// these declarations, so its uniforms+effects pipeline layout remains valid.
@group(2) @binding(0) var<storage, read> lodInstanceData: array<f32>;
@group(2) @binding(1) var<storage, read> lodVisibleIndices: array<u32>;

fn csm_vertexLogDepth(clipPosition: vec4<f32>, near: f32) -> f32 {
  return (clipPosition.w - near) + 1.0;
}
fn csm_updatePositionDepth(clipPosition: vec4<f32>) -> vec4<f32> {
  var c = clipPosition;
  c.z = clamp(c.z / c.w, 0.0, 1.0) * c.w;
  return c;
}
fn csm_writeLogDepth(d: f32, factor: f32) -> f32 {
  return log2(d) * factor;
}

fn buildVertex(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  let posRTE = (input.positionHigh - u.encodedCameraHigh)
             + (input.positionLow - u.encodedCameraLow);
  let clipPos = u.mvpRelativeToEye * vec4<f32>(posRTE, 1.0);
  // Same attenuation clamp as the color draw so the EDL depth attachment
  // stays coverage-identical to the on-screen quads.
  var pointSize = u.pointSizeMultiplier;
  if (u.attenuation > 0.0) {
    pointSize = min(u.attenuation / max(clipPos.w, 1.0e-6), pointSize);
  }
  let px = pointSize / u.viewportSize.x * clipPos.w;
  let py = pointSize / u.viewportSize.y * clipPos.w;
  var fp = clipPos;
  fp.x = fp.x + input.quadVertex.x * px;
  fp.y = fp.y + input.quadVertex.y * py;
  output.position = fp;
  output.color = input.colorAndAlpha * u.highlightColor;
  output.pointUV = input.quadVertex;
  output.worldPos = (u.modelMatrix * vec4<f32>(posRTE, 0.0)).xyz;
  output.vLogDepth = csm_vertexLogDepth(clipPos, u.logDepth.x);
  if (u.logDepth.w > 0.5) {
    output.position = csm_updatePositionDepth(output.position);
  }
  // clipPos.w is the positive eye-space distance to the point center for a
  // standard perspective projection (matching the on-screen draw path).
  output.eyeDepth = clipPos.w;
  return output;
}

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
  return buildVertex(input);
}

@vertex
fn vertexMainLOD(
  @location(0) quadVertex: vec2<f32>,
  @builtin(instance_index) compactedIndex: u32,
) -> VertexOutput {
  let pointIndex = lodVisibleIndices[compactedIndex];
  let base = pointIndex * 10u;
  return buildVertex(VertexInput(
    quadVertex,
    vec3<f32>(
      lodInstanceData[base],
      lodInstanceData[base + 1u],
      lodInstanceData[base + 2u],
    ),
    vec3<f32>(
      lodInstanceData[base + 3u],
      lodInstanceData[base + 4u],
      lodInstanceData[base + 5u],
    ),
    vec4<f32>(
      lodInstanceData[base + 6u],
      lodInstanceData[base + 7u],
      lodInstanceData[base + 8u],
      lodInstanceData[base + 9u],
    ),
  ));
}

//>>ifdef POINT_CLOUD_EDL_DEPTH
struct FragOut {
  @location(0) color: vec4<f32>,
  // Raw positive eye-space depth plus the exact scene device depth into an
  // rg32float attachment. Eye depth drives EDL; device depth is replayed by
  // the composite so terrain occludes points and subsequent passes see them.
  @location(1) eyeDepthAndDeviceDepth: vec2<f32>,
  @builtin(frag_depth) depth: f32,
}

@fragment
fn fragmentMain(input: VertexOutput) -> FragOut {
  // Solid square to match WebGL gl_Points (the WebGL EC shader from
  // PointCloudEyeDomeLighting keeps the default square rasterization;
  // ModelFS only carves a circle under HAS_POINT_DIAMETER). Must stay
  // coverage-identical to WebGPUPointCloudRenderer's color draw so the EDL
  // depth attachment covers the same pixels.
  var finalColor = input.color;
  // Keep this derived replay color path in lockstep with the normal default
  // and LOD point-cloud shaders, using the same active effects bind group.
  if (effects.atmosphereLutControl.x > 0.5) {
    let innerRadius = effects.atmosphereLutControl.y;
    let thickness = max(1.0, effects.atmosphereLutControl.z);
    // The model-space camera feeds only LUT direction and altitude, where metre-scale f32 error is imperceptible.
    let cameraModel = u.encodedCameraHigh + u.encodedCameraLow;
    let cameraWC = (u.modelMatrix * vec4<f32>(cameraModel, 1.0)).xyz;
    let viewDirWS = normalize(input.worldPos);
    let upDir = normalize(cameraWC);
    let cosViewZenith = clamp(dot(viewDirWS, upDir), -1.0, 1.0);
    let cameraAltitude = max(0.0, length(cameraWC) - innerRadius);
    let uv = vec2<f32>(
      clamp(cosViewZenith * 0.5 + 0.5, 0.0, 1.0),
      clamp(cameraAltitude / thickness, 0.0, 1.0),
    );
    let tSample = textureSampleLevel(
      atmosphereTransmittanceLut, atmosphereLutSampler, uv, 0.0,
    );
    let iSample = textureSampleLevel(
      atmosphereInscatterLut, atmosphereLutSampler, uv, 0.0,
    );
    let transmittance =
      clamp((tSample.r + tSample.g + tSample.b) / 3.0, 0.0, 1.0);
    let excessAltitude = max(0.0, cameraAltitude - thickness);
    let orbitFalloff = exp(-excessAltitude / thickness);
    let fogWeight = clamp(iSample.a, 0.0, 1.0) * orbitFalloff;
    finalColor = vec4<f32>(
      mix(finalColor.rgb, iSample.rgb, fogWeight), finalColor.a,
    );
    if (effects.atmosphereLutControl.w > 0.5) {
      finalColor = vec4<f32>(
        finalColor.rgb * mix(1.0, transmittance, fogWeight), finalColor.a,
      );
    }
  }

  var deviceDepth = input.position.z;
  if (u.logDepth.w > 0.5) {
    deviceDepth = csm_writeLogDepth(input.vLogDepth, u.logDepth.z);
  }
  return FragOut(
    finalColor,
    vec2<f32>(max(input.eyeDepth, 1.0e-4), deviceDepth),
    deviceDepth,
  );
}
//>>else
@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  // Solid square; see the ifdef branch above.
  return input.color;
}
//>>endif
