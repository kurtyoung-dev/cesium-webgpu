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

// FEAT-GAP-09 (Batch 97) — truncated EffectsUniforms struct, sized to
// reach the `atmosphereLutControl: vec4<f32>` slot at byte offset 240
// in the shared 480-byte UBO (see `WebGPUEffectsBindGroup.js`). Reading
// less than the full UBO is safe — WGSL just sees the prefix.
struct EffectsUniforms {
    shadowMatrix: mat4x4<f32>,
    shadowMapSize: vec2<f32>,
    shadowDarkness: f32,
    shadowSoftShadows: f32,
    clippingPlaneCount: u32,
    clippingUnionMode: u32,
    clippingEdgeWidth: f32,
    clippingPolygonCount: u32,
    clippingEdgeColor: vec4<f32>,
    clipPlaneEqHW: array<vec4<f32>, 8>,
    atmosphereLutControl: vec4<f32>,
}

@group(3) @binding(0) var<uniform> effects: EffectsUniforms;
// FEAT-GAP-09 (Batch 97) — aerial-perspective LUT bindings 7/8/9.
@group(3) @binding(7) var atmosphereTransmittanceLut: texture_2d<f32>;
@group(3) @binding(8) var atmosphereInscatterLut: texture_2d<f32>;
@group(3) @binding(9) var atmosphereLutSampler: sampler;

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
    output.eyePosition = posRTE.xyz;
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
    var finalColor = vec4<f32>(waterColor, material.baseWaterColor.a * waterMask);

    // FEAT-GAP-09 (Batch 97) — Aerial-perspective fog blend. Mirrors
    // `PrimitiveBasicColor.wgsl::fragmentMain`.
    if (effects.atmosphereLutControl.x > 0.5) {
        let innerRadius = effects.atmosphereLutControl.y;
        let thickness = max(1.0, effects.atmosphereLutControl.z);
        let cameraWC = camera.encodedCameraHigh + camera.encodedCameraLow;
        let viewDirWS = normalize(input.eyePosition);
        let upDir = normalize(cameraWC);
        let cosViewZenith = clamp(dot(viewDirWS, upDir), -1.0, 1.0);
        let cameraAltitude = max(0.0, length(cameraWC) - innerRadius);
        let uCoord = clamp(cosViewZenith * 0.5 + 0.5, 0.0, 1.0);
        let vCoord = clamp(cameraAltitude / thickness, 0.0, 1.0);

        let tSample = textureSampleLevel(
            atmosphereTransmittanceLut, atmosphereLutSampler,
            vec2<f32>(uCoord, vCoord), 0.0,
        );
        let iSample = textureSampleLevel(
            atmosphereInscatterLut, atmosphereLutSampler,
            vec2<f32>(uCoord, vCoord), 0.0,
        );
        let transmittance =
            clamp((tSample.r + tSample.g + tSample.b) / 3.0, 0.0, 1.0);

        let excessAltitude = max(0.0, cameraAltitude - thickness);
        let orbitFalloff = exp(-excessAltitude / thickness);

        let fogWeight = clamp(iSample.a, 0.0, 1.0) * orbitFalloff;
        finalColor = vec4<f32>(
            mix(finalColor.rgb, iSample.rgb, fogWeight),
            finalColor.a,
        );
        if (effects.atmosphereLutControl.w > 0.5) {
            finalColor = vec4<f32>(
                finalColor.rgb * mix(1.0, transmittance, fogWeight),
                finalColor.a,
            );
        }
    }

    return finalColor;
}
