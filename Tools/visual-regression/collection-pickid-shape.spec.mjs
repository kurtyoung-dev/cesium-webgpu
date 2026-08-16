// collection-pickid-shape.spec.mjs — browser-free guard for
// NEW-WEBGPU-COLLECTION-PICKID-OBJECT-SHAPE, plus a zero-cost guard on the
// CO-16 pick-pass census instrumentation.
// @purpose Guards that WebGPU collection renderers register WebGL-shaped pick-id wrappers ({primitive, collection, id}), not bare primitives; CO-16 census guard.
// @status ACTIVE
//
// ── WHY (a) EXISTS: the pick-id SHAPE ───────────────────────────────────────
//
// WebGL registers a WRAPPER for every collection item:
//
//     PointPrimitive.getPickId  → { primitive: this,             collection, id }
//     Billboard.getPickId       → { primitive: this._pickPrimitive, collection, id }
//     Polyline.getPickId        → { primitive: this,             collection, id }
//
// The three WebGPU feature renderers bypassed those factories and registered
// the BARE primitive (`context.createPickId(point, "point")`). Three
// consequences, all of them wrong and none of them a crash:
//
//   1. A resolved pick handed user code an object whose `.primitive`,
//      `.collection` and `.id` all read `undefined` — the documented Cesium
//      pick contract, silently broken only on WebGPU.
//   2. LABEL picks resolved to the INTERNAL GLYPH `Billboard`. `Billboard`'s
//      own factory registers `this._pickPrimitive`, which
//      `LabelCollection.js:302` sets to the owning `Label`; bypassing the
//      factory discards that ownership rewiring entirely.
//   3. The bare registration ALIASES the registered target with the primitive
//      itself, so the `id` setter (`PointPrimitive.js`, `Billboard.js`:
//      `this._pickId.object.id = value`) re-enters its OWN accessor. Setting
//      `.id` after the first pick would recurse without bound.
//
// The factories already existed and already passed the correct `PickKind`, so
// the fix is a routing correction, not new behaviour. This spec pins the
// routing so a future edit cannot quietly re-open it, and re-runs the checker
// against mutants that reintroduce each historical form — a rule that only
// ever sees the right answer proves nothing.
//
// ── WHY (b) EXISTS: the census must cost NOTHING in release ─────────────────
//
// CO-16 added a per-pass dispatch census to `WebGPUSceneRendererPickPass.ts`
// so the pick chain stops being unobservable between "command pushed" and
// "key decoded". Diagnostics that survive into production are exactly what the
// logging rules forbid, so every producer statement must sit inside a
// `//>>includeStart('debug', pragmas.debug)` region. A leaked counter is a
// per-command tax on every pick in every shipped build.
//
// CRLF: this repo checks out with `core.autocrlf=true`; source text is
// normalized before any assertion.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const readNormalized = (relative) =>
  readFileSync(resolve(ROOT, relative), "utf8").replaceAll("\r\n", "\n");

const WEBGPU_DIR = "packages/engine/Source/Renderer/WebGPU";
const SCENE_DIR = "packages/engine/Source/Scene";

// ───────────────────────────────────────────────────────────────────────────
// (a) the feature renderers must route through the primitive's own factory
// ───────────────────────────────────────────────────────────────────────────

/**
 * The three collection feature renderers, with the receiver each one holds its
 * item in. `getPickId` is an instance method on the ITEM, so the call has to
 * name that receiver — matching on a bare `getPickId(` would accept a call on
 * the wrong object.
 */
const FEATURE_RENDERERS = [
  {
    file: `${WEBGPU_DIR}/WebGPUPointPrimitiveRenderer.js`,
    receiver: "point",
    kind: "point",
  },
  {
    file: `${WEBGPU_DIR}/WebGPUBillboardRenderer.js`,
    receiver: "bb",
    kind: "billboard",
  },
  {
    file: `${WEBGPU_DIR}/WebGPUPolylineRenderer.js`,
    receiver: "polyline",
    kind: "polyline",
  },
];

/**
 * Drop line comments and block-comment continuation lines.
 *
 * Load-bearing, not hygiene: the fix for this very defect documents the
 * historical form IN A COMMENT (`context.createPickId(point, "point")`), so a
 * prose-blind audit would flag the corrected file and, worse, would pass a file
 * whose only remaining `getPickId` mention was itself a comment. The audit must
 * read CODE.
 */
function stripComments(source) {
  return source
    .split("\n")
    .map((line) => {
      const trimmed = line.trimStart();
      if (
        trimmed.startsWith("//") ||
        trimmed.startsWith("*") ||
        trimmed.startsWith("/*")
      ) {
        return "";
      }
      const slash = line.indexOf("//");
      return slash === -1 ? line : line.slice(0, slash);
    })
    .join("\n");
}

