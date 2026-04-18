// PrimitiveMatWaterLit.wgsl
// Water material + Blinn-Phong lighting
// Animated water with perturbed normals from a normal map texture
// Includes specular reflections, distance-based fade, and fresnel blending
// Uses RTE (Relative-To-Eye) for 64-bit precision at planetary scale
// Vertex: posHigh(3) + posLow(3) + normal(3) + st(2) = 11 floats = 44 bytes
// Matches CesiumJS Material.WaterType: normalMap, baseWaterColor, blendColor, etc.

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
}

struct CameraUniforms {
    mvpRelativeToEye: mat4x4<f32>,
    modelViewRelativeToEye: mat4x4<f32>,
    normalMatrix: mat4x4<f32>,
    encodedCameraHigh: vec3<f32>,
    _pad0: f32,
    encodedCameraLow: vec3<f32>,
    _pad1: f32,
    lightDirection: vec4<f32>,
    _pad2: vec2<f32>,
    // DP-H41 (Batch 27) — previous frame's viewProjection for
    // TAA / motion-vector reprojection. Sourced from
    // `UniformState._previousViewProjection` (f32 mat4).
    previousViewProjection: mat4x4<f32>,
}

struct MaterialUniforms {
    baseWaterColor: vec4<f32>,
    blendColor: vec4<f32>,
    frequency: f32,
    animationSpeed: f32,
    amplitude: f32,
    specularIntensity: f32,
    fadeFactor: f32,
    time: f32,
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var<uniform> material: MaterialUniforms;
@group(2) @binding(0) var textureSampler: sampler;
// DP-H20 (Batch 25) — Water uses TWO textures:
//   @binding(1) normalMapTexture  → wave-normal perturbation (fetched
//                                   from `material._imageSources.normalMap`)
//   @binding(2) specularMapTexture → "where water is" mask (fetched
//                                    from `material._imageSources.specularMap`)
// Pre-Batch 25 the WebGPU code uploaded `specularMap` to @binding(1)
// but the shader read it AS IF it were the normal map — a subtle
// mislabel that produced chaotic wave behavior (specular coverage
// patterns treated as wave normals). Batch 25 routes the primary
// uniform to `normalMap` and adds `specularMap` as the mask at slot 2.
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
    output.clipPosition = camera.mvpRelativeToEye * posRTE;
    output.worldNormal = (camera.normalMatrix * vec4<f32>(input.normal, 0.0)).xyz;
    output.viewPosition = (camera.modelViewRelativeToEye * posRTE).xyz;
    output.texCoord = input.texCoord;
    return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
    let t = material.time * material.animationSpeed;
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
    let diffuse = material.baseWaterColor.rgb * (ambient + NdotL * 0.85);
    let spec = vec3<f32>(specular);

    // Blend with blendColor using fresnel
    let waterColor = mix(diffuse, material.blendColor.rgb, fresnel * 0.6);
    let finalColor = waterColor + spec;

    // DP-H20 — sample the specular mask to gate water extent. The mask
    // is 1.0 where water exists and 0.0 for land; multiply into alpha
    // so land tiles (with the same material applied) don't render
    // water effects. Matches the WebGL Water material's `specularMap`
    // semantics.
    let waterMask = textureSample(
        specularMapTexture,
        textureSampler,
        input.texCoord,
    ).r;
    return vec4<f32>(finalColor, material.baseWaterColor.a * waterMask);
}
