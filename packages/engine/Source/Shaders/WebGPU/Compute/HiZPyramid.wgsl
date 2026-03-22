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
// Usage:
//   Mip 0 = full-resolution depth (input, not computed here)
//   Mip 1 = max of each 2×2 block from Mip 0
//   Mip 2 = max of each 2×2 block from Mip 1
//   ...
//   Mip N = single texel covering entire screen

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

// Shared memory for workgroup reduction (16×16 = 256 threads)
var<workgroup> sharedDepth: array<f32, 256>;

@compute @workgroup_size(16, 16, 1)
fn computeMain(
  @builtin(global_invocation_id) globalId: vec3<u32>,
  @builtin(local_invocation_id) localId: vec3<u32>,
  @builtin(local_invocation_index) localIndex: u32,
) {
  let outputCoord = vec2<i32>(globalId.xy);

  // Bounds check — output texel must be within mip dimensions
  if (outputCoord.x >= i32(params.outputWidth) ||
      outputCoord.y >= i32(params.outputHeight)) {
    return;
  }

  // Compute the 2×2 source region in the input mip
  let srcBase = outputCoord * 2;

  // Sample 4 texels from the input depth (or previous mip level)
  // Use textureLoad for exact texel access (no filtering)
  let mip = i32(params.mipLevel);

  let d00 = textureLoad(depthInput, srcBase + vec2<i32>(0, 0), mip).r;
  let d10 = textureLoad(depthInput, srcBase + vec2<i32>(1, 0), mip).r;
  let d01 = textureLoad(depthInput, srcBase + vec2<i32>(0, 1), mip).r;
  let d11 = textureLoad(depthInput, srcBase + vec2<i32>(1, 1), mip).r;

  // Max depth = conservative occlusion (anything behind this IS occluded)
  // WebGPU depth range is 0..1 (0 = near, 1 = far)
  let maxDepth = max(max(d00, d10), max(d01, d11));

  // Write to the output mip level
  textureStore(hiZOutput, outputCoord, vec4<f32>(maxDepth, 0.0, 0.0, 0.0));
}
