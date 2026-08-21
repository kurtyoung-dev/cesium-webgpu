/**
 * WebGPUCubeMapPanoramaRenderer.js
 *
 * Handles WebGPU rendering for `CubeMapPanorama`, including `SkyBox` and
 * standalone panoramas. Creates pipelines, buffers, bind groups, and
 * `WebGPUDrawCommand` instances.
 *
 * Uniform layout matches `CubeMapPanorama.wgsl` (272 bytes of data in a
 * 288-byte buffer):
 *   projection:         mat4x4<f32>  (offset 0,  64 bytes)
 *   viewRotation:       mat4x4<f32>  (offset 64, 64 bytes)
 *   panoramaTransform:  mat4x4<f32>  (offset 128, 64 bytes)
 *   params:             vec4<f32>    (offset 192, 16 bytes)
 *     far, morph time, debug face, and sky brightness
 *   starModulation:     vec4<f32>    (offset 208, 16 bytes)
 *     inflection, steepness, enable flag, and cloud cover
 *   hdr:                vec4<f32>    (offset 224, 16 bytes)
 *     gamma when HDR, followed by three reserved values
 *   solarGlare:         vec4<f32>    (offset 240, 16 bytes)
 *     sun direction in the cube-map TEME frame and strength
 *   solarGlareCurve:    vec4<f32>    (offset 256, 16 bytes)
 *     angular core, pedestal, support, and one reserved value
 */
import WebGPUDrawCommand from "./WebGPUDrawCommand.js";
import WebGPUBuffer from "./WebGPUBuffer.js";
// Scene-framebuffer target helper.
import { makeSceneFBTargets } from "./WebGPUSceneFBTargetHelpers.js";
import defined from "../../Core/defined.js";
import Matrix3 from "../../Core/Matrix3.js";
import Matrix4 from "../../Core/Matrix4.js";
import Pass from "../Pass.js";
import {
  makeBindGroupLayout,
  uniformBuffer,
  texture,
  sampler,
  Stage,
} from "./WebGPUBindGroupLayoutHelpers.js";

