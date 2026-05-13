// PrimitiveMatWaterLit.wgsl
// Water material + Blinn-Phong lighting
// Animated water with perturbed normals from a normal map texture
// Includes specular reflections, distance-based fade, and fresnel blending
// Uses RTE (Relative-To-Eye) for 64-bit precision at planetary scale
// Vertex: posHigh(3) + posLow(3) + normal(3) + st(2) = 11 floats = 44 bytes
// Matches CesiumJS Material.WaterType: normalMap, baseWaterColor, blendColor, etc.
//
// CSM Slice 2d — receives cascaded shadows through the primitive
// effects bind group at `@group(3)` (texture group occupies @group(2)).
//
// Batch 167 - B.12 chunk usage. @chunk csm_samplePointShadow
// Diffuse + specular shadow; fresnel blend + ambient stay unshadowed.

struct VertexInput {
    @location(0) positionHigh: vec3<f32>,
    @location(1) positionLow: vec3<f32>,
    @location(2) normal: vec3<f32>,
    @location(3) texCoord: vec2<f32>,
}

struct VertexOutput {
    @builtin(position) clipPosition: vec4<f32>,
    @location(0) worldNormal: vec3<f32>,
    @location(1) viewPosition: vec3<f32>,
    @location(2) texCoord: vec2<f32>,
    @location(3) eyePosition: vec3<f32>,
}

// Water Lit repurposes the float-55 camera-UBO pad slot (normally
// `_pad1`) as a per-frame `time` value. See writeRTEUniformsLit in
// WebGPUPrimitiveCommands.js — frameNumber is packed there so the wave
// phase advances each frame.
struct CameraUniforms {
    mvpRelativeToEye: mat4x4<f32>,
    modelViewRelativeToEye: mat4x4<f32>,
    normalMatrix: mat4x4<f32>,
    encodedCameraHigh: vec3<f32>,
    _pad0: f32,
    encodedCameraLow: vec3<f32>,
    time: f32,
    lightDirection: vec4<f32>,
    previousViewProjection: mat4x4<f32>,
}

// Material.WaterType fabric: baseWaterColor, blendColor, specularMap,
// normalMap, frequency, animationSpeed, amplitude, specularIntensity,
// fadeFactor. Wave phase is driven by `camera.time` (frameNumber) —
// see writeRTEUniformsLit.
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
@group(2) @binding(1) var normalMapTexture: texture_2d<f32>;
@group(2) @binding(2) var specularMapTexture: texture_2d<f32>;

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
    csmControl: vec4<f32>,
    // Batch 167 - extends struct through pointLightPositionWC for B.12.
    edgeControl: vec4<f32>,
    edgeViewport: vec4<f32>,
    pointLightControl: vec4<f32>,
    pointLightPositionWC: vec4<f32>,
}

struct CSMParams {
    cascadeVP0: mat4x4<f32>,
    cascadeVP1: mat4x4<f32>,
    cascadeVP2: mat4x4<f32>,
    cascadeVP3: mat4x4<f32>,
    cascadeSplits: vec4<f32>,
    blendBands: vec4<f32>,
    cascadeMinBias: vec4<f32>,
    cascadeMaxSlopeBias: vec4<f32>,
}

@group(3) @binding(0) var<uniform> effects: EffectsUniforms;
@group(3) @binding(1) var shadowDepthTex: texture_depth_2d;
@group(3) @binding(2) var shadowCompSampler: sampler_comparison;
@group(3) @binding(10) var<uniform> csmParams: CSMParams;
@group(3) @binding(11) var cascadeDepthArray: texture_depth_2d_array;
@group(3) @binding(17) var pointLightCubeDepth: texture_depth_cube;

fn translateRelativeToEye(high: vec3<f32>, low: vec3<f32>) -> vec4<f32> {
    var highDiff = high - camera.encodedCameraHigh;
    if (length(highDiff) == 0.0) { highDiff = vec3<f32>(0.0); }
    let lowDiff = low - camera.encodedCameraLow;
    return vec4<f32>(highDiff + lowDiff, 1.0);
}

