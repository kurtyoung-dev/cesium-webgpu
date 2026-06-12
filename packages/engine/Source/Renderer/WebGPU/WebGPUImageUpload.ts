/**
 * WGF-8 helper — image-to-texture upload with EXIF/orientation handling.
 *
 * `GPUQueue.copyExternalImageToTexture()` does NOT inspect EXIF metadata.
 * If the source is an `HTMLImageElement` decoded from JPEG with a non-trivial
 * `Orientation` tag (rotated phone photos, scanner output), the GPU upload will
 * land *unrotated* and the resulting texture will appear sideways or mirrored.
 *
 * The fix is to convert the source through `createImageBitmap(source, { imageOrientation: "from-image" })`
 * before the copy. The browser then bakes the EXIF rotation into the bitmap so
 * the GPU sees pixels in the upright orientation a user would expect.
 *
 * This module also supports a few related upload concerns the raw queue API
 * leaves to the caller:
 *   - `flipY` for shader conventions that expect (0,0) at the bottom-left
 *   - `premultipliedAlpha` for blending paths that need pre-multiplied input
 *   - capability detection: `imageOrientation: "from-image"` is supported on
 *     all current Chromium/Firefox/Safari but the option name was unstable
 *     during the rollout, so we feature-test once and cache.
 *
 * Companion to `WebGPUContext.createTextureFromImage()` — the context method
 * delegates to `uploadImageToTexture()` here when `respectEXIF` is requested.
 * @module WebGPUImageUpload
 */

/// <reference types="@webgpu/types" />

/**
 * Source types accepted by the upload helpers. Mirrors the union accepted by
 * `GPUQueue.copyExternalImageToTexture()` plus `Blob`/`ArrayBuffer` which need
 * a decode step first.
 */
export type WebGPUImageSource =
  | ImageBitmap
  | HTMLImageElement
  | HTMLCanvasElement
  | OffscreenCanvas
  | HTMLVideoElement
  | VideoFrame
  | Blob;

/**
 * Options for the image upload helper.
 */
export interface WebGPUImageUploadOptions {
  /**
   * Bake EXIF orientation into the uploaded texture. Defaults to true — most
   * imagery pipelines expect upright pixels regardless of camera rotation.
   *
   * Cost: forces a `createImageBitmap` decode pass when the source isn't
   * already an `ImageBitmap`. For sources that are known to be EXIF-free
   * (procedurally generated canvases, video frames, pre-decoded bitmaps from
   * a worker that already handled orientation) set this to false to skip the
   * extra decode.
   */
  respectEXIF?: boolean;

  /** Flip the source vertically. Default: false. */
  flipY?: boolean;

  /** Pre-multiply alpha during the upload. Default: false. */
  premultipliedAlpha?: boolean;

  /** Color space hint for the destination. Default: "srgb". */
  colorSpace?: PredefinedColorSpace;

  /** Origin in the destination texture. Default: (0, 0, 0). */
  destinationOrigin?: GPUOrigin3D;

  /** Mip level to upload into. Default: 0. */
  destinationMipLevel?: number;
}

/**
 * Helper class — all methods are static. The `_capabilityCache` WeakMap holds
 * the result of the `imageOrientation` feature probe per device so we don't
 * re-test on every upload.
 */
export class WebGPUImageUpload {
  /**
   * Decode a `Blob`/`HTMLImageElement` to an `ImageBitmap` while respecting
   * EXIF orientation. For sources that are already an `ImageBitmap` the input
   * is returned unchanged (caller still owns the lifetime).
   *
   * Throws if the browser cannot decode the source. The error is left to
   * propagate so the caller can decide whether to fall back to a placeholder
   * texture or surface the failure to the user.
   */
  static async decodeWithOrientation(
    source: WebGPUImageSource,
    monitor?: import("./AsyncResourceMonitor.js").AsyncResourceMonitor | null,
    monitorLabel?: string,
  ): Promise<
    | ImageBitmap
    | HTMLCanvasElement
    | OffscreenCanvas
    | HTMLVideoElement
    | VideoFrame
  > {
    // Already a bitmap or non-image surface — nothing to decode. The
    // monitor is intentionally NOT registered here because there's no
    // async work to wait on; subscribers would just see a synthetic
    // started/resolved pair with zero duration.
    if (source instanceof ImageBitmap) {
      return source;
    }
    if (
      typeof HTMLCanvasElement !== "undefined" &&
      source instanceof HTMLCanvasElement
    ) {
      return source;
    }
    if (
      typeof OffscreenCanvas !== "undefined" &&
      source instanceof OffscreenCanvas
    ) {
      return source;
    }
    if (
      typeof HTMLVideoElement !== "undefined" &&
      source instanceof HTMLVideoElement
    ) {
      return source;
    }
    if (typeof VideoFrame !== "undefined" && source instanceof VideoFrame) {
      return source;
    }

    // NEW-WEBGPU-PIPELINE-READY-SIGNAL (Phase 5) — register the decode
    // with the monitor so Scene's wakeup path fires when the bitmap
    // lands. Without this, an environment-map texture that finishes
    // `createImageBitmap` after the scene hibernates lands silently.
    // The monitor key includes a counter so concurrent decodes from
    // different sources don't collide on dedup.
    let token: import("./AsyncResourceMonitor.js").AsyncResourceToken | null =
      null;
    if (monitor) {
      const id = ++WebGPUImageUpload._decodeCounter;
      token = monitor.begin({
        kind: "image-decode",
        key: `image-decode|${id}`,
        label: monitorLabel ?? "createImageBitmap",
      });
    }

    // HTMLImageElement / Blob both go through createImageBitmap with the
    // orientation hint. The "from-image" value tells the decoder to apply EXIF
    // rotation (and any embedded ICC orientation) before handing back pixels.
    const opts: ImageBitmapOptions = {
      imageOrientation: "from-image",
    };
    try {
      const bitmap = await createImageBitmap(source as ImageBitmapSource, opts);
      if (token && monitor) monitor.resolve(token);
      return bitmap;
    } catch (error) {
      if (token && monitor) monitor.reject(token, error);
      throw error;
    }
  }

