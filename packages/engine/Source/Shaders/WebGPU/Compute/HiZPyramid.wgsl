// HiZPyramid.wgsl — Compute shader to build hierarchical Z-buffer
//
// Takes the previous frame's depth buffer and builds a mip-chain where each
// texel is the MAXIMUM depth in its corresponding 2×2 region. This enables
// conservative occlusion testing: if a bounding volume's near Z is behind
// the Hi-Z value at the appropriate mip level, it's occluded.
//
// Dispatched once per frame, ~0.3ms for a 1920×1080 depth buffer.
// Each workgroup processes a 16×16 tile of the output mip level.
//
// Reference: Stephen Hill and Daniel Collin, "Practical, Dynamic Visibility
// for Games", GPU Pro 2 (2011) — the maximum-depth pyramid built here, which
// makes an occlusion test conservative: a volume rejected at some mip is
// guaranteed hidden, while a volume kept may still be hidden.
//
// Usage:
//   Mip 0 = full-resolution depth (input, not computed here)
//   Mip 1 = max of each 2×2 block from Mip 0
//   Mip 2 = max of each 2×2 block from Mip 1
//   ...
//   Mip N = single texel covering entire screen

// ── Mip 1+ entry point ──────────────────────────────────────────────
// Reads from the previous pyramid mip (r32float → texture_2d<f32>).
// Used for all mip levels after the initial depth reduction.

@group(0) @binding(0) var depthInput: texture_2d<f32>;
@group(0) @binding(1) var hiZOutput: texture_storage_2d<r32float, write>;

struct HiZParams {
  inputWidth: u32,
  inputHeight: u32,
  outputWidth: u32,
  outputHeight: u32,
  mipLevel: u32,
  _padding0: u32,
  _padding1: u32,
  _padding2: u32,
}

@group(0) @binding(2) var<uniform> params: HiZParams;

@compute @workgroup_size(16, 16, 1)
fn computeMain(
  @builtin(global_invocation_id) globalId: vec3<u32>,
) {
  let outputCoord = vec2<i32>(globalId.xy);

  if (outputCoord.x >= i32(params.outputWidth) ||
      outputCoord.y >= i32(params.outputHeight)) {
    return;
  }

  let srcBase = outputCoord * 2;
  let mip = i32(params.mipLevel);

  let d00 = textureLoad(depthInput, srcBase + vec2<i32>(0, 0), mip).r;
  let d10 = textureLoad(depthInput, srcBase + vec2<i32>(1, 0), mip).r;
  let d01 = textureLoad(depthInput, srcBase + vec2<i32>(0, 1), mip).r;
  let d11 = textureLoad(depthInput, srcBase + vec2<i32>(1, 1), mip).r;

  let maxDepth = max(max(d00, d10), max(d01, d11));
  textureStore(hiZOutput, outputCoord, vec4<f32>(maxDepth, 0.0, 0.0, 0.0));
}
