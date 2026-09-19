import { Check, wrapFunction } from "@cesium/engine";
import VoxelInspector from "../VoxelInspector/VoxelInspector.js";

/**
 * A mixin which adds the {@link VoxelInspector} widget to the {@link Viewer} widget.
 * Rather than being called directly, this function is normally passed as
 * a parameter to {@link Viewer#extend}, as shown in the example below.
 * @function
 *
 * @param {Viewer} viewer The viewer instance.
 *
 * @example
 * var viewer = new Cesium.Viewer('cesiumContainer');
 * viewer.extend(Cesium.viewerVoxelInspectorMixin);
 */
function viewerVoxelInspectorMixin(viewer) {
  //>>includeStart('debug', pragmas.debug);
  Check.typeOf.object("viewer", viewer);
  //>>includeEnd('debug');

  const container = document.createElement("div");
  container.className = "cesium-viewer-voxelInspectorContainer";
  viewer.container.appendChild(container);
  const voxelInspector = new VoxelInspector(container, viewer.scene);

  Object.defineProperties(viewer, {
    voxelInspector: {
      get: function () {
        return voxelInspector;
      },
    },
  });

  //Viewer.destroy removes only its own element, so the panel appended to the
  //caller's container is destroyed and removed here.
  viewer.destroy = wrapFunction(viewer, viewer.destroy, function () {
    voxelInspector.destroy();
    viewer.container.removeChild(container);
  });
}
export default viewerVoxelInspectorMixin;
