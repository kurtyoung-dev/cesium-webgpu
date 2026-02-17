// PrimitiveMatGridFlat.wgsl
// Procedural grid lines material, no lighting
// Vertex: position(3) + st(2) = 5 floats = 20 bytes
// Uniform: MVP(64) + color(16) + cellAlpha_lineCount(16) + lineThickness_lineOffset(16) = 112, padded to 256

struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) texCoord: vec2<f32>,
}

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) texCoord: vec2<f32>,
}

struct Uniforms {
    modelViewProjection: mat4x4<f32>,
    color: vec4<f32>,
    cellAlpha_lineCount: vec4<f32>,
    lineThickness_lineOffset: vec4<f32>,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    output.position = uniforms.modelViewProjection * vec4<f32>(input.position, 1.0);
    output.texCoord = input.texCoord;
    return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
    let cellAlpha = uniforms.cellAlpha_lineCount.x;
    let lineCountX = uniforms.cellAlpha_lineCount.y;
    let lineCountY = uniforms.cellAlpha_lineCount.z;
    let lineThicknessX = uniforms.lineThickness_lineOffset.x;
    let lineThicknessY = uniforms.lineThickness_lineOffset.y;
    let lineOffsetX = uniforms.lineThickness_lineOffset.z;
    let lineOffsetY = uniforms.lineThickness_lineOffset.w;

    let st = input.texCoord;
    let scaledX = fract((st.x - lineOffsetX) * lineCountX);
    let scaledY = fract((st.y - lineOffsetY) * lineCountY);

    let threshX = lineThicknessX / (1.0 / lineCountX) * 0.01;
    let threshY = lineThicknessY / (1.0 / lineCountY) * 0.01;

    let onLineX = f32(scaledX < threshX || scaledX > (1.0 - threshX));
    let onLineY = f32(scaledY < threshY || scaledY > (1.0 - threshY));
    let onLine = max(onLineX, onLineY);

    let alpha = mix(cellAlpha * uniforms.color.a, uniforms.color.a, onLine);
    return vec4<f32>(uniforms.color.rgb, alpha);
}
