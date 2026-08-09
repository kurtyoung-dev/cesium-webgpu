/// <reference types="@webgpu/types" />
/**
 * Per-tile GPU-resource cache and eviction helpers for
 * `WebGPUGlobeSurfaceRenderer`:
 *
 *   - `getTileKey(tile)` — pure helper that produces the cache key for
 *     a tile (`${level}_${x}_${y}`). No host needed.
 *   - `getOrCreateTileBuffers(host, tileKey, mesh)` — builds the per-tile
 *     vertex and index GPU buffers, handles `Uint8Array` index
 *     up-conversion, validates stride against actual vertex data
 *     (fill-tile correction), pads to 4-byte alignment, retains the
 *     shadow-cast mesh source, and caches the result. Returns null on any
 *     unrecoverable encoding mismatch.
 *   - `ensureTerrainShadowCastUniformBuffer(device, resources)` lazily
 *     packs, realizes, and uploads the per-tile shadow UB on the first real
 *     cast pass, then reuses it until mesh replacement, eviction, or device
 *     loss.
 *   - `evictStaleResources(host, activeTileKeys)` — culls cache entries
 *     whose key isn't in the active set, destroying their GPU buffers.
 *   - `removeImageryTexture(host, cacheKey)` — destroys an imagery
 *     texture and removes its cache entry.
 *
 * Internal helper: `packTerrainShadowUniformData(mesh)` packs the shared
 * 96-byte terrain shadow layout (scaleAndBias + center3D + minMaxHeight)
 * without allocating a GPU resource.
 *
 * `evictStaleResources` and `removeImageryTexture` also exist as two-line
 * delegators on the renderer, since they are part of its external surface.
 * The host fields these helpers read beyond `_device` are `_tileBufferCache`
 * and `_imageryTextureCache`.
 *
 * @module WebGPUGlobeSurfaceTileBuffers
 */

import { m4Values, gpuData } from "./webgpuTypeHelpers.js";
import type {
  TileGPUResources,
  ImageryGPUTexture,
  WebGPUGlobeLogicalCounters,
} from "./WebGPUGlobeSurfaceTypes.js";
import type { WebGPUSharedImageryRealizations } from "./WebGPUSharedImageryRealizations.js";

const TERRAIN_SHADOW_UNIFORM_SIZE = 96;

/**
 * The renderer surface the tile-buffer helpers reach into.
 *
 *   - `_device`: read-only.
 *   - `_tileBufferCache` / `_imageryTextureCache`: read+write Maps.
 *   - `_sharedImageryRealizations` / `_webgpuContext` (optional):
 *     shared-realization reference release plus deferred and inline-destroy
 *     stamping for evicted imagery entries.
 */
export interface TileBuffersHost {
  readonly _device: GPUDevice | null;
  readonly _tileBufferCache: Map<string, TileGPUResources>;
  readonly _imageryTextureCache: Map<string, ImageryGPUTexture>;
  readonly _logicalCounters?: WebGPUGlobeLogicalCounters | null;
  _sharedImageryRealizations?: WebGPUSharedImageryRealizations | null;
  _webgpuContext?: {
    scheduleTextureDestroy(texture: GPUTexture | null | undefined): void;
    noteInlineTextureDestroy?(texture: GPUTexture): void;
  } | null;
}

function tileResourceBytes(resources: TileGPUResources): number {
  return (
    (resources.vertexBuffer.size ?? 0) +
    (resources.indexBuffer.size ?? 0) +
    (resources.shadowCastUB?.size ?? 0)
  );
}

function recordTileResourcesAdded(
  host: TileBuffersHost,
  resources: TileGPUResources,
): void {
  const counters = host._logicalCounters;
  if (!counters) return;
  const bytes = tileResourceBytes(resources);
  counters.tileBufferLiveEntries = (counters.tileBufferLiveEntries ?? 0) + 1;
  counters.tileBufferLiveBytes = (counters.tileBufferLiveBytes ?? 0) + bytes;
  counters.tileBufferHighWaterEntries = Math.max(
    counters.tileBufferHighWaterEntries ?? 0,
    counters.tileBufferLiveEntries,
  );
  counters.tileBufferHighWaterBytes = Math.max(
    counters.tileBufferHighWaterBytes ?? 0,
    counters.tileBufferLiveBytes,
  );
}

function recordTileResourcesRetired(
  host: TileBuffersHost,
  resources: TileGPUResources,
): void {
  const counters = host._logicalCounters;
  if (!counters) return;
  counters.tileBufferRetirements = (counters.tileBufferRetirements ?? 0) + 1;
  counters.tileBufferLiveEntries = Math.max(
    0,
    (counters.tileBufferLiveEntries ?? 0) - 1,
  );
  counters.tileBufferLiveBytes = Math.max(
    0,
    (counters.tileBufferLiveBytes ?? 0) - tileResourceBytes(resources),
  );
}

