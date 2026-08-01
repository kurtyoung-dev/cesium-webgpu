// PrimitivePBRSimple.wgsl
// Simplified PBR (metallic-roughness) with per-vertex color
// Uses RTE (Relative-To-Eye) for 64-bit precision at planetary scale
// Vertex: posHigh(3) + posLow(3) + normal(3) + color(4) = 13 floats = 52 bytes
//
// CSM Slice 2d — receives cascaded shadows through the primitive
// effects bind group at `@group(2)` (no texture group between material
// and effects for this shader). The fragment path routes the direct
// (light-driven) radiance through `computeShadowFactorCSM` when
// `effects.csmControl.x > 0.5`; ambient stays unshadowed per PBR
// convention.
//
// Batch 165 - B.12 chunk usage. Point-light path calls
// `csm_samplePointShadow` from chunks/functions; the marker below tells
// WebGPUPrimitiveShaders.js to prepend the chunk's WGSL at load time.
// @chunk csm_samplePointShadow

struct VertexInput {
    @location(0) positionHigh: vec3<f32>,
    @location(1) positionLow: vec3<f32>,
    @location(2) normal: vec3<f32>,
    @location(3) color: vec4<f32>,
}

struct VertexOutput {
    @builtin(position) clipPosition: vec4<f32>,
    @location(0) color: vec4<f32>,
    @location(1) worldNormal: vec3<f32>,
    // View-space position (kept legacy name for diff minimization).
    // Consumers: `V = normalize(-viewPosition)` — view-space view dir.
    @location(2) viewPosition: vec3<f32>,
    // RTE (camera-relative world) position for CSM cascade VP sampling.
    // Same vector the globe + Phong receivers use.
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
    // DP-H41 (Batch 27) — previous frame's viewProjection for
    // TAA / motion-vector reprojection. Sourced from
    // `UniformState._previousViewProjection` (f32 mat4).
    previousViewProjection: mat4x4<f32>,
    inverseViewQuaternion: vec4<f32>,
    //>>ifdef LOG_DEPTH
    // ─── Renderer-wide log depth (Approach A) ───
    //   x = frustum near, y = frustum far,
    //   z = oneOverLog2FarDepthFromNearPlusOne (the log-depth factor),
    //   w = reserved. Packed by WebGPUPrimitiveCommands.writeRTEUniformsLit
    // into the 16-byte LIT UB tail (LIT_CAMERA_BYTES 320 -> 336).
    logDepth: vec4<f32>,
    //>>endif
}

