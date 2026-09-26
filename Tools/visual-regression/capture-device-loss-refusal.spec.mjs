// capture-device-loss-refusal.spec.mjs — the capture seam refuses a frame the
// device never drew, and a probe run ends on it instead of banking it.
// Pure Node: no browser, no GPU, no build, no network. Every filesystem write
// lands under `os.tmpdir()`.
//
// @purpose Drives captureElement and the cloud march mechanism probe with stub pages to pin that a lost WebGPU device or a control byte-identical to its treatment is refused by name before any bytes are written, ends the run with exit 3, and keeps the arms already banked.
// @status ACTIVE
//
// WHAT A LOST DEVICE LOOKS LIKE FROM THE PROBE'S SIDE. Nothing throws. The
// canvas keeps answering screenshots with the last frame the device drew, the
// console gate stays empty, and every later capture lands on disk under its
// own label with a valid-looking manifest line. The only settled record of the
// loss is `window.__webgpuGate.deviceLost`, which `Tools/lib/webgpu-error-gate.mjs`
// writes from the device's `lost` promise. So the rows below are written as
// behaviour against a page that SAYS its device is gone, and each asks what
// reached the disk — not what the source text contains.
//
// EACH ROW IS A FUNCTION OF ITS SUBJECTS. The same row runs against the real
// runtime and probe, where it must pass, and against copies with one guard made
// unreachable, where the rows that guard exists for must fail. A row that
// passes under its own guard's mutant is not a check of that guard.

import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as realRuntime from "./lib/probe-runtime.mjs";
import {
  armDialSets,
  descriptor as realDescriptor,
} from "./probe-cloud-march-mechanism.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_PATH = path.join(HERE, "lib", "probe-runtime.mjs");
const PROBE_PATH = path.join(HERE, "probe-cloud-march-mechanism.mjs");

const LOST =
  "[webgpu] device lost: reason=unknown message=DXGI_ERROR_DEVICE_HUNG";
const DESTROYED = "[webgpu] device lost: reason=destroyed message=";

/** The guard the refusal lives behind, and its inert form. */
const GUARD_ANCHOR = "  if (deviceLost) {";
const GUARD_MUTANT = "  if (false && deviceLost) {";
const PAIR_ANCHOR = "  if (pairedWith && pairedWith.sha256 === digest) {";
const PAIR_MUTANT =
  "  if (false && pairedWith && pairedWith.sha256 === digest) {";
const READ_ANCHOR = "  const liveness = await readCaptureLiveness(page);";
const READ_MUTANT = "  const liveness = null;";
const ARMED_ANCHOR = "    gateArmed: (gate?.armedDevices ?? 0) > 0,";
const ARMED_MUTANT = "    gateArmed: gate !== undefined && gate !== null,";

// ---------------------------------------------------------------------------
// Subjects: the real modules, or copies with one line replaced
// ---------------------------------------------------------------------------

function readNormalized(file) {
  return readFileSync(file, "utf8").replace(/\r\n/g, "\n");
}

function replaceOnce(source, anchor, replacement) {
  const occurrences = source.split(anchor).length - 1;
  assert.equal(
    occurrences,
    1,
    `mutation anchor must occur exactly once, found ${occurrences}: ${anchor}`,
  );
  return source.replace(anchor, replacement);
}

