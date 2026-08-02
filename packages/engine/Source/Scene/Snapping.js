import BoundingRectangle from "../Core/BoundingRectangle.js";
import Cartesian2 from "../Core/Cartesian2.js";
import Cartesian3 from "../Core/Cartesian3.js";
import Check from "../Core/Check.js";
import defined from "../Core/defined.js";
import oneTimeWarning from "../Core/oneTimeWarning.js";
import PerspectiveFrustum from "../Core/PerspectiveFrustum.js";
import PerspectiveOffCenterFrustum from "../Core/PerspectiveOffCenterFrustum.js";
import Ray from "../Core/Ray.js";
import MapMode2D from "./MapMode2D.js";
import { drawingBufferToFrustumCoordinates } from "./PickFrustumMath.js";
import { pickBegin, pickEnd } from "./Picking.js";
import SceneMode from "./SceneMode.js";
import SnapFramebuffer from "./SnapFramebuffer.js";

/**
 * Implementation of {@link Scene#snap}: snap-to-geometry picking.
 *
 * A snapping pass is an offscreen pick render (it reuses the pick render
 * machinery via <code>pickBegin</code>/<code>pickEnd</code>) that targets a
 * dedicated RGBA32F framebuffer instead of the RGBA8 pick framebuffer. Each
 * pixel carries a fuller payload than a pick color:
 * <ul>
 *   <li>R: pick ID (uint32)</li>
 *   <li>G: isEdge flag (0.0/1.0)</li>
 *   <li>B: linear eye-space depth (meters)</li>
 *   <li>A: unused</li>
 * </ul>
 * The payload expression is built in PickingPipelineStage (DrawCommand.snapId)
 * and compiled into a snap-derived shader by
 * DerivedCommand.createSnapDerivedCommand. Only commands with a
 * <code>snapId</code> (i.e. Model-pipeline primitives) render during a
 * snapping pass.
 *
 * @namespace Snapping
 *
 * @private
 */
const Snapping = {};

const scratchRectangle = new BoundingRectangle(0.0, 0.0, 3.0, 3.0);
const scratchSnapRay = new Ray();
const scratchSnapOffset = new Cartesian3();
const scratchSnapFrustumCoordinates = new Cartesian2();
const scratchSnapWindowPosition = new Cartesian2();

// Radius around the crosshair, in pixels, used to sample the nearest surface
// (the occluder the cursor is on).
const SNAP_OCCLUDER_RADIUS_PIXELS = 3.0;

// An edge more than this fraction deeper than that surface is treated as
// occluded by it (the edge is only visible because it pokes through a gap in a
// nearer silhouette), so snap doesn't punch through to geometry behind the
// object the cursor is on.
const SNAP_OCCLUSION_TOLERANCE = 0.1;

function cursorDist(hit) {
  return Math.sqrt(hit.x * hit.x + hit.y * hit.y);
}

function selectBestHit(hits) {
  // Depth of the nearest surface under the crosshair; edges well behind it are
  // occluded by the object the cursor is on and must not win.
  let occluderDepth = Number.POSITIVE_INFINITY;
  for (const hit of hits) {
    if (!hit.isEdge && cursorDist(hit) <= SNAP_OCCLUDER_RADIUS_PIXELS) {
      occluderDepth = Math.min(occluderDepth, hit.depth);
    }
  }
  const maxEdgeDepth = occluderDepth * (1.0 + SNAP_OCCLUSION_TOLERANCE);

  // Edges outrank surfaces, but only edges in front of (or at) the occluder;
  // otherwise fall back to the closest surface. Within the chosen group the
  // hit closest to the crosshair wins.
  const visible = hits.filter(
    (hit) => !hit.isEdge || hit.depth <= maxEdgeDepth,
  );
  const wantEdge = visible.some((hit) => hit.isEdge);
  const group = visible.filter((hit) => hit.isEdge === wantEdge);
  return group.reduce((best, hit) =>
    cursorDist(hit) < cursorDist(best) ? hit : best,
  );
}

/**
 * Capture the camera state that produced one snap payload. The synchronous
 * WebGPU API consumes a completed readback from an earlier mini-frame, so it
 * must reconstruct against that rendered view rather than the live camera.
 *
 * Keep this flat and scalar-only: one frozen allocation per snap query, no
 * retained Camera/Frustum/Viewport objects, and no mutable nested state.
 *
 * @param {Scene} scene
 * @param {Cartesian2} windowPosition
 * @returns {object}
 * @private
 */
