import Cartesian2 from "../Core/Cartesian2.js";
import Cartesian3 from "../Core/Cartesian3.js";
import Cartesian4 from "../Core/Cartesian4.js";
import Cartographic from "../Core/Cartographic.js";
import CesiumMath from "../Core/Math.js";
import clone from "../Core/clone.js";
import Color from "../Core/Color.js";
import defined from "../Core/defined.js";
import Ellipsoid from "../Core/Ellipsoid.js";
import JulianDate from "../Core/JulianDate.js";
import Material from "./Material.js";
import Matrix4 from "../Core/Matrix4.js";
import MetadataComponentType from "./MetadataComponentType.js";
import MetadataType from "./MetadataType.js";
import oneTimeWarning from "../Core/oneTimeWarning.js";
import VerticalExaggeration from "../Core/VerticalExaggeration.js";
import VoxelContent from "./VoxelContent.js";
import VoxelShapeType from "./VoxelShapeType.js";
import VoxelMetadataOrder from "./VoxelMetadataOrder.js";
import VoxelTraversal from "./VoxelTraversal.js";

// Scratch variables for orientedBoundingBoxToNdcAabb
const scratchIntersect = new Cartesian4();
const scratchTransformPositionLocalToWorld = new Matrix4();
const scratchTransformPositionLocalToProjection = new Matrix4();

const corners = new Array(
  new Cartesian4(-1.0, -1.0, -1.0, 1.0),
  new Cartesian4(+1.0, -1.0, -1.0, 1.0),
  new Cartesian4(-1.0, +1.0, -1.0, 1.0),
  new Cartesian4(+1.0, +1.0, -1.0, 1.0),
  new Cartesian4(-1.0, -1.0, +1.0, 1.0),
  new Cartesian4(+1.0, -1.0, +1.0, 1.0),
  new Cartesian4(-1.0, +1.0, +1.0, 1.0),
  new Cartesian4(+1.0, +1.0, +1.0, 1.0),
);
const vertexNeighborIndices = new Array(
  1,
  2,
  4,
  0,
  3,
  5,
  0,
  3,
  6,
  1,
  2,
  7,
  0,
  5,
  6,
  1,
  4,
  7,
  2,
  4,
  7,
  3,
  5,
  6,
);
const scratchCornersClipSpace = new Array(
  new Cartesian4(),
  new Cartesian4(),
  new Cartesian4(),
  new Cartesian4(),
  new Cartesian4(),
  new Cartesian4(),
  new Cartesian4(),
  new Cartesian4(),
);

// Scratch variables for shape/transform updates
const scratchExaggerationScale = new Cartesian3();
const scratchExaggerationCenter = new Cartesian3();
const scratchCartographicCenter = new Cartographic();
const scratchExaggeratedMinBounds = new Cartesian3();
const scratchExaggeratedMaxBounds = new Cartesian3();
const scratchExaggeratedMinClippingBounds = new Cartesian3();
const scratchExaggeratedMaxClippingBounds = new Cartesian3();
const scratchExaggeratedModelMatrix = new Matrix4();
const scratchCompoundModelMatrix = new Matrix4();
const scratchExaggerationTranslation = new Cartesian3();
const scratchCameraPositionShapeUv = new Cartesian3();

/**
 * Initialize shape and bounds from provider.
 * @param {VoxelPrimitive} primitive
 * @param {VoxelProvider} provider
 * @private
 */
export function initializeShape(primitive, provider) {
  const {
    shape: shapeType,
    minBounds = VoxelShapeType.getMinBounds(shapeType),
    maxBounds = VoxelShapeType.getMaxBounds(shapeType),
  } = provider;

  primitive.minBounds = minBounds;
  primitive.maxBounds = maxBounds;
  primitive.minClippingBounds = minBounds.clone();
  primitive.maxClippingBounds = maxBounds.clone();

  checkTransformAndBounds(primitive);

  const ShapeConstructor = VoxelShapeType.getShapeConstructor(shapeType);
  primitive._shape = new ShapeConstructor();
  primitive._shapeVisible = updateShapeAndTransforms(primitive);
}

