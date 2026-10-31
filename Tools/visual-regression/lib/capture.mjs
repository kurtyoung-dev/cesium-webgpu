// capture.mjs — DX-104, the capture seam: a rig in, a BEFORE/AFTER pair out.
//
// @purpose Captures one or more rigs over BEFORE and AFTER origins on both renderers in a single browser run, emitting the capture manifest, the diff heat-maps, the metric strip and the receipt.
// @status ACTIVE
//
// WHY THIS EXISTS. CLAUDE.md Principle 8 tells every rendering fix to build a
// probe, and names `probe-saved-view.mjs` as the template to copy. That file
// opens with `const BASE = "http://localhost:8080"` (`:16`), so every probe
// copied from it inherits a hard-coded origin, a private browser lifecycle and
// a private diff. `DX-01` already moved the browser lifecycle into
// `probe-runtime.mjs`; this module moves the rest, so "copy the template"
// becomes "declare a rig" and the origin becomes an argument the caller must
// supply. There is no default origin here, at all: an absent origin is the
// refusal `capture-origin-absent`. A default is exactly the thing this row
// exists to stop propagating, and `runProbe` still has one
// (`probe-runtime.mjs:905`, `http://localhost:${options.port}`) — which is why
// this module composes the runtime's PIECES (`launchEdge`, `captureElement`,
// the three deciders, `assembleReceipt`, `withEdgeSlot`) and never calls
// `runProbe` itself.
//
// BEFORE AND AFTER IN ONE RUN. A "before" capture taken on Monday and an
// "after" capture taken on Wednesday differ by the fix, by two driver states,
// by two Bing tile vintages and by whatever else moved in between. The pair is
// only comparable if it is taken in one process, through one browser, against
// two origins that are both up at the same moment — so `origins` is a required
// `{BEFORE, AFTER}` map and both legs of every cell run back to back. Two
// `--serve-built` servers on two ports is the intended deployment.
//
// EVERY MEASUREMENT IS TAKEN IN NODE, AFTER THE BROWSER HAS CLOSED. Principle
// 8 says "canvas-decode diff (no Node PNG dep needed)", which predates
// `Tools/lib/png-decode.mjs`. That decoder exists now, so the browser's only
// job here is to produce PNG bytes; the diff, the heat-map and the metric
// strip are computed from those bytes by pure functions a spec can drive with
// no browser at all.
//
// ONE BROWSER, OWNED BY THE LIFECYCLE. `fleetExemption`
// (`probe-fleet-contract.mjs:1141`) returns LAUNCHER_LIBRARY for every file
// directly under a `lib/`, and `launchesBrowserByBehaviour` (`:1125`) needs
// both a `playwright` import and an `<ident>.launch(` — this file has neither,
// because it delegates to `launchEdge`. So the fleet contract will never
// select it, and the watchdog rule has to hold without a guard enforcing it.
// A `finally` close alone does NOT hold it: it runs on the ordinary path and
// on the throw path, and on neither of the paths the watchdog exists for. So
// the Edge slot is taken through `scope.withEdgeSlot` and the browser through
// `scope.withResource({kind: "browser"})`, which is what puts the browser in
// the list `withProbeLifecycle` closes when the orderly deadline fires and
// proves closed before it reports quiescence. The run is bounded by that
// derived deadline rather than by a private `setTimeout(process.exit)` — a
// library must never call `process.exit`.
//
// THE MANIFEST CARRIES NO VERDICT. A rig may declare `gate`,
// `expectedMismatch` or `thresholds`; none of them reach the manifest, and
// `validateManifest` reports their presence as a violation. That is what makes
// "no pass/fail token on the contact sheet" (`R-2026-09-17-10`) structural
// rather than a promise: the page's only input cannot express a judgement.
// `UNMEASURED` is first-class — it is the word `visual-gate-policy.mjs:106`
// already uses for "never measured in this metric" — and a rig that declares
// `page: null` produces UNMEASURED cells rather than failing the run.

import fs from "node:fs";
import path from "node:path";

