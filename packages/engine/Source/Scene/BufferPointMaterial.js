// @ts-check

import Frozen from "../Core/Frozen.js";
import ComponentDatatype from "../Core/ComponentDatatype.js";
import oneTimeWarning from "../Core/oneTimeWarning.js";
import BufferPrimitiveMaterial from "./BufferPrimitiveMaterial.js";

/** @import Color from "../Core/Color.js"; */
/** @import BufferPoint from "./BufferPoint.js"; */

/**
 * @typedef {object} BufferPointMaterialOptions
 * @property {Color} [color=Color.WHITE] Color of fill.
 * @property {Color} [outlineColor=Color.WHITE] Color of outline.
 * @property {number} [outlineWidth=0.0] Width of outline, 0-255px.
 * @property {number} [size=1.0] Size of point, 0-255px.
 */

/**
 * Material description for a {@link BufferPoint}.
 *
 * <p>BufferPointMaterial objects are {@link Packable|packable}, stored
 * when calling {@link BufferPoint#setMaterial}. Subsequent changes to the
 * material will not affect the point until setMaterial() is called again.</p>
 *
 * @experimental This feature is not final and is subject to change without Cesium's standard deprecation policy.
 * @extends BufferPrimitiveMaterial
 */
class BufferPointMaterial extends BufferPrimitiveMaterial {
  /** @ignore */
  static Layout = {
    ...BufferPrimitiveMaterial.Layout,
    SIZE_U8: BufferPrimitiveMaterial.Layout.__BYTE_LENGTH,
    __BYTE_LENGTH: BufferPrimitiveMaterial.Layout.__BYTE_LENGTH + 4,
  };

  /**
   * @type {BufferPointMaterial}
   * @ignore
   */
  static DEFAULT_MATERIAL = Object.freeze(new BufferPointMaterial());

  /**
   * @param {BufferPointMaterialOptions} [options]
   */
  constructor(options = Frozen.EMPTY_OBJECT) {
    super(options);

    /**
     * Size of point, 0-255px.
     * @type {number}
     */
    this.size = options.size ?? 1;
  }

  /**
   * @override
   * @param {BufferPointMaterial} material
   * @param {DataView} view
   * @param {number} byteOffset
   * @override
   */
  static pack(material, view, byteOffset) {
    super.pack(material, view, byteOffset);
    view.setUint8(this.Layout.SIZE_U8 + byteOffset, material.size);
  }

  /**
   * @override
   * @param {DataView} view
   * @param {number} byteOffset
   * @param {BufferPointMaterial} result
   * @returns {BufferPointMaterial}
   * @override
   */
  static unpack(view, byteOffset, result) {
    super.unpack(view, byteOffset, result);
    result.size = view.getUint8(this.Layout.SIZE_U8 + byteOffset);
    return result;
  }

  /////////////////////////////////////////////////////////////////////////////
  // POSITION-ENCODING DETECTION

  /**
   * Reports whether a {@link BufferPointCollection} is using a position layout
   * that the renderers do not yet support equivalently across backends.
   *
   * <p>The 64-bit (<code>ComponentDatatype.DOUBLE</code>, non-normalized) path
   * is the only layout currently wired through every renderer with full RTE
   * precision: positions are split into <code>positionHigh</code> /
   * <code>positionLow</code> f32 lanes and reconstructed relative-to-eye in the
   * shader. Integer position datatypes (BYTE / UNSIGNED_BYTE / SHORT /
   * UNSIGNED_SHORT) and the <code>positionNormalized</code> snorm/unorm
   * interpretation require a SECOND, non-RTE pipeline + vertex-layout variant
   * that is owned by the renderer-side follow-up
   * (<code>batch-bufferprimitive-parity</code>; the §5 P2
   * "positionNormalized + integer position datatypes" row). Until that variant
   * lands, the WebGPU renderer would feed the integer store into the f64
   * high/low RTE encode path, silently mis-encoding the integer values as
   * Cartesian coordinates — points render in the wrong place with no error.</p>
   *
   * <p>This helper lets renderers (and the parity probe) detect that gap and
   * surface it explicitly — a flag the caller can branch on plus a one-time,
   * debug-only diagnostic — instead of corrupting the geometry quietly. It does
   * NOT change encoding behavior; the WebGL renderer already handles the
   * integer / normalized layout correctly via the vertex-buffer
   * <code>componentDatatype</code> / <code>normalize</code> attributes, so this
   * is purely diagnostic and leaves the DOUBLE path untouched.</p>
   *
   * @param {ComponentDatatype} positionDatatype The collection's position component datatype.
   * @param {boolean} [positionNormalized=false] The collection's <code>positionNormalized</code> flag.
   * @returns {boolean} <code>true</code> when the layout is NOT the fully-supported
   *   64-bit non-normalized layout (i.e. integer datatype and/or normalized).
   * @ignore
   */
  static detectUnsupportedPositionEncoding(
    positionDatatype,
    positionNormalized = false,
  ) {
    const unsupported =
      positionDatatype !== ComponentDatatype.DOUBLE ||
      positionNormalized === true;

    //>>includeStart('debug', pragmas.debug);
    if (unsupported) {
      oneTimeWarning(
        "BufferPointMaterial-position-encoding-unsupported",
        `[CesiumJS:BufferPoint] positionDatatype=${positionDatatype}` +
          ` positionNormalized=${positionNormalized}: integer / normalized ` +
          `position layouts are not yet wired through the full-precision RTE ` +
          `renderers. Only ComponentDatatype.DOUBLE (non-normalized) is fully ` +
          `supported on both backends today; the snorm/unorm non-RTE pipeline ` +
          `variant is the named follow-up (batch-bufferprimitive-parity, §5 P2). ` +
          `Points may render in the wrong position until it lands.`,
      );
    }
    //>>includeEnd('debug');

    return unsupported;
  }

  /////////////////////////////////////////////////////////////////////////////
  // DEBUG

  /**
   * Returns a JSON-serializable object representing the material. This encoding
   * is not memory-efficient, and should generally be used for debugging and
   * testing.
   *
   * @returns {Object} JSON-serializable object.
   */
  toJSON() {
    return { ...super.toJSON(), size: this.size };
  }
}

export default BufferPointMaterial;
