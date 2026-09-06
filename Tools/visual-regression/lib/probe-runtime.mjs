// probe-runtime.mjs — the one runtime the visual-regression probe fleet runs on.
//
// @purpose Owns probe argv parsing, the single-Edge-slot lock, Edge launch per run, the served-build preflight, the Sandcastle2 origin rewrite and its refusal, renderReady gating, element-only capture, sha256, receipt assembly and the exit-code table, so a probe is a short script that declares cells.
// @status ACTIVE
//
// WHY THIS EXISTS. The 2026-08-29 seat census counted 937 top-level `.mjs`
// files under `Tools/visual-regression`, of which 682 call `chromium.launch(`
// themselves, 91 define their own `sha256`, and 64 parse `process.argv` by
// hand. Every one of those copies is a place where a governance rule can be
// half-applied: a probe that forgets the served-build preflight measures a
// bundle the page never loaded, a probe that forgets the origin guard silently
// lands on the maintainer's live 8080 server, and a probe that scores a
// refusal as a measurement reports a number it never took. This module is the
// single home for the parts that must be identical everywhere, so a probe is
// left with the part that is genuinely its own: what to load and what to read
// back.
//
// THE SHAPE OF A MIGRATED PROBE. A probe hands `runProbe` a descriptor and gets
// back an exit code. The descriptor says what the probe is called, where its
// artifacts go, which extra flags it accepts, and one `cells` function that is
// called once per run with a live Edge browser and the parsed options. Nothing
// in the descriptor decides an exit code, opens a browser, or writes a file —
// those belong to the runtime, which is the point.
//
// TWO RECEIPTS, ON PURPOSE. A probe's receipt is the probe's own document: the
// fields it published before it was migrated are the fields it publishes after,
// because downstream readers (banked evidence, ledger citations, comparison
// scripts) key off them. The runtime therefore never injects its own fields
// into a `probe-owned` receipt. What the runtime knows — the resolved origin,
// the parsed options, the preflight result, the Edge slot, every capture and
// its sha256 — is written beside it as `<name>-runtime.json`. New probes that
// want one document instead of two declare `receiptEnvelope: "runtime"`.
//
// A RUN THAT DID NOT MEASURE WRITES NO RECEIPT. A refusal and a wedged harness
// both reach the end of `runProbe` with an empty cell list, and a receipt
// assembled from that is well-formed, reports zero failing verdicts, and — in
// the `probe-owned` envelope — cannot mention the refusal, because that
// envelope carries none of the runtime's fields. Writing it would destroy the
// last real receipt in the output directory and replace it with a document
// that reads as a clean run. So a non-measuring run leaves every measurement
// artifact untouched and writes one `<name>-refusal.json` (or `-error.json`)
// beside them instead, carrying the reason, the timestamp, the preflight facts
// and the options, and exits non-zero. When there is no prior receipt, nothing
// is written under the receipt's name at all: the absence IS the signal, and a
// hollow success-shaped document in its place is the failure being prevented.
//
// THREE FILES, NOT ONE. The exit-code table and the refusal error live in
// `probe-refusal.mjs`; the single-Edge-slot lock lives in `probe-edge-slot.mjs`.
// Both are re-exported here, so a probe imports one module and a reviewer reads
// three files that each stay well inside the fork's size rule. The split is
// also what keeps the lock module free of a cycle back through the runtime.
//
// THE ANTI-RE-ACCRETION CONTRACT (DX-02). Landing this runtime does not stop
// a future probe from re-growing a private copy of one of the four concerns
// it owns beside a `runProbe(` call that already handles them — that is how
// the fleet reached 682 private `chromium.launch(` sites in the first place.
// A probe that imports and calls `runProbe` from this module declares that
// residency in its own header, next to `@purpose` and `@status`:
//
//   // @runtime lib/probe-runtime.mjs
//
// `Tools/visual-regression/lib/runtime-residency-contract.mjs` reads that tag
// (not an import scan — see its own header for why) and, for every probe that
// carries it, refuses a hand-rolled `createHash` import (the served-build
// preflight and `sha256` are already covered), an exclusive-create `{ flag:
// "wx" }` lock (the Edge slot is already covered), a locally declared
// `Refusal`-shaped error class or a `*-refusal.json` / `*-error.json` write
// (`ProbeRefusal` and the incident writer are already covered), or a
// `*-report.json` / `*-summary.md` / `*-runtime.json` write (the receipt
// writer is already covered). `Tools/visual-regression/runtime-residency-
// contract.spec.mjs` enforces it as a shrink-only ratchet, the same shape
// `lib/prohibited-reader-allowlist.mjs` already established. A probe that has
// not been migrated onto this runtime carries no `@runtime` tag (or `@runtime
// none`) and is out of scope — migrating the fleet in family batches is
// `DX-06`'s job, not this contract's.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  DEFAULT_EDGE_SLOT_LOCK_PATH,
  EDGE_SLOT_STALE_AFTER_MS,
  acquireEdgeSlot,
  decideEdgeSlot,
} from "./probe-edge-slot.mjs";
import {
  PROBE_EXIT_CODES,
  ProbeRefusal,
  acceptedDecision,
  exitCodeForOutcome,
  refusedDecision,
  throwForDecision,
} from "./probe-refusal.mjs";
import {
  checkNavigatedOrigin,
  computeSandcastle2Origins,
} from "./sandcastle2-origin-rewrite.mjs";
import {
  DEFAULT_SERVED_BUILD_ARTIFACTS,
  preflightServedBuildArtifacts,
} from "./served-build-preflight.mjs";

