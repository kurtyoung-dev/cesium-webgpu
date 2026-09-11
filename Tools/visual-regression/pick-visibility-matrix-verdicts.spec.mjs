// pick-visibility-matrix-verdicts.spec.mjs — `AR-837`'s behaviour spec.
// @purpose Executes probe-pick-visibility-matrix's shipped decision functions over a pre-fix world and a post-fix world and requires each to REJECT the other's expectation, pins the three-way classifiers, the expectation-independent occlusion-parity row, the pick warm-up, subject renderability, the snap leg's standing and the AR-M30 clause, exercises the probe's refusal path without a browser, and proves by inertness mutants that every shipped assertion carries its own discrimination.
// @status ACTIVE
//
// WHAT `AR-837` ACTUALLY ASKS FOR. Not "a probe exists" — a diff certifies
// itself. The acceptance is that the matrix "must show that difference before
// `AR-001` lands and its disappearance after", which is a claim about
// DISCRIMINATION: the instrument has to separate two worlds, and it has to do
// it in both directions. A spec that only checked "the post-fix world passes
// `--expect after`" would be satisfied by a verdict function that returns
// `true` unconditionally.
//
// So every expectation is tested against BOTH worlds:
//
//   pre-fix  world + `--expect before`  ->  GREEN   (the reproduction)
//   pre-fix  world + `--expect after`   ->  RED     (the fix is not there)
//   post-fix world + `--expect after`   ->  GREEN   (the disappearance)
//   post-fix world + `--expect before`  ->  RED     (nothing left to show)
//
// THE FIXTURES ARE THE RECORDED MECHANISM, NOT AN INVENTED ONE. Batch 1439
// (`776e4476a0`) states, and the pre-batch tree at `08cb6fd4b2` confirms, that
// the four colour shaders ALREADY wrote `clipPos.z = 0.0` while the two pick
// shaders wrote `clipPos.z = clipPos.w` at six sites. So the pre-fix world's
// WebGPU cells are VISIBLE and UNPICKABLE — not invisible — and the spec pins
// that shape: a fixture where WebGPU also vanished would be a different defect,
// and a verdict function that accepted it would mis-attribute one.
//
// THE MUTANTS ARE `if (false && …)`, NOT DELETIONS. Deleting a clause is the
// easy mutation and most specs survive it. Sections F and G make the shipped
// clause UNREACHABLE in place — the exact form CLAUDE.md Principle 10 names —
// and require the discrimination to disappear with it. Section G additionally
// cuts the `AR-M30` block on its marker pair, because a block that returns no
// checks at all is the failure mode a "rate parity" claim is most likely to
// hide behind.
//
// NO BROWSER, NO SERVER, NO GPU. The verdict module has no imports, so a mutant
// can be executed from a `data:` URL; the probe's refusal path is reached by
// calling `descriptor.cells` directly with an object that would throw if it
// were ever touched.
//
// ROUND 2 (sections I-M) adds the decisions Eowyn's job 10 proved the
// instrument was missing, each with its own inertness mutant in section M:
//
//   I  the `ddtd = 0` cells are an OCCLUSION-PARITY row, judged identically
//      under both expectations, because job 10 measured that difference
//      BIT-IDENTICALLY on the pre- and post-`AR-001` trees
//   J  the pick warm-up: WebGPU cooks a pick pipeline asynchronously and skips
//      the pick draw meanwhile, so a leg's FIRST pick sequence read an empty
//      buffer; the cost is published and only its resolution is asserted
//   K  subject renderability: job 10's billboard measured 0 hue px in all
//      sixteen cell-measurements because its collection's draw command was
//      horizon-culled, and 0 px is indistinguishable from "occluded"
//   L  the snap leg's standing: "edge-drawing mode", "loaded", "projected" and
//      "in frame" are four claims, and job 10 banked a leg where the middle two
//      held and the last did not
//   N  the `AR-M30` subject must be ABLE to produce an edge hit — the asset the
//      shipped config names is decoded off disk and must declare
//      `EXT_mesh_primitive_edge_visibility` on a primitive, with job 10's own
//      subject as the negative control. This is the section that would have
//      caught round 2's first attempt, which re-shaped the cursor grid against
//      a model no aperture could ever have produced an `isEdge` hit from.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CAPTURE_BEGIN,
  CAPTURE_END,
  SAME_TASK_CAPTURE_SOURCE,
  checkEmbeddedCaptureIsCanonical,
} from "./lib/same-task-capture.mjs";
import { SNAP, descriptor } from "./probe-pick-visibility-matrix.mjs";
import {
  DDTD_LEGS,
  EXPECTATIONS,
  GATED_ITEMS,
  HELD_ITEMS,
  ITEMS,
  LOG_DEPTH_LEGS,
  MIN_CURSOR_OFFSET_PIXELS,
  OCCLUDED_PIXEL_CEILING,
  OCCLUSION_PARITY_ROW,
  PICK_ATTEMPTS,
  PICK_WARMUP_ATTEMPTS,
  SURFACE_POSITION_MIN_SAMPLES,
  SURFACE_POSITION_RATE_TOLERANCE,
  VISIBLE_PIXEL_FLOOR,
  afterCellPass,
  allChecksPass,
  beforeCellPass,
  buildChecks,
  cellClaim,
  classifyPick,
  classifyVisibility,
  controlChecks,
  isHeldItem,
  itemChecks,
  occlusionParityCellPass,
  pickWarmupChecks,
  resolveExpectation,
  snapLegStanding,
  subjectRenderabilityChecks,
  summarizeCell,
  surfacePositionChecks,
} from "./lib/pick-visibility-matrix-verdicts.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const VERDICTS_PATH = path.join(
  here,
  "lib",
  "pick-visibility-matrix-verdicts.mjs",
);
const verdictsSource = fs.readFileSync(VERDICTS_PATH, "utf8");

/**
 * Import a mutated copy of the verdict module. Only possible because the
 * module has no imports of its own — that is why it is a separate file.
 *
 * @param {string} source Module text.
 * @returns {Promise<object>} The module namespace.
 */
async function importSource(source) {
  return import(
    `data:text/javascript;base64,${Buffer.from(source, "utf8").toString("base64")}`
  );
}

/**
 * Make one shipped clause unreachable in place, without removing it.
 *
 * `after` names a unique preceding line when the clause itself repeats — the
 * BEFORE leg spells the same `pickClass` test in both of its branches, and a
 * mutant that hit the wrong one would prove nothing about the branch under
 * test. The anchor must be unique, and the clause must be the first occurrence
 * following it, or the mutation is refused rather than guessed.
 *
 * @param {string} source Module text.
 * @param {string} clause The `if (` condition to neutralize, verbatim.
 * @param {object} [options] Options.
 * @param {string} [options.after] A unique anchor the clause must follow.
 * @returns {string} The mutated text.
 */
function makeClauseInert(source, clause, options = {}) {
  const target = `if (${clause}) {`;
  let from = 0;
  if (options.after !== undefined) {
    const anchor = source.indexOf(options.after);
    assert.notEqual(anchor, -1, `anchor not found: ${options.after}`);
    assert.equal(
      source.indexOf(options.after, anchor + 1),
      -1,
      `anchor is not unique: ${options.after}`,
    );
    from = anchor + options.after.length;
  }
  const index = source.indexOf(target, from);
  assert.notEqual(index, -1, `clause not found in the module: ${clause}`);
  if (options.after === undefined) {
    assert.equal(
      source.indexOf(target, index + 1),
      -1,
      `clause is not unique, so the mutant would be ambiguous: ${clause}`,
    );
  }
  return (
    source.slice(0, index) +
    `if (false && ${clause}) {` +
    source.slice(index + target.length)
  );
}

/**
 * Remove a marker-delimited block from the module text.
 *
 * @param {string} source Module text.
 * @param {string} name Marker name.
 * @returns {string} The mutated text.
 */
function removeMarkedBlock(source, name) {
  const open = `/* ${name} */`;
  const close = `/* end-${name} */`;
  const from = source.indexOf(open);
  const to = source.indexOf(close);
  assert.ok(from !== -1 && to > from, `marker pair not found: ${name}`);
  return source.slice(0, from) + source.slice(to + close.length);
}

