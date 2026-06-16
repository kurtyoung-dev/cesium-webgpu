/**
 * WebGPU bright-star catalog starfield renderer (Track V-C, Batch 313 —
 * NEW-STARS-BRIGHT-CATALOG).
 *
 * Renders the Yale Bright Star Catalog subset
 * ({@link BrightStarCatalog}) as instanced HDR point sprites drawn into
 * the scene framebuffer with additive blend, so the existing bloom
 * post-process makes the brightest stars glow. This augments the static
 * SkyBox star cubemap on WebGPU with real, physically-placed stars.
 *
 * Technique (implemented fresh; credited in StarField.wgsl):
 *   - magnitude → intensity via the Pogson scale (each magnitude step is
 *     a flux ratio of 100^(1/5) ≈ 2.512).
 *   - B−V color index → color temperature (Ballesteros 2012) → Planckian-
 *     locus RGB.
 *   - J2000 / TEME catalog directions rotated into the Earth-fixed frame
 *     each frame by `Transforms.computeTemeToPseudoFixedMatrix` — the
 *     same matrix SkyBox uses — so constellations land at the correct
 *     RA/Dec for the scene clock.
 *
 * Lifecycle: the per-instance star buffer is built ONCE (catalog is
 * static). Only the uniform buffer (view-projection + sizing + fade) is
 * repacked per frame. The renderer is a singleton per scene, owned by
 * SkyBox via the FeatureRenderer seam (FeatureRendererKey.STAR_FIELD).
 *
 * NEW-TS-CONVERT-JS-RENDERERS (Batch 314) — converted from JS to
 * TypeScript with ZERO behavior change. Types annotate the existing
 * logic; the module-level function shapes, exports, and runtime paths are
 * byte-for-byte equivalent to the prior `.js`.
 *
 * @private
 * @module WebGPUStarFieldRenderer
 */
import Cartesian3 from "../../Core/Cartesian3.js";
import CesiumMath from "../../Core/Math.js";
import defined from "../../Core/defined.js";
import Matrix3 from "../../Core/Matrix3.js";
import Matrix4 from "../../Core/Matrix4.js";
import Transforms from "../../Core/Transforms.js";
import type JulianDate from "../../Core/JulianDate.js";
import BrightStarCatalog from "../../Scene/BrightStarCatalog.js";
import StarFieldShaderCode from "../../Shaders/WebGPU/Catalog/StarField.js";
import WebGPUBuffer from "./WebGPUBuffer.js";
import WebGPUDrawCommand from "./WebGPUDrawCommand.js";
import {
  makeSceneFBTargets,
  isSceneFBMrtMode,
  MRT_NORMAL_ROUGHNESS_FORMAT,
} from "./WebGPUSceneFBTargetHelpers.js";
import {
  makeBindGroupLayout,
  uniformBuffer,
  Stage,
} from "./WebGPUBindGroupLayoutHelpers.js";
import { ShaderSourceId } from "./WebGPUShaderDefines.js";
import { WebGPUShaderModuleCache } from "./WebGPUShaderModuleCache.js";
import type { WebGPURenderPipelineCache } from "./WebGPURenderPipelineCache.js";
import type { WebGPURenderPipelineDescriptor } from "./WebGPURenderPipelineCache.js";

/**
 * The backend-agnostic StarField scene primitive, narrowed to the fields
 * this renderer reads/writes. Declared structurally (not imported from
 * the untyped `Scene/StarField.js`) so this module stays free of a JS
 * inference dependency while preserving the exact runtime contract.
 * @private
 */
interface StarFieldLike {
  show: boolean;
  readonly _intensity: number;
  readonly _pointAngularSize: number;
  readonly _minPointSize: number;
  _webgpuCache?: StarFieldWebGPUCache;
  // Present on every class instance at runtime; declared so the primitive
  // structurally satisfies `WebGPUCommandOwner` when passed as a draw
  // command `owner` (the SceneRenderer reads `owner.constructor.name`).
  readonly constructor?: { readonly name?: string };
}

