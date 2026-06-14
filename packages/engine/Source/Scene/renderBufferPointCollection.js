// @ts-check

import defined from "../Core/defined.js";
import Cartesian3 from "../Core/Cartesian3.js";
import Color from "../Core/Color.js";
import BufferPoint from "./BufferPoint.js";
import Buffer from "../Renderer/Buffer.js";
import BufferUsage from "../Renderer/BufferUsage.js";
import VertexArray from "../Renderer/VertexArray.js";
import ComponentDatatype from "../Core/ComponentDatatype.js";
import RenderState from "../Renderer/RenderState.js";
import BlendingState from "./BlendingState.js";
import ShaderSource from "../Renderer/ShaderSource.js";
import ShaderProgram from "../Renderer/ShaderProgram.js";
import DrawCommand from "../Renderer/DrawCommand.js";
import Pass from "../Renderer/Pass.js";
import PrimitiveType from "../Core/PrimitiveType.js";
import BufferPointMaterialVS from "../Shaders/BufferPointMaterialVS.js";
import BufferPointMaterialFS from "../Shaders/BufferPointMaterialFS.js";
import EncodedCartesian3 from "../Core/EncodedCartesian3.js";
import AttributeCompression from "../Core/AttributeCompression.js";
import Matrix4 from "../Core/Matrix4.js";
import BoundingSphere from "../Core/BoundingSphere.js";
import BufferPointMaterial from "./BufferPointMaterial.js";
import WasmRTEBridge from "./WasmRTEBridge.js";

// NEW-BUFFERCOLL-WASM-ENCODE-WIRE (Batch 272) / NEW-BUFFERCOLL-ENCODE-BENCHMARK
// (Batch 273) — minimum dirty primitive count before routing the POSITION
// high/low encode through the batch RTE path (one contiguous `batchEncodeRange`
// call: WASM kernel when loaded, byte-identical scalar fround twin otherwise)
// instead of the per-primitive scalar EncodedCartesian3 loop. Mirrors the WebGPU
// renderer's BUFFER_WASM_ENCODE_THRESHOLD (kept in lock-step — both tuned to
// 2000 from the Batch-273 benchmark). The win is the encode-hoist out of the
// per-primitive loop, measured ~25-40% faster end-to-end at >= 1500 points on
// BOTH backends; see Tools/visual-regression/probe-buffercoll-encode-benchmark.mjs
// + Tools/wasm-encode-benchmark.mjs for the data and crossover rationale.
const BUFFER_WASM_ENCODE_THRESHOLD = 2000;

/** @import FrameState from "./FrameState.js"; */
/** @import BufferPointCollection from "./BufferPointCollection.js"; */
/** @import {Destroyable, TypedArray} from "../Core/globalTypes.js"; */

/**
 * TODO(PR#13211): Need 'keyof' syntax to avoid duplicating attribute names.
 * @typedef {'positionHigh' | 'positionLow' | 'pickColor' | 'showSizeAndColor' | 'outlineWidthAndOutlineColor'} BufferPointAttribute
 * @ignore
 */

/**
 * @type {Record<BufferPointAttribute, number>}
 * @ignore
 */
const BufferPointAttributeLocations = {
  positionHigh: 0,
  positionLow: 1,
  pickColor: 2,
  showSizeAndColor: 3,
  outlineWidthAndOutlineColor: 4,
};

/**
 * @typedef {object} BufferPointRenderContext
 * @property {VertexArray} [vertexArray]
 * @property {Record<BufferPointAttribute, TypedArray>} [attributeArrays]
 * @property {RenderState} [renderState]
 * @property {ShaderProgram} [shaderProgram]
 * @property {DrawCommand} [command]
 * @property {Destroyable[]} [pickIds] Unordered list of collection PickIds.
 * @property {WasmRTEBridge} [rteBridge] Lazily-created bridge for the threshold-gated WASM batch position encode.
 * @property {number} [wasmEncodeRepacks] Instrumentation: repacks that took the WASM/batch position path.
 * @property {number} [scalarEncodeRepacks] Instrumentation: repacks that took the scalar position path.
 * @property {number} [_repackMsLast] Debug-only (Batch 273): last repack+upload duration in ms.
 * @property {number} [_repackMsTotal] Debug-only (Batch 273): cumulative repack+upload ms across frames.
 * @property {number} [_repackSamples] Debug-only (Batch 273): number of timed repack frames.
 * @property {Function} destroy
 * @ignore
 */