import { withEdgeSlot } from "./probe-edge-slot.mjs";
import { withProbeLifecycle } from "./probe-lifecycle.mjs";
import { ProbeRefusal, throwForDecision } from "./probe-refusal.mjs";
import {
  assessLifecycleFailure,
  createCloseRecord,
  describeBrowserCloses,
  onlyLingeringClose,
  recordCloseExpiries,
} from "./probe-close-exemption.mjs";
import {
  PROBE_EXIT_CODES,
  RUN_OUTCOMES,
  assembleReceipt,
  buildIncidentRecord,
  launchEdge,
  normalizeJson,
  sha256,
} from "./probe-runtime.mjs";
import { preflightServedBuildArtifacts } from "./served-build-preflight.mjs";
import { decodePng } from "../../lib/png-decode.mjs";
import { encodeRgbaPng } from "../../lib/png-rgba.mjs";
import {
  CAPTURE_MANIFEST_SCHEMA_VERSION,
  CAPTURE_MANIFEST_KIND,
  CAPTURE_SLOTS,
  CELL_STATES,
  CAPTURE_RENDERERS,
  CELL_METRIC_PROVENANCE,
  NON_BLACK_CHANNEL_THRESHOLD,
  DEFAULT_PAIR_TOLERANCE,
  SPLIT_SCREEN_PAGE,
  FORBIDDEN_MANIFEST_KEYS,
  FORBIDDEN_MANIFEST_VALUES,
  DEFAULT_CELL_BUDGET_MS,
  DEFAULT_NAVIGATION_TIMEOUT_MS,
  DEFAULT_CLOSE_DEADLINE_MS,
  DEFAULT_READINESS_TIMEOUT_MS,
  DEFAULT_READINESS_POLL_INTERVAL_MS,
  MAX_TIMING_OPTION_MS,
  MAX_READINESS_POLLS,
  TIMING_OPTION_REFUSAL,
  READINESS_PREDICATES,
} from "./capture-vocabulary.mjs";
import {
  resolveRigPage,
  captureUrlFor,
  resolveCaptureOrigins,
} from "./capture-urls.mjs";
import {
  buildCaptureDescriptor,
  deriveCaptureDeadline,
  decideCaptureRefusal,
} from "./capture-descriptor.mjs";
import { cellMetrics, pairMetrics } from "./capture-metrics.mjs";
import {
  buildCaptureManifest,
  validateManifest,
  unmeasuredCell,
  unmeasuredPair,
} from "./capture-manifest.mjs";
import { defaultCellWork } from "./capture-cell-work.mjs";
import {
  pollReadiness,
  describeReadiness,
  decideCellReadinessRefusal,
  waitForCellReadiness,
  summariseCellReadiness,
} from "./capture-readiness.mjs";

// Every name this module exported before it was split into the capture-*
// pieces (DX-KIT-CAPTURE-SEAM-OVER-SIZE); the pieces own the code, this file
// keeps the public surface and the run.
export {
  CAPTURE_MANIFEST_SCHEMA_VERSION,
  CAPTURE_MANIFEST_KIND,
  CAPTURE_SLOTS,
  CELL_STATES,
  CAPTURE_RENDERERS,
  CELL_METRIC_PROVENANCE,
  NON_BLACK_CHANNEL_THRESHOLD,
  DEFAULT_PAIR_TOLERANCE,
  SPLIT_SCREEN_PAGE,
  FORBIDDEN_MANIFEST_KEYS,
  FORBIDDEN_MANIFEST_VALUES,
  DEFAULT_CELL_BUDGET_MS,
  DEFAULT_NAVIGATION_TIMEOUT_MS,
  DEFAULT_CLOSE_DEADLINE_MS,
  DEFAULT_READINESS_TIMEOUT_MS,
  DEFAULT_READINESS_POLL_INTERVAL_MS,
  MAX_TIMING_OPTION_MS,
  MAX_READINESS_POLLS,
  TIMING_OPTION_REFUSAL,
  READINESS_PREDICATES,
  resolveRigPage,
  captureUrlFor,
  resolveCaptureOrigins,
  buildCaptureDescriptor,
  deriveCaptureDeadline,
  decideCaptureRefusal,
  cellMetrics,
  pairMetrics,
  buildCaptureManifest,
  validateManifest,
  defaultCellWork,
  pollReadiness,
  describeReadiness,
  decideCellReadinessRefusal,
  waitForCellReadiness,
  summariseCellReadiness,
};

