// gsplat-parity-model.mjs — pure, browser-free decision logic for the C15-G1
// Gaussian-splat probe harness (`probe-gsplat-parity.mjs`).
//
// WHY THIS FILE EXISTS
// --------------------
// `probe-gsplat-parity.mjs` launches Edge at module scope, so nothing inside it
// can ever be executed by `node --test`. The whole point of C15-G1 is a DUAL-
// MODE instrument: the same probe must certify today's ABSENCE of WebGPU splats
// honestly and tomorrow's PRESENCE rigorously. That flip is arithmetic, and
// arithmetic that cannot be executed by a test is arithmetic nobody has checked.
//
// Three specific ways a dual-mode gate rots, all of them silent:
//
//   1. Absence keeps reporting the "expected" marker AFTER `--expect-webgpu` is
//      turned on, so the row that was supposed to prove splats appeared instead
//      proves nothing and exits 0.
//   2. Presence arrives while the probe is still in default mode, and the run
//      goes green on a contract that no longer describes the product.
//   3. The parity leg scores a mismatch against an EMPTY WebGPU canvas. Two
//      blank frames diff to 0%, which is the tightest parity number the gate can
//      print — a perfect score for a renderer that drew nothing.
//
// Every rule below is therefore stated once, here, and `gsplat-harness.spec.mjs`
// runs it against the real implementation AND against the plausible wrong one.
//
// Verdict doctrine (CLAUDE.md): 0 pass / 1 real product FAIL / 2 watchdog or
// exception / 3 STRUCTURAL. A leg that cannot see its own subject exits 3 —
// never 0, never 1. "The WebGL reference rendered nothing" is an instrument
// gap, not a WebGPU defect, and it must never be filed as one.

/** @typedef {"absent"|"present"|"ambiguous"} SplatPresenceState */

export const EXIT_CODE = Object.freeze({
  PASS: 0,
  FAIL: 1,
  ERROR: 2,
  STRUCTURAL: 3,
});

/**
 * The greppable current-state marker. Printed — and only printed — when the
 * WebGPU leg shows no splats AND the absence is ATTRIBUTABLE to a named,
 * observed blocker in the scaffolded WebGPU splat path. An absence the probe
 * cannot attribute is STRUCTURAL, not "expected": "nothing rendered" is also
 * what a broken probe, a dead device, or an unloaded tileset looks like.
 *
 * @type {string}
 */
export const ABSENT_MARKER = "WEBGPU-SPLATS-ABSENT (expected until C15-G3)";

/**
 * The greppable marker for the OTHER half of the dual mode: `--expect-webgpu`
 * scored WebGPU splats as present and gated them. Printed only when the flip
 * mode actually reached its product criteria.
 *
 * @type {string}
 */
export const PRESENT_MARKER = "WEBGPU-SPLATS-PRESENT (C15-G3)";

/**
 * The named blockers a default-mode run will accept as an ATTRIBUTION for the
 * absence. Each is an independently observable fact about the HEAD engine, and
 * each is a thing `C15-G2`/`C15-G3` has to remove before splats can appear.
 *
 * This is the VOCABULARY — every blocker this harness knows how to name across
 * the whole track. Which of them are expected to be OBSERVED right now is a
 * separate, stage-dependent question; see {@link STAGE}. Keeping the two apart
 * is what lets `C15-G2` retire a blocker without either deleting the name (and
 * losing the ability to detect its return) or leaving it in a list the run is
 * still happy to be satisfied by.
 *
 * `primitive-show-undefined` was NOT in the `C15-G0` report; it was found while
 * building this harness at `58af0d1819`, and it was the FIRST blocker in the
 * chain — `WebGPUGaussianSplatRenderer.updateWebGPUGaussianSplats` opens with
 * `if (!primitive.show) return;` and `GaussianSplatPrimitive` defined no `show`
 * member at all, so the renderer exited at its first statement and never
 * reached the `_splatData` read that `C15-G0` recorded as the break. `C15-G2`
 * removed it by giving the primitive a read-only `show` accessor that mirrors
 * `tileset.show`. The three synthetic probes hand-roll `show: true` on plain
 * object literals, so they were never affected either way.
 */
export const ABSENCE_BLOCKERS = Object.freeze([
  // RETIRED BY C15-G2. `WebGPUGaussianSplatRenderer.ts` first statement;
  // `GaussianSplatPrimitive` now exposes `get show()` proxying `tileset.show`,
  // so this no longer fires. Kept in the vocabulary so its RETURN is
  // detectable — see STAGE.retiredBlockers.
  "primitive-show-undefined",
  // RETIRED BY C15-G3. `C15-G0`'s recorded break: no splat attribute bytes
  // reach the WebGPU renderer in ANY layout it can consume. Still nothing in
  // packages/ assigns the legacy `_splatData` / `_renderResources.splatBuffer`
  // / `_splatCount` trio — that was the point of Option B — but the renderer's
  // production source is now `_packedSplatTextureData` (the WASM record,
  // consumed verbatim), and the probe's predicate tests all four fields.
  "no-splat-data-fields",
  // RETIRED BY C15-G2. Before the scene-logic extraction the whole data
  // pipeline sat below the FR dispatch, so the shared snapshot state was empty
  // on the WebGPU leg. It now runs before the backend branch.
  "primitive-numsplats-zero",
  // RETIRED BY C15-G3. The FR ran far enough to allocate its cache and still
  // found no data. Between C15-G2 and C15-G3 this was the load-bearing
  // attribution — the renderer executed past its visibility guard and stopped
  // at the missing splat buffer. C15-G3 commits that buffer, so a healthy run
  // reads the asset's splat count here. Its RETURN means the buffer commit
  // stopped happening.
  "cache-splat-count-zero",
]);

/**
 * Which blockers the CURRENT stage of the GSPLAT track expects to observe.
 *
 * A dual-mode gate that only ever asks "was at least one known blocker seen?"
 * decays the moment a row removes one: the run keeps printing the same green
 * marker for a strictly smaller reason, and nobody can tell from the log that
 * the world moved. So the stage is stated explicitly and BOTH directions are
 * enforced:
 *
 *   * a blocker in `retired` that is observed again is a REGRESSION of the row
 *     that removed it — structural, never "expected absence";
 *   * a blocker in `required` that is NOT observed means the absence has a
 *     different cause than the one this stage documents — also structural,
 *     because certifying it would be certifying something unmeasured.
 *
 * `C15-G3` moved `no-splat-data-fields` and `cache-splat-count-zero` into
 * `retired`, which empties `required`. An EMPTY `required` set is itself a
 * contract: there is no absence this stage knows how to certify, so default
 * mode structurally refuses (`webgpu:stage-requires-expect-webgpu`) and the
 * run must use `--expect-webgpu`. That is deliberately not the same thing as
 * "default mode is gone" — the probe stays dual-mode, and a default run still
 * reports every blocker it observed, it just cannot call the result green.
 *
 * The stage is a PARAMETER of `evaluateWebgpuLeg` / `evaluateParity`
 * (`options.stage`), not a hard-wired constant, so the both-directions
 * enforcement stays executable against a non-empty stage after the shipped
 * one goes empty. `gsplat-harness.spec.mjs` exercises the mechanism with a
 * frozen `C15-G2` fixture and pins the SHIPPED stage separately.
 */
