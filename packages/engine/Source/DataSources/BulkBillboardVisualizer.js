import AssociativeArray from "../Core/AssociativeArray.js";
import BoundingRectangle from "../Core/BoundingRectangle.js";
import Cartesian2 from "../Core/Cartesian2.js";
import Cartesian3 from "../Core/Cartesian3.js";
import Color from "../Core/Color.js";
import defined from "../Core/defined.js";
import destroyObject from "../Core/destroyObject.js";
import DeveloperError from "../Core/DeveloperError.js";
import DistanceDisplayCondition from "../Core/DistanceDisplayCondition.js";
import NearFarScalar from "../Core/NearFarScalar.js";
import BillboardCollection from "../Scene/BillboardCollection.js";
import HeightReference from "../Scene/HeightReference.js";
import HorizontalOrigin from "../Scene/HorizontalOrigin.js";
import SplitDirection from "../Scene/SplitDirection.js";
import VerticalOrigin from "../Scene/VerticalOrigin.js";
import BillboardVisualizer from "./BillboardVisualizer.js";
import BoundingSphereState from "./BoundingSphereState.js";
import Property from "./Property.js";

const defaultColor = Color.WHITE;
const defaultEyeOffset = Cartesian3.ZERO;
const defaultPixelOffset = Cartesian2.ZERO;
const defaultScale = 1.0;
const defaultRotation = 0.0;
const defaultAlignedAxis = Cartesian3.ZERO;
const defaultHorizontalOrigin = HorizontalOrigin.CENTER;
const defaultVerticalOrigin = VerticalOrigin.CENTER;
const defaultSizeInMeters = false;
const defaultSplitDirection = SplitDirection.NONE;

const colorScratch = new Color();
const eyeOffsetScratch = new Cartesian3();
const pixelOffsetScratch = new Cartesian2();
const scaleByDistanceScratch = new NearFarScalar();
const translucencyByDistanceScratch = new NearFarScalar();
const pixelOffsetScaleByDistanceScratch = new NearFarScalar();
const boundingRectangleScratch = new BoundingRectangle();
const distanceDisplayConditionScratch = new DistanceDisplayCondition();

/**
 * Returns true if the entity's `billboard` graphic can be represented by a
 * single, write-once entry in a flat-buffer {@link BillboardCollection} — i.e.
 * it never needs to be re-evaluated per frame.
 *
 * The fast path requires:
 *  - the entity has no time-varying availability (static lifetime),
 *  - every consumed BillboardGraphics property is constant (or undefined),
 *  - the position is constant,
 *  - height reference resolves to NONE (terrain-clamped billboards need the
 *    per-frame clamp path, which is inherently dynamic).
 *
 * Note: the async image load (`BillboardTexture` ready-state) is NOT a reason
 * to reject the fast path. The image is bound once at write time and the
 * collection's own per-frame `update()` finishes the upload a few frames later;
 * the static slot stays put and simply starts rendering when ready.
 *
 * @param {Entity} entity
 * @returns {boolean}
 * @private
 */
function isStaticBillboardEntity(entity) {
  if (defined(entity._availability)) {
    return false;
  }

  const billboard = entity._billboard;
  if (!defined(billboard) || !defined(entity._position)) {
    return false;
  }

  if (!Property.isConstant(entity._position)) {
    return false;
  }

  // A non-constant heightReference (or a constant one resolving to anything but
  // NONE) requires the per-frame clamp path.
  const heightReference = billboard._heightReference;
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
    Property.isConstant(billboard._show) &&
    Property.isConstant(billboard._image) &&
    Property.isConstant(billboard._imageSubRegion) &&
    Property.isConstant(billboard._color) &&
    Property.isConstant(billboard._eyeOffset) &&
    Property.isConstant(billboard._pixelOffset) &&
    Property.isConstant(billboard._scale) &&
    Property.isConstant(billboard._rotation) &&
    Property.isConstant(billboard._alignedAxis) &&
    Property.isConstant(billboard._horizontalOrigin) &&
    Property.isConstant(billboard._verticalOrigin) &&
    Property.isConstant(billboard._width) &&
    Property.isConstant(billboard._height) &&
    Property.isConstant(billboard._scaleByDistance) &&
    Property.isConstant(billboard._translucencyByDistance) &&
    Property.isConstant(billboard._pixelOffsetScaleByDistance) &&
    Property.isConstant(billboard._sizeInMeters) &&
    Property.isConstant(billboard._distanceDisplayCondition) &&
    Property.isConstant(billboard._disableDepthTestDistance) &&
    Property.isConstant(billboard._splitDirection)
  );
}

/**
 * Reads the (constant) BillboardGraphics property values for an entity and
 * applies them to the provided {@link Billboard} (creating the options bag for
 * a fresh `add`, or re-syncing an existing primitive after a definition change).
 * @private
 */
