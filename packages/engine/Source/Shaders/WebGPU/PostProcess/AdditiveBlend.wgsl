// AdditiveBlend.wgsl — WGSL twin of Shaders/PostProcessStages/AdditiveBlend.glsl,
// the stage that composites the sun glow back over the scene.
//
// `colorTexture` carries the blurred bright-pass glow and `colorTexture2` the
// untouched scene, exactly as the GLSL twin binds them. The radial term is what
// bounds the glow: it is added in full inside `0.5 x radius` of the projected
// solar centre, tapers over `[0.5, 0.8]`, and is absent beyond `0.8 x radius`,
// so the glow cannot reach the far side of the frame however bright the source.
// Keep the two files in lockstep (SHADER_PAIRS_LOCKSTEP.md).

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
}

struct Uniforms {
    // Projected solar centre in drawing-buffer pixels, y up from the
    // bottom-left, as `SunHaloAppearance` publishes it.
    center: vec2<f32>,
    // Fade radius in drawing-buffer pixels. Zero disables the radial term and
    // makes the composite a plain sum, which is the honest reading of "the
    // projection could not locate the Sun".
    radius: f32,
    // Drawing-buffer height in pixels, for the y flip below.
    viewportHeight: f32,
}

@group(0) @binding(0) var colorTexture: texture_2d<f32>;
@group(0) @binding(1) var colorSampler: sampler;
@group(0) @binding(2) var colorTexture2: texture_2d<f32>;
@group(0) @binding(3) var colorSampler2: sampler;
@group(0) @binding(4) var<uniform> uniforms: Uniforms;

@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
    var output: VertexOutput;
    let x = f32(i32(vertexIndex & 1u) * 4 - 1);
    let y = f32(i32(vertexIndex >> 1u) * 4 - 1);
    output.position = vec4<f32>(x, y, 0.0, 1.0);
    output.uv = vec2<f32>((x + 1.0) * 0.5, (1.0 - y) * 0.5);
    return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
    let color0 = textureSample(colorTexture, colorSampler, input.uv);
    let color1 = textureSample(colorTexture2, colorSampler2, input.uv);
    if (!(uniforms.radius > 0.0)) {
        return color0 + color1;
    }
    // `@builtin(position)` is pixel-centred with y down from the top-left;
    // `gl_FragCoord` in the GLSL twin is y up from the bottom-left, and the
    // published centre is in that convention. One flip, at the only place that
    // knows which convention it is reading.
    let fragGL = vec2<f32>(
        input.position.x,
        uniforms.viewportHeight - input.position.y,
    );
    let x = length(fragGL - uniforms.center) / uniforms.radius;
    let t = smoothstep(0.5, 0.8, x);
    return mix(color0 + color1, color1, t);
}
