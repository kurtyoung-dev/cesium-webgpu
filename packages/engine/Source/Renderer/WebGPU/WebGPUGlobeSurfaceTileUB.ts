/// <reference types="@webgpu/types" />
/**
 * Per-tile, per-pass `TileUniforms` packing for
 * `WebGPUGlobeSurfaceRenderer`.
 *
 * `createTileUniformBuffer(host, …)` lays the struct out against the
 * GlobeTerrain WGSL contract:
 *
 *   - Per-imagery-layer block (16 layers × 24 floats): translationAndScale,
 *     texCoordsRectangle, colorToAlpha (rgb + threshold), cutoutRectangle
 *     (in tile-UV), alpha/brightness/contrast/saturation,
 *     hue/oneOverGamma/split, and the tile size the layer's night-imagery
 *     magnification fade is measured against.
 *   - dayNightAlpha[8] vec4 array (packed 2 layers per vec4).
 *   - useWebMercatorTLayer[4] vec4 array (packed 4 layers per vec4).
 *   - Scalars: layerCount, fog density/offset/minBrightness, water-mask
 *     translation, cartographic limit rectangle, night fade in/out,
 *     vertical exaggeration, flags (waterMask/clipping/oceanWaves/
 *     subsequentPass), ocean params, night and ocean secondary params,
 *     wave time, fogVisualDensityScalar, splitPosition, debug fields,
 *     HSB shift.
 *   - Callback-shaped imagery-layer values resolve through
 *     `resolveImageryLayerValue` so dynamic-alpha use cases (hover-fade,
 *     time-of-day fade) work on WebGPU.
 *
 * Two diagnostic blocks are pragma-stripped in production:
 *   - The layer log (throttled to 1/sec on `_diagLastLayerCountLogMs`), which
 *     diagnoses the `layerCount=0` failure mode that produces empty tiles.
 *   - The fog log and fog-missing error (throttled to 1/sec on
 *     `_diagLastFogLogMs`, one-shot on `_diagFogMissingLogged`).
 *
 * The five host fields the packer reaches into are public on the renderer:
 *   - `_tileUniformData` (Float32Array scratch sized to TILE_UNIFORM_FLOATS)
 *   - `_tileUniformU32View` (Uint32Array view over the same buffer,
 *     scaffolding for bitfield slots; nothing in the current body reads it)
 *   - `_diagLastLayerCountLogMs`
 *   - `_diagLastFogLogMs`
 *   - `_diagFogMissingLogged`
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
  LIGHTING_FADE_OFFSET,
  TILE_CONTROLS_OFFSET,
  HSB_SHIFT_OFFSET,
  GROUND_ATMOSPHERE_CONTROL_OFFSET,
  INITIAL_COLOR_OFFSET,
  LOCALIZED_TRANSLUCENCY_RECT_OFFSET,
  OCEAN_WAVE_PHASE_A_OFFSET,
  OCEAN_WAVE_PHASE_B_OFFSET,
  OCEAN_OCTAVE_REPEATS,
  MAX_IMAGERY_LAYERS,
  resolveImageryLayerValue,
} from "./WebGPUGlobeSurfaceTypes.js";
// The enable/unset encoding for the night and ocean tunable slots lives in its
// own leaf so the CPU packer, the WGSL getters and the Node spec that
// cross-checks them all read one contract.
import { GLOBE_UB_UNSET, resolveGlobeTunable } from "./WebGPUGlobeTunables.js";
// Reuse the exact WebGL antimeridian-clip helper for the translucency
// rectangle rather than replicating the split logic here, which would drift.
// Backend-neutral pure function.
import { clipRectangleAntimeridian } from "../../Scene/GlobeSurfaceTileProviderRendering.js";
// The night layer's resolution fade is one law for both backends, so it lives
// in the Scene leaf the WebGL packer reads and is imported here rather than
// restated. Backend-neutral pure function.
import {
  nightImageryTileIsRetired,
  resolveNightImageryFadeTilePixels,
} from "../../Scene/GlobeNightImagery.js";
// WebGL's day/night camera-distance lighting fade lives in its own leaf for
// the same reason as `WebGPUGlobeTunables`: the packer, the shader and the
// Node spec that cross-checks both against `GlobeFS.glsl` all need to read one
// law, and only a leaf is importable from a spec.
import {
  computeLightingFade,
  type LightingFadeCamera,
  DEFAULT_LIGHTING_FADE_IN_DISTANCE,
  DEFAULT_LIGHTING_FADE_OUT_DISTANCE,
} from "./WebGPUGlobeLightingFade.js";
import SceneMode from "../../Scene/SceneMode.js";
import { writeUniformSlice } from "./WebGPUGlobeSurfaceCameraUB.js";
import { getActiveDebugSentinel } from "./WebGPUGlobeFragmentDebug.js";
import {
  resolveImageryProjection,
  type TextureCacheHost,
} from "./WebGPUGlobeSurfaceTextures.js";

/**
 * Per-frame increment for the deterministic ocean-wave animation clock.
 * Exported for the wrap-continuity regression spec; it is not public API.
 */