// ---------------------------------------------------------------------------
// A. The two worlds the instrument has to separate.
// ---------------------------------------------------------------------------

/**
 * One backend's measurement of one item in one cell.
 *
 * @param {number} huePixels Pixels of the item's hue in the sample window.
 * @param {number} pickHits Attempts that returned the item's own id.
 * @returns {object} The classified measurement, as the probe assembles it.
 */
function measured(huePixels, pickHits) {
  return {
    centre: { x: 400, y: 300 },
    huePixels,
    pickHits,
    pickAttempts: PICK_ATTEMPTS,
    pickIds: [],
    visibility: classifyVisibility(huePixels),
    pickClass: classifyPick(pickHits, PICK_ATTEMPTS),
  };
}

/** A subject that renders and picks: the property is honoured. */
const HONOURED = () => measured(430, PICK_ATTEMPTS);
/** A subject behind terrain with nothing overriding depth. */
const OCCLUDED = () => measured(0, 0);
/** The recorded pre-fix WebGPU shape: colour honoured it, the pick pass did not. */
const COLOUR_ONLY = () => measured(430, 0);

/**
 * Build one world's cells.
 *
 * @param {string} world `"pre-fix"` or `"post-fix"`.
 * @returns {Array<object>} Every cell of the matrix.
 */
function worldCells(world) {
  const cells = [];
  for (const logDepth of LOG_DEPTH_LEGS) {
    for (const ddtd of DDTD_LEGS) {
      for (const item of ITEMS) {
        const held = isHeldItem(item);
        const cell = { run: 0, item, ddtd, logDepth, held };
        if (ddtd === "zero") {
          cell.webgl = OCCLUDED();
          cell.webgpu = OCCLUDED();
        } else {
          cell.webgl = held ? OCCLUDED() : HONOURED();
          cell.webgpu =
            world === "pre-fix" && !held ? COLOUR_ONLY() : HONOURED();
        }
        cells.push(cell);
      }
    }
  }
  return cells;
}

/**
 * A healthy control record for each (logDepth, ddtd) page leg.
 *
 * @returns {Array<object>} The controls.
 */
function healthyControls() {
  const controls = [];
  for (const logDepth of LOG_DEPTH_LEGS) {
    for (const ddtd of DDTD_LEGS) {
      controls.push({
        run: 0,
        logDepth,
        ddtd,
        webgl: { ...HONOURED(), pickWarmup: warmup(1) },
        webgpu: { ...HONOURED(), pickWarmup: warmup(4) },
      });
    }
  }
  return controls;
}

/**
 * A warm-up that resolved. `attempts` deliberately differs by backend: WebGL
 * builds shader programs synchronously and pays one attempt, WebGPU cooks its
 * pick pipeline asynchronously and pays several. BOTH are passes — the cost is
 * published, only the resolution is asserted.
 *
 * @param {number} attempts Discarded attempts spent.
 * @param {boolean} [resolved] Whether a pick ever came back.
 * @returns {object} The warm-up record.
 */
function warmup(attempts, resolved = true) {
  return { attempts, resolved, ids: [], budget: PICK_WARMUP_ATTEMPTS };
}

/**
 * A subject that reached the screen: present, shown, image-ready where the type
 * has an image, and — the clause job 10's billboard failed — its collection's
 * draw command survived culling and reached execution.
 *
 * @param {string} item Item id.
 * @returns {object} The per-renderer renderability record.
 */
function renderable(item) {
  return {
    present: true,
    show: true,
    imageReady: item === "billboard" ? true : null,
    commandExecuted: true,
  };
}

/**
 * One renderability record per (item, log-depth page), both backends healthy.
 *
 * @returns {Array<object>} The records.
 */
function healthyRenderability() {
  const records = [];
  for (const logDepth of LOG_DEPTH_LEGS) {
    for (const item of ITEMS) {
      records.push({
        run: 0,
        item,
        logDepth,
        webgl: renderable(item),
        webgpu: renderable(item),
      });
    }
  }
  return records;
}

/**
 * A snap leg with enough far edge hits and matching defined-rates.
 *
 * @returns {Array<object>} One snap leg.
 */
function healthySnap() {
  return [
    {
      run: 0,
      snapWidth: 45,
      webgl: { farEdgeHits: 20, surfaceDefined: 12, definedRate: 0.6 },
      webgpu: { farEdgeHits: 18, surfaceDefined: 11, definedRate: 0.6111 },
    },
  ];
}

/**
 * The full check set for one world under one expectation.
 *
 * @param {string} world `"pre-fix"` or `"post-fix"`.
 * @param {string} expectation `"before"` or `"after"`.
 * @returns {Array<object>} Every check.
 */
function checksFor(world, expectation) {
  return buildChecks({
    cells: worldCells(world),
    controls: healthyControls(),
    renderability: healthyRenderability(),
    snap: healthySnap(),
    expectation,
  });
}

test("A1: the pre-fix world is VISIBLE and UNPICKABLE on WebGPU, not invisible", () => {
  // The mechanism Batch 1439 recorded and `08cb6fd4b2` confirms: the colour
  // shaders already wrote the near plane, only the pick shaders did not. A
  // fixture that made WebGPU vanish would be a different defect.
  const infinity = worldCells("pre-fix").filter(
    (cell) => cell.ddtd === "infinity" && !cell.held,
  );
  assert.ok(infinity.length > 0);
  for (const cell of infinity) {
    assert.equal(cell.webgpu.visibility, "visible");
    assert.equal(cell.webgpu.pickClass, "miss");
    assert.equal(cell.webgl.visibility, "visible");
    assert.equal(cell.webgl.pickClass, "hit");
  }
});

test("A2: the matrix covers every item in both log-depth legs and both ddtd legs", () => {
  const keys = new Set(
    worldCells("post-fix").map((cell) => summarizeCell(cell).key),
  );
  assert.equal(
    keys.size,
    ITEMS.length * LOG_DEPTH_LEGS.length * DDTD_LEGS.length,
  );
  assert.deepEqual([...LOG_DEPTH_LEGS], [true, false]);
  assert.deepEqual([...DDTD_LEGS], ["zero", "infinity"]);
});

// ---------------------------------------------------------------------------
// B. `--expect` has two first-class values and no default.
// ---------------------------------------------------------------------------

test("B1: a missing --expect is a caller error, not a silent choice of world", () => {
  for (const absent of [undefined, null, ""]) {
    assert.throws(() => resolveExpectation(absent), TypeError);
  }
});

test("B2: an unknown --expect is rejected rather than coerced", () => {
  for (const bad of ["pre", "post", "BEFORE_FIX", "true", 0]) {
    assert.throws(() => resolveExpectation(bad), TypeError);
  }
});

test("B3: both expectations are accepted, case- and space-insensitively", () => {
  assert.equal(resolveExpectation("before"), "before");
  assert.equal(resolveExpectation("  AFTER "), "after");
  assert.deepEqual([...EXPECTATIONS], ["before", "after"]);
});

// ---------------------------------------------------------------------------
// C. The classifiers are THREE-way. An undecided measurement is not evidence.
// ---------------------------------------------------------------------------

test("C1: visibility has an indeterminate band between the two bars", () => {
  assert.equal(classifyVisibility(VISIBLE_PIXEL_FLOOR), "visible");
  assert.equal(classifyVisibility(OCCLUDED_PIXEL_CEILING), "occluded");
  assert.equal(classifyVisibility(OCCLUDED_PIXEL_CEILING + 1), "indeterminate");
  assert.equal(classifyVisibility(VISIBLE_PIXEL_FLOOR - 1), "indeterminate");
  assert.equal(classifyVisibility(null), "indeterminate");
  assert.equal(classifyVisibility(Number.NaN), "indeterminate");
});

