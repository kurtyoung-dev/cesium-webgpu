/// <reference types="@webgpu/types" />
/**
 * Wireframe-pipeline + wireframe-index helpers extracted from
 * `WebGPUGlobeSurfaceRenderer`.
 *
 * Batch 149 of the audit-recommended decomposition (fifth slice of the
 * GlobeSurface decomposition arc — see
 * `migration_doc/BATCH_145_PLAN_GLOBE_SURFACE_DECOMPOSITION.md`).
 *
 * Moves the three internal wireframe helpers off the renderer class:
 *
 *   - `selectWireframePipeline(host, …)` — entry-based caching for the
 *     line-list pipeline variant. Mirrors `_selectPipeline`'s shape
 *     (Q/U, N/X, M/G, stride) so the wireframe overlay always uses the
 *     same vertex layout as its colored counterpart for the same tile.
 *   - `buildWireframePipelineDescriptor(host, …)` — produces a cache-
 *     friendly `WebGPURenderPipelineDescriptor` for the wireframe variant.
 *     Reuses the production shader module via the shader factory; differs
 *     from the colored pipeline only in topology (`line-list`) and cull
 *     mode (`none`).
 *   - `getOrCreateWireframeIndices(host, …)` — converts triangle indices
 *     to line indices on first use, caches the resulting GPU index
 *     buffer per tile.
 *
 * The public-API `createWireframeTileCommands` orchestrator stays on the
 * renderer class — it's the single entry point for wireframe-mode draw
 * commands, calls these helpers, and depends on a wider slice of class
 * state (uniform-buffer builders, tile-buffer cache, bind-group helpers)
 * that's scheduled to leave the class in Batches 150–153.
 *
 * The four host fields/methods these helpers reach into are flipped from
 * `private` to `public` on the renderer (with the underscore prefix
 * preserved as the convention marker per Batches 142–148).
 *
 * @module WebGPUGlobeSurfaceWireframe
 */

import { gpuData } from "./webgpuTypeHelpers.js";
import { ShaderDefine } from "./WebGPUShaderDefines.js";
import {
  getProductionShaderModule as getProductionShaderModuleHelper,
  type ShaderFactoryHost,
} from "./WebGPUGlobeSurfaceShaders.js";
import { resolveGlobePipelineEntry } from "./WebGPUGlobeSurfacePipelines.js";
import type { PipelineHost } from "./WebGPUGlobeSurfacePipelines.js";
import type { GlobePipelineEntry } from "./WebGPUGlobeSurfaceTypes.js";
import type { WebGPURenderPipelineDescriptor } from "./WebGPURenderPipelineCache.js";

/**
 * Wireframe-index-cache slot type. Keyed by tile key in
 * `_wireframeIndexCache`; the buffer is destroyed in `destroy()` /
 * `evictStaleResources()`.
 */
export interface WireframeIndexEntry {
  buffer: GPUBuffer;
  count: number;
  format: GPUIndexFormat;
}

/**
 * The renderer surface the wireframe helpers reach into. Extends
 * `PipelineHost` (which itself extends `ShaderFactoryHost`) so the
 * descriptor builder can call `getProductionShaderModule` and the
 * selector can call `resolveGlobePipelineEntry` directly without going
 * back through the renderer's delegators.
 */
export interface WireframeHost extends PipelineHost {
  readonly _wireframePipelineCache: Map<string, GlobePipelineEntry>;
  readonly _wireframeIndexCache: Map<string, WireframeIndexEntry>;
}

/**
 * Cold-path wireframe pipeline selector. Mirrors `_selectPipeline` exactly
 * in shape (Q/U, N/X, M/G, stride) so the wireframe variant uses the same
 * vertex layout as the production pipeline for the tile being drawn —
 * crucial because mismatched strides crash the GPU. Only differs in
 * topology (line-list vs triangle-list) and cull mode.
 *
 * Kept entirely off the hot path; only invoked when
 * `frameState.debugShowGlobeWireframe` is true.
 */
export function selectWireframePipeline(
  host: WireframeHost,
  isQuantized: boolean,
  hasNormals: boolean,
  hasWebMercatorT: boolean,
  strideBytes: number,
  hasGeodeticSurfaceNormals: boolean = false,
): GPURenderPipeline | null {
  // C-R7-RENDERER-MIGRATION (Batch 75) — entry-based caching; pipeline
  // resolves through the central cache. Returns null when the pipeline
  // hasn't materialized yet (caller should skip the wireframe overlay
  // for this tile this frame).
  const defines =
    (hasGeodeticSurfaceNormals ? ShaderDefine.GEODETIC_NORMAL : 0) |
    (host._imageryReduced ? ShaderDefine.GLOBE_IMAGERY_REDUCED : 0);
  const cacheKey = `${isQuantized ? "Q" : "U"}${hasNormals ? "N" : "X"}${hasWebMercatorT ? "M" : "G"}_${strideBytes}|${defines.toString(16)}`;
  let entry = host._wireframePipelineCache.get(cacheKey);
  if (!entry) {
    const descriptor = buildWireframePipelineDescriptor(
      host,
      isQuantized,
      hasNormals,
      hasWebMercatorT,
      strideBytes,
      hasGeodeticSurfaceNormals,
    );
    entry = { descriptor, pipeline: null, pending: false };
    host._wireframePipelineCache.set(cacheKey, entry);
  }
  return resolveGlobePipelineEntry(host, entry);
}

