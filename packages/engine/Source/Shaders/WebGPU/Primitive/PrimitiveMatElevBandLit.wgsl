// PrimitiveMatElevBandLit.wgsl
// ElevationBand material + Blinn-Phong lighting (DP-H22, Batch 25).
// Same banded color lookup as the Flat variant, then applies standard
// lit diffuse + specular. Useful when the primitive's geometry has
// real normals (e.g. ground-aligned terrain meshes) and the user
// wants the elevation banding to respond to sun direction.
//
// Vertex: posHigh(3) + posLow(3) + normal(3) + st(2) = 11 floats = 44 bytes.
//
// CSM Slice 2d — receives cascaded shadows through the primitive
// effects bind group at `@group(3)` (texture group occupies @group(2)).

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
    @location(3) height: f32,
    @location(4) eyePosition: vec3<f32>,
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
    _pad2: vec2<f32>,
    previousViewProjection: mat4x4<f32>,
}

struct MaterialUniforms {
    _pad: vec4<f32>,
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var<uniform> material: MaterialUniforms;
@group(2) @binding(0) var bandSampler: sampler;
@group(2) @binding(1) var heightsTexture: texture_2d<f32>;
@group(2) @binding(2) var colorsTexture: texture_2d<f32>;

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
    atmosphereLutControl: vec4<f32>,
    csmControl: vec4<f32>,
}

struct CSMParams {
    cascadeVP0: mat4x4<f32>,
    cascadeVP1: mat4x4<f32>,
    cascadeVP2: mat4x4<f32>,
    cascadeVP3: mat4x4<f32>,
    cascadeSplits: vec4<f32>,
    blendBands: vec4<f32>,
    cascadeMinBias: vec4<f32>,
    cascadeMaxSlopeBias: vec4<f32>,
}

@group(3) @binding(0) var<uniform> effects: EffectsUniforms;
@group(3) @binding(1) var shadowDepthTex: texture_depth_2d;
@group(3) @binding(2) var shadowCompSampler: sampler_comparison;
@group(3) @binding(10) var<uniform> csmParams: CSMParams;
@group(3) @binding(11) var cascadeDepthArray: texture_depth_2d_array;

const EARTH_RADIUS: f32 = 6371000.0;

fn translateRelativeToEye(high: vec3<f32>, low: vec3<f32>) -> vec4<f32> {
    var highDiff = high - camera.encodedCameraHigh;
    if (length(highDiff) == 0.0) { highDiff = vec3<f32>(0.0); }
    let lowDiff = low - camera.encodedCameraLow;
    return vec4<f32>(highDiff + lowDiff, 1.0);
}

fn getHeight(idx: i32, invTexSize: f32) -> f32 {
    let u = (f32(idx) + 0.5) * invTexSize;
    return textureSample(heightsTexture, bandSampler, vec2<f32>(u, 0.5)).x;
}

fn selectCascade(viewDepth: f32, splits: vec4<f32>) -> u32 {
    if (viewDepth < splits.x) { return 0u; }
    if (viewDepth < splits.y) { return 1u; }
    if (viewDepth < splits.z) { return 2u; }
    return 3u;
}

fn getCascadeVP(idx: u32) -> mat4x4<f32> {
    switch (idx) {
        case 0u: { return csmParams.cascadeVP0; }
        case 1u: { return csmParams.cascadeVP1; }
        case 2u: { return csmParams.cascadeVP2; }
        default: { return csmParams.cascadeVP3; }
    }
}

fn cascadeDepthBias(cascadeIdx: u32, normal: vec3<f32>, lightDir: vec3<f32>) -> f32 {
    let nDotL = clamp(dot(normalize(normal), normalize(lightDir)), 0.0, 1.0);
    let minBias = csmParams.cascadeMinBias[cascadeIdx];
    let maxSlope = csmParams.cascadeMaxSlopeBias[cascadeIdx];
    let slopeBias = maxSlope * (1.0 - nDotL);
    return max(minBias, slopeBias);
}

fn sampleOneCascade(eyePos: vec3<f32>, cascadeIdx: u32, depthBias: f32) -> f32 {
    let vp = getCascadeVP(cascadeIdx);
    let clipPos = vp * vec4<f32>(eyePos, 1.0);
    let ndc = clipPos.xyz / clipPos.w;
    let uv = vec2<f32>(ndc.x * 0.5 + 0.5, 1.0 - (ndc.y * 0.5 + 0.5));
    let depth = ndc.z - depthBias;
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 ||
        depth > 1.0 || depth < 0.0) {
        return 1.0;
    }
    return textureSampleCompareLevel(
        cascadeDepthArray,
        shadowCompSampler,
        uv,
        i32(cascadeIdx),
        depth,
    );
}

