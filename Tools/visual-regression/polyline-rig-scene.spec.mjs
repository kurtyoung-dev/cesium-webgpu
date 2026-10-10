// polyline-rig-scene.spec.mjs — the dial-driven polyline stage: dials in, collection shape out, dispose releases.
//
// @purpose Drives lib/polyline-rig-scene.mjs with a stub Cesium namespace and a stub viewer and asserts the collections it builds from a rig's dials (one per kind, a buffer collection sized exactly to its dials), that dispose removes each once, that a bad dial throws a TypeError before anything is added, and that the shipped source text works on its own.
// @status ACTIVE
//
// Pure Node, real stage module, stub engine, no browser, no GPU:
//   node --test Tools/visual-regression/polyline-rig-scene.spec.mjs
//   npm run test-visual-regression-node        # its registered runner home
//
// WHAT IS REAL AND WHAT IS STUBBED
// --------------------------------
// REAL    the stage function, its shipped source text, and the rig
//         `polyline-nearclip` read through the registry (the concrete dials).
// STUBBED the engine classes. The stage only calls constructors and `add`, so
//         the stubs record their constructor options and `add` calls and
//         nothing else; what the real engine does with them is the engine's
//         own specs' business, and the Edge leg's.
//
// THE GROUPS
//   S1  dials in, collection shape out
//   S2  dispose removes each collection once, and only those
//   S3  a bad dial throws a TypeError and nothing was added
//   S4  the shipped source text is self-contained
//   M   inertness images: a one-substitution copy of the stage's source turns
//       S1, S2 or S3 RED

import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import {
  buildPolylineRigScene,
  POLYLINE_RIG_SCENE_SOURCE,
} from "./lib/polyline-rig-scene.mjs";
import { loadRigs, rigById } from "./lib/rig-registry.mjs";

// ═══════════════════════════════════════════════════════════════════════
// Stubs
// ═══════════════════════════════════════════════════════════════════════

/**
 * A stub Cesium namespace that records what the stage constructs and adds.
 * `fromDegreesArrayHeights` returns the points as {x: lon, y: lat, z: height}
 * so a test can read the dial numbers back out of the buffer positions.
 *
 * @returns {{Cesium: object, log: object}} The namespace and its records.
 */
function makeStub() {
  const log = { polylineCollections: [], bufferCollections: [] };

  class PolylineCollection {
    constructor(options) {
      this.options = options;
      this.added = [];
      log.polylineCollections.push(this);
    }

    add(options) {
      this.added.push(options);
      return options;
    }
  }

  class BufferPolylineCollection {
    constructor(options) {
      this.options = options;
      this.added = [];
      log.bufferCollections.push(this);
    }

    add(options) {
      this.added.push(options);
      return options;
    }
  }

  class Color {
    constructor(r, g, b, a) {
      this.components = [r, g, b, a];
    }
  }

  class BufferPolylineMaterial {
    constructor(options) {
      this.options = options;
    }
  }

  const Cesium = {
    PolylineCollection,
    BufferPolylineCollection,
    BufferPolylineMaterial,
    Color,
    Cartesian3: {
      fromDegreesArrayHeights(flat) {
        const points = [];
        for (let i = 0; i < flat.length; i += 3) {
          points.push({ x: flat[i], y: flat[i + 1], z: flat[i + 2] });
        }
        return points;
      },
    },
    Material: {
      fromType(type, uniforms) {
        return { type, uniforms };
      },
    },
  };
  return { Cesium, log };
}

/** A stub viewer whose `scene.primitives` records `add` and `remove`. */
function makeViewer() {
  const calls = [];
  const viewer = {
    scene: {
      primitives: {
        add(primitive) {
          calls.push({ op: "add", primitive });
          return primitive;
        },
        remove(primitive) {
          calls.push({ op: "remove", primitive });
          return true;
        },
      },
    },
  };
  return { viewer, calls };
}

const line = (overrides = {}) => ({
  name: "line",
  collection: "PolylineCollection",
  positionsDegreesHeights: [-75, 40, 100, -75, 40.01, 100],
  width: 4,
  material: { type: "Color", color: [1, 0.5, 0.25, 1] },
  ...overrides,
});

