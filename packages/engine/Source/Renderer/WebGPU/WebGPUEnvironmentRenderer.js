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
import Pass from "../Pass.js";
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
// Scene-framebuffer target helper.
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
// Shared bounding-cube geometry and base uniform pack for ellipsoid bodies.
// The Moon is the only consumer today; the helpers are shaped so that a
// sun-as-ellipsoid or a custom planet renderer can share them unchanged.
import {
  createEllipsoidBoundingCube,
  createEllipsoidBindGroupLayout,
  packEllipsoidBaseUniforms,
} from "./WebGPUEllipsoidRenderer.js";
import { ShaderSourceId } from "./WebGPUShaderDefines.js";
import { WebGPUShaderModuleCache } from "./WebGPUShaderModuleCache.js";
import { isWebGPULogDepthActive } from "./WebGPULogDepth.js";

// Per-device shader module cache so two Sun / Moon instances on the same
// `GPUDevice` share one compiled `GPUShaderModule`.
const _envShaderModuleCaches = new WeakMap();

function getEnvShaderModuleCache(device) {
  let cache = _envShaderModuleCaches.get(device);
  if (!cache) {
    cache = new WebGPUShaderModuleCache(device);
    _envShaderModuleCaches.set(device, cache);
  }
  return cache;
}

// The sun's WGSL lives at module scope rather than inside the per-update
// block so the module cache can dedupe it by source id across instances.
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
  // C12-19 — the disc's LINEAR radiance occupies the former \`_sunPad1\` pad at
  // offset 156. Exactly the C12-29 S1 manoeuvre that turned \`_p2\` into
  // \`eclipseAlpha\`: the pad was already written (as 0.0) and already reserved
  // by the 256-byte uniform buffer, so this is a rename plus a use — no
  // stride, alignment, binding or bind-group-layout delta, and no new
  // ShaderDefine bit (C12 exit condition 5).
  encodedSunLow: vec3<f32>, discRadiance: f32,
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
  // C12-19 — true HDR disc radiance, the WGSL twin of SunFS.glsl's
  // \`out_FragColor.rgb *= u_discRadiance\`. AFTER the gamma decode (a radiance
  // is linear; applying it first would raise it to the gamma) and on RGB ONLY
  // (alpha is this pipeline's ALPHA_BLEND destination weight since C11-115 —
  // an alpha above 1 makes \`1 - a\` negative and subtracts the sky). Exactly
  // 1.0 outside HDR, so the multiply is a byte-identical no-op there.
  color = vec4f(color.rgb * u.discRadiance, color.a);
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
 * Mirrors `tryResolvePolylinePipeline`.
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

/**
 * Resolve the optional physical-Moon pipeline with a terminal failure policy.
 * Unlike the legacy environment pipelines, this route is a lazy correctness
 * upgrade with a feature-preserving ENVIRONMENT fallback. Retrying a rejected
 * compilation every near-Moon frame would create an unbounded hot-loop tax;
 * one failure therefore remains terminal for this owner/context/device/
 * generation cache. Device recovery or a scene-format generation change
 * replaces the entry and permits one fresh attempt.
 *
 * @private
 */
function tryResolvePhysicalMoonPipeline(device, pipelineCache, entry) {
  if (entry.failed === true) {
    return null;
  }
  if (entry.pipeline) {
    return entry.pipeline;
  }

  function fail(error) {
    entry.pending = false;
    entry.failed = true;
    if (entry.failureReported !== true) {
      entry.failureReported = true;
      console.warn(
        "[WebGPU:Moon] physical-depth pipeline failed; retaining the legacy ENVIRONMENT route:",
        error && error.message ? error.message : error,
      );
    }
    return null;
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
        .then((pipeline) => {
          if (entry.failed !== true) {
            entry.pipeline = pipeline;
            entry.pending = false;
          }
        })
        .catch(fail);
    }
    return null;
  }

  try {
    entry.pipeline = device.createRenderPipeline(
      _envDescriptorToGPU(entry.descriptor),
    );
    entry.pending = false;
    return entry.pipeline;
  } catch (error) {
    return fail(error);
  }
}

const UNIFORM_BUFFER_SIZE = 256;
// The Moon's uniform buffer is larger than the Sun's because it carries the
// whole ray-march state: the RTE moon centre and camera split, the 3x3
// inverse model-view, the radii, two light directions, the celestial state,
// the Phong tunables and the log-depth far plane, then the lunar BRDF flag at
// byte 316, the in-scatter vec3 and opposition surge at 320..335, and the
// relief strength and phase pair from byte 336.
//
// Growth is add-only at the tail and existing offsets stay frozen — the phase
// fraction remains at float offset 67, byte 268 — because the `U` struct in
// Moon.wgsl and `_packMoonUniforms` both address this buffer by absolute
// offset, so moving one field silently reinterprets every field after it.
const MOON_UNIFORM_BUFFER_SIZE = 352;
const scratchModelView = new Matrix4();
const scratchMVRTE = new Matrix4();
const scratchMVPRTE = new Matrix4();
// The inverseModelView3, cameraMC, sunMC, sceneLightMC, inverseModelMatrix
// and inverseModelRot3 scratches live in `WebGPUEllipsoidRenderer.ts` with the
// base uniform pack that uses them. The ones below belong to the Sun renderer
// (`scratchEncodedPos`, `scratchEncodedCamera`) and to the Moon's
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
 * Edge length of the sun bake, reproducing WebGL's rule
 * (`Sun.js`: `2^(ceil(log2(max(w, h))) - 2)`, clamped to >= 1) so that the two
 * backends bake at the same resolution, with one deliberate difference: an
 * upper cap of 1024.
 *
 * The cap exists because WebGL bakes on the GPU, in a full-screen
 * `ComputeCommand` pass, while this backend bakes on the CPU in a JS double
 * loop; uncapped, an 8K canvas would ask for a 2048^2 = 4.2 Mpx loop on the
 * main thread at every resize. It costs nothing visually: the billboard's
 * on-screen footprint is `22 * limbPx` pixels and `limbPx` is about 4.3 px at
 * 1080p and a 60 deg field of view, so the quad is about 95 px across and even
 * 256^2 is already about 2.7x oversampled, 1024^2 about 11x. Resolution is not
 * the visual lever here; the bake format is.
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