test("C2: a pick is a MISS only at zero and a HIT only near the ceiling", () => {
  assert.equal(classifyPick(0, 5), "miss");
  assert.equal(classifyPick(5, 5), "hit");
  assert.equal(classifyPick(4, 5), "hit");
  assert.equal(classifyPick(2, 5), "indeterminate");
  assert.equal(classifyPick(null, 5), "indeterminate");
  assert.equal(classifyPick(3, 0), "indeterminate");
  assert.equal(classifyPick(6, 5), "indeterminate");
});

test("C3: an indeterminate cell fails BOTH expectations", () => {
  for (const expectation of EXPECTATIONS) {
    const cells = worldCells(expectation === "before" ? "pre-fix" : "post-fix");
    assert.equal(
      allChecksPass(
        buildChecks({
          cells,
          controls: healthyControls(),
          snap: healthySnap(),
          expectation,
        }),
      ),
      true,
      "precondition: the matching world must be green before it is broken",
    );
    const muddied = cells.map((cell) =>
      cell.ddtd === "infinity" && !cell.held
        ? { ...cell, webgpu: measured(430, 2) }
        : cell,
    );
    assert.equal(
      allChecksPass(
        buildChecks({
          cells: muddied,
          controls: healthyControls(),
          snap: healthySnap(),
          expectation,
        }),
      ),
      false,
      `a 2-of-${PICK_ATTEMPTS} pick was rounded into a verdict under --expect ${expectation}`,
    );
  }
});

// ---------------------------------------------------------------------------
// D. DISCRIMINATION — each expectation rejects the other's world.
// ---------------------------------------------------------------------------

test("D1: the pre-fix world satisfies --expect before", () => {
  assert.equal(allChecksPass(checksFor("pre-fix", "before")), true);
});

test("D2: the pre-fix world FAILS --expect after", () => {
  const failing = checksFor("pre-fix", "after").filter((c) => !c.pass);
  assert.ok(
    failing.length > 0,
    "the AFTER expectation accepted a tree where WebGPU still misses the pick",
  );
  // and it fails for the right reason, in BOTH log-depth legs
  for (const logDepth of LOG_DEPTH_LEGS) {
    assert.ok(
      failing.some((c) => c.label.includes(`log-${logDepth ? "on" : "off"}`)),
      `no AFTER check fired in the log-${logDepth ? "on" : "off"} leg`,
    );
  }
  for (const item of GATED_ITEMS) {
    assert.ok(
      failing.some((c) => c.item === item),
      `${item} was not asserted under AFTER`,
    );
  }
});

test("D3: the post-fix world satisfies --expect after", () => {
  assert.equal(allChecksPass(checksFor("post-fix", "after")), true);
});

test("D4: the post-fix world FAILS --expect before", () => {
  const failing = checksFor("post-fix", "before").filter((c) => !c.pass);
  assert.ok(
    failing.length > 0,
    "the BEFORE expectation accepted a tree with no difference left to show — the reproduction leg would go green on the fixed tree",
  );
  for (const item of GATED_ITEMS) {
    assert.ok(failing.some((c) => c.item === item));
  }
});

test("D5: a WebGL anchor that stops occluding is caught under BOTH expectations", () => {
  // "No backend difference" is satisfied by two backends that are both wrong.
  for (const [world, expectation] of [
    ["pre-fix", "before"],
    ["post-fix", "after"],
  ]) {
    const cells = worldCells(world).map((cell) =>
      cell.ddtd === "zero" && !cell.held
        ? { ...cell, webgl: HONOURED(), webgpu: HONOURED() }
        : cell,
    );
    assert.equal(
      allChecksPass(
        buildChecks({
          cells,
          controls: healthyControls(),
          snap: healthySnap(),
          expectation,
        }),
      ),
      false,
      `a scene that stopped occluding passed --expect ${expectation}`,
    );
  }
});

test("D6: a WebGPU cell that is invisible AND unpickable is not recorded as the AR-001 defect", () => {
  const cells = worldCells("pre-fix").map((cell) =>
    cell.ddtd === "infinity" && !cell.held
      ? { ...cell, webgpu: OCCLUDED() }
      : cell,
  );
  assert.equal(
    allChecksPass(
      buildChecks({
        cells,
        controls: healthyControls(),
        snap: healthySnap(),
        expectation: "before",
      }),
    ),
    false,
    "a colour-pass regression was accepted as the pick-pass defect",
  );
});

test("D7: each ddtd-0 clause is load-bearing on its own", () => {
  // D5 corrupts BOTH backends at once, so any ONE of the three clauses that
  // govern the `disableDepthTestDistance = 0` leg can be made inert
  // (`if (false && …)`) with D1-D6 still green, and `afterCellPass` cannot
  // cover the gap because it only compares the backends. Each corruption below
  // trips exactly one clause, so the spec pins the clause and not the lump.
  const item = GATED_ITEMS[0];
  const base = { run: 0, item, ddtd: "zero", logDepth: true, held: false };
  for (const [what, webgl, webgpu] of [
    // The override applied where nothing should override it: visible, and
    // still not picking, so only the occluded clause can object.
    ["webgpu is VISIBLE at ddtd 0", OCCLUDED(), measured(430, 0)],
    // ... and its mirror: occluded, yet picking.
    ["webgpu PICKS at ddtd 0", OCCLUDED(), measured(0, PICK_ATTEMPTS)],
    // The WebGL anchor for this leg. A scene that stopped occluding at all is
    // D5; this is the same failure reaching only the reference backend.
    [
      "the webgl anchor stops occluding at ddtd 0",
      measured(430, 0),
      OCCLUDED(),
    ],
  ]) {
    assert.equal(
      allChecksPass(itemChecks(item, { ...base, webgl, webgpu }, "before")),
      false,
      `--expect before accepted a cell where ${what}`,
    );
  }
});

// ---------------------------------------------------------------------------
// E. The control, and the held item.
// ---------------------------------------------------------------------------

test("E1: a control that does not pick makes the run red rather than filing a defect", () => {
  const controls = healthyControls().map((control) => ({
    ...control,
    webgpu: measured(430, 0),
  }));
  for (const expectation of EXPECTATIONS) {
    const world = expectation === "before" ? "pre-fix" : "post-fix";
    assert.equal(
      allChecksPass(
        buildChecks({
          cells: worldCells(world),
          controls,
          snap: healthySnap(),
          expectation,
        }),
      ),
      false,
      `a dead pick path passed --expect ${expectation}`,
    );
  }
  const failing = controlChecks(controls[0]).filter((c) => !c.pass);
  assert.ok(failing.every((c) => c.id.startsWith("control-")));
});

test("E2: the control is asserted in EVERY (log-depth, ddtd) page leg", () => {
  const ids = healthyControls().flatMap((control) =>
    controlChecks(control).map((check) => check.id),
  );
  for (const logDepth of LOG_DEPTH_LEGS) {
    for (const ddtd of DDTD_LEGS) {
      assert.ok(
        ids.some((id) =>
          id.includes(`log-${logDepth ? "on" : "off"}/ddtd-${ddtd}`),
        ),
        `no control check for log-${logDepth}/ddtd-${ddtd}`,
      );
    }
  }
});

test("E3: the held item is measured and published but never asserted", () => {
  assert.deepEqual([...HELD_ITEMS], ["polyline"]);
  for (const item of HELD_ITEMS) {
    assert.ok(!GATED_ITEMS.includes(item));
    for (const expectation of EXPECTATIONS) {
      for (const cell of worldCells("pre-fix").filter((c) => c.item === item)) {
        assert.deepEqual(itemChecks(item, cell, expectation), []);
      }
    }
  }
  // Published: the summary still carries its row.
  const row = summarizeCell(
    worldCells("pre-fix").find((cell) => cell.item === "polyline"),
  );
  assert.equal(row.held, true);
  assert.ok(typeof row.webgpuPick === "string");
});

test("E4: a polyline that behaves like the defect cannot turn the run red", () => {
  for (const [world, expectation] of [
    ["pre-fix", "before"],
    ["post-fix", "after"],
  ]) {
    const cells = worldCells(world).map((cell) =>
      cell.item === "polyline" ? { ...cell, webgpu: OCCLUDED() } : cell,
    );
    assert.equal(
      allChecksPass(
        buildChecks({
          cells,
          controls: healthyControls(),
          snap: healthySnap(),
          expectation,
        }),
      ),
      true,
      `the held polyline was judged under --expect ${expectation}; AR-D09 has not ruled`,
    );
  }
});

