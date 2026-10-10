// postprocess-hdr-toggle-verdict.spec.mjs — fixture contract for the two pure
// functions that decide the HDR toggle probe's per-step verdict.
//
// @purpose Pins `judgeHdrStep` (the per-step pass/fail and device-blocked judgement of probe-postprocess-hdr-toggle) against hand-built step records at the probe's own limits, and `meanChroma` (the grey-frame measure that verdict reads) against small fixture images, so a change to either cannot silently re-rate the Edge leg.
// @status ACTIVE
//
// The probe's verdict is computed in Node from a step record and the banked
// frame; nothing here needs a browser. The records below are the shapes
// `pageApplyHdrStep` returns plus the two fields the probe adds
// (`consoleErrors`, `frame`), and the limits are imported from the probe, so the
// spec judges at the thresholds the Edge leg is pre-registered at.
//
// Run: node --test Tools/visual-regression/postprocess-hdr-toggle-verdict.spec.mjs

import assert from "node:assert/strict";
import test from "node:test";
import { meanChroma } from "./lib/metrics/mean-chroma.mjs";
import {
  HDR_CANVAS_FORMAT,
  judgeHdrStep,
} from "./lib/postprocess-hdr-toggle-steps.mjs";
import { HDR_TOGGLE_LIMITS } from "./probe-postprocess-hdr-toggle.mjs";

/**
 * A step record that passes: an armed gate with no error, no console error, a
 * live colour-grading stage, a lit and grey frame, on an SDR canvas that was
 * not asked for HDR. Each case overrides one part of it.
 *
 * @param {object} [overrides] Top-level fields to replace.
 * @returns {object} The record.
 */
function cleanRecord(overrides = {}) {
  return {
    flags: { highDynamicRange: false, useHDRCanvasOutput: false },
    canvas: { presentationFormat: "bgra8unorm", hdrCanvasOutput: false },
    postProcess: {
      hasActiveStages: true,
      tonemapEnabled: false,
      colorGradingEnabled: true,
      fxaaEnabled: true,
    },
    gate: { armed: 1, total: 0, errors: [], deviceLost: null },
    consoleErrors: [],
    frame: { nonBlackFraction: 0.4, meanChroma: 1.5 },
    ...overrides,
  };
}

const judge = (record) => judgeHdrStep(record, HDR_TOGGLE_LIMITS);

test("the probe's limits are the pre-registered ones", () => {
  assert.deepEqual(
    { ...HDR_TOGGLE_LIMITS },
    { nonBlackFloor: 0.05, chromaCeiling: 6 },
  );
});

test("judgeHdrStep: a clean step passes with no reason", () => {
  assert.deepEqual(judge(cleanRecord()), {
    pass: true,
    deviceBlocked: false,
    reasons: [],
  });
});

test("judgeHdrStep: each failure condition fails the step on its own, with its reason", () => {
  const cases = [
    {
      name: "one uncaptured WebGPU error",
      record: cleanRecord({
        gate: {
          armed: 1,
          total: 1,
          errors: [{ message: "Attachment state is not compatible" }],
          deviceLost: null,
        },
      }),
      reason: /^1 uncaptured WebGPU error\(s\)$/,
    },
    {
      name: "a gate that armed no device",
      record: cleanRecord({
        gate: { armed: 0, total: 0, errors: [], deviceLost: null },
      }),
      reason: /error gate was not armed/,
    },
    {
      name: "no gate at all",
      record: cleanRecord({ gate: null }),
      reason: /error gate was not armed/,
    },
    {
      name: "a lost device",
      record: cleanRecord({
        gate: { armed: 1, total: 0, errors: [], deviceLost: "destroyed" },
      }),
      reason: /^device lost: destroyed$/,
    },
    {
      name: "a console error",
      record: cleanRecord({ consoleErrors: ["boom"] }),
      reason: /^1 console error\(s\)$/,
    },
    {
      name: "no post-process pipeline reported",
      record: cleanRecord({ postProcess: null }),
      reason: /reported no pipeline/,
    },
    {
      name: "a colour-grading stage reported undefined (the dead latch)",
      record: cleanRecord({
        postProcess: {
          hasActiveStages: true,
          tonemapEnabled: true,
          colorGradingEnabled: null,
          fxaaEnabled: true,
        },
      }),
      reason: /colour-grading stage is not live \(reported null\)/,
    },
    {
      name: "a colour-grading stage reported disabled",
      record: cleanRecord({
        postProcess: {
          hasActiveStages: true,
          tonemapEnabled: false,
          colorGradingEnabled: false,
          fxaaEnabled: true,
        },
      }),
      reason: /colour-grading stage is not live \(reported false\)/,
    },
    {
      name: "a dead frame",
      record: cleanRecord({ frame: { nonBlackFraction: 0.01, meanChroma: 0 } }),
      reason: /the frame is dead/,
    },
    {
      name: "a frame with no measured non-black fraction",
      record: cleanRecord({
        frame: { nonBlackFraction: Number.NaN, meanChroma: 0 },
      }),
      reason: /the frame is dead/,
    },
    {
      name: "a coloured frame (the grade did not run)",
      record: cleanRecord({ frame: { nonBlackFraction: 0.4, meanChroma: 30 } }),
      reason: /the frame is not grey/,
    },
  ];
  for (const { name, record, reason } of cases) {
    const verdict = judge(record);
    assert.equal(verdict.pass, false, `${name}: must fail`);
    assert.equal(verdict.reasons.length, 1, `${name}: exactly one reason`);
    assert.match(verdict.reasons[0], reason, `${name}: the reason`);
  }
});

