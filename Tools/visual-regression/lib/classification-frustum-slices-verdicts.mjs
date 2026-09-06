// classification-frustum-slices-verdicts.mjs — AR-714 / AR-715 / AR-716's
// decision functions, calibrated 2026-09-05 against Eowyn's job-9 leg-2 run.
// @purpose The pass/fail logic of probe-classification-frustum-slices.mjs, pure over measurements and free of imports, so a browser-free spec can execute it against the recorded numbers and against its own mutation.
// @status ACTIVE
//
// WHY THE BARS ARE NOT THE ONES THE ROW FIRST NAMED
// -------------------------------------------------
// The row's Edge leg asked for `slices == 1`, `frustumCommandsList.length == 1`
// and `draws == distinctCommands` on BOTH renderers. The first Edge run
// (`wave-p0-2-edge-2026-09-05-job9/leg2-ar714`) showed all three are the same
// bar wearing three hats, and that the hat does not fit SCENE2D on either
// backend:
//
//   - `frustums` is `view.frustumCommandsList.length`, which `updateFrustums`
//     derives from the near/far accumulated over EVERY command in the frame
//     plus the mode's split rule (`Scene/View.js:556-611`). It is a property of
//     the whole scene, not of the primitive under test. The receipts prove the
//     two backends differ on it in cells where the primitive contributes
//     nothing at all: on both `*-cull` scenes WebGL reports 1 and WebGPU 2,
//     with `draws == 0` on all four. So `frustums` is REPORTED here, never
//     gated.
//   - With `frustums == 1` there is one band, so `slices` can only be 1 and
//     `draws` can only be `distinctCommands`. Both clauses are then ENTAILED,
//     not tested — an unbounded command would satisfy them too. A bar that the
//     defect satisfies is not a bar.
//   - In SCENE2D a fixed slice expectation is wrong in BOTH directions.
//     `View.js:579` clamps `far` to `camera.position.z + nearToFarDistance2D`
//     and `View.js:596-599` gives the last band the near
//     `far - nearToFarDistance2D`, so the last seam sits at `far - n2f` —
//     **at most** `camera.position.z`, and **exactly** `camera.position.z`
//     when the frame's accumulated far reaches the clamp. When it does, the
//     seam falls at the nadir camera's height above the map plane, which is
//     where a classification is draped: the seam bisects the drape and
//     `slices == 1` is unsatisfiable for it however tight the volume (this is
//     the case leg 2's WebGL SCENE2D cells were in). When the clamp does NOT
//     bind, the seam sits nearer than the drape and the same drape occupies a
//     single band in a multi-band 2D frame. Both cases are driven through the
//     real PVS in the spec's Group F. A per-frame expectation is the only bar
//     that is right in both.
//
// WHAT REPLACES THEM, AND WHICH BACKEND EACH BINDS
// ------------------------------------------------
// The defect AR-714/715/716 fixed is a MISSING BOUNDING VOLUME. So the bars
// observe that directly, and then observe that the volume is honoured:
//
//   1. `bounded` — every owned command carries a bounding volume. BOTH
//      backends. This is the fix itself; it cannot be satisfied vacuously.
//   2. `slicesAsVolumeRequires` — the observed slice popcount equals the count
//      derived by replaying `insertIntoBin`'s own band test over the command's
//      own `computePlaneDistances` extent against the frame's own band list.
//      BOTH backends. In a one-band frame that is 1; in the 2D straddle it is
//      2; with no volume the extent is the camera's whole range and it is the
//      whole band count.
//   3. `drawsAsVolumeRequires` — the bin-slot count equals the sum of those
//      per-command expectations. BOTH backends.
//   4. `sceneModeAsSpecified` — the cell measured the mode it claims. BOTH
//      backends. Added because leg 2's `groundprim-morph` cells reported
//      `sceneMode == SceneMode.SCENE2D (2)`, not `MORPHING (0)`: `morphTo3D`
//      spends its first third in a `camera.flyTo` that stays in SCENE2D
//      (`Scene/SceneTransitioner.js:470-546`), and the probe read inside it.
//   5. `noGatingErrors` — errors NOT attributed to the tracked
//      `WebGPUDebugFrustumOverlay` bind-group defect. BOTH backends. The
//      attributed ones are counted and reported separately; they are not
//      swallowed and they are not laid at this row's door.
//   6. `frustums` and `ratio` — REPORTED, NEITHER backend gated. See above for
//      `frustums`; for `ratio` see below.
//
// WHY `ratio` IS NOT GATED
// ------------------------
// Its control read zero. `footprintPixels` was 0 on 12 of 14 cells including
// WebGL cells that submitted draws with no errors, because the probe's own
// bar-1 instrument destroyed it: `scene.debugShowFrustums = true` makes
// `DebugInspector.js:79-85` multiply every fragment by `debugShowFrustumsColor`,
// which `:129-143` sets to `(bit0, bit1, bit2)` of `debugOverlappingFrustums`.
// A command in band 0 alone is multiplied by `(1,0,0)` — the green channel the
// footprint counts is zeroed. The only two cells with a footprint at all are
// the two WebGL SCENE2D cells, whose mask is `0b11` and so multiplies by
// `(1,1,0)`, which lets green through. On WebGPU the same switch routes the
// frame through the broken overlay pass instead of the post-process chain, so
// the canvas is never written with scene content at all.
//
// The probe now captures the footprint in a frame with `debugShowFrustums` OFF
// and reads the distribution in a later frame with it ON, which removes both
// mechanisms. But a band applied to a control that has never once produced a
// valid reading would be a premise, not a measurement, so `ratio` is reported
// with a `ratioStatus` and the band is carried in the receipt un-applied. The
// seat re-arms it when an Edge leg shows a non-zero control on both backends.

