/// <reference types="@webgpu/types" />
/**
 * Tile-buffer cache + eviction helpers extracted from
 * `WebGPUGlobeSurfaceRenderer`.
 *
 * Batch 151 of the audit-recommended decomposition (seventh slice of the
 * GlobeSurface decomposition arc — see
 * `migration_doc/BATCH_145_PLAN_GLOBE_SURFACE_DECOMPOSITION.md`).
 *
 * Moves the per-tile GPU-resource cache off the renderer class:
 *
 *   - `getTileKey(tile)` — pure helper that produces the cache key for
 *     a tile (`${level}_${x}_${y}`). No host needed.
 *   - `getOrCreateTileBuffers(host, tileKey, mesh)` — the heaviest helper
 *     in this batch (~245 LOC). Builds the per-tile vertex+index GPU
 *     buffers, handles `Uint8Array` index up-conversion, validates
 *     stride against actual vertex data (fill-tile correction), pads to
 *     4-byte alignment, allocates the shadow-cast UB, and caches the
 *     result. Returns null on any unrecoverable encoding mismatch.
 *   - `evictStaleResources(host, activeTileKeys)` — culls cache entries
 *     whose key isn't in the active set, destroying their GPU buffers.
 *   - `removeImageryTexture(host, cacheKey)` — destroys an imagery
 *     texture and removes its cache entry.
 *
 * Internal helper: `writeTerrainShadowUB(device, buffer, mesh)` writes
 * the 96-byte `quantized12` shadow-cast UB layout (scaleAndBias + center3D
 * + minMaxHeight). Not exported — only called from
 * `getOrCreateTileBuffers`.
 *
 * The renderer keeps `evictStaleResources` and `removeImageryTexture`
 * as public-API delegators (2-line wrappers) since they're part of the
 * renderer's external surface. The internal `_getTileKey`,
 * `_getOrCreateTileBuffers`, and `_writeTerrainShadowUB` methods are
 * removed entirely; the 2 internal callers (in `createTileCommands` and
 * `createWireframeTileCommands`) now invoke the helpers directly.
 *
 * The 2 host fields these helpers reach into beyond `_device` are
 * `_tileBufferCache` (flipped to public this batch) and
 * `_imageryTextureCache` (already public from Batch 148).
 *
 * @module WebGPUGlobeSurfaceTileBuffers
 */

import { m4Values, gpuData } from "./webgpuTypeHelpers.js";
import type {
  TileGPUResources,
  ImageryGPUTexture,
} from "./WebGPUGlobeSurfaceTypes.js";

/**
 * The renderer surface the tile-buffer helpers reach into.
 *
 *   - `_device`: read-only.
 *   - `_tileBufferCache` / `_imageryTextureCache`: read+write Maps.
 */
export interface TileBuffersHost {
  readonly _device: GPUDevice | null;
  readonly _tileBufferCache: Map<string, TileGPUResources>;
  readonly _imageryTextureCache: Map<string, ImageryGPUTexture>;
}

/** Stable per-tile cache key. Pure function — no host needed. */
export function getTileKey(tile: {
  level: number;
  x: number;
  y: number;
}): string {
  return `${tile.level}_${tile.x}_${tile.y}`;
}

// ═══════════════════════════════════════════════════════════════════════
// Vertex / Index Buffer Management
// ═══════════════════════════════════════════════════════════════════════