// ---------------------------------------------------------------------------
// F. The `AR-M30` clause — a different row, with its own ids.
// ---------------------------------------------------------------------------

test("F1: matching defined-rates over sufficient samples pass, and carry ar-m30 ids", () => {
  const checks = surfacePositionChecks(healthySnap()[0]);
  assert.equal(allChecksPass(checks), true);
  assert.ok(checks.every((check) => check.id.startsWith("ar-m30-")));
  assert.ok(checks.some((check) => check.id === "ar-m30-parity"));
});

test("F2: too few far edge hits fails sufficiency AND parity, never publishes agreement", () => {
  const leg = {
    ...healthySnap()[0],
    webgpu: {
      farEdgeHits: SURFACE_POSITION_MIN_SAMPLES - 1,
      surfaceDefined: 4,
      definedRate: 0.6,
    },
  };
  const checks = surfacePositionChecks(leg);
  const failing = checks.filter((c) => !c.pass).map((c) => c.id);
  assert.ok(failing.includes("ar-m30-samples-webgpu"));
  assert.ok(
    failing.includes("ar-m30-parity"),
    "an unmeasurable rate was published as agreement",
  );
});

test("F3: a diverging defined-rate fails parity and only parity", () => {
  const leg = {
    ...healthySnap()[0],
    webgpu: { farEdgeHits: 18, surfaceDefined: 0, definedRate: 0.0 },
  };
  const failing = surfacePositionChecks(leg)
    .filter((c) => !c.pass)
    .map((c) => c.id);
  assert.deepEqual(failing, ["ar-m30-parity"]);
});

test("F4: the tolerance band admits a small difference and rejects a larger one", () => {
  // Deliberately NOT tested exactly ON the bar: `0.6 + 0.05` is not
  // representable in binary and lands 4e-17 outside it, so an equality test at
  // the boundary would be asserting IEEE-754 rather than the bar.
  const within = {
    ...healthySnap()[0],
    webgpu: {
      farEdgeHits: 18,
      surfaceDefined: 11,
      definedRate: 0.6 + SURFACE_POSITION_RATE_TOLERANCE * 0.9,
    },
  };
  assert.equal(allChecksPass(surfacePositionChecks(within)), true);
  const outside = {
    ...within,
    webgpu: {
      ...within.webgpu,
      definedRate: 0.6 + SURFACE_POSITION_RATE_TOLERANCE * 1.5,
    },
  };
  assert.equal(allChecksPass(surfacePositionChecks(outside)), false);
});

test("F5: an AR-M30 red never lands on an AR-001 cell verdict", () => {
  // The two rows must stay separable in the receipt: a snap red must not make
  // any matrix cell red, or `AR-030`'s open gap would read as `AR-001`'s.
  const cells = worldCells("post-fix");
  const brokenSnap = [
    {
      ...healthySnap()[0],
      webgpu: { farEdgeHits: 18, surfaceDefined: 0, definedRate: 0.0 },
    },
  ];
  const failing = buildChecks({
    cells,
    controls: healthyControls(),
    snap: brokenSnap,
    expectation: "after",
  }).filter((c) => !c.pass);
  assert.deepEqual(
    failing.map((c) => c.id),
    ["ar-m30-parity"],
  );
});

// ---------------------------------------------------------------------------
// G. INERTNESS MUTANTS — over the SHIPPED source, in place.
// ---------------------------------------------------------------------------

test("G1: making the BEFORE leg's miss clause unreachable destroys the discrimination", async () => {
  // Shipped: the fixed tree does NOT satisfy `before`.
  assert.equal(allChecksPass(checksFor("post-fix", "before")), false);

  const mutant = await importSource(
    makeClauseInert(verdictsSource, 'gpu.pickClass !== "miss"', {
      after: 'if (gl.pickClass !== "hit") {',
    }),
  );
  const cells = worldCells("post-fix").filter(
    (cell) => cell.ddtd === "infinity" && !cell.held,
  );
  for (const cell of cells) {
    assert.equal(
      beforeCellPass(cell),
      false,
      "precondition: the shipped BEFORE clause must reject a fixed cell",
    );
    assert.equal(
      mutant.beforeCellPass(cell),
      true,
      "the BEFORE expectation still rejected the fixed tree with its miss clause unreachable — something else is carrying it, so this clause is not the load-bearing one",
    );
  }
});

test("G2: making the AFTER leg's pick-difference clause unreachable destroys the discrimination", async () => {
  assert.equal(allChecksPass(checksFor("pre-fix", "after")), false);

  // Anchored: the same clause text now also appears in
  // `occlusionParityCellPass`, which answers a DIFFERENT question, so an
  // unanchored mutation would be ambiguous about which decision it disabled.
  const mutant = await importSource(
    makeClauseInert(verdictsSource, "gpu.pickClass !== gl.pickClass", {
      after: "/* expectation-assertions:after */",
    }),
  );
  const cells = worldCells("pre-fix").filter(
    (cell) => cell.ddtd === "infinity" && !cell.held,
  );
  for (const cell of cells) {
    assert.equal(afterCellPass(cell), false);
    assert.equal(
      mutant.afterCellPass(cell),
      true,
      "the AFTER expectation still rejected the pre-fix tree with its pick-difference clause unreachable",
    );
  }
});

test("G3: making the BEFORE leg's WebGL anchor unreachable lets a two-backend miss pass as the defect", async () => {
  const mutant = await importSource(
    makeClauseInert(verdictsSource, 'gl.pickClass !== "hit"'),
  );
  // A world where NEITHER backend picks: no difference exists, so it is not
  // the AR-001 reproduction. The shipped clause says so; the mutant does not.
  const cell = {
    run: 0,
    item: "billboard",
    ddtd: "infinity",
    logDepth: true,
    held: false,
    webgl: COLOUR_ONLY(),
    webgpu: COLOUR_ONLY(),
  };
  assert.equal(beforeCellPass(cell), false);
  assert.equal(
    mutant.beforeCellPass(cell),
    true,
    "the WebGL anchor inside beforeCellPass is inert; a scene where nothing picks would be filed as the WebGPU defect",
  );
});

test("G4: removing the AR-M30 block makes a diverging rate publish as agreement", async () => {
  const leg = {
    ...healthySnap()[0],
    webgpu: { farEdgeHits: 2, surfaceDefined: 0, definedRate: 0.0 },
  };
  assert.equal(allChecksPass(surfacePositionChecks(leg)), false);

  const mutant = await importSource(
    removeMarkedBlock(verdictsSource, "snap-assertions:ar-m30"),
  );
  assert.deepEqual(
    mutant.surfacePositionChecks(leg),
    [],
    "the AR-M30 block survived its own removal",
  );
  assert.equal(
    mutant.allChecksPass(mutant.surfacePositionChecks(leg)),
    true,
    "a check set of zero must read as vacuously green — that is exactly why the sufficiency check exists",
  );
  // and the rest of the module still works, so G4 is a weakening not a break
  assert.equal(mutant.classifyPick(0, 5), "miss");
  assert.equal(mutant.afterCellPass(worldCells("post-fix")[0]), true);
});

// ---------------------------------------------------------------------------
// H. The probe's refusal path, without opening anything.
// ---------------------------------------------------------------------------

/** A browser that fails loudly if the refusal path ever reaches it. */
const forbiddenBrowser = new Proxy(
  {},
  {
    get(_target, property) {
      throw new Error(
        `probe-pick-visibility-matrix touched the browser (${String(property)}) before refusing`,
      );
    },
  },
);

test("H1: a missing --expect is a caller error and no browser is opened", async () => {
  await assert.rejects(
    () =>
      descriptor.cells({
        browser: forbiddenBrowser,
        origin: "http://localhost:8094",
        outputDirectory: path.join(here, "output", "unused-h1"),
        options: { renderers: ["webgl", "webgpu"], runs: 1 },
        run: 0,
      }),
    TypeError,
  );
});

