// AmbientOcclusionGenerate — Screen-space ambient occlusion (HBAO variant).
// Samples depth buffer in a hemisphere around each pixel to estimate occlusion.
// Based on the CesiumJS GLSL SSAO which uses horizon-based sampling with
// a random rotation per pixel to reduce banding.
//
// Phase 8a Slice 4 (Batch 87) — when `frustum.w > 0.5` (the
// `useGBufferNormal` flag set by the JS side when
// `scene.deferredLighting === true`), the shader reads the surface
// normal from the G-buffer at @binding(4) instead of reconstructing it
// from depth via central differences. Benefits:
//   - Silhouette edges produce clean normals (Slice 3 fix in the
//     producer eliminates the depth-discontinuity ring that the
//     central-difference path here used to inherit).
//   - One less function-of-five-depth-samples per fragment in the
//     `getNormal` path (the SSAO's `getNormal` was already doing the
//     same screen-space reconstruction the G-buffer producer now does
//     centrally — duplicate work).
//   - Consistent normal across all consumers (SSR, clustered lighting
//     in Slice 5 will read the same G-buffer).
// When the flag is 0 (default), the shader keeps its original depth-
// reconstruction path so non-deferred scenes are unchanged.

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

struct SSAOUniforms {
  // x = intensity, y = bias, z = lengthCap, w = stepCount
  params0: vec4<f32>,
  // x = directionCount, y = 1/width, z = 1/height, w = randomTexSize
  params1: vec4<f32>,
  // x = near, y = far, z = unused, w = useGBufferNormal flag (1.0 → on)
  frustum: vec4<f32>,
  // Padding for 16-byte alignment
  _pad: vec4<f32>,
};

@group(0) @binding(0) var depthTexture: texture_2d<f32>;
@group(0) @binding(1) var randomTexture: texture_2d<f32>;
@group(0) @binding(2) var texSampler: sampler;
@group(0) @binding(3) var<uniform> uniforms: SSAOUniforms;
// Phase 8a Slice 4 — G-buffer normal+roughness texture. Always bound
// (a 1×1 placeholder when the producer is off) so the bind-group
// layout stays stable across the flag's two states.
@group(0) @binding(4) var gBufferNormalTexture: texture_2d<f32>;

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
