// PrimitivePBRTextured.wgsl
// Full PBR (metallic-roughness) with texture sampling
// Uses RTE (Relative-To-Eye) for 64-bit precision at planetary scale
// Vertex: posHigh(3) + posLow(3) + normal(3) + uv(2) = 11 floats = 44 bytes

struct VertexInput {
    @location(0) positionHigh: vec3<f32>,
    @location(1) positionLow: vec3<f32>,
    @location(2) normal: vec3<f32>,
    @location(3) texCoord: vec2<f32>,
}

struct VertexOutput {
    @builtin(position) clipPosition: vec4<f32>,
    @location(0) worldNormal: vec3<f32>,
    @location(1) worldPosition: vec3<f32>,
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
}

struct MaterialUniforms {
    lightColor: vec4<f32>,
    baseColorFactor: vec4<f32>,
    metallic: f32,
    roughness: f32,
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var<uniform> material: MaterialUniforms;
@group(2) @binding(0) var textureSampler: sampler;
@group(2) @binding(1) var baseColorTexture: texture_2d<f32>;

const PI: f32 = 3.14159265359;

fn translateRelativeToEye(high: vec3<f32>, low: vec3<f32>) -> vec4<f32> {
    var highDiff = high - camera.encodedCameraHigh;
    if (length(highDiff) == 0.0) { highDiff = vec3<f32>(0.0); }
    let lowDiff = low - camera.encodedCameraLow;
    return vec4<f32>(highDiff + lowDiff, 1.0);
}

fn distributionGGX(N: vec3<f32>, H: vec3<f32>, roughness: f32) -> f32 {
    let a = roughness * roughness;
    let a2 = a * a;
    let NdotH = max(dot(N, H), 0.0);
    let NdotH2 = NdotH * NdotH;
    let denom = NdotH2 * (a2 - 1.0) + 1.0;
    return a2 / (PI * denom * denom);
}

fn geometrySmith(N: vec3<f32>, V: vec3<f32>, L: vec3<f32>, roughness: f32) -> f32 {
    let r = roughness + 1.0;
    let k = (r * r) / 8.0;
    let NdotV = max(dot(N, V), 0.0);
    let NdotL = max(dot(N, L), 0.0);
    let ggx1 = NdotV / (NdotV * (1.0 - k) + k);
    let ggx2 = NdotL / (NdotL * (1.0 - k) + k);
    return ggx1 * ggx2;
}

fn fresnelSchlick(cosTheta: f32, F0: vec3<f32>) -> vec3<f32> {
    return F0 + (1.0 - F0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
}

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    let eyePos = translateRelativeToEye(input.positionHigh, input.positionLow);
    output.clipPosition = camera.mvpRelativeToEye * eyePos;
    output.texCoord = input.texCoord;

    let transformedNormal = normalize(
        mat3x3<f32>(
            camera.normalMatrix[0].xyz,
            camera.normalMatrix[1].xyz,
            camera.normalMatrix[2].xyz
        ) * input.normal
    );
    output.worldNormal = transformedNormal;
    output.worldPosition = (camera.modelViewRelativeToEye * eyePos).xyz;

    return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
    let texColor = textureSample(baseColorTexture, textureSampler, input.texCoord);
    let albedo = texColor.rgb * material.baseColorFactor.rgb;
    let alpha = texColor.a * material.baseColorFactor.a;

    let N = normalize(input.worldNormal);
    let V = normalize(-input.worldPosition);
    let L = normalize(camera.lightDirection.xyz);
    let H = normalize(V + L);

    let F0 = mix(vec3<f32>(0.04), albedo, material.metallic);

    let D = distributionGGX(N, H, material.roughness);
    let G = geometrySmith(N, V, L, material.roughness);
    let F = fresnelSchlick(max(dot(H, V), 0.0), F0);

    let NdotL = max(dot(N, L), 0.0);
    let numerator = D * G * F;
    let denominator = 4.0 * max(dot(N, V), 0.0) * NdotL + 0.0001;
    let specular = numerator / denominator;

    let kD = (1.0 - F) * (1.0 - material.metallic);
    let diffuse = kD * albedo / PI;

    let color = (diffuse + specular) * material.lightColor.rgb * NdotL;
    let ambient = albedo * 0.03;
    let finalColor = color + ambient;

    let mapped = finalColor / (finalColor + 1.0);
    let gamma = pow(mapped, vec3<f32>(1.0 / 2.2));

    return vec4<f32>(gamma, alpha);
}