// Embedded WGSL shader source (avoids async fetch dependency)
const CUBEMAP_PANORAMA_WGSL = `
struct CubeMapPanoramaUniforms {
  projection: mat4x4<f32>,
  viewRotation: mat4x4<f32>,
  panoramaTransform: mat4x4<f32>,
  // params.w is the Phase 1.3a sky brightness scalar (0..1).
  params: vec4<f32>,
  // Phase 1.3b star modulation tunables, sourced from
  // atmosphericConditions.skyAtmosphere.starModulationCurve.
  // x = inflection, y = steepness, z = enableFlag (0/1), w = cloudCover
  starModulation: vec4<f32>,
  // C4-CUBEMAP-PANORAMA-HDR-DECODE — HDR sRGB->linear decode gate.
  // x = czm_gamma (uniformState.gamma, default 2.2) when HDR is active
  // (frameState.useHDR), else 0. Zero on the default SDR path keeps the
  // fragment output byte-identical. y/z/w reserved.
  hdr: vec4<f32>,
  // C12-27 — angular solar-glare star washout, ADD-ONLY at the tail.
  // xyz = Sun direction in THIS shader's cube-map lookup frame (TEME for
  // SkyBox, whose panoramaTransform IS temeToPseudoFixed); w = washout
  // strength, EXACTLY 0 for generic panoramas and for the disabled toggle,
  // which skips the whole block. Resolved once per frame on the CPU by
  // Scene/SolarGlareAppearance.js; SkyBoxFS.glsl reads the same numbers.
  solarGlare: vec4<f32>,
  // x = angular core (rad), y = pedestal, z = support (rad), w = reserved.
  // Uniforms rather than literals so this shader carries no numeric copy.
  solarGlareCurve: vec4<f32>,
};

@group(0) @binding(0) var<uniform> uniforms: CubeMapPanoramaUniforms;
@group(1) @binding(0) var cubeMapSampler: sampler;
@group(1) @binding(1) var cubeMapTexture: texture_cube<f32>;

struct VertexInput {
  @location(0) position: vec3<f32>,
};
struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) texCoord: vec3<f32>,
};

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  let far = uniforms.params.x;
  let scaledPos = far * input.position;
  let pt = mat3x3<f32>(
    uniforms.panoramaTransform[0].xyz,
    uniforms.panoramaTransform[1].xyz,
    uniforms.panoramaTransform[2].xyz,
  );
  let transformed = pt * scaledPos;
  let vr = mat3x3<f32>(
    uniforms.viewRotation[0].xyz,
    uniforms.viewRotation[1].xyz,
    uniforms.viewRotation[2].xyz,
  );
  let rotated = vr * transformed;
  let clipPos = uniforms.projection * vec4<f32>(rotated, 1.0);
  output.position = vec4<f32>(clipPos.x, clipPos.y, clipPos.w, clipPos.w);
  output.texCoord = input.position;
  return output;
}

// C12-27 — veiling-glare weight as a function of angular separation from the
// Sun. Character-identical to solarGlareVeil in Shaders/SkyBoxFS.glsl,
// Shaders/WebGPU/Catalog/StarField.wgsl and Shaders/StarFieldVS.glsl, and a
// line-for-line translation of angularGlareVeil in Scene/SolarDiscModel.js.
// Tools/visual-regression/solar-glare-star-washout.spec.mjs extracts all five
// texts (this JS-embedded production copy included), compiles each body as
// JavaScript, and requires them to agree with the JS reference to 1e-15.
//
//   raw(theta)  = 1 / (1 + (theta/core)^2)      -> ~ 1/theta^2 far field
//   veil(theta) = (raw - pedestal) / (1 - pedestal), clamped to [0, 1]
//
// The 1/theta^2 tail is the Stiles-Holladay / CIE disability-glare form. The
// pedestal subtraction makes the veil reach EXACTLY 0 at the support angle
// (90 deg), and the cosSeparation <= 0.0 early-out is the same half-space,
// so a direction at or beyond 90 deg from the Sun is multiplied by exactly 1.0
// — byte-identical to the no-Sun frame, the C12-27 acceptance criterion.
//
// NOTE: keep this whole template literal free of backticks, escaped or not.
// The specs slice the embedded WGSL out by scanning for the first backtick
// immediately followed by a semicolon, so one inside the string silently
// truncates the extracted shader and the naga validation then passes on a
// fragment. That is exactly how this comment block was first written.
fn solarGlareVeil(cosSeparation: f32, core: f32, pedestal: f32, support: f32) -> f32 {
  if (cosSeparation <= 0.0) { return 0.0; }
  let theta = acos(min(cosSeparation, 1.0));
  if (theta >= support) { return 0.0; }
  let t = theta / core;
  let raw = 1.0 / (1.0 + t * t);
  let v = (raw - pedestal) / (1.0 - pedestal);
  return clamp(v, 0.0, 1.0);
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  // Tier 1 debug — single-face isolation. params.z encodes the requested
  // face: 0=all (production), 1=+X, 2=-X, 3=+Y, 4=-Y, 5=+Z, 6=-Z.
  // We pick the face for each fragment by finding the dominant axis of
  // the cube direction; mismatched fragments discard so the chosen face
  // renders through its natural skybox projection over the full hemisphere
  // it covers. Lets you verify cubemap face data and orientation without
  // external tools.
  let dir = normalize(input.texCoord);
  let requested = i32(uniforms.params.z + 0.5);
  if (requested != 0) {
    let absDir = abs(dir);
    let maxAxis = max(absDir.x, max(absDir.y, absDir.z));
    var face: i32 = 0;
    if (absDir.x >= maxAxis) {
      if (dir.x > 0.0) { face = 1; } else { face = 2; }
    } else if (absDir.y >= maxAxis) {
      if (dir.y > 0.0) { face = 3; } else { face = 4; }
    } else {
      if (dir.z > 0.0) { face = 5; } else { face = 6; }
    }
    if (face != requested) {
      discard;
    }
  }

  let color = textureSample(cubeMapTexture, cubeMapSampler, dir);
  let morphTime = uniforms.params.y;

  // Phase 1.3b — Star brightness modulation. Stars need to dim toward
  // black as the sky brightens (sun above horizon, full moon overhead)
  // so the cubemap doesn't punch through the daytime atmosphere. The
  // smoothstep curve has two tunables (inflection, steepness) exposed via
  // atmosphericConditions.skyAtmosphere.starModulationCurve; C12-29 S6 /
  // ruling E3 derives their defaults in Scene/StarFieldMath.ts and turns the
  // flag ON by default, and WebGL's SkyBoxFS.glsl now carries the identical
  // expression in the identical position (before czm_gammaCorrect).
  // When the toggle is off (enableFlag == 0) the modulation is skipped
  // entirely — same byte cost as before, no visible change.
  // Phase 1.4 — Cloud cover star occlusion. starModulation.w carries
  // atmosphericConditions.weather.cloudCover (0..1). The final modulated
  // color is multiplied by (1 - cloudCover) so a fully overcast sky
  // hides stars completely without requiring a separate occlusion pass.
  let skyBrightness = uniforms.params.w;
  let inflection = uniforms.starModulation.x;
  let steepness = uniforms.starModulation.y;
  let enableMod = uniforms.starModulation.z > 0.5;
  let cloudCover = clamp(uniforms.starModulation.w, 0.0, 1.0);

  var modulated = color.rgb;
  if (enableMod) {
    let t = clamp((skyBrightness - inflection) * steepness, 0.0, 1.0);
    let factor = 1.0 - smoothstep(0.0, 1.0, t);
    modulated = modulated * factor;
  }
  modulated = modulated * (1.0 - cloudCover);

  // C12-27 — angular solar-glare washout. ORDER IS PART OF THE CONTRACT and
  // SkyBoxFS.glsl mirrors it exactly: modulate -> cloud-occlude -> GLARE ->
  // gamma. Must stay before the gamma step for the same reason the other two
  // do: czm_gammaCorrect is an sRGB->linear decode under HDR and
  // k*x^g != (k*x)^g, so moving a multiply across it desynchronises the
  // backends.
  if (uniforms.solarGlare.w > 0.0) {
    let veil = solarGlareVeil(
      dot(dir, uniforms.solarGlare.xyz),
      uniforms.solarGlareCurve.x,
      uniforms.solarGlareCurve.y,
      uniforms.solarGlareCurve.z
    );
    modulated = modulated * (1.0 - uniforms.solarGlare.w * veil);
  }

  // Match WebGL czm_gammaCorrect (Builtin/Functions/gammaCorrect.glsl):
  // it is a no-op when HDR is off (the default). Cubemap PNG data is
  // sRGB-encoded; the canvas color space is sRGB; passing the sampled
  // value straight through lands the right luminance on the display.
  // The previous unconditional pow(color, 1/2.2) re-encoded sRGB on
  // top of sRGB, brightening dark pixels (so star backgrounds looked
  // like concrete) and washing out the visible portion of the cubemap.
  // C4-CUBEMAP-PANORAMA-HDR-DECODE — when HDR is on, decode sRGB -> linear
  // (pow(color, czm_gamma), matching czm_gammaCorrect's #ifdef HDR branch)
  // so the cubemap participates in the linear HDR pipeline before the tonemap
  // stage re-encodes for display. hdr.x is 0 on the SDR default path, so the
  // branch is skipped and the output stays byte-identical.
  let hdrGamma = uniforms.hdr.x;
  if (hdrGamma > 0.5) {
    modulated = pow(modulated, vec3<f32>(hdrGamma));
  }
  return vec4<f32>(modulated, morphTime);
}
`;

