import Cartesian3 from "../Core/Cartesian3.js";
import Cartographic from "../Core/Cartographic.js";
import defined from "../Core/defined.js";
import CesiumMath from "../Core/Math.js";
import Rectangle from "../Core/Rectangle.js";

/**
 * CPU packing for the signed-distance-field (SDF) clipping-polygon path.
 *
 * CesiumJS 1.145 replaced the SDF clipping algorithm with vector clipping and
 * deleted this packing code from {@link ClippingPolygonCollection} and
 * {@link ClippingPolygon}. The fork's WebGPU backend still runs the SDF
 * algorithm (`PolygonSignedDistance.wgsl`), so the packing half is kept here,
 * in a fork-owned module, rather than inside the two upstream-tracked
 * <code>Scene/</code> files where it would re-conflict at every upstream sync.
 *
 * This module is backend-neutral by contract: it imports nothing from
 * <code>Renderer/WebGPU/</code> and never branches on the active backend. The
 * <code>CLIPPING_POLYGONS</code> feature renderer calls into it, never the
 * reverse.
 *
 * The packing convention — spherical <code>fastApproximateAtan2</code>
 * coordinates and merged-extent groups — is what
 * <code>PolygonSignedDistance.wgsl</code> decodes and what
 * <code>Tools/visual-regression/probe-globe-clippoly-geodetic.mjs</code>
 * pixel-gates. Changing any field order or units here changes rendered pixels.
 *
 * @module ClippingPolygonSdfPack
 * @private
 */

/**
 * Reads the collection's polygons through its public accessors, so this module
 * does not depend on the private entry shape upstream keeps changing.
 *
 * @param {ClippingPolygonCollection} collection
 * @returns {ClippingPolygon[]}
 * @private
 */
function getPolygons(collection) {
  const length = collection.length;
  const polygons = new Array(length);
  for (let i = 0; i < length; ++i) {
    polygons[i] = collection.get(i);
  }
  return polygons;
}

/**
 * The SDF pack walks the outer ring only. `ClippingPolygon.length` counts the
 * holes 1.145 added as well, and the SDF algorithm has no hole support, so
 * using it would write a vertex count the position list does not match.
 *
 * @param {ClippingPolygon} polygon
 * @returns {number} The number of outer-ring vertices.
 * @private
 */
function outerRingLength(polygon) {
  return polygon.positions.length;
}

/**
 * Computes a rectangle with the spherical extents that encloses the polygon defined by the list of positions, including cases over the international date line and the poles.
 *
 * @param {ClippingPolygon} polygon The polygon to compute spherical extents for.
 * @param {Rectangle} [result] An object in which to store the result.
 * @returns {Rectangle} The result rectangle with spherical extents.
 *
 * @private
 */
function computeSphericalExtents(polygon, result) {
  if (!defined(result)) {
    result = new Rectangle();
  }

  // `polygon.rectangle` is the same value the pre-1.145 `computeRectangle()`
  // returned, precomputed once at construction. Reading the property avoids the
  // deprecation warning the method now emits on every call.
  const rectangle = polygon.rectangle;

  let spherePoint = Cartographic.toCartesian(
    Rectangle.southwest(rectangle),
    polygon.ellipsoid,
    spherePointScratch,
  );

  // Project into plane with vertical for latitude
  let magXY = Math.sqrt(
    spherePoint.x * spherePoint.x + spherePoint.y * spherePoint.y,
  );

  // Use fastApproximateAtan2 for alignment with shader
  let sphereLatitude = CesiumMath.fastApproximateAtan2(magXY, spherePoint.z);
  let sphereLongitude = CesiumMath.fastApproximateAtan2(
    spherePoint.x,
    spherePoint.y,
  );

  result.south = sphereLatitude;
  result.west = sphereLongitude;

  spherePoint = Cartographic.toCartesian(
    Rectangle.northeast(rectangle),
    polygon.ellipsoid,
    spherePointScratch,
  );

  // Project into plane with vertical for latitude
  magXY = Math.sqrt(
    spherePoint.x * spherePoint.x + spherePoint.y * spherePoint.y,
  );

  // Use fastApproximateAtan2 for alignment with shader
  sphereLatitude = CesiumMath.fastApproximateAtan2(magXY, spherePoint.z);
  sphereLongitude = CesiumMath.fastApproximateAtan2(
    spherePoint.x,
    spherePoint.y,
  );

  result.north = sphereLatitude;
  result.east = sphereLongitude;

  return result;
}

