// @ts-check

import Frozen from "../Core/Frozen.js";
import defined from "../Core/defined.js";
import Cartesian3 from "../Core/Cartesian3.js";
import Cartographic from "../Core/Cartographic.js";
import EncodedCartesian3 from "../Core/EncodedCartesian3.js";
import BufferPrimitiveMaterial from "./BufferPrimitiveMaterial.js";

/** @import Color from "../Core/Color.js"; */
/** @import { TypedArray } from "../Core/globalTypes.js"; */
/** @import MapProjection from "../Core/MapProjection.js"; */
/** @import BufferPolygon from "./BufferPolygon.js"; */

/**
 * @typedef {object} BufferPolygonMaterialOptions
 * @property {Color} [color=Color.WHITE] Color of fill.
 * @property {Color} [outlineColor=Color.WHITE] Color of outline.
 * @property {number} [outlineWidth=0.0] Width of outline, 0-255px.
 */

/**
 * CPU-side reprojected SCENE2D / COLUMBUS_VIEW vertex data for a BufferPolygon
 * collection, mirroring the Vector3DTile classifier's reprojected-ENU buffer
 * (NEW-CLASSIFIER-2D-CV-MORPH). Each position is the planar ENU
 * <code>(height, projX, projY)</code> of the 3D ECEF input, expressed
 * relative-to-eye via {@link EncodedCartesian3} (RTE high/low Float32 pairs)
 * and RTC-relative to {@link BufferPolygon2DReprojection#center2D} so a
 * follow-up renderer batch can bind it with the same mode-agnostic vertex math
 * used for the 3D path. Producer-half only — the renderer-side bind is the
 * named follow-up (batch-bufferprimitive-parity).
 *
 * @typedef {object} BufferPolygon2DReprojection
 * @property {Cartesian3} center2D ENU center the per-vertex positions are
 *   expressed relative to, i.e. the projected collection center swizzled to the
 *   ENU <code>(height, projX, projY)</code> frame. Packed RTC-relative to the
 *   camera by the consuming renderer.
 * @property {Float32Array} positionHigh High bits of the per-vertex
 *   RTC-relative ENU positions, three (3) components per vertex.
 * @property {Float32Array} positionLow Low bits of the per-vertex RTC-relative
 *   ENU positions, three (3) components per vertex.
 * @property {number} vertexCount Number of VEC3 vertices encoded.
 * @ignore
 */

/**
 * Material description for a {@link BufferPolygon}.
 *
 * <p>BufferPolygonMaterial objects are {@link Packable|packable}, stored
 * when calling {@link BufferPolygon#setMaterial}. Subsequent changes to the
 * material will not affect the polygon until setMaterial() is called again.</p>
 *
 * @experimental This feature is not final and is subject to change without Cesium's standard deprecation policy.
 * @extends BufferPrimitiveMaterial
 */
class BufferPolygonMaterial extends BufferPrimitiveMaterial {
  /**
   * @type {BufferPolygonMaterial}
   * @ignore
   */
  static DEFAULT_MATERIAL = Object.freeze(new BufferPolygonMaterial());

  /**
   * @param {BufferPolygonMaterialOptions} [options]
   */
  constructor(options = Frozen.EMPTY_OBJECT) {
    super(options);
  }

