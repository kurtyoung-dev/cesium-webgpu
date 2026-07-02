/// <reference types="@webgpu/types" />
/**
 * Tile-uniform-buffer packing extracted from `WebGPUGlobeSurfaceRenderer`.
 *
 * Batch 153 of the audit-recommended decomposition (ninth and final
 * slice of the GlobeSurface decomposition arc — see
 * `migration_doc/BATCH_145_PLAN_GLOBE_SURFACE_DECOMPOSITION.md`).
 *
 * The biggest single extraction in the arc (~496 LOC). Moves the
 * per-tile per-pass `TileUniforms` packer off the renderer class.
 *
 * `createTileUniformBuffer(host, …)` lays out the 476-float
 * `TileUniforms` struct (1904 bytes) against the GlobeTerrain WGSL
 * contract:
 *
 *   - Per-imagery-layer block (16 layers × 24 floats): translationAndScale,
 *     texCoordsRectangle, colorToAlpha (rgb + threshold), cutoutRectangle
 *     (in tile-UV), alpha/brightness/contrast/saturation,
 *     hue/oneOverGamma/split (Batch 58 expansion).
 *   - dayNightAlpha[8] vec4 array (packed 2 layers per vec4).
 *   - useWebMercatorTLayer[4] vec4 array (packed 4 layers per vec4).
 *   - Scalars: layerCount, fog density/offset/minBrightness, water-mask
 *     translation, cartographic limit rectangle, night fade in/out,
 *     vertical exaggeration, flags (waterMask/clipping/oceanWaves/
 *     subsequentPass), ocean params, night & ocean secondary params,
 *     wave time, fogVisualDensityScalar, splitPosition, debug fields,
 *     HSB shift.
 *   - Resolves callback-shaped imagery-layer values via `resolveImageryLayerValue`
 *     so dynamic-alpha use cases (hover-fade, time-of-day fade) work on WebGPU.
 *
 * Two diagnostic blocks are pragma-stripped in production:
 *   - LAYERS log (1/sec throttle on `_diagLastLayerCountLogMs`) — helps
 *     diagnose the `layerCount=0` failure mode that produces empty tiles.
 *   - Fog log + fog-missing error (1/sec throttle on `_diagLastFogLogMs`,
 *     one-shot on `_diagFogMissingLogged`).
 *
 * The 5 host fields the packer reaches into are flipped from `private`
 * to `public` on the renderer:
 *   - `_tileUniformData` (Float32Array scratch sized to TILE_UNIFORM_FLOATS)
 *   - `_tileUniformU32View` (Uint32Array view, currently unused inside
 *     the body but kept per the "leave scaffolding" rule — was likely
 *     intended for bitfield slots in a future TileUniforms revision).
 *   - `_diagLastLayerCountLogMs`
 *   - `_diagLastFogLogMs`
 *   - `_diagFogMissingLogged`
 *
 * The 2 callers (in `createTileCommands` and `createWireframeTileCommands`)
 * now invoke the helper directly with `this`.
 *
 * @module WebGPUGlobeSurfaceTileUB
 */

import {
  TILE_UNIFORM_BYTES,
  LAYER_FLOATS,
  LAYERS_OFFSET,
  DAY_NIGHT_ALPHA_OFFSET,
  USE_WEB_MERC_OFFSET,
  LAYER_COUNT_OFFSET,
  FOG_DENSITY_OFFSET,
  FOG_OFFSET_OFFSET,
  FOG_MIN_BRIGHTNESS_OFFSET,
  WATER_MASK_TS_OFFSET,
  CART_LIMIT_RECT_OFFSET,
  NIGHT_FADE_OUT_OFFSET,
  NIGHT_FADE_IN_OFFSET,
  VERT_EXAG_OFFSET,
  VERT_EXAG_REL_HEIGHT_OFFSET,
  FLAGS_OFFSET,
  OCEAN_PARAMS_OFFSET,
  NIGHT_OCEAN_PARAMS_OFFSET,
  TIME_OFFSET,
  FOG_VIS_DENSITY_OFFSET,
  SPLIT_POSITION_OFFSET,
  DEBUG_FIELDS_OFFSET,
  HSB_SHIFT_OFFSET,
  GROUND_ATMOSPHERE_CONTROL_OFFSET,
  INITIAL_COLOR_OFFSET,
  LOCALIZED_TRANSLUCENCY_RECT_OFFSET,
  MAX_IMAGERY_LAYERS,
  resolveImageryLayerValue,
} from "./WebGPUGlobeSurfaceTypes.js";
// GLOBE-TRANSLUCENCY-ALPHA — reuse the exact WebGL antimeridian-clip helper
// for the translucency rectangle instead of replicating the split logic here
// and risking drift. Backend-neutral pure function.
import { clipRectangleAntimeridian } from "../../Scene/GlobeSurfaceTileProviderRendering.js";
import { writeUniformSlice } from "./WebGPUGlobeSurfaceCameraUB.js";
import { getActiveDebugSentinel } from "./WebGPUGlobeFragmentDebug.js";
import {
  resolveImageryProjection,
  type TextureCacheHost,
} from "./WebGPUGlobeSurfaceTextures.js";

