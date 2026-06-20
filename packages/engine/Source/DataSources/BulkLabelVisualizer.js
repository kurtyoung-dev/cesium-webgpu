import AssociativeArray from "../Core/AssociativeArray.js";
import Cartesian2 from "../Core/Cartesian2.js";
import Cartesian3 from "../Core/Cartesian3.js";
import Color from "../Core/Color.js";
import defined from "../Core/defined.js";
import destroyObject from "../Core/destroyObject.js";
import DeveloperError from "../Core/DeveloperError.js";
import DistanceDisplayCondition from "../Core/DistanceDisplayCondition.js";
import NearFarScalar from "../Core/NearFarScalar.js";
import HeightReference from "../Scene/HeightReference.js";
import HorizontalOrigin from "../Scene/HorizontalOrigin.js";
import LabelCollection from "../Scene/LabelCollection.js";
import LabelStyle from "../Scene/LabelStyle.js";
import VerticalOrigin from "../Scene/VerticalOrigin.js";
import BoundingSphereState from "./BoundingSphereState.js";
import LabelVisualizer from "./LabelVisualizer.js";
import Property from "./Property.js";

const defaultScale = 1.0;
const defaultFont = "30px sans-serif";
const defaultStyle = LabelStyle.FILL;
const defaultFillColor = Color.WHITE;
const defaultOutlineColor = Color.BLACK;
const defaultOutlineWidth = 1.0;
const defaultShowBackground = false;
const defaultBackgroundColor = new Color(0.165, 0.165, 0.165, 0.8);
const defaultBackgroundPadding = new Cartesian2(7, 5);
const defaultPixelOffset = Cartesian2.ZERO;
const defaultEyeOffset = Cartesian3.ZERO;
const defaultHorizontalOrigin = HorizontalOrigin.CENTER;
const defaultVerticalOrigin = VerticalOrigin.CENTER;

const fillColorScratch = new Color();
const outlineColorScratch = new Color();
const backgroundColorScratch = new Color();
const backgroundPaddingScratch = new Cartesian2();
const eyeOffsetScratch = new Cartesian3();
const pixelOffsetScratch = new Cartesian2();
const translucencyByDistanceScratch = new NearFarScalar();
const pixelOffsetScaleByDistanceScratch = new NearFarScalar();
const scaleByDistanceScratch = new NearFarScalar();
const distanceDisplayConditionScratch = new DistanceDisplayCondition();

/**
 * Returns true if the entity's `label` graphic can be represented by a single,
 * write-once entry in a flat-buffer {@link LabelCollection} — i.e. it never
 * needs to be re-evaluated per frame.
 *
 * The fast path requires:
 *  - the entity has no time-varying availability (static lifetime),
 *  - every consumed LabelGraphics property is constant (or undefined),
 *  - the position is constant,
 *  - height reference resolves to NONE (terrain-clamped labels need the
 *    per-frame clamp path, which is inherently dynamic).
 *
 * Note: the async glyph-atlas build is NOT a reason to reject the fast path.
 * The text is bound once at write time and the collection's own per-frame
 * `update()` maps the glyphs a few frames later; the static slot stays put and
 * simply starts rendering when ready.
 *
 * @param {Entity} entity
 * @returns {boolean}
 * @private
 */
function isStaticLabelEntity(entity) {
  if (defined(entity._availability)) {
    return false;
  }

  const label = entity._label;
  if (!defined(label) || !defined(entity._position)) {
    return false;
  }

  if (!Property.isConstant(entity._position)) {
    return false;
  }

  // A non-constant heightReference (or a constant one resolving to anything but
  // NONE) requires the per-frame clamp path.
  const heightReference = label._heightReference;
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
    Property.isConstant(label._show) &&
    Property.isConstant(label._text) &&
    Property.isConstant(label._scale) &&
    Property.isConstant(label._font) &&
    Property.isConstant(label._style) &&
    Property.isConstant(label._fillColor) &&
    Property.isConstant(label._outlineColor) &&
    Property.isConstant(label._outlineWidth) &&
    Property.isConstant(label._showBackground) &&
    Property.isConstant(label._backgroundColor) &&
    Property.isConstant(label._backgroundPadding) &&
    Property.isConstant(label._pixelOffset) &&
    Property.isConstant(label._eyeOffset) &&
    Property.isConstant(label._horizontalOrigin) &&
    Property.isConstant(label._verticalOrigin) &&
    Property.isConstant(label._translucencyByDistance) &&
    Property.isConstant(label._pixelOffsetScaleByDistance) &&
    Property.isConstant(label._scaleByDistance) &&
    Property.isConstant(label._distanceDisplayCondition) &&
    Property.isConstant(label._disableDepthTestDistance)
  );
}