// ═══════════════════════════════════════════════════════════════════════
// The groups, as functions over a stage so that a mutated copy of the stage
// can be required to fail them.
// ═══════════════════════════════════════════════════════════════════════

/**
 * S1 on the rig's own dials, then on a two-plus-one dial list.
 *
 * @param {Function} build The stage under test.
 * @param {object} nearclipDials The dials of rig `polyline-nearclip`.
 * @returns {string[]} Violations.
 */
function shapeViolations(build, nearclipDials) {
  const violations = [];
  const expect = (condition, message) => {
    if (!condition) {
      violations.push(message);
    }
  };

  // The rig's concrete dials.
  {
    const { Cesium, log } = makeStub();
    const { viewer, calls } = makeViewer();
    const scene = build(Cesium, viewer, nearclipDials);
    expect(
      scene.collections.length === 2,
      `rig: ${scene.collections.length} collections, not 2`,
    );
    const [first, second] = scene.collections;
    expect(first?.kind === "PolylineCollection", "rig: first kind");
    expect(
      JSON.stringify(first?.names) === JSON.stringify(["near-plane"]),
      `rig: first names ${JSON.stringify(first?.names)}`,
    );
    expect(second?.kind === "BufferPolylineCollection", "rig: second kind");
    expect(
      JSON.stringify(second?.names) ===
        JSON.stringify([
          "hairpin",
          "near-plane-buffer",
          "straight-3",
          "straight-5",
        ]),
      `rig: second names ${JSON.stringify(second?.names)}`,
    );
    expect(
      first?.collection === log.polylineCollections[0] &&
        second?.collection === log.bufferCollections[0],
      "rig: records hold the collections that were constructed",
    );
    expect(
      calls.filter((c) => c.op === "add").length === 2 &&
        calls[0]?.primitive === first?.collection &&
        calls[1]?.primitive === second?.collection,
      "rig: each collection is added to the scene exactly once, in order",
    );
    expect(
      calls.every((c) => c.op === "add"),
      "rig: building removes nothing",
    );

    const buffer = log.bufferCollections[0];
    expect(buffer?.options?.primitiveCountMax === 4, "rig: primitiveCountMax");
    expect(buffer?.options?.vertexCountMax === 13, "rig: vertexCountMax");
    const hairpin = buffer?.added?.[0];
    expect(buffer?.added?.length === 4, "rig: four buffer polylines");
    expect(
      hairpin?.positions instanceof Float64Array &&
        hairpin.positions.length === 9,
      "rig: buffer positions are a Float64Array of 9 numbers",
    );
    const dial = nearclipDials.polylines[1];
    expect(
      hairpin?.positions?.[0] === dial.positionsDegreesHeights[0] &&
        hairpin?.positions?.[1] === dial.positionsDegreesHeights[1] &&
        hairpin?.positions?.[2] === dial.positionsDegreesHeights[2] &&
        hairpin?.positions?.[6] === dial.positionsDegreesHeights[6],
      "rig: buffer positions are the points' x, y, z in order",
    );
    expect(
      hairpin?.material?.options?.width === dial.width &&
        JSON.stringify(hairpin?.material?.options?.color?.components) ===
          JSON.stringify(dial.material.color),
      "rig: buffer material carries the dial's width and colour",
    );
    const nearBuffer = buffer?.added?.[1];
    const nearBufferDial = nearclipDials.polylines[2];
    expect(
      nearBuffer?.positions instanceof Float64Array &&
        nearBuffer.positions.length === 6 &&
        nearBuffer.positions[5] === nearBufferDial.positionsDegreesHeights[5] &&
        nearBuffer?.material?.options?.width === nearBufferDial.width &&
        JSON.stringify(nearBuffer?.material?.options?.color?.components) ===
          JSON.stringify(nearBufferDial.material.color),
      "rig: the second buffer polyline carries its dial's points, width and colour",
    );
    const straight5 = buffer?.added?.[3];
    const straight5Dial = nearclipDials.polylines[4];
    expect(
      straight5?.positions instanceof Float64Array &&
        straight5.positions.length === 15 &&
        straight5.positions[14] === straight5Dial.positionsDegreesHeights[14] &&
        straight5?.material?.options?.width === straight5Dial.width &&
        JSON.stringify(straight5?.material?.options?.color?.components) ===
          JSON.stringify(straight5Dial.material.color),
      "rig: the fourth buffer polyline carries its dial's points, width and colour",
    );

    const near = log.polylineCollections[0]?.added?.[0];
    const nearDial = nearclipDials.polylines[0];
    expect(
      log.polylineCollections[0]?.added?.length === 1 &&
        near?.width === nearDial.width &&
        near?.positions?.length === 2 &&
        near?.positions?.[1]?.y === nearDial.positionsDegreesHeights[4] &&
        near?.material?.type === "Color" &&
        JSON.stringify(near?.material?.uniforms?.color?.components) ===
          JSON.stringify(nearDial.material.color),
      "rig: polyline entry carries positions, width and a Color material",
    );
  }

  // Two polyline entries and one buffer entry: grouping by kind, in order.
  {
    const { Cesium, log } = makeStub();
    const { viewer, calls } = makeViewer();
    const scene = build(Cesium, viewer, {
      polylines: [
        line({ name: "a" }),
        line({
          name: "buf",
          collection: "BufferPolylineCollection",
          positionsDegreesHeights: [0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3],
        }),
        line({ name: "b", width: 7 }),
      ],
    });
    expect(
      scene.collections.length === 2,
      `grouped: ${scene.collections.length} collections, not 2`,
    );
    expect(
      scene.collections[0]?.kind === "PolylineCollection" &&
        JSON.stringify(scene.collections[0].names) ===
          JSON.stringify(["a", "b"]),
      "grouped: the first record holds both polyline names in dial order",
    );
    expect(
      scene.collections[1]?.kind === "BufferPolylineCollection" &&
        JSON.stringify(scene.collections[1].names) === JSON.stringify(["buf"]),
      "grouped: the second record holds the buffer entry",
    );
    expect(
      log.polylineCollections.length === 1 &&
        log.polylineCollections[0].added.length === 2 &&
        log.polylineCollections[0].added[1].width === 7,
      "grouped: one PolylineCollection with two adds",
    );
    expect(
      log.bufferCollections.length === 1 &&
        log.bufferCollections[0].options.primitiveCountMax === 1 &&
        log.bufferCollections[0].options.vertexCountMax === 4,
      "grouped: the buffer is sized to its one entry of four points",
    );
    expect(
      calls.filter((c) => c.op === "add").length === 2,
      "grouped: two collections added to the scene",
    );
  }

  // A buffer collection holding two entries is sized to their sum.
  {
    const { Cesium, log } = makeStub();
    const { viewer } = makeViewer();
    build(Cesium, viewer, {
      polylines: [
        line({
          collection: "BufferPolylineCollection",
          positionsDegreesHeights: [0, 0, 0, 1, 1, 1],
        }),
        line({
          collection: "BufferPolylineCollection",
          positionsDegreesHeights: [0, 0, 0, 1, 1, 1, 2, 2, 2],
        }),
      ],
    });
    const options = log.bufferCollections[0]?.options;
    expect(
      options?.primitiveCountMax === 2 && options?.vertexCountMax === 5,
      `sum: sized ${JSON.stringify(options)}, not 2 primitives and 5 vertices`,
    );
  }
  return violations;
}

