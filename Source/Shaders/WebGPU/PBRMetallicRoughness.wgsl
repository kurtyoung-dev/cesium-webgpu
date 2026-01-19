// PBRMetallicRoughness.wgsl
// Physically Based Rendering shader using metallic-roughness workflow
// Compatible with glTF 2.0 PBR materials

struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) texCoord: vec2<f32>,
    @location(3) tangent: vec4<f32>, // w component is handedness
}

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) worldPosition: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) texCoord: vec2<f32>,
    @location(3) tangent: vec3<f32>,
    @location(4) bitangent: vec3<f32>,
}

struct CameraUniforms {
    viewMatrix: mat4x4<f32>,
    projectionMatrix: mat4x4<f32>,
    viewProjectionMatrix: mat4x4<f32>,
    cameraPosition: vec3<f32>,
    _padding: f32,
}

struct ModelUniforms {
    modelMatrix: mat4x4<f32>,
    normalMatrix: mat4x4<f32>,
}

struct PBRMaterial {
    // Base color factor (vec4 for albedo + alpha)
    baseColorFactor: vec4<f32>,
    
    // PBR parameters
    metallicFactor: f32,
    roughnessFactor: f32,
    
    // Normal map scale
    normalScale: f32,
    
    // Occlusion strength
    occlusionStrength: f32,
    
    // Emissive factor
    emissiveFactor: vec3<f32>,
    _padding: f32,
}

struct LightingUniforms {
    // Directional light
    lightDirection: vec3<f32>,
    _padding1: f32,
    lightColor: vec3<f32>,
    lightIntensity: f32,
    
    // Image-based lighting
    iblIntensity: f32,
    _padding2: vec3<f32>,
}

// Bind groups
@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(0) @binding(1) var<uniform> model: ModelUniforms;
@group(0) @binding(2) var<uniform> material: PBRMaterial;
@group(0) @binding(3) var<uniform> lighting: LightingUniforms;

// PBR textures (group 1)
@group(1) @binding(0) var defaultSampler: sampler;
@group(1) @binding(1) var baseColorTexture: texture_2d<f32>;
@group(1) @binding(2) var metallicRoughnessTexture: texture_2d<f32>; // B=metallic, G=roughness
@group(1) @binding(3) var normalTexture: texture_2d<f32>;
@group(1) @binding(4) var occlusionTexture: texture_2d<f32>; // R channel
@group(1) @binding(5) var emissiveTexture: texture_2d<f32>;

// Constants
const PI: f32 = 3.14159265359;

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    
    // Transform position to world space
    let worldPos = model.modelMatrix * vec4<f32>(input.position, 1.0);
    output.worldPosition = worldPos.xyz;
    
    // Transform position to clip space
    output.position = camera.viewProjectionMatrix * worldPos;
    
    // Transform normal to world space
    output.normal = normalize((model.normalMatrix * vec4<f32>(input.normal, 0.0)).xyz);
    
    // Transform tangent to world space
    output.tangent = normalize((model.normalMatrix * vec4<f32>(input.tangent.xyz, 0.0)).xyz);
    
    // Calculate bitangent
    output.bitangent = cross(output.normal, output.tangent) * input.tangent.w;
    
    // Pass through texture coordinates
    output.texCoord = input.texCoord;
    
    return output;
}

// PBR helper functions

// Normal Distribution Function (GGX/Trowbridge-Reitz)
fn distributionGGX(N: vec3<f32>, H: vec3<f32>, roughness: f32) -> f32 {
    let a = roughness * roughness;
    let a2 = a * a;
    let NdotH = max(dot(N, H), 0.0);
    let NdotH2 = NdotH * NdotH;
    
    let nom = a2;
    var denom = (NdotH2 * (a2 - 1.0) + 1.0);
    denom = PI * denom * denom;
    
    return nom / denom;
}

// Geometry Function (Smith's Schlick-GGX)
fn geometrySchlickGGX(NdotV: f32, roughness: f32) -> f32 {
    let r = roughness + 1.0;
    let k = (r * r) / 8.0;
    
    let nom = NdotV;
    let denom = NdotV * (1.0 - k) + k;
    
    return nom / denom;
}

fn geometrySmith(N: vec3<f32>, V: vec3<f32>, L: vec3<f32>, roughness: f32) -> f32 {
    let NdotV = max(dot(N, V), 0.0);
    let NdotL = max(dot(N, L), 0.0);
    let ggx2 = geometrySchlickGGX(NdotV, roughness);
    let ggx1 = geometrySchlickGGX(NdotL, roughness);
    
    return ggx1 * ggx2;
}

