/**
 * Type declarations for BoundingRectangle.js.
 *
 * Co-located `.d.ts` overrides TypeScript's inference from the JS source
 * so WebGPU TypeScript callers can pass `BoundingRectangle` (or any
 * structurally-matching `{x,y,width,height}` shape like
 * `CesiumBoundingRectangle`) without `as unknown as` casts.
 */

import Cartesian2 from "./Cartesian2.js";

/** Minimal structural shape shared with `CesiumBoundingRectangle`. */
export interface BoundingRectangleLike {
  x: number;
  y: number;
  width: number;
  height: number;
}

declare class BoundingRectangle implements BoundingRectangleLike {
  x: number;
  y: number;
  width: number;
  height: number;

  constructor(x?: number, y?: number, width?: number, height?: number);

  clone(result?: BoundingRectangle): BoundingRectangle;
  intersect(right: BoundingRectangleLike): number;
  equals(right?: BoundingRectangleLike): boolean;

  static readonly packedLength: 4;
  static pack(
    value: BoundingRectangleLike,
    array: number[] | Float32Array | Float64Array,
    startingIndex?: number,
  ): number[] | Float32Array | Float64Array;
  static unpack(
    array: ArrayLike<number>,
    startingIndex?: number,
    result?: BoundingRectangle,
  ): BoundingRectangle;
  static fromPoints(
    positions: ArrayLike<Cartesian2>,
    result?: BoundingRectangle,
  ): BoundingRectangle;
  static fromRectangle(
    rectangle: unknown,
    projection?: unknown,
    result?: BoundingRectangle,
  ): BoundingRectangle;
  /** Accepts any structurally compatible shape — the JS implementation
   *  only reads `x/y/width/height`. */
  static clone(
    rectangle: BoundingRectangleLike | undefined,
    result?: BoundingRectangleLike,
  ): BoundingRectangle;
  static union(
    left: BoundingRectangleLike,
    right: BoundingRectangleLike,
    result?: BoundingRectangle,
  ): BoundingRectangle;
  static expand(
    rectangle: BoundingRectangleLike,
    point: Cartesian2,
    result?: BoundingRectangle,
  ): BoundingRectangle;
  static intersect(
    left: BoundingRectangleLike,
    right: BoundingRectangleLike,
  ): number;
  static equals(
    left?: BoundingRectangleLike,
    right?: BoundingRectangleLike,
  ): boolean;
}

export default BoundingRectangle;
