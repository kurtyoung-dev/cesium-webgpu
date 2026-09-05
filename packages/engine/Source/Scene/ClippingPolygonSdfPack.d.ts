/**
 * Ambient types for the fork-owned signed-distance clipping-polygon packer.
 * TypeScript callers (the WebGPU CLIPPING_POLYGONS feature renderer) get real
 * types instead of the `any` a bare JS import would infer.
 */

/** Packed texture layout returned by `packDataForFeatureRenderer`. */
export interface PackedPolygonLayout {
  positionsWidth: number;
  positionsHeight: number;
  extentsWidth: number;
  extentsHeight: number;
  extentsCount: number;
}

/** The subset of ClippingPolygonCollection this module reads and writes. */
export interface ClippingPolygonSdfPackable {
  length: number;
  get(index: number): unknown;
  _float32View?: Float32Array;
  _extentsFloat32View?: Float32Array;
  _extentsCount?: number;
}

/** Spherical extents rectangle, in radians. */
export interface SphericalExtents {
  west: number;
  south: number;
  east: number;
  north: number;
}

export function computeSphericalExtents(
  polygon: unknown,
  result?: SphericalExtents,
): SphericalExtents;

export function packDataForFeatureRenderer(
  collection: ClippingPolygonSdfPackable,
  maximumTextureSize: number,
): PackedPolygonLayout | undefined;

export function packPolygonsAsFloats(
  collection: ClippingPolygonSdfPackable,
): void;

export function pixelsNeededForExtents(
  collection: ClippingPolygonSdfPackable,
): number;

export function pixelsNeededForPolygonPositions(
  collection: ClippingPolygonSdfPackable,
): number;
