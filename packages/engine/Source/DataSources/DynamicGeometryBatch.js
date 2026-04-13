import AssociativeArray from "../Core/AssociativeArray.js";
import defined from "../Core/defined.js";
import BoundingSphereState from "./BoundingSphereState.js";

/**
 * @private
 */
class DynamicGeometryBatch {
  constructor(primitives, orderedGroundPrimitives) {
    this._primitives = primitives;
    this._orderedGroundPrimitives = orderedGroundPrimitives;
    this._dynamicUpdaters = new AssociativeArray();
  }

  add(time, updater) {
    this._dynamicUpdaters.set(
      updater.id,
      updater.createDynamicUpdater(
        this._primitives,
        this._orderedGroundPrimitives,
      ),
    );
  }

  remove(updater) {
    const id = updater.id;
    const dynamicUpdater = this._dynamicUpdaters.get(id);
    if (defined(dynamicUpdater)) {
      this._dynamicUpdaters.remove(id);
      dynamicUpdater.destroy();
    }
  }

  update(time) {
    const geometries = this._dynamicUpdaters.values;
    for (let i = 0, len = geometries.length; i < len; i++) {
      geometries[i].update(time);
    }
    return true;
  }

  removeAllPrimitives() {
    const geometries = this._dynamicUpdaters.values;
    for (let i = 0, len = geometries.length; i < len; i++) {
      geometries[i].destroy();
    }
    this._dynamicUpdaters.removeAll();
  }

  getBoundingSphere(updater, result) {
    updater = this._dynamicUpdaters.get(updater.id);
    if (defined(updater) && defined(updater.getBoundingSphere)) {
      return updater.getBoundingSphere(result);
    }
    return BoundingSphereState.FAILED;
  }
}

export default DynamicGeometryBatch;
