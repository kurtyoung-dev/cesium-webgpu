/**
 * CLT-B4 — WebGL's day/night camera-distance lighting fade, as a leaf.
 *
 * WHY THIS IS ITS OWN MODULE. Same reason as `WebGPUGlobeTunables` (CLT-B2):
 * three parties share this law and cannot import each other — the CPU packer
 * (`WebGPUGlobeSurfaceTileUB`), the shader (`GlobeTerrain.wgsl`'s
 * `mix(1.0, computeDayNightDiffuse(...), tile.lightingFade)`), and the Node
 * spec that proves both match `GlobeFS.glsl`
 * (`Tools/visual-regression/globe-daynight-ramp-law.spec.mjs`). The packer
 * imports sibling modules through `.js` specifiers that resolve to `.ts` files,
 * which Node's strip-only TypeScript loader will not follow, so a spec cannot
 * import the packer. A leaf whose only import is a real `.js` enum can be
 * EXECUTED by the spec — which is the difference between pinning the law and
 * re-implementing it next to itself.
 *
 * THE LAW, transcribed from `GlobeFS.glsl:620-644` rather than re-derived:
 *
 * ```glsl
 * float cameraDist;
 * if (czm_sceneMode == czm_sceneMode2D)
 *     cameraDist = max(czm_frustumPlanes.x - czm_frustumPlanes.y,
 *                      czm_frustumPlanes.w - czm_frustumPlanes.z) * 0.5;
 * else if (czm_sceneMode == czm_sceneModeColumbusView)
 *     cameraDist = -czm_view[3].z;
 * else
 *     cameraDist = length(czm_view[3]);
 * float fadeOutDist = u_lightingFadeDistance.x;
 * float fadeInDist  = u_lightingFadeDistance.y;
 * if (czm_sceneMode != czm_sceneMode3D) {
 *     vec3 radii = czm_ellipsoidRadii;
 *     float maxRadii = max(radii.x, max(radii.y, radii.z));
 *     fadeOutDist -= maxRadii;
 *     fadeInDist  -= maxRadii;
 * }
 * fade = clamp((cameraDist - fadeOutDist) / (fadeInDist - fadeOutDist), 0, 1);
 * ```
 *
 * `GlobeFS.glsl:852` then consumes it as
 * `diffuseIntensity = mix(1.0, diffuseIntensity, fade)` — 0 near the ground
 * (flat-lit) and 1 at orbit (full day/night). The WGSL had no such term at all
 * until CO-18; `probe-daynight-terminator-law.mjs` run 2 measured the gap as a
 * night/day luminance ratio of 0.312 / 0.0896 against WebGL's 1.000 / 0.300 at
 * 3 Mm / 25 Mm. WebGL's two readings are this law's exact closed form: 3 Mm
 * sits below `lightingFadeOutDistance` (fade 0, so night and day both mix to
 * 1.0) and 25 Mm above `lightingFadeInDistance` (fade 1, so the ratio is the
 * bare `0.3 / 1.0`).
 *
 * WHY CPU-SIDE AT ALL. `GlobeTerrain.wgsl` carries neither `czm_view` nor
 * `czm_frustumPlanes`, so the mode-dependent `cameraDist` cannot be formed in
 * the shader without adding two more uniforms and re-deriving the selection
 * there. One packed scalar keeps the law single-sourced.
 *
 * @module WebGPUGlobeLightingFade
 */

import SceneMode from "../../Scene/SceneMode.js";

/** The subset of the frame's camera this law reads. */
export interface LightingFadeCamera {
  /** `czm_view`. Column 3 (elements 12/13/14) is the translation `czm_view[3]`. */
  readonly viewMatrix?: { readonly [index: number]: number };
  /**
   * `czm_frustumPlanes` is written from `frustum.offCenterFrustum ?? frustum`
   * (`UniformState.js:794-802`), so the 2D branch reads through the same
   * indirection rather than off the outer orthographic wrapper.
   */
  readonly frustum?: {
    readonly top?: number;
    readonly bottom?: number;
    readonly left?: number;
    readonly right?: number;
    readonly offCenterFrustum?: {
      readonly top?: number;
      readonly bottom?: number;
      readonly left?: number;
      readonly right?: number;
    };
  };
}

/**
 * `GlobeSurfaceTileProvider`'s constructor defaults for the two fade distances
 * (`GlobeSurfaceTileProvider.js:315-316`), which are also the WebGL uniform's
 * own initial value (`GlobeSurfaceTileProviderRendering.js:775`). `Globe.js`
 * overwrites both every frame with `π/2 × Rmin` and `π × Rmin`; these only
 * apply if a provider never got the copy.
 */
export const DEFAULT_LIGHTING_FADE_OUT_DISTANCE = 6500000.0;
/** @see DEFAULT_LIGHTING_FADE_OUT_DISTANCE */
export const DEFAULT_LIGHTING_FADE_IN_DISTANCE = 9000000.0;

/**
 * Evaluate WebGL's day/night camera-distance lighting fade for this frame.
 *
 * `length(czm_view[3])` is `|camera.position|` in the frame's own space —
 * `(right, up, direction)` is orthonormal, so the translation column's
 * magnitude is the position's — but this reads the matrix directly so a future
 * camera-transform change cannot silently break the identity.
 *
 * Returns 0 (flat-lit — WebGL's near-ground behaviour) when the camera, its
 * view matrix, or the 2D frustum planes are unavailable. That is the same value
 * the pre-CO-18 zero-filled scratch produced at this slot, so an unavailable
 * camera degrades to "no day/night falloff", never to a black night side.
 */
export function computeLightingFade(
  sceneMode: number,
  camera: LightingFadeCamera | undefined,
  fadeOutDistance: number,
  fadeInDistance: number,
  maximumEllipsoidRadius: number,
): number {
  if (!camera) {
    return 0;
  }
  let cameraDist: number;
  if (sceneMode === SceneMode.SCENE2D) {
    const frustum = camera.frustum?.offCenterFrustum ?? camera.frustum;
    const top = frustum?.top;
    const bottom = frustum?.bottom;
    const left = frustum?.left;
    const right = frustum?.right;
    if (
      !Number.isFinite(top) ||
      !Number.isFinite(bottom) ||
      !Number.isFinite(left) ||
      !Number.isFinite(right)
    ) {
      return 0;
    }
    cameraDist =
      Math.max(
        (top as number) - (bottom as number),
        (right as number) - (left as number),
      ) * 0.5;
  } else {
    const view = camera.viewMatrix;
    if (!view) {
      return 0;
    }
    const tx = view[12];
    const ty = view[13];
    const tz = view[14];
    if (!Number.isFinite(tx) || !Number.isFinite(ty) || !Number.isFinite(tz)) {
      return 0;
    }
    cameraDist =
      sceneMode === SceneMode.COLUMBUS_VIEW
        ? -tz
        : Math.sqrt(tx * tx + ty * ty + tz * tz);
  }
  let fadeOutDist = fadeOutDistance;
  let fadeInDist = fadeInDistance;
  if (sceneMode !== SceneMode.SCENE3D) {
    fadeOutDist -= maximumEllipsoidRadius;
    fadeInDist -= maximumEllipsoidRadius;
  }
  const span = fadeInDist - fadeOutDist;
  if (!Number.isFinite(span) || span === 0) {
    // GLSL would divide by zero here and let the clamp resolve the Inf to a
    // bound; refusing to fabricate a fade is the honest CPU equivalent.
    return 0;
  }
  const fade = (cameraDist - fadeOutDist) / span;
  return fade < 0 ? 0 : fade > 1 ? 1 : fade;
}

export default computeLightingFade;