function recordTerrainShadowUniformBufferCreated(
  resources: TileGPUResources,
  byteSize: number,
): void {
  const counters = resources.shadowCastCounters;
  if (!counters) return;
  counters.terrainShadowUniformBufferCreations =
    (counters.terrainShadowUniformBufferCreations ?? 0) + 1;
  counters.terrainShadowUniformBufferWrites =
    (counters.terrainShadowUniformBufferWrites ?? 0) + 1;
  counters.terrainShadowUniformBufferLiveEntries =
    (counters.terrainShadowUniformBufferLiveEntries ?? 0) + 1;
  counters.terrainShadowUniformBufferLiveBytes =
    (counters.terrainShadowUniformBufferLiveBytes ?? 0) + byteSize;
  counters.terrainShadowUniformBufferHighWaterEntries = Math.max(
    counters.terrainShadowUniformBufferHighWaterEntries ?? 0,
    counters.terrainShadowUniformBufferLiveEntries,
  );
  counters.terrainShadowUniformBufferHighWaterBytes = Math.max(
    counters.terrainShadowUniformBufferHighWaterBytes ?? 0,
    counters.terrainShadowUniformBufferLiveBytes,
  );
  counters.tileBufferLiveBytes = (counters.tileBufferLiveBytes ?? 0) + byteSize;
  counters.tileBufferHighWaterBytes = Math.max(
    counters.tileBufferHighWaterBytes ?? 0,
    counters.tileBufferLiveBytes,
  );
}

function retireTerrainShadowCastUniformBuffer(
  resources: TileGPUResources,
): void {
  const buffer = resources.shadowCastUB;
  if (!buffer) return;

  const byteSize = buffer.size ?? TERRAIN_SHADOW_UNIFORM_SIZE;
  buffer.destroy();
  resources.shadowCastUB = undefined;
  resources.shadowCastDevice = undefined;

  const counters = resources.shadowCastCounters;
  if (!counters) return;
  counters.terrainShadowUniformBufferRetirements =
    (counters.terrainShadowUniformBufferRetirements ?? 0) + 1;
  counters.terrainShadowUniformBufferLiveEntries = Math.max(
    0,
    (counters.terrainShadowUniformBufferLiveEntries ?? 0) - 1,
  );
  counters.terrainShadowUniformBufferLiveBytes = Math.max(
    0,
    (counters.terrainShadowUniformBufferLiveBytes ?? 0) - byteSize,
  );
  counters.tileBufferLiveBytes = Math.max(
    0,
    (counters.tileBufferLiveBytes ?? 0) - byteSize,
  );
}

/** Stable per-tile cache key. Pure function — no host needed. */
export function getTileKey(tile: {
  level: number;
  x: number;
  y: number;
}): string {
  return `${tile.level}_${tile.x}_${tile.y}`;
}