// IEEE-754 binary32 to binary16 conversion for the HDR bake. `Float16Array`
// is too new to rely on in the browsers this fork targets, so the packing is
// explicit. Every value this bake produces is a finite number in [0, 1],
// because the bake saturates, so the Inf/NaN paths are unreachable and the
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
 * @param {string} format `"rgba16float"` under HDR, otherwise `"rgba8unorm"`,
 *        matching WebGL's HALF_FLOAT/UNSIGNED_BYTE selection.
 * @param {object} appearance Resolved `frameState.sunDiscAppearance`; see
 *        `Scene/SunDiscAppearance.js`.
 * @param {object} halo Resolved `frameState.sunHalo`; see
 *        `Scene/SunHaloAppearance.js`. Supplies the disc's terminating radius
 *        and the bake halo gain, so this loop and `SunTextureFS.glsl` are fed
 *        the same two numbers rather than each re-deriving them.
 * @private
 */
function createSunTexture(device, size, glowFactor, format, appearance, halo) {
  const texture = device.createTexture({
    label: `Sun procedural texture [${size}^2 ${format}]`,
    size: [size, size, 1],
    format: format,
    usage:
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.STORAGE_BINDING |
      GPUTextureUsage.COPY_DST,
  });

  // The bake is the CPU twin of `SunTextureFS.glsl`: the disc occupies a small
  // central radius (`radiusTS` here, `u_radiusTS` there), a soft glow halo
  // fills the rest, and six pre-rotated lens-flare bursts radiate out. RGB is
  // close to white and the disc, glow and flare shape lives in alpha and blue,
  // so the blend paints a glowing sun. A disc sized to fill most of the
  // texture instead leaves no room for either the halo or the flare.
  // `glowLengthTS` mirrors `Sun.update`'s `glowFactor * 5`, which shrinks the
  // central disc and widens the glow halo as `glowFactor` rises; the default
  // `glowFactor = 1` gives 5.
  const glowLengthTS = glowFactor * 5.0;
  // The disc's terminating radius and the bake halo gain arrive resolved from
  // `Scene/SunHaloAppearance.js`, published on `frameState` before the backend
  // branch. The fallbacks below are the disabled-toggle positions — undersized
  // disc, baked halo — matching what `SunTextureFS.glsl` renders when its
  // uniforms carry those values, so an unpublished frame degrades to a sun
  // that still has a glow rather than to one with none.
  const radiusTS = halo ? halo.discEdge : 0.5 / (1.0 + 2.0 * glowLengthTS);
  const haloGain = halo ? halo.bakeHaloGain : 1.0;
  const lengthScalar = 2.0 / Math.sqrt(2.0);
  const smoothstep = (e0, e1, x) => {
    const t = Math.min(1.0, Math.max(0.0, (x - e0) / (e1 - e0)));
    return t * t * (3.0 - 2.0 * t);
  };
  // The same resolution the WebGL bake receives as uniforms
  // (`frameState.sunDiscAppearance`, published by `Sun.update` before the
  // backend branch). `a1 = a2 = 0, a0 = 1` is the disabled position and gives
  // a flat disc exactly; `glareLegacy = 1` selects the smoothstep halo.
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
  // Six manually-unrolled burst directions, matching the unrolled loop in
  // `SunTextureFS.glsl`.
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
      // Limb-darkened disc radiance in place of a binary step. The saturation
      // further down leaves this visible at defaults, because `haloGain` is 0
      // there and the alpha written is `surface` alone; `SunTextureFS.glsl`'s
      // `main()` carries the same reasoning for the GLSL bake.
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
      // Glow halo into blue and alpha. `haloGain` is 0 whenever the
      // post-process chain owns the halo, which makes the bake disc-only;
      // the GLSL twin gates the same term with `u_haloGain`.
      const glow = sunGlare(radius);
      cb += glow * (0.75 * haloGain);
      ca += glow * (0.75 * haloGain);
      // Lens-flare bursts: rotate(position, dir) * (25, 0.75), then radius.
      // Aperture diffraction rather than veiling glare, so the envelope stays
      // a smoothstep, reading `glareLegacyEdge` for the same 0.55 the GLSL
      // twin uses.
      let burst = 0.0;
      for (let b = 0; b < bursts.length; b++) {
        const dx = bursts[b][0];
        const dy = bursts[b][1];
        const rx = (px * dx - py * dy) * 25.0;
        const ry = (px * dy + py * dx) * 0.75;
        const rb = Math.sqrt(rx * rx + ry * ry) * lengthScalar;
        burst += bursts[b][2] * (1.0 - smoothstep(0.0, glareLegacyEdge, rb));
      }
      // The bursts follow `haloGain` with the halo, as the GLSL twin does: a
      // disc left with six spikes and no surrounding glow reads as a bug.
      burst = Math.min(1.0, Math.max(0.0, burst)) * (0.15 * haloGain);
      cr += burst;
      cg += burst;
      cb += burst;
      ca += burst;

      // The twin of the split saturation at the bottom of
      // `SunTextureFS.glsl`'s `main()`. Componentwise a clamp to [0, 1], split
      // so that both halves are named:
      //   * rgb is chroma, a white point — the `+0.2` on blue is the hue term
      //     that makes the halo orange and the core white,
      //   * alpha is the ALPHA_BLEND destination weight, and above 1 it makes
      //     `1 - a` negative and subtracts the sky.
      // The disc's HDR radiance is not baked here: it is a linear multiply in
      // the sun fragment shader (`u.discRadiance`), so the bake stays a shape
      // and the radiance stays a per-frame scalar.
      // `SolarDiscModel.SOLAR_DISC_SDR_RADIANCE` states both constraints.
      const chromaR = Math.min(1.0, Math.max(0.0, cr));
      const chromaG = Math.min(1.0, Math.max(0.0, cg));
      const chromaB = Math.min(1.0, Math.max(0.0, cb));
      const blendWeight = Math.min(1.0, Math.max(0.0, ca));

      const idx = (y * size + x) * 4;
      if (isHalf) {
        // HDR bake. Half-float buys precision in the glare tail, which is
        // where 8-bit quantisation truncates the profile: `rgba8unorm` cannot
        // represent an alpha below 1/255 = 0.00392, which clips the legacy
        // halo at 8.199 solar radii instead of its true 8.556 — a 4.2% radial
        // loss, and the whole of the veiling-glare tail beyond it.
        pixels[idx + 0] = floatToHalfBits(chromaR);
        pixels[idx + 1] = floatToHalfBits(chromaG);
        pixels[idx + 2] = floatToHalfBits(chromaB);
        pixels[idx + 3] = floatToHalfBits(blendWeight);
      } else {
        // The 8-bit store is its own saturation — `rgba8unorm` cannot carry
        // anything outside [0, 1] at all — so this branch is unchanged even if
        // the split above is removed. On an SDR display the sun path is
        // therefore range-limited by the format rather than by a tuning
        // decision.
        pixels[idx + 0] = chromaR * 255;
        pixels[idx + 1] = chromaG * 255;
        pixels[idx + 2] = chromaB * 255;
        pixels[idx + 3] = blendWeight * 255;
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

  // The quad is sized from the sun's true angular radius and glow length, and
  // aspect-corrected, mirroring `Sun.update`: the on-screen size is
  // 2 * solarLimbPixels * (1 + 2*glowLengthTS) with glowLengthTS =
  // glowFactor * 5, so the NDC half-extent is
  // (SOLAR_RADIUS / camera-to-sun distance) * projection focal term *
  // (1 + 2*glowLengthTS). Taking `projection[0]` for X and `[5]` for Y
  // corrects the aspect on its own, because `proj[0] = proj[5]/aspect` for a
  // perspective frustum, so the quad stays circular. A fixed NDC half-extent
  // applied equally to a non-square viewport instead renders the sun as a
  // small glow-less ellipse that is easily lost against the stars.
  // `createSunTexture` fills the whole quad with the central disc, the glow
  // halo and the lens-flare bursts.
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

  // RGB atmospheric transmittance at offsets 28..30 — vec3 `extinction`,
  // 16-byte aligned at byte 112. Defaults to (1,1,1) when the atmosphere is
  // hidden or the sun is viewed from orbit, making the shader multiply a
  // byte-identical no-op. Published by `Sun.update`.
  const extinction = frameState.sunAtmosphereExtinction;
  uniformData[28] = defined(extinction) ? extinction.x : 1.0;
  uniformData[29] = defined(extinction) ? extinction.y : 1.0;
  uniformData[30] = defined(extinction) ? extinction.z : 1.0;

  // Eclipse fade at offset 31, byte 124. `Sun.update` publishes it before the
  // backend branch, so WebGL's `u_eclipseAlpha` and this slot always carry the
  // same scalar. Falls back to 1.0, an exact identity, when the publisher has
  // not run.
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

  // Disc radiance at offset 39, byte 156. `Sun.update` resolves it before the
  // backend branch, so this slot and WebGL's `u_discRadiance` always carry the
  // same scalar. Falls back to 1.0, an exact identity, when the publisher has
  // not run.
  const discRadiance = frameState.sunHalo?.discRadiance;
  uniformData[39] = typeof discRadiance === "number" ? discRadiance : 1.0;
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

  // Parity with WebGL's `Sun`: the user-tunable `glowFactor` drives both the
  // baked texture — disc radius and glow-halo length — and the on-screen quad
  // size. `Sun.glowFactor`'s setter clamps it to >= 0.
  const glowFactor = defined(sun.glowFactor) ? sun.glowFactor : 1.0;

  // Bake size and format parity with WebGL's `Sun.update`: the size comes from
  // the drawing buffer, and the storage is the HALF_FLOAT equivalent under
  // HDR.
  const bakeSize = sunTextureSize(
    context.drawingBufferWidth,
    context.drawingBufferHeight,
  );
  const bakeFormat = frameState.useHDR === true ? "rgba16float" : "rgba8unorm";
  // Resolved by `Sun.update` before the backend branch, so this is the
  // identical payload the WebGL bake's uniforms carry.
  const appearance = frameState.sunDiscAppearance;
  // The fallback key has to be 0, both toggles off, because that is what
  // `createSunTexture` bakes when `appearance` is undefined: a0 = 1,
  // a1 = a2 = 0, glareLegacy = 1, i.e. the flat disc with the smoothstep halo.
  // A fallback of 3 would cache that bake under a both-on signature and never
  // rebuild it once a real appearance arrived carrying the same key. The
  // branch is unreachable while `Sun.update` publishes before the
  // feature-renderer branch, which is exactly why the mismatch would be
  // permanent if it ever did fire.
  const appearanceKey = defined(appearance) ? appearance.key : 0;
  // The halo state also shapes the bake — disc edge and halo gain — so it
  // joins the rebuild signature in bits 2-3, exactly as `Sun.js` does for the
  // WebGL bake. The fallback of 2 is the position this function bakes when
  // `halo` is undefined, the legacy disc edge with a baked halo, by the same
  // reasoning that fixes `appearanceKey`'s fallback at 0.
  const halo = frameState.sunHalo;
  const haloKey = defined(halo) ? halo.key : 2;

  // Regenerate the baked texture when `glowFactor`, the drawing-buffer-derived
  // size, the HDR format or the appearance toggle signature changes, mirroring
  // WebGL's `_glowFactorDirty` / drawing-buffer / `_useHdr` rebuild set.
  // Rebuild only on change to avoid a per-frame CPU bake.
  if (
    defined(cache.sunTexture) &&
    (cache.lastGlowFactor !== glowFactor ||
      cache.lastBakeSize !== bakeSize ||
      cache.lastBakeFormat !== bakeFormat ||
      cache.lastAppearanceKey !== appearanceKey ||
      cache.lastHaloKey !== haloKey)
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
      halo,
    );
    cache.lastGlowFactor = glowFactor;
    cache.lastBakeSize = bakeSize;
    cache.lastBakeFormat = bakeFormat;
    cache.lastAppearanceKey = appearanceKey;
    cache.lastHaloKey = haloKey;
    cache.sunTextureView = cache.sunTexture.createView();
    if (!defined(cache.sampler)) {
      cache.sampler = device.createSampler({
        minFilter: "linear",
        magFilter: "linear",
      });
    }
  }

  // Invalidate the cached pipeline when the scene format changes, as an HDR
  // toggle does. The Sun pipeline targets the scene framebuffer, so its
  // fragment-output format must match the recreated one.
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

  // Descriptor plus the central pipeline cache, so two Sun instances on the
  // same device share one compiled shader module and one pipeline.
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
      // `, alphaBlend` is a readability marker. The pipeline key already folds
      // shader-module and target identity structurally, so this is here to let
      // `describeCacheKey()` and devtools say which blend a row is, not to
      // keep two rows apart.
      name: `Sun pipeline [${format}/${depthFormat}, alphaBlend]`,
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
        // The sun blends ALPHA_BLEND on both backends, the exact twin of
        // `BlendingState.ALPHA_BLEND` which `Sun.js` sets on the WebGL draw
        // command: SRC_ALPHA / ONE_MINUS_SRC_ALPHA for colour and
        // ONE / ONE_MINUS_SRC_ALPHA for alpha.
        //
        // An additive blend (`src-alpha` / `one`) is not equivalent here. Its
        // composite is `dst + src.rgb*src.a`, so a black billboard — which is
        // what the sun becomes once atmospheric extinction drives its rgb to
        // zero near the horizon — is an exact identity, while ALPHA_BLEND
        // darkens the sky by `a*dst`. The two backends then disagree by a
        // residual that appears only where the billboard is black.
        //
        // The eclipse fade is invariant to that choice by construction, since
        // it scales alpha, which is the blend weight under both functions, and
        // so is the disc/halo split for the same reason.
        targets: makeSceneFBTargets(format, {
          blend: {
            color: {
              srcFactor: "src-alpha",
              dstFactor: "one-minus-src-alpha",
              operation: "add",
            },
            alpha: {
              srcFactor: "one",
              dstFactor: "one-minus-src-alpha",
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
      // Matches the scene framebuffer's sample count.
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
      pass: Pass.ENVIRONMENT,
      owner: sun,
    });
  }

  return cache.command;
}

// ============================================================
// Moon Renderer — Ray-Marched Analytic Ellipsoid
// ============================================================

/**
 * Bounding cube for the ray-marched moon shader. The geometry lives in
 * `WebGPUEllipsoidRenderer.ts` so that other ellipsoid bodies can share the
 * same 8-vertex / 36-index unit cube. The vertex shader scales it by `radii`
 * to wrap the moon ellipsoid, mirroring WebGL's `EllipsoidPrimitive`, which
 * uses `BoxGeometry.fromDimensions({2,2,2})`.
 *
 * A cube rather than a full-screen quad because the cube's screen footprint is
 * the moon's actual on-screen size, so the fragment shader runs only on pixels
 * that could contain the moon. A full-screen quad would run it on every pixel
 * of the canvas — around 8M invocations at 4K — all of which would discard
 * early but still cost rasterizer scheduling.
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

  // The shared bind group layout from `WebGPUEllipsoidRenderer`, so that other
  // ellipsoid bodies match it exactly. The moon opts into binding 3, the
  // tangent-space normal map.
  const bgl = createEllipsoidBindGroupLayout(device, { normalTexture: true });

  const descriptor = {
    name: `Moon pipeline [${format}/${depthFormat}]`,
    layout: device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
    vertex: {
      module: mod,
      entryPoint: "vs",
      // Bounding cube vertex layout: 12 bytes per vertex, 8 vertices,
      // 36 indices.
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
      // Scene-framebuffer target, with an overwrite blend
      // (1 x src + 0 x dst) for the bounding-cube ray-march pass.
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
    // Bounding cube with back faces culled: the front faces rasterize and the
    // fragment shader ray-marches inward. A camera inside the cube — a
    // close-up moon flythrough — would have its visible faces discarded by
    // that cull, which would need `cullMode` switched dynamically. Close-up
    // flythrough is out of scope here.
    primitive: { topology: "triangle-list", cullMode: "back" },
    depthStencil: {
      format: depthFormat,
      // The moon is rendered at the far plane, the vertex shader forcing
      // z/w = 1, and composited with `less-equal`, so it only draws in pixels
      // not already occluded by closer geometry. That makes it draw-order
      // agnostic; `depthCompare: always` would instead require the moon to be
      // issued before terrain.
      depthWriteEnabled: false,
      depthCompare: "less-equal",
    },
    // Matches the scene framebuffer's sample count.
    multisample: sampleCount > 1 ? { count: sampleCount } : undefined,
  };

  return { descriptor, bgl };
}

/**
 * C12-37 physical Moon pipeline. Kept separate and lazy so the ordinary
 * Earth-near ENVIRONMENT pipeline above retains its exact descriptor, bundle,
 * bind-group layout, and upload behavior.
 *
 * @private
 */
function buildPhysicalMoonPipelineResources(
  device,
  format,
  depthFormat,
  sampleCount,
) {
  const moduleCache = getEnvShaderModuleCache(device);
  const mod = moduleCache.getOrCreate(
    ShaderSourceId.ENVIRONMENT_MOON,
    MoonShaderCode,
    0,
    "Moon shader",
  );
  const bgl = makeBindGroupLayout(device, "Moon_Physical_BindGroupLayout", [
    uniformBuffer(0, Stage.VERTEX_FRAGMENT),
    texture(1, Stage.FRAGMENT),
    sampler(2, Stage.FRAGMENT),
    texture(3, Stage.FRAGMENT),
    texture(4, Stage.FRAGMENT),
  ]);
  const descriptor = {
    name: `Moon physical pipeline [${format}/${depthFormat}]`,
    layout: device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
    vertex: {
      module: mod,
      entryPoint: "vsPhysical",
      buffers: [
        {
          arrayStride: 12,
          attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }],
        },
      ],
    },
    fragment: {
      module: mod,
      entryPoint: "fsPhysical",
      targets: makeSceneFBTargets(format),
    },
    // Analytic intersection discards miss lanes. Disabling face culling also
    // preserves the camera-inside-Moon case without a second pipeline.
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: {
      format: depthFormat,
      depthWriteEnabled: true,
      depthCompare: "less-equal",
    },
    multisample: sampleCount > 1 ? { count: sampleCount } : undefined,
  };
  return { descriptor, bgl };
}

