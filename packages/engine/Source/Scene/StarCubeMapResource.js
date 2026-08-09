// StarCubeMapResource.js — samplable star texture.
//
// A backend-neutral handle to the star cube map that {@link SkyBox} already
// loads, so code outside the sky box can sample it instead of only drawing it.
// The cube map is the one celestial signal in this engine that is a texture
// rather than a sprite pass, which makes it the only celestial source a
// reflection shader can look up in a single fetch.
//
// Nothing samples it yet, and that is the point: this module exists so that a
// celestial water reflection has a star texture to read at all. `StarField`
// draws un-samplable point sprites and `ProceduralSkyCubemap.wgsl` carries the
// atmosphere only, so a `sampleStarField()` in a reflection shader would
// otherwise have no source. Deleting it because no shader reads it removes the
// only remaining half of that seam.
//
// Current readers: `Scene/CubeMapPanorama.js` (producer),
// `Scene/SkyBox.js` (re-exposes it), `frameState.starCubeMap` (publication).
//
// What a consumer needs to know:
//
// 1. Frame. The lookup direction is TEME / inertial, not Earth-fixed — both
//    backends apply `temeToPseudoFixed` on the way to clip space
//    (`SkyBoxVS.glsl` on WebGL; `panoramaTransform` on WebGPU), so the texture
//    itself is stored in the inertial frame. A reflection shader working in
//    world/eye space must rotate its sample direction by
//    `temeToPseudoFixed^-1` (or bake the rotation into a matrix uniform, as
//    the star sprites do).
//
// 2. Content. Under the default `SkyBox.Variant.TYCHO_T5_DIFFUSE` the cube
//    map carries the diffuse galactic band and nothing else; every resolved
//    star lives in the `StarField` sprite catalogue instead. A reflection that
//    samples only this texture therefore shows the Milky Way on the water and
//    no individual stars, which is a design consequence rather than a bug.
//    `SkyBox.variant` reports which map is loaded; `SkyBox.Variant.TYCHO_T5`
//    is the un-blurred set that does carry baked stars, and is the choice a
//    "moon and stars by night" reflection has to make.
//
// 3. Timing. Both backends load the six faces asynchronously. `available` is
//    false until they land, and it can go false again when `sources` are
//    replaced or the owning object is destroyed. Read it every frame; never
//    cache the raw handle across frames.
//
// 4. Ownership. The handles below are borrowed. `CubeMapPanorama` (WebGL) and
//    the WebGPU feature renderer's per-instance state own the underlying
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
// Default export required by the generated barrel: `packages/engine/index.js`
// is produced by `scripts/build.js`, which emits `export { default as X }`
// for every `Source/**/*.js` with no exclusion mechanism, so a named-exports-
// only module fails `npx gulp build` with "No matching export ... for import
// default". `npx tsc --noEmit` does not catch it, because it never checks the
// generated barrel — a gulp build is the only gate for this class of defect.
export default createStarCubeMapResource;
