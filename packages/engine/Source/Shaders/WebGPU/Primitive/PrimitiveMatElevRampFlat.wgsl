// PrimitiveMatElevRampFlat.wgsl
// Elevation ramp material, no lighting
// Maps height above ellipsoid to a color ramp texture
// Uses RTE (Relative-To-Eye) for 64-bit precision at planetary scale
// Vertex: posHigh(3) + posLow(3) + st(2) = 8 floats = 32 bytes
// Matches CesiumJS Material.ElevationRampType: image, minimumHeight, maximumHeight

struct VertexInput {
    @location(0) positionHigh: vec3<f32>,
    @location(1) positionLow: vec3<f32>,
    @location(2) texCoord: vec2<f32>,
}

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) texCoord: vec2<f32>,
    @location(1) height: f32,
    // Eye-space position consumed by the aerial-perspective fog block.
    @location(2) eyePosition: vec3<f32>,
    //>>ifdef LOG_DEPTH
    // Interpolated linear depthFromNearPlusOne; the FS converts it to frag_depth.
    @location(7) v_logDepth: f32,
    //>>endif
}

struct CameraUniforms {
    mvpRelativeToEye: mat4x4<f32>,
    encodedCameraHigh: vec3<f32>,
    _pad0: f32,
    encodedCameraLow: vec3<f32>,
    _pad1: f32,
        previousViewProjection: mat4x4<f32>,
    // Renderer-wide log-depth parameters:
    //   x = frustum near, y = frustum far,
    //   z = oneOverLog2FarDepthFromNearPlusOne (the log-depth factor),
    //   w = reserved. Packed by WebGPUPrimitiveCommands.writeRTEUniformsFlat
    // into the 16-byte block before the inverse-radii tail.
    logDepth: vec4<f32>,
    ellipsoidOneOverRadii: vec4<f32>,
    modelMatrixColumn0: vec4<f32>,
    modelMatrixColumn1: vec4<f32>,
    modelMatrixColumn2: vec4<f32>,
    encodedCameraWorldHigh: vec4<f32>,
    encodedCameraWorldLow: vec4<f32>,
    // x = device pixel ratio (`czm_pixelRatio`), y-w reserved. Packed by
    // WebGPUPrimitiveCommands.writePixelRatioTail. Declared by every elevation
    // material so the six share one camera layout; only the contour materials
    // read it.
    pixelRatio: vec4<f32>,
}

struct MaterialUniforms {
    minimumHeight: f32,
    maximumHeight: f32,
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var<uniform> material: MaterialUniforms;
@group(2) @binding(0) var rampSampler: sampler;
@group(2) @binding(1) var rampTexture: texture_2d<f32>;

// Prefix of the shared 480-byte effects uniform buffer through
// `atmosphereLutControl` at byte offset 240. Its layout matches
// `WebGPUEffectsBindGroup.js`; WGSL may declare only the prefix it reads.
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

@group(3) @binding(0) var<uniform> effects: EffectsUniforms;
// Aerial-perspective lookup textures at bindings 7, 8, and 9.
@group(3) @binding(7) var atmosphereTransmittanceLut: texture_2d<f32>;
@group(3) @binding(8) var atmosphereInscatterLut: texture_2d<f32>;
@group(3) @binding(9) var atmosphereLutSampler: sampler;

const WGS84_ONE_OVER_RADII: vec3<f32> = vec3<f32>(
    1.0 / 6378137.0,
    1.0 / 6378137.0,
    1.0 / 6356752.314245179,
);
const MAX_FINITE_F32: f32 = 3.402823466e+38;

//>>ifdef LOG_DEPTH
// Renderer-wide log-depth helpers mirror PrimitivePhongColor.wgsl and must
// remain byte-compatible. near/far/factor come from camera.logDepth. The FS swaps
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

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    let posRTE = translateRelativeToEye(input.positionHigh, input.positionLow);
    output.position = camera.mvpRelativeToEye * posRTE;
    output.eyePosition = posRTE.xyz;
    output.texCoord = input.texCoord;
    // The affine linear transform converts the model-space RTE delta before the
    // encoded world camera restores the absolute position. Scaled ellipsoid space
    // applies the active datum without subtracting planetary-scale values. The
    // residual stays below 4.0 m on a 13-longitude, half-degree WGS84 grid for
    // heights from -1 km to 500 km and camera separations from 1 km to 1,000 km;
    // most of it is the scaled-space approximation itself (exact only for a
    // sphere, peaking near mid-latitudes at altitude), not f32 rounding.
    let modelMatrix3 = mat3x3<f32>(
        camera.modelMatrixColumn0.xyz,
        camera.modelMatrixColumn1.xyz,
        camera.modelMatrixColumn2.xyz,
    );
    let worldPos =
        modelMatrix3 * posRTE.xyz +
        camera.encodedCameraWorldHigh.xyz +
        camera.encodedCameraWorldLow.xyz;
    let oneOverRadii = select(
        WGS84_ONE_OVER_RADII,
        camera.ellipsoidOneOverRadii.xyz,
        camera.ellipsoidOneOverRadii.w > 0.0,
    );
    let scaledPosition = worldPos * oneOverRadii;
    let scaledPositionLength = length(scaledPosition);
    let safeScaledPositionLength = select(
        1.0,
        scaledPositionLength,
        scaledPositionLength > 0.0,
    );
    let derivedHeight =
        length(worldPos) * (1.0 - 1.0 / safeScaledPositionLength);
    let heightIsFinite =
        derivedHeight >= -MAX_FINITE_F32 && derivedHeight <= MAX_FINITE_F32;
    output.height = select(0.0, derivedHeight, heightIsFinite);
    //>>ifdef LOG_DEPTH
    // Renderer-wide log depth: interpolate linear depthFromNearPlusOne and clamp
    // clip-z so the FS-written log depth isn't pre-empted by clipping.
    output.v_logDepth = csm_vertexLogDepth(output.position, camera.logDepth.x);
    output.position = csm_updatePositionDepth(output.position);
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
    let range = material.maximumHeight - material.minimumHeight;
    let t = clamp((input.height - material.minimumHeight) / max(range, 0.001), 0.0, 1.0);
    let rampColor = textureSample(rampTexture, rampSampler, vec2<f32>(t, 0.5));
    var finalColor = rampColor;

    // Aerial-perspective fog blend shared with
    // `PrimitiveBasicColor.wgsl::fragmentMain`.
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
