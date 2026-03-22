/**
 * Determines how draw commands within a render layer are sorted.
 *
 * Sort modes control the ordering strategy applied to commands within
 * a specific render layer. Different content types benefit from different
 * strategies — terrain is best sorted by material (batching), labels
 * by priority (manual), and transparent objects by distance.
 *
 * @enum {number}
 * @see RenderLayer
 * @see RenderScheduler
 */
const SortMode = {
  /**
   * No sorting. Commands render in the order they were added.
   * Use for content where order doesn't matter or is pre-sorted.
   * @type {number}
   * @constant
   */
  NONE: 0,

  /**
   * Sort by user-assigned priority (sortPriority). Lower values render first.
   * Use for UI elements, labels, or any content with explicit ordering.
   * @type {number}
   * @constant
   */
  MANUAL: 1,

  /**
   * Sort by material/shader ID first, then by distance.
   * Minimizes GPU state changes (shader swaps, texture rebinds).
   * Best for opaque geometry with many different materials.
   *
   * Sort order: materialSortId ASC → distance ASC (front-to-back)
   * @type {number}
   * @constant
   */
  MATERIAL_MESH: 2,

  /**
   * Sort by distance, front-to-back. Maximizes early-Z rejection.
   * Use when occlusion culling matters more than state-change batching.
   *
   * For opaque objects in scenes with heavy overdraw.
   * @type {number}
   * @constant
   */
  FRONT_TO_BACK: 3,

  /**
   * Sort by distance, back-to-front. Required for correct alpha blending.
   * Use for transparent objects when OIT is not available.
   * @type {number}
   * @constant
   */
  BACK_TO_FRONT: 4,

  /**
   * User-provided custom comparator function.
   * The comparator is set via {@link RenderLayer#customSort}.
   * @type {number}
   * @constant
   */
  CUSTOM: 5,
};

export default Object.freeze(SortMode);
