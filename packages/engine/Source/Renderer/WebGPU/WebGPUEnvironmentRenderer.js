/**
 * Handles WebGPU rendering of celestial bodies (Sun, Moon) and Fog integration.
 * Sun uses a procedurally generated texture rendered as a billboard quad.
 * Moon uses a textured sphere with simple diffuse lighting.
 * Fog is applied via fog density parameters passed to globe/atmosphere shaders.
 *
 * @private
 * @module WebGPUEnvironmentRenderer
 */
import Cartesian3 from "../../Core/Cartesian3.js";
import CesiumMath from "../../Core/Math.js";
import createGuid from "../../Core/createGuid.js";
import defined from "../../Core/defined.js";
import EncodedCartesian3 from "../../Core/EncodedCartesian3.js";
import Matrix4 from "../../Core/Matrix4.js";
import { getSharedMoonDecodedSourceCache } from "../../Core/MoonDecodedSourceCache.js";
import MoonShaderCode from "../../Shaders/WebGPU/Environment/Moon.js";
import { WebGPUImageUpload } from "./WebGPUImageUpload.js";
import WebGPUBuffer from "./WebGPUBuffer.js";
import WebGPUDrawCommand from "./WebGPUDrawCommand.js";
import {
  MoonTextureChannel,
  commitWebGPUMoonTextureCandidate,
  createWebGPUMoonUploadSource,
  createWebGPUMoonTextureLifecycle,
  createWebGPUMoonTexturePairKey,
  getWebGPUMoonTextureLifecycleDiagnostics,
  reconcileWebGPUMoonTextureChannel,
  releaseWebGPUMoonUploadSource,
  retireWebGPUMoonPublishedTexture,
  retireWebGPUMoonTextureLifecycle,
} from "./WebGPUMoonTextureLifecycle.js";
// Slice 5c-B Phase 1 (Batch 106) — scene-FB target helper.
import {
  makeSceneFBTargets,
  isSceneFBMrtMode,
  MRT_NORMAL_ROUGHNESS_FORMAT,
} from "./WebGPUSceneFBTargetHelpers.js";
import {
  makeBindGroupLayout,
  uniformBuffer,
  texture,
  sampler,
  Stage,
} from "./WebGPUBindGroupLayoutHelpers.js";
// Phase 1.x consolidation — shared bounding-cube + base uniform pack
// for ellipsoid bodies. Moon is the first consumer; future Sun-as-
// ellipsoid and custom planet renderers will share these helpers.
import {
  createEllipsoidBoundingCube,
  createEllipsoidBindGroupLayout,
  packEllipsoidBaseUniforms,
} from "./WebGPUEllipsoidRenderer.js";
import { ShaderSourceId } from "./WebGPUShaderDefines.js";
import { WebGPUShaderModuleCache } from "./WebGPUShaderModuleCache.js";

// Per-device shader module cache so two Sun / Moon instances on the same
// `GPUDevice` share one compiled `GPUShaderModule`.
// (C-R7-SHADER-MODULE-DEDUP, Batch 74.)
const _envShaderModuleCaches = new WeakMap();

function getEnvShaderModuleCache(device) {
  let cache = _envShaderModuleCaches.get(device);
  if (!cache) {
    cache = new WebGPUShaderModuleCache(device);
    _envShaderModuleCaches.set(device, cache);
  }
  return cache;
}

// Sun WGSL hoisted out of the per-update block so the module cache can
// dedupe it by source id. Pure relocation — content is unchanged.
const SUN_SHADER_WGSL = `
struct Uniforms {
  mvpRTE: mat4x4<f32>,
  encodedCameraHigh: vec3<f32>, _p0: f32,
  encodedCameraLow: vec3<f32>, _p1: f32,
  sunSize: vec2<f32>, glowFactor: f32, gamma: f32,
  // C7-SUN-STARS-EXTINCTION — per-channel atmospheric transmittance along
  // the camera→sun ray (offset 112, 16-aligned). vec3(1.0) from orbit / when
  // the atmosphere is hidden, so the multiply below is a no-op (byte-identical).
  // C12-29 S1 — eclipseAlpha occupies the former _p2 pad at offset 124.
  // The pad was already written (as 0.0) and already reserved by the 256-byte
  // uniform buffer, so this is a rename + a use, not a layout change: no
  // stride, alignment, binding or bind-group-layout delta, and no new
  // ShaderDefine bit (the registry is exhausted; C12 exit-gate item 5).
  extinction: vec3<f32>, eclipseAlpha: f32,
  // Sun position is dynamic uniform state, not vertex state. Keeping it here
  // lets one immutable six-corner buffer and one draw command survive every
  // clock tick while retaining encoded high/low RTE precision.
  encodedSunHigh: vec3<f32>, _sunPad0: f32,
  encodedSunLow: vec3<f32>, _sunPad1: f32,
};
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var tex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;

struct VOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };

@vertex fn vs(@location(0) dir: vec2<f32>) -> VOut {
  var o: VOut;
  let rte = (u.encodedSunHigh - u.encodedCameraHigh) +
    (u.encodedSunLow - u.encodedCameraLow);
  var cp = u.mvpRTE * vec4f(rte, 1.0);
  cp.x += dir.x * u.sunSize.x * cp.w;
  cp.y += dir.y * u.sunSize.y * cp.w;
  // Clamp the sun to the far plane. Without this the sun (world-space ~1.5e11 m)
  // gets frustum-clipped at every camera altitude whose far plane is < 1.5e11 m
  // — which is every multi-frustum slice except possibly the last.
  // Setting clip-z = clip-w maps to NDC z = 1.0, i.e. the far plane, so the
  // "less-equal" depth compare still allows the sun to render against any
  // previously-cleared depth value.
  o.pos = vec4f(cp.x, cp.y, cp.w, cp.w);
  o.uv = dir * 0.5 + 0.5; return o;
}

@fragment fn fs(i: VOut) -> @location(0) vec4<f32> {
  // BUG-1 fix — near-passthrough sample (matches WebGL SunFS.glsl). The baked
  // texture already carries the disc + glow halo + lens-flare (createSunTexture
  // replicates SunTextureFS.glsl); the previous extra exp() glow here was a
  // redundant second halo that over-brightened the (then disc-only) sun. The
  // additive blend turns the white texel * alpha into a glowing sun over the sky.
  var color = textureSample(tex, samp, i.uv);
  // czm_gammaCorrect parity (WebGL SunFS.glsl) — RGB→linear (pow(rgb, gamma))
  // when HDR is active so the sun composites correctly into the linear HDR
  // scene buffer. gamma == 1.0 (default / non-HDR) skips the branch entirely,
  // keeping the output byte-identical to the pre-gamma path.
  if (u.gamma != 1.0) {
    color = vec4f(pow(color.rgb, vec3f(u.gamma)), color.a);
  }
  // C7-SUN-STARS-EXTINCTION — attenuate + redden the sun by the atmospheric
  // extinction (dims + warms a low sun over the horizon). extinction == (1,1,1)
  // from orbit / atmosphere hidden, so this is a byte-identical no-op there.
  color = vec4f(color.rgb * u.extinction, color.a);
  // C12-29 S1 — continuous eclipse / occultation fade, the WGSL twin of
  // SunFS.glsl's out_FragColor.a *= u_eclipseAlpha. ALPHA, not rgb: this
  // pipeline blends additively with srcFactor src-alpha, so scaling alpha
  // scales the whole additive contribution; it also fades correctly if
  // C11-115 flips this target to ALPHA_BLEND. eclipseAlpha == 1.0 whenever
  // nothing occults the sun or enableEclipse is off — an exact no-op.
  color = vec4f(color.rgb, color.a * u.eclipseAlpha);
  return color;
}`;

/**
 * Convert our cache-friendly descriptor back into the WebGPU descriptor
 * shape for the fallback path (no central cache available).
 * @private
 */
function _envDescriptorToGPU(d) {
  return {
    label: d.name,
    layout: d.layout ?? "auto",
    vertex: {
      module: d.vertex.module,
      entryPoint: d.vertex.entryPoint,
      buffers: d.vertex.buffers,
    },
    fragment: d.fragment
      ? {
          module: d.fragment.module,
          entryPoint: d.fragment.entryPoint,
          targets: d.fragment.targets,
        }
      : undefined,
    primitive: d.primitive,
    depthStencil: d.depthStencil,
    multisample: d.multisample,
  };
}

/**
 * Resolve a single environment-renderer pipeline (Sun or Moon) through
 * the central pipeline cache. Returns the pipeline if cached; otherwise
 * kicks off async creation and returns null. Falls back to direct
 * synchronous creation when `pipelineCache` is null.
 *
 * C-R7-RENDERER-MIGRATION (Batch 74). Mirrors `tryResolvePolylinePipeline`.
 * @private
 */
function tryResolveEnvPipeline(device, pipelineCache, entry) {
  if (entry.pipeline) {
    return entry.pipeline;
  }
  if (pipelineCache) {
    const sync = pipelineCache.getPipelineSync(entry.descriptor);
    if (sync) {
      entry.pipeline = sync;
      entry.pending = false;
      return sync;
    }
    if (!entry.pending) {
      entry.pending = true;
      pipelineCache
        .getPipeline(entry.descriptor)
        .then((p) => {
          entry.pipeline = p;
          entry.pending = false;
        })
        .catch(() => {
          entry.pending = false;
        });
    }
    return null;
  }
  entry.pipeline = device.createRenderPipeline(
    _envDescriptorToGPU(entry.descriptor),
  );
  entry.pending = false;
  return entry.pipeline;
}

const UNIFORM_BUFFER_SIZE = 256;
// Moon uses a slightly larger uniform buffer to fit the full Phase 1.2c v2
// state (RTE moon center + camera split + 3x3 inverse-modelView + radii +
// 2 light directions + celestial state + Phong tunables + log-depth far).
// 320 → 336 for the C12 moon wave (lunarBRDF flag reuses the old spare at
// byte 316; inscatter vec3 + oppositionSurge appended at 320..335) —
// ADD-ONLY at the tail, existing offsets frozen (phaseFraction stays at
// float offset 67 / byte 268).
// 336 → 352 for C12-25's `normalStrength` (byte 336 / float offset 84): the
// 320..335 slot was already full (inscatter vec3 + oppositionSurge), so the
// new scalar opens a fresh 16-byte slot. Still add-only at the tail.
const MOON_UNIFORM_BUFFER_SIZE = 352;
const scratchModelView = new Matrix4();
const scratchMVRTE = new Matrix4();
const scratchMVPRTE = new Matrix4();
// Phase 1.x consolidation — the inverseModelView3, cameraMC, sunMC,
// sceneLightMC, inverseModelMatrix, and inverseModelRot3 scratches that
// the old `_packMoonUniforms` body used were moved into
// `WebGPUEllipsoidRenderer.ts` along with the base uniform pack. The
// scratches kept here are still used by the Sun renderer
// (`scratchEncodedPos`, `scratchEncodedCamera`) and the Moon
// behind-camera early-out (`scratchMoonPositionWC`, `scratchCameraToMoon`).
const scratchEncodedCamera = new EncodedCartesian3();
const scratchMoonPositionWC = new Cartesian3();
const scratchCameraToMoon = new Cartesian3();
const scratchEncodedPos = new EncodedCartesian3();
const defaultSunPosition = Object.freeze(new Cartesian3(1.5e11, 0.0, 0.0));

