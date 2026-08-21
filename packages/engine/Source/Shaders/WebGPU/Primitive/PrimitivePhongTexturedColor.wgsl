// PrimitivePhongTexturedColor.wgsl
// Blinn-Phong lighting + texture sampling + per-instance color + shadow + clipping
// Uses RTE (Relative-To-Eye) for 64-bit precision at planetary scale
// Vertex: posHigh(3) + posLow(3) + normal(3) + uv(2) + color(4) = 15 floats = 60 bytes
//
// Point-light cube-shadow sampling uses `csm_samplePointShadow`; the marker
// below causes WebGPUPrimitiveShaders.js to prepend the shared function.
// @chunk csm_samplePointShadow

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
    // `eyePosition` is the RTE-precise camera-relative position. Both the
    // single-shadow-map and CSM paths consume this one varying, avoiding a
    // lossy FP32 reconstruction of world-space position.
    @location(4) eyePosition: vec3<f32>,
    //>>ifdef LOG_DEPTH
    // Interpolated linear depthFromNearPlusOne; the FS converts it to frag_depth.
    @location(5) v_logDepth: f32,
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
    // Previous frame's view-projection matrix for temporal antialiasing and
    // motion-vector reprojection, supplied by
    // `UniformState._previousViewProjection`.
    previousViewProjection: mat4x4<f32>,
    inverseViewQuaternion: vec4<f32>,
    // Renderer-wide logarithmic depth parameters:
    //   x = frustum near, y = frustum far,
    //   z = oneOverLog2FarDepthFromNearPlusOne (the log-depth factor),
    //   w = reserved.
    // Packed by WebGPUPrimitiveCommands.writeRTEUniformsLit into the
    // 16-byte tail appended after inverseViewQuaternion (LIT_CAMERA_BYTES
    // 320 -> 336). They are inert unless the LOG_DEPTH pipeline define is set.
    // See WebGPULogDepth.ts.
    logDepth: vec4<f32>,
}

struct MaterialUniforms {
    _placeholder: vec4<f32>,
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var<uniform> material: MaterialUniforms;

//>>ifdef LOG_DEPTH
// This fully inline shader mirrors the canonical logarithmic-depth definitions
// in chunks/functions/csm_{vertexLogDepth,writeLogDepth}.wgsl. The definitions
// must remain byte-compatible; near, far, and factor come from camera.logDepth.
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
// Per-fragment interpolated depthFromNearPlusOne, stashed by fragmentMain so
// the FragOutput return sites can write frag_depth without a parameter.
var<private> g_fragLogDepth: f32;
//>>endif

// ─── Texture bind group ───
@group(2) @binding(0) var textureSampler: sampler;
@group(2) @binding(1) var colorTexture: texture_2d<f32>;

// ─── Effects bind group (shadow receive + clipping + atmosphere + CSM
// + point-light cube depth) ───
// The layout matches the 480-byte UBO in WebGPUEffectsBindGroup.js. This
// shader consumes a prefix through `pointLightPositionRTE` at offset 336;
// retaining intervening fields keeps the trailing offsets correct. The
// polygon-clipping array tail is not consumed.
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
    // edgeControl + edgeViewport: padding only — primitives don't
    // run the inline edge stage, but the trailing fields after them
    // (`pointLightControl`, `pointLightPositionRTE`) need their byte
    // offsets to match the UBO.
    edgeControl: vec4<f32>,
    edgeViewport: vec4<f32>,
    // Point-light cube-shadow receive control.
    // .x = enabled flag; .y = farPlane; .z = nearPlane; .w = depthBias.
    // See `samplePointShadow` below; mirrors `ModelPBRComplete.wgsl`.
    pointLightControl: vec4<f32>,
    // .xyz = camera-relative light position in world axes; .w = pcfRadius
    // (cube-face texels; 0 = hard sample).
    pointLightPositionRTE: vec4<f32>,
}

