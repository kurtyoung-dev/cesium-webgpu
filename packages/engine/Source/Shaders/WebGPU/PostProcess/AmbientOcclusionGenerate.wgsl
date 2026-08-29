// AmbientOcclusionGenerate — Screen-space ambient occlusion (HBAO variant).
// Samples depth buffer in a hemisphere around each pixel to estimate occlusion.
// Based on the CesiumJS GLSL SSAO which uses horizon-based sampling with
// a random rotation per pixel to reduce banding.
//
// When `frustum.w > 0.5` — the `useGBufferNormal` flag the JS side sets while
// `scene.deferredLighting === true` — the shader reads the surface normal
// from the G-buffer at `@binding(4)` rather than reconstructing it from depth
// by central differences. That gives clean normals at silhouette edges, where
// the central-difference path inherits the producer's depth-discontinuity
// ring; drops a five-depth-sample reconstruction per fragment that duplicates
// what the G-buffer producer already did centrally; and keeps the normal
// consistent across every consumer, since SSR and clustered lighting read the
// same G-buffer. With the flag at 0, the default, the depth-reconstruction
// path runs and non-deferred scenes are unchanged.

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

struct SSAOUniforms {
  // x = intensity, y = bias, z = lengthCap, w = stepCount
  params0: vec4<f32>,
  // x = directionCount, y = 1/width, z = 1/height, w = randomTexSize
  params1: vec4<f32>,
  // x = near, y = far, z = logActive, w = useGBufferNormal flag (1.0 → on)
  frustum: vec4<f32>,
  // x = full-sample-pattern landing switch; yzw = padding
  _pad: vec4<f32>,
};

@group(0) @binding(0) var depthTexture: texture_2d<f32>;
@group(0) @binding(1) var randomTexture: texture_2d<f32>;
@group(0) @binding(2) var texSampler: sampler;
@group(0) @binding(3) var<uniform> uniforms: SSAOUniforms;
// The G-buffer normal+roughness texture is always bound
// (a 1×1 placeholder when the producer is off) so the bind-group
// layout stays stable across the flag's two states.
@group(0) @binding(4) var gBufferNormalTexture: texture_2d<f32>;

// Reverse a logarithmic depth sample to hyperbolic
// window depth [0,1]. Byte-compatible with csm_reverseLogDepth.wgsl / WebGL
// czm_reverseLogDepth. Only invoked when the renderer-wide log-depth flag is
// set (frustum.z >= 0.5); the non-log path never calls this.
fn logDepthReverse(logZ: f32, near: f32, far: f32) -> f32 {
  if (far <= near) { return logZ; }
  let log2FarDepthFromNearPlusOne = log2((far - near) + 1.0);
  let depthFromNear = exp2(logZ * log2FarDepthFromNearPlusOne) - 1.0;
  let depthFromCamera = depthFromNear + near;
  return far * (1.0 - near / depthFromCamera) / (far - near);
}

// Reconstructs inverse projection from viewport to simplified reconstruction
// For WebGPU, we pass frustum params directly
fn readDepth(uv: vec2<f32>) -> f32 {
  // `textureSampleLevel`: this function is called from the SSAO sample
  // loop which is inside non-uniform control flow (loop bounds, sky
  // early-exit). `textureSample` requires uniform control flow because
  // it computes implicit derivatives across the fragment quad. Explicit
  // level 0 avoids the derivative requirement and validates from any
  // call site. The depth texture has a single mip; this is byte-
  // equivalent to the implicit-LOD form.
  let raw = textureSampleLevel(depthTexture, texSampler, uv, 0.0).r;
  // Linearize depth from [0,1] to eye-space Z
  let near = uniforms.frustum.x;
  let far = uniforms.frustum.y;
  // When renderer-wide log depth is active the depth
  // attachment holds a logarithmic value; reverse it before linearizing to
  // match WebGL czm_readDepth → czm_reverseLogDepth. logActive=0 (frustum.z)
  // leaves the non-log linearization path unchanged.
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
  // Simplified eye-space reconstruction
  return vec3<f32>(xy * depth, -depth);
}

fn getNormal(posEC: vec3<f32>, coord: vec2<f32>) -> vec3<f32> {
  // Phase 8a Slice 4 fast-path: read from G-buffer when available.
  // `frustum.w > 0.5` means the JS-side has bound a real G-buffer view
  // (the producer compute pass populated it this frame). The
  // producer's silhouette-aware reconstruction (Slice 3) produces
  // cleaner normals than the depth-only central-difference fallback
  // below, especially at object edges.
  //
  // The G-buffer .xyz is eye-space normal; .w is roughness (unused
  // here — AO doesn't care about roughness). The producer emits a
  // (0,0,0,1) sentinel for sky/discontinuity pixels; we fall back to
  // depth reconstruction at those.
  if (uniforms.frustum.w > 0.5) {
    let texelSize = vec2<f32>(uniforms.params1.y, uniforms.params1.z);
    let uv = coord * texelSize;
    let nSample = textureSampleLevel(
      gBufferNormalTexture, texSampler, uv, 0.0,
    );
    // Sentinel check: producer emits (0,0,0,*) for sky/depth-clear and
    // for high-gradient samples it couldn't safely reconstruct. Fall
    // back to depth reconstruction in those cases — they're rare and
    // the SSAO doesn't sample many of them.
    let lenSq = dot(nSample.xyz, nSample.xyz);
    if (lenSq > 0.01) {
      return normalize(nSample.xyz);
    }
  }

  // Depth-reconstruction fallback (original path). Used when the
  // G-buffer producer is off OR when the producer emitted a sentinel
  // at this pixel.
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

  // Fetch random rotation from tiled random texture.
  //
  // `textureSampleLevel` (not `textureSample`): WGSL forbids `textureSample`
  // from non-uniform control flow because it computes derivatives across
  // the fragment quad. The sky-pixel early-exit above is non-uniform, so
  // the validator rejects the implicit-LOD form. The random rotation
  // texture has a single mip and we don't need derivatives — explicit
  // level 0 is byte-equivalent and validates from any control-flow state.
  let randomUV = fract(screenCoord / randomTexSize);
  let randomVal =
    textureSampleLevel(randomTexture, texSampler, randomUV, 0.0).xy;

  var ao = 0.0;
  let fullSamplePattern = uniforms._pad.x > 0.5;
  // The false branch preserves the historical 8-direction/16-step caps.
  // The true branch leaves both uniform counts unbounded, matching WebGL2.
  var executedDirectionCount = directionCount;
  var executedStepCount = stepCount;
  if (!fullSamplePattern) {
    executedDirectionCount = min(directionCount, 8);
    executedStepCount = min(stepCount, 16);
  }

  // Legacy used the uniform step count even when its loop was capped. Full
  // mode divides the radius by the count the loop actually executes.
  let stepLenDenominator = select(
    stepCount,
    executedStepCount,
    fullSamplePattern,
  );
  let stepLen = lengthCap / f32(stepLenDenominator);

  for (var d: i32 = 0; d < executedDirectionCount; d = d + 1) {
    let angle = (f32(d) + randomVal.x) * PI / f32(directionCount);
    let dir2D = vec2<f32>(cos(angle), sin(angle));

    for (var s: i32 = 1; s <= executedStepCount; s = s + 1) {
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

  let executedSampleCount = executedDirectionCount * executedStepCount;
  if (fullSamplePattern) {
    ao = ao / f32(executedSampleCount);
  } else {
    ao = ao / f32(directionCount * stepCount);
  }
  ao = clamp(1.0 - ao * intensity, 0.0, 1.0);

  return vec4<f32>(ao, ao, ao, 1.0);
}
