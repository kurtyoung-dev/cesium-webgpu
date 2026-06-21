import AssociativeArray from "../Core/AssociativeArray.js";
import Cartesian3 from "../Core/Cartesian3.js";
import Color from "../Core/Color.js";
import defined from "../Core/defined.js";
import destroyObject from "../Core/destroyObject.js";
import DeveloperError from "../Core/DeveloperError.js";
import DistanceDisplayCondition from "../Core/DistanceDisplayCondition.js";
import NearFarScalar from "../Core/NearFarScalar.js";
import HeightReference from "../Scene/HeightReference.js";
import PointPrimitiveCollection from "../Scene/PointPrimitiveCollection.js";
import SplitDirection from "../Scene/SplitDirection.js";
import BoundingSphereState from "./BoundingSphereState.js";
import PointVisualizer from "./PointVisualizer.js";
import Property from "./Property.js";

const defaultColor = Color.WHITE;
const defaultOutlineColor = Color.BLACK;
const defaultOutlineWidth = 0.0;
const defaultPixelSize = 1.0;
const defaultDisableDepthTestDistance = 0.0;
const defaultSplitDirection = SplitDirection.NONE;

const colorScratch = new Color();
const outlineColorScratch = new Color();
const scaleByDistanceScratch = new NearFarScalar();
const translucencyByDistanceScratch = new NearFarScalar();
const distanceDisplayConditionScratch = new DistanceDisplayCondition();

/**
 * Returns true if the entity's `point` graphic can be represented by a single,
 * write-once entry in a flat-buffer {@link PointPrimitiveCollection} — i.e. it
 * never needs to be re-evaluated per frame.
 *
 * The fast path requires:
 *  - the entity has no time-varying availability (static lifetime),
 *  - every consumed PointGraphics property is constant (or undefined),
 *  - the position is constant,
 *  - height reference resolves to NONE (terrain-clamped points need the
 *    billboard-clamp path, which is inherently dynamic).
 *
 * @param {Entity} entity
 * @returns {boolean}
 * @private
 */
function isStaticPointEntity(entity) {
  if (defined(entity._availability)) {
    return false;
  }

  const point = entity._point;
  if (!defined(point) || !defined(entity._position)) {
    return false;
  }

  if (!Property.isConstant(entity._position)) {
    return false;
  }

  // A non-constant heightReference (or a constant one resolving to anything but
  // NONE) requires the per-frame billboard clamp path.
  const heightReference = point._heightReference;
  if (defined(heightReference)) {
    if (!Property.isConstant(heightReference)) {
      return false;
    }
    const value = heightReference.getValue(undefined);
    if (defined(value) && value !== HeightReference.NONE) {
      return false;
    }
  }

  return (
    Property.isConstant(point._show) &&
    Property.isConstant(point._color) &&
    Property.isConstant(point._outlineColor) &&
    Property.isConstant(point._outlineWidth) &&
    Property.isConstant(point._pixelSize) &&
    Property.isConstant(point._scaleByDistance) &&
    Property.isConstant(point._translucencyByDistance) &&
    Property.isConstant(point._distanceDisplayCondition) &&
    Property.isConstant(point._disableDepthTestDistance) &&
    Property.isConstant(point._splitDirection)
  );
}

/**
 * Reads the (constant) PointGraphics property values for an entity and pushes
 * them into the provided PointPrimitive options bag.
 * @private
 */
