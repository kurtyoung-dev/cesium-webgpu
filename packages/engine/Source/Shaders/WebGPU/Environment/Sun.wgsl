// Sun.wgsl — Procedural sun billboard rendering for CesiumJS WebGPU
// Renders a screen-space quad with procedural sun glow

struct Uniforms {
  mvpRelativeToEye: mat4x4<f32>,
  encodedCameraHigh: vec3<f32>,
  _pad0: f32,
  encodedCameraLow: vec3<f32>,
  _pad1: f32,
  sunSize: vec2<f32>,      // screen-space size
  glowFactor: f32,         // glow intensity
  _pad2: f32,
};

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var sunTexture: texture_2d<f32>;
@group(0) @binding(2) var sunSampler: sampler;

struct VertexInput {
  @location(0) positionHigh: vec3<f32>,
  @location(1) positionLow: vec3<f32>,
  @location(2) direction: vec2<f32>,  // corner offset [-1,1]
};

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) texCoord: vec2<f32>,
};

fn translateRelativeToEye(posHigh: vec3<f32>, posLow: vec3<f32>, camHigh: vec3<f32>, camLow: vec3<f32>) -> vec3<f32> {
  return (posHigh - camHigh) + (posLow - camLow);
}

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  let positionRTE = translateRelativeToEye(
    input.positionHigh, input.positionLow,
    u.encodedCameraHigh, u.encodedCameraLow
  );
  var clipPos = u.mvpRelativeToEye * vec4<f32>(positionRTE, 1.0);
  // Offset in screen space for billboard corners
  clipPos.x += input.direction.x * u.sunSize.x * clipPos.w;
  clipPos.y += input.direction.y * u.sunSize.y * clipPos.w;
  // AUDIT_2026_05_02 A.10 — horizon occlusion. From a surface-level
  // camera, the Sun should disappear when below the local horizon
  // (occluded by Earth). Approximate the local-up direction as
  // normalize(cameraECEF); the dot of that with the sun direction is
  // negative when the sun is below the horizon. Collapse the vertex
  // to a degenerate position to discard the draw without touching the
  // FS. Soft-twilight band (0.06 ≈ 3.4° below horizon) prevents an
  // abrupt pop. Orbital cameras (high altitude) almost always satisfy
  // dot > 0 since the local-up basis loses meaning, so this gates
  // gracefully without a hard altitude threshold.
  let cameraECEF = u.encodedCameraHigh + u.encodedCameraLow;
  let cameraECEFLen = length(cameraECEF);
  if (cameraECEFLen > 1.0) {
    let cameraUp = cameraECEF / cameraECEFLen;
    let sunDir = normalize(positionRTE);
    let sunUpDot = dot(sunDir, cameraUp);
    if (sunUpDot < -0.06) {
      // Sun is well below horizon; collapse to clip-space corner
      // out of [-1, 1] so all four corners are clipped.
      clipPos = vec4<f32>(2.0, 2.0, 2.0, 1.0);
    }
  }
  output.position = clipPos;
  output.texCoord = input.direction * 0.5 + 0.5;
  return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  let texColor = textureSample(sunTexture, sunSampler, input.texCoord);
  // Apply glow
  let dist = length(input.texCoord - vec2<f32>(0.5));
  let glow = exp(-dist * dist * 8.0) * u.glowFactor;
  var color = texColor.rgb + vec3<f32>(glow);
  let alpha = clamp(texColor.a + glow * 0.5, 0.0, 1.0);
  return vec4<f32>(color, alpha);
}

// Compute shader for procedural sun texture generation
struct ComputeUniforms {
  size: u32,
  _pad: vec3<u32>,
};

@group(0) @binding(0) var<uniform> computeParams: ComputeUniforms;
@group(0) @binding(1) var outputTexture: texture_storage_2d<rgba8unorm, write>;

@compute @workgroup_size(8, 8)
fn generateSunTexture(@builtin(global_invocation_id) gid: vec3<u32>) {
  let size = computeParams.size;
  if (gid.x >= size || gid.y >= size) { return; }

  let uv = vec2<f32>(f32(gid.x) + 0.5, f32(gid.y) + 0.5) / f32(size);
  let center = vec2<f32>(0.5);
  let dist = length(uv - center) * 2.0;

  // Sun disk
  let disk = smoothstep(0.9, 0.85, dist);
  // Corona glow
  let corona = exp(-dist * dist * 3.0) * 0.6;
  // Limb darkening
  let limb = 1.0 - pow(dist * 0.95, 4.0);

  let brightness = max(disk * limb, corona);
  let warmth = vec3<f32>(1.0, 0.95, 0.8);
  let color = warmth * brightness;
  let alpha = clamp(brightness, 0.0, 1.0);

  textureStore(outputTexture, vec2<i32>(gid.xy), vec4<f32>(color, alpha));
}