// ============================================================
// Sun Renderer
// ============================================================

/**
 * C12-17 — WebGL's sun texture is sized from the drawing buffer
 * (`Sun.js`: `2^(ceil(log2(max(w, h))) - 2)`, clamped to >= 1). WebGPU
 * hardcoded 256. This reproduces the WebGL rule so the two backends bake at
 * the same resolution, with ONE deliberate difference: an upper cap.
 *
 * WHY THE CAP. WebGL bakes on the GPU (a ComputeCommand full-screen pass);
 * WebGPU bakes on the CPU in a JS double loop, so an uncapped 8K canvas
 * would ask for a 2048^2 = 4.2 Mpx loop on the main thread at every resize.
 * The cap costs nothing visually: the billboard's on-screen footprint is
 * `22 * limbPx` pixels and `limbPx` is ~4.3 px at 1080p / 60 deg FOV, i.e.
 * the quad is ~95 px wide, so even 256^2 is already ~2.7x oversampled and
 * 1024^2 is ~11x. Resolution is not the visual lever here — FORMAT is, which
 * is the other half of C12-17.
 *
 * @param {number} width Drawing buffer width in pixels.
 * @param {number} height Drawing buffer height in pixels.
 * @returns {number} Bake edge length in texels.
 * @private
 */
function sunTextureSize(width, height) {
  const maxDim = Math.max(width | 0, height | 0);
  if (!(maxDim > 0)) {
    return 256;
  }
  const size = Math.pow(2.0, Math.ceil(Math.log(maxDim) / Math.log(2.0)) - 2.0);
  return Math.min(1024, Math.max(1.0, size));
}

// C12-17 — IEEE-754 binary32 -> binary16 conversion for the HDR bake.
// `Float16Array` is too new to rely on in the browsers this fork targets, so
// the packing is explicit. Every value this bake produces is a finite number
// in [0, 1] (main() clamps), so the Inf/NaN paths are unreachable and the
// only special case that matters is flushing values below the smallest
// binary16 subnormal (2^-24) to zero.
const _f32Scratch = new Float32Array(1);
const _u32Scratch = new Uint32Array(_f32Scratch.buffer);

function floatToHalfBits(value) {
  _f32Scratch[0] = value;
  const bits = _u32Scratch[0];
  const sign = (bits >>> 16) & 0x8000;
  const exponent = (bits >>> 23) & 0xff;
  const mantissa = bits & 0x7fffff;
  // Rebiased exponent (127 -> 15).
  const e = exponent - 112;
  if (e >= 31) {
    // Overflow / Inf / NaN — unreachable for a clamped [0, 1] bake, but a
    // finite saturation is the safe answer rather than a silent Inf.
    return sign | 0x7bff;
  }
  if (e <= 0) {
    if (e < -10) {
      return sign;
    }
    // Subnormal: restore the implicit leading 1 and shift into place,
    // rounding to nearest.
    const m = mantissa | 0x800000;
    const shift = 14 - e;
    const half = (m >>> shift) + ((m >>> (shift - 1)) & 1);
    return sign | half;
  }
  const half = (e << 10) | (mantissa >>> 13);
  // Round to nearest on the dropped bit.
  return sign | (half + ((mantissa >>> 12) & 1));
}

/**
 * Creates sun procedural texture via CPU fallback.
 *
 * @param {GPUDevice} device The device.
 * @param {number} size Edge length in texels ({@link sunTextureSize}).
 * @param {number} glowFactor `Sun.glowFactor`.
 * @param {string} format `"rgba16float"` under HDR, otherwise `"rgba8unorm"`
 *        (C12-17 parity with WebGL's HALF_FLOAT/UNSIGNED_BYTE selection).
 * @param {object} appearance Resolved `frameState.sunDiscAppearance`
 *        (C12-15 / C12-16); see `Scene/SunDiscAppearance.js`.
 * @private
 */
function createSunTexture(device, size, glowFactor, format, appearance) {
  const texture = device.createTexture({
    label: `Sun procedural texture [${size}^2 ${format}]`,
    size: [size, size, 1],
    format: format,
    usage:
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.STORAGE_BINDING |
      GPUTextureUsage.COPY_DST,
  });

  // BUG-1 fix — bake the sun texture exactly like WebGL SunTextureFS.glsl
  // instead of the old disc-fills-85%-of-texture procedural (which left no
  // room for a glow halo or lens flare). The disc occupies a SMALL central
  // radius (u_radiusTS), a soft glow halo fills the rest, and six pre-rotated
  // lens-flare bursts radiate out. RGB is ~white; the disc+glow+flare shape
  // lives in alpha (and blue), so additive blending paints a glowing sun.
  // glowLengthTS mirrors WebGL Sun.update (Sun.js:182-183): glowFactor * 5,
  // which shrinks the central disc (radiusTS) and widens the glow halo as
  // glowFactor rises. Sun default glowFactor = 1 -> glowLengthTS = 5.
  const glowLengthTS = glowFactor * 5.0;
  const radiusTS = 0.5 / (1.0 + 2.0 * glowLengthTS);
  const lengthScalar = 2.0 / Math.sqrt(2.0);
  const smoothstep = (e0, e1, x) => {
    const t = Math.min(1.0, Math.max(0.0, (x - e0) / (e1 - e0)));
    return t * t * (3.0 - 2.0 * t);
  };
  // C12-15 / C12-16 — the SAME resolution the WebGL bake receives as
  // uniforms (`frameState.sunDiscAppearance`, published by `Sun.update`
  // before the backend branch). `a1 = a2 = 0, a0 = 1` is the disabled
  // position and reproduces the historical flat disc exactly;
  // `glareLegacy = 1` selects the historical smoothstep halo.
  const a0 = appearance ? appearance.a0 : 1.0;
  const a1 = appearance ? appearance.a1 : 0.0;
  const a2 = appearance ? appearance.a2 : 0.0;
  const glareCore = appearance ? appearance.glareCore : 0.275;
  const glarePedestal = appearance ? appearance.glarePedestal : 0.0;
  const glareLegacyEdge = appearance ? appearance.glareLegacyEdge : 0.55;
  const glareLegacy = appearance ? appearance.glareLegacy : 1.0;
  // Twin of `sunGlare()` in SunTextureFS.glsl — keep the two in lockstep.
  const sunGlare = (radius) => {
    if (glareLegacy > 0.5) {
      return 1.0 - smoothstep(0.0, glareLegacyEdge, radius);
    }
    const t = radius / glareCore;
    const raw = 1.0 / (1.0 + t * t);
    const shaped = (raw - glarePedestal) / (1.0 - glarePedestal);
    return Math.min(1.0, Math.max(0.0, shaped));
  };
  // Six manually-unrolled burst directions from SunTextureFS.glsl:42-48.
  const bursts = [
    [0.38942, 0.92106, 0.4],
    [0.99235, 0.12348, 0.4],
    [0.60327, -0.79754, 0.4],
    [0.31457, 0.94924, 0.3],
    [0.97931, 0.20239, 0.3],
    [0.66507, -0.74678, 0.3],
  ];
  const isHalf = format === "rgba16float";
  const pixels = isHalf
    ? new Uint16Array(size * size * 4)
    : new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = (x + 0.5) / size - 0.5;
      const py = (y + 0.5) / size - 0.5;
      const radius = Math.sqrt(px * px + py * py) * lengthScalar;
      // C12-15 — limb-darkened disc radiance in place of the binary step.
      // See the SDR-clamp caveat in SunTextureFS.glsl's main(): with the
      // 0..1 clamp below still in place this is masked at defaults and
      // becomes visible under C12-19.
      const xr = Math.min(radius / radiusTS, 1.0);
      const muSq = 1.0 - xr * xr;
      const mu = muSq > 0.0 ? Math.sqrt(muSq) : 0.0;
      const limb = a0 + a1 * mu + a2 * mu * mu;
      const surface = (radius <= radiusTS ? 1.0 : 0.0) * limb;
      // color = vec4(1, 1, surface + 0.2, surface)
      let cr = 1.0;
      let cg = 1.0;
      let cb = surface + 0.2;
      let ca = surface;
      // glow halo into blue + alpha.
      const glow = sunGlare(radius);
      cb += glow * 0.75;
      ca += glow * 0.75;
      // lens-flare bursts (rotate(position, dir) * (25, 0.75), then radius).
      // Aperture diffraction, not veiling glare — unchanged by C12-16, and
      // reading `glareLegacyEdge` for the same 0.55 the GLSL twin uses.
      let burst = 0.0;
      for (let b = 0; b < bursts.length; b++) {
        const dx = bursts[b][0];
        const dy = bursts[b][1];
        const rx = (px * dx - py * dy) * 25.0;
        const ry = (px * dy + py * dx) * 0.75;
        const rb = Math.sqrt(rx * rx + ry * ry) * lengthScalar;
        burst += bursts[b][2] * (1.0 - smoothstep(0.0, glareLegacyEdge, rb));
      }
      burst = Math.min(1.0, Math.max(0.0, burst)) * 0.15;
      cr += burst;
      cg += burst;
      cb += burst;
      ca += burst;

      const idx = (y * size + x) * 4;
      if (isHalf) {
        // C12-17 — HDR bake. The values are still clamped to [0, 1] here
        // (removing that clamp is C12-19's job and needs the BrightPass
        // retune); half-float buys PRECISION in the glare tail, which is
        // exactly where 8-bit quantisation truncated the profile. Measured:
        // rgba8unorm cannot represent alpha below 1/255 = 0.00392, which
        // clips the legacy halo at 8.199 solar radii instead of its true
        // 8.556 — a 4.2% radial loss, and 100% of the C12-16 tail beyond it.
        pixels[idx + 0] = floatToHalfBits(Math.min(1.0, Math.max(0.0, cr)));
        pixels[idx + 1] = floatToHalfBits(Math.min(1.0, Math.max(0.0, cg)));
        pixels[idx + 2] = floatToHalfBits(Math.min(1.0, Math.max(0.0, cb)));
        pixels[idx + 3] = floatToHalfBits(Math.min(1.0, Math.max(0.0, ca)));
      } else {
        pixels[idx + 0] = Math.min(255, Math.max(0, cr) * 255);
        pixels[idx + 1] = Math.min(255, Math.max(0, cg) * 255);
        pixels[idx + 2] = Math.min(255, Math.max(0, cb) * 255);
        pixels[idx + 3] = Math.min(255, Math.max(0, ca) * 255);
      }
    }
  }

  const bytesPerRow = size * 4 * (isHalf ? 2 : 1);
  device.queue.writeTexture({ texture }, pixels, { bytesPerRow: bytesPerRow }, [
    size,
    size,
    1,
  ]);

  return texture;
}

