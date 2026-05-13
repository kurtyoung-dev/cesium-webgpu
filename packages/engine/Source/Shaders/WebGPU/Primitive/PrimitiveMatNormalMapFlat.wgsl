// PrimitiveMatNormalMapFlat.wgsl
// Normal map material, no lighting
// Normal mapping requires lighting to be visible — flat variant shows
// the normal map as a colorized visualization
// Uses RTE (Relative-To-Eye) for 64-bit precision at planetary scale
// Vertex: posHigh(3) + posLow(3) + st(2) = 8 floats = 32 bytes
// Matches CesiumJS Material.NormalMapType: image, channels, strength, repeat

struct VertexInput {
    @location(0) positionHigh: vec3<f32>,
    @location(1) positionLow: vec3<f32>,
    @location(2) texCoord: vec2<f32>,
}

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) texCoord: vec2<f32>,
}

struct CameraUniforms {
    mvpRelativeToEye: mat4x4<f32>,
    encodedCameraHigh: vec3<f32>,
    _pad0: f32,
    encodedCameraLow: vec3<f32>,
    _pad1: f32,
    // DP-H41 (Batch 27) — previous frame's viewProjection for
    // TAA / motion-vector reprojection. Sourced from
    // `UniformState._previousViewProjection` (f32 mat4).
    previousViewProjection: mat4x4<f32>,
}

// Material.NormalMapType fabric: { image: str, channels: "rgb", strength: f32, repeat: Cart2 }.
// `channels` packs as vec3<f32> indices (r=0, g=1, b=2, a=3) so the
// shader can swizzle at runtime. Fabric order: channels, strength, repeat.
struct MaterialUniforms {
    channels: vec3<f32>,
    strength: f32,
    repeat: vec2<f32>,
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var<uniform> material: MaterialUniforms;
@group(2) @binding(0) var textureSampler: sampler;
// DP-H20 (Batch 25) — dual texture bind group matching the Lit variant.
// Flat NormalMap uses only the normal map (binding 2) for its color
// visualization — the diffuse texture at binding 1 is unused here but
// the BGL is shared with other materials so the declaration stays.
@group(2) @binding(1) var diffuseTexture: texture_2d<f32>;
@group(2) @binding(2) var normalMapTexture: texture_2d<f32>;

fn translateRelativeToEye(high: vec3<f32>, low: vec3<f32>) -> vec4<f32> {
    var highDiff = high - camera.encodedCameraHigh;
    if (length(highDiff) == 0.0) { highDiff = vec3<f32>(0.0); }
    let lowDiff = low - camera.encodedCameraLow;
    return vec4<f32>(highDiff + lowDiff, 1.0);
}

fn swizzleChannel(c: vec4<f32>, idx: f32) -> f32 {
    return c[clamp(i32(idx), 0, 3)];
}

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    let posRTE = translateRelativeToEye(input.positionHigh, input.positionLow);
    output.position = camera.mvpRelativeToEye * posRTE;
    output.texCoord = input.texCoord;
    return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
    // Without lighting, show the normal map as a color visualization,
    // swizzled by the fabric-specified channel indices.
    let uv = fract(input.texCoord * material.repeat);
    let texColor = textureSample(normalMapTexture, textureSampler, uv);
    let nx = swizzleChannel(texColor, material.channels.x);
    let ny = swizzleChannel(texColor, material.channels.y);
    let nz = swizzleChannel(texColor, material.channels.z);
    return vec4<f32>(nx, ny, nz, 1.0);
}