export const OCEAN_WAVE_FRAME_SPEED = 0.15;

/**
 * Every ocean-advection component multiplied by this period is an integer.
 * Therefore wrapping the clock preserves the `fract(time * advection)` phase
 * used by the shader while keeping the f32 time small enough for smooth motion.
 */
export const OCEAN_WAVE_TIME_PERIOD = 16000.0;

/**
 * Allocation-free equivalent of WGSL `fract` for the f64 CPU phase setup.
 */
export function fractionalPart(value: number): number {
  return value - Math.floor(value);
}

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

  // Imagery layers. Per-layer struct = 24 floats / 96 bytes. Unused slots
  // carry defaults (alpha 0), so the shader's `count` gate is the only thing
  // keeping them from contributing.
  let layerCount = 0;
  // Raised when any layer on this tile asks to fade across the terminator.
  // WebGL derives the same condition from the same resolved values and turns it
  // into the APPLY_DAY_NIGHT_ALPHA define; here it becomes a uniform, because
  // the WGSL selects its arms at runtime rather than at compile time.
  let dayNightAlphaActive = false;
  for (
    let i = 0;
    i < passLayers.length && layerCount < MAX_IMAGERY_LAYERS;
    i++
  ) {
    const tileImagery = passLayers[i];
    if (!tileImagery || !tileImagery.readyImagery) continue;

    const imagery = tileImagery.readyImagery;
    if (!imagery.imageryLayer) continue;

    // Below the deepest level the bundled night pyramid contains, one of its
    // texels covers the whole terrain tile and replaces the scene under it with
    // a single flat colour. The magnification fade itself is a per-fragment
    // weight the shader resolves; this is the bound past which no fragment of
    // this tile can carry any, so the layer takes no slot at all and the tile
    // packs exactly as it would with no night layer attached, with the
    // procedural fallback taking the night side back.
    if (nightImageryTileIsRetired(imagery.imageryLayer, tileImagery)) {
      continue;
    }

    const baseOffset = LAYERS_OFFSET + layerCount * LAYER_FLOATS;

    // Dual-texture cache. `WebGPUGlobeSurfaceTextures.
    // getOrCreateImageryTexture` binds the Mercator-projection GPUTexture when
    // `tileImagery.useWebMercatorT === true` and
    // `imagery._webgpuMercatorTexture` exists, and the Geographic-projection
    // variant otherwise. The shader's `useWebMercatorTLayer` flag has to track
    // that decision so `selectLayerUV` samples the bound texture in the
    // correct coordinate space.
    //
    // The cached `tileImagery.textureTranslationAndScale` and
    // `textureCoordinateRectangle` are already in the matching coordinate
    // space: `_calculateTextureTranslationAndScale` and
    // `createTileImagerySkeletons` branch on `useWebMercatorT` and produce
    // Mercator-space tile-UVs when true and geographic-space tile-UVs when
    // false. Honouring the bound texture's projection therefore lines the
    // cached translation/scale and texCoordsRect up with no inline recalc.
    //
    // The flag is derived from `resolveImageryProjection`, the same pure peek
    // `getOrCreateImageryTexture` uses to pick the bound variant, so it can
    // never diverge from the bound texture's actual projection — cache hits,
    // the Mercator-to-geographic fall-through, and the race-window bind all
    // resolve identically here and at bind-group creation. A local
    // `tileImagery.useWebMercatorT && !!_webgpuMercatorTexture` recompute
    // misses the cache and fall-through cases.
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

    // Per-layer scalars: hue (radians), oneOverGamma (pre-divided so the
    // shader avoids a divide), split (-1/0/+1 from the SplitDirection enum),
    // and a trailing pad that keeps the layer struct 16-byte aligned for the
    // WGSL uniform-address-space rules.
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
    // The tile size the layer's magnification fade is measured against. Zero
    // for every layer the globe did not attach itself, which is the sentinel
    // that leaves the shader's weight at exactly 1.0 for them.
    data[baseOffset + 23] = resolveNightImageryFadeTilePixels(layer);

    // useWebMercatorT (packed 4 layers per vec4). Bit i in the layer
    // sequence maps to component (i % 4) of vec4 (i / 4).
    //
    // `effectiveUseWebMercatorT` mirrors what
    // `WebGPUGlobeSurfaceTextures.getOrCreateImageryTexture` decides to bind.
    // WebGL's GlobeSurfaceTileProviderRendering selects between
    // `imagery.texture` (geographic) and `imagery.textureWebMercator`
    // (mercator) per tile; WebGPU mirrors that with
    // `imagery._webgpuReprojectedTexture` and
    // `imagery._webgpuMercatorTexture`. The flag keeps the shader's
    // `selectLayerUV` in lock-step with the bound texture's projection.
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
    // Read back the slots rather than the properties: a callback has already
    // been resolved here, and it is the resolved number the shader will blend.
    if (data[dnFloatBase + 0] !== 1.0 || data[dnFloatBase + 1] !== 1.0) {
      dayNightAlphaActive = true;
    }

    layerCount++;
  }

  // layerCount is stored as f32 and read in WGSL via `u32(tile.layerCount)`,
  // matching the convention the rest of this struct uses for count slots.
  data[LAYER_COUNT_OFFSET] = layerCount;

  //>>includeStart('debug', pragmas.debug);
  // Logs every frame, throttled to 1/sec, even when layerCount is 0 — that is
  // exactly the failure mode this catches. It fires independently of the
  // shared `_diagShouldLog` counter so center3D logging cannot starve it.

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

  // Fog parameters. `frameState.atmosphericConditions.weather.humidity`
  // (default 0.5, meaning no change) modulates fog density by a
  // (0.5 + humidity) multiplier: humidity 0.0 gives 0.5× density for a very
  // dry desert, 0.5 gives 1.0×, and 1.0 gives 1.5× for tropical jungle haze.
  // Linear and bounded, so the existing fog tuning stays predictable.
  //
  // When `fog.enabled === false` the density is forced to 0 regardless of what
  // `fog.density` says. `Fog.update()` early-returns when `this.enabled` is
  // false, leaving any prior non-zero density stale on `frameState.fog`, and
  // at planetary scale a stale density fogs every distant pixel to black.
  // Zeroing explicitly keeps the GPU state consistent with the user-facing
  // switch.
  if (frameState && frameState.fog) {
    // When the aerial-perspective post-process owns the atmosphere, the
    // in-globe fog density is forced to 0 so the two do not double-apply.
    const fogEnabled =
      frameState.fog.enabled !== false &&
      (frameState as { aerialPerspective?: boolean }).aerialPerspective !==
        true &&
      // WebGL disables terrain fog when the camera is underground
      // (`enableFog = frameState.fog.enabled && frameState.fog.renderable &&
      // !cameraUnderground` in
      // GlobeSurfaceTileProviderRendering.js:1229-1230). Without this gate the
      // WGSL fog mix saturates every underside fragment toward the near-black
      // underground atmosphere color and buries the imagery and
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
    // A throttle independent of the tile-center3D log, so fog state stays
    // visible at camera-altitude transitions. Logs once per second regardless
    // of what other diagnostics are firing.
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
    // Fires once. `frameState.fog` missing entirely means Scene.fog.update()
    // never ran for this frame, which leaves the density at whatever it was
    // last set to with no zeroing path — the globe then renders black at
    // orbit.

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

  // Water mask translation and scale (vec4).
  if (!isSubsequentPass) {
    const wmTS = surfaceTile.waterMaskTranslationAndScale;
    if (wmTS) {
      data[WATER_MASK_TS_OFFSET + 0] = wmTS.x;
      data[WATER_MASK_TS_OFFSET + 1] = wmTS.y;
      data[WATER_MASK_TS_OFFSET + 2] = wmTS.z;
      data[WATER_MASK_TS_OFFSET + 3] = wmTS.w;
    }
  }

  // Cartographic limit rectangle (vec4).
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

  // Night fade distances (two scalars).
  if (tileProvider) {
    data[NIGHT_FADE_OUT_OFFSET] =
      tileProvider.nightFadeOutDistance ?? 10000000.0;
    data[NIGHT_FADE_IN_OFFSET] = tileProvider.nightFadeInDistance ?? 50000000.0;
  } else {
    data[NIGHT_FADE_OUT_OFFSET] = 10000000.0;
    data[NIGHT_FADE_IN_OFFSET] = 50000000.0;
  }

  // Vertical exaggeration (two scalars).
  data[VERT_EXAG_OFFSET] = frameState?.verticalExaggeration ?? 1.0;
  data[VERT_EXAG_REL_HEIGHT_OFFSET] =
    frameState?.verticalExaggerationRelativeHeight ?? 0.0;

  // dayNightAlpha[8] vec4 array already set above during layer iteration.
  // useWebMercatorTLayer[4] vec4 array also set during layer iteration.

  // `flags.x` controls whether the WGSL `computeEnhancedOcean` path runs for
  // ocean fragments. WebGL gates the equivalent `computeWaterColor` on the
  // `SHOW_REFLECTIVE_OCEAN` shader define, which is emitted only when both:
  //   1. the terrain provider supplies a water mask (`hasWaterMask`)
  //   2. the user enabled water rendering (`globe.showWaterEffect`,
  //      default false)
  // Checking only the first condition runs the enhanced shader over every
  // ocean fragment, blending 40% imagery with 60% deep color and dimming
  // satellite aerial imagery by roughly 5x.
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

  // Ocean enhancement params: x=deepR, y=deepG, z=deepB, w=fresnelPower.
  //
  // "Unset" is `GLOBE_UB_UNSET` (negative), never `0.0`. `data` is zero-filled
  // at the top of this function, so an unwritten slot reads as an explicit
  // zero; every arm below therefore writes something. `enableEnhancedOcean`
  // off means not applicable — `ShaderDefineHi.ENHANCED_OCEAN` preprocesses
  // the consuming branch out — so the off arm carries the unset marker and the
  // shader returns its built-in defaults.
  const enhancedOceanOn = tileProvider?.enableEnhancedOcean === true;
  const deepColor = enhancedOceanOn ? tileProvider?.oceanDeepColor : undefined;
  if (deepColor) {
    data[OCEAN_PARAMS_OFFSET + 0] = deepColor.red ?? deepColor.x ?? 0.008;
    data[OCEAN_PARAMS_OFFSET + 1] = deepColor.green ?? deepColor.y ?? 0.045;
    data[OCEAN_PARAMS_OFFSET + 2] = deepColor.blue ?? deepColor.z ?? 0.12;
  } else {
    data[OCEAN_PARAMS_OFFSET + 0] = GLOBE_UB_UNSET;
    data[OCEAN_PARAMS_OFFSET + 1] = GLOBE_UB_UNSET;
    data[OCEAN_PARAMS_OFFSET + 2] = GLOBE_UB_UNSET;
  }
  data[OCEAN_PARAMS_OFFSET + 3] = resolveGlobeTunable(
    enhancedOceanOn,
    tileProvider?.oceanFresnelPower,
    GLOBE_UB_UNSET,
  );

  // Ocean wave animation clock, driven from `frameState.frameNumber` to mirror
  // WebGL's `czm_frameNumber`, which drives `computeWaterColor`'s wave
  // sampling as `time = czm_frameNumber * oceanAnimationSpeed`
  // (GlobeFS.glsl L800/805). WebGL animates on every rendered frame regardless
  // of the scene clock, so a paused or slow clock still shows churning ocean.
  // Deriving the phase from `frameState.time` (JulianDate seconds) instead
  // advances the wave UV by only ~0.012/s at the WGSL octave coefficients
  // (`sampleOceanWaveNormals` 0.012/0.008/0.03), which reads as frozen next to
  // WebGL's per-frame churn and stops entirely when the clock is paused.
  //
  // `frameNumber` is constant across all views of one `scene.render()`, so
  // there is no per-view phase drift the way there is with
  // `performance.now()`, and it is deterministic for a fixed warm-up frame
  // count, which regression captures depend on. `OCEAN_WAVE_FRAME_SPEED` is
  // the per-frame phase increment fed into the octave coefficients, tuned for
  // a gentle, WebGL-comparable churn.
  //
  // The modulus is 16000, not 1e6. The WGSL march does `fract(t × velocity)`
  // per octave, and with `t` up to 1e6 the largest advection `t × 0.03 ≈ 3e4`
  // has an f32 ulp (~0.004) comparable to the per-frame step (~0.0045), so the
  // ripple animation stutters near the top of the range. 16000 keeps
  // `t × 0.03 ≤ 480` (ulp ~3e-5, far below the step) and is commensurate with
  // every shader advection rate: 16000 × {0.008, 0.012, 0.018, 0.03} is
  // integral. The wrap at ~107k frames, about 30 minutes at 60 fps, therefore
  // lands on the same texture phase rather than a visible pop.
  const frameNumber = frameState?.frameNumber ?? 0;
  const waveTime =
    (frameNumber * OCEAN_WAVE_FRAME_SPEED) % OCEAN_WAVE_TIME_PERIOD;
  data[TIME_OFFSET] = waveTime;
  //>>includeStart('debug', pragmas.debug);
  // `CesiumDebug.globeFragmentDebug(name)`, or setting
  // `globalThis._webgpuGlobeDebugMode` directly, writes one of the sentinel
  // values from `GLOBE_FRAGMENT_DEBUG_MODES`. The WGSL `fragmentMain` reads
  // `tile.time` and short-circuits to a debug visualization when it crosses
  // 1e9. The registry lives in `WebGPUGlobeFragmentDebug.ts`; a new mode is
  // added there plus a matching WGSL branch in
  // `GlobeTerrain.wgsl::fragmentMain`.
  const debugSentinel = getActiveDebugSentinel();
  if (debugSentinel !== null) {
    data[TIME_OFFSET] = debugSentinel;
  }
  //>>includeEnd('debug');
  // fogVisualDensityScalar matches WebGL's `czm_fogVisualDensityScalar`
  // automatic uniform (default 0.15 from UniformState). Without it the fog
  // formula is ~6.7x stronger than WebGL at horizontal viewing angles.
  data[FOG_VIS_DENSITY_OFFSET] =
    frameState?.context?.uniformState?.fogVisualDensityScalar ?? 0.15;
  // splitPosition in framebuffer pixels, matching gl_FragCoord and
  // `czm_splitPosition`. Sourced from `frameState.splitPosition`, a 0..1
  // fraction where 0.5 is the canvas centre, times the drawing buffer width.
  const splitFrac =
    typeof frameState?.splitPosition === "number"
      ? frameState.splitPosition
      : 0.5;
  const drawWidth =
    (frameState?.context as { drawingBufferWidth?: number } | undefined)
      ?.drawingBufferWidth ?? 0;
  data[SPLIT_POSITION_OFFSET] = splitFrac * drawWidth;

  // WebGL's day/night camera-distance fade. The DAYNIGHT_SHADING arm consumes
  // it as `mix(1.0, diffuseIntensity, fade)` (GlobeFS.glsl:852), so 0 is
  // flat-lit near the ground and 1 is full day/night at orbit. It is ungated,
  // unlike `groundAtmosphereControl.y` below, which carries the identical
  // clamp but is zeroed whenever the ground-atmosphere drape is off: WebGL
  // computes this fade under `ENABLE_DAYNIGHT_SHADING || GROUND_ATMOSPHERE`,
  // so turning the drape off must not flat-light the globe.
  //
  // The two distances live on the tile provider (`Globe.js:1204-1205` copies
  // them each frame); `WebGPUGlobeLightingFade`'s exported defaults are the
  // fallback if a provider never got that copy.
  const lightingProvider = tileProvider as {
    lightingFadeOutDistance?: number;
    lightingFadeInDistance?: number;
  };
  const ellipsoidMaxRadius =
    (
      frameState?.mapProjection as
        { ellipsoid?: { maximumRadius?: number } } | undefined
    )?.ellipsoid?.maximumRadius ?? 6378137.0;
  data[LIGHTING_FADE_OFFSET] = computeLightingFade(
    frameState?.mode ?? SceneMode.SCENE3D,
    frameState?.camera as unknown as LightingFadeCamera | undefined,
    lightingProvider.lightingFadeOutDistance ??
      DEFAULT_LIGHTING_FADE_OUT_DISTANCE,
    lightingProvider.lightingFadeInDistance ??
      DEFAULT_LIGHTING_FADE_IN_DISTANCE,
    ellipsoidMaxRadius,
  );

  // Night and ocean secondary params: x=nightIntensity, y=oceanReflectivity,
  // z=foamThreshold, w=oceanDarkening.
  //
  // The enable arrives as its own signal (`tileProvider.enableNightLights` /
  // `.enableEnhancedOcean`, both mirrored by `Globe.update()`) and the value
  // slot carries only a value. Collapsing the two into one number by writing
  // `0.0` on the off path makes `globe.enableNightLights = false` render as
  // default-on, because `getNightIntensity()` reads `0.0` as "use 2.5". With
  // the feature shipping ON, that is the whole of the toggle: an off state that
  // renders as on leaves the property with nothing to do.
  //
  // The two features answer "what does off mean" differently, which is why
  // `resolveGlobeTunable` takes the off value explicitly:
  //   night lights   → 0.0            (zero emission; the shader multiplies by it)
  //   enhanced ocean → GLOBE_UB_UNSET (branch removed by the define; no value)
  const nightLightsOn = tileProvider?.enableNightLights !== false;
  data[NIGHT_OCEAN_PARAMS_OFFSET + 0] = resolveGlobeTunable(
    nightLightsOn,
    tileProvider?.nightIntensity,
    0.0,
  );
  data[NIGHT_OCEAN_PARAMS_OFFSET + 1] = resolveGlobeTunable(
    enhancedOceanOn,
    tileProvider?.oceanReflectivity,
    GLOBE_UB_UNSET,
  );
  data[NIGHT_OCEAN_PARAMS_OFFSET + 2] = resolveGlobeTunable(
    enhancedOceanOn,
    tileProvider?.oceanFoamThreshold,
    GLOBE_UB_UNSET,
  );
  data[NIGHT_OCEAN_PARAMS_OFFSET + 3] = resolveGlobeTunable(
    enhancedOceanOn,
    tileProvider?.oceanDarkening,
    GLOBE_UB_UNSET,
  );

  // Per-tile controls. The first two remain diagnostics; the third is the
  // backend-neutral Globe appearance strength mirrored by Globe.beginFrame.
  //   .x = tileLevel — read by fragmentDebugLod for the LOD overlay
  //   .y = isolateImageryLayer — when >= 0, fragmentMain renders only
  //        that layer index (0..15 within the current pass) and skips
  //        the rest of the imagery composite. -1 = production behavior.
  //   .z = optional terminator glow strength; 0 = natural/parity identity
  //   .w = dayNightAlphaActive — 1.0 when a layer on this tile carries a
  //        day/night alpha away from 1.0. The fragment shader opens the
  //        day/night fade on it independently of camera.enableLighting, so a
  //        night imagery layer is visible on an unlit globe. Zero on every
  //        default globe, where all layers resolve to (1, 1).
  data[TILE_CONTROLS_OFFSET + 0] = tile?.level ?? 0;
  const isolate = frameState.debugShowImageryLayer;
  data[TILE_CONTROLS_OFFSET + 1] =
    typeof isolate === "number" && isolate >= 0 ? isolate : -1;
  data[TILE_CONTROLS_OFFSET + 2] = tileProvider.terminatorGlowStrength ?? 0.0;
  data[TILE_CONTROLS_OFFSET + 3] = dayNightAlphaActive ? 1.0 : 0.0;

  // HSB shift. Mirrors WebGL GlobeFS.glsl `u_hsbShift`. `Globe.update()` copies
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
  // The fourth HSB slot is alignment padding on a vec3 payload, not an HSB
  // channel; it carries the procedural night-darkening multiplier. 1.0 is the
  // multiplicative identity, which is also what a tile provider that never
  // heard of the property resolves to.
  //
  // The suppression against the layer path is NOT folded in here: the fallback
  // supplies the share of the night side the layers leave uncovered, and that
  // share is a per-fragment quantity because the magnification fade producing it
  // is one — folded from a single tile's texel count it steps across a terrain
  // LOD seam, where the magnification itself does not. So the floor travels and
  // the shader resolves the share while the layers composite; full coverage
  // still leaves the term at the identity. WebGL packs the same floor into
  // `u_nightDarkness` and derives its `APPLY_NIGHT_DARKNESS` define from it, so
  // both backends read one number and resolve one share.
  const nightDarkness = (tileProvider as { nightDarkness?: number })
    .nightDarkness;
  const sanitizedNightDarkness =
    typeof nightDarkness === "number" && Number.isFinite(nightDarkness)
      ? Math.min(Math.max(nightDarkness, 0.0), 1.0)
      : 1.0;
  data[HSB_SHIFT_OFFSET + 3] = sanitizedNightDarkness;

  // Ground-atmosphere control. Drives the no-fog ground-atmosphere drape path
  // in GlobeTerrain.wgsl, matching WebGL's `#else` branch in GlobeFS.glsl that
  // triggers when FOG is undefined but GROUND_ATMOSPHERE is defined — that is,
  // when the camera is above the fog maxHeight of 800 km. Without it the drape
  // is invisible at orbital altitudes and only the SkyAtmosphere limb shell
  // renders.
  //
  // Mirrors GlobeFS.glsl lines 369-391:
  //   cameraDist  = length(camera position from globe origin) [3D only]
  //   fadeOutDist = lightingFadeOutDistance (default π/2 × R ≈ 10 Mm)
  //   fadeInDist  = lightingFadeInDistance  (default π   × R ≈ 20 Mm)
  //   fade        = clamp((cameraDist - fadeOutDist) /
  //                       (fadeInDist - fadeOutDist), 0, 1)
  //
  // The per-tile drape is gated off when the unified aerial-perspective
  // post-process is active, since that owns the haze and the two would
  // double-apply.
  const aerialPerspectiveActive =
    (frameState as { aerialPerspective?: boolean })?.aerialPerspective === true;
  const showGroundAtmosphere =
    !aerialPerspectiveActive &&
    (tileProvider as { showGroundAtmosphere?: boolean })
      .showGroundAtmosphere !== false;
  let groundAtmosphereFade = 0;
  if (showGroundAtmosphere) {
    const camPos = frameState.camera?.positionWC as
      { x: number; y: number; z: number } | undefined;
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
  // .w = HDR-enabled flag, mirroring WebGL GlobeFS.glsl's `#ifdef HDR`. When
  // on, the drape branch skips the inline `1 - exp(-fExposure * x)` tonemap so
  // the post-process chain can apply its own; the HDR framebuffer holds
  // linear-radiance values until the final pass. Without the gate, demos such
  // as `Atmosphere.html`, which sets `scene.highDynamicRange = true` plus a
  // doubled default light intensity, collapse to uniform tan, because the
  // inline tonemap saturates every channel before the post-process gets a
  // chance to compress.
  const hdrEnabled = (frameState as { useHDR?: boolean }).useHDR === true;
  data[GROUND_ATMOSPHERE_CONTROL_OFFSET + 3] = hdrEnabled ? 1.0 : 0.0;

  // initialColor mirrors WebGL's `u_initialColor`: `globe.baseColor` on the
  // first pass, which is the color rendered where no imagery is available, and
  // transparent black (`otherPassesInitialColor`) on subsequent multi-pass
  // imagery passes. The zeroed scratch already covers the subsequent-pass
  // case.
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

  // localizedTranslucencyRectangle mirrors WebGL's `u_translucencyRectangle`
  // packing
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

  // Ocean-wave phase offsets and normalized span. The WGSL march samples 3
  // octaves in a global ellipsoid (lon/lat) UV at integer normal-map
  // repeat counts Rᵢ = round(circumference / wavelengthᵢ). The absolute sample
  // coordinate `euv × Rᵢ` reaches ~2.7e6 for the 15 m ripple, whose f32 ulp is
  // ~0.25 of a repeat, which quantizes the coordinate into staircase bands and
  // freezes the small-delta time advection. The large magnitude comes out the
  // same way it does for RTE positions: the per-tile per-octave phase offset
  // is computed in f64 here as fract(rectOriginNorm × Rᵢ) per axis and only
  // the [0,1) remainder is packed, so the shader reconstructs the coordinate
  // from small quantities (phaseOffset + tileLocalUV × spanNorm × Rᵢ +
  // fract(time)). Because Rᵢ is an exact integer, adjacent tiles and the ±180°
  // wrap stay phase-continuous. The normalized span is packed rather than
  // derived as east−west in the FS, which would suffer f32 cancellation and
  // produce wave-scale seams at fine LOD.
  if (tile.rectangle) {
    const ONE_OVER_TWO_PI = 0.15915494309189535;
    const ONE_OVER_PI = 0.3183098861837907;
    // SW-corner of the tile in normalized ellipsoid UV (matches the shader's
    // `oceanEllipsoidUV`: lon×1/2π+0.5, lat×1/π+0.5), computed in f64.
    const originU = tile.rectangle.west * ONE_OVER_TWO_PI + 0.5;
    const originV = tile.rectangle.south * ONE_OVER_PI + 0.5;
    const spanU = tile.rectangle.width * ONE_OVER_TWO_PI;
    const spanV = tile.rectangle.height * ONE_OVER_PI;
    data[OCEAN_WAVE_PHASE_A_OFFSET + 0] = fractionalPart(
      originU * OCEAN_OCTAVE_REPEATS[0],
    );
    data[OCEAN_WAVE_PHASE_A_OFFSET + 1] = fractionalPart(
      originV * OCEAN_OCTAVE_REPEATS[0],
    );
    data[OCEAN_WAVE_PHASE_A_OFFSET + 2] = fractionalPart(
      originU * OCEAN_OCTAVE_REPEATS[1],
    );
    data[OCEAN_WAVE_PHASE_A_OFFSET + 3] = fractionalPart(
      originV * OCEAN_OCTAVE_REPEATS[1],
    );
    data[OCEAN_WAVE_PHASE_B_OFFSET + 0] = fractionalPart(
      originU * OCEAN_OCTAVE_REPEATS[2],
    );
    data[OCEAN_WAVE_PHASE_B_OFFSET + 1] = fractionalPart(
      originV * OCEAN_OCTAVE_REPEATS[2],
    );
    data[OCEAN_WAVE_PHASE_B_OFFSET + 2] = spanU;
    data[OCEAN_WAVE_PHASE_B_OFFSET + 3] = spanV;
  }

  return writeUniformSlice(
    device,
    frameState,
    data,
    Math.max(TILE_UNIFORM_BYTES, 256),
    "Terrain tile UB",
  );
}