/**
 * A cached pipeline + its in-flight resolution state. The descriptor is
 * built once; `pipeline` is filled when the central pipeline cache
 * resolves it (sync hit or async settle). Mirrors the
 * `compositePipelineEntry` shape in WebGPUVolumetricFogRenderer.
 * @private
 */
interface StarPipelineEntry {
  descriptor: WebGPURenderPipelineDescriptor;
  pipeline: GPURenderPipeline | null;
  pending: boolean;
}

/**
 * Per-StarField WebGPU resource cache, attached to `starField._webgpuCache`.
 * All slots are lazily created on the first `updateWebGPUStarField` call.
 * @private
 */
interface StarFieldWebGPUCache {
  instanceBuffer?: WebGPUBuffer;
  starCount?: number;
  pipelineEntry?: StarPipelineEntry;
  pipeline?: GPURenderPipeline;
  bindGroupLayout?: GPUBindGroupLayout;
  _pipelineFormatGeneration?: number;
  uniformBuffer?: WebGPUBuffer;
  uniformData?: Float32Array;
  bindGroup?: GPUBindGroup;
  command?: WebGPUDrawCommand;
  injectCommand?: WebGPUDrawCommand;
}

/**
 * The WebGPU-context fields this renderer reads. The scene-FB format and
 * its invalidation generation are WebGPU-only and not present on the
 * ambient `CesiumGraphicsContext`; narrow to them here at the boundary.
 * @private
 */
interface StarFieldContext {
  readonly device?: GPUDevice | null;
  readonly uniformState: CesiumUniformState;
  readonly scenePipelineFormat?: GPUTextureFormat;
  readonly depthFormat?: GPUTextureFormat;
  readonly _msaaSamples?: number;
  readonly _scenePipelineFormatGeneration?: number;
  readonly webgpuPipelineCache?: WebGPURenderPipelineCache | null;
}

// Per-device shader-module cache so two starfields on the same GPUDevice
// share one compiled module. (Pattern: WebGPUEnvironmentRenderer.)
const _starShaderModuleCaches = new WeakMap<
  GPUDevice,
  WebGPUShaderModuleCache
>();
function getStarShaderModuleCache(device: GPUDevice): WebGPUShaderModuleCache {
  let cache = _starShaderModuleCaches.get(device);
  if (!cache) {
    cache = new WebGPUShaderModuleCache(device);
    _starShaderModuleCaches.set(device, cache);
  }
  return cache;
}

// Per-instance vertex layout (floats):
//   directionFixed (3) + intensity (1) + color (3) + sizeBoost (1) = 8
const FLOATS_PER_STAR = 8;
const STAR_VERTEX_STRIDE = FLOATS_PER_STAR * 4; // 32 bytes
// Uniform buffer: mat4 (16) + pointSize.xy (2) + intensityScale (1) +
// minPointSize (1) = 20 floats → pad to 256 for alignment.
const STAR_UNIFORM_BUFFER_SIZE = 256;

const scratchTemeToFixed3 = new Matrix3();
const scratchTemeToFixed4 = new Matrix4();
const scratchVPNoTranslation = new Matrix4();
const scratchStarDir = new Cartesian3();

/**
 * Convert a B−V color index to an approximate RGB color via a blackbody
 * temperature fit. Hot blue stars (B−V < 0) skew toward 0.6–0.8 in red
 * and ~1.0 in blue; cool red stars (B−V > 1.4) skew toward ~1.0 red and
 * low blue. Returns a normalized-ish RGB (brightest channel ≈ 1.0) so the
 * per-star Pogson intensity controls absolute brightness, not the hue.
 *
 * Ballesteros (2012): T ≈ 4600 K · (1/(0.92·BV + 1.7) + 1/(0.92·BV + 0.62)).
 * The Planckian-locus RGB below is a compact piecewise fit good enough
 * for a visual starfield (not colorimetric accuracy).
 *
 * @param {number} bv B−V color index.
 * @returns {number[]} [r, g, b] in [0, 1].
 * @private
 */