export const STAGE = Object.freeze({
  id: "C15-G3",
  retired: Object.freeze([
    "primitive-show-undefined",
    "primitive-numsplats-zero",
    // RETIRED BY C15-G3. The renderer's data source is now the packed WASM
    // payload (`_packedSplatTextureData`), consumed verbatim; the probe's
    // blocker predicate tests that field too, so a production primitive no
    // longer reports "no splat data reaches the renderer".
    "no-splat-data-fields",
    // RETIRED BY C15-G3. The cache commits `splatCount = _numSplats` from the
    // packed payload, so a healthy run reads 27 / 286868 here, not 0.
    "cache-splat-count-zero",
  ]),
  required: Object.freeze([]),
  /**
   * Whether the cross-backend pixel diff is a GATE at this stage, and why not.
   *
   * `C15-G3` ships the geometry: position, covariance and the RGBA8 base
   * colour, decoded bit-identically to what WebGL samples. It does NOT ship
   * spherical harmonics — the WGSL has no SH implementation at all
   * (`C15-G0` §6a(B)), and BOTH gate tilesets are SH degree 3, so every splat
   * carries a view-dependent colour term the WebGPU leg cannot reproduce yet.
   * A cross-backend diff therefore measures the MISSING SH, not the record
   * decode, and it cannot come in under the 1% / 3% thresholds no matter how
   * correct this row is.
   *
   * So parity is MEASURED and PRINTED at this stage — the number is evidence,
   * and its magnitude is the SH signal `C15-G5` has to remove — but it is not
   * folded into the verdict. What gates `C15-G3` instead is the reference
   * leg's own structure battery applied to the WEBGPU leg (added fraction,
   * edge fraction, luminance spread, the 10x negative-control margin) plus
   * splat-count equality, all of which `splatRenderCriteria` already computes
   * for whichever leg claims presence.
   *
   * The thresholds in {@link ASSETS} are UNCHANGED and stay the terminal
   * `C15-G8` gate. `C15-G5` flips `scored` to `true`; nothing else moves.
   */
  parity: Object.freeze({
    scored: false,
    deferredTo: "C15-G5",
    reason:
      "the WGSL has no spherical-harmonics term until C15-G5 and both gate " +
      "tilesets are SH degree 3, so a cross-backend diff scores the missing " +
      "view-dependent colour rather than the record decode this row ships",
  }),
  /**
   * `CO-12` — which of the three added lanes are GATES right now, and why the
   * split is not arbitrary.
   *
   * The AZIMUTH lane inherits {@link STAGE.parity}'s discipline: it is the same
   * cross-backend pixel comparison, just at three cameras instead of one, so it
   * cannot become a gate before the single-camera one does. `C15-G8` flips both
   * together (`parity.scored` and `controls.azimuth.scored`).
   *
   * The two VACUITY CONTROLS are gated NOW, at every stage, and that asymmetry
   * is the point. A ceiling ("the two backends agree to within 1%") is only
   * meaningful once someone has shown the measurement can DISAGREE; the
   * controls are floors ("switching the SH term off, or corrupting the
   * covariance, moves the number") and a floor that fails means the instrument
   * is vacuous no matter which stage the track is on. `C15-G5` certified with
   * neither of them executed — that is precisely the caveat this row exists to
   * discharge, and deferring them again would reproduce it.
   */
  controls: Object.freeze({
    azimuth: Object.freeze({
      scored: false,
      deferredTo: "C15-G8",
      reason:
        "the per-azimuth mismatch is the same cross-backend comparison the " +
        "single-camera parity leg makes, so it is armed by the same row",
    }),
    shOff: Object.freeze({
      scored: true,
      /**
       * Gated on `sh_unit_cube` only, and NOT because tower is harder — because
       * the pre-`C15-G5` residual is a RECORDED number there and is not on
       * tower. Batch 889 measured the cube's SH-off cross-backend mismatch at
       * 2.574% against a 1% threshold; tower's SH-off residual has never been
       * measured, so a floor for it would be invented at flip time rather than
       * derived. Tower is measured, printed, and left ungated until a run
       * supplies the number.
       */
      gatedAssets: Object.freeze(["sh_unit_cube"]),
      reason:
        "the C15-G5 row's own mandatory vacuity control: with SH consumption " +
        "disabled the cross-backend mismatch must rise back above the gate " +
        "threshold at >= 2 of the 3 azimuths, or the gate is not measuring SH",
    }),
    covariance: Object.freeze({
      scored: true,
      /**
       * The SINGLE-triple arm is gated on `sh_unit_cube` only, for an
       * arithmetic reason that is worth stating rather than discovering: one
       * corrupted splat can only move pixels inside its own footprint, and the
       * derived per-splat footprint is `addedFraction / expectedSplats` —
       * 19.14% / 27 = **0.709%** on the cube, versus 4.08% / 286,868 =
       * **1.4e-7** (a fraction of ONE pixel) on tower. Gating tower's single
       * arm would be gating a quantity below the instrument's resolution.
       * The BULK arm is gated on both.
       */
      singleArmGatedAssets: Object.freeze(["sh_unit_cube"]),
      reason:
        "C15-G8's own vacuity control: a deliberately corrupted covariance " +
        "must move the picture, or the parity gate cannot fail",
    }),
  }),
});

/**
 * The two in-tree tilesets (`C15-G0` §6b, "Test-asset situation"). Served by
 * `server.js`'s repo-root static mount, so no network and no Ion token.
 *
 * `parityThresholdFraction` mirrors the `C15-G8` terminal gate verbatim —
 * `tower` below 3%, `sh_unit_cube` below 1% — so the flip mode a later row
 * turns on scores against the number the track already committed to, rather
 * than a fresh one invented at flip time.
 */
export const ASSETS = Object.freeze({
  sh_unit_cube: Object.freeze({
    name: "sh_unit_cube",
    url: "/Specs/Data/Cesium3DTiles/GaussianSplats/sh_unit_cube/tileset.json",
    expectedSplats: 27,
    georeferenced: false,
    shDegree: 3,
    parityThresholdFraction: 0.01,
  }),
  tower: Object.freeze({
    name: "tower",
    url: "/Specs/Data/Cesium3DTiles/GaussianSplats/tower/tileset.json",
    expectedSplats: 286868,
    georeferenced: true,
    shDegree: 3,
    parityThresholdFraction: 0.03,
  }),
});

/**
 * Falsifiable numbers. Every one is predicted BEFORE the run and printed
 * next to what was measured, so a red is diagnosable from the log alone.
 */
