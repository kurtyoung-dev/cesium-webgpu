/**
 * Builds the flat and extruded polygon primitives a rig declares as data and
 * adds them to the CesiumViewer page's scene.
 * @purpose Stage piece that turns a rig's `polygons` list (id, degrees, height, optional extrudedHeight, colour) into one opaque lit-material `Primitive` per polygon on `window.viewer.scene.primitives`, refusing bad polygon data in Node before a browser is involved and reading back the ids it added.
 * @status ACTIVE
 *
 * WHY A STAGE PIECE. The SSR water probe built a "lake" (a flat lit polygon)
 * and a "wall" (an extruded polygon) in a private page function. The kit rule
 * is that scene construction lives in a `lib/` stage piece driven by rig data,
 * so a rig declares `polygons` (a top-level rig field, not a dial) and this
 * piece builds them, the same way for every probe that needs a surface to
 * reflect in or against.
 *
 * WHY ALWAYS THE TEXTURED VERTEX FORMAT. Every polygon is built with
 * `MaterialAppearance.MaterialSupport.TEXTURED.vertexFormat`. That format
 * includes per-vertex normals, so the appearance picks the lit material
 * variant (`matColorLit`) instead of the flat one (`matColorFlat`). The lit
 * variant is the one that emits the G-buffer normal and roughness output, so
 * screen-space reflections' sentinel check passes on these pixels and the ray
 * march actually attempts to reflect. A flat-format polygon would draw but be
 * invisible to SSR, which is the failure the probe exists to detect; there is
 * therefore no dial to choose another format.
 *
 * REFUSED IN NODE. An invalid entry (bad id, fewer than three points, an
 * odd-length or non-finite degrees list, a latitude outside [-90, 90], a
 * colour that is not four numbers in [0, 1], a non-finite height, an
 * `extrudedHeight` that is not above `height`, a duplicate id) is a rig the
 * probe cannot stage, so `polygonScenePayload` throws `rig-polygons-invalid`
 * naming the rig, each polygon and each problem. A rig without `polygons`
 * stages nothing and says so with an empty list.
 *
 * @module Tools/visual-regression/lib/polygon-primitive-scene
 */

import { ProbeRefusal } from "./probe-refusal.mjs";

/** Where the page imports the Cesium namespace from. */
export const POLYGON_SCENE_MODULE_URL = "/Build/CesiumUnminified/index.js";

const isFiniteNumber = (value) =>
  typeof value === "number" && Number.isFinite(value);

/**
 * Problems with one polygon declaration; empty when it is valid.
 *
 * @param {unknown} polygon
 * @returns {string[]}
 */
function polygonProblems(polygon) {
  if (polygon === null || typeof polygon !== "object") {
    return ["the entry is not an object"];
  }
  const problems = [];
  const { degrees, height, extrudedHeight, color } = polygon;
  if (!Array.isArray(degrees)) {
    problems.push("degrees is not an array");
  } else {
    if (degrees.length % 2 !== 0) {
      problems.push(
        `degrees has an odd length (${degrees.length}); it must be lon, lat pairs`,
      );
    }
    if (degrees.length < 6) {
      problems.push(
        `degrees has ${Math.floor(degrees.length / 2)} point(s); a polygon needs at least 3`,
      );
    }
    if (!degrees.every(isFiniteNumber)) {
      problems.push("degrees holds a value that is not a finite number");
    } else if (degrees.some((v, i) => i % 2 === 1 && (v < -90 || v > 90))) {
      problems.push("a latitude in degrees is outside [-90, 90]");
    }
  }
  if (!isFiniteNumber(height)) {
    problems.push(`height is not a finite number (${String(height)})`);
  }
  if (extrudedHeight !== undefined) {
    if (!isFiniteNumber(extrudedHeight)) {
      problems.push(
        `extrudedHeight is not a finite number (${String(extrudedHeight)})`,
      );
    } else if (isFiniteNumber(height) && extrudedHeight <= height) {
      problems.push(
        `extrudedHeight (${extrudedHeight}) must be greater than height (${height})`,
      );
    }
  }
  if (
    !Array.isArray(color) ||
    color.length !== 4 ||
    !color.every((c) => isFiniteNumber(c) && c >= 0 && c <= 1)
  ) {
    problems.push("color must be 4 numbers in [0, 1] (r, g, b, a)");
  }
  return problems;
}

