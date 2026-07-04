import BoundingSphere from "../../Core/BoundingSphere.js";
import Buffer from "../../Renderer/Buffer.js";
import BufferUsage from "../../Renderer/BufferUsage.js";
import Cartesian3 from "../../Core/Cartesian3.js";
import clone from "../../Core/clone.js";
import combine from "../../Core/combine.js";
import defined from "../../Core/defined.js";
import Matrix4 from "../../Core/Matrix4.js";
import ModelUtility from "./ModelUtility.js";
import SceneMode from "../SceneMode.js";
import ShaderDestination from "../../Renderer/ShaderDestination.js";
import VertexAttributeSemantic from "../VertexAttributeSemantic.js";
import SceneTransforms from "../SceneTransforms.js";

const scratchModelMatrix = new Matrix4();
const scratchModelView2D = new Matrix4();

/**
 * The scene mode 2D stage generates resources for rendering a primitive in 2D / CV mode.
 *
 * @namespace SceneMode2DPipelineStage
 *
 * @private
 */
const SceneMode2DPipelineStage = {
  name: "SceneMode2DPipelineStage", // Helps with debugging
};

/**
 * This pipeline stage processes the position attribute of a primitive and adds the relevant
 * define and uniform matrix to the shader. It also generates new resources for the primitive
 * in 2D. These resources persist in the runtime primitive so that the typed array used to
 * store the positional data can be freed.
 *
 * This stage must go before the GeometryPipelineStage in the primitive pipeline.
 *
 * Processes a primitive. This stage modifies the following parts of the render resources:
 * <ul>
 *  <li> creates a vertex buffer for the positions of the primitive projected to 2D
 *  <li> creates the bounding sphere for the primitive in 2D
 *  <li> adds a flag to the shader to use 2D positions
 *  <li> adds a uniform for the view model matrix in 2D
 * </ul>
 *
 * @param {PrimitiveRenderResources} renderResources The render resources for this primitive.
 * @param {ModelComponents.Primitive} primitive The primitive.
 * @param {FrameState} frameState The frame state.
 *
 * @private
 */

SceneMode2DPipelineStage.process = function (
  renderResources,
  primitive,
  frameState,
) {
  const positionAttribute = ModelUtility.getAttributeBySemantic(
    primitive,
    VertexAttributeSemantic.POSITION,
  );

  const shaderBuilder = renderResources.shaderBuilder;
  const model = renderResources.model;
  const modelMatrix = model.sceneGraph.computedModelMatrix;
  const nodeComputedTransform = renderResources.runtimeNode.computedTransform;
  const computedModelMatrix = Matrix4.multiplyTransformation(
    modelMatrix,
    nodeComputedTransform,
    scratchModelMatrix,
  );

  const boundingSphere2D = computeBoundingSphere2D(
    renderResources,
    computedModelMatrix,
    frameState,
  );

  const runtimePrimitive = renderResources.runtimePrimitive;
  runtimePrimitive.boundingSphere2D = boundingSphere2D;

  // If the model is instanced, 2D projection will be handled in the
  // InstancingPipelineStage.
  const instances = renderResources.runtimeNode.node.instances;
  if (defined(instances)) {
    return;
  }

  // Backend-agnostic guard (CLAUDE.md Principle 2): when the active
  // GraphicsContext retains the source geometry typed arrays
  // (`requiresVertexTypedArrayRetention` — true on WebGPU, which has no
  // `getBufferData()` back-channel), that backend builds its OWN 2D / CV
  // geometry from the CPU-side loader positions rather than the WebGL
  // 2D vertex-buffer machinery. Skip the WebGL 2D position-buffer
  // allocation, the source typed-array strip, and the `USE_2D_POSITIONS`
  // shader wiring below (GeometryPipelineStage's matching `use2D` gate
  // skips the paired `a_position2D` attribute, so the WebGL draw command
  // built for the model — which still runs under WebGPU — does not
  // reference an absent 2D vertex buffer). This leaves the intact source
  // `positionAttribute.typedArray` and the computed `boundingSphere2D` as
  // the substrate the WebGPU accurate-2D path (MORPH-MODEL-PROJECT2D /
  // B11) consumes. WebGL (capability false) keeps its exact strip +
  // stub-buffer behavior and byte-identical shader output.
  if (frameState.context.requiresVertexTypedArrayRetention === true) {
    return;
  }

  // If the typed array of the position attribute exists, then
  // the positions haven't been projected to 2D yet.
  if (defined(positionAttribute.typedArray)) {
    const buffer2D = createPositionBufferFor2D(
      positionAttribute,
      computedModelMatrix,
      boundingSphere2D,
      frameState,
    );

    // Since this buffer will persist even if the pipeline is re-run,
    // its memory will be counted in PrimitiveStatisticsPipelineStage
    runtimePrimitive.positionBuffer2D = buffer2D;
    model._modelResources.push(buffer2D);

    // Unload the typed array. This is just a pointer to the array in
    // the vertex buffer loader, so if the typed array is shared by
    // multiple primitives (i.e. multiple instances of the same mesh),
    // this will not affect the other primitives.
    positionAttribute.typedArray = undefined;
  }

  shaderBuilder.addDefine(
    "USE_2D_POSITIONS",
    undefined,
    ShaderDestination.VERTEX,
  );

  shaderBuilder.addUniform("mat4", "u_modelView2D", ShaderDestination.VERTEX);

  const modelMatrix2D = Matrix4.fromTranslation(
    boundingSphere2D.center,
    new Matrix4(),
  );

  const context = frameState.context;
  const uniformMap = {
    u_modelView2D: function () {
      return Matrix4.multiplyTransformation(
        context.uniformState.view,
        modelMatrix2D,
        scratchModelView2D,
      );
    },
  };

  renderResources.uniformMap = combine(uniformMap, renderResources.uniformMap);
};

