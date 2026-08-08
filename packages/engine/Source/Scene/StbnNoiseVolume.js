import Check from "../Core/Check.js";
import Resource from "../Core/Resource.js";
import buildModuleUrl from "../Core/buildModuleUrl.js";

/**
 * Import seam for the bundled spatiotemporal blue-noise (STBN) mask.
 *
 * The asset is a scalar 128x128x64 mask generated in-repo by
 * <code>Tools/stbn-bake/bake-stbn.mjs</code> and shipped as a 1024x1024 8-bit
 * greyscale PNG holding an 8x8 grid of 128x128 tiles, one tile per temporal
 * slice. It has no third party: it is computed from published algorithms
 * (Ulichney 1993 void-and-cluster; Georgiev and Fajardo 2016 pairwise energy;
 * the separable spatiotemporal criterion of Wolfe et al. 2022), certified
 * against the published spectral characterisation by
 * <code>Tools/visual-regression/stbn-asset.spec.mjs</code>, and therefore
 * carries no entry in <code>LICENSE.md</code>'s third-party sections. See
 * <code>Tools/stbn-bake/README.md</code>.
 *
 * <p>
 * SCOPE — this module is the ASSET SEAM ONLY, and it has no consumer yet.
 * Campaign-13 row <code>C13-11</code> has two halves: generation and import
 * (this, plus the tool and the spec), and the stochastic cloud-jitter
 * consumption that replaces the ordered 4x4 Bayer sub-pixel jitter and the
 * analytic interleaved-gradient ray phase in
 * <code>Shaders/WebGPU/Environment/ProceduralClouds.wgsl</code> with taps into
 * this mask. That second half is deliberately NOT wired here — it needs a new
 * bind-group entry, a texture upload, a <code>qualityFlags</code> gate and a
 * loading fallback, and doing it inside the generation batch would have landed
 * shader changes no probe had measured. Per CLAUDE.md principle 7 this file is
 * scaffolding for that follow-up, not dead code; per principle 9 the follow-up
 * is filed rather than silently deferred.
 * </p>
 *
 * @namespace StbnNoiseVolume
 *
 * @private
 */
const StbnNoiseVolume = {};

/**
 * Width of one temporal slice, in texels. Both spatial axes are toroidal, so
 * the mask tiles across the screen with no seam.
 * @type {number}
 * @constant
 */
StbnNoiseVolume.WIDTH = 128;

/**
 * Height of one temporal slice, in texels.
 * @type {number}
 * @constant
 */
StbnNoiseVolume.HEIGHT = 128;

/**
 * Number of temporal slices. The time axis is toroidal too, so a frame counter
 * may be reduced modulo this value without introducing a discontinuity. 64 was
 * chosen to match the existing 64-phase golden-ratio frame rotation in the
 * procedural-cloud ray phase, so the consuming change can keep its frame
 * bookkeeping and swap only the sampling.
 * @type {number}
 * @constant
 */
StbnNoiseVolume.FRAMES = 64;

/**
 * Tiles per atlas row.
 * @type {number}
 * @constant
 */
StbnNoiseVolume.ATLAS_COLUMNS = 8;

/**
 * Tiles per atlas column.
 * @type {number}
 * @constant
 */
StbnNoiseVolume.ATLAS_ROWS = 8;

/**
 * SHA-256 of the bundled PNG, mirroring
 * <code>Tools/stbn-bake/stbn-manifest.json</code>. It is pinned here so that
 * replacing the asset without re-running the bake is caught by
 * <code>stbn-asset.spec.mjs</code>, which compares this constant, the
 * manifest, and the bytes on disk against each other.
 * @type {string}
 * @constant
 */
StbnNoiseVolume.SHA256 =
  "8dd44e0b07bc69dea20955f67d9b9f78c0cf51a4f59b771b9eb3e7936cb2d579";

/**
 * Package-relative path of the bundled atlas.
 * @type {string}
 * @constant
 */
StbnNoiseVolume.ASSET_PATH = "Assets/Textures/Noise/stbn_scalar_128x128x64.png";

/**
 * The absolute URL of the bundled atlas.
 *
 * @returns {string} the URL
 */
StbnNoiseVolume.getUrl = function () {
  return buildModuleUrl(StbnNoiseVolume.ASSET_PATH);
};

/**
 * Texel coordinates of the top-left corner of one temporal slice within the
 * atlas.
 *
 * Slice <code>t</code> occupies tile <code>(t % ATLAS_COLUMNS, floor(t /
 * ATLAS_COLUMNS))</code> with the origin at the top left. The consuming shader
 * will do the same arithmetic on the GPU; this exists so the JS side, the
 * spec, and any diagnostic that wants to dump a slice all agree with it.
 *
 * @param {number} frame frame index; reduced modulo {@link StbnNoiseVolume.FRAMES}
 * @returns {number[]} the <code>[x, y]</code> texel offset of the slice
 */
StbnNoiseVolume.getSliceOffset = function (frame) {
  //>>includeStart('debug', pragmas.debug);
  Check.typeOf.number("frame", frame);
  //>>includeEnd('debug');

  const t =
    ((frame % StbnNoiseVolume.FRAMES) + StbnNoiseVolume.FRAMES) %
    StbnNoiseVolume.FRAMES;
  return [
    (t % StbnNoiseVolume.ATLAS_COLUMNS) * StbnNoiseVolume.WIDTH,
    Math.floor(t / StbnNoiseVolume.ATLAS_COLUMNS) * StbnNoiseVolume.HEIGHT,
  ];
};

let loadPromise;

/**
 * Fetch and decode the atlas, once per page.
 *
 * The decode options are load-bearing rather than stylistic. This image is
 * DATA, not a picture: <code>skipColorSpaceConversion</code> stops a browser
 * from applying a display transform that would remap the mask's values, and
 * <code>flipY: false</code> keeps the tile layout above true. Uploading the
 * result with an sRGB texture format, or with premultiplied alpha, would
 * likewise corrupt it — the consuming change must use an unorm format and
 * <code>textureLoad</code> with no sampler, so no filtering blends across a
 * tile boundary into the neighbouring temporal slice.
 *
 * @returns {Promise<ImageBitmap|HTMLImageElement>} the decoded atlas
 */
StbnNoiseVolume.load = function () {
  if (!loadPromise) {
    loadPromise = Resource.fetchImage({
      url: StbnNoiseVolume.getUrl(),
      preferImageBitmap: true,
      flipY: false,
      skipColorSpaceConversion: true,
    });
  }
  return loadPromise;
};

export default Object.freeze(StbnNoiseVolume);
