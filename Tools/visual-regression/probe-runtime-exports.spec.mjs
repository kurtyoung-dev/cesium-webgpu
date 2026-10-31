// probe-runtime-exports.spec.mjs - export parity of lib/probe-runtime.mjs after its decomposition (DX-KIT-DECOMPOSE-RUNTIME-WATER). Pure Node: no browser, no GPU.
// @purpose Pins that lib/probe-runtime.mjs still exports exactly the 40 names it exported before it was split into probe-runtime-{args,decisions,browser,receipts}.mjs, and that every moved name is the SAME binding as the companion that now owns it, so no importer of the runtime could tell the split happened.
// @status ACTIVE
//
// WHY A SPEC FOR A PURE MOVE. A decomposition changes no behaviour, so the
// behaviour specs stay green whether or not a re-export was lost: a probe that
// imports one name the runtime stopped re-exporting fails at its own import,
// which is a runtime failure in a browser session, not a spec failure. This
// spec is the one place that fails when the runtime's public surface drifts.
// The list below is the surface at 566ad99447, before the split; a name added
// to the runtime later is a deliberate edit to this list.
//
// INERTNESS. The mutant imports the runtime from a copy of its source with one
// re-export dropped and requires the parity check to report exactly that name,
// while the unmutated runtime reports nothing.

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { importMutated } from "./lib/import-mutated.mjs";
import * as runtime from "./lib/probe-runtime.mjs";
import * as args from "./lib/probe-runtime-args.mjs";
import * as browser from "./lib/probe-runtime-browser.mjs";
import * as decisions from "./lib/probe-runtime-decisions.mjs";
import * as receipts from "./lib/probe-runtime-receipts.mjs";
import * as edgeSlot from "./lib/probe-edge-slot.mjs";
import * as refusal from "./lib/probe-refusal.mjs";
import * as sceneFrames from "./lib/probe-scene-frames.mjs";
import { DEFAULT_SERVED_BUILD_ARTIFACTS } from "./lib/served-build-preflight.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_PATH = path.join(HERE, "lib", "probe-runtime.mjs");

/** The runtime's public surface before the split, sorted. */
const BASE_EXPORTS = Object.freeze([
  "CORE_OPTION_DEFAULTS",
  "CORE_OPTION_SPECS",
  "DEFAULT_EDGE_SLOT_LOCK_PATH",
  "EDGE_LAUNCH_ARGS",
  "EDGE_SLOT_STALE_AFTER_MS",
  "INCIDENT_ARTIFACT_SUFFIX",
  "PROBE_EXIT_CODES",
  "ProbeRefusal",
  "RENDERERS",
  "REQUIRED_SERVED_ARTIFACTS",
  "RUN_OUTCOMES",
  "SCENE_FRAME_DRIVER_GLOBAL",
  "SCENE_FRAME_OUTCOMES",
  "acceptedDecision",
  "acquireEdgeSlot",
  "assembleReceipt",
  "buildIncidentRecord",
  "buildMarkdownSummary",
  "buildRuntimeReceipt",
  "captureElement",
  "decideCaptureLiveness",
  "decideEdgeSlot",
  "decideOriginRefusal",
  "decideRenderReadyRefusal",
  "decideServedBuildRefusal",
  "driveSceneFrames",
  "exitCodeForOutcome",
  "installSandcastle2OriginRewrite",
  "installSceneFrameDriver",
  "isEntryPoint",
  "launchEdge",
  "normalizeJson",
  "outcomeOfRun",
  "parseProbeArgs",
  "refusedDecision",
  "runProbe",
  "sha256",
  "throwForDecision",
  "throwIfDeviceLost",
  "withEdgeSlot",
]);

