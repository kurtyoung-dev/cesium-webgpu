// HiZPyramidFromDepth.wgsl — Mip 0 builder that reads the native depth buffer
//
// Identical to the r32float path in HiZPyramid.wgsl except binding 0 is
// texture_depth_2d (sampleType "depth" in the bind group layout). This
// avoids a full-resolution depth-to-r32float copy — mip 0 of the Hi-Z
// pyramid is built directly from the scene depth attachment.

@group(0) @binding(0) var depthInput: texture_depth_2d;
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

  // textureLoad on texture_depth_2d returns f32 directly (not vec4).
  let d00 = textureLoad(depthInput, srcBase + vec2<i32>(0, 0), 0);
  let d10 = textureLoad(depthInput, srcBase + vec2<i32>(1, 0), 0);
  let d01 = textureLoad(depthInput, srcBase + vec2<i32>(0, 1), 0);
  let d11 = textureLoad(depthInput, srcBase + vec2<i32>(1, 1), 0);

  let maxDepth = max(max(d00, d10), max(d01, d11));
  textureStore(hiZOutput, outputCoord, vec4<f32>(maxDepth, 0.0, 0.0, 0.0));
}
