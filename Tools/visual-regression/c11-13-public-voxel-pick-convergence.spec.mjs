import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { advanceC1113PublicVoxelPickConvergence } from "./lib/c11-13-public-voxel-pick-convergence.mjs";

const probeSource = await readFile(
  new URL("./probe-voxel-pick.mjs", import.meta.url),
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

test("the physical probe consumes the exact convergence result fail-closed", () => {
  assert.match(
    probeSource,
    /advanceC1113PublicVoxelPickConvergence\.toString\(\)/u,
  );
  assert.match(
    probeSource,
    /convergence = advanceConvergence\(\s*convergence,\s*isCell \? key : null,?\s*\)/u,
  );
  assert.match(probeSource, /if \(convergence\.stable\) \{/u);
  assert.match(probeSource, /stable: convergence\.stable/u);
  assert.match(probeSource, /gl\.stable === true/u);
  assert.match(probeSource, /gp\.stable === true/u);
  assert.doesNotMatch(
    probeSource,
    /prevKey !== null && i >= 2 && prevKey === key/u,
  );
});