/** The ledger's single-blend band (`DEFERRED_WORK.md:6439`). Reported, not applied. */
export const SINGLE_BLEND_BAND = Object.freeze([0.34, 0.62]);

/** Below this a ratio is a handful of edge fragments wearing a number's clothes. */
export const MIN_FOOTPRINT_PIXELS = 2000;

/**
 * The signature of the tracked `WebGPUDebugFrustumOverlay` bind-group defect.
 * Every message Edge emits for it names the descriptor by label, so matching
 * the label attributes the error to the right subsystem without matching on
 * the validation prose, which is driver-worded.
 */
export const OVERLAY_DEFECT_MARKER = "DebugFrustumOverlay";

/** Where the attributed errors are owed, so a receipt reader can find the row. */
export const OVERLAY_DEFECT_ROW =
  "NEW-WEBGPU-DEBUG-FRUSTUM-OVERLAY-DEPTH-SAMPLETYPE";

/**
 * Splits gate + console messages into the ones this row answers for and the
 * ones attributed to the tracked overlay defect. Attribution is not
 * suppression: both counts are reported, and only the unattributed ones gate.
 *
 * @param {string[]} messages Every collected gate and console message.
 * @returns {{gating: string[], overlay: string[]}} The partition.
 */
export function partitionErrors(messages) {
  const gating = [];
  const overlay = [];
  for (const message of messages ?? []) {
    const text =
      typeof message === "string" ? message : JSON.stringify(message);
    if (text.includes(OVERLAY_DEFECT_MARKER)) {
      overlay.push(text);
    } else {
      gating.push(text);
    }
  }
  return { gating, overlay };
}

/**
 * How many bands `insertIntoBin` must put a command with this extent in.
 * A faithful replay of `Scene/View.js:630-648` — the same two early exits and
 * the same `executeInClosestFrustum` break — over the band list the frame
 * actually had.
 *
 * @param {Array<{near: number, far: number}>} bands `frustumCommandsList` near/far per band.
 * @param {{near: number, far: number, executeInClosestFrustum: (boolean|undefined)}} extent The command's extent.
 * @returns {number} The band count.
 */
export function expectedSliceCount(bands, extent) {
  let count = 0;
  for (const band of bands ?? []) {
    if (extent.near > band.far) {
      continue;
    }
    if (extent.far < band.near) {
      break;
    }
    count += 1;
    if (extent.executeInClosestFrustum === true) {
      break;
    }
  }
  return count;
}