/**
 * Initialize primitive properties that are derived from the voxel provider.
 * @param {VoxelPrimitive} primitive
 * @param {VoxelProvider} provider
 * @param {Context} context
 * @private
 */
export function initFromProvider(primitive, provider, context) {
  const uniforms = primitive._uniforms;

  primitive._pickId = context.createPickId({ primitive }, "voxel");
  uniforms.pickColor = Color.clone(primitive._pickId.color, uniforms.pickColor);

  const { shaderDefines, shaderUniforms: shapeUniforms } = primitive._shape;
  primitive._shapeDefinesOld = clone(shaderDefines, true);

  // Add shape uniforms to the uniform map
  const uniformMap = primitive._uniformMap;
  for (const key in shapeUniforms) {
    if (Object.hasOwn(shapeUniforms, key)) {
      const name = `u_${key}`;

      //>>includeStart('debug', pragmas.debug);
      if (defined(uniformMap[name])) {
        oneTimeWarning(
          `VoxelPrimitive: Uniform name "${name}" is already defined`,
        );
      }
      //>>includeEnd('debug');

      uniformMap[name] = function () {
        return shapeUniforms[key];
      };
    }
  }

  // Set uniforms that come from the provider
  primitive._dimensions = Cartesian3.clone(
    provider.dimensions,
    primitive._dimensions,
  );
  uniforms.dimensions = Cartesian3.clone(
    primitive._dimensions,
    uniforms.dimensions,
  );
  primitive._paddingBefore = Cartesian3.clone(
    provider.paddingBefore ?? Cartesian3.ZERO,
    primitive._paddingBefore,
  );
  uniforms.paddingBefore = Cartesian3.clone(
    primitive._paddingBefore,
    uniforms.paddingBefore,
  );
  primitive._paddingAfter = Cartesian3.clone(
    provider.paddingAfter ?? Cartesian3.ZERO,
    primitive._paddingAfter,
  );
  uniforms.paddingAfter = Cartesian3.clone(
    primitive._paddingAfter,
    uniforms.paddingAfter,
  );
  primitive._inputDimensions = Cartesian3.add(
    primitive._dimensions,
    primitive._paddingBefore,
    primitive._inputDimensions,
  );
  primitive._inputDimensions = Cartesian3.add(
    primitive._inputDimensions,
    primitive._paddingAfter,
    primitive._inputDimensions,
  );

  if (provider.metadataOrder === VoxelMetadataOrder.Y_UP) {
    const inputDimensionsY = primitive._inputDimensions.y;
    primitive._inputDimensions.y = primitive._inputDimensions.z;
    primitive._inputDimensions.z = inputDimensionsY;
  }
  uniforms.inputDimensions = Cartesian3.clone(
    primitive._inputDimensions,
    uniforms.inputDimensions,
  );
  primitive._availableLevels = provider.availableLevels ?? 1;

  // Create the VoxelTraversal, and set related uniforms
  const keyframeCount = provider.keyframeCount ?? 1;
  primitive._traversal = new VoxelTraversal(primitive, context, keyframeCount);
  primitive.statistics.texturesByteLength =
    primitive._traversal.textureMemoryByteLength;
  setTraversalUniforms(primitive._traversal, uniforms);
}

/**
 * Track changes in provider transform and primitive bounds.
 * @param {VoxelPrimitive} primitive
 * @returns {boolean} Whether any of the transform or bounds changed
 * @private
 */
export function checkTransformAndBounds(primitive) {
  const numChanges =
    updateBound(primitive, "_modelMatrix", "_modelMatrixOld") +
    updateBound(primitive, "_minBounds", "_minBoundsOld") +
    updateBound(primitive, "_maxBounds", "_maxBoundsOld") +
    updateBound(primitive, "_minClippingBounds", "_minClippingBoundsOld") +
    updateBound(primitive, "_maxClippingBounds", "_maxClippingBoundsOld");
  return numChanges > 0;
}