/**
 * Audit one feature-renderer source. Returns every violated rule by name so a
 * failure says WHICH invariant broke, not merely that one did.
 */
function auditFeatureRenderer(rawSource, receiver) {
  const source = stripComments(rawSource);
  const failures = [];
  if (!source.includes(`${receiver}.getPickId(context)`)) {
    failures.push("missing-getPickId-call");
  }
  // The bare-registration form is the defect itself. No collection feature
  // renderer has any other reason to mint a pick id directly.
  if (/\bcontext\.createPickId\s*\(/.test(source)) {
    failures.push("direct-createPickId");
  }
  // Assigning `_pickId` from the renderer re-opens the same hole through a
  // different door (it bypasses the factory's shape AND its `defined` guard).
  if (new RegExp(`\\b${receiver}\\._pickId\\s*=`).test(source)) {
    failures.push("direct-_pickId-assignment");
  }
  return { ok: failures.length === 0, failures };
}

for (const { file, receiver } of FEATURE_RENDERERS) {
  test(`${file}: pick color comes from ${receiver}.getPickId(context)`, () => {
    const result = auditFeatureRenderer(readNormalized(file), receiver);
    assert.deepEqual(
      result,
      { ok: true, failures: [] },
      `${file} must route its pick id through the primitive's own getPickId factory`,
    );
  });
}

test("the audit REJECTS each historical bare-registration form (mutants)", () => {
  // Mutant 1 — the exact pre-fix shape.
  const bare = `
    if (!defined(point._pickId)) {
      point._pickId = context.createPickId(point, "point");
    }
    const pc = point._pickId.color;
  `;
  const m1 = auditFeatureRenderer(bare, "point");
  assert.equal(m1.ok, false, "bare createPickId must be rejected");
  assert.ok(m1.failures.includes("direct-createPickId"));
  assert.ok(m1.failures.includes("direct-_pickId-assignment"));
  assert.ok(m1.failures.includes("missing-getPickId-call"));

  // Mutant 2 — calls the factory but ALSO keeps a direct mint alive on another
  // path. A checker that only looked for the good call would pass this.
  const mixed = `
    const pc = point.getPickId(context).color;
    if (somethingElse) {
      point._pickId = context.createPickId(point, "point");
    }
  `;
  const m2 = auditFeatureRenderer(mixed, "point");
  assert.equal(m2.ok, false, "a surviving direct mint must still be rejected");
  assert.deepEqual(m2.failures.sort(), [
    "direct-_pickId-assignment",
    "direct-createPickId",
  ]);

  // Mutant 3 — the good call on the WRONG receiver (a copy-paste between
  // renderers). Receiver-qualified matching is what catches this.
  const wrongReceiver = `const pc = bb.getPickId(context).color;`;
  const m3 = auditFeatureRenderer(wrongReceiver, "point");
  assert.equal(m3.ok, false, "a call on the wrong receiver must be rejected");
  assert.deepEqual(m3.failures, ["missing-getPickId-call"]);

  // Positive control — the shipped form must pass the same checker.
  const fixed = `const pc = point.getPickId(context).color;`;
  assert.deepEqual(auditFeatureRenderer(fixed, "point"), {
    ok: true,
    failures: [],
  });
});

// ───────────────────────────────────────────────────────────────────────────
// (a2) the factories themselves must register WebGL's wrapper + the right kind
// ───────────────────────────────────────────────────────────────────────────

/** Extract the body of a `getPickId(context) { ... }` method. */
function extractGetPickId(source, file) {
  const start = source.indexOf("getPickId(context) {");
  assert.notEqual(start, -1, `${file}: no getPickId(context) method found`);
  let depth = 0;
  let i = source.indexOf("{", start);
  const open = i;
  // Bounded scan: the method is a few dozen characters and the file is finite.
  for (; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  assert.fail(`${file}: unbalanced braces scanning getPickId`);
}

const FACTORIES = [
  {
    file: `${SCENE_DIR}/PointPrimitive.js`,
    kind: "point",
    primitiveExpression: "primitive: this,",
  },
  {
    file: `${SCENE_DIR}/Billboard.js`,
    kind: "billboard",
    // Load-bearing: the LABEL owns the pick, not the internal glyph billboard.
    primitiveExpression: "primitive: this._pickPrimitive,",
  },
  {
    file: `${SCENE_DIR}/Polyline.js`,
    kind: "polyline",
    primitiveExpression: "primitive: this,",
  },
];

for (const { file, kind, primitiveExpression } of FACTORIES) {
  test(`${file}: getPickId registers {primitive, collection, id} as kind "${kind}"`, () => {
    const body = extractGetPickId(readNormalized(file), file);
    assert.ok(
      body.includes(primitiveExpression),
      `${file}: getPickId must register \`${primitiveExpression}\``,
    );
    assert.ok(
      /\bcollection:\s*this\._/.test(body),
      `${file}: getPickId must register a \`collection\` slot`,
    );
    assert.ok(
      /\bid:\s*this\._id,/.test(body),
      `${file}: getPickId must register an \`id\` slot`,
    );
    assert.ok(
      body.includes(`"${kind}"`),
      `${file}: getPickId must declare the "${kind}" PickKind`,
    );
  });
}

test("LabelCollection rewires the glyph billboard's pick owner to the Label", () => {
  // This is the ONLY reason `Billboard.getPickId` reads `_pickPrimitive`
  // instead of `this`. If this line ever moves, the billboard factory's shape
  // assertion above stops meaning "label picks resolve to the Label".
  const source = readNormalized(`${SCENE_DIR}/LabelCollection.js`);
  assert.ok(
    source.includes("billboard.pickPrimitive = label;"),
    "LabelCollection must set the glyph billboard's pickPrimitive to the Label",
  );
});

test("the id setters write through the registered target (the recursion hazard)", () => {
  // Documented rationale for rule (a): with a BARE registration
  // `this._pickId.object === this`, so this assignment re-enters the `id`
  // accessor. The wrapper shape is what keeps it a plain data write.
  for (const file of [
    `${SCENE_DIR}/PointPrimitive.js`,
    `${SCENE_DIR}/Billboard.js`,
  ]) {
    const source = readNormalized(file);
    assert.ok(
      source.includes("this._pickId.object.id = value;"),
      `${file}: id setter is expected to write through _pickId.object`,
    );
  }
});

// ───────────────────────────────────────────────────────────────────────────
// (b) the CO-16 pick-pass census must be entirely debug-pragma'd
// ───────────────────────────────────────────────────────────────────────────

const PICK_PASS_FILE = `${WEBGPU_DIR}/WebGPUSceneRendererPickPass.ts`;

/**
 * Line numbers (1-based) that lie strictly inside a
 * `//>>includeStart('debug', ...)` / `//>>includeEnd('debug')` region.
 * Mirrors what `stripPragmaPlugin` removes.
 */
function debugRegionLines(source) {
  const lines = source.split("\n");
  const inside = new Set();
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes("//>>includeStart('debug'")) {
      depth++;
      continue;
    }
    if (line.includes("//>>includeEnd('debug')")) {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth > 0) inside.add(i + 1);
  }
  assert.equal(depth, 0, `${PICK_PASS_FILE}: unbalanced debug pragma regions`);
  return inside;
}

