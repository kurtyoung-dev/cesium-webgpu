// BillboardCollectionSDF.wgsl — Billboard rendering with SDF text support
// Extends BillboardCollection.wgsl with signed distance field rendering
// for antialiased text with outlines (used by LabelCollection).
//
// Instance data layout (128 bytes per billboard, 8 x vec4):
//   @location(0) posHighAndScale:    vec4<f32>
//   @location(1) posLowAndRotation:  vec4<f32>
//   @location(2) compressedAttr0:    vec4<f32> — pixelOffset.xy, alignedAxis.xy
//   @location(3) compressedAttr1:    vec4<f32> — imageRect (x,y,w,h normalized)
//   @location(4) color:              vec4<f32> — fill color rgba
//   @location(5) miscFlags:          vec4<f32> — show, sizeInMeters, width, height
//   @location(6) outlineColor:       vec4<f32> — outline color rgba
//   @location(7) sdfParams:          vec4<f32> — outlineWidth, sdfEdge, 0, 0

struct CameraUniforms {
  mvpRelativeToEye: mat4x4<f32>,
  viewRotation: mat4x4<f32>,
  encodedCameraHigh: vec3<f32>,
  _pad0: f32,
  encodedCameraLow: vec3<f32>,
  _pad1: f32,
  viewportSize: vec2<f32>,
  highResMultiplier: f32,
  _pad2: f32,
};

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(0) @binding(1) var atlasTexture: texture_2d<f32>;
@group(0) @binding(2) var atlasSampler: sampler;

struct VertexInput {
  @builtin(vertex_index) vertexIndex: u32,
  @location(0) posHighAndScale: vec4<f32>,
  @location(1) posLowAndRotation: vec4<f32>,
  @location(2) compressedAttr0: vec4<f32>,
  @location(3) compressedAttr1: vec4<f32>,
  @location(4) color: vec4<f32>,
  @location(5) miscFlags: vec4<f32>,
  @location(6) outlineColor: vec4<f32>,
  @location(7) sdfParams: vec4<f32>,
};

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) texCoord: vec2<f32>,
  @location(1) fillColor: vec4<f32>,
  @location(2) outlineColor: vec4<f32>,
  @location(3) sdfParams: vec2<f32>, // outlineWidth, sdfEdge
};

fn translateRelativeToEye(posHigh: vec3<f32>, posLow: vec3<f32>, camHigh: vec3<f32>, camLow: vec3<f32>) -> vec3<f32> {
  return (posHigh - camHigh) + (posLow - camLow);
}

const QUAD_OFFSETS = array<vec2<f32>, 6>(
  vec2<f32>(-0.5, -0.5),
  vec2<f32>( 0.5, -0.5),
  vec2<f32>( 0.5,  0.5),
  vec2<f32>(-0.5, -0.5),
  vec2<f32>( 0.5,  0.5),
  vec2<f32>(-0.5,  0.5),
);

const QUAD_UVS = array<vec2<f32>, 6>(
  vec2<f32>(0.0, 1.0),
  vec2<f32>(1.0, 1.0),
  vec2<f32>(1.0, 0.0),
  vec2<f32>(0.0, 1.0),
  vec2<f32>(1.0, 0.0),
  vec2<f32>(0.0, 0.0),
);

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;

  let show = input.miscFlags.x;
  if (show < 0.5) {
    output.position = vec4<f32>(0.0, 0.0, -2.0, 1.0);
    output.texCoord = vec2<f32>(0.0);
    output.fillColor = vec4<f32>(0.0);
    output.outlineColor = vec4<f32>(0.0);
    output.sdfParams = vec2<f32>(0.0);
    return output;
  }

  let posHigh = input.posHighAndScale.xyz;
  let posLow = input.posLowAndRotation.xyz;
  let scale = input.posHighAndScale.w;
  let rotation = input.posLowAndRotation.w;
  let pixelOffset = input.compressedAttr0.xy;
  let imageRect = input.compressedAttr1;
  let billboardWidth = input.miscFlags.z;
  let billboardHeight = input.miscFlags.w;

  let positionRTE = translateRelativeToEye(posHigh, posLow, camera.encodedCameraHigh, camera.encodedCameraLow);
  var clipPos = camera.mvpRelativeToEye * vec4<f32>(positionRTE, 1.0);

  let cornerIndex = input.vertexIndex % 6u;
  var corner = QUAD_OFFSETS[cornerIndex];

  if (abs(rotation) > 0.001) {
    let cosR = cos(rotation);
    let sinR = sin(rotation);
    corner = vec2<f32>(
      corner.x * cosR - corner.y * sinR,
      corner.x * sinR + corner.y * cosR
    );
  }

  let size = vec2<f32>(billboardWidth, billboardHeight) * scale;
  let pixelToClip = 2.0 / camera.viewportSize;
  clipPos.x += (corner.x * size.x + pixelOffset.x) * pixelToClip.x * clipPos.w;
  clipPos.y += (corner.y * size.y + pixelOffset.y) * pixelToClip.y * clipPos.w;

  output.position = clipPos;

  let baseUV = QUAD_UVS[cornerIndex];
  output.texCoord = vec2<f32>(
    imageRect.x + baseUV.x * imageRect.z,
    imageRect.y + baseUV.y * imageRect.w
  );

  output.fillColor = input.color;
  output.outlineColor = input.outlineColor;
  output.sdfParams = input.sdfParams.xy; // outlineWidth, sdfEdge
  return output;
}

