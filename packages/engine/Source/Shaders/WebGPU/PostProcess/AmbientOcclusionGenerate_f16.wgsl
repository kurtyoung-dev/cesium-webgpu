// AmbientOcclusionGenerate — f16 variant.
// Hand-tuned half-precision version of `AmbientOcclusionGenerate.wgsl`.
// Selected when `context.useShaderF16` is true. Keep in sync with the
// f32 reference.
//
// f16 policy — DELIBERATELY CONSERVATIVE. This pass is dominated by
// eye-space position reconstruction, depth linearization (near*far/(...)
// with far up to ~1e7), and normal cross-products — ALL precision-
// critical. Doing that geometry in f16 would visibly change the AO term
// (banding, wrong horizon angles). So the geometry stays F32 and matches
// the f32 reference bit-for-bit; only the final scalar `ao` accumulation
// + clamp is narrowed to f16. The net output is therefore within a tiny
// tolerance of the f32 variant by construction. The file exists so the
// f16-enabled pipeline has a variant for every stage (uniform selection
// path), even though this particular stage gains no precision headroom
// from f16.

enable f16;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

struct SSAOUniforms {
  params0: vec4<f32>,
  params1: vec4<f32>,
  frustum: vec4<f32>,
  _pad: vec4<f32>,
};

@group(0) @binding(0) var depthTexture: texture_2d<f32>;
@group(0) @binding(1) var randomTexture: texture_2d<f32>;
@group(0) @binding(2) var texSampler: sampler;
@group(0) @binding(3) var<uniform> uniforms: SSAOUniforms;
@group(0) @binding(4) var gBufferNormalTexture: texture_2d<f32>;

// Reverse a logarithmic depth sample to hyperbolic
// window depth [0,1]. Kept in f32 (log2/exp2 overflow f16). Only invoked when
// the renderer-wide log-depth flag is set (frustum.z >= 0.5).
fn logDepthReverse(logZ: f32, near: f32, far: f32) -> f32 {
  if (far <= near) { return logZ; }
  let log2FarDepthFromNearPlusOne = log2((far - near) + 1.0);
  let depthFromNear = exp2(logZ * log2FarDepthFromNearPlusOne) - 1.0;
  let depthFromCamera = depthFromNear + near;
  return far * (1.0 - near / depthFromCamera) / (far - near);
}

fn readDepth(uv: vec2<f32>) -> f32 {
  let raw = textureSampleLevel(depthTexture, texSampler, uv, 0.0).r;
  let near = uniforms.frustum.x;
  let far = uniforms.frustum.y;
  // Reverse log depth before linearizing when active.
  var d = raw;
  if (uniforms.frustum.z > 0.5) {
    d = logDepthReverse(raw, near, far);
  }
  return near * far / (far - d * (far - near));
}

fn pixelToEye(screenCoord: vec2<f32>) -> vec3<f32> {
  let uv = screenCoord * vec2<f32>(uniforms.params1.y, uniforms.params1.z);
  let depth = readDepth(uv);
  let xy = 2.0 * uv - vec2<f32>(1.0);
  return vec3<f32>(xy * depth, -depth);
}

fn getNormal(posEC: vec3<f32>, coord: vec2<f32>) -> vec3<f32> {
  if (uniforms.frustum.w > 0.5) {
    let texelSize = vec2<f32>(uniforms.params1.y, uniforms.params1.z);
    let uv = coord * texelSize;
    let nSample = textureSampleLevel(
      gBufferNormalTexture, texSampler, uv, 0.0,
    );
    let lenSq = dot(nSample.xyz, nSample.xyz);
    if (lenSq > 0.01) {
      return normalize(nSample.xyz);
    }
  }

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

  if (posEC.z > -uniforms.frustum.x * 1.1) {
    return vec4<f32>(1.0);
  }

  let randomUV = fract(screenCoord / randomTexSize);
  let randomVal =
    textureSampleLevel(randomTexture, texSampler, randomUV, 0.0).xy;

  // AO accumulation narrowed to f16 (bounded sum of [0,1] contributions).
  var ao: f16 = 0.0h;
  let stepLen = lengthCap / f32(stepCount);

  for (var d: i32 = 0; d < directionCount; d = d + 1) {
    if (d >= 8) { break; }

    let angle = (f32(d) + randomVal.x) * PI / f32(directionCount);
    let dir2D = vec2<f32>(cos(angle), sin(angle));

    for (var s: i32 = 1; s <= stepCount; s = s + 1) {
      if (s > 16) { break; }

      let sampleOffset = dir2D * (f32(s) * stepLen + randomVal.y);
      let sampleCoord = screenCoord + sampleOffset;
      let samplePos = pixelToEye(sampleCoord);

      // Geometry math in F32.
      let diff = samplePos - posEC;
      let dist = length(diff);
      let diffNorm = diff / max(dist, 0.0001);

      let cosAngle = dot(normalEC, diffNorm) - bias;
      let distFactor = 1.0 - clamp(dist / lengthCap, 0.0, 1.0);

      ao += f16(max(cosAngle, 0.0) * distFactor);
    }
  }

  ao = ao / f16(f32(directionCount * stepCount));
  ao = clamp(1.0h - ao * f16(intensity), 0.0h, 1.0h);

  let aoF32 = f32(ao);
  return vec4<f32>(aoF32, aoF32, aoF32, 1.0);
}
