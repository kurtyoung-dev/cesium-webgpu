import defined from "../Core/defined.js";
import DeveloperError from "../Core/DeveloperError.js";
import Cesium3DTileContentState from "./Cesium3DTileContentState.js";
import ProducerListenerAdapter from "./ProducerListenerAdapter.js";
import TilePathEncoding from "./TilePathEncoding.js";
import { createTilePathResolver } from "./TilePathResolver.js";

/**
 * Coordinator for the 3D Tiles live invalidation feed.
 *
 * Owns a reference to a parent {@link Cesium3DTileset}, a list of layer
 * names this feed cares about, a pluggable
 * {@link Cesium3DTilesInvalidationFeedAdapter} that converts producer-format
 * payloads into normalized {@link InvalidationSet} arrays, and a
 * {@link TilePathResolver} selected by the {@link TilePathEncoding} option
 * that parses per-entry path strings and walks the in-memory tile tree.
 *
 * Each tileset can have its own feed with its own encoding, so multiple
 * tilesets in the same scene can simultaneously stream invalidations from
 * different producers that disagree on path format.
 *
 * Triggering mechanism:
 *   - Walk the tileset tree via the resolver to find matched tiles.
 *   - Trigger the existing zero-flicker swap by setting
 *     <code>tile._expiredContent = tile._content</code> and flipping
 *     <code>_contentState</code> to <code>EXPIRED</code> — mirrors
 *     {@link Cesium3DTile#updateExpiration} (Cesium3DTile.js ~1067-1080
 *     and ~2154-2185).
 *   - Bump <code>scene._snapshotVersion</code> so the snapshot/locked-orbit
 *     subsystem discards cached render bundles.
 *
 * Network polling is OUT OF SCOPE for Phase 1 — see {@link #poll}.
 *
 * @alias Cesium3DTilesInvalidationFeed
 * @constructor
 * @private
 *
 * @param {Cesium3DTileset} tileset Parent tileset.
 * @param {object} options
 * @param {import("./Cesium3DTilesInvalidationFeedAdapter.js").default} options.adapter
 * @param {string[]} options.layers Layer names this feed listens for.
 * @param {string} [options.pathEncoding] A {@link TilePathEncoding} value;
 *   defaults to {@link TilePathEncoding.CHILD_INDEX}.
 * @param {Scene} [options.scene]
 */
class Cesium3DTilesInvalidationFeed {
  constructor(tileset, options) {
    if (!defined(tileset)) {
      throw new DeveloperError("tileset is required.");
    }
    if (!defined(options) || !defined(options.adapter)) {
      throw new DeveloperError("options.adapter is required.");
    }
    if (!defined(options.layers) || !Array.isArray(options.layers)) {
      throw new DeveloperError(
        "options.layers must be an array of layer names.",
      );
    }

    this._tileset = tileset;
    this._adapter = options.adapter;
    // Normalize configured layer names — strip trailing slash so comparisons
    // against adapter-normalized names (also without slash) always succeed.
    this._layers = new Set(
      options.layers.map((name) => stripTrailingSlash(name)),
    );
    this._scene = options.scene;

    this._pathEncoding = options.pathEncoding ?? TilePathEncoding.CHILD_INDEX;
    this._resolver = createTilePathResolver(this._pathEncoding);

    // Diagnostics.
    this._appliedCount = 0;
    this._lastAffectedTileCount = 0;
    this._totalApplied = 0;
    this._totalSkipped = 0;
    this._tilesetJsonRequests = 0;
    this._lastApplyMs = 0;
  }

  setScene(scene) {
    this._scene = scene;
  }

  /**
   * Convenience: parse a raw payload (which may contain many blocks) then
   * apply every resulting set.
   * @param {string|ArrayBuffer} payload
   * @returns {number} Total tiles affected across all sets.
   */
  parseAndApply(payload) {
    const sets = this._adapter.parse(payload);
    if (!defined(sets) || sets.length === 0) {
      return 0;
    }
    return this.applyAll(sets);
  }

  /**
   * Apply every set in an array. Returns the sum of affected tiles.
   * @param {import("./Cesium3DTilesInvalidationFeedAdapter.js").InvalidationSet[]} sets
   * @returns {number}
   */
  applyAll(sets) {
    if (!defined(sets) || sets.length === 0) {
      return 0;
    }
    let total = 0;
    for (let i = 0; i < sets.length; ++i) {
      total += this.apply(sets[i]);
    }
    return total;
  }

