// Campaign 13 C13-37 Slice B — 3D cloud-noise mip downsample.
//
// Each dispatch reads one explicit source mip view and writes the next explicit
// destination mip view. One destination voxel is the normalized box average of
// its 2x2x2 source neighborhood. Cloud-noise resources are power-of-two cubes,
// but the source-coordinate clamp keeps the kernel valid for a 1-wide axis and
// makes the shader safe for any legal explicit views.
//
// No sampler or uniform is needed. The source and destination dimensions come
// from their one-level views, keeping every mip pass self-describing.

@group(0) @binding(0) var sourceMip: texture_3d<f32>;
@group(0) @binding(1) var destinationMip:
  texture_storage_3d<rgba8unorm, write>;

@compute @workgroup_size(4, 4, 4)
fn downsampleCloudNoiseMip(
  @builtin(global_invocation_id) gid: vec3<u32>,
) {
  let destinationDimensions = textureDimensions(destinationMip);
  if (any(gid >= destinationDimensions)) {
    return;
  }

  let sourceDimensions = textureDimensions(sourceMip);
  let sourceLimit = sourceDimensions - vec3<u32>(1u);
  let sourceBase = gid * 2u;
  var sum = vec4<f32>(0.0);

  for (var z = 0u; z < 2u; z = z + 1u) {
    for (var y = 0u; y < 2u; y = y + 1u) {
      for (var x = 0u; x < 2u; x = x + 1u) {
        let sourceCoordinate = min(
          sourceBase + vec3<u32>(x, y, z),
          sourceLimit,
        );
        sum = sum + textureLoad(
          sourceMip,
          vec3<i32>(sourceCoordinate),
          0,
        );
      }
    }
  }

  textureStore(
    destinationMip,
    vec3<i32>(gid),
    sum * (1.0 / 8.0),
  );
}