export function getOrCreateTileBuffers(
  host: TileBuffersHost,
  tileKey: string,
  mesh: CesiumTerrainMesh,
): TileGPUResources | null {
  const device = host._device!;
  const generation = mesh._webgpuGeneration || 0;

  const cached = host._tileBufferCache.get(tileKey);
  // NS-WEBGPU-TILE-POPPING-SKIRTS — a tile's cache key (`level_x_y`) is stable
  // across a fill/upsampled → real-terrain mesh swap, and `meshGeneration` is
  // always 0 (nothing sets `mesh._webgpuGeneration`), so `meshGeneration`
  // alone never invalidates. Also require the cached buffers to have been built
  // from the SAME `mesh.vertices` array; when `renderedMesh` swaps in a new
  // mesh (new typed array) the reference differs and we rebuild instead of
  // serving stale vertex data that the current per-tile uniforms decode into
  // flung "space" vertices (black wedge slivers). Same mesh → same reference →
  // identical cache hit as before (byte-neutral for the settled steady state).
  if (
    cached &&
    cached.meshGeneration === generation &&
    cached.sourceVertices === mesh.vertices
  ) {
    return cached;
  }

  if (cached) {
    cached.vertexBuffer.destroy();
    cached.indexBuffer.destroy();
    cached.shadowCastUB?.destroy();
  }

  const vertices: Float32Array = mesh.vertices;
  let indices: Uint8Array | Uint16Array | Uint32Array = mesh.indices;
  if (!vertices || !indices || vertices.length === 0 || indices.length === 0) {
    return null;
  }

  // WebGPU does not support uint8 index format — only uint16 and uint32.
  // `TerrainFillMesh` stores indices as `Uint8Array` when `vertexCount < 256`
  // to save memory (see `TerrainFillMesh.js:1236`). Up-convert to Uint16Array
  // here so the buffer size, byte-length, and declared `indexFormat` all
  // agree. Historical bug: leaving the Uint8Array in place made
  // `indices.byteLength` equal to `indexCount` (1 byte/index), the buffer
  // was created at half the needed size, and the index format was still
  // reported as uint16 — the GPU then read 2 bytes per index and tried to
  // walk past the end of the buffer, invalidating the whole command buffer
  // and producing an invisible globe at default zoom.
  if (indices instanceof Uint8Array) {
    const upconverted = new Uint16Array(indices.length);
    for (let k = 0; k < indices.length; k++) upconverted[k] = indices[k];
    indices = upconverted;
  }

  const encoding = mesh.encoding;
  let stride = encoding.stride;
  let hasNormals = encoding.hasVertexNormals === true;
  let hasWebMercatorT = encoding.hasWebMercatorT === true;
  // TerrainQuantization.BITS12 = 1; NONE = 0
  const isQuantized =
    encoding.quantization !== undefined && encoding.quantization === 1;

  // Validate stride against actual vertex data. Fill tiles (TerrainFillMesh)
  // may have vertex data with a different stride than their encoding reports,
  // because the encoding is inherited from the parent tile. The encoding may
  // say stride=8 (pos+h+uv+webMercT+normal) but the fill mesh only wrote
  // stride=6 (pos+h+uv). Detect this by finding the smallest valid stride
  // that accommodates all indices.
  if (indices.length > 0 && vertices.length > 0) {
    let maxIdx = 0;
    for (let k = 0; k < indices.length; k++) {
      if (indices[k] > maxIdx) maxIdx = indices[k];
    }
    const neededVerts = maxIdx + 1;
    const vertCountAtStride = Math.floor(vertices.length / stride);
    if (neededVerts > vertCountAtStride) {
      // Current stride doesn't fit — find smallest valid stride.
      // Fill tiles may use stride as low as 4 (pos+height only).
      let correctedStride = 0;
      const minStride = isQuantized ? 3 : 4;
      for (let s = minStride; s <= stride; s++) {
        if (Math.floor(vertices.length / s) >= neededVerts) {
          correctedStride = s;
          break;
        }
      }
      // If corrected stride < 6 (uncompressed) or no stride found,
      // the vertex data lacks UV coordinates — skip this fill tile
      // rather than rendering with garbage UVs that produce black lines.
      if (correctedStride === 0 || (!isQuantized && correctedStride < 6)) {
        return null;
      }
      stride = correctedStride;
      // Recompute flags based on corrected stride
      if (!isQuantized) {
        hasWebMercatorT = stride >= 7 && encoding.hasWebMercatorT === true;
        hasNormals = stride >= 8 || (stride >= 7 && !hasWebMercatorT);
      }
    }
  }

  // WebGPU requires buffer sizes to be multiples of 4
  const vbSize = Math.ceil(vertices.byteLength / 4) * 4;
  const vertexBuffer = device.createBuffer({
    label: `Terrain VB ${tileKey}`,
    size: vbSize,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(vertexBuffer, 0, gpuData(vertices));

  // Index buffers with Uint16Array may have non-4-byte-aligned byteLength;
  // pad to 4-byte alignment for writeBuffer compatibility
  const ibByteLength = indices.byteLength;
  const ibAlignedSize = Math.ceil(ibByteLength / 4) * 4;
  const indexBuffer = device.createBuffer({
    label: `Terrain IB ${tileKey}`,
    size: ibAlignedSize,
    usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
  });
  if (ibAlignedSize !== ibByteLength) {
    // Pad to 4-byte alignment
    const padded = new Uint8Array(ibAlignedSize);
    padded.set(
      new Uint8Array(indices.buffer, indices.byteOffset, ibByteLength),
    );
    device.queue.writeBuffer(indexBuffer, 0, padded);
  } else {
    device.queue.writeBuffer(indexBuffer, 0, gpuData(indices));
  }

  const indexFormat: GPUIndexFormat =
    indices.BYTES_PER_ELEMENT === 4 ? "uint32" : "uint16";

  const strideBytes = stride * 4;

  // Final validation: vertex count must accommodate all indices.
  // This is a safety net — the upfront stride correction above should
  // handle most fill tile mismatches, but edge cases can still occur.
  const vertexCount = Math.floor(vbSize / strideBytes);
  let validIndexCount = indices.length;
  if (vertexCount > 0 && indices.length > 0) {
    let maxIdx = 0;
    for (let k = 0; k < indices.length; k++) {
      if (indices[k] > maxIdx) maxIdx = indices[k];
    }
    if (maxIdx >= vertexCount) {
      // Stride mismatch — encoding stride doesn't match actual vertex data.
      // Try to infer the correct stride from data length and max index.
      const actualVertCount = maxIdx + 1;
      const inferredStride = Math.floor(vertices.length / actualVertCount);

      // If we can infer a valid stride, use it instead
      if (
        inferredStride >= 3 &&
        inferredStride <= 11 &&
        vertices.length >= actualVertCount * inferredStride
      ) {
        const correctedStrideBytes = inferredStride * 4;
        const correctedVertCount = Math.floor(vbSize / correctedStrideBytes);
        if (maxIdx < correctedVertCount) {
          // DP-H25 — geodetic normals occupy the trailing 3 floats of the
          // stride when `encoding.hasGeodeticSurfaceNormals` is set. The
          // inferred-stride fallback only fires for fill tiles so we defer
          // to the encoding flag here; downstream `_selectPipeline` handles
          // the case where stride is too small to actually carry it.
          const inferredHasGeoNormal =
            encoding.hasGeodeticSurfaceNormals === true &&
            inferredStride >=
              (isQuantized ? 4 : hasWebMercatorT || hasNormals ? 7 : 6) + 3;
          const resources: TileGPUResources = {
            vertexBuffer,
            indexBuffer,
            indexCount: indices.length,
            indexFormat,
            strideFloats: inferredStride,
            strideBytes: correctedStrideBytes,
            hasNormals:
              inferredStride >= 7 || (isQuantized && inferredStride >= 4),
            hasWebMercatorT,
            isQuantized,
            hasGeodeticSurfaceNormals: inferredHasGeoNormal,
            meshGeneration: generation,
            sourceVertices: vertices,
          };
          host._tileBufferCache.set(tileKey, resources);
          return resources;
        }
      }

      // Fallback: clamp to safe indices
      let safeCount = 0;
      for (let k = 0; k < indices.length; k += 3) {
        if (
          k + 2 < indices.length &&
          indices[k] < vertexCount &&
          indices[k + 1] < vertexCount &&
          indices[k + 2] < vertexCount
        ) {
          safeCount = k + 3;
        } else {
          break;
        }
      }
      validIndexCount = safeCount;
      if (validIndexCount === 0) {
        vertexBuffer.destroy();
        indexBuffer.destroy();
        return null;
      }
    }
  }

  const resources: TileGPUResources = {
    vertexBuffer,
    indexBuffer,
    indexCount: validIndexCount,
    indexFormat,
    strideFloats: stride,
    strideBytes,
    hasNormals,
    hasWebMercatorT,
    isQuantized,
    // DP-H25 — `TerrainEncoding` flips `hasGeodeticSurfaceNormals` on when
    // the per-vertex stride is widened to include the normal (see
    // TerrainEncoding.js:320). The pipeline builder uses this flag to
    // add a `@location(2)` vec3 attribute over the trailing 12 bytes of
    // the stride and enable the `GEODETIC_NORMAL` shader define.
    hasGeodeticSurfaceNormals: encoding.hasGeodeticSurfaceNormals === true,
    meshGeneration: generation,
    sourceVertices: vertices,
  };

  // Allocate a shadow cast UB for every tile regardless of quantization.
  // Before Batch 24 this was quantized-only, which meant uncompressed
  // tiles fell through to the `rte24` variant via stride-inference —
  // and `rte24` reads two vec3s (positionHigh + positionLow) where
  // the uncompressed VB actually has `position3DAndHeight` + tex
  // coords. The resulting RTE math produced shadow coordinates
  // unrelated to the actual terrain. Batch 24's new
  // `terrainUncompressed` shadow cast variant consumes the same UB
  // layout as `quantized12` (scaleAndBias + center3D + minMaxHeight),
  // so every tile — quantized or not — needs the buffer populated.
  // The buffer is static for the tile's lifetime; when the tile's
  // mesh is regenerated we rebuild it alongside the vertex buffer
  // (next cache-miss path).
  const shadowUB = device.createBuffer({
    label: `Terrain shadow cast UB (${tileKey})`,
    // 96 bytes: scaleAndBias(64) + center3D+pad(16) + minMaxHeight+pad(16)
    size: 96,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  writeTerrainShadowUB(device, shadowUB, mesh);
  resources.shadowCastUB = shadowUB;

  host._tileBufferCache.set(tileKey, resources);
  return resources;
}

/**
 * Writes the `quantized12` shadow-cast variant's uniform data for
 * a tile. Layout (96 bytes, must match
 * WebGPUShadowMapRenderer.js::SHADOW_CAST_VARIANTS.quantized12):
 *
 *   offset  0: scaleAndBias: mat4x4<f32>  (from mesh.encoding.matrix)
 *   offset 64: center3D:     vec3<f32>    (from mesh.center)
 *   offset 76: _pad0:        f32
 *   offset 80: minMaxHeight: vec2<f32>
 *   offset 88: _pad1:        vec2<f32>
 *
 * Internal helper, not exported. Only called from
 * `getOrCreateTileBuffers` immediately after allocating the buffer.
 * @private
 */
function writeTerrainShadowUB(
  device: GPUDevice,
  buffer: GPUBuffer,
  mesh: CesiumTerrainMesh,
): void {
  const data = new Float32Array(24); // 96 bytes
  const encoding = mesh.encoding;
  if (encoding && encoding.matrix) {
    const m = m4Values(encoding.matrix);
    for (let i = 0; i < 16; i++) data[i] = m[i];
  } else {
    for (let i = 0; i < 16; i++) data[i] = i % 5 === 0 ? 1.0 : 0.0;
  }
  const center = mesh.center ||
    (encoding && encoding.center) || { x: 0, y: 0, z: 0 };
  data[16] = center.x;
  data[17] = center.y;
  data[18] = center.z;
  data[19] = 0;
  data[20] = encoding?.minimumHeight ?? 0;
  data[21] = encoding?.maximumHeight ?? 0;
  data[22] = 0;
  data[23] = 0;
  device.queue.writeBuffer(buffer, 0, data.buffer, 0, 96);
}

// ═══════════════════════════════════════════════════════════════════════
// Cache Eviction
// ═══════════════════════════════════════════════════════════════════════

export function evictStaleResources(
  host: TileBuffersHost,
  activeTileKeys: Set<string>,
): void {
  for (const [key, resources] of host._tileBufferCache) {
    if (!activeTileKeys.has(key)) {
      resources.vertexBuffer.destroy();
      resources.indexBuffer.destroy();
      resources.shadowCastUB?.destroy();
      host._tileBufferCache.delete(key);
    }
  }
}

export function removeImageryTexture(
  host: TileBuffersHost,
  cacheKey: string,
): void {
  const cached = host._imageryTextureCache.get(cacheKey);
  if (cached) {
    cached.texture.destroy();
    host._imageryTextureCache.delete(cacheKey);
  }
}
