// PrimitiveMatFadeFlat.wgsl
// Fade (gradient) material, no lighting
// Uses RTE (Relative-To-Eye) for 64-bit precision at planetary scale
// Vertex: posHigh(3) + posLow(3) + st(2) = 8 floats = 32 bytes
// Matches CesiumJS Material.FadeType: fadeInColor, fadeOutColor, maximumDistance, repeat, offset, time

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

// Material.FadeType fabric: { fadeInColor, fadeOutColor, maximumDistance,
// repeat: bool, fadeDirection: {x,y:bool}, time: Cart2 }. Fabric order
// is preserved here; `repeat` is packed as f32 (0.0/1.0) and
// `fadeDirection` as vec2<f32> (0.0/1.0). Matches upstream FadeMaterial.glsl.
struct MaterialUniforms {
    fadeInColor: vec4<f32>,
    fadeOutColor: vec4<f32>,
    maximumDistance: f32,
    fadeRepeat: f32,
    fadeDirection: vec2<f32>,
    time: vec2<f32>,
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var<uniform> material: MaterialUniforms;

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

@group(2) @binding(0) var<uniform> effects: EffectsUniforms;
// FEAT-GAP-09 (Batch 97) — aerial-perspective LUT bindings 7/8/9.
@group(2) @binding(7) var atmosphereTransmittanceLut: texture_2d<f32>;
@group(2) @binding(8) var atmosphereInscatterLut: texture_2d<f32>;
@group(2) @binding(9) var atmosphereLutSampler: sampler;

fn translateRelativeToEye(high: vec3<f32>, low: vec3<f32>) -> vec4<f32> {
    var highDiff = high - camera.encodedCameraHigh;
    if (length(highDiff) == 0.0) { highDiff = vec3<f32>(0.0); }
    let lowDiff = low - camera.encodedCameraLow;
    return vec4<f32>(highDiff + lowDiff, 1.0);
}

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    let eyePos = translateRelativeToEye(input.positionHigh, input.positionLow);
    output.position = camera.mvpRelativeToEye * eyePos;
    output.eyePosition = eyePos.xyz;
    output.texCoord = input.texCoord;
    return output;
}

// Mirrors getTime() in Shaders/Materials/FadeMaterial.glsl — measures
// the distance between the animation time axis-coordinate and the
// per-texel st coord, optionally wrapping when `repeat` is on.
fn getFadeTime(t: f32, coord: f32) -> f32 {
    let scalar = 1.0 / max(material.maximumDistance, 0.001);
    var q = abs(t - coord) * scalar;
    if (material.fadeRepeat > 0.5) {
        let r = abs(t - (coord + 1.0)) * scalar;
        let s = abs(t - (coord - 1.0)) * scalar;
        q = min(min(r, s), q);
    }
    return clamp(q, 0.0, 1.0);
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
    let st = input.texCoord;
    let s = getFadeTime(material.time.x, st.x) * material.fadeDirection.x;
    let tAxis = getFadeTime(material.time.y, st.y) * material.fadeDirection.y;
    let u = length(vec2<f32>(s, tAxis));
    var finalColor = mix(material.fadeInColor, material.fadeOutColor, u);

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