/**
 * Immutable sun billboard corners. The moving ECEF sun center lives in the
 * uniform buffer, so this array and its GPU buffer are created once.
 * @private
 */
const SUN_QUAD_DIRECTIONS = new Float32Array([
  -1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1,
]);

function createSunQuadBuffer(device) {
  return WebGPUBuffer.createVertexBuffer(
    device,
    SUN_QUAD_DIRECTIONS,
    "Sun vertices",
  );
}

function packSunUniforms(uniformData, frameState, glowFactor, gamma) {
  const uniformState = frameState.context.uniformState;
  Matrix4.clone(uniformState.view, scratchModelView);
  Matrix4.clone(scratchModelView, scratchMVRTE);
  scratchMVRTE[12] = 0.0;
  scratchMVRTE[13] = 0.0;
  scratchMVRTE[14] = 0.0;
  Matrix4.multiply(uniformState.projection, scratchMVRTE, scratchMVPRTE);
  Matrix4.pack(scratchMVPRTE, uniformData, 0);

  EncodedCartesian3.fromCartesian(
    frameState.camera.positionWC,
    scratchEncodedCamera,
  );
  uniformData[16] = scratchEncodedCamera.high.x;
  uniformData[17] = scratchEncodedCamera.high.y;
  uniformData[18] = scratchEncodedCamera.high.z;
  uniformData[19] = 0.0;
  uniformData[20] = scratchEncodedCamera.low.x;
  uniformData[21] = scratchEncodedCamera.low.y;
  uniformData[22] = scratchEncodedCamera.low.z;
  uniformData[23] = 0.0;

  // BUG-1 fix — size the sun quad from its true angular radius + glow length,
  // aspect-corrected, instead of the old fixed (0.02, 0.02) NDC half-extent
  // (which, applied equally to a non-square viewport, made the sun a tiny
  // glow-less ellipse easily lost against the stars — the "sun absent"
  // symptom). Mirrors WebGL Sun.update (Sun.js:301-317): on-screen size =
  // 2 * solarLimbPixels * (1 + 2*glowLengthTS), glowLengthTS = glowFactor*5.
  // NDC half-extent = (SOLAR_RADIUS / camera->sun distance) * projection focal
  // term * (1 + 2*glowLengthTS). Using projection[0] for X and [5] for Y
  // auto-corrects aspect (proj[0] = proj[5]/aspect for a perspective frustum),
  // so the quad is circular. The texture (createSunTexture) carries the small
  // central disc + soft glow halo + lens-flare bursts across the full quad.
  const glowLengthTS = glowFactor * 5.0;
  const sunSizeScale = 1.0 + 2.0 * glowLengthTS;
  const sunPos = uniformState.sunPositionWC ?? defaultSunPosition;
  const sunDist = Cartesian3.distance(sunPos, frameState.camera.positionWC);
  // Solar angular half-size (radians); fall back to ~0.0046 (the real solar
  // angular radius at 1 AU) if the distance is unavailable.
  const angHalf = sunDist > 0.0 ? CesiumMath.SOLAR_RADIUS / sunDist : 0.0046;
  const proj = uniformState.projection;
  uniformData[24] = angHalf * Math.abs(proj[0]) * sunSizeScale; // sunSize.x
  uniformData[25] = angHalf * Math.abs(proj[5]) * sunSizeScale; // sunSize.y
  uniformData[26] = glowFactor;
  uniformData[27] = gamma;

  // C7-SUN-STARS-EXTINCTION — RGB atmospheric transmittance at offsets 28..30
  // (vec3 `extinction`, 16-byte aligned at byte 112). Defaults to (1,1,1) when
  // the atmosphere is hidden or the sun is viewed from orbit, making the shader
  // multiply an exact no-op (byte-identical). Published by Sun.update.
  const extinction = frameState.sunAtmosphereExtinction;
  uniformData[28] = defined(extinction) ? extinction.x : 1.0;
  uniformData[29] = defined(extinction) ? extinction.y : 1.0;
  uniformData[30] = defined(extinction) ? extinction.z : 1.0;

  // C12-29 S1 — eclipse fade at offset 31 (the former `_p2` pad, byte 124).
  // `Sun.update` publishes this before the backend branch, so WebGL's
  // `u_eclipseAlpha` and this slot always carry the same scalar. Falls back
  // to 1.0 (exact identity) when the publisher hasn't run.
  const eclipseAlpha = frameState.sunEclipseAlpha;
  uniformData[31] = typeof eclipseAlpha === "number" ? eclipseAlpha : 1.0;

  EncodedCartesian3.fromCartesian(sunPos, scratchEncodedPos);
  uniformData[32] = scratchEncodedPos.high.x;
  uniformData[33] = scratchEncodedPos.high.y;
  uniformData[34] = scratchEncodedPos.high.z;
  uniformData[35] = 0.0;
  uniformData[36] = scratchEncodedPos.low.x;
  uniformData[37] = scratchEncodedPos.low.y;
  uniformData[38] = scratchEncodedPos.low.z;
  uniformData[39] = 0.0;
}

/**
 * Updates WebGPU Sun rendering.
 */
function updateWebGPUSun(sun, frameState) {
  if (!sun.show) {
    return;
  }
  const context = frameState.context;
  const device = context.device;

  if (defined(sun._webgpuCache) && sun._webgpuCache.device !== device) {
    destroyWebGPUSunResources(sun);
  }
  if (!defined(sun._webgpuCache)) {
    sun._webgpuCache = {
      device,
    };
  }
  const cache = sun._webgpuCache;

  // Parity with WebGL Sun (Sun.js) — the user-tunable glowFactor drives both
  // the baked texture (disc radius + glow-halo length) and the on-screen quad
  // size. Sun.glowFactor's setter clamps to >= 0; default 1.0 reproduces the
  // historical hardcoded bake, so default scenes stay byte-identical.
  const glowFactor = defined(sun.glowFactor) ? sun.glowFactor : 1.0;

  // C12-17 — bake size + format parity with WebGL (`Sun.update`): size from
  // the drawing buffer, HALF_FLOAT-equivalent storage under HDR. Previously
  // hardcoded 256^2 rgba8unorm regardless of canvas or HDR state.
  const bakeSize = sunTextureSize(
    context.drawingBufferWidth,
    context.drawingBufferHeight,
  );
  const bakeFormat = frameState.useHDR === true ? "rgba16float" : "rgba8unorm";
  // C12-15 / C12-16 — resolved by `Sun.update` before the backend branch, so
  // this is the identical payload the WebGL bake's uniforms carry.
  const appearance = frameState.sunDiscAppearance;
  // Fallback key MUST be 0 (both toggles OFF), because that is exactly what
  // `createSunTexture` bakes when `appearance` is undefined (a0 = 1, a1 = a2
  // = 0, glareLegacy = 1 — the historical disc + smoothstep halo). Using 3
  // here would cache a LEGACY bake under a "both ON" signature and never
  // rebuild it once a real appearance arrived carrying the same key.
  // Unreachable today (`Sun.update` publishes before the FR branch), which is
  // precisely why the mismatch would have been permanent if it ever fired.
  const appearanceKey = defined(appearance) ? appearance.key : 0;

  // Regenerate the baked texture when glowFactor, the drawing-buffer-derived
  // size, the HDR format or the C12-15/16 toggle signature changes (mirrors
  // WebGL's `_glowFactorDirty` / drawing-buffer / `_useHdr` rebuild set).
  // Rebuild only on change to avoid a per-frame CPU bake.
  if (
    defined(cache.sunTexture) &&
    (cache.lastGlowFactor !== glowFactor ||
      cache.lastBakeSize !== bakeSize ||
      cache.lastBakeFormat !== bakeFormat ||
      cache.lastAppearanceKey !== appearanceKey)
  ) {
    cache.sunTexture.destroy();
    cache.sunTexture = undefined;
    cache.sunTextureView = undefined;
    cache.bindGroup = undefined;
    cache.command = undefined;
  }

  if (!defined(cache.sunTexture)) {
    cache.sunTexture = createSunTexture(
      device,
      bakeSize,
      glowFactor,
      bakeFormat,
      appearance,
    );
    cache.lastGlowFactor = glowFactor;
    cache.lastBakeSize = bakeSize;
    cache.lastBakeFormat = bakeFormat;
    cache.lastAppearanceKey = appearanceKey;
    cache.sunTextureView = cache.sunTexture.createView();
    if (!defined(cache.sampler)) {
      cache.sampler = device.createSampler({
        minFilter: "linear",
        magFilter: "linear",
      });
    }
  }

  // Batch 110 \u2014 invalidate cached pipeline when scene format changes
  // (HDR toggle). The Sun pipeline targets the scene FB, so its
  // fragment-output format must match the recreated scene FB.
  const currentGen = context._scenePipelineFormatGeneration ?? 0;
  if (
    defined(cache.pipelineEntry) &&
    cache._pipelineFormatGeneration !== currentGen
  ) {
    cache.pipelineEntry = undefined;
    cache.pipeline = undefined;
    cache.bindGroup = undefined;
    cache.command = undefined;
  }

  // C-R7 (Batch 74) \u2014 descriptor + central pipeline cache. Two Sun
  // instances on the same device share one compiled shader module + one
  // pipeline.
  if (!defined(cache.pipelineEntry)) {
    const moduleCache = getEnvShaderModuleCache(device);
    const shaderModule = moduleCache.getOrCreate(
      ShaderSourceId.ENVIRONMENT_SUN,
      SUN_SHADER_WGSL,
      0,
      "Sun shader",
    );

    const bgl = makeBindGroupLayout(device, "Sun BGL", [
      uniformBuffer(0, Stage.VERTEX_FRAGMENT),
      texture(1, Stage.FRAGMENT),
      sampler(2, Stage.FRAGMENT),
    ]);

    const format = context.scenePipelineFormat || "bgra8unorm";
    const depthFormat = context.depthFormat || "depth24plus-stencil8";
    const descriptor = {
      name: `Sun pipeline [${format}/${depthFormat}]`,
      layout: device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
      vertex: {
        module: shaderModule,
        entryPoint: "vs",
        buffers: [
          {
            arrayStride: 8,
            attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }],
          },
        ],
      },
      fragment: {
        module: shaderModule,
        entryPoint: "fs",
        // Slice 5c-B Phase 1 (Batch 106) — scene-FB target. Additive
        // blend (src.a × src + 1 × dst) for the sun/moon flare layer.
        targets: makeSceneFBTargets(format, {
          blend: {
            color: {
              srcFactor: "src-alpha",
              dstFactor: "one",
              operation: "add",
            },
            alpha: {
              srcFactor: "one",
              dstFactor: "one",
              operation: "add",
            },
          },
        }),
      },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: {
        format: depthFormat,
        depthWriteEnabled: false,
        depthCompare: "less-equal",
      },
      // Session 65 Batch 21 — match scene FB sample count.
      multisample:
        (context._msaaSamples ?? 1) > 1
          ? { count: context._msaaSamples }
          : undefined,
    };
    cache.pipelineEntry = { descriptor, pipeline: null, pending: false };
    cache.bindGroupLayout = bgl;
    cache._pipelineFormatGeneration = currentGen;
  }
  const sunPipeline = tryResolveEnvPipeline(
    device,
    context.webgpuPipelineCache ?? null,
    cache.pipelineEntry,
  );
  if (!sunPipeline) {
    return;
  }
  cache.pipeline = sunPipeline;

  if (!defined(cache.vertexBuffer)) {
    cache.vertexBuffer = createSunQuadBuffer(device);
  }

  if (!defined(cache.uniformBuffer)) {
    cache.uniformBuffer = WebGPUBuffer.createUniformBuffer(
      device,
      UNIFORM_BUFFER_SIZE,
      undefined,
      "Sun uniforms",
    );
    cache.uniformData = new Float32Array(UNIFORM_BUFFER_SIZE / 4);
  }
  // czm_gammaCorrect parity: convert the sun to linear (pow(rgb, gamma)) only
  // when the scene is HDR; otherwise gamma = 1.0 makes the FS branch a no-op.
  const gamma =
    frameState.useHDR === true
      ? (frameState.context.uniformState.gamma ?? 2.2)
      : 1.0;
  packSunUniforms(cache.uniformData, frameState, glowFactor, gamma);
  device.queue.writeBuffer(
    cache.uniformBuffer.buffer,
    0,
    cache.uniformData.buffer,
    0,
    UNIFORM_BUFFER_SIZE,
  );

  if (!defined(cache.bindGroup)) {
    cache.bindGroup = device.createBindGroup({
      layout: cache.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: cache.uniformBuffer.buffer } },
        { binding: 1, resource: cache.sunTextureView },
        { binding: 2, resource: cache.sampler },
      ],
    });
  }

  if (!defined(cache.command)) {
    cache.command = new WebGPUDrawCommand({
      pipeline: cache.pipeline,
      bindGroups: [cache.bindGroup],
      vertexBuffers: [cache.vertexBuffer],
      vertexCount: 6,
      pass: 0, // Pass.ENVIRONMENT
      owner: sun,
    });
  }

  return cache.command;
}

