// Adjust Translucent — WGSL equivalent of AdjustTranslucentFS.glsl
// Converts fragment color for OIT (Order-Independent Transparency).
// Weighted Blended OIT: accumulation and revealage targets.

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
}

struct AdjustTranslucentUniforms {
    useOIT: f32,
    _pad0: f32,
    _pad1: f32,
    _pad2: f32,
}

@group(0) @binding(0) var colorTexture: texture_2d<f32>;
@group(0) @binding(1) var colorSampler: sampler;
@group(0) @binding(2) var<uniform> uniforms: AdjustTranslucentUniforms;

fn alphaWeight(a: f32, z: f32) -> f32 {
    return clamp(a * max(1e-2, min(3e3, 10.0 / (1e-5 + pow(z / 5.0, 2.0) + pow(z / 200.0, 6.0)))), 1e-2, 3e2);
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

// For OIT MRT output:
// Location 0: accumulation (premultiplied color * weight)
// Location 1: revealage (alpha * weight, revealage)
struct OITOutput {
    @location(0) accumulation: vec4<f32>,
    @location(1) revealage: vec4<f32>,
}

@fragment
fn fragmentMainOIT(input: VertexOutput) -> OITOutput {
    let color = textureSample(colorTexture, colorSampler, input.uv);
    if (color.a == 0.0) {
        discard;
    }

    let z = input.position.z;
    let weight = alphaWeight(color.a, z);

    var output: OITOutput;
    output.accumulation = vec4<f32>(color.rgb * color.a, color.a) * weight;
    output.revealage = vec4<f32>(color.a);
    return output;
}

@fragment
fn fragmentMainNoOIT(input: VertexOutput) -> @location(0) vec4<f32> {
    return textureSample(colorTexture, colorSampler, input.uv);
}
