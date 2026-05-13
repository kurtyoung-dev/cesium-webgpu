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
 * Resolve a `GPUTextureView` for an imagery layer's tile. Cache hit
 * returns the existing view; cache miss either:
 *   1. Adopts a pre-uploaded `GPUTexture` from
 *      `WebGPUImageryReprojection` (fast path — no second upload), or
 *   2. Falls back to `uploadImageSource` for a fresh GPU upload.
 *
 * Returns null when the imagery is missing, has no usable source, or
 * the underlying upload fails.
 */
export function getOrCreateImageryTexture(
  host: TextureCacheHost,
  imagery: CesiumReadyImagery | null | undefined,
): GPUTextureView | null {
  if (!imagery) return null;

  const cacheKey =
    imagery.key || `${imagery.x ?? 0}_${imagery.y ?? 0}_${imagery.level ?? 0}`;
  const cached = host._imageryTextureCache.get(cacheKey);
  if (cached) return cached.view;

  // If imagery was reprojected by WebGPUImageryReprojection, use
  // the pre-reprojected GPUTexture directly instead of re-uploading.
  if (imagery._webgpuReprojectedTexture) {
    const gpuTex = imagery._webgpuReprojectedTexture;
    const view = gpuTex.createView({ label: `imagery_reproj_${cacheKey}` });
    host._imageryTextureCache.set(cacheKey, {
      texture: gpuTex,
      view,
      sourceWidth: gpuTex.width,
      sourceHeight: gpuTex.height,
    });
    return view;
  }

  const source = imagery.image || imagery._source;
  if (!source) {
    if (host._diagShouldLog()) {
      console.warn(`[WebGPU:GlobeTile] No image source for ${cacheKey}`, {
        hasImage: !!imagery.image,
        hasTexture: !!imagery.texture,
        texSource: !!imagery._source,
      });
    }
    return null;
  }

  if (host._diagShouldLog()) {
    console.log(
      `[WebGPU:GlobeTile] Uploading image for ${cacheKey} type=${(source as object).constructor?.name}`,
    );
  }
  return uploadImageSource(
    host,
    source as HTMLImageElement | HTMLCanvasElement | ImageBitmap,
    cacheKey,
    host._imageryTextureCache,
  );
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
    } else if (source instanceof HTMLCanvasElement) {
      width = source.width;
      height = source.height;
      gpuSource = source;
    } else {
      return null;
    }

    if (width === 0 || height === 0) return null;

    const texture = device.createTexture({
      label: `Globe ${cacheKey}`,
      size: [width, height],
      format: "rgba8unorm",
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
      { source: gpuSource },
      { texture, colorSpace: "srgb" },
      [width, height],
    );

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
