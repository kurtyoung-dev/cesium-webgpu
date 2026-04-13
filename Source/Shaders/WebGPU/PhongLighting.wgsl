// PhongLighting.wgsl
// Basic Phong lighting shader for WebGPU
// Supports: ambient, diffuse, specular lighting with single directional light
//
// RTE — position is supplied as high/low split (locations 0/1) per the
// engine-wide 64-bit emulation rules. Clip-space is computed via
// `mvpRelativeToEye * translateRelativeToEye(...)` so planetary-scale
// world coordinates don't lose precision through a naked `mvp * worldPos`.

struct VertexInput {
    @location(0) positionHigh: vec3<f32>,
    @location(1) positionLow: vec3<f32>,
    @location(2) normal: vec3<f32>,
    @location(3) texCoord: vec2<f32>,
}

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    // RTE-safe eye-relative position — use this for fragment-stage math
    // that needs a "world position analogue". Do NOT reconstruct an
    // absolute ECEF world position on the GPU at planetary scale.
    @location(0) positionEC: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) texCoord: vec2<f32>,
}

struct CameraUniforms {
    viewMatrix: mat4x4<f32>,
    projectionMatrix: mat4x4<f32>,
    viewProjectionMatrix: mat4x4<f32>,
    // RTE matrices: translation zeroed so they can consume eye-relative
    // positions (see csm_translateRelativeToEye).
    mvpRelativeToEye: mat4x4<f32>,
    modelViewRelativeToEye: mat4x4<f32>,
    // EncodedCartesian3 camera position split into high/low halves.
    encodedCameraPositionMCHigh: vec3<f32>,
    _padHigh: f32,
    encodedCameraPositionMCLow: vec3<f32>,
    _padLow: f32,
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

// Inline RTE helper — matches the signature used across engine shaders.
// Sums the two-part high/low differences so the subtraction happens in
// the domain where precision actually exists.
fn translateRelativeToEye(
    posHigh: vec3<f32>,
    posLow: vec3<f32>,
    camHigh: vec3<f32>,
    camLow: vec3<f32>,
) -> vec3<f32> {
    let highDiff = posHigh - camHigh;
    let lowDiff = posLow - camLow;
    return highDiff + lowDiff;
}

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;

    // RTE: convert split world-space position into an eye-relative vec3.
    // `model.modelMatrix` is assumed to be identity-or-orientation-only
    // for primitives using this shader — translation lives in the encoded
    // camera/position pair. If a model transform is ever needed, it must
    // be applied to the encoded positions on the CPU, not here.
    let rte = translateRelativeToEye(
        input.positionHigh,
        input.positionLow,
        camera.encodedCameraPositionMCHigh,
        camera.encodedCameraPositionMCLow,
    );

    // Eye-relative view/clip transforms — these matrices have their
    // translation columns zeroed so they're safe to multiply against the
    // small RTE vector without losing bits to the translate column.
    let posEC = (camera.modelViewRelativeToEye * vec4<f32>(rte, 1.0)).xyz;
    output.positionEC = posEC;
    output.position = camera.mvpRelativeToEye * vec4<f32>(rte, 1.0);

    // Transform normal. Normal matrix should already be orientation-only
    // (inverse transpose of upper 3x3 of modelView), so FP32 is fine.
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

    // View direction. `positionEC` is already eye-relative so the view
    // vector is simply its negation. We don't reconstruct a world-space
    // position here — at planetary scale that would re-introduce the
    // precision loss RTE was meant to eliminate.
    let V = normalize(-input.positionEC);
    
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

    // View direction (eye-relative — see fragmentMain comment above).
    let V = normalize(-input.positionEC);
    
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
