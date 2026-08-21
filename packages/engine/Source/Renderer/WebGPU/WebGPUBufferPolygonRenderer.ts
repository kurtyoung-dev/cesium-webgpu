/**
 * WebGPU Buffer Polygon Renderer
 *
 * Per-collection renderer used by `WebGPUBufferPrimitiveRenderer`.
 *
 * Owns the BufferPolygonCollection rendering path: cache type,
 * pipeline builder, init / repack / upload / update / destroy
 * functions. Shared infrastructure (camera UBO packing, shader
 * preprocessing, bind-group-layout helper, shared scratch objects,
 * cache-base + buffer-creation helpers, `destroyPickIds`) is imported
 * from the parent module.
 *
 * The two public-API symbols (`updateWebGPUBufferPolygonCollection`,
 * `destroyWebGPUBufferPolygonCollection`) are re-exported from the
 * parent module so external callers (`WebGPUFeatureRenderers.ts`)
 * keep their existing import path.
 *
 * @module WebGPUBufferPolygonRenderer
 */

import Cartesian3 from "../../Core/Cartesian3.js";
import Color from "../../Core/Color.js";
import EncodedCartesian3 from "../../Core/EncodedCartesian3.js";
import Matrix4 from "../../Core/Matrix4.js";
import AttributeCompression from "../../Core/AttributeCompression.js";
import IndexDatatype from "../../Core/IndexDatatype.js";
import SceneMode from "../../Scene/SceneMode.js";
import Pass from "../Pass.js";
import WebGPUDrawCommand from "./WebGPUDrawCommand.js";
import { gpuData, jsModule, numericArray } from "./webgpuTypeHelpers.js";
import BufferPolygon from "../../Scene/BufferPolygon.js";
import BufferPolygonMaterial from "../../Scene/BufferPolygonMaterial.js";
import BufferPolygonMaterialWGSL from "../../Shaders/WebGPU/Collections/BufferPolygonMaterial.js";
// Color pipelines use scene-framebuffer targets; the
// separate pick pass stays single-target.
import { makeSceneFBTargets } from "./WebGPUSceneFBTargetHelpers.js";

import {
  packCameraUniforms,
  preprocessShader,
  preprocessPickShader,
  BUFFER_PICK_MODULE_KEYSALT,
  makeCameraBindGroupLayout,
  createSharedCacheBase,
  createVB,
  createIB,
  destroyPickIds,
  getBufferPrimitiveShaderCache,
  projectBufferPositionForMode,
  bufferModeNeedsRepack,
  computeBufferModeBoundingVolume,
  bufferPositionNormalizeDivisor,
  normalizeBufferPositionInPlace,
  scratchColor,
  scratchCart,
  scratchEnc,
} from "./WebGPUBufferPrimitiveRenderer.js";
import { ShaderSourceId, ShaderDefine } from "./WebGPUShaderDefines.js";
import {
  isWebGPULogDepthActive,
  isWebGPUPickLogDepthActive,
} from "./WebGPULogDepth.js";
import { computeNoDepthTest } from "./WebGPUCollectionRendererBase.js";
import BlendOption from "../../Scene/BlendOption.js";
import type {
  BufferPrimitiveCollection,
  CesiumPickIdRef,
  SharedCache,
  IndexDatatypeStatics,
} from "./WebGPUBufferPrimitiveRenderer.js";

// ─── Polygon-specific scratch ────────────────────────────────────────────────
const scratchPolygon = new BufferPolygon();
const scratchPolygonMat = new BufferPolygonMaterial();