/**
 * Returns the number of pixels needed in the texture containing the packed computed spherical extents for each polygon.
 *
 * @param {ClippingPolygonCollection} collection
 * @returns {number}
 * @private
 */
function pixelsNeededForExtents(collection) {
  return collection.length; // With an RGBA texture, each pixel contains min/max latitude and longitude.
}

/**
 * Returns the number of pixels needed in the texture containing the packed polygon positions.
 *
 * @param {ClippingPolygonCollection} collection
 * @returns {number}
 * @private
 */
function pixelsNeededForPolygonPositions(collection) {
  // In an RG FLOAT texture, each polygon position is 2 floats packed to a RG.
  // Each polygon has a 1-pixel header + 2 pixels for individual extents + the list of positions
  let totalPositions = 0;
  const length = collection.length;
  for (let i = 0; i < length; ++i) {
    totalPositions += outerRingLength(collection.get(i));
  }
  return totalPositions + 3 * length;
}

/**
 * Computes padded extents for a polygon's bounding rectangle, clamped to valid spherical ranges.
 *
 * @param {Rectangle} extents The original spherical extents to pad.
 * @param {number} padding A multiplier applied to the extents' width and height to determine the padding amount.
 * @param {Rectangle} [result] An optional rectangle to store the result in.
 * @returns {Rectangle} The padded and clamped rectangle.
 *
 * @private
 */
function computePaddedExtents(extents, padding, result) {
  const height = Math.max(extents.height * padding, 0);
  const width = Math.max(extents.width * padding, 0);
  const paddedExtents = Rectangle.clone(extents, result);

  // Pad
  paddedExtents.south -= height;
  paddedExtents.west -= width;
  paddedExtents.north += height;
  paddedExtents.east += width;

  // Clamp
  paddedExtents.south = Math.max(paddedExtents.south, -Math.PI);
  paddedExtents.west = Math.max(paddedExtents.west, -Math.PI);
  paddedExtents.north = Math.min(paddedExtents.north, Math.PI);
  paddedExtents.east = Math.min(paddedExtents.east, Math.PI);

  return paddedExtents;
}

/**
 * @typedef {object} ExtentsResult
 * @property {Rectangle[]} extentsList The list of merged padded extents, one per group.
 * @property {Map<number, number>} extentsIndexByPolygon A map from polygon index to the index of its group in extentsList.
 * @private
 */

/**
 * Groups nearby ClippingPolygons based on their spherical extents. Overlapping extents will be merged
 * into a single encompassing extent. Each Extent will later map into one region in the SignedDistanceTexture (atlas).
 *
 * Definitions:
 * n = number of polygons
 * g = number of resulting extents (merged) (g <= n)
 * absorb = merge two extents into one
 * restart = redo intersection check with previous groups
 *
 * Algorithm:
 * For each polygon we scan existing groups for a first overlap (O(g)),
 * then on each subsequent overlap we absorb the group and restart the
 * inner scan. Each group can be absorbed at most once per polygon, and
 * each restart reduces the group count by one, so the absorb-loop does
 * at most O(g) restarts per polygon. Overall: O(n * g) where g ≤ n,
 * giving O(n²) worst case when all polygons overlap transitively, but
 * typically much better when groups are few and disjoint.
 *
 * Note: Restarts are required because the new merged bounding box might
 * be larger than the two individual that were merged and introduce new
 * collisions. Example:
 *
 *   Before merging A and B:
 *
 *        ┌─────────┐
 *        │    A     │
 *        │         ┌┼────────┐
 *        └─────────┘│   B    │
 *        ┌────┐     │        │
 *        │ C  │     └────────┘
 *        └────┘
 *
 *     A overlaps B  ✓
 *     A overlaps C  ✗
 *     B overlaps C  ✗
 *
 *   After merging A ∪ B into one extent:
 *
 *        ┌───────────────────┐
 *        │                   │
 *        │    A ∪ B          │
 *        ├────┐              │
 *        │ C  │              │
 *        └────┘──────────────┘
 *
 *     (A ∪ B) overlaps C  ✓  ← new collision!
 *
 * @param {ClippingPolygon[]} polygons The array of clipping polygons to compute extents for.
 * @param {Rectangle[]} polygonExtentsCache An array of pre-computed spherical extents for each polygon, indexed by polygon index.
 * @returns {ExtentsResult} The merged extents and a mapping from polygon indices to their extent group indices.
 *
 * @private
 */
