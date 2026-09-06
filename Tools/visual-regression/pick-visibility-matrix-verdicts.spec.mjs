// pick-visibility-matrix-verdicts.spec.mjs — `AR-837`'s behaviour spec.
// @purpose Executes probe-pick-visibility-matrix's shipped decision functions over a pre-fix world and a post-fix world and requires each to REJECT the other's expectation, pins the three-way classifiers and the AR-M30 clause, exercises the probe's refusal path without a browser, and proves by inertness mutants that the shipped assertions carry the discrimination.
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
import { descriptor } from "./probe-pick-visibility-matrix.mjs";
import {
  DDTD_LEGS,
  EXPECTATIONS,
  GATED_ITEMS,
  HELD_ITEMS,
  ITEMS,
  LOG_DEPTH_LEGS,
  MIN_CURSOR_OFFSET_PIXELS,
  OCCLUDED_PIXEL_CEILING,
  PICK_ATTEMPTS,
  SURFACE_POSITION_MIN_SAMPLES,
  SURFACE_POSITION_RATE_TOLERANCE,
  VISIBLE_PIXEL_FLOOR,
  afterCellPass,
  allChecksPass,
  beforeCellPass,
  buildChecks,
  classifyPick,
  classifyVisibility,
  controlChecks,
  isHeldItem,
  itemChecks,
  resolveExpectation,
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
        webgl: HONOURED(),
        webgpu: HONOURED(),
      });
    }
  }
  return controls;
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

  const mutant = await importSource(
    makeClauseInert(verdictsSource, "gpu.pickClass !== gl.pickClass"),
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
