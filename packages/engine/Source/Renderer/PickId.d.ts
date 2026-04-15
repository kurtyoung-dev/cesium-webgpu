/**
 * Type declarations for PickId.js.
 *
 * Co-located `.d.ts` overrides TypeScript's inference from the JS source
 * so WebGPU TypeScript callers can construct PickId directly without
 * `as unknown as CesiumPickId` casts at the JS↔TS boundary.
 */

import Color from "../Core/Color.js";
import type { PickTarget } from "./GraphicsContext.js";

declare class PickId {
  constructor(pickObjects: Map<number, PickTarget>, key: number, color: Color);

  readonly _pickObjects: Map<number, PickTarget>;
  key: number;
  color: Color;
  /** Pre-computed RGBA for WebGPU (little-endian RGB + alpha=1). */
  normalizedRgba: Float32Array;

  /** Object bound to this pick ID (get/set backed by _pickObjects map). */
  object: PickTarget;

  /** Remove this pick ID from the shared map. */
  destroy(): undefined;
}

export default PickId;
