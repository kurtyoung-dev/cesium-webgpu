// PrimitiveMatGridFlat.wgsl
// Procedural grid material, no lighting
// Uses RTE (Relative-To-Eye) for 64-bit precision at planetary scale
// Vertex: posHigh(3) + posLow(3) + st(2) = 8 floats = 32 bytes

struct VertexInput {
    @location(0) positionHigh: vec3<f32>,
    @location(1) positionLow: vec3<f32>,
    @location(2) texCoord: vec2<f32>,
}

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) texCoord: vec2<f32>,
    // Eye-space position consumed by the aerial-perspective fog block.
    @location(1) eyePosition: vec3<f32>,
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
    // Previous frame's view-projection matrix for temporal antialiasing and
    // motion-vector reprojection, supplied by
    // `UniformState._previousViewProjection`.
    previousViewProjection: mat4x4<f32>,
    //>>ifdef LOG_DEPTH
    // Renderer-wide log-depth parameters:
    //   x = frustum near, y = frustum far,
    //   z = oneOverLog2FarDepthFromNearPlusOne (the log-depth factor),
    //   w = reserved. Packed by WebGPUPrimitiveCommands.writeRTEUniformsFlat
    // into the 16-byte flat UBO tail (FLAT_CAMERA_BYTES 160 -> 176).
    logDepth: vec4<f32>,
    //>>endif
}

struct MaterialUniforms {
    color: vec4<f32>,
    cellAlpha: f32,
    _pad_ca: f32,
    lineCount: vec2<f32>,
    lineThickness: vec2<f32>,
    lineOffset: vec2<f32>,
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var<uniform> material: MaterialUniforms;

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

@group(2) @binding(0) var<uniform> effects: EffectsUniforms;
// Aerial-perspective lookup textures at bindings 7, 8, and 9.
@group(2) @binding(7) var atmosphereTransmittanceLut: texture_2d<f32>;
@group(2) @binding(8) var atmosphereInscatterLut: texture_2d<f32>;
@group(2) @binding(9) var atmosphereLutSampler: sampler;

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
    let eyePos = translateRelativeToEye(input.positionHigh, input.positionLow);
    output.position = camera.mvpRelativeToEye * eyePos;
    output.eyePosition = eyePos.xyz;
    output.texCoord = input.texCoord;
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
    // Screen-space derivatives keep antialiased grid lines at constant pixel
    // width; a constant UV width would scale with zoom. This matches the
    // derivative branch in Shaders/Materials/GridMaterial.glsl term for term.
    let st = input.texCoord;
    // Triangle-wave distance to the nearest grid line, per axis, in [0, 0.5].
    var scaled = fract(material.lineCount * st - material.lineOffset);
    scaled = abs(scaled - floor(scaled + vec2<f32>(0.5)));
    const fuzz = 1.2;
    // lineThickness is in pixels (Material.js default 1.0). The grid camera
    // uniform buffer does not carry czm_pixelRatio, so this path assumes 1.0.
    let thicknessPx = material.lineThickness * 1.0 - vec2<f32>(1.0);
    // dF = per-fragment UV footprint (Cozzi & Ring, Listing 4.13). GLSL uses
    // max(|dFdx|,|dFdy|) per axis — replicate exactly (not the fwidth sum).
    let dxst = abs(dpdx(st));
    let dyst = abs(dpdy(st));
    let dF = vec2<f32>(max(dxst.x, dyst.x), max(dxst.y, dyst.y)) * material.lineCount;
    // value = cell weight (1 in cell, 0 on line).
    let value = min(
        smoothstep(dF.x * thicknessPx.x, dF.x * (fuzz + thicknessPx.x), scaled.x),
        smoothstep(dF.y * thicknessPx.y, dF.y * (fuzz + thicknessPx.y), scaled.y),
    );
    let isGrid = 1.0 - value; // 1 on the line, 0 in the cell
    // Grid lines get the material color; cells get the color at cellAlpha opacity
    let cellColor = vec4<f32>(material.color.rgb, material.cellAlpha);
    var finalColor = mix(cellColor, material.color, vec4<f32>(isGrid));

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