/**
 * S2.
 *
 * @param {Function} build The stage under test.
 * @returns {string[]} Violations.
 */
function disposeViolations(build) {
  const violations = [];
  const { Cesium } = makeStub();
  const { viewer, calls } = makeViewer();
  const scene = build(Cesium, viewer, {
    polylines: [
      line({ name: "a" }),
      line({ name: "b", collection: "BufferPolylineCollection" }),
    ],
  });
  if (calls.some((c) => c.op === "remove")) {
    violations.push("building removed something");
  }
  scene.dispose();
  const removes = calls.filter((c) => c.op === "remove");
  if (removes.length !== 2) {
    violations.push(`dispose removed ${removes.length} collections, not 2`);
  }
  for (const record of scene.collections) {
    if (!removes.some((c) => c.primitive === record.collection)) {
      violations.push(`dispose did not remove the ${record.kind}`);
    }
  }
  if (calls.length !== 4) {
    violations.push(
      `dispose touched the scene ${calls.length - 2} extra times`,
    );
  }
  scene.dispose();
  if (calls.filter((c) => c.op === "remove").length !== 2) {
    violations.push("a second dispose removed something more");
  }
  return violations;
}

const BAD_ENTRIES = Object.freeze({
  "an unknown collection": { collection: "Primitive" },
  "no collection": { collection: undefined },
  "positions not a multiple of 3": {
    positionsDegreesHeights: [0, 0, 0, 1, 1],
  },
  "under two points": { positionsDegreesHeights: [0, 0, 0] },
  "a NaN position": { positionsDegreesHeights: [0, 0, 0, 1, Number.NaN, 1] },
  "an infinite position": {
    positionsDegreesHeights: [0, 0, 0, 1, 1, Number.POSITIVE_INFINITY],
  },
  "positions not an array": { positionsDegreesHeights: "0,0,0,1,1,1" },
  "a zero width": { width: 0 },
  "a negative width": { width: -3 },
  "a NaN width": { width: Number.NaN },
  "a string width": { width: "4" },
  "a non-Color material": {
    material: { type: "Image", color: [1, 1, 1, 1] },
  },
  "no material": { material: undefined },
  "a three-component colour": {
    material: { type: "Color", color: [1, 1, 1] },
  },
  "a NaN colour component": {
    material: { type: "Color", color: [1, 1, Number.NaN, 1] },
  },
});

