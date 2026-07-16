/**
 * Type declarations for Matrix4.js.
 *
 * Co-located `.d.ts` overrides TypeScript's inference from the JS source.
 * Matrix4 is a plain ES6 class (NOT a Float64Array subclass) with
 * numeric-index properties and a large static API (~60 methods). This
 * declaration gives WebGPU TypeScript callers proper types for all
 * Matrix4 operations and enables structural compatibility with
 * CesiumMatrix4 (which models the ArrayLike<number> shape for UBO packing).
 */

import Cartesian3 from "./Cartesian3.js";
import Cartesian4 from "./Cartesian4.js";
import Matrix3 from "./Matrix3.js";
import type { ClipSpaceConventionRecord } from "./ClipSpaceConvention.js";

/**
 * A 4x4 matrix, indexable as a column-major order array via numeric
 * properties [0]..[15]. Constructor parameters are in row-major order
 * for readability. Used across the renderer for model, view, projection,
 * and composite transforms.
 */
declare class Matrix4 {
  /** Column 0, row 0 */ 0: number;
  /** Column 0, row 1 */ 1: number;
  /** Column 0, row 2 */ 2: number;
  /** Column 0, row 3 */ 3: number;
  /** Column 1, row 0 */ 4: number;
  /** Column 1, row 1 */ 5: number;
  /** Column 1, row 2 */ 6: number;
  /** Column 1, row 3 */ 7: number;
  /** Column 2, row 0 */ 8: number;
  /** Column 2, row 1 */ 9: number;
  /** Column 2, row 2 */ 10: number;
  /** Column 2, row 3 */ 11: number;
  /** Column 3, row 0 */ 12: number;
  /** Column 3, row 1 */ 13: number;
  /** Column 3, row 2 */ 14: number;
  /** Column 3, row 3 */ 15: number;
  readonly length: 16;
  /** Generic numeric-index access (for code that iterates `mv[i]` for i=0..15). */
  [index: number]: number;

  constructor(
    column0Row0?: number,
    column1Row0?: number,
    column2Row0?: number,
    column3Row0?: number,
    column0Row1?: number,
    column1Row1?: number,
    column2Row1?: number,
    column3Row1?: number,
    column0Row2?: number,
    column1Row2?: number,
    column2Row2?: number,
    column3Row2?: number,
    column0Row3?: number,
    column1Row3?: number,
    column2Row3?: number,
    column3Row3?: number,
  );

  // ─── Instance methods ────────────────────────────────────────────────
  clone(result?: Matrix4): Matrix4;
  equals(right?: Matrix4): boolean;
  equalsEpsilon(right?: Matrix4, epsilon?: number): boolean;
  toString(): string;

  // ─── Pack/unpack + basic factories ───────────────────────────────────
  static readonly packedLength: 16;
  static pack(
    value: Matrix4,
    array: number[] | Float32Array | Float64Array,
    startingIndex?: number,
  ): number[] | Float32Array | Float64Array;
  static unpack(
    array: ArrayLike<number>,
    startingIndex?: number,
    result?: Matrix4,
  ): Matrix4;
  static packArray(
    array: Matrix4[],
    result?: number[] | Float32Array | Float64Array,
  ): number[] | Float32Array | Float64Array;
  static unpackArray(array: ArrayLike<number>, result?: Matrix4[]): Matrix4[];
  static fromArray(
    array: ArrayLike<number>,
    startingIndex?: number,
    result?: Matrix4,
  ): Matrix4;
  static clone(matrix: Matrix4, result?: Matrix4): Matrix4;

  // ─── Constructors from components ────────────────────────────────────
  static fromColumnMajorArray(
    values: ArrayLike<number>,
    result?: Matrix4,
  ): Matrix4;
  static fromRowMajorArray(
    values: ArrayLike<number>,
    result?: Matrix4,
  ): Matrix4;
  static fromRotationTranslation(
    rotation: Matrix3,
    translation?: Cartesian3,
    result?: Matrix4,
  ): Matrix4;
  static fromTranslationQuaternionRotationScale(
    translation: Cartesian3,
    rotation: unknown,
    scale: Cartesian3,
    result?: Matrix4,
  ): Matrix4;
  static fromTranslationRotationScale(
    translationRotationScale: unknown,
    result?: Matrix4,
  ): Matrix4;
  static fromTranslation(translation: Cartesian3, result?: Matrix4): Matrix4;
  static fromScale(scale: Cartesian3, result?: Matrix4): Matrix4;
  static fromUniformScale(scale: number, result?: Matrix4): Matrix4;
  static fromRotation(rotation: Matrix3, result?: Matrix4): Matrix4;
  static fromCamera(camera: unknown, result?: Matrix4): Matrix4;

  // ─── Projection / view builders ──────────────────────────────────────
  static computePerspectiveFieldOfView(
    fovY: number,
    aspectRatio: number,
    near: number,
    far: number,
    result: Matrix4,
    clipSpaceConvention?: ClipSpaceConventionRecord,
  ): Matrix4;
  static computeOrthographicOffCenter(
    left: number,
    right: number,
    bottom: number,
    top: number,
    near: number,
    far: number,
    result: Matrix4,
    clipSpaceConvention?: ClipSpaceConventionRecord,
  ): Matrix4;
  static computePerspectiveOffCenter(
    left: number,
    right: number,
    bottom: number,
    top: number,
    near: number,
    far: number,
    result: Matrix4,
    clipSpaceConvention?: ClipSpaceConventionRecord,
  ): Matrix4;
  static computeInfinitePerspectiveOffCenter(
    left: number,
    right: number,
    bottom: number,
    top: number,
    near: number,
    result: Matrix4,
    clipSpaceConvention?: ClipSpaceConventionRecord,
  ): Matrix4;
  static computeViewportTransformation(
    viewport:
      { x?: number; y?: number; width?: number; height?: number } | undefined,
    nearDepthRange: number,
    farDepthRange: number,
    result: Matrix4,
  ): Matrix4;
  static computeView(
    position: Cartesian3,
    direction: Cartesian3,
    up: Cartesian3,
    right: Cartesian3,
    result: Matrix4,
  ): Matrix4;