fn selectCascade(viewDepth: f32, splits: vec4<f32>) -> u32 {
    if (viewDepth < splits.x) { return 0u; }
    if (viewDepth < splits.y) { return 1u; }
    if (viewDepth < splits.z) { return 2u; }
    return 3u;
}

fn getCascadeVP(idx: u32) -> mat4x4<f32> {
    switch (idx) {
        case 0u: { return csmParams.cascadeVP0; }
        case 1u: { return csmParams.cascadeVP1; }
        case 2u: { return csmParams.cascadeVP2; }
        default: { return csmParams.cascadeVP3; }
    }
}

fn cascadeDepthBias(cascadeIdx: u32, normal: vec3<f32>, lightDir: vec3<f32>) -> f32 {
    let nDotL = clamp(dot(normalize(normal), normalize(lightDir)), 0.0, 1.0);
    let minBias = csmParams.cascadeMinBias[cascadeIdx];
    let maxSlope = csmParams.cascadeMaxSlopeBias[cascadeIdx];
    let slopeBias = maxSlope * (1.0 - nDotL);
    return max(minBias, slopeBias);
}

fn sampleOneCascade(eyePos: vec3<f32>, cascadeIdx: u32, depthBias: f32) -> f32 {
    let vp = getCascadeVP(cascadeIdx);
    let clipPos = vp * vec4<f32>(eyePos, 1.0);
    let ndc = clipPos.xyz / clipPos.w;
    let uv = vec2<f32>(ndc.x * 0.5 + 0.5, 1.0 - (ndc.y * 0.5 + 0.5));
    let depth = ndc.z - depthBias;
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 ||
        depth > 1.0 || depth < 0.0) {
        return 1.0;
    }
    return textureSampleCompareLevel(
        cascadeDepthArray,
        shadowCompSampler,
        uv,
        i32(cascadeIdx),
        depth,
    );
}

fn sampleCascadeShadow(
    eyePos: vec3<f32>,
    viewDepth: f32,
    normal: vec3<f32>,
    lightDir: vec3<f32>,
) -> f32 {
    let cascadeIdx = selectCascade(viewDepth, csmParams.cascadeSplits);
    let bias0 = cascadeDepthBias(cascadeIdx, normal, lightDir);
    let s0 = sampleOneCascade(eyePos, cascadeIdx, bias0);
    let splitDist = csmParams.cascadeSplits[cascadeIdx];
    let blendBand = csmParams.blendBands[cascadeIdx];
    let blendStart = splitDist - blendBand;
    if (viewDepth > blendStart && cascadeIdx < 3u) {
        let nextIdx = cascadeIdx + 1u;
        let bias1 = cascadeDepthBias(nextIdx, normal, lightDir);
        let s1 = sampleOneCascade(eyePos, nextIdx, bias1);
        let blendT = smoothstep(blendStart, splitDist, viewDepth);
        return mix(s0, s1, blendT);
    }
    return s0;
}

// Batch 167 - B.12 chunk-based point-light receive.
fn computeShadowFactorPointLight(fragWC: vec3<f32>) -> f32 {
    if (effects.shadowDarkness >= 1.0) { return 1.0; }
    let visibility = csm_samplePointShadow(
        pointLightCubeDepth,
        shadowCompSampler,
        fragWC,
        effects.pointLightPositionWC.xyz,
        effects.pointLightControl.z,
        effects.pointLightControl.y,
        effects.pointLightControl.w,
        effects.pointLightPositionWC.w,
        effects.shadowMapSize.x,
    );
    return mix(effects.shadowDarkness, 1.0, visibility);
}