export {
  DEFAULT_EDGE_SLOT_LOCK_PATH,
  EDGE_SLOT_STALE_AFTER_MS,
  PROBE_EXIT_CODES,
  ProbeRefusal,
  acceptedDecision,
  acquireEdgeSlot,
  decideEdgeSlot,
  exitCodeForOutcome,
  refusedDecision,
  throwForDecision,
};

// ---------------------------------------------------------------------------
// 1. Constants
// ---------------------------------------------------------------------------

/**
 * The bundles a served-build assertion checks unless a probe narrows it.
 *
 * This is a RE-EXPORT, not a second list. The preflight library owns the set,
 * and a copy here would drift fail-open: if that library ever gained a third
 * bundle, a runtime with its own two-entry copy would let a stale third one
 * through without ever naming it in the refusal.
 */
export const REQUIRED_SERVED_ARTIFACTS = DEFAULT_SERVED_BUILD_ARTIFACTS;

/** Renderer names a probe may be pointed at. */
export const RENDERERS = Object.freeze(["webgl", "webgpu"]);

// ---------------------------------------------------------------------------
// 2. Argument parsing
// ---------------------------------------------------------------------------

/**
 * The flags every probe accepts. A probe adds its own through
 * `descriptor.args.extraOptions`; it never re-implements one of these.
 *
 * `--serve-built` is an ASSERTION, not a server switch: the probe cannot start
 * the server, so what the flag governs is whether the runtime insists that the
 * bytes the origin serves are the bytes on disk. It defaults ON — fail-closed —
 * and `--no-serve-built` is the visible, recorded waiver.
 */
export const CORE_OPTION_SPECS = Object.freeze([
  { flag: "--port", key: "port", kind: "positive-integer" },
  { flag: "--runs", key: "runs", kind: "positive-integer" },
  { flag: "--reverse", key: "reverse", kind: "boolean" },
  { flag: "--headed", key: "headed", kind: "boolean" },
  { flag: "--renderer", key: "renderers", kind: "renderer-list" },
  { flag: "--serve-built", key: "servedBuild", kind: "boolean" },
  { flag: "--no-serve-built", key: "servedBuild", kind: "boolean-false" },
  { flag: "--repository-root", key: "repositoryRoot", kind: "string" },
  { flag: "--output", key: "outputDirectory", kind: "string" },
  { flag: "--timeout-ms", key: "timeoutMs", kind: "positive-integer" },
]);

/** Defaults for the core flags. `port` is a governed Edge port, never 8080. */
export const CORE_OPTION_DEFAULTS = Object.freeze({
  port: 8094,
  runs: 1,
  reverse: false,
  headed: false,
  renderers: RENDERERS,
  servedBuild: true,
  repositoryRoot: null,
  outputDirectory: null,
  timeoutMs: 120000,
});

/**
 * @param {string[]} argv Raw argument list.
 * @param {number} index Index of the flag.
 * @param {string} name The flag, for the error message.
 * @returns {string} The flag's value.
 */
function optionValue(argv, index, name) {
  if (index + 1 >= argv.length || argv[index + 1].startsWith("--")) {
    throw new TypeError(`${name} requires a value`);
  }
  return argv[index + 1];
}

/**
 * @param {string} value Raw value.
 * @param {string} name The flag, for the error message.
 * @returns {number} The parsed integer.
 */
function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return parsed;
}

/**
 * @param {string} value Raw value.
 * @param {string} name The flag, for the error message.
 * @returns {number} The parsed number.
 */
function nonNegativeNumber(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new TypeError(`${name} must be a non-negative number`);
  }
  return parsed;
}

/**
 * `--renderer` accepts one backend, both comma-separated, or the word `both`.
 * The result always lists backends in `RENDERERS` order, so a probe's cell
 * order — and therefore its receipt — does not depend on how the flag was
 * spelled.
 *
 * @param {string} value Raw value.
 * @param {string} name The flag, for the error message.
 * @returns {string[]} Selected backends, in canonical order.
 */
