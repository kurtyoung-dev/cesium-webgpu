// capture-descriptor.mjs — the capture's whole plan before a browser exists, and the refusals it can decide.
//
// @purpose Descriptor piece of capture.mjs: buildCaptureDescriptor (rigs and origins to cells, deadlines, paths and the lifecycle budget), deriveCaptureDeadline and decideCaptureRefusal (every refusal a capture can decide, composed from the runtime's deciders), all pure.
// @status ACTIVE
//
// WHY A PIECE. The descriptor and its refusals moved out of `capture.mjs` when
// that module passed 1,000 lines (DX-KIT-CAPTURE-SEAM-OVER-SIZE).
// `capture.mjs` re-exports every name, so importers are unchanged.

import path from "node:path";

import {
  HARD_STOP_GRACE_MS,
  LAUNCH_BUDGET_MS,
  MAX_TIMER_DELAY_MS,
  PREFLIGHT_BUDGET_MS,
  RESOURCE_CLOSE_DEADLINE_MS,
  RUN_SETTLEMENT_MARGIN_MS,
} from "./probe-lifecycle-run.mjs";
import {
  ProbeRefusal,
  acceptedDecision,
  refusedDecision,
} from "./probe-refusal.mjs";
import {
  REQUIRED_SERVED_ARTIFACTS,
  decideOriginRefusal,
  decideRenderReadyRefusal,
  decideServedBuildRefusal,
} from "./probe-runtime.mjs";
import { replayKeyFor, validateRig } from "./rig-registry.mjs";
import {
  CAPTURE_MANIFEST_SCHEMA_VERSION,
  CAPTURE_RENDERERS,
  CAPTURE_SLOTS,
  CELL_STATES,
  DEFAULT_CELL_BUDGET_MS,
  DEFAULT_CLOSE_DEADLINE_MS,
  DEFAULT_NAVIGATION_TIMEOUT_MS,
  DEFAULT_PAIR_TOLERANCE,
  DEFAULT_READINESS_POLL_INTERVAL_MS,
  DEFAULT_READINESS_TIMEOUT_MS,
  MAX_TIMING_OPTION_MS,
  ORIGIN_REFUSAL_MESSAGE,
  READINESS_PREDICATES,
  SPLIT_SCREEN_PAGE,
  requireTimingMs,
} from "./capture-vocabulary.mjs";
import { defaultCellWork } from "./capture-cell-work.mjs";
import {
  captureUrlFor,
  resolveCaptureOrigins,
  resolveRigPage,
} from "./capture-urls.mjs";

function trackedByFor(rig) {
  const declared = rig?.expectedMismatch;
  if (!Array.isArray(declared)) {
    return null;
  }
  for (const entry of declared) {
    if (typeof entry?.trackedBy === "string" && entry.trackedBy.length > 0) {
      return entry.trackedBy;
    }
  }
  return null;
}

function selectorFor(page, renderer, options) {
  if (page.kind !== "none" && page.path.startsWith(SPLIT_SCREEN_PAGE)) {
    // The tag the readiness step installs on each viewer's canvas, matching
    // what `capture-and-diff.mjs:508-517` already does: the page carries an
    // FPS overlay canvas too, so a bare `canvas` selector is ambiguous there.
    return `canvas[data-vr-tag="${renderer}"]`;
  }
  return options?.selector ?? "canvas";
}

function cellUrlFor(rig, page, renderer, origin) {
  const url = new URL(captureUrlFor({ rig, origin }));
  if (!page.path.startsWith(SPLIT_SCREEN_PAGE)) {
    // A single-viewer page picks its backend from the query the fork's own
    // `ContextFactory` reads; the split-screen page builds both and needs no
    // hint, so it is left exactly as the rig declared it.
    url.searchParams.set("renderer", renderer);
  }
  return url.href;
}

/**
 * Plan every cell and every pair of a run, with no I/O and no browser.
 *
 * @param {object|object[]} rig One rig, or the set of rigs to capture. A set is
 *   what makes a manifest's `rigs` array more than one entry long; the
 *   singular form is the common case and is normalised to a one-element set.
 * @param {{BEFORE: string, AFTER: string}} origins The two origins.
 * @param {object} [options] Options.
 * @param {string} [options.captureId] Slug for the default capture root.
 * @param {string} [options.captureRoot] Repo-relative POSIX capture root.
 * @param {string} [options.repositoryRoot] Absolute repository root.
 * @param {string} [options.selector] Element selector for non-split-screen rigs.
 * @param {number} [options.tolerance] Per-channel diff tolerance.
 * @param {string[]} [options.launchArgs] Edge flags instead of the runtime default.
 * @param {Function} [options.cellWork] The per-cell body; the injection seam.
 * @returns {object} The frozen plan.
 */