/**
 * Reads the (constant) LabelGraphics property values for an entity and applies
 * them to the provided {@link Label} (for a fresh `add` or a re-sync after a
 * definition change).
 * @private
 */
function applyLabelOptions(label, entity, time) {
  const graphics = entity._label;

  const position = Property.getValueOrUndefined(
    entity._position,
    time,
    new Cartesian3(),
  );
  const text = Property.getValueOrUndefined(graphics._text, time);
  const show =
    entity.isShowing &&
    Property.getValueOrDefault(graphics._show, time, true) &&
    defined(position) &&
    defined(text);

  label.show = show;
  if (defined(position)) {
    label.position = position;
  }
  if (defined(text)) {
    label.text = text;
  }
  label.scale = Property.getValueOrDefault(graphics._scale, time, defaultScale);
  label.font = Property.getValueOrDefault(graphics._font, time, defaultFont);
  label.style = Property.getValueOrDefault(graphics._style, time, defaultStyle);
  label.fillColor = Property.getValueOrDefault(
    graphics._fillColor,
    time,
    defaultFillColor,
    fillColorScratch,
  );
  label.outlineColor = Property.getValueOrDefault(
    graphics._outlineColor,
    time,
    defaultOutlineColor,
    outlineColorScratch,
  );
  label.outlineWidth = Property.getValueOrDefault(
    graphics._outlineWidth,
    time,
    defaultOutlineWidth,
  );
  label.showBackground = Property.getValueOrDefault(
    graphics._showBackground,
    time,
    defaultShowBackground,
  );
  label.backgroundColor = Property.getValueOrDefault(
    graphics._backgroundColor,
    time,
    defaultBackgroundColor,
    backgroundColorScratch,
  );
  label.backgroundPadding = Property.getValueOrDefault(
    graphics._backgroundPadding,
    time,
    defaultBackgroundPadding,
    backgroundPaddingScratch,
  );
  label.pixelOffset = Property.getValueOrDefault(
    graphics._pixelOffset,
    time,
    defaultPixelOffset,
    pixelOffsetScratch,
  );
  label.eyeOffset = Property.getValueOrDefault(
    graphics._eyeOffset,
    time,
    defaultEyeOffset,
    eyeOffsetScratch,
  );
  label.heightReference = HeightReference.NONE;
  label.horizontalOrigin = Property.getValueOrDefault(
    graphics._horizontalOrigin,
    time,
    defaultHorizontalOrigin,
  );
  label.verticalOrigin = Property.getValueOrDefault(
    graphics._verticalOrigin,
    time,
    defaultVerticalOrigin,
  );
  label.translucencyByDistance = Property.getValueOrUndefined(
    graphics._translucencyByDistance,
    time,
    translucencyByDistanceScratch,
  );
  if (defined(label.translucencyByDistance)) {
    label.translucencyByDistance = NearFarScalar.clone(
      label.translucencyByDistance,
    );
  }
  label.pixelOffsetScaleByDistance = Property.getValueOrUndefined(
    graphics._pixelOffsetScaleByDistance,
    time,
    pixelOffsetScaleByDistanceScratch,
  );
  if (defined(label.pixelOffsetScaleByDistance)) {
    label.pixelOffsetScaleByDistance = NearFarScalar.clone(
      label.pixelOffsetScaleByDistance,
    );
  }
  label.scaleByDistance = Property.getValueOrUndefined(
    graphics._scaleByDistance,
    time,
    scaleByDistanceScratch,
  );
  if (defined(label.scaleByDistance)) {
    label.scaleByDistance = NearFarScalar.clone(label.scaleByDistance);
  }
  label.distanceDisplayCondition = Property.getValueOrUndefined(
    graphics._distanceDisplayCondition,
    time,
    distanceDisplayConditionScratch,
  );
  if (defined(label.distanceDisplayCondition)) {
    label.distanceDisplayCondition = DistanceDisplayCondition.clone(
      label.distanceDisplayCondition,
    );
  }
  label.disableDepthTestDistance = Property.getValueOrUndefined(
    graphics._disableDepthTestDistance,
    time,
  );
}