function rendererList(value, name) {
  const requested =
    value === "both"
      ? [...RENDERERS]
      : value
          .split(",")
          .map((entry) => entry.trim().toLowerCase())
          .filter((entry) => entry.length > 0);
  if (requested.length === 0) {
    throw new TypeError(`${name} requires at least one renderer`);
  }
  for (const entry of requested) {
    if (!RENDERERS.includes(entry)) {
      throw new TypeError(
        `${name} must be one of ${RENDERERS.join(", ")}, both, or a comma-separated subset (got "${entry}")`,
      );
    }
  }
  return RENDERERS.filter((entry) => requested.includes(entry));
}

/**
 * Parse a probe's command line against the core flags plus whatever the probe
 * declares. Malformed input throws a `TypeError` (a caller error, exit 2);
 * only a governance violation refuses (exit 3).
 *
 * @param {string[]} argv Arguments after the script name.
 * @param {object} [options] Parse options.
 * @param {object} [options.defaults] Per-probe overrides of {@link CORE_OPTION_DEFAULTS}.
 * @param {Array<{flag: string, key: string, kind: string}>} [options.extraOptions] Probe-declared flags.
 * @returns {object} Resolved options.
 */
export function parseProbeArgs(argv, options = {}) {
  const specs = [...CORE_OPTION_SPECS, ...(options.extraOptions ?? [])];
  const byFlag = new Map(specs.map((spec) => [spec.flag, spec]));
  const parsed = { ...CORE_OPTION_DEFAULTS };
  for (const spec of options.extraOptions ?? []) {
    if (Object.hasOwn(spec, "default")) {
      parsed[spec.key] = spec.default;
    }
  }
  Object.assign(parsed, options.defaults ?? {});

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const spec = byFlag.get(arg);
    if (spec === undefined) {
      throw new TypeError(`unknown argument: ${arg}`);
    }
    if (spec.kind === "boolean") {
      parsed[spec.key] = true;
      continue;
    }
    if (spec.kind === "boolean-false") {
      parsed[spec.key] = false;
      continue;
    }
    const raw = optionValue(argv, index, arg);
    index++;
    if (spec.kind === "positive-integer") {
      parsed[spec.key] = positiveInteger(raw, arg);
    } else if (spec.kind === "non-negative-number") {
      parsed[spec.key] = nonNegativeNumber(raw, arg);
    } else if (spec.kind === "renderer-list") {
      parsed[spec.key] = rendererList(raw, arg);
    } else if (spec.kind === "string") {
      parsed[spec.key] = raw;
    } else {
      throw new TypeError(
        `${arg} declares an unknown option kind: ${spec.kind}`,
      );
    }
  }

  if (parsed.port > 65535) {
    throw new TypeError("--port must be at most 65535");
  }

  // The built Sandcastle2 app bakes `http://localhost:8080` into its own
  // top-level redirect (`Q-145`), and the default dev server on 8080 serves a
  // live esbuild of the SOURCE tree rather than the built one. A probe on 8080
  // therefore cannot distinguish "I measured the build" from "I measured the
  // maintainer's running session", so the runtime does not let it try.
  if (parsed.port === 8080) {
    throw new ProbeRefusal(
      "port-8080-forbidden",
      "the probe runtime refuses port 8080; serve the built tree on a governed port (node server.js --port 8094 --serve-built)",
      { port: parsed.port },
    );
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// 3. Refusal decisions over the served build and the navigated origin
// ---------------------------------------------------------------------------

/**
 * Decide whether a served-build preflight clears the run.
 *
 * @param {object|null} preflight Result of `preflightServedBuildArtifacts`, or `null` when waived.
 * @param {object} [options] Options.
 * @param {string[]} [options.requiredArtifacts] Artifacts that must have matched.
 * @param {boolean} [options.waived] Whether `--no-serve-built` waived the assertion.
 * @returns {object} An accepted or refusing decision.
 */
export function decideServedBuildRefusal(preflight, options = {}) {
  const requiredArtifacts =
    options.requiredArtifacts ?? REQUIRED_SERVED_ARTIFACTS;
  if (options.waived === true) {
    return acceptedDecision();
  }
  if (!preflight || preflight.ok !== true) {
    return refusedDecision("served-build-preflight-failed", {
      preflight: preflight ?? null,
    });
  }
  const results = Array.isArray(preflight.artifacts) ? preflight.artifacts : [];
  const byPath = new Map(results.map((result) => [result.path, result]));
  const missingOrUnmatched = requiredArtifacts.filter((artifact) => {
    const result = byPath.get(artifact);
    return !result || result.match !== true;
  });
  if (missingOrUnmatched.length > 0) {
    return refusedDecision("served-build-preflight-incomplete", {
      missingOrUnmatched,
      preflight,
    });
  }
  return acceptedDecision();
}

/**
 * Decide whether a navigation stayed on the origin it was pointed at. The
 * comparison itself is delegated to `sandcastle2-origin-rewrite.mjs` so the
 * origin grammar has one home; this wrapper only maps its verdict onto the
 * runtime's decision shape.
 *
 * @param {object} options Inputs.
 * @param {string} options.requestedOrigin Origin the navigation was asked to reach.
 * @param {string} options.actualUrl The url the page ended on, after redirects.
 * @param {string} [options.label] What is being checked, folded into the reason.
 * @returns {object} An accepted or refusing decision.
 */
export function decideOriginRefusal({
  requestedOrigin,
  actualUrl,
  label = "navigation",
}) {
  let expected;
  try {
    expected = new URL(requestedOrigin).origin;
  } catch {
    return refusedDecision("requested-origin-invalid", { requestedOrigin });
  }
  const verdict = checkNavigatedOrigin({
    observedUrl: actualUrl,
    expectedOrigin: expected,
    label,
  });
  if (verdict.ok === true) {
    return acceptedDecision();
  }
  return refusedDecision(
    verdict.code === "UNPARSABLE_URL"
      ? "navigation-url-invalid"
      : "origin-mismatch",
    {
      requestedOrigin: expected,
      actualOrigin: verdict.observedOrigin,
      actualUrl,
      reason: verdict.reason,
    },
  );
}

/**
 * Decide whether a settle that was supposed to be gated on `Scene.renderReady`
 * may be believed. A capture taken before readiness is not a slow measurement,
 * it is a different measurement, so it refuses rather than scoring.
 *
 * @param {object} options Inputs.
 * @param {unknown} options.renderReady What the page reported for `scene.renderReady`.
 * @param {number} options.elapsedMs How long the wait took.
 * @param {number} options.timeoutMs The budget it had.
 * @returns {object} An accepted or refusing decision.
 */
export function decideRenderReadyRefusal({
  renderReady,
  elapsedMs,
  timeoutMs,
}) {
  if (typeof renderReady !== "boolean") {
    return refusedDecision("render-ready-absent", {
      observed: renderReady === undefined ? "undefined" : typeof renderReady,
    });
  }
  if (renderReady !== true) {
    return refusedDecision("render-ready-timeout", { elapsedMs, timeoutMs });
  }
  return acceptedDecision();
}

// ---------------------------------------------------------------------------
// 4. Browser lifecycle, origin rewrite, capture
// ---------------------------------------------------------------------------

/**
 * The Edge flag the fleet actually shares, and the ONLY one the runtime adds
 * on its own.
 *
 * A census of the 647 top-level probes taken while writing this module: 562
 * pass `--enable-unsafe-webgpu`, 210 pass `--use-vulkan`, and exactly one
 * (`probe-aec-perf.mjs`) passes `--enable-precise-memory-info`. A runtime
 * that quietly handed all four to every migrated probe would be changing the
 * measurement conditions of 437 probes that have never run under Vulkan and
 * 646 that have never run with un-bucketed `performance.memory` — and it
 * would do it invisibly, because a launch flag leaves no trace in a receipt.
 * Both of those flags are measurement-affecting here specifically:
 * `--use-vulkan` moves ANGLE and Dawn off the Windows D3D default, which is
 * pipeline-compile behaviour, and pipeline-compile counters are precisely what
 * the cold-start probe publishes; `--enable-precise-memory-info` un-buckets
 * `usedJSHeapSize`, which the cold-start harness reads and the probe reports
 * per cell.
 *
 * So the default is the common denominator and nothing more. A probe that
 * genuinely needs others declares `descriptor.launchArgs`, which puts the
 * change in the probe, in review, and in the runtime receipt.
 */
export const EDGE_LAUNCH_ARGS = Object.freeze(["--enable-unsafe-webgpu"]);

/**
 * Launch Edge. Channel `msedge` is not a preference: Playwright's bundled
 * Firefox is Nightly and has no WebGPU, so a Firefox run measures WebGL twice.
 *
 * @param {object} options Options.
 * @param {boolean} options.headed Whether to show the browser.
 * @param {string[]} [options.launchArgs] Flags to pass instead of {@link EDGE_LAUNCH_ARGS}.
 * @param {object} [options.chromium] Playwright's chromium namespace; imported lazily when absent.
 * @returns {Promise<object>} The launched browser.
 */
export async function launchEdge({ headed, launchArgs, chromium }) {
  const impl = chromium ?? (await import("playwright")).chromium;
  return impl.launch({
    channel: "msedge",
    headless: !headed,
    args: [...(launchArgs ?? EDGE_LAUNCH_ARGS)],
  });
}

/**
 * Install the Sandcastle2 origin rewrite on a context or page, for probes that
 * open the built app. Lazily imported so probes that never touch Sandcastle2
 * do not pay for it.
 *
 * @param {{route: Function}} contextOrPage A Playwright context or page.
 * @param {object} options Options.
 * @param {number|string} options.servedPort Port the app is served on.
 * @param {number|string} options.bucketPort Port the run/bucket frame is served on.
 * @returns {Promise<object>} The computed origins.
 */
export async function installSandcastle2OriginRewrite(
  contextOrPage,
  { servedPort, bucketPort },
) {
  const origins = computeSandcastle2Origins({ servedPort, bucketPort });
  const { installOriginRewrite } =
    await import("./sandcastle2-origin-rewrite.mjs");
  await installOriginRewrite(contextOrPage, origins);
  return origins;
}

/**
 * @param {Buffer|Uint8Array} bytes Bytes to fingerprint.
 * @returns {string} Lowercase hex sha256.
 */
export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Screenshot ONE element, never the page. A page screenshot includes the
 * widget chrome and the browser's own compositing, so two backends can differ
 * by pixels neither renderer drew; every parity number in this fork that
 * survived review was taken from an element.
 *
 * The locator must resolve to exactly one element, unless the caller names the
 * `index` it means. A selector that matches several and no declared index is a
 * probe bug that would otherwise silently photograph the first one; a declared
 * index records `matchCount` in the receipt, so a page that grew a second
 * canvas is visible rather than invisible.
 *
 * Zero matches always refuses: an empty capture is not a black frame.
 *
 * @param {object} options Options.
 * @param {object} options.page The Playwright page.
 * @param {string} [options.selector] CSS selector; defaults to the scene canvas.
 * @param {number} [options.index] Which match to take when several are expected.
 * @param {string} options.name Capture name, used for the file and the record.
 * @param {string} options.outputDirectory Where the PNG is written.
 * @param {Array<object>} [options.captures] Sink the record is appended to.
 * @returns {Promise<{name: string, path: string, byteLength: number, sha256: string, matchCount: number, buffer: Buffer}>} The capture.
 */
export async function captureElement({
  page,
  selector = "canvas",
  index,
  name,
  outputDirectory,
  captures,
}) {
  const locator = page.locator(selector);
  const count = await locator.count();
  if (count === 0 || (count !== 1 && index === undefined)) {
    throw new ProbeRefusal(
      "capture-selector-ambiguous",
      `element capture "${name}" needs exactly one match for ${selector} (or a declared index), found ${count}`,
      { selector, count, name },
    );
  }
  fs.mkdirSync(outputDirectory, { recursive: true });
  const file = path.join(outputDirectory, `${name}.png`);
  const target = index === undefined ? locator : locator.nth(index);
  const buffer = await target.screenshot({ type: "png", path: file });
  const record = {
    name,
    path: file,
    byteLength: buffer.byteLength,
    sha256: sha256(buffer),
    matchCount: count,
  };
  if (Array.isArray(captures)) {
    captures.push(record);
  }
  return { ...record, buffer };
}

// ---------------------------------------------------------------------------
// 5. Receipts
// ---------------------------------------------------------------------------

/**
 * Serialize a receipt the way every banked receipt in this fork is serialized:
 * two-space JSON, LF line endings, trailing newline. A receipt that changes its
 * whitespace between runs cannot be diffed, and diffing receipts is how a
 * regression gets found.
 *
 * @param {unknown} value The receipt.
 * @returns {string} The serialized text.
 */
export function normalizeJson(value) {
  return `${JSON.stringify(value, null, 2).replace(/\r\n/g, "\n")}\n`;
}

/**
 * Assemble the document a probe publishes.
 *
 * `probe-owned` (the default for a migrated probe) writes the probe's fields
 * and nothing else, so a receipt's field set survives migration unchanged.
 * `runtime` wraps them in the runtime's own envelope for probes written after
 * this module existed.
 *
 * @param {object} options Options.
 * @param {"probe-owned"|"runtime"} options.envelope Which shape to produce.
 * @param {object} options.fields The probe's own receipt fields.
 * @param {object} options.runtime The runtime section (origin, options, preflight, ...).
 * @returns {object} The receipt.
 */
export function assembleReceipt({ envelope, fields, runtime }) {
  if (envelope === "probe-owned") {
    return { ...fields };
  }
  if (envelope === "runtime") {
    return { ...runtime, ...fields };
  }
  throw new TypeError(`unknown receipt envelope: ${envelope}`);
}

/**
 * The runtime's own record of a run: everything the runtime knew and the probe
 * did not have to restate.
 *
 * @param {object} options Options.
 * @param {string} options.probe Probe name.
 * @param {string} options.generatedAt ISO timestamp.
 * @param {string} options.origin Resolved origin.
 * @param {object} options.options Parsed options.
 * @param {object|null} options.preflight Preflight result, or `null` when waived.
 * @param {object} options.edgeSlot Slot record.
 * @param {string[]} [options.launchArgs] Edge flags the run was launched with.
 * @param {Array<object>} options.captures Capture records.
 * @param {Array<object>} options.verdicts Probe verdicts.
 * @param {number} options.exitCode Final exit code.
 * @returns {object} The runtime receipt.
 */
export function buildRuntimeReceipt({
  probe,
  generatedAt,
  origin,
  options,
  preflight,
  edgeSlot,
  launchArgs,
  captures,
  verdicts,
  exitCode,
}) {
  return {
    probe,
    generatedAt,
    origin,
    options,
    servedBuildAssertion: options.servedBuild ? "enforced" : "waived",
    preflight,
    edgeSlot,
    launchArgs: launchArgs ?? null,
    captures,
    verdicts,
    exitCode,
  };
}

/**
 * The three ways a run can end, as far as its artifacts are concerned.
 *
 * Only a MEASURED run has standing to publish. The other two produce a
 * document that looks like a measurement and is not one: the cell loop never
 * ran, or ran partly, so a probe's receipt builder assembles a well-formed
 * envelope over zero cells and zero verdicts — and a `probe-owned` envelope by
 * design carries none of the runtime's fields, so it cannot even say why.
 * Written over a banked receipt, that is a probe reporting "nothing failed"
 * about a run it never took.
 */
export const RUN_OUTCOMES = Object.freeze({
  MEASURED: "measured",
  REFUSED: "refused",
  ERRORED: "errored",
});

/**
 * The sidecar a non-measuring run writes INSTEAD of a receipt.
 *
 * The name differs from `<name>-report.json` deliberately. What tells a reader
 * that the banked receipt is still the last real measurement is that no fresh
 * one appeared; an incident written under the receipt's own name could not say
 * that, whatever it contained.
 */
export const INCIDENT_ARTIFACT_SUFFIX = Object.freeze({
  [RUN_OUTCOMES.REFUSED]: "refusal",
  [RUN_OUTCOMES.ERRORED]: "error",
});

/**
 * Classify a finished run for the purpose of deciding what it may write.
 *
 * @param {object} options Options.
 * @param {object|null} [options.refusal] The refusal, when one occurred.
 * @param {boolean} [options.errored] Whether the harness threw.
 * @returns {string} One of {@link RUN_OUTCOMES}.
 */
export function outcomeOfRun({ refusal, errored }) {
  if (refusal) {
    return RUN_OUTCOMES.REFUSED;
  }
  if (errored === true) {
    return RUN_OUTCOMES.ERRORED;
  }
  return RUN_OUTCOMES.MEASURED;
}

/**
 * The durable record of a run that did not measure: the outcome first, then
 * everything the runtime knew — origin, options, the preflight result, the
 * Edge slot, the launch flags, the refusal — plus the harness error when there
 * was one. It is a strict superset of what the runtime sidecar carried, so
 * skipping the sidecar on this path loses nothing.
 *
 * @param {object} options Options.
 * @param {string} options.outcome One of {@link RUN_OUTCOMES}.
 * @param {object} options.runtimeReceipt The runtime receipt for the run.
 * @param {string|null} [options.error] The harness error text, when it threw.
 * @returns {object} The incident record.
 */
export function buildIncidentRecord({ outcome, runtimeReceipt, error = null }) {
  const record = { outcome, ...runtimeReceipt };
  if (error !== null && error !== undefined) {
    record.error = error;
  }
  return record;
}

/**
 * Default markdown summary. A probe with a richer table supplies its own
 * `summary(receipt, runtimeReceipt)`.
 *
 * @param {object} receipt The probe receipt.
 * @param {object} runtimeReceipt The runtime receipt.
 * @param {string} title Heading.
 * @returns {string} Markdown.
 */
export function buildMarkdownSummary(receipt, runtimeReceipt, title) {
  const verdicts = Array.isArray(runtimeReceipt.verdicts)
    ? runtimeReceipt.verdicts
    : [];
  const lines = [
    `# ${title}`,
    "",
    `Generated: ${runtimeReceipt.generatedAt}`,
    "",
    `Origin: \`${runtimeReceipt.origin}\``,
    "",
    `Served-build assertion: ${runtimeReceipt.servedBuildAssertion}`,
    "",
    `Exit code: ${runtimeReceipt.exitCode}`,
    "",
  ];
  if (verdicts.length > 0) {
    lines.push("| Verdict | Result |", "| --- | --- |");
    for (const verdict of verdicts) {
      const id = String(verdict.id ?? verdict.claim ?? "verdict").replaceAll(
        "|",
        "\\|",
      );
      lines.push(`| ${id} | ${verdict.pass === true ? "PASS" : "FAIL"} |`);
    }
    lines.push("");
  }
  lines.push(`Receipt fields: ${Object.keys(receipt).join(", ")}`, "");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 6. The composition root
// ---------------------------------------------------------------------------

/**
 * Whether the module at `moduleUrl` is the script Node was started with.
 *
 * A migrated probe MUST guard its `runProbe` call with this. Its own receipt
 * builders and verdict functions are pure and are exactly what a spec wants to
 * import; without the guard, importing one launches a browser.
 *
 * @param {string} moduleUrl The caller's `import.meta.url`.
 * @param {string[]} [argv] Defaults to `process.argv`.
 * @returns {boolean} Whether this module is the entry point.
 */
export function isEntryPoint(moduleUrl, argv = process.argv) {
  if (!argv[1]) {
    return false;
  }
  return pathToFileURL(path.resolve(argv[1])).href === moduleUrl;
}

/**
 * Run a probe end to end and return its exit code.
 *
 * The order is fixed and is the point of the module: parse, preflight, take the
 * Edge slot, then and only then open a browser. Every refusal that can be
 * decided without a GPU is decided before one is claimed.
 *
 * A run that refuses, or whose harness throws, writes NO receipt and no
 * summary: it leaves whatever is already banked in the output directory
 * byte-identical and records itself in `<name>-refusal.json` or
 * `<name>-error.json` instead. See the module header.
 *
 * @param {object} descriptor The probe descriptor.
 * @param {string} descriptor.name Slug for artifacts and the receipt.
 * @param {string} [descriptor.title] Markdown heading.
 * @param {string} [descriptor.outputSubdirectory] Folder under `Tools/visual-regression/output`.
 * @param {object} [descriptor.args] `{ defaults, extraOptions }` for {@link parseProbeArgs}.
 * @param {string[]} [descriptor.servedArtifacts] Artifacts the preflight must match.
 * @param {string[]} [descriptor.launchArgs] Edge flags instead of {@link EDGE_LAUNCH_ARGS}; recorded in the runtime receipt.
 * @param {"probe-owned"|"runtime"} [descriptor.receiptEnvelope] Receipt shape.
 * @param {Function} descriptor.cells Called once per run; returns an ARRAY of that run's cells (wrap a single cell as `[cell]`).
 * @param {Function} [descriptor.receipt] `(cells, context) => object` — the probe's fields.
 * @param {Function} [descriptor.verdicts] `(cells, context) => Array` — the probe's verdicts.
 * @param {Function} [descriptor.summary] `(receipt, runtimeReceipt) => string`.
 * @param {object} [dependencies] Injection seams for tests.
 * @returns {Promise<number>} The exit code.
 */
export async function runProbe(descriptor, dependencies = {}) {
  const {
    argv = process.argv.slice(2),
    now = Date.now,
    chromium,
    preflight: preflightImpl = preflightServedBuildArtifacts,
    launch = launchEdge,
    writeFile = (file, body) => fs.writeFileSync(file, body),
    repositoryRoot: repositoryRootOverride,
  } = dependencies;

  let refusal = null;
  let errored = false;
  let errorText = null;
  let slot = null;
  const captures = [];
  let options;
  let repositoryRoot;
  let outputDirectory;
  let origin = null;
  let preflight = null;
  const cells = [];
  let verdicts = [];
  // Resolved once, published in the runtime receipt: a launch flag is a
  // measurement condition, and an unrecorded measurement condition is how two
  // legs of the same probe end up incomparable without anyone noticing.
  const launchArgs = [...(descriptor.launchArgs ?? EDGE_LAUNCH_ARGS)];

  try {
    options = parseProbeArgs(argv, descriptor.args ?? {});
    // Every runner in this fork invokes a probe from the repository root, so
    // cwd is the last-resort default; `--repository-root` is what a spec or an
    // out-of-tree caller passes instead.
    repositoryRoot = path.resolve(
      options.repositoryRoot ?? repositoryRootOverride ?? process.cwd(),
    );
    outputDirectory = path.resolve(
      options.outputDirectory ??
        path.join(
          repositoryRoot,
          "Tools",
          "visual-regression",
          "output",
          descriptor.outputSubdirectory ?? descriptor.name,
        ),
    );
    origin = `http://localhost:${options.port}`;

    if (options.servedBuild) {
      preflight = await preflightImpl({
        origin,
        repositoryRoot,
        artifacts: [
          ...(descriptor.servedArtifacts ?? REQUIRED_SERVED_ARTIFACTS),
        ],
      });
    }
    throwForDecision(
      decideServedBuildRefusal(preflight, {
        requiredArtifacts:
          descriptor.servedArtifacts ?? REQUIRED_SERVED_ARTIFACTS,
        waived: !options.servedBuild,
      }),
      "the served bytes are not the bytes on disk; rebuild, or restart the server with --serve-built",
    );

    slot = acquireEdgeSlot({
      lockPath: path.join(repositoryRoot, DEFAULT_EDGE_SLOT_LOCK_PATH),
      owner: descriptor.name,
      now: now(),
    });

    for (let run = 0; run < options.runs; run++) {
      // One browser PER RUN. A repeat that reuses the previous browser inherits
      // its warm shader cache, which is exactly the confound every cold-start
      // and first-frame measurement in this fork exists to avoid.
      const browser = await launch({
        headed: options.headed,
        launchArgs,
        chromium,
      });
      try {
        const produced = await descriptor.cells({
          browser,
          run,
          options,
          origin,
          outputDirectory,
          repositoryRoot,
          captures,
        });
        // A descriptor that returns its single cell as a bare object used to
        // reach the spread below and die as "Spread syntax requires
        // ...iterable[Symbol.iterator] to be a function" — an error carrying
        // this module's line number, naming neither the probe nor the shape,
        // raised after the Edge slot had been taken and the measurements made.
        // That is how AR-752's acceptance leg was lost on 2026-09-05. The
        // contract is checked here so the violation names itself.
        if (
          produced !== null &&
          produced !== undefined &&
          !Array.isArray(produced)
        ) {
          throw new TypeError(
            `${descriptor.name}: descriptor.cells must return an array of cells, got ${Object.prototype.toString.call(produced)}; wrap a single cell as [cell]`,
          );
        }
        cells.push(...(produced ?? []));
      } finally {
        await browser.close();
      }
    }

    verdicts = descriptor.verdicts
      ? (descriptor.verdicts(cells, { options, origin, outputDirectory }) ?? [])
      : [];
  } catch (error) {
    if (error instanceof ProbeRefusal) {
      refusal = {
        reason: error.reason,
        message: error.message,
        details: error.details,
      };
    } else {
      errored = true;
      refusal = null;
      errorText = String(error?.stack ?? error);
      process.stderr.write(`${descriptor.name}: ${errorText}\n`);
    }
  } finally {
    if (slot) {
      slot.release();
    }
  }

  const exitCode = exitCodeForOutcome({ refusal, errored, verdicts });
  const generatedAt = new Date(now()).toISOString();
  const runtimeReceipt = buildRuntimeReceipt({
    probe: descriptor.name,
    generatedAt,
    origin,
    options: options ?? null,
    preflight,
    edgeSlot: slot
      ? {
          lockPath: slot.lockPath,
          acquiredAt: slot.acquiredAt,
          reclaimed: slot.reclaimed,
        }
      : null,
    launchArgs,
    captures,
    verdicts,
    exitCode,
  });
  if (refusal) {
    runtimeReceipt.refusal = refusal;
  }

  const outcome = outcomeOfRun({ refusal, errored });
  let incidentPath = null;

  if (outcome === RUN_OUTCOMES.MEASURED) {
    const context = {
      options,
      origin,
      outputDirectory,
      captures,
      verdicts,
      generatedAt,
    };
    const fields = descriptor.receipt ? descriptor.receipt(cells, context) : {};
    const envelope = descriptor.receiptEnvelope ?? "probe-owned";
    const receipt = assembleReceipt({
      envelope,
      fields,
      runtime: runtimeReceipt,
    });
    if (outputDirectory) {
      fs.mkdirSync(outputDirectory, { recursive: true });
      writeFile(
        path.join(outputDirectory, `${descriptor.name}-report.json`),
        normalizeJson(receipt),
      );
      if (envelope === "probe-owned") {
        writeFile(
          path.join(outputDirectory, `${descriptor.name}-runtime.json`),
          normalizeJson(runtimeReceipt),
        );
      }
      const summary = descriptor.summary
        ? descriptor.summary(receipt, runtimeReceipt)
        : buildMarkdownSummary(
            receipt,
            runtimeReceipt,
            descriptor.title ?? descriptor.name,
          );
      writeFile(
        path.join(outputDirectory, `${descriptor.name}-summary.md`),
        summary,
      );
    }
  } else if (outputDirectory) {
    // The probe's receipt builder is not CALLED on this path. Running it over
    // an empty `cells` is what manufactured the hollow document, and a builder
    // that reads `cells[0]` would turn a refusal into an ERROR.
    fs.mkdirSync(outputDirectory, { recursive: true });
    incidentPath = path.join(
      outputDirectory,
      `${descriptor.name}-${INCIDENT_ARTIFACT_SUFFIX[outcome]}.json`,
    );
    writeFile(
      incidentPath,
      normalizeJson(
        buildIncidentRecord({ outcome, runtimeReceipt, error: errorText }),
      ),
    );
  }

  if (refusal) {
    process.stderr.write(
      `${descriptor.name}: REFUSED (${refusal.reason}) — ${refusal.message}\n`,
    );
  }
  if (incidentPath) {
    process.stderr.write(
      `${descriptor.name}: no receipt was written; the ${outcome} run is recorded at ${incidentPath}\n`,
    );
  }
  return exitCode;
}