/**
 * Builds a wireframe variant of the terrain pipeline. Vertex stage is the
 * full production layout (matching `_createPipelineVariant`); only the
 * primitive topology and depth/cull state differ. Reuses the production
 * shader module — no special wireframe entry point needed because line-list
 * topology applied to triangle indices produces edges automatically when
 * the IB is converted (see `getOrCreateWireframeIndices`).
 */
// C-R7-RENDERER-MIGRATION (Batch 75) — returns descriptor; pipeline
// materializes through `webgpuPipelineCache`. Renamed:
// `_createWireframePipelineVariant` → `buildWireframePipelineDescriptor`.
export function buildWireframePipelineDescriptor(
  host: WireframeHost,
  isQuantized: boolean,
  hasNormals: boolean,
  hasWebMercatorT: boolean,
  strideBytes: number,
  hasGeodeticSurfaceNormals: boolean = false,
): WebGPURenderPipelineDescriptor {
  let vertexBuffers: GPUVertexBufferLayout[];
  let entryPoint: string;
  // Batch 20 — the production shader module + our `GEODETIC_NORMAL`
  // define keep the wireframe pipeline's vertex layout in sync with
  // the colored pass automatically. Entry-point names are unqualified;
  // the correct variant is selected via the active-defines bitmask
  // passed to `getProductionShaderModule`. Batch 246 — the reduced-
  // imagery bit rides along so the wireframe module's group-1
  // declarations match the device's 1-slot pipeline layout.
  const defines =
    (hasGeodeticSurfaceNormals ? ShaderDefine.GEODETIC_NORMAL : 0) |
    (host._imageryReduced ? ShaderDefine.GLOBE_IMAGERY_REDUCED : 0);

  if (isQuantized) {
    // See `_createPipelineVariant` for the full documentation of the
    // compressed0 / compressed1 layout. This block must stay in sync.
    let format: GPUVertexFormat;
    const hasCompressed1 = hasWebMercatorT && hasNormals;
    if (hasCompressed1) {
      format = "float32x4";
      entryPoint = "vertexMainQuantizedWebMercNormals";
    } else if (hasWebMercatorT) {
      format = "float32x4";
      entryPoint = "vertexMainQuantizedWebMerc";
    } else if (hasNormals) {
      format = "float32x4";
      entryPoint = "vertexMainQuantized";
    } else {
      format = "float32x3";
      entryPoint = "vertexMainQuantized";
    }
    const baseStride = hasWebMercatorT || hasNormals ? 16 : 12;
    const minStride =
      baseStride +
      (hasCompressed1 ? 4 : 0) +
      (hasGeodeticSurfaceNormals ? 12 : 0);
    const actualStride = Math.max(strideBytes, minStride);
    const attributes: GPUVertexAttribute[] = [
      { shaderLocation: 0, offset: 0, format },
    ];
    if (hasCompressed1) {
      attributes.push({
        shaderLocation: 1,
        offset: 16,
        format: "float32",
      });
    }
    if (hasGeodeticSurfaceNormals) {
      attributes.push({
        shaderLocation: 2,
        offset: actualStride - 12,
        format: "float32x3",
      });
    }
    vertexBuffers = [
      {
        arrayStride: actualStride,
        stepMode: "vertex",
        attributes,
      },
    ];
  } else {
    let texCoordFormat: GPUVertexFormat;
    if (hasWebMercatorT && hasNormals) {
      texCoordFormat = "float32x4";
      entryPoint = "vertexMainWebMercNormals";
    } else if (hasWebMercatorT) {
      texCoordFormat = "float32x3";
      entryPoint = "vertexMainWebMerc";
    } else if (hasNormals) {
      texCoordFormat = "float32x3";
      entryPoint = "vertexMain";
    } else {
      texCoordFormat = "float32x2";
      entryPoint = "vertexMain";
    }
    const minUncompressedStride = 24 + (hasGeodeticSurfaceNormals ? 12 : 0);
    const actualStride = Math.max(strideBytes, minUncompressedStride);
    const attributes: GPUVertexAttribute[] = [
      { shaderLocation: 0, offset: 0, format: "float32x4" },
      { shaderLocation: 1, offset: 16, format: texCoordFormat },
    ];
    if (hasGeodeticSurfaceNormals) {
      attributes.push({
        shaderLocation: 2,
        offset: actualStride - 12,
        format: "float32x3",
      });
    }
    vertexBuffers = [
      {
        arrayStride: actualStride,
        stepMode: "vertex",
        attributes,
      },
    ];
  }

  const quantLabel = isQuantized ? "quantized" : "uncompressed";
  const normLabel = hasNormals ? "normals" : "noNormals";
  const mercLabel = hasWebMercatorT ? "webMerc" : "geo";

  // Batch 20 — wireframe fetches the module from the shader cache with
  // the same `defines` used by the production pipeline for this tile,
  // so the wireframe overlay always matches its colored counterpart.
  const shaderModule = getProductionShaderModuleHelper(host, defines);
  // C11-158 — the wireframe overlay uses the full production `fragmentMain`
  // (line 249), so its module carries the ocean STYLING variant too. Mark the
  // descriptor name so the central pipeline cache doesn't alias the enhanced
  // and classic wireframe variants (the renderer-local `_wireframePipelineCache`
  // is wiped on the flag flip — see `_applyEnhancedOceanState`).
  const oceanLabel = host._enhancedOceanEnabled ? ", enhOcean" : "";
  return {
    name: `Globe wireframe (${quantLabel}, ${normLabel}, ${mercLabel}, ${strideBytes}b${host._imageryReduced ? ", imagery4" : ""}${oceanLabel})`,
    layout: host._pipelineLayout!,
    vertex: {
      module: shaderModule,
      entryPoint,
      buffers: vertexBuffers,
    },
    fragment: {
      module: shaderModule,
      entryPoint: "fragmentMain",
      // Match the scene framebuffer's attachment state EXACTLY, same as the
      // production globe pipeline (WebGPUGlobeSurfacePipelines.ts): TWO color
      // targets — the canvas-format scene color + the rgba16float G-buffer/
      // emissive target. With only ONE target (the prior code) the pipeline's
      // attachment state was incompatible with the Scene Framebuffer Render
      // Pass (which binds both attachments), so SetPipeline failed validation
      // and the wireframe draw was dropped — the overlay rendered BLACK.
      targets: [
        { format: host._canvasFormat },
        { format: "rgba16float" as GPUTextureFormat, writeMask: 0xf },
      ],
    },
    primitive: {
      topology: "line-list",
      cullMode: "none",
    },
    depthStencil: {
      format: "depth24plus-stencil8",
      // Slight depth bias would be ideal here, but WebGPU's depthBias
      // applies only to triangle topology — for line-list we accept the
      // co-planar z-fight and rely on the wireframe being a debug overlay.
      depthWriteEnabled: true,
      depthCompare: "less-equal",
    },
    // Match the scene FB sample count (MSAA) — same as the production pipeline.
    // A sampleCount-1 pipeline is incompatible with the 4x-MSAA scene pass and
    // would fail SetPipeline validation (the other half of the black overlay).
    multisample:
      (host._sampleCount ?? 1) > 1 ? { count: host._sampleCount! } : undefined,
  };
}

