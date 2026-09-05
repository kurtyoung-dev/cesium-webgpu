/**
 * WebGPU Clipping Polygon Collection
 *
 * Feature-renderer backend for `ClippingPolygonCollection` (registered under
 * `FeatureRendererKey.CLIPPING_POLYGONS`). Uploads the collection's CPU-packed
 * polygon + extents data into GPU textures and generates the signed distance
 * field (SDF) atlas via the `PolygonSignedDistance.wgsl` compute shader.
 *
 * Packing convention: the CPU pack is the same
 * `packPolygonsAsFloats` the WebGL path uses (invoked through
 * `Scene/ClippingPolygonSdfPack.packDataForFeatureRenderer`), so polygon vertices
 * and extents are in spherical `fastApproximateAtan2` coordinates and the
 * positions texture carries the per-polygon layout the compute
 * shader expects: 1 header pixel `(positionsLength, extentsIndex)` + 2
 * individual-extent pixels + one pixel per vertex. Raw geodetic `(lon, lat)`
 * pairs omit those headers and are incompatible with the SDF compute shader,
 * which is a port of `PolygonSignedDistanceFS.glsl`; using that layout
 * produces unusable SDF data and prevents clipping from activating.
 *
 * Consumers: `WebGPUEffectsBindGroup.createEffectsBindGroup` binds
 * `cache.signedDistanceTextureView` + `cache.sdfSampler` at effects bindings
 * 5/6 and packs `_extentsFloat32View` / `_extentsCount` into the
 * `clippingPolygonControl` / `clippingPolygonExtents` UBO fields consumed by
 * `modelClipByPolygon` (ModelPBRComplete.wgsl) and `globeClipByPolygon`
 * (GlobeTerrain.wgsl).
 *
 * @module WebGPUClippingPolygonCollection
 */

import {
  makeBindGroupLayout,
  uniformBuffer as uniformBufferEntry,
  texture as textureEntry,
  storageTexture,
  Stage,
} from "./WebGPUBindGroupLayoutHelpers.js";
import PolygonSignedDistanceWGSL from "../../Shaders/WebGPU/Compute/PolygonSignedDistance.js";
import { packDataForFeatureRenderer } from "../../Scene/ClippingPolygonSdfPack.js";

/** Minimal interface for ClippingPolygonCollection. */
interface ClippingPolygonCollectionLike {
  length: number;
  /** Private field: reading the public getter emits a 1.145 deprecation warning. */
  _quality?: number;
  get(index: number): { length: number };
  _float32View?: Float32Array;
  _extentsFloat32View?: Float32Array;
  _webgpuCache?: ClippingPolygonCache;
}

interface ClippingPolygonCache {
  positionsTexture: GPUTexture | null;
  extentsTexture: GPUTexture | null;
  signedDistanceTexture: GPUTexture | null;
  signedDistanceTextureView: GPUTextureView | null;
  sdfSampler: GPUSampler | null;
  // Change detection mirrors the WebGL heuristic: repack when the
  // total number of positions or the polygon count changes; per-vertex
  // edits with a constant count are not tracked, same as WebGL).
  lastTotalPositions: number;
  lastLength: number;
}

/**
 * Update WebGPU clipping polygon resources.
 * Packs polygon position and extent data into float textures and dispatches
 * the SDF compute pass when the collection contents changed.
 */