export const PREDICT = Object.freeze({
  /**
   * `C15-G1`'s own exit gate: ">= 2% of canvas pixels non-background at the
   * framed camera". Measured as pixels the tileset ADDED relative to the same
   * scene with `tileset.show = false`, not as "non-black pixels" — the
   * differencing form is what makes the metric blind to a widget, a fog band,
   * or a clear-colour change that has nothing to do with splats.
   */
  minAddedFraction: 0.02,

  /**
   * Structure floors, both applied to the ADDED pixels only.
   *
   * A flood fill (wrong clear colour, a full-screen quad, a composite that
   * blits garbage) produces a huge `changed` count with almost no boundary and
   * almost no luminance spread. A splat cloud produces both. Without these two,
   * "2% of the canvas changed" is satisfied by exactly the failure mode the
   * gate is supposed to catch.
   *
   * `edgeFraction` = added pixels with at least one 4-neighbour that is NOT an
   * added pixel, over all added pixels. A solid rectangle of N pixels has
   * O(sqrt(N)) boundary, so the floor is deliberately small; the ceiling
   * catches single-pixel confetti (a decode/stride defect), which is boundary
   * almost everywhere.
   */
  minEdgeFraction: 0.002,
  maxEdgeFraction: 0.95,
  /** 8-bit code values across the added pixels' luminance. */
  minLuminanceStdDev: 4.0,

  /**
   * Anti-vacuity margin. The ON measurement must exceed the hidden-tileset
   * control by this factor, using the SAME metric against the SAME reference
   * frame. A control that merely "is small" proves nothing if the signal is
   * also small.
   */
  negativeControlMargin: 10,

  /**
   * Near-zero floors, as fractions of the canvas. Not exact zero: the WebGPU
   * leg's splat path runs a JS comparator sort and both backends composite
   * through the post-process chain, so demanding byte equality would make the
   * control unresolvable rather than strict. Raw counts are always recorded.
   */
  blankFraction: 0.001,
  determinismFraction: 0.0005,
  negativeControlFraction: 0.001,

  /**
   * Capture-liveness floor: with the scene painted a known non-background
   * colour, this fraction of the canvas must read back non-background. 0.9
   * rather than 1.0 leaves room for the viewer chrome the lane hides and for
   * any letterboxing, while still being unreachable by a dead readback.
   */
  minLivenessFraction: 0.9,

  /** Camera-framing precondition: on-screen radius of the bounding sphere. */
  minFramingRadiusPx: 40,

  /**
   * Wall-clock readiness budgets, in ms. NEVER frame counts — a cold pipeline
   * variant has measured ~2674 ms to compile on this fork, and a splat tileset
   * additionally round-trips two WASM workers (texture generator + radix sort).
   */
  contentReadyBudgetMs: 120_000,
  dataReadyBudgetMs: 120_000,
  settleMs: 2_000,

  // ── CO-12 additions ──────────────────────────────────────────────────────

  /**
   * Wall-clock budget for one CONTROL step (a pipeline-variant flip, a payload
   * re-upload) to become observable. Separate from `dataReadyBudgetMs` because
   * it is not a data load: the dominant term is a cold WGSL variant compile,
   * measured at ~2674 ms on this fork, and the SH-off control forces exactly
   * one. Wall clock, never frames — same doctrine as every other budget here.
   */
  controlSettleBudgetMs: 45_000,

  /**
   * DERIVED — the pairwise angle between the camera VIEW DIRECTIONS at two of
   * {@link AZIMUTH_HEADINGS}, which is NOT the 120 deg heading separation.
   *
   * `Camera.lookAt(centre, HeadingPitchRange(h, p, r))` places the camera on a
   * cone of half-angle `90 - |p|` about the local up axis and points it at the
   * centre, so the view direction is
   * `(cos p cos h, cos p sin h, sin p)` in the local frame. For two headings
   * separated by `d`:
   *
   *   cos(angle) = cos^2(p) * cos(d) + sin^2(p)
   *
   * At `p = -30 deg`, `d = 120 deg`: `0.75 * (-0.5) + 0.25 = -0.125`, so the
   * angle is `acos(-0.125) = 97.18075578 deg` — and by symmetry it is the SAME
   * for the 0-120, 120-240 and 240-0 pairs. This is the anti-vacuity guard for
   * the azimuth lane: three captures taken at the SAME camera would agree
   * trivially, and nothing else in the lane would notice.
   */
  azimuthSeparationDegrees: 97.18075578145829,
  azimuthSeparationToleranceDegrees: 0.5,

  /**
   * Second azimuth anti-vacuity guard, and the one that catches a camera that
   * moved on paper but not on screen (a lookAt that silently failed, a frozen
   * canvas, a flood fill that is the same at every heading). Adjacent azimuth
   * ON frames must differ by at least this FRACTION OF THE MEASURED ADDED
   * FRACTION at azimuth 0.
   *
   * Scaled rather than absolute on purpose: the cube adds ~19% of the canvas
   * and tower ~4%, so any constant floor is either vacuous for one asset or
   * unreachable for the other. 0.25 is deliberately conservative — a 120 deg
   * orbit re-projects the whole cloud, so the honest expectation is most of the
   * footprint changing, and a quarter of it is a floor no working rotation can
   * miss.
   */
  azimuthDistinctnessFactor: 0.25,

  /**
   * The RECORDED pre-`C15-G5` cross-backend mismatch on `sh_unit_cube`
   * (Batch 889, `--expect-webgpu`, same 1024x768 pinned configuration). This is
   * the number the SH-off control is expected to walk back to: with the WGSL SH
   * term switched off, the WebGPU leg is once again the pre-G5 renderer, so the
   * cross-backend diff should return to this magnitude. Recorded as a
   * PREDICTION, gated as `>= parityThresholdFraction` — the gate is "the
   * residual came back", not "it came back to three decimal places".
   */
  shOffPreG5CubeMismatchFraction: 0.02574,

  /**
   * How many of the three azimuths must show the risen SH-off residual. Two of
   * three is the `C15-G5` row's own written wording, and it is the right shape:
   * a view-dependent term can be near-zero at a particular camera (that is what
   * "view-dependent" means), so requiring all three would make a correct
   * implementation fail at an unlucky azimuth.
   */
  shOffMinAzimuths: 2,

  /**
   * Covariance-corruption control parameters, pre-registered.
   *
   * `covarianceScaleFactor` is applied in the HALF-FLOAT EXPONENT: 4 = +2 on
   * the exponent field, which is exact for every normal half and cannot
   * manufacture a NaN or an Inf (the corrupter clamps instead). Scaling all six
   * sigma terms by 4 scales the 3D covariance by 4, the projected 2D conic by
   * 4, the splat RADIUS by 2 and its AREA by 4 — a change large enough to be
   * unambiguous and small enough to stay a splat rather than a full-screen
   * artifact. Zeroing the triple was rejected: a singular covariance divides by
   * a zero determinant, and an Inf/NaN quad would satisfy this control for a
   * reason that has nothing to do with the covariance being read.
   *
   * `covarianceBulkStride = 2` corrupts every second splat. DERIVED necessity:
   * the mismatch can never exceed the union of the clean and corrupted
   * footprints, so on tower — whose clean footprint is ~4.08% of the canvas —
   * NO corruption of a small subset can reach `C15-G8`'s 3% bar. Half the cloud
   * at 4x area is the smallest pre-registered fraction with headroom over it.
   */
  covarianceScaleFactor: 4,
  covarianceSingleSplatIndex: 0,
  covarianceBulkStride: 2,
});

/**
 * `C15-G5`'s written exit gate asks for three camera azimuths 120 deg apart;
 * `C15-G8`'s asks for "the framed camera and two orbit positions". They are the
 * same three cameras, so the harness has one list and both rows read it.
 *
 * Heading 0 is the historical single-camera pose every earlier `C15-G*` reading
 * was taken at, and it stays FIRST so the primary scored frame is unchanged and
 * the recorded numbers (19.141% added, 0.000% mismatch, 2.574% pre-G5) remain
 * comparable.
 *
 * @type {readonly number[]}
 */
export const AZIMUTH_HEADINGS = Object.freeze([0, 120, 240]);

/**
 * Named STRUCTURAL preconditions. Order is the order they are checked in, and
 * the order they are reported in. `gsplat-harness.spec.mjs` pins this list: a
 * precondition silently dropped from the probe is a precondition that stops
 * protecting the gate without anything going red.
 */
export const STRUCTURAL_PRECONDITIONS = Object.freeze([
  "server-reachable",
  "tileset-fetch",
  "pass-enum-exported",
  "backend-identity",
  "tileset-content-readiness",
  "camera-framing",
  "capture-liveness",
  "background-blank",
  "sort-quiesced",
  "capture-determinism",
  "negative-control-returns",
]);

/**
 * @param {number} count
 * @param {number} canvasPixels
 * @returns {number} count/canvasPixels, or NaN when the canvas size is unusable
 *   (NaN never satisfies a `<=` or `>=` comparison, so an unmeasured canvas
 *   cannot pass a threshold by accident).
 */
export function fractionOf(count, canvasPixels) {
  if (!Number.isFinite(count) || !Number.isFinite(canvasPixels)) {
    return Number.NaN;
  }
  if (canvasPixels <= 0) {
    return Number.NaN;
  }
  return count / canvasPixels;
}

const pct = (value) =>
  Number.isFinite(value) ? `${(value * 100).toFixed(3)}%` : "n/a";

/**
 * Evaluate the preconditions that must hold before ANY number this lane
 * produced means anything.
 *
 * @param {object} lane one backend lane's measurement record
 * @param {object} [predict]
 * @returns {Array<{name:string, ok:boolean, detail:string}>}
 */