// The uniform block contains 272 bytes of data and is padded to 288, keeping
// every vec4 naturally aligned. `solarGlare` and `solarGlareCurve` occupy the
// tail at offsets 240 and 256, preserving all preceding offsets.
const UNIFORM_BUFFER_SIZE = 288;
const UNIFORM_FLOAT_COUNT = UNIFORM_BUFFER_SIZE / 4;

// Cached per-device resources (shader module, pipeline, bind group layouts)
let _cachedShaderModule = null;
let _cachedPipeline = null;
// Cache the pipeline format because an HDR toggle recreates the scene
// framebuffer with a different color format.
let _cachedPipelineFormat = null;
let _cachedPipelineSampleCount = 1;
let _cachedBindGroupLayout0 = null;
let _cachedBindGroupLayout1 = null;
let _cachedPipelineLayout = null;
let _cachedDevice = null;

/**
 * Reset every device-bound module cache when the active `GPUDevice` changes,
 * including context reinitialization and split-screen contexts. This must
 * update `_cachedDevice` before any `getShaderModule`, `ensureLayouts`, or
 * `getPipeline` cache guard runs.
 *
 * A shared device guard in each individual getter is unsafe: the first getter
 * can update `_cachedDevice`, causing later getters to accept layouts that
 * still belong to the old device. Cross-device layouts invalidate the scene
 * framebuffer render pass.
 *
 * The device pool already destroyed the old device, so drop its cached handles
 * without calling `.destroy()` and let each getter rebuild for the new device.
 *
 * @param {GPUDevice} device
 */
function resetPanoramaDeviceCacheIfChanged(device) {
  if (_cachedDevice === device) {
    return;
  }
  _cachedDevice = device;
  _cachedShaderModule = null;
  _cachedPipeline = null;
  _cachedPipelineFormat = null;
  _cachedPipelineSampleCount = 1;
  _cachedBindGroupLayout0 = null;
  _cachedBindGroupLayout1 = null;
  _cachedPipelineLayout = null;
}

/**
 * Get or create the cached shader module for cubemap panorama rendering.
 * @param {GPUDevice} device
 * @returns {GPUShaderModule}
 */
function getShaderModule(device) {
  resetPanoramaDeviceCacheIfChanged(device);
  if (_cachedShaderModule) {
    return _cachedShaderModule;
  }
  _cachedShaderModule = device.createShaderModule({
    label: "CubeMapPanorama",
    code: CUBEMAP_PANORAMA_WGSL,
  });
  // Invalidate pipeline cache when shader module changes
  _cachedPipeline = null;
  return _cachedShaderModule;
}

/**
 * Get or create bind group layouts and pipeline layout.
 * @param {GPUDevice} device
 */
function ensureLayouts(device) {
  resetPanoramaDeviceCacheIfChanged(device);
  if (_cachedBindGroupLayout0) {
    return;
  }

  _cachedBindGroupLayout0 = makeBindGroupLayout(
    device,
    "CubeMapPanorama-uniforms",
    [uniformBuffer(0, Stage.VERTEX_FRAGMENT)],
  );

  _cachedBindGroupLayout1 = makeBindGroupLayout(
    device,
    "CubeMapPanorama-textures",
    [
      sampler(0, Stage.FRAGMENT),
      texture(1, Stage.FRAGMENT, { viewDimension: "cube" }),
    ],
  );

  _cachedPipelineLayout = device.createPipelineLayout({
    label: "CubeMapPanorama-layout",
    bindGroupLayouts: [_cachedBindGroupLayout0, _cachedBindGroupLayout1],
  });
}

