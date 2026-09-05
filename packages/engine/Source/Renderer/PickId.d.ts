/**
 * Type declarations for PickId.js.
 *
 * Co-located `.d.ts` overrides TypeScript's inference from the JS source
 * so WebGPU TypeScript callers can construct PickId directly without
 * `as unknown as CesiumPickId` casts at the JS↔TS boundary.
 */

import Color from "../Core/Color.js";
import type { PickKind, PickTarget } from "./GraphicsContext.js";

declare class PickId {
  constructor(
    pickObjects: Map<number, PickTarget>,
    key: number,
    color: Color,
    pickKinds?: Map<number, PickKind>,
  );

  readonly _pickObjects: Map<number, PickTarget>;
  readonly _pickKinds?: Map<number, PickKind>;
  key: number;
  color: Color;
  /** Pre-computed RGBA for WebGPU (little-endian RGBA; alpha is key bits 24-31). */
  normalizedRgba: Float32Array;

  /** Object bound to this pick ID (get/set backed by _pickObjects map). */
  object: PickTarget;

  /** Remove this pick ID from both the target map and the parallel kind map. */
  destroy(): undefined;
}

export default PickId;