export function precheckPreconditions(lane, predict = PREDICT) {
  const canvasPixels = lane?.canvasPixels ?? 0;
  const blank = fractionOf(lane?.backgroundForeground, canvasPixels);
  const determinism = fractionOf(lane?.determinismChanged, canvasPixels);
  const control = fractionOf(lane?.negativeControlChanged, canvasPixels);
  const liveness = fractionOf(lane?.captureLivenessForeground, canvasPixels);

  return [
    {
      name: "server-reachable",
      ok: lane?.navigationOk === true,
      detail: `predicted the dev server answers at the probe base; measured navigationOk=${lane?.navigationOk}${
        lane?.navigationError ? ` (${lane.navigationError})` : ""
      }`,
    },
    {
      name: "tileset-fetch",
      ok: lane?.tilesetFetchOk === true,
      detail: `predicted HTTP 200 for the tileset.json; measured status=${
        lane?.tilesetFetchStatus ?? "none"
      }${lane?.tilesetError ? ` (${lane.tilesetError})` : ""}`,
    },
    {
      // `frustum.indices[undefined] | 0` is 0, so a `Pass` enum that stopped
      // being exported would silently report "no splat commands" — i.e. it
      // would MANUFACTURE the absence this probe is supposed to observe.
      name: "pass-enum-exported",
      ok: lane?.passEnumOk === true,
      detail: `predicted Cesium.Pass.GAUSSIAN_SPLATS is an exported integer; measured passEnumOk=${
        lane?.passEnumOk
      } (value ${lane?.passGaussianSplats ?? "none"}) — an unexported Pass turns every command count into a silent 0`,
    },
    {
      name: "backend-identity",
      ok:
        typeof lane?.rendererType === "string" &&
        lane.rendererType === lane?.requested,
      detail: `predicted rendererType=${lane?.requested}; measured ${
        lane?.rendererType || "none"
      } — a lane that silently fell back scores the OTHER backend's frame`,
    },
    {
      name: "tileset-content-readiness",
      ok: lane?.contentReady === true,
      detail: `predicted tilesLoaded + root content ready within ${
        predict.contentReadyBudgetMs
      } ms (wall clock, not frames); measured contentReady=${
        lane?.contentReady
      } at ${
        lane?.contentReadyMs === null || lane?.contentReadyMs === undefined
          ? "never"
          : `${Math.round(lane.contentReadyMs)} ms`
      }`,
    },
    {
      name: "camera-framing",
      ok:
        lane?.framing?.centerOnScreen === true &&
        Number.isFinite(lane?.framing?.radiusPx) &&
        lane.framing.radiusPx >= predict.minFramingRadiusPx,
      detail: `predicted the tileset bounding sphere projects on-screen with radius >= ${
        predict.minFramingRadiusPx
      } px; measured centerOnScreen=${lane?.framing?.centerOnScreen} radiusPx=${
        Number.isFinite(lane?.framing?.radiusPx)
          ? lane.framing.radiusPx.toFixed(1)
          : "n/a"
      } — a mis-derived camera makes "no pixels" unattributable`,
    },
    {
      // Independent of splats: the scene is painted a known non-black colour
      // and the readback must see it. Without this, a dead canvas-readback
      // path (Cesium runs `preserveDrawingBuffer: false`; the Batch-227 trap
      // on this fork was solid black post-present) is indistinguishable from
      // "the renderer drew nothing" — and would be filed as a WebGL defect
      // that does not exist.
      name: "capture-liveness",
      ok: Number.isFinite(liveness) && liveness >= predict.minLivenessFraction,
      detail: `predicted a scene painted a known non-background colour reads back >= ${pct(
        predict.minLivenessFraction,
      )} non-background; measured ${pct(liveness)} (mean RGB ${
        lane?.captureLivenessMean
          ? lane.captureLivenessMean.map((v) => Math.round(v)).join("/")
          : "n/a"
      }) — a dead readback path scores every leg as "drew nothing"`,
    },
    {
      name: "background-blank",
      ok: Number.isFinite(blank) && blank <= predict.blankFraction,
      detail: `predicted the tileset-hidden frame is blank (<= ${pct(
        predict.blankFraction,
      )} of canvas above the background threshold); measured ${pct(blank)} (${
        lane?.backgroundForeground ?? "n/a"
      } px) — a polluted reference frame contaminates every ADDED count`,
    },
    {
      // `C15-G4b`. The determinism pair used to bracket a 2 s render window with
      // thousands of event-loop yields in it, and the splat pipeline resolves
      // its WASM radix sort on exactly those yields. That made "two captures of
      // the same settled frame" a claim the probe could not keep: a permutation
      // landing mid-window legitimately re-orders an order-dependent
      // premultiplied blend. This precondition asserts the scene was sort-quiet
      // BEFORE the pair — the sort provenance `C15-G4` stamps on the published
      // permutation (`_indexesSortSequence`, backend-neutral) held steady across
      // a full settle window with no promise in flight. It is a precondition OF
      // determinism, so it is checked before it.
      name: "sort-quiesced",
      ok: lane?.sortQuiesced === true,
      detail: `predicted the splat sort is quiescent before the determinism pair (sort provenance stable for a full settle window, no sort promise in flight); measured sortQuiesced=${
        lane?.sortQuiesced
      } after ${
        lane?.sortQuiesceMs === null || lane?.sortQuiesceMs === undefined
          ? "n/a"
          : `${Math.round(lane.sortQuiesceMs)}ms`
      }, signature=${lane?.sortSignatureAtCapture ?? "n/a"} — a sort resolving between the two captures re-orders an order-dependent blend`,
    },
    {
      name: "capture-determinism",
      ok:
        Number.isFinite(determinism) &&
        determinism <= predict.determinismFraction,
      detail: `predicted two BACK-TO-BACK captures (same task, no yield between them, so no async resolution can interleave) agree to <= ${pct(
        predict.determinismFraction,
      )}; measured ${pct(determinism)} (${
        lane?.determinismChanged ?? "n/a"
      } px) — without this the ADDED count is not a resolvable measurement`,
    },
    {
      name: "negative-control-returns",
      ok:
        Number.isFinite(control) && control <= predict.negativeControlFraction,
      detail: `predicted hiding the tileset again returns to the reference frame within ${pct(
        predict.negativeControlFraction,
      )}; measured ${pct(control)} (${
        lane?.negativeControlChanged ?? "n/a"
      } px) — this is the leg that proves the metric is watching the TILESET`,
    },
  ];
}

/**
 * Classify what the WebGPU leg actually shows, from three INDEPENDENT signals:
 * committed data, a binned `Pass.GAUSSIAN_SPLATS` command, and added pixels.
 *
 * All three negative → absent. All three positive → present. Anything else is
 * AMBIGUOUS and is never folded into either bucket: "data committed but no
 * command" and "command but no pixels" are exactly the half-landed states a
 * partial `C15-G3` produces, and silently calling either one "absent" would let
 * the flip-mode gate pass or fail for the wrong reason.
 *
 * @param {object} lane
 * @param {object} [predict]
 * @returns {{state:SplatPresenceState, dataCommitted:boolean,
 *   commands:boolean, pixels:boolean, addedFraction:number, why:string}}
 */
export function classifyWebgpuPresence(lane, predict = PREDICT) {
  // RENDERER-SCOPED, deliberately. Before `C15-G2` the whole splat data
  // pipeline sat below the feature-renderer dispatch, so `_numSplats > 0` was
  // itself evidence that the WebGPU path had done something. Since the
  // scene-logic extraction that pipeline is SHARED: `_numSplats` now reads
  // 286,868 on the WebGPU leg of a run where the renderer drew nothing at all,
  // and folding it in here would classify every post-G2 run "ambiguous" and
  // exit 3 on a healthy engine. The only signal that still discriminates what
  // the WebGPU renderer did is its own cache.
  const dataCommitted = (lane?.cacheSplatCount ?? 0) > 0;
  const commands = (lane?.splatPassCommands ?? 0) > 0;
  const addedFraction = fractionOf(lane?.added?.changed, lane?.canvasPixels);
  const pixels =
    Number.isFinite(addedFraction) && addedFraction >= predict.minAddedFraction;

  const positive = [dataCommitted, commands, pixels].filter(Boolean).length;
  const why =
    `dataCommitted=${dataCommitted} (numSplats=${lane?.numSplats ?? "n/a"}, ` +
    `cache.splatCount=${lane?.cacheSplatCount ?? "n/a"}), ` +
    `splatPassCommands=${lane?.splatPassCommands ?? "n/a"}, ` +
    `addedPixels=${pct(addedFraction)} (floor ${pct(
      predict.minAddedFraction,
    )})`;

  let state = /** @type {SplatPresenceState} */ ("ambiguous");
  if (positive === 0) {
    state = "absent";
  } else if (positive === 3) {
    state = "present";
  }
  return { state, dataCommitted, commands, pixels, addedFraction, why };
}

/**
 * Product criteria shared by any leg that DOES show splats — the reference leg
 * always, the WebGPU leg only once `--expect-webgpu` is on and presence is
 * established.
 *
 * @param {object} lane
 * @param {object} asset
 * @param {object} predict
 * @returns {Record<string, boolean>}
 */
function splatRenderCriteria(lane, asset, predict) {
  const added = lane?.added ?? {};
  const addedFraction = fractionOf(added.changed, lane?.canvasPixels);
  const controlFraction = fractionOf(
    lane?.negativeControlChanged,
    lane?.canvasPixels,
  );
  return {
    splatCount: lane?.numSplats === asset.expectedSplats,
    splatPassCommands: (lane?.splatPassCommands ?? 0) >= 1,
    addedPixels:
      Number.isFinite(addedFraction) &&
      addedFraction >= predict.minAddedFraction,
    structureEdges:
      Number.isFinite(added.edgeFraction) &&
      added.edgeFraction >= predict.minEdgeFraction &&
      added.edgeFraction <= predict.maxEdgeFraction,
    structureVariance:
      Number.isFinite(added.luminanceStdDev) &&
      added.luminanceStdDev >= predict.minLuminanceStdDev,
    // The ADDED signal must beat the hidden-tileset control by a margin, using
    // the same metric on the same reference frame. `controlFraction` is
    // clamped away from 0 so a control that measured exactly zero still yields
    // a finite, satisfiable comparison rather than Infinity/NaN.
    negativeControlMargin:
      Number.isFinite(addedFraction) &&
      Number.isFinite(controlFraction) &&
      addedFraction > 0 &&
      addedFraction >=
        Math.max(controlFraction, Number.MIN_VALUE) *
          predict.negativeControlMargin,
    clean: (lane?.errors?.length ?? 0) === 0,
  };
}

const namedFailures = (prefix, criteria) =>
  Object.entries(criteria)
    .filter(([, ok]) => !ok)
    .map(([name]) => `${prefix}:${name}`);

