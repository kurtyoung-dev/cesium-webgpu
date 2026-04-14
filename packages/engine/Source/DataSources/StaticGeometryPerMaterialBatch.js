import AssociativeArray from "../Core/AssociativeArray.js";
import Cartesian3 from "../Core/Cartesian3.js";
import Color from "../Core/Color.js";
import ColorGeometryInstanceAttribute from "../Core/ColorGeometryInstanceAttribute.js";
import defined from "../Core/defined.js";
import DistanceDisplayCondition from "../Core/DistanceDisplayCondition.js";
import DistanceDisplayConditionGeometryInstanceAttribute from "../Core/DistanceDisplayConditionGeometryInstanceAttribute.js";
import OffsetGeometryInstanceAttribute from "../Core/OffsetGeometryInstanceAttribute.js";
import ShowGeometryInstanceAttribute from "../Core/ShowGeometryInstanceAttribute.js";
import Primitive from "../Scene/Primitive.js";
import BoundingSphereState from "./BoundingSphereState.js";
import ColorMaterialProperty from "./ColorMaterialProperty.js";
import MaterialProperty from "./MaterialProperty.js";
import Property from "./Property.js";

const distanceDisplayConditionScratch = new DistanceDisplayCondition();
const defaultDistanceDisplayCondition = new DistanceDisplayCondition();
const defaultOffset = Cartesian3.ZERO;
const offsetScratch = new Cartesian3();
const colorScratch = new Color();

class Batch {
  constructor(
    primitives,
    appearanceType,
    materialProperty,
    depthFailAppearanceType,
    depthFailMaterialProperty,
    closed,
    shadows,
    renderPriority,
  ) {
    this.primitives = primitives;
    this.appearanceType = appearanceType;
    this.materialProperty = materialProperty;
    this.depthFailAppearanceType = depthFailAppearanceType;
    this.depthFailMaterialProperty = depthFailMaterialProperty;
    this.closed = closed;
    this.shadows = shadows;
    this.renderPriority = renderPriority ?? 0;
    this.updaters = new AssociativeArray();
    this.createPrimitive = true;
    this.primitive = undefined;
    this.oldPrimitive = undefined;
    this.geometry = new AssociativeArray();
    this.material = undefined;
    this.depthFailMaterial = undefined;
    this.updatersWithAttributes = new AssociativeArray();
    this.attributes = new AssociativeArray();
    this.invalidated = false;
    this.removeMaterialSubscription =
      materialProperty.definitionChanged.addEventListener(
        Batch.prototype.onMaterialChanged,
        this,
      );
    this.subscriptions = new AssociativeArray();
    this.showsUpdated = new AssociativeArray();
  }

  onMaterialChanged() {
    this.invalidated = true;
  }

  isMaterial(updater) {
    // Priority-aware matching: entities with different renderPriority go in different batches
    const updaterPriority = updater.entity._renderPriority ?? 0;
    if (this.renderPriority !== updaterPriority) {
      return false;
    }
    const material = this.materialProperty;
    const updaterMaterial = updater.fillMaterialProperty;
    const depthFailMaterial = this.depthFailMaterialProperty;
    const updaterDepthFailMaterial = updater.depthFailMaterialProperty;

    if (
      updaterMaterial === material &&
      updaterDepthFailMaterial === depthFailMaterial
    ) {
      return true;
    }
    let equals = defined(material) && material.equals(updaterMaterial);
    equals =
      ((!defined(depthFailMaterial) && !defined(updaterDepthFailMaterial)) ||
        (defined(depthFailMaterial) &&
          depthFailMaterial.equals(updaterDepthFailMaterial))) &&
      equals;
    return equals;
  }

  add(time, updater) {
    const id = updater.id;
    this.updaters.set(id, updater);
    this.geometry.set(id, updater.createFillGeometryInstance(time));
    if (
      !updater.hasConstantFill ||
      !updater.fillMaterialProperty.isConstant ||
      !Property.isConstant(updater.distanceDisplayConditionProperty) ||
      !Property.isConstant(updater.terrainOffsetProperty)
    ) {
      this.updatersWithAttributes.set(id, updater);
    } else {
      const that = this;
      this.subscriptions.set(
        id,
        updater.entity.definitionChanged.addEventListener(
          function (entity, propertyName, newValue, oldValue) {
            if (propertyName === "isShowing") {
              that.showsUpdated.set(updater.id, updater);
            }
          },
        ),
      );
    }
    this.createPrimitive = true;
  }

  remove(updater) {
    const id = updater.id;
    this.createPrimitive = this.geometry.remove(id) || this.createPrimitive;
    if (this.updaters.remove(id)) {
      this.updatersWithAttributes.remove(id);
      const unsubscribe = this.subscriptions.get(id);
      if (defined(unsubscribe)) {
        unsubscribe();
        this.subscriptions.remove(id);
        this.showsUpdated.remove(id);
      }
      return true;
    }
    return false;
  }

