/**
 * Type declarations for CubeMap.js.
 *
 * Co-located `.d.ts` overrides TypeScript's inference from the JS source.
 * CubeMap is a WebGL cube-map wrapper — six `Texture`-like faces bound
 * together for environment-map sampling. Scene-layer code hands CubeMap
 * handles back into both WebGL and WebGPU paths, so TS callers need
 * real types at the boundary.
 */

import type Cartesian3 from "../Core/Cartesian3.js";
import type Sampler from "./Sampler.js";
import type Texture, { TextureSource } from "./Texture.js";

/** Face name string enum; values match GL cube-map face suffixes. */
export type CubeMapFaceName =
  | "positiveX"
  | "negativeX"
  | "positiveY"
  | "negativeY"
  | "positiveZ"
  | "negativeZ";

/** A per-face source. Same shape as Texture's source union. */
export type CubeMapFaceSource =
  | TextureSource
  | ImageData
  | HTMLImageElement
  | HTMLCanvasElement
  | ImageBitmap;

export interface CubeMapConstructorOptions {
  context: object;
  source?: Record<CubeMapFaceName, CubeMapFaceSource>;
  width?: number;
  height?: number;
  pixelFormat?: number;
  pixelDatatype?: number;
  flipY?: boolean;
  preMultiplyAlpha?: boolean;
  skipColorSpaceConversion?: boolean;
  sampler?: Sampler;
}

declare class CubeMap {
  constructor(options: CubeMapConstructorOptions);

  // ─── Face accessors (each face is a Texture-shaped wrapper) ─────────
  readonly positiveX: Texture;
  readonly negativeX: Texture;
  readonly positiveY: Texture;
  readonly negativeY: Texture;
  readonly positiveZ: Texture;
  readonly negativeZ: Texture;

  // ─── Shared metadata ─────────────────────────────────────────────────
  readonly pixelFormat: number;
  readonly pixelDatatype: number;
  readonly width: number;
  readonly height: number;
  readonly sizeInBytes: number;
  readonly preMultiplyAlpha: boolean;
  readonly flipY: boolean;
  sampler: Sampler;

  // ─── Instance methods ────────────────────────────────────────────────
  copyFace(
    frameState: unknown,
    texture: Texture,
    face: CubeMapFaceName,
    mipLevel?: number,
  ): void;
  loadMipmaps(
    source: Array<Record<CubeMapFaceName, CubeMapFaceSource>>,
    skipColorSpaceConversion?: boolean,
  ): void;
  generateMipmap(hint?: number): void;
  isDestroyed(): boolean;
  destroy(): void;

  // ─── Statics ─────────────────────────────────────────────────────────
  static readonly FaceName: {
    readonly POSITIVEX: "positiveX";
    readonly NEGATIVEX: "negativeX";
    readonly POSITIVEY: "positiveY";
    readonly NEGATIVEY: "negativeY";
    readonly POSITIVEZ: "positiveZ";
    readonly NEGATIVEZ: "negativeZ";
  };
  static faceNames(): Iterable<CubeMapFaceName>;
  static getDirection(face: CubeMapFaceName, result?: Cartesian3): Cartesian3;
  static createVertexArray(context: object): object;
  static loadFace: (...args: unknown[]) => unknown;
}

export default CubeMap;
