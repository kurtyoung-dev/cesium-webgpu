/**
 * @purpose The arm table and pure reductions behind probe-cloud-march-mechanism.mjs: one dial per arm at one camera, and the frustum-far sweep's predicted-versus-measured period test with its stop condition.
 * @status ACTIVE
 *
 * WHAT THE LEG THIS DRIVES IS FOR. Orbital cloud captures carry a family of
 * concentric bands. Four independent readings say the family is NOT the
 * march's step size: it is uniform in ln(eye-axis depth) to about 2 % while
 * the step is not, it does not move when the primary step count is halved, and
 * the shipped step at the sub-satellite point is 26 m against a 2,500 m deck.
 * The remaining model is that the march's occlusion clamp compares against a
 * depth value it reads through an `r16float` resolve, whose one-ulp quantum at
 * orbital range is tens of kilometres. That model is consistent with the
 * banked captures in period AND in duty cycle, and it has NOT been confirmed
 * by a controlled experiment. This leg is that experiment.
 *
 * ONE DIAL PER ARM, ONE CAMERA, AND THE BASELINE RESTORED BETWEEN THEM. Every
 * arm renders the same recipe camera and changes exactly one thing, because
 * the whole point is attribution. An arm that changed two dials could not say
 * which one moved the bands — and one page runs every arm, so "one dial" is
 * only true if each arm starts from the same scene. `pageRunArm` below
 * restores the baseline captured by `pageBuildScene` before it applies its own
 * dial, and the far multiplier multiplies that RESTORED far rather than
 * whatever the previous sweep row left behind. Both were review findings
 * (Reginard R-2, Sigismond R1, 2026-09-19) against a first draft that had
 * neither: without the restore `M1`'s `globe.show = false` persisted into every
 * later arm, which switches OFF the very occlusion clamp the positive arm is
 * there to measure, and the far multipliers compounded into a running product
 * whose row labelled x4 landed back on the reference frustum.
 *
 * WHAT THE MODEL PREDICTS, IN NUMBERS, BEFORE THE RUN. Under log depth the
 * scene constructor pins the camera frustum at near 0.1 / far 1e10
 * (`Scene.js:1477-1478`) and the cloud pass packs those two planes verbatim
 * into slots 105/106 (`WebGPUProceduralCloudRenderer.ts:3780-3781`), so the
 * shipped scale is `log2(1e10 - 0.1 + 1) = 33.2193` and a 2^-11 half-float ulp
 * on the stored log depth is `33.2193 * ln2 * 2^-11 = 1.12431e-2` in
 * ln(eye-axis depth) — against the banked capture's measured `1.09239e-2`,
 * 2.84 % low, where the two frusta the design had guessed at are 11.7 % and
 * 21.5 % out. `predictedPeriod` is a RATIO of scales against a measured
 * reference, so neither the absolute scale nor the mantissa width enters the
 * sweep's arithmetic; the paragraph is here because a model whose magnitude is
 * explained is a different claim from one whose magnitude is not.
 *
 * THE VETO AND THE POSITIVE ARM ARE DIFFERENT ARMS, and conflating them is the
 * error this table exists to prevent. Hiding the globe makes the occlusion
 * clamp unreachable, so bands that SURVIVE it refute the model outright — that
 * direction is sound. Bands that vanish prove nothing on their own: hiding the
 * globe also removes the composite against globe colour, the hierarchical-Z
 * path, exposure adaptation over a suddenly black frame, and any depth
 * consumer nobody has enumerated. The positive arm is the frustum-far sweep,
 * which makes a NUMBER with the globe on screen.
 *
 * EVERY CAPTURING ARM TAKES TWO FRAMES, CLOUDS ON AND CLOUDS OFF. The scorer
 * downstream is `cloudContributionField(on, off)`, which is what separates the
 * cloud layer's ring energy from the limb, the terminator and the terrain
 * under it. An OFF frame borrowed from another arm is a different scene: `M1`
 * has no globe, `M3` has no real terrain, and the rig with imagery draws a
 * planet. So the OFF frame is taken from the arm's own scene, immediately
 * after its ON frame, with only `enableVolumetric` moved (Sigismond R3).
 *
 * EVERY DIAL REPORTS WHETHER IT TOOK, AND AN ARM WHOSE DIAL DID NOT TAKE IS
 * NOT BANKED. Round two returned this file twice for the same defect in two
 * places: page-side code written from a READING of the engine rather than
 * from the engine. The clouds-OFF control restored the master gate into the
 * same `configure` call that was clearing it, so the first OFF frame threw and
 * ended the run; and the god-ray arm wrote `postProcessStages.godRays`, a
 * member the engine has never had, behind an `if` with no `else` — so M7
 * rendered M0 and the summary printed M7's requested dial as though it were
 * M7's treatment. The structural answer is here rather than in either fix:
 * `pageRunArm` reads every dial BACK off the scene and returns
 * `dialReports` / `dialsApplied`, and the probe refuses to bank a capture from
 * an arm that reports `applied: false`. A dial that cannot apply now costs one
 * named refusal instead of a labelled picture of the wrong scene.
 */

