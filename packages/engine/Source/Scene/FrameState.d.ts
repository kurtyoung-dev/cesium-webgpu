/**
 * Type declarations for FrameState.js.
 *
 * Co-located `.d.ts` overrides TypeScript's inference from the JS source.
 * FrameState is a large plain-data container (~50 fields) populated by
 * Scene each frame and passed to every update/render path. Rather than
 * duplicating the entire field list here, this declaration uses
 * interface merging to reuse the ambient `CesiumFrameState` shape:
 *
 *   - `declare class FrameState` — supplies the constructor signature
 *     that TypeScript cannot otherwise derive from the JS.
 *   - `interface FrameState extends CesiumFrameState` — merges all
 *     instance fields from the already-maintained ambient interface in
 *     `Renderer/WebGPU/cesium-js-types.d.ts`, so both shapes stay in
 *     lockstep with a single point of truth.
 *
 * Net effect: TS callers can `import FrameState from "..."`, construct
 * instances, and pass them to APIs typed as `CesiumFrameState` without
 * any cast. The WebGPU renderer is the primary beneficiary.
 */

declare class FrameState {
  constructor(
    context: CesiumGraphicsContext,
    creditDisplay: unknown,
    jobScheduler: unknown,
  );
}

// Declaration merging: pull every field off the ambient CesiumFrameState
// interface so `FrameState` instances are structurally assignable to any
// `CesiumFrameState`-typed parameter.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
interface FrameState extends CesiumFrameState {}

export default FrameState;
