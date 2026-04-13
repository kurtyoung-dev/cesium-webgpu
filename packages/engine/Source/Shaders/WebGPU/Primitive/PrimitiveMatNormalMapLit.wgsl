// PrimitiveMatNormalMapLit.wgsl
// Normal map material + Blinn-Phong lighting
// Reads surface normal from texture and applies it to lighting
// Uses tangent-space to eye-space transformation via screen-space derivatives
// Uses RTE (Relative-To-Eye) for 64-bit precision at planetary scale
// Vertex: posHigh(3) + posLow(3) + normal(3) + st(2) = 11 floats = 44 bytes
// Matches CesiumJS Material.NormalMapType: image, channels, strength, repeat

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
    _pad2: f32,
    _pad3: f32,
}

struct MaterialUniforms {
    repeat: vec2<f32>,
    strength: f32,
    channels: vec3<f32>,  // swizzle indices: e.g. (0,1,2) = rgb,
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var<uniform> material: MaterialUniforms;
@group(2) @binding(0) var textureSampler: sampler;
@group(2) @binding(1) var normalTexture: texture_2d<f32>;

fn translateRelativeToEye(high: vec3<f32>, low: vec3<f32>) -> vec4<f32> {
    var highDiff = high - camera.encodedCameraHigh;
    if (length(highDiff) == 0.0) { highDiff = vec3<f32>(0.0); }
    let lowDiff = low - camera.encodedCameraLow;
    return vec4<f32>(highDiff + lowDiff, 1.0);
}

// WGF-5: WGSL allows dynamic indexing into vector types, so the old
// branch-per-channel helper can collapse to a single subscript. Saves three
// branches per fragment for normal-map sampling.
fn swizzleChannel(texColor: vec4<f32>, idx: f32) -> f32 {
    return texColor[clamp(i32(idx), 0, 3)];
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
    let uv = fract(input.texCoord * material.repeat);
    let texColor = textureSample(normalTexture, textureSampler, uv);

    // Read normal from texture using channel swizzle
    let nx = swizzleChannel(texColor, material.channels.x);
    let ny = swizzleChannel(texColor, material.channels.y);
    let nz = swizzleChannel(texColor, material.channels.z);

    // Remap from [0,1] to [-1,1]
    var tangentNormal = vec3<f32>(nx, ny, nz) * 2.0 - 1.0;
    // Apply strength: blend toward flat normal (0,0,1)
    tangentNormal = normalize(vec3<f32>(
        tangentNormal.x * material.strength,
        tangentNormal.y * material.strength,
        tangentNormal.z
    ));

    // Approximate tangent-to-eye transformation using screen-space derivatives
    let N = normalize(input.worldNormal);
    let dPdx = dpdx(input.viewPosition);
    let dPdy = dpdy(input.viewPosition);
    let T = normalize(dPdx - N * dot(dPdx, N));
    let B = normalize(cross(N, T));
    let perturbedNormal = normalize(
        T * tangentNormal.x + B * tangentNormal.y + N * tangentNormal.z
    );

    // Blinn-Phong with perturbed normal
    let V = normalize(-input.viewPosition);
    let L = normalize(camera.lightDirection.xyz);

    let NdotL = max(dot(perturbedNormal, L), 0.0);
    let H = normalize(L + V);
    let NdotH = max(dot(perturbedNormal, H), 0.0);
    let specular = pow(NdotH, 64.0);

    let ambient = 0.15;
    let baseDiffuse = vec3<f32>(0.5);
    let diffuse = baseDiffuse * (ambient + NdotL * 0.85);
    let spec = vec3<f32>(specular * 0.3);

    let finalColor = diffuse + spec;
    return vec4<f32>(finalColor, 1.0);
}