export function getOrCreateTileBuffers(
  host: TileBuffersHost,
  tileKey: string,
  mesh: CesiumTerrainMesh,
): TileGPUResources | null {
  const device = host._device!;
  const generation = mesh._webgpuGeneration || 0;

  const cached = host._tileBufferCache.get(tileKey);
  // A tile's cache key (`level_x_y`) is stable across a fill/upsampled →
  // real-terrain mesh swap, and `meshGeneration` is always 0 because nothing
  // sets `mesh._webgpuGeneration`, so the generation alone never invalidates.
  // The cached buffers must therefore also have been built from the same
  // `mesh.vertices` array: when `renderedMesh` swaps in a new mesh the typed
  // array reference differs and the entry rebuilds, instead of serving stale
  // vertex data that the current per-tile uniforms decode into vertices flung
  // to Earth-radius distance (black wedge slivers). An unchanged mesh keeps
  // the identical reference, so the settled steady state is a byte-neutral
  // cache hit.
  if (
    cached &&
    cached.meshGeneration === generation &&
    cached.sourceVertices === mesh.vertices
  ) {
    const counters = host._logicalCounters;
    if (counters) {
      counters.tileBufferCacheHits = (counters.tileBufferCacheHits ?? 0) + 1;
    }
    return cached;
  }

  const counters = host._logicalCounters;
  if (counters) {
    counters.tileBufferCacheMisses = (counters.tileBufferCacheMisses ?? 0) + 1;
  }

  const replacesCachedResources = cached !== undefined;
  if (cached) {
    // Retire the optional lazy UB first so generic tile accounting subtracts
    // its bytes exactly once; the remaining record then contains VB+IB only.
    retireTerrainShadowCastUniformBuffer(cached);
    recordTileResourcesRetired(host, cached);
    cached.vertexBuffer.destroy();
    cached.indexBuffer.destroy();
    // Never leave destroyed resources addressable after a failed rebuild.
    // Validation below can legitimately return null; a later retry must see a
    // clean miss rather than retire/destroy the same dead entry again.
    host._tileBufferCache.delete(tileKey);
  }

  const vertices: Float32Array = mesh.vertices;
  let indices: Uint8Array | Uint16Array | Uint32Array = mesh.indices;
  if (!vertices || !indices || vertices.length === 0 || indices.length === 0) {
    return null;
  }

  // WebGPU does not support uint8 index format — only uint16 and uint32.
  // `TerrainFillMesh` stores indices as `Uint8Array` when `vertexCount < 256`
  // to save memory (see `TerrainFillMesh.js:1236`). Up-convert to Uint16Array
  // here so the buffer size, byte length, and declared `indexFormat` all
  // agree. Leaving the Uint8Array in place makes `indices.byteLength` equal
  // to `indexCount` (1 byte per index), so the buffer is created at half the
  // needed size while the index format is still reported as uint16; the GPU
  // then reads 2 bytes per index, walks past the end of the buffer,
  // invalidates the whole command buffer, and the globe disappears at default
  // zoom.
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

      // Prefer the inferred stride when it is valid
      if (
        inferredStride >= 3 &&
        inferredStride <= 11 &&
        vertices.length >= actualVertCount * inferredStride
      ) {
        const correctedStrideBytes = inferredStride * 4;
        const correctedVertCount = Math.floor(vbSize / correctedStrideBytes);
        if (maxIdx < correctedVertCount) {
          // Geodetic normals occupy the trailing 3 floats of the stride when
          // `encoding.hasGeodeticSurfaceNormals` is set. The inferred-stride
          // fallback only fires for fill tiles, so the encoding flag is the
          // authority here; downstream `_selectPipeline` handles the case
          // where the stride is too small to actually carry it.
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
            shadowCastMesh: mesh,
            shadowCastCounters: counters,
            shadowCastTileKey: tileKey,
          };
          if (replacesCachedResources && counters) {
            counters.tileBufferRebuilds =
              (counters.tileBufferRebuilds ?? 0) + 1;
          }
          host._tileBufferCache.set(tileKey, resources);
          recordTileResourcesAdded(host, resources);
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
    // `TerrainEncoding` flips `hasGeodeticSurfaceNormals` on when the
    // per-vertex stride is widened to include the normal (see
    // TerrainEncoding.js:320). The pipeline builder uses this flag to
    // add a `@location(2)` vec3 attribute over the trailing 12 bytes of
    // the stride and enable the `GEODETIC_NORMAL` shader define.
    hasGeodeticSurfaceNormals: encoding.hasGeodeticSurfaceNormals === true,
    meshGeneration: generation,
    sourceVertices: vertices,
    shadowCastMesh: mesh,
    shadowCastCounters: counters,
    shadowCastTileKey: tileKey,
  };

  if (replacesCachedResources && counters) {
    counters.tileBufferRebuilds = (counters.tileBufferRebuilds ?? 0) + 1;
  }
  host._tileBufferCache.set(tileKey, resources);
  recordTileResourcesAdded(host, resources);
  return resources;
}

/**
 * Packs the terrain shadow-cast variants' uniform data for a tile. Layout
 * (96 bytes, must match
 * WebGPUShadowMapRenderer.js::SHADOW_CAST_VARIANTS.quantized12):
 *
 *   offset  0: scaleAndBias: mat4x4<f32>  (from mesh.encoding.matrix)
 *   offset 64: center3D:     vec3<f32>    (from mesh.center)
 *   offset 76: _pad0:        f32
 *   offset 80: minMaxHeight: vec2<f32>
 *   offset 88: _pad1:        vec2<f32>
 *
 * Internal helper, not exported. GPU allocation and upload remain deferred
 * until a real cast pass requests them.
 * @private
 */
function packTerrainShadowUniformData(mesh: CesiumTerrainMesh): Float32Array {
  const data = new Float32Array(
    TERRAIN_SHADOW_UNIFORM_SIZE / Float32Array.BYTES_PER_ELEMENT,
  );
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
  return data;
}

/**
 * Return the persistent per-tile shadow UB, realizing it only on first cast
 * demand. Device identity is part of the realization: recovery retires the
 * old buffer before creating and uploading the replacement.
 */