// Fresnel Function (Schlick's approximation)
fn fresnelSchlick(cosTheta: f32, F0: vec3<f32>) -> vec3<f32> {
    return F0 + (vec3<f32>(1.0) - F0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
}

// Get normal from normal map
fn getNormalFromMap(input: VertexOutput) -> vec3<f32> {
    // Sample normal map
    let tangentNormal = textureSample(normalTexture, defaultSampler, input.texCoord).xyz * 2.0 - 1.0;
    let scaledNormal = vec3<f32>(tangentNormal.xy * material.normalScale, tangentNormal.z);
    
    // Build TBN matrix
    let N = normalize(input.normal);
    let T = normalize(input.tangent);
    let B = normalize(input.bitangent);
    let TBN = mat3x3<f32>(T, B, N);
    
    // Transform to world space
    return normalize(TBN * scaledNormal);
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
    // Sample textures
    let baseColor = textureSample(baseColorTexture, defaultSampler, input.texCoord);
    let albedo = baseColor.rgb * material.baseColorFactor.rgb;
    let alpha = baseColor.a * material.baseColorFactor.a;
    
    // Metallic and roughness from texture (blue and green channels)
    let metallicRoughness = textureSample(metallicRoughnessTexture, defaultSampler, input.texCoord);
    let metallic = metallicRoughness.b * material.metallicFactor;
    let roughness = metallicRoughness.g * material.roughnessFactor;
    
    // Ambient occlusion (red channel)
    let ao = textureSample(occlusionTexture, defaultSampler, input.texCoord).r;
    let occlusion = mix(1.0, ao, material.occlusionStrength);
    
    // Emissive
    let emissive = textureSample(emissiveTexture, defaultSampler, input.texCoord).rgb * material.emissiveFactor;
    
    // Get normal (from normal map or vertex normal)
    let N = getNormalFromMap(input);
    
    // View direction
    let V = normalize(camera.cameraPosition - input.worldPosition);
    
    // Calculate F0 (surface reflection at zero incidence)
    var F0 = vec3<f32>(0.04); // Dielectric base reflectivity
    F0 = mix(F0, albedo, metallic);
    
    // Light calculation
    let L = normalize(-lighting.lightDirection);
    let H = normalize(V + L);
    
    // Cook-Torrance BRDF
    let NDF = distributionGGX(N, H, roughness);
    let G = geometrySmith(N, V, L, roughness);
    let F = fresnelSchlick(max(dot(H, V), 0.0), F0);
    
    let numerator = NDF * G * F;
    let denominator = 4.0 * max(dot(N, V), 0.0) * max(dot(N, L), 0.0) + 0.0001;
    let specular = numerator / denominator;
    
    // Energy conservation
    let kS = F;
    var kD = vec3<f32>(1.0) - kS;
    kD *= 1.0 - metallic; // Metallic surfaces don't have diffuse
    
    let NdotL = max(dot(N, L), 0.0);
    
    // Combine diffuse and specular
    let diffuse = kD * albedo / PI;
    let radiance = lighting.lightColor * lighting.lightIntensity;
    let Lo = (diffuse + specular) * radiance * NdotL;
    
    // Ambient term (simplified IBL)
    let ambient = vec3<f32>(0.03) * albedo * occlusion * lighting.iblIntensity;
    
    // Final color
    var color = ambient + Lo + emissive;
    
    // Tone mapping (simple Reinhard)
    color = color / (color + vec3<f32>(1.0));
    
    // Gamma correction
    color = pow(color, vec3<f32>(1.0 / 2.2));
    
    return vec4<f32>(color, alpha);
}

// Simplified fragment shader without normal mapping (for basic geometry)
@fragment
fn fragmentMainSimple(input: VertexOutput) -> @location(0) vec4<f32> {
    // Sample base color only
    let baseColor = textureSample(baseColorTexture, defaultSampler, input.texCoord);
    let albedo = baseColor.rgb * material.baseColorFactor.rgb;
    let alpha = baseColor.a * material.baseColorFactor.a;
    
    // Use material factors
    let metallic = material.metallicFactor;
    let roughness = material.roughnessFactor;
    
    // Use vertex normal
    let N = normalize(input.normal);
    let V = normalize(camera.cameraPosition - input.worldPosition);
    let L = normalize(-lighting.lightDirection);
    let H = normalize(V + L);
    
    // Calculate F0
    var F0 = vec3<f32>(0.04);
    F0 = mix(F0, albedo, metallic);
    
    // PBR calculation
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
    let radiance = lighting.lightColor * lighting.lightIntensity;
    let Lo = (diffuse + specular) * radiance * NdotL;
    
    let ambient = vec3<f32>(0.03) * albedo;
    var color = ambient + Lo;
    
    // Tone mapping and gamma correction
    color = color / (color + vec3<f32>(1.0));
    color = pow(color, vec3<f32>(1.0 / 2.2));
    
    return vec4<f32>(color, alpha);
}
