// OrbitalCatalogRender.wgsl — instanced point rendering for the GPU-resident
// orbital catalog (Phase 3, NEW-ORBITAL-GPU-RESIDENT-RENDERER).
//
// Vertex-pulls per-instance position high/low from the storage buffer that
// `OrbitalPropagate.wgsl` wrote this frame (same `GPUBuffer`, no CPU
// round-trip) and per-instance color/size from the element catalog buffer.
// Each object renders as a screen-space quad (2 triangles, 6 vertices from
// a tiny shared quad VB at @location(0)) shaded as an anti-aliased dot —
// the same quad-expansion approach as `PointPrimitiveColor.wgsl`, minus the
// per-point CPU attribute streams.
//
// RTE precision — positions arrive as EncodedCartesian3-style high/low and
// the encoded camera position is subtracted on the GPU (translateRelativeToEye
// pattern), then projected with `mvpRelativeToEye`. Never materializes an
// absolute world-space position in f32.
//
// `previousViewProjection` rides at the CameraUniforms tail per the DP-H41
// (Batch 27) struct contract. No velocity entry point yet — TAA motion
// vectors for GPU-resident orbital points are a tracked follow-up
// (the prev-position storage buffer double-buffer does not exist yet).

struct OrbitalElement {
  semiMajorAxis: f32,
  inclination: f32,
  raan: f32,
  phase: f32,
  meanMotion: f32,
  epochOffset: f32,
  packedColor: u32,
  pixelSize: f32,
};

struct PositionHL {
  high: vec3<f32>,
  low: vec3<f32>,
};

struct CameraUniforms {
  mvpRelativeToEye: mat4x4<f32>,         // bytes 0-63
  viewportSize: vec2<f32>,               // bytes 64-71
  _padA: vec2<f32>,                      // bytes 72-79
  encodedCameraHigh: vec3<f32>,          // bytes 80-91 (+4 pad)
  _pad0: f32,
  encodedCameraLow: vec3<f32>,           // bytes 96-107 (+4 pad)
  _pad1: f32,
  // DP-H41 (Batch 27) — previous frame's viewProjection at the tail.
  previousViewProjection: mat4x4<f32>,   // bytes 112-175
};

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(0) @binding(1) var<storage, read> positions: array<PositionHL>;
@group(0) @binding(2) var<storage, read> elements: array<OrbitalElement>;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec4<f32>,
  @location(1) uv: vec2<f32>,
};

@vertex
fn vertexMain(
  @builtin(instance_index) instanceIndex: u32,
  @location(0) quadPos: vec2<f32>,  // [-1, 1] quad corners
) -> VertexOutput {
  var output: VertexOutput;

  let p = positions[instanceIndex];
  let e = elements[instanceIndex];

  // RTE: emulated 64-bit camera-relative translation.
  var highDiff = p.high - camera.encodedCameraHigh;
  // NaN guard for devices where identical subtraction produces NaN (iOS).
  if (length(highDiff) == 0.0) {
    highDiff = vec3<f32>(0.0, 0.0, 0.0);
  }
  let lowDiff = p.low - camera.encodedCameraLow;
  var clipPos = camera.mvpRelativeToEye * vec4<f32>(highDiff + lowDiff, 1.0);

  // Screen-space quad expansion: quadPos in [-1,1], pixelSize is the dot
  // diameter, so the corner offset in pixels is quadPos * pixelSize / 2.
  // NDC offset = px / viewport * 2 → quadPos * pixelSize / viewport.
  // Multiply by w so the offset survives the perspective divide.
  let size = max(e.pixelSize, 1.0);
  clipPos = vec4<f32>(
    clipPos.x + quadPos.x * size / camera.viewportSize.x * clipPos.w,
    clipPos.y + quadPos.y * size / camera.viewportSize.y * clipPos.w,
    clipPos.z,
    clipPos.w,
  );

  output.position = clipPos;
  output.uv = quadPos;
  output.color = unpack4x8unorm(e.packedColor);
  return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  // Anti-aliased circular dot: uv is [-1,1] across the quad.
  let dist = length(input.uv);
  let alpha = (1.0 - smoothstep(0.7, 1.0, dist)) * input.color.a;
  if (alpha < 0.01) {
    discard;
  }
  return vec4<f32>(input.color.rgb, alpha);
}