/**
 * Convert triangle indices to line indices. Each triangle (i0, i1, i2)
 * produces 3 line segments: (i0,i1), (i1,i2), (i2,i0). Creates and
 * caches a GPU index buffer for the wireframe.
 */
export function getOrCreateWireframeIndices(
  host: WireframeHost,
  tileKey: string,
  mesh: CesiumTerrainMesh,
): WireframeIndexEntry | null {
  const cached = host._wireframeIndexCache.get(tileKey);
  if (cached) return cached;

  const device = host._device!;
  const triIndices = mesh.indices;
  if (!triIndices || triIndices.length < 3) return null;

  const triCount = Math.floor(triIndices.length / 3);
  const lineCount = triCount * 3; // 3 edges per triangle
  const lineIndexCount = lineCount * 2; // 2 indices per line

  // Use same index type as the source
  const use32 = triIndices.BYTES_PER_ELEMENT === 4;
  const wireIndices = use32
    ? new Uint32Array(lineIndexCount)
    : new Uint16Array(lineIndexCount);

  let out = 0;
  for (let t = 0; t < triCount; t++) {
    const base = t * 3;
    const i0 = triIndices[base];
    const i1 = triIndices[base + 1];
    const i2 = triIndices[base + 2];
    wireIndices[out++] = i0;
    wireIndices[out++] = i1;
    wireIndices[out++] = i1;
    wireIndices[out++] = i2;
    wireIndices[out++] = i2;
    wireIndices[out++] = i0;
  }

  const buffer = device.createBuffer({
    label: `Terrain wireframe IB ${tileKey}`,
    size: wireIndices.byteLength,
    usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(buffer, 0, gpuData(wireIndices));

  const result = {
    buffer,
    count: lineIndexCount,
    format: (use32 ? "uint32" : "uint16") as GPUIndexFormat,
  };
  host._wireframeIndexCache.set(tileKey, result);
  return result;
}