/**
 * Renderer hooks for one exact Moon texture request. The generic lifecycle
 * controller owns the deferred state and the stale-candidate rules; these
 * hooks are the only layer that knows how to fetch and realize a
 * `GPUTexture`.
 *
 * The orientation convention matches WebGL: both albedo and relief upload
 * with `flipY: true`.
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
  const physicalSlots = cache.physicalUniformSlots;
  if (defined(physicalSlots)) {
    for (let i = 0; i < physicalSlots.length; i++) {
      physicalSlots[i].bindGroup = undefined;
      physicalSlots[i].albedoView = undefined;
      physicalSlots[i].normalView = undefined;
    }
  }
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
 * A 1x1 flat tangent-space normal, (128, 128, 255), i.e. (0, 0, 1).
 *
 * Bound whenever the moon has no normal map — the `Moon.Variant.SMALL` case —
 * or while the real map is still loading. Paired with `normalStrength = 0` the
 * shader skips the fetch entirely, so this exists to satisfy the bind group
 * layout, where a binding must always have an entry, and to be harmless in the
 * one frame ordering where strength is non-zero before the real texture lands.
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
 * Updates WebGPU Moon rendering.
 *
 * Bounding-cube rasterization, an analytic ray-marched ellipsoid in model
 * space, and RTE 64-bit precision in the vertex shader. Mirrors the WebGL
 * `EllipsoidPrimitive` moon path with full feature parity, plus earthshine.
 * There is no phase-gating multiplier on the lit term: it double-counts the
 * N·L phase and blacks out the daytime moon. `phaseFraction` is still packed,
 * because earthshine reads it.
 *
 * Performance:
 *   - Render bundle pre-encoding through `WebGPURenderBundleManager`. The
 *     pipeline, bind group, vertex and index buffers and draw call are
 *     identical every frame, so the encoded bundle is cached and replayed.
 *     The uniform buffer contents change each frame through `writeBuffer`,
 *     but the bundle reads from the same buffer object, so the new data shows
 *     up on the next replay.
 *   - `SnapshotModeService` freezable registration. While snapshot mode is
 *     active the moon's per-frame uniform writes still happen on the first
 *     frame after entering, then become a no-op until thaw, and the bundle
 *     replays the captured uniforms verbatim.
 *   - Behind-camera early-out before any work, so a moon below the horizon
 *     does not even submit a draw command.
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

  // Every handle below is owned by this exact owner/context/device/generation
  // tuple. A device replacement or a same-device resource-generation bump
  // retires the whole old cache before any of its GPU objects can be inspected
  // or submitted.
  const cache = ensureWebGPUMoonCache(moon, context, device);

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

  // Bounding cube geometry (8 vertices, 36 indices).
  if (!defined(cache.geometry)) {
    cache.geometry = createMoonBoundingCube(device);
  }

  // Invalidate the cached pipeline and bundle when the scene format changes.
  // The bundle key includes `scenePipelineFormat`, so a stale bundle for the
  // old format would not match anyway, but flagging `_bundleStale` forces an
  // explicit invalidation in the manager and releases the old bundle's GPU
  // memory promptly.
  const currentMoonGen = context._scenePipelineFormatGeneration ?? 0;
  if (
    defined(cache.pipelineEntry) &&
    cache._pipelineFormatGeneration !== currentMoonGen
  ) {
    cache.pipelineEntry = undefined;
    cache.pipeline = undefined;
    cache.physicalPipelineEntry = undefined;
    cache.physicalPipeline = undefined;
    cache.physicalBgl = undefined;
    cache.physicalCommand = undefined;
    const physicalSlots = cache.physicalUniformSlots;
    if (defined(physicalSlots)) {
      for (let i = 0; i < physicalSlots.length; i++) {
        physicalSlots[i].bindGroup = undefined;
      }
    }
    cache._bundleStale = true;
  }

  // Descriptor plus the central pipeline cache. The cache's
  // `createRenderPipelineAsync()` path catches shader and pipeline validation
  // errors and surfaces them through its `.catch` handler, which logs and
  // clears the in-flight flag, so no `pushErrorScope` wrapper is needed here.
  // Nor is a failure sentinel: the entry's own `pending` slot stays stable on
  // failure, so a retry simply attempts creation again on the next frame,
  // which is the behaviour a transient error wants.
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

  // C12-37 — request the physical pipeline only while the shared f64 demand
  // asks for it. Until this lazy pipeline is genuinely ready, the function
  // continues through the unchanged ENVIRONMENT path below; the Moon never
  // disappears and never emits both routes.
  let physicalPipeline;
  if (
    moon._physicalDepthPrewarmRequested === true ||
    moon._physicalDepthRequested === true
  ) {
    if (!defined(cache.physicalPipelineEntry)) {
      const format = context.scenePipelineFormat || "bgra8unorm";
      const depthFmt = context.depthFormat || "depth24plus-stencil8";
      const sampleCount = context._msaaSamples ?? 1;
      const built = buildPhysicalMoonPipelineResources(
        device,
        format,
        depthFmt,
        sampleCount,
      );
      cache.physicalPipelineEntry = {
        descriptor: built.descriptor,
        pipeline: null,
        pending: false,
        failed: false,
        failureReported: false,
      };
      cache.physicalBgl = built.bgl;
    }
    physicalPipeline = tryResolvePhysicalMoonPipeline(
      device,
      context.webgpuPipelineCache ?? null,
      cache.physicalPipelineEntry,
    );
    if (defined(physicalPipeline)) {
      cache.physicalPipeline = physicalPipeline;
    }
  }

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

  // Normal map at binding 3, always bound: the flat placeholder is the
  // identity, so there is one pipeline and no shader variant.
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

  // Reconcile independent request serials against one exact
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

  if (moon._physicalDepthRequested === true && defined(physicalPipeline)) {
    pushPhysicalMoonCommand(moon, frameState, commandList, cache);
    return;
  }

  // Uniform buffer sized by `MOON_UNIFORM_BUFFER_SIZE`, currently 352 bytes /
  // 88 floats, of which floats 0..86 are in use and 87 is tail padding. The
  // size lives on that constant alone, and an add-only uniform appends after
  // the last used float, which is `ud[86]` in `_packMoonUniforms`, not
  // float 84.
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
        // Normal map; reuses the binding-2 sampler.
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
    // The canonical publication is `frameState.snapshotMode`, written by
    // `Scene.updateFrameState`. `frameState.scene` is never populated, so a
    // registration gated on that property never fires, and the moon then keeps
    // packing and uploading uniforms every frame while the scene is frozen.
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

  // The whole per-frame pack-and-write is skipped while the snapshot service
  // has this cache frozen. The bundle's recorded `setBindGroup` still points
  // at the same GPU uniform buffer, so it reads whatever was last written.
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

  // The pipeline, bind group, vertex and index buffers and indexed draw are
  // identical every frame, so the sequence is recorded once into a
  // `GPURenderBundle` and replayed through `executeBundles`;
  // `WebGPURenderBundleManager` handles caching and eviction. The bundle
  // becomes stale on:
  //   - the first frame for this moon
  //   - a texture upgrade, which replaces `cache.bindGroup`
  //   - an explicit invalidation
  // The bundle key includes the surface format set, so different render passes
  // such as picking get their own bundles.
  //
  // Bundle creation is skipped when the pipeline failed validation, because an
  // invalid pipeline produces an invalid bundle that poisons the entire
  // command encoder on `executeBundles`.
  const bundleMgr = context.renderBundleManager;
  if (defined(bundleMgr) && defined(cache.pipeline) && !cache._pipelineFailed) {
    // The bundle encoder has to match the recorded pipeline's multisample
    // state. The Moon pipeline bakes `sampleCount = context._msaaSamples`, so
    // the bundle's encoder needs the same value or `executeBundles` fails with
    // "Attachment state ... is not compatible". The sample count is also part
    // of the bundle key, so a mid-session MSAA toggle evicts the prior bundle
    // instead of replaying a stale one.
    const sampleCount = context._msaaSamples ?? 1;
    const bundleKey = `moon:${moon._cacheId ?? (moon._cacheId = createGuid())}:${context.scenePipelineFormat}:${context.depthFormat}:${sampleCount}`;
    cache._bundleKey = bundleKey;
    if (cache._bundleStale) {
      bundleMgr.invalidate(bundleKey);
      cache._bundleInvalidationCount++;
      cache._bundleStale = false;
    }
    // The bundle's `colorFormats` must match the Moon pipeline's target count.
    // `makeSceneFBTargets` makes the pipeline declare a slot-1 placeholder
    // while MRT mode is on, so the bundle needs the matching format entry;
    // without it the bundle's attachment state is incompatible with the
    // pipeline and recording fails with "Attachment state not compatible".
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

  // The draw command carries the bundle: the `Pass.ENVIRONMENT` executor calls
  // `executeBundles` when it sees `command.bundle` set. The command also
  // carries the pipeline, bind group and buffers, so an executor without
  // bundle support falls back to a normal indexed draw.
  cache.command = new WebGPUDrawCommand({
    pipeline: cache.pipeline,
    bindGroups: [cache.bindGroup],
    vertexBuffers: [cache.geometry.vertexBuffer],
    indexBuffer: cache.geometry.indexBuffer,
    indexCount: cache.geometry.indexCount,
    indexFormat: "uint16",
    pass: Pass.ENVIRONMENT,
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
 * Return one independently backed physical-Moon uniform slot. A physical
 * command is resolved only after the renderer has selected a view and frustum
 * and copied that frustum's globe depth. Because every queue.writeBuffer call
 * happens before the frame's single submit, reusing one buffer would make all
 * recorded draws observe the bytes from the last execution. Slots therefore
 * grow with the number of actual executions and are retained for reuse.
 *
 * @private
 */