function updateBound(primitive, newBoundKey, oldBoundKey) {
  const newBound = primitive[newBoundKey];
  const oldBound = primitive[oldBoundKey];
  const changed = !newBound.equals(oldBound);
  if (changed) {
    newBound.clone(oldBound);
  }
  return changed ? 1 : 0;
}

/**
 * Check for changes in the vertical exaggeration.
 * @param {VoxelPrimitive} primitive
 * @param {FrameState} frameState
 * @returns {boolean} True if the exaggeration changed
 * @private
 */
export function updateVerticalExaggeration(primitive, frameState) {
  const { verticalExaggeration, verticalExaggerationRelativeHeight } =
    frameState;

  if (
    primitive._verticalExaggeration === verticalExaggeration &&
    primitive._verticalExaggerationRelativeHeight ===
      verticalExaggerationRelativeHeight
  ) {
    return false;
  }

  primitive._verticalExaggeration = verticalExaggeration;
  primitive._verticalExaggerationRelativeHeight =
    verticalExaggerationRelativeHeight;
  return true;
}

/**
 * Update the shape and related transforms.
 * @param {VoxelPrimitive} primitive
 * @returns {boolean} True if the shape is visible
 * @private
 */
export function updateShapeAndTransforms(primitive) {
  const verticalExaggeration = primitive._verticalExaggeration;
  const verticalExaggerationRelativeHeight =
    primitive._verticalExaggerationRelativeHeight;
  const exaggeratedMinBounds = Cartesian3.clone(
    primitive._minBounds,
    scratchExaggeratedMinBounds,
  );
  const exaggeratedMaxBounds = Cartesian3.clone(
    primitive._maxBounds,
    scratchExaggeratedMaxBounds,
  );
  const exaggeratedMinClippingBounds = Cartesian3.clone(
    primitive._minClippingBounds,
    scratchExaggeratedMinClippingBounds,
  );
  const exaggeratedMaxClippingBounds = Cartesian3.clone(
    primitive._maxClippingBounds,
    scratchExaggeratedMaxClippingBounds,
  );
  const exaggeratedModelMatrix = Matrix4.clone(
    primitive._modelMatrix,
    scratchExaggeratedModelMatrix,
  );

  if (primitive.shape === VoxelShapeType.ELLIPSOID) {
    exaggeratedMinBounds.z = VerticalExaggeration.getHeight(
      primitive._minBounds.z,
      verticalExaggeration,
      verticalExaggerationRelativeHeight,
    );
    exaggeratedMaxBounds.z = VerticalExaggeration.getHeight(
      primitive._maxBounds.z,
      verticalExaggeration,
      verticalExaggerationRelativeHeight,
    );
    exaggeratedMinClippingBounds.z = VerticalExaggeration.getHeight(
      primitive._minClippingBounds.z,
      verticalExaggeration,
      verticalExaggerationRelativeHeight,
    );
    exaggeratedMaxClippingBounds.z = VerticalExaggeration.getHeight(
      primitive._maxClippingBounds.z,
      verticalExaggeration,
      verticalExaggerationRelativeHeight,
    );
  } else {
    const exaggerationScale = Cartesian3.fromElements(
      1.0,
      1.0,
      verticalExaggeration,
      scratchExaggerationScale,
    );
    Matrix4.multiplyByScale(
      exaggeratedModelMatrix,
      exaggerationScale,
      exaggeratedModelMatrix,
    );
    Matrix4.multiplyByTranslation(
      exaggeratedModelMatrix,
      computeBoxExaggerationTranslation(primitive),
      exaggeratedModelMatrix,
    );
  }

  const provider = primitive._provider;
  const shapeTransform = provider.shapeTransform ?? Matrix4.IDENTITY;
  const globalTransform = provider.globalTransform ?? Matrix4.IDENTITY;

  const compoundModelMatrix = Matrix4.multiplyTransformation(
    globalTransform,
    exaggeratedModelMatrix,
    scratchCompoundModelMatrix,
  );
  Matrix4.multiplyTransformation(
    compoundModelMatrix,
    shapeTransform,
    compoundModelMatrix,
  );

  const shape = primitive._shape;
  const visible = shape.update(
    compoundModelMatrix,
    exaggeratedMinBounds,
    exaggeratedMaxBounds,
    exaggeratedMinClippingBounds,
    exaggeratedMaxClippingBounds,
  );
  if (!visible) {
    return false;
  }

  primitive._transformPositionLocalToWorld = Matrix4.clone(
    shape.shapeTransform,
    primitive._transformPositionLocalToWorld,
  );
  primitive._transformPositionWorldToLocal = Matrix4.inverse(
    primitive._transformPositionLocalToWorld,
    primitive._transformPositionWorldToLocal,
  );
  primitive._transformDirectionWorldToLocal = Matrix4.getMatrix3(
    primitive._transformPositionWorldToLocal,
    primitive._transformDirectionWorldToLocal,
  );

  return true;
}

