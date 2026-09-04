// gpucull-blackframe-isolation-gate.mjs — the arm table and pass/fail/
// structural verdict for probe-gpucull-blackframe-isolation.mjs, split out
// so a Node spec can pin both without launching Edge.
//
// @purpose Q-20/Q-48 arm table (with each arm's expected translucent GPU-cull dispatch) and the exit-code verdict the isolation probe reports, importable without a browser.
// @status ACTIVE
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THE COMMANDS THIS SCENE BUILDS ARE TRANSLUCENT, NOT OPAQUE
// ─────────────────────────────────────────────────────────────────────────────
// The probe's scene is `C.BoxGeometry` + `C.PerInstanceColorAppearance({flat:
// true})`. `PerInstanceColorAppearance`'s own `translucent` option defaults to
// `true` (`Scene/PerInstanceColorAppearance.js`), and `Primitive` sorts a
// command into `Pass.TRANSLUCENT` purely from `appearance.isTranslucent()` —
// not from the actual alpha channel of the instance color. The scene this file
// builds therefore has ZERO opaque commands at any `n`, and
// `WebGPUSceneRenderer#getHighDensityCullStats().gpuCullerOpaque` reads 0 for
// every arm by construction. The subject this probe exists to isolate —
// `_maybeGPUCullTranslucent`, gated by `scene.gpuCullingHint` and the
// translucent command count — lives entirely in `gpuCullerTranslucent`.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHERE THE THRESHOLD COMES FROM, AND HOW EACH ARM'S EXPECTATION IS DERIVED
// ─────────────────────────────────────────────────────────────────────────────
// `_maybeGPUCullTranslucent` (`WebGPUSceneRenderer.ts`) short-circuits on
// `config.picking`, `count <= 0`, and — the one that matters for `auto` — a
// hint other than `"always"`: "Reachable only through the explicit `always`
// force mode; `auto` remains opaque-only characterization" (the method's own
// doc comment). Past that gate, `_updateActivationGate(prevActive, count, hi,
// lo)` returns `count >= hi` when the gate is not yet active — true from the
// very first frame a fresh page renders, since every per-frustum gate map
// starts empty. `GPU_CULL_THRESHOLD_HI`/`_LO` are mirrored below as plain
// values so this module carries no import of the (heavy, WebGPU-only)
// `WebGPUSceneRenderer.ts`; the arm-expectations spec cross-checks these
// mirrors against the real static class fields on every run; a threshold
// change there without an update here fails that check, not this one.
//
// IMPORTANT: `count` above is the per-frustum TRANSLUCENT COMMAND COUNT AFTER
// CPU FRUSTUM CULLING (`WebGPUSceneRendererTranslucentPass.ts`,
// `frustumCommands.indices[Pass.TRANSLUCENT]`), not `n`, the raw primitive
// count each arm's scene builds. At this probe's fixed 640x480 viewport and
// camera the vertical half-FOV is ~23.4 degrees, which puts roughly the
// bottom two and top one of the box grid's 20 latitude rows outside the
// frustum — the banked pre-render-pass-bracket run
// (`output/edge-executor-2026-08-28-t2/`, quoted in the probe file header)
// recorded `n256/n320/n384-always` clean (0 validation errors over 200
// frames) and `n448/n600-always` black with a locked-encoder validation
// error, and the render-pass bracket that turns a fired dispatch into that
// error landed only in Batch 1375 (`git log -S
// "this._resumeScenePass(wgpuCtx)"`) — AFTER that run. So at n=384 the
// post-cull count was demonstrably below 384: an exact `n === HI` arm cannot
// be trusted to cross the post-cull threshold. `expectDispatch` therefore
// requires a strict margin (`n > GPU_CULL_THRESHOLD_HI`, not `>=`) so a
// boundary arm whose culled count lands just under the threshold does not
// produce a STRUCTURAL false refusal on a healthy build.
// `n600-auto-recheck` never reaches the gate at all — `hint: "auto"` returns
// before the threshold check runs, at any n.
//
// This margin is deliberately conservative and probe-scene-specific (it does
// not attempt to model the exact culled fraction at every n); the Node-only
// arm-expectations spec cannot simulate real frustum culling either, so it
// pins the engine's raw `count >= hi` boundary decision as a separate claim
// from this margin-adjusted, real-scene `expectDispatch` prediction — see
// that spec's own comment for why the two are not the same claim, and why
// only a live Edge leg settles the boundary arm for certain (recording
// `translucentCommandsSeen`, which the probe already does, is what makes
// that leg a measurement rather than a re-derivation).
export const GPU_CULL_THRESHOLD_HI = 384;
export const GPU_CULL_THRESHOLD_LO = 192;

