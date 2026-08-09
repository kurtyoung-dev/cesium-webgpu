/// <reference types="@webgpu/types" />
/**
 * Per-frame camera-uniform-buffer packing for
 * `WebGPUGlobeSurfaceRenderer`.
 *
 *   - `createCameraUniformBuffer(host, device, …)` — the per-tile UB packer.
 *     Lays out the `CameraUniforms` struct against the GlobeTerrain WGSL
 *     contract: mvpRTE, modifiedMV, modifiedMVP, encoded camera high/low,
 *     center3D high/low, sun + lighting, scaleAndBias, minMaxHeight +
 *     ellipsoid radius, 2D/Columbus tileRectangle + south/north + mercatorY,
 *     scene mode + morph time + WebMercator flag, and the tails documented
 *     against `CAMERA_UNIFORM_FLOATS` in `WebGPUGlobeSurfaceTypes`. Emits the
 *     resulting `Float32Array` through `writeUniformSlice` against the
 *     per-frame ring allocator.
 *   - `writeUniformSlice(device, frameState, data, bufferSize, label)`
 *     — pure helper that uploads a CPU-staged Float32Array slice to
 *     the per-frame ring allocator. Falls back to a one-shot buffer
 *     allocation when no allocator is available (very first frame on
 *     a fresh context). Returns `{ buffer, offset, size }` for the
 *     bind-group entry.
 *   - `computeModifiedModelView(uniformState, mesh)` — pure helper that
 *     produces the `modifiedModelView` matrix used in 2D / Columbus /
 *     Morphing scene modes. Returns a Float64Array of length 16
 *     (column-major). Identity-translates the view matrix by the tile center.
 *
 * The two host fields the camera packer reaches into are public on the
 * renderer: `_cameraUniformData` (the reusable Float32Array scratch) and
 * `_cameraMvpScratch` (the Float64Array projection × modifiedView scratch).
 *
 * @module WebGPUGlobeSurfaceCameraUB
 */

import Cartographic from "../../Core/Cartographic.js";
import WebMercatorProjection from "../../Core/WebMercatorProjection.js";
// Reuse the exact WebGL underground-visibility predicate (cameraUnderground /
// globe translucency / backFaceCulling off / clipping planes / clipping
// polygons / cartographic limit) rather than replicating the condition here,
// which would drift. Backend-neutral pure function.
import { isUndergroundVisible } from "../../Scene/GlobeSurfaceTileProviderRendering.js";
import { m4Values } from "./webgpuTypeHelpers.js";
import { assertCameraRTERoundTrip } from "./WebGPURTEAssertions.js";
import { recordLogDepthEncoder } from "./WebGPULogDepth.js";
import {
  CAMERA_UNIFORM_BYTES,
  multiplyMat4ColumnMajor,
} from "./WebGPUGlobeSurfaceTypes.js";
// The shared cloud-shadow RTE frame owner.
import {
  type CloudShadowFrame,
  writeCloudShadowViewProjectionRelativeToEye,
} from "./WebGPUCloudShadowFrame.js";

// Scratch state for the SCENE2D / COLUMBUS_VIEW / MORPHING projected
// tile-rectangle math. Mirrors the WebGL packer's scratch instances in
// `GlobeSurfaceTileProviderRendering.js:1139-1164`. The packer is single-
// threaded per-frame, so reusing module-level scratch is safe and avoids
// per-tile allocations.
const swCarto = new Cartographic();
const neCarto = new Cartographic();
const swProj = { x: 0, y: 0, z: 0 } as { x: number; y: number; z: number };
const neProj = { x: 0, y: 0, z: 0 } as { x: number; y: number; z: number };
const projectedTileRect = { x: 0, y: 0, z: 0, w: 0 } as {
  x: number;
  y: number;
  z: number;
  w: number;
};
const rtc2D = { x: 0, y: 0, z: 0 } as { x: number; y: number; z: number };

