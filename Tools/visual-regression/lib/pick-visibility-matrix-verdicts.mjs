// pick-visibility-matrix-verdicts.mjs — `AR-837`'s decision functions.
// @purpose The pass/fail logic of probe-pick-visibility-matrix.mjs, pure over measurements and free of imports, so a browser-free spec can execute it against both named expectations and against its own mutation.
// @status ACTIVE
//
// WHY THIS IS A SEPARATE MODULE. `AR-837`'s acceptance
// (`QUEUE_2026-09-03_ARCHITECTURE_REVIEW.md:233`) is a BEFORE/AFTER pair:
//
//   "today WebGPU misses the pick on billboard/label/point behind terrain at
//    `disableDepthTestDistance = Infinity` while WebGL hits — the matrix must
//    show that difference before `AR-001` lands and its disappearance after"
//
// so the instrument has two first-class expectations and no default. A verdict
// module with NO imports can be read as text, mutated, written to a `data:`
// URL and executed, which is how `pick-visibility-matrix-verdicts.spec.mjs`
// proves that the SHIPPED decision carries the load rather than a
// spec-supplied flag. A file with relative imports cannot be run that way.
//
// THE FOUR TERMS. Every cell is one (item, `disableDepthTestDistance` leg,
// `logarithmicDepthBuffer` leg) measured on BOTH backends. A cell decides two
// questions and each has THREE outcomes, not two:
//
//   visibility  "visible" | "occluded" | "indeterminate"
//   pick        "hit"     | "miss"     | "indeterminate"
//
// The third outcome is the point. A pixel count between the occluded ceiling
// and the visible floor, or a pick that lands 2 times in 5, is not evidence
// for either side of a parity claim, and rounding it to the nearer one is how
// an instrument manufactures a verdict it did not measure. `indeterminate`
// fails EVERY expectation, so it surfaces as a red with the raw counts beside
// it instead of as a green.
//
// THE HELD ITEM. `AR-D09` has not ruled on whether
// `Polyline.disableDepthTestDistance` — fork-added, honoured by WebGPU only —
// stays or is deleted, and `AR-001`'s polyline half is held behind that ruling
// as one unit. The polyline cell is therefore MEASURED and REPORTED and never
// ASSERTED: `itemChecks` returns an empty list for it under both expectations.
// Asserting it would file a verdict on an undecided question, and dropping it
// would lose the measurement the ruling will want.
//
// THE `ddtd = 0` CELLS BECAME THEIR OWN ROW IN ROUND 2. Job 10 measured
// `label`/`point`/`polyline` at `ddtd 0` with `logarithmicDepthBuffer = false`
// VISIBLE and PICKABLE on WebGPU where WebGL occludes them, with BIT-IDENTICAL
// numbers on the pre- and post-`AR-001` trees. A difference that is present on
// both sides of a fix is not that fix's business, and judging it under
// `--expect` lets `AR-001`'s expectation flag take the blame for it. So the
// `ddtd = 0` cells are judged by `occlusionParityCellPass`, which is
// EXPECTATION-INDEPENDENT: WebGPU must match WebGL's visibility AND pick, under
// both log legs and under both expectations. `--expect` now governs the
// `ddtd = infinity` cells alone — the ones `AR-837`'s acceptance column names.
// The per-cell verdict ids are unchanged so job 10's receipts stay comparable;
// what changed is which question a `ddtd = 0` id answers, and its claim says so.
//
// THE PICK WARM-UP IS MEASURED, NOT HIDDEN. WebGPU resolves a pick pipeline
// through `createRenderPipelineAsync` and SKIPS the pick draw while the variant
// cooks (`WebGPUPointPrimitiveRenderer.js:1468-1472`, and the same shape in the
// label and billboard renderers), so the first pick sequence after a new define
// variant reads an empty pick buffer. In job 10 that landed entirely on the
// control, which is always a leg's first pick — 0/5, 1/5 or 2/5 on WebGPU in all
// 16 measurements with the nulls on the earliest attempts, while every LATER
// sequence in the same leg picked 5/5. The probe now spends discarded warm-up
// picks first, and `pickWarmupChecks` asserts the warm-up RESOLVED on both
// backends. The cost itself (`attempts`) is published rather than asserted: a
// bar for it would be a number this lane never measured across machines, but a
// warm-up that never resolves still turns the run red, so the control keeps the
// load-bearing role `controlChecks` gives it.
//
// A SUBJECT THAT NEVER RENDERS IS A REFUSAL, NOT A CELL. Job 10's billboard
// measured 0 hue pixels in all 16 cell-measurements on both backends and both
// trees — including the cells where this probe's own WebGL anchor requires it
// VISIBLE — because its collection's draw command was horizon-culled before it
// could be measured (see `lib/pick-visibility-matrix-page.mjs`, "EXTENT
// KEEPERS"). `subjectRenderabilityChecks` asserts the engine-visible
// preconditions for a subject to be measurable at all, so the next such defect
// surfaces as a named red instead of as a silent 0 that reads like occlusion.
//
// THE `AR-M30` CLAUSE IS A SEPARATE ROW. The `surfacePosition` defined-rate for
// edge hits more than 2 px from the cursor is `AR-M30`, the acceptance for
// `AR-030` — a different row from `AR-001`, and one whose queue text
// explicitly RETRACTS the "today 0%" figure it used to state. So this module
// predicts nothing about the rate: it requires only that BOTH backends produced
// enough far edge hits for a rate to mean anything, and that WebGPU's rate
// equals WebGL's, which is the bar `AR-030`'s acceptance column actually names.
// Its checks carry their own `ar-m30` id so a red there is attributable to
// `AR-030` and never to `AR-001`.