function readPointOptions(entity, time, options) {
  const point = entity._point;
  options.id = entity;
  options.show =
    entity.isShowing && Property.getValueOrDefault(point._show, time, true);
  options.position = Property.getValueOrUndefined(
    entity._position,
    time,
    new Cartesian3(),
  );
  options.color = Color.clone(
    Property.getValueOrDefault(point._color, time, defaultColor, colorScratch),
  );
  options.outlineColor = Color.clone(
    Property.getValueOrDefault(
      point._outlineColor,
      time,
      defaultOutlineColor,
      outlineColorScratch,
    ),
  );
  options.outlineWidth = Property.getValueOrDefault(
    point._outlineWidth,
    time,
    defaultOutlineWidth,
  );
  options.pixelSize = Property.getValueOrDefault(
    point._pixelSize,
    time,
    defaultPixelSize,
  );
  options.scaleByDistance = Property.getValueOrUndefined(
    point._scaleByDistance,
    time,
    scaleByDistanceScratch,
  );
  if (defined(options.scaleByDistance)) {
    options.scaleByDistance = NearFarScalar.clone(options.scaleByDistance);
  }
  options.translucencyByDistance = Property.getValueOrUndefined(
    point._translucencyByDistance,
    time,
    translucencyByDistanceScratch,
  );
  if (defined(options.translucencyByDistance)) {
    options.translucencyByDistance = NearFarScalar.clone(
      options.translucencyByDistance,
    );
  }
  options.distanceDisplayCondition = Property.getValueOrUndefined(
    point._distanceDisplayCondition,
    time,
    distanceDisplayConditionScratch,
  );
  if (defined(options.distanceDisplayCondition)) {
    options.distanceDisplayCondition = DistanceDisplayCondition.clone(
      options.distanceDisplayCondition,
    );
  }
  options.disableDepthTestDistance = Property.getValueOrDefault(
    point._disableDepthTestDistance,
    time,
    defaultDisableDepthTestDistance,
  );
  options.splitDirection = Property.getValueOrDefault(
    point._splitDirection,
    time,
    defaultSplitDirection,
  );
  return options;
}

/**
 * Pushes the already-computed options bag onto an existing {@link PointPrimitive}
 * (used when re-syncing a previously-fast-pathed entity after a definition
 * change).
 * @private
 */
function applyPointOptions(pointPrimitive, options) {
  pointPrimitive.show = defined(options.position) && options.show;
  if (defined(options.position)) {
    pointPrimitive.position = options.position;
  }
  pointPrimitive.color = options.color;
  pointPrimitive.outlineColor = options.outlineColor;
  pointPrimitive.outlineWidth = options.outlineWidth;
  pointPrimitive.pixelSize = options.pixelSize;
  pointPrimitive.scaleByDistance = options.scaleByDistance;
  pointPrimitive.translucencyByDistance = options.translucencyByDistance;
  pointPrimitive.distanceDisplayCondition = options.distanceDisplayCondition;
  pointPrimitive.disableDepthTestDistance = options.disableDepthTestDistance;
  pointPrimitive.splitDirection = options.splitDirection;
}

/**
 * A {@link Visualizer} which maps {@link Entity#point} to a {@link PointPrimitive},
 * with a bulk fast path for large homogeneous catalogs of *static* points
 * (e.g. tens of thousands of `point` entities ingested from CZML/GeoJSON).
 *
 * Static point entities — every consumed property is constant, no terrain
 * clamping, no time-varying availability — are written **once** into a flat-buffer
 * {@link PointPrimitiveCollection} (which already carries the partial-write
 * manager + WASM encode + WebGPU/WebGL feature renderers) and are then skipped
 * entirely by the per-frame update loop. The dominant per-frame cost of the
 * legacy path (re-reading ~10 `Property.getValueOrDefault` values per entity
 * every frame, even when nothing is dynamic) is eliminated for that majority.
 *
 * Entities that are NOT statically representable — dynamic / sampled properties,
 * terrain-clamped (`heightReference`), time-windowed availability, or any entity
 * while clustering is enabled — transparently fall back to a wrapped
 * {@link PointVisualizer}, so their behavior is byte-identical to the legacy path.
 *
 * The Entity API is fully preserved: `scene.pick` over a fast-pathed point
 * returns the originating {@link Entity} (the `PointPrimitive.id` is set to the
 * entity), and {@link DataSourceDisplay#getBoundingSphere} resolves correctly.
 *
 * @alias BulkPointVisualizer
 * @constructor
 *
 * @param {EntityCluster} entityCluster The entity cluster (clustering, when
 *        enabled, forces the legacy fallback path).
 * @param {EntityCollection} entityCollection The entityCollection to visualize.
 * @param {PrimitiveCollection} primitives The primitive collection the bulk
 *        flat-buffer collection is added to (the DataSource's own primitives).
 */