/** Identifiers, so a caller cannot misspell one into a silent no-op. */
export const MECHANISM_ARM_IDS = Object.freeze([
  "M0",
  "M1",
  "M3",
  "M4",
  // M5 (march jitter off) is STRUCK, 2026-09-19, before the leg ran. There is
  // no public dial for it: `CloudVolumetrics` carries no jitter property at
  // all — jitter is a tier-preset flag (`WebGPUCloudTierPresets.ts`
  // `jitterEnabled`) — and `__cloudProbe.configure` THROWS on a key that is
  // not a `CloudVolumetrics` property, so the arm would have ended the run
  // part-way through the leg rather than captured anything. The only public
  // route to jitter-off is the raw `cloudQuality` escape hatch, which is arm
  // M4 (`resolveCloudPreset` clears `jitterEnabled` on that path). The missing
  // dial is filed as `C13-N63` by this batch's ledger half, which is HELD at
  // the seat — so if this comment reaches a tree where that row does not exist
  // yet, the row is the thing that is late, not this strike. `C13-44` does NOT
  // get its evidence from this leg either way.
  "M6",
  "M7",
  "M2",
]);

/**
 * The arms, in execution order.
 *
 * `M2` is LAST on purpose, and it is the only arm that is not a capture: the
 * bind-group build it exercises is predicted to raise a device validation
 * error, and a device in an error state must not be able to contaminate a
 * capture taken after it. See `confirms` on that row.
 */
export const MECHANISM_ARMS = Object.freeze([
  Object.freeze({
    id: "M0",
    dial: "none",
    captures: true,
    decides:
      "reproduces the band family in this leg's own units and banks the RED fixture every other arm is read against",
  }),
  Object.freeze({
    id: "M1",
    dial: "scene.globe.show = false",
    captures: true,
    veto: true,
    decides:
      "DECISIVE IN THE NEGATIVE ONLY. With no globe every pixel carries the cleared far depth, the march's depth guard is false and no occlusion clamp runs. Bands that SURVIVE refute the model and the engine row is not written. Bands that vanish do NOT establish the clamp: hiding the globe removes several other things at once.",
  }),
  Object.freeze({
    id: "M3",
    dial: "terrain provider and maximumScreenSpaceError",
    captures: true,
    decides:
      "the polygon corollary. The innermost contour in the banked capture is a straight-edged polygon; a contour of a quantised read of a tessellated surface moves with the tessellation, and nothing cloud-side knows the tessellation exists.",
  }),
  Object.freeze({
    id: "M4",
    dial: "raw cloudQuality step count",
    captures: true,
    decides:
      "the step-count-only arm. Confound to state in the report: the raw escape hatch also switches the noise source to live and disables reconstruction, so it is not a single-variable arm and is read only for the direction of the band radii.",
  }),
  Object.freeze({
    id: "M6",
    dial: "camera.frustum.far multiplier",
    captures: true,
    positive: true,
    stopCondition: true,
    decides:
      "THE POSITIVE ARM, and the only one that makes a quantitative prediction with the globe on screen. If the family is depth quantisation, its period in ln(depth) scales with log2(far - near + 1); a far sweep therefore shifts every band radius by a predicted amount. Bands that ignore `far` refute the model with the globe drawn. STOP: if the recorded far and the measured period are inconsistent, the write/inverse pair is doing something nobody has read and no engine change is briefed until it is.",
  }),
  Object.freeze({
    id: "M7",
    // The two scene expandos, named: `scene.godRayEnabled` is the enable
    // (`WebGPUPostProcessStageCollection.ts:456-457`) and
    // `scene.godRayCloudAware` is what makes the cloud pass publish the
    // transmittance mask this arm is named after
    // (`WebGPUSceneRendererPostFrustumChain.ts:213-219`). There is no
    // `scene.postProcessStages.godRays`; the first draft drove that and was a
    // silent no-op (Reginard R2-2, Sigismond R5). The arm survives rather than
    // being struck like M5 because the flags ARE reachable from a page — the
    // tracked `lib/c13-42-reproduction-harness.mjs` drives `godRayEnabled` on
    // a real viewer and reads the realised effect back — and because the arm
    // now reports requested-versus-realised rather than assuming.
    dial: "scene.godRayEnabled + scene.godRayCloudAware on, sun in frame",
    captures: true,
    decides:
      "the march's deck function has a second fragment entry point that feeds the god-ray transmittance mask, so any change inside it moves god rays too. This arm banks the before picture that a fixture spec cannot give. It is banked ONLY if the arm reports the effect realised: a requested god ray that never reached a live effect is a second copy of M0 under M7's label.",
  }),
  Object.freeze({
    id: "M2",
    dial: "scene.msaaSamples 4 -> 1",
    captures: false,
    confirms:
      "PREDICTED FROM SOURCE, NOT OBSERVED: in single-sample mode the depth view published to the cloud pass is a depth-only aspect view, while the cloud bind-group layout declares that slot as a filterable float texture. Binding one to the other is a validation error, so this arm is expected to FAIL rather than render. It is last, it captures nothing, and its whole job is to confirm or refute that reading on a device. If it confirms, single-sample mode with procedural clouds is broken at the tip independently of the bands.",
    decides:
      "whether the quantum changes character when the depth read stops going through the 16-bit float resolve — only reachable at all if the bind group validates.",
  }),
]);

