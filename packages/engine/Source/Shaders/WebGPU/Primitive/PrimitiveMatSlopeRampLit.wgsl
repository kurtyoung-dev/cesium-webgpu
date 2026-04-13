// PrimitiveMatSlopeRampLit.wgsl
// Slope ramp material + Blinn-Phong lighting
// Maps surface slope angle to a color ramp texture
// Slope = angle between surface normal and radial (up) direction
// Uses RTE (Relative-To-Eye) for 64-bit precision at planetary scale
// Vertex: posHigh(3) + posLow(3) + normal(3) + st(2) = 11 floats = 44 bytes
// Matches CesiumJS Material.SlopeRampType: image

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
    @location(3) slopeT: f32,
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
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
// group(1) = MaterialUniforms placeholder (not referenced by this shader)
@group(2) @binding(0) var rampSampler: sampler;
@group(2) @binding(1) var rampTexture: texture_2d<f32>;

const PI_OVER_2: f32 = 1.5707963268;

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
    // Compute slope: angle between normal and radial (up) direction
    let worldPos = input.positionHigh + input.positionLow;
    let up = normalize(worldPos);
    let slope = acos(clamp(dot(normalize(input.normal), up), -1.0, 1.0));
    output.slopeT = slope / PI_OVER_2;
    return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
    let N = normalize(input.worldNormal);
    let V = normalize(-input.viewPosition);
    let L = normalize(camera.lightDirection.xyz);

    let NdotL = max(dot(N, L), 0.0);
    let H = normalize(L + V);
    let NdotH = max(dot(N, H), 0.0);
    let specular = pow(NdotH, 64.0);

    let ambient = 0.15;

    let t = clamp(input.slopeT, 0.0, 1.0);
    let rampColor = textureSample(rampTexture, rampSampler, vec2<f32>(t, 0.5));

    let diffuse = rampColor.rgb * (ambient + NdotL * 0.85);
    let spec = vec3<f32>(specular * 0.3);
    let finalColor = diffuse + spec;
    return vec4<f32>(finalColor, rampColor.a);
}