function getExtents(polygons, polygonExtentsCache) {
  // Pad extents to avoid floating point error when fragment culling at edges.
  const PADDING = 2.5;

  // Each group: { extent: padded Rectangle, polygonIndices: number[] }
  const groups = [];

  const length = polygons.length;
  for (let polygonIndex = 0; polygonIndex < length; ++polygonIndex) {
    const paddedExtent = computePaddedExtents(
      polygonExtentsCache[polygonIndex],
      PADDING,
    );

    // Pass 1: Find the first overlapping group
    let targetIdx = -1;
    for (let g = 0; g < groups.length; ++g) {
      if (
        defined(Rectangle.simpleIntersection(groups[g].extent, paddedExtent))
      ) {
        targetIdx = g;
        break;
      }
    }

    if (targetIdx === -1) {
      // No overlap — start a new group
      groups.push({ extent: paddedExtent, polygonIndices: [polygonIndex] });
    } else {
      // Overlap - Merge the polygon into the target group
      const target = groups[targetIdx];
      target.polygonIndices.push(polygonIndex);
      Rectangle.union(target.extent, paddedExtent, target.extent);

      // Pass 2: Absorb all other groups that overlap the (growing) target
      // extent. After each absorption the target grows, so restart the scan
      // to catch groups that now transitively overlap.
      for (let g = 0; g < groups.length; ++g) {
        if (g === targetIdx) {
          continue;
        }
        if (
          defined(Rectangle.simpleIntersection(groups[g].extent, target.extent))
        ) {
          target.polygonIndices.push(...groups[g].polygonIndices);
          Rectangle.union(target.extent, groups[g].extent, target.extent);
          groups.splice(g, 1);
          if (g < targetIdx) {
            targetIdx--;
          }
          g = -1; // restart (loop increment brings it to 0)
        }
      }
    }
  }

  const extentsList = groups.map((g) => g.extent);
  const extentsIndexByPolygon = new Map();
  groups.forEach((g, extentIndex) =>
    g.polygonIndices.forEach((p) => extentsIndexByPolygon.set(p, extentIndex)),
  );

  return { extentsList, extentsIndexByPolygon };
}

/**
 * Packs the collection's polygons and merged extents into the CPU-side
 * Float32Array views the SDF compute pass uploads.
 *
 * @param {ClippingPolygonCollection} collection The collection to pack. Its
 *   <code>_float32View</code> and <code>_extentsFloat32View</code> must already
 *   be allocated; <code>_extentsCount</code> is written here.
 *
 * @private
 */
