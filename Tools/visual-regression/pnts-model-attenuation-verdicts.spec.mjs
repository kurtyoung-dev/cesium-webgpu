// pnts-model-attenuation-verdicts.spec.mjs — browser-free verdict contracts.
// @purpose Executes the PNTS model-path attenuation probe's decision functions against synthetic footprint counters, including the pre-fix shape the probe exists to catch, without launching a browser.
// @status ACTIVE

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAttenuationVerdicts,
  decideIdentityVerdict,
  decideLivenessVerdict,
  decideParityVerdict,
  identityHashesFromReceipt,
} from "./probe-pnts-model-attenuation.mjs";

const DISTANCES = ["near", "mid", "far"];

/**
 * One cell of a synthetic run. `litPixels` is applied to the near distance and
 * scaled down for the other two, so a cell reads like a real capture set
 * without the spec having to spell every sample out.
 *
 * @param {string} renderer Backend.
 * @param {string} setting Setting id.
 * @param {number} litPixels Near-distance footprint.
 * @param {object} [overrides] Extra cell fields.
 * @returns {object} The cell.
 */
function cell(renderer, setting, litPixels, overrides = {}) {
  return {
    renderer,
    setting,
    identityLeg: setting === "shading-off",
    gateErrors: [],
    consoleErrors: [],
    deviceLost: null,
    samples: DISTANCES.map((distance, index) => ({
      distance,
      litPixels: Math.round(litPixels / (index + 1)),
      sha256: `${renderer}-${setting}-${distance}`,
    })),
    ...overrides,
  };
}

/**
 * The world as it is BEFORE the fix: WebGL's footprint grows with
 * `maximumAttenuation`, WebGPU's does not move at all because every point is
 * one pixel whatever the setting says.
 *
 * @returns {Array<object>} Cells.
 */
function preFixCells() {
  return [
    cell("webgl", "shading-off", 90),
    cell("webgl", "atten-max4", 800),
    cell("webgl", "atten-max16", 6000),
    cell("webgpu", "shading-off", 90),
    cell("webgpu", "atten-max4", 90),
    cell("webgpu", "atten-max16", 90),
  ];
}

/**
 * The world as it should be AFTER the fix: both backends respond, and their
 * footprints agree.
 *
 * @returns {Array<object>} Cells.
 */
function postFixCells() {
  return [
    cell("webgl", "shading-off", 90),
    cell("webgl", "atten-max4", 800),
    cell("webgl", "atten-max16", 6000),
    cell("webgpu", "shading-off", 90),
    cell("webgpu", "atten-max4", 830),
    cell("webgpu", "atten-max16", 6100),
  ];
}

const GATES = {
  livenessRatio: 1.5,
  parityGate: 1.35,
  baselineHashes: new Map(),
};

/**
 * @param {Array<object>} verdicts Verdicts.
 * @param {string} id Verdict id.
 * @returns {object} The verdict.
 */
function byId(verdicts, id) {
  const found = verdicts.find((verdict) => verdict.id === id);
  assert.ok(found, `expected a verdict with id ${id}`);
  return found;
}

test("a footprint that does not move when maximumAttenuation quadruples fails liveness", () => {
  const verdicts = buildAttenuationVerdicts(preFixCells(), GATES);
  assert.equal(byId(verdicts, "liveness/webgpu").pass, false);
  assert.equal(byId(verdicts, "liveness/webgpu").growthRatio, 1);
});

test("the WebGL leg is the control and passes liveness on the same captures", () => {
  const verdicts = buildAttenuationVerdicts(preFixCells(), GATES);
  const control = byId(verdicts, "liveness/webgl");
  assert.equal(control.control, true);
  assert.equal(control.pass, true);
  assert.ok(control.growthRatio > 1.5);
});

test("a responding WebGPU footprint passes liveness and cross-backend parity", () => {
  const verdicts = buildAttenuationVerdicts(postFixCells(), GATES);
  assert.equal(byId(verdicts, "liveness/webgpu").pass, true);
  for (const distance of DISTANCES) {
    assert.equal(byId(verdicts, `parity/atten-max16/${distance}`).pass, true);
  }
});

test("the pre-fix run fails parity on every attenuated cell and passes it with shading off", () => {
  const verdicts = buildAttenuationVerdicts(preFixCells(), GATES);
  for (const distance of DISTANCES) {
    assert.equal(byId(verdicts, `parity/atten-max4/${distance}`).pass, false);
    assert.equal(byId(verdicts, `parity/atten-max16/${distance}`).pass, false);
    assert.equal(byId(verdicts, `parity/shading-off/${distance}`).pass, true);
  }
});

