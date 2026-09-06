import defined from "../../Core/defined.js";
import SceneMode from "../../Scene/SceneMode.js";

/**
 * Mode-appropriate bounding volumes for the WebGPU classification commands
 * (ground primitives, standalone classification primitives, ground polylines).
 *
 * A classification command without a bounding volume is not merely un-culled.
 * `View.createPotentiallyVisibleSet` takes the no-bounding-volume branch
 * (`Scene/View.js:374-388`), assigns the command the camera's whole
 * `[frustum.near, frustum.far]` range, and folds that range into the scene
 * near/far accumulators that `updateFrustums` divides into slices — so the
 * command both lands in every slice AND grows the slice count. In SCENE2D the
 * divisor is `scene.nearToFarDistance2D` (`Scene/View.js:575-583`), so a
 * missing volume there turns one slice into `ceil(cameraHeight / 1.75e6)` of
 * them and the classification blends once per slice.
 *
 * The two WebGL scene files this mirrors select from two different shapes:
 *
 * - A `GroundPrimitive` owns mode-partitioned volume arrays built by its own
 *   `createBoundingVolume` — `_boundingVolumes` (world-space
 *   `OrientedBoundingBox`) and `_boundingVolumes2D` (a `BoundingSphere` whose
 *   center is swizzled into the `(height, projX, projY)` 2D frame). WebGL's
 *   selection is the two-way `if/else` at `Scene/GroundPrimitive.js:925-930`:
 *   SCENE3D reads the first array, every other mode reads the second.
 * - A directly constructed `ClassificationPrimitive` and a
 *   `GroundPolylinePrimitive` have neither field. Their volumes live on the
 *   inner `Primitive` as the four arrays `Primitive._updateBoundingVolumes`
 *   maintains, and WebGL's selection is the four-way chain shared by
 *   `Scene/ClassificationPrimitive.js:1336-1348` and
 *   `Scene/GroundPolylinePrimitive.js:862-874`.
 *
 * Both shapes are resolved here so one renderer-side call serves all three
 * command producers, and so the WebGPU selection cannot drift from the WebGL
 * selection one file at a time.
 *
 * @private
 */

/**
 * The first entry of a bounding-volume array, or `undefined` when the array is
 * absent or empty.
 *
 * `scene3DOnly` leaves `_boundingVolumes2D` allocated but empty, and a
 * primitive whose geometry has not combined yet has empty sphere arrays, so an
 * existence check on the array alone would hand a caller `undefined` dressed
 * up as a volume.
 *
 * @param {Array} [volumes] A bounding-volume array.
 * @returns {object|undefined} The first volume, if there is one.
 * @private
 */
function firstVolume(volumes) {
  return defined(volumes) && volumes.length > 0 ? volumes[0] : undefined;
}

/**
 * The `GroundPrimitive` selection: `Scene/GroundPrimitive.js:925-930`.
 *
 * @param {object} primitive The primitive the feature renderer was handed.
 * @param {number} sceneMode The active {@link SceneMode}.
 * @returns {object|undefined} The mode's volume, if the primitive has one.
 * @private
 */
function selectGroundPrimitiveVolume(primitive, sceneMode) {
  return firstVolume(
    sceneMode === SceneMode.SCENE3D
      ? primitive._boundingVolumes
      : primitive._boundingVolumes2D,
  );
}

/**
 * The inner-`Primitive` selection shared by `ClassificationPrimitive` and
 * `GroundPolylinePrimitive` (`:1336-1348` and `:862-874` respectively).
 *
 * The SCENE2D leg falls through to the morph spheres when the 2D array is
 * EMPTY, where WebGL's chain instead tests `defined(primitive._boundingSphere2D)`
 * on the array itself — always true, since `Primitive.js:272-276` allocates all
 * four. The two are observably identical: the 2D and morph spheres are written
 * under one `!frameState.scene3DOnly` guard at the same indices
 * (`PrimitiveCommandHelpers.js:369-378`), so an empty 2D array implies an empty
 * morph array and both selections yield `undefined`. The fall-through is the
 * safer shape should that ever stop holding.
 *
 * @param {object} primitive The primitive the feature renderer was handed.
 * @param {number} sceneMode The active {@link SceneMode}.
 * @returns {object|undefined} The mode's bounding sphere, if there is one.
 * @private
 */
function selectInnerPrimitiveSphere(primitive, sceneMode) {
  const inner = primitive._primitive;
  if (!defined(inner)) {
    return undefined;
  }
  if (sceneMode === SceneMode.SCENE3D) {
    return firstVolume(inner._boundingSphereWC);
  }
  if (sceneMode === SceneMode.COLUMBUS_VIEW) {
    return firstVolume(inner._boundingSphereCV);
  }
  if (sceneMode === SceneMode.SCENE2D) {
    const sphere2D = firstVolume(inner._boundingSphere2D);
    if (defined(sphere2D)) {
      return sphere2D;
    }
  }
  return firstVolume(inner._boundingSphereMorph);
}

/**
 * Selects the bounding volume a WebGPU classification command must carry in
 * the active scene mode, matching what the WebGL queue path would put on the
 * equivalent command.
 *
 * Returns `undefined` only when the primitive genuinely has no volume for the
 * mode yet (geometry still combining, or `scene3DOnly` with a non-3D mode that
 * cannot occur). Callers pair the result with `cull: defined(volume)` so an
 * absent volume keeps the historical full-range, no-cull behaviour rather than
 * culling against nothing.
 *
 * @param {object} [primitive] The `GroundPrimitive`, `ClassificationPrimitive`
 *   or `GroundPolylinePrimitive` the feature renderer was handed.
 * @param {number} sceneMode The active {@link SceneMode}.
 * @returns {object|undefined} The bounding volume for this mode.
 * @private
 */
function selectClassificationBoundingVolume(primitive, sceneMode) {
  if (!defined(primitive)) {
    return undefined;
  }
  return (
    selectGroundPrimitiveVolume(primitive, sceneMode) ??
    selectInnerPrimitiveSphere(primitive, sceneMode)
  );
}

export { selectClassificationBoundingVolume };
export default { selectClassificationBoundingVolume };