function packPolygonsAsFloats(collection) {
  const polygonsFloat32View = collection._float32View;
  const extentsFloat32View = collection._extentsFloat32View;
  const polygons = getPolygons(collection);

  /**
   * Pre-calculate all polygon spherical extents as it an expensive operation
   * @type {ReadonlyArray<Rectangle>}
   * */
  const polygonExtentsCache = polygons.map((polygon) =>
    computeSphericalExtents(polygon),
  );

  const { extentsList, extentsIndexByPolygon } = getExtents(
    polygons,
    polygonExtentsCache,
  );

  // Polygons are packed sequentially (ordered by extentsIndex) into polygonsFloat32View as follows:
  // For each polygon:
  //   [0] vertexCount - the number of vertices in the polygon
  //   [1] extentsIndex - index into the extents texture for this polygon's bounding rectangle
  //   [2] south - southern boundary of the individual polygon extent (radians)
  //   [3] west - western boundary of the individual polygon extent (radians)
  //   [4] latitudeRange - (north - south) for the individual polygon extent
  //   [5] longitudeRange - (east - west) for the individual polygon extent
  //   [6..6+2*vertexCount-1] pairs of (latitude, longitude) for each vertex,
  //       computed as fastApproximateAtan2 values to match the shader

  // Sort polygon indices by extentsIndex so polygons sharing the same extent are packed together
  // Can enable optimizations in the shader
  const sortedPolygonIndices = Array.from(polygons.keys()).sort(
    (a, b) => extentsIndexByPolygon.get(a) - extentsIndexByPolygon.get(b),
  );

  let floatIndex = 0;
  for (const polygonIndex of sortedPolygonIndices) {
    const polygon = polygons[polygonIndex];
    // Pack the length of the polygon into the polygon texture array buffer
    const length = outerRingLength(polygon);
    polygonsFloat32View[floatIndex++] = length;
    polygonsFloat32View[floatIndex++] = extentsIndexByPolygon.get(polygonIndex);

    // Pack the individual polygon extent
    const polygonExtent = polygonExtentsCache[polygonIndex];
    polygonsFloat32View[floatIndex++] = polygonExtent.south;
    polygonsFloat32View[floatIndex++] = polygonExtent.west;
    polygonsFloat32View[floatIndex++] =
      polygonExtent.north - polygonExtent.south;
    polygonsFloat32View[floatIndex++] = polygonExtent.east - polygonExtent.west;

    // Pack the polygon positions into the polygon texture array buffer
    for (let i = 0; i < length; ++i) {
      const spherePoint = polygon.positions[i];

      // Project into plane with vertical for latitude
      const magXY = Math.hypot(spherePoint.x, spherePoint.y);

      // Use fastApproximateAtan2 for alignment with shader
      const latitudeApproximation = CesiumMath.fastApproximateAtan2(
        magXY,
        spherePoint.z,
      );
      const longitudeApproximation = CesiumMath.fastApproximateAtan2(
        spherePoint.x,
        spherePoint.y,
      );

      polygonsFloat32View[floatIndex++] = latitudeApproximation;
      polygonsFloat32View[floatIndex++] = longitudeApproximation;
    }
  }

  // Extents are packed sequentially into extentsFloat32View as follows:
  // For each extent (maps to one RGBA pixel in the extents texture):
  //   [0] south - the southern boundary of the bounding rectangle (radians)
  //   [1] west - the western boundary of the bounding rectangle (radians)
  //   [2] latitudeRangeInverse - 1.0 / (north - south)
  //   [3] longitudeRangeInverse - 1.0 / (east - west)
  let extentsFloatIndex = 0;
  for (const extents of extentsList) {
    const longitudeRangeInverse = 1.0 / (extents.east - extents.west);
    const latitudeRangeInverse = 1.0 / (extents.north - extents.south);

    extentsFloat32View[extentsFloatIndex++] = extents.south;
    extentsFloat32View[extentsFloatIndex++] = extents.west;
    extentsFloat32View[extentsFloatIndex++] = latitudeRangeInverse;
    extentsFloat32View[extentsFloatIndex++] = longitudeRangeInverse;
  }

  collection._extentsCount = extentsList.length;
}

/**
 * Packs the polygon position + extents data into the CPU-side
 * Float32Array views (<code>_float32View</code>,
 * <code>_extentsFloat32View</code>) on the collection, without creating any
 * GPU resources. The WebGPU clipping-polygon feature renderer calls this, then
 * uploads the views into GPU textures and dispatches the WGSL SDF compute pass
 * (<code>PolygonSignedDistance.wgsl</code>) itself.
 *
 * @param {ClippingPolygonCollection} collection The collection to pack.
 * @param {number} maximumTextureSize Maximum 2D texture dimension of the target device.
 * @returns {object|undefined} The packed texture layout
 *   <code>{positionsWidth, positionsHeight, extentsWidth, extentsHeight, extentsCount}</code>,
 *   or <code>undefined</code> when the collection is empty.
 *
 * @private
 */
function packDataForFeatureRenderer(collection, maximumTextureSize) {
  if (collection.length === 0) {
    return undefined;
  }

  const positionsPixels = pixelsNeededForPolygonPositions(collection);
  const positionsWidth = Math.min(positionsPixels, maximumTextureSize);
  const positionsHeight = Math.ceil(positionsPixels / positionsWidth);
  collection._float32View = new Float32Array(
    positionsWidth * positionsHeight * 2,
  );

  const extentsPixels = pixelsNeededForExtents(collection);
  const extentsWidth = Math.min(extentsPixels, maximumTextureSize);
  const extentsHeight = Math.ceil(extentsPixels / extentsWidth);
  collection._extentsFloat32View = new Float32Array(
    extentsWidth * extentsHeight * 4,
  );

  packPolygonsAsFloats(collection);

  return {
    positionsWidth: positionsWidth,
    positionsHeight: positionsHeight,
    extentsWidth: extentsWidth,
    extentsHeight: extentsHeight,
    extentsCount: collection._extentsCount,
  };
}

const spherePointScratch = new Cartesian3();

export {
  computeSphericalExtents,
  packDataForFeatureRenderer,
  packPolygonsAsFloats,
  pixelsNeededForExtents,
  pixelsNeededForPolygonPositions,
};
