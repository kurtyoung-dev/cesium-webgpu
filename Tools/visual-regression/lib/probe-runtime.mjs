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
// THE LIFECYCLE IS OPT-IN, AND THE OPT-IN IS ONE FIELD (C13-42a). A descriptor
// that declares `workBudgetMs` — a function returning the positive
// safe-integer milliseconds ITS work needs per run — is run inside
// `withProbeLifecycle`: its `cells` is additionally handed a `scope`, every
// `scope.run` it starts is tracked to a settled outcome, the browser is not
// closed until that work drains, the Edge slot's ownership is re-asserted
// around each run, and the whole run carries a derived orderly deadline with a
// hard-stop grace behind it. A descriptor that declares NO `workBudgetMs`
// takes the path this runtime has always taken — `acquireEdgeSlot`, one
// browser per run in a `try/finally`, `cells` called with no `scope` — and its
// behaviour is unchanged by the adoption.
//
// The staging is deliberate. The version this was adopted from made
// `workBudgetMs` REQUIRED, which is a fleet-wide breaking change: at the time
// of adoption 21 probes on this runtime declared none, so every one of them
// would have died at `deriveLifecycleDeadline` before reaching a browser.
// Migrating them is `C13-42a-2`, one family at a time, each with its own
// measured budget — not a flag day. Until a probe is migrated, the absence of
// the field IS the declaration that it wants the old shape.
//
// THREE FILES, NOT ONE. The exit-code table and the refusal error live in
// `probe-refusal.mjs`; the single-Edge-slot lock lives in `probe-edge-slot.mjs`.
// Both are re-exported here, so a probe imports one module and a reviewer reads
// three files that each stay well inside the fork's size rule. The split is
// also what keeps the lock module free of a cycle back through the runtime.
// The scene frame driver (`probe-scene-frames.mjs`) is re-exported the same
// way: a step sequence that must act on given scene frames drives them through
// `driveSceneFrames`, which keeps a request-render-mode page rendering and
// ends at a wall-clock deadline, rather than through a private frame loop.
//
// FIVE COMPANION PIECES (DX-KIT-DECOMPOSE-RUNTIME-WATER). The flag table and
// its value parsers live in `probe-runtime-args.mjs`, the three refusal
// decisions in `probe-runtime-decisions.mjs`, Edge launch and the origin
// rewrite in `probe-runtime-browser.mjs`, and the receipt builders, outcomes
// and `sha256` in `probe-runtime-receipts.mjs`. Every name they own is
// re-exported below, so no importer changed. What stays here is what the
// runtime specs mutate in this file's own source and what is the composition
// root: `parseProbeArgs` with its port-8080 refusal, capture liveness and
// `captureElement`, and `runProbe`.
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

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  DEFAULT_EDGE_SLOT_LOCK_PATH,
  EDGE_SLOT_STALE_AFTER_MS,
  acquireEdgeSlot,
  decideEdgeSlot,
  withEdgeSlot,
} from "./probe-edge-slot.mjs";
import {
  appendLifecycleDiagnostics,
  failureState,
  probeRefusalRecord,
  projectLifecycleFailures,
} from "./probe-lifecycle-diagnostics.mjs";
import {
  assessLifecycleFailure,
  describeBrowserCloses,
  runDescriptorUnderLifecycle,
} from "./probe-lifecycle-run.mjs";
import { resolveProbeLocations } from "./probe-output-location.mjs";
import {
  PROBE_EXIT_CODES,
  ProbeRefusal,
  acceptedDecision,
  exitCodeForOutcome,
  refusedDecision,
  throwForDecision,
} from "./probe-refusal.mjs";
import {
  CORE_OPTION_DEFAULTS,
  CORE_OPTION_SPECS,
  REQUIRED_SERVED_ARTIFACTS,
  RENDERERS,
  isoInstant,
  nonNegativeNumber,
  optionValue,
  positiveInteger,
  rendererList,
} from "./probe-runtime-args.mjs";
import {
  EDGE_LAUNCH_ARGS,
  installSandcastle2OriginRewrite,
  launchEdge,
} from "./probe-runtime-browser.mjs";
import {
  decideOriginRefusal,
  decideRenderReadyRefusal,
  decideServedBuildRefusal,
} from "./probe-runtime-decisions.mjs";
import {
  INCIDENT_ARTIFACT_SUFFIX,
  RUN_OUTCOMES,
  assembleReceipt,
  buildIncidentRecord,
  buildMarkdownSummary,
  buildRuntimeReceipt,
  normalizeJson,
  outcomeOfRun,
  reportFileNameFor,
  sha256,
} from "./probe-runtime-receipts.mjs";
import {
  SCENE_FRAME_DRIVER_GLOBAL,
  SCENE_FRAME_OUTCOMES,
  driveSceneFrames,
  installSceneFrameDriver,
} from "./probe-scene-frames.mjs";
import { preflightServedBuildArtifacts } from "./served-build-preflight.mjs";

