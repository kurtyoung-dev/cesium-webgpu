// Lens Flare post-processing effect — WGSL parity twin of
// Shaders/PostProcessStages/LensFlare.glsl (WIRE-PP-LIBRARY-BUILTINS).
//
// Ported 1:1 from the GLSL: the space gate (`length(czm_viewerPositionWC)
// > 6 500 000` — flare is a pass-through below that, upstream #5932), the
// sun-on-screen gate (NDC within ±1.1), the 4-ghost chromatic-distorted
// chain, the halo, the earth-disk masking (isInEarth), and the
// sun-distance weighting. The czm_* frame state (sun NDC, viewer
// distance, earth NDC + edge) is computed CPU-side by
// `WebGPUPostProcessStageCollection.computeLensFlareFrameContext` and
// packed into the UBO.
//
// Documented parity gaps (see WebGPULibraryPostProcessStage.ts):
//   - `dirtTexture` overlay not implemented (contributes nothing here).
//   - `starTexture` modulation replaced by 1.0 — the burst-pattern
//     texture detail is missing, so in-space flares are smoother and
//     somewhat brighter than WebGL's.
//
// The shader works in GLSL texture coordinates (bottom-left origin) via
// glUV/sampleGL so the math is a literal transcription.

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
}

struct LensFlareUniforms {
    // x = intensity, y = ghostDispersal, z = haloWidth, w = distortion
    params0: vec4<f32>,
    // x, y = sun NDC position, z = length(czm_viewerPositionWC), w = unused
    params1: vec4<f32>,
    // x, y = pixelSize (czm_pixelRatio / viewport wh), z, w = earth NDC
    params2: vec4<f32>,
    // x = abs(earth-edge NDC x), y = viewport width, z = viewport height,
    // w = unused
    params3: vec4<f32>,
}

@group(0) @binding(0) var colorTexture: texture_2d<f32>;
@group(0) @binding(1) var colorSampler: sampler;
@group(0) @binding(2) var<uniform> uniforms: LensFlareUniforms;

// whether it is in space or not — 6500000.0 is the upstream empirical value
const DISTANCE_TO_SPACE: f32 = 6500000.0;

// Sample in GLSL (bottom-left origin) texture coordinates.
fn sampleGL(texcoord: vec2<f32>) -> vec4<f32> {
    return textureSampleLevel(
        colorTexture,
        colorSampler,
        vec2<f32>(texcoord.x, 1.0 - texcoord.y),
        0.0,
    );
}

// GLSL isInEarth twin. Upstream writes `clamp(0.0, 1.0, v)` (swapped
// argument order); drivers evaluate that as min(1.0, v) — mirrored here.
fn isInEarth(texcoord: vec2<f32>, sceneSize: vec2<f32>) -> f32 {
    var ndc = texcoord * 2.0 - 1.0;
    ndc -= uniforms.params2.zw;
    let x = abs(ndc.x) * sceneSize.x;
    let y = abs(ndc.y) * sceneSize.y;
    let edge = max(abs(uniforms.params3.x * sceneSize.x), 1.0);
    return min(1.0, max(sqrt(x * x + y * y) / edge - 0.8, 0.0));
}

// Chromatic-distorted sample, earth-masked when in space.
fn textureDistorted(
    texcoord: vec2<f32>,
    direction: vec2<f32>,
    distortion: vec3<f32>,
    isSpace: bool,
) -> vec4<f32> {
    let sceneSize = uniforms.params3.yz;
    var color: vec3<f32>;
    if (isSpace) {
        color.r = isInEarth(texcoord + direction * distortion.r, sceneSize)
            * sampleGL(texcoord + direction * distortion.r).r;
        color.g = isInEarth(texcoord + direction * distortion.g, sceneSize)
            * sampleGL(texcoord + direction * distortion.g).g;
        color.b = isInEarth(texcoord + direction * distortion.b, sceneSize)
            * sampleGL(texcoord + direction * distortion.b).b;
    } else {
        color.r = sampleGL(texcoord + direction * distortion.r).r;
        color.g = sampleGL(texcoord + direction * distortion.g).g;
        color.b = sampleGL(texcoord + direction * distortion.b).b;
    }
    return vec4<f32>(clamp(color, vec3<f32>(0.0), vec3<f32>(1.0)), 0.0);
}

@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
    var pos = array<vec2<f32>, 3>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>(3.0, -1.0),
        vec2<f32>(-1.0, 3.0)
    );
    var uv = array<vec2<f32>, 3>(
        vec2<f32>(0.0, 1.0),
        vec2<f32>(2.0, 1.0),
        vec2<f32>(0.0, -1.0)
    );
    var output: VertexOutput;
    output.position = vec4<f32>(pos[vertexIndex], 0.0, 1.0);
    output.uv = uv[vertexIndex];
    return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
    // GLSL-space (bottom-left origin) texture coordinate.
    let glUV = vec2<f32>(input.uv.x, 1.0 - input.uv.y);
    let originalColor = sampleGL(glUV);

    let isSpace = uniforms.params1.z > DISTANCE_TO_SPACE;
    let sunPos = uniforms.params1.xy;

    // If not in space or the sun is off screen, use the original color
    // (upstream: "Lens flare is disabled when not in space until #5932").
    if (!isSpace ||
        !(sunPos.x >= -1.1 && sunPos.x <= 1.1 &&
          sunPos.y >= -1.1 && sunPos.y <= 1.1)) {
        return originalColor;
    }

    let intensity = uniforms.params0.x;
    let ghostDispersal = uniforms.params0.y;
    let haloWidth = uniforms.params0.z;
    let distortionAmount = uniforms.params0.w;

    let texcoord = vec2<f32>(1.0) - glUV;
    let pixelSize = uniforms.params2.xy;
    let distortionVec = pixelSize.x
        * vec3<f32>(-distortionAmount, 0.0, distortionAmount);

    // ghost vector to image centre:
    let ghostVec = (vec2<f32>(0.5) - texcoord) * ghostDispersal;
    let direction = normalize(vec3<f32>(ghostVec, 0.0)).xy;

    // sample ghosts:
    var result = vec4<f32>(0.0);
    var ghost = vec4<f32>(0.0);
    for (var i = 0; i < 4; i++) {
        let offset = fract(texcoord + ghostVec * f32(i));
        ghost += textureDistorted(offset, direction, distortionVec, isSpace);
    }
    result += ghost;

    // sample halo:
    let haloVec = normalize(ghostVec) * haloWidth;
    var weightForHalo = length(vec2<f32>(0.5) - fract(texcoord + haloVec))
        / length(vec2<f32>(0.5));
    weightForHalo = pow(1.0 - weightForHalo, 5.0);
    result += textureDistorted(texcoord + haloVec, direction, distortionVec, isSpace)
        * weightForHalo * 1.5;

    // (dirtTexture overlay omitted — see module header.)

    // Sun-distance weighting (starTexture modulation approximated as 1.0).
    let st1 = vec2<f32>(glUV * 2.0 - vec2<f32>(1.0));
    let weightForLensFlare = length(vec3<f32>(sunPos, 0.0));
    let oneMinusWeightForLensFlare = max(1.0 - weightForLensFlare, 0.0);

    if (!isSpace) {
        result *= oneMinusWeightForLensFlare * intensity * 0.2;
    } else {
        result *= oneMinusWeightForLensFlare * intensity;
        result *= pow(weightForLensFlare, 1.0)
            * max(1.0 - length(vec3<f32>(st1, 0.0)), 0.0) * 2.0;
    }

    result += sampleGL(glUV);
    return result;
}