/** Look one arm up by id. */
export function armById(id) {
  const arm = MECHANISM_ARMS.find((entry) => entry.id === id);
  if (arm === undefined) {
    throw new RangeError(
      `unknown mechanism arm ${String(id)}; expected one of ${MECHANISM_ARM_IDS.join(", ")}`,
    );
  }
  return arm;
}

/**
 * The renderer-wide logarithmic depth scale for a frustum, `log2(far - near + 1)`.
 *
 * This is the constant the shader's own depth inverse multiplies by, so it is
 * also the constant the quantum of a fixed-mantissa depth store scales with.
 *
 * @param {number} nearMetres Frustum near plane.
 * @param {number} farMetres Frustum far plane.
 * @returns {number} The scale.
 */
export function logDepthScale(nearMetres, farMetres) {
  if (!Number.isFinite(nearMetres) || !Number.isFinite(farMetres)) {
    throw new TypeError("logDepthScale needs finite near and far planes");
  }
  if (!(farMetres > nearMetres)) {
    throw new RangeError(`far ${farMetres} must exceed near ${nearMetres}`);
  }
  return Math.log2(farMetres - nearMetres + 1);
}

/**
 * The band period the depth-quantisation model predicts for a frustum, given
 * the period measured at a reference frustum.
 *
 * Under the model the period in ln(eye-axis depth) is
 * `logDepthScale * ln2 * 2^-mantissaBits`, so it is PROPORTIONAL to the scale
 * and the mantissa width cancels: a reference measurement plus a ratio of
 * scales predicts the swept period with no free parameter at all. That is what
 * makes this arm a test rather than a fit.
 *
 * @param {object} options
 * @param {number} options.referencePeriod Measured period at the reference frustum.
 * @param {number} options.referenceNear Reference near plane.
 * @param {number} options.referenceFar Reference far plane.
 * @param {number} options.near Near plane of the frustum being predicted.
 * @param {number} options.far Far plane of the frustum being predicted.
 * @returns {number} Predicted period.
 */
export function predictedPeriod({
  referencePeriod,
  referenceNear,
  referenceFar,
  near,
  far,
}) {
  if (!Number.isFinite(referencePeriod) || !(referencePeriod > 0)) {
    throw new TypeError("referencePeriod must be a positive finite number");
  }
  return (
    referencePeriod *
    (logDepthScale(near, far) / logDepthScale(referenceNear, referenceFar))
  );
}

/**
 * Score the frustum-far sweep: does the measured band period move the way the
 * recorded frustum says it must?
 *
 * The reference row is the one with multiplier 1. Every other row's period is
 * predicted from the reference and the recorded planes, and the residual is
 * compared against a tolerance the caller states — which should be a few times
 * the onset ladder's own coefficient of variation, not a number chosen to make
 * the answer come out.
 *
 * `verdict` is deliberately one of three strings and never a boolean: "the
 * sweep was not measured" and "the sweep refuted the model" are different
 * facts and a boolean cannot hold both.
 *
 * @param {Array<object>} rows `{multiplier, nearMetres, farMetres, lnZSpacingMean}`.
 * @param {object} [options] `tolerance`, default 0.03.
 * @returns {object} `{verdict, rows, stop, reason}`.
 */
export function evaluateFarSweep(rows, options = {}) {
  const tolerance = options.tolerance ?? 0.03;
  if (!Array.isArray(rows) || rows.length < 2) {
    return {
      verdict: "unmeasured",
      stop: false,
      rows: [],
      reason: "the far sweep needs a reference row and at least one swept row",
    };
  }
  const reference = rows.find((row) => row.multiplier === 1);
  if (reference === undefined) {
    return {
      verdict: "unmeasured",
      stop: false,
      rows: [],
      reason: "no row carries multiplier 1, so there is no reference period",
    };
  }
  const usable = (row) =>
    Number.isFinite(row?.nearMetres) &&
    Number.isFinite(row?.farMetres) &&
    Number.isFinite(row?.lnZSpacingMean) &&
    row.lnZSpacingMean > 0;
  if (!usable(reference)) {
    return {
      verdict: "unmeasured",
      stop: false,
      rows: [],
      reason:
        "the reference row has no recorded frustum or no measured period; the leg recorded nothing to test",
    };
  }

  const scored = [];
  let anyUnmeasured = false;
  for (const row of rows) {
    if (row === reference) {
      continue;
    }
    if (!usable(row)) {
      anyUnmeasured = true;
      scored.push({ multiplier: row?.multiplier ?? null, residual: null });
      continue;
    }
    const predicted = predictedPeriod({
      referencePeriod: reference.lnZSpacingMean,
      referenceNear: reference.nearMetres,
      referenceFar: reference.farMetres,
      near: row.nearMetres,
      far: row.farMetres,
    });
    scored.push({
      multiplier: row.multiplier,
      nearMetres: row.nearMetres,
      farMetres: row.farMetres,
      predicted,
      observed: row.lnZSpacingMean,
      predictedShift: predicted / reference.lnZSpacingMean - 1,
      observedShift: row.lnZSpacingMean / reference.lnZSpacingMean - 1,
      residual: row.lnZSpacingMean / predicted - 1,
    });
  }

  if (anyUnmeasured) {
    return {
      verdict: "unmeasured",
      stop: false,
      rows: scored,
      reason:
        "at least one swept arm produced no frustum readout or no resolvable band ladder",
    };
  }
  const worst = scored.reduce(
    (a, b) => (Math.abs(a.residual) >= Math.abs(b.residual) ? a : b),
    scored[0],
  );
  if (Math.abs(worst.residual) <= tolerance) {
    return {
      verdict: "consistent",
      stop: false,
      rows: scored,
      tolerance,
      worst,
      reason:
        "every swept arm's band period moved by what the recorded frustum predicts; the family tracks the depth encoding",
    };
  }
  return {
    verdict: "inconsistent",
    // The STOP condition. The recorded planes and the measured period do not
    // agree, so something in the write/inverse pair is doing what nobody has
    // read, and no engine change is briefed until it is.
    stop: true,
    rows: scored,
    tolerance,
    worst,
    reason:
      `the far sweep's worst residual is ${(worst.residual * 100).toFixed(1)} % against a ${(tolerance * 100).toFixed(1)} % tolerance; ` +
      "either the family is not depth quantisation, or the frustum the shader packs is not the frustum this leg recorded",
  };
}

