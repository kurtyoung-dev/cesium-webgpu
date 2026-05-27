// PrimitivePhongColor.wgsl
// Per-vertex color + Blinn-Phong lighting + shadow receive + clipping planes
// Uses RTE (Relative-To-Eye) for 64-bit precision at planetary scale
//
// Batch 165 - B.12 chunk usage. Point-light cube shadow path calls
// csm_samplePointShadow from chunks/functions; the marker below tells
// WebGPUPrimitiveShaders.js to prepend the chunk's WGSL at load time.
// @chunk csm_samplePointShadow
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

// ─── Effects bind group (shadow receive + clipping + atmosphere + CSM
// + point-light cube depth) ───
// PhongColor has no texture group, so the effects group lands at
// @group(2) (one slot earlier than PhongTexturedColor's @group(3)).
// Layout MUST match the 480-byte UBO in WebGPUEffectsBindGroup.js.
// Struct extends through `pointLightPositionWC` (offset 336) to expose
// the Batch 161/165 point-light fields; polygon-clipping array tail
// (Batch 160, offset 352+) isn't used by primitives.
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
    // Atmosphere LUT control — drives the fog-blend gate:
    //   .x = enabled flag (> 0.5 enables fog)
    //   .y = planet inner radius (m)
    //   .z = atmosphere thickness (m)
    //   .w = transmittance-attenuation flag (> 0.5 attenuates lit color)
    atmosphereLutControl: vec4<f32>,
    // CSM control: .x = csmEnabled flag. See ShadowReceiveCSM.wgsl.
    csmControl: vec4<f32>,
    // Padding — primitives don't run the inline edge stage but the
    // trailing point-light fields need their byte offsets to match.
    edgeControl: vec4<f32>,
    edgeViewport: vec4<f32>,
    // Batch 165 - B.12 point-light cube-shadow receive control.
    // .x = enabled flag; .y = farPlane; .z = nearPlane; .w = depthBias.
    pointLightControl: vec4<f32>,
    // .xyz = world-space light position; .w = pcfRadius (cube-face texels;
    // 0 = hard sample).
    pointLightPositionWC: vec4<f32>,
}

// CSM cascade parameters (bindings 10/11). Layout matches
// `WebGPUCSMRenderer._cascadeParamsData` (272 floats, 1088 bytes).
// The VP matrices are RTE-aware — multiply by `eyePosition` directly so
// the cascade sampling keeps full RTE precision at planetary scale.
// Placeholder zero-filled when CSM is off; the shader gates on
// `effects.csmControl.x > 0.5` before sampling.
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

@group(2) @binding(0) var<uniform> effects: EffectsUniforms;
@group(2) @binding(1) var shadowDepthTex: texture_depth_2d;
@group(2) @binding(2) var shadowCompSampler: sampler_comparison;
@group(2) @binding(3) var clippingPlaneTex: texture_2d<f32>;
@group(2) @binding(4) var clippingPlaneSampler: sampler;
// FEAT-GAP-09 — Aerial-perspective LUT. Bindings 7/8/9 are populated by
// WebGPUEffectsBindGroup.js when the atmosphere LUT is active; otherwise
// they resolve to 1×1 placeholder textures. The shader gates all LUT
// sampling on `effects.atmosphereLutControl.x > 0.5` so the placeholder
// case costs only one uniform compare per fragment.
@group(2) @binding(7) var atmosphereTransmittanceLut: texture_2d<f32>;
@group(2) @binding(8) var atmosphereInscatterLut: texture_2d<f32>;
@group(2) @binding(9) var atmosphereLutSampler: sampler;
@group(2) @binding(10) var<uniform> csmParams: CSMParams;
@group(2) @binding(11) var cascadeDepthArray: texture_depth_2d_array;
// Batch 165 - B.12 point-light cube depth target (placeholder 1×1×6
// cube cleared to 1.0 when point-light shadows are off; gated by
// effects.pointLightControl.x > 0.5).
@group(2) @binding(17) var pointLightCubeDepth: texture_depth_cube;

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
            shadow += textureSampleCompareLevel(shadowDepthTex, shadowCompSampler, uv + offset, depth);
        }
    }
    return shadow / 9.0;
}

// CSM — cascade selection + sampling. Inlined from ShadowReceiveCSM.wgsl
// (same contract as PrimitivePhongTexturedColor's CSM block).
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