function computeBoxExaggerationTranslation(primitive) {
  const verticalExaggeration = primitive._verticalExaggeration;
  const verticalExaggerationRelativeHeight =
    primitive._verticalExaggerationRelativeHeight;

  const {
    shapeTransform = Matrix4.IDENTITY,
    globalTransform = Matrix4.IDENTITY,
  } = primitive._provider;

  const initialCenter = Matrix4.getTranslation(
    shapeTransform,
    scratchExaggerationCenter,
  );
  const intermediateCenter = Matrix4.multiplyByPoint(
    primitive._modelMatrix,
    initialCenter,
    scratchExaggerationCenter,
  );
  const transformedCenter = Matrix4.multiplyByPoint(
    globalTransform,
    intermediateCenter,
    scratchExaggerationCenter,
  );

  const ellipsoid = Ellipsoid.WGS84;
  const centerCartographic = ellipsoid.cartesianToCartographic(
    transformedCenter,
    scratchCartographicCenter,
  );

  let centerHeight = 0.0;
  if (defined(centerCartographic)) {
    centerHeight = centerCartographic.height;
  }

  const exaggeratedHeight = VerticalExaggeration.getHeight(
    centerHeight,
    verticalExaggeration,
    verticalExaggerationRelativeHeight,
  );

  return Cartesian3.fromElements(
    0.0,
    0.0,
    (exaggeratedHeight - centerHeight) / verticalExaggeration,
    scratchExaggerationTranslation,
  );
}

/**
 * Track changes in shape-related shader defines.
 * @param {VoxelPrimitive} primitive
 * @returns {boolean} True if any defines changed
 * @private
 */
export function checkShapeDefines(primitive) {
  const { shaderDefines } = primitive._shape;
  const shapeDefinesChanged = Object.keys(shaderDefines).some(
    (key) => shaderDefines[key] !== primitive._shapeDefinesOld[key],
  );
  if (shapeDefinesChanged) {
    primitive._shapeDefinesOld = clone(shaderDefines, true);
  }
  return shapeDefinesChanged;
}

/**
 * Find the keyframe location to render at.
 * @param {TimeIntervalCollection} timeIntervalCollection
 * @param {Clock} clock
 * @returns {number}
 * @private
 */
export function getKeyframeLocation(timeIntervalCollection, clock) {
  if (!defined(timeIntervalCollection) || !defined(clock)) {
    return 0.0;
  }
  let date = clock.currentTime;
  let timeInterval;
  let timeIntervalIndex = timeIntervalCollection.indexOf(date);
  if (timeIntervalIndex >= 0) {
    timeInterval = timeIntervalCollection.get(timeIntervalIndex);
  } else {
    timeIntervalIndex = ~timeIntervalIndex;
    if (timeIntervalIndex === timeIntervalCollection.length) {
      timeIntervalIndex = timeIntervalCollection.length - 1;
      timeInterval = timeIntervalCollection.get(timeIntervalIndex);
      date = timeInterval.stop;
    } else {
      timeInterval = timeIntervalCollection.get(timeIntervalIndex);
      date = timeInterval.start;
    }
  }
  const totalSeconds = JulianDate.secondsDifference(
    timeInterval.stop,
    timeInterval.start,
  );
  const secondsDifferenceStart = JulianDate.secondsDifference(
    date,
    timeInterval.start,
  );
  const t = secondsDifferenceStart / totalSeconds;

  return timeIntervalIndex + t;
}

