// PrimitiveMatElevBandFlat.wgsl
// ElevationBand material, no lighting (DP-H22, Batch 25).
// Maps per-fragment terrain height to a banded color ramp via two
// textures: a sorted 1D `heights` lookup + a 1D `colors` gradient.
// Runs a 16-step binary search in the fragment shader to find the
// pair of bracketing heights, then lerps the color between the
// matching color-ramp texels — identical semantics to the WebGL
// `ElevationBandMaterial.glsl` except WGSL can assume float texture
// format so we drop the packed-float fallback.
//
// Vertex: posHigh(3) + posLow(3) + st(2) = 8 floats = 32 bytes
// Matches CesiumJS Material.ElevationBandType: heights, colors.

struct VertexInput {
    @location(0) positionHigh: vec3<f32>,
    @location(1) positionLow: vec3<f32>,
    @location(2) texCoord: vec2<f32>,
}

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) texCoord: vec2<f32>,
    @location(1) height: f32,
}

struct CameraUniforms {
    mvpRelativeToEye: mat4x4<f32>,
    encodedCameraHigh: vec3<f32>,
    _pad0: f32,
    encodedCameraLow: vec3<f32>,
    _pad1: f32,
        previousViewProjection: mat4x4<f32>,
}

// Material uniforms for ElevationBand are empty today — the band
// definition lives entirely in the two textures. Kept as a 16-byte
// placeholder struct so the bind group layout matches the other
// material variants (WebGPU requires the binding to exist even if
// the shader never reads it).
struct MaterialUniforms {
    _pad: vec4<f32>,
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var<uniform> material: MaterialUniforms;
@group(2) @binding(0) var bandSampler: sampler;
// DP-H20 — ElevationBand uses TWO textures:
//   @binding(1) heightsTexture → 1D lookup of band heights (sorted asc)
//   @binding(2) colorsTexture  → 1D color ramp aligned with heights
@group(2) @binding(1) var heightsTexture: texture_2d<f32>;
@group(2) @binding(2) var colorsTexture: texture_2d<f32>;

// FEAT-GAP-09 (Batch 97) — truncated EffectsUniforms struct, sized to
// reach the `atmosphereLutControl: vec4<f32>` slot at byte offset 240
// in the shared 480-byte UBO (see `WebGPUEffectsBindGroup.js`). Reading
// less than the full UBO is safe — WGSL just sees the prefix.
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
// FEAT-GAP-09 (Batch 97) — aerial-perspective LUT bindings 7/8/9.
@group(3) @binding(7) var atmosphereTransmittanceLut: texture_2d<f32>;
@group(3) @binding(8) var atmosphereInscatterLut: texture_2d<f32>;
@group(3) @binding(9) var atmosphereLutSampler: sampler;

const EARTH_RADIUS: f32 = 6371000.0;

fn translateRelativeToEye(high: vec3<f32>, low: vec3<f32>) -> vec4<f32> {
    var highDiff = high - camera.encodedCameraHigh;
    if (length(highDiff) == 0.0) { highDiff = vec3<f32>(0.0); }
    let lowDiff = low - camera.encodedCameraLow;
    return vec4<f32>(highDiff + lowDiff, 1.0);
}

// Sample the heights texture at a given integer band index.
// The heights texture is laid out as a 1D strip (height in .x channel).
fn getHeight(idx: i32, invTexSize: f32) -> f32 {
    let u = (f32(idx) + 0.5) * invTexSize;
    return textureSample(heightsTexture, bandSampler, vec2<f32>(u, 0.5)).x;
}

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    let posRTE = translateRelativeToEye(input.positionHigh, input.positionLow);
    output.position = camera.mvpRelativeToEye * posRTE;
    output.eyePosition = posRTE.xyz;
    output.texCoord = input.texCoord;
    // Height above ellipsoid in meters. The WebGL ElevationBand reads
    // `materialInput.height` which Material.js populates the same way
    // for Primitive geometry. Using mean Earth radius gives us ~1 m
    // precision at sea level — plenty for banded visualization.
    let worldPos = input.positionHigh + input.positionLow;
    output.height = length(worldPos) - EARTH_RADIUS;
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

    // Early-out outside the configured height range — same semantics
    // as the WebGL shader's `height < minHeight || height > maxHeight`
    // check. Discard so the underlying geometry shows through.
    if (height < minHeight || height > maxHeight) {
        discard;
    }

    // Binary search over the heights texture to find the bracket
    // containing `height`. 16 iterations covers up to 65536 bands,
    // which is orders of magnitude more than any practical band
    // configuration.
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
    var color = textureSample(colorsTexture, bandSampler, vec2<f32>(colorU, 0.5));

    // Undo the premultiplied alpha the colors texture may be baked
    // with (matches the WebGL shader's unpremul step).
    if (color.a > 0.0) {
        color = vec4<f32>(color.rgb / color.a, color.a);
    }

    var finalColor = color;

    // FEAT-GAP-09 (Batch 97) — Aerial-perspective fog blend. Mirrors
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

    return finalColor;
}