struct MaterialUniforms {
    lightColor: vec4<f32>,
    metallic: f32,
    roughness: f32,
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var<uniform> material: MaterialUniforms;

// ─── Effects bind group (shadow receive + CSM + point-light cube depth) ───
// PBRSimple has no texture group, so effects lands at `@group(2)` —
// matches PrimitivePhongColor's convention. Layout MUST match the
// 480-byte UBO in WebGPUEffectsBindGroup.js. Struct extends through
// `pointLightPositionRTE` (offset 336) to expose the Batch 161
// point-light fields; the Batch 160 polygon-clipping array tail isn't
// used by primitives.
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
    // .x = csmEnabled flag. See ShadowReceiveCSM.wgsl.
    csmControl: vec4<f32>,
    // edgeControl + edgeViewport are unused on the primitive path but
    // kept as padding so the trailing point-light fields land at the
    // correct UBO offsets.
    edgeControl: vec4<f32>,
    edgeViewport: vec4<f32>,
    // Batch 161 — B.12 point-light cube-shadow receive control.
    pointLightControl: vec4<f32>,
    pointLightPositionRTE: vec4<f32>,
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

@group(2) @binding(0) var<uniform> effects: EffectsUniforms;
@group(2) @binding(1) var shadowDepthTex: texture_depth_2d;
@group(2) @binding(2) var shadowCompSampler: sampler_comparison;
// FEAT-GAP-09 — Aerial-perspective LUT. Bindings 7/8/9 are populated by
// WebGPUEffectsBindGroup.js when the atmosphere LUT is active; otherwise
// they resolve to 1×1 placeholder textures. Gated by
// `effects.atmosphereLutControl.x > 0.5` in fragmentMain.
@group(2) @binding(7) var atmosphereTransmittanceLut: texture_2d<f32>;
@group(2) @binding(8) var atmosphereInscatterLut: texture_2d<f32>;
@group(2) @binding(9) var atmosphereLutSampler: sampler;
@group(2) @binding(10) var<uniform> csmParams: CSMParams;
@group(2) @binding(11) var cascadeDepthArray: texture_depth_2d_array;
// Batch 161 — B.12 point-light cube depth target (placeholder 1×1×6
// cube cleared to 1.0 when point-light shadows are off; gated by
// `effects.pointLightControl.x > 0.5`).
@group(2) @binding(17) var pointLightCubeDepth: texture_depth_cube;

const PI: f32 = 3.14159265359;

//>>ifdef LOG_DEPTH
// Renderer-wide log depth (Approach A). Mirror of PrimitivePhongColor.wgsl —
// keep byte-compatible. near/far/factor come from camera.logDepth. The FS swaps
// to a FragOut struct so it can write @builtin(frag_depth) alongside the color.
struct FragOut {
    @location(0) color: vec4<f32>,
    @builtin(frag_depth) depth: f32,
}
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

fn rotateEyeToWorld(vector: vec3<f32>, quaternion: vec4<f32>) -> vec3<f32> {
    let t = 2.0 * cross(quaternion.xyz, vector);
    return vector + quaternion.w * t + cross(quaternion.xyz, t);
}

fn distributionGGX(N: vec3<f32>, H: vec3<f32>, roughness: f32) -> f32 {
    let a = roughness * roughness;
    let a2 = a * a;
    let NdotH = max(dot(N, H), 0.0);
    let NdotH2 = NdotH * NdotH;
    let denom = NdotH2 * (a2 - 1.0) + 1.0;
    return a2 / (PI * denom * denom);
}

fn geometrySmith(N: vec3<f32>, V: vec3<f32>, L: vec3<f32>, roughness: f32) -> f32 {
    let r = roughness + 1.0;
    let k = (r * r) / 8.0;
    let NdotV = max(dot(N, V), 0.0);
    let NdotL = max(dot(N, L), 0.0);
    let ggx1 = NdotV / (NdotV * (1.0 - k) + k);
    let ggx2 = NdotL / (NdotL * (1.0 - k) + k);
    return ggx1 * ggx2;
}

fn fresnelSchlick(cosTheta: f32, F0: vec3<f32>) -> vec3<f32> {
    return F0 + (1.0 - F0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
}

// ─── CSM helpers (inlined from PrimitivePhongColor) ───
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

// Batch 165 — B.12 chunk-based point-light receive. The Batch 161
// inline implementation has been replaced by a call to the reusable
// `csm_samplePointShadow` chunk function. See PrimitivePhongTexturedColor
// for the same pattern.
fn computeShadowFactorPointLight(fragRTE: vec3<f32>) -> f32 {
    if (effects.shadowDarkness >= 1.0) { return 1.0; }
    let visibility = csm_samplePointShadow(
        pointLightCubeDepth,
        shadowCompSampler,
        fragRTE,
        effects.pointLightPositionRTE.xyz,
        effects.pointLightControl.z,
        effects.pointLightControl.y,
        effects.pointLightControl.w,
        effects.pointLightPositionRTE.w,
        effects.shadowMapSize.x,
    );
    return mix(effects.shadowDarkness, 1.0, visibility);
}

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    let eyePos = translateRelativeToEye(input.positionHigh, input.positionLow);
    output.clipPosition = camera.mvpRelativeToEye * eyePos;
    output.color = input.color;

    let transformedNormal = normalize(
        mat3x3<f32>(
            camera.normalMatrix[0].xyz,
            camera.normalMatrix[1].xyz,
            camera.normalMatrix[2].xyz
        ) * input.normal
    );
    output.worldNormal = transformedNormal;
    let viewPosition = (camera.modelViewRelativeToEye * eyePos).xyz;
    output.viewPosition = viewPosition;
    output.eyePosition = rotateEyeToWorld(viewPosition, camera.inverseViewQuaternion);
    //>>ifdef LOG_DEPTH
    // Renderer-wide log depth: interpolate linear depthFromNearPlusOne and clamp
    // clip-z so the FS-written log depth isn't pre-empted by clipping.
    output.v_logDepth = csm_vertexLogDepth(output.clipPosition, camera.logDepth.x);
    output.clipPosition = csm_updatePositionDepth(output.clipPosition);
    //>>endif
    return output;
}

@fragment
//>>ifdef LOG_DEPTH
fn fragmentMain(input: VertexOutput) -> FragOut {
//>>else
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
//>>endif
    //>>ifdef LOG_DEPTH
    g_fragLogDepth = input.v_logDepth;
    //>>endif
    let albedo = input.color.rgb;
    let N = normalize(input.worldNormal);
    let V = normalize(-input.viewPosition);
    let L = normalize(camera.lightDirection.xyz);
    let H = normalize(V + L);

    let F0 = mix(vec3<f32>(0.04), albedo, material.metallic);

    let D = distributionGGX(N, H, material.roughness);
    let G = geometrySmith(N, V, L, material.roughness);
    let F = fresnelSchlick(max(dot(H, V), 0.0), F0);

    let NdotL = max(dot(N, L), 0.0);
    let numerator = D * G * F;
    let denominator = 4.0 * max(dot(N, V), 0.0) * NdotL + 0.0001;
    let specular = numerator / denominator;

    let kD = (1.0 - F) * (1.0 - material.metallic);
    let diffuse = kD * albedo / PI;

    // Direct lighting contribution (modulated by shadow factor below).
    var direct = (diffuse + specular) * material.lightColor.rgb * NdotL;

    // CSM Slice 2d / Batch 161 — route direct radiance through the
    // active shadow path when one is configured. Point-light cube
    // shadows take precedence over CSM (only one shadow map is active
    // at a time; checking pointLight first matches the Model FS gate
    // order so transitions stay coherent). Ambient stays unshadowed
    // per standard PBR convention (environment irradiance isn't
    // occluded by the active shadow map).
    if (effects.pointLightControl.x > 0.5) {
        let shadowFactor = computeShadowFactorPointLight(input.eyePosition);
        direct = direct * shadowFactor;
    } else if (effects.csmControl.x > 0.5) {
        // `viewDepth = |viewPosition.z|` because `viewPosition` here
        // is view-space (the field name is legacy).
        let viewDepth = abs(input.viewPosition.z);
        let shadowFactor = computeShadowFactorCSM(
            input.eyePosition,
            viewDepth,
            N,
            L,
        );
        direct = direct * shadowFactor;
    }

    let ambient = albedo * 0.03;
    let finalColorLinear = direct + ambient;

    // Tone mapping (Reinhard)
    let mapped = finalColorLinear / (finalColorLinear + 1.0);
    // Gamma correction
    let gamma = pow(mapped, vec3<f32>(1.0 / 2.2));

    var finalColor = vec4<f32>(gamma, input.color.a);

    // FEAT-GAP-09 — Aerial-perspective fog blend (Session 34 pattern).
    // Applied AFTER tonemap+gamma so the fog color is blended in display
    // space — matches how the PhongTexturedColor reference composites.
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

    //>>ifdef LOG_DEPTH
    return FragOut(finalColor, csm_writeLogDepth(g_fragLogDepth, camera.logDepth.z));
    //>>else
    return finalColor;
    //>>endif
}
