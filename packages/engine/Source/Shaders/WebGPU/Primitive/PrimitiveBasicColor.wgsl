// PrimitiveBasicColor.wgsl
// Flat color rendering: positionHigh/Low + color, no lighting + clipping planes
// Uses RTE (Relative-To-Eye) for 64-bit precision at planetary scale
// Vertex: posHigh(3) + posLow(3) + color(4) = 10 floats = 40 bytes
// Uniform: mvpRTE(64) + encodedCameraHigh(16) + encodedCameraLow(16) = 96 bytes

struct VertexInput {
    @location(0) positionHigh: vec3<f32>,
    @location(1) positionLow: vec3<f32>,
    @location(2) color: vec4<f32>,
}

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) color: vec4<f32>,
    @location(1) eyePosition: vec3<f32>,
    //>>ifdef LOG_DEPTH
    // Interpolated linear depthFromNearPlusOne; the FS converts it to frag_depth.
    @location(7) v_logDepth: f32,
    //>>endif
}

struct CameraUniforms {
    mvpRelativeToEye: mat4x4<f32>,
    encodedCameraHigh: vec3<f32>,
    // Holds czm_gamma when high dynamic range is enabled, otherwise zero.
    // fragmentMain uses it to match the per-instance color conversion in
    // WebGL's PerInstanceFlatColorAppearanceFS.
    hdrGamma: f32,
    encodedCameraLow: vec3<f32>,
    _pad1: f32,
    // Previous frame's view-projection matrix for temporal antialiasing and
    // motion-vector reprojection, supplied by
    // `UniformState._previousViewProjection`.
    previousViewProjection: mat4x4<f32>,
    //>>ifdef LOG_DEPTH
    // Renderer-wide logarithmic-depth parameters:
    //   x = frustum near, y = frustum far,
    //   z = oneOverLog2FarDepthFromNearPlusOne (the log-depth factor),
    //   w = reserved. Packed by WebGPUPrimitiveCommands.writeRTEUniformsFlat
    // into the 16-byte flat-camera tail (FLAT_CAMERA_BYTES, 160 to 176 bytes).
    logDepth: vec4<f32>,
    //>>endif
}

struct MaterialUniforms {
    _placeholder: vec4<f32>,
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var<uniform> material: MaterialUniforms;

// Effects bind group for clipping and aerial-perspective lookup textures.
// The shared getEffectsBindGroupLayout uniform buffer is at least 480 bytes.
// This shader declares its prefix through atmosphereLutControl and reads no
// later fields; binding the larger shared buffer is valid for that prefix.
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
}

@group(2) @binding(0) var<uniform> effects: EffectsUniforms;
@group(2) @binding(1) var shadowDepthTex: texture_depth_2d;
@group(2) @binding(2) var shadowCompSampler: sampler_comparison;
@group(2) @binding(3) var clippingPlaneTex: texture_2d<f32>;
@group(2) @binding(4) var clippingPlaneSampler: sampler;
// Aerial-perspective lookup textures at bindings 7, 8, and 9 are always
// populated by WebGPUEffectsBindGroup. Inactive lookup tables use 1×1
// placeholders and fragmentMain gates sampling on atmosphereLutControl.x,
// leaving one uniform comparison on the disabled path.
@group(2) @binding(7) var atmosphereTransmittanceLut: texture_2d<f32>;
@group(2) @binding(8) var atmosphereInscatterLut: texture_2d<f32>;
@group(2) @binding(9) var atmosphereLutSampler: sampler;

//>>ifdef LOG_DEPTH
// The logarithmic-depth layout matches PrimitivePhongColor.wgsl. Near, far,
// and the logarithmic factor come from camera.logDepth; FragOut carries
// @builtin(frag_depth) alongside color.
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

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    let eyePos = translateRelativeToEye(input.positionHigh, input.positionLow);
    output.position = camera.mvpRelativeToEye * eyePos;
    output.color = input.color;
    output.eyePosition = eyePos.xyz;
    //>>ifdef LOG_DEPTH
    // Renderer-wide log depth: interpolate linear depthFromNearPlusOne and clamp
    // clip-z so the FS-written log depth isn't pre-empted by clipping.
    output.v_logDepth = csm_vertexLogDepth(output.position, camera.logDepth.x);
    output.position = csm_updatePositionDepth(output.position);
    //>>endif
    return output;
}

// Clipping planes.
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
//>>ifdef LOG_DEPTH
fn fragmentMain(input: VertexOutput) -> FragOut {
//>>else
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
//>>endif
    //>>ifdef LOG_DEPTH
    g_fragLogDepth = input.v_logDepth;
    //>>endif
    // Clipping plane discard
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
            //>>ifdef LOG_DEPTH
            return FragOut(effects.clippingEdgeColor, csm_writeLogDepth(g_fragLogDepth, camera.logDepth.z));
            //>>else
            return effects.clippingEdgeColor;
            //>>endif
        }
    }

    var finalColor = input.color;

    // Decode the per-instance color from sRGB to linear before the
    // aerial-perspective blend, matching WebGL's czm_gammaCorrect order.
    // Both backends then feed linear color to fog and post-process tone
    // mapping. camera.hdrGamma is zero in SDR, leaving the color unchanged.
    if (camera.hdrGamma > 0.5) {
        finalColor = vec4<f32>(
            pow(max(finalColor.rgb, vec3<f32>(0.0)), vec3<f32>(camera.hdrGamma)),
            finalColor.a
        );
    }

    // The aerial-perspective blend matches PrimitiveMatColorLit.wgsl. Sample
    // the pre-integrated lookup table by cosine of view zenith and camera
    // altitude, then blend toward inscatter by one minus transmittance.
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