// SDF rendering: distance field is stored in the red channel of the atlas
// SDF_EDGE is the distance value at the glyph boundary (1.0 - CUTOFF = 0.75)
fn getSDFColor(
  texCoord: vec2<f32>,
  fillColor: vec4<f32>,
  outlineColor: vec4<f32>,
  outlineWidth: f32,
  sdfEdge: f32,
  smoothing: f32,
) -> vec4<f32> {
  let distance = textureSample(atlasTexture, atlasSampler, texCoord).r;

  if (outlineWidth > 0.0) {
    // Outline edge: move inward from the glyph edge
    let outlineEdge = clamp(sdfEdge - outlineWidth, 0.0, sdfEdge);
    // Transition from outline to fill at the SDF edge
    let outlineFactor = smoothstep(sdfEdge - smoothing, sdfEdge + smoothing, distance);
    let sdfColor = mix(outlineColor, fillColor, outlineFactor);
    // Alpha: glyph visible from outline edge outward
    let alpha = smoothstep(outlineEdge - smoothing, outlineEdge + smoothing, distance);
    return vec4<f32>(sdfColor.rgb, sdfColor.a * alpha);
  } else {
    // No outline — simple fill with antialiased edge
    let alpha = smoothstep(sdfEdge - smoothing, sdfEdge + smoothing, distance);
    return vec4<f32>(fillColor.rgb, fillColor.a * alpha);
  }
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  let outlineWidth = input.sdfParams.x;
  let sdfEdge = input.sdfParams.y;

  // Smoothing based on screen-space derivatives for resolution-independent AA
  let dx = dpdx(input.texCoord);
  let dy = dpdy(input.texCoord);
  let smoothing = length(vec2<f32>(length(dx), length(dy))) * 1.4142;

  // 5-tap supersampling: center + 4 diagonal neighbors
  let sampleOffset = 0.354 * (dx + dy);

  let center = getSDFColor(input.texCoord, input.fillColor, input.outlineColor, outlineWidth, sdfEdge, smoothing);
  let c1 = getSDFColor(input.texCoord + vec2<f32>(sampleOffset.x, sampleOffset.y), input.fillColor, input.outlineColor, outlineWidth, sdfEdge, smoothing);
  let c2 = getSDFColor(input.texCoord + vec2<f32>(-sampleOffset.x, sampleOffset.y), input.fillColor, input.outlineColor, outlineWidth, sdfEdge, smoothing);
  let c3 = getSDFColor(input.texCoord + vec2<f32>(-sampleOffset.x, -sampleOffset.y), input.fillColor, input.outlineColor, outlineWidth, sdfEdge, smoothing);
  let c4 = getSDFColor(input.texCoord + vec2<f32>(sampleOffset.x, -sampleOffset.y), input.fillColor, input.outlineColor, outlineWidth, sdfEdge, smoothing);

  var color = (center + c1 + c2 + c3 + c4) * 0.2;

  if (color.a < 0.005) {
    discard;
  }

  return color;
}
