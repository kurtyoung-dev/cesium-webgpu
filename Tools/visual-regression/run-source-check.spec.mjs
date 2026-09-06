// @purpose Verifies source-check identity and result folding with fake commands and storage.
// @status ACTIVE

import assert from "node:assert/strict";
import test from "node:test";

import { captureSourceCheck, sourceCheckExit } from "./run-source-check.mjs";

function completeRaw(code = 0) {
  return {
    completed: true,
    completion: { reason: "child-close" },
    native: { close: { observed: true, exitCode: code, signal: null } },
    timeout: { expired: false, forced: false },
    streamDrain: { completed: true, timedOut: false },
    stdout: { available: true, ended: true, truncated: false, error: null },
    stderr: { available: true, ended: true, truncated: false, error: null },
  };
}

function fixture() {
  const events = [];
  const dependencies = {
    snapshot: (files) =>
      Object.fromEntries(
        Object.keys(files).map((key) => [
          key,
          { exists: true, byteLength: 1, sha256: "a".repeat(64) },
        ]),
      ),
    recordCommand: async (options) => {
      events.push({ kind: "raw-closed", options });
      return { artifactPath: options.artifactPath, raw: completeRaw() };
    },
    writeImmutable: (file, bytes) =>
      events.push({ kind: "summary", file, bytes }),
  };
  return { dependencies, events };
}

const plan = {
  spec: "Tools/visual-regression/wgsl-mini-eval.spec.mjs",
  inputs: ["Tools/visual-regression/lib/wgsl-mini-eval.mjs"],
};

test("invalid provenance is structural and complete native exits use canonical verdicts", () => {
  const nativeFailure = completeRaw(7);
  assert.equal(sourceCheckExit(nativeFailure, { ok: false }), 3);
  assert.equal(nativeFailure.native.close.exitCode, 7);
  assert.equal(sourceCheckExit(nativeFailure, { ok: true }), 1);
  assert.equal(sourceCheckExit(completeRaw(1), { ok: true }), 1);
  assert.equal(sourceCheckExit(completeRaw(), { ok: false }), 3);
  assert.equal(sourceCheckExit(completeRaw(), { ok: "true" }), 3);
  assert.equal(sourceCheckExit(undefined, { ok: true }), 3);
  for (const missing of [null, false, "", 42, []]) {
    assert.equal(sourceCheckExit(missing, { ok: true }), 3);
  }
  assert.equal(sourceCheckExit(completeRaw(), { ok: true }), 0);
});

test("runtime failures and incomplete completion are ERROR, not STRUCTURAL", () => {
  const mutations = [
    (raw) => {
      raw.stdout.truncated = true;
    },
    (raw) => {
      raw.stderr.ended = false;
    },
    (raw) => {
      raw.timeout.expired = true;
    },
    (raw) => {
      raw.native.spawnError = { message: "failed" };
    },
    (raw) => {
      raw.native.close.observed = false;
    },
    (raw) => {
      raw.native.childError = { occurred: true, message: "undefined" };
    },
    (raw) => {
      raw.stderr.error = { occurred: true, message: "null" };
    },
    (raw) => {
      raw.completion.reason = "hard-completion-deadline";
    },
    (raw) => {
      raw.completion.reason = "stream-drain-timeout";
    },
    (raw) => {
      raw.streamDrain.timedOut = true;
    },
    (raw) => {
      raw.streamDrain.completed = false;
    },
    (raw) => {
      raw.timeout.forced = true;
    },
    (raw) => {
      raw.native.close.signal = "SIGTERM";
    },
    (raw) => {
      raw.native.close.exitCode = null;
    },
  ];
  for (const mutate of mutations) {
    const raw = completeRaw();
    mutate(raw);
    assert.equal(sourceCheckExit(raw, { ok: true }), 2);
  }
});

test("runtime and provenance defects preserve the exact native failure separately", () => {
  const raw = completeRaw(7);
  raw.timeout.expired = true;
  assert.equal(sourceCheckExit(raw, { ok: true }), 2);
  assert.equal(sourceCheckExit(raw, { ok: false }), 3);
  assert.equal(raw.native.close.exitCode, 7);
});

for (const reason of ["hard-completion-deadline", "stream-drain-timeout"]) {
  test(`otherwise clean ${reason} cannot be accepted`, () => {
    const raw = completeRaw();
    raw.completion.reason = reason;
    assert.equal(sourceCheckExit(raw, { ok: true }), 2);
  });
}

