/// <reference types="@webgpu/types" />
/**
 * Texture-cache helpers extracted from `WebGPUGlobeSurfaceRenderer`.
 *
 * Batch 148 of the audit-recommended decomposition (fourth slice of the
 * GlobeSurface decomposition arc — see
 * `migration_doc/BATCH_145_PLAN_GLOBE_SURFACE_DECOMPOSITION.md`).
 *
 * Moves the three image-upload methods off the renderer class:
 *
 *   - `getOrCreateImageryTexture(host, imagery)` — caches per-imagery
 *     `GPUTextureView`. Fast-path for already-uploaded tiles, with a
 *     special branch for tiles that the WebGPU imagery reprojection
 *     pipeline pre-uploaded into a `GPUTexture`.
 *   - `getOrCreateWaterMaskTexture(host, waterMaskTex)` — borrows an
 *     already-realized compatibility-stub texture when it belongs to the
 *     renderer's device, otherwise caches a cross-device fallback upload.
 *   - `uploadImageSource(host, source, cacheKey, cache)` — the shared
 *     upload primitive: validates the source is a GPU-copyable type,
 *     allocates a `GPUTexture`, runs `copyExternalImageToTexture`, and
 *     records the result in the caller-supplied cache. Returns null on
 *     any error so the caller's cache miss path retries next frame.
 *
 * The renderer's `_getOrCreateImageryTexture` / `_getOrCreateWaterMaskTexture`
 * methods are removed entirely (each had a single caller). The
 * `_uploadImageSource` method is also removed; the lone external caller
 * (the ocean normal map upload in `_createWaterOceanBindGroup`) now
 * invokes the helper directly.
 *
 * The four host fields/methods these helpers reach into are flipped
 * from `private` to `public` on the renderer (with the underscore
 * prefix preserved as the "do-not-call-from-outside-the-Renderer-package"
 * marker per the convention used in Batches 142–147).
 *
 * @module WebGPUGlobeSurfaceTextures
 */

import type {
  ImageryGPUTexture,
  WebGPUGlobeLogicalCounters,
} from "./WebGPUGlobeSurfaceTypes.js";
import { WebGPUMipmapGenerator } from "./WebGPUMipmapGenerator.js";
import type { WebGPUSharedImageryRealizations } from "./WebGPUSharedImageryRealizations.js";
import { getShareableImagerySourceIdentity } from "../ImagerySourceIdentity.js";

/**
 * The subset of `WebGPUContext` the texture helpers reach for C9-12A frame-owned
 * mip preparation and deferred texture retirement. Kept structural to avoid a
 * hard import cycle with `WebGPUContext`.
 */
export interface ImageryRealizationContext {
  enqueueImageryMipGeneration(
    texture: GPUTexture,
    format: GPUTextureFormat,
    mipLevelCount: number,
  ): void;
  scheduleTextureDestroy(texture: GPUTexture | null | undefined): void;
  /** F7 (Batch 686) — stamp a texture destroyed INLINE (dies immediately, not
   * deferred) so a same-frame pending mip job for it is dropped rather than
   * encoded against a dead texture. Optional for structural-typing tolerance. */
  noteInlineTextureDestroy?(texture: GPUTexture): void;
}

// Lazily-allocated mipmap generator, shared across all imagery uploads
// (and reprojection outputs — same device, same shader, same sampler).
// Allocated on first use to avoid paying for it when the WebGPU backend
// isn't active. The generator caches per-format pipelines internally.
let _mipmapGenerator: WebGPUMipmapGenerator | null = null;
let _mipmapGeneratorDevice: GPUDevice | null = null;
function ensureMipmapGenerator(device: GPUDevice): WebGPUMipmapGenerator {
  if (_mipmapGenerator !== null && _mipmapGeneratorDevice === device) {
    return _mipmapGenerator;
  }
  _mipmapGenerator = new WebGPUMipmapGenerator(device);
  _mipmapGeneratorDevice = device;
  return _mipmapGenerator;
}

// `Math.floor(Math.log2(maxDim)) + 1` mip levels — same convention as
// the cubemap loader and WebGL's `gl.generateMipmap`. A 256×256 imagery
// tile gets 9 mip levels (256, 128, 64, 32, 16, 8, 4, 2, 1). Without
// mipmaps the GPU point-samples Level-0 at orbital altitudes where one
// fragment covers many texels, producing severe aliasing AND a
// brightness drop because the alias pattern under-samples bright
// pixels. Batch 57 — root cause of the WebGPU/WebGL brightness gap.
function mipLevelCountFor(width: number, height: number): number {
  return Math.floor(Math.log2(Math.max(width, height))) + 1;
}

/**
 * Register (or extend) the per-imagery cleanup that drops this imagery's
 * renderer texture-cache entry when the imagery is evicted
 * (`Imagery.releaseReference`).
 *
 * The `_imageryTextureCache` outlives the imagery object: an imagery is
 * evicted + re-created (same tile x/y/level key) many times while the cache
 * keeps one entry per key. Without this, after the evicting imagery frees its
 * `GPUTexture` the cache would still serve a `GPUTextureView` onto that freed
 * texture → "Destroyed texture used in a submit". The identity guard
 * (`cache.get(key)?.texture === texture`) ensures we only drop the entry while
 * it still wraps the texture we cached — a re-created imagery may have already
 * replaced it with its own.
 */
