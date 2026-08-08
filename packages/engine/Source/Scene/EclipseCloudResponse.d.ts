// Co-located ambient types for the plain-JS EclipseCloudResponse.js. A sibling
// .d.ts overrides JS inference for TypeScript importers, so the WebGPU cloud
// renderer, the globe camera uniform buffer, the aerial-perspective effect, the
// volumetric-fog renderer and the dynamic-environment-map manager can all read
// these without `any`.
//
// The parameter is a minimal structural shape rather than the engine
// `FrameState` type: every consumer already holds its own narrowed frame-state
// view, and both accessors resolve to the identity when the fields are absent.

export interface EclipseCloudResponseFrameState {
  /** The published scene-light multiplier; absent outside an eclipse-aware frame. */
  eclipseSceneLightFactor?: number;
  /** The published per-frame eclipse state. */
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
