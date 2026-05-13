// BillboardCollectionPick.wgsl — Pick shader for instanced billboard rendering
// Same vertex logic as BillboardCollection.wgsl but outputs pick color instead of texture.
//
// Instance data layout (160 bytes per billboard, 10 x vec4 — Batch 137):
//   @location(0) posHighAndScale:           vec4<f32> — encodedPosition.high.xyz, uniformScale
//   @location(1) posLowAndRotation:         vec4<f32> — encodedPosition.low.xyz, rotation
//   @location(2) compressedAttr0:           vec4<f32> — pixelOffset.xy, alignedAxis.xy
//   @location(3) compressedAttr1:           vec4<f32> — imageRect (x,y,w,h in atlas, normalized)
//   @location(4) pickColor:                 vec4<f32> — pick ID rgba
//   @location(5) miscFlags:                 vec4<f32> — show, sizeInMeters, width, height
//   @location(6) perInstanceFlags:          vec4<f32> — disableDepthTestDistance,
//                                            splitDirection,
//                                            distanceDisplayConditionNearSq,
//                                            distanceDisplayConditionFarSq
//   @location(7) translucencyByDistance:    vec4<f32> — near, nearAlpha, far, farAlpha
//   @location(8) pixelOffsetScaleByDistance: vec4<f32> — near, nearScale, far, farScale
//   @location(9) scaleByDistance:           vec4<f32> — near, nearScale, far, farScale
//
// The pick path applies DP-H42 + DP-H40 + AUDIT_2026_05_02 A.14 (DDC +
// translucency + pixelOffset + scaling) the same way the color path
// does so the picked region matches the visible one. Batch 136
// extended the color path; Batch 137 brings pick to parity (a
// translucency=0 / scale=0 / out-of-DDC-window billboard must NOT
// pick — `clipPos = (0,0,0,1)` collapses the quad to a degenerate
// point that the depth-clip rejects).

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
  minimumDisableDepthTestDistance: f32,
  splitPosition: f32,
      previousViewProjection: mat4x4<f32>,
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
  @location(6) perInstanceFlags: vec4<f32>,
  @location(7) translucencyByDistance: vec4<f32>,
  @location(8) pixelOffsetScaleByDistance: vec4<f32>,
  @location(9) scaleByDistance: vec4<f32>,
};