function getPhysicalMoonUniformSlot(cache, slotIndex) {
  const slots = (cache.physicalUniformSlots ??= []);
  let slot = slots[slotIndex];
  if (!defined(slot)) {
    slot = slots[slotIndex] = {
      uniformBuffer: WebGPUBuffer.createUniformBuffer(
        cache.device,
        MOON_UNIFORM_BUFFER_SIZE,
        undefined,
        `Moon physical uniforms ${slotIndex}`,
      ),
      uniformData: new Float32Array(MOON_UNIFORM_BUFFER_SIZE / 4),
      bindGroup: undefined,
      albedoView: undefined,
      normalView: undefined,
      sampler: undefined,
      globeDepthView: undefined,
    };
  }
  return slot;
}

/**
 * Build or refresh a physical-Moon bind group for one execution slot. The
 * packed depth view is deliberately resolved here, not during Scene.update:
 * WebGPU publishes a different view after each frustum's GLOBE copy. The
 * albedo view is a valid texture placeholder while no packed view is needed
 * (or when a required view failed to publish); the uniform mode prevents that
 * placeholder from ever being interpreted as depth.
 *
 * @private
 */
function getPhysicalMoonBindGroup(cache, slot, globeDepthView) {
  const depthResource = globeDepthView ?? cache.moonTextureView;
  if (
    !defined(slot.bindGroup) ||
    slot.albedoView !== cache.moonTextureView ||
    slot.normalView !== cache.normalTextureView ||
    slot.sampler !== cache.sampler ||
    slot.globeDepthView !== depthResource
  ) {
    slot.bindGroup = cache.device.createBindGroup({
      label: "Moon physical bind group",
      layout: cache.physicalBgl,
      entries: [
        { binding: 0, resource: { buffer: slot.uniformBuffer.buffer } },
        { binding: 1, resource: cache.moonTextureView },
        { binding: 2, resource: cache.sampler },
        { binding: 3, resource: cache.normalTextureView },
        { binding: 4, resource: depthResource },
      ],
    });
    slot.albedoView = cache.moonTextureView;
    slot.normalView = cache.normalTextureView;
    slot.sampler = cache.sampler;
    slot.globeDepthView = depthResource;
  }
  return slot.bindGroup;
}