function updateWebGPUClippingPolygons(
  collection: ClippingPolygonCollectionLike,
  frameState: CesiumFrameState,
): void {
  const context = frameState.context;
  const device: GPUDevice = context.device;

  if (collection.length === 0) {
    return;
  }

  let totalPositions = 0;
  for (let i = 0; i < collection.length; i++) {
    totalPositions += collection.get(i).length;
  }

  if (!collection._webgpuCache) {
    collection._webgpuCache = {
      positionsTexture: null,
      extentsTexture: null,
      signedDistanceTexture: null,
      signedDistanceTextureView: null,
      sdfSampler: null,
      lastTotalPositions: -1,
      lastLength: -1,
    };
  }

  const cache = collection._webgpuCache;
  if (
    cache.lastTotalPositions === totalPositions &&
    cache.lastLength === collection.length &&
    cache.signedDistanceTexture !== null
  ) {
    return;
  }

  const maxDim = device.limits.maxTextureDimension2D;

  // Shared CPU pack — same spherical fastApproximateAtan2 convention +
  // merged-extent grouping the WebGL path uploads.
  const layout = packDataForFeatureRenderer(collection, maxDim);
  const positionsView = collection._float32View;
  const extentsView = collection._extentsFloat32View;
  if (!layout || !positionsView || !extentsView) {
    return;
  }

  // Positions texture (rg32float): header + individual extents + vertices.
  if (cache.positionsTexture) {
    cache.positionsTexture.destroy();
  }
  cache.positionsTexture = device.createTexture({
    label: "ClippingPolygon positions",
    size: { width: layout.positionsWidth, height: layout.positionsHeight },
    format: "rg32float",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture(
    { texture: cache.positionsTexture },
    positionsView,
    { bytesPerRow: layout.positionsWidth * 8 },
    { width: layout.positionsWidth, height: layout.positionsHeight },
  );

  // Merged-extents texture (rgba32float): (south, west, invLatRange,
  // invLonRange) per merged-extent group.
  if (cache.extentsTexture) {
    cache.extentsTexture.destroy();
  }
  cache.extentsTexture = device.createTexture({
    label: "ClippingPolygon extents",
    size: { width: layout.extentsWidth, height: layout.extentsHeight },
    format: "rgba32float",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture(
    { texture: cache.extentsTexture },
    extentsView,
    { bytesPerRow: layout.extentsWidth * 16 },
    { width: layout.extentsWidth, height: layout.extentsHeight },
  );

  // Signed distance atlas (r32float, filterable via the float32-filterable
  // device feature the context requests at init — same assumption the
  // effects placeholder SDF texture already makes). The sizing convention was
  // inherited from `ClippingPolygonCollection.getClippingDistanceTextureResolution`,
  // which the 1.145 sync removed along with the rest of the WebGL signed-distance
  // producer; this is now the only place it lives, so it is spelled out rather than
  // cited. `_quality` is read instead of the public `quality` getter because 1.145
  // deprecated that getter and warns on every read — see DECISIONS D2.
  const quality = collection._quality ?? 1.0;
  const sdfSize = Math.min(Math.max(128, Math.ceil(4096 * quality)), maxDim);
  if (cache.signedDistanceTexture) {
    cache.signedDistanceTexture.destroy();
  }
  cache.signedDistanceTexture = device.createTexture({
    label: "ClippingPolygon SDF atlas",
    size: { width: sdfSize, height: sdfSize },
    format: "r32float",
    usage:
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.STORAGE_BINDING |
      GPUTextureUsage.COPY_DST,
  });
  cache.signedDistanceTextureView = cache.signedDistanceTexture.createView();

  if (!cache.sdfSampler) {
    // Linear filtering with clamp-to-edge matches the WebGL
    // signed-distance sampler.
    cache.sdfSampler = device.createSampler({
      label: "ClippingPolygon SDF sampler",
      minFilter: "linear",
      magFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });
  }

  computePolygonSDF(
    device,
    cache,
    collection.length,
    layout.extentsCount,
    layout.positionsWidth,
    sdfSize,
    context.webgpuComputePipelineCache ?? null,
  );

  cache.lastTotalPositions = totalPositions;
  cache.lastLength = collection.length;
}

// ---- SDF compute pipeline ----

// Module-level pipeline cache (shared across all collections on same device)
let _sdfComputePipeline: GPUComputePipeline | null = null;
let _sdfBindGroupLayout: GPUBindGroupLayout | null = null;
let _sdfPipelineDevice: GPUDevice | null = null;

/**
 * Dispatch the PolygonSignedDistance.wgsl compute shader to fill the SDF texture.
 */
function computePolygonSDF(
  device: GPUDevice,
  cache: ClippingPolygonCache,
  polygonCount: number,
  extentsCount: number,
  positionsWidth: number,
  sdfSize: number,
  computePipelineCache:
    | import("./WebGPUComputePipelineCache.js").WebGPUComputePipelineCache
    | null = null,
): void {
  if (
    !cache.positionsTexture ||
    !cache.extentsTexture ||
    !cache.signedDistanceTexture
  ) {
    return;
  }

  // Lazily create the compute pipeline
  if (!_sdfComputePipeline || _sdfPipelineDevice !== device) {
    _sdfPipelineDevice = device;

    _sdfBindGroupLayout = makeBindGroupLayout(
      device,
      "PolygonSDF-BindGroupLayout",
      [
        uniformBufferEntry(0, Stage.COMPUTE),
        textureEntry(1, Stage.COMPUTE, { sampleType: "unfilterable-float" }),
        textureEntry(2, Stage.COMPUTE, { sampleType: "unfilterable-float" }),
        storageTexture(3, Stage.COMPUTE, "r32float"),
      ],
    );

    // Canonical WGSL source — port of PolygonSignedDistanceFS.glsl,
    // compiled from Shaders/WebGPU/Compute/PolygonSignedDistance.wgsl.
    const shaderModule = device.createShaderModule({
      label: "PolygonSDF-Compute",
      code: PolygonSignedDistanceWGSL,
    });

    // Route through the central cache. This module-level singleton must be
    // deduplicated when two contexts on the same device need polygon clipping.
    const sdfPipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [_sdfBindGroupLayout],
    });
    if (computePipelineCache) {
      _sdfComputePipeline = computePipelineCache.getOrCreateSync({
        name: "PolygonSDF-Pipeline",
        layout: sdfPipelineLayout,
        compute: { module: shaderModule, entryPoint: "main" },
      });
    } else {
      _sdfComputePipeline = device.createComputePipeline({
        label: "PolygonSDF-Pipeline",
        layout: sdfPipelineLayout,
        compute: { module: shaderModule, entryPoint: "main" },
      });
    }
  }

  // Uniforms: { polygonsLength, extentsLength, positionsWidth, pad }.
  // extentsLength is the MERGED extent-group count (`_extentsCount`) —
  // the atlas grid dimension derives from it on both the compute side
  // and the fragment lookup side (`clippingPolygonControl.y`).
  const uniformData = new Uint32Array([
    polygonCount,
    extentsCount,
    positionsWidth,
    0, // padding
  ]);
  const uniformBuffer = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(uniformBuffer, 0, uniformData);

  // Create bind group
  const bindGroup = device.createBindGroup({
    layout: _sdfBindGroupLayout!,
    entries: [
      { binding: 0, resource: { buffer: uniformBuffer } },
      { binding: 1, resource: cache.positionsTexture.createView() },
      { binding: 2, resource: cache.extentsTexture.createView() },
      { binding: 3, resource: cache.signedDistanceTextureView! },
    ],
  });

  // Dispatch compute shader
  const encoder = device.createCommandEncoder({ label: "PolygonSDF-Compute" });
  const pass = encoder.beginComputePass({ label: "PolygonSDF-Pass" });
  pass.setPipeline(_sdfComputePipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(Math.ceil(sdfSize / 8), Math.ceil(sdfSize / 8), 1);
  pass.end();
  device.queue.submit([encoder.finish()]);

  // Cleanup one-shot uniform buffer
  uniformBuffer.destroy();
}

/**
 * Destroy WebGPU clipping polygon resources.
 */
function destroyWebGPUClippingPolygonResources(
  collection: CesiumObjectWithWebGPUCache,
): void {
  const cache = collection._webgpuCache as ClippingPolygonCache | undefined;
  if (!cache) {
    return;
  }

  if (cache.positionsTexture) {
    cache.positionsTexture.destroy();
  }
  if (cache.extentsTexture) {
    cache.extentsTexture.destroy();
  }
  if (cache.signedDistanceTexture) {
    cache.signedDistanceTexture.destroy();
  }

  (collection as CesiumObjectWithWebGPUCache)._webgpuCache = undefined;
}

export { updateWebGPUClippingPolygons, destroyWebGPUClippingPolygonResources };
export default {
  updateWebGPUClippingPolygons,
  destroyWebGPUClippingPolygonResources,
};