// AUDIT_2026_05_02 A.14 (Batch 137) — `czm_nearFarScalar` for the pick
// path. Identical implementation to the color path so a primitive's
// distance-aware visibility is mirrored exactly.
fn czm_nearFarScalar(scalar: vec4<f32>, distSq: f32) -> f32 {
  let nearDistSq = scalar.x * scalar.x;
  let farDistSq = scalar.z * scalar.z;
  let denom = farDistSq - nearDistSq;
  if (denom <= 0.0) {
    return scalar.y;
  }
  let t = clamp((distSq - nearDistSq) / denom, 0.0, 1.0);
  return mix(scalar.y, scalar.w, t);
}

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) texCoord: vec2<f32>,
  @location(1) pickColor: vec4<f32>,
  //>>ifdef SPLIT_ENABLED
  @location(2) splitDirection: f32,
  //>>endif
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
  let baseScale = input.posHighAndScale.w;
  let rotation = input.posLowAndRotation.w;
  let basePixelOffset = input.compressedAttr0.xy;
  let imageRect = input.compressedAttr1;
  let billboardWidth = input.miscFlags.z;
  let billboardHeight = input.miscFlags.w;

  // RTE position to clip space
  let positionRTE = translateRelativeToEye(posHigh, posLow, camera.encodedCameraHigh, camera.encodedCameraLow);
  var clipPos = camera.mvpRelativeToEye * vec4<f32>(positionRTE, 1.0);

  // Hoisted: squared eye distance, consumed by 4 gates below.
  let camDistSq = dot(positionRTE, positionRTE);

  // AUDIT_2026_05_02 A.14 (Batch 137) — apply EYE_DISTANCE_SCALING
  // before the corner expansion so a `scaleByDistance.farValue=0`
  // billboard collapses and is unpickable. Mirrors the color path.
  var effectiveScale: f32 = baseScale;
  //>>ifdef EYE_DISTANCE_SCALING
  let distScale = czm_nearFarScalar(input.scaleByDistance, camDistSq);
  effectiveScale = effectiveScale * distScale;
  if (distScale == 0.0) {
    clipPos = vec4<f32>(0.0, 0.0, 0.0, 1.0);
  }
  //>>endif

  // AUDIT_2026_05_02 A.14 (Batch 137) — apply EYE_DISTANCE_PIXEL_OFFSET
  // before the pixel-to-clip conversion. Pick parity with color path.
  var effectivePixelOffset: vec2<f32> = basePixelOffset;
  //>>ifdef EYE_DISTANCE_PIXEL_OFFSET
  let pxScale = czm_nearFarScalar(input.pixelOffsetScaleByDistance, camDistSq);
  effectivePixelOffset = effectivePixelOffset * pxScale;
  //>>endif

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

  // Billboard size in pixels (post-distance-scaling)
  let size = vec2<f32>(billboardWidth, billboardHeight) * effectiveScale;

  // Convert pixel offset to clip space
  let pixelToClip = 2.0 / camera.viewportSize;
  clipPos.x += (corner.x * size.x + effectivePixelOffset.x) * pixelToClip.x * clipPos.w;
  clipPos.y += (corner.y * size.y + effectivePixelOffset.y) * pixelToClip.y * clipPos.w;

  //>>ifdef DISTANCE_DISPLAY_CONDITION
  // AUDIT_2026_05_02 A.14 (Batch 137) — DDC gate. Out-of-window
  // billboards collapse to a degenerate clip-pos so the pick fragment
  // never rasterizes.
  let nearSqDDC = input.perInstanceFlags.z;
  let farSqDDC = input.perInstanceFlags.w;
  if (camDistSq < nearSqDDC || camDistSq > farSqDDC) {
    clipPos = vec4<f32>(0.0, 0.0, 0.0, 1.0);
  }
  //>>endif

  //>>ifdef DISABLE_DEPTH_DISTANCE
  // Batch 139 (4th-pass audit) — raw-sentinel pattern. Pick path
  // mirrors the color path's DISABLE_DEPTH_DISTANCE behavior so a
  // billboard with `disableDepthTestDistance = Infinity` (raw -1 in
  // the buffer) is correctly pickable above terrain.
  let disableRawDPick = input.perInstanceFlags.x;
  if (disableRawDPick < 0.0) {
    clipPos.z = clipPos.w;
  } else if (disableRawDPick != 0.0) {
    let disableDepthSqDPick = disableRawDPick * disableRawDPick;
    if (camDistSq < disableDepthSqDPick) {
      clipPos.z = clipPos.w;
    }
  } else if (camera.minimumDisableDepthTestDistance != 0.0) {
    let frameMinSqDPick =
      camera.minimumDisableDepthTestDistance *
      camera.minimumDisableDepthTestDistance;
    if (camDistSq < frameMinSqDPick) {
      clipPos.z = clipPos.w;
    }
  }
  //>>endif

  // AUDIT_2026_05_02 A.14 (Batch 137) — translucency=0 → unpickable.
  // For partial translucency (0 < t < 1) the pick still fires because
  // the user can still see and interact with the billboard.
  //>>ifdef EYE_DISTANCE_TRANSLUCENCY
  let translucency = czm_nearFarScalar(input.translucencyByDistance, camDistSq);
  if (translucency == 0.0) {
    clipPos = vec4<f32>(0.0, 0.0, 0.0, 1.0);
  }
  //>>endif

  output.position = clipPos;

  //>>ifdef SPLIT_ENABLED
  output.splitDirection = input.perInstanceFlags.y;
  //>>endif

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
  //>>ifdef SPLIT_ENABLED
  if (input.splitDirection < 0.0 && input.position.x > camera.splitPosition) {
    discard;
  }
  if (input.splitDirection > 0.0 && input.position.x < camera.splitPosition) {
    discard;
  }
  //>>endif

  // Sample atlas texture for alpha — discard transparent pixels
  let texAlpha = textureSample(atlasTexture, atlasSampler, input.texCoord).a;
  if (texAlpha < 0.005) {
    discard;
  }
  // Output pick color (ID encoded as RGBA)
  return input.pickColor;
}
