// PrimitiveMatBumpMapLit.wgsl
// Bump map material + Blinn-Phong lighting
// Perturbs surface normal using height differences from a texture
// Samples center, right, and top texels to compute tangent-space normal
// Uses RTE (Relative-To-Eye) for 64-bit precision at planetary scale
// Vertex: posHigh(3) + posLow(3) + normal(3) + st(2) = 11 floats = 44 bytes
// Matches CesiumJS Material.BumpMapType: image, channel, strength, repeat
//
// CSM Slice 2d — receives cascaded shadows through the primitive
// effects bind group at `@group(3)` (texture group occupies @group(2)).
//
// Batch 165 - B.12 chunk usage. Point-light cube shadow path calls
// csm_samplePointShadow from chunks/functions; the marker below tells
// WebGPUPrimitiveShaders.js to prepend the chunk's WGSL at load time.
// @chunk csm_samplePointShadow

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
    @location(3) eyePosition: vec3<f32>,
    //>>ifdef LOG_DEPTH
    // Interpolated linear depthFromNearPlusOne; the FS converts it to frag_depth.
    @location(7) v_logDepth: f32,
    //>>endif
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
    previousViewProjection: mat4x4<f32>,
    //>>ifdef LOG_DEPTH
    // ─── Renderer-wide log depth (Approach A) ───
    //   x = frustum near, y = frustum far,
    //   z = oneOverLog2FarDepthFromNearPlusOne (the log-depth factor),
    //   w = reserved. Packed by WebGPUPrimitiveCommands.writeRTEUniformsLit
    // into the 16-byte tail appended after previousViewProjection
    // (LIT_CAMERA_BYTES 304 -> 320). See WebGPULogDepth.ts.
    logDepth: vec4<f32>,
    //>>endif
}