/** The items the matrix places behind terrain. */
export const ITEMS = Object.freeze(["billboard", "label", "point", "polyline"]);

/** The items `AR-001`'s non-polyline half covers, and the only ones asserted. */
export const GATED_ITEMS = Object.freeze(["billboard", "label", "point"]);

/** Measured and reported, never asserted, until `AR-D09` rules. */
export const HELD_ITEMS = Object.freeze(["polyline"]);

/** The row the held item waits on. */
export const HELD_ITEM_ROW = "AR-D09";

/** The two `disableDepthTestDistance` legs, as receipt keys. */
export const DDTD_LEGS = Object.freeze(["zero", "infinity"]);

/** Both `scene.logarithmicDepthBuffer` legs. `AR-M01` requires both. */
export const LOG_DEPTH_LEGS = Object.freeze([true, false]);

/** The two first-class expectations. Neither is a default. */
export const EXPECTATIONS = Object.freeze(["before", "after"]);

/** Hue pixels inside the sample window at or above which an item is VISIBLE. */
export const VISIBLE_PIXEL_FLOOR = 60;

/** Hue pixels at or below which an item is OCCLUDED. */
export const OCCLUDED_PIXEL_CEILING = 4;

/** `pickAsync` calls made per cell per backend. */
export const PICK_ATTEMPTS = 5;

/**
 * Discarded `pickAsync` calls spent warming a leg's pick pipelines before the
 * first MEASURED pick of that leg. Sized from job 10: WebGPU's leading nulls
 * ran to 5 of 5 in the worst control measurement, so a budget that only just
 * covered the observed worst case would be a bar tuned to one machine. This is
 * a ceiling on how long the probe will wait, not a bar anything is judged
 * against — `pickWarmupChecks` asserts only that the warm-up RESOLVED.
 */
export const PICK_WARMUP_ATTEMPTS = 16;

/** The row the `ddtd = 0` occlusion-parity cells belong to, not `AR-001`. */
export const OCCLUSION_PARITY_ROW = "AR-837/occlusion-parity";

/**
 * A pick is a HIT at this share of attempts or better, and a MISS only at
 * exactly zero. The gap between them is `indeterminate` ON PURPOSE: the
 * BEFORE leg predicts 0 of 5 and the AFTER leg predicts 5 of 5, so a 2-of-5
 * is neither, and a probe that rounded it would report a parity claim from a
 * measurement that did not separate the two worlds.
 */