// ============================================================
// Moon Renderer — Ray-Marched Analytic Ellipsoid (Phase 1.2c)
// ============================================================

/**
 * Bounding cube for the ray-marched moon shader. Phase 1.x consolidation:
 * the geometry was extracted to `WebGPUEllipsoidRenderer.ts` so future
 * ellipsoid bodies (Sun-as-ellipsoid, custom planets) can share the
 * same 8-vert / 36-index unit cube. The vertex shader still scales by
 * `radii` to wrap the moon ellipsoid, mirroring WebGL's
 * `EllipsoidPrimitive` which uses `BoxGeometry.fromDimensions({2,2,2})`.
 *
 * Why a cube and not a full-screen quad: the cube's screen footprint is
 * the moon's actual on-screen size, so the fragment shader runs only on
 * pixels that could possibly contain the moon. A full-screen quad would
 * run the FS on every pixel of the canvas (~8M FS invocations at 4K),
 * all of which would discard early but still cost rasterizer scheduling.
 *
 * @private
 */
function createMoonBoundingCube(device) {
  return createEllipsoidBoundingCube(device);
}

/**
 * Build the cache-friendly descriptor for the Moon rendering pipeline
 * (textured sphere + diffuse lighting). The actual `GPURenderPipeline`
 * is materialized through `webgpuPipelineCache.getPipeline()` so two
 * Moon instances on the same device share one pipeline.
 *
 * C-R7-RENDERER-MIGRATION (Batch 74).
 * @private
 */
function buildMoonPipelineResources(device, format, depthFormat, sampleCount) {
  // Shader validation is handled centrally by WebGPUContext's
  // _installShaderValidation wrapper — no per-site validation needed.
  const moduleCache = getEnvShaderModuleCache(device);
  const mod = moduleCache.getOrCreate(
    ShaderSourceId.ENVIRONMENT_MOON,
    MoonShaderCode,
    0,
    "Moon shader",
  );

  // Phase 1.x consolidation — use the shared bind group layout from
  // WebGPUEllipsoidRenderer so future ellipsoid bodies match exactly.
  // C12-25 — the moon opts into binding 3 (tangent-space normal map).
  const bgl = createEllipsoidBindGroupLayout(device, { normalTexture: true });

  const descriptor = {
    name: `Moon pipeline [${format}/${depthFormat}]`,
    layout: device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
    vertex: {
      module: mod,
      entryPoint: "vs",
      // Phase 1.2c v2 — bounding cube vertex layout. 12 bytes per vertex,
      // 8 vertices, 36 indices.
      buffers: [
        {
          arrayStride: 12,
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x3" }, // cubePos
          ],
        },
      ],
    },
    fragment: {
      module: mod,
      entryPoint: "fs",
      // Slice 5c-B Phase 1 (Batch 106) — scene-FB target. Overwrite
      // blend (1 × src + 0 × dst) for the bounding-cube ray-march pass.
      targets: makeSceneFBTargets(format, {
        blend: {
          color: {
            srcFactor: "one",
            dstFactor: "zero",
            operation: "add",
          },
          alpha: {
            srcFactor: "one",
            dstFactor: "zero",
            operation: "add",
          },
        },
      }),
    },
    // Bounding cube — cull back faces. We render the front faces of the
    // cube and the FS ray-marches inward. If the camera enters the cube
    // (close-up moon flythrough), back-face culling would discard the
    // visible faces — handled in JS by switching cullMode dynamically OR
    // by accepting that close-up flythroughs are out of scope. For now
    // we cull back faces; close-up flythrough is a follow-up.
    primitive: { topology: "triangle-list", cullMode: "back" },
    depthStencil: {
      format: depthFormat,
      // Moon is rendered at the far plane (vertex shader forces z/w=1)
      // and composited with `less-equal`, so it only draws in pixels
      // not already occluded by closer geometry. This is draw-order
      // agnostic — unlike the prior `depthCompare: always` path which
      // relied on the moon being issued before terrain.
      depthWriteEnabled: false,
      depthCompare: "less-equal",
    },
    // Session 65 Batch 21 — match scene FB sample count.
    multisample: sampleCount > 1 ? { count: sampleCount } : undefined,
  };

  return { descriptor, bgl };
}

/**
 * C12-35 L2 — renderer hooks for one exact Moon texture request. The generic
 * lifecycle controller owns the deferred state and stale-candidate rules;
 * these hooks are the only layer that knows how to fetch and realize a
 * `GPUTexture`.
 *
 * The orientation convention remains the C12-24/C12-25 WebGL parity rule:
 * both albedo and relief upload with `flipY: true`.
 *
 * @private
 */
function createMoonTextureRequestHooks(context, device, channelName) {
  const normal = channelName === MoonTextureChannel.NORMAL;
  const label = normal ? "Moon normal map" : "Moon texture";
  const format = "rgba8unorm";
  const monitor = context.asyncResources;
  const decodedSourceCache = getSharedMoonDecodedSourceCache();
  return {
    beginAsync: function (identity) {
      return monitor?.begin({
        kind: "texture-upload",
        key: `moon-${channelName}|${identity.cacheSerial}|${identity.requestSerial}`,
        label,
        // The placeholder is a complete renderable fallback. Let explicit-
        // render scenes hibernate during fetch/decode, then rely on the
        // monitor's terminal event to request the one frame that commits.
        priority: "background",
      });
    },
    resolveAsync: function (token) {
      if (defined(token)) {
        monitor?.resolve(token);
      }
    },
    rejectAsync: function (token, error) {
      if (defined(token)) {
        monitor?.reject(token, error);
      }
    },
    acquireSource: function (url) {
      // Cache identity includes the exact URL and every pixel-affecting decode
      // axis. The lease is returned immediately so the lifecycle can release
      // pending ownership synchronously on URL, owner, context, device, or
      // resource-generation supersession.
      return decodedSourceCache.acquire(url, {
        imageOrientation: "from-image",
        colorSpaceConversion: "default",
        premultiplyAlpha: "default",
      });
    },
    prepareSource: function (image) {
      return WebGPUImageUpload.decodeWithOrientation(image).then(
        function (uploadSource) {
          // `image` belongs to the shared decoded-source cache. The helper
          // grants request ownership only for a distinct orientation fallback.
          return createWebGPUMoonUploadSource(image, uploadSource);
        },
      );
    },
    releaseSource: releaseWebGPUMoonUploadSource,
    createCandidate: function (source) {
      const image = source.uploadSource;
      const width = image.width ?? image.videoWidth ?? image.codedWidth;
      const height = image.height ?? image.videoHeight ?? image.codedHeight;
      const mipLevelCount = Math.floor(Math.log2(Math.max(width, height))) + 1;
      const texture = device.createTexture({
        label,
        size: [width, height, 1],
        format,
        mipLevelCount,
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.RENDER_ATTACHMENT,
      });
      return {
        texture,
        width,
        height,
        format,
        mipLevelCount,
        maxLod: mipLevelCount - 1,
        mipGenerationQueued: false,
        view: undefined,
      };
    },
    uploadCandidate: function (source, candidate) {
      return WebGPUImageUpload.uploadImageToTexture(
        device,
        source.uploadSource,
        candidate.texture,
        { flipY: true, respectEXIF: false },
      );
    },
    finalizeCandidate: function (candidate, uploadResult) {
      candidate.width = uploadResult.width;
      candidate.height = uploadResult.height;
      candidate.view = candidate.texture.createView({
        baseMipLevel: 0,
        mipLevelCount: candidate.mipLevelCount,
      });
      return candidate;
    },
    destroyCandidate: function (candidate) {
      const texture = candidate.texture;
      candidate.texture = undefined;
      if (defined(texture)) {
        try {
          if (typeof context.cancelTextureMipGeneration === "function") {
            context.cancelTextureMipGeneration(texture);
          } else {
            context.noteInlineTextureDestroy?.(texture);
          }
        } catch {
          // Queue bookkeeping must never strand candidate destruction.
        }
      }
      texture?.destroy();
    },
    onError: function (error, phase) {
      //>>includeStart('debug', pragmas.debug);
      console.warn(
        `[WebGPUEnvironmentRenderer] ${label} ${phase} failed:`,
        error && error.message ? error.message : error,
      );
      //>>includeEnd('debug');
    },
  };
}

function invalidateMoonTextureBindings(cache) {
  const bundleManager = cache.context?.renderBundleManager;
  if (defined(bundleManager) && defined(cache._bundleKey)) {
    bundleManager.invalidate(cache._bundleKey);
    cache._bundleInvalidationCount++;
  }
  cache.bindGroup = undefined;
  cache.bundle = undefined;
  cache._bundleStale = true;
}