/**
 * Intersect the blockers the lane REPORTED with the blockers this model
 * RECOGNIZES. Intersecting rather than trusting the lane is deliberate: a
 * future edit that invents a new blocker name has to add it to
 * {@link ABSENCE_BLOCKERS} — and therefore has to state, in this file, why the
 * new observation is a legitimate attribution — instead of quietly widening
 * what counts as "expected absence" from inside the page.
 *
 * @param {object} lane
 * @returns {string[]}
 */
export function recognizedBlockers(lane) {
  const reported = Array.isArray(lane?.absenceBlockers)
    ? lane.absenceBlockers
    : [];
  return ABSENCE_BLOCKERS.filter((name) => reported.includes(name));
}

/**
 * The WebGL reference leg. This is the leg the whole track is measured
 * against, so its blindness modes are STRUCTURAL: if the reference drew
 * nothing, "WebGPU differs from it" is not a defect anyone can act on.
 *
 * @param {object} lane
 * @param {object} asset
 * @param {object} [predict]
 * @returns {{criteria:(Record<string,boolean>|null), structural:string[],
 *   failures:string[], blind:boolean}}
 */
export function evaluateReferenceLeg(lane, asset, predict = PREDICT) {
  const structural = precheckPreconditions(lane, predict)
    .filter((check) => !check.ok)
    .map((check) => `reference:${check.name} — ${check.detail}`);

  if (lane?.dataReady !== true) {
    structural.push(
      `reference:splat-data-commit — predicted _numSplats > 0 and isStable within ${
        predict.dataReadyBudgetMs
      } ms; measured numSplats=${lane?.numSplats ?? "n/a"} isStable=${
        lane?.isStable
      } indexes=${lane?.indexesLength ?? "n/a"}. The WebGL splat data path runs ` +
        `through two WASM workers (gaussianSplatTextureGenerator, ` +
        `gaussianSplatSorter); if they do not resolve under Playwright the ` +
        `reference leg cannot see its own subject and NOTHING downstream in ` +
        `C15-G2..G8 can be gated against it. Instrument gap, not a product verdict.`,
    );
  }

  if (structural.length > 0) {
    // A blind leg does not also get to file product defects.
    return { criteria: null, structural, failures: [], blind: true };
  }

  const criteria = splatRenderCriteria(lane, asset, predict);
  return {
    criteria,
    structural: [],
    failures: namedFailures("reference", criteria),
    blind: false,
  };
}

/**
 * The WebGPU leg — the dual-mode half.
 *
 * DEFAULT MODE (the C15-G1..G2 world): absence is the documented current state
 * and is reported with {@link ABSENT_MARKER} while the run stays green. But the
 * absence must be ATTRIBUTABLE: the feature renderer has to have resolved ready
 * and actually run, with its cache reporting `splatCount === 0`. An absence
 * because the FR never loaded is a different fact and exits STRUCTURAL.
 * Presence in default mode is ALSO structural — good news, stale contract, and
 * a run that quietly passes on a stale contract is how a gate stops meaning
 * anything.
 *
 * EXPECT MODE (`--expect-webgpu`, turned on by C15-G3+): absence is a real
 * product FAIL, and presence hands off to the parity gate.
 *
 * @param {object} lane
 * @param {object} asset
 * @param {object} [predict]
 * @param {{expectWebgpu?:boolean, stage?:object}} [options]
 * @returns {{presence:ReturnType<typeof classifyWebgpuPresence>,
 *   criteria:(Record<string,boolean>|null), structural:string[],
 *   failures:string[], notes:string[]}}
 */
export function evaluateWebgpuLeg(
  lane,
  asset,
  predict = PREDICT,
  options = {},
) {
  const expectWebgpu = options.expectWebgpu === true;
  // The stage is injectable so the both-directions blocker enforcement stays
  // executable after the SHIPPED stage's `required` set goes empty. Production
  // callers pass nothing and get {@link STAGE}.
  const stage = options.stage ?? STAGE;
  const presence = classifyWebgpuPresence(lane, predict);
  const structural = precheckPreconditions(lane, predict)
    .filter((check) => !check.ok)
    .map((check) => `webgpu:${check.name} — ${check.detail}`);

  if (structural.length > 0) {
    return { presence, criteria: null, structural, failures: [], notes: [] };
  }

  if (!expectWebgpu) {
    if (presence.state === "present") {
      structural.push(
        `webgpu:absent-contract-stale — WebGPU rendered splats (${presence.why}). ` +
          `That is the C15-G3 outcome, but this run scored it under the ` +
          `CURRENT-STATE contract, which only knows how to certify absence. ` +
          `Re-run with --expect-webgpu to score parity.`,
      );
      return { presence, criteria: null, structural, failures: [], notes: [] };
    }
    if (presence.state === "ambiguous") {
      structural.push(
        `webgpu:partial-splat-state — ${presence.why}. Neither the documented ` +
          `absence nor a renderable cloud; a half-landed data path cannot be ` +
          `certified either way.`,
      );
      return { presence, criteria: null, structural, failures: [], notes: [] };
    }
    // Absent. At a stage with NO required blockers there is no absence left to
    // certify — every named cause has been closed — so default mode refuses
    // BEFORE it starts attributing. Falling through would report either
    // `absence-unattributed` (if the probe saw nothing, which is now the
    // healthy shape of a broken renderer) or `blocker-regression` (if it saw a
    // retired one), and both name the wrong thing: what actually happened is
    // that the run was scored under a contract the track has moved past.
    if (stage.required.length === 0) {
      structural.push(
        `webgpu:stage-requires-expect-webgpu — ${stage.id} retired every named ` +
          `blocker ([${stage.retired.join(", ")}]), so there is no absence this ` +
          `stage can certify: WebGPU is expected to RENDER splats now. This ` +
          `run measured none (${presence.why}; blockers observed: ` +
          `[${recognizedBlockers(lane).join(", ") || "none"}]). Re-run with ` +
          `--expect-webgpu, which scores that as a product FAIL instead of an ` +
          `uncertifiable absence.`,
      );
      return { presence, criteria: null, structural, failures: [], notes: [] };
    }
    // Attribute it or report STRUCTURAL.
    if (lane?.featureRendererKind !== "ready") {
      structural.push(
        `webgpu:feature-renderer-readiness — predicted the GAUSSIAN_SPLAT ` +
          `feature renderer resolves "ready" (it is registered as a LAZY ` +
          `loader, so early frames legitimately read "loading"); measured ` +
          `"${lane?.featureRendererKind ?? "none"}" after the readiness ` +
          `budget. A blank canvas because the FR never loaded is a different ` +
          `fact from the scaffolded data path, and certifies neither.`,
      );
      return { presence, criteria: null, structural, failures: [], notes: [] };
    }
    const observed = recognizedBlockers(lane);
    if (observed.length === 0) {
      structural.push(
        `webgpu:absence-unattributed — the FR is ready and nothing rendered, ` +
          `but none of the known blockers [${ABSENCE_BLOCKERS.join(
            ", ",
          )}] was observed. "Nothing rendered" is also what a broken probe ` +
          `looks like; an unattributed absence certifies nothing.`,
      );
      return { presence, criteria: null, structural, failures: [], notes: [] };
    }

    // Stage contract, both directions. See STAGE.
    const regressed = stage.retired.filter((name) => observed.includes(name));
    if (regressed.length > 0) {
      structural.push(
        `webgpu:blocker-regression — [${regressed.join(", ")}] was observed, ` +
          `but ${stage.id} removed it. Its return means that row regressed, ` +
          `not that the absence is "expected": the run would be certifying a ` +
          `blank canvas for a reason the track already closed.`,
      );
      return { presence, criteria: null, structural, failures: [], notes: [] };
    }
    const missing = stage.required.filter((name) => !observed.includes(name));
    if (missing.length > 0) {
      structural.push(
        `webgpu:blocker-contract-stale — ${stage.id} expects the absence to be ` +
          `attributable to [${stage.required.join(", ")}], but [${missing.join(
            ", ",
          )}] was not observed (saw [${observed.join(", ") || "none"}]). ` +
          `Either the cause moved or a later row landed; certifying this ` +
          `absence would be certifying something the probe did not measure.`,
      );
      return { presence, criteria: null, structural, failures: [], notes: [] };
    }

    return {
      presence,
      criteria: null,
      structural: [],
      failures: [],
      notes: [
        `${ABSENT_MARKER} — ${presence.why}; feature renderer ready; ` +
          `blockers observed: ${observed.join(", ")} (${stage.id} contract: ` +
          `requires [${stage.required.join(", ")}], forbids [${stage.retired.join(
            ", ",
          )}]). This is the documented baseline the rest of the track is ` +
          `measured against.`,
      ],
    };
  }

  // ── --expect-webgpu: the flip.
  if (presence.state === "absent") {
    return {
      presence,
      criteria: null,
      structural: [],
      failures: [`webgpu:splats-absent — ${presence.why}`],
      notes: [],
    };
  }
  if (presence.state === "ambiguous") {
    return {
      presence,
      criteria: null,
      structural: [],
      failures: [`webgpu:partial-splat-state — ${presence.why}`],
      notes: [],
    };
  }
  const criteria = splatRenderCriteria(lane, asset, predict);
  const failures = namedFailures("webgpu", criteria);
  return {
    presence,
    criteria,
    structural: [],
    failures,
    // C15-G3 — when the flip mode passes, say so with a greppable marker. The
    // criteria list is printed with it, because THAT is what `C15-G3` gates on
    // (see STAGE.parity): the reference leg's own structure battery, applied
    // to the WebGPU leg, plus splat-count equality.
    notes:
      failures.length === 0
        ? [
            `${PRESENT_MARKER} — ${presence.why}; every criterion the ` +
              `reference leg is held to now holds on the WEBGPU leg: ` +
              `${Object.keys(criteria).join(", ")}.`,
          ]
        : [],
  };
}