export const PICK_HIT_RATE_FLOOR = 0.8;

/** The `AR-M30` clause's own words: hits MORE than 2 px from the cursor. */
export const MIN_CURSOR_OFFSET_PIXELS = 2;

/** Far edge hits each backend needs before a defined-rate means anything. */
export const SURFACE_POSITION_MIN_SAMPLES = 8;

/** How far WebGPU's `surfacePosition` defined-rate may sit from WebGL's. */
export const SURFACE_POSITION_RATE_TOLERANCE = 0.05;

/**
 * Resolve the `--expect` flag. There is deliberately NO default: `AR-837`
 * names two outcomes and the probe judges against the one it was told, so a
 * missing flag is malformed input (a caller error, exit 2) rather than a
 * silent choice of world.
 *
 * @param {unknown} value The raw flag value.
 * @returns {string} `"before"` or `"after"`.
 */
export function resolveExpectation(value) {
  if (value === undefined || value === null || value === "") {
    throw new TypeError(
      `--expect is required and has no default; pass one of ${EXPECTATIONS.join(", ")} (before = the AR-001 defect is present, after = it is gone)`,
    );
  }
  const normalized = String(value).trim().toLowerCase();
  if (!EXPECTATIONS.includes(normalized)) {
    throw new TypeError(
      `--expect must be one of ${EXPECTATIONS.join(", ")} (got "${value}")`,
    );
  }
  return normalized;
}

/**
 * Three-way visibility from a hue-pixel count.
 *
 * @param {unknown} huePixels Pixels of the item's own hue in the sample window.
 * @returns {string} `"visible"`, `"occluded"` or `"indeterminate"`.
 */
export function classifyVisibility(huePixels) {
  if (typeof huePixels !== "number" || !Number.isFinite(huePixels)) {
    return "indeterminate";
  }
  if (huePixels >= VISIBLE_PIXEL_FLOOR) {
    return "visible";
  }
  if (huePixels <= OCCLUDED_PIXEL_CEILING) {
    return "occluded";
  }
  return "indeterminate";
}

/**
 * Three-way pick outcome from a hit count.
 *
 * @param {unknown} hits Attempts whose `pickAsync` returned the item's own id.
 * @param {unknown} attempts Attempts made.
 * @returns {string} `"hit"`, `"miss"` or `"indeterminate"`.
 */
export function classifyPick(hits, attempts) {
  if (
    typeof hits !== "number" ||
    typeof attempts !== "number" ||
    !Number.isFinite(hits) ||
    !Number.isFinite(attempts) ||
    attempts <= 0 ||
    hits < 0 ||
    hits > attempts
  ) {
    return "indeterminate";
  }
  if (hits === 0) {
    return "miss";
  }
  if (hits / attempts >= PICK_HIT_RATE_FLOOR) {
    return "hit";
  }
  return "indeterminate";
}

/**
 * The receipt key for one cell.
 *
 * @param {object} cell A cell.
 * @returns {string} Its key.
 */
export function cellKey(cell) {
  return `${cell.item}/ddtd-${cell.ddtd}/log-${cell.logDepth === true ? "on" : "off"}`;
}

/**
 * Whether an item is held behind `AR-D09` rather than asserted.
 *
 * @param {string} item Item id.
 * @returns {boolean} True when the item is measured but never asserted.
 */
export function isHeldItem(item) {
  return HELD_ITEMS.includes(item);
}

/**
 * @param {number|null|undefined} value A rate that may be absent.
 * @returns {string} A printable form.
 */
function show(value) {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toFixed(3)
    : "n/a";
}

/**
 * Does this cell satisfy the BEFORE world — the pre-`AR-001` tree, where the
 * colour pass already honoured the property and the pick pass did not?
 *
 * Each clause is its own `if` so a reviewer can make exactly one of them
 * unreachable (`if (false && …)`) and watch the spec go red; a single fused
 * boolean would survive that mutation as one lump.
 *
 * @param {object} cell One measured cell.
 * @returns {boolean} Whether the cell matches the BEFORE expectation.
 */
