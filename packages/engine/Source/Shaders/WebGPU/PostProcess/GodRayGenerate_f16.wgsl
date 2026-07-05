// GodRayGenerate — f16 variant (PARITY-F16-POSTPROCESS). Hand-tuned
// half-precision version of `GodRayGenerate.wgsl`. Selected when
// `context.useShaderF16` is true. Keep in sync with the f32 reference.
//
// f16 policy: the ray-march STEP (accumulated `stepUV` toward the sun)
// and depth linearization stay in F32 — the marched UV is precision-
// sensitive (an f16 UV drifts across up to 128 steps and smears the
// shaft) and depth linearization overflows f16. The per-sample DECAY
// factor also stays F32 (it's a running product over up to 128 steps;
// f16 rounding would compound). Only the accumulated illumination COLOR
// is f16 — bounded because each contribution is `sample(SDR) * weight *
// decay` with weight/decay <= 1.

enable f16;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

struct GodRayUniforms {
  params0: vec4<f32>,
  params1: vec4<f32>,
  frustum: vec4<f32>,
};

@group(0) @binding(0) var sceneColorTex: texture_2d<f32>;
@group(0) @binding(1) var sceneDepthTex: texture_2d<f32>;
@group(0) @binding(2) var texSampler: sampler;
@group(0) @binding(3) var<uniform> uniforms: GodRayUniforms;
// TAKRAM-9 (cloud-aware god rays) — see GodRayGenerate.wgsl. 1×1 white
// (r8unorm) fallback → exactly 1.0 → byte-identical to the depth-only path.
@group(0) @binding(4) var cloudTransTex: texture_2d<f32>;

const F16_MAX_HDR: f32 = 65000.0;

@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  var out: VertexOutput;
  let x = f32(i32(vertexIndex & 1u) * 4 - 1);
  let y = f32(i32(vertexIndex >> 1u) * 4 - 1);
  out.position = vec4<f32>(x, y, 0.0, 1.0);
  out.uv = vec2<f32>((x + 1.0) * 0.5, (1.0 - y) * 0.5);
  return out;
}

fn linearizeDepth(raw: f32) -> f32 {
  let near = uniforms.frustum.x;
  let far = uniforms.frustum.y;
  return near * far / (far - raw * (far - near));
}

@fragment
fn fragmentMain(in: VertexOutput) -> @location(0) vec4<f32> {
  let sunUV = uniforms.params0.xy;
  let density = uniforms.params0.z;
  let decay = uniforms.params0.w;
  let weight = uniforms.params1.x;
  let exposure = uniforms.params1.y;
  let sampleCount = i32(clamp(uniforms.params1.z, 1.0, 128.0));
  let occlusionCutoff = uniforms.params1.w;
  let far = uniforms.frustum.y;

  // UV march + decay in F32 (precision-sensitive over up to 128 steps).
  let deltaUV = (sunUV - in.uv) * (density / f32(sampleCount));

  var stepUV = in.uv;
  var illumination: vec3<f16> = vec3<f16>(0.0h);
  var illumDecay: f32 = 1.0;

  for (var i = 0; i < sampleCount; i = i + 1) {
    stepUV = stepUV + deltaUV;
    let rawDepth = textureSampleLevel(
      sceneDepthTex, texSampler, stepUV, 0.0,
    ).r;
    let linearDepth = linearizeDepth(rawDepth);
    let isSky = step(far * occlusionCutoff, linearDepth);
    // Cloud transmittance gate (white fallback = 1.0 → byte-identical).
    let cloudTrans = textureSampleLevel(
      cloudTransTex, texSampler, stepUV, 0.0,
    ).r;
    let sample32 = clamp(
      textureSampleLevel(sceneColorTex, texSampler, stepUV, 0.0).rgb
        * isSky * cloudTrans,
      vec3<f32>(0.0), vec3<f32>(F16_MAX_HDR),
    );
    // Color accumulation in F16; the per-sample scale (weight*decay) is
    // computed in F32 then narrowed.
    illumination = illumination + vec3<f16>(sample32) * f16(weight * illumDecay);
    illumDecay = illumDecay * decay;
  }

  let outColor = vec3<f32>(illumination) * exposure;
  return vec4<f32>(outColor, 1.0);
}