function registerImageryCacheCleanup(
  imagery: CesiumReadyImagery,
  cache: Map<string, ImageryGPUTexture>,
  key: string,
  texture: GPUTexture,
): void {
  const previous = imagery._webgpuTextureCacheCleanup;
  imagery._webgpuTextureCacheCleanup = () => {
    if (previous) {
      previous();
    }
    if (cache.get(key)?.texture === texture) {
      cache.delete(key);
    }
  };
}

/**
 * The renderer surface the texture-cache helpers reach into.
 *
 *   - `_device`: read-only.
 *   - `_imageryTextureCache` / `_waterMaskTextureCache`: read+write Maps.
 *   - `_diagShouldLog()`: pragma-stripped throttle predicate. Returns
 *     `false` in production builds (the body is wrapped in
 *     `//>>includeStart('debug', pragmas.debug)`), so any diagnostic
 *     `console.log`/`console.warn` guarded by it dead-code-eliminates.
 */
export interface TextureCacheHost {
  readonly _device: GPUDevice | null;
  readonly _imageryTextureCache: Map<string, ImageryGPUTexture>;
  readonly _waterMaskTextureCache: Map<string, ImageryGPUTexture>;
  readonly _logicalCounters?: WebGPUGlobeLogicalCounters | null;
  // C9-12A — the per-context shared imagery realization table and the context
  // used for frame-owned mip prep + deferred retirement. Both are null until
  // the first tile-command frame plumbs them (uploads only occur from that
  // path, so they are populated before `uploadImageSource` ever runs).
  _sharedImageryRealizations?: WebGPUSharedImageryRealizations | null;
  _webgpuContext?: ImageryRealizationContext | null;
  _diagShouldLog(): boolean;
}

type StubBackedWaterMaskTexture = Omit<CesiumTextureWithSource, "_texture"> & {
  _context?: {
    device?: GPUDevice | null;
  };
  _texture?: {
    _webgpuTexture?: {
      texture: GPUTexture;
      view: GPUTextureView;
    } | null;
  };
};

function incrementLogicalCounter(
  counters: WebGPUGlobeLogicalCounters | null | undefined,
  name: keyof WebGPUGlobeLogicalCounters,
  amount = 1,
): void {
  if (!counters) return;
  counters[name] = (counters[name] ?? 0) + amount;
}

function rgba8MipChainBytes(
  width: number,
  height: number,
  mipLevelCount: number,
): number {
  let bytes = 0;
  for (let level = 0; level < mipLevelCount; level++) {
    bytes += Math.max(1, width >> level) * Math.max(1, height >> level) * 4;
  }
  return bytes;
}

function recordOwnedImageryAdded(
  host: TextureCacheHost,
  byteSize: number,
): void {
  const counters = host._logicalCounters;
  if (!counters) return;
  incrementLogicalCounter(counters, "imageryDirectUploads");
  incrementLogicalCounter(counters, "imageryDirectUploadBytes", byteSize);
  incrementLogicalCounter(counters, "imageryOwnedLiveTextures");
  incrementLogicalCounter(counters, "imageryOwnedLiveBytes", byteSize);
  counters.imageryOwnedHighWaterTextures = Math.max(
    counters.imageryOwnedHighWaterTextures ?? 0,
    counters.imageryOwnedLiveTextures ?? 0,
  );
  counters.imageryOwnedHighWaterBytes = Math.max(
    counters.imageryOwnedHighWaterBytes ?? 0,
    counters.imageryOwnedLiveBytes ?? 0,
  );
}

function recordOwnedImageryRetired(
  host: TextureCacheHost,
  byteSize: number,
): void {
  const counters = host._logicalCounters;
  if (!counters) return;
  incrementLogicalCounter(counters, "imageryOwnedRetirements");
  incrementLogicalCounter(counters, "imageryOwnedLiveTextures", -1);
  incrementLogicalCounter(counters, "imageryOwnedLiveBytes", -byteSize);
}

function recordRealizationLiveBytes(host: TextureCacheHost): void {
  const counters = host._logicalCounters;
  const table = host._sharedImageryRealizations;
  if (!counters || !table) return;
  counters.imageryRealizationLiveBytes = table.getDiagnostics().liveBytes;
}

// F5 (Batch 686) — layer-scoped imagery cache key. `imagery.key` is never
// assigned in-tree, so the fallback was a bare `x_y_level` string with NO
// layer/provider component: two geographic-provider ImageryLayers whose tiles
// share coordinates aliased each other's cached GPUTexture on the cache-hit
// branch (filed as NEW-WEBGPU-IMAGERY-CACHE-KEY-CROSS-LAYER-COLLISION).
// Prefixing a stable per-ImageryLayer id closes the collision at the root.
// Memory stays deduped for shareable sources — the realization table BELOW the
// cache keys on source identity, not on this string. The two derivation sites
// (`resolveImageryProjection` / `getOrCreateImageryTexture`) both route here.
let _nextImageryLayerId = 1;
const _imageryLayerIds = new WeakMap<object, number>();
function imageryCacheKey(imagery: CesiumReadyImagery): string {
  if (imagery.key) return imagery.key;
  const layer = imagery.imageryLayer as object | undefined;
  let lid = 0;
  if (layer) {
    lid = _imageryLayerIds.get(layer) ?? _nextImageryLayerId++;
    _imageryLayerIds.set(layer, lid);
  }
  return `L${lid}_${imagery.x ?? 0}_${imagery.y ?? 0}_${imagery.level ?? 0}`;
}

