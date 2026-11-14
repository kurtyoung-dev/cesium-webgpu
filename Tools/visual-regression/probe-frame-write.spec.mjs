// probe-frame-write.spec.mjs — the runtime's receipt timing, capture records,
// bankPngCapture, the shared-root frame-overwrite guard and the exported port
// decision, asserted as observable behaviour. Pure Node: no browser, no GPU, no
// build, no network. Every filesystem write lands under a lane temp root.
// @purpose Pins KIT-5A: runtime receipts carry startedAt/elapsedMs on every outcome, capture records carry url and an ISO capturedAt, bankPngCapture decodes or refuses by name, a frame write into the shared Tools/visual-regression/output root refuses to replace an existing frame unless --output lifted the guard for the run, and decidePortRefusal is the one port decision.
// @status ACTIVE
//
// HOW THIS IS WRITTEN. The assertions are groups, each a function of the
// runtime's exports. The live tests run every group over the real modules; the
// mutant tests run the SAME group over a copy of the runtime (or of the
// frame-write primitive it imports) with the clause under test made
// unreachable (`if (false && ...)` or the equivalent) and require the group to
// fail. A mutant whose group still passes means the group was never asserting
// the clause. Each mutation anchor must occur exactly once in the source, so a
// moved anchor fails loudly instead of mutating nothing.
//
// The groups are driven by the behaviour statement, not by the code's shape:
// stub pages, stub clocks, real PNG bytes, real files in a temp tree whose
// shared output root is a real `.../Tools/visual-regression/output` directory.
//
// Run: node --test Tools/visual-regression/probe-frame-write.spec.mjs

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { withLaneTmp } from "../lib/lane-tmp.mjs";
import { encodeRgbaPng } from "../lib/png-rgba.mjs";
import { importMutated } from "./lib/import-mutated.mjs";
import * as realRuntime from "./lib/probe-runtime.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_PATH = path.join(HERE, "lib", "probe-runtime.mjs");
const FRAME_WRITE_PATH = path.join(HERE, "lib", "probe-frame-write.mjs");
const DECISIONS_PATH = path.join(HERE, "lib", "probe-runtime-decisions.mjs");

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const EXIT = realRuntime.PROBE_EXIT_CODES;

// ---------------------------------------------------------------------------
// Mutation harness
// ---------------------------------------------------------------------------

/**
 * @param {string} file Absolute module path.
 * @param {Array<[string, string]>} replacements Exactly-once anchor pairs.
 * @returns {string} The rewritten source, relative imports made absolute.
 */
function mutatedSource(file, replacements) {
  let source = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const base = pathToFileURL(file);
  source = source.replace(
    /from "(\.[^"]*)"/g,
    (_match, specifier) => `from "${new URL(specifier, base).href}"`,
  );
  for (const [anchor, replacement] of replacements) {
    const count = source.split(anchor).length - 1;
    assert.equal(
      count,
      1,
      `anchor must occur exactly once (${count}): ${anchor}`,
    );
    source = source.replace(anchor, () => replacement);
  }
  return source;
}

/**
 * Load the runtime, optionally with a mutated runtime source and/or a mutated
 * frame-write primitive wired in as the runtime's own import of it.
 *
 * @param {object} [mutations] Mutations.
 * @param {Array<[string, string]>} [mutations.runtime] Runtime anchors.
 * @param {Array<[string, string]>} [mutations.frameWrite] Primitive anchors.
 * @param {Array<[string, string]>} [mutations.decisions] Decisions-companion anchors.
 * @returns {Promise<object>} The runtime namespace.
 */
async function loadRuntime({
  runtime = [],
  frameWrite = [],
  decisions = [],
} = {}) {
  const replacements = [...runtime];
  if (frameWrite.length > 0) {
    const dataUrl = `data:text/javascript;base64,${Buffer.from(
      mutatedSource(FRAME_WRITE_PATH, frameWrite),
    ).toString("base64")}`;
    replacements.unshift([
      `from "${pathToFileURL(FRAME_WRITE_PATH).href}"`,
      `from "${dataUrl}"`,
    ]);
  }
  if (decisions.length > 0) {
    const dataUrl = `data:text/javascript;base64,${Buffer.from(
      mutatedSource(DECISIONS_PATH, decisions),
    ).toString("base64")}`;
    replacements.unshift([
      `from "${pathToFileURL(DECISIONS_PATH).href}"`,
      `from "${dataUrl}"`,
    ]);
  }
  return importMutated(RUNTIME_PATH, replacements);
}

/**
 * Assert that a behaviour group FAILS over a mutated runtime.
 *
 * @param {string} label What the mutant does.
 * @param {object} mutations See {@link loadRuntime}.
 * @param {Function} group The group to run.
 */