function bvToRgb(bv: number): [number, number, number] {
  const denomA = 0.92 * bv + 1.7;
  const denomB = 0.92 * bv + 0.62;
  // Guard against the (rare for real stars) pole near bv ≈ -1.8 / -0.67.
  const t =
    4600.0 *
    (1.0 / (Math.abs(denomA) < 1e-3 ? 1e-3 : denomA) +
      1.0 / (Math.abs(denomB) < 1e-3 ? 1e-3 : denomB));
  // Clamp to a sane stellar temperature window.
  const temp = Math.min(40000.0, Math.max(1500.0, t)) / 100.0;

  let r;
  let g;
  let b;
  // Tanner Helland's blackbody fit (public-domain algorithm), normalized.
  if (temp <= 66.0) {
    r = 255.0;
    g = 99.4708025861 * Math.log(temp) - 161.1195681661;
  } else {
    r = 329.698727446 * Math.pow(temp - 60.0, -0.1332047592);
    g = 288.1221695283 * Math.pow(temp - 60.0, -0.0755148492);
  }
  if (temp >= 66.0) {
    b = 255.0;
  } else if (temp <= 19.0) {
    b = 0.0;
  } else {
    b = 138.5177312231 * Math.log(temp - 10.0) - 305.0447927307;
  }
  r = Math.min(255.0, Math.max(0.0, r)) / 255.0;
  g = Math.min(255.0, Math.max(0.0, g)) / 255.0;
  b = Math.min(255.0, Math.max(0.0, b)) / 255.0;
  // Renormalize so the brightest channel is 1.0 — keeps absolute
  // brightness in the Pogson intensity, not the color.
  const peak = Math.max(r, g, b, 1e-3);
  return [r / peak, g / peak, b / peak];
}

/**
 * Build the static per-instance star buffer from the catalog. Each star's
 * J2000 RA/Dec becomes a TEME-frame unit direction; magnitude becomes a
 * Pogson intensity; B−V becomes a blackbody RGB. The TEME→fixed rotation
 * is applied per frame in the uniform pack (NOT baked here), so the same
 * buffer is correct for every scene time.
 *
 * @private
 */
function buildStarInstanceData(): Float32Array {
  const cat = BrightStarCatalog.data;
  const stride = BrightStarCatalog.STRIDE;
  const count = BrightStarCatalog.count;
  const out = new Float32Array(count * FLOATS_PER_STAR);

  // Per-star brightness from visual magnitude (Pogson scale). The raw
  // flux ratio across the catalog (mag −1.46 … +4.4) spans ~240×, far too
  // wide to map linearly onto a display — the faintest stars would vanish
  // below 1/255 while Sirius alone fills the frame. We therefore:
  //   1) compute the true Pogson flux relative to the faint limit, then
  //   2) gamma-compress it (exponent < 1) so the faint end lifts into
  //      visibility, then
  //   3) remap into a [LO, HI] band where LO keeps the faintest star a
  //      dim-but-real point and HI lets the brightest stars overflow 1.0
  //      (HDR) so the additive scene-FB target feeds them into bloom.
  // This preserves the PERCEPTUAL ordering (brighter magnitude ⇒ brighter
  // pixel ⇒ larger bloomed disc) while keeping the whole catalog visible.
  const faintLimitMag = 4.6;
  const brightestFlux = Math.pow(10.0, -0.4 * (-1.46 - faintLimitMag));
  const FLUX_GAMMA = 0.38; // < 1 lifts the faint tail
  const LO = 0.55; // faintest star brightness (clearly visible point)
  const HI = 6.0; // brightest star brightness (overflows → bloom)

  for (let i = 0; i < count; i++) {
    const base = i * stride;
    const raDeg = cat[base + 0];
    const decDeg = cat[base + 1];
    const vmag = cat[base + 2];
    const bv = cat[base + 3];

    const ra = CesiumMath.toRadians(raDeg);
    const dec = CesiumMath.toRadians(decDeg);
    // RA/Dec → equatorial-inertial unit vector (TEME axes: x toward
    // vernal equinox, z toward north celestial pole).
    const cosDec = Math.cos(dec);
    const dx = cosDec * Math.cos(ra);
    const dy = cosDec * Math.sin(ra);
    const dz = Math.sin(dec);

    // Pogson flux relative to the faint limit, in [~0, 1].
    const rawFlux = Math.pow(10.0, -0.4 * (vmag - faintLimitMag));
    const norm = Math.min(1.0, rawFlux / brightestFlux);
    const compressed = Math.pow(norm, FLUX_GAMMA);
    const flux = LO + compressed * (HI - LO);

    const rgb = bvToRgb(bv);

    // sizeBoost: brighter stars (lower magnitude) get a larger disc.
    // Map mag −1.5 → ~1.7 boost, mag 4 → ~0 boost.
    const sizeBoost = Math.max(0.0, (4.0 - vmag) * 0.42);

    const o = i * FLOATS_PER_STAR;
    out[o + 0] = dx;
    out[o + 1] = dy;
    out[o + 2] = dz;
    out[o + 3] = flux;
    out[o + 4] = rgb[0];
    out[o + 5] = rgb[1];
    out[o + 6] = rgb[2];
    out[o + 7] = sizeBoost;
  }
  return out;
}