// Scratch variables.
const point = new BufferPoint();
const material = new BufferPointMaterial();
const pickColor = new Color();
const cartesian = new Cartesian3();
const encodedCartesian = new EncodedCartesian3();

/**
 * @param {BufferPointCollection} collection
 * @param {FrameState} frameState
 * @param {BufferPointRenderContext} [renderContext]
 * @returns {BufferPointRenderContext}
 * @ignore
 */
function renderBufferPointCollection(collection, frameState, renderContext) {
  const context = frameState.context;
  renderContext = renderContext || { destroy: destroyRenderContext };

  if (!defined(renderContext.attributeArrays)) {
    const featureCountMax = collection.primitiveCountMax;

    renderContext.attributeArrays = {
      positionHigh: new Float32Array(featureCountMax * 3),
      positionLow: new Float32Array(featureCountMax * 3),
      pickColor: new Uint8Array(featureCountMax * 4),
      showSizeAndColor: new Float32Array(featureCountMax * 3),
      outlineWidthAndOutlineColor: new Float32Array(featureCountMax * 2),
    };
  }

  if (!defined(renderContext.pickIds)) {
    renderContext.pickIds = [];
  }

  // NEW-BUFFERCOLL-ENCODE-BENCHMARK (Batch 273) — repack+upload timer. Captured
  // at the start of the dirty repack and read after the copyAttributeFromRange
  // upload below so the benchmark probe sees position-encode + GPU-upload cost
  // together. Debug-only: pragma-stripped from production builds.
  //>>includeStart('debug', pragmas.debug);
  let _repackT0 = 0;
  if (collection._dirtyCount > 0) {
    _repackT0 = performance.now();
  }
  //>>includeEnd('debug');

  if (collection._dirtyCount > 0) {
    const { attributeArrays, pickIds } = renderContext;

    const positionHighArray = attributeArrays.positionHigh;
    const positionLowArray = attributeArrays.positionLow;
    const pickColorArray = attributeArrays.pickColor;
    const showSizeAndColorArray = attributeArrays.showSizeAndColor;
    const outlineWidthAndOutlineColorArray =
      attributeArrays.outlineWidthAndOutlineColor;

    const { _dirtyOffset, _dirtyCount } = collection;

    // NEW-BUFFERCOLL-WASM-ENCODE-WIRE (Batch 272) — for large dirty ranges,
    // encode the POSITION high/low lanes for the whole contiguous slice in one
    // WASM batch call (SIMD when ready, byte-equivalent scalar fallback before).
    // Points have vertexOffset == index, so collection._positionView[i*3..] is
    // contiguous over the dirty range and maps 1:1 onto positionHighArray[i*3..].
    // The batch (fround) and scalar EncodedCartesian3 (AGI 65536-grid) splits
    // produce different high/low bytes but the same eye-space position after the
    // shader's RTE reconstruction (both satisfy high+low == value in f64), so the
    // rendered result is unchanged. Color / pick / outline interleave stays in
    // the per-primitive JS loop below.
    const positionView = collection._positionView;
    // Honor an optional per-collection threshold override so the parity probe
    // can force the SAME large collection onto the scalar path
    // (override = Number.POSITIVE_INFINITY) or batch path (override = 0).
    const thresholdOverride =
      /** @type {{_wasmEncodeThresholdOverride?: number}} */ (collection)
        ._wasmEncodeThresholdOverride;
    const threshold =
      typeof thresholdOverride === "number"
        ? thresholdOverride
        : BUFFER_WASM_ENCODE_THRESHOLD;
    const useBatchPositionEncode =
      _dirtyCount >= threshold && positionView instanceof Float64Array;
    if (useBatchPositionEncode) {
      let bridge = renderContext.rteBridge;
      if (!defined(bridge)) {
        bridge = new WasmRTEBridge();
        renderContext.rteBridge = bridge;
        // Fire-and-forget: until the module resolves, batchEncodeRange uses the
        // byte-equivalent scalar fallback, so there is no visible pop on the
        // first frames. The module-level ready flag is shared across bridges.
        void bridge.loadWasm();
      }
      bridge.batchEncodeRange(
        positionView,
        _dirtyOffset,
        _dirtyCount,
        /** @type {Float32Array} */ (positionHighArray),
        /** @type {Float32Array} */ (positionLowArray),
        _dirtyOffset,
      );
      renderContext.wasmEncodeRepacks =
        (renderContext.wasmEncodeRepacks ?? 0) + 1;
    } else {
      renderContext.scalarEncodeRepacks =
        (renderContext.scalarEncodeRepacks ?? 0) + 1;
    }

    for (let i = _dirtyOffset, il = _dirtyOffset + _dirtyCount; i < il; i++) {
      collection.get(i, point);

      if (!point._dirty) {
        continue;
      }

      if (collection._allowPicking && point._pickId === 0) {
        const pickIdOwner = {
          collection,
          index: i,
          get primitive() {
            // Cannot reuse primitives; scene.drillPick() appends to a list.
            return collection.get(this.index, new BufferPoint());
          },
        };
        const pickId = context.createPickId(pickIdOwner, "buffer-primitive");
        point._pickId = pickId.key;
        pickIds.push(pickId);
      }

      if (!useBatchPositionEncode) {
        point.getPosition(cartesian);
        EncodedCartesian3.fromCartesian(cartesian, encodedCartesian);

        positionHighArray[i * 3] = encodedCartesian.high.x;
        positionHighArray[i * 3 + 1] = encodedCartesian.high.y;
        positionHighArray[i * 3 + 2] = encodedCartesian.high.z;

        positionLowArray[i * 3] = encodedCartesian.low.x;
        positionLowArray[i * 3 + 1] = encodedCartesian.low.y;
        positionLowArray[i * 3 + 2] = encodedCartesian.low.z;
      }

      point.getMaterial(material);
      Color.fromRgba(point._pickId, pickColor);

      pickColorArray[i * 4] = Color.floatToByte(pickColor.red);
      pickColorArray[i * 4 + 1] = Color.floatToByte(pickColor.green);
      pickColorArray[i * 4 + 2] = Color.floatToByte(pickColor.blue);
      pickColorArray[i * 4 + 3] = Color.floatToByte(pickColor.alpha);

      showSizeAndColorArray[i * 3] = point.show ? 1 : 0;
      showSizeAndColorArray[i * 3 + 1] = material.size;
      showSizeAndColorArray[i * 3 + 2] = AttributeCompression.encodeRGB8(
        material.color,
      );

      outlineWidthAndOutlineColorArray[i * 2] = material.outlineWidth;
      outlineWidthAndOutlineColorArray[i * 2 + 1] =
        AttributeCompression.encodeRGB8(material.outlineColor);

      point._dirty = false;
    }
  }

  if (!defined(renderContext.vertexArray)) {
    const { attributeArrays } = renderContext;

    renderContext.vertexArray = new VertexArray({
      context,
      attributes: [
        {
          index: BufferPointAttributeLocations.positionHigh,
          componentDatatype: ComponentDatatype.FLOAT,
          componentsPerAttribute: 3,
          vertexBuffer: Buffer.createVertexBuffer({
            typedArray: attributeArrays.positionHigh,
            context,
            // @ts-expect-error Requires https://github.com/CesiumGS/cesium/pull/13203.
            usage: BufferUsage.STATIC_DRAW,
          }),
        },
        {
          index: BufferPointAttributeLocations.positionLow,
          componentDatatype: ComponentDatatype.FLOAT,
          componentsPerAttribute: 3,
          vertexBuffer: Buffer.createVertexBuffer({
            typedArray: attributeArrays.positionLow,
            context,
            // @ts-expect-error Requires https://github.com/CesiumGS/cesium/pull/13203.
            usage: BufferUsage.STATIC_DRAW,
          }),
        },
        {
          index: BufferPointAttributeLocations.pickColor,
          componentDatatype: ComponentDatatype.UNSIGNED_BYTE,
          componentsPerAttribute: 4,
          vertexBuffer: Buffer.createVertexBuffer({
            typedArray: attributeArrays.pickColor,
            context,
            // @ts-expect-error Requires https://github.com/CesiumGS/cesium/pull/13203.
            usage: BufferUsage.STATIC_DRAW,
          }),
        },
        {
          index: BufferPointAttributeLocations.showSizeAndColor,
          componentDatatype: ComponentDatatype.FLOAT,
          componentsPerAttribute: 3,
          vertexBuffer: Buffer.createVertexBuffer({
            typedArray: attributeArrays.showSizeAndColor,
            context,
            // @ts-expect-error Requires https://github.com/CesiumGS/cesium/pull/13203.
            usage: BufferUsage.STATIC_DRAW,
          }),
        },
        {
          index: BufferPointAttributeLocations.outlineWidthAndOutlineColor,
          componentDatatype: ComponentDatatype.FLOAT,
          componentsPerAttribute: 2,
          vertexBuffer: Buffer.createVertexBuffer({
            typedArray: attributeArrays.outlineWidthAndOutlineColor,
            context,
            // @ts-expect-error Requires https://github.com/CesiumGS/cesium/pull/13203.
            usage: BufferUsage.STATIC_DRAW,
          }),
        },
      ],
    });
  } else if (collection._dirtyCount > 0) {
    for (const key in BufferPointAttributeLocations) {
      if (Object.hasOwn(BufferPointAttributeLocations, key)) {
        const attribute = /** @type {BufferPointAttribute} */ (key);
        renderContext.vertexArray.copyAttributeFromRange(
          BufferPointAttributeLocations[attribute],
          renderContext.attributeArrays[attribute],
          collection._dirtyOffset,
          collection._dirtyCount,
        );
      }
    }
  }

  // NEW-BUFFERCOLL-ENCODE-BENCHMARK (Batch 273) — record the repack+upload
  // duration captured above (debug-only; stripped from production builds).
  //>>includeStart('debug', pragmas.debug);
  if (_repackT0 !== 0) {
    const _repackDt = performance.now() - _repackT0;
    renderContext._repackMsLast = _repackDt;
    renderContext._repackMsTotal =
      (renderContext._repackMsTotal ?? 0) + _repackDt;
    renderContext._repackSamples = (renderContext._repackSamples ?? 0) + 1;
  }
  //>>includeEnd('debug');

  if (!defined(renderContext.renderState)) {
    renderContext.renderState = RenderState.fromCache({
      blending: BlendingState.ALPHA_BLEND,
      depthTest: { enabled: true },
    });
  }

  if (!defined(renderContext.shaderProgram)) {
    renderContext.shaderProgram = ShaderProgram.fromCache({
      context,
      vertexShaderSource: new ShaderSource({
        sources: [BufferPointMaterialVS],
      }),
      fragmentShaderSource: new ShaderSource({
        sources: [BufferPointMaterialFS],
      }),
      attributeLocations: BufferPointAttributeLocations,
    });
  }

  if (
    !defined(renderContext.command) ||
    isCommandDirty(collection, renderContext.command)
  ) {
    renderContext.command = new DrawCommand({
      vertexArray: renderContext.vertexArray,
      renderState: renderContext.renderState,
      shaderProgram: renderContext.shaderProgram,
      primitiveType: PrimitiveType.POINTS,
      pass: Pass.OPAQUE,
      pickId: "v_pickColor",
      owner: collection,
      count: collection.primitiveCount,
      modelMatrix: collection.modelMatrix,
      boundingVolume: collection.boundingVolumeWC,
      debugShowBoundingVolume: collection.debugShowBoundingVolume,
    });
  }

  frameState.commandList.push(renderContext.command);

  collection._dirtyCount = 0;
  collection._dirtyOffset = 0;

  return renderContext;
}