function createMoonTexturePublicationCallbacks(cache, device, channelName) {
  const normal = channelName === MoonTextureChannel.NORMAL;
  return {
    prepareCandidate: function (candidate) {
      if (candidate.mipGenerationQueued) {
        return;
      }
      const enqueueMipGeneration = cache.context?.enqueueTextureMipGeneration;
      if (typeof enqueueMipGeneration !== "function") {
        throw new Error("WebGPU context has no frame-owned texture mip queue");
      }
      const accepted = enqueueMipGeneration.call(
        cache.context,
        candidate.texture,
        candidate.format,
        candidate.mipLevelCount,
      );
      if (accepted === false) {
        throw new Error("WebGPU texture mip queue rejected the Moon candidate");
      }
      candidate.mipGenerationQueued = true;
    },
    invalidate: function () {
      invalidateMoonTextureBindings(cache);
    },
    publish: function (candidate, identity) {
      const previous = normal ? cache.normalTexture : cache.moonTexture;
      if (normal) {
        cache.normalTexture = candidate.texture;
        cache.normalTextureView = candidate.view;
        cache.normalTextureUrl = identity.exactUrl;
        cache.normalTextureWidth = candidate.width;
        cache.normalTextureHeight = candidate.height;
        cache.normalTextureMipLevelCount = candidate.mipLevelCount;
        cache.normalTextureMaxLod = candidate.maxLod;
      } else {
        cache.moonTexture = candidate.texture;
        cache.moonTextureView = candidate.view;
        cache.moonTextureUrl = identity.exactUrl;
        cache.moonTextureWidth = candidate.width;
        cache.moonTextureHeight = candidate.height;
        cache.moonTextureMipLevelCount = candidate.mipLevelCount;
        cache.moonTextureMaxLod = candidate.maxLod;
      }
      return previous;
    },
    destroyPrevious: function (previous) {
      if (
        defined(previous) &&
        (!normal || previous !== cache.normalPlaceholderTexture)
      ) {
        try {
          if (typeof cache.context?.cancelTextureMipGeneration === "function") {
            cache.context.cancelTextureMipGeneration(previous);
          } else {
            cache.context?.noteInlineTextureDestroy?.(previous);
          }
        } catch {
          // Queue bookkeeping must never strand previous texture retirement.
        }
        previous.destroy();
      }
    },
    preparePlaceholder: function () {
      if (normal) {
        return {
          texture: cache.normalPlaceholderTexture,
          view: cache.normalPlaceholderView,
        };
      }
      const texture = createMoonPlaceholderTexture(device);
      return { texture, view: createTextureViewOrDestroy(texture) };
    },
    destroyPreparedPlaceholder: function (placeholder) {
      if (!normal && defined(placeholder?.texture)) {
        try {
          if (typeof cache.context?.cancelTextureMipGeneration === "function") {
            cache.context.cancelTextureMipGeneration(placeholder.texture);
          } else {
            cache.context?.noteInlineTextureDestroy?.(placeholder.texture);
          }
        } catch {
          // Continue through best-effort placeholder retirement.
        }
        destroyTextureSuppressingError(placeholder.texture);
      }
    },
    publishPlaceholder: function (placeholder) {
      const previous = normal ? cache.normalTexture : cache.moonTexture;
      if (normal) {
        cache.normalTexture = placeholder.texture;
        cache.normalTextureView = placeholder.view;
        cache.normalTextureUrl = undefined;
        cache.normalTextureWidth = 1;
        cache.normalTextureHeight = 1;
        cache.normalTextureMipLevelCount = 1;
        cache.normalTextureMaxLod = 0;
      } else {
        cache.moonTexture = placeholder.texture;
        cache.moonTextureView = placeholder.view;
        cache.moonTextureUrl = undefined;
        cache.moonTextureWidth = 4;
        cache.moonTextureHeight = 4;
        cache.moonTextureMipLevelCount = 1;
        cache.moonTextureMaxLod = 0;
      }
      return previous;
    },
    onError: function (error, phase) {
      //>>includeStart('debug', pragmas.debug);
      console.warn(`[WebGPUEnvironmentRenderer] Moon ${phase} failed:`, error);
      //>>includeEnd('debug');
    },
  };
}

/**
 * C12-25 — 1x1 FLAT tangent-space normal (128, 128, 255), i.e. (0, 0, 1).
 *
 * Bound whenever the moon has no normal map (the `Moon.Variant.SMALL` case)
 * or while the real map is still loading. Paired with `normalStrength = 0`
 * the shader skips the fetch entirely, so this exists to satisfy the bind
 * group layout — a layout binding must always have an entry — and to be
 * harmless in the one frame ordering where strength is non-zero before the
 * real texture lands.
 *
 * @private
 */