  update(time) {
    let isUpdated = true;
    let primitive = this.primitive;
    const primitives = this.primitives;
    const geometries = this.geometry.values;
    let i;

    if (this.createPrimitive) {
      const geometriesLength = geometries.length;
      if (geometriesLength > 0) {
        if (defined(primitive)) {
          if (!defined(this.oldPrimitive)) {
            this.oldPrimitive = primitive;
          } else {
            primitives.remove(primitive);
          }
        }

        this.material = MaterialProperty.getValue(
          time,
          this.materialProperty,
          this.material,
        );

        let depthFailAppearance;
        if (defined(this.depthFailMaterialProperty)) {
          this.depthFailMaterial = MaterialProperty.getValue(
            time,
            this.depthFailMaterialProperty,
            this.depthFailMaterial,
          );
          const DepthFailAppearanceType = this.depthFailAppearanceType;
          depthFailAppearance = new DepthFailAppearanceType({
            material: this.depthFailMaterial,
            translucent: this.depthFailMaterial.isTranslucent(),
            closed: this.closed,
          });
        }

        const AppearanceType = this.appearanceType;
        primitive = new Primitive({
          show: false,
          asynchronous: true,
          geometryInstances: geometries.slice(),
          appearance: new AppearanceType({
            material: this.material,
            translucent: this.material.isTranslucent(),
            closed: this.closed,
          }),
          depthFailAppearance: depthFailAppearance,
          shadows: this.shadows,
        });
        // Flow render priority from batch to primitive for sort system integration
        if (this.renderPriority !== 0) {
          primitive.renderPriority = this.renderPriority;
        }

        primitives.add(primitive);
        isUpdated = false;
      } else {
        if (defined(primitive)) {
          primitives.remove(primitive);
          primitive = undefined;
        }
        const oldPrimitive = this.oldPrimitive;
        if (defined(oldPrimitive)) {
          primitives.remove(oldPrimitive);
          this.oldPrimitive = undefined;
        }
      }

      this.attributes.removeAll();
      this.primitive = primitive;
      this.createPrimitive = false;
    } else if (defined(primitive) && primitive.ready) {
      primitive.show = true;
      if (defined(this.oldPrimitive)) {
        primitives.remove(this.oldPrimitive);
        this.oldPrimitive = undefined;
      }

      this.material = MaterialProperty.getValue(
        time,
        this.materialProperty,
        this.material,
      );
      this.primitive.appearance.material = this.material;

      if (
        defined(this.depthFailAppearanceType) &&
        !(this.depthFailMaterialProperty instanceof ColorMaterialProperty)
      ) {
        this.depthFailMaterial = MaterialProperty.getValue(
          time,
          this.depthFailMaterialProperty,
          this.depthFailMaterial,
        );
        this.primitive.depthFailAppearance.material = this.depthFailMaterial;
      }

      const updatersWithAttributes = this.updatersWithAttributes.values;
      const length = updatersWithAttributes.length;
      for (i = 0; i < length; i++) {
        const updater = updatersWithAttributes[i];
        const entity = updater.entity;
        const instance = this.geometry.get(updater.id);

        let attributes = this.attributes.get(instance.id.id);
        if (!defined(attributes)) {
          attributes = primitive.getGeometryInstanceAttributes(instance.id);
          this.attributes.set(instance.id.id, attributes);
        }

        if (
          defined(this.depthFailAppearanceType) &&
          this.depthFailMaterialProperty instanceof ColorMaterialProperty &&
          !updater.depthFailMaterialProperty.isConstant
        ) {
          const depthFailColorProperty =
            updater.depthFailMaterialProperty.color;
          const depthFailColor = Property.getValueOrDefault(
            depthFailColorProperty,
            time,
            Color.WHITE,
            colorScratch,
          );
          if (!Color.equals(attributes._lastDepthFailColor, depthFailColor)) {
            attributes._lastDepthFailColor = Color.clone(
              depthFailColor,
              attributes._lastDepthFailColor,
            );
            attributes.depthFailColor = ColorGeometryInstanceAttribute.toValue(
              depthFailColor,
              attributes.depthFailColor,
            );
          }
        }

        const show =
          entity.isShowing &&
          (updater.hasConstantFill || updater.isFilled(time));
        const currentShow = attributes.show[0] === 1;
        if (show !== currentShow) {
          attributes.show = ShowGeometryInstanceAttribute.toValue(
            show,
            attributes.show,
          );
        }

        const distanceDisplayConditionProperty =
          updater.distanceDisplayConditionProperty;
        if (!Property.isConstant(distanceDisplayConditionProperty)) {
          const distanceDisplayCondition = Property.getValueOrDefault(
            distanceDisplayConditionProperty,
            time,
            defaultDistanceDisplayCondition,
            distanceDisplayConditionScratch,
          );
          if (
            !DistanceDisplayCondition.equals(
              distanceDisplayCondition,
              attributes._lastDistanceDisplayCondition,
            )
          ) {
            attributes._lastDistanceDisplayCondition =
              DistanceDisplayCondition.clone(
                distanceDisplayCondition,
                attributes._lastDistanceDisplayCondition,
              );
            attributes.distanceDisplayCondition =
              DistanceDisplayConditionGeometryInstanceAttribute.toValue(
                distanceDisplayCondition,
                attributes.distanceDisplayCondition,
              );
          }
        }

        const offsetProperty = updater.terrainOffsetProperty;
        if (!Property.isConstant(offsetProperty)) {
          const offset = Property.getValueOrDefault(
            offsetProperty,
            time,
            defaultOffset,
            offsetScratch,
          );
          if (!Cartesian3.equals(offset, attributes._lastOffset)) {
            attributes._lastOffset = Cartesian3.clone(
              offset,
              attributes._lastOffset,
            );
            attributes.offset = OffsetGeometryInstanceAttribute.toValue(
              offset,
              attributes.offset,
            );
          }
        }
      }

      this.updateShows(primitive);
    } else if (defined(primitive) && !primitive.ready) {
      isUpdated = false;
    }
    return isUpdated;
  }