// CSM cascade parameters (bindings 10/11). Layout matches
// `WebGPUCSMRenderer._cascadeParamsData` (272 floats, 1088 bytes).
// The VP matrices are RTE-aware — multiply by `eyePosition` rather than a
// lossy reconstructed worldPos so the cascade sampling keeps full RTE
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
// Aerial-perspective lookup bindings use live textures while the atmosphere
// LUT is active and 1-by-1 placeholders otherwise. The control flag gates all
// sampling, leaving only one uniform comparison on the disabled path.
@group(3) @binding(7) var atmosphereTransmittanceLut: texture_2d<f32>;
@group(3) @binding(8) var atmosphereInscatterLut: texture_2d<f32>;
@group(3) @binding(9) var atmosphereLutSampler: sampler;
@group(3) @binding(10) var<uniform> csmParams: CSMParams;
@group(3) @binding(11) var cascadeDepthArray: texture_depth_2d_array;
// `_renderPointLightCubeCastPasses` populates the six-face depth32float cube.
// `pointLightControl.x` gates sampling through `shadowCompSampler`; a
// 1-by-1-by-6 cube cleared to 1.0 serves as the disabled-path placeholder.
@group(3) @binding(17) var pointLightCubeDepth: texture_depth_cube;

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

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    let eyePos = translateRelativeToEye(input.positionHigh, input.positionLow);
    output.clipPosition = camera.mvpRelativeToEye * eyePos;
    output.color = input.color;
    output.texCoord = input.texCoord;
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
    // Renderer-wide log depth: interpolate the linear depthFromNearPlusOne and
    // clamp clip-z so the FS-written log depth isn't pre-empted by clipping.
    output.v_logDepth = csm_vertexLogDepth(output.clipPosition, camera.logDepth.x);
    output.clipPosition = csm_updatePositionDepth(output.clipPosition);
    //>>endif

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

// Cascade selection and sampling are inlined from ShadowReceiveCSM.wgsl
// because this shader does not use the WGSL preprocessor include path.
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
    // A 3-by-3 percentage-closer-filtering kernel softens cascade edges,
    // matching WebGL's `czm_shadowVisibility` soft-shadow path. The radius in
    // shadow texels is `effects.csmControl.y`; zero selects one hardware
    // comparison tap and a hard edge.
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

// Point-light receive uses the shared `csm_samplePointShadow` chunk, declared
// by WebGPUPrimitiveShaders.js `injectChunks`. It applies dominant-axis
// perspective depth, scale-bias remapping, and optional five-tap cross PCF.
// The `@chunk` marker above requests the shared function.
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