/**
 * The renderer surface the tile-UB packer reaches into.
 *
 *   - `_tileUniformData`: Float32Array scratch, sized to TILE_UNIFORM_FLOATS.
 *   - `_tileUniformU32View`: Uint32Array view of the same buffer (scaffolding;
 *     unused in the current body but kept for future bitfield-slot use).
 *   - `_diagLastLayerCountLogMs` / `_diagLastFogLogMs` / `_diagFogMissingLogged`:
 *     diagnostic-throttle state. Read+write by the pragma-stripped log
 *     blocks; production builds dead-code-eliminate the call sites.
 */
export interface TileUBHost extends TextureCacheHost {
  readonly _tileUniformData: Float32Array;
  readonly _tileUniformU32View: Uint32Array;
  _diagLastLayerCountLogMs: number;
  _diagLastFogLogMs: number;
  _diagFogMissingLogged: boolean;
}

/**
 * Create tile uniform buffer with imagery, fog, water mask, clipping,
 * and day/night params. Supports per-pass imagery layer subsets.
 */
export function createTileUniformBuffer(
  host: TileUBHost,
  device: GPUDevice,
  surfaceTile: CesiumGlobeSurfaceTile,
  tileProvider: CesiumGlobeTileProvider,
  frameState: CesiumFrameState,
  tile: { level: number; x: number; y: number; rectangle: CesiumRectangle },
  passLayers: CesiumTileImagery[],
  isSubsequentPass: boolean,
): { buffer: GPUBuffer; offset: number; size: number } {
  const data = host._tileUniformData;
  const u32 = host._tileUniformU32View;
  data.fill(0);

  // ─── Imagery layers (Batch 58, C-R5) ───
  // Per-layer struct = 24 floats / 96 bytes. Slots 4-15 are filled with
  // sensible defaults (alpha=0 below) so the shader's `count` gate is
  // the only thing keeping unused slots from contributing.
  let layerCount = 0;

  for (
    let i = 0;
    i < passLayers.length && layerCount < MAX_IMAGERY_LAYERS;
    i++
  ) {
    const tileImagery = passLayers[i];
    if (!tileImagery || !tileImagery.readyImagery) continue;

    const imagery = tileImagery.readyImagery;
    if (!imagery.imageryLayer) continue;

    const baseOffset = LAYERS_OFFSET + layerCount * LAYER_FLOATS;

    // Batch 65 — dual-texture cache. `WebGPUGlobeSurfaceTextures.
    // getOrCreateImageryTexture` binds the Mercator-projection
    // GPUTexture when `tileImagery.useWebMercatorT === true` AND
    // `imagery._webgpuMercatorTexture` exists; otherwise it binds the
    // Geographic-projection variant. The shader's
    // `useWebMercatorTLayer` flag MUST track that decision so
    // `selectLayerUV` samples the bound texture at the correct
    // coordinate space.
    //
    // The cached `tileImagery.textureTranslationAndScale` and
    // `textureCoordinateRectangle` are already in the matching
    // coordinate space — `_calculateTextureTranslationAndScale` and
    // `createTileImagerySkeletons` branch on `useWebMercatorT` and
    // produce Mercator-space tile-UVs when true and geographic-space
    // tile-UVs when false. So when we honor the bound texture's
    // projection, the cached translation/scale and texCoordsRect line
    // up without any inline recalc (the Batch 62 fixup is no longer
    // needed and would have been wrong in either direction).
    //
    // NEW-USEWEBMERCATORT-SINGLE-SOURCE (Batch 304): derive the flag
    // from `resolveImageryProjection` — the SAME pure peek
    // `getOrCreateImageryTexture` uses to pick the bound variant — so
    // the shader's `useWebMercatorTLayer` flag can never diverge from
    // the actually-bound texture's projection (cache hits, the
    // Mercator→geographic fall-through, and the race-window bind all
    // resolve identically here and at bind-group creation). The old
    // local `tileImagery.useWebMercatorT && !!_webgpuMercatorTexture`
    // recompute missed the cache and fall-through cases.
    const effectiveUseWebMercatorT =
      resolveImageryProjection(host, tileImagery)?.isMercator ?? false;

    // translationAndScale (vec4) — cached value, matches the bound
    // texture's coordinate space.
    const ts = tileImagery.textureTranslationAndScale;
    if (ts) {
      data[baseOffset + 0] = ts.x;
      data[baseOffset + 1] = ts.y;
      data[baseOffset + 2] = ts.z;
      data[baseOffset + 3] = ts.w;
    } else {
      data[baseOffset + 2] = 1;
      data[baseOffset + 3] = 1;
    }

    // texCoordsRectangle (vec4) — cached value, matches the bound
    // texture's coordinate space (including the base-layer south-edge
    // fixup applied by `createTileImagerySkeletons`).
    const rect = tileImagery.textureCoordinateRectangle;
    if (rect) {
      data[baseOffset + 4] = rect.x;
      data[baseOffset + 5] = rect.y;
      data[baseOffset + 6] = rect.z;
      data[baseOffset + 7] = rect.w;
    } else {
      data[baseOffset + 6] = 1;
      data[baseOffset + 7] = 1;
    }

    const layer = imagery.imageryLayer;

    // colorToAlpha (vec4: rgb + threshold). Default sentinel (.a < 0)
    // disables the effect — the shader skips the key-color compare for
    // layers with `colorToAlpha.a < 0`. Mirrors WebGL's CPU-side default
    // in GlobeSurfaceTileProviderRendering.js where `colorToAlpha.w = -1`
    // when `imageryLayer.colorToAlpha` is undefined.
    const cta = (
      layer as unknown as {
        colorToAlpha?: { red: number; green: number; blue: number };
        colorToAlphaThreshold?: number;
      }
    ).colorToAlpha;
    const ctaThreshold = (
      layer as unknown as { colorToAlphaThreshold?: number }
    ).colorToAlphaThreshold;
    if (cta && typeof ctaThreshold === "number" && ctaThreshold > 0.0) {
      data[baseOffset + 8] = cta.red ?? 0;
      data[baseOffset + 9] = cta.green ?? 0;
      data[baseOffset + 10] = cta.blue ?? 0;
      data[baseOffset + 11] = ctaThreshold;
    } else {
      // Disable: threshold < 0 is the WebGL convention.
      data[baseOffset + 8] = 0;
      data[baseOffset + 9] = 0;
      data[baseOffset + 10] = 0;
      data[baseOffset + 11] = -1.0;
    }

    // cutoutRectangle (vec4 in tile-UV space). Packed as
    // (west_uv, south_uv, east_uv, north_uv) — see WebGL CPU code in
    // GlobeSurfaceTileProviderRendering.js. When `imageryLayer.cutoutRectangle`
    // is undefined the WebGL path writes Cartesian4.ZERO which the shader
    // detects as "zero area → disabled".
    const cutoutRect = (
      layer as unknown as {
        cutoutRectangle?: {
          west: number;
          south: number;
          east: number;
          north: number;
        };
      }
    ).cutoutRectangle;
    if (cutoutRect && tile.rectangle) {
      const tw = tile.rectangle.width || 1.0;
      const th = tile.rectangle.height || 1.0;
      const invW = 1.0 / tw;
      const invH = 1.0 / th;
      // Convert from cartographic radians to tile-UV [0..1].
      data[baseOffset + 12] = (cutoutRect.west - tile.rectangle.west) * invW;
      data[baseOffset + 13] = (cutoutRect.south - tile.rectangle.south) * invH;
      data[baseOffset + 14] = (cutoutRect.east - tile.rectangle.west) * invW;
      data[baseOffset + 15] = (cutoutRect.north - tile.rectangle.south) * invH;
    } else {
      data[baseOffset + 12] = 0;
      data[baseOffset + 13] = 0;
      data[baseOffset + 14] = 0;
      data[baseOffset + 15] = 0;
    }

    // Several of these properties are documented as scalar-OR-callback
    // (ImageryLayer JSDoc). Writing a Function into a Float32Array yields
    // NaN, which propagates through the imagery blend and makes the entire
    // layer disappear. Resolve callbacks against the tile rectangle so
    // dynamic-alpha use cases (hover-fade, time-of-day fade) work on WebGPU.
    data[baseOffset + 16] = resolveImageryLayerValue(
      layer.alpha,
      1.0,
      frameState,
      layer,
      tile,
    );
    data[baseOffset + 17] = resolveImageryLayerValue(
      layer.brightness,
      1.0,
      frameState,
      layer,
      tile,
    );
    data[baseOffset + 18] = resolveImageryLayerValue(
      layer.contrast,
      1.0,
      frameState,
      layer,
      tile,
    );
    data[baseOffset + 19] = resolveImageryLayerValue(
      layer.saturation,
      1.0,
      frameState,
      layer,
      tile,
    );

    // Batch 58 — new per-layer scalars: hue (radians), oneOverGamma
    // (pre-divided so shader avoids a divide), split (-1/0/+1 from
    // SplitDirection enum), and a trailing pad to keep the layer struct
    // 16-byte aligned for WGSL uniform-address-space rules.
    const hueResolved = resolveImageryLayerValue(
      (layer as unknown as { hue?: unknown }).hue,
      0.0,
      frameState,
      layer,
      tile,
    );
    const gammaResolved = resolveImageryLayerValue(
      (layer as unknown as { gamma?: unknown }).gamma,
      1.0,
      frameState,
      layer,
      tile,
    );
    const splitResolved = resolveImageryLayerValue(
      (layer as unknown as { splitDirection?: unknown }).splitDirection,
      0.0,
      frameState,
      layer,
      tile,
    );
    data[baseOffset + 20] = hueResolved;
    // Guard against 1/0 if a caller sets gamma=0; the shader skips the
    // pow when |oneOverGamma - 1| < 1e-4 so default fast-path is free.
    data[baseOffset + 21] = gammaResolved !== 0 ? 1.0 / gammaResolved : 1.0;
    data[baseOffset + 22] = splitResolved;
    data[baseOffset + 23] = 0;

    // useWebMercatorT (packed 4 layers per vec4). Bit i in the layer
    // sequence maps to component (i % 4) of vec4 (i / 4).
    //
    // Batch 65 — `effectiveUseWebMercatorT` mirrors what
    // `WebGPUGlobeSurfaceTextures.getOrCreateImageryTexture` decides to
    // bind. WebGL's GlobeSurfaceTileProviderRendering selects between
    // `imagery.texture` (geographic) and `imagery.textureWebMercator`
    // (mercator) per tile; WebGPU now mirrors that with
    // `imagery._webgpuReprojectedTexture` (geographic) and
    // `imagery._webgpuMercatorTexture` (mercator). The flag here keeps
    // the shader's `selectLayerUV` in lock-step with the bound
    // texture's projection.
    const useWMVecIndex = layerCount >> 2;
    const useWMComp = layerCount & 3;
    data[USE_WEB_MERC_OFFSET + useWMVecIndex * 4 + useWMComp] =
      effectiveUseWebMercatorT ? 1.0 : 0.0;

    // dayNightAlpha (packed 2 layers per vec4): pair (i*2..i*2+1) lives
    // in dayNightAlpha[i/2].xy / .zw → vec4 index = layerCount/2,
    // half = layerCount%2 (0 → xy, 1 → zw).
    const dnVecIndex = layerCount >> 1;
    const dnHalf = layerCount & 1;
    const dnFloatBase = DAY_NIGHT_ALPHA_OFFSET + dnVecIndex * 4 + dnHalf * 2;
    data[dnFloatBase + 0] = resolveImageryLayerValue(
      layer.dayAlpha,
      1.0,
      frameState,
      layer,
      tile,
    );
    data[dnFloatBase + 1] = resolveImageryLayerValue(
      layer.nightAlpha,
      1.0,
      frameState,
      layer,
      tile,
    );

    layerCount++;
  }

  // ─── layerCount (f32 at LAYER_COUNT_OFFSET) ───
  // Stored as f32 (read in WGSL via `u32(tile.layerCount)`) — matches the
  // historical convention used to diagnose past UB transfer issues.
  data[LAYER_COUNT_OFFSET] = layerCount;

  //>>includeStart('debug', pragmas.debug);
  // Dedicated diagnostic — logs EVERY frame (throttled to 1/sec) even
  // when layerCount=0, because layerCount=0 is exactly the failure mode
  // we need to catch. Fires independently of the shared `_diagShouldLog`
  // counter to avoid getting starved by center3D logging.

  const nowMs3 =
    typeof performance !== "undefined" ? performance.now() : Date.now();
  if (
    host._diagLastLayerCountLogMs === undefined ||
    nowMs3 - host._diagLastLayerCountLogMs >= 1000
  ) {
    host._diagLastLayerCountLogMs = nowMs3;
    const readyCount = passLayers.filter(
      (l: CesiumTileImagery) => l?.readyImagery?.imageryLayer,
    ).length;
    const level = tile?.level ?? -1;
    const tileImageryCount = surfaceTile.imagery?.length ?? -1;
    console.log(
      `[WebGPU:GlobeTile] LAYERS tile=${level}_${tile?.x}_${tile?.y} ` +
        `layerCount=${layerCount} passLayersLen=${passLayers.length} ` +
        `readyInPass=${readyCount} surfaceTileImagery=${tileImageryCount} ` +
        `isSubsequentPass=${isSubsequentPass}`,
    );
  }
  //>>includeEnd('debug');

  // ─── Fog parameters (offsets 49-51) ───
  // Phase 1.4 — `frameState.atmosphericConditions.weather.humidity`
  // (default 0.5 = no change) modulates fog density on a (0.5+humidity)
  // multiplier: 0.0 humidity → 0.5× density (very dry desert), 0.5 →
  // 1.0× (default, no change), 1.0 → 1.5× (tropical jungle haze).
  // Linear and bounded so the existing fog tuning stays predictable.
  //
  // CRITICAL — belt-and-suspenders: when `fog.enabled === false`, force
  // density to 0 regardless of what `fog.density` says. `Fog.update()`
  // early-returns when `this.enabled` is false, which leaves any prior
  // non-zero density value sitting on `frameState.fog.density` stale.
  // At planetary scale that stale value causes the shader to fog every
  // distant pixel to black — the "black globe at distance" bug.
  // Explicitly zeroing when !enabled makes the GPU state consistent
  // with the user-facing switch.
  if (frameState && frameState.fog) {
    // Track V-A2 — when aerial perspective owns the atmosphere, force the
    // in-globe fog density to 0 so the two don't double-apply.
    const fogEnabled =
      frameState.fog.enabled !== false &&
      (frameState as { aerialPerspective?: boolean }).aerialPerspective !==
        true &&
      // GLOBE-UNDERGROUND-COLOR — WebGL disables terrain fog when the camera
      // is underground (`enableFog = frameState.fog.enabled &&
      // frameState.fog.renderable && !cameraUnderground` in
      // GlobeSurfaceTileProviderRendering.js:1229-1230). Without this gate
      // the WGSL fog mix saturates every underside fragment toward the
      // (near-black) underground atmosphere color and buries the imagery +
      // undergroundColor tint that WebGL shows.
      (frameState as { cameraUnderground?: boolean }).cameraUnderground !==
        true;
    let density = fogEnabled ? (frameState.fog.density ?? 0.0) : 0.0;
    if (fogEnabled) {
      const ac = frameState.atmosphericConditions;
      const weather = ac && ac.weather ? ac.weather : undefined;
      if (weather && typeof weather.humidity === "number") {
        density = density * (0.5 + weather.humidity);
      }
    }
    data[FOG_DENSITY_OFFSET] = density;
    data[FOG_OFFSET_OFFSET] = fogEnabled ? (frameState.fog.offset ?? 0.0) : 0.0;
    data[FOG_MIN_BRIGHTNESS_OFFSET] = frameState.fog.minimumBrightness ?? 0.03;
    //>>includeStart('debug', pragmas.debug);
    // Dedicated throttle (independent of the tile-center3D log) so we
    // always see fog state at camera altitude transitions. Logs once
    // per second regardless of what other diagnostics are firing.
    const nowMs =
      typeof performance !== "undefined" ? performance.now() : Date.now();

    if (
      host._diagLastFogLogMs === undefined ||
      nowMs - host._diagLastFogLogMs >= 1000
    ) {
      host._diagLastFogLogMs = nowMs;
      const cameraHeight =
        frameState.camera?.positionCartographic?.height ?? -1;
      console.log(
        `[WebGPU:GlobeTile] fog density=${density.toExponential(3)} ` +
          `rawDensity=${(frameState.fog.density ?? 0).toExponential(3)} ` +
          `offset=${(data[FOG_OFFSET_OFFSET] ?? 0).toExponential(3)} ` +
          `minBrightness=${(frameState.fog.minimumBrightness ?? 0.03).toFixed(3)} ` +
          `enabled=${frameState.fog.enabled} gated=${fogEnabled} ` +
          `cameraHeight=${(cameraHeight / 1000).toFixed(0)}km`,
      );
    }
    //>>includeEnd('debug');
  } else {
    data[FOG_MIN_BRIGHTNESS_OFFSET] = 0.03;
    //>>includeStart('debug', pragmas.debug);
    // Called once — frameState.fog is missing entirely. That means
    // Scene.fog.update() never ran for this frame, which would fully
    // explain the "black globe at orbit" symptom: density stays at
    // whatever it was last set to and no zeroing path runs.

    if (!host._diagFogMissingLogged) {
      host._diagFogMissingLogged = true;
      console.error(
        `[WebGPU:GlobeTile] frameState.fog is UNDEFINED — ` +
          `Scene.fog.update() probably not running for this render path. ` +
          `Fog density will be stale from initialization.`,
      );
    }
    //>>includeEnd('debug');
  }

  // ─── Water mask translation and scale (vec4) ───
  if (!isSubsequentPass) {
    const wmTS = surfaceTile.waterMaskTranslationAndScale;
    if (wmTS) {
      data[WATER_MASK_TS_OFFSET + 0] = wmTS.x;
      data[WATER_MASK_TS_OFFSET + 1] = wmTS.y;
      data[WATER_MASK_TS_OFFSET + 2] = wmTS.z;
      data[WATER_MASK_TS_OFFSET + 3] = wmTS.w;
    }
  }

  // ─── Cartographic limit rectangle (vec4) ───
  if (tileProvider && tileProvider.cartographicLimitRectangle) {
    const limitRect = tileProvider.cartographicLimitRectangle;
    const tileRect = tile.rectangle;
    if (tileRect) {
      const invW = 1.0 / tileRect.width;
      const invH = 1.0 / tileRect.height;
      data[CART_LIMIT_RECT_OFFSET + 0] =
        (limitRect.west - tileRect.west) * invW;
      data[CART_LIMIT_RECT_OFFSET + 1] =
        (limitRect.south - tileRect.south) * invH;
      data[CART_LIMIT_RECT_OFFSET + 2] =
        (limitRect.east - tileRect.west) * invW;
      data[CART_LIMIT_RECT_OFFSET + 3] =
        (limitRect.north - tileRect.south) * invH;
    }
  } else {
    // No clipping — full tile visible
    data[CART_LIMIT_RECT_OFFSET + 2] = 1.0;
    data[CART_LIMIT_RECT_OFFSET + 3] = 1.0;
  }

  // ─── Night fade distances (two scalars) ───
  if (tileProvider) {
    data[NIGHT_FADE_OUT_OFFSET] =
      tileProvider.nightFadeOutDistance ?? 10000000.0;
    data[NIGHT_FADE_IN_OFFSET] = tileProvider.nightFadeInDistance ?? 50000000.0;
  } else {
    data[NIGHT_FADE_OUT_OFFSET] = 10000000.0;
    data[NIGHT_FADE_IN_OFFSET] = 50000000.0;
  }

  // ─── Vertical exaggeration (two scalars) ───
  data[VERT_EXAG_OFFSET] = frameState?.verticalExaggeration ?? 1.0;
  data[VERT_EXAG_REL_HEIGHT_OFFSET] =
    frameState?.verticalExaggerationRelativeHeight ?? 0.0;

  // dayNightAlpha[8] vec4 array already set above during layer iteration.
  // useWebMercatorTLayer[4] vec4 array also set during layer iteration.

  // ─── Flags (vec4) ───
  // Batch 58 — `flags.x` controls whether the WGSL `computeEnhancedOcean`
  // path runs for ocean fragments. WebGL gates the equivalent
  // `computeWaterColor` on the `SHOW_REFLECTIVE_OCEAN` shader define,
  // which is only emitted when BOTH:
  //   1. the terrain provider supplies a water mask (`hasWaterMask`)
  //   2. the user enabled water rendering (`globe.showWaterEffect`,
  //      default FALSE)
  // Previously the WGSL only checked condition 1, so every ocean
  // fragment ran the enhanced shader (which blends 40% imagery + 60%
  // deep color, dimming the satellite Bing aerial by ~5×). That was
  // the dominant source of the WebGPU/WebGL brightness gap at
  // mid/orbit distances over ocean.
  const hasWaterMask =
    !isSubsequentPass &&
    tileProvider &&
    tileProvider.hasWaterMask &&
    surfaceTile.waterMaskTexture !== undefined;
  const showReflectiveOcean =
    hasWaterMask && tileProvider.showWaterEffect === true;
  const enableClipping =
    tileProvider &&
    tileProvider.cartographicLimitRectangle &&
    tileProvider.cartographicLimitRectangle.width < Math.PI * 2 - 0.001;
  const showOceanWaves =
    showReflectiveOcean && tileProvider.oceanNormalMap !== undefined;

  data[FLAGS_OFFSET + 0] = showReflectiveOcean ? 1.0 : 0.0;
  data[FLAGS_OFFSET + 1] = enableClipping ? 1.0 : 0.0;
  data[FLAGS_OFFSET + 2] = showOceanWaves ? 1.0 : 0.0;
  data[FLAGS_OFFSET + 3] = isSubsequentPass ? 1.0 : 0.0;

  // ─── Ocean enhancement params (vec4) ───
  // oceanParams: x=deepR, y=deepG, z=deepB, w=fresnelPower
  // Defaults applied in shader when all zero (no tileProvider config needed)
  if (tileProvider?.oceanDeepColor) {
    const c = tileProvider.oceanDeepColor;
    data[OCEAN_PARAMS_OFFSET + 0] = c.red ?? c.x ?? 0.008;
    data[OCEAN_PARAMS_OFFSET + 1] = c.green ?? c.y ?? 0.045;
    data[OCEAN_PARAMS_OFFSET + 2] = c.blue ?? c.z ?? 0.12;
  }
  data[OCEAN_PARAMS_OFFSET + 3] = tileProvider?.oceanFresnelPower ?? 0.0; // 0 = use shader default

  // ─── Time for ocean wave animation ───
  // Derive animation clock from `frameState.time` (a JulianDate) so every
  // view in a multi-view render pass samples the same wave phase and
  // screenshots are deterministic. Previously the renderer read
  // `performance.now()` directly, which drifts per-view and breaks
  // deterministic capture. Mod by 1e6 s (~11.6 days) to keep the
  // monotonic counter within f32 precision for smooth `sin(k*t)` / `fract`
  // kernels in the shader.
  const t = frameState?.time as
    | { dayNumber?: number; secondsOfDay?: number }
    | undefined;
  let waveTime = 0.0;
  if (t) {
    const secs = (t.dayNumber ?? 0) * 86400.0 + (t.secondsOfDay ?? 0);
    waveTime = secs % 1000000.0;
  }
  data[TIME_OFFSET] = waveTime;
  //>>includeStart('debug', pragmas.debug);
  // Batch 56 diagnostic — `CesiumDebug.globeFragmentDebug(name)` (or
  // setting `globalThis._webgpuGlobeDebugMode` directly) writes one of
  // the sentinel values from `GLOBE_FRAGMENT_DEBUG_MODES`. The WGSL
  // `fragmentMain` reads `tile.time` and short-circuits to a debug
  // visualization when it crosses 1e9. Registry lives in
  // `WebGPUGlobeFragmentDebug.ts` — add new modes there, then add the
  // matching WGSL branch in `GlobeTerrain.wgsl::fragmentMain`.
  const debugSentinel = getActiveDebugSentinel();
  if (debugSentinel !== null) {
    data[TIME_OFFSET] = debugSentinel;
  }
  //>>includeEnd('debug');
  // OPEN-5 fix: fogVisualDensityScalar — matches WebGL's
  // `czm_fogVisualDensityScalar` auto-uniform (default 0.15 from
  // UniformState). Without this the fog formula is ~6.7x stronger than
  // WebGL at horizontal viewing angles.
  data[FOG_VIS_DENSITY_OFFSET] =
    frameState?.context?.uniformState?.fogVisualDensityScalar ?? 0.15;
  // Batch 58 — splitPosition in framebuffer pixels (matches gl_FragCoord
  // and `czm_splitPosition`). Sourced via `frameState.splitPosition` (a
  // 0..1 fraction; 0.5 = canvas centre) × drawing buffer width.
  const splitFrac =
    typeof frameState?.splitPosition === "number"
      ? frameState.splitPosition
      : 0.5;
  const drawWidth =
    (frameState?.context as { drawingBufferWidth?: number } | undefined)
      ?.drawingBufferWidth ?? 0;
  data[SPLIT_POSITION_OFFSET] = splitFrac * drawWidth;

  // ─── Night & ocean secondary params (vec4) ───
  // nightOceanParams: x=nightIntensity, y=oceanReflectivity, z=foamThreshold, w=oceanDarkening
  data[NIGHT_OCEAN_PARAMS_OFFSET + 0] =
    (tileProvider?.nightIntensity as number | undefined) ?? 0.0; // 0 = use shader default (2.5)
  data[NIGHT_OCEAN_PARAMS_OFFSET + 1] =
    (tileProvider?.oceanReflectivity as number | undefined) ?? 0.0; // 0 = use shader default (0.04)
  data[NIGHT_OCEAN_PARAMS_OFFSET + 2] =
    (tileProvider?.oceanFoamThreshold as number | undefined) ?? 0.0; // 0 = use shader default (0.35)
  data[NIGHT_OCEAN_PARAMS_OFFSET + 3] =
    (tileProvider?.oceanDarkening as number | undefined) ?? 0.0; // 0 = use shader default (0.6)

  // ─── Per-tile debug fields (vec4) ───
  // Tier 2 debug: tile depth-level + imagery layer isolation. Both
  // sourced from frameState so a single Scene property toggle flips
  // them on for every tile uniformly. Production cost is two property
  // reads + two array writes per tile, sub-noise-floor.
  //   .x = tileLevel — read by fragmentDebugLod for the LOD overlay
  //   .y = isolateImageryLayer — when >= 0, fragmentMain renders only
  //        that layer index (0..15 within the current pass) and skips
  //        the rest of the imagery composite. -1 = production behavior.
  //   .z, .w = reserved for future per-tile debug toggles
  data[DEBUG_FIELDS_OFFSET + 0] = tile?.level ?? 0;
  const isolate = frameState.debugShowImageryLayer;
  data[DEBUG_FIELDS_OFFSET + 1] =
    typeof isolate === "number" && isolate >= 0 ? isolate : -1;
  data[DEBUG_FIELDS_OFFSET + 2] = 0;
  data[DEBUG_FIELDS_OFFSET + 3] = 0;

  // ─── DP-H24: HSB shift (vec4) ───
  // Mirrors WebGL GlobeFS.glsl `u_hsbShift`. `Globe.update()` copies
  // `Globe.atmosphereHueShift/Saturation/Brightness` onto the tile
  // provider each frame, so tileProvider is authoritative here.
  // The shader gates the HSB round-trip on |any| > 0.001, so writing
  // zeros (the default) carries no GPU cost.
  data[HSB_SHIFT_OFFSET + 0] =
    typeof tileProvider.hueShift === "number" ? tileProvider.hueShift : 0;
  data[HSB_SHIFT_OFFSET + 1] =
    typeof tileProvider.saturationShift === "number"
      ? tileProvider.saturationShift
      : 0;
  data[HSB_SHIFT_OFFSET + 2] =
    typeof tileProvider.brightnessShift === "number"
      ? tileProvider.brightnessShift
      : 0;
  data[HSB_SHIFT_OFFSET + 3] = 0;

  // ─── GroundAtmosphere control (vec4) — Session 65 (2026-05-11) ───
  // Drives the no-fog GroundAtmosphere drape path in GlobeTerrain.wgsl,
  // matching WebGL's `#else` branch in GlobeFS.glsl that triggers when
  // FOG is undefined but GROUND_ATMOSPHERE is defined (i.e. camera is
  // above the fog maxHeight of 800 km). Without this, the drape is
  // invisible at orbital altitudes — only the SkyAtmosphere limb shell
  // renders, which is what the Hello-World screenshot was missing.
  //
  // Mirrors GlobeFS.glsl lines 369-391:
  //   cameraDist  = length(camera position from globe origin) [3D only]
  //   fadeOutDist = lightingFadeOutDistance (default π/2 × R ≈ 10 Mm)
  //   fadeInDist  = lightingFadeInDistance  (default π   × R ≈ 20 Mm)
  //   fade        = clamp((cameraDist - fadeOutDist) /
  //                       (fadeInDist - fadeOutDist), 0, 1)
  // Track V-A2 (NEW-ATMO-AERIAL-PERSPECTIVE-POSTPROCESS) — gate the per-tile
  // ground-atmosphere drape OFF when the unified aerial-perspective
  // post-process is active, so they don't double-apply (it owns the haze).
  const aerialPerspectiveActive =
    (frameState as { aerialPerspective?: boolean })?.aerialPerspective === true;
  const showGroundAtmosphere =
    !aerialPerspectiveActive &&
    (tileProvider as { showGroundAtmosphere?: boolean })
      .showGroundAtmosphere !== false;
  let groundAtmosphereFade = 0;
  if (showGroundAtmosphere) {
    const camPos = frameState.camera?.positionWC as
      | { x: number; y: number; z: number }
      | undefined;
    if (camPos) {
      const cameraDist = Math.sqrt(
        camPos.x * camPos.x + camPos.y * camPos.y + camPos.z * camPos.z,
      );
      const fadeOutDist =
        (tileProvider as { lightingFadeOutDistance?: number })
          .lightingFadeOutDistance ?? 10000000.0;
      const fadeInDist =
        (tileProvider as { lightingFadeInDistance?: number })
          .lightingFadeInDistance ?? 20000000.0;
      const span = fadeInDist - fadeOutDist;
      if (span > 1.0) {
        groundAtmosphereFade = Math.max(
          0,
          Math.min(1, (cameraDist - fadeOutDist) / span),
        );
      }
    }
  }
  data[GROUND_ATMOSPHERE_CONTROL_OFFSET + 0] =
    showGroundAtmosphere && groundAtmosphereFade > 0 ? 1.0 : 0.0;
  data[GROUND_ATMOSPHERE_CONTROL_OFFSET + 1] = groundAtmosphereFade;
  data[GROUND_ATMOSPHERE_CONTROL_OFFSET + 2] =
    (tileProvider as { atmosphereLightIntensity?: number })
      .atmosphereLightIntensity ?? 10.0;
  // .w = HDR-enabled flag. Mirrors WebGL GlobeFS.glsl `#ifdef HDR` —
  // when on, the drape branch SKIPS the inline `1 - exp(-fExposure * x)`
  // tonemap so the post-process chain can apply its own (the HDR
  // framebuffer holds linear-radiance values until the final pass).
  // Without this gate, demos like `Atmosphere.html` (which sets
  // `scene.highDynamicRange = true` plus a 2x default light intensity)
  // collapse to uniform tan because the inline tonemap saturates every
  // channel before the post-process gets a chance to compress.
  const hdrEnabled = (frameState as { useHDR?: boolean }).useHDR === true;
  data[GROUND_ATMOSPHERE_CONTROL_OFFSET + 3] = hdrEnabled ? 1.0 : 0.0;

  // ─── initialColor (vec4) — Batch 247, NEW-GROUND-VIEW-ENV-DIVERGENCES ───
  // Mirrors WebGL's `u_initialColor`: `globe.baseColor` on the first pass
  // (the color rendered where no imagery is available), transparent black
  // (`otherPassesInitialColor`) on subsequent multi-pass imagery passes —
  // the zeroed scratch already covers the subsequent-pass case. The WGSL
  // previously hardcoded vec3(0.04, 0.04, 0.06), rendering rgb(10,10,15)
  // where WebGL rendered the configured baseColor.
  if (!isSubsequentPass) {
    const baseColor = tileProvider?.baseColor;
    if (baseColor) {
      data[INITIAL_COLOR_OFFSET + 0] = baseColor.red ?? 0.0;
      data[INITIAL_COLOR_OFFSET + 1] = baseColor.green ?? 0.0;
      data[INITIAL_COLOR_OFFSET + 2] = baseColor.blue ?? 0.0;
      data[INITIAL_COLOR_OFFSET + 3] = baseColor.alpha ?? 1.0;
    } else {
      // GlobeSurfaceTileProvider's constructor default: Color(0, 0, 0.5, 1).
      data[INITIAL_COLOR_OFFSET + 2] = 0.5;
      data[INITIAL_COLOR_OFFSET + 3] = 1.0;
    }
  }

  // ─── GLOBE-TRANSLUCENCY-ALPHA: localizedTranslucencyRectangle (vec4) ───
  // Mirrors WebGL's `u_translucencyRectangle` packing
  // (GlobeSurfaceTileProviderRendering.js:1555-1607): antimeridian-clip
  // `globe.translucency.rectangle` against the tile rectangle, then localize
  // to tile-UV space (west, south, east, north). Only packed when the globe
  // is actually translucent — the scratch's zero default is inert because
  // the FS only reads this field inside the `camera.translucencyControl.x`
  // gate, which is closed unless `globeTranslucencyState.translucent`.
  const translucencyState = (
    frameState as
      | {
          globeTranslucencyState?: {
            translucent?: boolean;
            rectangle?: CesiumRectangle;
          };
        }
      | undefined
  )?.globeTranslucencyState;
  const translucencyRectangle = translucencyState?.rectangle;
  if (
    translucencyState?.translucent === true &&
    translucencyRectangle &&
    tile.rectangle
  ) {
    const clippedTranslucencyRectangle = clipRectangleAntimeridian(
      tile.rectangle,
      translucencyRectangle,
    ) as CesiumRectangle;
    const invW = 1.0 / tile.rectangle.width;
    const invH = 1.0 / tile.rectangle.height;
    data[LOCALIZED_TRANSLUCENCY_RECT_OFFSET + 0] =
      (clippedTranslucencyRectangle.west - tile.rectangle.west) * invW;
    data[LOCALIZED_TRANSLUCENCY_RECT_OFFSET + 1] =
      (clippedTranslucencyRectangle.south - tile.rectangle.south) * invH;
    data[LOCALIZED_TRANSLUCENCY_RECT_OFFSET + 2] =
      (clippedTranslucencyRectangle.east - tile.rectangle.west) * invW;
    data[LOCALIZED_TRANSLUCENCY_RECT_OFFSET + 3] =
      (clippedTranslucencyRectangle.north - tile.rectangle.south) * invH;
  }

  return writeUniformSlice(
    device,
    frameState,
    data,
    Math.max(TILE_UNIFORM_BYTES, 256),
    "Terrain tile UB",
  );
}
