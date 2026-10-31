// polygon-primitive-scene.spec.mjs - pure Node: no browser, no GPU.
//
// @purpose Exercises lib/polygon-primitive-scene.mjs: payload validation and refusal per invalid kind, a JSON round trip, the page-side primitives built against a fake Cesium module (heights, degrees, colour, TEXTURED vertex format, asynchronous false), the Node wrapper, and an inertness mutant that makes the scene add unreachable.
// @status ACTIVE

import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  POLYGON_SCENE_MODULE_URL,
  pagePolygonScene,
  polygonScenePayload,
  stagePolygonScene,
} from "./lib/polygon-primitive-scene.mjs";
import { importMutated } from "./lib/import-mutated.mjs";
import { ProbeRefusal } from "./lib/probe-refusal.mjs";

const PIECE = fileURLToPath(
  new URL("./lib/polygon-primitive-scene.mjs", import.meta.url),
);

const LAKE = Object.freeze({
  id: "lake",
  degrees: [-80, 40, -79.9, 40, -79.9, 40.1, -80, 40.1],
  height: 240,
  color: [0.05, 0.1, 0.2, 1],
});
const WALL = Object.freeze({
  id: "wall",
  degrees: [-80, 40.2, -79.9, 40.2, -79.9, 40.3],
  height: 240,
  extrudedHeight: 400,
  color: [1, 0.7, 0.1, 1],
});
const RIG = Object.freeze({ id: "rig-x", polygons: [LAKE, WALL] });

const FAKE_CESIUM_SOURCE = `
const record = (kind) =>
  class {
    constructor(options) {
      this.kind = kind;
      this.options = options;
    }
  };
export const Primitive = record("Primitive");
export const GeometryInstance = record("GeometryInstance");
export const PolygonGeometry = record("PolygonGeometry");
export const PolygonHierarchy = record("PolygonHierarchy");
export class Color {
  constructor(r, g, b, a) {
    Object.assign(this, { r, g, b, a });
  }
}
export const Cartesian3 = {
  fromDegreesArray(degrees) {
    return { cartesianOf: [...degrees] };
  },
};
export class MaterialAppearance {
  constructor(options) {
    this.options = options;
  }
  static MaterialSupport = {
    TEXTURED: { vertexFormat: { marker: "TEXTURED-VERTEX-FORMAT" } },
  };
}
export const Material = {
  fromType(type, uniforms) {
    return { type, uniforms };
  },
};
`;

const FAKE_CESIUM_URL =
  "data:text/javascript," + encodeURIComponent(FAKE_CESIUM_SOURCE);

function installFakeViewer() {
  const added = [];
  globalThis.viewer = {
    scene: {
      primitives: {
        add(primitive) {
          added.push(primitive);
        },
        get length() {
          return added.length;
        },
      },
    },
  };
  return added;
}

function refusalOf(rig) {
  try {
    polygonScenePayload(rig);
  } catch (error) {
    assert.ok(error instanceof ProbeRefusal, String(error));
    return error;
  }
  assert.fail("expected polygonScenePayload to refuse");
  return null;
}