  // Monotonic counter for image-decode token keys. Concurrent decodes
  // from independent call sites must not dedupe — they're separate
  // pieces of work even when their sources hash the same.
  private static _decodeCounter = 0;

  /**
   * Upload an image source into an existing `GPUTexture`, baking EXIF
   * orientation by default. The image is sized via `width`/`height` from the
   * (decoded) source — callers should ensure the destination texture has at
   * least that capacity.
   *
   * Returns the resolved `ImageBitmap` (or pass-through source) so callers
   * that need the dimensions for follow-up work — e.g. mipmap generation —
   * don't have to re-query.
   */
  static async uploadImageToTexture(
    device: GPUDevice,
    source: WebGPUImageSource,
    destination: GPUTexture,
    options: WebGPUImageUploadOptions = {},
  ): Promise<{ width: number; height: number }> {
    const decoded =
      options.respectEXIF === false
        ? (source as Exclude<WebGPUImageSource, Blob>)
        : await WebGPUImageUpload.decodeWithOrientation(source);

    // Width/height extraction matches the union accepted by
    // copyExternalImageToTexture — every member exposes both fields except
    // VideoFrame which uses codedWidth/codedHeight.
    let width: number;
    let height: number;
    if (typeof VideoFrame !== "undefined" && decoded instanceof VideoFrame) {
      width = decoded.codedWidth;
      height = decoded.codedHeight;
    } else {
      const w = (decoded as { width?: number; videoWidth?: number }).width;
      const h = (decoded as { height?: number; videoHeight?: number }).height;
      width = w ?? (decoded as HTMLVideoElement).videoWidth;
      height = h ?? (decoded as HTMLVideoElement).videoHeight;
    }

    device.queue.copyExternalImageToTexture(
      {
        source: decoded as GPUCopyExternalImageSource,
        flipY: options.flipY ?? false,
      },
      {
        texture: destination,
        mipLevel: options.destinationMipLevel ?? 0,
        origin: options.destinationOrigin,
        premultipliedAlpha: options.premultipliedAlpha ?? false,
        colorSpace: options.colorSpace ?? "srgb",
      },
      { width, height },
    );

    return { width, height };
  }

  /**
   * Feature-detect `createImageBitmap({ imageOrientation: "from-image" })`.
   * The probe is cheap (decodes a 1×1 PNG) and the result is cached, so
   * subsequent calls are O(1). Returns true on every modern browser; the
   * probe exists to give callers a clean fallback path on the long tail of
   * older Safari/embedded WebViews where the option silently no-ops.
   */
  static async isOrientationSupported(): Promise<boolean> {
    if (WebGPUImageUpload._orientationProbeCache !== undefined) {
      return WebGPUImageUpload._orientationProbeCache;
    }
    try {
      // 1×1 transparent PNG — the smallest valid PNG payload.
      const onePixel = new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
        0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
        0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
        0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
        0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
        0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
      ]);
      const blob = new Blob([onePixel], { type: "image/png" });
      const bmp = await createImageBitmap(blob, {
        imageOrientation: "from-image",
      });
      bmp.close?.();
      WebGPUImageUpload._orientationProbeCache = true;
    } catch {
      WebGPUImageUpload._orientationProbeCache = false;
    }
    return WebGPUImageUpload._orientationProbeCache;
  }

  private static _orientationProbeCache: boolean | undefined = undefined;
}

export default WebGPUImageUpload;