/**
 * Get or create the cached render pipeline.
 * @param {GPUDevice} device
 * @param {GPUTextureFormat} format - Canvas preferred format
 * @returns {GPURenderPipeline}
 */
function getPipeline(device, format, sampleCount) {
  sampleCount = sampleCount ?? 1;
  resetPanoramaDeviceCacheIfChanged(device);
  // Recreate when an HDR toggle changes the scene-framebuffer format or when
  // the MSAA sample count changes.
  if (
    _cachedPipeline &&
    _cachedPipelineFormat === format &&
    _cachedPipelineSampleCount === sampleCount
  ) {
    return _cachedPipeline;
  }

  const shaderModule = getShaderModule(device);
  ensureLayouts(device);

  _cachedPipeline = device.createRenderPipeline({
    label: "CubeMapPanorama-pipeline",
    layout: _cachedPipelineLayout,
    vertex: {
      module: shaderModule,
      entryPoint: "vertexMain",
      buffers: [
        {
          arrayStride: 12, // vec3<f32> = 3 * 4 bytes
          attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }],
        },
      ],
    },
    fragment: {
      module: shaderModule,
      entryPoint: "fragmentMain",
      // Use the scene-framebuffer target helper's standard alpha-over blend.
      targets: makeSceneFBTargets(format, { translucent: true }),
    },
    primitive: {
      topology: "triangle-list",
      cullMode: "none",
    },
    depthStencil: {
      format: "depth24plus-stencil8",
      depthWriteEnabled: false,
      // The vertex shader forces clip-space z/w to 1 (exactly the far
      // plane), so `less-equal` lets the skybox fill only the pixels
      // where no closer opaque geometry has already written a depth
      // value < 1. This is draw-order agnostic — skybox can be issued
      // before or after terrain and the result is the same.
      depthCompare: "less-equal",
    },
    // Match the scene-framebuffer sample count.
    multisample: sampleCount > 1 ? { count: sampleCount } : undefined,
  });
  _cachedPipelineFormat = format;
  _cachedPipelineSampleCount = sampleCount;

  return _cachedPipeline;
}

/**
 * Pack a Matrix3 into a Float32Array as a mat4x4<f32> (column-major,
 * 16 floats).
 * @param {Matrix3} m3 - Source 3x3 rotation matrix
 * @param {Float32Array} dst - Destination array
 * @param {number} offset - Offset in floats
 */
function packMatrix3As4x4(m3, dst, offset) {
  // Column 0
  dst[offset + 0] = m3[Matrix3.COLUMN0ROW0];
  dst[offset + 1] = m3[Matrix3.COLUMN0ROW1];
  dst[offset + 2] = m3[Matrix3.COLUMN0ROW2];
  dst[offset + 3] = 0.0;
  // Column 1
  dst[offset + 4] = m3[Matrix3.COLUMN1ROW0];
  dst[offset + 5] = m3[Matrix3.COLUMN1ROW1];
  dst[offset + 6] = m3[Matrix3.COLUMN1ROW2];
  dst[offset + 7] = 0.0;
  // Column 2
  dst[offset + 8] = m3[Matrix3.COLUMN2ROW0];
  dst[offset + 9] = m3[Matrix3.COLUMN2ROW1];
  dst[offset + 10] = m3[Matrix3.COLUMN2ROW2];
  dst[offset + 11] = 0.0;
  // Column 3
  dst[offset + 12] = 0.0;
  dst[offset + 13] = 0.0;
  dst[offset + 14] = 0.0;
  dst[offset + 15] = 1.0;
}

/**
 * Pack a Matrix4 into a Float32Array (column-major, 16 floats).
 * @param {Matrix4} m4
 * @param {Float32Array} dst
 * @param {number} offset
 */
function packMatrix4(m4, dst, offset) {
  for (let i = 0; i < 16; i++) {
    dst[offset + i] = m4[i];
  }
}

// Identity Matrix3 for when no panorama transform is set
const IDENTITY_MATRIX3 = Matrix3.clone(Matrix3.IDENTITY);

// Scratch variables
const scratchMatrix3 = new Matrix3();

/**
 * Create WebGPU vertex and index buffers from box geometry.
 *
 * @param {GPUDevice} device
 * @param {Object} geometry - CesiumJS geometry from
 *        `BoxGeometry.createGeometry`.
 * @returns {{vertexBuffer: WebGPUBuffer, indexBuffer: WebGPUBuffer,
 *          indexCount: number}} The GPU geometry buffers.
 */
export function createGeometryBuffers(device, geometry) {
  const positions = geometry.attributes.position.values;
  const indices = geometry.indices;

  const vertexBuffer = WebGPUBuffer.createVertexBuffer(
    device,
    new Float32Array(positions),
    "CubeMapPanorama-vertices",
  );

  const indexBuffer = WebGPUBuffer.createIndexBuffer(
    device,
    new Uint16Array(indices),
    "CubeMapPanorama-indices",
  );

  return { vertexBuffer, indexBuffer, indexCount: indices.length };
}

