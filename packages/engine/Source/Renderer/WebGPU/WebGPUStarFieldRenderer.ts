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
import defined from "../../Core/defined.js";
import Cartesian3 from "../../Core/Cartesian3.js";
import Matrix3 from "../../Core/Matrix3.js";
import Matrix4 from "../../Core/Matrix4.js";
import Transforms from "../../Core/Transforms.js";
import type JulianDate from "../../Core/JulianDate.js";
import BrightStarCatalog from "../../Scene/BrightStarCatalog.js";
import {
  FLOATS_PER_STAR,
  bvToRgb,
  buildStarInstanceData,
  computeStarDayFade,
} from "../../Scene/StarFieldMath.js";
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
  readonly _effectiveIntensityScale?: number;
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
// FLOATS_PER_STAR is imported from the backend-neutral StarFieldMath so
// the WebGL renderer packs the identical record.
const STAR_VERTEX_STRIDE = FLOATS_PER_STAR * 4; // 32 bytes
// Uniform buffer: mat4 (16) + pointSize.xy (2) + intensityScale (1) +
// minPointSize (1) = 20 floats → pad to 256 for alignment.
const STAR_UNIFORM_BUFFER_SIZE = 256;

const scratchTemeToFixed3 = new Matrix3();
const scratchTemeToFixed4 = new Matrix4();
const scratchVPNoTranslation = new Matrix4();
// C7-SUN-STARS-EXTINCTION scratch — camera up (Earth-fixed), the TEME→fixed
// transpose, and camera up rotated into the TEME instance frame.
const scratchTemeToFixedT = new Matrix3();
const scratchCamUpFixed = new Cartesian3();
const scratchCamUpTeme = new Cartesian3();

// `bvToRgb` + `buildStarInstanceData` (the B−V → blackbody RGB conversion
// and the Pogson magnitude → HDR-brightness per-instance packing) live in
// the backend-neutral `Scene/StarFieldMath` so the WebGL renderer builds
// the byte-identical per-instance record. Imported above; re-exported at
// the tail for backwards-compat with the prior WebGPU-local `bvToRgb`.

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
  effectiveIntensityScale: number,
): void {
  const uniformState = frameState.context.uniformState;

  // TEME → fixed rotation for the current scene time.
  // `frameState.time` is the ambient opaque JulianDate; bridge to the real
  // Core `JulianDate` type that `Transforms` consumes. The ambient boundary
  // type (cesium-js-types.d.ts) deliberately keeps it opaque so that file
  // stays free of Core imports — the cast is the documented seam.
  const date = frameState.time as unknown as JulianDate | undefined;
  const hasRotation = defined(date);
  let temeToFixed4;
  if (hasRotation) {
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

  // The backend-neutral StarField update owns the daytime-fade calculation so
  // WebGL and WebGPU consume the same exact scale and zero-work decision.
  uniformData[18] = effectiveIntensityScale;
  // Minimum NDC half-extent so faint stars stay ≥ ~1 px on a 1080p frame.
  uniformData[19] = starField._minPointSize;

  // C7-SUN-STARS-EXTINCTION — zenith transmittance (floats 20..22) + camera
  // local-up in the TEME instance frame (floats 24..26). Published by
  // StarField.update via the shared B629 integrator. (1,1,1) / no extinction
  // from orbit / atmosphere-hidden → the shader's pow(1, airmass) is a byte-
  // identical no-op.
  const zenithT = frameState.starZenithTransmittance;
  if (defined(zenithT)) {
    uniformData[20] = zenithT.x;
    uniformData[21] = zenithT.y;
    uniformData[22] = zenithT.z;
  } else {
    uniformData[20] = 1.0;
    uniformData[21] = 1.0;
    uniformData[22] = 1.0;
  }
  uniformData[23] = 0.0;

  // Camera local-up (Earth-fixed) rotated into the star instance (TEME)
  // frame: cameraUpTeme = temeToFixed^T · normalize(cameraPositionWC). Since
  // rotation preserves the dot product, dot(directionFixed_TEME, cameraUpTeme)
  // === sin(elevation) in the fixed frame — the exact quantity the WebGL path
  // computes as dot(temeToFixed·directionFixed, cameraUpFixed).
  const camPos = frameState.camera?.positionWC as Cartesian3 | undefined;
  const camLen = defined(camPos) ? Cartesian3.magnitude(camPos) : 0.0;
  if (camLen > 1.0) {
    Cartesian3.divideByScalar(camPos as Cartesian3, camLen, scratchCamUpFixed);
    if (hasRotation) {
      Matrix3.transpose(scratchTemeToFixed3, scratchTemeToFixedT);
      Matrix3.multiplyByVector(
        scratchTemeToFixedT,
        scratchCamUpFixed,
        scratchCamUpTeme,
      );
    } else {
      Cartesian3.clone(scratchCamUpFixed, scratchCamUpTeme);
    }
    uniformData[24] = scratchCamUpTeme.x;
    uniformData[25] = scratchCamUpTeme.y;
    uniformData[26] = scratchCamUpTeme.z;
  } else {
    uniformData[24] = 0.0;
    uniformData[25] = 0.0;
    uniformData[26] = 1.0;
  }
  uniformData[27] = 0.0;
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
 * Ensures the starfield's immutable GPU resources exist and its scene-format
 * pipeline is (asynchronously) resolving/resolved, WITHOUT packing any
 * per-frame uniform or emitting a draw. Shared by {@link updateWebGPUStarField}
 * (contributing frames) and {@link prepareWebGPUStarField} (the zero-
 * contribution warm-keep path). Returns the resolved pipeline, or `null` when
 * the async pipeline cache has not settled yet.
 *
 * Building these resources on a daylight (zero-contribution) frame is what lets
 * the first contributing dusk frame draw immediately instead of cold-starting
 * the instance buffer + async pipeline compile (the star pop-in symptom).
 *
 * @private
 */
function ensureStarFieldResources(
  starField: StarFieldLike,
  context: StarFieldContext,
  device: GPUDevice,
): GPURenderPipeline | null {
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
    return null;
  }
  cache.pipeline = pipeline;

  // ── Uniform buffer + bind group (per-frame data is written by update) ──
  if (!defined(cache.uniformBuffer)) {
    cache.uniformBuffer = WebGPUBuffer.createUniformBuffer(
      device,
      STAR_UNIFORM_BUFFER_SIZE,
      undefined,
      "StarField uniforms",
    );
    cache.uniformData = new Float32Array(STAR_UNIFORM_BUFFER_SIZE / 4);
  }

  if (!defined(cache.bindGroup)) {
    cache.bindGroup = device.createBindGroup({
      label: "StarField bind group",
      layout: cache.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: cache.uniformBuffer.buffer } },
      ],
    });
  }

  return pipeline;
}

