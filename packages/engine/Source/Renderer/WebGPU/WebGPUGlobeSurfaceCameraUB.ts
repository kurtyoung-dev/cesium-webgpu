/// <reference types="@webgpu/types" />
/**
 * Camera-uniform-buffer packing extracted from `WebGPUGlobeSurfaceRenderer`.
 *
 * Batch 152 of the audit-recommended decomposition (eighth slice of the
 * GlobeSurface decomposition arc — see
 * `migration_doc/BATCH_145_PLAN_GLOBE_SURFACE_DECOMPOSITION.md`).
 *
 * Moves the per-frame camera-UB packing logic off the renderer class:
 *
 *   - `createCameraUniformBuffer(host, device, …)` — the heavyweight
 *     (~270 LOC) per-tile UB packer. Lays out the 116-float
 *     `CameraUniforms` struct against the GlobeTerrain WGSL contract:
 *     mvpRTE, modifiedMV, modifiedMVP, encoded camera high/low,
 *     center3D high/low, sun + lighting, scaleAndBias, minMaxHeight +
 *     ellipsoid radius, 2D/Columbus tileRectangle + south/north +
 *     mercatorY, scene mode + morph time + WebMercator flag, and the
 *     DP-H41 `previousViewProjection` tail. Emits the resulting
 *     `Float32Array` through `writeUniformSlice` against the per-frame
 *     ring allocator.
 *   - `writeUniformSlice(device, frameState, data, bufferSize, label)`
 *     — pure helper that uploads a CPU-staged Float32Array slice to
 *     the per-frame ring allocator. Falls back to a one-shot buffer
 *     allocation when no allocator is available (very first frame on
 *     a fresh context). Returns `{ buffer, offset, size }` for the
 *     bind-group entry.
 *   - `computeModifiedModelView(uniformState, surfaceTile)` — pure
 *     helper that produces the `modifiedModelView` matrix used in 2D /
 *     Columbus / Morphing scene modes. Returns a Float64Array of length
 *     16 (column-major). Identity-translates the view matrix by the
 *     tile center.
 *
 * The renderer's `_createCameraUniformBuffer`, `_writeUniformSlice`,
 * and `_computeModifiedModelView` are removed entirely. The 2 callers
 * of `createCameraUniformBuffer` (in `createTileCommands` and
 * `createWireframeTileCommands`) now invoke the helper directly. The
 * 1 external caller of `writeUniformSlice` (inside the still-on-class
 * `_createTileUniformBuffer`) also calls the helper directly — it
 * will move to its own module in Batch 153.
 *
 * The 2 host fields the camera packer reaches into are flipped from
 * `private` to `public` on the renderer: `_cameraUniformData` (the
 * reusable Float32Array scratch) and `_cameraMvpScratch` (the
 * Float64Array projection × modifiedView scratch).
 *
 * @module WebGPUGlobeSurfaceCameraUB
 */

import { m4Values } from "./webgpuTypeHelpers.js";
import { assertCameraRTERoundTrip } from "./WebGPURTEAssertions.js";
import {
  CAMERA_UNIFORM_BYTES,
  multiplyMat4ColumnMajor,
} from "./WebGPUGlobeSurfaceTypes.js";

/**
 * The renderer surface the camera-UB packer reaches into.
 *
 *   - `_cameraUniformData`: the reusable Float32Array scratch buffer
 *     sized to `CAMERA_UNIFORM_FLOATS` (116 floats). Filled in by the
 *     packer and uploaded via `writeUniformSlice`.
 *   - `_cameraMvpScratch`: Float64Array of length 16 used to compute
 *     `projection × modifiedModelView` for the 2D/CV/Morphing path.
 *   - `_diagShouldLog()`: pragma-stripped throttle predicate; gates
 *     the per-tile center3D diagnostic at line ~1020 of the original.
 */
export interface CameraUBHost {
  readonly _cameraUniformData: Float32Array;
  readonly _cameraMvpScratch: Float64Array;
  _diagShouldLog(): boolean;
}

