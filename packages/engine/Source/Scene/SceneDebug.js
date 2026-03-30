/**
 * Debug infrastructure extracted from Scene.js. Handles bounding volume
 * visualization, frustum plane debug rendering, and FPS display.
 *
 * @private
 */
import BoxGeometry from "../Core/BoxGeometry.js";
import Cartesian3 from "../Core/Cartesian3.js";
import ColorGeometryInstanceAttribute from "../Core/ColorGeometryInstanceAttribute.js";
import defined from "../Core/defined.js";
import EllipsoidGeometry from "../Core/EllipsoidGeometry.js";
import GeometryInstance from "../Core/GeometryInstance.js";
import GeometryPipeline from "../Core/GeometryPipeline.js";
import Matrix4 from "../Core/Matrix4.js";
import SceneMode from "./SceneMode.js";
import DebugCameraPrimitive from "./DebugCameraPrimitive.js";
import DerivedCommand from "./DerivedCommand.js";
import PerformanceDisplay from "./PerformanceDisplay.js";
import PerInstanceColorAppearance from "./PerInstanceColorAppearance.js";
import Primitive from "./Primitive.js";

let transformFrom2D = new Matrix4(
  0.0,
  0.0,
  1.0,
  0.0,
  1.0,
  0.0,
  0.0,
  0.0,
  0.0,
  1.0,
  0.0,
  0.0,
  0.0,
  0.0,
  0.0,
  1.0,
);
transformFrom2D = Matrix4.inverseTransformation(
  transformFrom2D,
  transformFrom2D,
);

function debugShowBoundingVolume(command, scene, passState, debugFramebuffer) {
  const frameState = scene._frameState;
  const context = frameState.context;
  const boundingVolume = command.boundingVolume;

  if (defined(scene._debugVolume)) {
    scene._debugVolume.destroy();
  }

  let center = Cartesian3.clone(boundingVolume.center);
  if (frameState.mode !== SceneMode.SCENE3D) {
    center = Matrix4.multiplyByPoint(transformFrom2D, center, center);
    const projection = frameState.mapProjection;
    const centerCartographic = projection.unproject(center);
    center = projection.ellipsoid.cartographicToCartesian(centerCartographic);
  }

  let geometry;
  let modelMatrix;
  const { radius } = boundingVolume;
  if (defined(radius)) {
    geometry = EllipsoidGeometry.createGeometry(
      new EllipsoidGeometry({
        radii: new Cartesian3(radius, radius, radius),
        vertexFormat: PerInstanceColorAppearance.FLAT_VERTEX_FORMAT,
      }),
    );
    modelMatrix = Matrix4.fromTranslation(center);
  } else {
    geometry = BoxGeometry.createGeometry(
      BoxGeometry.fromDimensions({
        dimensions: new Cartesian3(2.0, 2.0, 2.0),
        vertexFormat: PerInstanceColorAppearance.FLAT_VERTEX_FORMAT,
      }),
    );
    modelMatrix = Matrix4.fromRotationTranslation(
      boundingVolume.halfAxes,
      center,
      new Matrix4(),
    );
  }
  scene._debugVolume = new Primitive({
    geometryInstances: new GeometryInstance({
      geometry: GeometryPipeline.toWireframe(geometry),
      modelMatrix: modelMatrix,
      attributes: {
        color: new ColorGeometryInstanceAttribute(1.0, 0.0, 0.0, 1.0),
      },
    }),
    appearance: new PerInstanceColorAppearance({
      flat: true,
      translucent: false,
    }),
    asynchronous: false,
  });

  const savedCommandList = frameState.commandList;
  const commandList = (frameState.commandList = []);
  scene._debugVolume.update(frameState);

  command = commandList[0];

  if (frameState.useLogDepth) {
    const logDepth = DerivedCommand.createLogDepthCommand(command, context);
    command = logDepth.command;
  }

  let framebuffer;
  if (defined(debugFramebuffer)) {
    framebuffer = passState.framebuffer;
    passState.framebuffer = debugFramebuffer;
  }

  command.execute(context, passState);

  if (defined(framebuffer)) {
    passState.framebuffer = framebuffer;
  }

  frameState.commandList = savedCommandList;
}

function updateDebugFrustumPlanes(scene) {
  const frameState = scene._frameState;
  if (scene.debugShowFrustumPlanes !== scene._debugShowFrustumPlanes) {
    if (scene.debugShowFrustumPlanes) {
      scene._debugFrustumPlanes = new DebugCameraPrimitive({
        camera: scene.camera,
        updateOnChange: false,
        frustumSplits: frameState.frustumSplits,
      });
    } else {
      scene._debugFrustumPlanes =
        scene._debugFrustumPlanes && scene._debugFrustumPlanes.destroy();
    }
    scene._debugShowFrustumPlanes = scene.debugShowFrustumPlanes;
  }

  if (defined(scene._debugFrustumPlanes)) {
    scene._debugFrustumPlanes.update(frameState);
  }
}

function updateDebugShowFramesPerSecond(scene, renderedThisFrame) {
  if (scene.debugShowFramesPerSecond) {
    if (!defined(scene._performanceDisplay)) {
      const performanceContainer = document.createElement("div");
      performanceContainer.className =
        "cesium-performanceDisplay-defaultContainer";
      const container = scene._canvas.parentNode;
      container.appendChild(performanceContainer);
      const performanceDisplay = new PerformanceDisplay({
        container: performanceContainer,
      });
      scene._performanceDisplay = performanceDisplay;
      scene._performanceContainer = performanceContainer;
    }

    scene._performanceDisplay.throttled = scene.requestRenderMode;
    scene._performanceDisplay.update(renderedThisFrame);
  } else if (defined(scene._performanceDisplay)) {
    scene._performanceDisplay =
      scene._performanceDisplay && scene._performanceDisplay.destroy();
    scene._performanceContainer.parentNode.removeChild(
      scene._performanceContainer,
    );
  }
}

export {
  debugShowBoundingVolume,
  updateDebugFrustumPlanes,
  updateDebugShowFramesPerSecond,
};

// Namespace default export for build system barrel compatibility
const SceneDebug = {
  debugShowBoundingVolume,
  updateDebugFrustumPlanes,
  updateDebugShowFramesPerSecond,
};
export default SceneDebug;
