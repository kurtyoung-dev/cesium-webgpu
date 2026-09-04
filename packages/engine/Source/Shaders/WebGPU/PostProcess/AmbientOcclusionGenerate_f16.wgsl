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
  // x = full-sample-pattern landing switch; yzw = padding
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

// Convert the sample radius the uniforms carry in eye-space metres into the
// per-step stride the march walks in screen pixels. This reconstruction places
// one pixel at `2 * texelWidth * depth` metres, so dividing the radius by that
// scale makes the whole march span the same eye-space reach at every depth —
// the falloff below then compares distances against the same metres value it
// was written for. Without the conversion the march covers `lengthCap` PIXELS,
// which collapses inside one texel wherever a pixel is wider than the cap. The
// one-pixel floor keeps consecutive samples off the centre's own texel, where
// the fetch returns no depth the march has not already read and the step
// vector carries no occlusion.
fn marchStepPixels(
  lengthCapMeters: f32,
  eyeDepth: f32,
  texelWidth: f32,
  stepDenominator: f32,
) -> f32 {
  let metersPerPixel = 2.0 * texelWidth * max(eyeDepth, 0.01);
  let radiusPixels = lengthCapMeters / metersPerPixel;
  return max(radiusPixels / max(stepDenominator, 1.0), 1.0);
}

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
  let fullSamplePattern = uniforms._pad.x > 0.5;
  // Keep this policy byte-for-byte parallel with the f32 HBAO variant.
  var executedDirectionCount = directionCount;
  var executedStepCount = stepCount;
  if (!fullSamplePattern) {
    executedDirectionCount = min(directionCount, 8);
    executedStepCount = min(stepCount, 16);
  }

  let stepLenDenominator = select(
    stepCount,
    executedStepCount,
    fullSamplePattern,
  );
  let stepLen = marchStepPixels(
    lengthCap,
    -posEC.z,
    texelSize.x,
    f32(stepLenDenominator),
  );

  // The stride above is a real pixel count, so a march that starts near a
  // frame edge can walk past it. The depth texture is read through the shared
  // post-process sampler, which declares no address mode and therefore clamps
  // to edge: an off-screen fetch returns the border texel's depth while
  // `pixelToEye` reconstructs the lateral position from the unclamped
  // coordinate, fabricating an occluder that the falloff still weights. Bound
  // the march the way the WebGL stage does.
  let viewportSize = vec2<f32>(1.0, 1.0) / texelSize;

  for (var d: i32 = 0; d < executedDirectionCount; d = d + 1) {
    let angle = (f32(d) + randomVal.x) * PI / f32(directionCount);
    let dir2D = vec2<f32>(cos(angle), sin(angle));

    for (var s: i32 = 1; s <= executedStepCount; s = s + 1) {
      let sampleOffset = dir2D * (f32(s) * stepLen + randomVal.y);
      let sampleCoord = screenCoord + sampleOffset;
      // Stop this direction once it steps off the screen; every later step
      // along it only goes further out.
      if (any(sampleCoord != clamp(sampleCoord, vec2<f32>(0.0), viewportSize))) {
        break;
      }
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

  let executedSampleCount = executedDirectionCount * executedStepCount;
  if (fullSamplePattern) {
    ao = f16(f32(ao) / f32(executedSampleCount));
  } else {
    ao = ao / f16(f32(directionCount * stepCount));
  }
  ao = clamp(1.0h - ao * f16(intensity), 0.0h, 1.0h);

  let aoF32 = f32(ao);
  return vec4<f32>(aoF32, aoF32, aoF32, 1.0);
}
