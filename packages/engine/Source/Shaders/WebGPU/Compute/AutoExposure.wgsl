// AutoExposure.wgsl — Parallel luminance reduction for HDR tone mapping.
//
// Two-pass compute shader that replaces WebGL's multi-pass framebuffer
// reduction (AutoExposure.js). Pass 1 reduces every 16×16 tile to a
// single luminance value via shared-memory reduction. Pass 2 reduces
// all tile values to one final scalar and applies temporal smoothing
// against the previous frame's result.
//
// Output: a single f32 in `result[0]` that the tonemapping stage reads
// as the scene's average luminance for adaptive exposure.

struct Params {
  width: u32,
  height: u32,
  tileCountX: u32,
  tileCountY: u32,
  minLuminance: f32,
  maxLuminance: f32,
  adaptationRate: f32, // 1 / (fps × seconds), e.g. 1/(60×1.5) ≈ 0.011
  _pad: f32,
};

@group(0) @binding(0) var inputTexture: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> intermediate: array<f32>;
@group(0) @binding(2) var<storage, read_write> result: array<f32>;
@group(0) @binding(3) var<uniform> params: Params;

// Renamed from `shared` to `tileLumens` because `shared` is a reserved
// keyword in newer WGSL drafts (Naga / Tint enforce this — Edge's
// shader compiler rejects the variable name with a parse error). The
// allocation + access pattern is identical; this is a pure rename.
var<workgroup> tileLumens: array<f32, 256>;

fn luminance(color: vec3<f32>) -> f32 {
  return dot(color, vec3<f32>(0.2126, 0.7152, 0.0722));
}

// Pass 1: each 16×16 workgroup reduces its tile to one luminance value.
// Dispatch: ceil(width/16) × ceil(height/16) × 1
@compute @workgroup_size(16, 16, 1)
fn pass1(
  @builtin(global_invocation_id) gid: vec3<u32>,
  @builtin(local_invocation_index) lid: u32,
  @builtin(workgroup_id) wgid: vec3<u32>,
) {
  var lum: f32 = 0.0;
  if (gid.x < params.width && gid.y < params.height) {
    let color = textureLoad(inputTexture, vec2<i32>(i32(gid.x), i32(gid.y)), 0).rgb;
    lum = luminance(max(color, vec3<f32>(0.0)));
  }
  tileLumens[lid] = lum;
  workgroupBarrier();

  // Tree reduction in shared memory (256 → 1)
  for (var stride: u32 = 128u; stride > 0u; stride >>= 1u) {
    if (lid < stride) {
      tileLumens[lid] += tileLumens[lid + stride];
    }
    workgroupBarrier();
  }

  if (lid == 0u) {
    // Average over the tile (count valid pixels, not always 256)
    let tileW = min(16u, params.width - wgid.x * 16u);
    let tileH = min(16u, params.height - wgid.y * 16u);
    let count = f32(tileW * tileH);
    let tileIndex = wgid.y * params.tileCountX + wgid.x;
    intermediate[tileIndex] = tileLumens[0] / max(count, 1.0);
  }
}

// Pass 2: single workgroup reduces all tile values to one scalar.
// Dispatch: 1 × 1 × 1
@compute @workgroup_size(256, 1, 1)
fn pass2(
  @builtin(local_invocation_index) lid: u32,
) {
  let totalTiles = params.tileCountX * params.tileCountY;

  // Each thread sums a strided range of tiles
  var sum: f32 = 0.0;
  var idx = lid;
  while (idx < totalTiles) {
    sum += intermediate[idx];
    idx += 256u;
  }
  tileLumens[lid] = sum;
  workgroupBarrier();

  // Tree reduction (256 → 1)
  for (var stride: u32 = 128u; stride > 0u; stride >>= 1u) {
    if (lid < stride) {
      tileLumens[lid] += tileLumens[lid + stride];
    }
    workgroupBarrier();
  }

  if (lid == 0u) {
    let avgLuminance = tileLumens[0] / f32(max(totalTiles, 1u));

    // Temporal smoothing: exponential moving average with the previous
    // frame's result. Matches WebGL's `previous + (current - previous)
    // / (60 * 1.5)` formula.
    let previous = result[0];
    var smoothed = previous + (avgLuminance - previous) * params.adaptationRate;
    smoothed = clamp(smoothed, params.minLuminance, params.maxLuminance);
    result[0] = smoothed;
  }
}
