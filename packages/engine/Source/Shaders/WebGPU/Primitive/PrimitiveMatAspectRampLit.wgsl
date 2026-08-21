// PrimitiveMatAspectRampLit.wgsl
// Aspect ramp material + Blinn-Phong lighting
// Maps surface aspect (compass direction of slope) to a color ramp texture
// Aspect = atan2 of the slope's east/north components, normalized to [0, 1]
// Uses RTE (Relative-To-Eye) for 64-bit precision at planetary scale
// Vertex: posHigh(3) + posLow(3) + normal(3) + st(2) = 11 floats = 44 bytes
// Matches CesiumJS Material.AspectRampType: image
//
// Receives cascaded shadows through the primitive effects bind group at
// `@group(3)`; the texture group occupies `@group(2)`.
//
// The chunk marker supplies point-light cube-shadow sampling.
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
    @location(3) aspectT: f32,
    @location(4) eyePosition: vec3<f32>,
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
    inverseViewQuaternion: vec4<f32>,
    //>>ifdef LOG_DEPTH
    // Renderer-wide log-depth parameters:
    //   x = frustum near, y = frustum far,
    //   z = oneOverLog2FarDepthFromNearPlusOne (the log-depth factor),
    //   w = reserved. Packed by WebGPUPrimitiveCommands.writeRTEUniformsLit
    // into the 16-byte tail appended after inverseViewQuaternion
    // (LIT_CAMERA_BYTES 320 -> 336). See WebGPULogDepth.ts.
    logDepth: vec4<f32>,
    //>>endif
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
// group(1) = MaterialUniforms placeholder (not referenced by this shader)
@group(2) @binding(0) var rampSampler: sampler;
@group(2) @binding(1) var rampTexture: texture_2d<f32>;

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
    edgeControl: vec4<f32>,
    edgeViewport: vec4<f32>,
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

@group(3) @binding(0) var<uniform> effects: EffectsUniforms;
@group(3) @binding(1) var shadowDepthTex: texture_depth_2d;
@group(3) @binding(2) var shadowCompSampler: sampler_comparison;
@group(3) @binding(10) var<uniform> csmParams: CSMParams;
@group(3) @binding(11) var cascadeDepthArray: texture_depth_2d_array;
@group(3) @binding(17) var pointLightCubeDepth: texture_depth_cube;

const TWO_PI: f32 = 6.2831853072;

//>>ifdef LOG_DEPTH
// Renderer-wide log-depth helpers mirror the canonical definitions in
// PrimitivePhongColor.wgsl and `chunks/functions/csm_*LogDepth`; they must
// remain byte-compatible. near/far/factor come from camera.logDepth.
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

// Point-light cube-shadow sampling through the shared chunk.
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
    let viewPosition = (camera.modelViewRelativeToEye * posRTE).xyz;
    output.viewPosition = viewPosition;
    output.eyePosition = rotateEyeToWorld(viewPosition, camera.inverseViewQuaternion);
    output.texCoord = input.texCoord;

    // Compute aspect: compass direction of the steepest slope
    // Project normal onto the tangent plane (remove radial component)
    let worldPos = input.positionHigh + input.positionLow;
    let up = normalize(worldPos);
    let n = normalize(input.normal);
    let slopeDir = n - dot(n, up) * up;  // tangential component of normal

    // Compute east and north basis vectors on the tangent plane
    // East ~ cross(north_pole, up), North ~ cross(up, east)
    let northPole = vec3<f32>(0.0, 0.0, 1.0);
    var east = cross(northPole, up);
    let eastLen = length(east);
    if (eastLen < 0.001) {
        // At poles, use arbitrary east direction
        east = vec3<f32>(1.0, 0.0, 0.0);
    } else {
        east = east / eastLen;
    }
    let north = cross(up, east);

    let eastComp = dot(slopeDir, east);
    let northComp = dot(slopeDir, north);
    var aspect = atan2(eastComp, northComp); // 0 = north, increases clockwise
    if (aspect < 0.0) { aspect = aspect + TWO_PI; }
    output.aspectT = aspect / TWO_PI;

    //>>ifdef LOG_DEPTH
    // Renderer-wide log depth: interpolate linear depthFromNearPlusOne and clamp
    // clip-z so the FS-written log depth isn't pre-empted by clipping. near =
    // camera.logDepth.x; computed from clipPosition.w before the clamp.
    output.v_logDepth = csm_vertexLogDepth(output.clipPosition, camera.logDepth.x);
    output.clipPosition = csm_updatePositionDepth(output.clipPosition);
    //>>endif
    return output;
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
    g_fragLogDepth = input.v_logDepth;
    //>>endif
    let N = normalize(input.worldNormal);
    let V = normalize(-input.viewPosition);
    let L = normalize(camera.lightDirection.xyz);

    let NdotL = max(dot(N, L), 0.0);
    let H = normalize(L + V);
    let NdotH = max(dot(N, H), 0.0);
    let specular = pow(NdotH, 64.0);

    let ambient = 0.5;

    let t = clamp(input.aspectT, 0.0, 1.0);
    let rampColor = textureSample(rampTexture, rampSampler, vec2<f32>(t, 0.5));

    let ambientTerm = rampColor.rgb * ambient;
    let diffuse = 0.5 * (max(dot(N, vec3<f32>(0.0, 0.0, 1.0)), 0.0) + max(dot(N, vec3<f32>(0.0, 1.0, 0.0)), 0.0));
    var directTerm = rampColor.rgb * diffuse;
    var spec = vec3<f32>(specular * 0.3);

    // Point-light cube shadows take precedence over the cascaded shadow map.
    if (effects.pointLightControl.x > 0.5) {
        let shadowFactor = computeShadowFactorPointLight(input.eyePosition);
        directTerm = directTerm * shadowFactor;
        spec = spec * shadowFactor;
    } else if (effects.csmControl.x > 0.5) {
        let viewDepth = abs(input.viewPosition.z);
        let shadowFactor = computeShadowFactorCSM(
            input.eyePosition, viewDepth, N, L,
        );
        directTerm = directTerm * shadowFactor;
        spec = spec * shadowFactor;
    }

    // Additive Forward+ clustered lighting uses eye-space inputs.
    // The ramp supplies albedo; F0/roughness are synthesized as a neutral
    // dielectric for the non-PBR material path.
    let clusteredContrib = evalClusteredLights(
        input.viewPosition, N, V,
        vec3<f32>(0.04), 0.5, rampColor.rgb,
        input.clipPosition.xy, input.viewPosition.z,
    );
    let finalColor = ambientTerm + directTerm + spec + clusteredContrib;
    // `worldNormal` is already in eye space after `camera.normalMatrix`.
    // The material uniform buffer carries no roughness, so slot 1 uses 0.5.
    var mrtOut: FragOutput;
    mrtOut.color = vec4<f32>(finalColor, rampColor.a);
    mrtOut.normalRoughness = vec4<f32>(normalize(input.worldNormal), 0.5);
    //>>ifdef LOG_DEPTH
    // Write logarithmic frag depth. factor = camera.logDepth.z.
    mrtOut.depth = csm_writeLogDepth(g_fragLogDepth, camera.logDepth.z);
    //>>endif
    return mrtOut;
}
