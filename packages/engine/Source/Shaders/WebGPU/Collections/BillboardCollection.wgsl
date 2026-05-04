// BillboardCollection.wgsl — Instanced billboard rendering for CesiumJS WebGPU
// Each billboard is an instanced screen-aligned quad with texture atlas support.
//
// Instance data layout (112 bytes per billboard, 7 x vec4):
//   @location(0) posHighAndScale:    vec4<f32> — encodedPosition.high.xyz, uniformScale
//   @location(1) posLowAndRotation:  vec4<f32> — encodedPosition.low.xyz, rotation
//   @location(2) compressedAttr0:    vec4<f32> — pixelOffset.xy, alignedAxis.xy
//   @location(3) compressedAttr1:    vec4<f32> — imageRect (x,y,w,h in atlas, normalized)
//   @location(4) color:              vec4<f32> — rgba
//   @location(5) miscFlags:          vec4<f32> — show, sizeInMeters, width, height
//   @location(6) perInstanceFlags:   vec4<f32> — disableDepthTestDistance,
//                                     splitDirection (-1/0/+1),
//                                     distanceDisplayConditionNearSq,
//                                     distanceDisplayConditionFarSq
//
// The `perInstanceFlags` attribute is read only inside `//>>ifdef` blocks
// for DP-H42 (DISABLE_DEPTH_DISTANCE), DP-H40 (SPLIT_ENABLED), and
// AUDIT_2026_05_02 A.14 (DISTANCE_DISPLAY_CONDITION). When none of those
// defines are active WGSL treats the declared input as unused and the
// rasterizer ignores the VB slot — cost is 16 bytes per instance of
// VRAM bandwidth only.

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
  // DP-H42 — frame-wide fallback threshold. When a billboard's per-instance
  // `disableDepthTestDistance` is zero and this is non-zero, we use this
  // value so `scene.minimumDisableDepthTestDistance` applies globally.
  // Value is the raw (unsquared) distance in meters; squared in the shader
  // for the comparison.
  minimumDisableDepthTestDistance: f32,
  // DP-H40 — frame-wide split screen cutoff in framebuffer pixels
  // (`frameState.splitPosition * context.drawingBufferWidth`). Matches
  // WebGL's `czm_splitPosition` convention so the fragment compare sits
  // in the same coordinate space as `position.xy` / `gl_FragCoord.x`.
  splitPosition: f32,
  _pad3: vec2<f32>,
    // DP-H41 (Batch 27) — previous frame's viewProjection for
    // TAA / motion-vector reprojection. Sourced from
    // `UniformState._previousViewProjection` (f32 mat4).
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
  @location(4) color: vec4<f32>,
  @location(5) miscFlags: vec4<f32>,
  @location(6) perInstanceFlags: vec4<f32>,
};

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) texCoord: vec2<f32>,
  @location(1) color: vec4<f32>,
  //>>ifdef SPLIT_ENABLED
  // DP-H40 — per-instance split direction forwarded to the fragment
  // stage so each billboard's side-of-cutoff is preserved after
  // rasterization. `-1` = left half only, `0` = always render,
  // `+1` = right half only.
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
    output.color = vec4<f32>(0.0);
    return output;
  }

  let posHigh = input.posHighAndScale.xyz;
  let posLow = input.posLowAndRotation.xyz;
  let scale = input.posHighAndScale.w;
  let rotation = input.posLowAndRotation.w;
  let pixelOffset = input.compressedAttr0.xy;
  let imageRect = input.compressedAttr1; // x,y,w,h in atlas (normalized)
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

  //>>ifdef DISTANCE_DISPLAY_CONDITION
  // AUDIT_2026_05_02 A.14 (Batch 135) — gate visibility by camera-to-
  // billboard squared eye distance against the per-instance
  // `[nearSq, farSq]` window packed into `perInstanceFlags.zw`. When
  // outside the window, push the vertex behind the near plane so all
  // 6 quad corners clip — same trick the WebGL VS uses at
  // BillboardCollectionVS.glsl:254-261. `positionRTE` is the eye-
  // space offset from the camera so its dot-self IS the squared
  // eye distance (no sqrt needed; matches WebGL's lengthSq path).
  let distSqDDC = dot(positionRTE, positionRTE);
  let nearSqDDC = input.perInstanceFlags.z;
  let farSqDDC = input.perInstanceFlags.w;
  if (distSqDDC < nearSqDDC || distSqDDC > farSqDDC) {
    clipPos = vec4<f32>(0.0, 0.0, 0.0, 1.0);
  }
  //>>endif

  //>>ifdef DISABLE_DEPTH_DISTANCE
  // DP-H42 — override depth when the camera is within the configured
  // distance of this billboard. Mirrors BillboardCollectionVS.glsl:267-276:
  // per-instance value wins, falling back to the frame-wide minimum, then
  // comparing squared eye-space distance so we avoid a sqrt. Setting
  // `clipPos.z = clipPos.w` maps to NDC z=1 (far plane) so the rasterizer
  // always passes `less-equal` depth regardless of what's in the buffer.
  var disableDepthSq = input.perInstanceFlags.x * input.perInstanceFlags.x;
  if (disableDepthSq == 0.0 && camera.minimumDisableDepthTestDistance != 0.0) {
    disableDepthSq =
      camera.minimumDisableDepthTestDistance *
      camera.minimumDisableDepthTestDistance;
  }
  if (disableDepthSq != 0.0) {
    // `positionRTE` is the eye-space offset from the camera; its squared
    // length is the squared eye-distance to the billboard center.
    let distSq = dot(positionRTE, positionRTE);
    // Negative `disableDepthTestDistanceSq` is a sentinel for infinity —
    // always disable (match WebGL's `< 0.0` convention).
    if (disableDepthSq < 0.0 || distSq < disableDepthSq) {
      clipPos.z = clipPos.w;
    }
  }
  //>>endif

  output.position = clipPos;

  //>>ifdef SPLIT_ENABLED
  // DP-H40 — forward the per-instance split direction to the fragment
  // stage. The fragment uses it to discard pixels on the wrong side of
  // `camera.splitPosition`. Interpolation over a screen-aligned quad is
  // constant in the sign-of-direction sense, so rasterization preserves
  // the intended sign.
  output.splitDirection = input.perInstanceFlags.y;
  //>>endif

  // Texture coordinates from atlas rect
  let baseUV = QUAD_UVS[cornerIndex];
  output.texCoord = vec2<f32>(
    imageRect.x + baseUV.x * imageRect.z,
    imageRect.y + baseUV.y * imageRect.w
  );

  output.color = input.color;
  return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  //>>ifdef SPLIT_ENABLED
  // DP-H40 — discard pixels on the wrong side of the split cutoff.
  // Matches the BillboardCollectionFS.glsl WebGL path:
  //   `splitDirection < 0` → render only left of cutoff
  //   `splitDirection > 0` → render only right of cutoff
  //   `splitDirection == 0` → render everywhere (the `!= 0` guards below).
  // `position.xy` is in framebuffer pixels (same as `gl_FragCoord.xy`)
  // and `camera.splitPosition` is already `fraction * drawingBufferWidth`
  // (uploaded by the JS side), so the compare stays in pixel space.
  if (input.splitDirection < 0.0 && input.position.x > camera.splitPosition) {
    discard;
  }
  if (input.splitDirection > 0.0 && input.position.x < camera.splitPosition) {
    discard;
  }
  //>>endif

  let texColor = textureSample(atlasTexture, atlasSampler, input.texCoord);
  let color = texColor * input.color;
  if (color.a < 0.005) {
    discard;
  }
  return color;
}