function applyBillboardOptions(billboard, entity, time) {
  const graphics = entity._billboard;

  const position = Property.getValueOrUndefined(
    entity._position,
    time,
    new Cartesian3(),
  );
  const image = Property.getValueOrUndefined(graphics._image, time);
  const show =
    entity.isShowing &&
    Property.getValueOrDefault(graphics._show, time, true) &&
    defined(position) &&
    defined(image);

  billboard.show = show;
  if (defined(position)) {
    billboard.position = position;
  }
  billboard.color = Color.clone(
    Property.getValueOrDefault(
      graphics._color,
      time,
      defaultColor,
      colorScratch,
    ),
  );
  billboard.eyeOffset = Property.getValueOrDefault(
    graphics._eyeOffset,
    time,
    defaultEyeOffset,
    eyeOffsetScratch,
  );
  billboard.heightReference = HeightReference.NONE;
  billboard.pixelOffset = Property.getValueOrDefault(
    graphics._pixelOffset,
    time,
    defaultPixelOffset,
    pixelOffsetScratch,
  );
  billboard.scale = Property.getValueOrDefault(
    graphics._scale,
    time,
    defaultScale,
  );
  billboard.rotation = Property.getValueOrDefault(
    graphics._rotation,
    time,
    defaultRotation,
  );
  billboard.alignedAxis = Property.getValueOrDefault(
    graphics._alignedAxis,
    time,
    defaultAlignedAxis,
  );
  billboard.horizontalOrigin = Property.getValueOrDefault(
    graphics._horizontalOrigin,
    time,
    defaultHorizontalOrigin,
  );
  billboard.verticalOrigin = Property.getValueOrDefault(
    graphics._verticalOrigin,
    time,
    defaultVerticalOrigin,
  );
  billboard.width = Property.getValueOrUndefined(graphics._width, time);
  billboard.height = Property.getValueOrUndefined(graphics._height, time);
  billboard.scaleByDistance = Property.getValueOrUndefined(
    graphics._scaleByDistance,
    time,
    scaleByDistanceScratch,
  );
  if (defined(billboard.scaleByDistance)) {
    billboard.scaleByDistance = NearFarScalar.clone(billboard.scaleByDistance);
  }
  billboard.translucencyByDistance = Property.getValueOrUndefined(
    graphics._translucencyByDistance,
    time,
    translucencyByDistanceScratch,
  );
  if (defined(billboard.translucencyByDistance)) {
    billboard.translucencyByDistance = NearFarScalar.clone(
      billboard.translucencyByDistance,
    );
  }
  billboard.pixelOffsetScaleByDistance = Property.getValueOrUndefined(
    graphics._pixelOffsetScaleByDistance,
    time,
    pixelOffsetScaleByDistanceScratch,
  );
  if (defined(billboard.pixelOffsetScaleByDistance)) {
    billboard.pixelOffsetScaleByDistance = NearFarScalar.clone(
      billboard.pixelOffsetScaleByDistance,
    );
  }
  billboard.sizeInMeters = Property.getValueOrDefault(
    graphics._sizeInMeters,
    time,
    defaultSizeInMeters,
  );
  billboard.distanceDisplayCondition = Property.getValueOrUndefined(
    graphics._distanceDisplayCondition,
    time,
    distanceDisplayConditionScratch,
  );
  if (defined(billboard.distanceDisplayCondition)) {
    billboard.distanceDisplayCondition = DistanceDisplayCondition.clone(
      billboard.distanceDisplayCondition,
    );
  }
  billboard.disableDepthTestDistance = Property.getValueOrUndefined(
    graphics._disableDepthTestDistance,
    time,
  );
  billboard.splitDirection = Property.getValueOrDefault(
    graphics._splitDirection,
    time,
    defaultSplitDirection,
  );

  billboard._sortPriority = entity._renderPriority ?? 0;

  // Apply .image last so any sizing properties are available before the texture
  // is added to the atlas. The async load completes a few frames later; the
  // static slot stays and binds on ready (no per-frame re-read needed).
  if (defined(image)) {
    billboard.image = image;

    const subRegion = Property.getValueOrUndefined(
      graphics._imageSubRegion,
      time,
      boundingRectangleScratch,
    );
    if (defined(subRegion)) {
      billboard.setImageSubRegion(billboard.image, subRegion);
    }
  }
}

