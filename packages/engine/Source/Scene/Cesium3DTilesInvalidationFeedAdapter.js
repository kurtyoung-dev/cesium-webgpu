import DeveloperError from "../Core/DeveloperError.js";

/**
 * @typedef {object} InvalidationEntry
 * @property {("exact"|"subtree")} kind  Wildcard semantic produced by the
 *   adapter. <code>"exact"</code> means invalidate just the tile addressed
 *   by <code>rawPath</code>; <code>"subtree"</code> means invalidate that
 *   tile and every in-memory descendant.
 * @property {string} rawPath The tile identifier as it appeared in the feed,
 *   with the layer prefix and any wildcard suffix ("*", ".*") already
 *   stripped. The feed's {@link TilePathResolver} parses this into a
 *   concrete address during {@link Cesium3DTilesInvalidationFeed#apply} —
 *   adapters NEVER pre-parse path segments, because a given feed instance
 *   may be configured with any of the four supported encodings.
 * @property {boolean} tilesetJson True when the resource was
 *   <code>{layer}/tileset.json</code>, meaning the tileset root should be
 *   re-fetched. Phase 1 logs and skips; Phase 2 will perform the re-fetch.
 */

/**
 * @typedef {object} InvalidationLayer
 * @property {string} name Layer name, trailing slash already stripped (e.g.
 *   <code>"terrain"</code>, <code>"objects-collision"</code>).
 * @property {InvalidationEntry[]} entries
 */

/**
 * @typedef {object} InvalidationSet
 * @property {string} id Stable identifier for the block — either the
 *   producer-supplied <code>id</code> field, or a synthesized FNV-1a digest
 *   of the canonicalized block prefixed with <code>"sha:"</code>.
 * @property {string} generatedAt ISO-8601 timestamp when the producer
 *   supplies one, otherwise a synthesized <code>"file:&lt;mtime&gt;+&lt;idx&gt;"</code>
 *   tag (or <code>new Date().toISOString()</code> when no mtime is known).
 * @property {string} version Feed version string the adapter parsed
 *   (e.g. <code>"2.0"</code>).
 * @property {Map<string, InvalidationLayer>} layers Keyed by normalized
 *   layer name (no trailing slash).
 * @property {number} sourceBlockIndex 0-based index of this block within the
 *   source payload. Useful for debug logging when a single file contains
 *   many blocks.
 */

/**
 * Abstract adapter contract for the 3D Tiles live invalidation feed.
 *
 * Implementations parse a producer-specific feed format into an array of
 * normalized {@link InvalidationSet} objects — one per logical "block" in
 * the source payload (the producer feed is append-only, so a single file
 * typically contains many blocks). The {@link Cesium3DTilesInvalidationFeed}
 * coordinator applies each set independently.
 *
 * Adapters are pluggable so the coordinator stays format-agnostic. New
 * producer formats register a concrete subclass with the adapter registry
 * exposed by {@link Cesium3DTilesInvalidationFeed}.
 *
 * @interface
 * @private
 */
function Cesium3DTilesInvalidationFeedAdapter() {}

/**
 * Parse a raw feed payload into an array of normalized invalidation sets.
 * One input payload may produce any number of sets — the producer feed is
 * append-only and a single file typically contains many blocks separated by
 * <code>new invalidation:</code> headers.
 *
 * @param {string|ArrayBuffer} payload Raw feed contents.
 * @param {object} [perCallOptions] Optional per-call overrides (e.g.
 *   <code>sourceMtime</code>, <code>sourceUrl</code>).
 * @returns {InvalidationSet[]} Parsed sets. Empty array when the payload
 *   is recognised but contained no invalidation blocks.
 */
Cesium3DTilesInvalidationFeedAdapter.prototype.parse = function (
  payload,
  perCallOptions,
) {
  throw new DeveloperError(
    "Cesium3DTilesInvalidationFeedAdapter.parse must be implemented by a subclass.",
  );
};

Object.defineProperties(Cesium3DTilesInvalidationFeedAdapter.prototype, {
  /**
   * Stable identifier used for diagnostics and registry lookup, e.g.
   * <code>"producer-listener-v2.0"</code>.
   * @memberof Cesium3DTilesInvalidationFeedAdapter.prototype
   * @type {string}
   * @readonly
   */
  formatId: {
    get: function () {
      throw new DeveloperError(
        "Cesium3DTilesInvalidationFeedAdapter.formatId must be implemented by a subclass.",
      );
    },
  },
});

export default Cesium3DTilesInvalidationFeedAdapter;
