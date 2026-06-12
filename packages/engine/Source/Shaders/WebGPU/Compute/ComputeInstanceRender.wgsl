// ComputeInstanceRender.wgsl — instanced point rendering for GPU-resident
// compute-instance collections (NEW-COMPUTE-INSTANCE-SYSTEM; renamed from
// the Batch-230 OrbitalCatalogRender.wgsl when the orbital catalog was
// generalized into the feature-agnostic compute-instance system).
//
// Vertex-pulls per-instance position high/low + color + pixelSize from the
// storage buffer that the composed compute module (ComputeInstanceScaffold
// + user kernel) wrote this frame (same `GPUBuffer`, no CPU round-trip).
// Each instance renders as a screen-space quad (2 triangles, 6 vertices
// from a tiny shared quad VB at @location(0)) shaded as an anti-aliased
// dot — the same quad-expansion approach as `PointPrimitiveColor.wgsl`,
// minus the per-point CPU attribute streams.
//
// RTE precision — positions arrive as EncodedCartesian3-style high/low and
// the encoded camera position is subtracted on the GPU (translateRelativeToEye
// pattern), then projected with `mvpRelativeToEye`. Never materializes an
// absolute world-space position in f32.
//
// `previousViewProjection` rides at the CameraUniforms tail per the DP-H41
// (Batch 27) struct contract. TAA motion vectors (Batch 235): the renderer
// ping-pongs two instance-record buffers — the kernel writes the CURRENT
// buffer each frame and last frame's output buffer binds as `prevInstances`
// (@binding(2), statically used only by the velocity entry points below, so
// the color pipeline's two-entry bind group layout is unaffected). The
// velocity pass rasterizes at the current position and outputs the NDC
// delta into the rg16float velocity target (cloud/point/billboard pattern).

// MUST match `CsmInstanceRecord` in ComputeInstanceScaffold.wgsl
// (64 bytes: vec3+pad, vec3+pad, vec4, f32+12 pad).
struct InstanceRecord {
  positionHigh: vec3<f32>,
  positionLow: vec3<f32>,
  color: vec4<f32>,
  pixelSize: f32,
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
@group(0) @binding(1) var<storage, read> instances: array<InstanceRecord>;

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

  let inst = instances[instanceIndex];

  // RTE: emulated 64-bit camera-relative translation.
  var highDiff = inst.positionHigh - camera.encodedCameraHigh;
  // NaN guard for devices where identical subtraction produces NaN (iOS).
  if (length(highDiff) == 0.0) {
    highDiff = vec3<f32>(0.0, 0.0, 0.0);
  }
  let lowDiff = inst.positionLow - camera.encodedCameraLow;
  var clipPos = camera.mvpRelativeToEye * vec4<f32>(highDiff + lowDiff, 1.0);

  // Screen-space quad expansion: quadPos in [-1,1], pixelSize is the dot
  // diameter, so the corner offset in pixels is quadPos * pixelSize / 2.
  // NDC offset = px / viewport * 2 → quadPos * pixelSize / viewport.
  // Multiply by w so the offset survives the perspective divide.
  let size = max(inst.pixelSize, 1.0);
  clipPos = vec4<f32>(
    clipPos.x + quadPos.x * size / camera.viewportSize.x * clipPos.w,
    clipPos.y + quadPos.y * size / camera.viewportSize.y * clipPos.w,
    clipPos.z,
    clipPos.w,
  );

  output.position = clipPos;
  output.uv = quadPos;
  output.color = inst.color;
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

// ── TAA velocity entry points (Batch 235) ──────────────────────────────
// Previous frame's instance records — the OTHER half of the renderer's
// ping-pong pair (last frame's kernel output buffer). Bound only by the
// velocity pipeline's three-entry bind group; the color pipeline never
// statically references this binding.
@group(0) @binding(2) var<storage, read> prevInstances: array<InstanceRecord>;

struct VelocityVertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) currentCenterClip: vec4<f32>,
  @location(1) prevCenterClip: vec4<f32>,
};

@vertex
fn vertexVelocityMain(
  @builtin(instance_index) instanceIndex: u32,
  @location(0) quadPos: vec2<f32>,  // [-1, 1] quad corners
) -> VelocityVertexOutput {
  var output: VelocityVertexOutput;

  let inst = instances[instanceIndex];
  let prev = prevInstances[instanceIndex];

  // Current-frame center clip via RTE (identical math to vertexMain).
  var highDiff = inst.positionHigh - camera.encodedCameraHigh;
  if (length(highDiff) == 0.0) {
    highDiff = vec3<f32>(0.0, 0.0, 0.0);
  }
  let lowDiff = inst.positionLow - camera.encodedCameraLow;
  let currentCenterClip =
    camera.mvpRelativeToEye * vec4<f32>(highDiff + lowDiff, 1.0);

  // Previous-frame center clip via the full previous viewProjection.
  // high + low reconstructs the absolute position because
  // previousViewProjection is a plain world-space matrix, not RTE — the
  // f32 precision loss only perturbs the velocity vector, never the
  // rasterized position (PointPrimitiveColor.wgsl velocity precedent).
  let prevWorld = vec4<f32>(prev.positionHigh + prev.positionLow, 1.0);
  let prevCenterClip = camera.previousViewProjection * prevWorld;

  // Rasterize at the CURRENT-frame position so the velocity texture
  // covers the same pixels the color pass touched (same quad expansion
  // as vertexMain).
  let size = max(inst.pixelSize, 1.0);
  output.position = vec4<f32>(
    currentCenterClip.x +
      quadPos.x * size / camera.viewportSize.x * currentCenterClip.w,
    currentCenterClip.y +
      quadPos.y * size / camera.viewportSize.y * currentCenterClip.w,
    currentCenterClip.z,
    currentCenterClip.w,
  );
  output.currentCenterClip = currentCenterClip;
  output.prevCenterClip = prevCenterClip;
  return output;
}

@fragment
fn fragmentVelocityMain(
  input: VelocityVertexOutput,
) -> @location(0) vec2<f32> {
  let curW = input.currentCenterClip.w;
  let prevW = input.prevCenterClip.w;
  if (curW <= 0.0 || prevW <= 0.0) {
    return vec2<f32>(0.0);
  }
  let curNdc = input.currentCenterClip.xy / curW;
  let prevNdc = input.prevCenterClip.xy / prevW;
  return curNdc - prevNdc;
}