export {
  CORE_OPTION_DEFAULTS,
  CORE_OPTION_SPECS,
  DEFAULT_EDGE_SLOT_LOCK_PATH,
  EDGE_LAUNCH_ARGS,
  EDGE_SLOT_STALE_AFTER_MS,
  INCIDENT_ARTIFACT_SUFFIX,
  PROBE_EXIT_CODES,
  ProbeRefusal,
  RENDERERS,
  REQUIRED_SERVED_ARTIFACTS,
  RUN_OUTCOMES,
  SCENE_FRAME_DRIVER_GLOBAL,
  SCENE_FRAME_OUTCOMES,
  acceptedDecision,
  acquireEdgeSlot,
  assembleReceipt,
  buildIncidentRecord,
  buildMarkdownSummary,
  buildRuntimeReceipt,
  decideEdgeSlot,
  decideOriginRefusal,
  decideRenderReadyRefusal,
  decideServedBuildRefusal,
  driveSceneFrames,
  exitCodeForOutcome,
  installSandcastle2OriginRewrite,
  installSceneFrameDriver,
  launchEdge,
  normalizeJson,
  outcomeOfRun,
  refusedDecision,
  reportFileNameFor,
  sha256,
  throwForDecision,
  withEdgeSlot,
};

// ---------------------------------------------------------------------------
// 1. Argument parsing (flag table and value parsers: probe-runtime-args.mjs)
// ---------------------------------------------------------------------------

/**
 * Parse a probe's command line against the core flags plus whatever the probe
 * declares. Malformed input throws a `TypeError` (a caller error, exit 2);
 * only a governance violation refuses (exit 3).
 *
 * @param {string[]} argv Arguments after the script name.
 * @param {object} [options] Parse options.
 * @param {object} [options.defaults] Per-probe overrides of {@link CORE_OPTION_DEFAULTS}.
 * @param {Array<{flag: string, key: string, kind: string}>} [options.extraOptions] Probe-declared flags.
 * @param {Function} [options.finalize] `(parsed, {explicit}) => object`: a
 *   default that depends on other flags (the landing probe's identity cells
 *   default to two runs); `explicit` is the set of keys the command line set.
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
  const explicit = new Set();

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const spec = byFlag.get(arg);
    if (spec === undefined) {
      throw new TypeError(`unknown argument: ${arg}`);
    }
    explicit.add(spec.key);
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
    } else if (spec.kind === "iso-instant") {
      parsed[spec.key] = isoInstant(raw, arg);
    } else if (spec.kind === "string") {
      parsed[spec.key] = raw;
    } else {
      throw new TypeError(
        `${arg} declares an unknown option kind: ${spec.kind}`,
      );
    }
  }

  if (typeof options.finalize === "function") {
    const finalized = options.finalize(
      { ...parsed },
      { explicit: new Set(explicit) },
    );
    if (finalized === null || typeof finalized !== "object") {
      throw new TypeError("descriptor.args.finalize must return an object");
    }
    Object.assign(parsed, finalized);
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
// 2. Capture liveness and element capture
// ---------------------------------------------------------------------------

/**
 * The page-side half of the liveness question. Self-contained, because
 * `page.evaluate` serialises its source; the marker comment lets a stub page
 * dispatch on it.
 *
 * `window.__webgpuGate` is the gate `Tools/lib/webgpu-error-gate.mjs` installs
 * and arms on the scene's device. The gate exists from the init script on, but
 * only a gate that armed a device can see a loss, so a gate that armed nothing
 * is reported exactly like a page with no gate rather than read as a live
 * device.
 *
 * @returns {{gateArmed: boolean, deviceLost: string|null, frameNumber: number|null}} What the page says.
 */