function captureSnapView(scene, windowPosition, drawingBufferRectangle) {
  const camera = scene.camera;
  const frustum = camera.frustum;
  const offCenterFrustum = frustum.offCenterFrustum;
  const effectiveFrustum = defined(offCenterFrustum)
    ? offCenterFrustum
    : frustum;
  const viewport = scene.defaultView.viewport;
  const canvas = scene.canvas;
  let sampleWindowX = windowPosition.x;
  let sampleWindowY = windowPosition.y;
  if (
    defined(drawingBufferRectangle) &&
    scene.drawingBufferWidth > 0 &&
    scene.drawingBufferHeight > 0 &&
    canvas.clientWidth > 0 &&
    canvas.clientHeight > 0
  ) {
    const sampleWidth = Math.max(
      1,
      Math.floor(drawingBufferRectangle.width ?? 1),
    );
    const sampleHeight = Math.max(
      1,
      Math.floor(drawingBufferRectangle.height ?? 1),
    );
    const sampleCenterX =
      Math.floor(drawingBufferRectangle.x ?? 0) + Math.floor(sampleWidth * 0.5);
    const sampleOriginTopY =
      scene.drawingBufferHeight -
      Math.floor(drawingBufferRectangle.y ?? 0) -
      sampleHeight;
    const sampleCenterTopY = sampleOriginTopY + Math.floor(sampleHeight * 0.5);
    // sampleCenterX/TopY are integer drawing-buffer pixel INDICES; the point
    // the payload sampled is that pixel's CENTER, so convert index + 0.5.
    // Without the half-pixel offset every reconstructed ray and reported
    // screenPosition is biased half a drawing-buffer pixel up-left.
    sampleWindowX =
      (sampleCenterX + 0.5) * (canvas.clientWidth / scene.drawingBufferWidth);
    sampleWindowY =
      (sampleCenterTopY + 0.5) *
      (canvas.clientHeight / scene.drawingBufferHeight);
  }

  return Object.freeze({
    sceneFrameNumber: scene.frameState?.frameNumber ?? 0,
    windowX: windowPosition.x,
    windowY: windowPosition.y,
    sampleWindowX,
    sampleWindowY,
    canvasWidth: canvas.clientWidth,
    canvasHeight: canvas.clientHeight,
    drawingBufferWidth: scene.drawingBufferWidth,
    drawingBufferHeight: scene.drawingBufferHeight,
    viewportX: viewport.x,
    viewportY: viewport.y,
    viewportWidth: viewport.width,
    viewportHeight: viewport.height,
    positionX: camera.positionWC.x,
    positionY: camera.positionWC.y,
    positionZ: camera.positionWC.z,
    directionX: camera.directionWC.x,
    directionY: camera.directionWC.y,
    directionZ: camera.directionWC.z,
    rightX: camera.rightWC.x,
    rightY: camera.rightWC.y,
    rightZ: camera.rightWC.z,
    upX: camera.upWC.x,
    upY: camera.upWC.y,
    upZ: camera.upWC.z,
    perspective:
      frustum instanceof PerspectiveFrustum ||
      frustum instanceof PerspectiveOffCenterFrustum ||
      (defined(frustum.aspectRatio) &&
        defined(frustum.fov) &&
        defined(frustum.near)),
    fovy: frustum.fovy ?? 0.0,
    aspectRatio: frustum.aspectRatio ?? 0.0,
    near: frustum.near ?? 0.0,
    far: effectiveFrustum.far ?? frustum.far ?? 0.0,
    left: effectiveFrustum.left ?? 0.0,
    right: effectiveFrustum.right ?? 0.0,
    top: effectiveFrustum.top ?? 0.0,
    bottom: effectiveFrustum.bottom ?? 0.0,
    sceneMode: scene.mode,
    mapMode2D: scene.mapMode2D,
    wrapLongitude:
      scene.mode === SceneMode.SCENE2D &&
      scene.mapMode2D === MapMode2D.INFINITE_SCROLL,
    maxCoordinateX: camera._maxCoord?.x ?? 0.0,
  });
}