/**
 * The popcount of a `debugOverlappingFrustums` mask (`Scene/View.js:642-643`).
 *
 * @param {number} mask The mask.
 * @returns {number} Set bits.
 */
export function sliceCount(mask) {
  let bits = (mask ?? 0) >>> 0;
  let count = 0;
  while (bits !== 0) {
    count += bits & 1;
    bits >>>= 1;
  }
  return count;
}

/**
 * Folds the per-command readings into the numbers the clauses are stated over.
 *
 * @param {Array<object>} commands One entry per distinct owned command.
 * @param {Array<{near: number, far: number}>} bands The frame's band list.
 * @returns {object} The folded reading.
 */
export function foldCommands(commands, bands) {
  const owned = commands ?? [];
  let slices = 0;
  let expectedSlices = 0;
  let expectedDraws = 0;
  let boundedCommands = 0;
  for (const command of owned) {
    slices = Math.max(slices, sliceCount(command.sliceMask));
    const expected = expectedSliceCount(bands, command);
    expectedSlices = Math.max(expectedSlices, expected);
    expectedDraws += expected;
    if (command.hasBoundingVolume === true) {
      boundedCommands += 1;
    }
  }
  return {
    distinctCommands: owned.length,
    boundedCommands,
    slices,
    expectedSlices,
    expectedDraws,
  };
}

/**
 * The ratio the cell publishes, and why it is or is not a number.
 *
 * @param {object} cell The cell so far.
 * @returns {{ratio: (number|null), ratioStatus: string}} The reading.
 */
export function evaluateRatio(cell) {
  if (cell.opaqueMeanChannel === null || cell.opaqueMeanChannel === undefined) {
    return { ratio: null, ratioStatus: "not-a-ratio-scene" };
  }
  if (!(cell.opaqueMeanChannel > 0)) {
    return { ratio: null, ratioStatus: "opaque-control-read-zero" };
  }
  if (cell.footprintPixels < MIN_FOOTPRINT_PIXELS) {
    return { ratio: null, ratioStatus: "footprint-below-floor" };
  }
  return {
    ratio: cell.translucentMeanChannel / cell.opaqueMeanChannel,
    ratioStatus: "measured",
  };
}

/**
 * The cell's verdict. Pure over the cell record; every clause is named in the
 * result so a receipt reader sees which one failed rather than a bare false.
 *
 * The two new gating clauses are delimited by marker pairs. Those markers are
 * the seam `classification-bounding-volume-frustum-slices.spec.mjs` cuts on to
 * make each clause INERT (`false && …`, evaluated but unreachable) rather than
 * absent; they are load-bearing, not decoration.
 *
 * @param {object} cell The measured cell.
 * @returns {{pass: boolean, clauses: object, claim: string}} The verdict.
 */
export function evaluateCell(cell) {
  if (cell.outside === true) {
    const cullClauses = {
      noGatingErrors: cell.errors === 0,
      // Supplying a volume switches on culling that was moot while it was
      // absent (`WebGPUDrawCommand.ts:502` defaults `cull` true and
      // `Scene.isVisible` short-circuits on a missing volume), so the cull
      // half is what stops the fix from changing behaviour twice.
      notBinned: cell.draws === 0,
    };
    return {
      pass: Object.values(cullClauses).every(Boolean),
      clauses: cullClauses,
      claim: "a classification primitive outside the view is not drawn",
    };
  }

  /* clause:bounded */
  const bounded =
    cell.distinctCommands > 0 && cell.boundedCommands === cell.distinctCommands;
  /* end-clause:bounded */

  const clauses = {
    noGatingErrors: cell.errors === 0,
    sceneModeAsSpecified: cell.sceneMode === cell.expectedSceneMode,
    bounded,
    /* clause:slices */
    slicesAsVolumeRequires: cell.slices === cell.expectedSlices,
    /* end-clause:slices */
    drawsAsVolumeRequires: cell.draws === cell.expectedDraws,
  };
  return {
    pass: Object.values(clauses).every(Boolean),
    clauses,
    claim:
      "every classification command carries a bounding volume and is binned " +
      "exactly into the frustum bands that volume reaches",
  };
}
