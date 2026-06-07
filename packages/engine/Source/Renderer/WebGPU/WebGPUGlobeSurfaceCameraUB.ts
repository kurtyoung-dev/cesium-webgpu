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

import Cartographic from "../../Core/Cartographic.js";
import WebMercatorProjection from "../../Core/WebMercatorProjection.js";
import { m4Values } from "./webgpuTypeHelpers.js";
import { assertCameraRTERoundTrip } from "./WebGPURTEAssertions.js";
import {
  CAMERA_UNIFORM_BYTES,
  multiplyMat4ColumnMajor,
} from "./WebGPUGlobeSurfaceTypes.js";

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

  // ─── SCENE2D / COLUMBUS_VIEW / MORPHING projected-rectangle setup ───
  // Mirrors `GlobeSurfaceTileProviderRendering.js:1139-1164` (upstream
  // WebGL). For non-SCENE3D modes, the planar vertex path operates on
  // PROJECTED meters, not raw radians. The `tileRectangle` uniform AND
  // the `rtc` used by `modifiedModelView` both have to be in projected
  // space — otherwise the vertex shader's
  //   `lon = mix(west, east, st.x); lat = mix(south, north, yFrac);`
  // produces values in radians ([-π, π]) which the projection × modelView
  // matrix expects in meters (millions of units). Result: every planar
  // vertex collapses to ~0 in clip space and the globe disappears.
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
  // Session 65 Batch 41 (NEW-VR2-1) — pass `mesh.center` not
  // `surfaceTile.center`. WebGL's GlobeSurfaceTileProviderRendering.js
  // line 1120 reads `rtc = mesh.center` and feeds that to
  // `u_modifiedModelView`. `surfaceTile.center` is NOT a property that
  // exists on GlobeSurfaceTile — the previous call was always passing
  // `undefined`, causing `computeModifiedModelView` to fall back to
  // the plain view matrix.
  //
  // With a plain view matrix, `view × position_tile_local` produces a
  // HUGE camera-relative position because `position_tile_local` is
  // small (a few hundred meters at most) but the translation column
  // of `view` is the negative camera position in world coords (~6.4 Mm
  // for Earth surface views). The resulting `v_positionEC` magnitude
  // crossed 100 km on every fragment in Bloom / Particle System,
  // making `v_distance` huge and `computeFog(v_distance, density, mod)`
  // saturate to 1.0 at every pixel — which is why fog appeared to
  // wipe imagery to a uniform color across the entire below-horizon
  // area regardless of the Batch 41 night-fog gating fix.
  //
  // The fix is one character — pass `mesh` instead of `surfaceTile`
  // to `computeModifiedModelView`. (Renamed signature below to make
  // it impossible to repeat the mistake.)
  //
  // SCENE2D / COLUMBUS_VIEW override: substitute the projected tile-center
  // rtc for `mesh.center`. The ECEF center is meaningless in planar modes
  // (it's at the surface of the WGS84 ellipsoid in 3D space, ~6.4 Mm from
  // the projected origin) — feeding it to `setTranslation(view, view×rtc)`
  // would translate the view to an impossible eye-space point and the
  // planar geometry would never reach clip space. Mirrors `rtc` assignment
  // at `GlobeSurfaceTileProviderRendering.js:1156-1163`.
  //
  // MORPHING override (mode 0): use a PLAIN view (no center baked) so the
  // morph branch's `modifiedModelView(Projection)` equals WebGL's plain
  // `czm_modelView` / `czm_projection`. The WGSL MORPHING branch feeds these
  // matrices a WORLD-space position (`position3DWC = exaggeratedPosition +
  // center3D`, and an absolute-projected planar position), so baking
  // `view × mesh.center` would add the tile center a SECOND time — the
  // ~6.4 Mm per-tile eye-space offset that splayed the globe apart through
  // every transition. WebGL's `getPositionMorphingMode` (GlobeVS.glsl:172-182)
  // uses `czm_modelView` (the globe command has an identity modelMatrix, so
  // that is the plain view) — NOT the center-baked `u_modifiedModelView`,
  // which it only uses for the 3D/CV/2D planar `getPositionPlanarEarth` path
  // with tile-LOCAL positions. `computeModifiedModelView` returns the plain
  // view when handed a source with no `center`. (BUG: globe morph splay.)
  const rtcSource = usePlanarMv
    ? { center: rtc2D }
    : sceneMode === 0 /* MORPHING */
      ? { center: undefined }
      : mesh;
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
  // Session 65 Batch 17 — pack `lightDirectionEC` (the SCENE LIGHT
  // direction) instead of `sunDirectionEC`. When the scene uses a
  // SunLight, these are identical (see `UniformState.update` line
  // 836-844). When the scene overrides `scene.light` with a custom
  // `DirectionalLight` (e.g., Bathymetry's per-frame hillshade
  // direction), only `lightDirectionEC` reflects the user-set value.
  // Mirrors upstream `GlobeFS.glsl` which references
  // `czm_lightDirectionEC` everywhere — using `sunDirectionEC` here
  // produced dark output for custom-light demos because the Lambert
  // term + day/night fade math read the wrong direction. The WGSL
  // field is still named `sunDirectionEC` for back-compat with
  // existing shader code; it's a misnomer but rewriting the field
  // name is a separate refactor.
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
  const ell = (tileProvider?._ellipsoid ?? tileProvider?.ellipsoid) as
    | { maximumRadius?: number }
    | undefined;
  data[offset++] = ell?.maximumRadius ?? 0.0;
  data[offset++] = 0; // reserved (future minor-axis radius)

  // ─── 2D / Columbus View support ───
  // tileRectangle (vec4): planar modes pack the PROJECTED rectangle in
  // meters (relative to rtc2D for SCENE2D / COLUMBUS_VIEW; absolute for
  // MORPHING). SCENE3D packs raw radians since `computePlanarPosition`
  // is not invoked in the 3D vertex branch. See the projected-rectangle
  // setup near the top of this function.
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
  // Use `instanceof`, NOT `constructor.name === "WebMercatorProjection"` —
  // esbuild's minifyIdentifiers renames the class in release builds, so the
  // string compare silently returns false and the globe reverts to
  // geographic-linear latitude spacing (vertical tile warping at mid/high
  // latitudes) in minified 2D/CV/morph. Mirrors WebGL
  // GlobeSurfaceTileProviderRendering.js:1201 (`projection instanceof WebMercatorProjection`).
  const projection = frameState?.mapProjection;
  const isWebMercator = projection instanceof WebMercatorProjection;
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

  // ─── Session 65 Batch 9 (Cluster 2b/5): Nishita ground atmosphere ───
  // Pack atmosphere parameters for the per-vertex ray-march. All values
  // default to the constants in `Source/Scene/Atmosphere.js` so the
  // first-frame render matches WebGL out of the box. Scene-level setters
  // (`scene.atmosphere.rayleighCoefficient = ...`) flow through to
  // `uniformState.atmosphere*` on update; we read those when present.
  //
  // atmosphereLightDirectionAndIntensity (vec4): xyz = light direction WC
  //   (sun by default — matches `DYNAMIC_ATMOSPHERE_LIGHTING_FROM_SUN`),
  //   w = light intensity (default 10.0).
  // GROUND atmosphere parameters live on the Globe (via tileProvider.*)
  // rather than `scene.atmosphere.*`. The Atmosphere.html demo sets
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
    // Batch 77 — Custom Lambert coefficient uniforms (tile-provider-driven).
    // Default values come from Globe.js (0.9 / 0.3) and are propagated to
    // the tile provider via Globe.beginFrame.
    lambertDiffuseMultiplier?: number;
    vertexShadowDarkness?: number;
    // Surface terrain provider exposes `hasVertexNormals` — when true, the
    // WebGL pipeline cache enables ENABLE_VERTEX_LIGHTING; the WGSL Lambert
    // path mirrors that gate at runtime.
    terrainProvider?: { hasVertexNormals?: boolean };
  };
  const us = uniformState as unknown as {
    sunDirectionWC?: { x: number; y: number; z: number };
    lightDirectionWC?: { x: number; y: number; z: number };
    // Batch 76 — `czm_lightColor` mirror. UniformState computes this as
    // `lightColorHdr` clipped so the brightest channel ≤ 1.
    lightColor?: { x: number; y: number; z: number };
  };
  const fs = frameState as
    | (CesiumFrameState & {
        fog?: { enabled?: boolean };
      })
    | undefined;
  // Light direction WC: WebGL chooses between `czm_sunDirectionWC` (when
  // `DYNAMIC_ATMOSPHERE_LIGHTING_FROM_SUN`) and `czm_lightDirectionWC`
  // otherwise. We mirror that decision here. When dynamic lighting is
  // off entirely, WebGL substitutes `normalize(positionWC)` in the VS;
  // we always pass a global direction and let the VS handle the
  // per-vertex fallback (computes nothing extra in our case since the
  // ray-march already uses positionWC as the inner radius source).
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
  const fogEnabled = fs?.fog?.enabled !== false;
  const groundAtmoEnabled = tp.showGroundAtmosphere !== false;
  // Session 65 Batch 38 — ground-atmosphere proper integration.
  // `atmosphereParams.w` encodes the enable flag AND the lighting mode,
  // replacing the empirical cap=1.5 × scale=0.15 workaround:
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
  //   2.0 → atmosphere on, dynamic lighting ACTIVE (real sun direction +
  //         FS darken/sunlitAtmosphereIntensity day-night mix).
  //
  // WebGL `dynamicLighting = DYNAMIC_ATMOSPHERE_LIGHTING && (ENABLE_VERTEX_LIGHTING
  // || ENABLE_DAYNIGHT_SHADING)`. The first define follows
  // `tileProvider.dynamicAtmosphereLighting`; the latter two are gated by
  // `enableLighting` in GlobeSurfaceShaderSet. Hello World defaults to
  // `enableLighting = false`, so WebGL's `dynamicLighting` evaluates to
  // false even though `dynamicAtmosphereLighting` is true by default —
  // the WGSL must reproduce that AND-gate or the per-vertex march
  // accumulates ~7-10× more radiance than the WebGL flat-light reference.
  //
  // The WGSL `w > 0.5` enable check still passes for both 1.0 and 2.0;
  // a separate `w > 1.5` check gates the dynamic-lighting branch.
  const atmoEnabled = fogEnabled || groundAtmoEnabled;
  const dynamicLightingActive =
    !!tp.dynamicAtmosphereLighting && !!tp.enableLighting;
  data[offset++] = atmoEnabled ? (dynamicLightingActive ? 2.0 : 1.0) : 0.0;

  // ─── Batch 76: czm_lightColor (vec4, offset 132-135) ───
  // Mirrors WebGL's `czm_lightColor` automatic uniform. UniformState
  // computes `_lightColor` as `lightColorHdr` clipped so the brightest
  // channel ≤ 1 (see UniformState.js:855-878). When the scene provides
  // a custom light (`scene.light.color = Color.ORANGE`), the WGSL globe
  // Lambert path multiplies the diffuse term by this color, matching
  // WebGL's ENABLE_VERTEX_LIGHTING / ENABLE_DAYNIGHT_SHADING paths.
  // Default uniform value is (1,1,1) so non-customized scenes (the
  // overwhelming majority) are visually unchanged.
  const lc = us.lightColor;
  if (lc) {
    data[offset++] = lc.x;
    data[offset++] = lc.y;
    data[offset++] = lc.z;
  } else {
    // UniformState hasn't been updated yet (extremely early frame).
    // White preserves pre-Batch-76 behavior (multiply by 1).
    data[offset++] = 1.0;
    data[offset++] = 1.0;
    data[offset++] = 1.0;
  }
  data[offset++] = 0.0; // .w reserved

  // ─── Batch 77: lighting (vec4, offset 136-139) ───
  // Custom Lambert coefficient uniforms (tile-provider-driven). Mirrors
  // WebGL's `u_lambertDiffuseMultiplier` + `u_vertexShadowDarkness`
  // fragment uniforms. The WGSL Lambert path gates on `.z`
  // (hasVertexNormals) to match WebGL's ENABLE_VERTEX_LIGHTING gating
  // (compile-time #ifdef in WebGL → runtime branch in WGSL).
  //
  // When a tile provider hasn't been populated yet (extremely early
  // frame) we still write the Globe.js defaults so the WGSL branch is
  // well-defined.
  const lambertMult = tp.lambertDiffuseMultiplier;
  const shadowDark = tp.vertexShadowDarkness;
  data[offset++] = typeof lambertMult === "number" ? lambertMult : 0.9;
  data[offset++] = typeof shadowDark === "number" ? shadowDark : 0.3;
  const hasNormals = !!tp.terrainProvider?.hasVertexNormals;
  data[offset++] = hasNormals ? 1.0 : 0.0;
  data[offset++] = 0.0; // .w reserved

  // ─── Renderer-wide log depth tail (vec4: near, far, factor, reserved) ───
  // Read by GlobeTerrain.wgsl's `//>>ifdef LOG_DEPTH` blocks (camera.logDepth).
  // Carries zero / the live frustum scalars regardless of the flag — inert
  // until `_logDepthWriteEnabled` flips and the LOG_DEPTH pipeline define is
  // set. The bespoke globe UB carries these at the tail rather than the shared
  // CameraUniforms .w lanes (see WebGPULogDepth.ts).
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

  // NEW-WEBGPU-GLOBE-CLASSIFY-DEPTH-PRECISION — stash the EXACT near/far this
  // globe command log-encodes the whole depth texture against onto the SHARED
  // uniformState (the one object that crosses the GraphicsContext boundary to
  // the depth-sample classifier's frameState.context.uniformState). This runs
  // at scene-update (full frustum, before the per-slice loop slices
  // currentFrustum AND before the classifier's command-build), so depth-sample
  // classifiers read the correct encode frustum to reverse the log depth. Only
  // stash a valid frustum so an early-frame zero never poisons the decode.
  if (ldFar > ldNear) {
    const usStash = uniformState as unknown as {
      _logDepthEncodeNearFar: Float32Array | null;
    };
    if (!usStash._logDepthEncodeNearFar) {
      usStash._logDepthEncodeNearFar = new Float32Array(2);
    }
    usStash._logDepthEncodeNearFar[0] = ldNear;
    usStash._logDepthEncodeNearFar[1] = ldFar;
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
/**
 * Build the per-tile `modifiedModelView` matrix that the globe-terrain
 * vertex shader uses as
 *   `v_positionEC = modifiedModelView × position_tile_local`
 * — equivalent to `view × (position_tile_local + mesh.center)` i.e. the
 * eye-space position for the world point the tile-local vertex
 * represents.
 *
 * Mirrors WebGL `GlobeSurfaceTileProviderRendering.js#L1120,L406-L414`
 * which reads `rtc = mesh.center` and feeds it to `u_modifiedModelView`.
 *
 * Session 65 Batch 41 (NEW-VR2-1) — renamed the second argument from
 * `surfaceTile` to `mesh` to make it impossible to repeat the bug
 * where the caller passed a `GlobeSurfaceTile` and the function looked
 * up `surfaceTile.center` which doesn't exist on that class — the
 * `if (!center) return new Float64Array(view);` fallback then handed
 * back a plain view matrix, leaving every fragment with a HUGE
 * (>100 km) `v_positionEC` magnitude at ground-altitude camera
 * positions. The visible symptom was Bloom.html + Particle System.html
 * rendering as a flat uniform fog color across the entire below-
 * horizon area (NEW-VR2-1 "still deferred" since 2026-05-10).
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