/**
 * The payload `pagePolygonScene` takes. Pure; JSON-safe.
 *
 * @param {object} rig A rig record; `rig.polygons` is optional.
 * @returns {{rigId: string, moduleUrl: string, polygons: Array<{id: string,
 *   degrees: number[], height: number, extrudedHeight?: number,
 *   color: number[]}>}}
 * @throws {ProbeRefusal} `rig-polygons-invalid` for any invalid entry.
 */
export function polygonScenePayload(rig) {
  const rigId = rig?.id ?? "(unnamed)";
  const declared = rig?.polygons ?? [];
  const problems = [];
  if (!Array.isArray(declared)) {
    problems.push({ polygonId: null, problem: "polygons is not an array" });
  }
  const polygons = [];
  const seen = new Set();
  for (const polygon of Array.isArray(declared) ? declared : []) {
    const id = polygon?.id;
    const label = typeof id === "string" ? id : "(no id)";
    const found = [];
    if (typeof id !== "string" || id.length === 0) {
      found.push("id must be a non-empty string");
    } else if (seen.has(id)) {
      found.push("duplicate polygon id");
    } else {
      seen.add(id);
    }
    found.push(...polygonProblems(polygon));
    for (const problem of found) {
      problems.push({ polygonId: label, problem });
    }
    if (found.length === 0) {
      polygons.push({
        id,
        degrees: [...polygon.degrees],
        height: polygon.height,
        ...(polygon.extrudedHeight !== undefined
          ? { extrudedHeight: polygon.extrudedHeight }
          : {}),
        color: [...polygon.color],
      });
    }
  }
  if (problems.length > 0) {
    throw new ProbeRefusal(
      "rig-polygons-invalid",
      `rig ${rigId}: the polygon scene cannot build ${problems
        .map((p) =>
          p.polygonId === null
            ? p.problem
            : `polygon ${p.polygonId}: ${p.problem}`,
        )
        .join("; ")}`,
      { rigId, problems },
    );
  }
  return { rigId, moduleUrl: POLYGON_SCENE_MODULE_URL, polygons };
}

/**
 * PAGE SIDE. Build one opaque lit-colour Primitive per polygon and add it to
 * `globalThis.viewer.scene.primitives`. Self-contained.
 *
 * @param {object} payload From {@link polygonScenePayload}.
 * @returns {Promise<{rigId: string, added: string[],
 *   primitivesCount: number}>}
 */
export async function pagePolygonScene(payload) {
  const C = await import(payload.moduleUrl);
  const scene = /** @type {any} */ (globalThis).viewer.scene;
  const added = [];
  for (const polygon of payload.polygons) {
    const geometryOptions = {
      polygonHierarchy: new C.PolygonHierarchy(
        C.Cartesian3.fromDegreesArray(polygon.degrees),
      ),
      height: polygon.height,
      // TEXTURED includes per-vertex normals, which selects the lit material
      // variant whose G-buffer output SSR needs (see the module header).
      vertexFormat: C.MaterialAppearance.MaterialSupport.TEXTURED.vertexFormat,
    };
    if (polygon.extrudedHeight !== undefined) {
      geometryOptions.extrudedHeight = polygon.extrudedHeight;
    }
    const [r, g, b, a] = polygon.color;
    const primitive = new C.Primitive({
      geometryInstances: new C.GeometryInstance({
        geometry: new C.PolygonGeometry(geometryOptions),
      }),
      appearance: new C.MaterialAppearance({
        material: C.Material.fromType("Color", {
          color: new C.Color(r, g, b, a),
        }),
        translucent: false,
      }),
      asynchronous: false,
    });
    scene.primitives.add(primitive);
    added.push(polygon.id);
  }
  return {
    rigId: payload.rigId,
    added,
    primitivesCount: scene.primitives.length,
  };
}

/**
 * NODE SIDE. Build the payload (refusing in Node) and stage it on the page.
 *
 * @param {{page: {evaluate: Function}, rig: object}} args
 * @returns {Promise<{rigId: string, added: string[], primitivesCount: number}>}
 * @throws {ProbeRefusal} `rig-polygons-invalid` before the page is touched.
 */
export async function stagePolygonScene({ page, rig }) {
  const payload = polygonScenePayload(rig);
  return await page.evaluate(pagePolygonScene, payload);
}
