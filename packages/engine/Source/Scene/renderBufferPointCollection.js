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
import BufferPointMaterial from "./BufferPointMaterial.js";
import BlendOption from "./BlendOption.js";
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
/** @import {TypedArray} from "../Core/globalTypes.js"; */

/**
 * TODO(PR#13211): Need 'keyof' syntax to avoid duplicating attribute names.
 * @typedef {'positionHigh' | 'positionLow' | 'pickColor' | 'showSizeColorAlpha' | 'outlineWidthColorAlpha'} BufferPointAttribute
 * @ignore
 */

/**
 * Attribute locations when using 64-bit position precision.
 * @type {Record<BufferPointAttribute, number>}
 * @ignore
 */
const BufferPointAttributeLocationsFloat64 = {
  positionHigh: 0,
  positionLow: 1,
  pickColor: 2,
  showSizeColorAlpha: 3,
  outlineWidthColorAlpha: 4,
};

/**
 * Attribute locations when using <= 32-bit position precision.
 * @type {Record<string, number>}
 * @ignore
 */
const BufferPointAttributeLocations = {
  position: 0,
  pickColor: 1,
  showSizeColorAlpha: 2,
  outlineWidthColorAlpha: 3,
};

/**
 * @typedef {object} BufferPointRenderContext
 * @property {VertexArray} [vertexArray]
 * @property {Record<string, TypedArray>} [attributeArrays]
 * @property {RenderState} [renderState]
 * @property {ShaderProgram} [shaderProgram]
 * @property {DrawCommand} [command]
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
  const useFloat64 = collection._positionDatatype === ComponentDatatype.DOUBLE;
  const attributeLocations = useFloat64
    ? BufferPointAttributeLocationsFloat64
    : BufferPointAttributeLocations;

  if (!defined(renderContext.attributeArrays)) {
    const featureCountMax = collection.primitiveCountMax;

    renderContext.attributeArrays = {
      ...(useFloat64
        ? {
            positionHigh: new Float32Array(featureCountMax * 3),
            positionLow: new Float32Array(featureCountMax * 3),
          }
        : { position: collection._positionView }),
      pickColor: new Uint8Array(featureCountMax * 4),
      showSizeColorAlpha: new Float32Array(featureCountMax * 4),
      outlineWidthColorAlpha: new Float32Array(featureCountMax * 3),
    };
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
    const { attributeArrays } = renderContext;

    const positionHighArray = attributeArrays.positionHigh;
    const positionLowArray = attributeArrays.positionLow;
    const pickColorArray = attributeArrays.pickColor;
    const showSizeColorAlphaArray = attributeArrays.showSizeColorAlpha;
    const outlineWidthColorAlphaArray = attributeArrays.outlineWidthColorAlpha;

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
    // the per-primitive JS loop below. The batch RTE encode only applies to the
    // 64-bit position path (the only path that fills positionHigh/positionLow);
    // the <=32-bit path sources `position` straight from collection._positionView.
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
      useFloat64 &&
      _dirtyCount >= threshold &&
      positionView instanceof Float64Array;
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
        /** @type {Float32Array} */ (attributeArrays.positionHigh),
        /** @type {Float32Array} */ (attributeArrays.positionLow),
        _dirtyOffset,
      );
      renderContext.wasmEncodeRepacks =
        (renderContext.wasmEncodeRepacks ?? 0) + 1;
    } else if (useFloat64) {
      renderContext.scalarEncodeRepacks =
        (renderContext.scalarEncodeRepacks ?? 0) + 1;
    }

    for (let i = _dirtyOffset, il = _dirtyOffset + _dirtyCount; i < il; i++) {
      collection.get(i, point);

      if (!point._dirty) {
        continue;
      }

      // NEW-BUFFERCOLL-WASM-ENCODE-WIRE (Batch 272) — when the whole dirty range
      // was already encoded in one batch RTE call above, skip the per-primitive
      // scalar encode. Otherwise fall back to upstream's per-point encode (still
      // gated on the 64-bit position path).
      if (useFloat64 && !useBatchPositionEncode) {
        point.getPosition(cartesian);
        EncodedCartesian3.fromCartesian(cartesian, encodedCartesian);
        // @ts-expect-error https://github.com/CesiumGS/cesium/pull/13302
        Cartesian3.pack(encodedCartesian.high, positionHighArray, i * 3);
        // @ts-expect-error https://github.com/CesiumGS/cesium/pull/13302
        Cartesian3.pack(encodedCartesian.low, positionLowArray, i * 3);
      }

      point.getMaterial(material);
      Color.fromRgba(point._pickId, pickColor);

      pickColorArray[i * 4] = Color.floatToByte(pickColor.red);
      pickColorArray[i * 4 + 1] = Color.floatToByte(pickColor.green);
      pickColorArray[i * 4 + 2] = Color.floatToByte(pickColor.blue);
      pickColorArray[i * 4 + 3] = Color.floatToByte(pickColor.alpha);

      showSizeColorAlphaArray[i * 4] = point.show ? 1 : 0;
      showSizeColorAlphaArray[i * 4 + 1] = material.size;
      showSizeColorAlphaArray[i * 4 + 2] = AttributeCompression.encodeRGB8(
        material.color,
      );
      showSizeColorAlphaArray[i * 4 + 3] = material.color.alpha;

      outlineWidthColorAlphaArray[i * 3] = material.outlineWidth;
      outlineWidthColorAlphaArray[i * 3 + 1] = AttributeCompression.encodeRGB8(
        // When outlineWidth=0, overwrite outlineColor to prevent subpixel bleeding.
        material.outlineWidth > 0 ? material.outlineColor : material.color,
      );
      outlineWidthColorAlphaArray[i * 3 + 2] =
        // When outlineWidth=0, overwrite outlineAlpha to prevent subpixel bleeding.
        material.outlineWidth > 0
          ? material.outlineColor.alpha
          : material.color.alpha;

      point._dirty = false;
    }
  }

  if (!defined(renderContext.vertexArray)) {
    const { attributeArrays } = renderContext;

    renderContext.vertexArray = new VertexArray({
      context,
      attributes: [
        ...(!useFloat64
          ? [
              {
                index: BufferPointAttributeLocations.position,
                componentDatatype: collection._positionDatatype,
                componentsPerAttribute: 3,
                normalize: collection._positionNormalized,
                vertexBuffer: Buffer.createVertexBuffer({
                  typedArray: collection._positionView,
                  context,
                  usage: BufferUsage.STATIC_DRAW,
                }),
              },
            ]
          : [
              {
                index: BufferPointAttributeLocationsFloat64.positionHigh,
                componentDatatype: ComponentDatatype.FLOAT,
                componentsPerAttribute: 3,
                vertexBuffer: Buffer.createVertexBuffer({
                  typedArray: attributeArrays.positionHigh,
                  context,
                  usage: BufferUsage.STATIC_DRAW,
                }),
              },
              {
                index: BufferPointAttributeLocationsFloat64.positionLow,
                componentDatatype: ComponentDatatype.FLOAT,
                componentsPerAttribute: 3,
                vertexBuffer: Buffer.createVertexBuffer({
                  typedArray: attributeArrays.positionLow,
                  context,
                  usage: BufferUsage.STATIC_DRAW,
                }),
              },
            ]),
        {
          index: attributeLocations.pickColor,
          componentDatatype: ComponentDatatype.UNSIGNED_BYTE,
          componentsPerAttribute: 4,
          vertexBuffer: Buffer.createVertexBuffer({
            typedArray: attributeArrays.pickColor,
            context,
            usage: BufferUsage.STATIC_DRAW,
          }),
        },
        {
          index: attributeLocations.showSizeColorAlpha,
          componentDatatype: ComponentDatatype.FLOAT,
          componentsPerAttribute: 4,
          vertexBuffer: Buffer.createVertexBuffer({
            typedArray: attributeArrays.showSizeColorAlpha,
            context,
            usage: BufferUsage.STATIC_DRAW,
          }),
        },
        {
          index: attributeLocations.outlineWidthColorAlpha,
          componentDatatype: ComponentDatatype.FLOAT,
          componentsPerAttribute: 3,
          vertexBuffer: Buffer.createVertexBuffer({
            typedArray: attributeArrays.outlineWidthColorAlpha,
            context,
            usage: BufferUsage.STATIC_DRAW,
          }),
        },
      ],
    });
  } else if (collection._dirtyCount > 0) {
    for (const key in attributeLocations) {
      if (Object.hasOwn(attributeLocations, key)) {
        const attribute = /** @type {BufferPointAttribute} */ (key);
        renderContext.vertexArray.copyAttributeFromRange(
          attributeLocations[attribute],
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
      blending:
        collection._blendOption === BlendOption.OPAQUE
          ? BlendingState.DISABLED
          : BlendingState.ALPHA_BLEND,
      depthTest: { enabled: true },
    });
  }

  if (!defined(renderContext.shaderProgram)) {
    renderContext.shaderProgram = ShaderProgram.fromCache({
      context,
      vertexShaderSource: new ShaderSource({
        sources: [BufferPointMaterialVS],
        defines: useFloat64 ? ["USE_FLOAT64"] : [],
      }),
      fragmentShaderSource: new ShaderSource({
        sources: [BufferPointMaterialFS],
      }),
      attributeLocations,
    });
  }

  if (!defined(renderContext.command)) {
    renderContext.command = new DrawCommand({
      vertexArray: renderContext.vertexArray,
      renderState: renderContext.renderState,
      shaderProgram: renderContext.shaderProgram,
      primitiveType: PrimitiveType.POINTS,
      pass:
        collection._blendOption === BlendOption.OPAQUE
          ? Pass.OPAQUE
          : Pass.TRANSLUCENT,
      pickId: collection._allowPicking ? "v_pickColor" : undefined,
      owner: collection,
      count: collection.primitiveCount,
      modelMatrix: collection.modelMatrix, // shared reference
      boundingVolume: collection.boundingVolume, // shared reference
      debugShowBoundingVolume: collection.debugShowBoundingVolume,
    });
  }

  const command = renderContext.command;

  if (command.count !== collection.primitiveCount) {
    command.count = collection.primitiveCount;
  }

  if (command.debugShowBoundingVolume !== collection.debugShowBoundingVolume) {
    command.debugShowBoundingVolume = collection.debugShowBoundingVolume;
  }

  frameState.commandList.push(command);

  collection._makeClean();

  return renderContext;
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

  // NEW-BUFFERCOLL-WASM-ENCODE-WIRE (Batch 272) — release the RTE bridge handle.
  // destroy() is idempotent and the WASM module is shared across bridges.
  if (defined(context.rteBridge)) {
    context.rteBridge.destroy();
  }
}

export default renderBufferPointCollection;