export function buildCaptureDescriptor(rig, origins, options = {}) {
  const rigs = Array.isArray(rig) ? [...rig] : [rig];
  if (rigs.length === 0) {
    throw new TypeError("buildCaptureDescriptor requires at least one rig");
  }

  const resolved = resolveCaptureOrigins({ ...options, origins });
  if (resolved.ok !== true) {
    throw new ProbeRefusal(
      resolved.reason,
      ORIGIN_REFUSAL_MESSAGE[resolved.reason],
      resolved.details,
    );
  }

  const violations = rigs.flatMap((one) => validateRig(one));
  if (violations.length > 0) {
    throw new TypeError(
      `buildCaptureDescriptor: ${violations.length} rig violation(s): ${violations.join("; ")}`,
    );
  }

  // EVERY TIMING OPTION, NOT JUST THE ONE THAT HAD A BUG. Before this block
  // only `closeDeadlineMs` was checked, so `readinessTimeoutMs: Infinity`,
  // `: NaN` and `readinessPollIntervalMs: NaN` each reached `pollReadiness`
  // and spun it without bound — the poll loop's own guard is derived from the
  // very numbers that were never validated. They are all refused here, at the
  // descriptor, which is the first thing `capture()` builds and is therefore
  // before the preflight, before the Edge slot and before any browser.
  // The close deadline's own ceiling is the sane maximum LESS the margin its
  // derived grace adds on top of it: a close budget that only just fits would
  // otherwise derive a grace that does not, and refusing the grace for a value
  // the caller never typed is a confusing way to say "your close deadline is
  // too big".
  const hardStopMarginMs = HARD_STOP_GRACE_MS - RESOURCE_CLOSE_DEADLINE_MS;
  const resolvedCloseDeadlineMs = requireTimingMs(
    "closeDeadlineMs",
    options.closeDeadlineMs ?? DEFAULT_CLOSE_DEADLINE_MS,
    MAX_TIMING_OPTION_MS - hardStopMarginMs,
  );
  const resolvedNavigationTimeoutMs = requireTimingMs(
    "navigationTimeoutMs",
    options.navigationTimeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS,
  );
  const resolvedReadinessTimeoutMs = requireTimingMs(
    "readinessTimeoutMs",
    options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS,
  );
  const resolvedReadinessPollIntervalMs = requireTimingMs(
    "readinessPollIntervalMs",
    options.readinessPollIntervalMs ?? DEFAULT_READINESS_POLL_INTERVAL_MS,
  );
  const resolvedCellBudgetMs = requireTimingMs(
    "cellBudgetMs",
    options.cellBudgetMs ?? DEFAULT_CELL_BUDGET_MS,
  );
  const resolvedHardStopGraceMs = requireTimingMs(
    "hardStopGraceMs",
    options.hardStopGraceMs ?? resolvedCloseDeadlineMs + hardStopMarginMs,
  );

  const captureRoot = resolveCaptureRoot(options);
  const repositoryRoot = path.resolve(options.repositoryRoot ?? process.cwd());
  const outputDirectory = path.resolve(
    repositoryRoot,
    ...captureRoot.split("/"),
  );
  const tolerance = options.tolerance ?? DEFAULT_PAIR_TOLERANCE;

  const cells = [];
  const pairs = [];
  const summaries = [];
  const renderers = new Set();

  for (const one of rigs) {
    const page = resolveRigPage(one);
    const rigRenderers = one.renderers.filter((renderer) =>
      CAPTURE_RENDERERS.includes(renderer),
    );
    summaries.push(
      Object.freeze({
        id: one.id,
        replayKey: replayKeyFor(one),
        description: one.description ?? "",
        viewport: Object.freeze({
          width: one.viewport.width,
          height: one.viewport.height,
        }),
        renderers: Object.freeze([...rigRenderers]),
      }),
    );

    for (const renderer of rigRenderers) {
      renderers.add(renderer);
      for (const slot of CAPTURE_SLOTS) {
        const measurable = page.kind !== "none";
        cells.push(
          Object.freeze({
            key: `${one.id}|${renderer}|${slot}`,
            rigId: one.id,
            renderer,
            slot,
            state: measurable ? CELL_STATES.MEASURED : CELL_STATES.UNMEASURED,
            reason: measurable ? null : page.reason,
            trackedBy: measurable ? null : trackedByFor(one),
            origin: resolved.origins[slot],
            declaredOrigin:
              page.kind === "absolute" ? page.declaredOrigin : null,
            url: measurable
              ? cellUrlFor(one, page, renderer, resolved.origins[slot])
              : null,
            pageKind:
              measurable && page.path.startsWith(SPLIT_SCREEN_PAGE)
                ? "split-screen"
                : "single-viewer",
            selector: selectorFor(page, renderer, options),
            viewport: Object.freeze({
              width: one.viewport.width,
              height: one.viewport.height,
            }),
            readiness: one.readiness,
            readinessPredicates: Object.freeze([
              ...(options.readinessPredicates ?? READINESS_PREDICATES),
            ]),
            navigationTimeoutMs: resolvedNavigationTimeoutMs,
            readinessTimeoutMs: resolvedReadinessTimeoutMs,
            readinessPollIntervalMs: resolvedReadinessPollIntervalMs,
            image: measurable ? `${one.id}/${renderer}/${slot}.png` : null,
            captureName: slot,
            outputDirectory: path.join(outputDirectory, one.id, renderer),
            outputPath: path.join(
              outputDirectory,
              one.id,
              renderer,
              `${slot}.png`,
            ),
          }),
        );
      }
      pairs.push(
        Object.freeze({
          key: `${one.id}|${renderer}`,
          rigId: one.id,
          renderer,
          diffImage: `${one.id}/${renderer}/DIFF.png`,
          diffPath: path.join(outputDirectory, one.id, renderer, "DIFF.png"),
          tolerance,
        }),
      );
    }
  }

  const descriptor = {
    schemaVersion: CAPTURE_MANIFEST_SCHEMA_VERSION,
    captureId: options.captureId ?? path.posix.basename(captureRoot),
    captureRoot,
    repositoryRoot,
    outputDirectory,
    origins: resolved.origins,
    slots: Object.freeze([...CAPTURE_SLOTS]),
    renderers: Object.freeze(
      CAPTURE_RENDERERS.filter((renderer) => renderers.has(renderer)),
    ),
    rigs: Object.freeze(summaries),
    cells: Object.freeze(cells),
    pairs: Object.freeze(pairs),
    tolerance,
    launchArgs: options.launchArgs
      ? Object.freeze([...options.launchArgs])
      : null,
    headed: options.headed === true,
    servedBuild: options.servedBuild !== false,
    requiredArtifacts: Object.freeze([
      ...(options.servedArtifacts ?? REQUIRED_SERVED_ARTIFACTS),
    ]),
    cellBudgetMs: resolvedCellBudgetMs,
    // Both budgets are the CAPTURE's, not the fleet's — see
    // `DEFAULT_CLOSE_DEADLINE_MS`. The grace keeps the fleet's own margin
    // (`HARD_STOP_GRACE_MS - RESOURCE_CLOSE_DEADLINE_MS`, the Edge-slot close
    // timeout plus a second) above whatever the close deadline becomes, so a
    // raised close budget cannot silently move the hard stop below it.
    closeDeadlineMs: resolvedCloseDeadlineMs,
    hardStopGraceMs: resolvedHardStopGraceMs,
    incidentName: "capture-incident.json",
    // `cells` is a DESCRIPTOR field, the way `runProbe`'s own `cells` is
    // (`probe-runtime.mjs:836` takes `{argv, now, chromium, preflight, launch,
    // writeFile, repositoryRoot, lifecycle, lifecycleDependencies}` as
    // `dependencies` and reads the cell body off the descriptor). Both seams
    // exist; they are simply in two different places, and this one is here.
    cellWork: options.cellWork ?? defaultCellWork,
    slotOwner:
      options.slotOwner ??
      `capture:${options.captureId ?? path.posix.basename(captureRoot)}`,
    edgeSlotLockPath: path.join(
      repositoryRoot,
      "Tools",
      "visual-regression",
      "output",
      ".edge-slot.lock",
    ),
    manifestName: "capture-manifest.json",
    receiptPath: options.receiptPath ?? "capture-report.json",
  };
  descriptor.deadlineMs = deriveCaptureDeadline(descriptor, options);
  return Object.freeze(descriptor);
}

