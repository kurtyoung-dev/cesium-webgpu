// Point Primitive Color Shader — WebGPU (with RTE precision)
// Renders points as instanced screen-space quads with circle + outline.
// WebGPU has no gl_PointSize/gl_PointCoord, so each point is a quad
// expanded in the vertex shader using vertex_index (0-5) for 2 triangles.
//
// Uses RTE (Relative-To-Eye) emulated 64-bit precision to eliminate
// jittering at planetary scale. Positions are encoded as high/low
// 32-bit float pairs and the encoded camera position is subtracted
// on the GPU to produce a small eye-relative offset.
//
// Batch 21 — unified CameraUniforms merges the former `MaterialUniforms`
// (bound at a non-existent @group(1)) with the existing CameraUniforms
// at @group(0). Pre-existing bug: the JS side only bound group 0, so any
// access to `material.*` read through a never-bound slot. Merging into
// the real UB also makes room for DP-H42 (`minimumDisableDepthTestDistance`)
// and wires `splitPosition` to something the JS actually uploads.

struct CameraUniforms {
    mvpRelativeToEye: mat4x4<f32>,            // bytes 0-63
    viewportSize: vec2<f32>,                   // bytes 64-71
    splitPosition: f32,                        // byte 72 (DP-H40)
    minimumDisableDepthTestDistance: f32,       // byte 76 (DP-H42)
    encodedCameraPositionMCHigh: vec3<f32>,    // bytes 80-91 (+4 pad)
    _pad0: f32,
    encodedCameraPositionMCLow: vec3<f32>,     // bytes 96-107 (+4 pad)
    _pad1: f32,
    // DP-H41 (Batch 27) — previous frame's viewProjection for
    // TAA / motion-vector reprojection. Sourced from
    // `UniformState._previousViewProjection` (f32 mat4).
    previousViewProjection: mat4x4<f32>,
}

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) color: vec4<f32>,
    @location(1) outlineColor: vec4<f32>,
    @location(2) uv: vec2<f32>,
    @location(3) innerPercent: f32,
    @location(4) pixelDistance: f32,
    //>>ifdef SPLIT_ENABLED
    @location(5) splitDirection: f32,
    //>>endif
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

// Quad corners for 2 triangles (6 vertices per instance)
const QUAD_CORNERS = array<vec2<f32>, 6>(
    vec2<f32>(-0.5, -0.5),  // BL
    vec2<f32>( 0.5, -0.5),  // BR
    vec2<f32>( 0.5,  0.5),  // TR
    vec2<f32>(-0.5, -0.5),  // BL
    vec2<f32>( 0.5,  0.5),  // TR
    vec2<f32>(-0.5,  0.5),  // TL
);

// RTE: Translate position relative to eye using emulated 64-bit precision
fn translateRelativeToEye(
    posHigh: vec3<f32>,
    posLow: vec3<f32>,
) -> vec4<f32> {
    var highDiff = posHigh - camera.encodedCameraPositionMCHigh;
    // NaN guard for devices where identical subtraction produces NaN (iOS)
    if (length(highDiff) == 0.0) {
        highDiff = vec3<f32>(0.0, 0.0, 0.0);
    }
    let lowDiff = posLow - camera.encodedCameraPositionMCLow;
    return vec4<f32>(highDiff + lowDiff, 1.0);
}

@vertex
fn vertexMain(
    @builtin(vertex_index) vertexIndex: u32,
    // Per-instance attributes (step_mode = instance):
    @location(0) posHighAndSize: vec4<f32>,     // positionHigh.xyz, pixelSize
    @location(1) posLowAndOutline: vec4<f32>,   // positionLow.xyz, outlineWidth
    @location(2) pointColor: vec4<f32>,          // color rgba
    @location(3) outColorAndShow: vec4<f32>,     // outlineColor.rgb, show (0/1)
    // DP-H42 / DP-H40 — perInstanceFlags. Same contract as Billboard:
    //   x = disableDepthTestDistance (meters; squared in shader)
    //   y = splitDirection (-1 / 0 / +1)
    //   z, w = reserved
    @location(4) perInstanceFlags: vec4<f32>,
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
        //>>ifdef SPLIT_ENABLED
        output.splitDirection = 0.0;
        //>>endif
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

    // RTE: compute eye-relative position with emulated 64-bit precision
    // This eliminates jittering at planetary-scale coordinates
    let eyeRelativePos = translateRelativeToEye(posHigh, posLow);
    var clipPos = camera.mvpRelativeToEye * eyeRelativePos;

    // Screen-space offset: corner * totalSize pixels → NDC offset
    let ndcOffset = vec2<f32>(
        corner.x * totalSize * 2.0 / camera.viewportSize.x,
        corner.y * totalSize * 2.0 / camera.viewportSize.y,
    );

    // Apply offset in clip space (multiply by w to maintain after perspective divide)
    clipPos = vec4<f32>(
        clipPos.x + ndcOffset.x * clipPos.w,
        clipPos.y + ndcOffset.y * clipPos.w,
        clipPos.z,
        clipPos.w,
    );

    //>>ifdef DISABLE_DEPTH_DISTANCE
    // DP-H42 — override depth when within the per-instance or frame-wide
    // `disableDepthTestDistance`. See BillboardCollection.wgsl for
    // derivation; eye-relative distance squared is `dot(rte, rte)`.
    var disableDepthSq = perInstanceFlags.x * perInstanceFlags.x;
    if (disableDepthSq == 0.0 && camera.minimumDisableDepthTestDistance != 0.0) {
        disableDepthSq =
            camera.minimumDisableDepthTestDistance *
            camera.minimumDisableDepthTestDistance;
    }
    if (disableDepthSq != 0.0) {
        let distSq = dot(eyeRelativePos.xyz, eyeRelativePos.xyz);
        if (disableDepthSq < 0.0 || distSq < disableDepthSq) {
            clipPos.z = clipPos.w;
        }
    }
    //>>endif

    output.position = clipPos;

    output.uv = corner;
    output.color = pointColor;
    output.outlineColor = vec4<f32>(outColorAndShow.xyz, pointColor.a);
    output.innerPercent = select(0.0, pixelSize / totalSize, totalSize > 0.0);
    output.pixelDistance = select(0.0, 1.0 / totalSize, totalSize > 0.0);

    //>>ifdef SPLIT_ENABLED
    // DP-H40 — forward split direction for per-fragment discard.
    output.splitDirection = perInstanceFlags.y;
    //>>endif

    return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
    //>>ifdef SPLIT_ENABLED
    // DP-H40 — discard pixels on the wrong side of the split cutoff.
    if (input.splitDirection < 0.0 && input.position.x > camera.splitPosition) {
        discard;
    }
    if (input.splitDirection > 0.0 && input.position.x < camera.splitPosition) {
        discard;
    }
    //>>endif

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
