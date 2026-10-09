// polyline-rig-scene.mjs — a polyline scene built from a rig's dials.
//
// @purpose Build the polylines a rig's dials declare (positions, width, colour material, and whether each lives in a PolylineCollection or a BufferPolylineCollection) on a given viewer, and hand back the collections with a dispose that removes them; no camera, capture, page or renderer logic.
// @status ACTIVE
//
// WHY THIS EXISTS. Every polyline rig the family declares is `page: null`: each
// probe builds its own scene in its own page function from the rig's numbers,
// so a new polyline scene has meant a new page function. This is the first
// polyline stage that is driven by dials alone: a rig lists its polylines and
// this builds them, the same way on either renderer, so a probe that wants a
// polyline scene names a rig instead of writing the scene. The capture seam's
// rig stages are where it belongs once that seam takes stages; until then a
// probe ships it into its page (below) and applies the rig's camera itself.
//
// HOW A PROBE CALLS IT IN A PAGE. `page.evaluate` cannot close over a Node
// import, so the function is written to be shipped as SOURCE: it reads nothing
// from this module's scope, takes the Cesium namespace and the viewer as
// arguments, and `POLYLINE_RIG_SCENE_SOURCE` is its text. A probe composes
// `(${pageFunction})(${POLYLINE_RIG_SCENE_SOURCE}, input)` and calls the first
// argument with the module it imported in the page.
//
// FAILS CLOSED. A dial it does not understand (an unknown collection kind or
// material type, a position list that is not whole points, a width that is not
// a positive number) throws a TypeError before anything is added, so a rig
// typo never renders a silently different scene.

/**
 * Builds the polylines `dials.polylines` declares and adds one collection per
 * kind to `viewer.scene.primitives`, in the order each kind is first named.
 *
 * Each entry of `dials.polylines` is
 * `{ name, collection, positionsDegreesHeights, width, material }`:
 * `collection` is `"PolylineCollection"` or `"BufferPolylineCollection"`;
 * `positionsDegreesHeights` is a flat `[lon, lat, height, ...]` list in degrees
 * and metres, at least two points; `width` is in pixels; `material` is
 * `{ type: "Color", color: [r, g, b, a] }` with components in [0, 1].
 *
 * Self-contained by design: everything it uses arrives in its arguments.
 *
 * @param {object} Cesium The Cesium module namespace.
 * @param {{scene: {primitives: {add: Function, remove: Function}}}} viewer The viewer to build on.
 * @param {{polylines: object[]}} dials The rig's dials.
 * @returns {{collections: Array<{kind: string, collection: object, names: string[]}>, dispose: () => void}}
 *   One record per collection added, with the names of the polylines it holds
 *   in the order they were added, and a dispose that removes every collection
 *   from the scene (once; a second call does nothing).
 * @throws {TypeError} A dial this stage cannot build.
 */
export function buildPolylineRigScene(Cesium, viewer, dials) {
  const KINDS = ["PolylineCollection", "BufferPolylineCollection"];
  const polylines = dials?.polylines;
  if (!Array.isArray(polylines) || polylines.length === 0) {
    throw new TypeError(
      "polyline rig scene: dials.polylines names no polyline",
    );
  }
  const isFiniteNumber = (value) =>
    typeof value === "number" && Number.isFinite(value);

  // Validate every entry before adding anything, so a bad rig leaves the scene
  // as it was.
  for (let i = 0; i < polylines.length; i++) {
    const entry = polylines[i];
    const label = `polyline rig scene: polylines[${i}]`;
    if (!KINDS.includes(entry?.collection)) {
      throw new TypeError(
        `${label}.collection must be one of ${KINDS.join(", ")} (got ${String(entry?.collection)})`,
      );
    }
    const flat = entry.positionsDegreesHeights;
    if (
      !Array.isArray(flat) ||
      flat.length < 6 ||
      flat.length % 3 !== 0 ||
      !flat.every(isFiniteNumber)
    ) {
      throw new TypeError(
        `${label}.positionsDegreesHeights must be finite [lon, lat, height] triples, at least two points`,
      );
    }
    if (!isFiniteNumber(entry.width) || entry.width <= 0) {
      throw new TypeError(`${label}.width must be a positive number`);
    }
    const material = entry.material;
    if (material?.type !== "Color") {
      throw new TypeError(
        `${label}.material.type must be "Color" (got ${String(material?.type)})`,
      );
    }
    if (
      !Array.isArray(material.color) ||
      material.color.length !== 4 ||
      !material.color.every(isFiniteNumber)
    ) {
      throw new TypeError(`${label}.material.color must be [r, g, b, a]`);
    }
  }

  const primitives = viewer.scene.primitives;
  const byKind = new Map();
  const records = [];
  const recordFor = (kind) => {
    if (!byKind.has(kind)) {
      const record = { kind, entries: [] };
      byKind.set(kind, record);
      records.push(record);
    }
    return byKind.get(kind);
  };
  for (const entry of polylines) {
    recordFor(entry.collection).entries.push(entry);
  }

  const collections = [];
  for (const record of records) {
    let collection;
    if (record.kind === "PolylineCollection") {
      collection = new Cesium.PolylineCollection();
      for (const entry of record.entries) {
        collection.add({
          positions: Cesium.Cartesian3.fromDegreesArrayHeights(
            entry.positionsDegreesHeights,
          ),
          width: entry.width,
          material: Cesium.Material.fromType("Color", {
            color: new Cesium.Color(...entry.material.color),
          }),
        });
      }
    } else {
      // A buffer collection cannot grow, so it is sized to exactly what the
      // dials hold.
      const vertexCount = record.entries.reduce(
        (sum, entry) => sum + entry.positionsDegreesHeights.length / 3,
        0,
      );
      collection = new Cesium.BufferPolylineCollection({
        primitiveCountMax: record.entries.length,
        vertexCountMax: vertexCount,
      });
      for (const entry of record.entries) {
        const points = Cesium.Cartesian3.fromDegreesArrayHeights(
          entry.positionsDegreesHeights,
        );
        const positions = new Float64Array(points.length * 3);
        for (let i = 0; i < points.length; i++) {
          positions[i * 3] = points[i].x;
          positions[i * 3 + 1] = points[i].y;
          positions[i * 3 + 2] = points[i].z;
        }
        collection.add({
          positions,
          material: new Cesium.BufferPolylineMaterial({
            color: new Cesium.Color(...entry.material.color),
            width: entry.width,
          }),
        });
      }
    }
    primitives.add(collection);
    collections.push({
      kind: record.kind,
      collection,
      names: record.entries.map((entry) => entry.name),
    });
  }

  let disposed = false;
  return {
    collections,
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      for (const { collection } of collections) {
        primitives.remove(collection);
      }
    },
  };
}

/** The stage's source text, for a probe to ship into its page. */
export const POLYLINE_RIG_SCENE_SOURCE = String(buildPolylineRigScene);