/**
 * S3: every bad entry, first and not first, plus an empty dial list.
 *
 * @param {Function} build The stage under test.
 * @returns {string[]} Violations.
 */
function failClosedViolations(build) {
  const violations = [];
  const attempt = (label, dials) => {
    const { Cesium } = makeStub();
    const { viewer, calls } = makeViewer();
    let thrown;
    try {
      build(Cesium, viewer, dials);
    } catch (error) {
      thrown = error;
    }
    if (!(thrown instanceof TypeError)) {
      violations.push(
        `${label}: threw ${thrown === undefined ? "nothing" : thrown?.constructor?.name}, not a TypeError`,
      );
    }
    if (calls.length !== 0) {
      violations.push(`${label}: ${calls.length} scene calls before the throw`);
    }
  };
  attempt("no polylines key", {});
  attempt("an empty list", { polylines: [] });
  attempt("polylines not an array", { polylines: "nope" });
  attempt("no dials", undefined);
  for (const [name, overrides] of Object.entries(BAD_ENTRIES)) {
    attempt(`${name} first`, { polylines: [line(overrides)] });
    attempt(`${name} last`, {
      polylines: [
        line({ name: "good" }),
        line({ name: "good buffer", collection: "BufferPolylineCollection" }),
        line(overrides),
      ],
    });
  }
  return violations;
}

/**
 * Rebuild the stage from a source text, the way a probe ships it into a page.
 *
 * @param {string} source A function expression's text.
 * @returns {Function} The function.
 */
const fromSource = (source) => vm.runInThisContext(`(${source})`);

/**
 * Apply one substitution to the stage's source and refuse if it matched
 * nothing, so a mutation image cannot be a green test over unmutated text.
 *
 * @param {string|RegExp} from What to replace.
 * @param {string} to The replacement.
 * @returns {Function} The mutated stage.
 */
function mutatedStage(from, to) {
  const mutated = POLYLINE_RIG_SCENE_SOURCE.replace(from, to);
  assert.notEqual(
    mutated,
    POLYLINE_RIG_SCENE_SOURCE,
    `the mutation ${String(from)} matched nothing`,
  );
  return fromSource(mutated);
}