function dataUrl(source) {
  return `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
}

/**
 * Load the runtime with `replacements` applied, and the probe re-pointed at
 * THAT runtime, so the probe's refusals and `runProbe`'s classification of
 * them come from the same module instance.
 *
 * @param {Array<[string, string]>} replacements Runtime anchor/replacement pairs.
 * @returns {Promise<{runtime: object, descriptor: object}>} The subjects.
 */
async function mutatedSubjects(replacements) {
  const libBase = pathToFileURL(path.dirname(RUNTIME_PATH) + path.sep).href;
  let runtimeSource = readNormalized(RUNTIME_PATH).replaceAll(
    'from "./',
    `from "${libBase}`,
  );
  for (const [anchor, replacement] of replacements) {
    runtimeSource = replaceOnce(runtimeSource, anchor, replacement);
  }
  const runtimeUrl = dataUrl(runtimeSource);

  const probeBase = pathToFileURL(HERE + path.sep).href;
  const toolsBase = pathToFileURL(path.dirname(HERE) + path.sep).href;
  let probeSource = replaceOnce(
    readNormalized(PROBE_PATH),
    'from "./lib/probe-runtime.mjs"',
    `from "${runtimeUrl}"`,
  );
  probeSource = probeSource
    .replaceAll('from "./', `from "${probeBase}`)
    .replaceAll('from "../', `from "${toolsBase}`);

  const runtime = await import(runtimeUrl);
  const { descriptor } = await import(dataUrl(probeSource));
  return { runtime, descriptor };
}

const REAL = { runtime: realRuntime, descriptor: realDescriptor };

// ---------------------------------------------------------------------------
// Stub pages
// ---------------------------------------------------------------------------

function makeTempRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "capture-device-loss-"));
  assert.ok(
    root.startsWith(tmpdir()),
    "the spec's sandbox must live under os.tmpdir()",
  );
  return root;
}

function listing(directory) {
  return existsSync(directory) ? readdirSync(directory).sort() : [];
}

/**
 * A page that answers the seam's liveness read with `state.liveness` and
 * every screenshot with `state.bytes`. A screenshot handed a `path` writes
 * there, the way Playwright's does, so a seam that let Playwright write the
 * file before deciding would be caught by the directory, not by a flag.
 */
function seamPage(state) {
  const calls = [];
  const shoot = async (opts) => {
    calls.push({ shot: opts ?? null });
    if (opts?.path) {
      writeFileSync(opts.path, state.bytes);
    }
    return state.bytes;
  };
  return {
    calls,
    async evaluate(fn) {
      const source = String(fn);
      if (source.includes("__captureLiveness")) {
        calls.push({ liveness: true });
        return state.liveness;
      }
      throw new Error(`unstubbed page.evaluate: ${source.slice(0, 120)}`);
    },
    locator() {
      return {
        count: async () => 1,
        nth: () => ({ screenshot: shoot }),
        screenshot: shoot,
      };
    },
  };
}

const live = (frameNumber) => ({
  gateArmed: true,
  deviceLost: null,
  frameNumber,
});

/**
 * A page for the mechanism probe. `script` decides, per call, what the gate
 * reports: `lostAtShot` makes the seam's liveness read report a lost device
 * from that screenshot on; `lostAfterArm` makes the gate read that follows the
 * named arm report it; `identicalPairAt` makes that arm's two frames the same
 * bytes.
 */