// ─── PolygonCache type ───────────────────────────────────────────────────────
export interface PolygonCache extends SharedCache {
  positionHigh: GPUBuffer;
  positionLow: GPUBuffer;
  pickColor: GPUBuffer;
  showAndColor: GPUBuffer;
  indexBuffer: GPUBuffer;
  positionHighArr: Float32Array;
  positionLowArr: Float32Array;
  pickColorArr: Uint8Array;
  showAndColorArr: Float32Array;
  indexArr: Uint16Array | Uint32Array;
  indexFormat: GPUIndexFormat;
  vertexCountMax: number;
  triangleCountMax: number;
  pipeline: GPURenderPipeline;
  pickPipeline: GPURenderPipeline;
  // OPAQUE blend variant of the color pipeline (blend off, depth write on).
  // Built lazily on first use when collection._blendOption === OPAQUE; the
  // TRANSLUCENT `pipeline` stays the default. Mirrors the WebGL
  // RenderState.fromCache({ blending: DISABLED }) branch.
  opaquePipeline?: GPURenderPipeline;
  // Settled 2D/CV uses coplanar-depth variants (depth test
  // "always", no depth write). Built lazily on first non-3D settled frame;
  // the TRANSLUCENT + OPAQUE 3D pipelines above stay byte-identical.
  noDepthTestPipeline?: GPURenderPipeline;
  noDepthTestOpaquePipeline?: GPURenderPipeline;
  // noDepthTest the cached color `command` was built for; rebuild on change.
  commandNoDepthTest?: boolean;
  // Retained build inputs let the `OPAQUE` color variant reuse the shader
  // module and bind-group layouts from the default `TRANSLUCENT` pipeline
  // without recompilation or layout drift.
  shaderModule: GPUShaderModule;
  bgls: GPUBindGroupLayout[];
  sampleCount: number;
  format: GPUTextureFormat;
  bindGroup: GPUBindGroup;
  command: WebGPUDrawCommand | null;
  pickCommand: WebGPUDrawCommand | null;
  pickIds: CesiumPickIdRef[];
  // Blend option the cached color `command` was built for. When the live
  // collection._blendOption differs, the command is rebuilt so the pass +
  // pipeline track the latest setting.
  commandBlendOption?: number;
}

// ─── Pipeline builder ────────────────────────────────────────────────────────
function buildPolygonPipeline(
  device: GPUDevice,
  shaderModule: GPUShaderModule,
  format: GPUTextureFormat,
  bgls: GPUBindGroupLayout[],
  fragmentEntryPoint: string = "fragmentMain",
  sampleCount: number = 1,
  // When true, build the opaque color variant with blending disabled and depth
  // writes enabled, matching WebGL's disabled blending and enabled depth test.
  opaque: boolean = false,
  // Settled 2D and Columbus View use a coplanar variant with an always depth
  // comparison and no depth writes so the flat-map
  // reprojected fill draws on top instead of z-fighting the coplanar map.
  noDepthTest: boolean = false,
  // The pick-log switch only selects the diagnostic label here; the pick shader
  // module supplies logarithmic fragment depth. Color pipelines ignore it.
  pickLogActive: boolean = false,
): GPURenderPipeline {
  // Pick entry points emit opaque pick IDs and must not alpha-blend
  // (blending pick IDs produces invalid intermediate values that map to
  // wrong entity IDs at readback). Everything else is a color pipeline
  // that needs standard src-alpha / one-minus-src-alpha blending so a
  // polygon with a `color.alpha < 1` actually composites against the
  // frame instead of overwriting it.
  const isPick = fragmentEntryPoint === "fragmentPickMain";
  // Picking uses its separate single-target framebuffer; color targets match
  // the scene framebuffer's attachment topology. The pick variant uses the
  // context's byte-object-ID format, while color uses `scenePipelineFormat`,
  // so both pipelines match their render-pass attachments in HDR scenes.
  const colorBlend: GPUBlendState = {
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
  };
  // The opaque color variant overwrites. Picking is always opaque
  // (discrete IDs). TRANSLUCENT color path keeps `colorBlend`.
  const colorTargetOpts = opaque ? {} : { blend: colorBlend };
  const targets: Array<GPUColorTargetState | null> = isPick
    ? [{ format }]
    : makeSceneFBTargets(format, colorTargetOpts);
  // The color path draws into the MSAA scene framebuffer, so its pipeline
  // sample count must match `context._msaaSamples` (4 when MSAA is on) or
  // the render pass rejects it with an attachment-state mismatch. The pick
  // path renders into the single-sample pick FB, so it stays at count 1 —
  // mirroring GroundPrimitive's pick variant (no `multisample`).
  const multisample =
    !isPick && sampleCount > 1 ? { count: sampleCount } : undefined;
  return device.createRenderPipeline({
    label: `BufferPolygon pipeline (${fragmentEntryPoint}, ms=${
      multisample?.count ?? 1
    })${isPick && pickLogActive ? " [ld]" : ""}`,
    layout: device.createPipelineLayout({ bindGroupLayouts: bgls }),
    multisample,
    vertex: {
      module: shaderModule,
      entryPoint: "vertexMain",
      buffers: [
        {
          arrayStride: 12,
          attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }],
        },
        {
          arrayStride: 12,
          attributes: [{ shaderLocation: 1, offset: 0, format: "float32x3" }],
        },
        {
          arrayStride: 4,
          attributes: [{ shaderLocation: 2, offset: 0, format: "unorm8x4" }],
        },
        // showAndColor: vec3 [show, encodedRGB8, color.alpha]. Widened from
        // vec2 (stride 8 / float32x2) to vec3 (stride 12 / float32x3) so the
        // GPU layout stays in lockstep with the CPU showAndColorArr width-3
        // pack and the WGSL `showAndColor : vec3<f32>` field.
        {
          arrayStride: 12,
          attributes: [{ shaderLocation: 3, offset: 0, format: "float32x3" }],
        },
      ],
    },
    fragment: {
      module: shaderModule,
      entryPoint: fragmentEntryPoint,
      targets,
    },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: {
      format: "depth24plus-stencil8",
      // Pick path always writes depth so per-pixel pick IDs are
      // deterministic. OPAQUE color path writes depth too (correct
      // occlusion + sort vs WebGL's `depthTest.enabled` with blend off).
      // TRANSLUCENT color path keeps depth write off when blending
      // fragments — matches the WebGL convention and prevents alpha-blended
      // polygons from occluding geometry behind them.
      // The coplanar 2D/CV variant never writes depth.
      depthWriteEnabled: !noDepthTest && (isPick || opaque),
      // less-equal (not less) — lets primitives that project exactly
      // onto the far plane due to FP32 rounding still pass the depth
      // test. Safe at planetary scale where the Z range is huge and
      // precision collapses near z=1. In settled 2D/CV the coplanar fill
      // uses "always" so it draws over the flat map without z-fighting.
      depthCompare: noDepthTest ? "always" : "less-equal",
    },
  });
}