// ---------------------------------------------------------------------------
// The page-side halves of the leg.
//
// THEY LIVE HERE, NOT IN THE PROBE, SO A NODE SPEC CAN EXECUTE THEM. The first
// draft kept them inline in `probe-cloud-march-mechanism.mjs` behind a
// `c8 ignore` block, which meant the arm-isolation logic — the part two
// reviewers found broken — was covered by nothing at all while the descriptor
// and the arithmetic around it were covered four ways. Exported here they are
// driven against a fake viewer in `cloud-orbital-ladder-contract.spec.mjs`
// section D, with the REAL `installCloudProbeHarness` installed over it, so the
// refusals below are the refusals the page gets.
//
// EACH IS SELF-CONTAINED ON PURPOSE. `page.evaluate` serialises the function's
// source and nothing else, so a module-scope constant referenced from one of
// these arrives in the page as a ReferenceError at first call. They read
// `globalThis` rather than `window` for the same reason the split exists: the
// two are the same object in a page, and only one of them exists in Node.
// ---------------------------------------------------------------------------

/**
 * Take the page's viewer under this leg's control and capture the baseline
 * every arm is restored to.
 *
 * Returns rather than throws wherever it can, because a throw inside
 * `page.evaluate` reaches the Node side as an opaque browser error — which is
 * the shape this leg is trying to avoid, not one to reproduce. The one
 * exception is the harness's own refusal, which names the offending dial.
 *
 * @param {object} config `{clock, dials}` — the rig's clock and its dial block.
 * @returns {Promise<object>} The build verdict, including `baseline`.
 */
