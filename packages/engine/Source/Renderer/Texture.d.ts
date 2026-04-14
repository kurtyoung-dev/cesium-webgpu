/**
 * Type declarations for Texture.js.
 *
 * Co-located `.d.ts` overrides TypeScript's inference from the JS source.
 * Texture is the WebGL texture wrapper — a plain ES6 class that stores a
 * `WebGLTexture` handle plus format/size metadata. This declaration
 * gives WebGPU TypeScript callers proper types when interop hands them a
 * Texture handle through `context.defaultTexture` or similar.
 *
 * Like the other co-located `.d.ts` files in this directory, `@private`
 * JSDoc tags on methods are NOT honored here — upstream CesiumJS uses
 * `@private` to mean "not part of the published API" (closer to TS
 * `@internal` than TS `private`). Every method on Texture is reachable
 * from Scene/Renderer code and must be public for TS callers.
 */

import type Sampler from "./Sampler.js";

/** Source object accepted by `Texture.copyFrom()`. */
export interface TextureSource {
  /** Width in texels (required for array-buffer sources). */
  width?: number;
  /** Height in texels (required for array-buffer sources). */
  height?: number;
  /** Pixel data for array-buffer sources. */
  arrayBufferView?: ArrayBufferView;
  /** DOM image source for DOM-based uploads. */
  [extra: string]: unknown;
}

export interface TextureConstructorOptions {
  context: object;
  source?:
    | TextureSource
    | ImageData
    | HTMLImageElement
    | HTMLCanvasElement
    | HTMLVideoElement
    | ImageBitmap
    | OffscreenCanvas;
  width?: number;
  height?: number;
  pixelFormat?: number;
  pixelDatatype?: number;
  flipY?: boolean;
  premultiplyAlpha?: boolean;
  skipColorSpaceConversion?: boolean;
  sampler?: Sampler;
}

declare class Texture {
  constructor(options: TextureConstructorOptions);

  // ─── Read-only metadata ──────────────────────────────────────────────
  readonly id: string;
  readonly pixelFormat: number;
  readonly pixelDatatype: number;
  readonly dimensions: unknown;
  readonly preMultiplyAlpha: boolean;
  readonly flipY: boolean;
  readonly width: number;
  readonly height: number;
  readonly sizeInBytes: number;

  // `sampler` is the only writable instance property — setting it
  // reapplies the sampler to the underlying GL texture.
  sampler: Sampler;

  // ─── Instance methods ────────────────────────────────────────────────
  copyFrom(options: {
    source:
      | TextureSource
      | ImageData
      | HTMLImageElement
      | HTMLCanvasElement
      | HTMLVideoElement
      | ImageBitmap
      | OffscreenCanvas;
    xOffset?: number;
    yOffset?: number;
    skipColorSpaceConversion?: boolean;
  }): void;
  copyFromFramebuffer(
    xOffset?: number,
    yOffset?: number,
    framebufferXOffset?: number,
    framebufferYOffset?: number,
    width?: number,
    height?: number,
  ): void;
  generateMipmap(hint?: number): void;
  isDestroyed(): boolean;
  destroy(): void;

  // ─── Static factories ────────────────────────────────────────────────
  static create(options: TextureConstructorOptions): Texture;
  static fromFramebuffer(options: {
    context: object;
    pixelFormat?: number;
    framebufferXOffset?: number;
    framebufferYOffset?: number;
    width?: number;
    height?: number;
    framebuffer?: object;
  }): Texture;
}

export default Texture;