function mutant(label, mutations, group) {
  test(`mutant: ${label} turns the group RED`, async () => {
    const api = await loadRuntime(mutations);
    await assert.rejects(
      () => group(api),
      // A harness fault in the mutant (a typo that no longer parses or runs)
      // is not a RED for the clause; only an assertion or a refusal is.
      (error) =>
        !(
          error instanceof TypeError ||
          error instanceof ReferenceError ||
          error instanceof SyntaxError
        ),
      `${label}: the group still passed over the mutant, so it never asserted the clause`,
    );
  });
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const pngBytes = (seed) =>
  Buffer.from(encodeRgbaPng(new Uint8Array(4 * 4 * 4).fill(seed), 4, 4));
const dataUrlOf = (bytes) =>
  `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`;
const digestOf = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** The shared output root of a fixture tree, created. */
function sharedRootOf(root) {
  const shared = path.join(root, "Tools", "visual-regression", "output");
  fs.mkdirSync(shared, { recursive: true });
  return shared;
}

/**
 * A page whose one canvas screenshots to `bytes()`; `url` gives it `url()`.
 */
function stubPage({ bytes, url, liveness } = {}) {
  const shoot = async () => bytes();
  const page = {
    locator: () => ({
      count: async () => 1,
      screenshot: shoot,
      nth: () => ({ screenshot: shoot }),
    }),
  };
  if (url !== undefined) {
    page.url = () => url;
  }
  if (liveness !== undefined) {
    page.evaluate = async () => liveness;
  }
  return page;
}

/** Silence the runtime's stderr lines for a run, returning what was written. */
async function quietly(fn) {
  const original = process.stderr.write;
  const lines = [];
  process.stderr.write = (chunk) => {
    lines.push(String(chunk));
    return true;
  };
  try {
    return { value: await fn(), stderr: lines.join("") };
  } finally {
    process.stderr.write = original;
  }
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

/** A clock that advances `step` ms per reading and records every reading. */
function steppingClock(start = Date.UTC(2026, 9, 9, 3, 0, 0), step = 250) {
  const readings = [];
  const now = () => {
    const value = start + readings.length * step;
    readings.push(value);
    return value;
  };
  return { now, readings };
}

const noopLaunch = async () => ({ close: async () => {} });

function fakeDescriptor(over = {}) {
  return {
    name: "fake-probe",
    receiptEnvelope: "probe-owned",
    cells: async () => [{ value: 1 }],
    receipt: (cells) => ({ cells }),
    verdicts: () => [{ id: "v", pass: true }],
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Groups (each a function of a runtime namespace)
// ---------------------------------------------------------------------------

/** (a) startedAt and elapsedMs on every outcome, from the runtime clock. */
async function timingGroup(api) {
  const checkFields = (record, clock, label) => {
    assert.match(record.startedAt, ISO_UTC, `${label}: startedAt is ISO UTC`);
    assert.equal(
      record.startedAt,
      new Date(clock.readings[0]).toISOString(),
      `${label}: startedAt is the FIRST clock reading`,
    );
    assert.ok(
      Number.isSafeInteger(record.elapsedMs) && record.elapsedMs >= 0,
      `${label}: elapsedMs is a non-negative integer`,
    );
    assert.equal(
      record.elapsedMs,
      clock.readings.at(-1) - clock.readings[0],
      `${label}: elapsedMs is the last reading minus the first`,
    );
    assert.ok(record.elapsedMs > 0, `${label}: the stepping clock advanced`);
  };

  await withLaneTmp("frame-write-timing-", async (root) => {
    // Measured, probe-owned envelope: the runtime sidecar.
    let out = path.join(root, "measured");
    let clock = steppingClock();
    let run = await quietly(() =>
      api.runProbe(fakeDescriptor(), {
        argv: ["--repository-root", root, "--output", out, "--no-serve-built"],
        now: clock.now,
        launch: noopLaunch,
      }),
    );
    assert.equal(run.value, EXIT.OK);
    checkFields(
      readJson(path.join(out, "fake-probe-runtime.json")),
      clock,
      "measured",
    );

    // Measured, runtime envelope: the report is the runtime receipt.
    out = path.join(root, "runtime-envelope");
    clock = steppingClock();
    run = await quietly(() =>
      api.runProbe(fakeDescriptor({ receiptEnvelope: "runtime" }), {
        argv: ["--repository-root", root, "--output", out, "--no-serve-built"],
        now: clock.now,
        launch: noopLaunch,
      }),
    );
    assert.equal(run.value, EXIT.OK);
    checkFields(
      readJson(path.join(out, "fake-probe-report.json")),
      clock,
      "runtime envelope",
    );

    // Refused (the served build did not match): the refusal record.
    out = path.join(root, "refused");
    clock = steppingClock();
    run = await quietly(() =>
      api.runProbe(fakeDescriptor(), {
        argv: ["--repository-root", root, "--output", out],
        now: clock.now,
        launch: noopLaunch,
        preflight: async () => ({
          ok: false,
          artifacts: [
            { path: "Build/CesiumUnminified/Cesium.js", match: false },
          ],
        }),
      }),
    );
    assert.equal(run.value, EXIT.REFUSAL);
    checkFields(
      readJson(path.join(out, "fake-probe-refusal.json")),
      clock,
      "refused",
    );

    // Errored (cells throws): the error record.
    out = path.join(root, "errored");
    clock = steppingClock();
    run = await quietly(() =>
      api.runProbe(
        fakeDescriptor({
          cells: async () => {
            throw new Error("cells blew up");
          },
        }),
        {
          argv: [
            "--repository-root",
            root,
            "--output",
            out,
            "--no-serve-built",
          ],
          now: clock.now,
          launch: noopLaunch,
        },
      ),
    );
    assert.equal(run.value, EXIT.ERROR);
    checkFields(
      readJson(path.join(out, "fake-probe-error.json")),
      clock,
      "errored",
    );
  });
}

/** (a) A clock that goes backwards is never a negative duration. */
async function backwardsClockGroup(api) {
  await withLaneTmp("frame-write-clock-", async (root) => {
    const out = path.join(root, "out");
    const readings = [];
    const now = () => {
      readings.push(readings.length === 0 ? 5000 : 100);
      return readings.at(-1);
    };
    const run = await quietly(() =>
      api.runProbe(fakeDescriptor(), {
        argv: ["--repository-root", root, "--output", out, "--no-serve-built"],
        now,
        launch: noopLaunch,
      }),
    );
    assert.equal(run.value, EXIT.OK);
    const runtime = readJson(path.join(out, "fake-probe-runtime.json"));
    assert.equal(runtime.startedAt, new Date(5000).toISOString());
    assert.equal(
      runtime.elapsedMs,
      0,
      "a backwards clock yields 0, not a negative",
    );
  });
}

/** (a) A refusal while the arguments are parsed exits 3; an unknown flag 2. */
async function parseTimeExitGroup(api) {
  await withLaneTmp("frame-write-parse-", async (root) => {
    let launches = 0;
    const launch = async () => {
      launches += 1;
      return { close: async () => {} };
    };
    let run = await quietly(() =>
      api.runProbe(fakeDescriptor(), {
        argv: [
          "--repository-root",
          root,
          "--output",
          path.join(root, "o1"),
          "--port",
          "8080",
        ],
        launch,
      }),
    );
    assert.equal(
      run.value,
      EXIT.REFUSAL,
      "--port 8080 refuses (exit 3), not a crash",
    );
    assert.match(run.stderr, /REFUSED \(port-8080-forbidden\)/);
    run = await quietly(() =>
      api.runProbe(fakeDescriptor(), {
        argv: [
          "--repository-root",
          root,
          "--output",
          path.join(root, "o2"),
          "--bogus-flag",
        ],
        launch,
      }),
    );
    assert.equal(run.value, EXIT.ERROR, "an unknown flag exits 2, not 1");
    assert.equal(launches, 0, "neither run reached a browser");
  });
}

/** (a2) captureElement's record, over a stub page. */
async function captureElementRecordGroup(api) {
  await withLaneTmp("frame-write-record-", async (root) => {
    const bytes = pngBytes(40);
    const captures = [];
    const fixedNow = () => Date.UTC(2026, 9, 9, 12, 0, 0);
    const result = await api.captureElement({
      page: stubPage({
        bytes: () => bytes,
        url: "http://localhost:8094/Apps/x.html?q=1",
      }),
      name: "left",
      outputDirectory: path.join(root, "frames"),
      captures,
      now: fixedNow,
    });
    assert.equal(result.url, "http://localhost:8094/Apps/x.html?q=1");
    assert.equal(result.capturedAt, "2026-10-09T12:00:00.000Z");
    const onDisk = fs.readFileSync(path.join(root, "frames", "left.png"));
    assert.ok(onDisk.equals(bytes), "the bytes on disk are the screenshot");
    assert.equal(result.byteLength, onDisk.byteLength);
    assert.equal(result.sha256, digestOf(onDisk));
    assert.equal(captures.length, 1, "the record is pushed to the sink");
    assert.equal(captures[0].url, result.url);
    assert.equal(captures[0].capturedAt, result.capturedAt);

    // A page with no url() cannot say which page it photographed.
    const noUrl = await api.captureElement({
      page: stubPage({ bytes: () => bytes }),
      name: "right",
      outputDirectory: path.join(root, "frames"),
    });
    assert.equal(noUrl.url, null);
    assert.match(
      noUrl.capturedAt,
      ISO_UTC,
      "default clock still yields ISO UTC",
    );
  });
}

/** (a2) bankPngCapture's record and file naming, over a real PNG data URL. */
async function bankRecordGroup(api) {
  await withLaneTmp("frame-write-bank-", async (root) => {
    const bytes = pngBytes(90);
    const url = dataUrlOf(bytes);
    const captures = [];
    const record = api.bankPngCapture(url, "alpha", {
      outputDirectory: root,
      captures,
      url: "http://localhost:8094/page",
      now: () => Date.UTC(2026, 9, 9, 13, 30, 0),
    });
    assert.ok(fs.readFileSync(path.join(root, "alpha.png")).equals(bytes));
    assert.equal(record.name, "alpha");
    assert.equal(record.path, path.join(root, "alpha.png"));
    assert.equal(record.byteLength, bytes.byteLength);
    assert.equal(record.sha256, digestOf(bytes));
    assert.equal(record.matchCount, null);
    assert.equal(record.url, "http://localhost:8094/page");
    assert.equal(record.capturedAt, "2026-10-09T13:30:00.000Z");
    assert.deepEqual(record.liveness, { state: "unread", frameNumber: null });
    assert.deepEqual(Object.keys(record).sort(), [
      "buffer",
      "byteLength",
      "capturedAt",
      "liveness",
      "matchCount",
      "name",
      "path",
      "sha256",
      "url",
    ]);
    assert.equal(captures.length, 1);
    assert.equal(captures[0].sha256, record.sha256);
    assert.equal(
      "buffer" in captures[0],
      false,
      "the sink record carries no bytes",
    );

    // No url passed: null, never undefined.
    const bare = api.bankPngCapture(url, "beta", { outputDirectory: root });
    assert.equal(bare.url, null);

    // A name already ending in .png is the file name; the record keeps the name.
    const named = api.bankPngCapture(url, "gamma.png", {
      outputDirectory: root,
    });
    assert.equal(named.name, "gamma.png");
    assert.equal(path.basename(named.path), "gamma.png");
    assert.equal(fs.existsSync(path.join(root, "gamma.png.png")), false);

    // A supplied same-task liveness record is carried; teardown is not a loss.
    const live = api.bankPngCapture(url, "live", {
      outputDirectory: root,
      liveness: { gateArmed: true, deviceLost: null, frameNumber: 12 },
    });
    assert.deepEqual(live.liveness, { state: "live", frameNumber: 12 });
    const teardown = api.bankPngCapture(url, "teardown", {
      outputDirectory: root,
      liveness: {
        gateArmed: true,
        deviceLost: "device lost: reason=destroyed",
        frameNumber: 13,
      },
    });
    assert.deepEqual(teardown.liveness, { state: "teardown", frameNumber: 13 });
    const unobserved = api.bankPngCapture(url, "unobserved", {
      outputDirectory: root,
      liveness: { gateArmed: false, deviceLost: null, frameNumber: null },
    });
    assert.equal(unobserved.liveness.state, "unobserved");
  });
}

/** (a2) bankPngCapture refuses by name, and writes nothing when it does. */
async function bankRefusalGroup(api) {
  await withLaneTmp("frame-write-bank-refuse-", async (root) => {
    const good = dataUrlOf(pngBytes(10));
    const cases = [
      ["empty string", "", "empty"],
      ["undefined", undefined, "empty"],
      ["a non-string", 42, "empty"],
      ["a JPEG data URL", "data:image/jpeg;base64,/9j/4AAQSkZJRg==", "not-png"],
      [
        "base64 of something that is not a PNG",
        `data:image/png;base64,${Buffer.from("this is certainly not a png file").toString("base64")}`,
        "not-png",
      ],
      [
        "non-base64 text",
        "data:image/png;base64,!!!!not*base64!!!",
        "undecodable",
      ],
      ["a truncated payload", good.slice(0, good.length - 1), "undecodable"],
    ];
    for (const [label, value, defect] of cases) {
      const name = `refused-${defect}`;
      const captures = [];
      assert.throws(
        () =>
          api.bankPngCapture(value, name, { outputDirectory: root, captures }),
        (error) => {
          assert.ok(
            error instanceof api.ProbeRefusal,
            `${label}: a ProbeRefusal`,
          );
          assert.equal(error.reason, "capture-data-url-invalid", label);
          assert.equal(error.details.defect, defect, label);
          assert.equal(error.details.name, name, label);
          assert.equal(error.exitCode, EXIT.REFUSAL, label);
          return true;
        },
        label,
      );
      assert.deepEqual(captures, [], `${label}: nothing was recorded`);
      assert.equal(
        fs.existsSync(path.join(root, `${name}.png`)),
        false,
        `${label}: no file`,
      );
    }
    assert.deepEqual(fs.readdirSync(root), [], "no refusal left a file behind");

    // The decoder is exported and refuses the same way; a good one decodes.
    assert.throws(
      () => api.decodePngDataUrl("", { name: "x" }),
      (error) =>
        error.reason === "capture-data-url-invalid" &&
        error.details.defect === "empty",
    );
    assert.ok(api.decodePngDataUrl(good, { name: "x" }).equals(pngBytes(10)));
  });
}

/** (a2) bankPngCapture applies the runtime's device-lost refusal. */
async function bankDeviceLostGroup(api) {
  await withLaneTmp("frame-write-bank-lost-", async (root) => {
    const captures = [];
    assert.throws(
      () =>
        api.bankPngCapture(dataUrlOf(pngBytes(5)), "lost", {
          outputDirectory: root,
          captures,
          liveness: {
            gateArmed: true,
            deviceLost: "device lost: reason=unknown",
            frameNumber: 9,
          },
        }),
      (error) =>
        error instanceof api.ProbeRefusal &&
        error.reason === "capture-device-lost",
    );
    assert.deepEqual(captures, []);
    assert.equal(
      fs.existsSync(path.join(root, "lost.png")),
      false,
      "no file for a lost device",
    );
  });
}

/**
 * (b) A frame write into the shared output root never replaces an existing
 * file there, from captureElement AND from bankPngCapture; first writes,
 * subdirectories and other directories are free.
 */
async function sharedRootGuardGroup(api) {
  await withLaneTmp("frame-write-guard-", async (root) => {
    const shared = sharedRootOf(root);
    const older = new Date(Date.UTC(2026, 0, 1));
    const seed = (name, bytes) => {
      const file = path.join(shared, name);
      fs.writeFileSync(file, bytes);
      fs.utimesSync(file, older, older);
      return { file, mtimeMs: fs.statSync(file).mtimeMs };
    };
    const refusalOf = async (attempt) => {
      try {
        await attempt();
      } catch (error) {
        return error;
      }
      return null;
    };
    const oldBytes = pngBytes(1);
    const newBytes = pngBytes(200);

    // captureElement
    const banked = seed("frame.png", oldBytes);
    let error = await refusalOf(() =>
      api.captureElement({
        page: stubPage({ bytes: () => newBytes }),
        name: "frame",
        outputDirectory: shared,
      }),
    );
    assert.ok(error instanceof api.ProbeRefusal, "captureElement refuses");
    assert.equal(error.reason, "frame-overwrite-shared-root");
    assert.equal(error.exitCode, EXIT.REFUSAL);
    assert.equal(error.details.path, banked.file);
    assert.equal(error.details.sha256, digestOf(oldBytes));
    assert.ok(fs.readFileSync(banked.file).equals(oldBytes), "bytes unchanged");
    assert.equal(
      fs.statSync(banked.file).mtimeMs,
      banked.mtimeMs,
      "mtime unchanged",
    );

    // bankPngCapture
    const bankedB = seed("banked.png", oldBytes);
    error = await refusalOf(() =>
      api.bankPngCapture(dataUrlOf(newBytes), "banked", {
        outputDirectory: shared,
      }),
    );
    assert.ok(error instanceof api.ProbeRefusal, "bankPngCapture refuses");
    assert.equal(error.reason, "frame-overwrite-shared-root");
    assert.equal(error.details.path, bankedB.file);
    assert.equal(error.details.sha256, digestOf(oldBytes));
    assert.ok(fs.readFileSync(bankedB.file).equals(oldBytes));
    assert.equal(fs.statSync(bankedB.file).mtimeMs, bankedB.mtimeMs);

    // The .png-suffixed spelling is the same file.
    error = await refusalOf(() =>
      api.bankPngCapture(dataUrlOf(newBytes), "banked.png", {
        outputDirectory: shared,
      }),
    );
    assert.equal(error?.reason, "frame-overwrite-shared-root");

    // The first write of a NEW name in the shared root succeeds, once.
    const fresh = api.bankPngCapture(dataUrlOf(newBytes), "fresh", {
      outputDirectory: shared,
    });
    assert.ok(fs.readFileSync(fresh.path).equals(newBytes));
    await api.captureElement({
      page: stubPage({ bytes: () => newBytes }),
      name: "fresh-element",
      outputDirectory: shared,
    });
    assert.equal(
      (
        await refusalOf(() =>
          api.bankPngCapture(dataUrlOf(oldBytes), "fresh", {
            outputDirectory: shared,
          }),
        )
      )?.reason,
      "frame-overwrite-shared-root",
      "the second write of that name is a replacement",
    );

    // A subdirectory of the shared root, and a directory elsewhere, replace freely.
    for (const directory of [
      path.join(shared, "some-probe"),
      path.join(root, "elsewhere"),
    ]) {
      api.bankPngCapture(dataUrlOf(oldBytes), "again", {
        outputDirectory: directory,
      });
      api.bankPngCapture(dataUrlOf(newBytes), "again", {
        outputDirectory: directory,
      });
      assert.ok(
        fs.readFileSync(path.join(directory, "again.png")).equals(newBytes),
        `${directory}: replaced freely`,
      );
      await api.captureElement({
        page: stubPage({ bytes: () => oldBytes }),
        name: "again-element",
        outputDirectory: directory,
      });
      await api.captureElement({
        page: stubPage({ bytes: () => newBytes }),
        name: "again-element",
        outputDirectory: directory,
      });
      assert.ok(
        fs
          .readFileSync(path.join(directory, "again-element.png"))
          .equals(newBytes),
      );
    }
  });
}

/**
 * (b) Through runProbe: a descriptor writing its frames into the shared root
 * refuses without --output; --output (naming that root) lifts the guard for the
 * run only.
 */
async function sharedRootRunProbeGroup(api) {
  await withLaneTmp("frame-write-run-", async (root) => {
    const shared = sharedRootOf(root);
    const frame = path.join(shared, "frame.png");
    const older = new Date(Date.UTC(2026, 0, 1));
    const oldBytes = pngBytes(3);
    const newBytes = pngBytes(220);
    fs.writeFileSync(frame, oldBytes);
    fs.utimesSync(frame, older, older);
    const mtimeBefore = fs.statSync(frame).mtimeMs;

    const descriptor = {
      name: "frame-probe",
      outputSubdirectory: "",
      receiptEnvelope: "probe-owned",
      cells: async ({ browser, outputDirectory, captures }) => {
        await api.captureElement({
          page: browser.page,
          name: "frame",
          outputDirectory,
          captures,
        });
        return [{ ok: true }];
      },
      receipt: (cells) => ({ cells }),
      verdicts: () => [{ id: "v", pass: true }],
    };
    const launch = async () => ({
      page: stubPage({ bytes: () => newBytes, url: "http://localhost:8094/p" }),
      close: async () => {},
    });

    // 1. No --output: refused, exit 3, the banked frame is untouched.
    let run = await quietly(() =>
      api.runProbe(descriptor, {
        argv: ["--repository-root", root, "--no-serve-built"],
        launch,
      }),
    );
    assert.equal(
      run.value,
      EXIT.REFUSAL,
      "a default run into the shared root refuses",
    );
    assert.equal(
      readJson(path.join(shared, "frame-probe-refusal.json")).refusal.reason,
      "frame-overwrite-shared-root",
    );
    assert.ok(
      fs.readFileSync(frame).equals(oldBytes),
      "the banked frame is unchanged",
    );
    assert.equal(fs.statSync(frame).mtimeMs, mtimeBefore);

    // 2. --output naming that root: the operator said write here.
    run = await quietly(() =>
      api.runProbe(descriptor, {
        argv: [
          "--repository-root",
          root,
          "--output",
          shared,
          "--no-serve-built",
        ],
        launch,
      }),
    );
    assert.equal(run.value, EXIT.OK, "--output lifts the guard");
    assert.ok(
      fs.readFileSync(frame).equals(newBytes),
      "the frame was replaced",
    );

    // 3. The lift ends with the run.
    const error = await (async () => {
      try {
        await api.captureElement({
          page: stubPage({ bytes: () => oldBytes }),
          name: "frame",
          outputDirectory: shared,
        });
      } catch (caught) {
        return caught;
      }
      return null;
    })();
    assert.equal(
      error?.reason,
      "frame-overwrite-shared-root",
      "the lift did not outlive the run",
    );
    assert.ok(fs.readFileSync(frame).equals(newBytes));

    // 4. A per-probe subdirectory is never guarded: two default runs both write.
    const subDescriptor = {
      ...descriptor,
      name: "frame-sub-probe",
      outputSubdirectory: "frame-sub-probe",
    };
    for (const bytes of [oldBytes, newBytes]) {
      run = await quietly(() =>
        api.runProbe(subDescriptor, {
          argv: ["--repository-root", root, "--no-serve-built"],
          launch: async () => ({
            page: stubPage({ bytes: () => bytes }),
            close: async () => {},
          }),
        }),
      );
      assert.equal(
        run.value,
        EXIT.OK,
        "a per-probe subdirectory run is unchanged",
      );
    }
    assert.ok(
      fs
        .readFileSync(path.join(shared, "frame-sub-probe", "frame.png"))
        .equals(newBytes),
    );
  });
}

/** The exported port decision is the one parseProbeArgs refuses with. */
async function portDecisionGroup(api) {
  const refused = api.decidePortRefusal(8080);
  assert.equal(refused.refuse, true);
  assert.equal(refused.reason, "port-8080-forbidden");
  assert.equal(refused.exitCode, EXIT.REFUSAL);
  assert.deepEqual(refused.details, { port: 8080 });
  for (const port of [8094, 8081, 80, 443, 3000]) {
    assert.equal(
      api.decidePortRefusal(port).refuse,
      false,
      `port ${port} is accepted`,
    );
  }
  let thrown = null;
  try {
    api.parseProbeArgs(["--port", "8080"]);
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof api.ProbeRefusal, "parseProbeArgs refuses 8080");
  assert.equal(
    thrown.reason,
    refused.reason,
    "same id as the exported decision",
  );
  assert.deepEqual(thrown.details, refused.details);
  assert.equal(thrown.message, api.PORT_8080_REFUSAL_MESSAGE);
  assert.equal(api.parseProbeArgs(["--port", "8094"]).port, 8094);
}

// ---------------------------------------------------------------------------
// Live tests: every group over the real runtime
// ---------------------------------------------------------------------------

test("a. every runtime receipt carries startedAt and elapsedMs", () =>
  timingGroup(realRuntime));
test("a. a backwards clock never yields a negative elapsedMs", () =>
  backwardsClockGroup(realRuntime));
test("a. a refusal while parsing arguments exits 3, an unknown flag exits 2", () =>
  parseTimeExitGroup(realRuntime));
test("a2. captureElement's record carries url and an ISO capturedAt", () =>
  captureElementRecordGroup(realRuntime));
test("a2. bankPngCapture banks a real PNG data URL with the same record shape", () =>
  bankRecordGroup(realRuntime));
test("a2. bankPngCapture refuses an empty, non-PNG or undecodable URL by name", () =>
  bankRefusalGroup(realRuntime));
test("a2. bankPngCapture refuses a lost device and writes nothing", () =>
  bankDeviceLostGroup(realRuntime));
test("b. a frame write never replaces an existing frame in the shared output root", () =>
  sharedRootGuardGroup(realRuntime));
test("b. runProbe lifts the shared-root guard only for --output, and only for the run", () =>
  sharedRootRunProbeGroup(realRuntime));
test("port. the exported decision is the one parseProbeArgs refuses with", () =>
  portDecisionGroup(realRuntime));

// ---------------------------------------------------------------------------
// Inertness mutants
// ---------------------------------------------------------------------------

const ELAPSED_ANCHOR =
  "    elapsedMs: Math.max(0, Math.round(generatedAtMs - startedAtMs)),";
const STARTED_ANCHOR = "    startedAt: new Date(startedAtMs).toISOString(),";

mutant(
  "elapsedMs dropped",
  { runtime: [[ELAPSED_ANCHOR, "    elapsedMs: null,"]] },
  timingGroup,
);
mutant(
  "startedAt dropped",
  { runtime: [[STARTED_ANCHOR, "    startedAt: null,"]] },
  timingGroup,
);
mutant(
  "the Math.max(0, ...) floor removed",
  {
    runtime: [
      [
        ELAPSED_ANCHOR,
        "    elapsedMs: Math.round(generatedAtMs - startedAtMs),",
      ],
    ],
  },
  backwardsClockGroup,
);

mutant(
  "captureElement's url dropped",
  {
    runtime: [
      [
        "    liveness: { state: livenessDecision.state, frameNumber },\n    url,\n    capturedAt,\n",
        "    liveness: { state: livenessDecision.state, frameNumber },\n    capturedAt,\n",
      ],
    ],
  },
  captureElementRecordGroup,
);
mutant(
  "captureElement's capturedAt dropped",
  {
    runtime: [
      [
        "    liveness: { state: livenessDecision.state, frameNumber },\n    url,\n    capturedAt,\n",
        "    liveness: { state: livenessDecision.state, frameNumber },\n    url,\n",
      ],
    ],
  },
  captureElementRecordGroup,
);
mutant(
  "bankPngCapture's url dropped",
  {
    runtime: [
      [
        '    url: typeof url === "string" ? url : null,\n    capturedAt,\n',
        "    capturedAt,\n",
      ],
    ],
  },
  bankRecordGroup,
);
mutant(
  "bankPngCapture's capturedAt dropped",
  {
    runtime: [
      [
        '    url: typeof url === "string" ? url : null,\n    capturedAt,\n',
        '    url: typeof url === "string" ? url : null,\n',
      ],
    ],
  },
  bankRecordGroup,
);

mutant(
  "bankPngCapture writing with its own fs.writeFileSync (bypassing the guard)",
  {
    runtime: [
      [
        "  const file = writeFrameFile({\n    file: path.join(outputDirectory, fileName),\n    bytes: buffer,\n  });",
        "  const file = path.join(outputDirectory, fileName);\n  fs.mkdirSync(outputDirectory, { recursive: true });\n  fs.writeFileSync(file, buffer);",
      ],
    ],
  },
  sharedRootGuardGroup,
);
mutant(
  "captureElement writing with its own fs.writeFileSync (bypassing the guard)",
  {
    runtime: [
      [
        "  const file = writeFrameFile({\n    file: path.join(outputDirectory, `${name}.png`),\n    bytes: buffer,\n  });",
        "  const file = path.join(outputDirectory, `${name}.png`);\n  fs.mkdirSync(outputDirectory, { recursive: true });\n  fs.writeFileSync(file, buffer);",
      ],
    ],
  },
  sharedRootGuardGroup,
);
mutant(
  "bankPngCapture's liveness check inert",
  {
    runtime: [
      [
        "  if (liveness !== undefined && liveness !== null) {\n    const decision = throwIfDeviceLost(liveness, { name });",
        "  if (false && liveness !== undefined && liveness !== null) {\n    const decision = throwIfDeviceLost(liveness, { name });",
      ],
    ],
  },
  bankDeviceLostGroup,
);

const GUARD_ANCHOR =
  "  if (isSharedOutputRootDirectory(directory) && !isLifted(directory)) {";
mutant(
  "the shared-root guard inert",
  {
    frameWrite: [
      [
        GUARD_ANCHOR,
        "  if (false && isSharedOutputRootDirectory(directory) && !isLifted(directory)) {",
      ],
    ],
  },
  sharedRootGuardGroup,
);
mutant(
  "the shared-root guard inert (through runProbe)",
  {
    frameWrite: [
      [
        GUARD_ANCHOR,
        "  if (false && isSharedOutputRootDirectory(directory) && !isLifted(directory)) {",
      ],
    ],
  },
  sharedRootRunProbeGroup,
);
mutant(
  "the guard treating every directory as the shared root",
  {
    frameWrite: [
      [
        "      (segment, index) => segment === SHARED_OUTPUT_ROOT_SEGMENTS[index],",
        "      (segment, index) => index >= 0,",
      ],
    ],
  },
  sharedRootGuardGroup,
);
mutant(
  "the refusal naming no sha256",
  {
    frameWrite: [
      [
        "        { path: target, sha256: digest },",
        "        { path: target },",
      ],
    ],
  },
  sharedRootGuardGroup,
);
mutant(
  "the lift held for every directory",
  {
    frameWrite: [
      [
        "  return liftedDirectories.has(directoryKey(directory));",
        "  return true;",
      ],
    ],
  },
  sharedRootGuardGroup,
);
mutant(
  "a released lift that stays held",
  {
    frameWrite: [
      [
        "  return () => {\n    if (released) {",
        "  return () => {\n    if (true) {",
      ],
    ],
  },
  sharedRootRunProbeGroup,
);
mutant(
  "runProbe never lifting the guard for --output",
  {
    runtime: [
      [
        "    if (\n      options.outputDirectory !== null &&\n      options.outputDirectory !== undefined\n    ) {\n      releaseSharedRootLift",
        "    if (\n      false &&\n      options.outputDirectory !== null &&\n      options.outputDirectory !== undefined\n    ) {\n      releaseSharedRootLift",
      ],
    ],
  },
  sharedRootRunProbeGroup,
);
mutant(
  "runProbe lifting the guard even without --output",
  {
    runtime: [
      [
        "    if (\n      options.outputDirectory !== null &&\n      options.outputDirectory !== undefined\n    ) {\n      releaseSharedRootLift",
        "    if (\n      true ||\n      options.outputDirectory !== null &&\n      options.outputDirectory !== undefined\n    ) {\n      releaseSharedRootLift",
      ],
    ],
  },
  sharedRootRunProbeGroup,
);

mutant(
  "the undecodable-base64 check inert",
  {
    frameWrite: [
      [
        "  if (!isStrictBase64(payload)) {",
        "  if (false && !isStrictBase64(payload)) {",
      ],
    ],
  },
  bankRefusalGroup,
);
mutant(
  "the PNG signature check inert",
  {
    frameWrite: [
      [
        "    bytes.length <= PNG_SIGNATURE.length ||\n    !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)",
        "    false",
      ],
    ],
  },
  bankRefusalGroup,
);
mutant(
  "the not-a-PNG-prefix check inert",
  {
    frameWrite: [
      [
        "  if (!dataUrl.startsWith(PNG_DATA_URL_PREFIX)) {",
        "  if (false && !dataUrl.startsWith(PNG_DATA_URL_PREFIX)) {",
      ],
    ],
  },
  bankRefusalGroup,
);
mutant(
  "the empty-input check inert",
  {
    frameWrite: [
      [
        '  if (typeof dataUrl !== "string" || dataUrl.length === 0) {',
        '  if (false && (typeof dataUrl !== "string" || dataUrl.length === 0)) {',
      ],
    ],
  },
  bankRefusalGroup,
);

mutant(
  "the exported port decision inert",
  {
    decisions: [["  if (port === 8080) {", "  if (false && port === 8080) {"]],
  },
  portDecisionGroup,
);
mutant(
  "parseProbeArgs' own port refusal inert",
  {
    runtime: [
      [
        "  if (parsed.port === 8080) {",
        "  if (false && parsed.port === 8080) {",
      ],
    ],
  },
  portDecisionGroup,
);
mutant(
  "parseProbeArgs' own port refusal inert (run exit)",
  {
    runtime: [
      [
        "  if (parsed.port === 8080) {",
        "  if (false && parsed.port === 8080) {",
      ],
    ],
  },
  parseTimeExitGroup,
);
