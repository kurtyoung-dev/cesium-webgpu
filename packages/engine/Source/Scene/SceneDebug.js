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
import FpsOverlay from "../Services/FpsOverlay.js";
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

/**
 * `scene.debugShowFramesPerSecond = true` historically attached an
 * upstream `PerformanceDisplay` widget that showed a recent-average
 * FPS in a corner div. We've replaced that with `FpsOverlay`, which
 * is the same component the worker test page uses — it draws a
 * 60-second rolling graph + average + 1% lows + 1% highs by polling
 * `scene.performanceTracker` (which is now always recording every
 * rendered frame into a circular buffer at near-zero hot-path cost).
 *
 * The toggle field name (`scene.debugShowFramesPerSecond`) and the
 * cached field on the scene (`scene._performanceDisplay`) are
 * preserved for backwards compatibility — any user code that
 * introspects `defined(scene._performanceDisplay)` continues to
 * work; the held value is now an `FpsOverlay` instance instead of a
 * `PerformanceDisplay`. Both expose `destroy()`.
 *
 * Headless safety: skipped entirely when there's no DOM (`document`
 * undefined or canvas has no parentNode), which matches the worker
 * Scene path. The host-side worker pane wires up its own FpsOverlay
 * directly via `WorkerSceneHost`, so it doesn't need this code path.
 */
function updateDebugShowFramesPerSecond(scene, renderedThisFrame) {
  if (scene.debugShowFramesPerSecond) {
    if (!defined(scene._performanceDisplay)) {
      // Headless / worker safety — skip overlay creation when there's
      // no DOM. The worker test page wires its own FpsOverlay against
      // the WorkerSceneHost on the main thread.
      if (
        typeof document === "undefined" ||
        !scene._canvas ||
        !scene._canvas.parentNode
      ) {
        return;
      }

      // The FpsOverlay attaches itself to the parent and manages its
      // own DOM lifecycle. We don't need a separate
      // `_performanceContainer` field anymore — the overlay's
      // `destroy()` removes its container from the parent in one
      // step.
      const overlay = new FpsOverlay({
        parent: scene._canvas.parentNode,
        dataSource: scene.performanceTracker,
        label: scene._context && scene._context.isWebGPU ? "webgpu" : "webgl",
        position: "top-left",
      });
      scene._performanceDisplay = overlay;
    }
    // The overlay is self-driving (polls at 6 Hz via setInterval). We
    // don't need a per-frame update call here; the legacy
    // PerformanceDisplay required one because it computed FPS from
    // its own internal frame counter, but FpsOverlay reads from
    // `scene.performanceTracker` which `Scene.render()` already
    // updates via `recordFrame()` after every rendered frame.
    void renderedThisFrame;
  } else if (defined(scene._performanceDisplay)) {
    scene._performanceDisplay.destroy();
    scene._performanceDisplay = undefined;
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