/**
 * Create the uniform buffer for cubemap panorama rendering.
 * @param {GPUDevice} device
 * @returns {{ uniformBuffer: GPUBuffer, uniformData: Float32Array }}
 */
export function createUniformBuffer(device) {
  const uniformData = new Float32Array(UNIFORM_FLOAT_COUNT);
  const uniformBuffer = device.createBuffer({
    label: "CubeMapPanorama-uniforms",
    size: UNIFORM_BUFFER_SIZE,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  return { uniformBuffer, uniformData };
}

/**
 * Create a cubemap sampler for the panorama.
 * @param {GPUDevice} device
 * @returns {GPUSampler}
 */
export function createCubeMapSampler(device) {
  return device.createSampler({
    label: "CubeMapPanorama-sampler",
    magFilter: "linear",
    minFilter: "linear",
    mipmapFilter: "linear",
    addressModeU: "clamp-to-edge",
    addressModeV: "clamp-to-edge",
    addressModeW: "clamp-to-edge",
  });
}

/**
 * Create bind groups for the cubemap panorama.
 * @param {GPUDevice} device
 * @param {GPUBuffer} uniformBuffer
 * @param {GPUSampler} sampler
 * @param {GPUTextureView} cubeMapView - Cubemap texture view
 * @returns {{ bindGroup0: GPUBindGroup, bindGroup1: GPUBindGroup }}
 */
export function createBindGroups(device, uniformBuffer, sampler, cubeMapView) {
  ensureLayouts(device);

  const bindGroup0 = device.createBindGroup({
    label: "CubeMapPanorama-bg0-uniforms",
    layout: _cachedBindGroupLayout0,
    entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
  });

  const bindGroup1 = device.createBindGroup({
    label: "CubeMapPanorama-bg1-textures",
    layout: _cachedBindGroupLayout1,
    entries: [
      { binding: 0, resource: sampler },
      { binding: 1, resource: cubeMapView },
    ],
  });

  return { bindGroup0, bindGroup1 };
}

/**
 * Update the uniform buffer with per-frame camera and transform data.
 *
 * @param {GPUDevice} device
 * @param {GPUBuffer} uniformBuffer
 * @param {Float32Array} uniformData
 * @param {Object} frameState - CesiumJS frame state containing uniform state
 *        and per-frame debug controls.
 * @param {Matrix3|Matrix4|undefined} panoramaTransform - Panorama orientation
 *        transform.
 * @param {Object|undefined} panorama - Backend-neutral panorama state.
 */
export function updateUniforms(
  device,
  uniformBuffer,
  uniformData,
  frameState,
  panoramaTransform,
  panorama,
) {
  const uniformState = frameState.context.uniformState;

  // Projection matrix (offset 0, 16 floats)
  packMatrix4(uniformState.projection, uniformData, 0);

  // View rotation as mat4x4 (offset 16, 16 floats)
  const viewRotation = uniformState.viewRotation;
  packMatrix3As4x4(viewRotation, uniformData, 16);

  // Panorama transform as mat4x4 (offset 32, 16 floats).
  // Parity with WebGL SkyBoxVS: when no explicit transform is supplied
  // (the SkyBox case), fall back to `czm_temeToPseudoFixed` so star-map
  // textures (authored in TEME / J2000 epoch) align with the current
  // Earth orientation. Standalone CubeMapPanorama still uses its
  // user-supplied transform (matches CubeMapPanoramaVS in WebGL).
  let transform;
  if (defined(panoramaTransform)) {
    if (panoramaTransform.length === 16) {
      // Matrix4 — extract 3x3 rotation part
      Matrix4.getMatrix3(panoramaTransform, scratchMatrix3);
      transform = scratchMatrix3;
    } else {
      // Matrix3
      transform = panoramaTransform;
    }
  } else {
    transform = uniformState.temeToPseudoFixedMatrix ?? IDENTITY_MATRIX3;
  }
  packMatrix3As4x4(transform, uniformData, 32);

  // Params: x=far, y=morphTime, z=debugCubeFace, w=skyBrightness
  // Source the debug field from `frameState` to keep the call signature
  // independent of per-frame controls. It is zero when disabled. Sky
  // brightness and modulation are resolved by `CubeMapPanorama` before
  // backend dispatch; generic panoramas carry an explicit identity vector.
  uniformData[48] = uniformState.entireFrustum.y; // far
  // `morphTime` lives on `frameState`, matching the WebGL `czm_morphTime`
  // source. Reading it from `uniformState` yields undefined, which propagates
  // a NaN alpha and leaves the destination at its clear color.
  uniformData[49] = frameState.morphTime ?? 1.0;
  uniformData[50] = frameState.debugShowCubeMapFace | 0; // 0=all, 1..6=face
  // `CubeMapPanorama` resolves this vector before backend dispatch. `SkyBox`
  // opts into `isStarMap`; generic and Street View panoramas resolve z and w
  // to zero so daylight and weather do not modulate them.
  const starModulation = panorama?._starModulation;
  uniformData[51] = panorama?._skyBrightness ?? 1.0;
  uniformData[52] = starModulation?.x ?? 0.0;
  uniformData[53] = starModulation?.y ?? 0.0;
  uniformData[54] = starModulation?.z ?? 0.0;
  uniformData[55] = starModulation?.w ?? 0.0;

  // `hdr.x` carries `czm_gamma`, defaulting to 2.2, when HDR is active and
  // zero otherwise. The fragment shader then mirrors `SkyBoxFS.glsl`'s
  // `czm_gammaCorrect` sRGB-to-linear decode. This matches the HDR gamma gate
  // used by the billboard, sun, and point renderers.
  uniformData[56] =
    frameState?.useHDR === true
      ? typeof uniformState?.gamma === "number"
        ? uniformState.gamma
        : 2.2
      : 0.0;

  // Angular solar-glare washout occupies floats 60 through 67.
  // `CubeMapPanorama` resolves it before backend dispatch, like
  // `_starModulation`. `isStarMap` gates the effect, so generic and Street
  // View panoramas write zero strength. Identity fallbacks cover an instance
  // that has not reached `update`.
  const solarGlare = panorama?._solarGlare;
  const solarGlareCurve = panorama?._solarGlareCurve;
  uniformData[60] = solarGlare?.x ?? 0.0;
  uniformData[61] = solarGlare?.y ?? 0.0;
  uniformData[62] = solarGlare?.z ?? 1.0;
  uniformData[63] = solarGlare?.w ?? 0.0;
  uniformData[64] = solarGlareCurve?.x ?? 1.0;
  uniformData[65] = solarGlareCurve?.y ?? 0.0;
  uniformData[66] = solarGlareCurve?.z ?? 0.0;
  uniformData[67] = 0.0;

  device.queue.writeBuffer(uniformBuffer, 0, uniformData);
}

/**
 * Create a complete WebGPUDrawCommand for cubemap panorama rendering.
 *
 * @param {GPUDevice} device
 * @param {GPUTextureFormat} canvasFormat
 * @param {WebGPUBuffer} vertexBuffer
 * @param {WebGPUBuffer} indexBuffer
 * @param {number} indexCount
 * @param {GPUBindGroup} bindGroup0
 * @param {GPUBindGroup} bindGroup1
 * @returns {WebGPUDrawCommand}
 */
export function createDrawCommand(
  device,
  canvasFormat,
  vertexBuffer,
  indexBuffer,
  indexCount,
  bindGroup0,
  bindGroup1,
  sampleCount,
) {
  const pipeline = getPipeline(device, canvasFormat, sampleCount);

  return new WebGPUDrawCommand({
    pipeline: pipeline,
    bindGroups: [bindGroup0, bindGroup1],
    vertexBuffers: [vertexBuffer],
    indexBuffer: indexBuffer,
    indexFormat: "uint16",
    indexCount: indexCount,
    pass: Pass.ENVIRONMENT,
    owner: null,
  });
}

/**
 * Destroy cached device-specific resources.
 * Called when the CubeMapPanorama is destroyed.
 */
export function resetCache() {
  _cachedShaderModule = null;
  _cachedPipeline = null;
  _cachedBindGroupLayout0 = null;
  _cachedBindGroupLayout1 = null;
  _cachedPipelineLayout = null;
  _cachedDevice = null;
}

// ── Per-instance state for the feature renderer pattern ──
// Uses a WeakMap so panorama instances can be GC'd normally.
const _instanceState = new WeakMap();

/**
 * Get or create the per-instance WebGPU state for a CubeMapPanorama.
 * @param {Object} panorama
 * @returns {Object}
 */
function getState(panorama) {
  let state = _instanceState.get(panorama);
  if (!defined(state)) {
    state = {
      vertexBuffer: undefined,
      indexBuffer: undefined,
      indexCount: 0,
      uniformBuffer: undefined,
      uniformData: undefined,
      sampler: undefined,
      bindGroup0: undefined,
      bindGroup1: undefined,
      cubeMapTexture: undefined,
      cubeMapView: undefined,
      command: undefined,
      cubeMapLoading: false,
      sources: undefined,
      addToPanoramaCommandList: false,
    };
    _instanceState.set(panorama, state);
  }
  return state;
}

/**
 * Expose the loaded cube texture so backend-neutral scene code can publish it
 * as a sampled star texture through `Scene/StarCubeMapResource.js`.
 *
 * Registered as the `CUBE_MAP_PANORAMA` feature renderer's `getResource`, so
 * `CubeMapPanorama` reaches it without importing from `Renderer/WebGPU/`.
 * Returns `undefined` while the six faces are loading.
 *
 * @param {Object} panorama The CubeMapPanorama instance.
 * @returns {{texture: GPUTexture, view: GPUTextureView}|undefined}
 */
export function getCubeMapPanoramaResource(panorama) {
  const state = _instanceState.get(panorama);
  if (
    !defined(state) ||
    !defined(state.cubeMapTexture) ||
    !defined(state.cubeMapView)
  ) {
    return undefined;
  }
  return { texture: state.cubeMapTexture, view: state.cubeMapView };
}

/**
 * Load cubemap images and create a WebGPU cubemap texture.
 * @param {GPUDevice} device
 * @param {Object} sources - CubeMap face sources (URLs or Image objects)
 * @param {Object} state - Per-instance state
 * @param {Object} panorama - CubeMapPanorama instance (for error reporting)
 */
function loadCubeMap(device, sources, state, panorama) {
  const faceNames = [
    "positiveX",
    "negativeX",
    "positiveY",
    "negativeY",
    "positiveZ",
    "negativeZ",
  ];

  //>>includeStart('debug', pragmas.debug);
  // Log source types and URLs for diagnosing fetch failures.
  for (const face of faceNames) {
    const src = sources[face];
    const srcType = typeof src;
    const srcDesc =
      srcType === "string"
        ? src.substring(src.lastIndexOf("/") + 1)
        : (src?.constructor?.name ?? srcType);
    console.log(`[WebGPU:SkyBox] face=${face} type=${srcType} src=${srcDesc}`);
  }
  //>>includeEnd('debug');

  const loadPromises = faceNames.map((face) => {
    const src = sources[face];
    if (typeof src === "string") {
      return fetch(src)
        .then((r) => {
          if (!r.ok) {
            throw new Error(
              `Fetch failed for ${face}: HTTP ${r.status} ${r.statusText} — ${src}`,
            );
          }
          return r.blob();
        })
        .then((b) => createImageBitmap(b));
    }
    // Image / HTMLImageElement / ImageBitmap — need to ensure it's loaded.
    // `HTMLImageElement` may not be decoded yet; `createImageBitmap` handles
    // decoding for every supported source type.
    if (src && typeof src === "object") {
      // HTMLImageElement: wait for it to finish loading if it hasn't yet.
      if (src instanceof HTMLImageElement && !src.complete) {
        return new Promise((resolve, reject) => {
          src.onload = () => createImageBitmap(src).then(resolve).catch(reject);
          src.onerror = () =>
            reject(new Error(`Image load failed for ${face}: ${src.src}`));
        });
      }
      // Already loaded image, ImageBitmap, canvas, etc. — createImageBitmap
      // normalises to a transferable bitmap the GPU can consume.
      return createImageBitmap(src);
    }
    return Promise.reject(
      new Error(`Invalid source for ${face}: ${typeof src}`),
    );
  });

  Promise.all(loadPromises)
    .then((images) => {
      const size = images[0].width;
      if (size <= 0) {
        throw new Error(
          `Cubemap face 0 has zero width — image may not have loaded`,
        );
      }
      const texture = device.createTexture({
        label: "CubeMapPanorama-cubemap",
        size: [size, size, 6],
        format: "rgba8unorm",
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.RENDER_ATTACHMENT,
        dimension: "2d",
      });

      for (let i = 0; i < 6; i++) {
        device.queue.copyExternalImageToTexture(
          // WebGL loads skybox faces with `UNPACK_FLIP_Y_WEBGL=true`, making
          // stored row 0 the image bottom. WebGL and WebGPU share the same
          // cube-face `(s, t)` derivation, so WebGPU must also flip on upload
          // to avoid sampling a vertically mirrored sky region.
          { source: images[i], flipY: true },
          { texture: texture, origin: [0, 0, i] },
          [size, size],
        );
      }

      state.cubeMapTexture = texture;
      state.cubeMapView = texture.createView({
        dimension: "cube",
        format: "rgba8unorm",
      });
      state.cubeMapLoading = false;
      //>>includeStart('debug', pragmas.debug);
      console.log(`[WebGPU:SkyBox] Cubemap loaded: ${size}x${size}, 6 faces`);
      //>>includeEnd('debug');
    })
    .catch((error) => {
      console.error(
        "[WebGPU:SkyBox] Cubemap load FAILED:",
        error?.message ?? error,
      );
      // Don't propagate as a scene-level error that would stop rendering.
      // The skybox just won't render — globe and terrain continue fine.
      state.cubeMapLoading = false;
    });
}

/**
 * Feature renderer update method for CubeMapPanorama.
 * Manages all WebGPU state internally — the scene file only calls this.
 *
 * @param {Object} panorama - The CubeMapPanorama instance
 * @param {Object} frameState - CesiumJS FrameState
 * @param {boolean} useHdr - Whether HDR is enabled
 * @returns {Object|undefined} The WebGPU draw command (if returnCommand mode)
 */
export function updateCubeMapPanorama(panorama, frameState, useHdr) {
  const { context, panoramaCommandList } = frameState;
  const device = context.device;
  const state = getState(panorama);

  // Load the cubemap when its sources change.
  if (state.sources !== panorama.sources && !state.cubeMapLoading) {
    state.sources = panorama.sources;
    state.cubeMapLoading = true;
    state.command = undefined;
    //>>includeStart('debug', pragmas.debug);
    console.log("[WebGPU:SkyBox] Loading cubemap textures...");
    //>>includeEnd('debug');
    loadCubeMap(device, state.sources, state, panorama);
  }

  // Create geometry buffers once.
  if (!defined(state.vertexBuffer)) {
    const geometry = _createBoxGeometry();
    const buffers = createGeometryBuffers(device, geometry);
    state.vertexBuffer = buffers.vertexBuffer;
    state.indexBuffer = buffers.indexBuffer;
    state.indexCount = buffers.indexCount;
  }

  // Create the uniform buffer and sampler once.
  if (!defined(state.uniformBuffer)) {
    const ub = createUniformBuffer(device);
    state.uniformBuffer = ub.uniformBuffer;
    state.uniformData = ub.uniformData;
    state.sampler = createCubeMapSampler(device);
  }

  // Wait for the cubemap texture.
  if (!defined(state.cubeMapView)) {
    //>>includeStart('debug', pragmas.debug);
    if (!state._waitLogged) {
      console.log(
        `[WebGPU:SkyBox] Waiting for cubemap: loading=${state.cubeMapLoading} ` +
          `hasError=${panorama._hasError} sources=${!!state.sources}`,
      );
      state._waitLogged = true;
    }
    //>>includeEnd('debug');
    return undefined;
  }

  // Invalidate the draw command when an HDR toggle changes the scene format.
  // Its pipeline bakes the fragment-output format, which must match the
  // recreated rgba16float scene framebuffer.
  const currentGen = context._scenePipelineFormatGeneration ?? 0;
  if (
    defined(state.command) &&
    state._pipelineFormatGeneration !== currentGen
  ) {
    state.command = undefined;
  }

  // Create bind groups and the draw command after the cubemap is ready.
  if (!defined(state.command)) {
    const bg = createBindGroups(
      device,
      state.uniformBuffer,
      state.sampler,
      state.cubeMapView,
    );
    state.bindGroup0 = bg.bindGroup0;
    state.bindGroup1 = bg.bindGroup1;

    // The skybox draws into the scene framebuffer, so its fragment-output
    // format must use `scenePipelineFormat`, including rgba16float in HDR.
    const sceneFormat =
      context.scenePipelineFormat ?? navigator.gpu.getPreferredCanvasFormat();
    state.command = createDrawCommand(
      device,
      sceneFormat,
      state.vertexBuffer,
      state.indexBuffer,
      state.indexCount,
      state.bindGroup0,
      state.bindGroup1,
      context._msaaSamples ?? 1,
    );
    state._pipelineFormatGeneration = currentGen;
  }

  // Update uniforms every frame.
  updateUniforms(
    device,
    state.uniformBuffer,
    state.uniformData,
    frameState,
    panorama._transform,
    panorama,
  );

  // Add credits for visible scene-owned panoramas.
  if (panorama.show && defined(panorama._credit) && !panorama._returnCommand) {
    frameState.creditDisplay.addCreditToNextFrame(panorama._credit);
  }

  if (panorama._returnCommand) {
    return state.command;
  }

  // Push to panoramaCommandList every frame — the list is cleared each frame
  panoramaCommandList.push(state.command);
  //>>includeStart('debug', pragmas.debug);
  if (!state._pushLogged) {
    console.log(
      `[WebGPU:SkyBox] Command pushed to panoramaCommandList (len=${panoramaCommandList.length})`,
    );
    state._pushLogged = true;
  }
  //>>includeEnd('debug');
}

// Lazily-created box geometry (shared across all instances)
import BoxGeometry from "../../Core/BoxGeometry.js";
import Cartesian3 from "../../Core/Cartesian3.js";
import VertexFormat from "../../Core/VertexFormat.js";

let _cachedBoxGeometry = null;

function _createBoxGeometry() {
  if (!_cachedBoxGeometry) {
    _cachedBoxGeometry = BoxGeometry.createGeometry(
      BoxGeometry.fromDimensions({
        dimensions: new Cartesian3(2.0, 2.0, 2.0),
        vertexFormat: VertexFormat.POSITION_ONLY,
      }),
    );
  }
  return _cachedBoxGeometry;
}

/**
 * Feature renderer destroy method for CubeMapPanorama.
 * Cleans up all per-instance WebGPU resources.
 *
 * @param {Object} panorama - The CubeMapPanorama instance
 */
export function destroyCubeMapPanorama(panorama) {
  const state = _instanceState.get(panorama);
  if (!defined(state)) {
    return;
  }

  if (defined(state.vertexBuffer)) {
    state.vertexBuffer.destroy();
  }
  if (defined(state.indexBuffer)) {
    state.indexBuffer.destroy();
  }
  if (defined(state.uniformBuffer)) {
    state.uniformBuffer.destroy();
  }
  if (defined(state.cubeMapTexture)) {
    state.cubeMapTexture.destroy();
  }

  _instanceState.delete(panorama);
}

export default {
  createGeometryBuffers,
  createUniformBuffer,
  createCubeMapSampler,
  createBindGroups,
  updateUniforms,
  createDrawCommand,
  resetCache,
  updateCubeMapPanorama,
  destroyCubeMapPanorama,
};
