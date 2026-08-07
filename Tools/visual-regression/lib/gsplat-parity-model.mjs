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
  // `C15-G0`'s recorded break, and the one `C15-G3` closes: nothing in
  // packages/ assigns any of `_splatData` / `_renderResources.splatBuffer` /
  // `_splatCount`.
  "no-splat-data-fields",
  // RETIRED BY C15-G2. Before the scene-logic extraction the whole data
  // pipeline sat below the FR dispatch, so the shared snapshot state was empty
  // on the WebGPU leg. It now runs before the backend branch.
  "primitive-numsplats-zero",
  // The FR ran far enough to allocate its cache and still found no data. Since
  // C15-G2 this is the load-bearing one: it proves the renderer executed past
  // its visibility guard and stopped at the missing splat buffer, which is
  // exactly and only what `C15-G3` is left to fix.
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
 * `C15-G3` moves `no-splat-data-fields` and `cache-splat-count-zero` into
 * `retired`, at which point `required` is empty and the probe must be run with
 * `--expect-webgpu` instead.
 */
export const STAGE = Object.freeze({
  id: "C15-G2",
  retired: Object.freeze([
    "primitive-show-undefined",
    "primitive-numsplats-zero",
  ]),
  required: Object.freeze(["no-splat-data-fields", "cache-splat-count-zero"]),
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
});

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
      name: "capture-determinism",
      ok:
        Number.isFinite(determinism) &&
        determinism <= predict.determinismFraction,
      detail: `predicted two captures of the SAME settled frame agree to <= ${pct(
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
 * @param {{expectWebgpu?:boolean}} [options]
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
    // Absent — the expected state. Attribute it or report STRUCTURAL.
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
    const regressed = STAGE.retired.filter((name) => observed.includes(name));
    if (regressed.length > 0) {
      structural.push(
        `webgpu:blocker-regression — [${regressed.join(", ")}] was observed, ` +
          `but ${STAGE.id} removed it. Its return means that row regressed, ` +
          `not that the absence is "expected": the run would be certifying a ` +
          `blank canvas for a reason the track already closed.`,
      );
      return { presence, criteria: null, structural, failures: [], notes: [] };
    }
    const missing = STAGE.required.filter((name) => !observed.includes(name));
    if (missing.length > 0) {
      structural.push(
        `webgpu:blocker-contract-stale — ${STAGE.id} expects the absence to be ` +
          `attributable to [${STAGE.required.join(", ")}], but [${missing.join(
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
          `blockers observed: ${observed.join(", ")} (${STAGE.id} contract: ` +
          `requires [${STAGE.required.join(", ")}], forbids [${STAGE.retired.join(
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
  return {
    presence,
    criteria,
    structural: [],
    failures: namedFailures("webgpu", criteria),
    notes: [],
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
 *   asset:object}} input
 * @returns {{scored:boolean, pass:(boolean|null), threshold:(number|null),
 *   mismatchFraction:(number|null), structural:(string|null), reason:string}}
 */
export function evaluateParity(input) {
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
