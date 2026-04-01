// AmbientOcclusionGenerate — Screen-space ambient occlusion (HBAO variant).
// Samples depth buffer in a hemisphere around each pixel to estimate occlusion.
// Based on the CesiumJS GLSL SSAO which uses horizon-based sampling with
// a random rotation per pixel to reduce banding.

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

struct SSAOUniforms {
  // x = intensity, y = bias, z = lengthCap, w = stepCount
  params0: vec4<f32>,
  // x = directionCount, y = 1/width, z = 1/height, w = randomTexSize
  params1: vec4<f32>,
  // frustum: x = near, y = far, z = unused, w = unused
  frustum: vec4<f32>,
  // Padding for 16-byte alignment
  _pad: vec4<f32>,
};

@group(0) @binding(0) var depthTexture: texture_2d<f32>;
@group(0) @binding(1) var randomTexture: texture_2d<f32>;
@group(0) @binding(2) var texSampler: sampler;
@group(0) @binding(3) var<uniform> uniforms: SSAOUniforms;

// Reconstructs inverse projection from viewport to simplified reconstruction
// For WebGPU, we pass frustum params directly
fn readDepth(uv: vec2<f32>) -> f32 {
  let raw = textureSample(depthTexture, texSampler, uv).r;
  // Linearize depth from [0,1] to eye-space Z
  let near = uniforms.frustum.x;
  let far = uniforms.frustum.y;
  return near * far / (far - raw * (far - near));
}

fn pixelToEye(screenCoord: vec2<f32>) -> vec3<f32> {
  let uv = screenCoord * vec2<f32>(uniforms.params1.y, uniforms.params1.z);
  let depth = readDepth(uv);
  let xy = 2.0 * uv - vec2<f32>(1.0);
  // Simplified eye-space reconstruction
  return vec3<f32>(xy * depth, -depth);
}

fn getNormal(posEC: vec3<f32>, coord: vec2<f32>) -> vec3<f32> {
  let texelSize = vec2<f32>(uniforms.params1.y, uniforms.params1.z);
  let posLeft  = pixelToEye(coord + vec2<f32>(-1.0, 0.0));
  let posRight = pixelToEye(coord + vec2<f32>( 1.0, 0.0));
  let posUp    = pixelToEye(coord + vec2<f32>( 0.0, 1.0));
  let posDown  = pixelToEye(coord + vec2<f32>( 0.0, -1.0));

  let dx = select(posRight - posEC, posEC - posLeft,
                  abs(posLeft.z - posEC.z) < abs(posRight.z - posEC.z));
  let dy = select(posUp - posEC, posEC - posDown,
                  abs(posDown.z - posEC.z) < abs(posUp.z - posEC.z));

  return normalize(cross(dx, dy));
}

@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  var output: VertexOutput;
  let x = f32(i32(vertexIndex & 1u) * 4 - 1);
  let y = f32(i32(vertexIndex >> 1u) * 4 - 1);
  output.position = vec4<f32>(x, y, 0.0, 1.0);
  output.uv = vec2<f32>((x + 1.0) * 0.5, (1.0 - y) * 0.5);
  return output;
}

const PI: f32 = 3.14159265359;

@fragment
fn fragmentMain(in: VertexOutput) -> @location(0) vec4<f32> {
  let intensity = uniforms.params0.x;
  let bias = uniforms.params0.y;
  let lengthCap = uniforms.params0.z;
  let stepCount = i32(uniforms.params0.w);
  let directionCount = i32(uniforms.params1.x);
  let texelSize = vec2<f32>(uniforms.params1.y, uniforms.params1.z);
  let randomTexSize = uniforms.params1.w;

  let screenCoord = in.uv / texelSize;
  let posEC = pixelToEye(screenCoord);
  let normalEC = getNormal(posEC, screenCoord);

  // Early exit for sky pixels
  if (posEC.z > -uniforms.frustum.x * 1.1) {
    return vec4<f32>(1.0);
  }

  // Fetch random rotation from tiled random texture
  let randomUV = fract(screenCoord / randomTexSize);
  let randomVal = textureSample(randomTexture, texSampler, randomUV).xy;

  var ao = 0.0;
  let stepLen = lengthCap / f32(stepCount);

  for (var d: i32 = 0; d < directionCount; d = d + 1) {
    if (d >= 8) { break; } // Safety clamp

    let angle = (f32(d) + randomVal.x) * PI / f32(directionCount);
    let dir2D = vec2<f32>(cos(angle), sin(angle));

    for (var s: i32 = 1; s <= stepCount; s = s + 1) {
      if (s > 16) { break; } // Safety clamp

      let sampleOffset = dir2D * (f32(s) * stepLen + randomVal.y);
      let sampleCoord = screenCoord + sampleOffset;
      let samplePos = pixelToEye(sampleCoord);

      let diff = samplePos - posEC;
      let dist = length(diff);
      let diffNorm = diff / max(dist, 0.0001);

      let cosAngle = dot(normalEC, diffNorm) - bias;
      let distFactor = 1.0 - clamp(dist / lengthCap, 0.0, 1.0);

      ao += max(cosAngle, 0.0) * distFactor;
    }
  }

  ao = ao / f32(directionCount * stepCount);
  ao = clamp(1.0 - ao * intensity, 0.0, 1.0);

  return vec4<f32>(ao, ao, ao, 1.0);
}