  /**
   * Reprojects a collection's 3D ECEF positions into the planar SCENE2D /
   * COLUMBUS_VIEW ENU frame, mirroring the Vector3DTile classifier's
   * CPU-reprojected ENU buffer path (NEW-CLASSIFIER-2D-CV-MORPH).
   *
   * <p>Unlike the {@link GeometryPipeline.projectTo2D} primitive path (which
   * owns a <code>position</code> attribute it can split into
   * <code>position2DHigh/Low</code>), a BufferPolygon collection carries only
   * the 3D ECEF positions, so the 2D positions are derived here:
   * <code>cartesianToCartographic</code> &rarr; <code>projection.project</code>
   * &rarr; <code>(projX, projY, height)</code> &rarr; ENU
   * <code>(height, projX, projY)</code>, RTE-encoded and RTC-relative to a
   * single ENU center so the renderer can reuse the same mode-agnostic
   * vertex math used for the 3D path (camera-relative high/low add).</p>
   *
   * <p>This is the producer half: the result is stashed by the caller for a
   * follow-up renderer batch to upload + bind. It does NOT change the SCENE3D
   * vertex path — those positions still flow through the
   * <code>positionHigh/Low</code> attributes built in
   * <code>renderBufferPolygonCollection</code> directly from the 3D ECEF
   * cartesians.</p>
   *
   * @param {TypedArray} positions3D Tightly-packed 3D ECEF positions, three (3)
   *   components per vertex (the collection's <code>_positionView</code>).
   * @param {number} vertexCount Number of VEC3 vertices in
   *   <code>positions3D</code> to reproject.
   * @param {MapProjection} [projection] The scene's active map projection
   *   (<code>frameState.mapProjection</code>); supplies both the ellipsoid and
   *   the planar projection. When unavailable (e.g. <code>scene3DOnly</code>),
   *   pass nothing and this returns <code>undefined</code>.
   * @param {BufferPolygon2DReprojection} [result] Reused result. Its typed
   *   arrays are reallocated only when too small for <code>vertexCount</code>.
   * @returns {BufferPolygon2DReprojection|undefined} The reprojected ENU data,
   *   or <code>undefined</code> when no projection/ellipsoid is available or the
   *   collection has no vertices.
   * @ignore
   */
  static computeReprojected2DPositions(
    positions3D,
    vertexCount,
    projection,
    result,
  ) {
    const ellipsoid = projection?.ellipsoid;
    if (!defined(projection) || !defined(ellipsoid) || vertexCount <= 0) {
      return undefined;
    }

    // 2D center = ENU of the FIRST vertex's projected coordinates. Using an
    // in-collection vertex (rather than a synthetic origin) keeps the
    // RTC-relative offsets small and the float32 encode well-conditioned,
    // matching the classifier's "center is a real projected point" approach.
    scratchReproject2DWorld.x = positions3D[0];
    scratchReproject2DWorld.y = positions3D[1];
    scratchReproject2DWorld.z = positions3D[2];
    const centerCarto = ellipsoid.cartesianToCartographic(
      scratchReproject2DWorld,
      scratchReproject2DCarto,
    );
    if (!defined(centerCarto)) {
      // Center at the ellipsoid's center / degenerate — no usable 2D frame.
      return undefined;
    }
    const centerProj = projection.project(centerCarto, scratchReproject2DProj);
    // ENU frame: (height, projX, projY) = projected.(z, x, y). The `.zxy`
    // swizzle is applied here on the CPU (matching the Vector3DTile classifier
    // reference), so the consuming renderer binds these positions WITHOUT a
    // further shader-side swizzle — the 2D/CV world frame is x=up(height),
    // y=easting(projX), z=northing(projY).
    scratchReproject2DCenter.x = centerProj.z;
    scratchReproject2DCenter.y = centerProj.x;
    scratchReproject2DCenter.z = centerProj.y;

    result = result ?? {
      center2D: new Cartesian3(),
      positionHigh: new Float32Array(0),
      positionLow: new Float32Array(0),
      vertexCount: 0,
    };

    Cartesian3.clone(scratchReproject2DCenter, result.center2D);

    const componentCount = vertexCount * 3;
    if (result.positionHigh.length < componentCount) {
      result.positionHigh = new Float32Array(componentCount);
      result.positionLow = new Float32Array(componentCount);
    }
    result.vertexCount = vertexCount;

    const positionHigh = result.positionHigh;
    const positionLow = result.positionLow;
    const cx = scratchReproject2DCenter.x;
    const cy = scratchReproject2DCenter.y;
    const cz = scratchReproject2DCenter.z;

    for (let i = 0; i < vertexCount; i++) {
      const src = i * 3;
      scratchReproject2DWorld.x = positions3D[src];
      scratchReproject2DWorld.y = positions3D[src + 1];
      scratchReproject2DWorld.z = positions3D[src + 2];

      const carto = ellipsoid.cartesianToCartographic(
        scratchReproject2DWorld,
        scratchReproject2DCarto,
      );
      const dst = src;
      if (!defined(carto)) {
        // Degenerate vertex (shouldn't happen for real geometry); collapse to
        // the 2D center so it contributes nothing rather than emitting NaN.
        positionHigh[dst] = 0.0;
        positionHigh[dst + 1] = 0.0;
        positionHigh[dst + 2] = 0.0;
        positionLow[dst] = 0.0;
        positionLow[dst + 1] = 0.0;
        positionLow[dst + 2] = 0.0;
        continue;
      }

      const proj = projection.project(carto, scratchReproject2DProj);
      // ENU (height, projX, projY) then RTC-relative to the 2D center, then
      // RTE-encoded into high/low float32 pairs to preserve 64-bit precision
      // (never collapse to a single float32 position).
      scratchReproject2DEnu.x = proj.z - cx;
      scratchReproject2DEnu.y = proj.x - cy;
      scratchReproject2DEnu.z = proj.y - cz;
      EncodedCartesian3.fromCartesian(
        scratchReproject2DEnu,
        scratchReproject2DEncoded,
      );

      positionHigh[dst] = scratchReproject2DEncoded.high.x;
      positionHigh[dst + 1] = scratchReproject2DEncoded.high.y;
      positionHigh[dst + 2] = scratchReproject2DEncoded.high.z;
      positionLow[dst] = scratchReproject2DEncoded.low.x;
      positionLow[dst + 1] = scratchReproject2DEncoded.low.y;
      positionLow[dst + 2] = scratchReproject2DEncoded.low.z;
    }

    return result;
  }
}

// Scratch variables for the SCENE2D / COLUMBUS_VIEW reprojection. Reused
// across calls; the helper is single-threaded per frame and never re-enters.
const scratchReproject2DWorld = new Cartesian3();
const scratchReproject2DCarto = new Cartographic();
const scratchReproject2DProj = new Cartesian3();
const scratchReproject2DCenter = new Cartesian3();
const scratchReproject2DEnu = new Cartesian3();
const scratchReproject2DEncoded = new EncodedCartesian3();

export default BufferPolygonMaterial;