fn sampleCascadeShadow(
    eyePos: vec3<f32>,
    viewDepth: f32,
    normal: vec3<f32>,
    lightDir: vec3<f32>,
) -> f32 {
    let cascadeIdx = selectCascade(viewDepth, csmParams.cascadeSplits);
    let bias0 = cascadeDepthBias(cascadeIdx, normal, lightDir);
    let s0 = sampleOneCascade(eyePos, cascadeIdx, bias0);
    let splitDist = csmParams.cascadeSplits[cascadeIdx];
    let blendBand = csmParams.blendBands[cascadeIdx];
    let blendStart = splitDist - blendBand;
    if (viewDepth > blendStart && cascadeIdx < 3u) {
        let nextIdx = cascadeIdx + 1u;
        let bias1 = cascadeDepthBias(nextIdx, normal, lightDir);
        let s1 = sampleOneCascade(eyePos, nextIdx, bias1);
        let blendT = smoothstep(blendStart, splitDist, viewDepth);
        return mix(s0, s1, blendT);
    }
    return s0;
}

fn computeShadowFactorCSM(
    eyePos: vec3<f32>,
    viewDepth: f32,
    normal: vec3<f32>,
    lightDir: vec3<f32>,
) -> f32 {
    if (effects.shadowDarkness >= 1.0) { return 1.0; }
    let visibility = sampleCascadeShadow(eyePos, viewDepth, normal, lightDir);
    return mix(effects.shadowDarkness, 1.0, visibility);
}

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    let posRTE = translateRelativeToEye(input.positionHigh, input.positionLow);
    output.clipPosition = camera.mvpRelativeToEye * posRTE;
    output.worldNormal = (camera.normalMatrix * vec4<f32>(input.normal, 0.0)).xyz;
    output.viewPosition = (camera.modelViewRelativeToEye * posRTE).xyz;
    output.texCoord = input.texCoord;
    let worldPos = input.positionHigh + input.positionLow;
    output.height = length(worldPos) - EARTH_RADIUS;
    output.eyePosition = posRTE.xyz;
    return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
    let height = input.height;
    let texDims = vec2<f32>(textureDimensions(heightsTexture, 0));
    let texWidth = max(texDims.x, 1.0);
    let invTexSize = 1.0 / texWidth;
    let bandCount = i32(texWidth);

    let minHeight = getHeight(0, invTexSize);
    let maxHeight = getHeight(bandCount - 1, invTexSize);

    if (height < minHeight || height > maxHeight) {
        discard;
    }

    var idxBelow: i32 = 0;
    var idxAbove: i32 = bandCount;
    var heightBelow: f32 = minHeight;
    var heightAbove: f32 = maxHeight;
    for (var i: i32 = 0; i < 16; i = i + 1) {
        if (idxBelow >= idxAbove - 1) { break; }
        let idxMid = (idxBelow + idxAbove) / 2;
        let heightTex = getHeight(idxMid, invTexSize);
        if (height > heightTex) {
            idxBelow = idxMid;
            heightBelow = heightTex;
        } else {
            idxAbove = idxMid;
            heightAbove = heightTex;
        }
    }

    let span = heightAbove - heightBelow;
    let lerper = select((height - heightBelow) / span, 1.0, abs(span) < 1e-6);
    let colorU = invTexSize * (f32(idxBelow) + 0.5 + lerper);
    var bandColor = textureSample(colorsTexture, bandSampler, vec2<f32>(colorU, 0.5));
    if (bandColor.a > 0.0) {
        bandColor = vec4<f32>(bandColor.rgb / bandColor.a, bandColor.a);
    }

    // Blinn-Phong using the band color as the diffuse albedo.
    let N = normalize(input.worldNormal);
    let V = normalize(-input.viewPosition);
    let L = normalize(camera.lightDirection.xyz);
    let NdotL = max(dot(N, L), 0.0);
    let H = normalize(L + V);
    let NdotH = max(dot(N, H), 0.0);
    let specular = pow(NdotH, 64.0);

    let ambient = 0.15;
    let ambientTerm = bandColor.rgb * ambient;
    var directTerm = bandColor.rgb * NdotL * 0.85;
    var spec = vec3<f32>(specular * 0.3);

    if (effects.csmControl.x > 0.5) {
        let viewDepth = abs(input.viewPosition.z);
        let shadowFactor = computeShadowFactorCSM(
            input.eyePosition, viewDepth, N, L,
        );
        directTerm = directTerm * shadowFactor;
        spec = spec * shadowFactor;
    }

    return vec4<f32>(ambientTerm + directTerm + spec, bandColor.a);
}