/**
 * Resolve one physical Moon execution against the current view/frustum.
 * Projection, RTE camera position, canonical log-depth range, TAA jitter and
 * the packed globe-depth view are all late state and must be captured here.
 *
 * @private
 */
function resolvePhysicalMoonBindGroup(moon, frameState, cache) {
  const context = frameState.context;
  const uniformState = context.uniformState;
  const slot = getPhysicalMoonUniformSlot(
    cache,
    cache.physicalExecutionCursor++,
  );
  const cameraPositionWC =
    uniformState.cameraPosition ?? frameState.camera.positionWC;
  _packMoonUniforms(
    moon,
    frameState,
    cache,
    slot.uniformData,
    cameraPositionWC,
  );
  // Physical depth must use the renderer-wide producer switch. Keep this
  // override out of the legacy ENVIRONMENT pack, whose historical shader uses
  // frameState.useLogDepth directly and parks the Moon at the far plane.
  slot.uniformData[69] = isWebGPULogDepthActive(context, frameState)
    ? 1.0
    : 0.0;

  // The globe publishes the FULL camera range used to encode packed log depth,
  // while projection/currentFrustum remain the executing slice. This is the
  // same split consumed by globe, primitives, collections and voxels.
  const encodeNearFar = uniformState._logDepthEncodeNearFar;
  const encodeNear = Number(encodeNearFar?.[0]);
  const encodeFar = Number(encodeNearFar?.[1]);
  const currentFrustum = uniformState.currentFrustum;
  slot.uniformData[73] = Number.isFinite(encodeNear)
    ? encodeNear
    : (currentFrustum?.x ?? 0.0);
  slot.uniformData[72] = Number.isFinite(encodeFar)
    ? encodeFar
    : (currentFrustum?.y ?? 1.0e9);
  const publishedFactor = Number(uniformState._logDepthEncodeFactor);
  const logSpan = slot.uniformData[72] - slot.uniformData[73] + 1.0;
  slot.uniformData[74] =
    Number.isFinite(publishedFactor) && publishedFactor > 0.0
      ? publishedFactor
      : logSpan > 1.0
        ? 1.0 / Math.log2(logSpan)
        : 0.0;

  const requiresPackedDepth = moon._physicalDepthClearGlobeDepth === true;
  const globeDepthView = context._globeDepthView ?? undefined;
  // -1 is fail-closed in WGSL. It prevents a first-frame/resize/device-recovery
  // hole from turning into the original Moon-on-top bug.
  slot.uniformData[75] = requiresPackedDepth
    ? defined(globeDepthView)
      ? 1.0
      : -1.0
    : 0.0;

  context.device.queue.writeBuffer(
    slot.uniformBuffer.buffer,
    0,
    slot.uniformData.buffer,
    slot.uniformData.byteOffset,
    slot.uniformData.byteLength,
  );
  return getPhysicalMoonBindGroup(cache, slot, globeDepthView);
}