/** Which companion owns which re-exported names. */
const OWNERS = Object.freeze([
  [
    "probe-runtime-args.mjs",
    args,
    [
      "CORE_OPTION_DEFAULTS",
      "CORE_OPTION_SPECS",
      "RENDERERS",
      "REQUIRED_SERVED_ARTIFACTS",
    ],
  ],
  [
    "probe-runtime-decisions.mjs",
    decisions,
    [
      "decideOriginRefusal",
      "decideRenderReadyRefusal",
      "decideServedBuildRefusal",
    ],
  ],
  [
    "probe-runtime-browser.mjs",
    browser,
    ["EDGE_LAUNCH_ARGS", "installSandcastle2OriginRewrite", "launchEdge"],
  ],
  [
    "probe-runtime-receipts.mjs",
    receipts,
    [
      "INCIDENT_ARTIFACT_SUFFIX",
      "RUN_OUTCOMES",
      "assembleReceipt",
      "buildIncidentRecord",
      "buildMarkdownSummary",
      "buildRuntimeReceipt",
      "normalizeJson",
      "outcomeOfRun",
      "sha256",
    ],
  ],
  [
    "probe-edge-slot.mjs",
    edgeSlot,
    [
      "DEFAULT_EDGE_SLOT_LOCK_PATH",
      "EDGE_SLOT_STALE_AFTER_MS",
      "acquireEdgeSlot",
      "decideEdgeSlot",
      "withEdgeSlot",
    ],
  ],
  [
    "probe-refusal.mjs",
    refusal,
    [
      "PROBE_EXIT_CODES",
      "ProbeRefusal",
      "acceptedDecision",
      "exitCodeForOutcome",
      "refusedDecision",
      "throwForDecision",
    ],
  ],
  [
    "probe-scene-frames.mjs",
    sceneFrames,
    [
      "SCENE_FRAME_DRIVER_GLOBAL",
      "SCENE_FRAME_OUTCOMES",
      "driveSceneFrames",
      "installSceneFrameDriver",
    ],
  ],
]);

/**
 * Compare a runtime namespace with the base surface and the companions.
 *
 * @param {object} namespace The runtime module namespace under test.
 * @returns {{missing: string[], extra: string[], notSame: string[]}} The drift.
 */
function surfaceDrift(namespace) {
  const actual = Object.keys(namespace).sort();
  const missing = BASE_EXPORTS.filter((name) => !actual.includes(name));
  const extra = actual.filter((name) => !BASE_EXPORTS.includes(name));
  const notSame = [];
  for (const [, owner, names] of OWNERS) {
    for (const name of names) {
      if (namespace[name] !== owner[name]) {
        notSame.push(name);
      }
    }
  }
  return { missing, extra, notSame };
}

test("the runtime exports exactly the 40 names it exported before the split", () => {
  assert.equal(BASE_EXPORTS.length, 40);
  assert.deepEqual([...BASE_EXPORTS].sort(), [...BASE_EXPORTS]);
  assert.deepEqual(Object.keys(runtime).sort(), [...BASE_EXPORTS]);
});

test("every moved name is the same binding as its companion's", () => {
  assert.deepEqual(surfaceDrift(runtime), {
    missing: [],
    extra: [],
    notSame: [],
  });
  assert.equal(
    runtime.REQUIRED_SERVED_ARTIFACTS,
    DEFAULT_SERVED_BUILD_ARTIFACTS,
    "the served-artifact list stays a re-export of the preflight library's, never a copy",
  );
});

test("the names that stayed in the runtime are functions it defines itself", () => {
  for (const name of [
    "captureElement",
    "decideCaptureLiveness",
    "isEntryPoint",
    "parseProbeArgs",
    "runProbe",
    "throwIfDeviceLost",
  ]) {
    assert.equal(typeof runtime[name], "function", name);
  }
});

test("the four value parsers are not part of the runtime's public surface", () => {
  for (const name of [
    "optionValue",
    "positiveInteger",
    "nonNegativeNumber",
    "rendererList",
  ]) {
    assert.equal(
      typeof args[name],
      "function",
      `${name} lives in the args piece`,
    );
    assert.equal(Object.hasOwn(runtime, name), false, name);
  }
});

test("MUTANT (inertness): a runtime that drops one re-export is reported by name", async () => {
  const mutated = await importMutated(RUNTIME_PATH, [
    [
      "  sha256,\n  throwForDecision,\n  withEdgeSlot,\n};",
      "  throwForDecision,\n  withEdgeSlot,\n};",
    ],
  ]);
  assert.equal(
    Object.hasOwn(mutated, "sha256"),
    false,
    "the mutant must lose sha256, otherwise the parity check below proves nothing",
  );
  assert.deepEqual(surfaceDrift(mutated), {
    missing: ["sha256"],
    extra: [],
    notSame: ["sha256"],
  });
  assert.deepEqual(surfaceDrift(runtime), {
    missing: [],
    extra: [],
    notSame: [],
  });
});
