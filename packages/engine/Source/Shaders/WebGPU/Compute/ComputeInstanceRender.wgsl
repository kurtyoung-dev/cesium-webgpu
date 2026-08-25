// Renders GPU-resident compute-instance collections as instanced points.
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
// `previousViewProjection` occupies the CameraUniforms tail. For TAA motion
// vectors, the renderer ping-pongs two instance-record buffers: the kernel
// writes the current buffer each frame and last frame's output buffer binds as
// `prevInstances` at @binding(3). Only the velocity entry points reference
// that binding, so the color pipeline's two-entry bind group layout is
// unaffected. The velocity pass rasterizes at the current position and outputs
// the NDC delta into the rg16float velocity target (cloud/point/billboard
// pattern).

// Must match `CsmInstanceRecord` in ComputeInstanceScaffold.wgsl
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
  // Log-depth encode frustum (near, far) and factor
  // (oneOverLog2FarDepthFromNearPlusOne). Packed unconditionally; only the
  // preprocessor-controlled log-depth paths read these fields.
  logDepthNearFar: vec2<f32>,            // bytes 72-79
  encodedCameraHigh: vec3<f32>,          // bytes 80-91 (+4 pad)
  logDepthFactor: f32,
  encodedCameraLow: vec3<f32>,           // bytes 96-107 (+4 pad)
  _pad1: f32,
  // Previous frame's view-projection matrix occupies the layout tail.
  previousViewProjection: mat4x4<f32>,   // bytes 112-175
};

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(0) @binding(1) var<storage, read> instances: array<InstanceRecord>;

//>>ifdef LOG_DEPTH
// Renderer-wide log depth — canonical inline copies; see
// chunks/functions/csm_{vertexLogDepth,writeLogDepth}.wgsl.
fn csm_vertexLogDepth(clipPosition: vec4<f32>, near: f32) -> f32 {
  return (clipPosition.w - near) + 1.0;
}
fn csm_updatePositionDepth(clipPosition: vec4<f32>) -> vec4<f32> {
  var coords = clipPosition;
  coords.z = clamp(coords.z / coords.w, 0.0, 1.0) * coords.w;
  return coords;
}
fn csm_writeLogDepth(depthFromNearPlusOne: f32, oneOverLog2FarDepthFromNearPlusOne: f32) -> f32 {
  return log2(depthFromNearPlusOne) * oneOverLog2FarDepthFromNearPlusOne;
}
//>>endif

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec4<f32>,
  @location(1) uv: vec2<f32>,
  //>>ifdef LOG_DEPTH
  // Interpolated linear depthFromNearPlusOne; FS converts to frag_depth.
  @location(2) v_logDepth: f32,
  //>>endif
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
  //>>ifdef LOG_DEPTH
  output.v_logDepth =
    csm_vertexLogDepth(output.position, camera.logDepthNearFar.x);
  output.position = csm_updatePositionDepth(output.position);
  //>>endif
  return output;
}

struct FragOutput {
  @location(0) color: vec4<f32>,
  //>>ifdef LOG_DEPTH
  // Written for the depth test as well (frag_depth replaces rasterized z),
  // so dots test correctly against the globe's log depth at orbital range.
  @builtin(frag_depth) depth: f32,
  //>>endif
};

@fragment
fn fragmentMain(input: VertexOutput) -> FragOutput {
  // Anti-aliased circular dot: uv is [-1,1] across the quad.
  let dist = length(input.uv);
  let alpha = (1.0 - smoothstep(0.7, 1.0, dist)) * input.color.a;
  if (alpha < 0.01) {
    discard;
  }
  var out: FragOutput;
  out.color = vec4<f32>(input.color.rgb, alpha);
  //>>ifdef LOG_DEPTH
  out.depth = csm_writeLogDepth(input.v_logDepth, camera.logDepthFactor);
  //>>endif
  return out;
}

// Per-instance pick color, RGB-packed pick id in [0,1] (CPU-allocated via
// context.createPickId, one id per instance index, uploaded to its own
// storage buffer). Bound only by the pick pipeline's three-entry bind group
// (@binding(0) camera, @binding(1) instances, @binding(2) here); the color
// and velocity pipelines never statically reference this binding, so their
// own bind group layouts are unaffected. The pick pass rasterizes the same
// instanced quads as the color pass and writes the pick color byte-exact
// into the single-attachment pick FBO (no blend), so the readback decodes
// the instance under the cursor (GPU-resident point picking — there is no
// CPU position to hit-test).
@group(0) @binding(2) var<storage, read> pickColors: array<vec4<f32>>;