test("every pick-pass census statement is stripped from release builds", () => {
  const source = readNormalized(PICK_PASS_FILE);
  const inside = debugRegionLines(source);
  const lines = source.split("\n");

  // Producer identifiers. TYPE declarations (`PickPassCensusRow`,
  // `PickPassCensus`, `PickCensusContext`) are deliberately excluded: types are
  // erased by the compiler, not by the pragma stripper, so they cost nothing
  // and must live OUTSIDE the pragma region for `tsc` to see them.
  const producers = [
    "diagResetPickCensus",
    "diagPickCensusRow",
    "censusRow",
    "_diagPickPassCensus",
  ];

  const leaks = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Comments describe the mechanism and are free.
    const code = line.replace(/^\s*(\/\/|\*|\/\*).*$/, "");
    if (code.trim().length === 0) continue;
    for (const id of producers) {
      if (code.includes(id) && !inside.has(i + 1)) {
        leaks.push(`${i + 1}: ${line.trim().slice(0, 120)}`);
        break;
      }
    }
  }

  // The one legitimate exception is the `PickCensusContext` type ALIAS, which
  // names `_diagPickPassCensus` as a type member. Types are erased by the
  // compiler, so it emits no code and must stay outside the pragma region for
  // `tsc` to see it. Allow exactly that declaration, by name.
  const realLeaks = leaks.filter(
    (entry) => !entry.includes("type PickCensusContext ="),
  );
  assert.deepEqual(
    realLeaks,
    [],
    "pick-pass census statements must live inside debug pragma regions",
  );
});

test("the pragma-containment audit REJECTS a leaked counter (mutant)", () => {
  const mutant = [
    "function executePickBatch() {",
    "  //>>includeStart('debug', pragmas.debug);",
    "  const censusRow = diagPickCensusRow(context, passIndex);",
    "  //>>includeEnd('debug');",
    "  censusRow.dispatched++;", // ← leaked: outside the region
    "}",
  ].join("\n");

  const lines = mutant.split("\n");
  const inside = new Set();
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes("//>>includeStart('debug'")) {
      depth++;
      continue;
    }
    if (lines[i].includes("//>>includeEnd('debug')")) {
      depth--;
      continue;
    }
    if (depth > 0) inside.add(i + 1);
  }
  const leaked = lines
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line, n }) => line.includes("censusRow") && !inside.has(n));
  assert.equal(
    leaked.length,
    1,
    "the audit must see the statement that survives pragma stripping",
  );
});