export async function pageBuildScene(config) {
  // __mechanismBuildScene
  const root = globalThis;
  const viewer = root.viewer;
  const scene = viewer.scene;
  const Cesium = root.Cesium;
  viewer.useDefaultRenderLoop = false;
  scene.requestRenderMode = false;
  viewer.clock.shouldAnimate = false;
  viewer.clock.currentTime = Cesium.JulianDate.fromIso8601(config.clock);

  // THE RIG'S DIAL BLOCK CARRIES TWO KINDS OF DIAL AND ONLY ONE OF THEM MAY
  // REACH THE CLOUD HARNESS. Every DIAL on `CloudVolumetrics` is
  // `cloud*`-prefixed, and `__cloudProbe.configure` THROWS — naming the key —
  // on anything that is not a property of the class, so handing it the rig's
  // globe dials (`globeBaseColor`, `globeEnableLighting`,
  // `globeShowWaterEffect`, `removeImageryLayers`) ends the run before the
  // first arm. That is exactly what the first draft did (Reginard R-1). The
  // prefix is the boundary; the harness is the backstop for a `cloud*` key
  // that is not a real property.
  //
  // THE PREFIX IS NOT THE CLASS'S WHOLE SURFACE, and the first draft's comment
  // said it was. `CloudVolumetrics` has 55 own properties and TWO of them are
  // unprefixed — `enabled` (`CloudVolumetrics.js:51`) and `weatherProvider`
  // (`:300`). The split still holds because neither is a rig dial and an
  // unrecognised globe key is reported rather than applied; but the false half
  // of that belief is what put the master gate into the baseline snapshot
  // below, so it is corrected here rather than left to be re-derived
  // (Sigismond R4's fourth item).
  const cloudDials = {};
  const globeDials = {};
  for (const [key, value] of Object.entries(config.dials ?? {})) {
    if (key.startsWith("cloud")) {
      cloudDials[key] = value;
    } else {
      globeDials[key] = value;
    }
  }

  // The globe half, applied here, and every key accounted for: a dial this
  // function does not recognise is REPORTED rather than dropped, because a
  // silently ignored dial is how a capture gets taken under a treatment nobody
  // asked for.
  const unappliedGlobeDials = [];
  let imageryLayersRemoved = 0;
  for (const [key, value] of Object.entries(globeDials)) {
    if (key === "globeBaseColor") {
      if (value !== null && value !== undefined) {
        scene.globe.baseColor = Cesium.Color.fromCssColorString(value);
      }
    } else if (key === "globeEnableLighting") {
      scene.globe.enableLighting = value;
    } else if (key === "globeShowWaterEffect") {
      scene.globe.showWaterEffect = value;
    } else if (key === "removeImageryLayers") {
      if (value === true) {
        imageryLayersRemoved = scene.imageryLayers.length;
        scene.imageryLayers.removeAll(false);
      }
    } else {
      unappliedGlobeDials.push(key);
    }
  }

  const truth = root.__cloudProbe.configure({
    requireWebGPU: true,
    enableVolumetric: true,
    volumetric: cloudDials,
  });

  // THE CLOUD BASELINE IS THE WHOLE DIAL BLOCK, NOT THE RIG'S KEYS. Re-asserting
  // only what the rig states leaves a dial no rig mentions — `cloudQuality`,
  // which arm M4 drives — set to whatever the last arm left, so every arm after
  // M4 would render at its raw escape-hatch step count. The snapshot is taken
  // over every scalar `cloud*` property the live `CloudVolumetrics` carries, so
  // a future arm cannot introduce an unrestored dial by touching a key nobody
  // listed. Object-valued properties are deliberately outside it: none of them
  // is reachable from an arm, and `coveredCloudKeys` says which keys are in.
  //
  // THE `cloud` PREFIX IS THE SNAPSHOT BOUNDARY AS WELL AS THE RIG-DIAL ONE,
  // and the two properties it excludes are the reason. `CloudVolumetrics` has
  // 55 own properties and exactly two carry no prefix (measured against the
  // real class, `CloudVolumetrics.js:51` and `:300`):
  //
  //   * `enabled` IS NOT A DIAL, IT IS THE MASTER GATE, and `configure` drives
  //     it through `enableVolumetric` in the SAME call. `CloudCollection`'s
  //     setter WRITES `volumetric.enabled` (`CloudCollection.js:292-305`) and
  //     `configure` assigns the requested properties FIRST, the gate AFTER,
  //     then round-trip-checks every requested key — so a snapshot carrying
  //     `enabled: true` handed back with `enableVolumetric: false` reports
  //     "enabled round trip failed: expected true, received false" and THROWS.
  //     Every clouds-OFF control frame would have ended the run at arm 1, one
  //     PNG banked and no progress file (Reginard R2-1, Sigismond R4).
  //   * `weatherProvider` is a resource handle no arm drives, and on a fresh
  //     instance it is `undefined` — so it rode this snapshot across two
  //     `page.evaluate` boundaries for nothing (Sigismond F-4).
  //
  // The first draft's comment claimed the whole public surface was prefixed.
  // It is not, and believing it is what let a master gate into a dial
  // snapshot. What is excluded is REPORTED rather than dropped, because the
  // next property that stops being a dial should be visible in the receipt.
  const collection = scene.globe.defaultCloudCollection;
  const liveVolumetric = collection.volumetric;
  const cloudSnapshot = {};
  const uncoveredCloudKeys = [];
  for (const key of Object.keys(liveVolumetric)) {
    const value = liveVolumetric[key];
    if (
      value !== null &&
      (typeof value === "object" || typeof value === "function")
    ) {
      continue;
    }
    if (!key.startsWith("cloud")) {
      uncoveredCloudKeys.push(key);
      continue;
    }
    cloudSnapshot[key] = value;
  }

  // The terrain provider cannot cross `page.evaluate`'s serialisation boundary,
  // so the baseline for it is a page global rather than a field on the returned
  // object. Everything else is a number, a boolean, a string or null.
  root.__mechanismBaselineTerrain = scene.globe.terrainProvider;
  const baseline = {
    cloudSnapshot,
    coveredCloudKeys: Object.keys(cloudSnapshot),
    uncoveredCloudKeys,
    near: scene.camera.frustum.near,
    far: scene.camera.frustum.far,
    globeShow: scene.globe.show,
    msaaSamples: scene.msaaSamples ?? null,
    maximumScreenSpaceError: scene.globe.maximumScreenSpaceError ?? null,
    // THE FORK'S GOD-RAY FLAGS ARE ON THE SCENE, NOT ON THE STAGE COLLECTION.
    // `scene.postProcessStages` is upstream's `PostProcessStageCollection`
    // (`Scene.js:1214`) and has no `godRays` member — `git grep godRays` over
    // `packages/engine/Source` returns nothing at all. The enable is the scene
    // expando `scene.godRayEnabled`, read once per frame into the cache
    // (`WebGPUPostProcessStageCollection.ts:456-457`), and the cloud-aware
    // coupling this arm is NAMED after is a second expando,
    // `scene.godRayCloudAware` (`WebGPUSceneRendererPostFrustumChain.ts:213-219`,
    // declared on `CesiumScene` in `cesium-js-types.d.ts:1175`). Both are what
    // this repository's own `lib/c13-42-reproduction-harness.mjs` drives
    // (`:2640`). Reading the collection returned `null` and the guarded write
    // was a silent no-op, so M7 banked an M0 frame under M7's label
    // (Reginard R2-2, Sigismond R5).
    godRays: scene.godRayEnabled === true,
    godRayCloudAware: scene.godRayCloudAware === true,
    terrainProvider: scene.globe.terrainProvider?.constructor?.name ?? null,
  };

  return {
    ok: truth?.ok === true && unappliedGlobeDials.length === 0,
    renderLoopDisabled: viewer.useDefaultRenderLoop === false,
    truth,
    cloudDials,
    globeDials,
    unappliedGlobeDials,
    imageryLayersRemoved,
    baseline,
    defaultFrustum: { near: baseline.near, far: baseline.far },
    logarithmicDepthBuffer: scene.logarithmicDepthBuffer ?? null,
  };
}