/**
 * @typedef {object} IsolationArm
 * @property {string} name
 * @property {number} n Command count the arm's scene builds (all translucent
 *   — see the header above).
 * @property {"auto"|"always"|"never"} hint `scene.gpuCullingHint` for the arm.
 * @property {boolean} hiz Whether the arm also enables Hi-Z consumption.
 * @property {boolean} expectDispatch Whether the REAL, frustum-culled
 *   Edge probe is expected to observe at least one translucent GPU-cull
 *   dispatch for this arm — `hint === "always"` AND a strict margin above
 *   `GPU_CULL_THRESHOLD_HI` (`n > HI`, not `n >= HI`; see the module header
 *   for why an exact boundary count cannot be trusted post-frustum-cull).
 */

/** @type {ReadonlyArray<Readonly<IsolationArm>>} */
export const ARMS = Object.freeze(
  [
    { name: "n256-always", n: 256, hint: "always", hiz: false },
    { name: "n320-always", n: 320, hint: "always", hiz: false },
    // n384 === GPU_CULL_THRESHOLD_HI exactly: the banked pre-bracket run
    // (module header above) recorded this arm clean with zero validation
    // errors, which is only possible if the post-frustum-cull count never
    // reached the threshold — so this boundary arm does NOT get
    // expectDispatch:true merely for equalling HI.
    { name: "n384-always", n: 384, hint: "always", hiz: false },
    { name: "n448-always", n: 448, hint: "always", hiz: false },
    // Restored (Q-153's sibling row): the header's own before-numbers name
    // this arm as one of the two that historically blanked, but the arm list
    // had dropped it — see the file's Repatriated comment for the provenance.
    { name: "n600-always", n: 600, hint: "always", hiz: false },
    { name: "n600-auto-recheck", n: 600, hint: "auto", hiz: false },
  ].map((arm) =>
    Object.freeze({
      ...arm,
      expectDispatch: arm.hint === "always" && arm.n > GPU_CULL_THRESHOLD_HI,
    }),
  ),
);

/**
 * @typedef {object} IsolationVerdict
 * @property {0|1|2|3} exitCode Fleet contract: 0 PASS / 1 FAIL / 2 HARNESS
 *   FAULT / 3 STRUCTURAL refusal.
 * @property {"PASS"|"FAIL"|"HARNESS FAULT"|"STRUCTURAL"} verdict
 * @property {string[]} reasons Empty only when `exitCode === 0`.
 */

// The frozen verdict-to-exit-code table `judgeIsolationResults` resolves
// against, so no verdict object below carries a bare numeric `exitCode`
// literal alongside its `verdict` field — `probe-fleet-contract.spec.mjs`'s
// exit-semantics contract (`gateVerdictExitBindingViolations`) flags exactly
// that shape, with no allowlist. `HARNESS FAULT`, not `ERROR`, is this
// module's own verdict string (see `IsolationVerdict` above), so this stays
// a local table rather than importing the differently-worded
// `lib/verdict-exit-gate.mjs` one.
const ISOLATION_VERDICT_EXIT_CODE = Object.freeze({
  PASS: 0,
  FAIL: 1,
  "HARNESS FAULT": 2,
  STRUCTURAL: 3,
});

/**
 * Exit code for one of this module's verdict strings.
 *
 * @param {string} verdict One of `PASS`/`FAIL`/`HARNESS FAULT`/`STRUCTURAL`.
 * @returns {0|1|2|3} The verdict's exit code; falls back to the
 *   `HARNESS FAULT` code for a verdict string this table does not
 *   recognize, since an unreadable verdict is itself a harness-trust
 *   problem, not a silent pass.
 */