export function createCameraUniformBuffer(
  host: CameraUBHost,
  device: GPUDevice,
  uniformState: CesiumUniformState,
  surfaceTile: CesiumGlobeSurfaceTile,
  tileProvider: CesiumGlobeTileProvider,
  mesh: CesiumTerrainMesh,
  frameState?: CesiumFrameState,
  tile?: { level: number; x: number; y: number; rectangle: CesiumRectangle },
): { buffer: GPUBuffer; offset: number; size: number } {
  const data = host._cameraUniformData;
  let offset = 0;

  // mvpRelativeToEye (mat4x4, 16 floats)
  const mvpRTE = m4Values(uniformState.modelViewProjectionRelativeToEye);
  for (let i = 0; i < 16; i++) data[offset++] = mvpRTE[i];

  // modifiedModelView (mat4x4, 16 floats)
  const modifiedView = computeModifiedModelView(uniformState, surfaceTile);
  const mv = m4Values(modifiedView);
  for (let i = 0; i < 16; i++) data[offset++] = mv[i];

  // modifiedModelViewProjection (mat4x4, 16 floats) — used by 2D/CV/Morphing
  // paths in the WGSL vertex shader. Equals projection × modifiedModelView.
  // Matches WebGL u_modifiedModelViewProjection (see
  // GlobeSurfaceTileProviderRendering.js).
  const mvp = host._cameraMvpScratch;
  multiplyMat4ColumnMajor(uniformState.projection, modifiedView, mvp);
  for (let i = 0; i < 16; i++) data[offset++] = mvp[i];

  // encodedCameraHigh (vec3 + pad)
  const camHigh = uniformState.encodedCameraPositionMCHigh;
  data[offset++] = camHigh.x;
  data[offset++] = camHigh.y;
  data[offset++] = camHigh.z;
  data[offset++] = 0;

  // encodedCameraLow (vec3 + pad)
  const camLow = uniformState.encodedCameraPositionMCLow;
  data[offset++] = camLow.x;
  data[offset++] = camLow.y;
  data[offset++] = camLow.z;
  data[offset++] = 0;

  //>>includeStart('debug', pragmas.debug);
  // RTE round-trip: verify that high+low reconstructs the unencoded camera
  // position. Catches off-by-one packer bugs that swap the high/low slots
  // (visible symptom: ~6 m geometry jitter at orbital altitude).
  //
  // For terrain the model matrix is identity (`inverseModel` is identity),
  // so the MC-encoded high/low must reconstruct to `cameraPosition` (WC)
  // exactly. UniformState computes the encoded MC pair from
  // `inverseModel × cameraPosition` (UniformStateComputations.js:404-416).
  if (camHigh && camLow && uniformState.cameraPosition) {
    assertCameraRTERoundTrip(
      camHigh,
      camLow,
      uniformState.cameraPosition,
      "Globe terrain camera UB",
    );
  }
  //>>includeEnd('debug');

  // center3D (vec3 + pad) — MUST match the encoding center that vertex
  // positions are relative to. In `TerrainEncoding.encode`, each vertex
  // is stored as `(position - encoding.center)`, so the vertex shader
  // reconstructs the world position via `exaggeratedPosition + camera.center3D`.
  // If we feed `mesh.center` here but `mesh.center !== encoding.center`,
  // the reconstructed world position is wrong by exactly that delta —
  // which would produce per-tile radius variance in wireframe, matching
  // the user-reported symptom.
  //
  // Therefore: ALWAYS use `encoding.center` here, not `mesh.center`.
  // They should normally be equal, but subtle paths (TerrainFillMesh OBB
  // vs rectangle center, upsampled meshes, cloned encodings) can make
  // them diverge, and `encoding.center` is the authoritative source for
  // "the reference point the vertices were encoded against."
  const encodingCenter = mesh.encoding?.center;
  const meshCenter = mesh.center;
  const center = encodingCenter || meshCenter || { x: 0, y: 0, z: 0 };
  //>>includeStart('debug', pragmas.debug);
  if (host._diagShouldLog()) {
    const mag = Math.sqrt(
      (center.x || 0) * (center.x || 0) +
        (center.y || 0) * (center.y || 0) +
        (center.z || 0) * (center.z || 0),
    );
    // isFill check: "fill" meshes are stored separately on
    // `surfaceTile.fill.mesh`, not on `surfaceTile.mesh`. Check both.
    const fillMesh = surfaceTile.fill?.mesh;
    const isFillByRef = mesh === fillMesh;
    const isCachedMesh = mesh === surfaceTile.mesh;
    // Ctor name reveals which TerrainData class produced this mesh
    // (QuantizedMeshTerrainData / HeightmapTerrainData / Cesium3DTilesTerrainData
    // / TerrainFillMesh). The center bug is almost certainly "which
    // constructor was called with what center", so this is the
    // fingerprint we need.
    const meshCtor = mesh?.constructor?.name ?? "?";
    const encCtor = mesh?.encoding?.constructor?.name ?? "?";
    const tdCtor =
      (surfaceTile.data as { constructor?: { name?: string } } | undefined)
        ?.constructor?.name ?? "?";
    console.log(
      `[WebGPU:GlobeTile] center3D tile=${tile?.level}_${tile?.x}_${tile?.y} ` +
        `meshCtor=${meshCtor} encCtor=${encCtor} terrainDataCtor=${tdCtor} ` +
        `isFillByRef=${isFillByRef} isCachedMesh=${isCachedMesh} ` +
        `magKm=${(mag / 1000).toFixed(3)} ` +
        `center.xyz=(${(center.x || 0).toFixed(1)},${(center.y || 0).toFixed(1)},${(center.z || 0).toFixed(1)}) ` +
        `quantized=${!!mesh.encoding?.quantization}`,
    );
  }
  //>>includeEnd('debug');
  // Split center3D into high/low f32 so the SCENE3D RTE assembly in
  // GlobeTerrain.wgsl can do `(centerH - camH) + (centerL + pos - camL)`
  // without losing sub-meter precision. The encoding matches
  // `EncodedCartesian3.fromCartesian`: for each component, high =
  // reinterpret(f32(value & ~((1<<24)-1))), low = value - high. When the
  // camera is close to the tile, both (centerH - camH) and
  // (centerL - camL) are small, so the RTE sum keeps sub-meter precision.
  const cxF32 = Math.fround(center.x);
  const cyF32 = Math.fround(center.y);
  const czF32 = Math.fround(center.z);
  const splitShift = 65536.0; // 2^16
  // Canonical EncodedCartesian3 split: mask off the low ~24 bits by
  // multiplying by 2^-16, flooring, and multiplying back. This is what
  // `EncodedCartesian3.fromCartesian` does.
  const cxHigh = Math.fround(Math.floor(cxF32 / splitShift) * splitShift);
  const cyHigh = Math.fround(Math.floor(cyF32 / splitShift) * splitShift);
  const czHigh = Math.fround(Math.floor(czF32 / splitShift) * splitShift);
  const cxLow = Math.fround(cxF32 - cxHigh);
  const cyLow = Math.fround(cyF32 - cyHigh);
  const czLow = Math.fround(czF32 - czHigh);
  // center3DHigh (vec3 + pad)
  data[offset++] = cxHigh;
  data[offset++] = cyHigh;
  data[offset++] = czHigh;
  data[offset++] = 0;
  // center3DLow (vec3 + pad)
  data[offset++] = cxLow;
  data[offset++] = cyLow;
  data[offset++] = czLow;
  data[offset++] = 0;

  // sunDirectionEC (vec3) + enableLighting (f32)
  const sunDir = uniformState.sunDirectionEC;
  data[offset++] = sunDir.x;
  data[offset++] = sunDir.y;
  data[offset++] = sunDir.z;
  data[offset++] = tileProvider.enableLighting ? 1.0 : 0.0;

  // scaleAndBias (mat4x4, 16 floats) — for quantized mesh decompression
  const encoding = mesh.encoding;
  if (encoding && encoding.matrix) {
    const sbm = m4Values(encoding.matrix);
    for (let i = 0; i < 16; i++) data[offset++] = sbm[i];
  } else {
    // Identity fallback (uncompressed terrain doesn't use this)
    for (let i = 0; i < 16; i++) data[offset++] = i % 5 === 0 ? 1.0 : 0.0;
  }

  // minMaxHeight (vec2) + ellipsoidRadius (f32) + pad (f32)
  // ellipsoidRadius carries the tile provider's ellipsoid maximum radius
  // so the shader's altitude calculations work for non-WGS84 ellipsoids
  // (Mars, Moon, custom). Falls through to 0 when unavailable; the shader
  // detects a zero and substitutes the WGS84 fallback constant.
  data[offset++] = encoding?.minimumHeight ?? 0.0;
  data[offset++] = encoding?.maximumHeight ?? 0.0;
  const ell = (tileProvider?._ellipsoid ?? tileProvider?.ellipsoid) as
    | { maximumRadius?: number }
    | undefined;
  data[offset++] = ell?.maximumRadius ?? 0.0;
  data[offset++] = 0; // reserved (future minor-axis radius)

  // ─── 2D / Columbus View support ───
  // tileRectangle (vec4): west, south, east, north (radians)
  const rectangle = tile?.rectangle;
  if (rectangle) {
    data[offset++] = rectangle.west;
    data[offset++] = rectangle.south;
    data[offset++] = rectangle.east;
    data[offset++] = rectangle.north;
  } else {
    data[offset++] = 0;
    data[offset++] = 0;
    data[offset++] = 0;
    data[offset++] = 0;
  }

  // southAndNorthLatitude (vec2)
  if (rectangle) {
    data[offset++] = rectangle.south;
    data[offset++] = rectangle.north;
  } else {
    data[offset++] = 0;
    data[offset++] = 0;
  }

  // southMercatorYAndOneOverHeight (vec2)
  // Computed from tile rectangle: southMercY = log((1+sin(south))/(1-sin(south))) * 0.5
  // mercatorHeight = northMercY - southMercY
  if (rectangle) {
    const south = Math.max(rectangle.south, -1.4844222297453324);
    const north = Math.min(rectangle.north, 1.4844222297453324);
    const sinS = Math.sin(south);
    const sinN = Math.sin(north);
    const southMercY = 0.5 * Math.log((1 + sinS) / (1 - sinS));
    const northMercY = 0.5 * Math.log((1 + sinN) / (1 - sinN));
    const height = northMercY - southMercY;
    data[offset++] = southMercY;
    data[offset++] = height > 1e-9 ? 1.0 / height : 0.0;
  } else {
    data[offset++] = 0;
    data[offset++] = 0;
  }

  // sceneMode (f32): 0=MORPH, 1=COLUMBUS, 2=2D, 3=3D
  data[offset++] = frameState?.mode ?? 3;
  // morphTime (f32): 0..1, used for morphing transitions
  data[offset++] = frameState?.morphTime ?? 1.0;
  // useWebMercator (f32): 1 if Web Mercator projection, 0 if Geographic
  const projection = frameState?.mapProjection;
  const isWebMercator =
    projection &&
    projection.constructor &&
    projection.constructor.name === "WebMercatorProjection";
  data[offset++] = isWebMercator ? 1.0 : 0.0;
  data[offset++] = 0; // pad

  // ─── DP-H41: previousViewProjection (mat4x4, 16 floats, offsets 100–115)
  // `UniformState.update()` clones the current viewProjection into
  // `_previousViewProjection` before overwriting it with the new camera
  // state, so on frame N this field is the viewProjection from frame N-1.
  // TAA / motion-vector shaders consume it via `camera.previousViewProjection`.
  // Writing zeros on the very first frame (when previousViewProjection is
  // still Matrix4.IDENTITY) is fine — motion-vector consumers detect the
  // first frame via a separate "valid history" flag on their own pass.
  const prevVP = uniformState.previousViewProjection;
  if (prevVP) {
    const prev = m4Values(prevVP);
    for (let i = 0; i < 16; i++) data[offset++] = prev[i];
  } else {
    // Identity fallback keeps the shader contract stable.
    data[offset++] = 1;
    data[offset++] = 0;
    data[offset++] = 0;
    data[offset++] = 0;
    data[offset++] = 0;
    data[offset++] = 1;
    data[offset++] = 0;
    data[offset++] = 0;
    data[offset++] = 0;
    data[offset++] = 0;
    data[offset++] = 1;
    data[offset++] = 0;
    data[offset++] = 0;
    data[offset++] = 0;
    data[offset++] = 0;
    data[offset++] = 1;
  }

  const bufferSize = Math.max(CAMERA_UNIFORM_BYTES, 256);
  return writeUniformSlice(
    device,
    frameState,
    data,
    bufferSize,
    "Terrain camera UB",
  );
}