/**
 * A {@link Visualizer} which maps {@link Entity#label} to a {@link Label}, with
 * a bulk fast path for large homogeneous catalogs of *static* labels (e.g. tens
 * of thousands of `label` entities ingested from CZML/GeoJSON).
 *
 * Static label entities — every consumed property is constant, no terrain
 * clamping, no time-varying availability — are written **once** into a flat-buffer
 * {@link LabelCollection} and are then skipped entirely by the per-frame update
 * loop. The dominant per-frame cost of the legacy path (re-reading ~25
 * `Property.getValueOrDefault` values per entity every frame, even when nothing
 * is dynamic) is eliminated for that majority.
 *
 * The async glyph-atlas build is tolerated: the text is bound at write time and
 * the collection's own per-frame `update()` maps the glyphs a few frames later,
 * at which point the static slot renders — no re-classification or per-frame
 * property re-read is required.
 *
 * Entities that are NOT statically representable — dynamic / sampled properties,
 * terrain-clamped (`heightReference`), time-windowed availability, or any entity
 * while clustering is enabled — transparently fall back to a wrapped
 * {@link LabelVisualizer}, so their behavior is byte-identical to the legacy path.
 *
 * The Entity API is fully preserved: `scene.pick` over a fast-pathed label
 * returns the originating {@link Entity} (the `Label.id` is set to the entity),
 * and {@link DataSourceDisplay#getBoundingSphere} resolves correctly.
 *
 * @alias BulkLabelVisualizer
 * @constructor
 *
 * @param {EntityCluster} entityCluster The entity cluster (clustering, when
 *        enabled, forces the legacy fallback path).
 * @param {EntityCollection} entityCollection The entityCollection to visualize.
 * @param {PrimitiveCollection} primitives The primitive collection the bulk
 *        flat-buffer collection is added to (the DataSource's own primitives).
 */
class BulkLabelVisualizer {
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

    // Flat-buffer collection that holds the static fast-pathed labels.
    this._collection = primitives.add(new LabelCollection());

    // entity.id -> { entity, label } for fast-pathed (static) entities.
    this._staticItems = new AssociativeArray();
    // Entities currently delegated to the wrapped legacy visualizer.
    this._fallbackEntities = new AssociativeArray();

    this._fallback = new LabelVisualizer(entityCluster, entityCollection);
    // The legacy visualizer subscribes to collectionChanged and, in its
    // constructor, has already populated its `_items` with EVERY label entity.
    // We instead drive it explicitly so each entity is owned by exactly one lane.
    // Detach its auto-subscription and clear the items it pre-seeded;
    // classification below re-adds only the entities that belong in the fallback
    // lane.
    entityCollection.collectionChanged.removeEventListener(
      LabelVisualizer.prototype._onCollectionChanged,
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

    // Static fast-pathed labels need no per-frame work — they were written once
    // (the collection's own update() finishes any async glyph mapping). Only the
    // (typically small) set of dynamic / clamped entities is updated, by the
    // wrapped legacy visualizer.
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
    if (defined(item) && defined(item.label)) {
      result.center = Cartesian3.clone(item.label.position, result.center);
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
   * Adds an entity to the static fast-buffer collection.
   * @private
   */
  _addStatic(entity, time) {
    const label = this._collection.add({ id: entity });
    applyLabelOptions(label, entity, time);
    this._staticItems.set(entity.id, { entity, label });
  }

  /** @private */
  _removeStatic(entity) {
    const item = this._staticItems.get(entity.id);
    if (defined(item)) {
      if (defined(item.label) && !this._collection.isDestroyed()) {
        this._collection.remove(item.label);
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
    const label = entity._label;
    const hasLabel = defined(label) && defined(entity._position);

    // Clustering re-positions/merges primitives every frame, so the static fast
    // path is invalid while it is enabled — route everything to the legacy path
    // (which owns the cluster collections).
    const clusteringEnabled = this._cluster.enabled === true;

    if (hasLabel && !clusteringEnabled && isStaticLabelEntity(entity)) {
      // Belongs in the fast lane.
      this._removeFallback(entity);
      if (this._staticItems.contains(entity.id)) {
        // Re-sync in place after a definition change.
        const item = this._staticItems.get(entity.id);
        applyLabelOptions(item.label, entity, undefined);
      } else {
        this._addStatic(entity, undefined);
      }
      return;
    }

    // Belongs in the fallback lane (dynamic, clamped, time-windowed, or
    // clustering-enabled) — or the entity no longer has a label graphic.
    this._removeStatic(entity);
    if (hasLabel) {
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

export default BulkLabelVisualizer;