function mechanismPage(log, script) {
  let shot = 0;
  let lost = false;
  let currentLabel = null;
  let armCursor = -1;
  const sets = armDialSets();
  // The device's state is a fact about the page, so every read of it — the
  // seam's and the probe's own gate read — sees the same loss.
  const noteLossByShot = () => {
    if (script.lostAtShot !== undefined && shot >= script.lostAtShot) {
      lost = true;
    }
  };
  return {
    on() {},
    async addInitScript() {},
    async goto() {},
    async waitForFunction() {},
    async evaluate(fn, arg) {
      const source = String(fn);
      if (source.includes("__captureLiveness")) {
        noteLossByShot();
        return {
          gateArmed: true,
          deviceLost: lost ? LOST : null,
          frameNumber: 100 + shot,
        };
      }
      if (source.includes("__mechanismInstallNamespace")) {
        return { ok: true, source: "module", moduleUrl: arg };
      }
      if (source.includes("__mechanismBuildScene")) {
        return {
          ok: true,
          renderLoopDisabled: true,
          cloudDials: {},
          baseline: { near: 0.1, far: 1e10 },
        };
      }
      if (source.includes("__mechanismRunArm")) {
        if (arg.cloudsOn !== false) {
          armCursor += 1;
          currentLabel = sets[armCursor].label;
        }
        log.armsAttempted.push(
          `${currentLabel}:${arg.cloudsOn ? "on" : "off"}`,
        );
        return {
          cloudsOn: arg.cloudsOn !== false,
          dialsApplied: true,
          unappliedDials: [],
          dialReports: [],
        };
      }
      if (source.includes("cesium-viewer-toolbar")) {
        return { removed: 0 };
      }
      if (source.includes("__armWebGPUDevice")) {
        return { armed: 1, found: 1, total: 1 };
      }
      if (source.includes("__webgpuGate")) {
        noteLossByShot();
        if (script.lostAfterArm !== undefined) {
          const lostIndex = sets.findIndex(
            (set) => set.label === script.lostAfterArm,
          );
          if (armCursor >= lostIndex) {
            lost = true;
          }
        }
        return {
          errors: [],
          deviceLost: lost ? LOST : null,
          armedDevices: 1,
        };
      }
      throw new Error(`unstubbed page.evaluate: ${source.slice(0, 120)}`);
    },
    locator() {
      const screenshot = async (opts) => {
        log.shots.push(opts ?? null);
        shot += 1;
        const identical =
          script.identicalPairAt !== undefined &&
          currentLabel === script.identicalPairAt;
        return Buffer.from(
          identical ? `frame-${currentLabel}` : `frame-${shot}`,
        );
      };
      return {
        count: async () => 1,
        nth: () => ({ screenshot }),
        screenshot,
      };
    },
  };
}

async function driveProbe(subjects, script) {
  const root = makeTempRoot();
  const out = path.join(root, "out");
  const log = { armsAttempted: [], shots: [] };
  const code = await subjects.runtime.runProbe(subjects.descriptor, {
    argv: [
      "--repository-root",
      root,
      "--output",
      out,
      "--no-serve-built",
      "--renderer",
      "webgpu",
      "--settle-frames",
      "1",
    ],
    now: () => Date.UTC(2026, 8, 26, 3, 0, 0),
    launch: async () => ({
      async newPage() {
        return mechanismPage(log, script);
      },
      async close() {},
    }),
  });
  const refusalPath = path.join(out, "cloud-march-mechanism-refusal.json");
  const progressPath = path.join(out, "arms-so-far.json");
  return {
    root,
    out,
    code,
    log,
    refusal: existsSync(refusalPath)
      ? JSON.parse(readFileSync(refusalPath, "utf8"))
      : null,
    banked: existsSync(progressPath)
      ? JSON.parse(readFileSync(progressPath, "utf8"))
      : [],
  };
}

const png = (out, label) =>
  path.join(out, `cloud-march-mechanism-${label}.png`);

// ---------------------------------------------------------------------------
// The rows, each a function of its subjects
// ---------------------------------------------------------------------------

/**
 * GIVEN a fake page whose gate reports deviceLost = "device lost: reason=unknown …"
 * WHEN the capture seam is asked for a frame
 * THEN it throws ProbeRefusal("capture-device-lost"), the refusal carries the
 * gate's own message and the capture label, and NO file is written to the
 * output directory. The refusal happens before the bytes are written.
 */