/**
 * Update the clipping planes state and associated uniforms.
 * @param {VoxelPrimitive} primitive
 * @param {FrameState} frameState
 * @returns {boolean} Whether the clipping planes changed
 * @private
 */
export function updateClippingPlanes(primitive, frameState) {
  const clippingPlanes = primitive.clippingPlanes;
  if (!defined(clippingPlanes)) {
    return false;
  }

  clippingPlanes.update(frameState);

  const { clippingPlanesState, enabled } = clippingPlanes;

  if (enabled) {
    const uniforms = primitive._uniforms;
    uniforms.clippingPlanesTexture = clippingPlanes.texture;
    uniforms.clippingPlanesMatrix = Matrix4.transpose(
      Matrix4.multiplyTransformation(
        Matrix4.inverse(
          clippingPlanes.modelMatrix,
          uniforms.clippingPlanesMatrix,
        ),
        primitive._transformPositionLocalToWorld,
        uniforms.clippingPlanesMatrix,
      ),
      uniforms.clippingPlanesMatrix,
    );
  }

  if (
    primitive._clippingPlanesState === clippingPlanesState &&
    primitive._clippingPlanesEnabled === enabled
  ) {
    return false;
  }
  primitive._clippingPlanesState = clippingPlanesState;
  primitive._clippingPlanesEnabled = enabled;

  return true;
}

export function updateNearestSampling(primitive) {
  const { megatextures } = primitive._traversal;
  for (let i = 0; i < megatextures.length; ++i) {
    megatextures[i].nearestSampling = primitive._nearestSampling;
  }
}

export function updateRenderBoundPlanes(primitive, frameState) {
  const uniforms = primitive._uniforms;
  const { renderBoundPlanes } = primitive._shape;
  if (!defined(renderBoundPlanes)) {
    return;
  }
  renderBoundPlanes.update(frameState, primitive._transformPlaneLocalToView);
  uniforms.renderBoundPlanesTexture = renderBoundPlanes.texture;
}

/**
 * Converts a position in local space to tile coordinates.
 * @param {VoxelPrimitive} primitive
 * @param {Cartesian3} positionLocal
 * @param {Cartesian4} result
 * @returns {Cartesian4}
 * @private
 */
export function getTileCoordinates(primitive, positionLocal, result) {
  const shapeUv = primitive._shape.convertLocalToShapeUvSpace(
    positionLocal,
    scratchCameraPositionShapeUv,
  );

  const availableLevels = primitive._availableLevels;
  const numTiles = 2 ** (availableLevels - 1);

  return Cartesian4.fromElements(
    shapeUv.x * numTiles,
    shapeUv.y * numTiles,
    shapeUv.z * numTiles,
    availableLevels - 1,
    result,
  );
}

function setTraversalUniforms(traversal, uniforms) {
  uniforms.octreeInternalNodeTexture = traversal.internalNodeTexture;
  uniforms.octreeInternalNodeTexelSizeUv = Cartesian2.clone(
    traversal.internalNodeTexelSizeUv,
    uniforms.octreeInternalNodeTexelSizeUv,
  );
  uniforms.octreeInternalNodeTilesPerRow = traversal.internalNodeTilesPerRow;

  const { megatextures } = traversal;
  const megatexture = megatextures[0];
  uniforms.megatextureTextures = new Array(megatextures.length);
  for (let i = 0; i < megatextures.length; i++) {
    uniforms.megatextureTextures[i] = megatextures[i].texture;
  }
  uniforms.megatextureTileCounts = Cartesian3.clone(
    megatexture.tileCounts,
    uniforms.megatextureTileCounts,
  );
}

/**
 * Projects OBB to NDC-space AABB with near-plane clipping.
 * @param {OrientedBoundingBox} orientedBoundingBox
 * @param {Matrix4} worldToProjection
 * @param {Cartesian4} result
 * @returns {Cartesian4}
 * @private
 */