/**
 * Emit the physical Moon as one ordinary, bounded OPAQUE command. It remains
 * in Cesium's normal frustum binning across every intersecting slice, and opts
 * out of Earth-centric horizon/octree/Hi-Z occlusion. The physical fragment's
 * canonical depth-range guard leaves exactly the owning slice visible. Keeping
 * all intersecting slices is required for camera-inside-Moon views, where the
 * sphere enters the closest slice but its visible exit surface may be farther.
 * No render bundle is attached because its bind group is resolved per
 * execution after the GLOBE depth publication.
 *
 * @private
 */
function pushPhysicalMoonCommand(moon, frameState, commandList, cache) {
  cache.physicalExecutionCursor = 0;
  const initialSlot = getPhysicalMoonUniformSlot(cache, 0);
  const initialBindGroup = getPhysicalMoonBindGroup(
    cache,
    initialSlot,
    undefined,
  );
  if (!defined(cache.physicalBindGroupResolver)) {
    cache.physicalBindGroupResolver = function () {
      return resolvePhysicalMoonBindGroup(
        cache.physicalMoon,
        cache.physicalFrameState,
        cache,
      );
    };
  }
  cache.physicalMoon = moon;
  cache.physicalFrameState = frameState;

  if (!defined(cache.physicalCommand)) {
    cache.physicalCommand = new WebGPUDrawCommand({
      pipeline: cache.physicalPipeline,
      bindGroups: [initialBindGroup],
      bindGroupResolvers: [cache.physicalBindGroupResolver],
      vertexBuffers: [cache.geometry.vertexBuffer],
      indexBuffer: cache.geometry.indexBuffer,
      indexCount: cache.geometry.indexCount,
      indexFormat: "uint16",
      pass: Pass.OPAQUE,
      owner: moon,
      boundingVolume: moon._physicalDepthBoundingVolume,
      modelMatrix: moon._ellipsoidPrimitive.modelMatrix,
      cull: true,
      occlude: false,
      castShadows: false,
      receiveShadows: false,
      pickOnly: false,
      executeInClosestFrustum: false,
    });
  }
  const command = cache.physicalCommand;
  command.pipeline = cache.physicalPipeline;
  command.bindGroups[0] = initialBindGroup;
  command.bindGroup = initialBindGroup;
  command.boundingVolume = moon._physicalDepthBoundingVolume;
  command.modelMatrix = moon._ellipsoidPrimitive.modelMatrix;
  command.owner = moon;
  command.pass = Pass.OPAQUE;
  command.cull = true;
  command.occlude = false;
  command.executeInClosestFrustum = false;
  command.bundle = undefined;
  command._moonPhysicalDepthRoute = true;
  commandList.push(command);
}