test("H2: a single-renderer run REFUSES rather than reporting a one-sided matrix", async () => {
  await assert.rejects(
    () =>
      descriptor.cells({
        browser: forbiddenBrowser,
        origin: "http://localhost:8094",
        outputDirectory: path.join(here, "output", "unused-h2"),
        options: { renderers: ["webgpu"], runs: 1, expect: "after" },
        run: 0,
      }),
    (error) => {
      assert.equal(error.name, "ProbeRefusal");
      assert.equal(error.reason, "renderer-pair-required");
      assert.equal(error.exitCode, 3);
      return true;
    },
  );
});

test("H3: the probe declares its runtime residency and its two measurement rows", () => {
  const source = fs.readFileSync(
    path.join(here, "probe-pick-visibility-matrix.mjs"),
    "utf8",
  );
  assert.match(source, /@runtime lib\/probe-runtime\.mjs/);
  assert.match(source, /@purpose /);
  assert.match(source, /@status ACTIVE/);
  // The watchdog is the only construct that ends a hung probe.
  assert.match(source, /WATCHDOG_BUDGET_MS/);
  assert.equal(descriptor.name, "pick-visibility-matrix");
  const flags = descriptor.args.extraOptions.map((option) => option.flag);
  assert.ok(flags.includes("--expect"));
  assert.ok(flags.includes("--snap-width"));
  // `--expect` carries no default, which is what makes B1 reachable at runtime.
  const expectSpec = descriptor.args.extraOptions.find(
    (option) => option.flag === "--expect",
  );
  assert.equal(Object.hasOwn(expectSpec, "default"), false);
});

test("H4: the AR-M30 offset bar is the row's own words: MORE than 2 px", () => {
  assert.equal(MIN_CURSOR_OFFSET_PIXELS, 2);
});

test("H5: the in-page module reads pixels only through the canonical same-task capture", () => {
  // The defect this pins is the one this lane's own first draft carried: a
  // `drawImage` of the LIVE scene canvas after a yield reads a cleared WebGL
  // drawing buffer or an invalidated WebGPU swap-chain texture, and returns
  // black. This probe's finding is "the item is not there", so that failure
  // manufactures its expected result on both backends and on both trees while
  // every verdict goes green.
  const pageSource = fs.readFileSync(
    path.join(here, "lib", "pick-visibility-matrix-page.mjs"),
    "utf8",
  );
  assert.ok(pageSource.includes(CAPTURE_BEGIN));
  assert.ok(pageSource.includes(CAPTURE_END));
  assert.deepEqual(
    checkEmbeddedCaptureIsCanonical(pageSource),
    [],
    "the embedded same-task-capture block has drifted from lib/same-task-capture.mjs",
  );
  // The only `drawImage` CALL in the file is the canonical block's own decode
  // of an immutable PNG `Image`, never the scene canvas. Comment lines naming
  // the defect are not calls and are dropped before the search, or the
  // assertion would forbid explaining what it forbids.
  const outsideBlock = pageSource
    .split(CAPTURE_BEGIN)[0]
    .concat(pageSource.split(CAPTURE_END)[1] ?? "");
  const codeLines = outsideBlock
    .split(String.fromCharCode(10))
    .filter((line) => {
      const trimmed = line.trim();
      return !(
        trimmed.startsWith("//") ||
        trimmed.startsWith("*") ||
        trimmed.startsWith("/*")
      );
    });
  assert.deepEqual(
    codeLines.filter((line) => line.includes("drawImage(")),
    [],
    "a second pixel reader appeared beside the canonical primitives",
  );
  assert.ok(SAME_TASK_CAPTURE_SOURCE.includes("canvas.toDataURL"));
});

test("H6: neither shipped file exceeds the fork's 1,000-line rule", () => {
  for (const relative of [
    "probe-pick-visibility-matrix.mjs",
    path.join("lib", "pick-visibility-matrix-page.mjs"),
    path.join("lib", "pick-visibility-matrix-verdicts.mjs"),
  ]) {
    const lineCount = fs
      .readFileSync(path.join(here, relative), "utf8")
      .split(String.fromCharCode(10)).length;
    assert.ok(
      lineCount < 1000,
      `${relative} is ${lineCount} lines; CLAUDE.md asks for decomposition past ~1000`,
    );
  }
});

// ---------------------------------------------------------------------------
// I. The `ddtd = 0` cells are an OCCLUSION-PARITY row, not `AR-001`.
//
// Job 10 measured, with BIT-IDENTICAL numbers on the pre- and post-`AR-001`
// trees: with `logarithmicDepthBuffer = false` at `ddtd 0`, WebGPU fails to
// occlude subjects 60 km behind terrain that WebGL occludes — `label` VISIBLE
// 399 px and HIT 5/5, `point` indeterminate at 35 px, `polyline` (held) VISIBLE
// 294 px and HIT 5/5 — while the same cells with log depth ON are correctly
// occluded on both backends. A difference present on BOTH sides of a fix is not
// that fix's business, so these cells answer their own question under both
// expectations and their claims say which row owns them.
// ---------------------------------------------------------------------------

/**
 * Job 10's measured `ddtd 0` / log-off shape for one item: WebGL occludes and
 * does not pick, WebGPU does whatever it was measured doing.
 *
 * @param {string} item Item id.
 * @param {number} huePixels WebGPU's hue pixels.
 * @param {number} pickHits WebGPU's pick hits.
 * @returns {object} The cell.
 */
function occlusionEscapeCell(item, huePixels, pickHits) {
  return {
    run: 0,
    item,
    ddtd: "zero",
    logDepth: false,
    held: isHeldItem(item),
    webgl: measured(0, 0),
    webgpu: measured(huePixels, pickHits),
  };
}

test("I1: the occlusion-parity decision gives the SAME answer under both expectations", () => {
  // The label's recorded escape: WebGL occludes, WebGPU renders it and picks it.
  const escaped = occlusionEscapeCell("label", 399, PICK_ATTEMPTS);
  assert.equal(occlusionParityCellPass(escaped), false);
  // Both expectation entry points route a `ddtd 0` cell through it, so neither
  // `--expect` value can make this cell read differently.
  assert.equal(beforeCellPass(escaped), false);
  assert.equal(afterCellPass(escaped), false);

  const agreeing = occlusionEscapeCell("label", 0, 0);
  assert.equal(occlusionParityCellPass(agreeing), true);
  assert.equal(beforeCellPass(agreeing), true);
  assert.equal(afterCellPass(agreeing), true);
});

test("I2: a ddtd-0 cell's claim names the occlusion row and never AR-001", () => {
  for (const expectation of EXPECTATIONS) {
    const cell = occlusionEscapeCell("label", 399, PICK_ATTEMPTS);
    const checks = itemChecks("label", cell, expectation);
    const decision = checks.at(-1);

    // The check LABEL is folded away by `allChecksPass` and never reaches
    // `report.json`; the CLAIM is what a reader sees beside the red, so both
    // have to name the row or the attribution is lost exactly where it is read.
    const claim = cellClaim(cell, expectation);
    assert.ok(
      claim.startsWith(OCCLUSION_PARITY_ROW),
      `the published claim does not name the occlusion row: ${claim}`,
    );
    assert.equal(
      claim.includes(`AR-837/${expectation}`),
      false,
      `a ddtd-0 red would publish under an AR-001 expectation claim: ${claim}`,
    );
    // ... and the `ddtd = infinity` cells must still carry the expectation, or
    // the branch would have thrown the attribution away in the other direction.
    const gated = { item: "label", ddtd: "infinity", logDepth: true };
    assert.ok(
      cellClaim(gated, expectation).startsWith(`AR-837/${expectation}`),
    );
    assert.equal(decision.pass, false);
    assert.ok(
      decision.label.includes("occlusion-parity"),
      `the ddtd-0 decision under --expect ${expectation} does not name the occlusion row: ${decision.label}`,
    );
    // The label may SAY "not AR-001"; what it must never be is one of the two
    // expectation claims, which are what attribute a red to `AR-001`.
    assert.ok(
      !decision.label.includes("the AR-001 difference is PRESENT"),
      `a ddtd-0 red was filed as the AR-001 reproduction: ${decision.label}`,
    );
    assert.ok(
      !decision.label.includes("no backend difference"),
      `a ddtd-0 red was filed as the AR-001 disappearance: ${decision.label}`,
    );
  }
});

