/**
 * Voxel ray marching for volume rendering.
 * Port of Octree.glsl + Megatexture.glsl + VoxelFS.glsl concepts.
 */

struct VoxelRayMarchUniforms {
    modelViewProjection: mat4x4<f32>,
    inverseModelView: mat4x4<f32>,
    cameraPositionMC: vec3<f32>,
    stepCount: f32,
    volumeMin: vec3<f32>,
    volumeDensity: f32,
    volumeMax: vec3<f32>,
    _pad: f32,
};

@group(0) @binding(0) var<uniform> voxelUniforms: VoxelRayMarchUniforms;
@group(0) @binding(1) var volumeTexture: texture_3d<f32>;
@group(0) @binding(2) var volumeSampler: sampler;

fn csm_sampleVoxelDensity(uvw: vec3<f32>) -> f32 {
    return textureSampleLevel(volumeTexture, volumeSampler, uvw, 0.0).r;
}

fn csm_voxelRayMarch(
    rayOrigin: vec3<f32>,
    rayDir: vec3<f32>,
    tNear: f32,
    tFar: f32,
    stepCount: i32,
    densityScale: f32,
    volumeMin: vec3<f32>,
    volumeMax: vec3<f32>
) -> vec4<f32> {
    let stepSize: f32 = (tFar - tNear) / f32(stepCount);
    var accColor: vec3<f32> = vec3<f32>(0.0);
    var accAlpha: f32 = 0.0;

    for (var i: i32 = 0; i < stepCount; i = i + 1) {
        if (accAlpha >= 0.99) { break; }
        let t: f32 = tNear + (f32(i) + 0.5) * stepSize;
        let samplePos: vec3<f32> = rayOrigin + rayDir * t;
        let uvw: vec3<f32> = (samplePos - volumeMin) / (volumeMax - volumeMin);

        if (all(uvw >= vec3<f32>(0.0)) && all(uvw <= vec3<f32>(1.0))) {
            let density: f32 = csm_sampleVoxelDensity(uvw) * densityScale;
            let sampleAlpha: f32 = 1.0 - exp(-density * stepSize);
            let sampleColor: vec3<f32> = vec3<f32>(density); // Transfer function
            accColor += sampleColor * sampleAlpha * (1.0 - accAlpha);
            accAlpha += sampleAlpha * (1.0 - accAlpha);
        }
    }

    return vec4<f32>(accColor, accAlpha);
}
