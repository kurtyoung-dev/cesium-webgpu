// PrimitivePhongTexturedColor.wgsl
// Blinn-Phong lighting + texture sampling + per-instance color + shadow + clipping
// Uses RTE (Relative-To-Eye) for 64-bit precision at planetary scale
// Vertex: posHigh(3) + posLow(3) + normal(3) + uv(2) + color(4) = 15 floats = 60 bytes

struct VertexInput {
    @location(0) positionHigh: vec3<f32>,
    @location(1) positionLow: vec3<f32>,
    @location(2) normal: vec3<f32>,
    @location(3) texCoord: vec2<f32>,
    @location(4) color: vec4<f32>,
}

struct VertexOutput {
    @builtin(position) clipPosition: vec4<f32>,
    @location(0) color: vec4<f32>,
    @location(1) worldNormal: vec3<f32>,
    @location(2) viewPosition: vec3<f32>,
    @location(3) texCoord: vec2<f32>,
    // eyePosition is the RTE-precise camera-relative position
    // ((posHigh-camHigh) + (posLow-camLow)). Both the single-shadow-map
    // path (`shadowMatrix * vec4(eyePosition,1)`) and the CSM path
    // (`cascadeVP_RTE * vec4(eyePosition,1)`) read it — keeping a single
    // varying avoids the lossy FP32 reconstruction of world-space
    // position that the removed @location(5) `worldPosition` used to do.
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

// ─── Texture bind group ───
@group(2) @binding(0) var textureSampler: sampler;
@group(2) @binding(1) var colorTexture: texture_2d<f32>;

// ─── Effects bind group (shadow receive + clipping + atmosphere + CSM) ───
// Must match the 272-byte layout in WebGPUEffectsBindGroup.js. The
// primitive shader doesn't consume atmosphereLutControl (no fog path
// here) but the struct size must match what the UBO provides so
// trailing field offsets (csmControl) line up correctly.
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
    // Atmosphere LUT control — unused by primitive receivers but the
    // struct offset must match (otherwise csmControl below lands in
    // the wrong bytes).
    atmosphereLutControl: vec4<f32>,
    // CSM control: .x = csmEnabled flag. See ShadowReceiveCSM.wgsl.
    csmControl: vec4<f32>,
}

// CSM cascade parameters (bindings 10/11). Layout matches
// `WebGPUCSMRenderer._cascadeParamsData` (272 floats, 1088 bytes).
// The VP matrices are RTE-aware — multiply by `eyePosition` (NOT a
// lossy reconstructed worldPos) so the cascade sampling keeps full RTE
// precision. Placeholder zero-filled when CSM is off; the shader gates
// on `effects.csmControl.x > 0.5` before sampling.
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
@group(3) @binding(3) var clippingPlaneTex: texture_2d<f32>;
@group(3) @binding(4) var clippingPlaneSampler: sampler;
// FEAT-GAP-09 — Aerial-perspective LUT. Bindings 7/8/9 are populated by
// WebGPUEffectsBindGroup.js when the atmosphere LUT is active; otherwise
// they resolve to 1×1 placeholder textures. The shader gates all LUT
// sampling on `effects.atmosphereLutControl.x > 0.5` so the placeholder
// case costs only one uniform compare per fragment.
@group(3) @binding(7) var atmosphereTransmittanceLut: texture_2d<f32>;
@group(3) @binding(8) var atmosphereInscatterLut: texture_2d<f32>;
@group(3) @binding(9) var atmosphereLutSampler: sampler;
@group(3) @binding(10) var<uniform> csmParams: CSMParams;
@group(3) @binding(11) var cascadeDepthArray: texture_depth_2d_array;

