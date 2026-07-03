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
 *   - `getOrCreateWaterMaskTexture(host, waterMaskTex)` — caches per-
 *     water-mask textures keyed by their WebGL `_id`.
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

import type { ImageryGPUTexture } from "./WebGPUGlobeSurfaceTypes.js";
import { WebGPUMipmapGenerator } from "./WebGPUMipmapGenerator.js";

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
  _diagShouldLog(): boolean;
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

  const baseKey =
    imagery.key || `${imagery.x ?? 0}_${imagery.y ?? 0}_${imagery.level ?? 0}`;
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

  const baseKey =
    imagery.key || `${imagery.x ?? 0}_${imagery.y ?? 0}_${imagery.level ?? 0}`;

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
      return { view: cachedMerc.view, isMercator: true };
    }
    if (imagery._webgpuMercatorTexture) {
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
    if (cachedGeo) return { view: cachedGeo.view, isMercator: false };

    if (imagery._webgpuReprojectedTexture) {
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
  );
  if (!uploaded) return null;
  // The `imagery.image` direct-upload path runs for geographic providers
  // (no reprojection step). The data is geographic-V, regardless of
  // what the tile skeleton flagged — report `isMercator: false` so the
  // shader matches.
  return { view: uploaded, isMercator: false };
}

/**
 * Resolve a `GPUTextureView` for a water-mask texture.
 *
 * NEW-GLOBE-BELOWSURFACE-FIX (Batch 510 attribution → this fix). The
 * water mask arrives as a Cesium `Texture` object whose texel payload is
 * retained by `GlobeSurfaceTile.js` on `_webgpuSource` (the Texture class
 * itself does not keep its source after upload — the previous
 * `wm._source || wm.image` extraction was ALWAYS undefined, so every
 * water-masked tile fell back to the renderer's 1×1 WHITE placeholder:
 * `waterMask = 1.0` across the whole tile, running the enhanced-ocean
 * shader over entire land tiles. That full-tile bluish haze was the
 * dominant below-surface/translucency darkening term).
 *
 * Two source shapes (see `createWaterMaskTextureIfNeeded`):
 *
 *   - `{width, height, arrayBufferView}` — LUMINANCE typed array (the
 *     quantized-mesh 256×256 mask and the shared 1×1 all-water texture).
 *     Uploaded as single-mip `r8unorm` via `writeTexture`, with rows
 *     REVERSED: the source is north-first (WebGL uploads it to v=0 and
 *     applies `y = 1 - y` in GlobeFS.glsl AFTER the translation/scale),
 *     while the WGSL samples directly at south-origin
 *     `geoUV * wmTS.zw + wmTS.xy`. South-first rows make direct sampling
 *     byte-equivalent to WebGL's flip-after-TS, including for inherited
 *     ancestor masks (wmTS stays south-origin in both conventions).
 *   - `ImageBitmap` — uploaded via `copyExternalImageToTexture` with
 *     `flipY: true` for the same north-first → south-first conversion
 *     (WebGL uploads bitmap masks with `flipY: false` + shader V-flip).
 *
 * The mask is consumed via `textureSampleLevel(…, 0.0)` so no mip chain
 * is generated. Cached per WebGL-texture `_id`; `GlobeSurfaceTile.js`
 * invokes the registered `_webgpuTextureCacheCleanup` when the WebGL
 * texture's refcount hits zero so the GPU copy is released with it.
 */
export function getOrCreateWaterMaskTexture(
  host: TextureCacheHost,
  waterMaskTex: CesiumOpaqueTexture,
): GPUTextureView | null {
  const wm = waterMaskTex as CesiumTextureWithSource;
  const cacheKey = `wm_${wm._id || "default"}`;
  const cached = host._waterMaskTextureCache.get(cacheKey);
  if (cached) return cached.view;

  const source = wm._webgpuSource ?? wm._source ?? wm.image;
  if (!source) return null;

  const device = host._device!;
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
        { source, flipY: true },
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
      // Reverse row order (north-first → south-first); see the function
      // docstring for why direct south-origin sampling requires it.
      const flipped = new Uint8Array(width * height);
      for (let row = 0; row < height; row++) {
        const srcStart = (height - 1 - row) * width;
        flipped.set(data.subarray(srcStart, srcStart + width), row * width);
      }
      device.queue.writeTexture(
        { texture },
        flipped,
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
    wm._webgpuTextureCacheCleanup = () => {
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
 * Upload an image source (ImageBitmap, HTMLImageElement, HTMLCanvasElement)
 * to a GPU texture.
 *
 * The `cache` parameter lets the caller pick the destination Map —
 * imagery, water mask, or ocean normal cache. Returns null on any
 * error (unrecognized source type, zero-sized image, undecoded
 * `<img>`, `copyExternalImageToTexture` rejection).
 */
export function uploadImageSource(
  host: TextureCacheHost,
  source: ImageBitmap | HTMLImageElement | HTMLCanvasElement | unknown,
  cacheKey: string,
  cache: Map<string, ImageryGPUTexture>,
): GPUTextureView | null {
  // `source` is declared wider than the WebGPU-supported types because
  // the caller passes heterogeneous imagery payloads; the instanceof
  // chain below narrows to the actual GPU-copyable variants.
  const device = host._device!;

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

    // Force sRGB color space on both source and destination to prevent the
    // browser from applying a wide-gamut → sRGB conversion when the user
    // is on a display-p3 / HDR monitor. WebGL's `pixelStorei(
    // UNPACK_COLORSPACE_CONVERSION_WEBGL, BROWSER_DEFAULT_WEBGL)` ends up
    // as a no-op on those setups, while WebGPU's
    // `copyExternalImageToTexture` defaults to a "default" colorSpace
    // mapping that may convert the source. Explicit srgb→srgb is a safe
    // identity copy on every display.
    device.queue.copyExternalImageToTexture(
      { source: gpuSource, flipY: needsFlipY },
      { texture, colorSpace: "srgb" },
      [width, height],
    );

    // Generate mipmap chain via blit pipeline. The generator runs a
    // fullscreen-triangle render pass from mip N to mip N+1 for each
    // level, using a linear sampler. Equivalent to gl.generateMipmap.
    if (mipLevelCount > 1) {
      ensureMipmapGenerator(device).generateMipmapsAndSubmit(
        texture,
        "rgba8unorm",
        mipLevelCount,
      );
    }

    const view = texture.createView();
    cache.set(cacheKey, {
      texture,
      view,
      sourceWidth: width,
      sourceHeight: height,
    });

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
