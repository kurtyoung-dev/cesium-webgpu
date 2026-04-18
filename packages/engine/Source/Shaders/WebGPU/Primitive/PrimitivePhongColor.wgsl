// PrimitivePhongColor.wgsl
// Per-vertex color + Blinn-Phong lighting + shadow receive + clipping planes
// Uses RTE (Relative-To-Eye) for 64-bit precision at planetary scale
//
// Two vertex layouts — selected at pipeline-build time via the
// `COMPRESSED_VERTICES` define (DP-H19-SHADER-DECODE):
//   default : posHigh(3) + posLow(3) + normal(3)  + color(4) = 13 floats
//   compressed : posHigh(3) + posLow(3) + compressedAttributes(1 f32) + color(4)
// When COMPRESSED_VERTICES is on, the vertex stage decodes the normal
// via csm_octDecodeFloat_single (see csm_decodeCompressedVertex.wgsl).

//>>ifdef COMPRESSED_VERTICES
struct VertexInput {
    @location(0) positionHigh: vec3<f32>,
    @location(1) positionLow: vec3<f32>,
    @location(2) compressedAttributes: f32,
    @location(3) color: vec4<f32>,
}
//>>else
struct VertexInput {
    @location(0) positionHigh: vec3<f32>,
    @location(1) positionLow: vec3<f32>,
    @location(2) normal: vec3<f32>,
    @location(3) color: vec4<f32>,
}
//>>endif

struct VertexOutput {
    @builtin(position) clipPosition: vec4<f32>,
    @location(0) color: vec4<f32>,
    @location(1) worldNormal: vec3<f32>,
    @location(2) viewPosition: vec3<f32>,
    @location(3) eyePosition: vec3<f32>,
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
    // DP-H41 (Batch 27) — previous frame's viewProjection for
    // TAA / motion-vector reprojection. Sourced from
    // `UniformState._previousViewProjection` (f32 mat4).
    previousViewProjection: mat4x4<f32>,
}

struct MaterialUniforms {
    _placeholder: vec4<f32>,
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var<uniform> material: MaterialUniforms;

// ─── Effects bind group (shadow receive + clipping) ───
struct EffectsUniforms {
    shadowMatrix: mat4x4<f32>,
    shadowMapSize: vec2<f32>,
    shadowDarkness: f32,
    shadowSoftShadows: f32,
    clippingPlaneCount: u32,
    clippingUnionMode: u32,
    clippingEdgeWidth: f32,
    clippingPolygonCount: u32,
    clippingEdgeColor: vec4<f32>,
    clipPlaneEqHW: array<vec4<f32>, 8>,
}

@group(2) @binding(0) var<uniform> effects: EffectsUniforms;
@group(2) @binding(1) var shadowDepthTex: texture_depth_2d;
@group(2) @binding(2) var shadowCompSampler: sampler_comparison;
@group(2) @binding(3) var clippingPlaneTex: texture_2d<f32>;
@group(2) @binding(4) var clippingPlaneSampler: sampler;

fn translateRelativeToEye(high: vec3<f32>, low: vec3<f32>) -> vec4<f32> {
    var highDiff = high - camera.encodedCameraHigh;
    if (length(highDiff) == 0.0) { highDiff = vec3<f32>(0.0); }
    let lowDiff = low - camera.encodedCameraLow;
    return vec4<f32>(highDiff + lowDiff, 1.0);
}

//>>ifdef COMPRESSED_VERTICES
// DP-H19-SHADER-DECODE (Batch 27) — inline oct-decode for a single
// packed normal (PhongColor consumes only `normal`, no tangent/bitangent
// or UVs). Mirror of csm_decodeCompressedVertex.wgsl — kept inline to
// avoid pulling in the shared chunk until the #import pipeline covers
// Primitive shaders. CPU reference: AttributeCompression.octDecodeFloat.
fn csm_octDecodeFloat_single(value: f32) -> vec3<f32> {
    let temp = value / 256.0;
    let x = floor(temp);
    let y = (temp - x) * 256.0;
    let e = vec2<f32>(x, y) / 255.0 * 2.0 - 1.0;
    var v = vec3<f32>(e.x, e.y, 1.0 - abs(e.x) - abs(e.y));
    if (v.z < 0.0) {
        let s = vec2<f32>(
            select(-1.0, 1.0, v.x >= 0.0),
            select(-1.0, 1.0, v.y >= 0.0),
        );
        v = vec3<f32>((1.0 - abs(v.yx)) * s, v.z);
    }
    return normalize(v);
}
//>>endif

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    let eyePos = translateRelativeToEye(input.positionHigh, input.positionLow);
    output.clipPosition = camera.mvpRelativeToEye * eyePos;
    output.color = input.color;
    output.eyePosition = eyePos.xyz;