class BulkPointVisualizer {
  constructor(entityCluster, entityCollection, primitives) {
    //>>includeStart('debug', pragmas.debug);
    if (!defined(entityCluster)) {
      throw new DeveloperError("entityCluster is required.");
    }
    if (!defined(entityCollection)) {
      throw new DeveloperError("entityCollection is required.");
    }
    if (!defined(primitives)) {
      throw new DeveloperError("primitives is required.");
    }
    //>>includeEnd('debug');

    this._cluster = entityCluster;
    this._entityCollection = entityCollection;
    this._primitives = primitives;

    // Flat-buffer collection that holds the static fast-pathed points. Created
    // LAZILY on the first static-lane add (see _ensureCollection) so a data
    // source with zero static points pays no PointPrimitiveCollection allocation
    // (flat-buffer + WASM-encode + feature-renderer infra) at all. The eager
    // allocation cost setup at every entity count — see the 2026-06-20 bulk-vs-
    // legacy perf benchmark (setup_delta +2-4ms at n=1 rising to +22-43ms at
    // n=2000) — which dominated the (negligible) per-frame win at low counts.
    this._collection = undefined;

    // entity.id -> { entity, pointPrimitive } for fast-pathed (static) entities.
    this._staticItems = new AssociativeArray();
    // Entities currently delegated to the wrapped legacy visualizer.
    this._fallbackEntities = new AssociativeArray();

    this._fallback = new PointVisualizer(entityCluster, entityCollection);
    // The legacy visualizer subscribes to collectionChanged and, in its
    // constructor, has already populated its `_items` with EVERY point entity.
    // We instead drive it explicitly so each entity is owned by exactly one
    // lane. Detach its auto-subscription and clear the items it pre-seeded;
    // classification below re-adds only the entities that actually belong in
    // the fallback lane.
    entityCollection.collectionChanged.removeEventListener(
      PointVisualizer.prototype._onCollectionChanged,
      this._fallback,
    );
    this._fallback._items.removeAll();

    this._optionsScratch = {};

    entityCollection.collectionChanged.addEventListener(
      this._onCollectionChanged,
      this,
    );
    this._onCollectionChanged(
      entityCollection,
      entityCollection.values,
      [],
      [],
    );
  }

  /**
   * @param {JulianDate} time The time to update to.
   * @returns {boolean} Always true.
   */
  update(time) {
    //>>includeStart('debug', pragmas.debug);
    if (!defined(time)) {
      throw new DeveloperError("time is required.");
    }
    //>>includeEnd('debug');

    // Static fast-pathed points need no per-frame work — they were written once.
    // Only the (typically small) set of dynamic / clamped entities is updated,
    // by the wrapped legacy visualizer.
    return this._fallback.update(time);
  }

  getBoundingSphere(entity, result) {
    //>>includeStart('debug', pragmas.debug);
    if (!defined(entity)) {
      throw new DeveloperError("entity is required.");
    }
    if (!defined(result)) {
      throw new DeveloperError("result is required.");
    }
    //>>includeEnd('debug');

    const item = this._staticItems.get(entity.id);
    if (defined(item) && defined(item.pointPrimitive)) {
      result.center = Cartesian3.clone(
        item.pointPrimitive.position,
        result.center,
      );
      result.radius = 0;
      return BoundingSphereState.DONE;
    }

    return this._fallback.getBoundingSphere(entity, result);
  }

  isDestroyed() {
    return false;
  }

  destroy() {
    this._entityCollection.collectionChanged.removeEventListener(
      this._onCollectionChanged,
      this,
    );
    this._fallback.destroy();
    this._staticItems.removeAll();
    this._fallbackEntities.removeAll();
    if (defined(this._collection) && !this._collection.isDestroyed()) {
      this._primitives.remove(this._collection);
    }
    this._collection = undefined;
    return destroyObject(this);
  }

  /**
   * Lazily creates the flat-buffer collection on first use and adds it to the
   * data source's primitives. Deferring this until the first static entity
   * means a data source with no static points never allocates one.
   * @private
   */
  _ensureCollection() {
    if (!defined(this._collection)) {
      this._collection = this._primitives.add(new PointPrimitiveCollection());
    }
    return this._collection;
  }