test("I3: an item that is indeterminate on WebGPU at ddtd 0 is still red, not rounded", () => {
  // The recorded `point` escape: 35 px is between the occluded ceiling and the
  // visible floor, so its visibility is `indeterminate` and cannot equal
  // WebGL's `occluded`. A parity check that coerced it would publish agreement.
  const cell = occlusionEscapeCell("point", 35, 0);
  assert.equal(cell.webgpu.visibility, "indeterminate");
  assert.equal(occlusionParityCellPass(cell), false);
});

test("I4: the ddtd-infinity cells are STILL governed by --expect", () => {
  // The re-homing must not have taken the `AR-001` cells with it.
  const preFix = worldCells("pre-fix").filter(
    (cell) => cell.ddtd === "infinity" && !cell.held,
  );
  assert.ok(preFix.length > 0);
  for (const cell of preFix) {
    assert.equal(beforeCellPass(cell), true);
    assert.equal(afterCellPass(cell), false);
  }
});

// ---------------------------------------------------------------------------
// J. The pick warm-up. Measured and published; only its resolution is asserted.
// ---------------------------------------------------------------------------

test("J1: a warm-up that resolved passes at ANY cost, on either backend", () => {
  for (const attempts of [1, 4, PICK_WARMUP_ATTEMPTS]) {
    const control = {
      run: 0,
      logDepth: true,
      ddtd: "infinity",
      webgl: { ...HONOURED(), pickWarmup: warmup(1) },
      webgpu: { ...HONOURED(), pickWarmup: warmup(attempts) },
    };
    assert.equal(
      allChecksPass(pickWarmupChecks(control)),
      true,
      `a resolved warm-up costing ${attempts} attempts was judged a failure; the cost is published, not asserted`,
    );
    // ... and the cost reaches the receipt reader.
    const webgpuCheck = pickWarmupChecks(control).find((check) =>
      check.id.endsWith("webgpu"),
    );
    assert.ok(
      webgpuCheck.label.includes(
        `after ${attempts} of ${PICK_WARMUP_ATTEMPTS}`,
      ),
      `the warm-up cost is not published in the check label: ${webgpuCheck.label}`,
    );
  }
});

test("J2: a warm-up that never resolved is red, on that backend alone", () => {
  const control = {
    run: 0,
    logDepth: false,
    ddtd: "zero",
    webgl: { ...HONOURED(), pickWarmup: warmup(1) },
    webgpu: { ...HONOURED(), pickWarmup: warmup(PICK_WARMUP_ATTEMPTS, false) },
  };
  const checks = pickWarmupChecks(control);
  assert.equal(allChecksPass(checks), false);
  assert.equal(
    checks.find((check) => check.id.endsWith("webgl")).pass,
    true,
    "a WebGPU warm-up failure must not implicate WebGL",
  );
  assert.equal(checks.find((check) => check.id.endsWith("webgpu")).pass, false);
});

test("J3: a control with no warm-up record at all is red, not vacuously green", () => {
  // The shape a page that skipped the warm-up would produce. It must not read
  // as "nothing to check" — that is how the control stopped being load-bearing.
  const control = {
    run: 0,
    logDepth: true,
    ddtd: "zero",
    webgl: HONOURED(),
    webgpu: HONOURED(),
  };
  const checks = pickWarmupChecks(control);
  assert.equal(checks.length, 2);
  assert.equal(allChecksPass(checks), false);
});

test("J4: warm-up ids are their own and never collide with a cell verdict id", () => {
  const ids = healthyControls().flatMap((control) =>
    pickWarmupChecks(control).map((check) => check.id),
  );
  assert.equal(new Set(ids).size, ids.length, "warm-up ids are not unique");
  const cellIds = new Set(
    worldCells("post-fix").map((cell) => summarizeCell(cell).key),
  );
  for (const id of ids) {
    assert.ok(id.startsWith("pick-warmup-"));
    assert.ok(!cellIds.has(id));
  }
});

// ---------------------------------------------------------------------------
// K. Subject renderability — the check job 10's billboard needed and lacked.
//
// The billboard measured 0 hue px in all 16 cell-measurements on both backends
// and both trees, INCLUDING the cells where this probe's own WebGL anchor
// requires it VISIBLE, because its collection's draw command was culled by the
// horizon occluder before it could draw. 0 px and "occluded" are the same
// number, so the matrix reported a red it could not attribute.
// ---------------------------------------------------------------------------

test("K1: a collection whose draw command was culled is a named red on both backends", () => {
  const record = {
    run: 0,
    item: "billboard",
    logDepth: true,
    webgl: { ...renderable("billboard"), commandExecuted: false },
    webgpu: { ...renderable("billboard"), commandExecuted: false },
  };
  const checks = subjectRenderabilityChecks(record);
  assert.equal(checks.length, 2);
  assert.equal(allChecksPass(checks), false);
  for (const check of checks) {
    assert.equal(check.pass, false);
    assert.ok(check.id.startsWith("subject-renderable-billboard/log-on-"));
    assert.ok(check.label.includes("commandExecuted false"));
  }
});

test("K2: a type with no image gate is not failed for having none", () => {
  // `imageReady: null` means "this type has no atlas image", and only an
  // explicit `false` is a failure. A checker that treated null as falsy would
  // fail the label, point and polyline in every run that ever ran.
  for (const item of ITEMS) {
    const record = {
      run: 0,
      item,
      logDepth: false,
      webgl: renderable(item),
      webgpu: renderable(item),
    };
    assert.equal(allChecksPass(subjectRenderabilityChecks(record)), true);
  }
  const notReady = {
    run: 0,
    item: "billboard",
    logDepth: false,
    webgl: renderable("billboard"),
    webgpu: { ...renderable("billboard"), imageReady: false },
  };
  assert.equal(allChecksPass(subjectRenderabilityChecks(notReady)), false);
});

test("K3: renderability is asserted for the HELD item too", () => {
  // `AR-D09` holds the polyline's `disableDepthTestDistance` BEHAVIOUR. Whether
  // the polyline reached the screen at all is not that question — and job 10's
  // WebGL polyline anchor was silently culled in all four of its cells, which
  // the held-item exemption hid.
  const record = {
    run: 0,
    item: "polyline",
    logDepth: true,
    webgl: { ...renderable("polyline"), commandExecuted: false },
    webgpu: renderable("polyline"),
  };
  const checks = subjectRenderabilityChecks(record);
  assert.equal(checks.find((check) => check.id.endsWith("webgl")).pass, false);
  assert.equal(checks.find((check) => check.id.endsWith("webgpu")).pass, true);
  // ... and it reaches the full check set, which the held item's CELL does not.
  const full = buildChecks({
    cells: worldCells("post-fix"),
    controls: healthyControls(),
    renderability: [record],
    snap: healthySnap(),
    expectation: "after",
  });
  assert.equal(allChecksPass(full), false);
});

// ---------------------------------------------------------------------------
// L. The snap leg's standing. Four claims, not one.
// ---------------------------------------------------------------------------

test("L1: edge-mode, loaded, projected and in-frame are four separate refusals", () => {
  assert.equal(snapLegStanding({}).code, "snap-edge-mode-unresolved");
  assert.equal(
    snapLegStanding({ edgeModeResolved: true }).code,
    "snap-model-never-ready",
  );
  assert.equal(
    snapLegStanding({ edgeModeResolved: true, modelReady: true }).code,
    "snap-model-not-projected",
  );
  // Job 10's exact shape: the earlier claims true, no model in frame.
  assert.equal(
    snapLegStanding({
      edgeModeResolved: true,
      modelReady: true,
      projected: true,
      inFrame: false,
    }).code,
    "snap-model-not-in-frame",
  );
  assert.equal(
    snapLegStanding({
      edgeModeResolved: true,
      modelReady: true,
      projected: true,
      inFrame: true,
    }),
    null,
  );
});