function pageReadCaptureLiveness() {
  // __captureLiveness
  const root = globalThis;
  const gate = root.__webgpuGate;
  const viewer =
    root.viewer ?? root.webgpuViewer ?? root.webglViewer ?? root.__viewer;
  const frameNumber = viewer?.scene?.frameState?.frameNumber;
  return {
    gateArmed: (gate?.armedDevices ?? 0) > 0,
    deviceLost: gate?.deviceLost ?? null,
    frameNumber: typeof frameNumber === "number" ? frameNumber : null,
  };
}

/**
 * The gate formats a loss as `device lost: reason=<reason> …`. `destroyed` is
 * the orderly `viewer.destroy()` path, which is teardown and not a fault.
 */
const DEVICE_LOSS_TEARDOWN = /\breason=destroyed\b/;

/**
 * Decide whether a page that reported `liveness` may have a frame banked.
 *
 * A lost device does not stop the canvas from answering a screenshot: it hands
 * back the last frame the device drew, under whatever label the probe asks
 * for. The only place that difference is visible is the gate, so the gate is
 * asked at the seam, every time, before anything reaches the disk. The
 * refusal exits 3: the run's precondition (a device that draws) failed, which
 * is the table's REFUSAL tier, not a harness that threw.
 *
 * The returned decision also carries `state` — `live`, `teardown`,
 * `unobserved` (no armed gate on the page) or `lost` — which the capture record
 * publishes, so a receipt says whether liveness was actually confirmed.
 *
 * @param {{gateArmed?: boolean, deviceLost?: string|null, frameNumber?: number|null}|null} liveness What the page reported.
 * @param {object} [context] Folded into a refusal's details: `name`, `frameIndex`, `lastLiveSerial`.
 * @returns {object} An accepted or refusing decision with its `state`.
 */
export function decideCaptureLiveness(liveness, context = {}) {
  const deviceLost = liveness?.deviceLost ?? null;
  if (deviceLost) {
    if (DEVICE_LOSS_TEARDOWN.test(String(deviceLost))) {
      return { ...acceptedDecision(), state: "teardown" };
    }
    return {
      ...refusedDecision("capture-device-lost", {
        ...context,
        deviceLost: String(deviceLost),
        observedSerial: liveness?.frameNumber ?? null,
      }),
      state: "lost",
    };
  }
  if (liveness?.gateArmed !== true) {
    return { ...acceptedDecision(), state: "unobserved" };
  }
  return { ...acceptedDecision(), state: "live" };
}

/**
 * Raise {@link decideCaptureLiveness}'s refusal with a message naming the
 * capture and quoting the gate. Shared by the seam and by a probe that reads
 * the gate between captures, so both refuse in the same words.
 *
 * @param {object|null} liveness What the page reported.
 * @param {{name: string, frameIndex?: number, lastLiveSerial?: number|null}} context What is being banked.
 * @returns {object} The accepted decision, when there was nothing to refuse.
 */
export function throwIfDeviceLost(liveness, context) {
  const decision = decideCaptureLiveness(liveness, context);
  throwForDecision(
    decision,
    `"${context.name}" was not banked: the page reports ${decision.details?.deviceLost}. ` +
      "A lost device still answers a screenshot with the last frame it drew, so " +
      "anything captured now is a picture of an earlier frame under this label " +
      `(last live frame serial: ${context.lastLiveSerial ?? "none observed"}).`,
  );
  return decision;
}

/**
 * Per-page capture history: how many frames the seam has banked from the page
 * and the frame serial of the last one confirmed live. Weakly held, so a
 * closed page takes its history with it.
 */
const captureHistory = new WeakMap();

