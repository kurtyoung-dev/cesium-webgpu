// C11-13 preservation repair — exact voxel-pick log-depth pipeline identity.
// @purpose Pins the exact voxel-pick log-depth pipeline identity across Picking.js, VoxelPrimitive.js, the WebGPU pick pass and the probe that observes it.
// @status ACTIVE
//
// Run: node --test Tools/visual-regression/c11-13-voxel-pick-pipeline-name.spec.mjs

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  exactC1113VoxelPickPipelineName,
  expectedC1113VoxelPickPipelineName,
} from "./lib/c11-13-voxel-pick-pipeline-name.mjs";

const helperSource = await readFile(
  new URL("./lib/c11-13-voxel-pick-pipeline-name.mjs", import.meta.url),
  "utf8",
);
const probeSource = await readFile(
  new URL("./probe-voxel-cell-pick.mjs", import.meta.url),
  "utf8",
);
const pickingSource = await readFile(
  new URL("../../packages/engine/Source/Scene/Picking.js", import.meta.url),
  "utf8",
);
const voxelPrimitiveSource = await readFile(
  new URL(
    "../../packages/engine/Source/Scene/VoxelPrimitive.js",
    import.meta.url,
  ),
  "utf8",
);
const pickPassSource = await readFile(
  new URL(
    "../../packages/engine/Source/Renderer/WebGPU/WebGPUSceneRendererPickPass.ts",
    import.meta.url,
  ),
  "utf8",
);

function assessHelperSource(source) {
  const errors = [];
  for (const field of ["master", "frame", "realized"]) {
    if (!source.includes(`typeof state?.${field} !== "boolean"`)) {
      errors.push(`${field} must be an exact boolean`);
    }
  }
  if (
    !source.includes("const expectedRealized = state.master && state.frame;")
  ) {
    errors.push("realized log depth must use master AND frame");
  }
  if (!source.includes("state.realized !== expectedRealized")) {
    errors.push("realized state must match the independent expectation");
  }
  if (!source.includes('state.realized ? " [ld]" : ""')) {
    errors.push("the exact realized suffix is required");
  }
  if (
    !source.includes("expectedName !== null && actualName === expectedName")
  ) {
    errors.push("the actual descriptor must equal the exact non-null name");
  }
  return errors;
}

function mutateOnce(source, before, after) {
  assert.equal(source.split(before).length - 1, 1, `unique mutant: ${before}`);
  const mutant = source.replace(before, after);
  assert.notEqual(mutant, source, `mutant must change: ${before}`);
  return mutant;
}

test("all master/frame states map to one exact realized name", () => {
  for (const master of [false, true]) {
    for (const frame of [false, true]) {
      const realized = master && frame;
      const state = { master, frame, realized };
      const expected = `Voxel pickVoxel pipeline${realized ? " [ld]" : ""}`;
      assert.equal(expectedC1113VoxelPickPipelineName(state), expected);
      assert.equal(exactC1113VoxelPickPipelineName(state, expected), true);
      assert.equal(
        exactC1113VoxelPickPipelineName(state, `${expected}-extra`),
        false,
      );
    }
  }
});

test("missing, nonboolean, and inconsistent state fails closed", () => {
  for (const state of [
    null,
    {},
    { master: 1, frame: true, realized: true },
    { master: true, frame: "true", realized: true },
    { master: true, frame: true, realized: 1 },
    { master: true, frame: true, realized: false },
    { master: false, frame: true, realized: true },
    { master: true, frame: false, realized: true },
  ]) {
    assert.equal(expectedC1113VoxelPickPipelineName(state), null);
    assert.equal(
      exactC1113VoxelPickPipelineName(state, "Voxel pickVoxel pipeline [ld]"),
      false,
    );
  }
});

