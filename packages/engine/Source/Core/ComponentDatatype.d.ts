/**
 * Sidecar TypeScript declaration for ComponentDatatype.js.
 *
 * ComponentDatatype is a frozen plain object at runtime, but Cesium's JSDoc
 * convention (`@param {ComponentDatatype}`) treats it as a numeric enum type.
 * Modeling it as an `enum` + a merged `namespace` lets both interpretations
 * work: the identifier is a value (with enum members + utility functions)
 * AND a type (= numeric enum value). This matches the Cesium JSDoc
 * convention precisely.
 *
 * Pattern: co-located .d.ts overrides JS inference for default imports
 * (see CLAUDE.md). No tsconfig changes required.
 *
 * @private
 */

/** Typed arrays produced by `ComponentDatatype.createTypedArray` etc. */
export type ComponentDatatypeTypedArray =
  | Int8Array
  | Uint8Array
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array
  | Float32Array
  | Float64Array;

/**
 * WebGL component datatype enum. Members are numeric WebGL constants
 * (BYTE = 5120, FLOAT = 5126, etc.). Use as both a type in JSDoc/TS
 * (`@param {ComponentDatatype}` resolves to this enum) and as a value
 * when reading `ComponentDatatype.FLOAT`.
 */
declare enum ComponentDatatype {
  BYTE = 5120,
  UNSIGNED_BYTE = 5121,
  SHORT = 5122,
  UNSIGNED_SHORT = 5123,
  INT = 5124,
  UNSIGNED_INT = 5125,
  FLOAT = 5126,
  DOUBLE = 5130,
}

/** Static utility methods attached to the `ComponentDatatype` runtime object. */
declare namespace ComponentDatatype {
  /** Size in bytes of one component of the given datatype. */
  function getSizeInBytes(componentDatatype: ComponentDatatype): number;

  /** Infers the ComponentDatatype from a TypedArray instance. */
  function fromTypedArray(
    array: ComponentDatatypeTypedArray | ArrayBufferView,
  ): ComponentDatatype;

  /** True iff the value is a known ComponentDatatype constant. */
  function validate(componentDatatype: ComponentDatatype): boolean;

  /** Allocates a new TypedArray for the given datatype. */
  function createTypedArray(
    componentDatatype: ComponentDatatype,
    valuesOrLength: number | ArrayLike<number>,
  ): ComponentDatatypeTypedArray;

  /** Creates a TypedArray view over an existing ArrayBuffer. */
  function createArrayBufferView(
    componentDatatype: ComponentDatatype,
    buffer: ArrayBuffer,
    byteOffset?: number,
    length?: number,
  ): ComponentDatatypeTypedArray;

  /** Inverse of `name` — maps 'BYTE' → BYTE, etc. */
  function fromName(name: string): ComponentDatatype;
}

export default ComponentDatatype;