  updateShows(primitive) {
    const showsUpdated = this.showsUpdated.values;
    const length = showsUpdated.length;
    for (let i = 0; i < length; i++) {
      const updater = showsUpdated[i];
      const entity = updater.entity;
      const instance = this.geometry.get(updater.id);

      let attributes = this.attributes.get(instance.id.id);
      if (!defined(attributes)) {
        attributes = primitive.getGeometryInstanceAttributes(instance.id);
        this.attributes.set(instance.id.id, attributes);
      }

      const show = entity.isShowing;
      const currentShow = attributes.show[0] === 1;
      if (show !== currentShow) {
        attributes.show = ShowGeometryInstanceAttribute.toValue(
          show,
          attributes.show,
        );
        instance.attributes.show.value[0] = attributes.show[0];
      }
    }
    this.showsUpdated.removeAll();
  }

  contains(updater) {
    return this.updaters.contains(updater.id);
  }

  getBoundingSphere(updater, result) {
    const primitive = this.primitive;
    if (!primitive.ready) {
      return BoundingSphereState.PENDING;
    }
    const attributes = primitive.getGeometryInstanceAttributes(updater.entity);
    if (
      !defined(attributes) ||
      !defined(attributes.boundingSphere) ||
      (defined(attributes.show) && attributes.show[0] === 0)
    ) {
      return BoundingSphereState.FAILED;
    }
    attributes.boundingSphere.clone(result);
    return BoundingSphereState.DONE;
  }

  destroy() {
    const primitive = this.primitive;
    const primitives = this.primitives;
    if (defined(primitive)) {
      primitives.remove(primitive);
    }
    const oldPrimitive = this.oldPrimitive;
    if (defined(oldPrimitive)) {
      primitives.remove(oldPrimitive);
    }
    this.removeMaterialSubscription();
  }
}

/**
 * @private
 */
class StaticGeometryPerMaterialBatch {
  constructor(
    primitives,
    appearanceType,
    depthFailAppearanceType,
    closed,
    shadows,
  ) {
    this._items = [];
    this._primitives = primitives;
    this._appearanceType = appearanceType;
    this._depthFailAppearanceType = depthFailAppearanceType;
    this._closed = closed;
    this._shadows = shadows;
  }

  add(time, updater) {
    const items = this._items;
    const length = items.length;
    for (let i = 0; i < length; i++) {
      const item = items[i];
      if (item.isMaterial(updater)) {
        item.add(time, updater);
        return;
      }
    }
    // Extract entity render priority for priority-aware batch grouping
    const entityPriority = updater.entity._renderPriority ?? 0;
    const batch = new Batch(
      this._primitives,
      this._appearanceType,
      updater.fillMaterialProperty,
      this._depthFailAppearanceType,
      updater.depthFailMaterialProperty,
      this._closed,
      this._shadows,
      entityPriority,
    );
    batch.add(time, updater);
    items.push(batch);
  }

  remove(updater) {
    const items = this._items;
    const length = items.length;
    for (let i = length - 1; i >= 0; i--) {
      const item = items[i];
      if (item.remove(updater)) {
        if (item.updaters.length === 0) {
          items.splice(i, 1);
          item.destroy();
        }
        break;
      }
    }
  }

  update(time) {
    let i;
    const items = this._items;
    const length = items.length;

    for (i = length - 1; i >= 0; i--) {
      const item = items[i];
      if (item.invalidated) {
        items.splice(i, 1);
        const updaters = item.updaters.values;
        const updatersLength = updaters.length;
        for (let h = 0; h < updatersLength; h++) {
          this.add(time, updaters[h]);
        }
        item.destroy();
      }
    }

    let isUpdated = true;
    for (i = 0; i < items.length; i++) {
      isUpdated = items[i].update(time) && isUpdated;
    }
    return isUpdated;
  }

  getBoundingSphere(updater, result) {
    const items = this._items;
    const length = items.length;
    for (let i = 0; i < length; i++) {
      const item = items[i];
      if (item.contains(updater)) {
        return item.getBoundingSphere(updater, result);
      }
    }
    return BoundingSphereState.FAILED;
  }

  removeAllPrimitives() {
    const items = this._items;
    const length = items.length;
    for (let i = 0; i < length; i++) {
      items[i].destroy();
    }
    this._items.length = 0;
  }
}

export default StaticGeometryPerMaterialBatch;
