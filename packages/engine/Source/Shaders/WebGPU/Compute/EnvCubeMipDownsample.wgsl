// EnvCubeMipDownsample.wgsl — source env-cube mip-chain downsampler
//
// Item 1.3 (IBL-PREFILTER-HQ, Batch 426). The Karis/UE4 prefilter samples
// the SOURCE environment cube at a GGX-pdf-derived LOD instead of always
// mip 0, which requires the source cube to carry a real mip chain. The
// procedural sky fill only writes mip 0, so this compute pass box-averages
// each mip level from the previous one, one level per dispatch, across all
// 6 cube faces (array layers).
//
// Format-agnostic: the storage-texture format token defaults to rgba16float
// (the HDR-on env cube). The pipeline string-swaps it to rgba8unorm when the
// source cube is LDR (both formats are storage-write-capable in core
// WebGPU). Source mip is bound as a 2d-array sampled texture; dest mip as a
// 2d-array write-only storage texture.
//
// This pass only runs when `iblPrefilterQuality === 'high'`; the parity
// default never dispatches it (no source-mip pass), keeping the shipped
// pixels byte-identical.

struct Params {
  dstSize: u32,   // width=height of the destination mip level
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
};

@group(0) @binding(0) var srcTex: texture_2d_array<f32>;
@group(0) @binding(1) var srcSampler: sampler;
@group(0) @binding(2) var dstTex: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(3) var<uniform> params: Params;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let dstSize = params.dstSize;
  if (gid.x >= dstSize || gid.y >= dstSize || gid.z >= 6u) {
    return;
  }
  let layer = i32(gid.z);

  // 2×2 box average of the previous mip via a single bilinear tap at the
  // destination texel center (the linear sampler at the source mip level
  // averages the 4 contributing source texels). The source view is already
  // narrowed to one mip level, so LOD 0 here samples that level.
  let uv = (vec2<f32>(f32(gid.x), f32(gid.y)) + vec2<f32>(0.5)) / f32(dstSize);
  let c = textureSampleLevel(srcTex, srcSampler, uv, layer, 0.0);

  textureStore(dstTex, vec2<i32>(i32(gid.x), i32(gid.y)), layer, c);
}