export function orientedBoundingBoxToNdcAabb(
  orientedBoundingBox,
  worldToProjection,
  result,
) {
  const transformPositionLocalToWorld = Matrix4.fromRotationTranslation(
    orientedBoundingBox.halfAxes,
    orientedBoundingBox.center,
    scratchTransformPositionLocalToWorld,
  );
  const transformPositionLocalToProjection = Matrix4.multiply(
    worldToProjection,
    transformPositionLocalToWorld,
    scratchTransformPositionLocalToProjection,
  );

  let ndcMinX = +Number.MAX_VALUE;
  let ndcMaxX = -Number.MAX_VALUE;
  let ndcMinY = +Number.MAX_VALUE;
  let ndcMaxY = -Number.MAX_VALUE;
  let cornerIndex;

  const cornersClipSpace = scratchCornersClipSpace;
  const cornersLength = corners.length;
  for (cornerIndex = 0; cornerIndex < cornersLength; cornerIndex++) {
    Matrix4.multiplyByVector(
      transformPositionLocalToProjection,
      corners[cornerIndex],
      cornersClipSpace[cornerIndex],
    );
  }

  for (cornerIndex = 0; cornerIndex < cornersLength; cornerIndex++) {
    const position = cornersClipSpace[cornerIndex];
    if (position.z >= -position.w) {
      const ndcX = position.x / position.w;
      const ndcY = position.y / position.w;
      ndcMinX = Math.min(ndcMinX, ndcX);
      ndcMaxX = Math.max(ndcMaxX, ndcX);
      ndcMinY = Math.min(ndcMinY, ndcY);
      ndcMaxY = Math.max(ndcMaxY, ndcY);
    } else {
      for (let neighborIndex = 0; neighborIndex < 3; neighborIndex++) {
        const neighborVertexIndex =
          vertexNeighborIndices[cornerIndex * 3 + neighborIndex];
        const neighborPosition = cornersClipSpace[neighborVertexIndex];
        if (neighborPosition.z >= -neighborPosition.w) {
          const distanceToPlaneFromPosition = position.z + position.w;
          const distanceToPlaneFromNeighbor =
            neighborPosition.z + neighborPosition.w;
          const t =
            distanceToPlaneFromPosition /
            (distanceToPlaneFromPosition - distanceToPlaneFromNeighbor);

          const intersect = Cartesian4.lerp(
            position,
            neighborPosition,
            t,
            scratchIntersect,
          );
          const intersectNdcX = intersect.x / intersect.w;
          const intersectNdcY = intersect.y / intersect.w;
          ndcMinX = Math.min(ndcMinX, intersectNdcX);
          ndcMaxX = Math.max(ndcMaxX, intersectNdcX);
          ndcMinY = Math.min(ndcMinY, intersectNdcY);
          ndcMaxY = Math.max(ndcMaxY, intersectNdcY);
        }
      }
    }
  }

  ndcMinX = CesiumMath.clamp(ndcMinX, -1.0, +1.0);
  ndcMinY = CesiumMath.clamp(ndcMinY, -1.0, +1.0);
  ndcMaxX = CesiumMath.clamp(ndcMaxX, -1.0, +1.0);
  ndcMaxY = CesiumMath.clamp(ndcMaxY, -1.0, +1.0);
  result = Cartesian4.fromElements(ndcMinX, ndcMinY, ndcMaxX, ndcMaxY, result);

  return result;
}

const polylineAxisDistance = 30000000.0;
const polylineXAxis = new Cartesian3(polylineAxisDistance, 0.0, 0.0);
const polylineYAxis = new Cartesian3(0.0, polylineAxisDistance, 0.0);
const polylineZAxis = new Cartesian3(0.0, 0.0, polylineAxisDistance);

/**
 * Draws the tile bounding boxes and axes.
 * @param {VoxelPrimitive} that
 * @param {FrameState} frameState
 * @private
 */