/**
 * Register the per-imagery cleanup for a direct-upload / shared-realization
 * cache entry (C9-12A). Unlike {@link registerImageryCacheCleanup} (which only
 * drops the map entry, used for reprojection-produced textures the imagery
 * owns), this releases the shared realization reference or retires the owned
 * texture through the context's deferred destroy, closing the historical
 * zero-retirement leak on the direct-upload path.
 *
 * Identity-guarded (`cache.get(key)?.texture === entry.texture`) so a later
 * re-realization under a reused key is not clobbered.
 */
function registerImageryUploadCleanup(
  host: TextureCacheHost,
  imagery: CesiumReadyImagery,
  key: string,
  entry: ImageryGPUTexture,
): void {
  const cache = host._imageryTextureCache;
  const texture = entry.texture;
  const shared = entry.shared;
  const byteSize = entry.byteSize ?? 0;
  const previous = imagery._webgpuTextureCacheCleanup;
  imagery._webgpuTextureCacheCleanup = () => {
    if (previous) {
      previous();
    }
    if (cache.get(key)?.texture !== texture) {
      return;
    }
    cache.delete(key);
    if (shared) {
      const table = host._sharedImageryRealizations;
      if (table) {
        // Batch 686 (F0b/F2a) — destruction routes through a live context's
        // deferred destroy supplied at call time; never-shared entries retire
        // promptly here (counter below), ever-shared ones enter the pool.
        const ctx = host._webgpuContext;
        const retired = table.release(shared, (t) => {
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
        if (retired) {
          incrementLogicalCounter(
            host._logicalCounters,
            "imageryRealizationRetirements",
          );
        }
        recordRealizationLiveBytes(host);
      }
    } else {
      const ctx = host._webgpuContext;
      if (ctx) {
        ctx.scheduleTextureDestroy(texture);
      } else {
        try {
          texture.destroy();
        } catch {
          // Device already lost — destroy() is a safe no-op.
        }
      }
      recordOwnedImageryRetired(host, byteSize);
    }
  };
}

/**
 * Resolve a `GPUTextureView` for an imagery layer's tile, picking the
 * Mercator-projection or Geographic-projection variant based on the
 * tile's per-skeleton `useWebMercatorT` flag.
 *
 * Batch 65 — dual-texture cache. Two cache entries per imagery:
 *
 *   - `${key}_merc` → `imagery._webgpuMercatorTexture` (set by
 *     `ImageryLayer._reprojectTexture` on the `uploadAndReproject`
 *     path for Mercator providers). Used when `tileImagery.useWebMercatorT
 *     === true` — the cached `textureTranslationAndScale` and
 *     `textureCoordinateRectangle` are in Mercator-space, so the
 *     matching Mercator texture must be bound.
 *
 *   - `${key}` → `imagery._webgpuReprojectedTexture` (Geographic) OR
 *     the result of uploading `imagery.image` directly (Geographic
 *     providers — no reprojection runs). Used when
 *     `tileImagery.useWebMercatorT === false`.
 *
 * If the requested variant doesn't exist, the function gracefully
 * downgrades:
 *
 *   - Want merc, have merc → bind merc.
 *   - Want merc, no merc, have reprojected → bind reprojected (the
 *     caller's `effectiveUseWebMercatorT` must follow suit so the
 *     shader samples geographic-V).
 *   - Want geographic, have reprojected → bind reprojected.
 *   - Want geographic, only have merc (race window before reproject
 *     finishes) → bind merc (caller must flip
 *     `effectiveUseWebMercatorT` so the shader samples Mercator-V).
 *   - Nothing GPU-resident → upload `imagery.image` as the geographic
 *     variant (legacy path for geographic providers).
 *
 * Returns `{ view, isMercator }` so the caller can keep
 * `useWebMercatorTLayer` in lock-step with what was actually bound.
 * Returns null when the imagery is missing or every fallback fails.
 */
/**
 * The single authority for the Mercator-vs-geographic projection
 * decision used by both the texture binding (`getOrCreateImageryTexture`)
 * and the tile-uniform-buffer's `useWebMercatorTLayer` flag
 * (`createTileUniformBuffer`).
 *
 * NEW-USEWEBMERCATORT-SINGLE-SOURCE (Batch 304): previously the tile-UB
 * packer recomputed the flag as `tileImagery.useWebMercatorT &&
 * !!imagery._webgpuMercatorTexture`, which does NOT match the richer
 * decision tree in `getOrCreateImageryTexture` (cache hits, the
 * geographic fall-through when a Mercator skeleton has no merc texture,
 * and the race-window bind where only the merc texture is resident).
 * In those windows the shader's V-coordinate space and the bound
 * texture's actual projection could disagree, producing a misprojected
 * imagery strip until the next steady-state frame. Routing both
 * consumers through this pure peek closes that gap.
 *
 * Pure: no uploads, no cache writes — it only inspects the imagery
 * texture cache and the per-imagery dual-texture fields. The `variant`
 * mirrors which branch `getOrCreateImageryTexture` will take:
 *
 *   - `"merc"`   → a Mercator GPUTexture is (or will be) bound; isMercator true.
 *   - `"geo"`    → a geographic (reprojected/cached) GPUTexture is bound; false.
 *   - `"upload"` → nothing GPU-resident yet; the direct `imagery.image`
 *                  upload path runs, producing geographic data; false.
 *
 * Returns null only when there is no `readyImagery` to resolve.
 */
export function resolveImageryProjection(
  host: TextureCacheHost,
  tileImagery: CesiumTileImagery | null | undefined,
): { variant: "merc" | "geo" | "upload"; isMercator: boolean } | null {
  if (!tileImagery) return null;
  const imagery = tileImagery.readyImagery as CesiumReadyImagery | undefined;
  if (!imagery) return null;

  const baseKey = imageryCacheKey(imagery);
  const wantMercator = !!tileImagery.useWebMercatorT;

  // First preference: Mercator variant when the skeleton requested it
  // and a Mercator source (cached view or pre-reprojected GPUTexture)
  // is resident.
  if (wantMercator) {
    if (
      host._imageryTextureCache.has(`${baseKey}_merc`) ||
      imagery._webgpuMercatorTexture
    ) {
      return { variant: "merc", isMercator: true };
    }
    // Mercator requested but no Mercator texture yet — fall through to
    // geographic so the tile still renders (flag flips to geographic-V).
  }

  // Geographic variant: cached geo view or the pre-reprojected texture.
  if (
    host._imageryTextureCache.has(baseKey) ||
    imagery._webgpuReprojectedTexture
  ) {
    return { variant: "geo", isMercator: false };
  }

  // Race window: only the Mercator texture is resident (reprojection
  // hasn't produced the geographic version yet). Bind it and flag
  // Mercator-V so the shader stays consistent with the bound data.
  if (imagery._webgpuMercatorTexture) {
    return { variant: "merc", isMercator: true };
  }

  // Nothing GPU-resident — the direct `imagery.image` upload path runs,
  // which always produces geographic-V data.
  return { variant: "upload", isMercator: false };
}

export function getOrCreateImageryTexture(
  host: TextureCacheHost,
  tileImagery: CesiumTileImagery | null | undefined,
): { view: GPUTextureView; isMercator: boolean } | null {
  if (!tileImagery) return null;
  // The `CesiumTileImagery.readyImagery` inline shape omits a few
  // fields that the standalone `CesiumReadyImagery` interface
  // declares (key, x/y/level coords, _source). Cast to the full
  // shape so the lookup logic can read them.
  const imagery = tileImagery.readyImagery as CesiumReadyImagery | undefined;
  if (!imagery) return null;
  const logicalCounters = host._logicalCounters;

  const baseKey = imageryCacheKey(imagery);

  // NEW-USEWEBMERCATORT-SINGLE-SOURCE (Batch 304) — the projection
  // decision (Mercator vs geographic variant) is computed ONCE in
  // `resolveImageryProjection` so the bound texture, the shader's
  // `useWebMercatorTLayer` flag, and the cached translation/scale
  // coordinate space can't diverge. `resolveImageryProjection` is a
  // pure peek (no uploads, no cache writes); the branches below honor
  // its `variant` choice exactly.
  const projection = resolveImageryProjection(host, tileImagery);

  // First-preference lookup: Mercator variant when the peek chose it.
  if (projection?.variant === "merc") {
    const cachedMerc = host._imageryTextureCache.get(`${baseKey}_merc`);
    if (cachedMerc) {
      if (logicalCounters) {
        logicalCounters.imageryTextureCacheHits =
          (logicalCounters.imageryTextureCacheHits ?? 0) + 1;
      }
      return { view: cachedMerc.view, isMercator: true };
    }
    if (imagery._webgpuMercatorTexture) {
      if (logicalCounters) {
        logicalCounters.imageryTextureCacheMisses =
          (logicalCounters.imageryTextureCacheMisses ?? 0) + 1;
      }
      const gpuTex = imagery._webgpuMercatorTexture;
      const view = gpuTex.createView({ label: `imagery_merc_${baseKey}` });
      host._imageryTextureCache.set(`${baseKey}_merc`, {
        texture: gpuTex,
        view,
        sourceWidth: gpuTex.width,
        sourceHeight: gpuTex.height,
      });
      registerImageryCacheCleanup(
        imagery,
        host._imageryTextureCache,
        `${baseKey}_merc`,
        gpuTex,
      );
      return { view, isMercator: true };
    }
    // Unreachable: the peek only returns "merc" when one of the two
    // mercator sources above exists. Fall through defensively.
  }

  // Geographic variant lookup.
  if (projection?.variant === "geo") {
    const cachedGeo = host._imageryTextureCache.get(baseKey);
    if (cachedGeo) {
      if (logicalCounters) {
        logicalCounters.imageryTextureCacheHits =
          (logicalCounters.imageryTextureCacheHits ?? 0) + 1;
      }
      return { view: cachedGeo.view, isMercator: false };
    }

    if (imagery._webgpuReprojectedTexture) {
      if (logicalCounters) {
        logicalCounters.imageryTextureCacheMisses =
          (logicalCounters.imageryTextureCacheMisses ?? 0) + 1;
      }
      const gpuTex = imagery._webgpuReprojectedTexture;
      const view = gpuTex.createView({ label: `imagery_reproj_${baseKey}` });
      host._imageryTextureCache.set(baseKey, {
        texture: gpuTex,
        view,
        sourceWidth: gpuTex.width,
        sourceHeight: gpuTex.height,
      });
      registerImageryCacheCleanup(
        imagery,
        host._imageryTextureCache,
        baseKey,
        gpuTex,
      );
      return { view, isMercator: false };
    }
  }

  const source = imagery.image || imagery._source;
  if (logicalCounters) {
    logicalCounters.imageryTextureCacheMisses =
      (logicalCounters.imageryTextureCacheMisses ?? 0) + 1;
  }
  if (!source) {
    if (host._diagShouldLog()) {
      console.warn(`[WebGPU:GlobeTile] No image source for ${baseKey}`, {
        hasImage: !!imagery.image,
        hasTexture: !!imagery.texture,
        hasMerc: !!imagery._webgpuMercatorTexture,
        hasReproj: !!imagery._webgpuReprojectedTexture,
        texSource: !!imagery._source,
      });
    }
    return null;
  }

  if (host._diagShouldLog()) {
    console.log(
      `[WebGPU:GlobeTile] Uploading image for ${baseKey} type=${(source as object).constructor?.name}`,
    );
  }
  const uploaded = uploadImageSource(
    host,
    source as HTMLImageElement | HTMLCanvasElement | ImageBitmap,
    baseKey,
    host._imageryTextureCache,
    "imagery",
  );
  if (!uploaded) return null;
  // C9-12A — register the release hook for the direct-upload path (which
  // historically registered none → the zero-retirement leak). Shared entries
  // release their realization reference; owned entries retire via
  // `scheduleTextureDestroy`. The imagery object is reachable here (it is not
  // inside `uploadImageSource`), so this is where the cleanup is bound.
  const uploadedEntry = host._imageryTextureCache.get(baseKey);
  if (uploadedEntry) {
    registerImageryUploadCleanup(host, imagery, baseKey, uploadedEntry);
  }
  // The `imagery.image` direct-upload path runs for geographic providers
  // (no reprojection step). The data is geographic-V, regardless of
  // what the tile skeleton flagged — report `isMercator: false` so the
  // shader matches.
  return { view: uploaded, isMercator: false };
}

/**
 * Resolve a `GPUTextureView` for a water-mask texture.
 *
 * On a WebGPU context, the Cesium `Texture` object's compatibility-stub
 * handle already owns the native `GPUTexture` populated by `Texture.create`.
 * Borrowing its stable view avoids a second allocation, upload, and destroy.
 * The nested device-identity check is load-bearing for multi-context scenes:
 * pooled contexts sharing one `GPUDevice` may borrow, while a texture
 * realized on another device must use the retained `_webgpuSource` fallback.
 *
 * The fallback payload has two source shapes (see
 * `createWaterMaskTextureIfNeeded`):
 *
 *   - `{width, height, arrayBufferView}` — LUMINANCE typed array (the
 *     quantized-mesh 256×256 mask and the shared 1×1 all-water texture).
 *     Uploaded unchanged as single-mip `r8unorm` via `writeTexture`.
 *   - `ImageBitmap` — uploaded via `copyExternalImageToTexture` with
 *     `flipY: false`, matching `Texture.create({ flipY: false })`.
 *
 * Both routes preserve WebGL's north-first texture row order.
 * `GlobeTerrain.wgsl` applies WebGL's post-translation `1.0 - y` coordinate
 * transform at sampling time, including inherited ancestor-mask transforms.
 * Only fallback uploads enter `_waterMaskTextureCache`; their registered
 * cleanup runs at refcount zero. Stub-native textures remain solely owned and
 * destroyed by `Texture`.
 */
export function getOrCreateWaterMaskTexture(
  host: TextureCacheHost,
  waterMaskTex: CesiumOpaqueTexture,
): GPUTextureView | null {
  const wm = waterMaskTex as StubBackedWaterMaskTexture;
  const device = host._device;
  const native = wm._texture?._webgpuTexture;
  if (
    device !== null &&
    wm._context?.device === device &&
    native?.texture &&
    native.view
  ) {
    return native.view;
  }

  const cacheKey = `wm_${wm._id || "default"}`;
  const cached = host._waterMaskTextureCache.get(cacheKey);
  if (cached) return cached.view;

  const source = wm._webgpuSource ?? wm._source ?? wm.image;
  if (!source) return null;

  if (device === null) return null;
  const cache = host._waterMaskTextureCache;
  try {
    let texture: GPUTexture;
    let width: number;
    let height: number;

    if (
      source instanceof ImageBitmap ||
      source instanceof HTMLCanvasElement ||
      source instanceof HTMLImageElement
    ) {
      if (source instanceof HTMLImageElement) {
        // Same undecoded-image guard as `uploadImageSource` (C-P18).
        if (!source.complete || source.naturalWidth === 0) return null;
        width = source.naturalWidth || source.width;
        height = source.naturalHeight || source.height;
      } else {
        width = source.width;
        height = source.height;
      }
      if (width === 0 || height === 0) return null;
      texture = device.createTexture({
        label: `Globe ${cacheKey}`,
        size: [width, height],
        format: "rgba8unorm",
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.RENDER_ATTACHMENT,
      });
      device.queue.copyExternalImageToTexture(
        { source, flipY: false },
        { texture, colorSpace: "srgb" },
        [width, height],
      );
    } else {
      const texels = source as CesiumLuminanceTexelSource;
      const data = texels.arrayBufferView;
      width = texels.width;
      height = texels.height;
      if (
        !data ||
        !(width > 0) ||
        !(height > 0) ||
        data.length < width * height
      ) {
        return null;
      }
      texture = device.createTexture({
        label: `Globe ${cacheKey}`,
        size: [width, height],
        format: "r8unorm",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      device.queue.writeTexture(
        { texture },
        data,
        { bytesPerRow: width, rowsPerImage: height },
        [width, height],
      );
    }

    const view = texture.createView();
    cache.set(cacheKey, {
      texture,
      view,
      sourceWidth: width,
      sourceHeight: height,
    });
    // Release the GPU copy when the owning WebGL texture is destroyed
    // (GlobeSurfaceTile.freeResources → refcount 0). Identity-guarded so
    // a later re-upload under a reused `_id` is not clobbered.
    const previousCleanup = wm._webgpuTextureCacheCleanup;
    wm._webgpuTextureCacheCleanup = () => {
      previousCleanup?.();
      if (cache.get(cacheKey)?.texture === texture) {
        cache.delete(cacheKey);
        texture.destroy();
      }
    };
    return view;
  } catch (e) {
    // Same rationale as `uploadImageSource`: a throw here is a real fault
    // (OOM / lost device); surface it permanently and let the caller's
    // cache-miss retry handle recoverable cases.
    const message = e instanceof Error ? e.message : String(e);
    console.error(
      `[CesiumJS:webgpu] water-mask upload failed for "${cacheKey}": ${message}`,
    );
    return null;
  }
}

/**
 * C9-12A — prepare the mip chain for a freshly-uploaded imagery texture.
 * Frame-owned by default (enqueued on the context, encoded + submitted in one
 * `"ImageryMipPreparation"` encoder in `endFrame` before scene passes → zero
 * private submits from draw emission). Falls back to the historical private
 * submit only when no context is plumbed (cannot happen on the live upload
 * path, but guarded so the fallback is counted as a regression tripwire).
 */
function prepareImageryMips(
  host: TextureCacheHost,
  device: GPUDevice,
  texture: GPUTexture,
  mipLevelCount: number,
): void {
  if (mipLevelCount <= 1) return;
  const ctx = host._webgpuContext;
  if (ctx) {
    ctx.enqueueImageryMipGeneration(texture, "rgba8unorm", mipLevelCount);
    return;
  }
  ensureMipmapGenerator(device).generateMipmapsAndSubmit(
    texture,
    "rgba8unorm",
    mipLevelCount,
  );
  incrementLogicalCounter(host._logicalCounters, "imageryMipFallbackSubmits");
}

// Create the destination `GPUTexture` and copy the source image into mip 0.
// Shared by the dedup-miss and owned branches of `uploadImageSource`; the
// colorSpace/flipY rationale is documented at the call site block below.
function createUploadedImageryTexture(
  device: GPUDevice,
  cacheKey: string,
  gpuSource: ImageBitmap | HTMLImageElement | HTMLCanvasElement,
  width: number,
  height: number,
  needsFlipY: boolean,
  mipLevelCount: number,
): GPUTexture {
  const texture = device.createTexture({
    label: `Globe ${cacheKey}`,
    size: [width, height],
    format: "rgba8unorm",
    mipLevelCount,
    usage:
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.RENDER_ATTACHMENT,
  });
  device.queue.copyExternalImageToTexture(
    { source: gpuSource, flipY: needsFlipY },
    { texture, colorSpace: "srgb" },
    [width, height],
  );
  return texture;
}

// Per-cacheKey upload tally backing the re-upload storm sentinel below.
const reuploadWatch = new Map<
  string,
  { count: number; windowStartMs: number; reported: boolean }
>();

/**
 * PERMANENT SENTINEL — detects a texture re-upload storm.
 *
 * `uploadImageSource` does NOT read the cache it is handed (see its docblock),
 * so a caller that forgets its own cache-hit guard silently re-uploads the same
 * image every frame. That exact defect (`NEW-WEBGPU-OCEANNORMAL-PER-CALL-REUPLOAD`)
 * cost ~9.6 ms/frame and hid for two campaigns, because the per-pass CPU
 * profiler is structurally blind to it — 99% of the frame lived outside every
 * instrumented pass.
 *
 * Deliberately NOT pragma-stripped, per the permanent-sentinel rule for
 * loop/re-entry detectors. The cost argument is airtight: in correct operation
 * uploads are rare (once per source), so this Map op is noise next to a
 * `copyExternalImageToTexture`; in broken operation the frequency IS the bug and
 * we want the error. The tally is per cacheKey, so many DIFFERENT tiles
 * uploading during load never trip it — only the same key repeating does.
 */
function noteUploadForStormDetection(cacheKey: string): void {
  const now = performance.now();
  let entry = reuploadWatch.get(cacheKey);
  if (!entry) {
    entry = { count: 0, windowStartMs: now, reported: false };
    reuploadWatch.set(cacheKey, entry);
  }
  // Rolling 2 s window: a legitimate re-upload on content change is a slow
  // trickle and resets here, so it can never accumulate into a false positive.
  if (now - entry.windowStartMs > 2000) {
    entry.count = 1;
    entry.windowStartMs = now;
    entry.reported = false;
    return;
  }
  entry.count++;
  if (!entry.reported && entry.count >= 30) {
    entry.reported = true;
    console.error(
      `[WebGPU:TextureUpload] RE-UPLOAD STORM: "${cacheKey}" uploaded ${entry.count}x in ` +
        `${Math.round(now - entry.windowStartMs)}ms. \`uploadImageSource\` does NOT read its ` +
        `\`cache\` argument — the CALLING site must supply a cache-hit guard (compare source ` +
        `identity, as \`_materialTextureCache\` and \`_oceanNormalMapSource\` do). Until it does, ` +
        `this uploads a texture + regenerates mips + creates a new view every frame, and the ` +
        `fresh view identity also defeats any view-keyed bind-group cache downstream.`,
    );
  }
}

/**
 * Upload an image source (ImageBitmap, HTMLImageElement, HTMLCanvasElement)
 * to a GPU texture.
 *
 * ⚠ **CONTRACT — THIS FUNCTION NEVER READS `cache`.** It only ever WRITES the
 * resulting entry into it. There is no `cache.get`/`cache.has` anywhere in the
 * body. The `cache` argument selects the destination Map (imagery, water mask,
 * or ocean normal) — it is **not** a memo.
 *
 * **Therefore every caller MUST supply its own cache-hit guard.** An unguarded
 * call re-uploads on every invocation: `createTexture` +
 * `copyExternalImageToTexture` + a full mip chain + a fresh `createView`, and
 * because bind-group caches key on view identity the new view also forces a
 * `createBindGroup` — self-perpetuating. Guarded callers to copy from:
 * `_resolveOrUploadMaterialTexture` and the ocean-normal path (both compare
 * source identity: `cached.source === value`).
 *
 * The one internal dedupe path — the shared realization table
 * (`host._sharedImageryRealizations`) — is gated on `logicalOwner === "imagery"`
 * and does nothing for any other caller.
 *
 * A `console.error` sentinel fires if the same `cacheKey` is uploaded ≥30 times
 * within 2 s, which is what a missing guard looks like.
 *
 * Returns null on any error (unrecognized source type, zero-sized image,
 * undecoded `<img>`, `copyExternalImageToTexture` rejection).
 */
export function uploadImageSource(
  host: TextureCacheHost,
  source: ImageBitmap | HTMLImageElement | HTMLCanvasElement | unknown,
  cacheKey: string,
  cache: Map<string, ImageryGPUTexture>,
  logicalOwner?: "imagery",
): GPUTextureView | null {
  // `source` is declared wider than the WebGPU-supported types because
  // the caller passes heterogeneous imagery payloads; the instanceof
  // chain below narrows to the actual GPU-copyable variants.
  const device = host._device!;
  noteUploadForStormDetection(cacheKey);

  try {
    let width: number, height: number;
    let gpuSource: ImageBitmap | HTMLImageElement | HTMLCanvasElement;
    // Batch 60 — `needsFlipY` controls the `flipY` option on
    // `copyExternalImageToTexture`. The WGSL globe-FS samples imagery
    // textures at `(u, geoUV.y)` where `geoUV.y = 0` is the tile's SOUTH
    // edge (the WebGL V=0=south convention preserved through the shared
    // terrain mesh). For the texture to honor that convention, the
    // top-of-source-image must end up at V=1 (south of image-content =
    // north geographically).
    //
    // The standard Cesium imagery providers route through
    // `Resource.fetchImage({ flipY: true })`, which decodes via
    // `createImageBitmap(blob, { imageOrientation: "flipY" })`. Those
    // ImageBitmaps arrive PRE-FLIPPED — `flipY: false` at upload is
    // correct.
    //
    // Custom providers (notably `TileCoordinatesImageryProvider` and
    // our fork-added `DebugTileImageryProvider`) return a raw
    // `HTMLCanvasElement` drawn top-down without any flip. For those
    // the upload needs `flipY: true` so the canvas's row 0 lands at the
    // texture's V=1 row — matching what the globe FS expects. Without
    // this, the canvas content renders upside-down (Batch 60 user-
    // observed symptom on the `DebugTileImageryProvider` overlay).
    //
    // `HTMLImageElement` sources are uncommon (most providers prefer
    // ImageBitmaps); when they appear they're typically NOT pre-flipped
    // either, so they get the same treatment as raw canvases.
    let needsFlipY = false;
    if (source instanceof ImageBitmap) {
      width = source.width;
      height = source.height;
      gpuSource = source;
    } else if (source instanceof HTMLImageElement) {
      // C-P18: reject not-yet-decoded images. Without this check,
      // `copyExternalImageToTexture` throws "source is not in a valid
      // state" for any HTMLImageElement whose load/decode hasn't
      // completed — which happens unpredictably when imagery layers
      // hand off `<img>` refs immediately after `src=` assignment.
      // The uploader returns null; the caller's cache miss path
      // retries on the next frame when `complete` flips to true.
      if (!source.complete || source.naturalWidth === 0) {
        return null;
      }
      width = source.naturalWidth || source.width;
      height = source.naturalHeight || source.height;
      gpuSource = source;
      needsFlipY = true;
    } else if (source instanceof HTMLCanvasElement) {
      width = source.width;
      height = source.height;
      gpuSource = source;
      needsFlipY = true;
    } else {
      return null;
    }

    if (width === 0 || height === 0) return null;

    // Batch 57 — allocate with full mipmap chain. WebGL's imagery upload
    // path calls `gl.generateMipmap` after `texImage2D`, producing 9 mip
    // levels for a 256×256 tile. WebGPU has no equivalent so we have to
    // build the chain explicitly via `WebGPUMipmapGenerator`. Without
    // this the GPU point-samples Level-0 at orbital altitudes (one
    // fragment covers many texels) which produces severe aliasing AND a
    // brightness drop — the alias pattern under-samples bright pixels,
    // dropping mean radiance by ~4x at 20Mm altitude relative to
    // WebGL's properly-mipmapped sampling. See
    // `migration_doc/WEBGPU_DEBUGGING_LOG.md` Batch 57.
    const mipLevelCount = mipLevelCountFor(width, height);

    // C9-12A — realization dedup for the imagery cache only. A shareable
    // (immutable) source (an ImageBitmap, or a provider-declared canvas such as
    // GridImagery's constructor-drawn grid) is realized ONCE into a shared
    // GPUTexture+view referenced by every tile that binds it, instead of one
    // identical full-mip texture per tile. Non-imagery callers (ocean normal /
    // material uploads) never participate — they keep owned textures exactly.
    //
    // The sRGB colorSpace and the flipY convention (see the `needsFlipY` block
    // above) are unchanged: `createUploadedImageryTexture` forces srgb→srgb
    // identity copy so a display-p3 / HDR monitor cannot introduce a wide-gamut
    // conversion. Mip generation is frame-owned (`prepareImageryMips`).
    const identity =
      logicalOwner === "imagery"
        ? getShareableImagerySourceIdentity(source)
        : null;
    const table =
      logicalOwner === "imagery"
        ? (host._sharedImageryRealizations ?? null)
        : null;

    if (identity && table) {
      const fingerprint = `s${identity.sourceId}r${identity.revision}|${width}x${height}|rgba8unorm|m${mipLevelCount}|f${needsFlipY ? 1 : 0}|srgb`;
      const existing = table.get(fingerprint);
      if (existing) {
        // Reuse the ONE texture + view. Sharing the view object also collapses
        // the group-1 bind-group cache key (keyed on view identity) so the
        // repeated per-tile bind-group creates collapse alongside the uploads.
        cache.set(cacheKey, {
          texture: existing.texture,
          view: existing.view,
          sourceWidth: width,
          sourceHeight: height,
          byteSize: existing.byteSize,
          logicalOwner,
          shared: existing,
        });
        incrementLogicalCounter(
          host._logicalCounters,
          "imageryRealizationShares",
        );
        recordRealizationLiveBytes(host);
        return existing.view;
      }
      // Miss — realize once and register in the shared table.
      const texture = createUploadedImageryTexture(
        device,
        cacheKey,
        gpuSource,
        width,
        height,
        needsFlipY,
        mipLevelCount,
      );
      prepareImageryMips(host, device, texture, mipLevelCount);
      const view = texture.createView();
      const byteSize = rgba8MipChainBytes(width, height, mipLevelCount);
      const entry = table.register(fingerprint, texture, view, byteSize);
      cache.set(cacheKey, {
        texture,
        view,
        sourceWidth: width,
        sourceHeight: height,
        byteSize,
        logicalOwner,
        shared: entry,
      });
      incrementLogicalCounter(
        host._logicalCounters,
        "imageryRealizationsCreated",
      );
      recordRealizationLiveBytes(host);
      return view;
    }

    // Non-shareable source (undeclared / mutable) or a non-imagery caller: own
    // the texture outright, exactly as before this task — but with frame-owned
    // mips and (for imagery) refcounted retirement wired at the caller.
    const texture = createUploadedImageryTexture(
      device,
      cacheKey,
      gpuSource,
      width,
      height,
      needsFlipY,
      mipLevelCount,
    );
    prepareImageryMips(host, device, texture, mipLevelCount);

    const view = texture.createView();
    if (logicalOwner === "imagery") {
      // Always store byteSize so eviction retirement can account it; counters
      // stay behind the null guard in `recordOwnedImageryAdded`.
      const byteSize = rgba8MipChainBytes(width, height, mipLevelCount);
      cache.set(cacheKey, {
        texture,
        view,
        sourceWidth: width,
        sourceHeight: height,
        byteSize,
        logicalOwner,
      });
      recordOwnedImageryAdded(host, byteSize);
    } else {
      // Preserve the original clean-path object shape for non-imagery callers.
      cache.set(cacheKey, {
        texture,
        view,
        sourceWidth: width,
        sourceHeight: height,
      });
    }

    return view;
  } catch (e) {
    // NEW-UPLOADIMAGESOURCE-OBSERVABILITY (Batch 304) — reaching here is
    // unexpected: the transient undecoded-`<img>` case is already handled
    // by the early `!source.complete` return above, and unsupported source
    // types are rejected before the try. A throw from
    // `createTexture`/`copyExternalImageToTexture` therefore signals a real
    // fault (out-of-memory, an out-of-bounds size, or a lost device) that
    // would otherwise silently blank the tile with no signal at all.
    // Surface it as a permanent (non-pragma) error so the failure is
    // diagnosable. We deliberately do NOT re-throw: device loss is already
    // routed through the `device.lost` promise in WebGPUContextDeviceLoss /
    // WebGPUDeviceLossRecovery, and throwing synchronously from this
    // globe-render hot path would crash the frame loop instead of letting
    // that async recovery engage. Returning null preserves the caller's
    // cache-miss retry for recoverable cases.
    const message = e instanceof Error ? e.message : String(e);
    console.error(
      `[CesiumJS:webgpu] uploadImageSource failed for "${cacheKey}": ${message}`,
    );
    return null;
  }
}