/**
 * Pack the per-frame uniform buffer: a translation-free view-projection
 * that incorporates the TEME→fixed rotation, point sizing, and the
 * daytime fade.
 *
 * Star directions in the instance buffer are TEME/inertial. We bake the
 * TEME→fixed rotation into the matrix here so the shader can apply
 * one transform: viewProjection(noTranslation) · temeToFixed · dir.
 *
 * @private
 */
function packStarUniforms(
  uniformData: Float32Array,
  frameState: CesiumFrameState,
  starField: StarFieldLike,
): void {
  const uniformState = frameState.context.uniformState;

  // TEME → fixed rotation for the current scene time.
  // `frameState.time` is the ambient opaque JulianDate; bridge to the real
  // Core `JulianDate` type that `Transforms` consumes. The ambient boundary
  // type (cesium-js-types.d.ts) deliberately keeps it opaque so that file
  // stays free of Core imports — the cast is the documented seam.
  const date = frameState.time as unknown as JulianDate | undefined;
  let temeToFixed4;
  if (defined(date)) {
    Transforms.computeTemeToPseudoFixedMatrix(date, scratchTemeToFixed3);
    temeToFixed4 = Matrix4.fromRotation(
      scratchTemeToFixed3,
      scratchTemeToFixed4,
    );
  } else {
    temeToFixed4 = Matrix4.clone(Matrix4.IDENTITY, scratchTemeToFixed4);
  }

  // View with translation zeroed (stars are directional — at infinity).
  Matrix4.clone(uniformState.view, scratchVPNoTranslation);
  scratchVPNoTranslation[12] = 0.0;
  scratchVPNoTranslation[13] = 0.0;
  scratchVPNoTranslation[14] = 0.0;
  // projection · viewNoTranslation
  Matrix4.multiply(
    uniformState.projection,
    scratchVPNoTranslation,
    scratchVPNoTranslation,
  );
  // · temeToFixed  →  full directional transform for an inertial star dir.
  Matrix4.multiply(
    scratchVPNoTranslation,
    temeToFixed4,
    scratchVPNoTranslation,
  );
  Matrix4.pack(scratchVPNoTranslation, uniformData, 0);

  // Aspect-corrected point half-size in NDC. Use the projection focal
  // terms (proj[0] horizontal, proj[5] vertical) so a fixed angular
  // radius renders as a round sprite on any viewport aspect.
  const proj = uniformState.projection;
  const angularRadius = starField._pointAngularSize; // radians
  uniformData[16] = angularRadius * Math.abs(proj[0]);
  uniformData[17] = angularRadius * Math.abs(proj[5]);

  // Daytime fade: dim the stars as the sun climbs above the horizon for a
  // surface-level camera. At altitude the sky is always black so the fade
  // is gated by camera height. Approximate the local-up as
  // normalize(cameraECEF); dot with the sun direction is the solar
  // altitude sine.
  let dayFade = 1.0;
  const sunDir = uniformState.sunDirectionWC;
  const camPos = frameState.camera?.positionWC;
  if (defined(sunDir) && defined(camPos)) {
    const camLen = Cartesian3.magnitude(camPos);
    if (camLen > 1.0) {
      Cartesian3.normalize(camPos, scratchStarDir);
      const solarAltSin = Cartesian3.dot(sunDir, scratchStarDir);
      // Full brightness when sun is > ~6° below horizon (astronomical
      // twilight-ish), fully faded when sun is > ~3° above horizon.
      // smoothstep over sin(altitude): [-0.10, +0.05].
      const t = CesiumMath.clamp(
        (solarAltSin - -0.1) / (0.05 - -0.1),
        0.0,
        1.0,
      );
      dayFade = 1.0 - t;
      // Above ~100 km the atmosphere no longer scatters enough sunlight to
      // wash out stars — keep them visible regardless of solar altitude.
      // camLen is distance from Earth's center; subtract a mean Earth
      // radius for a crude altitude (good enough to gate the fade).
      const altitude = camLen - 6371000.0;
      if (altitude > 100000.0) {
        dayFade = 1.0;
      }
    }
  }

  uniformData[18] = starField._intensity * dayFade;
  // Minimum NDC half-extent so faint stars stay ≥ ~1 px on a 1080p frame.
  uniformData[19] = starField._minPointSize;
}