/**
 * The durable record a capture writes when the lifecycle's hard stop is about
 * to end the process.
 *
 * A WATCHDOG THAT KILLS THE PROCESS OWES A DIAGNOSIS. The lifecycle's own
 * hard-stop line says only that quiescence was not reached — the Edge leg of
 * 2026-09-18 hit it and the run exited 2 with nothing else printed, so the
 * cell failure that caused the wedge was unrecoverable from the transcript.
 * This is the capture's half of that message: which phase it was in, which
 * cell, for how long, and what it still had open. It is built through the
 * runtime's own {@link buildIncidentRecord} so a capture incident reads like
 * every other incident this fleet writes.
 *
 * @param {object} options Options.
 * @param {object} options.descriptor The run descriptor.
 * @param {object} options.progress `{phase, cell, startedAt, open, completed}`.
 * @param {number} options.at The clock reading, in milliseconds.
 * @param {string} options.reason What the lifecycle said.
 * @returns {object} The incident record.
 */
export function buildCaptureIncident({ descriptor, progress, at, reason }) {
  return buildIncidentRecord({
    outcome: RUN_OUTCOMES.ERRORED,
    runtimeReceipt: {
      kind: "capture-incident",
      probe: descriptor.slotOwner,
      captureId: descriptor.captureId,
      captureRoot: descriptor.captureRoot,
      origins: { ...descriptor.origins },
      servedBuildAssertion: descriptor.servedBuild ? "enforced" : "waived",
      phase: progress.phase,
      cell: progress.cell,
      elapsedMs: at - progress.startedAt,
      openResources: [...progress.open],
      cellsCompleted: [...progress.completed],
      deadlineMs: descriptor.deadlineMs,
      closeDeadlineMs: descriptor.closeDeadlineMs,
      hardStopGraceMs: descriptor.hardStopGraceMs,
    },
    error: reason,
  });
}

/**
 * Capture a rig (or a rig set) over BEFORE and AFTER origins, on every
 * renderer the rig declares, in ONE browser run.
 *
 * The order is fixed and is the point of the module: resolve the origins,
 * plan every cell, preflight both served builds, take the single Edge slot,
 * and only then open a browser — every refusal that can be decided without a
 * GPU is decided before one is claimed. The slot and the browser are both
 * taken THROUGH the lifecycle scope, so the browser is closed whatever the
 * cell work does AND whatever the watchdog does, and every measurement is
 * computed in Node after that close.
 *
 * @param {object|object[]} rig The rig, or the rig set.
 * @param {{BEFORE: string, AFTER: string}} origins Required; never defaulted.
 * @param {object} [options] See {@link buildCaptureDescriptor}.
 * @param {object} [dependencies] Injection seams.
 * @param {object} [dependencies.chromium] Playwright's chromium namespace.
 * @param {Function} [dependencies.launch] Edge launcher.
 * @param {Function} [dependencies.preflight] Served-build preflight.
 * @param {Function} [dependencies.acquireSlot] Edge-slot holder, supplied to the lifecycle as its slot dependency.
 * @param {Function} [dependencies.lifecycle] Bounded lifecycle; a replacement must honour the same scope contract.
 * @param {object} [dependencies.lifecycleDependencies] The lifecycle's own timer/exit/diagnostic seams.
 * @param {Function} [dependencies.decodePng] PNG decoder.
 * @param {Function} [dependencies.encodePng] RGBA encoder for the heat-maps.
 * @param {Function} [dependencies.writeFile] `(file, body) => void`.
 * @param {Function} [dependencies.mkdir] `(directory) => void`.
 * @param {Function} [dependencies.now] Clock.
 * @returns {Promise<{descriptor: object, manifest: object, receipt: object,
 *   manifestPath: string, receiptPath: string, writtenPaths: string[]}>} The run.
 */