// ─── BufferPolygonCollection ─────────────────────────────────────────────────

function initPolygonCache(
  collection: BufferPrimitiveCollection,
  context: CesiumGraphicsContext,
  format: GPUTextureFormat,
  defines: number,
  // Pick-log depth is controlled independently of the color shader defines.
  pickLogActive: boolean,
): PolygonCache {
  const device: GPUDevice = context.device;
  const vertexCountMax: number = collection.vertexCountMax;
  const triangleCountMax: number = collection.triangleCountMax;

  const positionHighArr = new Float32Array(vertexCountMax * 3);
  const positionLowArr = new Float32Array(vertexCountMax * 3);
  const pickColorArr = new Uint8Array(vertexCountMax * 4);
  // width 3 per vertex: [show, encodedRGB8(color), color.alpha]. Lockstep
  // with the float32x3 / arrayStride-12 attribute at shaderLocation 3.
  const showAndColorArr = new Float32Array(vertexCountMax * 3);
  const indexArr = jsModule<IndexDatatypeStatics>(
    IndexDatatype,
  ).createTypedArray(vertexCountMax, triangleCountMax * 3);
  const indexFormat: GPUIndexFormat =
    indexArr instanceof Uint32Array ? "uint32" : "uint16";

  // Resolve the log-depth pragma against `defines` and include the result in
  // the module-cache key so enabled and disabled variants stay distinct.
  const shaderSource = preprocessShader(
    context,
    "BufferPolygonMaterial",
    BufferPolygonMaterialWGSL,
    defines,
  );
  const shaderModule = getBufferPrimitiveShaderCache(device).getOrCreate(
    ShaderSourceId.BUFFER_POLYGON_MATERIAL,
    shaderSource,
    defines,
    "BufferPolygonMaterial",
  );
  // The pick fleet has an independent log-depth switch. Its enabled variant
  // preprocesses both the source and pick suffix so `v_logDepth` is available
  // to the fragment shader. The key salt prevents it from aliasing a color
  // module with the same source identifier and define bits.
  const pickDefines =
    (defines & ~ShaderDefine.LOG_DEPTH) |
    (pickLogActive ? ShaderDefine.LOG_DEPTH : 0);
  const pickModule = pickLogActive
    ? getBufferPrimitiveShaderCache(device).getOrCreate(
        ShaderSourceId.BUFFER_POLYGON_MATERIAL,
        preprocessPickShader(
          context,
          "BufferPolygonMaterial",
          BufferPolygonMaterialWGSL,
          pickDefines,
        ),
        pickDefines,
        "BufferPolygonMaterial [ld pick]",
        BUFFER_PICK_MODULE_KEYSALT,
      )
    : shaderModule;

  const bgls = makeCameraBindGroupLayout(device, false);
  const sampleCount = context._msaaSamples ?? 1;
  const pipeline = buildPolygonPipeline(
    device,
    shaderModule,
    format,
    bgls,
    "fragmentMain",
    sampleCount,
  );
  // The pick pipeline targets the context's byte-object-ID format, matching
  // the pick framebuffer rather than a possibly floating-point scene format.
  // Its selected module supplies logarithmic fragment depth when enabled.
  const pickPipeline = buildPolygonPipeline(
    device,
    pickModule,
    context.pickPipelineFormat ?? "rgba8unorm",
    bgls,
    "fragmentPickMain",
    1,
    false,
    false,
    pickLogActive,
  );

  const base = createSharedCacheBase(device);
  const cache: PolygonCache = {
    ...base,
    positionHigh: createVB(device, positionHighArr.byteLength, "polyHigh"),
    positionLow: createVB(device, positionLowArr.byteLength, "polyLow"),
    pickColor: createVB(device, pickColorArr.byteLength, "polyPick"),
    showAndColor: createVB(device, showAndColorArr.byteLength, "polyShow"),
    indexBuffer: createIB(device, indexArr.byteLength, "polyIdx"),
    positionHighArr,
    positionLowArr,
    pickColorArr,
    showAndColorArr,
    indexArr,
    indexFormat,
    vertexCountMax,
    triangleCountMax,
    pipeline,
    pickPipeline,
    shaderModule,
    bgls,
    sampleCount,
    format,
    bindGroup: device.createBindGroup({
      label: "BufferPolygon BG",
      layout: bgls[0],
      entries: [{ binding: 0, resource: { buffer: base.cameraUBO } }],
    }),
    command: null,
    pickCommand: null,
    pickIds: [],
  };
  return cache;
}

