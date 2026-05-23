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
  const wantMercator = !!tileImagery.useWebMercatorT;

  // First-preference lookup: Mercator variant when requested.
  if (wantMercator) {
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
      return { view, isMercator: true };
    }
    // Fall through to geographic — adopt whatever's available so the
    // tile renders, but flip the flag so the shader samples geographic-V
    // instead of Mercator-V on a geographic-data texture.
  }

  // Geographic variant lookup.
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
    return { view, isMercator: false };
  }

  // Last-resort: race window where the Mercator texture exists but
  // reprojection hasn't produced the geographic version yet. Bind
  // mercator and report it back so the shader stays consistent.
  if (imagery._webgpuMercatorTexture) {
    const gpuTex = imagery._webgpuMercatorTexture;
    const view = gpuTex.createView({ label: `imagery_merc_${baseKey}` });
    host._imageryTextureCache.set(`${baseKey}_merc`, {
      texture: gpuTex,
      view,
      sourceWidth: gpuTex.width,
      sourceHeight: gpuTex.height,
    });
    return { view, isMercator: true };
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
 * Resolve a `GPUTextureView` for a water-mask texture. The water mask
 * arrives as a Cesium WebGL `Texture` object; we extract its `_source`
 * or `image` field and route it through `uploadImageSource`.
 */
export function getOrCreateWaterMaskTexture(
  host: TextureCacheHost,
  waterMaskTex: CesiumOpaqueTexture,
): GPUTextureView | null {
  // Water mask textures are WebGL Texture objects; extract the source image
  const wm = waterMaskTex as CesiumTextureWithSource;
  const source = wm._source || wm.image;
  if (!source) return null;

  const cacheKey = `wm_${wm._id || "default"}`;
  const cached = host._waterMaskTextureCache.get(cacheKey);
  if (cached) return cached.view;

  return uploadImageSource(host, source, cacheKey, host._waterMaskTextureCache);
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
    return null;
  }
}