test("parity verdicts declare themselves provisional", () => {
  const verdicts = buildAttenuationVerdicts(postFixCells(), GATES);
  assert.equal(byId(verdicts, "parity/atten-max4/near").provisional, true);
});

test("a parity verdict fails in both directions, not only when WebGPU is smaller", () => {
  assert.equal(
    decideParityVerdict({
      webglLitPixels: 100,
      webgpuLitPixels: 200,
      gate: 1.35,
    }).pass,
    false,
  );
  assert.equal(
    decideParityVerdict({
      webglLitPixels: 200,
      webgpuLitPixels: 100,
      gate: 1.35,
    }).pass,
    false,
  );
});

test("an identity verdict with no baseline does not pass", () => {
  const verdicts = buildAttenuationVerdicts(postFixCells(), GATES);
  const identity = byId(verdicts, "identity/webgpu/shading-off/near");
  assert.equal(identity.status, "pending-baseline");
  assert.equal(identity.pass, false);
});

test("an identity verdict passes only when the banked hash matches", () => {
  const cells = postFixCells();
  const baselineHashes = identityHashesFromReceipt({ cells });
  const matched = buildAttenuationVerdicts(cells, { ...GATES, baselineHashes });
  assert.equal(byId(matched, "identity/webgpu/shading-off/near").pass, true);

  const changed = postFixCells();
  const disabledLeg = changed.find(
    (entry) => entry.renderer === "webgpu" && entry.setting === "shading-off",
  );
  disabledLeg.samples[0].sha256 = "a-different-frame";
  const rejected = buildAttenuationVerdicts(changed, {
    ...GATES,
    baselineHashes,
  });
  const verdict = byId(rejected, "identity/webgpu/shading-off/near");
  assert.equal(verdict.status, "changed");
  assert.equal(verdict.pass, false);
});

test("only the disabled-shading captures are banked as identity baselines", () => {
  const hashes = identityHashesFromReceipt({ cells: postFixCells() });
  assert.equal(hashes.size, 6);
  for (const key of hashes.keys()) {
    assert.match(key, /shading-off/);
  }
});

test("a GPU validation fault, a console fault or a lost device fails its cell", () => {
  const cells = postFixCells();
  cells[4].gateErrors = ["GPUValidationError: vertex range"];
  cells[5].consoleErrors = ["console.error: popErrorScope"];
  cells[3].deviceLost = "destroyed";
  const verdicts = buildAttenuationVerdicts(cells, GATES);
  assert.equal(byId(verdicts, "errors/webgpu/atten-max4").pass, false);
  assert.equal(byId(verdicts, "errors/webgpu/atten-max16").pass, false);
  assert.equal(byId(verdicts, "errors/webgpu/shading-off").pass, false);
  assert.equal(byId(verdicts, "errors/webgl/atten-max4").pass, true);
});

test("a single-backend run emits no cross-backend verdict rather than a failing one", () => {
  const cells = postFixCells().filter((entry) => entry.renderer === "webgpu");
  const verdicts = buildAttenuationVerdicts(cells, GATES);
  assert.equal(
    verdicts.some((verdict) => verdict.id.startsWith("parity/")),
    false,
  );
  assert.equal(
    verdicts.some((verdict) => verdict.id === "liveness/webgl"),
    false,
  );
  assert.equal(byId(verdicts, "liveness/webgpu").pass, true);
});

test("a zero-footprint capture cannot pass liveness through a divide by zero", () => {
  const verdict = decideLivenessVerdict({
    smallLitPixels: 0,
    largeLitPixels: 0,
    ratioGate: 1.5,
  });
  assert.equal(Number.isFinite(verdict.growthRatio), false);
  assert.equal(verdict.pass, false);
});

test("an unreadable baseline yields no hashes rather than throwing", () => {
  assert.equal(identityHashesFromReceipt(null).size, 0);
  assert.equal(identityHashesFromReceipt({}).size, 0);
});

test("decideIdentityVerdict treats an absent baseline and a null baseline alike", () => {
  assert.equal(
    decideIdentityVerdict({ sha256: "a" }).status,
    "pending-baseline",
  );
  assert.equal(
    decideIdentityVerdict({ sha256: "a", baselineSha256: null }).status,
    "pending-baseline",
  );
});