/**
 * Convert our cache-friendly descriptor into the WebGPU descriptor shape
 * for the no-central-cache fallback path.
 * @private
 */
function _starDescriptorToGPU(
  d: WebGPURenderPipelineDescriptor,
): GPURenderPipelineDescriptor {
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
 * Resolve the starfield pipeline through the central pipeline cache.
 * Returns the pipeline if available, otherwise kicks off async creation
 * and returns null. Falls back to synchronous creation when no cache.
 * (Pattern: tryResolveEnvPipeline.)
 * @private
 */
function tryResolveStarPipeline(
  device: GPUDevice,
  pipelineCache: WebGPURenderPipelineCache | null,
  entry: StarPipelineEntry,
): GPURenderPipeline | null {
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
    _starDescriptorToGPU(entry.descriptor),
  );
  entry.pending = false;
  return entry.pipeline;
}

/**
 * Updates the WebGPU starfield: builds GPU resources once, repacks the
 * per-frame uniform, and pushes one instanced draw command onto the
 * command list (Pass.ENVIRONMENT). Mirrors the Sun renderer's command
 * convention so the SceneRenderer bins it into the ENVIRONMENT pass.
 *
 * @param {StarField} starField The backend-agnostic starfield primitive.
 * @param {FrameState} frameState
 * @param {Array} commandList The frame's command list to push onto.
 * @private
 */
