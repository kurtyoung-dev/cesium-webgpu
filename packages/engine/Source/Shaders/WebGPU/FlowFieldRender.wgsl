// FlowFieldRender.wgsl — instanced point rendering for GPU flow-field wind
// particles. Each particle's geographic state
// (lon/lat/age/speed01) is vertex-pulled from the ping-pong state buffer the
// advection compute pass wrote this frame; the vertex shader converts lon/lat
// → WGS84 ellipsoid ECEF, RTE-splits it (EncodedCartesian3 2^16 convention),
// subtracts the encoded camera, and projects with mvpRelativeToEye. Never
// materializes an absolute world-space position through a single mvp*pos.
//
// Quad-expansion + circular-dot fragment follow ComputeInstanceRender.wgsl;
// LOG_DEPTH ifdef blocks mirror it so particles occlude correctly against the
// globe's log-depth buffer at planetary range.
//
// Reference: Cesium GPU-wind blog (RaymanNg/3D-Wind-Field, MIT) globe path.

const TWO_PI: f32 = 6.28318530717958647692;

struct CameraUniforms {
  mvpRelativeToEye: mat4x4<f32>,         // bytes 0-63
  viewportSize: vec2<f32>,               // bytes 64-71
  logDepthNearFar: vec2<f32>,            // bytes 72-79
  encodedCameraHigh: vec3<f32>,          // bytes 80-91 (+4 pad)
  logDepthFactor: f32,
  encodedCameraLow: vec3<f32>,           // bytes 96-107 (+4 pad)
  _pad1: f32,
  previousViewProjection: mat4x4<f32>,   // bytes 112-175
};

struct RenderParams {
  radiiSquared: vec3<f32>,   // WGS84 (a^2, a^2, b^2)
  heightOffset: f32,         // meters above the ellipsoid surface
  colorSlow: vec3<f32>,      // RGB for slow winds
  pixelSize: f32,            // dot diameter (px)
  colorFast: vec3<f32>,      // RGB for fast winds
  alpha: f32,                // overall particle alpha
};

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(0) @binding(1) var<storage, read> particles: array<vec4<f32>>;
@group(0) @binding(2) var<uniform> render: RenderParams;

//>>ifdef LOG_DEPTH
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

// lon/lat (radians) + height → WGS84 ECEF, mirroring Cesium's
// Cartographic.toCartesian (scaleToGeodeticSurface via radiiSquared).
fn lonLatToEcef(lon: f32, lat: f32, height: f32) -> vec3<f32> {
  let cosLat = cos(lat);
  let n = vec3<f32>(cosLat * cos(lon), cosLat * sin(lon), sin(lat));
  let k = render.radiiSquared * n;
  let gamma = sqrt(dot(n, k));
  let surface = k / gamma;
  return surface + n * height;
}

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec4<f32>,
  @location(1) uv: vec2<f32>,
  //>>ifdef LOG_DEPTH
  @location(2) v_logDepth: f32,
  //>>endif
};

@vertex
fn vertexMain(
  @builtin(instance_index) instanceIndex: u32,
  @location(0) quadPos: vec2<f32>,   // [-1,1] quad corners
) -> VertexOutput {
  var output: VertexOutput;

  let p = particles[instanceIndex];
  let pos = lonLatToEcef(p.x, p.y, render.heightOffset);

  // EncodedCartesian3 high/low split (2^16 = 65536.0) so the RTE subtraction
  // cancels the large common magnitude against the encoded camera.
  let high = floor(pos / 65536.0) * 65536.0;
  let low = pos - high;

  var highDiff = high - camera.encodedCameraHigh;
  if (length(highDiff) == 0.0) {
    highDiff = vec3<f32>(0.0, 0.0, 0.0);
  }
  let lowDiff = low - camera.encodedCameraLow;
  var clipPos = camera.mvpRelativeToEye * vec4<f32>(highDiff + lowDiff, 1.0);

  let size = max(render.pixelSize, 1.0);
  clipPos = vec4<f32>(
    clipPos.x + quadPos.x * size / camera.viewportSize.x * clipPos.w,
    clipPos.y + quadPos.y * size / camera.viewportSize.y * clipPos.w,
    clipPos.z,
    clipPos.w,
  );

  output.position = clipPos;
  output.uv = quadPos;
  let rgb = mix(render.colorSlow, render.colorFast, clamp(p.w, 0.0, 1.0));
  output.color = vec4<f32>(rgb, render.alpha);
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
  @builtin(frag_depth) depth: f32,
  //>>endif
};

@fragment
fn fragmentMain(input: VertexOutput) -> FragOutput {
  let dist = length(input.uv);
  let alpha = (1.0 - smoothstep(0.6, 1.0, dist)) * input.color.a;
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