/**
 * Upload a CPU-staged Float32Array slice through the per-frame ring
 * allocator. Falls back to a fresh `createBuffer` when the allocator
 * isn't yet attached to the context (very first frame).
 *
 * Returns a `{ buffer, offset, size }` triple sized to the requested
 * `bufferSize` — NOT the allocator's 256-aligned slot size — so the
 * caller's bind-group entry binds exactly the WGSL struct width.
 *
 * Pure free function — no host needed.
 */
export function writeUniformSlice(
  device: GPUDevice,
  frameState: CesiumFrameState | undefined,
  data: Float32Array,
  bufferSize: number,
  label: string,
): { buffer: GPUBuffer; offset: number; size: number } {
  const ctx = frameState?.context as
    | (CesiumGraphicsContext & {
        uniformAllocator?: {
          allocate(size: number): { buffer: GPUBuffer; offset: number };
        };
      })
    | undefined;
  const allocator = ctx?.uniformAllocator;
  const writeBytes = Math.min(data.byteLength, bufferSize);

  if (allocator) {
    const alloc = allocator.allocate(bufferSize);
    device.queue.writeBuffer(
      alloc.buffer,
      alloc.offset,
      data.buffer,
      data.byteOffset,
      writeBytes,
    );
    // Bind exactly the requested struct size, not the allocator's
    // 256-aligned slice size. The shader struct is `bufferSize` bytes;
    // padding bytes [bufferSize, alloc.size) belong to the allocator's
    // alignment slack and may overlap into the next allocation's data
    // on the next frame. Reporting the exact struct size keeps the
    // binding view tight against the WGSL struct definition.
    return { buffer: alloc.buffer, offset: alloc.offset, size: bufferSize };
  }

  // Fallback path — only reached when the ring allocator hasn't been
  // initialized yet (e.g., very first frame on a fresh context).
  const buffer = device.createBuffer({
    label,
    size: bufferSize,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(buffer, 0, data.buffer, data.byteOffset, writeBytes);
  return { buffer, offset: 0, size: bufferSize };
}

/**
 * Compute the `modifiedModelView` matrix for 2D / Columbus View / Morphing
 * scene modes. Identity-translates the view matrix by the tile center.
 *
 * Pure free function — no host needed.
 */
export function computeModifiedModelView(
  uniformState: CesiumUniformState,
  surfaceTile: CesiumGlobeSurfaceTile,
): Float64Array {
  const view = uniformState.view;
  const center = surfaceTile.center;
  if (!center) return new Float64Array(view);

  const result = new Float64Array(16);
  for (let i = 0; i < 16; i++) result[i] = view[i];

  result[12] += view[0] * center.x + view[4] * center.y + view[8] * center.z;
  result[13] += view[1] * center.x + view[5] * center.y + view[9] * center.z;
  result[14] += view[2] * center.x + view[6] * center.y + view[10] * center.z;

  return result;
}