function exitCodeForIsolationVerdict(verdict) {
  return Object.hasOwn(ISOLATION_VERDICT_EXIT_CODE, verdict)
    ? ISOLATION_VERDICT_EXIT_CODE[verdict]
    : ISOLATION_VERDICT_EXIT_CODE["HARNESS FAULT"];
}

/**
 * Judges one run's per-arm results against the arm table above. A result
 * missing entirely from `ARMS` (a name typo, a renamed arm) is itself a
 * harness fault — the loop below cannot judge an arm it cannot find.
 *
 * Priority, matching the fleet's documented "FAIL outranks STRUCTURAL":
 * any harness-level per-arm error outranks everything (the run itself is
 * untrustworthy); a genuine black-frame/validation regression outranks a
 * missing-dispatch refusal (a real product regression is more actionable
 * than "the probe could not confirm its own coverage"); only when neither
 * fires does a should-have-dispatched arm reporting zero refuse the run.
 *
 * @param {Array<object>} results One entry per arm, as
 *   `probe-gpucull-blackframe-isolation.mjs` writes to `isolation-round2.json`.
 * @returns {IsolationVerdict}
 */
export function judgeIsolationResults(results) {
  const armByName = new Map(ARMS.map((arm) => [arm.name, arm]));
  const harnessReasons = [];
  const failReasons = [];
  const structuralReasons = [];

  for (const result of results ?? []) {
    const arm = armByName.get(result?.name);
    if (!arm) {
      harnessReasons.push(
        `${String(result?.name)}: no matching entry in the ARMS table — the ` +
          "run and the gate have drifted apart",
      );
      continue;
    }
    if (result.error) {
      harnessReasons.push(`${arm.name}: harness error - ${result.error}`);
      continue;
    }

    const nonBlackPct = result.nonBlackPct ?? null;
    const validationErrorCount = result.validationErrorCount ?? 0;
    if (validationErrorCount > 0 || nonBlackPct === 0) {
      failReasons.push(
        `${arm.name}: black-frame regression (nonBlack=${nonBlackPct}%, ` +
          `validationErrs=${validationErrorCount})`,
      );
    }

    if (arm.expectDispatch) {
      const cullDispatches = result.stats?.cullDispatches ?? 0;
      if (!(cullDispatches > 0)) {
        // Named in terms of the MEASURED post-frustum-cull translucent
        // command count the probe already records
        // (`stats.translucentCommandsSeen`), not just the arm's raw `n` —
        // `n` is what the scene builds, not what the engine's threshold
        // check reads (see the gate module's header).
        const translucentCommandsSeen =
          result.stats?.translucentCommandsSeen ?? null;
        structuralReasons.push(
          `${arm.name}: expected the translucent GPU-cull dispatch to fire ` +
            `(measured translucentCommandsSeen=${translucentCommandsSeen}, ` +
            `arm n=${arm.n}, GPU_CULL_THRESHOLD_HI=${GPU_CULL_THRESHOLD_HI}, ` +
            `hint="${arm.hint}") but cullDispatches=${cullDispatches} — the ` +
            "probe never reached the subject it exists to isolate",
        );
      }
    }
  }

  if (harnessReasons.length > 0) {
    return {
      exitCode: exitCodeForIsolationVerdict("HARNESS FAULT"),
      verdict: "HARNESS FAULT",
      reasons: harnessReasons,
    };
  }
  if (failReasons.length > 0) {
    return {
      exitCode: exitCodeForIsolationVerdict("FAIL"),
      verdict: "FAIL",
      reasons: failReasons,
    };
  }
  if (structuralReasons.length > 0) {
    return {
      exitCode: exitCodeForIsolationVerdict("STRUCTURAL"),
      verdict: "STRUCTURAL",
      reasons: structuralReasons,
    };
  }
  return {
    exitCode: exitCodeForIsolationVerdict("PASS"),
    verdict: "PASS",
    reasons: [],
  };
}
