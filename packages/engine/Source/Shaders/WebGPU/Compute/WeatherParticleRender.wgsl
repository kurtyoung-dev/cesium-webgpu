// WeatherParticleRender.wgsl — Render weather particles as camera-facing quads
//
// Reads the particle storage buffer from the compute simulation and renders
// each alive particle as a billboard-style screen-aligned quad.
//
// RTE precision — particle.position is CAMERA-RELATIVE (see
// `WeatherParticles.wgsl` header). Clip space is computed via
// `mvpRelativeToEye` (translation-zeroed view-projection) so particles
// project without materializing an absolute world-space position on
// the GPU. cameraRight/cameraUp are direction vectors — they can be
// added to a camera-relative position without precision loss because
// they're bounded by `particle.size` (meters).
//
// Particle struct (32 bytes):
//   position: vec3<f32>  (CAMERA-RELATIVE)
//   lifetime: f32        (remaining seconds, <0 = dead)
//   velocity: vec3<f32>  (m/s)
//   size: f32            (world-space radius)

struct Particle {
  position: vec3<f32>,
  lifetime: f32,
  velocity: vec3<f32>,
  size: f32,
};

struct CameraUniforms {
  // View-projection with the translation column zeroed. Safe to
  // multiply against eye-relative positions without losing bits
  // through a large translation add.
  mvpRelativeToEye: mat4x4<f32>,
  cameraRight: vec3<f32>,
  _pad0: f32,
  cameraUp: vec3<f32>,
  _pad1: f32,
  // Legacy cameraPosition slot kept for binary compatibility with
  // the existing JS-side uniform layout, but unused in the shader.
  _unusedCameraPosition: vec3<f32>,
  maxLifetime: f32,
  viewportSize: vec2<f32>,
  weatherType: u32,
  particleAlpha: f32,
};

@group(0) @binding(0) var<storage, read> particles: array<Particle>;
@group(0) @binding(1) var<uniform> cam: CameraUniforms;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) alpha: f32,
  @location(2) weatherType: f32,
};

// Quad corner offsets (2 triangles)
const QUAD_OFFSETS = array<vec2<f32>, 6>(
  vec2<f32>(-0.5, -0.5),
  vec2<f32>( 0.5, -0.5),
  vec2<f32>( 0.5,  0.5),
  vec2<f32>(-0.5, -0.5),
  vec2<f32>( 0.5,  0.5),
  vec2<f32>(-0.5,  0.5),
);

const QUAD_UVS = array<vec2<f32>, 6>(
  vec2<f32>(0.0, 0.0),
  vec2<f32>(1.0, 0.0),
  vec2<f32>(1.0, 1.0),
  vec2<f32>(0.0, 0.0),
  vec2<f32>(1.0, 1.0),
  vec2<f32>(0.0, 1.0),
);

@vertex
fn vertexMain(
  @builtin(vertex_index) vertexIndex: u32,
  @builtin(instance_index) instanceIndex: u32,
) -> VertexOutput {
  var output: VertexOutput;

  let p = particles[instanceIndex];

  // Dead particle — move off-screen
  if (p.lifetime <= 0.0) {
    output.position = vec4<f32>(0.0, 0.0, -2.0, 1.0);
    output.uv = vec2<f32>(0.0);
    output.alpha = 0.0;
    output.weatherType = 0.0;
    return output;
  }

  let cornerIdx = vertexIndex % 6u;
  let corner = QUAD_OFFSETS[cornerIdx];

  // Billboard: expand quad along camera right/up axes. `p.position` is
  // already camera-relative, and the right/up offsets are bounded by
  // `p.size` (meters), so the sum stays well within FP32 precision.
  let eyeRelativePos = p.position
    + cam.cameraRight * corner.x * p.size
    + cam.cameraUp * corner.y * p.size;

  // Project with the translation-zeroed view-projection.
  output.position = cam.mvpRelativeToEye * vec4<f32>(eyeRelativePos, 1.0);
  output.uv = QUAD_UVS[cornerIdx];

  // Alpha: fade in/out based on lifetime
  let lifeFraction = p.lifetime / cam.maxLifetime;
  let fadeIn = smoothstep(0.0, 0.1, lifeFraction);
  let fadeOut = smoothstep(0.0, 0.2, 1.0 - lifeFraction);
  output.alpha = fadeIn * fadeOut * cam.particleAlpha;

  output.weatherType = f32(cam.weatherType);
  return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  if (input.alpha < 0.001) {
    discard;
  }

  let uv = input.uv;
  let weatherType = u32(input.weatherType + 0.5);

  var color: vec4<f32>;

  switch (weatherType) {
    case 0u: {
      // Rain: vertical streak
      let streakX = smoothstep(0.4, 0.5, uv.x) * smoothstep(0.6, 0.5, uv.x);
      let streakY = uv.y;
      let streak = streakX * streakY;
      color = vec4<f32>(0.7, 0.75, 0.85, streak * input.alpha);
    }
    case 1u: {
      // Snow: soft circular dot
      let dist = length(uv - vec2<f32>(0.5));
      let circle = smoothstep(0.5, 0.3, dist);
      color = vec4<f32>(0.95, 0.95, 1.0, circle * input.alpha);
    }
    case 2u: {
      // Fog: very soft large circle
      let dist = length(uv - vec2<f32>(0.5));
      let fog = smoothstep(0.5, 0.0, dist) * 0.3;
      color = vec4<f32>(0.85, 0.85, 0.88, fog * input.alpha);
    }
    case 3u: {
      // Hail: harder circular dot with slight blue tint
      let dist = length(uv - vec2<f32>(0.5));
      let circle = smoothstep(0.5, 0.35, dist);
      color = vec4<f32>(0.8, 0.85, 0.95, circle * input.alpha);
    }
    default: {
      color = vec4<f32>(1.0, 1.0, 1.0, input.alpha);
    }
  }

  return color;
}