export function beforeCellPass(cell) {
  const gl = cell.webgl ?? {};
  const gpu = cell.webgpu ?? {};
  /* expectation-assertions:before */
  if (cell.ddtd !== "infinity") {
    // Round 2: the `ddtd = 0` cells are no longer judged by expectation. They
    // are an occlusion-parity question with the same answer on both trees, and
    // `occlusionParityCellPass` owns it.
    return occlusionParityCellPass(cell);
  }
  // The defect must be PRESENT and must be a DIFFERENCE: a WebGPU miss is
  // only evidence when WebGL, on the same scene, hits.
  if (gl.pickClass !== "hit") {
    return false;
  }
  if (gpu.pickClass !== "miss") {
    return false;
  }
  // ... and it must be the PICK pass alone. The colour shaders already wrote
  // `clipPos.z = 0.0` before Batch 1439 (verified at `08cb6fd4b2`), so a
  // WebGPU cell that is also invisible is a different defect and must not be
  // recorded as this one.
  if (gpu.visibility !== "visible") {
    return false;
  }
  return true;
  /* end-expectation-assertions:before */
}

/**
 * Does this `disableDepthTestDistance = 0` cell show WebGPU agreeing with
 * WebGL? Expectation-independent ON PURPOSE: job 10 measured the WebGPU
 * non-logarithmic-depth cells VISIBLE and PICKABLE where WebGL occludes, with
 * bit-identical numbers on the pre- and post-`AR-001` trees, so the question
 * this answers belongs to its own row and must give the same answer under both
 * `--expect` values.
 *
 * Each clause is its own `if` so a reviewer can make exactly one of them
 * unreachable and watch the spec go red.
 *
 * @param {object} cell One measured cell at `ddtd = 0`.
 * @returns {boolean} Whether WebGPU matched WebGL on this cell.
 */
export function occlusionParityCellPass(cell) {
  const gl = cell.webgl ?? {};
  const gpu = cell.webgpu ?? {};
  /* occlusion-assertions:parity */
  if (gpu.visibility !== gl.visibility) {
    return false;
  }
  if (gpu.pickClass !== gl.pickClass) {
    return false;
  }
  return true;
  /* end-occlusion-assertions:parity */
}

/**
 * Does this cell satisfy the AFTER world — no backend difference?
 *
 * @param {object} cell One measured cell.
 * @returns {boolean} Whether the cell matches the AFTER expectation.
 */
export function afterCellPass(cell) {
  const gl = cell.webgl ?? {};
  const gpu = cell.webgpu ?? {};
  /* expectation-assertions:after */
  if (cell.ddtd !== "infinity") {
    return occlusionParityCellPass(cell);
  }
  if (gpu.visibility !== gl.visibility) {
    return false;
  }
  if (gpu.pickClass !== gl.pickClass) {
    return false;
  }
  return true;
  /* end-expectation-assertions:after */
}

/**
 * The WebGL anchor for a cell. "No backend difference" is satisfied just as
 * well by two backends that are both wrong, so the reference behaviour is
 * asserted separately and under BOTH expectations.
 *
 * @param {object} cell One measured cell.
 * @returns {Array<{label: string, pass: boolean}>} The anchor checks.
 */
export function anchorChecks(cell) {
  const tag = `[${cellKey(cell)}]`;
  const gl = cell.webgl ?? {};
  if (cell.ddtd === "infinity") {
    return [
      {
        label: `${tag} webgl is VISIBLE through terrain (${gl.huePixels ?? 0} px)`,
        pass: gl.visibility === "visible",
      },
      {
        label: `${tag} webgl PICKS through terrain (${gl.pickHits ?? 0}/${gl.pickAttempts ?? 0})`,
        pass: gl.pickClass === "hit",
      },
    ];
  }
  return [
    {
      label: `${tag} webgl is OCCLUDED at ddtd 0 (${gl.huePixels ?? 0} px)`,
      pass: gl.visibility === "occluded",
    },
    {
      label: `${tag} webgl does NOT pick at ddtd 0 (${gl.pickHits ?? 0}/${gl.pickAttempts ?? 0})`,
      pass: gl.pickClass === "miss",
    },
  ];
}