function repackPolygonDirty(
  collection: BufferPrimitiveCollection,
  cache: PolygonCache,
  context: CesiumGraphicsContext,
  frameState: CesiumFrameState,
  // `force` reprocesses every polygon in the dirty range when the scene-mode
  // projection frame changed with no per-primitive edits.
  force: boolean,
): void {
  const dirtyOffset: number = collection._dirtyOffset;
  const dirtyCount: number = collection._dirtyCount;
  if (dirtyCount === 0) {
    return;
  }
  const allowPicking: boolean = collection._allowPicking;
  // Reproject each ECEF vertex into the scene-mode frame in 2D, Columbus View,
  // and morphing while preserving triangulation. Scene 3D keeps raw ECEF.
  const reproject = frameState.mode !== SceneMode.SCENE3D;
  const modelMatrix = collection.modelMatrix ?? Matrix4.IDENTITY;
  // This divisor is zero unless the collection stores
  // normalized integer positions.
  const normDivisor = bufferPositionNormalizeDivisor(collection);
  for (let i = dirtyOffset; i < dirtyOffset + dirtyCount; i++) {
    collection.get(i, scratchPolygon);
    if (!scratchPolygon._dirty && !force) {
      continue;
    }

    if (allowPicking && scratchPolygon._pickId === 0) {
      const pickId = context.createPickId(
        {
          collection,
          index: i,
          get primitive() {
            return collection.get(i, new BufferPolygon());
          },
        },
        "buffer-primitive",
      );
      scratchPolygon._pickId = pickId.key;
      cache.pickIds.push(pickId);
    }

    let tOffset = scratchPolygon.triangleOffset;
    let vOffset = scratchPolygon.vertexOffset;
    const triangles = scratchPolygon.getTriangles();
    for (let j = 0, jl = scratchPolygon.triangleCount; j < jl; j++) {
      cache.indexArr[tOffset * 3] = vOffset + triangles[j * 3];
      cache.indexArr[tOffset * 3 + 1] = vOffset + triangles[j * 3 + 1];
      cache.indexArr[tOffset * 3 + 2] = vOffset + triangles[j * 3 + 2];
      tOffset++;
    }

    const positions = scratchPolygon.getPositions();
    scratchPolygon.getMaterial(scratchPolygonMat);
    const encodedColor = AttributeCompression.encodeRGB8(
      scratchPolygonMat.color,
    );
    // Material fill alpha [0,1]; widens the per-vertex show/color pack so
    // translucent polygon fills composite correctly (the shader discard at
    // alpha < 0.005 is now live). Mirrors WebGL's `showColorAlpha.z`.
    const colorAlpha = scratchPolygonMat.color.alpha;
    Color.fromRgba(scratchPolygon._pickId, scratchColor);
    const show = scratchPolygon.show;

    for (let j = 0, jl = scratchPolygon.vertexCount; j < jl; j++) {
      Cartesian3.fromArray(numericArray(positions), j * 3, scratchCart);
      if (normDivisor !== 0) {
        normalizeBufferPositionInPlace(scratchCart, normDivisor);
      }
      if (reproject) {
        projectBufferPositionForMode(
          scratchCart,
          frameState,
          modelMatrix,
          scratchCart,
        );
      }
      EncodedCartesian3.fromCartesian(scratchCart, scratchEnc);
      const v3 = vOffset * 3;
      const v4 = vOffset * 4;
      const vsc = vOffset * 3; // showAndColor stride is 3 floats per vertex
      cache.positionHighArr[v3] = scratchEnc.high.x;
      cache.positionHighArr[v3 + 1] = scratchEnc.high.y;
      cache.positionHighArr[v3 + 2] = scratchEnc.high.z;
      cache.positionLowArr[v3] = scratchEnc.low.x;
      cache.positionLowArr[v3 + 1] = scratchEnc.low.y;
      cache.positionLowArr[v3 + 2] = scratchEnc.low.z;
      cache.pickColorArr[v4] = Color.floatToByte(scratchColor.red);
      cache.pickColorArr[v4 + 1] = Color.floatToByte(scratchColor.green);
      cache.pickColorArr[v4 + 2] = Color.floatToByte(scratchColor.blue);
      cache.pickColorArr[v4 + 3] = Color.floatToByte(scratchColor.alpha);
      cache.showAndColorArr[vsc] = show ? 1 : 0;
      cache.showAndColorArr[vsc + 1] = encodedColor;
      cache.showAndColorArr[vsc + 2] = colorAlpha;
      vOffset++;
    }

    scratchPolygon._dirty = false;
  }
}