  /**
   * Adds (or re-adds) an entity to the static fast-buffer collection.
   * @private
   */
  _addStatic(entity, time) {
    const options = readPointOptions(entity, time, this._optionsScratch);
    // PointPrimitiveCollection.add does not accept undefined position; clamp
    // show to false and use ZERO so the slot exists but is hidden if a static
    // entity ever has no resolvable position (shouldn't happen for constants).
    if (!defined(options.position)) {
      options.position = Cartesian3.clone(Cartesian3.ZERO);
      options.show = false;
    }
    const pointPrimitive = this._ensureCollection().add(options);
    this._staticItems.set(entity.id, { entity, pointPrimitive });
  }

  /** @private */
  _removeStatic(entity) {
    const item = this._staticItems.get(entity.id);
    if (defined(item)) {
      if (
        defined(item.pointPrimitive) &&
        defined(this._collection) &&
        !this._collection.isDestroyed()
      ) {
        this._collection.remove(item.pointPrimitive);
      }
      this._staticItems.remove(entity.id);
    }
  }

  /**
   * Routes an entity to the wrapped legacy visualizer by feeding it through that
   * visualizer's own collectionChanged handler as an "added" entity.
   * @private
   */
  _addFallback(entity) {
    if (this._fallbackEntities.contains(entity.id)) {
      return;
    }
    this._fallbackEntities.set(entity.id, entity);
    this._fallback._onCollectionChanged(
      this._entityCollection,
      [entity],
      [],
      [],
    );
  }

  /** @private */
  _removeFallback(entity) {
    if (!this._fallbackEntities.contains(entity.id)) {
      return;
    }
    this._fallbackEntities.remove(entity.id);
    this._fallback._onCollectionChanged(
      this._entityCollection,
      [],
      [entity],
      [],
    );
  }

  /**
   * Decides which lane an entity belongs in and (re)places it there.
   * @private
   */
  _classify(entity) {
    const point = entity._point;
    const hasPoint = defined(point) && defined(entity._position);

    // Clustering re-positions/merges primitives every frame, so the static
    // fast path is invalid while it is enabled — route everything to the legacy
    // path (which owns the cluster collections).
    const clusteringEnabled = this._cluster.enabled === true;

    if (hasPoint && !clusteringEnabled && isStaticPointEntity(entity)) {
      // Belongs in the fast lane.
      this._removeFallback(entity);
      if (this._staticItems.contains(entity.id)) {
        // Re-sync in place after a definition change.
        const item = this._staticItems.get(entity.id);
        const options = readPointOptions(
          entity,
          undefined,
          this._optionsScratch,
        );
        applyPointOptions(item.pointPrimitive, options);
      } else {
        this._addStatic(entity, undefined);
      }
      return;
    }

    // Belongs in the fallback lane (dynamic, clamped, time-windowed, or
    // clustering-enabled) — or the entity no longer has a point graphic at all.
    this._removeStatic(entity);
    if (hasPoint) {
      this._addFallback(entity);
    } else {
      this._removeFallback(entity);
    }
  }

  /** @private */
  _onCollectionChanged(entityCollection, added, removed, changed) {
    let i;
    let entity;

    for (i = added.length - 1; i > -1; i--) {
      this._classify(added[i]);
    }

    for (i = changed.length - 1; i > -1; i--) {
      this._classify(changed[i]);
    }

    for (i = removed.length - 1; i > -1; i--) {
      entity = removed[i];
      this._removeStatic(entity);
      this._removeFallback(entity);
    }
  }

  /**
   * Number of entities currently rendered through the bulk (write-once) fast
   * path. Exposed for instrumentation / probes.
   * @type {number}
   * @readonly
   */
  get staticCount() {
    return this._staticItems.length;
  }

  /**
   * Number of entities currently delegated to the per-frame legacy path.
   * @type {number}
   * @readonly
   */
  get fallbackCount() {
    return this._fallbackEntities.length;
  }
}

export default BulkPointVisualizer;