/**
 * The renderer surface the camera-UB packer reaches into.
 *
 *   - `_cameraUniformData`: the reusable Float32Array scratch buffer
 *     sized to `CAMERA_UNIFORM_FLOATS` (232 floats). Filled in by the
 *     packer and uploaded via `writeUniformSlice`.
 *   - `_cameraMvpScratch`: Float64Array of length 16 used to compute
 *     `projection × modifiedModelView` for the 2D/CV/Morphing path.
 *   - `_diagShouldLog()`: pragma-stripped throttle predicate gating the
 *     per-tile center3D diagnostic.
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
  const ellipsoid =
    (
      tileProvider as CesiumGlobeTileProvider & {
        tilingScheme?: {
          ellipsoid?: {
            maximumRadius?: number;
            oneOverRadii?: { x: number; y: number; z: number };
          };
        };
        _ellipsoid?: {
          maximumRadius?: number;
          oneOverRadii?: { x: number; y: number; z: number };
        };
        ellipsoid?: {
          maximumRadius?: number;
          oneOverRadii?: { x: number; y: number; z: number };
        };
      }
    ).tilingScheme?.ellipsoid ??
    (
      tileProvider as CesiumGlobeTileProvider & {
        _ellipsoid?: {
          maximumRadius?: number;
          oneOverRadii?: { x: number; y: number; z: number };
        };
      }
    )._ellipsoid ??
    (
      tileProvider as CesiumGlobeTileProvider & {
        ellipsoid?: {
          maximumRadius?: number;
          oneOverRadii?: { x: number; y: number; z: number };
        };
      }
    ).ellipsoid;
  const ellipsoidInverseRadii = ellipsoid?.oneOverRadii ?? {
    x: 1.0 / 6378137.0,
    y: 1.0 / 6378137.0,
    z: 1.0 / 6356752.314245179,
  };

  // Projected-rectangle setup for SCENE2D / COLUMBUS_VIEW / MORPHING. Mirrors
  // upstream WebGL's `GlobeSurfaceTileProviderRendering.js:1139-1164`. Outside
  // SCENE3D the planar vertex path operates on projected meters, not raw
  // radians, so both the `tileRectangle` uniform and the `rtc` used by
  // `modifiedModelView` have to be in projected space. Otherwise the vertex
  // shader's
  //   `lon = mix(west, east, st.x); lat = mix(south, north, yFrac);`
  // produces radians in [-π, π] where the projection × modelView matrix
  // expects meters (millions of units), every planar vertex collapses to ~0 in
  // clip space, and the globe disappears.
  //
  // SceneMode constants: MORPHING=0, COLUMBUS_VIEW=1, SCENE2D=2, SCENE3D=3.
  const sceneMode = frameState?.mode ?? 3;
  const isPlanarMode = sceneMode !== 3; // true for MORPHING / CV / 2D
  const useRTCShift = sceneMode === 1 || sceneMode === 2; // CV or 2D
  const mapProjection = frameState?.mapProjection as
    | {
        project: (
          c: Cartographic,
          result?: { x: number; y: number; z: number },
        ) => { x: number; y: number; z: number };
      }
    | undefined;
  const tileRect = tile?.rectangle;
  let usePlanarMv = false; // whether modifiedView should use rtc2D instead of ECEF center
  if (isPlanarMode && mapProjection && tileRect) {
    swCarto.longitude = tileRect.west;
    swCarto.latitude = tileRect.south;
    swCarto.height = 0;
    neCarto.longitude = tileRect.east;
    neCarto.latitude = tileRect.north;
    neCarto.height = 0;
    mapProjection.project(swCarto, swProj);
    mapProjection.project(neCarto, neProj);

    projectedTileRect.x = swProj.x;
    projectedTileRect.y = swProj.y;
    projectedTileRect.z = neProj.x;
    projectedTileRect.w = neProj.y;

    if (useRTCShift) {
      // rtc.x = 0 (height axis is X in planar earth convention).
      // rtc.y/z = projected tile center, then shift rect to be relative.
      rtc2D.x = 0;
      rtc2D.y = (projectedTileRect.z + projectedTileRect.x) * 0.5;
      rtc2D.z = (projectedTileRect.w + projectedTileRect.y) * 0.5;
      projectedTileRect.x -= rtc2D.y;
      projectedTileRect.y -= rtc2D.z;
      projectedTileRect.z -= rtc2D.y;
      projectedTileRect.w -= rtc2D.z;
      usePlanarMv = true;
    }
  }

  // mvpRelativeToEye (mat4x4, 16 floats)
  const mvpRTE = m4Values(uniformState.modelViewProjectionRelativeToEye);
  for (let i = 0; i < 16; i++) data[offset++] = mvpRTE[i];

  // modifiedModelView (mat4x4, 16 floats).
  //
  // The centre source must be a mesh, never a `GlobeSurfaceTile`: WebGL's
  // `GlobeSurfaceTileProviderRendering.js:1120` reads `rtc = mesh.center` and
  // feeds that to `u_modifiedModelView`, and `GlobeSurfaceTile` has no
  // `center` property at all, so passing one makes
  // `computeModifiedModelView` fall back to the plain view matrix. With a
  // plain view, `view × position_tile_local` yields a huge camera-relative
  // position — the tile-local position is at most a few hundred meters while
  // the translation column of `view` is the negative camera position in world
  // coordinates (~6.4 Mm for Earth-surface views). The resulting
  // `v_positionEC` magnitude crosses 100 km on every fragment, `v_distance`
  // goes huge, and `computeFog(v_distance, density, mod)` saturates to 1.0 at
  // every pixel, wiping imagery to a uniform fog color below the horizon.
  //
  // SCENE2D / COLUMBUS_VIEW override: substitute the projected tile-center
  // rtc for `mesh.center`. The ECEF center is meaningless in planar modes —
  // it sits on the WGS84 ellipsoid in 3D space, ~6.4 Mm from the projected
  // origin — so feeding it to `setTranslation(view, view×rtc)` translates the
  // view to an impossible eye-space point and the planar geometry never
  // reaches clip space. Mirrors the `rtc` assignment at
  // `GlobeSurfaceTileProviderRendering.js:1156-1163`.
  //
  // MORPHING override (mode 0): use a plain view with no center baked, so the
  // morph branch's `modifiedModelView(Projection)` equals WebGL's plain
  // `czm_modelView` / `czm_projection`. The WGSL MORPHING branch feeds these
  // matrices a world-space position (`position3DWC = exaggeratedPosition +
  // center3D`, plus an absolute-projected planar position), so baking
  // `view × mesh.center` adds the tile center a second time — a ~6.4 Mm
  // per-tile eye-space offset that splays the globe apart through every
  // transition. WebGL's `getPositionMorphingMode` (GlobeVS.glsl:172-182) uses
  // `czm_modelView`, which is the plain view because the globe command has an
  // identity modelMatrix, and not the center-baked `u_modifiedModelView`,
  // which it uses only for the 3D/CV/2D planar `getPositionPlanarEarth` path
  // with tile-local positions. `computeModifiedModelView` returns the plain
  // view when handed a source with no `center`.
  const rtcSource = usePlanarMv
    ? { center: rtc2D }
    : sceneMode === 0 /* MORPHING */
      ? { center: undefined }
      : // SCENE3D RTC: modifiedModelViewProjection bakes view×center, and the
        // SCENE3D vertex branch multiplies it by the tile-local position with
        // encoding.center pre-subtracted. For out.position to land at the true
        // world position the baked center has to equal the vertex encoding
        // center — the same center the center3D split below uses.
        // `mesh.center` normally equals it but diverges for TerrainFillMesh,
        // upsampled, and cloned encodings, so the authoritative encode
        // reference `encoding.center` is used instead and divergent tiles do
        // not render offset.
        { center: mesh.encoding?.center ?? mesh.center };
  const modifiedView = computeModifiedModelView(uniformState, rtcSource);
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
  // Reuse the three existing vec3 alignment lanes for the rendered globe
  // ellipsoid's inverse radii. The fragment horizon test consumes them, and
  // riding the existing lanes costs no CameraUniforms growth and no additional
  // upload bytes.
  data[offset++] = ellipsoidInverseRadii.x;

  // encodedCameraLow (vec3 + pad)
  const camLow = uniformState.encodedCameraPositionMCLow;
  data[offset++] = camLow.x;
  data[offset++] = camLow.y;
  data[offset++] = camLow.z;
  data[offset++] = ellipsoidInverseRadii.y;

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

  // center3D (vec3 + pad) has to match the encoding center that vertex
  // positions are relative to. `TerrainEncoding.encode` stores each vertex as
  // `(position - encoding.center)`, so the vertex shader reconstructs the
  // world position via `exaggeratedPosition + camera.center3D`. Writing
  // `mesh.center` here when it differs from `encoding.center` leaves the
  // reconstructed world position wrong by exactly that delta, which shows up
  // as per-tile radius variance in wireframe.
  //
  // The two are normally equal, but subtle paths (TerrainFillMesh OBB versus
  // rectangle center, upsampled meshes, cloned encodings) make them diverge,
  // and `encoding.center` is the authoritative reference point the vertices
  // were encoded against.
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
    // The constructor name reveals which TerrainData class produced this mesh
    // (QuantizedMeshTerrainData / HeightmapTerrainData /
    // Cesium3DTilesTerrainData / TerrainFillMesh), which is the fingerprint
    // for tracing a wrong centre back to the constructor that supplied it.
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
  // Split center3D into a high/low f32 pair so the SCENE3D RTE assembly in
  // GlobeTerrain.wgsl can compute `(centerH - camH) + (centerL + pos - camL)`
  // without losing sub-meter precision. The encoding matches
  // `EncodedCartesian3.fromCartesian`: for each component, high =
  // reinterpret(f32(value & ~((1<<24)-1))), low = value - high. With the
  // camera close to the tile both (centerH - camH) and (centerL - camL) are
  // small, so the RTE sum keeps sub-meter precision.
  //
  // The split runs on the full f64 value, matching `EncodedCartesian3.encode`
  // including its sign branch and the encodedCamera side this is subtracted
  // from in GlobeTerrain.wgsl. Rounding the centre to f32 before splitting
  // destroys the sub-meter residual `low` has to carry and leaves a per-tile
  // world-space offset of ~0.012 m near Earth radius — sub-pixel up close, but
  // at orbit distance it throws limb-tile vertices to garbage and tears the
  // globe mesh into radial wedge gaps. Splitting the f64 value keeps `low`
  // near sub-centimetre before it is stored as f32.
  const splitShift = 65536.0; // 2^16
  const cxHigh =
    center.x >= 0.0
      ? Math.floor(center.x / splitShift) * splitShift
      : -Math.floor(-center.x / splitShift) * splitShift;
  const cyHigh =
    center.y >= 0.0
      ? Math.floor(center.y / splitShift) * splitShift
      : -Math.floor(-center.y / splitShift) * splitShift;
  const czHigh =
    center.z >= 0.0
      ? Math.floor(center.z / splitShift) * splitShift
      : -Math.floor(-center.z / splitShift) * splitShift;
  const cxLow = center.x - cxHigh;
  const cyLow = center.y - cyHigh;
  const czLow = center.z - czHigh;
  // center3DHigh (vec3 + pad)
  data[offset++] = cxHigh;
  data[offset++] = cyHigh;
  data[offset++] = czHigh;
  data[offset++] = ellipsoidInverseRadii.z;
  // center3DLow (vec3 + pad)
  data[offset++] = cxLow;
  data[offset++] = cyLow;
  data[offset++] = czLow;
  data[offset++] = 0;

  // sunDirectionEC (vec3) + enableLighting (f32).
  //
  // The value packed is `lightDirectionEC`, the scene light direction, not
  // `sunDirectionEC`. With a SunLight the two are identical (see
  // `UniformState.update` lines 836-844), but when the scene overrides
  // `scene.light` with a custom `DirectionalLight` — Bathymetry's per-frame
  // hillshade direction, for instance — only `lightDirectionEC` reflects the
  // user-set value. Upstream `GlobeFS.glsl` references
  // `czm_lightDirectionEC` everywhere; packing `sunDirectionEC` here makes
  // the Lambert term and day/night fade read the wrong direction and renders
  // custom-light demos dark. The WGSL field keeps the name `sunDirectionEC`
  // for compatibility with existing shader code; the name is a misnomer that
  // a rename would have to fix on both sides at once.
  const lightDir = uniformState.lightDirectionEC;
  data[offset++] = lightDir.x;
  data[offset++] = lightDir.y;
  data[offset++] = lightDir.z;
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
  data[offset++] = ellipsoid?.maximumRadius ?? 0.0;
  data[offset++] = 0; // reserved (future minor-axis radius)

  // tileRectangle (vec4): planar modes pack the projected rectangle in meters,
  // relative to rtc2D for SCENE2D / COLUMBUS_VIEW and absolute for MORPHING.
  // SCENE3D packs raw radians, since `computePlanarPosition` is not invoked in
  // the 3D vertex branch. See the projected-rectangle setup near the top of
  // this function.
  const rectangle = tile?.rectangle;
  if (isPlanarMode && mapProjection && rectangle) {
    data[offset++] = projectedTileRect.x;
    data[offset++] = projectedTileRect.y;
    data[offset++] = projectedTileRect.z;
    data[offset++] = projectedTileRect.w;
  } else if (rectangle) {
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
  // useWebMercator (f32): 1 if Web Mercator projection, 0 if Geographic.
  // Tested with `instanceof` rather than
  // `constructor.name === "WebMercatorProjection"`: esbuild's
  // minifyIdentifiers renames the class in release builds, so the string
  // compare silently returns false and the globe reverts to
  // geographic-linear latitude spacing — vertical tile warping at mid and
  // high latitudes — in minified 2D, Columbus View and morph. Mirrors WebGL
  // GlobeSurfaceTileProviderRendering.js:1201 (`projection instanceof WebMercatorProjection`).
  const projection = frameState?.mapProjection;
  const isWebMercator = projection instanceof WebMercatorProjection;
  data[offset++] = isWebMercator ? 1.0 : 0.0;
  data[offset++] = 0; // pad

  // previousViewProjection (mat4x4, 16 floats, offsets 100-115).
  // `UniformState.update()` clones the current viewProjection into
  // `_previousViewProjection` before overwriting it with the new camera
  // state, so on frame N this field is the viewProjection from frame N-1.
  // TAA and motion-vector shaders consume it via
  // `camera.previousViewProjection`. Identity on the very first frame is
  // harmless: motion-vector consumers detect the first frame through a
  // separate "valid history" flag on their own pass.
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

  // Ground-atmosphere parameters for the per-vertex ray-march. All values
  // default to the constants in `Source/Scene/Atmosphere.js` so the
  // first-frame render matches WebGL out of the box. Scene-level setters
  // (`scene.atmosphere.rayleighCoefficient = ...`) flow through to
  // `uniformState.atmosphere*` on update and are read here when present.
  //
  // atmosphereLightDirectionAndIntensity (vec4): xyz = light direction WC
  //   (sun by default — matches `DYNAMIC_ATMOSPHERE_LIGHTING_FROM_SUN`),
  //   w = light intensity (default 10.0).
  // Ground-atmosphere parameters live on the Globe, reached through
  // `tileProvider.*`, rather than on `scene.atmosphere.*`. The
  // Atmosphere.html demo sets
  // `globe.atmosphereLightIntensity = 20.0` which the Globe.update path
  // copies onto the tileProvider. WebGL reads these via
  // `tileProvider.atmosphereLightIntensity` etc. SkyAtmosphere uses a
  // separate `scene.atmosphere.*` config — kept distinct so demos like
  // Atmosphere.html can independently tune ground vs sky.
  const tp = tileProvider as unknown as {
    atmosphereLightIntensity?: number;
    atmosphereRayleighCoefficient?: { x: number; y: number; z: number };
    atmosphereMieCoefficient?: { x: number; y: number; z: number };
    atmosphereRayleighScaleHeight?: number;
    atmosphereMieScaleHeight?: number;
    atmosphereMieAnisotropy?: number;
    dynamicAtmosphereLighting?: boolean;
    dynamicAtmosphereLightingFromSun?: boolean;
    showGroundAtmosphere?: boolean;
    enableLighting?: boolean;
    hasWaterMask?: boolean;
    // Lambert coefficient uniforms. Defaults come from Globe.js (0.9 / 0.3)
    // and propagate to the tile provider via Globe.beginFrame.
    lambertDiffuseMultiplier?: number;
    vertexShadowDarkness?: number;
    // `u_zoomedOutOceanSpecularIntensity` mirror, driven per frame by
    // Globe.beginFrame: 0.4 with ground atmosphere, 0.5 without, 0.0 outside
    // SCENE3D.
    zoomedOutOceanSpecularIntensity?: number;
    // Surface terrain provider exposes `hasVertexNormals` — when true, the
    // WebGL pipeline cache enables ENABLE_VERTEX_LIGHTING; the WGSL Lambert
    // path mirrors that gate at runtime.
    terrainProvider?: { hasVertexNormals?: boolean };
  };
  const us = uniformState as unknown as {
    sunDirectionWC?: { x: number; y: number; z: number };
    lightDirectionWC?: { x: number; y: number; z: number };
    // `czm_lightColor` mirror. UniformState computes it as `lightColorHdr`
    // clipped so the brightest channel is at most 1.
    lightColor?: { x: number; y: number; z: number };
  };
  const fs = frameState as
    | (CesiumFrameState & {
        fog?: { enabled?: boolean };
      })
    | undefined;
  // Light direction WC mirrors WebGL's choice between `czm_sunDirectionWC`
  // (under `DYNAMIC_ATMOSPHERE_LIGHTING_FROM_SUN`) and
  // `czm_lightDirectionWC` otherwise. When dynamic lighting is off entirely,
  // WebGL substitutes `normalize(positionWC)` in the VS; a global direction is
  // always passed here and the VS handles the per-vertex fallback, which costs
  // nothing extra because the ray-march already uses positionWC as its inner
  // radius source.
  const lightWC = tp.dynamicAtmosphereLightingFromSun
    ? (us.sunDirectionWC ?? us.lightDirectionWC)
    : (us.lightDirectionWC ?? us.sunDirectionWC);
  data[offset++] = lightWC?.x ?? 0.0;
  data[offset++] = lightWC?.y ?? 0.0;
  data[offset++] = lightWC?.z ?? 1.0;
  data[offset++] = tp.atmosphereLightIntensity ?? 10.0;

  // Rayleigh coefficient + scale height. Defaults match Globe.js init
  // (rayleighCoefficient = (5.5e-6, 13e-6, 28.4e-6), scaleHeight =
  // 10000). Sourced from tileProvider, not scene.atmosphere.
  const rC = tp.atmosphereRayleighCoefficient;
  data[offset++] = rC?.x ?? 5.5e-6;
  data[offset++] = rC?.y ?? 13.0e-6;
  data[offset++] = rC?.z ?? 28.4e-6;
  data[offset++] = tp.atmosphereRayleighScaleHeight ?? 10000.0;

  // Mie coefficient + scale height. Defaults: mieCoefficient = (21e-6,
  // 21e-6, 21e-6) — grey, wavelength-independent. mieScaleHeight = 3200.
  const mC = tp.atmosphereMieCoefficient;
  data[offset++] = mC?.x ?? 21.0e-6;
  data[offset++] = mC?.y ?? 21.0e-6;
  data[offset++] = mC?.z ?? 21.0e-6;
  data[offset++] = tp.atmosphereMieScaleHeight ?? 3200.0;

  // Atmosphere params: anisotropy, inner radius, outer radius, enable.
  data[offset++] = tp.atmosphereMieAnisotropy ?? 0.9;
  // Inner radius = max ellipsoid radius (WGS84 = 6378137). Match the
  // value already passed via `ellipsoidRadius` so the VS ray-march and
  // FS lookups agree on the planet size.
  const innerRadius =
    (
      tileProvider as unknown as {
        ellipsoid?: { maximumRadius?: number };
        _ellipsoid?: { maximumRadius?: number };
      }
    )?.ellipsoid?.maximumRadius ??
    (
      tileProvider as unknown as {
        _ellipsoid?: { maximumRadius?: number };
      }
    )?._ellipsoid?.maximumRadius ??
    6378137.0;
  data[offset++] = innerRadius;
  // Outer radius: inner + atmosphere thickness. Atmosphere.js uses
  // ATMOSPHERE_THICKNESS = 111e3 m — kept in sync with AtmosphereCommon.glsl.
  data[offset++] = innerRadius + 111000.0;
  // Enable flag: fog enabled OR ground atmosphere enabled. Either
  // triggers the per-vertex ray-march. When both are off, the VS skips
  // the ray-march entirely (zero per-vertex cost). `showGroundAtmosphere`
  // is mirrored from Globe.js onto tileProvider; fog.enabled comes from
  // the per-frame Fog.update.
  // When the unified aerial-perspective post-process owns the atmosphere, the
  // in-globe ground-atmosphere and fog drape are gated off so the two do not
  // double-apply. The flag is the canonical per-frame one Scene publishes onto
  // frameState, the same pattern as `taaEnabled`. WebGL never sets it, so this
  // is a no-op there.
  const aerialPerspectiveActive =
    (frameState as { aerialPerspective?: boolean })?.aerialPerspective === true;
  const fogEnabled = !aerialPerspectiveActive && fs?.fog?.enabled !== false;
  const groundAtmoEnabled =
    !aerialPerspectiveActive && tp.showGroundAtmosphere !== false;
  // `atmosphereParams.w` encodes both the enable flag and the lighting mode:
  //
  //   0.0 → atmosphere off (skip per-vertex ray-march entirely)
  //   1.0 → atmosphere on, "static" lighting (the WebGL `dynamicLighting`
  //         bool evaluates to false). VS substitutes per-vertex
  //         `normalize(positionWC)` for the light direction, mirroring
  //         WebGL's `czm_branchFreeTernary(dynamicLighting, …,
  //         normalize(positionWC))` fallback at GlobeFS.glsl line 494.
  //         Every vertex sees a "straight up" light ray, so the
  //         integrated optical depth is uniform across the planet (the
  //         simplified flat-light model WebGL ships when lighting is off
  //         or atmosphere lighting is NONE).
  //   2.0 → atmosphere on, dynamic lighting active: real sun direction plus
  //         the FS darken/sunlitAtmosphereIntensity day-night mix.
  //
  // WebGL computes `dynamicLighting = DYNAMIC_ATMOSPHERE_LIGHTING &&
  // (ENABLE_VERTEX_LIGHTING || ENABLE_DAYNIGHT_SHADING)`. The first define
  // follows `tileProvider.dynamicAtmosphereLighting`; the latter two are gated
  // by `enableLighting` in GlobeSurfaceShaderSet. The default scene has
  // `enableLighting = false`, so WebGL's `dynamicLighting` evaluates to false
  // even though `dynamicAtmosphereLighting` defaults to true. The WGSL has to
  // reproduce that AND-gate, or the per-vertex march accumulates roughly 7-10x
  // more radiance than the WebGL flat-light reference.
  //
  // The WGSL `w > 0.5` enable check passes for both 1.0 and 2.0; a separate
  // `w > 1.5` check gates the dynamic-lighting branch.
  const atmoEnabled = fogEnabled || groundAtmoEnabled;
  const dynamicLightingActive =
    !!tp.dynamicAtmosphereLighting && !!tp.enableLighting;
  data[offset++] = atmoEnabled ? (dynamicLightingActive ? 2.0 : 1.0) : 0.0;

  // czm_lightColor (vec4, offset 132-135). Mirrors WebGL's `czm_lightColor`
  // automatic uniform. UniformState computes `_lightColor` as `lightColorHdr`
  // clipped so the brightest channel is at most 1 (see
  // UniformState.js:855-878). When the scene provides a custom light
  // (`scene.light.color = Color.ORANGE`), the WGSL globe Lambert path
  // multiplies the diffuse term by this color, matching WebGL's
  // ENABLE_VERTEX_LIGHTING / ENABLE_DAYNIGHT_SHADING paths. The default
  // uniform value is (1,1,1), so uncustomized scenes are visually unchanged.
  const lc = us.lightColor;
  if (lc) {
    data[offset++] = lc.x;
    data[offset++] = lc.y;
    data[offset++] = lc.z;
  } else {
    // UniformState has not been updated yet on an extremely early frame.
    // White multiplies by 1 and leaves the diffuse term untouched.
    data[offset++] = 1.0;
    data[offset++] = 1.0;
    data[offset++] = 1.0;
  }
  data[offset++] = 0.0; // .w reserved

  // lighting (vec4, offset 136-139): the tile-provider-driven Lambert
  // coefficients, mirroring WebGL's `u_lambertDiffuseMultiplier` +
  // `u_vertexShadowDarkness` fragment uniforms. The WGSL Lambert path gates on
  // `.z` (hasVertexNormals) to match WebGL's ENABLE_VERTEX_LIGHTING gating,
  // which is a compile-time #ifdef in WebGL and a runtime branch in WGSL.
  //
  // A tile provider that has not been populated yet, on an extremely early
  // frame, still gets the Globe.js defaults written so the WGSL branch is
  // well-defined.
  const lambertMult = tp.lambertDiffuseMultiplier;
  const shadowDark = tp.vertexShadowDarkness;
  data[offset++] = typeof lambertMult === "number" ? lambertMult : 0.9;
  data[offset++] = typeof shadowDark === "number" ? shadowDark : 0.3;
  const hasNormals = !!tp.terrainProvider?.hasVertexNormals;
  data[offset++] = hasNormals ? 1.0 : 0.0;
  // .w mirrors `u_zoomedOutOceanSpecularIntensity`. Globe.beginFrame drives it
  // per frame: 0.4 with the default showGroundAtmosphere, 0.5 without, 0.0
  // outside SCENE3D. Consumed by computeEnhancedOcean's specular
  // surfaceReflectance in GlobeTerrain.wgsl.
  const zoomedOutSpec = tp.zoomedOutOceanSpecularIntensity;
  data[offset++] = typeof zoomedOutSpec === "number" ? zoomedOutSpec : 0.5;

  // Log-depth tail (vec4: near, far, factor, reserved), read by
  // GlobeTerrain.wgsl's `//>>ifdef LOG_DEPTH` blocks as `camera.logDepth`. It
  // carries the live frustum scalars regardless of the flag and is inert on
  // any frame where the LOG_DEPTH pipeline define is not set — that is,
  // whenever `isWebGPULogDepthActive(context, frameState)` is false because
  // the master switch is off or `frameState.useLogDepth` was cleared by 2D,
  // Columbus View, or an orthographic frustum. The globe UB carries these at
  // its tail rather than in the shared CameraUniforms .w lanes (see
  // WebGPULogDepth.ts).
  const usLog = uniformState as unknown as {
    currentFrustum?: { x: number; y: number };
    oneOverLog2FarDepthFromNearPlusOne?: number;
  };
  const ldNear = usLog.currentFrustum?.x ?? 0.0;
  const ldFar = usLog.currentFrustum?.y ?? 0.0;
  let ldFactor = usLog.oneOverLog2FarDepthFromNearPlusOne ?? 0.0;
  if (!(ldFactor > 0.0) && ldFar > ldNear) {
    const log2Far = Math.log2(ldFar - ldNear + 1.0);
    ldFactor = log2Far > 0.0 ? 1.0 / log2Far : 0.0;
  }
  data[offset++] = ldNear;
  data[offset++] = ldFar;
  data[offset++] = ldFactor;
  data[offset++] = 0.0; // reserved
  //>>includeStart('debug', pragmas.debug);
  // Publish the pair this tile's camera UB actually baked. The globe is the
  // reference every other producer's frag_depth is compared against, so its
  // baked pair is half of every depth verdict in the scene. Per-tile but
  // pragma-stripped from release builds, and the last tile wins: they all pack
  // from the same `uniformState` read within one update phase, and a
  // divergence between them is itself the finding.
  recordLogDepthEncoder(uniformState, "globe", ldNear, ldFar, ldFactor);
  //>>includeEnd('debug');

  // Globe pick color tail (vec4, offsets 144-147), read only by
  // GlobeTerrain.wgsl::fragmentPickMain, the pick-pass entry point.
  // `Globe.beginFrame` stashes the globe's registered pick-ID color on
  // `tileProvider._webgpuGlobePickColor` when `globe.pickable` is true and
  // clears it otherwise. With (0,0,0,0) the pick FBO still receives globe
  // depth, so `scene.pickPosition` works over terrain the way WebGL's
  // `updateForPick` re-push provides, but the zero pick color leaves
  // `scene.pick` undefined over the globe, matching WebGL. A non-zero color
  // makes `scene.pick` return the Globe.
  const pickColor = (
    tileProvider as unknown as {
      _webgpuGlobePickColor?: {
        red: number;
        green: number;
        blue: number;
        alpha: number;
      } | null;
    }
  )?._webgpuGlobePickColor;
  if (pickColor) {
    data[offset++] = pickColor.red;
    data[offset++] = pickColor.green;
    data[offset++] = pickColor.blue;
    data[offset++] = pickColor.alpha;
  } else {
    data[offset++] = 0.0;
    data[offset++] = 0.0;
    data[offset++] = 0.0;
    data[offset++] = 0.0;
  }

  // Sun-view beer shadow map tail:
  // cloudShadowVP (mat4, offsets 148-163) + cloudShadowControl (vec4, 164-167).
  // The procedural cloud renderer stashes the world-to-sun-clip matrix and an
  // "active" flag on `context._cloudCache` after rendering the map, which
  // happens after the globe terrain pass, so terrain reads the previous
  // frame's matrix — acceptable for a slow, soft cloud shadow. When inactive,
  // which covers the default and the very first frame before the cloud
  // renderer runs, the packer writes identity plus control.x = 0 so the FS
  // gate stays closed and the render is byte-identical.
  const cloudCache = (
    frameState?.context as unknown as {
      _cloudCache?: {
        shadowActive?: boolean;
        shadowSunViewVP?: Float32Array;
        shadowAbsorption?: number;
        // Eclipse-aware cast-shadow strength, published by the cloud renderer
        // through this same seam. The `?? 1.0` fallback covers any frame that
        // has not published one.
        shadowStrength?: number;
        shadowCascadeActive?: boolean;
        shadowCascadeVP?: Float32Array;
        shadowFrame?: CloudShadowFrame;
        shadowCascadeFrames?: CloudShadowFrame[];
      };
    }
  )?._cloudCache;
  const shadowActive = cloudCache?.shadowActive === true;
  const shadowVP = cloudCache?.shadowSunViewVP;
  // Project through the eye-relative sun-view matrix.
  // `cloudShadowVP * vec4(v_positionMC, 1.0)` is the planet-scale
  // `mvp * vec4(position, 1.0)` the fork's RTE law forbids: both the matrix
  // translation column and the position are ~6.4e6 m in f32. In SCENE3D the
  // fragment already carries `v_positionRTE`, the exact high/low
  // camera-relative vector CSM samples with, so the shared cloud-shadow frame
  // owner emits the matrix relative to this packer's camera and the product
  // stays small.
  //
  // The planar modes have no ECEF camera-relative fragment position, so they
  // keep the absolute matrix and `v_positionMC`.
  const cloudShadowFrame = cloudCache?.shadowFrame;
  const cloudShadowCascadeFrames = cloudCache?.shadowCascadeFrames;
  const cloudShadowEyeX = camHigh.x + camLow.x;
  const cloudShadowEyeY = camHigh.y + camLow.y;
  const cloudShadowEyeZ = camHigh.z + camLow.z;
  // The opt-in cascade tier renders a 3-cascade atlas and stashes three
  // forward VPs (48 floats). Cascade 0 goes in the cloudShadowVP field above;
  // cloudShadowControl.w carries the cascade count (3.0) so the FS takes the
  // cascade branch. Cascades 1 and 2 are appended at the struct tail below.
  const cascadeActive = cloudCache?.shadowCascadeActive === true;
  const cascadeVP = cloudCache?.shadowCascadeVP;
  const cascadeReady = cascadeActive && !!cascadeVP && cascadeVP.length >= 48;
  // The flag the FS reads applies to every matrix in the struct at once: a mix
  // of eye-relative and absolute VPs would silently project the wrong operand
  // through one cascade. Every frame this branch will emit must therefore be
  // valid.
  const cloudShadowRelativeToEye =
    sceneMode === 3 &&
    cloudShadowFrame?.valid === true &&
    (!cascadeReady ||
      (cloudShadowCascadeFrames?.length === 3 &&
        cloudShadowCascadeFrames.every((frame) => frame.valid)));
  if (cascadeReady) {
    if (cloudShadowRelativeToEye && cloudShadowCascadeFrames?.[0]) {
      writeCloudShadowViewProjectionRelativeToEye(
        data,
        offset,
        cloudShadowCascadeFrames[0],
        cloudShadowEyeX,
        cloudShadowEyeY,
        cloudShadowEyeZ,
      );
      offset += 16;
    } else {
      for (let i = 0; i < 16; i++) data[offset++] = cascadeVP![i]; // cascade 0 VP
    }
    data[offset++] = 1.0; // x = enabled
    data[offset++] = cloudCache?.shadowAbsorption ?? 0.04; // y = absorption
    data[offset++] = cloudCache?.shadowStrength ?? 1.0; // z = strength
    data[offset++] = 3.0; // w = cascade count (cascaded atlas branch)
  } else if (shadowActive && shadowVP && shadowVP.length >= 16) {
    if (cloudShadowRelativeToEye) {
      writeCloudShadowViewProjectionRelativeToEye(
        data,
        offset,
        cloudShadowFrame!,
        cloudShadowEyeX,
        cloudShadowEyeY,
        cloudShadowEyeZ,
      );
      offset += 16;
    } else {
      for (let i = 0; i < 16; i++) data[offset++] = shadowVP[i];
    }
    data[offset++] = 1.0; // x = enabled
    data[offset++] = cloudCache?.shadowAbsorption ?? 0.04; // y = absorption
    data[offset++] = cloudCache?.shadowStrength ?? 1.0; // z = strength
    data[offset++] = 0.0; // w = cascade count 0 (single-map branch)
  } else {
    // Identity matrix + disabled control (byte-identical default).
    data[offset++] = 1.0;
    data[offset++] = 0.0;
    data[offset++] = 0.0;
    data[offset++] = 0.0;
    data[offset++] = 0.0;
    data[offset++] = 1.0;
    data[offset++] = 0.0;
    data[offset++] = 0.0;
    data[offset++] = 0.0;
    data[offset++] = 0.0;
    data[offset++] = 1.0;
    data[offset++] = 0.0;
    data[offset++] = 0.0;
    data[offset++] = 0.0;
    data[offset++] = 0.0;
    data[offset++] = 1.0;
    data[offset++] = 0.0; // x = disabled
    data[offset++] = 0.0;
    data[offset++] = 0.0;
    data[offset++] = 0.0;
  }

  // Underground tint tail (offsets 168-179): undergroundColor (vec4) +
  // undergroundColorAlphaByDistance (vec4) + undergroundControl (vec4).
  // Mirrors the WebGL uniforms `u_undergroundColor` /
  // `u_undergroundColorAlphaByDistance` plus the `showUndergroundColor`
  // compile-time gate from GlobeSurfaceTileProviderRendering.js:1212-1217; the
  // gate becomes `undergroundControl.x` because WGSL branches at runtime.
  // `Globe.render` mirrors `globe.undergroundColor` /
  // `globe.undergroundColorAlphaByDistance` onto the tile provider each frame
  // (Globe.js:1420-1422). `undergroundControl.y` carries
  // `max(czm_eyeHeight, 0)`, which the FS subtracts from `v_distance` before
  // the NearFarScalar ramp exactly as GlobeFS.glsl line 738 does. All-zero,
  // gate closed, when the condition fails, keeping the default render
  // byte-identical.
  const ugTp = tileProvider as unknown as {
    undergroundColor?: {
      red: number;
      green: number;
      blue: number;
      alpha: number;
    };
    undergroundColorAlphaByDistance?: {
      near: number;
      nearValue: number;
      far: number;
      farValue: number;
    };
  };
  const ugColor = ugTp.undergroundColor;
  const ugAlphaByDistance = ugTp.undergroundColorAlphaByDistance;
  const showUndergroundColor =
    frameState !== undefined &&
    sceneMode === 3 /* SCENE3D */ &&
    ugColor !== undefined &&
    ugColor.alpha > 0.0 &&
    ugAlphaByDistance !== undefined &&
    (ugAlphaByDistance.nearValue > 0.0 || ugAlphaByDistance.farValue > 0.0) &&
    isUndergroundVisible(tileProvider, frameState) === true;
  if (showUndergroundColor && ugColor && ugAlphaByDistance) {
    data[offset++] = ugColor.red;
    data[offset++] = ugColor.green;
    data[offset++] = ugColor.blue;
    data[offset++] = ugColor.alpha;
    data[offset++] = ugAlphaByDistance.near;
    data[offset++] = ugAlphaByDistance.nearValue;
    data[offset++] = ugAlphaByDistance.far;
    data[offset++] = ugAlphaByDistance.farValue;
    data[offset++] = 1.0; // x = show flag
    data[offset++] = Math.max(uniformState.eyeHeight ?? 0.0, 0.0);
    data[offset++] = 0.0;
    data[offset++] = 0.0;
  } else {
    for (let i = 0; i < 12; i++) data[offset++] = 0.0;
  }

  // Translucent-globe alpha tail (180-191):
  // translucencyFrontAlphaByDistance (vec4) + translucencyBackAlphaByDistance
  // (vec4) + translucencyControl (vec4). Mirrors the WebGL uniforms
  // `u_frontFaceAlphaByDistance` / `u_backFaceAlphaByDistance`
  // (GlobeSurfaceTileProviderRendering.js:1487-1509): each NearFarScalar is
  // resolved by GlobeTranslucencyState.update (frontFaceAlpha ×
  // frontFaceAlphaByDistance etc.), and the camera-underground front/back
  // swap is applied CPU-side. `translucencyControl.x` mirrors the WebGL
  // TRANSLUCENT compile-time define — emitted exactly when
  // `globeTranslucencyState.translucent` (front faces translucent). All-zero
  // (gate closed) when translucency is off → byte-identical default render.
  const translucencyState = (
    frameState as
      | {
          globeTranslucencyState?: {
            translucent?: boolean;
            frontFaceAlphaByDistance?: {
              near: number;
              nearValue: number;
              far: number;
              farValue: number;
            };
            backFaceAlphaByDistance?: {
              near: number;
              nearValue: number;
              far: number;
              farValue: number;
            };
          };
        }
      | undefined
  )?.globeTranslucencyState;
  const translucencyFront = translucencyState?.frontFaceAlphaByDistance;
  const translucencyBack = translucencyState?.backFaceAlphaByDistance;
  if (
    translucencyState?.translucent === true &&
    translucencyFront &&
    translucencyBack
  ) {
    const translucencyCameraUnderground =
      (frameState as { cameraUnderground?: boolean } | undefined)
        ?.cameraUnderground === true;
    const frontFinal = translucencyCameraUnderground
      ? translucencyBack
      : translucencyFront;
    const backFinal = translucencyCameraUnderground
      ? translucencyFront
      : translucencyBack;
    data[offset++] = frontFinal.near;
    data[offset++] = frontFinal.nearValue;
    data[offset++] = frontFinal.far;
    data[offset++] = frontFinal.farValue;
    data[offset++] = backFinal.near;
    data[offset++] = backFinal.nearValue;
    data[offset++] = backFinal.far;
    data[offset++] = backFinal.farValue;
    data[offset++] = 1.0; // x = TRANSLUCENT gate
    data[offset++] = 0.0;
    data[offset++] = 0.0;
    data[offset++] = 0.0;
  } else {
    for (let i = 0; i < 12; i++) data[offset++] = 0.0;
  }

  // czm_gammaCorrect HDR gate tail (192-195): hdrControl (vec4). Mirrors
  // WebGL's `#ifdef HDR` czm_gammaCorrect (gammaCorrect.glsl: sRGB to linear
  // decode). WebGL pushes the `HDR` define via
  // DerivedCommand.createHdrCommand whenever `scene._hdr`
  // (`scene.highDynamicRange`) is true, independently of whether the canvas is
  // an actual HDR/rgba16float output. The gate here is therefore
  // `frameState.useHDR` alone, which Scene mirrors from
  // `scene.highDynamicRange`, matching WebGL's single HDR define, this globe's
  // own atmosphere/fog inline-tonemap skip gate
  // (`groundAtmosphereControl.w` in WebGPUGlobeSurfaceTileUB.ts, also
  // `frameState.useHDR`), and the WebGPU post-process Tonemap stage
  // (`setStageEnabled("Tonemap", useHdr && !hdrOutputMode)`), which tonemaps
  // and gamma-encodes on `scene.highDynamicRange` regardless of canvas output.
  //
  // Adding `context.hdrCanvasOutput` to the gate would leave imagery undecoded
  // under a plain `scene.highDynamicRange = true` on an SDR canvas while the
  // post-process Tonemap still gamma-encodes it — a double gamma encode that
  // renders the globe double-bright against WebGL.
  //
  // y carries czm_gamma (uniformState.gamma, default 2.2). All-zero on the
  // default SDR path, where useHDR is false, so czm_gammaCorrect stays an
  // identity and the render is byte-identical.
  const hdrEnabled =
    (frameState as { useHDR?: boolean } | undefined)?.useHDR === true;
  data[offset++] = hdrEnabled ? 1.0 : 0.0;
  data[offset++] = (uniformState as { gamma?: number }).gamma ?? 2.2;
  data[offset++] = 0.0;
  data[offset++] = 0.0;

  // Cloud-shadow cascade tail (196-231): cloudShadowVP1 (mat4) +
  // cloudShadowVP2 (mat4) are the mid and far cascade forward VPs, cascade 0
  // being packed above into cloudShadowVP. cloudShadowCascadeParams (vec4)
  // carries x = atlas tile count (3.0). All-zero unless the opt-in cascade
  // tier rendered the atlas this frame, so the FS single-map branch stays
  // byte-identical.
  if (cascadeReady) {
    for (let ci = 1; ci < 3; ci++) {
      const cascadeFrame = cloudShadowCascadeFrames?.[ci];
      if (cloudShadowRelativeToEye && cascadeFrame) {
        writeCloudShadowViewProjectionRelativeToEye(
          data,
          offset,
          cascadeFrame,
          cloudShadowEyeX,
          cloudShadowEyeY,
          cloudShadowEyeZ,
        );
        offset += 16;
      } else {
        const base = ci * 16;
        for (let i = base; i < base + 16; i++) data[offset++] = cascadeVP![i];
      }
    }
    data[offset++] = 3.0; // x = tile count
    // y > 0.5 tells the FS the sun-view matrices above are eye-relative and
    // that it must project `v_positionRTE` rather than the full-ECEF
    // `v_positionMC`.
    data[offset++] = cloudShadowRelativeToEye ? 1.0 : 0.0;
    data[offset++] = 0.0;
    data[offset++] = 0.0;
  } else {
    for (let i = 0; i < 32; i++) data[offset++] = 0.0;
    data[offset++] = 0.0; // x = tile count (single-map branch)
    data[offset++] = cloudShadowRelativeToEye ? 1.0 : 0.0; // y = eye-relative VP
    data[offset++] = 0.0;
    data[offset++] = 0.0;
  }

  // Stash the exact near/far this globe command log-encodes the whole depth
  // texture against onto the shared uniformState, the one object that crosses
  // the GraphicsContext boundary to the depth-sample classifier's
  // `frameState.context.uniformState`. This runs at scene-update, on the full
  // frustum, before the per-slice loop slices currentFrustum and before the
  // classifier's command build, so depth-sample classifiers read the correct
  // encode frustum when reversing the log depth. Only a valid frustum is
  // stashed, so an early-frame zero cannot poison the decode.
  if (ldFar > ldNear) {
    const usStash = uniformState as unknown as {
      _logDepthEncodeNearFar: Float32Array | null;
      _logDepthEncodeFactor: number;
    };
    if (!usStash._logDepthEncodeNearFar) {
      usStash._logDepthEncodeNearFar = new Float32Array(2);
    }
    usStash._logDepthEncodeNearFar[0] = ldNear;
    usStash._logDepthEncodeNearFar[1] = ldFar;
    // Publish the already-derived factor with its frame-stable pair. General
    // primitive camera packs reuse it instead of recalculating Math.log2 once
    // per command on the render hot path.
    usStash._logDepthEncodeFactor = ldFactor;
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
 * `bufferSize`, not to the allocator's 256-aligned slot size, so the caller's
 * bind-group entry binds exactly the WGSL struct width.
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
          allocateAndWrite?(
            data: ArrayBuffer | ArrayBufferView,
            allocationSize?: number,
          ): { buffer: GPUBuffer; offset: number };
        };
      })
    | undefined;
  const allocator = ctx?.uniformAllocator;
  const writeBytes = Math.min(data.byteLength, bufferSize);

  if (allocator) {
    const uploadData =
      writeBytes === data.byteLength
        ? data
        : new Uint8Array(data.buffer, data.byteOffset, writeBytes);
    const alloc = allocator.allocateAndWrite
      ? allocator.allocateAndWrite(uploadData, bufferSize)
      : allocator.allocate(bufferSize);
    // Compatibility for lightweight allocator mocks and integrations that
    // expose only allocate(). Production WebGPUContext uses the staged path.
    if (!allocator.allocateAndWrite) {
      device.queue.writeBuffer(
        alloc.buffer,
        alloc.offset,
        data.buffer,
        data.byteOffset,
        writeBytes,
      );
    }
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
 * Build the per-tile `modifiedModelView` matrix that the globe-terrain
 * vertex shader uses as
 *   `v_positionEC = modifiedModelView × position_tile_local`
 * — equivalent to `view × (position_tile_local + mesh.center)`, the
 * eye-space position for the world point the tile-local vertex represents.
 * Used by the 2D, Columbus View and Morphing scene modes; it
 * identity-translates the view matrix by the tile center.
 *
 * Mirrors WebGL `GlobeSurfaceTileProviderRendering.js#L1120,L406-L414`,
 * which reads `rtc = mesh.center` and feeds it to `u_modifiedModelView`.
 *
 * The second argument has to be something carrying a `center`. A
 * `GlobeSurfaceTile` does not: the `if (!center) return new
 * Float64Array(view);` fallback then returns a plain view matrix, leaving
 * every fragment with a `v_positionEC` magnitude above 100 km at
 * ground-altitude camera positions, which saturates the fog term to a flat
 * uniform color across the entire below-horizon area.
 *
 * Pure free function — no host needed.
 */
export function computeModifiedModelView(
  uniformState: CesiumUniformState,
  mesh: CesiumTerrainMesh | { center?: { x: number; y: number; z: number } },
): Float64Array {
  const view = uniformState.view;
  const center = mesh?.center;
  if (!center) return new Float64Array(view);

  const result = new Float64Array(16);
  for (let i = 0; i < 16; i++) result[i] = view[i];

  result[12] += view[0] * center.x + view[4] * center.y + view[8] * center.z;
  result[13] += view[1] * center.x + view[5] * center.y + view[9] * center.z;
  result[14] += view[2] * center.x + view[6] * center.y + view[10] * center.z;

  return result;
}