// Material.BumpMapType fabric: { image: str, channel: "r", strength: f32, repeat: Cart2 }.
// `channel` is packed as an f32 index by MaterialUniformBuffer
// (r=0, g=1, b=2, a=3). Fabric order: channel, strength, repeat.
struct MaterialUniforms {
    channel: f32,
    strength: f32,
    repeat: vec2<f32>,
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var<uniform> material: MaterialUniforms;
@group(2) @binding(0) var textureSampler: sampler;
// DP-H20 (Batch 25) — BumpMap uses TWO textures:
//   @binding(1) diffuseTexture → base color (material uniform `image`)
//   @binding(2) bumpTexture    → height data for normal perturbation
//                                (material uniform `bumpMap`)
@group(2) @binding(1) var diffuseTexture: texture_2d<f32>;
@group(2) @binding(2) var bumpTexture: texture_2d<f32>;

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
    // Batch 165 - extends struct through pointLightPositionWC (offset
    // 336) for the B.12 point-light fields. edgeControl + edgeViewport
    // are padding only.
    edgeControl: vec4<f32>,
    edgeViewport: vec4<f32>,
    pointLightControl: vec4<f32>,
    pointLightPositionWC: vec4<f32>,
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
// FEAT-GAP-09 (Batch 201) — aerial-perspective LUT bindings 7/8/9.
// Populated by WebGPUEffectsBindGroup.js when atmosphere LUT is active;
// otherwise resolve to 1×1 placeholder textures. The shader gates all
// LUT sampling on `effects.atmosphereLutControl.x > 0.5` so the
// placeholder case costs only one uniform compare per fragment.
@group(3) @binding(7) var atmosphereTransmittanceLut: texture_2d<f32>;
@group(3) @binding(8) var atmosphereInscatterLut: texture_2d<f32>;
@group(3) @binding(9) var atmosphereLutSampler: sampler;
@group(3) @binding(10) var<uniform> csmParams: CSMParams;
@group(3) @binding(11) var cascadeDepthArray: texture_depth_2d_array;
// Batch 165 - B.12 point-light cube depth.
@group(3) @binding(17) var pointLightCubeDepth: texture_depth_cube;

//>>ifdef LOG_DEPTH
// Renderer-wide log depth (Approach A). These mirror the canonical definitions
// in PrimitivePhongColor.wgsl / Shaders/WebGPU/chunks/functions/csm_*LogDepth —
// keep them byte-compatible. near/far/factor come from camera.logDepth.
fn csm_vertexLogDepth(clipPosition: vec4<f32>, near: f32) -> f32 {
    return (clipPosition.w - near) + 1.0;
}
fn csm_updatePositionDepth(clipPosition: vec4<f32>) -> vec4<f32> {
    var coords = clipPosition;
    coords.z = clamp(coords.z / coords.w, 0.0, 1.0) * coords.w;
    return coords;
}
fn csm_writeLogDepth(depthFromNearPlusOne: f32, oneOverLog2FarDepthFromNearPlusOne: f32) -> f32 {
    return log2(depthFromNearPlusOne) * oneOverLog2FarDepthFromNearPlusOne;
}
// Per-fragment interpolated depthFromNearPlusOne, stashed by fragmentMain.
var<private> g_fragLogDepth: f32;
//>>endif

fn translateRelativeToEye(high: vec3<f32>, low: vec3<f32>) -> vec4<f32> {
    var highDiff = high - camera.encodedCameraHigh;
    if (length(highDiff) == 0.0) { highDiff = vec3<f32>(0.0); }
    let lowDiff = low - camera.encodedCameraLow;
    return vec4<f32>(highDiff + lowDiff, 1.0);
}

fn extractChannel(c: vec4<f32>, idx: f32) -> f32 {
    return c[clamp(i32(idx), 0, 3)];
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
    // CSM-PCF-SOFT: soften the cascade edge with a 3x3 PCF box kernel,
    // matching WebGL's czm_shadowVisibility USE_SOFT_SHADOWS path. The
    // kernel radius (in shadow texels) is effects.csmControl.y; 0 keeps
    // the original single hardware-comparison tap (hard edge).
    let csmPcfRadius = effects.csmControl.y;
    if (csmPcfRadius <= 0.0) {
      return textureSampleCompareLevel(
        cascadeDepthArray, shadowCompSampler, uv, i32(cascadeIdx), depth);
    }
    let csmDim = vec2<f32>(textureDimensions(cascadeDepthArray, 0));
    let csmTexel = csmPcfRadius / max(csmDim, vec2<f32>(1.0));
    var csmVis = 0.0;
    for (var sx: i32 = -1; sx <= 1; sx++) {
      for (var sy: i32 = -1; sy <= 1; sy++) {
        let csmOff = vec2<f32>(f32(sx), f32(sy)) * csmTexel;
        csmVis = csmVis + textureSampleCompareLevel(
            cascadeDepthArray, shadowCompSampler, uv + csmOff, i32(cascadeIdx), depth);
      }
    }
    return csmVis * (1.0 / 9.0);
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

// Batch 165 - B.12 chunk-based point-light receive.
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

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    let posRTE = translateRelativeToEye(input.positionHigh, input.positionLow);
    output.clipPosition = camera.mvpRelativeToEye * posRTE;
    output.worldNormal = (camera.normalMatrix * vec4<f32>(input.normal, 0.0)).xyz;
    output.viewPosition = (camera.modelViewRelativeToEye * posRTE).xyz;
    output.texCoord = input.texCoord;
    output.eyePosition = posRTE.xyz;

    //>>ifdef LOG_DEPTH
    // Renderer-wide log depth: interpolate linear depthFromNearPlusOne and clamp
    // clip-z so the FS-written log depth isn't pre-empted by clipping. near =
    // camera.logDepth.x; computed from clipPosition.w BEFORE the clamp.
    output.v_logDepth = csm_vertexLogDepth(output.clipPosition, camera.logDepth.x);
    output.clipPosition = csm_updatePositionDepth(output.clipPosition);
    //>>endif
    return output;
}

// Slice 5c-B Batch 121 — G-buffer MRT output struct (added by
// Tools/batch-121-wrap-lit-shaders.mjs). Slot 0 = lit color, slot 1 =
// eye-space normal + roughness. NormalMap / BumpMap variants emit the
// geometric vertex normal for now; a follow-up batch can switch them
// to their perturbed-normal variable for wider Slice 4 divergence.
struct FragOutput {
    @location(0) color: vec4<f32>,
    @location(1) normalRoughness: vec4<f32>,
    //>>ifdef LOG_DEPTH
    @builtin(frag_depth) depth: f32,
    //>>endif
};

@fragment
fn fragmentMain(input: VertexOutput) -> FragOutput {
    //>>ifdef LOG_DEPTH
    g_fragLogDepth = input.v_logDepth;
    //>>endif
    // Compute bumped normal from height map
    let texDims = vec2<f32>(textureDimensions(bumpTexture, 0));
    let uv = fract(input.texCoord * material.repeat);

    let ch = material.channel;
    let centerBump = extractChannel(
        textureSample(bumpTexture, textureSampler, uv),
        ch,
    );
    let rightBump = extractChannel(
        textureSample(
            bumpTexture, textureSampler,
            fract(uv + vec2<f32>(1.0 / texDims.x, 0.0)),
        ),
        ch,
    );
    let topBump = extractChannel(
        textureSample(
            bumpTexture, textureSampler,
            fract(uv + vec2<f32>(0.0, 1.0 / texDims.y)),
        ),
        ch,
    );

    // Tangent-space normal from height differences
    let bumpNormal = normalize(vec3<f32>(
        centerBump - rightBump,
        centerBump - topBump,
        clamp(1.0 - material.strength, 0.1, 1.0)
    ));

    // Approximate tangent-to-eye transformation using screen-space derivatives
    let N = normalize(input.worldNormal);
    let dPdx = dpdx(input.viewPosition);
    let dPdy = dpdy(input.viewPosition);
    let T = normalize(dPdx - N * dot(dPdx, N));
    let B = normalize(cross(N, T));
    let perturbedNormal = normalize(
        T * bumpNormal.x + B * bumpNormal.y + N * bumpNormal.z
    );

    // Blinn-Phong with perturbed normal
    let V = normalize(-input.viewPosition);
    let L = normalize(camera.lightDirection.xyz);

    let NdotL = max(dot(perturbedNormal, L), 0.0);
    let H = normalize(L + V);
    let NdotH = max(dot(perturbedNormal, H), 0.0);
    let specular = pow(NdotH, 64.0);

    let ambient = 0.5;
    // DP-H20 — read the actual diffuse texture instead of the
    // hardcoded gray (pre-Batch 25 bug). Sampled at the same UV as the
    // bump map so per-texel correspondence matches WebGL.
    let baseDiffuse = textureSample(diffuseTexture, textureSampler, uv).rgb;
    let ambientTerm = baseDiffuse * ambient;
    let diffuse = 0.5 * (max(dot(perturbedNormal, vec3<f32>(0.0, 0.0, 1.0)), 0.0) + max(dot(perturbedNormal, vec3<f32>(0.0, 1.0, 0.0)), 0.0));
    var directTerm = baseDiffuse * diffuse;
    var spec = vec3<f32>(specular * 0.3);

    // Batch 165 - point-light cube shadows take precedence over CSM.
    if (effects.pointLightControl.x > 0.5) {
        let cameraWC = camera.encodedCameraHigh + camera.encodedCameraLow;
        let fragWC = cameraWC + input.eyePosition;
        let shadowFactor = computeShadowFactorPointLight(fragWC);
        directTerm = directTerm * shadowFactor;
        spec = spec * shadowFactor;
    } else if (effects.csmControl.x > 0.5) {
        let viewDepth = abs(input.viewPosition.z);
        // Use the perturbed normal for shadow biasing (matches lighting normal).
        let shadowFactor = computeShadowFactorCSM(
            input.eyePosition, viewDepth, perturbedNormal, L,
        );
        directTerm = directTerm * shadowFactor;
        spec = spec * shadowFactor;
    }

    // Slice 5d Batch 155 — additive Forward+ clustered lighting on the
    // bump-perturbed eye-space normal. baseColor = textured albedo;
    // F0/roughness synthesized neutral dielectric (no PBR material).
    let clusteredContrib = evalClusteredLights(
        input.viewPosition, perturbedNormal, V,
        vec3<f32>(0.04), 0.5, baseDiffuse,
        input.clipPosition.xy, input.viewPosition.z,
    );
    var finalColor = vec4<f32>(
        ambientTerm + directTerm + spec + clusteredContrib,
        1.0,
    );

    // FEAT-GAP-09 (Batch 201) — aerial-perspective fog blend. Pattern
    // mirrors PrimitivePhongTexturedColor.wgsl. Single texture sample
    // pair (transmittance + inscatter) replaces the per-fragment ray
    // march. Gated on `atmosphereLutControl.x` so off-path costs one
    // uniform compare.
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
        let transmittance = clamp(
            (tSample.r + tSample.g + tSample.b) / 3.0, 0.0, 1.0,
        );
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

    // Slice 5c-B Batch 135 — emit the bump-perturbed normal (same as
    // the lighting eval) to G-buffer slot 1. See PrimitiveMatNormalMapLit
    // for the full rationale; Bump and NormalMap diverge in how the
    // perturbation is computed but the G-buffer consumer benefit is
    // identical.
    var mrtOut: FragOutput;
    mrtOut.color = finalColor;
    mrtOut.normalRoughness = vec4<f32>(perturbedNormal, 0.5);
    //>>ifdef LOG_DEPTH
    // Write logarithmic frag depth. factor = camera.logDepth.z.
    mrtOut.depth = csm_writeLogDepth(g_fragLogDepth, camera.logDepth.z);
    //>>endif
    return mrtOut;
}