/**
 * Every check for ONE cell under ONE expectation. A held item yields none.
 *
 * @param {string} item Item id.
 * @param {object} cell The measured cell.
 * @param {string} expectation `"before"` or `"after"`.
 * @returns {Array<{item: string, label: string, pass: boolean}>} The checks.
 */
export function itemChecks(item, cell, expectation) {
  if (isHeldItem(item)) {
    // Held behind `AR-D09`. Measured, published, never judged.
    return [];
  }
  const tag = `[${cellKey(cell)}]`;
  const gpu = cell.webgpu ?? {};
  const checks = anchorChecks(cell).map((check) => ({ item, ...check }));

  // An undecided measurement is not evidence for either world.
  checks.push({
    item,
    label: `${tag} webgpu visibility is decided (${gpu.visibility ?? "absent"}, ${gpu.huePixels ?? 0} px)`,
    pass: gpu.visibility === "visible" || gpu.visibility === "occluded",
  });
  checks.push({
    item,
    label: `${tag} webgpu pick is decided (${gpu.pickClass ?? "absent"}, ${gpu.pickHits ?? 0}/${gpu.pickAttempts ?? 0})`,
    pass: gpu.pickClass === "hit" || gpu.pickClass === "miss",
  });

  if (cell.ddtd !== "infinity") {
    // NOT an `AR-001` question and NOT governed by `--expect`: at
    // `disableDepthTestDistance = 0` nothing overrides depth, so the only claim
    // is that WebGPU occludes and picks exactly as WebGL does. Job 10 found it
    // false with log depth OFF, identically on both trees.
    checks.push({
      item,
      label: `${tag} ${OCCLUSION_PARITY_ROW} (NOT AR-001) — webgpu matches webgl at ddtd 0 (visible ${cell.webgl?.visibility ?? "absent"}/${gpu.visibility ?? "absent"}, pick ${cell.webgl?.pickClass ?? "absent"}/${gpu.pickClass ?? "absent"})`,
      pass: occlusionParityCellPass(cell),
    });
    return checks;
  }

  if (expectation === "before") {
    checks.push({
      item,
      label: `${tag} the AR-001 difference is PRESENT (webgl ${cell.webgl?.pickClass ?? "absent"} / webgpu ${gpu.pickClass ?? "absent"})`,
      pass: beforeCellPass(cell),
    });
  } else {
    checks.push({
      item,
      label: `${tag} no backend difference (visible ${cell.webgl?.visibility ?? "absent"}/${gpu.visibility ?? "absent"}, pick ${cell.webgl?.pickClass ?? "absent"}/${gpu.pickClass ?? "absent"})`,
      pass: afterCellPass(cell),
    });
  }
  return checks;
}

/**
 * The CLAIM text a cell verdict is PUBLISHED under.
 *
 * The check label built by `itemChecks` names the occlusion row, but check
 * labels are folded away by `allChecksPass` and never reach `report.json`; the
 * claim is what a reader of the receipt sees beside a red. So the row a
 * `ddtd = 0` red belongs to has to be decided HERE too, or the two expected
 * occlusion reds arrive tagged `AR-837/before` / `AR-837/after` — the two
 * strings that attribute a red to `AR-001`.
 *
 * @param {object} cell The measured cell.
 * @param {string} expectation `"before"` or `"after"`.
 * @returns {string} The claim the verdict is published under.
 */