// Batch 165 - B.12 chunk-based point-light receive. Calls
// csm_samplePointShadow (prepended at load by WebGPUPrimitiveShaders.js
// via the @chunk marker). fragWC reconstructed at the call site as
// cameraWC + eyePosition.
fn computeShadowFactorPointLight(fragWC: vec3<f32>) -> f32 {
    if (effects.shadowDarkness >= 1.0) { return 1.0; }
    let visibility = csm_samplePointShadow(
        pointLightCubeDepth,
        shadowCompSampler,
        fragWC,
        effects.pointLightPositionWC.xyz,
        effects.pointLightControl.z,
        effects.pointLightControl.y,
        effects.pointLightControl.w,
        effects.pointLightPositionWC.w,
        effects.shadowMapSize.x,
    );
    return mix(effects.shadowDarkness, 1.0, visibility);
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
            visibility = textureSampleCompareLevel(shadowDepthTex, shadowCompSampler, uv, coord.z);
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

// Slice 5c-B Batch 121 — G-buffer MRT output struct (added by
// Tools/batch-121-wrap-lit-shaders.mjs). Slot 0 = lit color, slot 1 =
// eye-space normal + roughness. NormalMap / BumpMap variants emit the
// geometric vertex normal for now; a follow-up batch can switch them
// to their perturbed-normal variable for wider Slice 4 divergence.
struct FragOutput {
    @location(0) color: vec4<f32>,
    @location(1) normalRoughness: vec4<f32>,
};

@fragment
fn fragmentMain(input: VertexOutput) -> FragOutput {
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
            // Slice 5d Batch 157 — emit a full FragOutput (color +
            // G-buffer normalRoughness). This early-return previously
            // returned a bare vec4, a latent type mismatch vs the
            // `-> FragOutput` signature that never compiled — it was
            // dormant because nothing routed to the `phong` shader until
            // the decode-before-select fix made PerInstanceColorAppearance
            // resolve to phong.
            var edgeOut: FragOutput;
            edgeOut.color = effects.clippingEdgeColor;
            edgeOut.normalRoughness = vec4<f32>(normalize(input.worldNormal), 0.5);
            return edgeOut;
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

    // CSM Slice 2b — route through the cascaded path when
    // `effects.csmControl.x > 0.5`. viewDepth = |eyePosition.z| since
    // the eye-space convention puts in-front points at negative z.
    // `input.eyePosition` is the RTE-precise camera-relative vector;
    // feed it straight into the RTE-aware cascade VPs.
    // Batch 165 - B.12 point-light cube shadows take precedence over
    // CSM / single-shadow-map paths (only one shadow map is active at
    // a time; matches Model FS gate order).
    var shadowFactor: f32;
    if (effects.pointLightControl.x > 0.5) {
        let cameraWC = camera.encodedCameraHigh + camera.encodedCameraLow;
        let fragWC = cameraWC + input.eyePosition;
        shadowFactor = computeShadowFactorPointLight(fragWC);
    } else if (effects.csmControl.x > 0.5) {
        let viewDepth = abs(input.eyePosition.z);
        shadowFactor = computeShadowFactorCSM(
            input.eyePosition,
            viewDepth,
            normal,
            lightDir,
        );
    } else {
        shadowFactor = computeShadowFactor(input.eyePosition);
    }
    let lighting = ambient + (diffuse + specular) * shadowFactor;
    // Slice 5d Batch 156 — additive Forward+ clustered lighting (eye-space
    // inputs; baseColor = per-vertex color; F0/roughness neutral dielectric
    // — Phong has no PBR material). Early-outs when no clustered lights.
    let clusteredContrib = evalClusteredLights(
        input.viewPosition, normal, viewDir,
        vec3<f32>(0.04), 0.5, input.color.rgb,
        input.clipPosition.xy, input.viewPosition.z,
    );
    var finalColor = vec4<f32>(input.color.rgb * lighting + clusteredContrib, input.color.a);

    // FEAT-GAP-09 — Aerial-perspective fog blend. Same math as the
    // PhongTexturedColor reference (Session 34): sample the pre-integrated
    // LUT by (cos view-zenith, camera altitude) and lerp lit color toward
    // inscatter by (1 - transmittance). See GlobeTerrain.wgsl::sampleAtmosphereFogLut.
    if (effects.atmosphereLutControl.x > 0.5) {
        let innerRadius = effects.atmosphereLutControl.y;
        let thickness = max(1.0, effects.atmosphereLutControl.z);
        let cameraWC = camera.encodedCameraHigh + camera.encodedCameraLow;
        let viewDirWS = normalize(input.eyePosition);
        let upDir = normalize(cameraWC);
        let cosViewZenith = clamp(dot(viewDirWS, upDir), -1.0, 1.0);
        let cameraAltitude = max(0.0, length(cameraWC) - innerRadius);
        let uCoord = clamp(cosViewZenith * 0.5 + 0.5, 0.0, 1.0);
        let vCoord = clamp(cameraAltitude / thickness, 0.0, 1.0);

        let tSample = textureSampleLevel(
            atmosphereTransmittanceLut, atmosphereLutSampler,
            vec2<f32>(uCoord, vCoord), 0.0,
        );
        let iSample = textureSampleLevel(
            atmosphereInscatterLut, atmosphereLutSampler,
            vec2<f32>(uCoord, vCoord), 0.0,
        );
        let transmittance =
            clamp((tSample.r + tSample.g + tSample.b) / 3.0, 0.0, 1.0);

        let excessAltitude = max(0.0, cameraAltitude - thickness);
        let orbitFalloff = exp(-excessAltitude / thickness);

        let fogWeight = clamp(iSample.a, 0.0, 1.0) * orbitFalloff;
        finalColor = vec4<f32>(
            mix(finalColor.rgb, iSample.rgb, fogWeight),
            finalColor.a,
        );
        if (effects.atmosphereLutControl.w > 0.5) {
            finalColor = vec4<f32>(
                finalColor.rgb * mix(1.0, transmittance, fogWeight),
                finalColor.a,
            );
        }
    }

    // Slice 5c-B Batch 121 — emit FragOutput. normalRoughness gets the
    // geometric eye-space normal (vertex shader writes worldNormal as
    // eye-space via camera.normalMatrix). Roughness 0.5 placeholder —
    // Lit Mat shaders don't carry material roughness in their UBOs.
    var mrtOut: FragOutput;
    mrtOut.color = finalColor;
    mrtOut.normalRoughness = vec4<f32>(normalize(input.worldNormal), 0.5);
    return mrtOut;
}