export function ensureTerrainShadowCastUniformBuffer(
  device: GPUDevice,
  resources: TileGPUResources,
): GPUBuffer | undefined {
  if (resources.shadowCastUB && resources.shadowCastDevice === device) {
    return resources.shadowCastUB;
  }

  if (resources.shadowCastUB) {
    retireTerrainShadowCastUniformBuffer(resources);
  }

  let data = resources.shadowCastUniformData;
  if (!data) {
    const mesh = resources.shadowCastMesh;
    if (!mesh) return undefined;
    data = packTerrainShadowUniformData(mesh);
    resources.shadowCastUniformData = data;
    resources.shadowCastMesh = undefined;
    const counters = resources.shadowCastCounters;
    if (counters) {
      counters.terrainShadowUniformDataPacks =
        (counters.terrainShadowUniformDataPacks ?? 0) + 1;
    }
  }

  const buffer = device.createBuffer({
    label: `Terrain shadow cast UB (${resources.shadowCastTileKey ?? "tile"})`,
    size: TERRAIN_SHADOW_UNIFORM_SIZE,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  try {
    device.queue.writeBuffer(
      buffer,
      0,
      data.buffer,
      data.byteOffset,
      TERRAIN_SHADOW_UNIFORM_SIZE,
    );
  } catch (error) {
    buffer.destroy();
    throw error;
  }

  resources.shadowCastUB = buffer;
  resources.shadowCastDevice = device;
  recordTerrainShadowUniformBufferCreated(resources, buffer.size);
  return buffer;
}

interface TerrainShadowCastCommand {
  _shadowCastLayout?: string;
  _shadowCastTerrainUB?: GPUBuffer;
  _shadowCastBindGroupCacheHost?: object;
}

/**
 * Realize and publish terrain UBs for commands that will enter a real cast
 * pass. Existing direct-buffer callers remain valid when no cache host exists.
 */
export function prepareTerrainShadowCastCommandUniforms(
  device: GPUDevice,
  commands: ReadonlyArray<unknown>,
): number {
  let readyCount = 0;
  for (let i = 0; i < commands.length; i++) {
    const command = commands[i] as TerrainShadowCastCommand | undefined;
    const layout = command?._shadowCastLayout;
    if (layout !== "quantized12" && layout !== "terrainUncompressed") {
      continue;
    }

    const resources = command?._shadowCastBindGroupCacheHost as
      TileGPUResources | undefined;
    if (resources) {
      const buffer = ensureTerrainShadowCastUniformBuffer(device, resources);
      if (buffer) {
        command!._shadowCastTerrainUB = buffer;
      }
    }
    if (command?._shadowCastTerrainUB) {
      readyCount++;
    }
  }
  return readyCount;
}

export function evictStaleResources(
  host: TileBuffersHost,
  activeTileKeys: Set<string>,
): void {
  for (const [key, resources] of host._tileBufferCache) {
    if (!activeTileKeys.has(key)) {
      retireTerrainShadowCastUniformBuffer(resources);
      recordTileResourcesRetired(host, resources);
      resources.vertexBuffer.destroy();
      resources.indexBuffer.destroy();
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
    // A shared-realization entry does not own its texture, but it does own a
    // reference: dropping the map entry without releasing it orphans the
    // refcount forever, because the imagery-side cleanup is identity-guarded
    // on this same map entry and early-returns once the entry is gone.
    // Releasing here retires never-shared entries promptly through the live
    // context's deferred destroy, while ever-shared ones re-enter the table's
    // zero-ref pool. Owned-texture counters are untouched — those track
    // outright-owned direct uploads.
    if (cached.shared) {
      host._imageryTextureCache.delete(cacheKey);
      const table = host._sharedImageryRealizations;
      const ctx = host._webgpuContext;
      if (table) {
        const retired = table.release(cached.shared, (t) => {
          if (ctx) {
            ctx.scheduleTextureDestroy(t);
          } else {
            try {
              t.destroy();
            } catch {
              // Device already lost — destroy() is a safe no-op.
            }
          }
        });
        const counters = host._logicalCounters;
        if (counters) {
          if (retired) {
            counters.imageryRealizationRetirements =
              (counters.imageryRealizationRetirements ?? 0) + 1;
          }
          counters.imageryRealizationLiveBytes =
            table.getDiagnostics().liveBytes;
        }
      }
      return;
    }
    if (cached.logicalOwner === "imagery" && host._logicalCounters) {
      const counters = host._logicalCounters;
      counters.imageryOwnedRetirements =
        (counters.imageryOwnedRetirements ?? 0) + 1;
      counters.imageryOwnedLiveTextures = Math.max(
        0,
        (counters.imageryOwnedLiveTextures ?? 0) - 1,
      );
      counters.imageryOwnedLiveBytes = Math.max(
        0,
        (counters.imageryOwnedLiveBytes ?? 0) - (cached.byteSize ?? 0),
      );
    }
    // Inline destroy: stamp the texture so a same-frame pending mip job for
    // it is skipped. This texture dies immediately, unlike scheduled destroys
    // which stay live through this frame's submit.
    host._webgpuContext?.noteInlineTextureDestroy?.(cached.texture);
    cached.texture.destroy();
    host._imageryTextureCache.delete(cacheKey);
  }
}
