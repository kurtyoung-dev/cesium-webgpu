@group(0) @binding(0) var densitySnapshotSource: texture_3d<f32>;
@group(0) @binding(1) var densitySnapshotOutput: texture_storage_3d<rgba16float, write>;
@compute @workgroup_size(4, 4, 4)
fn copyDensitySnapshot(@builtin(global_invocation_id) id: vec3<u32>) {
  if (any(id >= textureDimensions(densitySnapshotOutput))) { return; }
  textureStore(densitySnapshotOutput, vec3<i32>(id), textureLoad(densitySnapshotSource, vec3<i32>(id), 0));
}