function resolveCaptureRoot(options) {
  if (
    typeof options.captureRoot === "string" &&
    options.captureRoot.length > 0
  ) {
    return options.captureRoot.split("\\").join("/").replace(/\/+$/, "");
  }
  if (typeof options.captureId === "string" && options.captureId.length > 0) {
    return `Tools/visual-regression/output/capture/${options.captureId}`;
  }
  throw new TypeError(
    "buildCaptureDescriptor requires options.captureId or options.captureRoot; a capture that names itself by accident cannot be banked",
  );
}

/**
 * The whole-run orderly deadline, composed from the parts this module owns.
 *
 * Same shape and the same constants as `deriveLifecycleDeadline`
 * (`probe-lifecycle-run.mjs`), re-composed for this module's run shape: one
 * preflight PER ORIGIN, exactly ONE browser for the whole run, and one work
 * budget per MEASURED cell. `BigInt` so an implausible budget produces a
 * refusable range error rather than a silently saturated timer.
 *
 * @param {object} descriptor A capture descriptor.
 * @param {object} [options] Options; `cellBudgetMs` overrides the descriptor's.
 * @returns {number} The deadline in milliseconds.
 */
export function deriveCaptureDeadline(descriptor, options = {}) {
  const budget = options.cellBudgetMs ?? descriptor.cellBudgetMs;
  if (!Number.isSafeInteger(budget) || budget < 1) {
    throw new TypeError(
      "capture cellBudgetMs must be a positive safe integer of milliseconds",
    );
  }
  const measured = descriptor.cells.filter(
    (cell) => cell.state === CELL_STATES.MEASURED,
  ).length;
  const required =
    BigInt(PREFLIGHT_BUDGET_MS) * BigInt(descriptor.slots.length) +
    BigInt(LAUNCH_BUDGET_MS) +
    BigInt(measured) * BigInt(budget) +
    BigInt(RUN_SETTLEMENT_MARGIN_MS);
  if (required > BigInt(MAX_TIMER_DELAY_MS)) {
    throw new RangeError(
      "capture deadline exceeds the supported timer delay; capture fewer rigs per run",
    );
  }
  return Number(required);
}