test("judgeHdrStep: the frame limits are inclusive", () => {
  const verdict = judge(
    cleanRecord({
      frame: {
        nonBlackFraction: HDR_TOGGLE_LIMITS.nonBlackFloor,
        meanChroma: HDR_TOGGLE_LIMITS.chromaCeiling,
      },
    }),
  );
  assert.equal(verdict.pass, true, verdict.reasons.join("; "));
});

test("judgeHdrStep: failures accumulate rather than stopping at the first", () => {
  const verdict = judge(
    cleanRecord({
      consoleErrors: ["a", "b"],
      postProcess: null,
      frame: { nonBlackFraction: 0, meanChroma: 40 },
    }),
  );
  assert.equal(verdict.pass, false);
  assert.equal(verdict.reasons.length, 4, verdict.reasons.join("; "));
});

test("judgeHdrStep: an HDR canvas request demoted by the device is deviceBlocked and still passes when clean", () => {
  const askedForHdr = { highDynamicRange: true, useHDRCanvasOutput: true };
  const demoted = [
    { presentationFormat: "bgra8unorm", hdrCanvasOutput: false },
    { presentationFormat: "bgra8unorm", hdrCanvasOutput: true },
    { presentationFormat: HDR_CANVAS_FORMAT, hdrCanvasOutput: false },
  ];
  for (const canvas of demoted) {
    const verdict = judge(cleanRecord({ flags: askedForHdr, canvas }));
    assert.deepEqual(
      { pass: verdict.pass, deviceBlocked: verdict.deviceBlocked },
      { pass: true, deviceBlocked: true },
      `canvas ${JSON.stringify(canvas)}`,
    );
  }
  // A deviceBlocked step is still judged on everything else.
  const dirty = judge(
    cleanRecord({
      flags: askedForHdr,
      canvas: demoted[0],
      gate: { armed: 1, total: 1, errors: [{}], deviceLost: null },
    }),
  );
  assert.deepEqual(
    { pass: dirty.pass, deviceBlocked: dirty.deviceBlocked },
    { pass: false, deviceBlocked: true },
  );
});

test("judgeHdrStep: an honoured HDR canvas request, or no request, is not deviceBlocked", () => {
  const honoured = judge(
    cleanRecord({
      flags: { highDynamicRange: true, useHDRCanvasOutput: true },
      canvas: { presentationFormat: HDR_CANVAS_FORMAT, hdrCanvasOutput: true },
    }),
  );
  assert.equal(honoured.deviceBlocked, false);
  assert.equal(honoured.pass, true);
  const notAsked = judge(
    cleanRecord({
      canvas: { presentationFormat: "bgra8unorm", hdrCanvasOutput: false },
    }),
  );
  assert.equal(notAsked.deviceBlocked, false);
});

/**
 * An RGBA image from a list of [r, g, b] pixels in one row.
 *
 * @param {number[][]} pixels The pixels.
 * @returns {{width: number, height: number, data: Uint8ClampedArray}} The image.
 */
function row(pixels) {
  const data = new Uint8ClampedArray(pixels.length * 4);
  pixels.forEach(([r, g, b], i) => data.set([r, g, b, 255], i * 4));
  return { width: pixels.length, height: 1, data };
}

test("meanChroma: averages max-minus-min over the non-black pixels only", () => {
  const result = meanChroma(
    row([
      [100, 100, 100],
      [200, 100, 50],
      [0, 0, 0],
      [16, 16, 16],
    ]),
  );
  assert.deepEqual(result, {
    nonBlackPx: 2,
    meanChroma: 75,
    chromaticFraction: 0.5,
  });
});

test("meanChroma: the black and chroma thresholds are strict", () => {
  // 17 in one channel is non-black (strictly above 16); chroma 8 is not
  // chromatic (strictly above 8), chroma 9 is.
  const result = meanChroma(
    row([
      [17, 0, 0],
      [108, 100, 100],
      [109, 100, 100],
    ]),
  );
  assert.equal(result.nonBlackPx, 3);
  assert.equal(result.meanChroma, (17 + 8 + 9) / 3);
  assert.equal(result.chromaticFraction, 2 / 3);
});

test("meanChroma: an all-black frame reads as zero, not as grey by division", () => {
  assert.deepEqual(
    meanChroma(
      row([
        [0, 0, 0],
        [10, 12, 16],
      ]),
    ),
    { nonBlackPx: 0, meanChroma: 0, chromaticFraction: 0 },
  );
});

test("meanChroma: the thresholds are options", () => {
  // Chroma 5 is not above a chromaThreshold of 5; chroma 10 is.
  const result = meanChroma(
    row([
      [10, 5, 5],
      [30, 20, 20],
    ]),
    { blackThreshold: 8, chromaThreshold: 5 },
  );
  assert.deepEqual(result, {
    nonBlackPx: 2,
    meanChroma: 7.5,
    chromaticFraction: 0.5,
  });
});