export async function capture(rig, origins, options = {}, dependencies = {}) {
  const {
    chromium,
    launch = launchEdge,
    preflight: preflightImpl = preflightServedBuildArtifacts,
    acquireSlot = withEdgeSlot,
    lifecycle = withProbeLifecycle,
    lifecycleDependencies,
    decodePng: decodePngImpl = decodePng,
    encodePng = encodeRgbaPng,
    writeFile = (file, body) => fs.writeFileSync(file, body),
    mkdir = (directory) => fs.mkdirSync(directory, { recursive: true }),
    now = Date.now,
  } = dependencies;

  const descriptor = buildCaptureDescriptor(rig, origins, options);
  const servedBuildAssertion = descriptor.servedBuild ? "enforced" : "waived";

  const preflightBySlot = {};
  if (descriptor.servedBuild) {
    for (const slot of descriptor.slots) {
      preflightBySlot[slot] = await preflightImpl({
        origin: descriptor.origins[slot],
        repositoryRoot: descriptor.repositoryRoot,
        artifacts: [...descriptor.requiredArtifacts],
      });
    }
  }
  throwForDecision(
    decideCaptureRefusal({
      rig,
      origins,
      preflight: preflightBySlot,
      servedBuild: descriptor.servedBuild,
      requiredArtifacts: descriptor.requiredArtifacts,
    }),
    "the served bytes are not the bytes on disk; rebuild, or restart the server with --serve-built",
  );

  const measurable = descriptor.cells.filter(
    (cell) => cell.state === CELL_STATES.MEASURED,
  );
  const produced = new Map();
  let edgeSlot = null;
  let browsersLaunched = 0;

  // What the watchdog would otherwise be unable to say. Updated in place as
  // the run moves, and read only when the hard stop is about to fire.
  const progress = {
    phase: measurable.length > 0 ? "planned" : "no measurable cell",
    cell: null,
    startedAt: now(),
    open: new Set(),
    completed: [],
  };

  // What the close exemption reads (`probe-close-exemption.mjs`): whether every
  // measurable cell returned, and one record per browser close.
  const closeState = { complete: false, closes: [] };
  const browserLabel = `${descriptor.slotOwner} browser`;

  // Run at most once: the lifecycle's hard stop publishes through it when only
  // a lingering browser kept a complete capture from finishing, and the
  // ordinary return path would otherwise write everything a second time.
  let finished = null;
  const finish = () => {
    finished ??= finishCapture({
      descriptor,
      produced,
      servedBuildAssertion,
      preflight: descriptor.servedBuild ? preflightBySlot : null,
      edgeSlot,
      browsersLaunched,
      browserCloses:
        closeState.closes.length > 0
          ? describeBrowserCloses(closeState, now)
          : null,
      decodePngImpl,
      encodePng,
      writeFile,
      mkdir,
      now,
    });
    return finished;
  };

  if (measurable.length > 0) {
    // THE SLOT AND THE BROWSER ARE THE LIFECYCLE'S, NOT THIS FUNCTION'S.
    // An earlier shape opened the browser by hand inside the lifecycle body
    // and closed it in a `finally`. That closes on the ordinary path and on
    // the throw path, and on NEITHER of the two paths the lifecycle exists
    // for: nothing was registered, so the "prove every resource closed" check
    // had an empty list to prove, the orderly deadline's abort reached no
    // aborter, and `hardExit()` could end the process with Edge still
    // running. Taking both through the scope fixes all three at once, and
    // `withResource` additionally AGGREGATES a failing close with the cell
    // failure instead of letting "Target closed" replace the real diagnosis.
    progress.phase = "acquiring the Edge slot";
    const lifecycleBody = async (lifecycleScope) =>
      lifecycleScope.withEdgeSlot(async (slotScope, held) => {
        edgeSlot = {
          owner: held?.owner ?? descriptor.slotOwner,
          pid: held?.pid ?? null,
          acquiredAt: held?.acquiredAt ?? null,
          reclaimed: held?.reclaimed ?? null,
        };
        progress.open.add("edge slot");
        progress.phase = "launching the browser";
        await slotScope.withResource(
          {
            kind: "browser",
            // ONE browser for the whole run: the BEFORE and AFTER legs of a
            // pair are only comparable if nothing between them changed, and a
            // second browser changes the shader cache, the GPU process and
            // the adapter.
            label: browserLabel,
            acquire: async () => {
              const browser = await launch({
                headed: descriptor.headed,
                launchArgs: descriptor.launchArgs ?? undefined,
                chromium,
              });
              browsersLaunched++;
              progress.open.add("browser");
              return browser;
            },
            close: async (browser) => {
              progress.phase = "closing the browser";
              // Drained when the cells all returned: they are awaited one at
              // a time, so a close that begins after the last one has no work
              // left to wait for.
              const record = createCloseRecord({
                run: 0,
                label: browserLabel,
                deadlineMs: descriptor.closeDeadlineMs,
                startedAt: now(),
              });
              record.drained = closeState.complete;
              closeState.closes.push(record);
              try {
                await browser.close();
                record.browserCloseMs = now() - record.startedAt;
                progress.open.delete("browser");
              } finally {
                record.closeMs = now() - record.startedAt;
              }
            },
            isClosed: (browser) => !browser.isConnected(),
          },
          async (browser) => {
            for (const cell of measurable) {
              // Between cells, never inside one: a run that has begun
              // draining stops planning more work here rather than opening
              // another page against a slot it may no longer hold.
              slotScope.checkpoint();
              progress.phase = "capturing";
              progress.cell = cell.key;
              produced.set(
                cell.key,
                await descriptor.cellWork(cell, {
                  browser,
                  descriptor,
                  options,
                  now,
                  scope: slotScope,
                }),
              );
              progress.completed.push(cell.key);
              progress.cell = null;
            }
            progress.phase = "every cell captured";
            closeState.complete = true;
          },
        );
        progress.open.delete("edge slot");
      });

    // The lifecycle takes the slot itself, so the caller's `acquireSlot` seam
    // reaches it as its own slot dependency. The wrapper exists only to carry
    // the injected clock, which the lifecycle's call shape does not forward.
    const slotDependency = (slotOptions, slotBody) =>
      acquireSlot({ ...slotOptions, now: now() }, slotBody);

    // THE HARD STOP DOES NOT GET TO LEAVE WITHOUT SAYING WHAT IT WAS WAITING
    // FOR. The lifecycle writes exactly one diagnostic, on exactly one path:
    // immediately before `exit()` in `hardExit()` (`probe-lifecycle.mjs:224`).
    // So a wrapper here is precisely "the watchdog is about to kill us", and
    // it writes the capture's own state FIRST — to the same sink, and as a
    // durable `capture-incident.json` — before letting the lifecycle's line
    // through unchanged. Every write is guarded: a diagnostic that throws must
    // not become the reason the process dies, and `exit()` follows
    // synchronously, which is why the incident is written with the SYNCHRONOUS
    // writer this module already takes.
    // The one way to lose it: a caller that replaces `dependencies.lifecycle`
    // AND supplies its own `writeDiagnostic` after spreading ours discards this
    // wrapper along with it. That is the same trade as replacing the lifecycle
    // itself — a replacement owns the diagnostics too — and it is why the
    // documented seam is `lifecycleDependencies`, which this wraps rather than
    // replaces.
    const baseWriteDiagnostic =
      lifecycleDependencies?.writeDiagnostic ??
      ((text) => process.stderr.write(text));
    let incident = null;
    let incidentBanked = false;
    const bankIncident = () => {
      if (incident === null || incidentBanked) {
        return;
      }
      incidentBanked = true;
      try {
        mkdir(descriptor.outputDirectory);
        writeFile(
          path.join(descriptor.outputDirectory, descriptor.incidentName),
          `${JSON.stringify(incident, null, 2)}\n`,
        );
      } catch {
        // Likewise for a read-only or absent output directory.
      }
    };
    const writeDiagnostic = (text) => {
      incident = buildCaptureIncident({
        descriptor,
        progress,
        at: now(),
        reason: String(text).trim(),
      });
      try {
        baseWriteDiagnostic(
          `${descriptor.slotOwner} incident: phase "${incident.phase}", cell ${incident.cell ?? "none"}, ${incident.elapsedMs} ms elapsed, still open [${incident.openResources.join(", ") || "nothing"}], ${incident.cellsCompleted.length} cell(s) captured\n`,
        );
      } catch {
        // A broken sink is not worth failing the exit over.
      }
      // A complete capture whose browser has not yet closed may still be
      // published by the hard-stop hook that runs next; its incident is banked
      // there when it is not.
      if (!(
        closeState.complete &&
        closeState.closes.some((record) => record.closeMs === null)
      )) {
        bankIncident();
      }
      return baseWriteDiagnostic(text);
    };

    // The hard stop is the last synchronous point before the process dies: a
    // capture whose cells all returned and whose only open resource is a
    // browser that will not close is published from here (the manifest and
    // receipt, exit 0). Any other hard stop keeps its incident and exit 2.
    const onHardStop = (raws) => {
      recordCloseExpiries(closeState, raws);
      if (!onlyLingeringClose(raws, closeState)) {
        bankIncident();
        return undefined;
      }
      try {
        finish();
      } catch {
        bankIncident();
        return undefined;
      }
      return PROBE_EXIT_CODES.OK;
    };

    try {
      await lifecycle(
        {
          probe: descriptor.slotOwner,
          deadlineMs: descriptor.deadlineMs,
          closeDeadlineMs: descriptor.closeDeadlineMs,
          hardStopGraceMs: descriptor.hardStopGraceMs,
          edgeSlotLockPath: descriptor.edgeSlotLockPath,
          onHardStop,
        },
        lifecycleBody,
        {
          ...lifecycleDependencies,
          edgeSlot: slotDependency,
          writeDiagnostic,
        },
      );
    } catch (error) {
      // A browser that outlived its close deadline AFTER every cell was
      // captured is a teardown problem, not a lost measurement: the capture is
      // published and the close is in the receipt. Any other rejection is the
      // error it was.
      const lingering = assessLifecycleFailure(error, closeState);
      if (!lingering) {
        throw error;
      }
      try {
        baseWriteDiagnostic(
          `${descriptor.slotOwner}: a browser close outlived its deadline after every cell was captured; the capture is published and the close is in the receipt\n`,
        );
      } catch {
        // A broken sink must not turn a published capture into a failure.
      }
    }
  }

  return finish();
}