export function debugDraw(that, frameState) {
  const traversal = that._traversal;
  const polylines = that._debugPolylines;
  polylines.removeAll();

  function makePolylineLineSegment(startPos, endPos, color, thickness) {
    polylines.add({
      positions: [startPos, endPos],
      width: thickness,
      material: Material.fromType("Color", {
        color: color,
      }),
    });
  }

  function makePolylineBox(orientedBoundingBox, color, thickness) {
    const boxCorners = orientedBoundingBox.computeCorners();
    makePolylineLineSegment(boxCorners[0], boxCorners[1], color, thickness);
    makePolylineLineSegment(boxCorners[2], boxCorners[3], color, thickness);
    makePolylineLineSegment(boxCorners[4], boxCorners[5], color, thickness);
    makePolylineLineSegment(boxCorners[6], boxCorners[7], color, thickness);
    makePolylineLineSegment(boxCorners[0], boxCorners[2], color, thickness);
    makePolylineLineSegment(boxCorners[4], boxCorners[6], color, thickness);
    makePolylineLineSegment(boxCorners[1], boxCorners[3], color, thickness);
    makePolylineLineSegment(boxCorners[5], boxCorners[7], color, thickness);
    makePolylineLineSegment(boxCorners[0], boxCorners[4], color, thickness);
    makePolylineLineSegment(boxCorners[2], boxCorners[6], color, thickness);
    makePolylineLineSegment(boxCorners[1], boxCorners[5], color, thickness);
    makePolylineLineSegment(boxCorners[3], boxCorners[7], color, thickness);
  }

  function drawTile(tile) {
    if (!traversal.isRenderable(tile)) {
      return;
    }

    const level = tile.level;
    const startThickness = 5.0;
    const thickness = Math.max(1.0, startThickness / Math.pow(2.0, level));
    const colors = [Color.RED, Color.LIME, Color.BLUE];
    const color = colors[level % 3];

    makePolylineBox(tile.orientedBoundingBox, color, thickness);

    if (defined(tile.children)) {
      for (let i = 0; i < 8; i++) {
        drawTile(tile.children[i]);
      }
    }
  }

  makePolylineBox(that._shape.orientedBoundingBox, Color.WHITE, 5.0);

  drawTile(traversal.rootNode);

  const axisThickness = 10.0;
  makePolylineLineSegment(
    Cartesian3.ZERO,
    polylineXAxis,
    Color.RED,
    axisThickness,
  );
  makePolylineLineSegment(
    Cartesian3.ZERO,
    polylineYAxis,
    Color.LIME,
    axisThickness,
  );
  makePolylineLineSegment(
    Cartesian3.ZERO,
    polylineZAxis,
    Color.BLUE,
    axisThickness,
  );

  polylines.update(frameState);
}

/**
 * Default voxel provider for VoxelPrimitive.DefaultProvider.
 * @private
 */
export class DefaultVoxelProvider {
  constructor() {
    this.ready = true;
    this.shape = VoxelShapeType.BOX;
    this.dimensions = new Cartesian3(1, 1, 1);
    this.names = ["data"];
    this.types = [MetadataType.SCALAR];
    this.componentTypes = [MetadataComponentType.FLOAT32];
    this.maximumTileCount = 1;
  }

  requestData(options) {
    const tileLevel = defined(options) ? (options.tileLevel ?? 0) : 0;
    if (tileLevel >= 1) {
      return undefined;
    }

    const content = new VoxelContent({ metadata: [new Float32Array(1)] });
    return Promise.resolve(content);
  }
}

// Namespace default export for build system barrel compatibility
const VoxelPrimitiveHelpers = {
  initializeShape,
  initFromProvider,
  checkTransformAndBounds,
  updateVerticalExaggeration,
  updateShapeAndTransforms,
  checkShapeDefines,
  getKeyframeLocation,
  updateClippingPlanes,
  updateNearestSampling,
  updateRenderBoundPlanes,
  getTileCoordinates,
  orientedBoundingBoxToNdcAabb,
  debugDraw,
  DefaultVoxelProvider,
};
export default VoxelPrimitiveHelpers;