/** The two-polygon behavioural check, run against any build of the piece. */
async function assertTwoPolygonsBuilt(pageFn) {
  const added = installFakeViewer();
  try {
    const payload = polygonScenePayload(RIG);
    const result = await pageFn({ ...payload, moduleUrl: FAKE_CESIUM_URL });
    assert.deepEqual(result.added, ["lake", "wall"]);
    assert.equal(result.primitivesCount, 2);
    assert.equal(added.length, 2);
    const [lake, wall] = added;
    for (const primitive of added) {
      assert.equal(primitive.kind, "Primitive");
      assert.equal(primitive.options.asynchronous, false);
      assert.equal(primitive.options.appearance.options.translucent, false);
    }
    const geometryOf = (primitive) =>
      primitive.options.geometryInstances.options.geometry.options;
    assert.equal(geometryOf(lake).height, 240);
    assert.equal(geometryOf(lake).extrudedHeight, undefined);
    assert.deepEqual(
      geometryOf(lake).polygonHierarchy.options.cartesianOf,
      LAKE.degrees,
    );
    assert.equal(geometryOf(wall).height, 240);
    assert.equal(geometryOf(wall).extrudedHeight, 400);
    assert.deepEqual(
      geometryOf(wall).polygonHierarchy.options.cartesianOf,
      WALL.degrees,
    );
    for (const primitive of added) {
      assert.deepEqual(geometryOf(primitive).vertexFormat, {
        marker: "TEXTURED-VERTEX-FORMAT",
      });
    }
    const colorOf = (primitive) =>
      primitive.options.appearance.options.material.uniforms.color;
    assert.equal(
      primitive0Type(lake),
      "Color",
      "the material is the Color material",
    );
    assert.deepEqual({ ...colorOf(lake) }, { r: 0.05, g: 0.1, b: 0.2, a: 1 });
    assert.deepEqual({ ...colorOf(wall) }, { r: 1, g: 0.7, b: 0.1, a: 1 });
  } finally {
    delete globalThis.viewer;
  }
}

function primitive0Type(primitive) {
  return primitive.options.appearance.options.material.type;
}

test("a rig without polygons yields an empty, JSON-safe payload", () => {
  for (const rig of [{ id: "a" }, { id: "b", polygons: [] }]) {
    const payload = polygonScenePayload(rig);
    assert.deepEqual(payload.polygons, []);
    assert.equal(payload.rigId, rig.id);
    assert.equal(payload.moduleUrl, POLYGON_SCENE_MODULE_URL);
  }
  assert.equal(POLYGON_SCENE_MODULE_URL, "/Build/CesiumUnminified/index.js");
});

test("a valid rig round-trips through JSON unchanged", () => {
  const payload = polygonScenePayload(RIG);
  assert.deepEqual(JSON.parse(JSON.stringify(payload)), payload);
  assert.equal(payload.rigId, "rig-x");
  assert.deepEqual(
    payload.polygons.map((p) => p.id),
    ["lake", "wall"],
  );
  assert.equal(payload.polygons[0].extrudedHeight, undefined);
  assert.equal(payload.polygons[1].extrudedHeight, 400);
});

const INVALID_CASES = [
  ["a missing id", { ...LAKE, id: undefined }, /id must be a non-empty/],
  ["an empty id", { ...LAKE, id: "" }, /id must be a non-empty/],
  ["too few points", { ...LAKE, degrees: [0, 0, 1, 1] }, /needs at least 3/],
  [
    "odd-length degrees",
    { ...LAKE, degrees: [0, 0, 1, 1, 2, 2, 3] },
    /odd length/,
  ],
  [
    "non-finite degrees",
    { ...LAKE, degrees: [0, 0, 1, 1, 2, Number.NaN] },
    /not a finite number/,
  ],
  [
    "latitude out of range",
    { ...LAKE, degrees: [0, 0, 1, 91, 2, 2] },
    /latitude/,
  ],
  ["a non-finite height", { ...LAKE, height: Infinity }, /height is not/],
  [
    "extrudedHeight equal to height",
    { ...WALL, extrudedHeight: 240 },
    /must be greater than height/,
  ],
  [
    "extrudedHeight below height",
    { ...WALL, extrudedHeight: 100 },
    /must be greater than height/,
  ],
  [
    "a non-finite extrudedHeight",
    { ...WALL, extrudedHeight: Number.NaN },
    /extrudedHeight is not/,
  ],
  [
    "a colour of three numbers",
    { ...LAKE, color: [0, 0, 0] },
    /4 numbers in \[0, 1\]/,
  ],
  [
    "a colour component above 1",
    { ...LAKE, color: [0, 0, 2, 1] },
    /4 numbers in \[0, 1\]/,
  ],
  [
    "a colour component below 0",
    { ...LAKE, color: [-0.1, 0, 0, 1] },
    /4 numbers in \[0, 1\]/,
  ],
];

