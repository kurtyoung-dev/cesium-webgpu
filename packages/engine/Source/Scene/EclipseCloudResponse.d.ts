// Co-located ambient types for the plain-JS EclipseCloudResponse.js (Session 29
// pattern: a sibling .d.ts overrides JS inference for TS importers, so the
// WebGPU cloud renderer, the globe camera UB, the aerial-perspective effect,
// the volumetric-fog renderer and the dynamic-environment-map manager can all
// read these without `any`).
//
// The parameter is deliberately a minimal STRUCTURAL shape rather than the
// engine `FrameState` type: every consumer here already holds its own
// narrowed frame-state view, and both accessors are written to resolve to the
// identity when the fields are absent.

export interface EclipseCloudResponseFrameState {
  /** C12-29 S2's published scene-light multiplier; absent outside an eclipse-aware frame. */
  eclipseSceneLightFactor?: number;
  /** C12-29 S1's published per-frame eclipse state. */
  eclipseState?: {
    enabled?: boolean;
    valid?: boolean;
    moonObscuration?: number;
  };
}

export function resolveEclipseCloudFactor(
  frameState: EclipseCloudResponseFrameState | undefined,
): number;

export function eclipseCloudDirectionalFraction(
  frameState: EclipseCloudResponseFrameState | undefined,
): number;

export function applyEclipseCloudDimming(value: number, factor: number): number;

export function quantizeEclipseEnvironmentRefreshInput(factor: number): number;

export const ECLIPSE_ENV_REFRESH_STEPS: number;
export const ECLIPSE_ENV_REFRESH_BUCKET_IDENTITY: number;

export default resolveEclipseCloudFactor;