const scratchProjectedMin = new Cartesian3();
const scratchProjectedMax = new Cartesian3();

function computeBoundingSphere2D(renderResources, modelMatrix, frameState) {
  // Compute the bounding sphere in 2D.
  const transformedPositionMin = Matrix4.multiplyByPoint(
    modelMatrix,
    renderResources.positionMin,
    scratchProjectedMin,
  );

  const projectedMin = SceneTransforms.computeActualEllipsoidPosition(
    frameState,
    transformedPositionMin,
    transformedPositionMin,
  );

  const transformedPositionMax = Matrix4.multiplyByPoint(
    modelMatrix,
    renderResources.positionMax,
    scratchProjectedMax,
  );

  const projectedMax = SceneTransforms.computeActualEllipsoidPosition(
    frameState,
    transformedPositionMax,
    transformedPositionMax,
  );

  return BoundingSphere.fromCornerPoints(
    projectedMin,
    projectedMax,
    new BoundingSphere(),
  );
}

const scratchPosition = new Cartesian3();

function dequantizePositionsTypedArray(typedArray, quantization) {
  // Draco compression is normally handled in the dequantization stage
  // in the shader, but it must be decoded here in order to project
  // the positions to 2D / CV.
  const length = typedArray.length;
  const dequantizedArray = new Float32Array(length);
  const quantizedVolumeOffset = quantization.quantizedVolumeOffset;
  const quantizedVolumeStepSize = quantization.quantizedVolumeStepSize;
  for (let i = 0; i < length; i += 3) {
    const initialPosition = Cartesian3.fromArray(
      typedArray,
      i,
      scratchPosition,
    );
    const scaledPosition = Cartesian3.multiplyComponents(
      initialPosition,
      quantizedVolumeStepSize,
      initialPosition,
    );
    const dequantizedPosition = Cartesian3.add(
      scaledPosition,
      quantizedVolumeOffset,
      scaledPosition,
    );

    dequantizedArray[i] = dequantizedPosition.x;
    dequantizedArray[i + 1] = dequantizedPosition.y;
    dequantizedArray[i + 2] = dequantizedPosition.z;
  }

  return dequantizedArray;
}

function createPositionsTypedArrayFor2D(
  attribute,
  modelMatrix,
  referencePoint,
  frameState,
) {
  let result;
  if (defined(attribute.quantization)) {
    // Dequantize the positions if necessary.
    result = dequantizePositionsTypedArray(
      attribute.typedArray,
      attribute.quantization,
    );
  } else {
    result = attribute.typedArray.slice();
  }

  const startIndex = attribute.byteOffset / Float32Array.BYTES_PER_ELEMENT;
  const length = result.length;
  const stride = defined(attribute.byteStride)
    ? attribute.byteStride / Float32Array.BYTES_PER_ELEMENT
    : 3;

  for (let i = startIndex; i < length; i += stride) {
    const initialPosition = Cartesian3.fromArray(result, i, scratchPosition);
    if (
      isNaN(initialPosition.x) ||
      isNaN(initialPosition.y) ||
      isNaN(initialPosition.z)
    ) {
      continue;
    }

    const transformedPosition = Matrix4.multiplyByPoint(
      modelMatrix,
      initialPosition,
      initialPosition,
    );

    const projectedPosition = SceneTransforms.computeActualEllipsoidPosition(
      frameState,
      transformedPosition,
      transformedPosition,
    );

    const relativePosition = Cartesian3.subtract(
      projectedPosition,
      referencePoint,
      projectedPosition,
    );

    result[i] = relativePosition.x;
    result[i + 1] = relativePosition.y;
    result[i + 2] = relativePosition.z;
  }

  return result;
}