function finishCapture({
  descriptor,
  produced,
  servedBuildAssertion,
  preflight,
  edgeSlot,
  browsersLaunched,
  browserCloses,
  decodePngImpl,
  encodePng,
  writeFile,
  mkdir,
  now,
}) {
  const writtenPaths = [];
  const decoded = new Map();
  const cellRecords = new Map();
  const captures = [];

  for (const cell of descriptor.cells) {
    if (cell.state === CELL_STATES.UNMEASURED) {
      cellRecords.set(cell.key, unmeasuredCell(cell.reason, cell.trackedBy));
      continue;
    }
    const result = produced.get(cell.key);
    if (result === undefined) {
      cellRecords.set(
        cell.key,
        unmeasuredCell("the cell produced no capture", cell.trackedBy),
      );
      continue;
    }
    const buffer = Buffer.from(result.buffer);
    const image = decodePngImpl(buffer);
    decoded.set(cell.key, image);
    // `capture()` is the single writer for every artifact in the tree, so an
    // injected cell body produces the same on-disk layout as the default one.
    mkdir(cell.outputDirectory);
    writeFile(cell.outputPath, buffer);
    writtenPaths.push(cell.outputPath);
    const record = {
      state: CELL_STATES.MEASURED,
      image: cell.image,
      width: image.width,
      height: image.height,
      byteLength: buffer.byteLength,
      sha256: result.sha256 ?? sha256(buffer),
      url: result.url ?? cell.url,
      capturedAt: result.capturedAt ?? new Date(now()).toISOString(),
      metrics: cellMetrics(image, image),
    };
    cellRecords.set(cell.key, record);
    captures.push({
      name: cell.key,
      path: cell.image,
      byteLength: record.byteLength,
      sha256: record.sha256,
      matchCount: result.matchCount ?? null,
      // The SUCCESS path's readiness record — `null` when the cell body was
      // injected and reported none. Receipt only: the manifest is unchanged.
      readiness: summariseCellReadiness(result.readiness),
    });
  }

  const pairRecords = new Map();
  for (const pair of descriptor.pairs) {
    const before = cellRecords.get(`${pair.key}|BEFORE`);
    const after = cellRecords.get(`${pair.key}|AFTER`);
    if (before?.state !== CELL_STATES.MEASURED) {
      pairRecords.set(pair.key, unmeasuredPair("BEFORE is UNMEASURED"));
      continue;
    }
    if (after?.state !== CELL_STATES.MEASURED) {
      pairRecords.set(pair.key, unmeasuredPair("AFTER is UNMEASURED"));
      continue;
    }
    const beforeImage = decoded.get(`${pair.key}|BEFORE`);
    const afterImage = decoded.get(`${pair.key}|AFTER`);
    if (
      beforeImage.width !== afterImage.width ||
      beforeImage.height !== afterImage.height
    ) {
      pairRecords.set(
        pair.key,
        unmeasuredPair(
          `BEFORE is ${beforeImage.width}x${beforeImage.height} and AFTER is ${afterImage.width}x${afterImage.height} — a pair of two sizes cannot be diffed`,
        ),
      );
      continue;
    }
    const metrics = pairMetrics(beforeImage, afterImage, {
      tolerance: pair.tolerance,
    });
    mkdir(path.dirname(pair.diffPath));
    writeFile(
      pair.diffPath,
      Buffer.from(
        encodePng(metrics.diffRgba, beforeImage.width, beforeImage.height),
      ),
    );
    writtenPaths.push(pair.diffPath);
    pairRecords.set(pair.key, {
      state: CELL_STATES.MEASURED,
      diffImage: pair.diffImage,
      mismatchPct: metrics.mismatchPct,
      changedPx: metrics.changedPx,
      bbox: metrics.bbox,
      tolerance: metrics.tolerance,
      metrics: { mssim: metrics.mssim, windows: metrics.windows },
    });
  }

  const generatedAt = new Date(now()).toISOString();
  const manifest = buildCaptureManifest({
    descriptor,
    cells: cellRecords,
    pairs: pairRecords,
    receiptPath: descriptor.receiptPath,
    generatedAt,
    servedBuildAssertion,
  });
  const violations = validateManifest(manifest);
  if (violations.length > 0) {
    throw new ProbeRefusal(
      "capture-manifest-invalid",
      `the capture manifest this run assembled does not validate: ${violations.join("; ")}`,
      { violations },
    );
  }

  const measured = [...cellRecords.values()].filter(
    (record) => record.state === CELL_STATES.MEASURED,
  ).length;
  const receipt = assembleReceipt({
    envelope: "runtime",
    runtime: {
      capture: descriptor.captureId,
      generatedAt,
      origins: { ...descriptor.origins },
      servedBuildAssertion,
      preflight,
      edgeSlot,
      launchArgs: descriptor.launchArgs,
      deadlineMs: descriptor.deadlineMs,
      browsersLaunched,
      ...(browserCloses === null ? {} : { browserCloses }),
      captures,
    },
    fields: {
      manifest: descriptor.manifestName,
      captureRoot: descriptor.captureRoot,
      rigs: descriptor.rigs.map((summary) => summary.id),
      renderers: [...descriptor.renderers],
      slots: [...descriptor.slots],
      cells: {
        measured,
        unmeasured: cellRecords.size - measured,
      },
    },
  });

  mkdir(descriptor.outputDirectory);
  const manifestPath = path.join(
    descriptor.outputDirectory,
    descriptor.manifestName,
  );
  const receiptPath = path.join(
    descriptor.outputDirectory,
    ...descriptor.receiptPath.split("/"),
  );
  writeFile(manifestPath, normalizeJson(manifest));
  writeFile(receiptPath, normalizeJson(receipt));
  writtenPaths.push(manifestPath, receiptPath);

  return {
    descriptor,
    manifest,
    receipt,
    manifestPath,
    receiptPath,
    writtenPaths,
  };
}