struct PickVertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) pickColor: vec4<f32>,
  @location(1) uv: vec2<f32>,
  //>>ifdef LOG_DEPTH
  @location(2) v_logDepth: f32,
  //>>endif
};

@vertex
fn vertexPickMain(
  @builtin(instance_index) instanceIndex: u32,
  @location(0) quadPos: vec2<f32>,  // [-1, 1] quad corners
) -> PickVertexOutput {
  var output: PickVertexOutput;

  let inst = instances[instanceIndex];

  // RTE: emulated 64-bit camera-relative translation (identical math to
  // vertexMain — the picked region must match the rendered region exactly).
  var highDiff = inst.positionHigh - camera.encodedCameraHigh;
  if (length(highDiff) == 0.0) {
    highDiff = vec3<f32>(0.0, 0.0, 0.0);
  }
  let lowDiff = inst.positionLow - camera.encodedCameraLow;
  var clipPos = camera.mvpRelativeToEye * vec4<f32>(highDiff + lowDiff, 1.0);

  let size = max(inst.pixelSize, 1.0);
  clipPos = vec4<f32>(
    clipPos.x + quadPos.x * size / camera.viewportSize.x * clipPos.w,
    clipPos.y + quadPos.y * size / camera.viewportSize.y * clipPos.w,
    clipPos.z,
    clipPos.w,
  );

  output.position = clipPos;
  output.uv = quadPos;
  output.pickColor = pickColors[instanceIndex];
  //>>ifdef LOG_DEPTH
  output.v_logDepth =
    csm_vertexLogDepth(output.position, camera.logDepthNearFar.x);
  output.position = csm_updatePositionDepth(output.position);
  //>>endif
  return output;
}

struct PickFragOutput {
  @location(0) color: vec4<f32>,
  //>>ifdef LOG_DEPTH
  @builtin(frag_depth) depth: f32,
  //>>endif
};

@fragment
fn fragmentPickMain(input: PickVertexOutput) -> PickFragOutput {
  // Match the color path's circular-dot discard so picks line up with the
  // visible dot (no picking through the transparent quad corners).
  let dist = length(input.uv);
  let alpha = 1.0 - smoothstep(0.7, 1.0, dist);
  if (alpha < 0.5) {
    discard;
  }
  var out: PickFragOutput;
  // Write the pick color without blending or alpha replacement. Pick ids pack
  // the 32-bit key little-endian across RGBA; replacing the usually-zero alpha
  // with 1.0 changes the high byte to 0xff and prevents lookup.
  out.color = input.pickColor;
  //>>ifdef LOG_DEPTH
  out.depth = csm_writeLogDepth(input.v_logDepth, camera.logDepthFactor);
  //>>endif
  return out;
}

// Previous frame's instance records are the other half of the renderer's
// ping-pong pair (last frame's kernel output buffer). Bound only by the
// velocity pipeline's three-entry bind group; the color pipeline never
// statically references this binding.
@group(0) @binding(3) var<storage, read> prevInstances: array<InstanceRecord>;

struct VelocityVertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) currentCenterClip: vec4<f32>,
  @location(1) prevCenterClip: vec4<f32>,
  //>>ifdef LOG_DEPTH
  // Velocity pass shares scene depth read-only — test in log space.
  @location(2) v_logDepth: f32,
  //>>endif
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

  // Rasterize at the current-frame position so the velocity texture
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
  //>>ifdef LOG_DEPTH
  output.v_logDepth =
    csm_vertexLogDepth(output.position, camera.logDepthNearFar.x);
  output.position = csm_updatePositionDepth(output.position);
  //>>endif
  return output;
}

struct VelocityFragOutput {
  @location(0) velocity: vec2<f32>,
  //>>ifdef LOG_DEPTH
  @builtin(frag_depth) depth: f32,
  //>>endif
};

@fragment
fn fragmentVelocityMain(
  input: VelocityVertexOutput,
) -> VelocityFragOutput {
  var out: VelocityFragOutput;
  //>>ifdef LOG_DEPTH
  out.depth = csm_writeLogDepth(input.v_logDepth, camera.logDepthFactor);
  //>>endif
  let curW = input.currentCenterClip.w;
  let prevW = input.prevCenterClip.w;
  if (curW <= 0.0 || prevW <= 0.0) {
    out.velocity = vec2<f32>(0.0);
    return out;
  }
  let curNdc = input.currentCenterClip.xy / curW;
  let prevNdc = input.prevCenterClip.xy / prevW;
  out.velocity = curNdc - prevNdc;
  return out;
}
