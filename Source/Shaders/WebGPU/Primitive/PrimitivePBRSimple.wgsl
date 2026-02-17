// PrimitivePBRSimple.wgsl
// PBR metallic-roughness without textures — all parameters from uniforms
// Vertex: position(3) + normal(3) + st(2) = 8 floats = 32 bytes
// Uniform: MVP(64) + ModelView(64) + NormalMatrix(64) + LightDir(16) +
//          baseColorFactor(16) + pbrParams(16) + emissive(16) = 256 bytes
// pbrParams: x=metallic, y=roughness, z=occlusionStrength, w=unused

const PI: f32 = 3.14159265359;

struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) texCoord: vec2<f32>,
}

struct VertexOutput {
    @builtin(position) clipPosition: vec4<f32>,
    @location(0) worldNormal: vec3<f32>,
    @location(1) viewPosition: vec3<f32>,
    @location(2) texCoord: vec2<f32>,
}

struct Uniforms {
    modelViewProjection: mat4x4<f32>,
    modelView: mat4x4<f32>,
    normalMatrix: mat4x4<f32>,
    lightDirection: vec4<f32>,
    baseColorFactor: vec4<f32>,
    pbrParams: vec4<f32>,
    emissiveFactor: vec4<f32>,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    output.clipPosition = uniforms.modelViewProjection * vec4<f32>(input.position, 1.0);
    output.texCoord = input.texCoord;

    let transformedNormal = normalize(
        mat3x3<f32>(
            uniforms.normalMatrix[0].xyz,
            uniforms.normalMatrix[1].xyz,
            uniforms.normalMatrix[2].xyz
        ) * input.normal
    );
    output.worldNormal = transformedNormal;

    let viewPos = uniforms.modelView * vec4<f32>(input.position, 1.0);
    output.viewPosition = viewPos.xyz;

    return output;
}

fn distributionGGX(N: vec3<f32>, H: vec3<f32>, roughness: f32) -> f32 {
    let a = roughness * roughness;
    let a2 = a * a;
    let NdotH = max(dot(N, H), 0.0);
    let NdotH2 = NdotH * NdotH;
    var denom = (NdotH2 * (a2 - 1.0) + 1.0);
    denom = PI * denom * denom;
    return a2 / denom;
}

fn geometrySchlickGGX(NdotV: f32, roughness: f32) -> f32 {
    let r = roughness + 1.0;
    let k = (r * r) / 8.0;
    return NdotV / (NdotV * (1.0 - k) + k);
}

fn geometrySmith(N: vec3<f32>, V: vec3<f32>, L: vec3<f32>, roughness: f32) -> f32 {
    let NdotV = max(dot(N, V), 0.0);
    let NdotL = max(dot(N, L), 0.0);
    return geometrySchlickGGX(NdotV, roughness) * geometrySchlickGGX(NdotL, roughness);
}

fn fresnelSchlick(cosTheta: f32, F0: vec3<f32>) -> vec3<f32> {
    return F0 + (vec3<f32>(1.0) - F0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
    let N = normalize(input.worldNormal);
    let V = normalize(-input.viewPosition);
    let L = normalize(uniforms.lightDirection.xyz);
    let H = normalize(V + L);

    let albedo = uniforms.baseColorFactor.rgb;
    let alpha = uniforms.baseColorFactor.a;
    let metallic = uniforms.pbrParams.x;
    let roughness = uniforms.pbrParams.y;

    var F0 = vec3<f32>(0.04);
    F0 = mix(F0, albedo, metallic);

    let NDF = distributionGGX(N, H, roughness);
    let G = geometrySmith(N, V, L, roughness);
    let F = fresnelSchlick(max(dot(H, V), 0.0), F0);

    let numerator = NDF * G * F;
    let denominator = 4.0 * max(dot(N, V), 0.0) * max(dot(N, L), 0.0) + 0.0001;
    let specular = numerator / denominator;

    let kS = F;
    var kD = vec3<f32>(1.0) - kS;
    kD *= 1.0 - metallic;

    let NdotL = max(dot(N, L), 0.0);
    let diffuse = kD * albedo / PI;
    let Lo = (diffuse + specular) * vec3<f32>(1.0) * NdotL;

    let ambient = vec3<f32>(0.03) * albedo;
    let emissive = uniforms.emissiveFactor.rgb;
    var color = ambient + Lo + emissive;

    // Reinhard tone mapping
    color = color / (color + vec3<f32>(1.0));
    // Gamma correction
    color = pow(color, vec3<f32>(1.0 / 2.2));

    return vec4<f32>(color, alpha);
}