fn computeShadowFactorCSM(
    eyePos: vec3<f32>,
    viewDepth: f32,
    normal: vec3<f32>,
    lightDir: vec3<f32>,
) -> f32 {
    if (effects.shadowDarkness >= 1.0) { return 1.0; }
    let visibility = sampleCascadeShadow(eyePos, viewDepth, normal, lightDir);
    return mix(effects.shadowDarkness, 1.0, visibility);
}

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    let posRTE = translateRelativeToEye(input.positionHigh, input.positionLow);
    output.clipPosition = camera.mvpRelativeToEye * posRTE;
    output.worldNormal = (camera.normalMatrix * vec4<f32>(input.normal, 0.0)).xyz;
    output.viewPosition = (camera.modelViewRelativeToEye * posRTE).xyz;
    output.texCoord = input.texCoord;
    output.eyePosition = posRTE.xyz;
    return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
    // Wave phase from the per-frame camera `time` slot (frameNumber).
    // Matches upstream Water.glsl: `time = czm_frameNumber * animationSpeed`.
    let t = camera.time * material.animationSpeed;
    let freq = material.frequency;
    let viewDist = length(input.viewPosition);

    // Distance-based fade: reduce wave perturbation at distance
    let fade = max(1.0, (viewDist / 10000000000.0) * freq * material.fadeFactor);

    // Sample normal map at two slightly offset animated UVs for wave effect
    let waveUV1 = fract(input.texCoord * freq + vec2<f32>(t * 0.3, t * 0.1));
    let waveUV2 = fract(input.texCoord * freq * 0.7 + vec2<f32>(-t * 0.15, t * 0.25));
    let noise1 = textureSample(normalMapTexture, textureSampler, waveUV1);
    let noise2 = textureSample(normalMapTexture, textureSampler, waveUV2);

    // Combine two noise samples for more natural wave pattern
    let combinedNoise = (noise1.rgb + noise2.rgb) * 0.5;
    var waveNormal = combinedNoise * 2.0 - 1.0;
    waveNormal = vec3<f32>(
        waveNormal.x / max(material.amplitude, 0.001),
        waveNormal.y / max(material.amplitude, 0.001),
        waveNormal.z
    );
    // Fade out normal perturbation at distance
    waveNormal = mix(vec3<f32>(0.0, 0.0, 1.0), normalize(waveNormal), 1.0 / fade);

    // Approximate tangent-to-eye: perturb the surface normal
    let N = normalize(input.worldNormal);
    let dPdx = dpdx(input.viewPosition);
    let dPdy = dpdy(input.viewPosition);
    let T = normalize(dPdx - N * dot(dPdx, N));
    let B = normalize(cross(N, T));
    let perturbedNormal = normalize(
        T * waveNormal.x + B * waveNormal.y + N * waveNormal.z
    );

    // Lighting
    let V = normalize(-input.viewPosition);
    let L = normalize(camera.lightDirection.xyz);

    let NdotL = max(dot(perturbedNormal, L), 0.0);
    let H = normalize(L + V);
    let NdotH = max(dot(perturbedNormal, H), 0.0);

    // Fresnel approximation: more reflective at grazing angles
    let NdotV = max(dot(perturbedNormal, V), 0.0);
    let fresnel = pow(1.0 - NdotV, 5.0);

    // Specular — enhanced by specularIntensity
    let specular = pow(NdotH, 64.0) * material.specularIntensity;

    let ambient = 0.15;
    let ambientTerm = material.baseWaterColor.rgb * ambient;
    var directTerm = material.baseWaterColor.rgb * NdotL * 0.85;
    var spec = vec3<f32>(specular);

    // Batch 167 - point-light cube shadows take precedence over CSM.
    if (effects.pointLightControl.x > 0.5) {
        let cameraWC = camera.encodedCameraHigh + camera.encodedCameraLow;
        let fragWC = cameraWC + input.eyePosition;
        let shadowFactor = computeShadowFactorPointLight(fragWC);
        directTerm = directTerm * shadowFactor;
        spec = spec * shadowFactor;
    } else if (effects.csmControl.x > 0.5) {
        let viewDepth = abs(input.viewPosition.z);
        let shadowFactor = computeShadowFactorCSM(
            input.eyePosition, viewDepth, perturbedNormal, L,
        );
        directTerm = directTerm * shadowFactor;
        spec = spec * shadowFactor;
    }

    let diffuseColor = ambientTerm + directTerm;

    // Blend with blendColor using fresnel
    let waterColor = mix(diffuseColor, material.blendColor.rgb, fresnel * 0.6);
    let finalColor = waterColor + spec;

    // DP-H20 — sample the specular mask to gate water extent.
    let waterMask = textureSample(
        specularMapTexture,
        textureSampler,
        input.texCoord,
    ).r;
    return vec4<f32>(finalColor, material.baseWaterColor.a * waterMask);
}
