// Point Primitive Color Shader — WebGPU
// Renders points as instanced screen-space quads with circle + outline.
// WebGPU has no gl_PointSize/gl_PointCoord, so each point is a quad
// expanded in the vertex shader using vertex_index (0-5) for 2 triangles.

struct Uniforms {
    mvpMatrix: mat4x4<f32>,       // model-view-projection
    viewportSize: vec2<f32>,       // width, height in pixels
    splitPosition: f32,            // for split-screen (0.0 = disabled)
    _pad0: f32,
}

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) color: vec4<f32>,
    @location(1) outlineColor: vec4<f32>,
    @location(2) uv: vec2<f32>,
    @location(3) innerPercent: f32,
    @location(4) pixelDistance: f32,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

// Quad corners for 2 triangles (6 vertices per instance)
const QUAD_CORNERS = array<vec2<f32>, 6>(
    vec2<f32>(-0.5, -0.5),  // BL
    vec2<f32>( 0.5, -0.5),  // BR
    vec2<f32>( 0.5,  0.5),  // TR
    vec2<f32>(-0.5, -0.5),  // BL
    vec2<f32>( 0.5,  0.5),  // TR
    vec2<f32>(-0.5,  0.5),  // TL
);

@vertex
fn vertexMain(
    @builtin(vertex_index) vertexIndex: u32,
    // Per-instance attributes (step_mode = instance):
    @location(0) posHighAndSize: vec4<f32>,     // positionHigh.xyz, pixelSize
    @location(1) posLowAndOutline: vec4<f32>,   // positionLow.xyz, outlineWidth
    @location(2) pointColor: vec4<f32>,          // color rgba
    @location(3) outColorAndShow: vec4<f32>,     // outlineColor.rgb, show (0/1)
) -> VertexOutput {
    var output: VertexOutput;

    let show = outColorAndShow.w;
    if (show < 0.5) {
        output.position = vec4<f32>(0.0, 0.0, -2.0, 1.0);
        output.color = vec4<f32>(0.0);
        output.outlineColor = vec4<f32>(0.0);
        output.uv = vec2<f32>(0.0);
        output.innerPercent = 0.0;
        output.pixelDistance = 0.0;
        return output;
    }

    let posHigh = posHighAndSize.xyz;
    let posLow = posLowAndOutline.xyz;
    let pixelSize = posHighAndSize.w;
    let outlineWidth = posLowAndOutline.w;

    // Total rendered size including outline on both sides
    let totalSize = max(pixelSize + 2.0 * outlineWidth, 1.0);

    // Quad corner from vertex index (0-5)
    let corner = QUAD_CORNERS[vertexIndex % 6u];

    // Transform world position to clip space (RTE: high + low)
    let worldPos = vec4<f32>(posHigh + posLow, 1.0);
    let clipPos = uniforms.mvpMatrix * worldPos;

    // Screen-space offset: corner * totalSize pixels → NDC offset
    let ndcOffset = vec2<f32>(
        corner.x * totalSize * 2.0 / uniforms.viewportSize.x,
        corner.y * totalSize * 2.0 / uniforms.viewportSize.y,
    );

    // Apply offset in clip space (multiply by w to maintain after perspective divide)
    output.position = vec4<f32>(
        clipPos.x + ndcOffset.x * clipPos.w,
        clipPos.y + ndcOffset.y * clipPos.w,
        clipPos.z,
        clipPos.w,
    );

    output.uv = corner;
    output.color = pointColor;
    output.outlineColor = vec4<f32>(outColorAndShow.xyz, pointColor.a);
    output.innerPercent = select(0.0, pixelSize / totalSize, totalSize > 0.0);
    output.pixelDistance = select(0.0, 1.0 / totalSize, totalSize > 0.0);

    return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
    // Distance from center of the point (0 at center, ~0.707 at corner)
    let distanceToCenter = length(input.uv);

    // Anti-aliasing: stop 1 pixel shy of edge
    let maxDistance = max(0.0, 0.5 - input.pixelDistance);
    let wholeAlpha = 1.0 - smoothstep(maxDistance, 0.5, distanceToCenter);
    let innerAlpha = 1.0 - smoothstep(
        maxDistance * input.innerPercent,
        0.5 * input.innerPercent,
        distanceToCenter
    );

    // Mix outline and fill colors
    var color = mix(input.outlineColor, input.color, innerAlpha);
    color = vec4<f32>(color.rgb, color.a * wholeAlpha);

    if (color.a < 0.005) {
        discard;
    }

    return color;
}