/**
 * Convert a snap-payload offset from drawing-buffer pixels to the CSS/window
 * coordinate system used by Camera.getPickRay and SceneSnapResult.
 *
 * @param {object} view
 * @param {object} hit
 * @param {Cartesian2} result
 * @returns {Cartesian2 | undefined}
 * @private
 */
function snapHitToScreenPosition(view, hit, result) {
  if (
    !(view.canvasWidth > 0.0) ||
    !(view.canvasHeight > 0.0) ||
    !(view.drawingBufferWidth > 0.0) ||
    !(view.drawingBufferHeight > 0.0)
  ) {
    return undefined;
  }

  const sampleWindowX = view.sampleWindowX ?? view.windowX;
  const sampleWindowY = view.sampleWindowY ?? view.windowY;
  result.x =
    sampleWindowX + hit.x * (view.canvasWidth / view.drawingBufferWidth);
  result.y =
    sampleWindowY + hit.y * (view.canvasHeight / view.drawingBufferHeight);
  return result;
}

function getSnapPickRay(view, hit, result) {
  const windowPosition = snapHitToScreenPosition(
    view,
    hit,
    scratchSnapWindowPosition,
  );
  if (!defined(windowPosition)) {
    return undefined;
  }

  const viewportWidth = view.viewportWidth;
  const viewportHeight = view.viewportHeight;
  if (!(viewportWidth > 0.0) || !(viewportHeight > 0.0)) {
    return undefined;
  }

  // Viewports are expressed in drawing-buffer pixels with a bottom-left
  // origin, while Scene.snap receives CSS/window pixels with a top-left
  // origin. Convert through the frozen drawing-buffer scale before deriving
  // NDC so non-1x DPR and non-default viewports reconstruct the same ray that
  // produced the payload.
  const drawingBufferX =
    windowPosition.x * (view.drawingBufferWidth / view.canvasWidth);
  const drawingBufferYFromTop =
    windowPosition.y * (view.drawingBufferHeight / view.canvasHeight);
  const drawingBufferY = view.drawingBufferHeight - drawingBufferYFromTop;
  const frustumCoordinates = drawingBufferToFrustumCoordinates(
    drawingBufferX,
    drawingBufferY,
    view.viewportX,
    view.viewportY,
    viewportWidth,
    viewportHeight,
    view.left,
    view.right,
    view.bottom,
    view.top,
    scratchSnapFrustumCoordinates,
  );
  const frustumX = frustumCoordinates.x;
  const frustumY = frustumCoordinates.y;
  const origin = result.origin;
  const direction = result.direction;

  if (view.perspective) {
    origin.x = view.positionX;
    origin.y = view.positionY;
    origin.z = view.positionZ;

    direction.x =
      view.directionX * view.near +
      view.rightX * frustumX +
      view.upX * frustumY;
    direction.y =
      view.directionY * view.near +
      view.rightY * frustumX +
      view.upY * frustumY;
    direction.z =
      view.directionZ * view.near +
      view.rightZ * frustumX +
      view.upZ * frustumY;
    Cartesian3.normalize(direction, direction);
    return result;
  }

  origin.x = view.positionX + view.rightX * frustumX + view.upX * frustumY;
  origin.y = view.positionY + view.rightY * frustumX + view.upY * frustumY;
  origin.z = view.positionZ + view.rightZ * frustumX + view.upZ * frustumY;
  direction.x = view.directionX;
  direction.y = view.directionY;
  direction.z = view.directionZ;

  if (view.wrapLongitude && view.maxCoordinateX > 0.0) {
    const period = 2.0 * view.maxCoordinateX;
    origin.y =
      ((((origin.y + view.maxCoordinateX) % period) + period) % period) -
      view.maxCoordinateX;
  }
  return result;
}

// Unproject a snap hit's eye-space depth (channel B of the snap framebuffer,
// written by the snap shader at the edge fragment itself) into a world
// position.
function snapHitToWorld(view, hit) {
  const ray = getSnapPickRay(view, hit, scratchSnapRay);
  if (!defined(ray)) {
    return undefined;
  }

  // hit.depth is perpendicular distance from the camera plane along the view
  // direction; convert to distance along the (non-axis-aligned) pick ray.
  const cos =
    ray.direction.x * view.directionX +
    ray.direction.y * view.directionY +
    ray.direction.z * view.directionZ;
  if (cos <= 0.0) {
    return undefined;
  }
  const t = hit.depth / cos;

  const offset = Cartesian3.multiplyByScalar(
    ray.direction,
    t,
    scratchSnapOffset,
  );
  return Cartesian3.add(ray.origin, offset, new Cartesian3());
}