function updateWebGPUStarField(
  starField: StarFieldLike,
  frameState: CesiumFrameState,
  commandList: CesiumAnyDrawCommand[],
): WebGPUDrawCommand | undefined {
  if (!starField.show) {
    return;
  }
  const context = frameState.context as unknown as StarFieldContext;
  const device = context.device;
  if (!defined(device)) {
    return;
  }

  if (!defined(starField._webgpuCache)) {
    starField._webgpuCache = {};
  }
  const cache = starField._webgpuCache;

  // ── One-time instance buffer (catalog is static) ──
  if (!defined(cache.instanceBuffer)) {
    const data = buildStarInstanceData();
    cache.instanceBuffer = WebGPUBuffer.createVertexBuffer(
      device,
      data,
      "StarField instances",
    );
    cache.starCount = BrightStarCatalog.count;
  }

  // ── Invalidate pipeline on scene-format change (HDR toggle / resize) ──
  const currentGen = context._scenePipelineFormatGeneration ?? 0;
  if (
    defined(cache.pipelineEntry) &&
    cache._pipelineFormatGeneration !== currentGen
  ) {
    cache.pipelineEntry = undefined;
    cache.pipeline = undefined;
  }

  if (!defined(cache.pipelineEntry)) {
    const moduleCache = getStarShaderModuleCache(device);
    const shaderModule = moduleCache.getOrCreate(
      ShaderSourceId.STAR_FIELD_CATALOG,
      StarFieldShaderCode,
      0,
      "StarField shader",
    );

    const bgl = makeBindGroupLayout(device, "StarField BGL", [
      uniformBuffer(0, Stage.VERTEX_FRAGMENT),
    ]);

    const format = context.scenePipelineFormat || "bgra8unorm";
    const depthFormat = context.depthFormat || "depth24plus-stencil8";
    const descriptor: WebGPURenderPipelineDescriptor = {
      name: `StarField pipeline [${format}/${depthFormat}]`,
      layout: device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
      vertex: {
        module: shaderModule,
        entryPoint: "vertexMain",
        buffers: [
          {
            // Per-instance star record.
            arrayStride: STAR_VERTEX_STRIDE,
            stepMode: "instance",
            attributes: [
              { shaderLocation: 0, offset: 0, format: "float32x3" }, // directionFixed
              { shaderLocation: 1, offset: 12, format: "float32" }, // intensity
              { shaderLocation: 2, offset: 16, format: "float32x3" }, // color
              { shaderLocation: 3, offset: 28, format: "float32" }, // sizeBoost
            ],
          },
        ],
      },
      fragment: {
        module: shaderModule,
        entryPoint: "fragmentMain",
        // Scene-FB target with premultiplied additive blend so bright
        // stars feed bloom. The FS already multiplies rgb by the radial
        // falloff (premultiplied), so srcFactor = "one" — using
        // "src-alpha" here would attenuate by the falloff TWICE, crushing
        // every star to a sub-threshold smudge.
        targets: makeSceneFBTargets(format, {
          blend: {
            color: {
              srcFactor: "one",
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
      multisample:
        (context._msaaSamples ?? 1) > 1
          ? { count: context._msaaSamples }
          : undefined,
    };
    cache.pipelineEntry = { descriptor, pipeline: null, pending: false };
    cache.bindGroupLayout = bgl;
    cache._pipelineFormatGeneration = currentGen;
  }

  const pipeline = tryResolveStarPipeline(
    device,
    context.webgpuPipelineCache ?? null,
    cache.pipelineEntry,
  );
  if (!pipeline) {
    return;
  }
  cache.pipeline = pipeline;

  // ── Uniform buffer ──
  if (!defined(cache.uniformBuffer)) {
    cache.uniformBuffer = WebGPUBuffer.createUniformBuffer(
      device,
      STAR_UNIFORM_BUFFER_SIZE,
      undefined,
      "StarField uniforms",
    );
    cache.uniformData = new Float32Array(STAR_UNIFORM_BUFFER_SIZE / 4);
  }
  packStarUniforms(cache.uniformData, frameState, starField);
  device.queue.writeBuffer(
    cache.uniformBuffer.buffer,
    0,
    cache.uniformData.buffer,
    0,
    STAR_UNIFORM_BUFFER_SIZE,
  );

  if (!defined(cache.bindGroup)) {
    cache.bindGroup = device.createBindGroup({
      label: "StarField bind group",
      layout: cache.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: cache.uniformBuffer.buffer } },
      ],
    });
  }

  // Two command instances sharing the same GPU resources:
  //   - `cache.command` is pushed onto the binned command list so a
  //     frustum is GUARANTEED to exist even on sky-only views (no globe /
  //     primitives) — same rationale as Sun. It draws EARLY in the
  //     ENVIRONMENT pass.
  //   - `cache.injectCommand` is RETURNED so the SceneRenderer can inject
  //     it AFTER the SkyBox cubemap command. The cubemap (when present) is
  //     an alpha-over draw injected after the binned ENVIRONMENT commands;
  //     an opaque/dark cubemap would otherwise overwrite the early binned
  //     starfield. The late injected copy lands the additive HDR stars ON
  //     TOP of the cubemap.
  //
  // Double-draw avoidance: the caller (Scene.updateEnvironment) only uses
  // the returned inject command when a `skyBoxCommand` actually exists. So:
  //   - cubemap present  → early binned draw is wiped by the cubemap, late
  //     injected draw shows  → net 1× stars on top of the cubemap.
  //   - no cubemap        → caller drops the inject command; only the early
  //     binned draw runs     → net 1× stars.
  // Either way the catalog is drawn exactly once.
  cache.command = new WebGPUDrawCommand({
    pipeline: cache.pipeline,
    bindGroups: [cache.bindGroup],
    vertexBuffers: [cache.instanceBuffer],
    vertexCount: 6,
    instanceCount: cache.starCount,
    pass: 0, // Pass.ENVIRONMENT
    owner: starField,
  });
  commandList.push(cache.command as unknown as CesiumAnyDrawCommand);

  cache.injectCommand = new WebGPUDrawCommand({
    pipeline: cache.pipeline,
    bindGroups: [cache.bindGroup],
    vertexBuffers: [cache.instanceBuffer],
    vertexCount: 6,
    instanceCount: cache.starCount,
    pass: 0, // Pass.ENVIRONMENT
    owner: starField,
  });
  return cache.injectCommand;
}

/**
 * A read-only diagnostic snapshot of a starfield's WebGPU cache.
 * @private
 */
interface StarFieldStatistics {
  backend: "webgpu";
  starCount: number;
  pipelineReady: boolean;
  bindGroupReady: boolean;
  mrtMode: boolean;
  mrtSlot1Format: GPUTextureFormat;
  intensityScale: number | null;
}

/**
 * Debug surface — returns a diagnostic snapshot of a starfield's WebGPU
 * cache. Pure read; safe from Scene.getDebugSnapshot().
 *
 * @param {StarField} starField
 * @returns {object|null}
 * @private
 */
function getWebGPUStarFieldStatistics(
  starField: StarFieldLike | undefined,
): StarFieldStatistics | null {
  if (!defined(starField) || !defined(starField._webgpuCache)) {
    return null;
  }
  const cache = starField._webgpuCache;
  return {
    backend: "webgpu",
    starCount: cache.starCount ?? 0,
    pipelineReady: defined(cache.pipeline),
    bindGroupReady: defined(cache.bindGroup),
    mrtMode: isSceneFBMrtMode(),
    mrtSlot1Format: MRT_NORMAL_ROUGHNESS_FORMAT,
    intensityScale:
      defined(cache.uniformData) && cache.uniformData.length > 18
        ? cache.uniformData[18]
        : null,
  };
}

/**
 * Releases the starfield's GPU resources.
 * @param {StarField} starField
 * @private
 */
function destroyWebGPUStarFieldResources(
  starField: StarFieldLike | undefined,
): void {
  const cache = starField && starField._webgpuCache;
  if (!defined(cache)) {
    return;
  }
  if (defined(cache.instanceBuffer)) {
    cache.instanceBuffer.destroy();
  }
  if (defined(cache.uniformBuffer)) {
    cache.uniformBuffer.destroy();
  }
  starField._webgpuCache = undefined;
}

export {
  updateWebGPUStarField,
  getWebGPUStarFieldStatistics,
  destroyWebGPUStarFieldResources,
  bvToRgb,
};

export default {
  updateWebGPUStarField,
  getWebGPUStarFieldStatistics,
  destroyWebGPUStarFieldResources,
  bvToRgb,
};
