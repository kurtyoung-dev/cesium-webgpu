/**
 * Type declarations for UniformState.js.
 *
 * Co-located `.d.ts` overrides TypeScript's inference from the JS source.
 * UniformState aggregates the scene's view/projection/lighting state for
 * the shader pipeline. This declaration exposes the subset actually read
 * by the WebGPU renderer — matching the `CesiumUniformState` ambient
 * interface so `new UniformState()` is assignable without casts.
 *
 * `Cesium*` types come from `WebGPU/cesium-js-types.d.ts`.
 */

import Cartesian2 from "../Core/Cartesian2.js";
import Cartesian3 from "../Core/Cartesian3.js";
import type { ClipSpaceConventionRecord } from "../Core/ClipSpaceConvention.js";
import Color from "../Core/Color.js";
import Matrix4 from "../Core/Matrix4.js";

declare class UniformState {
  constructor(clipSpaceConvention?: ClipSpaceConventionRecord);

  // ─── Mutable fields ──────────────────────────────────────────────────
  viewport: CesiumBoundingRectangle;
  model: Matrix4;
  globeDepthTexture: CesiumOpaqueTexture | undefined;

  // ─── Read-only derived state ────────────────────────────────────────
  readonly frameState: CesiumFrameState | undefined;
  readonly view: Matrix4;
  readonly inverseView: Matrix4;
  readonly projection: Matrix4;
  readonly inverseProjection: Matrix4;
  readonly viewProjection: Matrix4;
  readonly inverseViewProjection: Matrix4;
  /**
   * Last frame's `viewProjection`, cloned before the current-frame
   * state is written — see `UniformState.update()`. Consumed by the
   * TAA / motion-vector path (DP-H41, Batch 27).
   */
  readonly previousViewProjection: Matrix4;
  readonly modelView: Matrix4;
  readonly inverseModelView: Matrix4;
  readonly modelViewProjection: Matrix4;
  readonly modelViewProjectionRelativeToEye: Matrix4;
  readonly modelViewRelativeToEye: Matrix4;
  readonly normal: Matrix4;

  readonly encodedCameraPositionMCHigh: Cartesian3;
  readonly encodedCameraPositionMCLow: Cartesian3;
  readonly cameraPosition: Cartesian3;

  readonly sunDirectionEC: Cartesian3;
  readonly sunDirectionWC: Cartesian3;
  readonly sunPositionWC: Cartesian3;
  readonly moonDirectionEC: Cartesian3;
  readonly lightDirectionEC: Cartesian3;
  readonly lightDirectionWC: Cartesian3;
  readonly lightColor: Cartesian3;
  readonly lightColorHdr: Cartesian3;

  readonly eyeHeight: number;
  readonly fogDensity: number | undefined;
  readonly fogVisualDensityScalar: number | undefined;
  readonly fogMinimumBrightness: number | undefined;
  readonly currentFrustum: Cartesian2;
  readonly entireFrustum: Cartesian2;
  /**
   * `1 / log2((far - near) + 1)` for the current frustum — the per-frustum
   * log-depth factor (`czm_oneOverLog2FarDepthFromNearPlusOne`). Consumed by
   * the renderer-wide log-depth producers.
   */
  readonly oneOverLog2FarDepthFromNearPlusOne: number;
  readonly pixelRatio: number;
  readonly pass: number | undefined;
  readonly backgroundColor: Color;
  readonly splitPosition: number;
  readonly orthographicIn3D: boolean;

  readonly _context: CesiumGraphicsContext;

  // ─── Updaters called by the renderer each frame ─────────────────────
  update(frameState: CesiumFrameState): void;
  updateCamera(camera: CesiumCamera): void;
  updateFrustum(frustum: { near: number; far: number }): void;
  updatePass(pass: number): void;
}

export default UniformState;