test("L2: a leg with no standing never publishes an AR-M30 rate", () => {
  // The refusal has to come BEFORE the rate, because a leg with no subject
  // produces `farEdgeHits: 0` on both backends — which the sufficiency check
  // also reds, but as an `AR-030` finding rather than as "we measured nothing".
  const emptyLeg = {
    edgeModeResolved: true,
    modelReady: true,
    projected: true,
    inFrame: false,
    farEdgeHits: 0,
    surfaceDefined: 0,
    definedRate: null,
  };
  assert.notEqual(snapLegStanding(emptyLeg), null);
  const wouldHavePublished = surfacePositionChecks({
    snapWidth: 45,
    webgl: emptyLeg,
    webgpu: emptyLeg,
  });
  assert.equal(allChecksPass(wouldHavePublished), false);
});

// ---------------------------------------------------------------------------
// M. INERTNESS MUTANTS for round 2's decisions, over the SHIPPED source.
// ---------------------------------------------------------------------------

test("M1: removing the occlusion-parity block makes the recorded escape stop failing", async () => {
  const escaped = occlusionEscapeCell("label", 399, PICK_ATTEMPTS);
  assert.equal(occlusionParityCellPass(escaped), false);

  const mutant = await importSource(
    removeMarkedBlock(verdictsSource, "occlusion-assertions:parity"),
  );
  assert.equal(
    mutant.occlusionParityCellPass(escaped),
    undefined,
    "the occlusion-parity block survived its own removal",
  );
  // Both expectation entry points consume it, so the weakening is real: neither
  // rejects the recorded escape any more.
  assert.notEqual(mutant.beforeCellPass(escaped), false);
  assert.notEqual(mutant.afterCellPass(escaped), false);
});

test("M2: making the occlusion-parity pick clause unreachable loses the pick escape", async () => {
  const mutant = await importSource(
    makeClauseInert(verdictsSource, "gpu.pickClass !== gl.pickClass", {
      after: "/* occlusion-assertions:parity */",
    }),
  );
  // A cell where WebGPU is correctly occluded but STILL picks through terrain:
  // only the pick clause separates it.
  const pickOnly = occlusionEscapeCell("label", 0, PICK_ATTEMPTS);
  assert.equal(occlusionParityCellPass(pickOnly), false);
  assert.equal(
    mutant.occlusionParityCellPass(pickOnly),
    true,
    "the occlusion-parity pick clause is inert; a WebGPU pick through terrain would publish as parity",
  );
});

test("M3: removing the warm-up block makes a dead pick path publish as warm", async () => {
  const control = {
    run: 0,
    logDepth: true,
    ddtd: "zero",
    webgl: { ...HONOURED(), pickWarmup: warmup(1) },
    webgpu: { ...HONOURED(), pickWarmup: warmup(PICK_WARMUP_ATTEMPTS, false) },
  };
  assert.equal(allChecksPass(pickWarmupChecks(control)), false);

  const mutant = await importSource(
    removeMarkedBlock(verdictsSource, "warmup-assertions:resolved"),
  );
  assert.deepEqual(
    mutant.pickWarmupChecks(control),
    [],
    "the warm-up block survived its own removal",
  );
  assert.equal(mutant.allChecksPass(mutant.pickWarmupChecks(control)), true);
});

test("M4: removing the renderability block makes a culled subject publish as measured", async () => {
  const record = {
    run: 0,
    item: "billboard",
    logDepth: true,
    webgl: { ...renderable("billboard"), commandExecuted: false },
    webgpu: { ...renderable("billboard"), commandExecuted: false },
  };
  assert.equal(allChecksPass(subjectRenderabilityChecks(record)), false);

  const mutant = await importSource(
    removeMarkedBlock(verdictsSource, "renderability-assertions:subject"),
  );
  assert.deepEqual(
    mutant.subjectRenderabilityChecks(record),
    [],
    "the renderability block survived its own removal",
  );
  assert.equal(
    mutant.allChecksPass(mutant.subjectRenderabilityChecks(record)),
    true,
    "job 10's billboard defect would again read as occlusion",
  );
});

test("M5: making the in-frame clause unreachable restores job 10's silent snap leg", async () => {
  const buried = {
    edgeModeResolved: true,
    modelReady: true,
    projected: true,
    inFrame: false,
  };
  assert.equal(snapLegStanding(buried).code, "snap-model-not-in-frame");

  const mutant = await importSource(
    makeClauseInert(verdictsSource, "leg.inFrame !== true"),
  );
  assert.equal(
    mutant.snapLegStanding(buried),
    null,
    "the in-frame clause is inert; a page with no model in it would report a surfacePosition rate again",
  );
  // The earlier claims still refuse, so M5 is a weakening not a break.
  assert.equal(
    mutant.snapLegStanding({ edgeModeResolved: true }).code,
    "snap-model-never-ready",
  );
});

test("M6: making the occlusion claim branch inert files a ddtd-0 red as AR-001", async () => {
  const cell = occlusionEscapeCell("label", 399, PICK_ATTEMPTS);
  for (const expectation of EXPECTATIONS) {
    assert.ok(cellClaim(cell, expectation).startsWith(OCCLUSION_PARITY_ROW));
  }

  const mutant = await importSource(
    makeClauseInert(verdictsSource, 'cell?.ddtd !== "infinity"'),
  );
  for (const expectation of EXPECTATIONS) {
    const claim = mutant.cellClaim(cell, expectation);
    assert.equal(
      claim.includes(OCCLUSION_PARITY_ROW),
      false,
      "the claim branch is inert; the occlusion reds would publish under an AR-001 expectation claim again",
    );
    assert.ok(claim.startsWith(`AR-837/${expectation}`));
  }
  // The `ddtd = infinity` claim is unchanged by the mutation, so M6 names the
  // branch and not the whole function.
  const infinity = { item: "label", ddtd: "infinity", logDepth: true };
  assert.equal(
    mutant.cellClaim(infinity, "before"),
    cellClaim(infinity, "before"),
  );
});

test("M7: making the edge-mode clause inert lets a surfaces-only leg report a rate", async () => {
  // The leg WebGPU would produce with the default display mode: the model
  // loads, projects and is in frame, and its edge emitter never runs.
  const surfacesOnly = {
    edgeModeResolved: false,
    modelReady: true,
    projected: true,
    inFrame: true,
  };
  assert.equal(snapLegStanding(surfacesOnly).code, "snap-edge-mode-unresolved");

  const mutant = await importSource(
    makeClauseInert(verdictsSource, "leg.edgeModeResolved !== true"),
  );
  assert.equal(
    mutant.snapLegStanding(surfacesOnly),
    null,
    "the edge-mode clause is inert; a leg whose subject cannot draw edges would publish a surfacePosition rate",
  );
  // The three later claims still refuse, so M7 is a weakening not a break.
  assert.equal(mutant.snapLegStanding({}).code, "snap-model-never-ready");
});

// ---------------------------------------------------------------------------
// N. The `AR-M30` subject must be ABLE to produce an edge hit.
//
// Job 10's snap leg was not defeated by its cursor pattern. `isEdge` is a
// fragment flag written only by a model's edge pass (`ModelFS.glsl:68,202-203`
// under `#ifdef HAS_EDGE_VISIBILITY`), the stage exists only when the glTF
// primitive carries `EXT_mesh_primitive_edge_visibility`
// (`ModelRuntimePrimitive.js:269,357-363`; `GltfLoader.js:1415-1418`), and
// `SnapFramebuffer.js:56` is the only place the flag is ever derived. Job 10's
// subject carried no extensions at all, so its 81/81 zero-`isEdge` result was a
// property of the ASSET and no aperture could have moved it.
//
// This section decodes the asset the SHIPPED config names, out of the bytes on
// disk, and requires the extension to be there. The negative control decodes
// job 10's own subject and requires the same check to REJECT it — otherwise the
// check is text that happens to be true rather than a discriminating one.
// ---------------------------------------------------------------------------