export function cellClaim(cell, expectation) {
  const where = `${cell?.item} behind terrain at disableDepthTestDistance ${cell?.ddtd} with logarithmicDepthBuffer ${cell?.logDepth ? "on" : "off"}`;
  /* occlusion-assertions:claim */
  if (cell?.ddtd !== "infinity") {
    return `${OCCLUSION_PARITY_ROW} (NOT AR-001) — ${where}`;
  }
  /* end-occlusion-assertions:claim */
  return `AR-837/${expectation} — ${where}`;
}

/**
 * The per-page liveness control: an unoccluded primitive with no
 * `disableDepthTestDistance` at all, in front of the globe.
 *
 * Without it a WebGPU pick miss on a subject is ambiguous between "the fix is
 * absent" and "this page never produced a pick at all", and the BEFORE leg's
 * whole finding is a miss. The control makes the ambiguity impossible: it must
 * render and must pick on BOTH backends in every page, under both
 * expectations.
 *
 * @param {object} control One control record for a (renderer-pair, logDepth) page.
 * @returns {Array<{label: string, pass: boolean}>} The checks.
 */
export function controlChecks(control) {
  const slug = `log-${control.logDepth === true ? "on" : "off"}/ddtd-${control.ddtd}`;
  const tag = `[control/${slug}]`;
  const checks = [];
  for (const renderer of ["webgl", "webgpu"]) {
    const measured = control[renderer] ?? {};
    checks.push({
      id: `control-${slug}-${renderer}-renders`,
      label: `${tag} ${renderer} control renders (${measured.huePixels ?? 0} px)`,
      pass: measured.visibility === "visible",
    });
    checks.push({
      id: `control-${slug}-${renderer}-picks`,
      label: `${tag} ${renderer} control PICKS (${measured.pickHits ?? 0}/${measured.pickAttempts ?? 0})`,
      pass: measured.pickClass === "hit",
    });
  }
  return checks;
}

/**
 * The pick warm-up. WebGPU cooks a pick pipeline through
 * `createRenderPipelineAsync` and skips the pick draw while the variant is
 * still materializing, so the FIRST pick sequence after a new define variant
 * reads an empty pick buffer. The probe therefore spends discarded picks before
 * a leg's first measured pick and records what they cost.
 *
 * What is asserted is that the warm-up RESOLVED — a pick path that never
 * returns anything is still a red, which is what keeps `controlChecks`
 * load-bearing. What is NOT asserted is the cost: `attempts` is published so
 * the cook latency is visible with numbers, but a ceiling on it would be a bar
 * measured on one machine on one night.
 *
 * @param {object} control One control record for a (renderer-pair, logDepth, ddtd) leg.
 * @returns {Array<{id: string, label: string, pass: boolean}>} The checks.
 */
export function pickWarmupChecks(control) {
  const slug = `log-${control.logDepth === true ? "on" : "off"}/ddtd-${control.ddtd}`;
  const tag = `[warmup/${slug}]`;
  const checks = [];
  /* warmup-assertions:resolved */
  for (const renderer of ["webgl", "webgpu"]) {
    const warmup = (control[renderer] ?? {}).pickWarmup ?? {};
    checks.push({
      id: `pick-warmup-${slug}-${renderer}`,
      label: `${tag} ${renderer} produced a pick before the leg was measured (resolved ${warmup.resolved === true}, after ${warmup.attempts ?? "n/a"} of ${warmup.budget ?? "n/a"} discarded attempts)`,
      pass: warmup.resolved === true,
    });
  }
  /* end-warmup-assertions:resolved */
  return checks;
}

/**
 * A subject that never reaches the screen cannot be measured, and its 0 hue
 * pixels read exactly like occlusion. Job 10 spent four Edge runs on a
 * billboard whose collection's draw command was culled before it could be
 * drawn, and nothing in the instrument said so.
 *
 * These are engine-visible PRECONDITIONS, not behaviour: the item is still in
 * its collection, it is shown, its image (where the type has one) is ready, and
 * — the one that catches job 10 — its collection's draw command SURVIVED
 * culling and reached execution. `commandExecuted` is observed through
 * `scene.debugCommandFilter`, which both backends consult only for commands
 * that already passed the frustum and occluder tests.
 *
 * @param {object} record One `{item, logDepth, webgl, webgpu}` renderability record.
 * @returns {Array<{id: string, label: string, pass: boolean}>} The checks.
 */
