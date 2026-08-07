// StarCubeMapResource.js — C12-14 (`samplable star texture`).
//
// A backend-neutral HANDLE to the star cube map that {@link SkyBox} already
// loads, so code outside the sky box can SAMPLE it instead of only drawing it.
// The cube map is the one celestial signal in this engine that is a texture
// rather than a sprite pass, which makes it the only celestial source a
// reflection shader can look up in a single fetch.
//
// ─── PRINCIPLE 7: NOTHING CONSUMES THIS YET, AND THAT IS THE POINT ─────────
//
// **Do not delete this module because grep shows no reader.** It exists to
// discharge a named, recorded blocker:
// `migration_doc/CELESTIAL_WATER_REFLECTION_RESEARCH.md` lists
// *"Samplable STAR cubemap"* as the **biggest gap** for `C11-163`
// (C11-CELESTIAL-WATER-REFLECTION), noting that `StarField.wgsl` is
// un-samplable point sprites and `ProceduralSkyCubemap.wgsl` carries the
// atmosphere only, so its planned `sampleStarField()` had no texture to read.
// `C12-14` is the row that closes that gap; `C11-163` is the row that consumes
// it. Between the two, this is scaffolding by design.
//
// Today's readers: `Scene/CubeMapPanorama.js` (producer),
// `Scene/SkyBox.js` (re-exposes it), `frameState.starCubeMap` (publication).
// No shader samples it yet.
//
// ─── WHAT A CONSUMER NEEDS TO KNOW ────────────────────────────────────────
//
// 1. **Frame.** The lookup direction is TEME / inertial, NOT Earth-fixed —
//    both backends apply `temeToPseudoFixed` on the way to clip space
//    (`SkyBoxVS.glsl` on WebGL; `panoramaTransform` on WebGPU), so the texture
//    itself is stored in the inertial frame. A reflection shader working in
//    world/eye space must rotate its sample direction by
//    `temeToPseudoFixed^-1` (or bake the rotation into a matrix uniform, as
//    the star sprites do).
//
// 2. **Content.** Under the default `SkyBox.Variant.TYCHO_T5_DIFFUSE` the cube
//    map carries the DIFFUSE galactic band and nothing else — Campaign-12
//    decision DR-01 moved every RESOLVED star to the `StarField` sprite
//    catalogue. So a reflection that samples ONLY this texture will show the
//    Milky Way on the water and no individual stars, which is a design
//    consequence, not a bug. `SkyBox.variant` reports which map is loaded;
//    `SkyBox.Variant.TYCHO_T5` is the un-blurred set that does carry baked
//    stars. This is load-bearing for `C11-163`'s "moon + stars by night" half
//    and is the first thing that row must decide about.
//
// 3. **Timing.** Both backends load the six faces ASYNCHRONOUSLY. `available`
//    is false until they land, and it can go false again when `sources` are
//    replaced or the owning object is destroyed. Read it every frame; never
//    cache the raw handle across frames.
//
// 4. **Ownership.** The handles below are BORROWED. `CubeMapPanorama` (WebGL)
//    and the WebGPU feature renderer's per-instance state own the underlying
//    resources and destroy them. A consumer must not destroy, reallocate or
//    retain them past the frame.
//
// @private
// @module StarCubeMapResource

import defined from "../Core/defined.js";

/**
 * Creates the mutable descriptor the producers fill in. One per
 * {@link CubeMapPanorama}; never reallocated per frame, so a consumer that
 * holds the object across frames still sees current values (but must re-check
 * {@link module:StarCubeMapResource.available} — see note 3 in the header).
 *
 * @returns {object} The star cube-map descriptor.
 * @private
 */
function createStarCubeMapResource() {
  return {
    /** Whether the six faces have finished loading and are bindable. */
    available: false,
    /** `"webgl"` or `"webgpu"`, or undefined before the first realization. */
    backend: undefined,
    /** Edge length of one cube face in texels; 0 until known. */
    faceSize: 0,
    /**
     * The frame the cube-map lookup direction is expressed in. Always TEME —
     * stated as data rather than only in prose so a consumer can assert it.
     */
    orientation: "TEME",
    /** WebGL handle: a {@link CubeMap}, bindable through a `samplerCube`. */
    webglCubeMap: undefined,
    /** WebGPU handle: the `GPUTexture` backing the six faces. */
    webgpuTexture: undefined,
    /** WebGPU handle: a `cube`-dimension `GPUTextureView` of the above. */
    webgpuTextureView: undefined,
  };
}

/**
 * Returns the descriptor to the "nothing bindable" state. Called whenever the
 * producer's texture is absent, still loading, or replaced.
 *
 * @param {object} resource A {@link createStarCubeMapResource} object.
 * @returns {object} `resource`.
 * @private
 */
function clearStarCubeMapResource(resource) {
  resource.available = false;
  resource.faceSize = 0;
  resource.webglCubeMap = undefined;
  resource.webgpuTexture = undefined;
  resource.webgpuTextureView = undefined;
  return resource;
}

/**
 * Records the WebGL cube map for this frame.
 *
 * @param {object} resource A {@link createStarCubeMapResource} object.
 * @param {object} [cubeMap] The {@link CubeMap} the panorama loaded.
 * @returns {object} `resource`.
 * @private
 */
function setWebGLStarCubeMap(resource, cubeMap) {
  resource.backend = "webgl";
  if (!defined(cubeMap)) {
    return clearStarCubeMapResource(resource);
  }
  resource.available = true;
  resource.faceSize = cubeMap.width ?? 0;
  resource.webglCubeMap = cubeMap;
  resource.webgpuTexture = undefined;
  resource.webgpuTextureView = undefined;
  return resource;
}

/**
 * Records the WebGPU cube texture + view for this frame.
 *
 * @param {object} resource A {@link createStarCubeMapResource} object.
 * @param {GPUTexture} [texture] The six-layer cube texture.
 * @param {GPUTextureView} [view] Its `cube`-dimension view.
 * @returns {object} `resource`.
 * @private
 */
function setWebGPUStarCubeMap(resource, texture, view) {
  resource.backend = "webgpu";
  if (!defined(texture) || !defined(view)) {
    return clearStarCubeMapResource(resource);
  }
  resource.available = true;
  resource.faceSize = texture.width ?? 0;
  resource.webglCubeMap = undefined;
  resource.webgpuTexture = texture;
  resource.webgpuTextureView = view;
  return resource;
}

export {
  createStarCubeMapResource,
  clearStarCubeMapResource,
  setWebGLStarCubeMap,
  setWebGPUStarCubeMap,
};
// Default export REQUIRED by the generated barrel: `packages/engine/index.js`
// is produced by `scripts/build.js`, which emits `export { default as X }`
// for every `Source/**/*.js` with no exclusion mechanism, so a named-exports-
// only module fails `npx gulp build` with "No matching export ... for import
// default". `npx tsc --noEmit` does NOT catch it (it never checks the
// generated barrel) — a gulp build is the only gate for this class.
export default createStarCubeMapResource;
