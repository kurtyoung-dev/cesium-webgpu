/**
 * The render mode of a {@link CloudCollection} — mutually exclusive.
 *
 * <p><code>BILLBOARD</code> (the default) renders the collection's clouds as the
 * classic cumulus-style billboards on both the WebGL and WebGPU renderers.</p>
 *
 * <p><code>VOLUMETRIC</code> instead drives the WebGPU full-screen ray-marched
 * volumetric cloud deck from this collection's <code>.volumetric</code> config,
 * and <b>suppresses this collection's billboards</b>. It is <b>WebGPU only</b>;
 * on the WebGL renderer a <code>VOLUMETRIC</code> collection stores the mode but
 * renders nothing extra (documented graceful no-op — see FORK_OVERVIEW
 * principle 10). Only one <code>VOLUMETRIC</code> collection is primary per
 * frame in the first cut (see migration_doc/CLOUD_UNIFICATION_DESIGN.md §7 Q1).</p>
 *
 * @enum {number}
 */
const CloudRenderMode = {
  /**
   * Render the collection's clouds as cumulus-style billboards (the default,
   * both backends).
   * @type {number}
   * @constant
   */
  BILLBOARD: 0,

  /**
   * Drive the WebGPU volumetric ray-marched cloud deck from this collection's
   * <code>.volumetric</code> config and suppress this collection's billboards.
   * WebGPU only; a documented no-op on WebGL.
   * @type {number}
   * @constant
   */
  VOLUMETRIC: 1,
};

/**
 * Validates that the provided render mode is a valid {@link CloudRenderMode}.
 *
 * @param {CloudRenderMode} cloudRenderMode The render mode to validate.
 * @returns {boolean} <code>true</code> if valid; otherwise <code>false</code>.
 */
CloudRenderMode.validate = function (cloudRenderMode) {
  return (
    cloudRenderMode === CloudRenderMode.BILLBOARD ||
    cloudRenderMode === CloudRenderMode.VOLUMETRIC
  );
};

export default Object.freeze(CloudRenderMode);
