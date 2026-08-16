// @purpose node:test contract for the public voxel-pick convergence state machine (two identical consecutive cells = stable; undefined never converges).
// @status ACTIVE

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { advanceC1113PublicVoxelPickConvergence } from "./lib/c11-13-public-voxel-pick-convergence.mjs";

const probeSource = await readFile(
  new URL("./probe-voxel-pick.mjs", import.meta.url),
  "utf8",
);
const refinedProbeSource = await readFile(
  new URL("./probe-voxel-refined-pick.mjs", import.meta.url),
  "utf8",
);

function runSequence(keys) {
  let state = {
    lastCellKey: null,
    consecutiveCellCount: 0,
    stable: false,
  };
  return keys.map((key) => {
    state = advanceC1113PublicVoxelPickConvergence(state, key);
    return state;
  });
}

test("undefined results never converge while two identical cells do", () => {
  const cold = runSequence([null, null, null, null]);
  assert.equal(
    cold.some((state) => state.stable),
    false,
  );

  const warmed = runSequence([null, "0/19", null, "0/19", "0/19"]);
  assert.equal(warmed.at(-2).stable, false);
  assert.deepEqual(warmed.at(-1), {
    lastCellKey: "0/19",
    consecutiveCellCount: 2,
    stable: true,
  });
});

test("a different cell or a cold gap resets the real-cell streak", () => {
  const changed = runSequence(["0/19", "0/15", "0/15"]);
  assert.equal(changed[1].stable, false);
  assert.equal(changed[2].stable, true);

  const interrupted = runSequence(["0/19", null, "0/19"]);
  assert.equal(interrupted.at(-1).stable, false);
  assert.equal(interrupted.at(-1).consecutiveCellCount, 1);
});

function assertProbeConsumesConvergence(source) {
  assert.match(source, /advanceC1113PublicVoxelPickConvergence\.toString\(\)/u);
  assert.match(
    source,
    /convergence = advanceConvergence\(\s*convergence,\s*isCell \? key : null,?\s*\)/u,
  );
  assert.match(source, /if \(convergence\.stable\) \{/u);
  assert.match(source, /stable: convergence\.stable/u);
  assert.match(source, /gl\.stable === true/u);
  assert.match(source, /gp\.stable === true/u);
  assert.doesNotMatch(source, /prevKey !== null && i >= 2 && prevKey === key/u);
}

test("both public physical probes consume the exact convergence result fail-closed", () => {
  assertProbeConsumesConvergence(probeSource);
  assertProbeConsumesConvergence(refinedProbeSource);
});