test("source mutants lock AND, exact suffix, fail-closed types, and equality", () => {
  assert.deepEqual(assessHelperSource(helperSource), []);
  const mutants = [
    mutateOnce(
      helperSource,
      "const expectedRealized = state.master && state.frame;",
      "const expectedRealized = state.master || state.frame;",
    ),
    mutateOnce(
      helperSource,
      'state.realized ? " [ld]" : ""',
      'state.realized ? "" : ""',
    ),
    mutateOnce(
      helperSource,
      'typeof state?.master !== "boolean"',
      "!state?.master",
    ),
    mutateOnce(
      helperSource,
      "expectedName !== null && actualName === expectedName",
      "expectedName !== null && actualName.startsWith(expectedName)",
    ),
    mutateOnce(helperSource, "state.realized !== expectedRealized", "false"),
  ];
  for (const mutant of mutants) {
    assert.notDeepEqual(assessHelperSource(mutant), []);
  }
});

test("the physical probe records independent state and uses only the exact helper", () => {
  for (const token of [
    "master: scene.context._pickLogDepthWriteEnabled",
    "frame: scene.frameState.useLogDepth",
    "realized: cache._pipelinePickLogActive",
    "expectedC1113VoxelPickPipelineName(",
    "exactC1113VoxelPickPipelineName(",
  ]) {
    assert.equal(probeSource.includes(token), true, token);
  }
  assert.doesNotMatch(
    probeSource,
    /pickVoxelPipelineName\s*===\s*"Voxel pickVoxel pipeline"/u,
  );
  assert.doesNotMatch(probeSource, /pickVoxelPipelineName\.startsWith/u);
});

function assessSelectedOwnerContract({ probe, picking, primitive, pickPass }) {
  const errors = [];
  if (
    !/scene\._picking\.pickVoxelCoordinate\(scene, pos, 1, 1, prim\)/u.test(
      probe,
    )
  ) {
    errors.push("the probe must pass its exact voxel primitive owner");
  }
  if (
    !/pickVoxelCoordinate\(scene, windowPosition, width, height, voxelPrimitive\)[\s\S]*?frameState\._pickVoxelPrimitive = voxelPrimitive[\s\S]*?finally \{[\s\S]*?frameState\._pickVoxelPrimitive = undefined/u.test(
      picking,
    )
  ) {
    errors.push("Picking must scope the selected owner to the mini-frame");
  }
  if (
    !/frameState\.passes\.pickVoxel[\s\S]*?defined\(frameState\._pickVoxelPrimitive\)[\s\S]*?frameState\._pickVoxelPrimitive !== this[\s\S]*?return;/u.test(
      primitive,
    )
  ) {
    errors.push("non-selected voxel primitives must skip the selected pass");
  }
  if (
    !/selectedVoxelOwner !== undefined[\s\S]*?dispatchedVoxelOwner === selectedVoxelOwner/u.test(
      pickPass,
    )
  ) {
    errors.push("WebGPU must reject a missing or mismatched voxel owner");
  }
  return errors;
}

test("the probe supplies the selected owner required by the WebGPU mini-frame", () => {
  const sources = {
    probe: probeSource,
    picking: pickingSource,
    primitive: voxelPrimitiveSource,
    pickPass: pickPassSource,
  };
  assert.deepEqual(assessSelectedOwnerContract(sources), []);

  const missingProbeOwner = {
    ...sources,
    probe: mutateOnce(
      probeSource,
      "scene._picking.pickVoxelCoordinate(scene, pos, 1, 1, prim)",
      "scene._picking.pickVoxelCoordinate(scene, pos, 1, 1)",
    ),
  };
  assert.notDeepEqual(assessSelectedOwnerContract(missingProbeOwner), []);

  const failOpenPickPass = {
    ...sources,
    pickPass: mutateOnce(
      pickPassSource,
      "selectedVoxelOwner !== undefined &&",
      "selectedVoxelOwner === undefined ||",
    ),
  };
  assert.notDeepEqual(assessSelectedOwnerContract(failOpenPickPass), []);
});