function createFlatNormalPlaceholderTexture(device) {
  const texture = device.createTexture({
    label: "Moon normal placeholder (flat)",
    size: [1, 1, 1],
    format: "rgba8unorm",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  try {
    device.queue.writeTexture(
      { texture },
      new Uint8Array([128, 128, 255, 255]),
      { bytesPerRow: 4 },
      [1, 1, 1],
    );
  } catch (error) {
    destroyTextureSuppressingError(texture);
    throw error;
  }
  return texture;
}

/**
 * Creates a placeholder 4x4 gray texture for the Moon when the real texture hasn't loaded.
 * @private
 */
function createMoonPlaceholderTexture(device) {
  const size = 4;
  const pixels = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    pixels[i * 4 + 0] = 180;
    pixels[i * 4 + 1] = 180;
    pixels[i * 4 + 2] = 180;
    pixels[i * 4 + 3] = 255;
  }
  const texture = device.createTexture({
    label: "Moon placeholder",
    size: [size, size, 1],
    format: "rgba8unorm",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  try {
    device.queue.writeTexture({ texture }, pixels, { bytesPerRow: size * 4 }, [
      size,
      size,
      1,
    ]);
  } catch (error) {
    destroyTextureSuppressingError(texture);
    throw error;
  }
  return texture;
}

function destroyTextureSuppressingError(texture) {
  try {
    texture.destroy();
  } catch (_ignored) {
    // Preserve the allocation/write/view error that triggered rollback.
  }
}

function createTextureViewOrDestroy(texture) {
  try {
    return texture.createView();
  } catch (error) {
    destroyTextureSuppressingError(texture);
    throw error;
  }
}

function createWebGPUMoonCache(moon, context, device) {
  const resourceGeneration = context.resourceGeneration ?? 0;
  const cache = {
    owner: moon,
    context,
    device,
    resourceGeneration,
    _bundleInvalidationCount: 0,
  };
  moon._webgpuCache = cache;
  const lifecycle = createWebGPUMoonTextureLifecycle(
    moon,
    cache,
    context,
    device,
    resourceGeneration,
  );
  cache.cacheSerial = lifecycle.cacheSerial;
  return cache;
}

function ensureWebGPUMoonCache(moon, context, device) {
  const resourceGeneration = context.resourceGeneration ?? 0;
  let cache = moon._webgpuCache;
  if (
    defined(cache) &&
    (cache.owner !== moon ||
      cache.context !== context ||
      cache.device !== device ||
      cache.resourceGeneration !== resourceGeneration)
  ) {
    destroyWebGPUMoonResources(moon);
    cache = undefined;
  }
  if (!defined(cache)) {
    cache = createWebGPUMoonCache(moon, context, device);
  }
  return cache;
}

function ensureMoonTextureLifecycleHooks(cache) {
  if (!defined(cache._albedoTextureRequestHooks)) {
    cache._albedoTextureRequestHooks = createMoonTextureRequestHooks(
      cache.context,
      cache.device,
      MoonTextureChannel.ALBEDO,
    );
    cache._normalTextureRequestHooks = createMoonTextureRequestHooks(
      cache.context,
      cache.device,
      MoonTextureChannel.NORMAL,
    );
    cache._albedoPublicationCallbacks = createMoonTexturePublicationCallbacks(
      cache,
      cache.device,
      MoonTextureChannel.ALBEDO,
    );
    cache._normalPublicationCallbacks = createMoonTexturePublicationCallbacks(
      cache,
      cache.device,
      MoonTextureChannel.NORMAL,
    );
  }
}

function getMoonTexturePairKey(cache, moon) {
  if (
    cache._pairAlbedoUrl !== moon.textureUrl ||
    cache._pairNormalUrl !== moon.normalMapUrl
  ) {
    cache._pairAlbedoUrl = moon.textureUrl;
    cache._pairNormalUrl = moon.normalMapUrl;
    cache._texturePairKey = createWebGPUMoonTexturePairKey(
      moon.textureUrl,
      moon.normalMapUrl,
    );
  }
  return cache._texturePairKey;
}

/**
 * Updates WebGPU Moon rendering — Phase 1.2c v2.
 *
 * Architecture: bounding-cube rasterization + analytic ray-marched
 * ellipsoid in model space + RTE 64-bit precision in the VS. Mirrors the
 * WebGL EllipsoidPrimitive moon path with full feature parity, plus the
 * Phase 1.2 earthshine improvement. (The Phase 1.2 phase-gating multiplier
 * was deleted by C11-176b — it double-counted N·L phase and blacked out
 * the daytime moon; phaseFraction is still packed for C12-21 earthshine.)
 *
 * Performance leverage from Phase 0:
 *   - Render bundle pre-encoding via WebGPURenderBundleManager. The
 *     pipeline + bind group + vertex/index buffer + draw call sequence
 *     is identical every frame; we cache the encoded bundle and replay
 *     it. The uniform buffer contents change each frame (writeBuffer),
 *     but the bundle reads from the same buffer object so the new data
 *     just shows up on the next replay.
 *   - SnapshotModeService freezable registration. When snapshot mode is
 *     active, the moon's per-frame uniform writes still happen on the
 *     first frame after entering, then become a no-op until thaw — the
 *     bundle replays the captured uniforms verbatim.
 *   - Behind-camera early-out before any work, so a moon below the
 *     horizon doesn't even submit a draw command.
 *
 * @private
 */
function updateWebGPUMoon(moon, frameState, commandList) {
  if (!moon.show) {
    return;
  }
  const context = frameState.context;
  const device = context.device;
  if (!device) {
    return;
  }

  // C12-35 L2 — every handle below is owned by this exact tuple. A device
  // replacement or same-device resource-generation bump retires the entire
  // old cache before any of its GPU objects can be inspected or submitted.
  const cache = ensureWebGPUMoonCache(moon, context, device);

  // ── Behind-camera early-out ─────────────────────────────────────────
  // If the moon is fully behind the camera, don't submit anything. The
  // bounding cube would be culled by the rasterizer anyway, but skipping
  // the draw command avoids the bundle execute and the per-frame uniform
  // writes too.
  const cameraPosWC = frameState.camera.positionWC;
  const cameraDirWC = frameState.camera.directionWC;
  const ellipsoidPrimitive = moon._ellipsoidPrimitive;
  const modelMatrix = ellipsoidPrimitive.modelMatrix;
  Matrix4.getTranslation(modelMatrix, scratchMoonPositionWC);
  Cartesian3.subtract(scratchMoonPositionWC, cameraPosWC, scratchCameraToMoon);
  // Pad by max radius so a partially-visible moon at the screen edge is
  // still drawn. Cheap conservative test.
  const maxRadius = Math.max(
    moon._ellipsoid.radii.x,
    moon._ellipsoid.radii.y,
    moon._ellipsoid.radii.z,
  );
  const dotForward = Cartesian3.dot(scratchCameraToMoon, cameraDirWC);
  if (dotForward < -maxRadius) {
    return; // moon is fully behind the camera
  }

  // ── One-time resource creation ──────────────────────────────────────

  // Bounding cube geometry (8 verts, 36 indices)
  if (!defined(cache.geometry)) {
    cache.geometry = createMoonBoundingCube(device);
  }

  // Batch 110 — invalidate cached pipeline + bundle when scene format
  // changes. The bundleKey includes scenePipelineFormat so a stale
  // bundle for the old format won't match anyway, but flagging
  // _bundleStale forces explicit invalidation in the manager so the
  // old bundle's GPU memory is released promptly.
  const currentMoonGen = context._scenePipelineFormatGeneration ?? 0;
  if (
    defined(cache.pipelineEntry) &&
    cache._pipelineFormatGeneration !== currentMoonGen
  ) {
    cache.pipelineEntry = undefined;
    cache.pipeline = undefined;
    cache._bundleStale = true;
  }

  // C-R7 (Batch 74) — descriptor + central pipeline cache. The cache's
  // `createRenderPipelineAsync()` path catches shader/pipeline validation
  // errors and surfaces them through its `.catch` handler (logs + clears
  // the in-flight flag). The previous `pushErrorScope` wrapper is
  // redundant under that pattern, so it's been dropped — the
  // `_pipelineFailed` sentinel is also no longer needed because the
  // entry's own `pending` slot stays stable on failure (a retry will
  // simply attempt creation again next frame, matching the prior
  // behavior for transient errors).
  if (!defined(cache.pipelineEntry)) {
    const format = context.scenePipelineFormat || "bgra8unorm";
    const depthFmt = context.depthFormat || "depth24plus-stencil8";
    const sampleCount = context._msaaSamples ?? 1;
    const built = buildMoonPipelineResources(
      device,
      format,
      depthFmt,
      sampleCount,
    );
    cache.pipelineEntry = {
      descriptor: built.descriptor,
      pipeline: null,
      pending: false,
    };
    cache.bgl = built.bgl;
    cache._pipelineFormatGeneration = currentMoonGen;
  }
  const moonPipeline = tryResolveEnvPipeline(
    device,
    context.webgpuPipelineCache ?? null,
    cache.pipelineEntry,
  );
  if (!moonPipeline) {
    return;
  }
  cache.pipeline = moonPipeline;

  // Moon texture (placeholder until async load completes)
  if (!defined(cache.moonTexture)) {
    const placeholderTexture = createMoonPlaceholderTexture(device);
    let placeholderView;
    let sampler;
    try {
      placeholderView = placeholderTexture.createView();
      sampler = device.createSampler({
        minFilter: "linear",
        magFilter: "linear",
        mipmapFilter: "linear",
        // Moon imagery is equirectangular: longitude wraps at the model-space
        // -X seam, while latitude terminates at the poles.
        addressModeU: "repeat",
        addressModeV: "clamp-to-edge",
      });
    } catch (error) {
      destroyTextureSuppressingError(placeholderTexture);
      throw error;
    }
    cache.moonTexture = placeholderTexture;
    cache.moonTextureView = placeholderView;
    cache.moonTextureWidth = 4;
    cache.moonTextureHeight = 4;
    cache.moonTextureMipLevelCount = 1;
    cache.moonTextureMaxLod = 0;
    cache.sampler = sampler;
  }

  // C12-25 — normal map at binding 3. Always bound: the flat placeholder is
  // the identity, so there is one pipeline and no shader variant.
  if (!defined(cache.normalPlaceholderTexture)) {
    const normalPlaceholderTexture = createFlatNormalPlaceholderTexture(device);
    const normalPlaceholderView = createTextureViewOrDestroy(
      normalPlaceholderTexture,
    );
    cache.normalPlaceholderTexture = normalPlaceholderTexture;
    cache.normalPlaceholderView = normalPlaceholderView;
    cache.normalTexture = normalPlaceholderTexture;
    cache.normalTextureView = normalPlaceholderView;
    cache.normalTextureWidth = 1;
    cache.normalTextureHeight = 1;
    cache.normalTextureMipLevelCount = 1;
    cache.normalTextureMaxLod = 0;
  }

  // C12-35 L0/L2 — reconcile independent request serials against one exact
  // owner/context/device/generation/cache/pair identity. A normal strength of
  // zero starts no work, but matching current or in-flight work is retained.
  // Candidates only publish here, on the frame-owned update path; promise
  // callbacks can stage or destroy candidates but never mutate live bindings.
  ensureMoonTextureLifecycleHooks(cache);
  const pairKey = getMoonTexturePairKey(cache, moon);
  const lifecycle = cache._moonTextureLifecycle;
  const albedoOptions = lifecycle.channels.albedo.reconcileOptions;
  albedoOptions.url = moon.textureUrl;
  albedoOptions.pairKey = pairKey;
  albedoOptions.demanded = defined(moon.textureUrl);
  albedoOptions.hooks = cache._albedoTextureRequestHooks;
  const albedoResult = reconcileWebGPUMoonTextureChannel(
    lifecycle,
    MoonTextureChannel.ALBEDO,
    albedoOptions,
  );
  if (albedoResult.retireCurrent) {
    retireWebGPUMoonPublishedTexture(
      lifecycle,
      MoonTextureChannel.ALBEDO,
      cache._albedoPublicationCallbacks,
    );
  }
  commitWebGPUMoonTextureCandidate(
    lifecycle,
    MoonTextureChannel.ALBEDO,
    cache._albedoPublicationCallbacks,
  );

  const normalOptions = lifecycle.channels.normal.reconcileOptions;
  normalOptions.url = moon.normalMapUrl;
  normalOptions.pairKey = pairKey;
  normalOptions.demanded =
    defined(moon.normalMapUrl) && frameState.moonNormalMapStrength > 0.0;
  normalOptions.hooks = cache._normalTextureRequestHooks;
  const normalResult = reconcileWebGPUMoonTextureChannel(
    lifecycle,
    MoonTextureChannel.NORMAL,
    normalOptions,
  );
  if (normalResult.retireCurrent) {
    retireWebGPUMoonPublishedTexture(
      lifecycle,
      MoonTextureChannel.NORMAL,
      cache._normalPublicationCallbacks,
    );
  }
  commitWebGPUMoonTextureCandidate(
    lifecycle,
    MoonTextureChannel.NORMAL,
    cache._normalPublicationCallbacks,
  );

  // Uniform buffer (Phase 1.2c v2 + C12 moon-wave tail = 336 bytes / 84 floats)
  if (!defined(cache.uniformBuffer)) {
    cache.uniformBuffer = WebGPUBuffer.createUniformBuffer(
      device,
      MOON_UNIFORM_BUFFER_SIZE,
      undefined,
      "Moon uniforms",
    );
    cache.uniformData = new Float32Array(MOON_UNIFORM_BUFFER_SIZE / 4);
  }

  // Bind group (recreated whenever a lifecycle candidate commits; the
  // transactional publication path clears cache.bindGroup first).
  if (!defined(cache.bindGroup)) {
    cache.bindGroup = device.createBindGroup({
      label: "Moon bind group",
      layout: cache.bgl,
      entries: [
        { binding: 0, resource: { buffer: cache.uniformBuffer.buffer } },
        { binding: 1, resource: cache.moonTextureView },
        { binding: 2, resource: cache.sampler },
        // C12-25 — normal map; reuses the binding-2 sampler.
        { binding: 3, resource: cache.normalTextureView },
      ],
    });
    // Bind group changed → render bundle (if any) is stale.
    cache._bundleStale = true;
  }

  // Snapshot mode freezable registration. First-time only. Each Moon
  // instance gets one freezable registration; the freezable just toggles
  // a flag the per-frame path consults to skip uniform writes. The
  // service reference is stashed on the cache so destroy() can
  // unregister later — without it, the closure would leak after the
  // moon's GPU resources are destroyed.
  if (!cache._snapshotRegistered) {
    // Batch 244 — read the canonical `frameState.snapshotMode`
    // publication (Scene.updateFrameState). The old `frameState.scene`
    // read was ALWAYS undefined (that property is never populated —
    // same dormant-gate bug class as Batch 234's `taaEnabled` fix), so
    // this registration silently never fired and the moon kept packing
    // + uploading uniforms every frame while the scene was frozen.
    const snapshotMode = frameState.snapshotMode;
    if (defined(snapshotMode)) {
      snapshotMode.registerFreezable(
        "moon-renderer",
        createMoonFreezable(cache),
      );
      cache._snapshotRegistered = true;
      cache._snapshotService = snapshotMode;
    }
  }

  // ── Per-frame uniform pack ──────────────────────────────────────────
  //
  // Skip the entire pack-and-write when the snapshot service has frozen
  // us. The bundle's recorded `setBindGroup` still points at the same
  // GPU uniform buffer, so it reads whatever was last written.
  if (!cache._frozen) {
    _packMoonUniforms(moon, frameState, cache);
    device.queue.writeBuffer(
      cache.uniformBuffer.buffer,
      0,
      cache.uniformData.buffer,
      cache.uniformData.byteOffset,
      cache.uniformData.byteLength,
    );
  }

  // ── Render bundle: pre-encoded draw sequence ────────────────────────
  //
  // The pipeline + bind group + vertex/index buffer + indexed draw is
  // identical every frame, so we record it once into a GPURenderBundle
  // and replay it via executeBundles. WebGPURenderBundleManager handles
  // caching and eviction. The bundle becomes stale on:
  //   - first frame for this moon
  //   - texture upgrade (cache.bindGroup replaced)
  //   - explicit invalidation
  // Bundle key includes the surface format set so different render passes
  // (e.g. picking) get their own bundles.
  // Skip bundle creation if the pipeline failed validation — prevents
  // an invalid pipeline from producing an invalid bundle that would
  // poison the entire command encoder on executeBundles.
  const bundleMgr = context.renderBundleManager;
  if (defined(bundleMgr) && defined(cache.pipeline) && !cache._pipelineFailed) {
    // Session 65 Batch 37 — bundle encoder MUST match the recorded
    // pipeline's multisample state. The Moon pipeline now bakes
    // sampleCount = context._msaaSamples (Phase MSAA-FLEET), so the
    // bundle's encoder needs the same value or executeBundles fails
    // with "Attachment state ... is not compatible". The sampleCount
    // is also part of the bundle key so a mid-session MSAA toggle
    // evicts the prior bundle instead of replaying a stale one.
    const sampleCount = context._msaaSamples ?? 1;
    const bundleKey = `moon:${moon._cacheId ?? (moon._cacheId = createGuid())}:${context.scenePipelineFormat}:${context.depthFormat}:${sampleCount}`;
    cache._bundleKey = bundleKey;
    if (cache._bundleStale) {
      bundleMgr.invalidate(bundleKey);
      cache._bundleInvalidationCount++;
      cache._bundleStale = false;
    }
    // Slice 5c-B Batch 121 — bundle colorFormats must match the Moon
    // pipeline's target count. Phase 1 conversion (Batch 106) made the
    // Moon pipeline declare a slot-1 placeholder via makeSceneFBTargets
    // when MRT mode is on; the bundle needs the matching format entry.
    // Without this, the bundle's attachmentState is incompatible with
    // the pipeline → "Attachment state not compatible" at recording.
    // (Same fix pattern as the Globe bundle in Batch 117.)
    const moonColorFormats = isSceneFBMrtMode()
      ? [
          context.scenePipelineFormat || "bgra8unorm",
          MRT_NORMAL_ROUGHNESS_FORMAT,
        ]
      : [context.scenePipelineFormat || "bgra8unorm"];
    const bundle = bundleMgr.getOrCreate(
      bundleKey,
      {
        colorFormats: moonColorFormats,
        depthStencilFormat: context.depthFormat || "depth24plus-stencil8",
        sampleCount,
        label: "Moon bundle",
      },
      function (encoder) {
        encoder.setPipeline(cache.pipeline);
        encoder.setBindGroup(0, cache.bindGroup);
        encoder.setVertexBuffer(0, cache.geometry.vertexBuffer.buffer);
        encoder.setIndexBuffer(cache.geometry.indexBuffer, "uint16");
        encoder.drawIndexed(cache.geometry.indexCount);
        return 1; // one draw call
      },
    );
    cache.bundle = bundle;
  }

  // ── Submit ──────────────────────────────────────────────────────────
  //
  // Build a draw command that carries the bundle. The Pass.ENVIRONMENT
  // executor will call executeBundles when it sees `command.bundle` set.
  // For renderers that don't yet support bundle execution, the command
  // also carries the pipeline/bindgroup/buffers so it can fall back to
  // a normal indexed draw.
  cache.command = new WebGPUDrawCommand({
    pipeline: cache.pipeline,
    bindGroups: [cache.bindGroup],
    vertexBuffers: [cache.geometry.vertexBuffer],
    indexBuffer: cache.geometry.indexBuffer,
    indexCount: cache.geometry.indexCount,
    indexFormat: "uint16",
    pass: 0, // Pass.ENVIRONMENT
    owner: moon,
  });
  // Attach the bundle so a bundle-aware pass executor can replay it
  // instead of recording the draw calls again.
  if (defined(cache.bundle)) {
    cache.command.bundle = cache.bundle;
  }

  commandList.push(cache.command);
}

/**
 * Packs the moon uniform buffer for one frame. Pulled out of
 * updateWebGPUMoon so the snapshot-mode skip path is a single conditional.
 *
 * Layout matches the `U` struct in Moon.wgsl (Phase 1.2c v2):
 *   mvpRTE             0..15  (mat4)
 *   camH + pad         16..19  (camera in moon MODEL coords, RTE high)
 *   camL + pad         20..23  (camera in moon MODEL coords, RTE low)
 *   moonH + pad        24..27  (world center split — unused by the VS)
 *   moonL + pad        28..31
 *   ivmRow0 + pad      32..35
 *   ivmRow1 + pad      36..39
 *   ivmRow2 + pad      40..43
 *   cameraPosMC + pad  44..47
 *   radii + pad        48..51
 *   oneOverRadiiSq+pad 52..55
 *   sunDirMC + onlySun 56..59
 *   sceneLightMC + pad 60..63
 *   moonDirWC + phase  64..67
 *   shineFlag/log/shin/spec 68..71
 *   farPlane + 3 pad   72..75
 *   extinction         76..78  (NS-MOON-ATMOSPHERE-EXTINCTION)
 *   lunarBRDF flag     79      (C12-20; was spare)
 *   inscatter          80..82  (C12-30 sky-wash, additive)
 *   oppositionSurge    83      (C12-23)
 *   normalStrength     84      (C12-25 LOLA relief; 0 = exact identity)
 *   earthshinePhase    85      (C12-21 Earth-phase complement; 1 = identity)
 *   terminatorSoftness 86      (C12-22 solar angular radius; 0 = identity)
 *
 * @private
 */
function _packMoonUniforms(moon, frameState, cache) {
  const context = frameState.context;
  const uniformState = context.uniformState;
  const ellipsoidPrimitive = moon._ellipsoidPrimitive;
  const modelMatrix = ellipsoidPrimitive.modelMatrix;
  const viewMatrix = uniformState.view;
  const projMatrix = uniformState.projection;

  // Compute mvpRelativeToEye: projection × (view × model with the moon
  // translation zeroed). Same math as before; the body translation is
  // applied via the RTE position split written by the shared packer.
  Matrix4.multiply(viewMatrix, modelMatrix, scratchModelView);
  Matrix4.clone(scratchModelView, scratchMVRTE);
  scratchMVRTE[12] = 0.0;
  scratchMVRTE[13] = 0.0;
  scratchMVRTE[14] = 0.0;
  Matrix4.multiply(projMatrix, scratchMVRTE, scratchMVPRTE);

  const ud = cache.uniformData;
  ud.fill(0);

  // ── Phase 1.x consolidation: shared base uniform pack (offsets 0..63) ──
  // Fills mvpRTE, camH/L split, centerH/L split, ivmRow0..2, cameraPosMC,
  // radii, oneOverRadiiSq, sunDirMC, sceneLightDirMC. Body-specific
  // writes follow at offsets 64+.
  packEllipsoidBaseUniforms(ud, {
    mvpRelativeToEye: scratchMVPRTE,
    viewMatrix: viewMatrix,
    cameraPositionWC: frameState.camera.positionWC,
    modelMatrix: modelMatrix,
    radii: moon._ellipsoid.radii,
    oneOverRadiiSquared: moon._ellipsoid.oneOverRadiiSquared,
    sunDirectionWC: uniformState.sunDirectionWC,
    sceneLightDirectionWC: defined(uniformState.lightDirectionWC)
      ? uniformState.lightDirectionWC
      : uniformState.sunDirectionWC,
  });

  // The shared packer leaves the .w slot of sunDirMC (offset 59) at zero.
  // The Moon shader uses that slot for the `onlySunLighting` flag.
  ud[59] = moon.onlySunLighting === false ? 0.0 : 1.0;

  // ── Moon-specific uniforms (offsets 64..79) ──
  const moonDirWC = frameState.moonDirectionWC;
  const ac = frameState.atmosphericConditions;
  const earthshineOn =
    defined(ac) && defined(ac.lighting) && ac.lighting.enableEarthshine === true
      ? 1.0
      : 0.0;

  // moonDirWC + phaseFraction — offsets 64..67
  ud[64] = defined(moonDirWC) ? moonDirWC.x : 0.0;
  ud[65] = defined(moonDirWC) ? moonDirWC.y : 0.0;
  ud[66] = defined(moonDirWC) ? moonDirWC.z : 0.0;
  ud[67] = frameState.moonPhaseFraction ?? 1.0;

  // earthshine, useLogDepth, shininess, specularStrength — offsets 68..71
  ud[68] = earthshineOn;
  ud[69] = frameState.useLogDepth === true ? 1.0 : 0.0;
  // Parity (ENV-MOON-SLIVER): WebGL's moon material is
  // Material.fromType(Material.ImageType) whose czm_getDefaultMaterial
  // specular is 0.0 — the WebGL moon has NO specular highlight. Keep the
  // shininess exponent sane but zero the strength so the disc shading
  // matches czm_private_phong exactly.
  ud[70] = 5.0; // shininess (Phong exponent; inert while strength is 0)
  ud[71] = 0.0; // specularStrength — 0 to match Material.ImageType

  // farPlane + 3 pad — offsets 72..75
  ud[72] = defined(uniformState.currentFrustum)
    ? uniformState.currentFrustum.y
    : 1.0e9;
  ud[73] = 0;
  ud[74] = 0;
  ud[75] = 0;

  // NS-MOON-ATMOSPHERE-EXTINCTION — RGB atmospheric transmittance at offsets
  // 76..78 (vec3 `extinction`, 16-byte aligned at byte 304). Defaults to
  // (1,1,1) when the atmosphere is hidden or the moon is viewed from orbit,
  // making the multiply in the shader an exact no-op (byte-identical).
  const extinction = frameState.moonAtmosphereExtinction;
  ud[76] = defined(extinction) ? extinction.x : 1.0;
  ud[77] = defined(extinction) ? extinction.y : 1.0;
  ud[78] = defined(extinction) ? extinction.z : 1.0;

  // C12-20 — Lommel-Seeliger runtime flag at offset 79 (byte 316; was the
  // spare). Same source expression as the WebGL path's Moon.js wiring
  // (atmosphericConditions.lighting.enableLunarBRDF, false when no globe),
  // so both backends select the same disc law every frame.
  ud[79] =
    defined(ac) && defined(ac.lighting) && ac.lighting.enableLunarBRDF === true
      ? 1.0
      : 0.0;

  // C12-30 — additive in-scattered sky-wash at offsets 80..82 (vec3
  // `inscatter`, 16-byte aligned at byte 320). Published by Moon.update via
  // the shared CPU integral; (0,0,0) — the additive identity — when the
  // wash is disabled, the atmosphere is hidden, or the view ray misses the
  // shell (orbit), keeping the legacy output byte-identical there.
  const inscatter = frameState.moonAtmosphereInscatter;
  ud[80] = defined(inscatter) ? inscatter.x : 0.0;
  ud[81] = defined(inscatter) ? inscatter.y : 0.0;
  ud[82] = defined(inscatter) ? inscatter.z : 0.0;

  // C12-23 — opposition-surge multiplier at offset 83 (byte 332). 1.0 =
  // identity (disabled / away from opposition). Published by Moon.update.
  ud[83] = frameState.moonOppositionSurge ?? 1.0;

  // C12-25 — LOLA relief strength at offset 84 (byte 336). Resolved ONCE,
  // backend-agnostically, by Moon.update — it already folds in the
  // atmosphericConditions.lighting.enableLunarNormalMap toggle AND the
  // variant gate (SMALL ships no map), so both backends read the same
  // number and cannot disagree about whether relief is on. Exactly 0.0
  // disables the perturbation as an exact identity.
  ud[84] = frameState.moonNormalMapStrength ?? 0.0;

  // C12-21 — earthshine phase scale at offset 85 (byte 340) and C12-22 —
  // solar angular radius at offset 86 (byte 344). Both resolved ONCE,
  // backend-agnostically, by Moon.update via Scene/MoonPhaseAppearance.js and
  // handed to the WebGL twin as u_earthshinePhaseScale / u_terminatorSoftness,
  // so the two backends cannot derive different numbers. The `??` fallbacks
  // are the two exact identities: 1.0 leaves earthshine at its historical
  // constant, 0.0 makes softTerminatorMu0 return the legacy max(N·L, 0).
  // Both live inside the 336..351 slot C12-25 already opened, so the buffer
  // size and the bind-group layout are unchanged.
  ud[85] = frameState.moonEarthshinePhaseScale ?? 1.0;
  ud[86] = frameState.moonTerminatorSoftness ?? 0.0;
}

/**
 * Build a SnapshotFreezable-shaped object for a moon cache. Mirrors the
 * pattern used by `WebGPURenderBundleManager.asFreezable()` and
 * `WebGPUVolumetricFogRenderer.asFreezable()` so the registration site
 * is symmetric and the spec layer can drive the freezable contract
 * without needing a real GPU device.
 *
 * @param {object} cache The moon's `_webgpuCache` object.
 * @returns {{ name: string, freeze: function, thaw: function, isFrozen: function }}
 */
function createMoonFreezable(cache) {
  return {
    name: "moon-renderer",
    freeze: function () {
      cache._frozen = true;
    },
    thaw: function () {
      cache._frozen = false;
    },
    isFrozen: function () {
      return cache._frozen === true;
    },
  };
}

/**
 * Phase 6 debug surface — return a diagnostic snapshot of a Moon's
 * WebGPU cache. Returns `null` when the moon hasn't yet had its first
 * `update()` call (cache absent) or when called against a non-WebGPU
 * scene. Pure read; safe to call from `Scene.getDebugSnapshot()`.
 *
 * @param {Moon} moon
 * @returns {object|null}
 */
function getWebGPUMoonStatistics(moon) {
  if (!defined(moon) || !defined(moon._webgpuCache)) {
    return null;
  }
  const cache = moon._webgpuCache;
  // Pull the moon-specific uniforms back out of the packed buffer for
  // a quick "what got pushed to the GPU last frame" view. The offsets
  // here mirror `_packMoonUniforms()` (offsets 64..83 are the moon tail).
  const ud = cache.uniformData;
  const moonDirWC =
    defined(ud) && ud.length > 67
      ? Object.freeze({ x: ud[64], y: ud[65], z: ud[66] })
      : null;
  const phaseFraction = defined(ud) && ud.length > 67 ? ud[67] : null;
  const earthshineOn = defined(ud) && ud.length > 68 ? ud[68] === 1.0 : null;
  const useLogDepth = defined(ud) && ud.length > 69 ? ud[69] === 1.0 : null;
  const shininess = defined(ud) && ud.length > 70 ? ud[70] : null;
  const specularStrength = defined(ud) && ud.length > 71 ? ud[71] : null;
  // C12 moon-wave tail (offsets 76..83) — extinction, lunar BRDF flag,
  // sky-wash, opposition surge, as last pushed to the GPU.
  const extinction =
    defined(ud) && ud.length > 78
      ? Object.freeze({ x: ud[76], y: ud[77], z: ud[78] })
      : null;
  const lunarBRDFOn = defined(ud) && ud.length > 79 ? ud[79] === 1.0 : null;
  const inscatter =
    defined(ud) && ud.length > 82
      ? Object.freeze({ x: ud[80], y: ud[81], z: ud[82] })
      : null;
  const oppositionSurge = defined(ud) && ud.length > 83 ? ud[83] : null;
  // C12-25 — relief strength as last pushed, plus whether the bound normal
  // texture is the real map or the flat identity placeholder.
  const normalMapStrength = defined(ud) && ud.length > 84 ? ud[84] : null;
  // C12-21 / C12-22 — as last pushed. The Edge acceptance probe reads these
  // to prove the CPU-resolved numbers actually reached the GPU.
  const earthshinePhaseScale = defined(ud) && ud.length > 85 ? ud[85] : null;
  const terminatorSoftness = defined(ud) && ud.length > 86 ? ud[86] : null;
  const lifecycle = cache._moonTextureLifecycle;
  const albedoLifecycle = lifecycle?.channels?.albedo;
  const normalLifecycle = lifecycle?.channels?.normal;
  const lifecycleStatistics =
    getWebGPUMoonTextureLifecycleDiagnostics(lifecycle);
  return Object.freeze({
    backend: "webgpu",
    pipelineReady: defined(cache.pipeline),
    bindGroupReady: defined(cache.bindGroup),
    moonTextureLoaded: defined(albedoLifecycle)
      ? defined(albedoLifecycle.currentIdentity)
      : defined(cache.moonTexture),
    moonTextureUrl:
      albedoLifecycle?.currentIdentity?.exactUrl ??
      cache.moonTextureUrl ??
      null,
    moonTextureMipLevelCount: cache.moonTextureMipLevelCount ?? null,
    moonTextureMaxLod: cache.moonTextureMaxLod ?? null,
    normalMapStrength,
    normalMapUrl:
      normalLifecycle?.currentIdentity?.exactUrl ??
      cache.normalTextureUrl ??
      null,
    normalMapLoaded:
      defined(cache.normalTexture) &&
      cache.normalTexture !== cache.normalPlaceholderTexture,
    normalTextureMipLevelCount: cache.normalTextureMipLevelCount ?? null,
    normalTextureMaxLod: cache.normalTextureMaxLod ?? null,
    ...lifecycleStatistics,
    // Preserve the pre-lifecycle synthetic-cache compatibility used by the
    // focused snapshot spec while real caches report their exact tuple.
    cacheSerial: lifecycleStatistics.cacheSerial ?? cache.cacheSerial ?? null,
    resourceGeneration:
      lifecycleStatistics.resourceGeneration ??
      cache.resourceGeneration ??
      null,
    sourceCache: getSharedMoonDecodedSourceCache().getDiagnostics(),
    bundleKey: cache._bundleKey ?? null,
    bundleInvalidationCount: cache._bundleInvalidationCount ?? 0,
    bundleStale: cache._bundleStale === true,
    snapshotRegistered: cache._snapshotRegistered === true,
    frozen: cache._frozen === true,
    moonDirectionWC: moonDirWC,
    phaseFraction,
    earthshineOn,
    earthshinePhaseScale,
    terminatorSoftness,
    useLogDepth,
    shininess,
    specularStrength,
    atmosphereExtinction: extinction,
    lunarBRDFOn,
    atmosphereInscatter: inscatter,
    oppositionSurge,
  });
}

// ============================================================
// Cleanup
// ============================================================

function destroyWebGPUSunResources(sun) {
  const cache = sun._webgpuCache;
  if (!defined(cache)) {
    return;
  }
  if (defined(cache.vertexBuffer)) {
    cache.vertexBuffer.destroy();
  }
  if (defined(cache.uniformBuffer)) {
    cache.uniformBuffer.destroy();
  }
  if (defined(cache.sunTexture)) {
    cache.sunTexture.destroy();
  }
  sun._webgpuCache = undefined;
}

function destroyWebGPUMoonResources(moon) {
  const cache = moon._webgpuCache;
  if (!defined(cache)) {
    return;
  }
  // Detach first. Every deferred callback checks this exact owner/cache link,
  // so no settlement can mutate the orphan while teardown drains candidates.
  moon._webgpuCache = undefined;
  retireWebGPUMoonTextureLifecycle(
    cache._moonTextureLifecycle,
    "cache-destroyed",
  );

  // Invalidate the recorded bundle before retiring any texture view captured
  // by that bundle. A bundle manager may already be gone during context loss;
  // teardown remains best-effort in that case.
  try {
    if (
      defined(cache.context?.renderBundleManager) &&
      defined(cache._bundleKey)
    ) {
      cache.context.renderBundleManager.invalidate(cache._bundleKey);
      cache._bundleInvalidationCount++;
    }
  } catch (e) {
    //>>includeStart('debug', pragmas.debug);
    console.warn("[WebGPU:Moon] bundle invalidation failed:", e);
    //>>includeEnd('debug');
  }
  cache.bindGroup = undefined;
  cache.bundle = undefined;

  // Phase 6 audit fix — the moon registers a "moon-renderer" freezable
  // with `scene.snapshotMode` during update(). The closure captures the
  // `cache` object; without explicit unregistration, the registration
  // outlives the moon's GPU resources and freeze()/thaw() would mutate
  // a destroyed cache on the next snapshot enter/exit.
  if (cache._snapshotRegistered && defined(cache._snapshotService)) {
    try {
      cache._snapshotService.unregisterFreezable("moon-renderer");
    } catch (e) {
      //>>includeStart('debug', pragmas.debug);
      console.warn("[WebGPU:Moon] unregisterFreezable failed:", e);
      //>>includeEnd('debug');
    }
    cache._snapshotRegistered = false;
    cache._snapshotService = undefined;
  }

  // Drain every independently owned handle even if one destroy() reports an
  // error. The Set also protects the placeholder/current alias from a second
  // destroy call.
  const destroyed = new Set();
  let firstDestroyError;
  function destroyOnce(resource) {
    if (!defined(resource) || destroyed.has(resource)) {
      return;
    }
    destroyed.add(resource);
    try {
      resource.destroy();
    } catch (error) {
      firstDestroyError ??= error;
    }
  }
  function destroyTextureOnce(texture) {
    if (defined(texture) && !destroyed.has(texture)) {
      try {
        if (typeof cache.context?.cancelTextureMipGeneration === "function") {
          cache.context.cancelTextureMipGeneration(texture);
        } else {
          cache.context?.noteInlineTextureDestroy?.(texture);
        }
      } catch (error) {
        firstDestroyError ??= error;
      }
    }
    destroyOnce(texture);
  }
  destroyOnce(cache.geometry?.vertexBuffer);
  destroyOnce(cache.geometry?.indexBuffer);
  destroyOnce(cache.uniformBuffer);
  destroyTextureOnce(cache.moonTexture);
  destroyTextureOnce(cache.normalTexture);
  destroyTextureOnce(cache.normalPlaceholderTexture);

  cache.geometry = undefined;
  cache.uniformBuffer = undefined;
  cache.moonTexture = undefined;
  cache.moonTextureView = undefined;
  cache.normalTexture = undefined;
  cache.normalTextureView = undefined;
  cache.normalPlaceholderTexture = undefined;
  cache.normalPlaceholderView = undefined;

  if (defined(firstDestroyError)) {
    //>>includeStart('debug', pragmas.debug);
    console.warn("[WebGPU:Moon] resource teardown failed:", firstDestroyError);
    //>>includeEnd('debug');
  }
}

export {
  updateWebGPUSun,
  updateWebGPUMoon,
  destroyWebGPUSunResources,
  destroyWebGPUMoonResources,
  getWebGPUMoonStatistics,
  createMoonFreezable,
};

export default {
  updateWebGPUSun,
  updateWebGPUMoon,
  destroyWebGPUSunResources,
  destroyWebGPUMoonResources,
  getWebGPUMoonStatistics,
  createMoonFreezable,
};