for (const [name, polygon, pattern] of INVALID_CASES) {
  test(`refuses ${name} with rig-polygons-invalid naming rig and polygon`, () => {
    const error = refusalOf({ id: "rig-bad", polygons: [polygon] });
    assert.equal(error.reason, "rig-polygons-invalid");
    assert.match(error.message, /rig rig-bad/);
    assert.match(error.message, pattern);
    assert.equal(error.details.rigId, "rig-bad");
    assert.ok(error.details.problems.length >= 1);
    if (typeof polygon.id === "string" && polygon.id.length > 0) {
      assert.match(error.message, new RegExp(`polygon ${polygon.id}`));
    }
  });
}

test("refuses a duplicate polygon id and names it", () => {
  const error = refusalOf({
    id: "rig-dup",
    polygons: [LAKE, { ...WALL, id: "lake" }],
  });
  assert.equal(error.reason, "rig-polygons-invalid");
  assert.match(error.message, /polygon lake: duplicate polygon id/);
});

test("refuses polygons that is not an array", () => {
  const error = refusalOf({ id: "rig-arr", polygons: { lake: LAKE } });
  assert.equal(error.reason, "rig-polygons-invalid");
  assert.match(error.message, /polygons is not an array/);
});

test("reports every invalid polygon, not only the first", () => {
  const error = refusalOf({
    id: "rig-many",
    polygons: [
      { ...LAKE, id: "a", height: Number.NaN },
      { ...WALL, id: "b", color: [] },
    ],
  });
  assert.match(error.message, /polygon a:/);
  assert.match(error.message, /polygon b:/);
});

test("the page side builds one opaque TEXTURED primitive per polygon and adds it", async () => {
  await assertTwoPolygonsBuilt(pagePolygonScene);
});

test("stagePolygonScene refuses in Node before touching the page", async () => {
  let evaluated = false;
  const page = {
    evaluate() {
      evaluated = true;
    },
  };
  await assert.rejects(
    stagePolygonScene({
      page,
      rig: { id: "rig-bad", polygons: [{ ...LAKE, degrees: [1, 2] }] },
    }),
    (error) =>
      error instanceof ProbeRefusal && error.reason === "rig-polygons-invalid",
  );
  assert.equal(evaluated, false);
});

test("stagePolygonScene evaluates the page function with the payload", async () => {
  const added = installFakeViewer();
  try {
    const page = {
      evaluate(fn, payload) {
        return fn({ ...payload, moduleUrl: FAKE_CESIUM_URL });
      },
    };
    const result = await stagePolygonScene({ page, rig: RIG });
    assert.deepEqual(result, {
      rigId: "rig-x",
      added: ["lake", "wall"],
      primitivesCount: 2,
    });
    assert.equal(added.length, 2);
  } finally {
    delete globalThis.viewer;
  }
});

test("a rig without polygons adds nothing on the page side", async () => {
  const added = installFakeViewer();
  try {
    const result = await pagePolygonScene({
      ...polygonScenePayload({ id: "none" }),
      moduleUrl: FAKE_CESIUM_URL,
    });
    assert.deepEqual(result, { rigId: "none", added: [], primitivesCount: 0 });
    assert.equal(added.length, 0);
  } finally {
    delete globalThis.viewer;
  }
});

test("INERTNESS: with the scene add unreachable the two-primitives check fails", async () => {
  const mutated = await importMutated(PIECE, [
    [
      "    scene.primitives.add(primitive);",
      "    if (false && scene.primitives) scene.primitives.add(primitive);",
    ],
  ]);
  await assert.rejects(
    assertTwoPolygonsBuilt(mutated.pagePolygonScene),
    (error) => error instanceof assert.AssertionError,
  );
});