/**
 * Returns true if DrawCommand is out of date for the given collection.
 * @param {BufferPointCollection} collection
 * @param {DrawCommand} command
 * @ignore
 */
function isCommandDirty(collection, command) {
  const isModelMatrixEqual = Matrix4.equals(
    collection.modelMatrix,
    command._modelMatrix,
  );

  const isBoundingVolumeEqual = BoundingSphere.equals(
    collection.boundingVolumeWC,
    command._boundingVolume,
  );

  return (
    collection.primitiveCount !== command._count ||
    collection.debugShowBoundingVolume !== command.debugShowBoundingVolume ||
    !isModelMatrixEqual ||
    !isBoundingVolumeEqual
  );
}

/**
 * Destroys render context resources. Deleting properties from the context
 * object isn't necessary, as collection.destroy() will discard the object.
 * @ignore
 */
function destroyRenderContext() {
  const context = /** @type {BufferPointRenderContext} */ (this);

  if (defined(context.vertexArray)) {
    context.vertexArray.destroy();
  }

  if (defined(context.shaderProgram)) {
    context.shaderProgram.destroy();
  }

  if (defined(context.renderState)) {
    RenderState.releaseCache(context.renderState);
  }

  if (defined(context.pickIds)) {
    for (const pickId of context.pickIds) {
      pickId.destroy();
    }
  }

  // NEW-BUFFERCOLL-WASM-ENCODE-WIRE (Batch 272) — release the RTE bridge handle.
  // destroy() is idempotent and the WASM module is shared across bridges.
  if (defined(context.rteBridge)) {
    context.rteBridge.destroy();
  }
}

export default renderBufferPointCollection;