function createPositionBufferFor2D(
  positionAttribute,
  modelMatrix,
  boundingSphere2D,
  frameState,
) {
  // Force the scene mode to be CV. In 2D, projected positions will have
  // an x-coordinate of 0, which eliminates the height data that is
  // necessary for rendering in CV mode.
  const frameStateCV = clone(frameState);
  frameStateCV.mode = SceneMode.COLUMBUS_VIEW;

  // To prevent jitter, the positions are defined relative to a common
  // reference point. For convenience, this is the center of the
  // primitive's bounding sphere in 2D.
  const referencePoint = boundingSphere2D.center;
  const projectedPositions = createPositionsTypedArrayFor2D(
    positionAttribute,
    modelMatrix,
    referencePoint,
    frameStateCV,
  );

  // Put the resulting data in a GPU buffer.
  const buffer = Buffer.createVertexBuffer({
    context: frameState.context,
    typedArray: projectedPositions,
    usage: BufferUsage.STATIC_DRAW,
  });
  buffer.vertexArrayDestroyable = false;

  return buffer;
}

// ── WebGPU accurate-2D reuse surface (NEW-MODEL-PROJECT2D-BV-MORPH / B11) ──
//
// The WebGPU model renderer cannot consume the WebGL `positionBuffer2D` (it
// builds its own GPU buffers from the retained CPU-side loader positions —
// see the `requiresVertexTypedArrayRetention` guard in `.process` above). It
// still needs the SAME per-vertex ellipsoid→projected reprojection WebGL bakes
// into `positionBuffer2D`, so the two pure math helpers are exported here for
// reuse rather than duplicated. Both force COLUMBUS_VIEW internally (matching
// `createPositionBufferFor2D`) so the resulting projected positions keep their
// height component and one buffer serves both SCENE2D (the ortho view drops the
// height) and COLUMBUS_VIEW.

const scratchCVProjected = new Cartesian3();

/**
 * Accurately project a world-space (ECEF) position into the 2D / CV projected
 * frame, forcing COLUMBUS_VIEW so the height component is retained. Used by the
 * WebGPU accurate-2D path to derive a stable per-model reference point.
 *
 * @param {FrameState} frameState The frame state.
 * @param {Cartesian3} worldPosition The world-space position.
 * @param {Cartesian3} result The object onto which to store the result.
 * @returns {Cartesian3} The projected position.
 *
 * @private
 */
export function computeReference2DPosition(frameState, worldPosition, result) {
  const frameStateCV = clone(frameState);
  frameStateCV.mode = SceneMode.COLUMBUS_VIEW;
  return SceneTransforms.computeActualEllipsoidPosition(
    frameStateCV,
    worldPosition,
    result,
  );
}

/**
 * Accurately reproject an interleaved xyz Float32 position array (already
 * dequantized, stride 3) from model space into the 2D / CV projected frame,
 * relative to a shared reference point. Mirrors the per-vertex math in the
 * WebGL `createPositionsTypedArrayFor2D` but operates on the WebGPU renderer's
 * plain positionData typed array (no quantization / stride handling needed).
 *
 * @param {Float32Array} positionData Packed xyz model-space positions.
 * @param {Matrix4} computedModelMatrix World matrix (model × node transform).
 * @param {Cartesian3} referencePoint Projected-frame reference to subtract.
 * @param {FrameState} frameState The frame state.
 * @returns {Float32Array} Projected positions relative to referencePoint.
 *
 * @private
 */
export function projectPositionsTo2D(
  positionData,
  computedModelMatrix,
  referencePoint,
  frameState,
) {
  const frameStateCV = clone(frameState);
  frameStateCV.mode = SceneMode.COLUMBUS_VIEW;
  const length = positionData.length;
  const result = new Float32Array(length);
  for (let i = 0; i + 2 < length; i += 3) {
    const initial = Cartesian3.fromArray(positionData, i, scratchPosition);
    if (isNaN(initial.x) || isNaN(initial.y) || isNaN(initial.z)) {
      continue;
    }
    const world = Matrix4.multiplyByPoint(
      computedModelMatrix,
      initial,
      initial,
    );
    const projected = SceneTransforms.computeActualEllipsoidPosition(
      frameStateCV,
      world,
      scratchCVProjected,
    );
    const relative = Cartesian3.subtract(projected, referencePoint, projected);
    result[i] = relative.x;
    result[i + 1] = relative.y;
    result[i + 2] = relative.z;
  }
  return result;
}

export default SceneMode2DPipelineStage;