function uploadPolygonBuffers(device: GPUDevice, cache: PolygonCache): void {
  device.queue.writeBuffer(
    cache.positionHigh,
    0,
    gpuData(cache.positionHighArr),
  );
  device.queue.writeBuffer(cache.positionLow, 0, gpuData(cache.positionLowArr));
  device.queue.writeBuffer(cache.pickColor, 0, gpuData(cache.pickColorArr));
  device.queue.writeBuffer(
    cache.showAndColor,
    0,
    gpuData(cache.showAndColorArr),
  );
  device.queue.writeBuffer(cache.indexBuffer, 0, gpuData(cache.indexArr));
}

export function updateWebGPUBufferPolygonCollection(
  collection: BufferPrimitiveCollection,
  frameState: CesiumFrameState,
): void {
  if (!collection.show) {
    return;
  }
  const context = frameState.context;
  const device: GPUDevice = context.device;
  // Buffer primitives draw into the scene framebuffer, whose format may differ
  // from the preferred canvas format.
  const format: GPUTextureFormat =
    (
      context as unknown as {
        scenePipelineFormat?: GPUTextureFormat;
      }
    ).scenePipelineFormat ??
    (navigator.gpu.getPreferredCanvasFormat() as GPUTextureFormat);

  // A scene log-depth state change invalidates the cache so the shader module
  // and pipeline rebuild together.
  const logDepthActive = isWebGPULogDepthActive(context, frameState);
  const defines = logDepthActive ? ShaderDefine.LOG_DEPTH : 0;
  // Track the independent pick-log switch alongside the scene format and
  // color-log state because a change requires a new pick module and pipeline.
  const pickLogActive = isWebGPUPickLogDepthActive(context, frameState);

  let cache = collection._webgpuCache as PolygonCache | undefined;
  // Invalidate pipelines when the scene format generation changes.
  const sceneGen =
    (context as unknown as { _scenePipelineFormatGeneration?: number })
      ._scenePipelineFormatGeneration ?? 0;
  if (
    cache &&
    ((cache as unknown as { _pipelineFormatGeneration?: number })
      ._pipelineFormatGeneration !== sceneGen ||
      (cache as unknown as { _logDepthEnabled?: boolean })._logDepthEnabled !==
        logDepthActive ||
      (cache as unknown as { _pickLogDepthEnabled?: boolean })
        ._pickLogDepthEnabled !== pickLogActive)
  ) {
    cache = undefined;
    collection._webgpuCache = undefined;
  }
  if (!cache) {
    cache = initPolygonCache(
      collection,
      context,
      format,
      defines,
      pickLogActive,
    );
    (
      cache as unknown as { _pipelineFormatGeneration?: number }
    )._pipelineFormatGeneration = sceneGen;
    (cache as unknown as { _logDepthEnabled?: boolean })._logDepthEnabled =
      logDepthActive;
    (
      cache as unknown as { _pickLogDepthEnabled?: boolean }
    )._pickLogDepthEnabled = pickLogActive;
    collection._webgpuCache = cache;
    // First-time: pack everything as dirty.
    collection._dirtyOffset = 0;
    collection._dirtyCount = collection.primitiveCount;
  }

  // Force a full repack when the scene-mode projection
  // frame changed (no-op in the SCENE3D steady state).
  const modeRepack = bufferModeNeedsRepack(cache, frameState);
  if (modeRepack) {
    collection._dirtyOffset = 0;
    collection._dirtyCount = collection.primitiveCount;
  }

  if (collection._dirtyCount > 0) {
    repackPolygonDirty(collection, cache, context, frameState, modeRepack);
    uploadPolygonBuffers(device, cache);
    cache.command = null;
    cache.pickCommand = null;
  }

  // Camera UBO
  packCameraUniforms(
    cache.cameraData,
    context.uniformState,
    collection.modelMatrix ?? Matrix4.IDENTITY,
  );
  device.queue.writeBuffer(cache.cameraUBO, 0, gpuData(cache.cameraData));

  const triangleCount: number = collection.triangleCount;
  if (triangleCount === 0) {
    collection._dirtyCount = 0;
    collection._dirtyOffset = 0;
    return;
  }

  const indexCount = triangleCount * 3;
  const vbs = [
    cache.positionHigh,
    cache.positionLow,
    cache.pickColor,
    cache.showAndColor,
  ];

  // The blend option selects opaque overwrite with depth writes or the default
  // translucent path, matching the WebGL render-state and pass branch.
  const isOpaque = collection._blendOption === BlendOption.OPAQUE;
  // In settled 2D and Columbus View, draw the coplanar reprojected fill on
  // top (no depth test/write) so it doesn't z-fight the flat map. False in 3D
  // and mid-morph retain the depth-tested pipeline.
  const noDepthTest = computeNoDepthTest(frameState);
  // Cull against a bounding volume in the same render frame as the packed
  // positions; Scene 3D retains the collection's reference volume.
  const modeBV = computeBufferModeBoundingVolume(collection, frameState, cache);

  if (frameState.passes.render) {
    // Rebuild the cached command when blendOption or the coplanar-depth flag
    // flips so the pass + pipeline track the live setting.
    if (
      cache.command &&
      (cache.commandBlendOption !== collection._blendOption ||
        cache.commandNoDepthTest !== noDepthTest)
    ) {
      cache.command = null;
    }
    if (!cache.command) {
      let colorPipeline;
      if (noDepthTest) {
        // Coplanar 2D/CV variant (built lazily per blend mode).
        if (isOpaque) {
          if (!cache.noDepthTestOpaquePipeline) {
            cache.noDepthTestOpaquePipeline = buildPolygonPipeline(
              device,
              cache.shaderModule,
              cache.format,
              cache.bgls,
              "fragmentMain",
              cache.sampleCount,
              true,
              true,
            );
          }
          colorPipeline = cache.noDepthTestOpaquePipeline;
        } else {
          if (!cache.noDepthTestPipeline) {
            cache.noDepthTestPipeline = buildPolygonPipeline(
              device,
              cache.shaderModule,
              cache.format,
              cache.bgls,
              "fragmentMain",
              cache.sampleCount,
              false,
              true,
            );
          }
          colorPipeline = cache.noDepthTestPipeline;
        }
      } else if (isOpaque) {
        // Lazily build + cache the OPAQUE color pipeline variant on first
        // use, reusing the cached shader module + bind-group layouts so it is
        // byte-identical to the TRANSLUCENT pipeline except blend/depth-write.
        if (!cache.opaquePipeline) {
          cache.opaquePipeline = buildPolygonPipeline(
            device,
            cache.shaderModule,
            cache.format,
            cache.bgls,
            "fragmentMain",
            cache.sampleCount,
            true,
          );
        }
        colorPipeline = cache.opaquePipeline;
      } else {
        colorPipeline = cache.pipeline;
      }
      cache.command = new WebGPUDrawCommand({
        pipeline: colorPipeline,
        bindGroups: [cache.bindGroup],
        vertexBuffers: vbs,
        indexBuffer: cache.indexBuffer,
        indexFormat: cache.indexFormat,
        indexCount,
        // OPAQUE collections sort + occlude with the opaque pass; the default
        // TRANSLUCENT path composites back-to-front. Pick path stays OPAQUE
        // because pick-ID color is discrete, not alpha-blended.
        pass: isOpaque ? Pass.OPAQUE : Pass.TRANSLUCENT,
        // Scene-mode-aware bounding sphere → per-frustum culling + (when
        // enabled) the debug overlay. Refreshed below every frame.
        boundingVolume: modeBV,
        debugShowBoundingVolume: collection.debugShowBoundingVolume,
      });
      cache.commandBlendOption = collection._blendOption;
      cache.commandNoDepthTest = noDepthTest;
    } else {
      cache.command.indexCount = indexCount;
    }
    // Refresh per-frame: the collection's bounding sphere is auto-updated
    // Scene-side, and debugShowBoundingVolume can toggle at runtime. Re-read
    // both onto the command so culling + overlay track them.
    cache.command.boundingVolume = modeBV;
    cache.command.debugShowBoundingVolume =
      collection.debugShowBoundingVolume ?? false;
    frameState.commandList.push(cache.command);
  }

  if (frameState.passes.pick && collection._allowPicking) {
    if (!cache.pickCommand) {
      cache.pickCommand = new WebGPUDrawCommand({
        pipeline: cache.pickPipeline,
        bindGroups: [cache.bindGroup],
        vertexBuffers: vbs,
        indexBuffer: cache.indexBuffer,
        indexFormat: cache.indexFormat,
        indexCount,
        pass: Pass.OPAQUE,
        // This command is submitted only during the pick pass.
        pickOnly: true,
      });
    } else {
      cache.pickCommand.indexCount = indexCount;
    }
    frameState.commandList.push(cache.pickCommand);
  }

  collection._dirtyCount = 0;
  collection._dirtyOffset = 0;
}

export function destroyWebGPUBufferPolygonCollection(
  collection: BufferPrimitiveCollection,
): void {
  const cache = collection._webgpuCache as PolygonCache | undefined;
  if (!cache) {
    return;
  }
  destroyPickIds(cache);
  cache.cameraUBO.destroy();
  cache.positionHigh.destroy();
  cache.positionLow.destroy();
  cache.pickColor.destroy();
  cache.showAndColor.destroy();
  cache.indexBuffer.destroy();
  collection._webgpuCache = undefined;
}