/**
 * The cross-backend pixel gate. Deliberately refuses to produce a number in
 * every case where the number would be vacuous — most importantly when the
 * WebGPU leg drew nothing, because two blank canvases diff to 0.000%, the
 * best score this gate can print.
 *
 * @param {{expectWebgpu:boolean, referenceBlind:boolean,
 *   presenceState:SplatPresenceState, mismatchFraction:(number|null|undefined),
 *   asset:object, stage?:object}} input
 * @returns {{scored:boolean, pass:(boolean|null), threshold:(number|null),
 *   mismatchFraction:(number|null), structural:(string|null), reason:string}}
 */
export function evaluateParity(input) {
  const stage = input?.stage ?? STAGE;
  const base = {
    scored: false,
    pass: null,
    threshold: null,
    mismatchFraction: null,
    structural: null,
  };
  if (!input?.expectWebgpu) {
    return {
      ...base,
      reason:
        "parity is scored only under --expect-webgpu; the default run certifies the documented absence",
    };
  }
  if (input.referenceBlind) {
    return {
      ...base,
      structural: "parity:reference-blind",
      reason:
        "the WebGL reference leg could not see its subject, so a mismatch against it measures nothing",
    };
  }
  if (input.presenceState !== "present") {
    return {
      ...base,
      reason: `WebGPU leg is ${input.presenceState}; a diff against a canvas with no splats scores 0% for a renderer that drew nothing`,
    };
  }
  if (!Number.isFinite(input.mismatchFraction)) {
    return {
      ...base,
      structural: "parity:no-diff-measured",
      reason:
        "both legs claim splats but no cross-backend diff was produced; the comparison never happened",
    };
  }
  // C15-G3 — the diff is still REQUIRED to exist (the check above stays
  // structural) and is reported, but it is not a gate while the WGSL has no
  // spherical-harmonics term. See STAGE.parity for why, and why leaving the
  // thresholds untouched matters: `C15-G5` flips `scored` and the SAME numbers
  // become the gate again.
  if (stage.parity?.scored === false) {
    return {
      ...base,
      mismatchFraction: input.mismatchFraction,
      reason:
        `measured mismatch ${pct(input.mismatchFraction)} — RECORDED, NOT ` +
        `GATED at ${stage.id}: ${stage.parity.reason}. The ` +
        `${pct(input.asset.parityThresholdFraction)} threshold for ` +
        `${input.asset.name} is unchanged and becomes the gate again at ` +
        `${stage.parity.deferredTo}. What gates this stage instead is the ` +
        `WebGPU leg's own structure battery + count equality.`,
    };
  }
  const threshold = input.asset.parityThresholdFraction;
  const pass = input.mismatchFraction <= threshold;
  return {
    scored: true,
    pass,
    threshold,
    mismatchFraction: input.mismatchFraction,
    structural: null,
    reason: `predicted mismatch <= ${pct(threshold)} (C15-G8 threshold for ${
      input.asset.name
    }); measured ${pct(input.mismatchFraction)}`,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// CO-12 — the three lanes `C15-G5` certified WITHOUT and `C15-G8` cannot gate
// without: three azimuths, the SH-off vacuity control, and the
// corrupted-covariance vacuity control.
//
// All three follow the same doctrine as everything above them: they REFUSE to
// produce a number in every case where the number would be vacuous, and each
// refusal is named. The two controls are FLOORS, not ceilings — they assert
// that the instrument can move, which is the one thing a parity ceiling can
// never assert about itself.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Names of the lanes this file evaluates, in the order they are reported.
 * Pinned by `gsplat-harness.spec.mjs`: a lane silently dropped from the probe
 * is a lane that stops protecting the gate without anything going red — the
 * same reason {@link STRUCTURAL_PRECONDITIONS} is pinned.
 */
export const CONTROL_LANES = Object.freeze([
  "azimuth",
  "sh-off-vacuity",
  "covariance-vacuity",
]);

const RAD_TO_DEG = 180 / Math.PI;

/**
 * Angle between two 3-vectors in degrees, or NaN when either is unusable.
 * NaN never satisfies a `<=` comparison, so an unmeasured camera cannot pass
 * the separation guard by accident (same contract as {@link fractionOf}).
 *
 * @param {number[]|undefined|null} a
 * @param {number[]|undefined|null} b
 * @returns {number}
 */
export function angleBetweenDegrees(a, b) {
  if (
    !Array.isArray(a) ||
    !Array.isArray(b) ||
    a.length !== 3 ||
    b.length !== 3
  ) {
    return Number.NaN;
  }
  let dot = 0;
  let lengthA = 0;
  let lengthB = 0;
  for (let i = 0; i < 3; i++) {
    if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) {
      return Number.NaN;
    }
    dot += a[i] * b[i];
    lengthA += a[i] * a[i];
    lengthB += b[i] * b[i];
  }
  lengthA = Math.sqrt(lengthA);
  lengthB = Math.sqrt(lengthB);
  if (!(lengthA > 0) || !(lengthB > 0)) {
    return Number.NaN;
  }
  return (
    Math.acos(Math.min(1, Math.max(-1, dot / (lengthA * lengthB)))) * RAD_TO_DEG
  );
}

const laneResult = (overrides) => ({
  scored: false,
  gated: false,
  entries: [],
  structural: [],
  failures: [],
  notes: [],
  reason: "",
  ...overrides,
});

/**
 * Preconditions shared by all three added lanes. They exist only when the
 * single-camera legs already decided the run has a subject: a lane that scores
 * three cameras against a blind reference, or against a WebGPU leg that drew
 * nothing, is measuring exactly as much as the single-camera one would have.
 *
 * @param {object} input
 * @param {string} laneName
 * @returns {{ok:boolean, result:object}}
 */
function laneGuard(input, laneName) {
  if (!input?.expectWebgpu) {
    return {
      ok: false,
      result: laneResult({
        reason: `${laneName} is scored only under --expect-webgpu`,
      }),
    };
  }
  if (input.referenceBlind) {
    return {
      ok: false,
      result: laneResult({
        structural: [`${laneName}:reference-blind`],
        reason: `the WebGL reference leg could not see its subject, so ${laneName} measures nothing`,
      }),
    };
  }
  if (input.presenceState !== "present") {
    return {
      ok: false,
      result: laneResult({
        reason: `WebGPU leg is ${input.presenceState}; ${laneName} against a canvas with no splats scores nothing`,
      }),
    };
  }
  return { ok: true, result: null };
}

/**
 * The THREE-AZIMUTH lane — `C15-G5`'s written exit gate ("three camera azimuths
 * 120 deg apart") and `C15-G8`'s ("the framed camera and two orbit positions").
 *
 * Two anti-vacuity guards run BEFORE any mismatch is read, because a
 * three-camera lane has two ways to be a one-camera lane wearing a disguise:
 *
 *   1. GEOMETRIC — the cameras did not actually separate. Guarded by the
 *      recorded view directions against the DERIVED
 *      {@link PREDICT.azimuthSeparationDegrees}, which is computed from the
 *      pitch and heading the probe actually used, not asserted.
 *   2. PICTORIAL — they separated and the picture did not follow (a frozen
 *      canvas, a stale readback, a flood fill). Guarded on the REFERENCE leg,
 *      whose frames are the ones the whole track is measured against.
 *
 * Both are STRUCTURAL, not failures: a lane that could not distinguish its own
 * cameras has not found a product defect, it has found itself.
 *
 * @param {object} input
 * @returns {object}
 */
export function evaluateAzimuthLane(input) {
  const predict = input?.predict ?? PREDICT;
  const stage = input?.stage ?? STAGE;
  const controls = stage.controls ?? STAGE.controls;
  const guard = laneGuard(input, "azimuth");
  if (!guard.ok) {
    return guard.result;
  }

  const reference = input.reference?.azimuths ?? [];
  const webgpu = input.webgpu?.azimuths ?? [];
  const diffs = input.diffs ?? [];
  const expected = AZIMUTH_HEADINGS.length;
  if (
    reference.length !== expected ||
    webgpu.length !== expected ||
    diffs.length !== expected
  ) {
    return laneResult({
      structural: [
        `azimuth:incomplete — predicted ${expected} azimuths on each leg with a cross-backend diff for each; measured reference=${reference.length} webgpu=${webgpu.length} diffs=${diffs.length}. A partial orbit is not the gate C15-G5 wrote.`,
      ],
      reason: "the orbit did not complete on both legs",
    });
  }

  // Guard 1 — the cameras really moved, on BOTH legs.
  const separationFailures = [];
  for (const [legName, leg] of [
    ["reference", reference],
    ["webgpu", webgpu],
  ]) {
    for (let i = 0; i < expected; i++) {
      const next = (i + 1) % expected;
      const angle = angleBetweenDegrees(
        leg[i]?.viewDirection,
        leg[next]?.viewDirection,
      );
      const ok =
        Number.isFinite(angle) &&
        Math.abs(angle - predict.azimuthSeparationDegrees) <=
          predict.azimuthSeparationToleranceDegrees;
      if (!ok) {
        separationFailures.push(
          `${legName} ${leg[i]?.headingDegrees}->${leg[next]?.headingDegrees} deg measured ${
            Number.isFinite(angle) ? `${angle.toFixed(3)} deg` : "n/a"
          }`,
        );
      }
    }
  }
  if (separationFailures.length > 0) {
    return laneResult({
      structural: [
        `azimuth:cameras-not-separated — predicted every adjacent pair of view directions ${predict.azimuthSeparationDegrees.toFixed(
          3,
        )} +/- ${predict.azimuthSeparationToleranceDegrees} deg apart (DERIVED from pitch ${-30} deg and 120 deg heading steps: acos(cos^2 p cos d + sin^2 p)); measured ${separationFailures.join(
          "; ",
        )}. Three captures at one camera agree trivially.`,
      ],
      reason: "the orbit did not move the camera",
    });
  }

  // Guard 2 — the picture followed, measured on the reference leg.
  const baseAdded = fractionOf(
    reference[0]?.added?.changed,
    reference[0]?.canvasPixels,
  );
  const distinctnessFloor = predict.azimuthDistinctnessFactor * baseAdded;
  const notDistinct = [];
  for (let i = 1; i < expected; i++) {
    const changed = fractionOf(
      reference[i]?.changedVsPrevious,
      reference[i]?.canvasPixels,
    );
    if (!(Number.isFinite(changed) && changed >= distinctnessFloor)) {
      notDistinct.push(
        `${reference[i - 1]?.headingDegrees}->${reference[i]?.headingDegrees} deg changed ${pct(changed)}`,
      );
    }
  }
  if (notDistinct.length > 0) {
    return laneResult({
      structural: [
        `azimuth:frames-not-distinct — predicted each orbit step changes >= ${pct(
          distinctnessFloor,
        )} of the canvas on the REFERENCE leg (${
          predict.azimuthDistinctnessFactor
        } x its ${pct(
          baseAdded,
        )} added fraction); measured ${notDistinct.join("; ")}. A camera that moved on paper and not on screen makes every azimuth number a copy of the first.`,
      ],
      reason: "the orbit did not change the picture",
    });
  }

  const threshold = input.asset.parityThresholdFraction;
  const entries = diffs.map((diff) => ({
    headingDegrees: diff.headingDegrees,
    mismatchFraction: diff.mismatchFraction,
    pass: Number.isFinite(diff.mismatchFraction)
      ? diff.mismatchFraction <= threshold
      : null,
  }));
  const unmeasured = entries.filter((e) => e.pass === null);
  if (unmeasured.length > 0) {
    return laneResult({
      entries,
      structural: [
        `azimuth:no-diff-measured — ${unmeasured
          .map((e) => `${e.headingDegrees} deg`)
          .join(
            ", ",
          )} produced no cross-backend diff; the comparison never happened`,
      ],
      reason: "one or more azimuths were never compared",
    });
  }

  const over = entries.filter((e) => e.pass === false);
  if (controls.azimuth?.scored !== true) {
    return laneResult({
      entries,
      notes: [
        `azimuth: ${entries
          .map((e) => `${e.headingDegrees}deg=${pct(e.mismatchFraction)}`)
          .join(" ")} against the ${pct(
          threshold,
        )} ${input.asset.name} threshold — RECORDED, NOT GATED at ${stage.id}: ${
          controls.azimuth?.reason ?? "no reason recorded"
        }. Armed at ${controls.azimuth?.deferredTo ?? "C15-G8"}.`,
      ],
      reason: `measured ${entries
        .map((e) => `${e.headingDegrees}deg=${pct(e.mismatchFraction)}`)
        .join(" ")} — recorded, not gated at ${stage.id}`,
    });
  }
  return laneResult({
    scored: true,
    gated: true,
    entries,
    failures: over.map(
      (e) =>
        `azimuth:mismatch-above-threshold@${e.headingDegrees}deg — predicted <= ${pct(
          threshold,
        )}; measured ${pct(e.mismatchFraction)}`,
    ),
    reason: `predicted every azimuth <= ${pct(threshold)}; measured ${entries
      .map((e) => `${e.headingDegrees}deg=${pct(e.mismatchFraction)}`)
      .join(" ")}`,
  });
}

/**
 * The SH-OFF VACUITY CONTROL — the check `C15-G5` declared MANDATORY in its own
 * exit gate and then certified without.
 *
 * With the WGSL spherical-harmonics term switched off, the WebGPU leg is once
 * again the pre-`C15-G5` renderer, so the cross-backend mismatch must climb
 * back to the recorded pre-G5 residual. If it does NOT — if SH-off still diffs
 * to 0.000% against a WebGL leg that evaluates degree-3 SH — then the 0.000%
 * the row certified on was never measuring SH, and the two legs agree for some
 * other reason entirely. That is the failure this control exists to name, and
 * it is the one a ceiling can never catch: a vacuous gate reports its best
 * possible score.
 *
 * @param {object} input
 * @returns {object}
 */
export function evaluateShOffControl(input) {
  const predict = input?.predict ?? PREDICT;
  const stage = input?.stage ?? STAGE;
  const controls = stage.controls ?? STAGE.controls;
  const guard = laneGuard(input, "sh-off");
  if (!guard.ok) {
    return guard.result;
  }

  const control = input.control ?? {};
  if (control.supported !== true) {
    return laneResult({
      structural: [
        `sh-off:not-executed — ${control.why ?? "the probe did not run the SH-off leg"}. The C15-G5 exit gate calls this control MANDATORY, so a run without it certifies nothing about the SH term.`,
      ],
      reason: "the SH-off leg did not execute",
    });
  }

  // Two-sided, exactly like the tileset-hidden negative control: switching SH
  // back on must return the picture. A control that permanently mutates the
  // scene invalidates the readings taken before it, not just its own.
  const restored = fractionOf(control.restoredChanged, control.canvasPixels);
  if (
    control.restored !== true ||
    !(Number.isFinite(restored) && restored <= predict.determinismFraction)
  ) {
    return laneResult({
      structural: [
        `sh-off:not-restored — predicted re-enabling SH returns to the clean frame within ${pct(
          predict.determinismFraction,
        )}; measured restored=${control.restored} at ${pct(
          restored,
        )}. An irreversible control leaves every number in the run describing a different renderer than the one under test.`,
      ],
      reason: "the SH-off control did not restore the renderer",
    });
  }

  const entries = (control.azimuths ?? []).map((entry) => ({
    headingDegrees: entry.headingDegrees,
    crossBackendMismatch: entry.crossBackendMismatch,
    sameBackendMismatch: entry.sameBackendMismatch,
  }));
  if (entries.length !== AZIMUTH_HEADINGS.length) {
    return laneResult({
      entries,
      structural: [
        `sh-off:incomplete — predicted ${AZIMUTH_HEADINGS.length} SH-off captures (the row asks for the control at >= 2 of 3 azimuths); measured ${entries.length}`,
      ],
      reason: "the SH-off orbit did not complete",
    });
  }

  const threshold = input.asset.parityThresholdFraction;
  const risen = entries.filter(
    (e) =>
      Number.isFinite(e.crossBackendMismatch) &&
      e.crossBackendMismatch >= threshold,
  );
  const measured = entries
    .map(
      (e) =>
        `${e.headingDegrees}deg=${pct(e.crossBackendMismatch)}(vs-webgl)/${pct(
          e.sameBackendMismatch,
        )}(vs-sh-on)`,
    )
    .join(" ");

  const gatedHere = (controls.shOff?.gatedAssets ?? []).includes(
    input.asset.name,
  );
  if (controls.shOff?.scored !== true || !gatedHere) {
    return laneResult({
      entries,
      notes: [
        `sh-off: ${measured} — RECORDED, NOT GATED for ${input.asset.name}: ${
          gatedHere
            ? (controls.shOff?.reason ?? "no reason recorded")
            : "the pre-C15-G5 residual is a recorded number on sh_unit_cube only, so a floor for this asset would be invented rather than derived"
        }`,
      ],
      reason: `measured ${measured} — recorded, not gated for ${input.asset.name}`,
    });
  }

  const failures =
    risen.length >= predict.shOffMinAzimuths
      ? []
      : [
          `sh-off:sh-term-vacuous — predicted the cross-backend mismatch rises back to about ${pct(
            predict.shOffPreG5CubeMismatchFraction,
          )} (the recorded pre-C15-G5 figure) and clears the ${pct(
            threshold,
          )} gate threshold at >= ${
            predict.shOffMinAzimuths
          } of ${entries.length} azimuths; measured ${measured} — ${
            risen.length
          } cleared it. An SH-off leg that still matches WebGL means the parity number is not measuring the SH term.`,
        ];
  return laneResult({
    scored: true,
    gated: true,
    entries,
    failures,
    reason: `predicted >= ${predict.shOffMinAzimuths} of ${entries.length} azimuths above ${pct(
      threshold,
    )} with SH off (pre-C15-G5 reference ${pct(
      predict.shOffPreG5CubeMismatchFraction,
    )}); measured ${measured}`,
  });
}

/**
 * The CORRUPTED-COVARIANCE VACUITY CONTROL — `C15-G8`'s own ("an intentionally
 * corrupted covariance term must push the mismatch above the threshold, proving
 * the gate can fail").
 *
 * Both arms are same-backend: the corrupted WebGPU frame against the clean
 * WebGPU frame at the same camera. That is deliberate — the question is whether
 * the WebGPU pixel path READS the covariance bytes, and a cross-backend diff
 * would fold in every other difference between the two renderers.
 *
 * The corruption is applied to a COPY of the payload and then withdrawn, and
 * the withdrawal is itself gated: an irreversible corruption would mean every
 * later reading describes damaged data.
 *
 * @param {object} input
 * @returns {object}
 */
export function evaluateCovarianceControl(input) {
  const predict = input?.predict ?? PREDICT;
  const stage = input?.stage ?? STAGE;
  const controls = stage.controls ?? STAGE.controls;
  const guard = laneGuard(input, "covariance");
  if (!guard.ok) {
    return guard.result;
  }

  const control = input.control ?? {};
  if (control.supported !== true) {
    return laneResult({
      structural: [
        `covariance:not-executed — ${control.why ?? "the probe did not run the corruption leg"}. Without it the parity threshold has never been shown to be reachable from the wrong side.`,
      ],
      reason: "the corruption leg did not execute",
    });
  }

  const canvasPixels = control.canvasPixels;
  const restored = fractionOf(control.restoredChanged, canvasPixels);
  if (
    control.restored !== true ||
    !(Number.isFinite(restored) && restored <= predict.determinismFraction)
  ) {
    return laneResult({
      structural: [
        `covariance:not-restored — predicted restoring the original payload returns to the clean frame within ${pct(
          predict.determinismFraction,
        )}; measured restored=${control.restored} at ${pct(restored)}`,
      ],
      reason: "the corruption was not reversible",
    });
  }

  const single = fractionOf(control.singleChanged, canvasPixels);
  const bulk = fractionOf(control.bulkChanged, canvasPixels);
  const threshold = input.asset.parityThresholdFraction;
  // DERIVED — one corrupted splat can only move pixels inside its own
  // footprint, whose expected size is the measured added fraction divided by
  // the splat count. Printed next to the measurement so a red is diagnosable
  // from the log rather than from arithmetic done later.
  const perSplatFootprint =
    fractionOf(control.cleanAddedChanged, canvasPixels) /
    input.asset.expectedSplats;
  const singleFloor =
    predict.negativeControlMargin * predict.determinismFraction;
  const entries = [
    {
      arm: "single",
      changedFraction: single,
      floor: singleFloor,
      derivedFootprint: perSplatFootprint,
    },
    { arm: "bulk", changedFraction: bulk, floor: threshold },
  ];
  const measured = `single=${pct(single)} (derived per-splat footprint ${pct(
    perSplatFootprint,
  )}, floor ${pct(singleFloor)}) bulk=${pct(bulk)} (floor ${pct(threshold)})`;

  if (controls.covariance?.scored !== true) {
    return laneResult({
      entries,
      notes: [`covariance: ${measured} — RECORDED, NOT GATED at ${stage.id}`],
      reason: `measured ${measured} — recorded, not gated at ${stage.id}`,
    });
  }

  const failures = [];
  const singleGated = (
    controls.covariance?.singleArmGatedAssets ?? []
  ).includes(input.asset.name);
  if (singleGated && !(Number.isFinite(single) && single >= singleFloor)) {
    failures.push(
      `covariance:single-triple-invisible — predicted corrupting ONE covariance triple (splat ${predict.covarianceSingleSplatIndex}, all six sigma terms x${predict.covarianceScaleFactor}) moves >= ${pct(
        singleFloor,
      )} of the canvas (${
        predict.negativeControlMargin
      }x the determinism bar, and below the ${pct(
        perSplatFootprint,
      )} footprint that splat occupies); measured ${pct(single)}`,
    );
  }
  if (!(Number.isFinite(bulk) && bulk >= threshold)) {
    failures.push(
      `covariance:gate-cannot-fail — predicted corrupting every ${predict.covarianceBulkStride}th splat's covariance moves >= ${pct(
        threshold,
      )} of the canvas, i.e. past the ${input.asset.name} parity gate itself; measured ${pct(
        bulk,
      )}. A parity gate that a corrupted covariance cannot breach is not gating the covariance.`,
    );
  }
  return laneResult({
    scored: true,
    gated: true,
    entries,
    failures,
    reason: `predicted single >= ${pct(singleFloor)}${
      singleGated ? "" : " (recorded only for this asset)"
    } and bulk >= ${pct(threshold)}; measured ${measured}`,
  });
}

/**
 * Fold the legs into one verdict + exit code.
 *
 * FAIL outranks STRUCTURAL: a run with a real defect reports the defect. But a
 * run with no FAIL and any structural leg is NOT green — exit 3, so a run that
 * could not see its subject can never be mistaken for one that did.
 *
 * @param {{reference:object, webgpu:object, parity?:object}} evaluated
 * @returns {{verdict:string, exitCode:number, failures:string[],
 *   structural:string[], notes:string[]}}
 */
export function foldGsplatVerdict(evaluated) {
  const failures = [
    ...(evaluated?.reference?.failures ?? []),
    ...(evaluated?.webgpu?.failures ?? []),
  ];
  const structural = [
    ...(evaluated?.reference?.structural ?? []),
    ...(evaluated?.webgpu?.structural ?? []),
  ];
  const notes = [...(evaluated?.webgpu?.notes ?? [])];

  const parity = evaluated?.parity;
  if (parity) {
    if (parity.structural) {
      structural.push(`${parity.structural} — ${parity.reason}`);
    }
    if (parity.scored && parity.pass === false) {
      failures.push(`parity:mismatch-above-threshold — ${parity.reason}`);
    }
  }

  // CO-12 — the added lanes fold in the SAME shape as the legs above (arrays of
  // named failures and structural items), so nothing here special-cases them
  // and adding a fourth lane costs one entry in the probe's array. A lane whose
  // arrays are empty contributes nothing, which is what "recorded, not gated"
  // is supposed to look like.
  for (const lane of evaluated?.controls ?? []) {
    if (!lane) continue;
    failures.push(...(lane.failures ?? []));
    structural.push(...(lane.structural ?? []));
    notes.push(...(lane.notes ?? []));
  }

  let verdict = "PASS";
  let exitCode = EXIT_CODE.PASS;
  if (failures.length > 0) {
    verdict = "FAIL";
    exitCode = EXIT_CODE.FAIL;
  } else if (structural.length > 0) {
    verdict = "STRUCTURAL";
    exitCode = EXIT_CODE.STRUCTURAL;
  }
  return { verdict, exitCode, failures, structural, notes };
}