fn computeShadowFactor(eyePos: vec3<f32>) -> f32 {
    if (effects.shadowDarkness >= 1.0) { return 1.0; }

    let shadowPos = effects.shadowMatrix * vec4<f32>(eyePos, 1.0);
    // Already WebGPU shadow-texture space — scale/bias from
    // `ShadowMap.getViewProjection`, v-origin flip from
    // `toWebGPUShadowReceiveMatrix` (`WebGPUShadowReceiveTransform.ts`).
    let coord = shadowPos.xyz / shadowPos.w;
    let uv = coord.xy;
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

// G-buffer output: slot 0 stores lit color; slot 1 stores the eye-space
// normal and roughness.
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
    // Stash the interpolated log-depth varying so both FragOutput return
    // sites below (edgeOut early-return + final mrtOut) can write frag_depth.
    g_fragLogDepth = input.v_logDepth;
    //>>endif

    // Clipping plane discard (early out)
    if (clipByPlanes(input.viewPosition)) { discard; }

    // Clipping edge highlight
    if (effects.clippingPlaneCount > 0u && effects.clippingEdgeWidth > 0.0) {
        let count = effects.clippingPlaneCount;
        let texWidth = f32(count);
        var minDist: f32 = 1e10;
        for (var i: u32 = 0u; i < count; i++) {
            let texelU = (f32(i) + 0.5) / texWidth;
            let planeData = textureSampleLevel(clippingPlaneTex, clippingPlaneSampler,
                                               vec2<f32>(texelU, 0.5), 0.0);
            let dist = abs(dot(input.viewPosition, planeData.xyz) + planeData.w);
            minDist = min(minDist, dist);
        }
        if (minDist < effects.clippingEdgeWidth) {
            // Every return site initializes the full fragment output, including
            // the G-buffer normal and roughness attachment.
            var edgeOut: FragOutput;
            edgeOut.color = effects.clippingEdgeColor;
            edgeOut.normalRoughness = vec4<f32>(normalize(input.worldNormal), 0.5);
            //>>ifdef LOG_DEPTH
            edgeOut.depth = csm_writeLogDepth(g_fragLogDepth, camera.logDepth.z);
            //>>endif
            return edgeOut;
        }
    }

    let texColor = textureSample(colorTexture, textureSampler, input.texCoord);
    let baseColor = texColor * input.color;

    let normal = normalize(input.worldNormal);
    // `lightDir` is consumed by CSM slope bias and cascade sampling, not by the
    // diffuse term.
    let lightDir = normalize(camera.lightDirection.xyz);
    let viewDir = normalize(-input.viewPosition);

    // Match `czm_phong` for lit color and material appearances. Diffuse uses
    // fixed eye-space +Z and +Y light directions and folds in a 0.5 ambient
    // term: `out = color * 0.5 * (1 + diffuse)`. These materials have zero
    // specular contribution.
    let diffuse = max(dot(normal, vec3<f32>(0.0, 0.0, 1.0)), 0.0)
                + max(dot(normal, vec3<f32>(0.0, 1.0, 0.0)), 0.0);

    // The cascaded path uses the absolute eye-space z coordinate for view
    // depth and feeds the RTE-precise camera-relative position directly to
    // the cascade matrices. Normal and light direction share eye space, so
    // their dot product is frame-invariant for slope bias.
    var shadowFactor: f32;
    // Point-light cube shadows take precedence over cascaded and single-map
    // shadows, matching the Model fragment-shader gate order while only one
    // shadow map is active.
    if (effects.pointLightControl.x > 0.5) {
        shadowFactor = computeShadowFactorPointLight(input.eyePosition);
    } else if (effects.csmControl.x > 0.5) {
        let viewDepth = abs(input.viewPosition.z);
        shadowFactor = computeShadowFactorCSM(
            input.eyePosition,
            viewDepth,
            normal,
            lightDir,
        );
    } else {
        shadowFactor = computeShadowFactor(input.viewPosition);
    }
    let lighting = 0.5 + 0.5 * diffuse * shadowFactor;
    // The shadow factor darkens only the diffuse term, leaving the 0.5 ambient
    // floor lit. WebGL applies visibility to the entire `czm_phong` result,
    // including ambient. Additive clustered lighting uses eye-space inputs,
    // the textured per-vertex base color, and neutral dielectric F0 and
    // roughness; it exits early when no clustered lights are active.
    let clusteredContrib = evalClusteredLights(
        input.viewPosition, normal, viewDir,
        vec3<f32>(0.04), 0.5, baseColor.rgb,
        input.clipPosition.xy, input.viewPosition.z,
    );
    var finalColor = vec4<f32>(baseColor.rgb * lighting + clusteredContrib, baseColor.a);

    // The aerial-perspective lookup is pre-integrated by AtmosphereLUT.wgsl
    // with the current sun direction. One texture sample replaces a
    // per-fragment ray march and blends lit color toward inscatter by one
    // minus transmittance.
    //
    // Math mirrors `sampleAtmosphereFogLut` in GlobeTerrain.wgsl:
    //   - viewDir     = normalize(camera-to-fragment) — `eyePosition` is
    //     already the RTE-precise camera-relative vector, so it is the
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

    // `worldNormal` is already in eye space after `camera.normalMatrix`.
    // The material uniform buffer carries no roughness, so slot 1 uses 0.5.
    var mrtOut: FragOutput;
    mrtOut.color = finalColor;
    mrtOut.normalRoughness = vec4<f32>(normalize(input.worldNormal), 0.5);
    //>>ifdef LOG_DEPTH
    // Write logarithmic frag depth. g_fragLogDepth was stashed at fragment entry.
    mrtOut.depth = csm_writeLogDepth(g_fragLogDepth, camera.logDepth.z);
    //>>endif
    return mrtOut;
}