    //>>ifdef COMPRESSED_VERTICES
    let decodedNormal = csm_octDecodeFloat_single(input.compressedAttributes);
    //>>else
    let decodedNormal = input.normal;
    //>>endif

    let transformedNormal = normalize(
        mat3x3<f32>(
            camera.normalMatrix[0].xyz,
            camera.normalMatrix[1].xyz,
            camera.normalMatrix[2].xyz
        ) * decodedNormal
    );
    output.worldNormal = transformedNormal;
    output.viewPosition = (camera.modelViewRelativeToEye * eyePos).xyz;

    return output;
}

// ─── Shadow sampling ───
fn sampleShadowPCF(uv: vec2<f32>, depth: f32, texelSize: vec2<f32>) -> f32 {
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 || depth > 1.0) {
        return 1.0;
    }
    var shadow: f32 = 0.0;
    for (var x: i32 = -1; x <= 1; x++) {
        for (var y: i32 = -1; y <= 1; y++) {
            let offset = vec2<f32>(f32(x), f32(y)) * texelSize;
            shadow += textureSampleCompare(shadowDepthTex, shadowCompSampler, uv + offset, depth);
        }
    }
    return shadow / 9.0;
}

fn computeShadowFactor(eyePos: vec3<f32>) -> f32 {
    if (effects.shadowDarkness >= 1.0) { return 1.0; }

    let shadowPos = effects.shadowMatrix * vec4<f32>(eyePos, 1.0);
    let coord = shadowPos.xyz / shadowPos.w;
    let uv = vec2<f32>(coord.x * 0.5 + 0.5, 1.0 - (coord.y * 0.5 + 0.5));
    let texelSize = 1.0 / effects.shadowMapSize;

    var visibility: f32;
    if (effects.shadowSoftShadows > 0.5) {
        visibility = sampleShadowPCF(uv, coord.z, texelSize);
    } else {
        if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 || coord.z > 1.0) {
            visibility = 1.0;
        } else {
            visibility = textureSampleCompare(shadowDepthTex, shadowCompSampler, uv, coord.z);
        }
    }
    return mix(effects.shadowDarkness, 1.0, visibility);
}

// ─── Clipping planes ───
fn clipByPlanes(eyePos: vec3<f32>) -> bool {
    let count = effects.clippingPlaneCount;
    if (count == 0u) { return false; }

    let isUnion = effects.clippingUnionMode == 1u;
    let texWidth = f32(count);
    var clippedCount: u32 = 0u;

    for (var i: u32 = 0u; i < count; i++) {
        let texelU = (f32(i) + 0.5) / texWidth;
        let planeData = textureSampleLevel(clippingPlaneTex, clippingPlaneSampler,
                                           vec2<f32>(texelU, 0.5), 0.0);
        let dist = dot(eyePos, planeData.xyz) + planeData.w;
        if (dist < 0.0) {
            clippedCount++;
            if (isUnion) { return true; }
        }
    }

    if (!isUnion && clippedCount == count) { return true; }
    return false;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
    // Clipping plane discard (early out)
    if (clipByPlanes(input.eyePosition)) { discard; }

    // Clipping edge highlight
    if (effects.clippingPlaneCount > 0u && effects.clippingEdgeWidth > 0.0) {
        let count = effects.clippingPlaneCount;
        let texWidth = f32(count);
        var minDist: f32 = 1e10;
        for (var i: u32 = 0u; i < count; i++) {
            let texelU = (f32(i) + 0.5) / texWidth;
            let planeData = textureSampleLevel(clippingPlaneTex, clippingPlaneSampler,
                                               vec2<f32>(texelU, 0.5), 0.0);
            let dist = abs(dot(input.eyePosition, planeData.xyz) + planeData.w);
            minDist = min(minDist, dist);
        }
        if (minDist < effects.clippingEdgeWidth) {
            return effects.clippingEdgeColor;
        }
    }

    let normal = normalize(input.worldNormal);
    let lightDir = normalize(camera.lightDirection.xyz);

    let ambient = 0.15;
    let NdotL = max(dot(normal, lightDir), 0.0);
    let diffuse = NdotL * 0.7;

    let viewDir = normalize(-input.viewPosition);
    let halfDir = normalize(lightDir + viewDir);
    let NdotH = max(dot(normal, halfDir), 0.0);
    let specular = pow(NdotH, 32.0) * 0.15;

    let shadowFactor = computeShadowFactor(input.eyePosition);
    let lighting = ambient + (diffuse + specular) * shadowFactor;
    return vec4<f32>(input.color.rgb * lighting, input.color.a);
}
