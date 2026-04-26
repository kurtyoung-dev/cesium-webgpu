// PrimitiveMatWaterFlat.wgsl
// Water material, no lighting
// Simplified animated water effect using procedural wave patterns
// Blends baseWaterColor with blendColor based on distance-based fade
// Uses RTE (Relative-To-Eye) for 64-bit precision at planetary scale
// Vertex: posHigh(3) + posLow(3) + st(2) = 8 floats = 32 bytes
// Matches CesiumJS Material.WaterType (simplified — no specular/normal map textures)

struct VertexInput {
    @location(0) positionHigh: vec3<f32>,
    @location(1) positionLow: vec3<f32>,
    @location(2) texCoord: vec2<f32>,
}

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) texCoord: vec2<f32>,
    @location(1) viewDist: f32,
}

// Water Flat repurposes the float-23 camera-UBO pad slot (normally
// `_pad1`) as a per-frame `time` value. See writeRTEUniformsFlat in
// WebGPUPrimitiveCommands.js — frameNumber is packed there so the wave
// phase advances each frame. Matches upstream `czm_frameNumber` semantic.
struct CameraUniforms {
    mvpRelativeToEye: mat4x4<f32>,
    encodedCameraHigh: vec3<f32>,
    _pad0: f32,
    encodedCameraLow: vec3<f32>,
    time: f32,
    _pad2: vec2<f32>,
    // DP-H41 (Batch 27) — previous frame's viewProjection for
    // TAA / motion-vector reprojection. Sourced from
    // `UniformState._previousViewProjection` (f32 mat4).
    previousViewProjection: mat4x4<f32>,
}

// Material.WaterType fabric: baseWaterColor, blendColor, specularMap,
// normalMap, frequency, animationSpeed, amplitude, specularIntensity,
// fadeFactor. Textures live on binding slots; wave phase is driven by
// `camera.time` (frameNumber) — see writeRTEUniformsFlat.
struct MaterialUniforms {
    baseWaterColor: vec4<f32>,
    blendColor: vec4<f32>,
    frequency: f32,
    animationSpeed: f32,
    amplitude: f32,
    specularIntensity: f32,
    fadeFactor: f32,
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var<uniform> material: MaterialUniforms;
@group(2) @binding(0) var textureSampler: sampler;
// DP-H20 (Batch 25) — dual texture layout matching the Lit variant.
@group(2) @binding(1) var normalMapTexture: texture_2d<f32>;
@group(2) @binding(2) var specularMapTexture: texture_2d<f32>;

fn translateRelativeToEye(high: vec3<f32>, low: vec3<f32>) -> vec4<f32> {
    var highDiff = high - camera.encodedCameraHigh;
    if (length(highDiff) == 0.0) { highDiff = vec3<f32>(0.0); }
    let lowDiff = low - camera.encodedCameraLow;
    return vec4<f32>(highDiff + lowDiff, 1.0);
}

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    let posRTE = translateRelativeToEye(input.positionHigh, input.positionLow);
    output.position = camera.mvpRelativeToEye * posRTE;
    output.texCoord = input.texCoord;
    output.viewDist = length(posRTE.xyz);
    return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
    // Wave phase from the per-frame camera `time` slot (frameNumber).
    // Matches upstream Water.glsl: `time = czm_frameNumber * animationSpeed`.
    let t = camera.time * material.animationSpeed;
    let freq = material.frequency;

    // Animated UV for wave sampling
    let waveUV = input.texCoord * freq + vec2<f32>(t * 0.3, t * 0.1);
    let noise = textureSample(normalMapTexture, textureSampler, fract(waveUV));

    // Distance-based fade
    let fade = max(1.0, (input.viewDist / 10000000000.0) * freq * material.fadeFactor);
    let waveIntensity = (noise.r * 2.0 - 1.0) / (fade * max(material.amplitude, 0.001));

    // Blend base water color with blend color based on wave
    let blendFactor = clamp(0.5 + waveIntensity * 0.5, 0.0, 1.0);
    let waterColor = mix(material.baseWaterColor.rgb, material.blendColor.rgb, blendFactor);

    // DP-H20 — gate alpha by the specular mask (see Lit variant).
    let waterMask = textureSample(
        specularMapTexture,
        textureSampler,
        input.texCoord,
    ).r;
    return vec4<f32>(waterColor, material.baseWaterColor.a * waterMask);
}