/**
 * A {@link Visualizer} which maps {@link Entity#billboard} to a {@link Billboard},
 * with a bulk fast path for large homogeneous catalogs of *static* billboards
 * (e.g. tens of thousands of `billboard` entities ingested from CZML/GeoJSON).
 *
 * Static billboard entities — every consumed property is constant, no terrain
 * clamping, no time-varying availability — are written **once** into a flat-buffer
 * {@link BillboardCollection} and are then skipped entirely by the per-frame
 * update loop. The dominant per-frame cost of the legacy path (re-reading ~20
 * `Property.getValueOrDefault` values per entity every frame, even when nothing
 * is dynamic) is eliminated for that majority.
 *
 * The async image load is tolerated: the image is bound at write time and the
 * collection's own per-frame `update()` finishes the texture upload a few frames
 * later, at which point the static slot renders — no re-classification or
 * per-frame property re-read is required.
 *
 * Entities that are NOT statically representable — dynamic / sampled properties,
 * terrain-clamped (`heightReference`), time-windowed availability, or any entity
 * while clustering is enabled — transparently fall back to a wrapped
 * {@link BillboardVisualizer}, so their behavior is byte-identical to the legacy
 * path.
 *
 * The Entity API is fully preserved: `scene.pick` over a fast-pathed billboard
 * returns the originating {@link Entity} (the `Billboard.id` is set to the
 * entity), and {@link DataSourceDisplay#getBoundingSphere} resolves correctly.
 *
 * @alias BulkBillboardVisualizer
 * @constructor
 *
 * @param {EntityCluster} entityCluster The entity cluster (clustering, when
 *        enabled, forces the legacy fallback path).
 * @param {EntityCollection} entityCollection The entityCollection to visualize.
 * @param {PrimitiveCollection} primitives The primitive collection the bulk
 *        flat-buffer collection is added to (the DataSource's own primitives).
 */
class BulkBillboardVisualizer {
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

    // Flat-buffer collection that holds the static fast-pathed billboards.
    // Created LAZILY on the first static-lane add (see _ensureCollection) so a
    // data source with zero static billboards pays no BillboardCollection
    // allocation at all — see the 2026-06-20 bulk-vs-legacy perf benchmark
    // (eager setup_delta +2-4ms at n=1 rising to +22-43ms at n=2000).
    this._collection = undefined;

    // entity.id -> { entity, billboard } for fast-pathed (static) entities.
    this._staticItems = new AssociativeArray();
    // Entities currently delegated to the wrapped legacy visualizer.
    this._fallbackEntities = new AssociativeArray();

    this._fallback = new BillboardVisualizer(entityCluster, entityCollection);
    // The legacy visualizer subscribes to collectionChanged and, in its
    // constructor, has already populated its `_items` with EVERY billboard
    // entity. We instead drive it explicitly so each entity is owned by exactly
    // one lane. Detach its auto-subscription and clear the items it pre-seeded;
    // classification below re-adds only the entities that belong in the fallback
    // lane.
    entityCollection.collectionChanged.removeEventListener(
      BillboardVisualizer.prototype._onCollectionChanged,
      this._fallback,
    );
    this._fallback._items.removeAll();

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

    // Static fast-pathed billboards need no per-frame work — they were written
    // once (the collection's own update() finishes any async image upload).
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
    if (defined(item) && defined(item.billboard)) {
      result.center = Cartesian3.clone(item.billboard.position, result.center);
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
   * means a data source with no static billboards never allocates one.
   * @private
   */
  _ensureCollection() {
    if (!defined(this._collection)) {
      this._collection = this._primitives.add(new BillboardCollection());
    }
    return this._collection;
  }

  /**
   * Adds an entity to the static fast-buffer collection.
   * @private
   */
  _addStatic(entity, time) {
    const billboard = this._ensureCollection().add({ id: entity });
    applyBillboardOptions(billboard, entity, time);
    this._staticItems.set(entity.id, { entity, billboard });
  }

  /** @private */
  _removeStatic(entity) {
    const item = this._staticItems.get(entity.id);
    if (defined(item)) {
      if (
        defined(item.billboard) &&
        defined(this._collection) &&
        !this._collection.isDestroyed()
      ) {
        this._collection.remove(item.billboard);
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
    const billboard = entity._billboard;
    const hasBillboard = defined(billboard) && defined(entity._position);

    // Clustering re-positions/merges primitives every frame, so the static fast
    // path is invalid while it is enabled — route everything to the legacy path
    // (which owns the cluster collections).
    const clusteringEnabled = this._cluster.enabled === true;

    if (hasBillboard && !clusteringEnabled && isStaticBillboardEntity(entity)) {
      // Belongs in the fast lane.
      this._removeFallback(entity);
      if (this._staticItems.contains(entity.id)) {
        // Re-sync in place after a definition change.
        const item = this._staticItems.get(entity.id);
        applyBillboardOptions(item.billboard, entity, undefined);
      } else {
        this._addStatic(entity, undefined);
      }
      return;
    }

    // Belongs in the fallback lane (dynamic, clamped, time-windowed, or
    // clustering-enabled) — or the entity no longer has a billboard graphic.
    this._removeStatic(entity);
    if (hasBillboard) {
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

export default BulkBillboardVisualizer;