/**
 * Warm-keeps the WebGPU starfield on a zero-contribution (daylight) frame:
 * builds the immutable instance buffer + uniform/bind-group resources and
 * kicks the async pipeline compile, but writes no per-frame uniform and emits
 * no draw. This is the {@link FeatureRendererKey.STAR_FIELD} `prepare` entry
 * point; {@link StarField#update} calls it on the zero-intensity path so the
 * first contributing dusk frame never cold-starts (no star pop-in). Idempotent
 * and byte-neutral to the rendered frame.
 *
 * @param {StarField} starField The backend-agnostic starfield primitive.
 * @param {FrameState} frameState
 * @private
 */
function prepareWebGPUStarField(
  starField: StarFieldLike,
  frameState: CesiumFrameState,
): void {
  if (!starField.show) {
    return;
  }
  const context = frameState.context as unknown as StarFieldContext;
  const device = context.device;
  if (!defined(device)) {
    return;
  }
  ensureStarFieldResources(starField, context, device);
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

  const effectiveIntensityScale = defined(starField._effectiveIntensityScale)
    ? starField._effectiveIntensityScale
    : starField._intensity *
      computeStarDayFade(
        context.uniformState.sunDirectionWC,
        frameState.camera?.positionWC,
      );
  if (effectiveIntensityScale === 0.0) {
    return;
  }

  const pipeline = ensureStarFieldResources(starField, context, device);
  if (!pipeline) {
    return;
  }
  const cache = starField._webgpuCache as StarFieldWebGPUCache;

  packStarUniforms(
    cache.uniformData,
    frameState,
    starField,
    effectiveIntensityScale,
  );
  device.queue.writeBuffer(
    cache.uniformBuffer.buffer,
    0,
    cache.uniformData.buffer,
    0,
    STAR_UNIFORM_BUFFER_SIZE,
  );

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
  prepareWebGPUStarField,
  getWebGPUStarFieldStatistics,
  destroyWebGPUStarFieldResources,
  bvToRgb,
};

export default {
  updateWebGPUStarField,
  prepareWebGPUStarField,
  getWebGPUStarFieldStatistics,
  destroyWebGPUStarFieldResources,
  bvToRgb,
};
