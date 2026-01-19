// PhongLighting.wgsl
// Basic Phong lighting shader for WebGPU
// Supports: ambient, diffuse, specular lighting with single directional light

struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) texCoord: vec2<f32>,
}

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) worldPosition: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) texCoord: vec2<f32>,
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

struct LightUniforms {
    // Directional light
    lightDirection: vec3<f32>,
    _padding1: f32,
    lightColor: vec3<f32>,
    lightIntensity: f32,
    
    // Material properties
    ambientColor: vec3<f32>,
    _padding2: f32,
    diffuseColor: vec3<f32>,
    _padding3: f32,
    specularColor: vec3<f32>,
    shininess: f32,
}

// Bind groups
@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(0) @binding(1) var<uniform> model: ModelUniforms;
@group(0) @binding(2) var<uniform> light: LightUniforms;

// Optional texture (for textured materials)
@group(1) @binding(0) var textureSampler: sampler;
@group(1) @binding(1) var diffuseTexture: texture_2d<f32>;

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
    
    // Pass through texture coordinates
    output.texCoord = input.texCoord;
    
    return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
    // Normalize interpolated normal
    let N = normalize(input.normal);
    
    // Light direction (negated because it points toward the light)
    let L = normalize(-light.lightDirection);
    
    // View direction
    let V = normalize(camera.cameraPosition - input.worldPosition);
    
    // Reflection vector for specular
    let R = reflect(-L, N);
    
    // Sample texture if available (for now, use diffuse color)
    var baseColor = light.diffuseColor;
    // Uncomment when texture binding is set up:
    // baseColor = textureSample(diffuseTexture, textureSampler, input.texCoord).rgb;
    
    // Ambient component
    let ambient = light.ambientColor * baseColor;
    
    // Diffuse component (Lambert)
    let NdotL = max(dot(N, L), 0.0);
    let diffuse = baseColor * light.lightColor * NdotL * light.lightIntensity;
    
    // Specular component (Blinn-Phong)
    let H = normalize(L + V);
    let NdotH = max(dot(N, H), 0.0);
    let spec = pow(NdotH, light.shininess);
    let specular = light.specularColor * light.lightColor * spec * light.lightIntensity;
    
    // Combine all components
    let finalColor = ambient + diffuse + specular;
    
    return vec4<f32>(finalColor, 1.0);
}

// Alternative fragment shader with texture support
@fragment
fn fragmentMainTextured(input: VertexOutput) -> @location(0) vec4<f32> {
    // Normalize interpolated normal
    let N = normalize(input.normal);
    
    // Light direction
    let L = normalize(-light.lightDirection);
    
    // View direction
    let V = normalize(camera.cameraPosition - input.worldPosition);
    
    // Sample base color from texture
    let baseColor = textureSample(diffuseTexture, textureSampler, input.texCoord).rgb;
    
    // Ambient component
    let ambient = light.ambientColor * baseColor;
    
    // Diffuse component
    let NdotL = max(dot(N, L), 0.0);
    let diffuse = baseColor * light.lightColor * NdotL * light.lightIntensity;
    
    // Specular component (Blinn-Phong)
    let H = normalize(L + V);
    let NdotH = max(dot(N, H), 0.0);
    let spec = pow(NdotH, light.shininess);
    let specular = light.specularColor * light.lightColor * spec * light.lightIntensity;
    
    // Combine all components
    let finalColor = ambient + diffuse + specular;
    
    return vec4<f32>(finalColor, 1.0);
}