export function subjectRenderabilityChecks(record) {
  const slug = `${record.item}/log-${record.logDepth === true ? "on" : "off"}`;
  const tag = `[renderable/${slug}]`;
  const checks = [];
  /* renderability-assertions:subject */
  for (const renderer of ["webgl", "webgpu"]) {
    const measured = record[renderer] ?? {};
    checks.push({
      id: `subject-renderable-${slug}-${renderer}`,
      label: `${tag} ${renderer} subject is present, shown, image-ready and its collection's draw command reached execution (present ${measured.present === true}, show ${measured.show === true}, imageReady ${measured.imageReady ?? "n/a"}, commandExecuted ${measured.commandExecuted === true})`,
      pass:
        measured.present === true &&
        measured.show === true &&
        measured.imageReady !== false &&
        measured.commandExecuted === true,
    });
  }
  /* end-renderability-assertions:subject */
  return checks;
}

/**
 * Does a snap leg have standing to report a `surfacePosition` rate at all?
 *
 * FOUR claims, and job 10 showed the last three are genuinely different. The
 * first is the lesson of job 10's snap leg as a whole: WebGPU gates its entire
 * edge emitter, snap variant included, on
 * `edgeDisplayMode !== SURFACES_ONLY` (`WebGPUModelRenderer.ts:8514-8517`), so
 * a leg that could not resolve an edge-drawing mode would measure WebGL's edges
 * against WebGPU's silence and publish it as an `AR-030` finding. Its BEFORE leg
 * reported `modelReady` and `projected` both true on a WebGL page that had
 * rendered imagery-covered real terrain with the model nowhere in it — job 10's
 * subject sat at 100 m ellipsoidal height under ~1500 m of terrain at
 * (-105, 40) — and returned 81/81 undefined. "Loaded" is not "in frame", and
 * neither is "in frame" the same as "big enough for an aperture to straddle".
 *
 * Returns `null` when the leg may report, or the refusal the probe raises. The
 * probe raises rather than publishing a red, because a leg with no subject has
 * not measured `AR-030`'s gap in either direction.
 *
 * @param {object} measured One backend's raw snap measurement.
 * @returns {{code: string, message: string}|null} The refusal, or null.
 */
export function snapLegStanding(measured) {
  const leg = measured ?? {};
  /* snap-standing-assertions:leg */
  if (leg.edgeModeResolved !== true) {
    return {
      code: "snap-edge-mode-unresolved",
      message:
        "the AR-M30 leg could not put the model into an edge-drawing display mode, so no fragment in its scene can set the snap payload's edge flag on WebGPU and the leg has no standing to report a surfacePosition rate",
    };
  }
  if (leg.modelReady !== true) {
    return {
      code: "snap-model-never-ready",
      message:
        "the AR-M30 leg's glTF model never reached ready; the leg saw no subject, so it has no standing to report a surfacePosition rate",
    };
  }
  if (leg.projected !== true) {
    return {
      code: "snap-model-not-projected",
      message:
        "the AR-M30 leg could not project its model to window coordinates",
    };
  }
  if (leg.inFrame !== true) {
    return {
      code: "snap-model-not-in-frame",
      message:
        "the AR-M30 leg's model did not render at its own projected centre, or projected smaller than the aperture floor; the leg has no silhouette to snap to and no standing to report a surfacePosition rate",
    };
  }
  return null;
  /* end-snap-standing-assertions:leg */
}

/**
 * The `AR-M30` clause. Separate id, separate row (`AR-030`), separate cause.
 *
 * @param {object} snap One snap leg record.
 * @returns {Array<{label: string, pass: boolean}>} The checks.
 */