  /**
   * Apply a single normalized invalidation set.
   * @param {import("./Cesium3DTilesInvalidationFeedAdapter.js").InvalidationSet} set
   * @returns {number}
   */
  apply(set) {
    const t0 =
      typeof performance !== "undefined" &&
      typeof performance.now === "function"
        ? performance.now()
        : 0;

    this._lastAffectedTileCount = 0;
    if (!defined(set) || !defined(set.layers)) {
      this._lastApplyMs =
        typeof performance !== "undefined" &&
        typeof performance.now === "function"
          ? performance.now() - t0
          : 0;
      return 0;
    }

    const root = this._tileset._root;
    if (!defined(root)) {
      this._lastApplyMs =
        typeof performance !== "undefined" &&
        typeof performance.now === "function"
          ? performance.now() - t0
          : 0;
      return 0;
    }

    let affected = 0;
    const listenedLayers = this._layers;
    const resolver = this._resolver;

    set.layers.forEach((layer, name) => {
      const normalized = stripTrailingSlash(name);
      if (!listenedLayers.has(normalized)) {
        return;
      }
      const entries = layer.entries;
      for (let i = 0; i < entries.length; ++i) {
        const entry = entries[i];

        if (entry.tilesetJson === true) {
          console.log(
            `[InvalidationFeed] tileset.json refetch requested for layer ${normalized} — Phase 2`,
          );
          this._tilesetJsonRequests++;
          continue;
        }

        let parsed;
        try {
          parsed = resolver.parsePath(entry.rawPath);
        } catch (err) {
          this._totalSkipped++;
          console.warn(
            `[InvalidationFeed] resolver failed to parse "${entry.rawPath}" (${this._pathEncoding}): ${err.message}`,
          );
          continue;
        }

        const tiles = resolver.resolve(root, parsed, entry.kind);
        if (!defined(tiles) || tiles.length === 0) {
          this._totalSkipped++;
          continue;
        }

        for (let t = 0; t < tiles.length; ++t) {
          if (invalidateTile(tiles[t])) {
            affected++;
            this._totalApplied++;
          } else {
            this._totalSkipped++;
          }
        }
      }
    });

    this._lastAffectedTileCount = affected;
    this._appliedCount++;

    if (affected > 0 && defined(this._scene)) {
      this._scene._snapshotVersion = (this._scene._snapshotVersion ?? 0) + 1;
    }

    this._lastApplyMs =
      typeof performance !== "undefined" &&
      typeof performance.now === "function"
        ? performance.now() - t0
        : 0;
    return affected;
  }

  /**
   * Diagnostic snapshot.
   * @returns {{totalApplied: number, totalSkipped: number, tilesetJsonRequests: number, lastApplyMs: number}}
   */
  getDiagnostics() {
    return {
      totalApplied: this._totalApplied,
      totalSkipped: this._totalSkipped,
      tilesetJsonRequests: this._tilesetJsonRequests,
      lastApplyMs: this._lastApplyMs,
    };
  }

  poll(url, intervalMs) {
    throw new DeveloperError(
      "Cesium3DTilesInvalidationFeed.poll: network polling lands in invalidation feed Phase 2.",
    );
  }

  getAuthHeaders() {
    // TODO Phase 2: integrate with IonResource token plumbing.
    return {};
  }

  get tileset() {
    return this._tileset;
  }

  get adapter() {
    return this._adapter;
  }

  get layers() {
    return Array.from(this._layers);
  }

  get pathEncoding() {
    return this._pathEncoding;
  }

  get lastAffectedTileCount() {
    return this._lastAffectedTileCount;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripTrailingSlash(name) {
  if (typeof name !== "string" || name.length === 0) {
    return name;
  }
  if (name.charCodeAt(name.length - 1) === 47 /* '/' */) {
    return name.slice(0, -1);
  }
  return name;
}

/**
 * Trigger the existing _expiredContent zero-flicker swap on a single tile.
 * Mirrors {@link Cesium3DTile#updateExpiration}. Skips tiles with multiple
 * contents — the existing expiration path at Cesium3DTile.js line 2158 does
 * the same.
 * @private
 */
function invalidateTile(tile) {
  if (!defined(tile)) {
    return false;
  }
  if (tile.hasMultipleContents) {
    return false;
  }
  if (!tile.contentReady) {
    tile._contentState = Cesium3DTileContentState.EXPIRED;
    return true;
  }
  tile._expiredContent = tile._content;
  tile._contentState = Cesium3DTileContentState.EXPIRED;
  return true;
}

// ---------------------------------------------------------------------------
// Adapter registry (A2)
// ---------------------------------------------------------------------------

/** @type {Map<string, () => import("./Cesium3DTilesInvalidationFeedAdapter.js").default>} */
const adapterRegistry = new Map();

Cesium3DTilesInvalidationFeed.registerAdapter = function (formatId, factory) {
  if (typeof formatId !== "string" || formatId.length === 0) {
    throw new DeveloperError("formatId must be a non-empty string.");
  }
  if (typeof factory !== "function") {
    throw new DeveloperError("factory must be a function.");
  }
  adapterRegistry.set(formatId, factory);
};

Cesium3DTilesInvalidationFeed.fromFormat = function (
  formatId,
  tileset,
  options,
) {
  const factory = adapterRegistry.get(formatId);
  if (!defined(factory)) {
    throw new DeveloperError(
      `No invalidation feed adapter registered for format "${formatId}".`,
    );
  }
  const merged = Object.assign({}, options ?? {}, { adapter: factory() });
  return new Cesium3DTilesInvalidationFeed(tileset, merged);
};

// First-party registration: producer listener v2.0.
Cesium3DTilesInvalidationFeed.registerAdapter(
  "producer-listener-v2.0",
  () => new ProducerListenerAdapter(),
);

export default Cesium3DTilesInvalidationFeed;