// ---------------------------------------------------------------------------
// 5. Refusals — composed from the runtime's deciders, never re-implemented
// ---------------------------------------------------------------------------

/**
 * Every refusal a capture can decide, in the order it can decide them.
 *
 * The served-build, navigated-origin and render-ready questions are answered
 * by `decideServedBuildRefusal`, `decideOriginRefusal` and
 * `decideRenderReadyRefusal` from the runtime — this function composes them and
 * adds only what the runtime has no equivalent for: the required origins, and
 * whether the rig set is well formed. A rig that declares `page: null` is NOT a
 * refusal: it produces UNMEASURED cells and the rest of the run proceeds.
 *
 * @param {object} inputs Inputs.
 * @param {object|object[]} inputs.rig The rig or rig set.
 * @param {{BEFORE?: string, AFTER?: string}} inputs.origins The two origins.
 * @param {object} [inputs.preflight] Preflight results keyed by slot.
 * @param {boolean} [inputs.servedBuild] Whether the served-build assertion is enforced.
 * @param {string[]} [inputs.requiredArtifacts] Artifacts the preflight must have matched.
 * @param {object} [inputs.navigation] `{requestedOrigin, actualUrl, label}` after a navigation.
 * @param {object} [inputs.readiness] `{renderReady, elapsedMs, timeoutMs}` after a settle.
 * @returns {object} An accepted or refusing decision.
 */
export function decideCaptureRefusal({
  rig,
  origins,
  preflight,
  servedBuild = true,
  requiredArtifacts,
  navigation,
  readiness,
}) {
  const resolved = resolveCaptureOrigins({ origins });
  if (resolved.ok !== true) {
    return refusedDecision(resolved.reason, resolved.details);
  }

  const rigs = Array.isArray(rig) ? rig : [rig];
  if (rigs.length === 0) {
    return refusedDecision("capture-rig-absent", { rigs: 0 });
  }
  const violations = rigs.flatMap((one) => validateRig(one));
  if (violations.length > 0) {
    return refusedDecision("capture-rig-invalid", { violations });
  }

  const waived = servedBuild !== true;
  for (const slot of CAPTURE_SLOTS) {
    const decision = decideServedBuildRefusal(
      waived ? null : (preflight?.[slot] ?? null),
      { requiredArtifacts, waived },
    );
    if (decision.refuse === true) {
      return refusedDecision(decision.reason, {
        ...(decision.details ?? {}),
        slot,
        origin: resolved.origins[slot],
      });
    }
    if (waived) {
      break;
    }
  }

  if (navigation) {
    const decision = decideOriginRefusal(navigation);
    if (decision.refuse === true) {
      return decision;
    }
  }
  if (readiness) {
    const decision = decideRenderReadyRefusal(readiness);
    if (decision.refuse === true) {
      return decision;
    }
  }
  return acceptedDecision();
}