/**
 * Run one arm: restore the baseline, apply this arm's one dial, settle, and
 * read out everything the report needs live off the scene.
 *
 * @param {object} config `{camera, baseline, cloudDials, dial, settleFrames,
 *   cloudsOn}`. `cloudsOn: false` renders the arm's own clouds-OFF control
 *   frame — the same scene with `enableVolumetric` moved and nothing else.
 * @returns {Promise<object>} The arm's measurement block.
 */
export async function pageRunArm(config) {
  // __mechanismRunArm
  const root = globalThis;
  const viewer = root.viewer;
  const scene = viewer.scene;
  const Cesium = root.Cesium;
  const camera = config.camera;
  const baseline = config.baseline;
  const dial = config.dial ?? {};
  const cloudsOn = config.cloudsOn !== false;

  const setCamera = () =>
    scene.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(
        camera.lon,
        camera.lat,
        camera.height,
      ),
      orientation: {
        heading: camera.heading,
        pitch: camera.pitch,
        roll: camera.roll,
      },
    });

  // ---- restore the baseline, so this arm's dial is the only one off it ----
  // One page runs every arm. Without this block M1's hidden globe, M3's
  // ellipsoid provider and screen-space error, M4's raw quality and M7's god
  // rays all persist into every arm that follows them.
  scene.globe.show = baseline.globeShow;
  if (baseline.msaaSamples !== null) {
    scene.msaaSamples = baseline.msaaSamples;
  }
  if (baseline.maximumScreenSpaceError !== null) {
    scene.globe.maximumScreenSpaceError = baseline.maximumScreenSpaceError;
  }
  const baselineTerrain = root.__mechanismBaselineTerrain;
  if (
    baselineTerrain !== undefined &&
    scene.globe.terrainProvider !== baselineTerrain
  ) {
    scene.globe.terrainProvider = baselineTerrain;
  }
  scene.godRayEnabled = baseline.godRays === true;
  scene.godRayCloudAware = baseline.godRayCloudAware === true;
  scene.camera.frustum.near = baseline.near;
  scene.camera.frustum.far = baseline.far;
  // Re-asserting the whole cloud snapshot is what undoes M4's raw
  // `cloudQuality` — a dial no rig states, so restoring only the rig's keys
  // would leave it set. `configure` throws on a refusal, naming the key; the
  // explicit `ok` check is defence in depth against a harness that one day
  // returns the refusal instead of throwing it, because a silently refused dial
  // is how an arm gets banked without having run.
  const restored = root.__cloudProbe.configure({
    requireWebGPU: true,
    enableVolumetric: cloudsOn,
    volumetric: baseline?.cloudSnapshot ?? config.cloudDials ?? {},
  });
  if (restored?.ok !== true) {
    throw new Error(
      `baseline dials refused: ${JSON.stringify(restored?.errors ?? restored)}`,
    );
  }

  // ---- the one dial -------------------------------------------------------
  // EVERY DIAL REPORTS WHETHER IT TOOK, AND THE READBACK IS OFF THE SCENE.
  // A dial that writes a property the engine does not have is the defect class
  // that produced R2-2 / R5: the write lands on an expando nobody reads, the
  // arm renders the arm before it, and the summary table prints the REQUEST as
  // though it were the treatment. `applied` is a comparison against what the
  // scene reads back afterwards, never an echo of the request, and the probe
  // refuses to bank an arm any of whose dials reports `applied: false`.
  const dialReports = [];
  const reportDial = (name, requested, read) => {
    let observed = null;
    let reason = null;
    try {
      observed = read();
    } catch (error) {
      reason = String((error && error.message) || error);
    }
    const applied = reason === null && Object.is(observed, requested);
    if (reason === null && !applied) {
      reason = `wrote ${JSON.stringify(requested)}, read back ${JSON.stringify(observed)}`;
    }
    dialReports.push({ dial: name, requested, observed, applied, reason });
  };

  if (dial.globeShow !== undefined) {
    scene.globe.show = dial.globeShow;
    reportDial("globeShow", dial.globeShow, () => scene.globe.show);
  }
  if (dial.msaaSamples !== undefined) {
    scene.msaaSamples = dial.msaaSamples;
    reportDial("msaaSamples", dial.msaaSamples, () => scene.msaaSamples);
  }
  if (dial.maximumScreenSpaceError !== undefined) {
    scene.globe.maximumScreenSpaceError = dial.maximumScreenSpaceError;
    reportDial(
      "maximumScreenSpaceError",
      dial.maximumScreenSpaceError,
      () => scene.globe.maximumScreenSpaceError,
    );
  }
  if (dial.ellipsoidTerrain === true) {
    // The readback is IDENTITY, not the constructor's name: a `Globe` that
    // ignored the assignment, or replaced it with something of its own, is
    // what this row has to catch, and the class name is the same string
    // whether or not the write landed.
    const ellipsoidProvider = new Cesium.EllipsoidTerrainProvider();
    scene.globe.terrainProvider = ellipsoidProvider;
    reportDial(
      "ellipsoidTerrain",
      true,
      () => scene.globe.terrainProvider === ellipsoidProvider,
    );
  }
  if (dial.volumetric !== undefined) {
    const applied = root.__cloudProbe.configure({
      requireWebGPU: true,
      enableVolumetric: cloudsOn,
      volumetric: dial.volumetric,
    });
    if (applied?.ok !== true) {
      throw new Error(
        `arm dial refused: ${JSON.stringify(applied?.errors ?? applied)}`,
      );
    }
    // `configure` has already round-trip-checked every requested key against
    // the live `CloudVolumetrics` and thrown if one did not take, so this row
    // records WHICH key each arm moved rather than re-deriving the check.
    for (const [key, value] of Object.entries(dial.volumetric)) {
      reportDial(
        `volumetric.${key}`,
        value,
        () => scene.globe.defaultCloudCollection.volumetric[key],
      );
    }
  }
  if (dial.godRays !== undefined) {
    // The two real flags, driven together: the arm is named "cloud-aware god
    // rays" and the cloud mask is only requested when BOTH the effect is
    // enabled and `scene.godRayCloudAware` is set
    // (`WebGPUSceneRendererPostFrustumChain.ts:213-219`). Driving the enable
    // alone would bank a god-ray frame that never asked the cloud pass for a
    // transmittance mask — a different picture from the one M7 is named after.
    scene.godRayEnabled = dial.godRays === true;
    scene.godRayCloudAware = dial.godRays === true;
    reportDial("godRayEnabled", dial.godRays === true, () => {
      return scene.godRayEnabled === true;
    });
    reportDial("godRayCloudAware", dial.godRays === true, () => {
      return scene.godRayCloudAware === true;
    });
  }

  setCamera();
  // The far multiplier is applied AFTER setView and against the RESTORED
  // baseline, never against the frustum the previous row left behind. Taken
  // against the live value the multipliers compound: [1, 0.25, 4, 16] realises
  // F, 0.25F, F, 16F and the row labelled x4 measures the reference frustum. It
  // is applied after `setView` because that is where the arm's camera is set,
  // and `Camera.setView` does not touch `frustum.near`/`far` at all in 3D
  // (`Camera.js:746`) — the first draft's comment claimed it re-derived them.
  if (dial.farMultiplier !== undefined && dial.farMultiplier !== 1) {
    scene.camera.frustum.far = baseline.far * dial.farMultiplier;
  }
  if (dial.farMultiplier !== undefined) {
    reportDial(
      "farMultiplier",
      baseline.far * dial.farMultiplier,
      () => scene.camera.frustum.far,
    );
  }

  // ---- settle -------------------------------------------------------------
  const firstFrameStart = performance.now();
  let firstCloudFrameMs = null;
  for (let frame = 0; frame < config.settleFrames; frame++) {
    scene.render();
    if (firstCloudFrameMs === null) {
      const settling = scene.context?._cloudCache?.observability;
      if ((settling?.marchPixels ?? 0) > 0) {
        firstCloudFrameMs = performance.now() - firstFrameStart;
      }
    }
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }

  // ---- read everything the report needs, live ----------------------------
  // THE CACHE PUBLISHES `observability`, AND NOTHING PUBLISHES `counters`.
  // `CloudCache.observability` is a `CloudFrameCounters`
  // (`WebGPUProceduralCloudRenderer.ts:802`, reset in place at the top of every
  // execute so a culled frame reports zeros rather than the last drawn frame);
  // `counters` is the per-attempt local that gets assigned INTO it at `:3283`.
  // Reading the local's name off the cache returned `undefined`, so every
  // number in the realization block below — `primarySteps` among them, which
  // is the one figure M4's whole arm is read on — came back null on a leg that
  // had rendered, and so did the first-cloud-frame latency above and all five
  // weather counters (Reginard R2-3).
  const cache = scene.context?._cloudCache;
  const counters = cache?.observability;
  const uniforms = cache?.uniformData;
  const debugSnapshot =
    typeof scene.getDebugSnapshot === "function"
      ? scene.getDebugSnapshot()
      : null;
  const observability = debugSnapshot?.cloud ?? debugSnapshot?.clouds ?? null;

  return {
    cloudsOn,
    // PER-DIAL APPLICATION, READ BACK OFF THE SCENE. `dialsApplied` false is a
    // refusal, not a footnote: the caller declines to bank the arm's capture,
    // because a picture labelled with a treatment that did not take is worse
    // than no picture at all.
    dialReports,
    dialsApplied: dialReports.every((entry) => entry.applied === true),
    unappliedDials: dialReports
      .filter((entry) => entry.applied !== true)
      .map((entry) => `${entry.dial}: ${entry.reason ?? "did not apply"}`),
    // What the restore actually put back, per arm, so a confounded arm is
    // visible in the receipt rather than inferred from the arm's label.
    restoredToBaseline: {
      globeShow: baseline.globeShow,
      near: baseline.near,
      far: baseline.far,
      maximumScreenSpaceError: baseline.maximumScreenSpaceError,
      msaaSamples: baseline.msaaSamples,
      terrainProvider: baseline.terrainProvider,
      godRays: baseline.godRays,
      godRayCloudAware: baseline.godRayCloudAware,
    },
    frustum: {
      near: scene.camera.frustum.near,
      far: scene.camera.frustum.far,
      logarithmicDepthBuffer: scene.logarithmicDepthBuffer ?? null,
      frustumCommandsListLength:
        scene._view?.frustumCommandsList?.length ?? null,
    },
    // Slots 105 and 106 are the near/far the cloud pass itself packs. Reading
    // them beside the camera's own frustum is what turns the model's one free
    // parameter into a readout: if the two disagree, the sweep's arithmetic is
    // being done against a frustum the shader never saw.
    cloudPlanes: {
      nearPlane: uniforms?.[105] ?? null,
      farPlane: uniforms?.[106] ?? null,
    },
    depthTexture: {
      format:
        scene.context?._depthStencilTextureFormat ??
        scene.context?._sceneFramebuffer?.depthStencilTexture?.format ??
        null,
      msaaSamples: scene.msaaSamples ?? null,
    },
    globe: {
      show: scene.globe.show,
      terrainProvider: scene.globe.terrainProvider?.constructor?.name ?? null,
      maximumScreenSpaceError: scene.globe.maximumScreenSpaceError ?? null,
      baseColor: scene.globe.baseColor?.toCssColorString?.() ?? null,
    },
    realization: {
      enableVolumetric: restored?.enableVolumetric ?? null,
      cachePresent: !!cache,
      initialized: cache?.initialized === true,
      pipelineReady: cache?.pipeline !== null && cache?.pipeline !== undefined,
      frameCounter: cache?.frameCounter ?? 0,
      // TWO INDEPENDENT READS OF THE SAME THREE NUMBERS, AND THE UNIFORM IS
      // FIRST. Slots 44 / 45 / 74 are what the pass PACKED this frame
      // (`WebGPUProceduralCloudRenderer.ts:3576`, `:3577`, `:3659`) and are
      // what the tracked `lib/cloud-probe-harness.mjs` reads (`:85-87`);
      // `observability.maxSteps` / `.lightSteps` are what the CPU side
      // RESOLVED. They should agree, and a row where they do not is itself the
      // finding — so both are banked rather than one being inferred from the
      // other. `qualityFlags` has no cache field at all: slot 74 is the only
      // place it exists outside the preset module.
      primarySteps: uniforms?.[44] ?? counters?.maxSteps ?? null,
      lightSteps: uniforms?.[45] ?? counters?.lightSteps ?? null,
      qualityFlags: uniforms?.[74] ?? null,
      resolvedPrimarySteps: counters?.maxSteps ?? null,
      resolvedLightSteps: counters?.lightSteps ?? null,
      weatherTexture: cache?.weatherTexture
        ? {
            width: cache.weatherTexture.width,
            height: cache.weatherTexture.height,
            format: cache.weatherTexture.format,
          }
        : null,
      halfWidth: counters?.marchWidth ?? null,
      halfHeight: counters?.marchHeight ?? null,
      halfResActive: counters?.halfResActive === 1,
      marchPixels: counters?.marchPixels ?? null,
      primarySampleBudget: counters?.primarySampleBudget ?? null,
      lightSampleBudget: counters?.lightSampleBudget ?? null,
    },
    // REQUESTED VERSUS REALISED, because the effect initialises LAZILY inside
    // the post-process pipeline: `updatePostProcessCache` reads
    // `scene.godRayEnabled` into `cache.godRayEnabled`
    // (`WebGPUPostProcessStageCollection.ts:456-457`) and only then does
    // `pipeline.addGodRay(...)` run (`:1016`). So a frame whose request never
    // reached a live effect banked a picture of the arm before it, and the two
    // have to be reported apart. The readback path is the one this
    // repository's own `lib/c13-42-reproduction-harness.mjs` uses (`:988`,
    // `:1503`, `:2651`).
    godRay: {
      requested: scene.godRayEnabled === true,
      cloudAware: scene.godRayCloudAware === true,
      realized:
        scene._alternateSceneRenderer?.postProcessPipeline?.godRayEffect
          ?.enabled ?? null,
      effectPresent:
        !!scene._alternateSceneRenderer?.postProcessPipeline?.godRayEffect,
    },
    // These five discharge the widened-weather-resource row's own measurement
    // for free, on a leg that is at this camera anyway.
    weatherObservability: {
      source: observability
        ? "debug-snapshot"
        : counters
          ? "cache-observability"
          : null,
      uploads:
        observability?.weather?.uploads ?? counters?.weatherUploads ?? null,
      uploadBytes:
        observability?.weather?.uploadBytes ??
        counters?.weatherUploadBytes ??
        null,
      cacheHits:
        observability?.weather?.cacheHits ?? counters?.weatherCacheHits ?? null,
      cacheMisses:
        observability?.weather?.cacheMisses ??
        counters?.weatherCacheMisses ??
        null,
      liveBytes:
        observability?.weather?.liveBytes ?? counters?.weatherLiveBytes ?? null,
    },
    timing: {
      firstCloudFrameMs,
      settleFrames: config.settleFrames,
    },
  };
}
