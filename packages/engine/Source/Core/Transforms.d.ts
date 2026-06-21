/**
 * Minimal type declarations for Transforms.js.
 *
 * Co-located `.d.ts` overrides TypeScript's inference from the JS source
 * (allowJs + checkJs:false), giving WebGPU TypeScript callers proper types
 * for the handful of Transforms operations they use. Only the members the
 * fork's TS code references are declared here — extend as needed rather
 * than typing the whole ~1300-line module. See Matrix4.d.ts / Cartesian3.d.ts
 * for the same pattern.
 */

import Cartesian3 from "./Cartesian3.js";
import Matrix3 from "./Matrix3.js";
import Matrix4 from "./Matrix4.js";

declare const Transforms: {
  /**
   * Computes a 4x4 transformation matrix from a reference frame with an
   * east-north-up axes centered at the provided origin to the provided
   * ellipsoid's fixed reference frame.
   */
  eastNorthUpToFixedFrame(
    origin: Cartesian3,
    ellipsoid?: unknown,
    result?: Matrix4,
  ): Matrix4;

  /**
   * Computes a rotation matrix to transform a point or vector from True
   * Equator Mean Equinox (TEME) axes to the pseudo-fixed axes at a given
   * time.
   */
  computeTemeToPseudoFixedMatrix(date: unknown, result?: Matrix3): Matrix3;
};

export default Transforms;