export function surfacePositionChecks(snap) {
  const tag = `[ar-m30/width-${snap?.snapWidth ?? "?"}]`;
  const gl = snap?.webgl ?? {};
  const gpu = snap?.webgpu ?? {};
  const checks = [];
  /* snap-assertions:ar-m30 */
  // A defined-rate over three samples is not a rate. Sufficiency is asserted
  // first and separately, so "we could not measure it" never publishes as
  // "the backends agree".
  for (const [renderer, measured] of [
    ["webgl", gl],
    ["webgpu", gpu],
  ]) {
    checks.push({
      id: `ar-m30-samples-${renderer}`,
      label: `${tag} ${renderer} produced >= ${SURFACE_POSITION_MIN_SAMPLES} edge hits more than ${MIN_CURSOR_OFFSET_PIXELS} px from the cursor (${measured.farEdgeHits ?? 0})`,
      pass: (measured.farEdgeHits ?? 0) >= SURFACE_POSITION_MIN_SAMPLES,
    });
  }
  const bothSufficient =
    (gl.farEdgeHits ?? 0) >= SURFACE_POSITION_MIN_SAMPLES &&
    (gpu.farEdgeHits ?? 0) >= SURFACE_POSITION_MIN_SAMPLES;
  const delta =
    bothSufficient &&
    typeof gl.definedRate === "number" &&
    typeof gpu.definedRate === "number"
      ? Math.abs(gpu.definedRate - gl.definedRate)
      : null;
  checks.push({
    id: "ar-m30-parity",
    label: `${tag} webgpu surfacePosition defined-rate equals webgl's (webgl ${show(gl.definedRate)}, webgpu ${show(gpu.definedRate)}, delta ${show(delta)})`,
    pass: delta !== null && delta <= SURFACE_POSITION_RATE_TOLERANCE,
  });
  /* end-snap-assertions:ar-m30 */
  return checks;
}

/**
 * Every check a run produces.
 *
 * @param {object} options Inputs.
 * @param {Array<object>} options.cells Measured cells.
 * @param {Array<object>} options.controls Per-page control records.
 * @param {Array<object>} options.snap Snap leg records.
 * @param {Array<object>} [options.renderability] Per-subject renderability records.
 * @param {string} options.expectation The named expectation.
 * @returns {Array<{label: string, pass: boolean}>} Every check.
 */
export function buildChecks({
  cells,
  controls,
  snap,
  renderability,
  expectation,
}) {
  const checks = [];
  for (const record of renderability ?? []) {
    checks.push(...subjectRenderabilityChecks(record));
  }
  for (const control of controls ?? []) {
    checks.push(...pickWarmupChecks(control));
    checks.push(...controlChecks(control));
  }
  for (const cell of cells ?? []) {
    checks.push(...itemChecks(cell.item, cell, expectation));
  }
  for (const leg of snap ?? []) {
    checks.push(...surfacePositionChecks(leg));
  }
  return checks;
}

/**
 * @param {Array<{pass: boolean}>} checks Checks.
 * @returns {boolean} Whether every check passed.
 */
export function allChecksPass(checks) {
  return (checks ?? []).every((check) => check.pass === true);
}

/**
 * One printable row per cell, for the markdown summary and the packet.
 *
 * @param {object} cell A measured cell.
 * @returns {object} The row.
 */
export function summarizeCell(cell) {
  const gl = cell.webgl ?? {};
  const gpu = cell.webgpu ?? {};
  return {
    key: cellKey(cell),
    item: cell.item,
    ddtd: cell.ddtd,
    logarithmicDepthBuffer: cell.logDepth === true,
    held: isHeldItem(cell.item),
    webglVisible: gl.visibility ?? "absent",
    webgpuVisible: gpu.visibility ?? "absent",
    webglPick: gl.pickClass ?? "absent",
    webgpuPick: gpu.pickClass ?? "absent",
    visibilityDiffers:
      (gl.visibility ?? "absent") !== (gpu.visibility ?? "absent"),
    pickDiffers: (gl.pickClass ?? "absent") !== (gpu.pickClass ?? "absent"),
  };
}