test("otherwise clean pipe-drain timeout cannot be accepted", () => {
  const raw = completeRaw();
  raw.streamDrain.timedOut = true;
  assert.equal(sourceCheckExit(raw, { ok: true }), 2);
});

test("adapter binds explicit inputs and records raw before immutable summary", async () => {
  const { dependencies, events } = fixture();
  const summary = await captureSourceCheck(
    plan,
    "unused-fake-directory",
    dependencies,
  );
  assert.equal(summary.exitCode, 0);
  assert.deepEqual(
    events.map((event) => event.kind),
    ["raw-closed", "summary"],
  );
  const options = events[0].options;
  assert.ok(options.argv.includes("--experimental-test-isolation=none"));
  assert.ok(options.startIdentity.inputs[plan.inputs[0]]);
  assert.ok(options.startIdentity.inputs.$node);
  assert.ok(options.startIdentity.inputs.$recorder);
  assert.ok(options.startIdentity.inputs.$refusal);
  assert.ok(options.startIdentity.inputs.$verdict);
});

test("missing input prevents command execution", async () => {
  const { dependencies, events } = fixture();
  dependencies.snapshot = () => ({ missing: { exists: false } });
  await assert.rejects(
    captureSourceCheck(plan, "unused", dependencies),
    (error) =>
      /inputs unavailable/u.test(error.message) && error.exitCode === 3,
  );
  assert.equal(events.length, 0);
});

test("input drift is reported without losing raw command facts", async () => {
  const { dependencies, events } = fixture();
  const original = dependencies.snapshot;
  let calls = 0;
  dependencies.snapshot = (files) => {
    const result = original(files);
    if (++calls === 2) result[plan.spec].sha256 = "b".repeat(64);
    return result;
  };
  const summary = await captureSourceCheck(plan, "unused", dependencies);
  assert.equal(summary.exitCode, 3);
  assert.equal(events[0].kind, "raw-closed");
  assert.match(summary.comparison.reasons[0], /changed/u);
});

test("adapter summary retains native status when its public verdict is canonical", async () => {
  for (const drift of [false, true]) {
    const { dependencies, events } = fixture();
    const raw = completeRaw(7);
    dependencies.recordCommand = async (options) => {
      events.push({ kind: "raw-closed", options, raw });
      return { artifactPath: options.artifactPath, raw };
    };
    const original = dependencies.snapshot;
    let calls = 0;
    dependencies.snapshot = (files) => {
      const result = original(files);
      if (++calls === 2 && drift) result[plan.spec].sha256 = "b".repeat(64);
      return result;
    };
    const summary = await captureSourceCheck(plan, "unused", dependencies);
    assert.equal(summary.exitCode, drift ? 3 : 1);
    assert.equal(summary.native.close.exitCode, 7);
    assert.equal(events[0].raw.native.close.exitCode, 7);
    assert.equal(JSON.parse(events[1].bytes).native.close.exitCode, 7);
  }
});

test("summary persistence failure occurs only after raw completion", async () => {
  const { dependencies, events } = fixture();
  dependencies.writeImmutable = () => {
    throw new Error("EEXIST");
  };
  await assert.rejects(
    captureSourceCheck(plan, "unused", dependencies),
    /EEXIST/u,
  );
  assert.equal(events[0].kind, "raw-closed");
});

for (const [label, result] of [
  ["absent recorder result", undefined],
  [
    "absent raw with an available artifact path",
    { artifactPath: "retained.jsonl" },
  ],
]) {
  test(`${label} persists a STRUCTURAL summary`, async () => {
    const { dependencies, events } = fixture();
    dependencies.recordCommand = async () => result;
    const summary = await captureSourceCheck(plan, "unused", dependencies);
    assert.equal(summary.exitCode, 3);
    assert.equal(summary.rawArtifact, result?.artifactPath ?? null);
    assert.equal(summary.native, null);
    assert.equal(summary.timeout, null);
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, "summary");
    assert.deepEqual(JSON.parse(events[0].bytes), summary);
  });
}

test("invalid or escaping inputs never reach the recorder", async () => {
  for (const invalid of [
    { ...plan, spec: "../outside.spec.mjs" },
    { ...plan, inputs: ["../outside.mjs"] },
    { ...plan, spec: "Tools/not-a-spec.mjs" },
  ]) {
    const { dependencies, events } = fixture();
    await assert.rejects(captureSourceCheck(invalid, "unused", dependencies));
    assert.equal(events.length, 0);
  }
});
