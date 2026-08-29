import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  EXIT_CODES,
  REFUSAL_REASONS,
  buildReceipt,
  buildStepPlan,
  decideArgumentRefusal,
  parseArgs,
  verdictFromExitCodes,
} from "./wave-end-gate.mjs";

test("step plan preserves the required order and commands", () => {
  const args = parseArgs([
    "--wave",
    "wave-1",
    "--port",
    "8094",
    "--bucket-port",
    "8095",
    "--runs",
    "2",
  ]);

  assert.equal(decideArgumentRefusal(args), null);

  const plan = buildStepPlan(args);
  assert.deepEqual(
    plan.map((step) => step.name),
    [
      "variant-smoke-test",
      "sandcastle2-sweep-webgl",
      "sandcastle2-sweep-webgpu",
      "visual-regression",
    ],
  );
  assert.deepEqual(
    plan.map((step) => step.command),
    [
      "node Tools/variant-smoke-test.mjs --url http://localhost:8094",
      "node Tools/sandcastle2-sweep-probe.mjs --renderer webgl --runs 2",
      "node Tools/sandcastle2-sweep-probe.mjs --renderer webgpu --runs 2",
      "node Tools/visual-regression/capture-and-diff.mjs",
    ],
  );
  assert.equal(plan[1].env.PORT, "8094");
  assert.equal(plan[1].env.BUCKET_PORT, "8095");
  assert.equal(plan[2].env.SANDCASTLE2_BUCKET_PORT, "8095");
});

test("--update-baselines without --reason refuses with exit 3 and a named reason", () => {
  const args = parseArgs(["--wave", "wave-1", "--update-baselines"]);
  const refusal = decideArgumentRefusal(args);

  assert.equal(refusal.exitCode, EXIT_CODES.REFUSED);
  assert.equal(refusal.name, REFUSAL_REASONS.BASELINE_REASON_REQUIRED);
  assert.match(refusal.message, /requires --reason/);
});

test("baseline-update plan forwards the reviewed rationale", () => {
  const args = parseArgs([
    "--wave",
    "wave-1",
    "--update-baselines",
    "--reason",
    "WebGPU lighting correction",
  ]);
  const visualStep = buildStepPlan(args).at(-1);

  assert.equal(
    visualStep.command,
    'node Tools/visual-regression/capture-and-diff.mjs --update --confirm-baseline-promotion --update-rationale "WebGPU lighting correction" --reviewed-by wave-end-gate:wave-1',
  );
});

test("verdict function maps exit codes to PASS or FAIL", () => {
  assert.equal(verdictFromExitCodes([]), "PASS");
  assert.equal(verdictFromExitCodes([0]), "PASS");
  assert.equal(verdictFromExitCodes([0, 0, 0, 0]), "PASS");
  assert.equal(verdictFromExitCodes([0, 1, 0, 0]), "FAIL");
  assert.equal(verdictFromExitCodes([2]), "FAIL");
  assert.equal(verdictFromExitCodes([null]), "FAIL");
});

test("receipt shape contains every required field", () => {
  const receipt = buildReceipt({
    wave: "wave-1",
    startedAt: "2026-08-29T10:00:00.000Z",
    finishedAt: "2026-08-29T10:01:00.000Z",
    tip: "0123456789abcdef",
    servedMd5: {
      "Build/CesiumUnminified/Cesium.js": "main-md5",
      "packages/engine/Build/Unminified/index.js": "bucket-md5",
    },
    steps: [
      {
        name: "variant-smoke-test",
        command: "node Tools/variant-smoke-test.mjs",
        exitCode: 0,
        wallMs: 1234,
        ignoredInternalField: true,
      },
    ],
    updateBaselines: true,
    reason: "Reviewed renderer correction",
    verdict: "PASS",
  });

  assert.deepEqual(Object.keys(receipt), [
    "wave",
    "startedAt",
    "finishedAt",
    "tip",
    "servedMd5",
    "steps",
    "baselineUpdate",
    "verdict",
  ]);
  assert.equal(receipt.wave, "wave-1");
  assert.equal(receipt.startedAt, "2026-08-29T10:00:00.000Z");
  assert.equal(receipt.finishedAt, "2026-08-29T10:01:00.000Z");
  assert.equal(receipt.tip, "0123456789abcdef");
  assert.deepEqual(receipt.servedMd5, {
    "Build/CesiumUnminified/Cesium.js": "main-md5",
    "packages/engine/Build/Unminified/index.js": "bucket-md5",
  });
  assert.deepEqual(receipt.steps, [
    {
      name: "variant-smoke-test",
      command: "node Tools/variant-smoke-test.mjs",
      exitCode: 0,
      wallMs: 1234,
    },
  ]);
  assert.deepEqual(receipt.baselineUpdate, {
    requested: true,
    reason: "Reviewed renderer correction",
  });
  assert.equal(receipt.verdict, "PASS");
});

test("mutation control", async (t) => {
  await t.test(
    "removing the baseline reason check makes the refusal disappear",
    async () => {
      const source = await readFile(
        new URL("./wave-end-gate.mjs", import.meta.url),
        "utf8",
      );
      const reasonCheck = "if (args.updateBaselines && !args.reason) {";
      const mutant = source.replace(reasonCheck, "if (false) {");

      assert.notEqual(mutant, source, "reason-check mutation must apply");

      const importableMutant = mutant.replace(/^#![^\r\n]*(?:\r?\n)?/, "");
      const dataUrl = `data:text/javascript;base64,${Buffer.from(importableMutant).toString("base64")}`;
      const mutatedModule = await import(dataUrl);

      const refusal = mutatedModule.decideArgumentRefusal(
        mutatedModule.parseArgs(["--wave", "wave-1", "--update-baselines"]),
      );

      assert.equal(refusal, null);
    },
  );
});
