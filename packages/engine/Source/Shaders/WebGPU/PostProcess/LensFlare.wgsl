// Lens Flare post-processing effect — WGSL equivalent of LensFlare.glsl

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
}

struct LensFlareUniforms {
    intensity: f32,
    ghostDispersal: f32,
    haloWidth: f32,
    earthRadius: f32,
    lightWorldDirection: vec3<f32>,
    _pad0: f32,
    viewport: vec4<f32>,
}

@group(0) @binding(0) var colorTexture: texture_2d<f32>;
@group(0) @binding(1) var colorSampler: sampler;
@group(0) @binding(2) var<uniform> uniforms: LensFlareUniforms;

fn luminance(rgb: vec3<f32>) -> f32 {
    return dot(rgb, vec3<f32>(0.2125, 0.7154, 0.0721));
}

fn chromaticDistortion(texcoord: vec2<f32>, direction: vec2<f32>) -> vec3<f32> {
    let r = textureSample(colorTexture, colorSampler, texcoord + direction * 0.01).r;
    let g = textureSample(colorTexture, colorSampler, texcoord).g;
    let b = textureSample(colorTexture, colorSampler, texcoord - direction * 0.01).b;
    return vec3<f32>(r, g, b);
}

@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
    var pos = array<vec2<f32>, 3>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>(3.0, -1.0),
        vec2<f32>(-1.0, 3.0)
    );
    var uv = array<vec2<f32>, 3>(
        vec2<f32>(0.0, 1.0),
        vec2<f32>(2.0, 1.0),
        vec2<f32>(0.0, -1.0)
    );
    var output: VertexOutput;
    output.position = vec4<f32>(pos[vertexIndex], 0.0, 1.0);
    output.uv = uv[vertexIndex];
    return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
    let texCoord = input.uv;
    let originalColor = textureSample(colorTexture, colorSampler, texCoord);

    // Ghost vector toward center
    let ghostVec = (vec2<f32>(0.5) - texCoord) * uniforms.ghostDispersal;

    var result = vec3<f32>(0.0);
    let numGhosts = 4;

    // Sample ghosts
    for (var i = 0; i < numGhosts; i++) {
        let offset = fract(texCoord + ghostVec * f32(i));
        let ghostSample = textureSample(colorTexture, colorSampler, offset);
        let weight = length(vec2<f32>(0.5) - offset) / length(vec2<f32>(0.5));
        let w = pow(1.0 - weight, 10.0);
        result += ghostSample.rgb * w;
    }

    // Halo
    let haloVec = normalize(ghostVec) * uniforms.haloWidth;
    let haloWeight = length(vec2<f32>(0.5) - fract(texCoord + haloVec)) / length(vec2<f32>(0.5));
    let haloW = pow(1.0 - clamp(haloWeight, 0.0, 1.0), 5.0);
    result += textureSample(colorTexture, colorSampler, texCoord + haloVec).rgb * haloW;

    return vec4<f32>(originalColor.rgb + result * uniforms.intensity, originalColor.a);
}
