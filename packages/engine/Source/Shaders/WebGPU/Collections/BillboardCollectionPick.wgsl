// BillboardCollectionPick.wgsl — Pick shader for instanced billboard rendering
// Same vertex logic as BillboardCollection.wgsl but outputs pick color instead of texture.
//
// Instance data layout (96 bytes per billboard, 6 x vec4):
//   @location(0) posHighAndScale:    vec4<f32> — encodedPosition.high.xyz, uniformScale
//   @location(1) posLowAndRotation:  vec4<f32> — encodedPosition.low.xyz, rotation
//   @location(2) compressedAttr0:    vec4<f32> — pixelOffset.xy, alignedAxis.xy
//   @location(3) compressedAttr1:    vec4<f32> — imageRect (x,y,w,h in atlas, normalized)
//   @location(4) pickColor:          vec4<f32> — pick ID rgba
//   @location(5) miscFlags:          vec4<f32> — show, sizeInMeters, width, height

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
  // Per-instance attributes
  @location(0) posHighAndScale: vec4<f32>,
  @location(1) posLowAndRotation: vec4<f32>,
  @location(2) compressedAttr0: vec4<f32>,
  @location(3) compressedAttr1: vec4<f32>,
  @location(4) pickColor: vec4<f32>,
  @location(5) miscFlags: vec4<f32>,
};

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) texCoord: vec2<f32>,
  @location(1) pickColor: vec4<f32>,
};

fn translateRelativeToEye(posHigh: vec3<f32>, posLow: vec3<f32>, camHigh: vec3<f32>, camLow: vec3<f32>) -> vec3<f32> {
  return (posHigh - camHigh) + (posLow - camLow);
}

// Quad corner offsets (2 triangles = 6 vertices)
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
    // Hidden billboard — move off-screen
    output.position = vec4<f32>(0.0, 0.0, -2.0, 1.0);
    output.texCoord = vec2<f32>(0.0);
    output.pickColor = vec4<f32>(0.0);
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

  // RTE position to clip space
  let positionRTE = translateRelativeToEye(posHigh, posLow, camera.encodedCameraHigh, camera.encodedCameraLow);
  var clipPos = camera.mvpRelativeToEye * vec4<f32>(positionRTE, 1.0);

  // Corner offset
  let cornerIndex = input.vertexIndex % 6u;
  var corner = QUAD_OFFSETS[cornerIndex];

  // Apply rotation
  if (abs(rotation) > 0.001) {
    let cosR = cos(rotation);
    let sinR = sin(rotation);
    corner = vec2<f32>(
      corner.x * cosR - corner.y * sinR,
      corner.x * sinR + corner.y * cosR
    );
  }

  // Billboard size in pixels
  let size = vec2<f32>(billboardWidth, billboardHeight) * scale;

  // Convert pixel offset to clip space
  let pixelToClip = 2.0 / camera.viewportSize;
  clipPos.x += (corner.x * size.x + pixelOffset.x) * pixelToClip.x * clipPos.w;
  clipPos.y += (corner.y * size.y + pixelOffset.y) * pixelToClip.y * clipPos.w;

  output.position = clipPos;

  // Texture coordinates from atlas rect (used for alpha discard)
  let baseUV = QUAD_UVS[cornerIndex];
  output.texCoord = vec2<f32>(
    imageRect.x + baseUV.x * imageRect.z,
    imageRect.y + baseUV.y * imageRect.w
  );

  output.pickColor = input.pickColor;
  return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  // Sample atlas texture for alpha — discard transparent pixels
  let texAlpha = textureSample(atlasTexture, atlasSampler, input.texCoord).a;
  if (texAlpha < 0.005) {
    discard;
  }
  // Output pick color (ID encoded as RGBA)
  return input.pickColor;
}