/**
 * Packs the moon uniform buffer for one frame. Pulled out of
 * updateWebGPUMoon so the snapshot-mode skip path is a single conditional.
 *
 * Layout matches the `U` struct in Moon.wgsl:
 *   mvpRTE             0..15  (mat4)
 *   camH + pad         16..19  (camera in moon model coords, RTE high)
 *   camL + pad         20..23  (camera in moon model coords, RTE low)
 *   moonH + pad        24..27  (world centre split — unused by the VS)
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
 *   extinction         76..78  (atmospheric transmittance)
 *   lunarBRDF flag     79
 *   inscatter          80..82  (sky-wash, additive)
 *   oppositionSurge    83
 *   normalStrength     84      (relief strength; 0 = exact identity)
 *   earthshinePhase    85      (Earth-phase complement; 1 = identity)
 *   terminatorSoftness 86      (solar angular radius; 0 = identity)
 *
 * @private
 */
function _packMoonUniforms(
  moon,
  frameState,
  cache,
  uniformData,
  cameraPositionWC,
) {
  const context = frameState.context;
  const uniformState = context.uniformState;
  const ellipsoidPrimitive = moon._ellipsoidPrimitive;
  const modelMatrix = ellipsoidPrimitive.modelMatrix;
  const viewMatrix = uniformState.view;
  const projMatrix = uniformState.projection;

  // mvpRelativeToEye is projection x (view x model, with the moon translation
  // zeroed). The body translation is applied instead through the RTE position
  // split that the shared packer writes.
  Matrix4.multiply(viewMatrix, modelMatrix, scratchModelView);
  Matrix4.clone(scratchModelView, scratchMVRTE);
  scratchMVRTE[12] = 0.0;
  scratchMVRTE[13] = 0.0;
  scratchMVRTE[14] = 0.0;
  Matrix4.multiply(projMatrix, scratchMVRTE, scratchMVPRTE);

  const ud = uniformData ?? cache.uniformData;
  ud.fill(0);

  // Shared base uniform pack, offsets 0..63: mvpRTE, the camH/camL split, the
  // centerH/centerL split, ivmRow0..2, cameraPosMC, radii, oneOverRadiiSq,
  // sunDirMC and sceneLightDirMC. Body-specific writes follow at offset 64.
  packEllipsoidBaseUniforms(ud, {
    mvpRelativeToEye: scratchMVPRTE,
    viewMatrix: viewMatrix,
    cameraPositionWC: cameraPositionWC ?? frameState.camera.positionWC,
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

  // Moon-specific uniforms, offsets 64..79.
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
  // WebGL's moon material is `Material.fromType(Material.ImageType)`, whose
  // `czm_getDefaultMaterial` specular is 0.0, so the WebGL moon carries no
  // specular highlight. The shininess exponent stays at a sane value while
  // the strength is zeroed, which makes the disc shading match
  // `czm_private_phong` exactly.
  ud[70] = 5.0; // shininess (Phong exponent; inert while strength is 0)
  ud[71] = 0.0; // specularStrength — 0 to match Material.ImageType

  // farPlane + 3 pad — offsets 72..75
  ud[72] = defined(uniformState.currentFrustum)
    ? uniformState.currentFrustum.y
    : 1.0e9;
  ud[73] = 0;
  ud[74] = 0;
  ud[75] = 0;

  // RGB atmospheric transmittance at offsets 76..78 — vec3 `extinction`,
  // 16-byte aligned at byte 304. Defaults to (1,1,1) when the atmosphere is
  // hidden or the moon is viewed from orbit, making the multiply in the
  // shader a byte-identical no-op.
  const extinction = frameState.moonAtmosphereExtinction;
  ud[76] = defined(extinction) ? extinction.x : 1.0;
  ud[77] = defined(extinction) ? extinction.y : 1.0;
  ud[78] = defined(extinction) ? extinction.z : 1.0;

  // Lommel-Seeliger runtime flag at offset 79, byte 316. Same source
  // expression as the WebGL path's `Moon.js` wiring —
  // `atmosphericConditions.lighting.enableLunarBRDF`, false when there is no
  // globe — so both backends select the same disc law every frame.
  ud[79] =
    defined(ac) && defined(ac.lighting) && ac.lighting.enableLunarBRDF === true
      ? 1.0
      : 0.0;

  // Additive in-scattered sky-wash at offsets 80..82 — vec3 `inscatter`,
  // 16-byte aligned at byte 320. Published by `Moon.update` through the shared
  // CPU integral, and (0,0,0) — the additive identity — when the wash is
  // disabled, the atmosphere is hidden, or the view ray misses the shell from
  // orbit, so the output there is byte-identical to a frame without it.
  const inscatter = frameState.moonAtmosphereInscatter;
  ud[80] = defined(inscatter) ? inscatter.x : 0.0;
  ud[81] = defined(inscatter) ? inscatter.y : 0.0;
  ud[82] = defined(inscatter) ? inscatter.z : 0.0;

  // Opposition-surge multiplier at offset 83, byte 332; 1.0 is the identity,
  // used when it is disabled or the moon is away from opposition. Published by
  // `Moon.update`.
  ud[83] = frameState.moonOppositionSurge ?? 1.0;

  // Relief strength at offset 84, byte 336. Resolved once, backend-agnostically,
  // by `Moon.update`, which folds in both the
  // `atmosphericConditions.lighting.enableLunarNormalMap` toggle and the
  // variant gate, since the small variant ships no map, so the two backends
  // read one number and cannot disagree about whether relief is on. Exactly
  // 0.0 disables the perturbation as an exact identity.
  ud[84] = frameState.moonNormalMapStrength ?? 0.0;

  // Earthshine phase scale at offset 85, byte 340, and the solar angular
  // radius at offset 86, byte 344. Both are resolved once,
  // backend-agnostically, by `Moon.update` through
  // `Scene/MoonPhaseAppearance.js` and handed to the WebGL twin as
  // `u_earthshinePhaseScale` and `u_terminatorSoftness`, so the two backends
  // cannot derive different numbers. The `??` fallbacks are the two exact
  // identities: 1.0 leaves earthshine at a constant, and 0.0 makes
  // `softTerminatorMu0` return `max(N·L, 0)`. Both live inside the 336..351
  // slot the relief strength already opened, so the buffer size and the
  // bind-group layout are unchanged.
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
 * Returns a diagnostic snapshot of a Moon's WebGPU cache, or `null` when the
 * moon has not yet had its first `update()` call, so the cache is absent, or
 * when called against a non-WebGPU scene. Pure read; safe to call from
 * `Scene.getDebugSnapshot()`.
 *
 * @param {Moon} moon
 * @returns {object|null}
 */
function getWebGPUMoonStatistics(moon) {
  if (!defined(moon) || !defined(moon._webgpuCache)) {
    return null;
  }
  const cache = moon._webgpuCache;
  // Pull the moon-specific uniforms back out of the packed buffer for a quick
  // view of what was pushed to the GPU last frame. The offsets here
  // mirror `_packMoonUniforms()` (offsets 64..86 are the moon tail: 64..75 the
  // base block, 76..83 the atmosphere and BRDF terms, 84 the relief strength,
  // and 85/86 the phase pair).
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
  // Offsets 76..83 — extinction, lunar BRDF flag, sky-wash and opposition
  // surge, as last pushed to the GPU.
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
  // Relief strength as last pushed, alongside whether the bound normal texture
  // is the real map or the flat identity placeholder.
  const normalMapStrength = defined(ud) && ud.length > 84 ? ud[84] : null;
  // The phase pair as last pushed. Acceptance probes read these to prove the
  // CPU-resolved numbers actually reached the GPU.
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

  // The moon registers a "moon-renderer" freezable with `scene.snapshotMode`
  // during `update()`, and that closure captures the `cache` object. Without
  // an explicit unregistration the registration outlives the moon's GPU
  // resources, and `freeze()`/`thaw()` would then mutate a destroyed cache on
  // the next snapshot enter or exit.
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
  const physicalSlots = cache.physicalUniformSlots;
  if (defined(physicalSlots)) {
    for (let i = 0; i < physicalSlots.length; i++) {
      destroyOnce(physicalSlots[i].uniformBuffer);
    }
  }
  destroyTextureOnce(cache.moonTexture);
  destroyTextureOnce(cache.normalTexture);
  destroyTextureOnce(cache.normalPlaceholderTexture);

  cache.geometry = undefined;
  cache.uniformBuffer = undefined;
  cache.physicalUniformSlots = undefined;
  cache.physicalCommand = undefined;
  cache.physicalBindGroupResolver = undefined;
  cache.physicalMoon = undefined;
  cache.physicalFrameState = undefined;
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
  tryResolvePhysicalMoonPipeline,
};

export default {
  updateWebGPUSun,
  updateWebGPUMoon,
  destroyWebGPUSunResources,
  destroyWebGPUMoonResources,
  getWebGPUMoonStatistics,
  createMoonFreezable,
  tryResolvePhysicalMoonPipeline,
};