async function readCaptureLiveness(page) {
  // A handle that cannot evaluate cannot be asked; `unobserved` says so.
  if (typeof page.evaluate !== "function") {
    return null;
  }
  return page.evaluate(pageReadCaptureLiveness);
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
 * NOTHING IS WRITTEN UNTIL THE FRAME HAS BEEN ACCEPTED. The screenshot is
 * taken into memory, the page is asked whether its device is still alive, and
 * a declared control is compared by digest; only then do the bytes reach the
 * disk. A frame refused after it was written would already sit in the output
 * directory under a valid-looking label, which is the failure being prevented.
 *
 * @param {object} options Options.
 * @param {object} options.page The Playwright page.
 * @param {string} [options.selector] CSS selector; defaults to the scene canvas.
 * @param {number} [options.index] Which match to take when several are expected.
 * @param {string} options.name Capture name, used for the file and the record.
 * @param {string} options.outputDirectory Where the PNG is written.
 * @param {Array<object>} [options.captures] Sink the record is appended to.
 * @param {{name: string, sha256: string}} [options.pairedWith] The treatment
 *   capture this one is the control for. Byte-identical bytes mean no frame
 *   was drawn between the two, and the capture refuses.
 * @returns {Promise<{name: string, path: string, byteLength: number, sha256: string, matchCount: number, liveness: object, buffer: Buffer}>} The capture.
 */
export async function captureElement({
  page,
  selector = "canvas",
  index,
  name,
  outputDirectory,
  captures,
  pairedWith,
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
  const target = index === undefined ? locator : locator.nth(index);
  const buffer = await target.screenshot({ type: "png" });

  let history = captureHistory.get(page);
  if (history === undefined) {
    history = { banked: 0, lastLiveSerial: null };
    captureHistory.set(page, history);
  }
  const liveness = await readCaptureLiveness(page);
  const livenessDecision = throwIfDeviceLost(liveness, {
    name,
    frameIndex: history.banked,
    lastLiveSerial: history.lastLiveSerial,
  });

  const digest = sha256(buffer);
  if (pairedWith && pairedWith.sha256 === digest) {
    throw new ProbeRefusal(
      "capture-frame-not-redrawn",
      `"${name}" is byte-identical to its treatment "${pairedWith.name}" (sha256 ${digest}): ` +
        "no frame was drawn between them, so the pair measures nothing.",
      {
        treatment: pairedWith.name,
        control: name,
        sha256: digest,
        frameIndex: history.banked,
        lastLiveSerial: history.lastLiveSerial,
      },
    );
  }

  fs.mkdirSync(outputDirectory, { recursive: true });
  const file = path.join(outputDirectory, `${name}.png`);
  fs.writeFileSync(file, buffer);
  const frameNumber = liveness?.frameNumber ?? null;
  history.banked += 1;
  if (livenessDecision.state === "live" && frameNumber !== null) {
    history.lastLiveSerial = frameNumber;
  }
  const record = {
    name,
    path: file,
    byteLength: buffer.byteLength,
    sha256: digest,
    matchCount: count,
    liveness: { state: livenessDecision.state, frameNumber },
  };
  if (Array.isArray(captures)) {
    captures.push(record);
  }
  return { ...record, buffer };
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
 * The artifacts a descriptor's served-build preflight must match. A static
 * array (or nothing, for the runtime default) is returned as declared; a
 * function is called with the parsed options, because some probes load a
 * heavier page only for some cells and must not demand its files otherwise.
 *
 * @param {{name: string, servedArtifacts?: string[]|Function}} descriptor
 * @param {object} options The parsed probe options.
 * @returns {string[]} The artifact list.
 * @throws {TypeError} When a function descriptor returns anything but a non-empty array.
 */
function resolveServedArtifacts(descriptor, options) {
  const declared = descriptor.servedArtifacts;
  if (typeof declared !== "function") {
    return declared ?? REQUIRED_SERVED_ARTIFACTS;
  }
  const resolved = declared(options);
  if (!Array.isArray(resolved) || resolved.length === 0) {
    throw new TypeError(
      `${descriptor.name}: descriptor.servedArtifacts must return a non-empty array, got ${Array.isArray(resolved) ? "an empty array" : Object.prototype.toString.call(resolved)}`,
    );
  }
  return resolved;
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
 * @param {string[]|Function} [descriptor.servedArtifacts] Artifacts the preflight must match: an array, or `(options) => string[]` called once with the parsed options for a probe whose artifact list depends on its flags. A function returning a non-array or an empty array is a probe error.
 * @param {string[]} [descriptor.launchArgs] Edge flags instead of {@link EDGE_LAUNCH_ARGS}; recorded in the runtime receipt.
 * @param {"probe-owned"|"runtime"} [descriptor.receiptEnvelope] Receipt shape.
 * @param {Function} [descriptor.workBudgetMs] `(options) => number` — the positive safe-integer milliseconds THIS probe's work needs per run. Declaring it is the opt-in to the lifecycle: `cells` is then additionally handed `scope`, and the run carries a derived orderly deadline. Omitting it keeps the pre-adoption behaviour exactly.
 * @param {Function} descriptor.cells Called once per run; returns an ARRAY of that run's cells (wrap a single cell as `[cell]`).
 * @param {Function} [descriptor.receipt] `(cells, context) => object` — the probe's fields.
 * @param {Function} [descriptor.verdicts] `(cells, context) => Array` — the probe's verdicts.
 * @param {Function} [descriptor.summary] `(receipt, runtimeReceipt) => string`.
 * @param {object} [dependencies] Injection seams for tests.
 * @param {Function} [dependencies.lifecycle] Lifecycle implementation; lifecycle path only.
 * @param {object} [dependencies.lifecycleDependencies] Lifecycle timer/exit/slot seams; lifecycle path only.
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
    lifecycle,
    lifecycleDependencies,
  } = dependencies;

  // The whole staging turns on this one predicate. A descriptor that declares
  // the field with a BAD value — zero, a float, a string, a function returning
  // one of those — reaches `deriveLifecycleDeadline` and is told so, rather
  // than falling silently back onto the pre-adoption path and running with no
  // deadline at all.
  //
  // An explicit `workBudgetMs: undefined` reads as ABSENT here, which is the
  // idiomatic JS reading (`??`, default parameters and `JSON.stringify` all
  // agree) and is deliberate rather than overlooked. `Object.hasOwn` would
  // catch that case and introduce its mirror image: a key arriving from a
  // prototype or from a spread whose config omitted the budget would be forced
  // onto the lifecycle and killed, which is a loud failure for a probe that did
  // nothing wrong. Neither reading is obviously right and no descriptor in the
  // tree exhibits either shape, so the choice is recorded rather than made
  // twice — `C13-42a-3` in `DEFERRED_WORK.md`, to be settled by whoever
  // migrates the eighteen legacy probes and actually sees which shape occurs.
  const lifecycleAdopted = descriptor.workBudgetMs !== undefined;
  // `complete` and `closes` are what lets a browser that lingers after all
  // the work is done be recorded rather than treated as a failed run; see
  // `probe-lifecycle-run.mjs`.
  const lifecycleState = {
    slot: null,
    verdicts: [],
    complete: false,
    closes: [],
  };
  let finishedExitCode = null;
  let lifecycleFailures = Object.freeze([]);

  let refusal = null;
  let errored = false;
  let errorText = null;
  let slot = null;
  let releasableSlot = null;
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
    // Never cwd: the default root is the checkout holding the kit, and an
    // output outside it needs an explicit `--repository-root` (specs pass one).
    ({ repositoryRoot, outputDirectory } = resolveProbeLocations({
      repositoryRoot: options.repositoryRoot,
      repositoryRootOverride,
      outputDirectory: options.outputDirectory,
      outputSubdirectory: descriptor.outputSubdirectory ?? descriptor.name,
    }));
    origin = `http://localhost:${options.port}`;

    // Shared by both paths so the served-build assertion cannot drift between
    // them: the lifecycle runs it inside its first tracked operation, the
    // pre-adoption path runs it inline, and it is the same code either way.
    const runServedBuildPreflight = async () => {
      // Resolved once, so the list handed to the preflight and the list the
      // decision requires cannot disagree.
      const servedArtifacts = resolveServedArtifacts(descriptor, options);
      if (options.servedBuild) {
        preflight = await preflightImpl({
          origin,
          repositoryRoot,
          artifacts: [...servedArtifacts],
        });
      }
      throwForDecision(
        decideServedBuildRefusal(preflight, {
          requiredArtifacts: servedArtifacts,
          waived: !options.servedBuild,
        }),
        "the served bytes are not the bytes on disk; rebuild, or restart the server with --serve-built",
      );
    };

    if (lifecycleAdopted) {
      await runDescriptorUnderLifecycle({
        descriptor,
        options,
        origin,
        outputDirectory,
        repositoryRoot,
        captures,
        cells,
        launchArgs,
        edgeSlotLockPath: path.join(
          repositoryRoot,
          DEFAULT_EDGE_SLOT_LOCK_PATH,
        ),
        preflight: runServedBuildPreflight,
        launch,
        chromium,
        ...(lifecycle === undefined ? {} : { lifecycle }),
        lifecycleDependencies,
        now,
        finalizeOnHardStop: finishRun,
        state: lifecycleState,
      });
    } else {
      await runServedBuildPreflight();

      releasableSlot = acquireEdgeSlot({
        lockPath: path.join(repositoryRoot, DEFAULT_EDGE_SLOT_LOCK_PATH),
        owner: descriptor.name,
        now: now(),
      });
      slot = releasableSlot;

      for (let run = 0; run < options.runs; run++) {
        // One browser PER RUN. A repeat that reuses the previous browser
        // inherits its warm shader cache, which is exactly the confound every
        // cold-start and first-frame measurement in this fork exists to avoid.
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
          // raised after the Edge slot had been taken and the measurements
          // made. That is how AR-752's acceptance leg was lost on 2026-09-05.
          // The contract is checked here so the violation names itself.
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
        ? (descriptor.verdicts(cells, { options, origin, outputDirectory }) ??
          [])
        : [];
    }
  } catch (error) {
    // The pre-adoption path catches what the descriptor threw, one call away,
    // and `String(error?.stack ?? error)` is the right description of it. A
    // lifecycle rejects with an AGGREGATE of everything the run accumulated,
    // and stringifying that reports the aggregate's own one-line message while
    // discarding the occurrences — so the lifecycle path projects them instead.
    // A browser that outlived its close deadline AFTER every run's cells and
    // verdicts were complete is a teardown problem: the run publishes, and the
    // runtime receipt's `browserCloses` carries the close.
    const lingeringClose =
      lifecycleAdopted && assessLifecycleFailure(error, lifecycleState);
    const lifecycleRefusal =
      lifecycleAdopted && !lingeringClose ? probeRefusalRecord(error) : null;
    if (lingeringClose) {
      process.stderr.write(
        `${descriptor.name}: a browser close outlived its deadline after the work completed; the run is published and the close is in the receipt\n`,
      );
    } else if (lifecycleRefusal !== null) {
      refusal = lifecycleRefusal;
    } else if (!lifecycleAdopted && error instanceof ProbeRefusal) {
      refusal = {
        reason: error.reason,
        message: error.message,
        details: error.details,
      };
    } else if (lifecycleAdopted) {
      errored = true;
      refusal = null;
      lifecycleFailures = projectLifecycleFailures(error);
      errorText = appendLifecycleDiagnostics(
        failureState(error, "probe runtime").description,
        error,
        lifecycleFailures,
      );
      process.stderr.write(`${descriptor.name}: ${errorText}\n`);
    } else {
      errored = true;
      refusal = null;
      errorText = String(error?.stack ?? error);
      process.stderr.write(`${descriptor.name}: ${errorText}\n`);
    }
  } finally {
    // Only the pre-adoption path releases here. On the lifecycle path the slot
    // is owned by `scope.withEdgeSlot`, which has already released it and
    // published whether the release actually settled.
    if (releasableSlot) {
      releasableSlot.release();
    }
  }

  return finishRun();

  // Everything after the lifecycle: the exit code, the receipt or the incident.
  // A function, and run at most once, because the lifecycle's hard stop calls
  // it too when only a lingering browser kept a complete run from finishing.
  function finishRun() {
    if (finishedExitCode !== null) {
      return finishedExitCode;
    }
    if (lifecycleAdopted) {
      slot = lifecycleState.slot;
      verdicts = lifecycleState.verdicts;
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
    if (lifecycleState.closes.length > 0) {
      runtimeReceipt.browserCloses = describeBrowserCloses(lifecycleState, now);
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
      const fields = descriptor.receipt
        ? descriptor.receipt(cells, context)
        : {};
      const envelope = descriptor.receiptEnvelope ?? "probe-owned";
      const receipt = assembleReceipt({
        envelope,
        fields,
        runtime: runtimeReceipt,
      });
      if (outputDirectory) {
        fs.mkdirSync(outputDirectory, { recursive: true });
        writeFile(
          path.join(outputDirectory, reportFileNameFor(descriptor)),
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
      const incidentRecord = buildIncidentRecord({
        outcome,
        runtimeReceipt,
        error: errorText,
      });
      // Only present when a lifecycle actually accumulated occurrences, so a
      // pre-adoption probe's incident record keeps exactly the fields it had.
      if (lifecycleFailures.length > 0) {
        incidentRecord.lifecycleFailures = lifecycleFailures;
      }
      writeFile(incidentPath, normalizeJson(incidentRecord));
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
    finishedExitCode = exitCode;
    return exitCode;
  }
}