  // ─── Array / element access ──────────────────────────────────────────
  static toArray(
    matrix: Matrix4,
    result?: number[] | Float32Array | Float64Array,
  ): number[] | Float32Array | Float64Array;
  static getElementIndex(column: number, row: number): number;
  static getColumn(
    matrix: Matrix4,
    index: number,
    result: Cartesian4,
  ): Cartesian4;
  static setColumn(
    matrix: Matrix4,
    index: number,
    cartesian: Cartesian4,
    result: Matrix4,
  ): Matrix4;
  static getRow(matrix: Matrix4, index: number, result: Cartesian4): Cartesian4;
  static setRow(
    matrix: Matrix4,
    index: number,
    cartesian: Cartesian4,
    result: Matrix4,
  ): Matrix4;
  static setTranslation(
    matrix: Matrix4,
    translation: Cartesian3,
    result: Matrix4,
  ): Matrix4;
  static setScale(matrix: Matrix4, scale: Cartesian3, result: Matrix4): Matrix4;
  static setUniformScale(
    matrix: Matrix4,
    scale: number,
    result: Matrix4,
  ): Matrix4;
  static getScale(matrix: Matrix4, result: Cartesian3): Cartesian3;
  static getMaximumScale(matrix: Matrix4): number;
  static setRotation(
    matrix: Matrix4,
    rotation: Matrix3,
    result: Matrix4,
  ): Matrix4;
  static getRotation(matrix: Matrix4, result: Matrix3): Matrix3;
  static getTranslation(matrix: Matrix4, result: Cartesian3): Cartesian3;
  static getMatrix3(matrix: Matrix4, result: Matrix3): Matrix3;

  // ─── Matrix arithmetic ───────────────────────────────────────────────
  static multiply(left: Matrix4, right: Matrix4, result: Matrix4): Matrix4;
  static add(left: Matrix4, right: Matrix4, result: Matrix4): Matrix4;
  static subtract(left: Matrix4, right: Matrix4, result: Matrix4): Matrix4;
  static multiplyTransformation(
    left: Matrix4,
    right: Matrix4,
    result: Matrix4,
  ): Matrix4;
  static multiplyByMatrix3(
    matrix: Matrix4,
    rotation: Matrix3,
    result: Matrix4,
  ): Matrix4;
  static multiplyByTranslation(
    matrix: Matrix4,
    translation: Cartesian3,
    result: Matrix4,
  ): Matrix4;
  static multiplyByScale(
    matrix: Matrix4,
    scale: Cartesian3,
    result: Matrix4,
  ): Matrix4;
  static multiplyByUniformScale(
    matrix: Matrix4,
    scale: number,
    result: Matrix4,
  ): Matrix4;
  static multiplyByVector(
    matrix: Matrix4,
    cartesian: Cartesian4,
    result: Cartesian4,
  ): Cartesian4;
  static multiplyByPointAsVector(
    matrix: Matrix4,
    cartesian: Cartesian3,
    result: Cartesian3,
  ): Cartesian3;
  static multiplyByPoint(
    matrix: Matrix4,
    cartesian: Cartesian3,
    result: Cartesian3,
  ): Cartesian3;
  static multiplyByScalar(
    matrix: Matrix4,
    scalar: number,
    result: Matrix4,
  ): Matrix4;

  // ─── Unary operations ────────────────────────────────────────────────
  static negate(matrix: Matrix4, result: Matrix4): Matrix4;
  static transpose(matrix: Matrix4, result: Matrix4): Matrix4;
  static abs(matrix: Matrix4, result: Matrix4): Matrix4;
  static inverse(matrix: Matrix4, result: Matrix4): Matrix4;
  static inverseTransformation(matrix: Matrix4, result: Matrix4): Matrix4;
  static inverseTranspose(matrix: Matrix4, result: Matrix4): Matrix4;

  // ─── Equality ────────────────────────────────────────────────────────
  static equals(left?: Matrix4, right?: Matrix4): boolean;
  static equalsEpsilon(
    left?: Matrix4,
    right?: Matrix4,
    epsilon?: number,
  ): boolean;
  static equalsArray(
    matrix: Matrix4,
    array: ArrayLike<number>,
    offset: number,
  ): boolean;

  // ─── Constants ───────────────────────────────────────────────────────
  static readonly IDENTITY: Matrix4;
  static readonly ZERO: Matrix4;

  /** Flat-array index constants (column-major). */
  static readonly COLUMN0ROW0: 0;
  static readonly COLUMN0ROW1: 1;
  static readonly COLUMN0ROW2: 2;
  static readonly COLUMN0ROW3: 3;
  static readonly COLUMN1ROW0: 4;
  static readonly COLUMN1ROW1: 5;
  static readonly COLUMN1ROW2: 6;
  static readonly COLUMN1ROW3: 7;
  static readonly COLUMN2ROW0: 8;
  static readonly COLUMN2ROW1: 9;
  static readonly COLUMN2ROW2: 10;
  static readonly COLUMN2ROW3: 11;
  static readonly COLUMN3ROW0: 12;
  static readonly COLUMN3ROW1: 13;
  static readonly COLUMN3ROW2: 14;
  static readonly COLUMN3ROW3: 15;
}

export default Matrix4;