async function rowDeviceLostRefuses({ runtime }) {
  const root = makeTempRoot();
  try {
    const out = path.join(root, "frames");
    const state = { liveness: live(41), bytes: Buffer.from("drawn") };
    const page = seamPage(state);
    await runtime.captureElement({ page, name: "arm-a", outputDirectory: out });

    state.liveness = { gateArmed: true, deviceLost: LOST, frameNumber: 41 };
    state.bytes = Buffer.from("the last frame the device drew");
    const before = listing(out);
    await assert.rejects(
      runtime.captureElement({ page, name: "arm-b", outputDirectory: out }),
      (error) => {
        assert.equal(error.name, "ProbeRefusal");
        assert.equal(error.reason, "capture-device-lost");
        assert.equal(error.exitCode, 3);
        assert.ok(error.message.includes(LOST), "the gate's own message");
        assert.ok(error.message.includes("arm-b"), "the capture label");
        assert.equal(error.details.name, "arm-b");
        assert.equal(error.details.deviceLost, LOST);
        assert.equal(
          error.details.frameIndex,
          1,
          "the frame it would have been",
        );
        assert.equal(error.details.lastLiveSerial, 41);
        return true;
      },
    );
    assert.deepEqual(listing(out), before, "a refused frame reached the disk");
    assert.ok(!existsSync(path.join(out, "arm-b.png")));
    assert.ok(
      page.calls.every((call) => !call.shot?.path),
      "the screenshot was handed a path, so the browser wrote before the seam decided",
    );
    // A fresh directory is not even created for a refused first frame.
    const fresh = path.join(root, "never");
    await assert.rejects(
      runtime.captureElement({
        page: seamPage({
          liveness: { gateArmed: true, deviceLost: LOST, frameNumber: 9 },
          bytes: Buffer.from("x"),
        }),
        name: "first",
        outputDirectory: fresh,
      }),
      { reason: "capture-device-lost" },
    );
    assert.equal(existsSync(fresh), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * GIVEN a fake page whose gate reports deviceLost = null
 * WHEN the capture seam is asked for a frame
 * THEN it returns the capture and the bytes on disk are byte-identical to the
 * scripted bytes (the guard is not merely absent-on-the-happy-path: it must be
 * REACHED and pass).
 */
async function rowLiveCaptures({ runtime }) {
  const root = makeTempRoot();
  try {
    const bytes = Buffer.from("a frame the device drew");
    const page = seamPage({ liveness: live(7), bytes });
    const captures = [];
    const record = await runtime.captureElement({
      page,
      name: "live",
      outputDirectory: root,
      captures,
    });
    assert.deepEqual(readFileSync(record.path), bytes);
    assert.equal(record.sha256, runtime.sha256(bytes));
    assert.ok(
      page.calls.some((call) => call.liveness === true),
      "the liveness read was never made",
    );
    assert.deepEqual(record.liveness, { state: "live", frameNumber: 7 });
    assert.deepEqual(captures[0].liveness, { state: "live", frameNumber: 7 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * GIVEN a fake page whose gate reports deviceLost = "… reason=destroyed"
 * WHEN the capture seam is asked for a frame during teardown
 * THEN it does NOT refuse (the normal viewer.destroy() path, per the teardown
 * note in webgpu-error-gate.mjs).
 */
async function rowTeardownDoesNotRefuse({ runtime }) {
  const root = makeTempRoot();
  try {
    const bytes = Buffer.from("teardown frame");
    const record = await runtime.captureElement({
      page: seamPage({
        liveness: { gateArmed: true, deviceLost: DESTROYED, frameNumber: 3 },
        bytes,
      }),
      name: "teardown",
      outputDirectory: root,
    });
    assert.deepEqual(readFileSync(record.path), bytes);
    assert.equal(record.liveness.state, "teardown");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * GIVEN two captures in one run whose scripted bytes are identical AND which
 * are declared a treatment/control pair
 * THEN the run refuses "capture-frame-not-redrawn", naming both labels and the
 * shared digest, and the refusal exits 3 (PROBE_EXIT_CODES.REFUSAL), never 0.
 */
async function rowIdenticalPairRefuses(subjects) {
  const { runtime } = subjects;
  const root = makeTempRoot();
  try {
    const bytes = Buffer.from("same frame twice");
    const page = seamPage({ liveness: live(5), bytes });
    const treatment = await runtime.captureElement({
      page,
      name: "on",
      outputDirectory: root,
    });
    const before = listing(root);
    await assert.rejects(
      runtime.captureElement({
        page,
        name: "off",
        outputDirectory: root,
        pairedWith: treatment,
      }),
      (error) => {
        assert.equal(error.reason, "capture-frame-not-redrawn");
        assert.equal(error.exitCode, runtime.PROBE_EXIT_CODES.REFUSAL);
        assert.equal(error.details.treatment, "on");
        assert.equal(error.details.control, "off");
        assert.equal(error.details.sha256, treatment.sha256);
        for (const text of ["on", "off", treatment.sha256]) {
          assert.ok(error.message.includes(text), `message names ${text}`);
        }
        return true;
      },
    );
    assert.deepEqual(listing(root), before, "the control reached the disk");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  const run = await driveProbe(subjects, { identicalPairAt: "M0" });
  try {
    assert.equal(run.code, runtime.PROBE_EXIT_CODES.REFUSAL);
    assert.equal(run.refusal?.refusal?.reason, "capture-frame-not-redrawn");
    const text = JSON.stringify(run.refusal);
    assert.ok(text.includes('cloud-march-mechanism-M0"'), "treatment label");
    assert.ok(text.includes("cloud-march-mechanism-M0-clouds-off"), "control");
    assert.equal(existsSync(png(run.out, "M0-clouds-off")), false);
  } finally {
    rmSync(run.root, { recursive: true, force: true });
  }
}

/**
 * GIVEN an arm that refuses for either reason
 * THEN the arms already banked survive (arms-so-far.json is written per arm)
 * and the run's exit code is 3 — asserted by driving the descriptor's error
 * path, not by reading source text.
 */
async function rowArmRefusalKeepsBankedArms(subjects, reason) {
  const sets = armDialSets();
  // The third arm refuses: the device is lost at its first screenshot, or its
  // two frames come back identical.
  const script =
    reason === "capture-device-lost"
      ? { lostAtShot: 5 }
      : { identicalPairAt: sets[2].label };
  const run = await driveProbe(subjects, script);
  try {
    assert.equal(run.code, 3, `${reason}: exit code`);
    assert.equal(run.refusal?.refusal?.reason, reason);
    assert.deepEqual(
      run.banked.map((arm) => arm.label),
      [sets[0].label, sets[1].label],
      `${reason}: the banked arms`,
    );
    for (const set of sets.slice(0, 2)) {
      assert.ok(existsSync(png(run.out, set.label)));
      assert.ok(existsSync(png(run.out, `${set.label}-clouds-off`)));
    }
    assert.equal(
      existsSync(png(run.out, `${sets[2].label}-clouds-off`)),
      false,
      `${reason}: the refused arm's control was banked`,
    );
    assert.equal(
      existsSync(path.join(run.out, "cloud-march-mechanism-report.json")),
      false,
      "a refused run wrote a receipt",
    );
  } finally {
    rmSync(run.root, { recursive: true, force: true });
  }
}

/**
 * GIVEN the gate reports deviceLost only AFTER arm N
 * THEN arms 1..N are banked and arms N+1.. are not attempted — i.e. the
 * refusal ends the run rather than being recorded per arm and ignored.
 */
async function rowLossAfterArmEndsRun(subjects) {
  const sets = armDialSets();
  const n = 2;
  const run = await driveProbe(subjects, { lostAfterArm: sets[n - 1].label });
  try {
    assert.equal(run.code, 3);
    assert.equal(run.refusal?.refusal?.reason, "capture-device-lost");
    assert.equal(run.refusal.refusal.details.armIndex, n - 1);
    assert.deepEqual(
      run.banked.map((arm) => arm.label),
      sets.slice(0, n).map((set) => set.label),
    );
    assert.equal(run.banked[n - 1].deviceGate.deviceLost, LOST);
    assert.ok(
      run.log.armsAttempted.every(
        (entry) => !entry.startsWith(`${sets[n].label}:`),
      ),
      "arm N+1 was attempted after the gate reported the device lost",
    );
  } finally {
    rmSync(run.root, { recursive: true, force: true });
  }
}

const ROWS = Object.freeze([
  ["device lost refuses before any bytes", rowDeviceLostRefuses],
  ["a live device is asked and banks the exact bytes", rowLiveCaptures],
  ["teardown does not refuse", rowTeardownDoesNotRefuse],
  [
    "an identical treatment/control pair refuses, exit 3",
    rowIdenticalPairRefuses,
  ],
  [
    "an arm lost at capture keeps the banked arms, exit 3",
    (s) => rowArmRefusalKeepsBankedArms(s, "capture-device-lost"),
  ],
  [
    "an arm whose pair is identical keeps the banked arms, exit 3",
    (s) => rowArmRefusalKeepsBankedArms(s, "capture-frame-not-redrawn"),
  ],
  ["a loss after arm N ends the run there", rowLossAfterArmEndsRun],
]);

// ---------------------------------------------------------------------------
// The rows against the real modules
// ---------------------------------------------------------------------------

test("the device-loss rows against the real runtime and probe", async (t) => {
  for (const [name, row] of ROWS) {
    await t.test(name, () => row(REAL));
  }
});

test("the decision classifies without a page", () => {
  const { decideCaptureLiveness } = realRuntime;
  assert.equal(decideCaptureLiveness(live(1)).state, "live");
  assert.equal(decideCaptureLiveness(null).state, "unobserved");
  assert.equal(
    decideCaptureLiveness({ gateArmed: false, deviceLost: null }).state,
    "unobserved",
    "a page nobody armed is not a live device",
  );
  assert.equal(
    decideCaptureLiveness({ gateArmed: true, deviceLost: DESTROYED }).state,
    "teardown",
  );
  const lost = decideCaptureLiveness(
    { gateArmed: true, deviceLost: LOST, frameNumber: 12 },
    { name: "x", frameIndex: 4, lastLiveSerial: 11 },
  );
  assert.equal(lost.refuse, true);
  assert.equal(lost.exitCode, realRuntime.PROBE_EXIT_CODES.REFUSAL);
  assert.deepEqual(lost.details, {
    name: "x",
    frameIndex: 4,
    lastLiveSerial: 11,
    deviceLost: LOST,
    observedSerial: 12,
  });
});

// ---------------------------------------------------------------------------
// The page half of the question, driven rather than stubbed
// ---------------------------------------------------------------------------

/**
 * A page whose `evaluate` runs the function it is handed against a scripted
 * `globalThis`, so the seam's own page read is what answers. The script is
 * removed again before the call returns.
 */
function scriptedGlobalPage(globals) {
  const bytes = Buffer.from("scripted frame");
  return {
    async evaluate(fn) {
      const saved = Object.keys(globals).map((key) => [
        key,
        Object.getOwnPropertyDescriptor(globalThis, key),
      ]);
      Object.assign(globalThis, globals);
      try {
        return fn();
      } finally {
        for (const [key, descriptor] of saved) {
          if (descriptor) {
            Object.defineProperty(globalThis, key, descriptor);
          } else {
            delete globalThis[key];
          }
        }
      }
    },
    locator() {
      const screenshot = async () => bytes;
      return { count: async () => 1, nth: () => ({ screenshot }), screenshot };
    },
  };
}

const gate = (armedDevices, deviceLost = null) => ({
  __webgpuGate: { errors: [], deviceLost, armedDevices },
});

const SCRIPTED_PAGES = Object.freeze({
  "no gate": {},
  // The init script defines the gate before any device exists.
  "gate installed, nothing armed": gate(0),
  "gate armed, device live": {
    ...gate(1),
    viewer: { scene: { frameState: { frameNumber: 5 } } },
  },
  "gate armed, device lost": gate(1, LOST),
});

const SCRIPTED_STATES = Object.freeze({
  "no gate": "unobserved",
  "gate installed, nothing armed": "unobserved",
  "gate armed, device live": "live",
  "gate armed, device lost": "capture-device-lost",
});

/** The liveness state, or the refusal reason, the seam records per page. */
async function scriptedPageStates({ runtime }) {
  const root = makeTempRoot();
  const states = {};
  try {
    for (const [name, globals] of Object.entries(SCRIPTED_PAGES)) {
      try {
        const record = await runtime.captureElement({
          page: scriptedGlobalPage(globals),
          name: "scripted",
          outputDirectory: root,
        });
        states[name] = record.liveness.state;
      } catch (error) {
        states[name] = error.reason ?? String(error);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  return states;
}

test("only a gate that armed a device confirms a live one", async () => {
  assert.deepEqual(await scriptedPageStates(REAL), SCRIPTED_STATES);
});

// ---------------------------------------------------------------------------
// Mutation controls: inertness, not deletion
// ---------------------------------------------------------------------------

/**
 * Run every row against `subjects` and report which ones failed. The expected
 * set is stated per mutant: a row a guard exists for must fail when that guard
 * is unreachable, and a row about a different guard must not.
 */
async function rowOutcomes(subjects) {
  const outcomes = {};
  for (const [name, row] of ROWS) {
    try {
      await row(subjects);
      outcomes[name] = "pass";
    } catch {
      outcomes[name] = "FAIL";
    }
  }
  return outcomes;
}

function expectOutcomes(outcomes, failing) {
  const expected = Object.fromEntries(
    ROWS.map(([name]) => [name, failing.includes(name) ? "FAIL" : "pass"]),
  );
  assert.deepEqual(outcomes, expected);
}

test("MUTANT `if (false && deviceLost)`: every device-loss row goes red", async () => {
  const outcomes = await rowOutcomes(
    await mutatedSubjects([[GUARD_ANCHOR, GUARD_MUTANT]]),
  );
  // The live row and the two pair rows are about other guards and stay green;
  // the teardown row goes red because the teardown reading sits inside the
  // guard, so the mutant also reports a destroyed device as live.
  expectOutcomes(outcomes, [
    "device lost refuses before any bytes",
    "teardown does not refuse",
    "an arm lost at capture keeps the banked arms, exit 3",
    "a loss after arm N ends the run there",
  ]);
});

test("MUTANT: an inert pair comparison banks the undrawn control", async () => {
  const outcomes = await rowOutcomes(
    await mutatedSubjects([[PAIR_ANCHOR, PAIR_MUTANT]]),
  );
  expectOutcomes(outcomes, [
    "an identical treatment/control pair refuses, exit 3",
    "an arm whose pair is identical keeps the banked arms, exit 3",
  ]);
});

test("MUTANT: a seam that never asks the page is caught by the live row", async () => {
  const outcomes = await rowOutcomes(
    await mutatedSubjects([[READ_ANCHOR, READ_MUTANT]]),
  );
  // With nothing read at the seam, only the probe's own after-arm gate read
  // is left to refuse, and it fires one arm late.
  expectOutcomes(outcomes, [
    "device lost refuses before any bytes",
    "a live device is asked and banks the exact bytes",
    "teardown does not refuse",
    "an arm lost at capture keeps the banked arms, exit 3",
  ]);
});

test("MUTANT: a gate that armed nothing is read as a live device", async () => {
  const states = await scriptedPageStates(
    await mutatedSubjects([[ARMED_ANCHOR, ARMED_MUTANT]]),
  );
  assert.deepEqual(states, {
    ...SCRIPTED_STATES,
    "gate installed, nothing armed": "live",
  });
});

test("the mutant loader reaches the same modules the real rows use", async () => {
  // An identity mutant must pass every row, or the red rows above could be a
  // loader failure rather than the guard.
  const identity = await mutatedSubjects([[GUARD_ANCHOR, GUARD_ANCHOR]]);
  expectOutcomes(await rowOutcomes(identity), []);
});