/**
 * Returns the best snap target in a screen-space region around
 * <code>windowPosition</code>. See {@link Scene#snap} for the public API.
 *
 * @param {Scene} scene
 * @param {Cartesian2} windowPosition Window coordinates at the center of the search region.
 * @param {object} [options] Object with the following properties:
 * @param {number} [options.width=25] Width of the search region in pixels.
 * @param {number} [options.height=options.width] Height of the search region in pixels.
 * @returns {SceneSnapResult | undefined}
 *
 * @private
 */
Snapping.snap = function (scene, windowPosition, options) {
  //>>includeStart('debug', pragmas.debug);
  Check.defined("windowPosition", windowPosition);
  //>>includeEnd('debug');

  const width = options?.width ?? 25;
  const height = options?.height ?? width;

  const { context, defaultView } = scene;

  // The snap framebuffer is RGBA32F; rendering to it requires float color
  // attachment support.
  if (!context.colorBufferFloat) {
    oneTimeWarning(
      "snap-color-buffer-float",
      "Scene.snap requires the EXT_color_buffer_float extension, which is not supported on this platform.",
    );
    return undefined;
  }

  // Created lazily so applications that never snap pay no framebuffer cost.
  //
  // UP144-SNAP-WEBGPU (C11-212) — backend-appropriate target via the context
  // factory (same pattern View.js uses for the pick framebuffer): WebGL returns
  // null and falls through to `SnapFramebuffer`; WebGPU returns a
  // `WebGPUSnapFramebuffer`, whose construction also latches the context so the
  // model renderer starts emitting snap draw commands. Both implement the same
  // `begin(rectangle, viewport)` / `end(rectangle)` / `destroy()` surface, so
  // everything below this line is backend-agnostic.
  if (!defined(defaultView.snapFramebuffer)) {
    defaultView.snapFramebuffer =
      context.createSnapFramebuffer() ?? new SnapFramebuffer(context);
  }
  const snapFramebuffer = defaultView.snapFramebuffer;

  const drawingBufferRectangle = scratchRectangle;
  let readback;
  let snapError;
  let hasSnapError = false;
  try {
    pickBegin(scene, windowPosition, drawingBufferRectangle, width, height, {
      framebuffer: snapFramebuffer,
      snap: true,
    });
    const currentView = captureSnapView(
      scene,
      windowPosition,
      drawingBufferRectangle,
    );
    readback = snapFramebuffer.end(drawingBufferRectangle, currentView);
  } catch (error) {
    snapError = error;
    hasSnapError = true;
  }

  // A snap mini-frame owns frame resources and pass flags even when rendering
  // or readback setup throws. Preserve the primary failure if teardown also
  // fails, matching Picking's exception-safe completion contract.
  let cleanupError;
  let hasCleanupError = false;
  try {
    pickEnd(scene);
  } catch (error) {
    cleanupError = error;
    hasCleanupError = true;
  }
  if (hasSnapError) {
    throw snapError;
  }
  if (hasCleanupError) {
    throw cleanupError;
  }

  const { hits, view } = readback;

  if (hits.length === 0) {
    return undefined;
  }

  const best = selectBestHit(hits);
  if (!defined(best)) {
    return undefined;
  }

  const position = snapHitToWorld(view, best);
  if (!defined(position)) {
    return undefined;
  }

  const screenPosition = snapHitToScreenPosition(view, best, new Cartesian2());
  if (!defined(screenPosition)) {
    return undefined;
  }

  return {
    object: best.object,
    isEdge: best.isEdge,
    position: position,
    screenPosition: screenPosition,
  };
};

// Exposed for testing.
Snapping._selectBestHit = selectBestHit;
Snapping._snapHitToWorld = snapHitToWorld;
Snapping._captureSnapView = captureSnapView;
Snapping._snapHitToScreenPosition = snapHitToScreenPosition;

export default Snapping;