/**
 * Read a `.glb`'s JSON chunk. Container parse only: a 12-byte header then
 * length-prefixed chunks, the first of type `JSON`.
 *
 * @param {string} file Absolute path to the binary glTF.
 * @returns {object} The parsed glTF JSON.
 */
function readGlbJson(file) {
  const bytes = fs.readFileSync(file);
  assert.equal(bytes.toString("ascii", 0, 4), "glTF", `not a glb: ${file}`);
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32LE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8).trim();
    if (type === "JSON") {
      return JSON.parse(
        bytes.toString("utf8", offset + 8, offset + 8 + length),
      );
    }
    offset += 8 + length;
  }
  throw new Error(`no JSON chunk in ${file}`);
}

/**
 * Does this glTF declare the edge-visibility extension on a primitive?
 *
 * The declaration that matters is the PRIMITIVE's: `GltfLoader` populates
 * `primitive.edgeVisibility` from `primitive.extensions`, not from
 * `extensionsUsed`.
 *
 * @param {object} gltf Parsed glTF JSON.
 * @param {string} extension The extension name.
 * @returns {boolean} Whether any primitive carries it.
 */
function anyPrimitiveHasExtension(gltf, extension) {
  return (gltf.meshes ?? []).some((mesh) =>
    (mesh.primitives ?? []).some((primitive) =>
      Object.hasOwn(primitive.extensions ?? {}, extension),
    ),
  );
}

test("N1: the AR-M30 subject carries EXT_mesh_primitive_edge_visibility", () => {
  // The served URL is repository-root-relative (`server.js` serves `.`), so
  // the file the Edge leg fetches is the file this test decodes.
  const file = path.join(here, "..", "..", SNAP.modelUrl.replace(/^[/]/, ""));
  assert.ok(fs.existsSync(file), `the AR-M30 subject is not on disk: ${file}`);

  const gltf = readGlbJson(file);
  assert.ok(
    (gltf.extensionsUsed ?? []).includes(SNAP.requiredExtension),
    `${SNAP.modelUrl} does not declare ${SNAP.requiredExtension} in extensionsUsed`,
  );
  assert.ok(
    anyPrimitiveHasExtension(gltf, SNAP.requiredExtension),
    `no primitive of ${SNAP.modelUrl} carries ${SNAP.requiredExtension}, so no fragment can set the snap payload's edge flag`,
  );
});

test("N2: the same check REJECTS job 10's subject", () => {
  // The discrimination proof. If this passed, N1 would be asserting nothing.
  const file = path.join(
    here,
    "..",
    "..",
    "Apps/SampleData/models/CesiumMilkTruck/CesiumMilkTruck.glb",
  );
  assert.ok(fs.existsSync(file));
  const gltf = readGlbJson(file);
  assert.equal(gltf.extensionsUsed, undefined);
  assert.equal(
    anyPrimitiveHasExtension(gltf, SNAP.requiredExtension),
    false,
    "job 10's subject would now pass N1, so N1 discriminates nothing",
  );
});

test("N4: the numeric EdgeDisplayMode fallback matches the engine's own enum", () => {
  // The page prefers `Cesium.EdgeDisplayMode` and falls back to these numbers
  // for a bundle whose barrel does not re-export the enum — the two shipped
  // edge probes drive the feature by number for the same reason. A mirror is
  // only safe while something compares it to the original, so this reads the
  // engine enum out of its own source and requires every entry to agree.
  const enumSource = fs.readFileSync(
    path.join(
      here,
      "..",
      "..",
      "packages/engine/Source/Scene/EdgeDisplayMode.js",
    ),
    "utf8",
  );
  const values = {};
  for (const [, name, value] of enumSource.matchAll(
    /^\s{2}([A-Z_]+):\s*(\d+),$/gm,
  )) {
    values[name] = Number(value);
  }
  // The enum has three members; a regex that matched none would make the loop
  // below vacuous.
  assert.equal(Object.keys(values).length, 3, JSON.stringify(values));
  assert.deepEqual(SNAP.edgeModeValues, values);
});

// ---------------------------------------------------------------------------
// O. The PUBLISHED verdicts — `descriptor.verdicts` executed, not inspected.
//
// Every section above executes decision functions. None of them executed the
// probe's own `verdicts()`, which is where those decisions become the rows a
// reader of `report.json` sees — and which is on the Edge leg's only execution
// path. That is precisely the gap `probe-descriptor-cells-contract.spec.mjs`
// was written for after `AR-752`'s three-character `cells()` defect survived a
// landing, a review and a fleet of source-reading guards. This section runs the
// real function over a healthy world and pins the shape the runtime needs and
// the attribution the two rows need.
// ---------------------------------------------------------------------------

/**
 * One run's `cells()` entry, healthy on every axis.
 *
 * @param {string} world `"pre-fix"` or `"post-fix"`.
 * @param {string} expectation `"before"` or `"after"`.
 * @returns {object} The entry `verdicts()` consumes.
 */
function healthyEntry(world, expectation) {
  return {
    run: 0,
    expectation,
    cells: worldCells(world),
    controls: healthyControls(),
    renderability: healthyRenderability(),
    snap: healthySnap(),
    gates: [{ gateErrors: 0, deviceLost: false }],
  };
}

test("O1: descriptor.verdicts runs and publishes the shape the runtime requires", () => {
  for (const expectation of EXPECTATIONS) {
    const published = descriptor.verdicts([
      healthyEntry("post-fix", expectation),
    ]);
    // 16 renderability + 8 warm-up + 4 control + 12 judged cells + 3 ar-m30 + 1 gate.
    assert.equal(published.length, 44);
    const ids = new Set();
    for (const verdict of published) {
      assert.equal(typeof verdict.id, "string", JSON.stringify(verdict));
      assert.equal(typeof verdict.claim, "string", JSON.stringify(verdict));
      assert.equal(typeof verdict.pass, "boolean", JSON.stringify(verdict));
      assert.equal(
        ids.has(verdict.id),
        false,
        `duplicate verdict id: ${verdict.id}`,
      );
      ids.add(verdict.id);
    }
    // The held item is measured and published in the receipt, never judged.
    assert.equal(
      published.some((verdict) => verdict.id.startsWith("polyline/")),
      false,
    );
  }
});

test("O2: the published ddtd-0 claims name the occlusion row, the ddtd-infinity claims the expectation", () => {
  for (const expectation of EXPECTATIONS) {
    const published = descriptor.verdicts([
      healthyEntry("post-fix", expectation),
    ]);
    const cellVerdicts = published.filter((verdict) =>
      GATED_ITEMS.some((item) => verdict.id.startsWith(`${item}/`)),
    );
    assert.equal(cellVerdicts.length, 12);
    let zero = 0;
    let infinity = 0;
    for (const verdict of cellVerdicts) {
      if (verdict.id.includes("ddtd-zero")) {
        zero++;
        assert.ok(
          verdict.claim.startsWith(OCCLUSION_PARITY_ROW),
          `a ddtd-0 verdict reaches report.json under ${verdict.claim}`,
        );
      } else {
        infinity++;
        assert.ok(
          verdict.claim.startsWith(`AR-837/${expectation}`),
          verdict.claim,
        );
      }
    }
    assert.equal(zero, 6);
    assert.equal(infinity, 6);
  }
});

test("N3: the leg loads the subject in an edge-drawing display mode", () => {
  // WebGPU gates its entire edge emitter, snap variant included, on
  // `edgeDisplayMode !== SURFACES_ONLY`, so the extension alone is not enough.
  assert.notEqual(SNAP.edgeDisplayMode, "SURFACES_ONLY");
  assert.ok(
    ["SURFACES_AND_EDGES", "EDGES_ONLY"].includes(SNAP.edgeDisplayMode),
    `${SNAP.edgeDisplayMode} is not an EdgeDisplayMode member that draws edges`,
  );
});