const rigs = await loadRigs();
const nearclip = rigById(rigs, "polyline-nearclip");
assert.ok(nearclip, "rig polyline-nearclip is not in the registry");
const nearclipDials = nearclip.dials;

// ═══════════════════════════════════════════════════════════════════════
// S1 .. S4
// ═══════════════════════════════════════════════════════════════════════

test("S1: the rig's dials give a polyline collection and a buffer collection of the right shape", () => {
  assert.deepEqual(shapeViolations(buildPolylineRigScene, nearclipDials), []);
});

test("S2: dispose removes each collection once, and nothing else", () => {
  assert.deepEqual(disposeViolations(buildPolylineRigScene), []);
});

test("S3: a bad dial throws a TypeError before anything is added", () => {
  assert.deepEqual(failClosedViolations(buildPolylineRigScene), []);
});

test("S4: the shipped source text works on its own, with the same shape", () => {
  // vm.runInThisContext sees only the global scope, so a free variable the stage read
  // from this module would throw here.
  const standalone = fromSource(POLYLINE_RIG_SCENE_SOURCE);
  assert.notEqual(standalone, buildPolylineRigScene);
  assert.deepEqual(shapeViolations(standalone, nearclipDials), []);
  assert.deepEqual(disposeViolations(standalone), []);
  assert.deepEqual(failClosedViolations(standalone), []);
});

// ═══════════════════════════════════════════════════════════════════════
// M — inertness images
// ═══════════════════════════════════════════════════════════════════════

test("M1: a buffer collection sized to zero vertices turns S1 RED", () => {
  const stage = mutatedStage(
    /vertexCountMax: vertexCount\b/u,
    "vertexCountMax: 0",
  );
  assert.ok(shapeViolations(stage, nearclipDials).length > 0);
});

test("M1b: dropping the per-kind grouping turns S1 RED", () => {
  // Every entry gets a collection of its own.
  const stage = mutatedStage(/if \(!byKind\.has\(kind\)\) \{/u, "if (true) {");
  assert.ok(shapeViolations(stage, nearclipDials).length > 0);
});

test("M2: a dispose that removes nothing turns S2 RED", () => {
  const stage = mutatedStage(
    /primitives\.remove\(collection\);/u,
    "void collection;",
  );
  assert.ok(disposeViolations(stage).length > 0);
});

test("M2b: a dispose that removes again on a second call turns S2 RED", () => {
  const stage = mutatedStage(/if \(disposed\) \{/u, "if (false) {");
  assert.ok(disposeViolations(stage).length > 0);
});

test("M3: validation made unreachable turns S3 RED", () => {
  const stage = mutatedStage(
    /for \(let i = 0; i < polylines\.length; i\+\+\) \{/u,
    "for (let i = 0; i < 0; i++) {",
  );
  assert.ok(failClosedViolations(stage).length > 0);
});

test("M3b: touching the scene before validating turns S3 RED (an add happens before the throw)", () => {
  // The checks still throw a TypeError, but only after the scene was touched.
  const mutated = POLYLINE_RIG_SCENE_SOURCE.replace(
    "const polylines = dials?.polylines;",
    "const polylines = dials?.polylines; viewer.scene.primitives.add({});",
  );
  assert.notEqual(mutated, POLYLINE_RIG_SCENE_SOURCE);
  assert.ok(failClosedViolations(fromSource(mutated)).length > 0);
});

test("M5: a stage text that reaches into module scope turns S4 RED", () => {
  // S4 runs the TEXT where module bindings do not exist; a free variable in the
  // text must therefore fail there, not be satisfied by this module.
  const stage = mutatedStage(
    /const primitives = viewer.scene.primitives;/u,
    "const primitives = moduleScopeProbe.primitivesOf(viewer);",
  );
  assert.throws(
    () => shapeViolations(stage, nearclipDials),
    /moduleScopeProbe is not defined/u,
  );
});

test("M4: the mutation helper refuses a substitution that matched nothing", () => {
  assert.throws(
    () => mutatedStage("no such text anywhere", "x"),
    /matched nothing/u,
  );
});