fn translateRelativeToEye(high: vec3<f32>, low: vec3<f32>) -> vec4<f32> {
    var highDiff = high - camera.encodedCameraHigh;
    if (length(highDiff) == 0.0) { highDiff = vec3<f32>(0.0); }
    let lowDiff = low - camera.encodedCameraLow;
    return vec4<f32>(highDiff + lowDiff, 1.0);
}

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    let eyePos = translateRelativeToEye(input.positionHigh, input.positionLow);
    output.clipPosition = camera.mvpRelativeToEye * eyePos;
    output.color = input.color;
    output.texCoord = input.texCoord;
    output.eyePosition = eyePos.xyz;

    let transformedNormal = normalize(
        mat3x3<f32>(
            camera.normalMatrix[0].xyz,
            camera.normalMatrix[1].xyz,
            camera.normalMatrix[2].xyz
        ) * input.normal
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

// CSM — cascade selection + sampling. Inlined from ShadowReceiveCSM.wgsl
// (the WGSL preprocessor's #include path isn't wired for this shader
// yet; sharing the file across receivers is a Slice 2 follow-on).
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

// Per-cascade slope-scaled depth bias. Same formulation as the globe
// receiver: minBias floor + slope-bias that grows at grazing angles.
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

// CSM variant — takes RTE-aware eyePos + viewDepth + N + L. The caller
// routes here when `effects.csmControl.x > 0.5`. Uses
// `textureSampleCompareLevel` for uniform-control-flow safety (same
// reason as the globe receiver).
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

    let texColor = textureSample(colorTexture, textureSampler, input.texCoord);
    let baseColor = texColor * input.color;

    let normal = normalize(input.worldNormal);
    let lightDir = normalize(camera.lightDirection.xyz);

    let ambient = 0.15;
    let NdotL = max(dot(normal, lightDir), 0.0);
    let diffuse = NdotL * 0.7;

    let viewDir = normalize(-input.viewPosition);
    let halfDir = normalize(lightDir + viewDir);
    let NdotH = max(dot(normal, halfDir), 0.0);
    let specular = pow(NdotH, 32.0) * 0.15;

    // CSM Slice 1 — route through the cascaded path when
    // `effects.csmControl.x > 0.5`. viewDepth = |eyePosition.z| since
    // the eye-space looking -Z convention puts in-front points at
    // negative z. `input.eyePosition` is the RTE-precise camera-relative
    // vector from the vertex stage; feed it straight into the RTE-aware
    // cascade VPs (no reconstructed worldPos). N + L live in the same
    // space (both transformed by normalMatrix / camera), so nDotL is
    // frame-invariant for the slope-bias calc.
    var shadowFactor: f32;
    if (effects.csmControl.x > 0.5) {
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
    var finalColor = vec4<f32>(baseColor.rgb * lighting, baseColor.a);

    // FEAT-GAP-09 — Aerial-perspective fog blend. The LUT was pre-integrated
    // by AtmosphereLUT.wgsl with the current sun direction baked in; we
    // replace the per-fragment ray march with a single texture sample and
    // lerp the lit color toward the inscatter color by (1 - transmittance).
    //
    // Math mirrors `sampleAtmosphereFogLut` in GlobeTerrain.wgsl:
    //   - viewDir     = normalize(camera-to-fragment) — `eyePosition` is
    //     already the RTE-precise camera-relative vector, so it IS the
    //     world-space view direction (rotation is identity in RTE space).
    //   - cameraWC    = encodedCameraHigh + encodedCameraLow reconstructs
    //     the world-space camera position at FP32. The LUT is 256×64 so
    //     FP32 jitter in `cameraAltitude` is well below one texel.
    //   - cosZenith   = dot(viewDir, upDir) drives the U coordinate.
    //   - altitude/thickness drives V.
    if (effects.atmosphereLutControl.x > 0.5) {
        let innerRadius = effects.atmosphereLutControl.y;
        let thickness = max(1.0, effects.atmosphereLutControl.z);
        let cameraWC = camera.encodedCameraHigh + camera.encodedCameraLow;
        let viewDir = normalize(input.eyePosition);
        let upDir = normalize(cameraWC);
        let cosViewZenith = clamp(dot(viewDir, upDir), -1.0, 1.0);
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

        // Orbital-falloff — when the camera is above the atmosphere shell
        // the LUT lookup is extrapolated and fog should fade to zero.
        let excessAltitude = max(0.0, cameraAltitude - thickness);
        let orbitFalloff = exp(-excessAltitude / thickness);

        // Intensity is the LUT's .a channel (aerial-perspective weight),
        // modulated by the orbital-falloff. At the horizon this produces
        // a smooth transition from lit color to sky color.
        let fogWeight = clamp(iSample.a, 0.0, 1.0) * orbitFalloff;
        finalColor = vec4<f32>(
            mix(finalColor.rgb, iSample.rgb, fogWeight),
            finalColor.a,
        );
        // Optional transmittance attenuation — dims the direct terrain
        // contribution through thick fog. Gated by the .w flag so callers
        // can opt out (e.g., for cutout materials).
        if (effects.atmosphereLutControl.w > 0.5) {
            finalColor = vec4<f32>(
                finalColor.rgb * mix(1.0, transmittance, fogWeight),
                finalColor.a,
            );
        }
    }

    return finalColor;
}
