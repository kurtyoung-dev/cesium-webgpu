// EnvCubeTemporalBlend.wgsl — dynamic environment-cube temporal accumulation
//
// C2-25 item 3-B (ENV-TEMPORAL, Batch 449). Sits BETWEEN the env-cube
// capture (procedural sky fill → optional scene-capture composite) and the
// IBL mip/prefilter + SH projection, ONLY when
// `contextOptions.webgpu.envMapTemporalAccumulation` is true. Default-off the
// pass never runs (no history cube allocated) → byte-identical to the shipped
// single-frame debounced refresh.
//
// Mechanism (shares the exponential-blend pattern with the cloud temporal
// resolve `CloudTemporalResolve.wgsl` and the froxel-fog temporal pass): each
// of the 6 cube faces is an array layer. For every texel,
//
//     out = mix(history, current, alpha)
//
// where `alpha` is the per-frame fraction of the freshly-captured cube folded
// in (an exponential moving average; history keeps 1-alpha). Holding the sun +
// camera still, the cube converges to the deterministic capture — so a static
// scene's accumulated cube matches the single-frame OFF cube (the EMA fixed
// point of a constant signal is that constant). Under a small sun/camera drift
// the blend crossfades smoothly (no popping between debounced refreshes).
//
// HISTORY INVALIDATION: on a LARGE sun or camera delta the JS side passes
// `alpha = 1.0` (the `resetHistory` flag), so the cube snaps to the current
// capture with NO history contribution — the env map can't smear across a big
// change. The JS gate reuses the same `SUN_REFRESH_EPSILON_SQ` / capture
// camera-delta machinery the refresh already tracks.
//
// PER-FACE JITTER: a frame-indexed Hammersley rotation (`jitter.xy`) is fed in
// as a sub-texel UV offset when sampling the current capture. For the present
// largely-deterministic sky+globe capture the jitter is intentionally subtle
// (it averages out to the same converged value); it exists so the FUTURE
// clouds-in-IBL consumer (3-C) — which adds a stochastic per-face raymarch —
// accumulates a clean low-variance result instead of a noisy single sample.
//
// The current + history cubes share format/size. `currentTex` and
// `historyTex` are bound as 2d-array SAMPLED textures (read); `outTex` is the
// destination 2d-array STORAGE texture (the cube being accumulated). The JS
// ping-pongs: this pass writes the blended result into the cube AND the JS
// copies the cube into history for the next frame (a copyTexture). The
// storage-format token defaults to rgba16float (HDR env cube) and is
// string-swapped to rgba8unorm for the LDR parity cube — exactly as
// `EnvCubeMipDownsample.wgsl` does.

struct BlendParams {
  // x = alpha (per-frame blend fraction; 1.0 on a history reset → current only).
  // y = faceSize (texels per face edge), for the sub-texel jitter UV step.
  // z,w = unused (reserved).
  alphaAndSize: vec4<f32>,
  // xy = per-face Hammersley-rotated sub-texel jitter offset in [-0.5,0.5]
  // texels (applied to the current sample's UV). zw reserved.
  jitter: vec4<f32>,
};

@group(0) @binding(0) var currentTex: texture_2d_array<f32>;
@group(0) @binding(1) var historyTex: texture_2d_array<f32>;
@group(0) @binding(2) var linearSampler: sampler;
@group(0) @binding(3) var outTex: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(4) var<uniform> params: BlendParams;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let faceSize = u32(params.alphaAndSize.y);
  if (gid.x >= faceSize || gid.y >= faceSize || gid.z >= 6u) {
    return;
  }
  let layer = i32(gid.z);
  let coord = vec2<i32>(i32(gid.x), i32(gid.y));

  // Current freshly-captured sample, jittered by a sub-texel Hammersley offset
  // so the deterministic capture is sampled at slightly different points each
  // frame (matters for the future stochastic cloud consumer; for the smooth
  // sky+globe capture it averages to the same value). Texel center + jitter,
  // converted to UV; clamp sampler keeps edges in range.
  let texel = 1.0 / max(params.alphaAndSize.y, 1.0);
  let baseUV = (vec2<f32>(f32(gid.x), f32(gid.y)) + vec2<f32>(0.5)) * texel;
  let jitterUV = params.jitter.xy * texel;
  let current = textureSampleLevel(
    currentTex, linearSampler, baseUV + jitterUV, layer, 0.0);

  // History sample at the exact texel (no reprojection — the cube is in a
  // planet-local frame and the per-texel direction is frame-stable; the sun /
  // camera deltas that WOULD invalidate reprojection are handled by the JS
  // alpha=1 reset, not a neighborhood clamp).
  let history = textureLoad(historyTex, coord, layer, 0);

  // Exponential moving average. alpha=1 (history reset) → pure current.
  let alpha = clamp(params.alphaAndSize.x, 0.0, 1.0);
  let result = mix(history, current, alpha);

  textureStore(outTex, coord, layer, result);
}
