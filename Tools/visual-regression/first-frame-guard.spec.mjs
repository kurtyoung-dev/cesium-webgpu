// first-frame-guard.spec.mjs - the black-first-frame guard. Pure Node.
// @purpose Pins lib/first-frame-guard.mjs over synthetic RGBA frames: a drawn first frame is accepted untouched, a black one is re-settled and recaptured a bounded number of times, and one that stays black is REFUSED (first-frame-black, exit 3) with what the guard saw on every attempt, never returned as a measurement.
// @status ACTIVE
//
// The page work is injected (`capture`, `resettle`), so the loop runs here with
// no browser. The bar is checked at its edges (exactly 1 % non-black accepts,
// just under refuses) because the measured populations it separates (a black
// canvas at 0.004 % and drawn frames at 99.981-100.000 %, from the banked Edge
// run) sit nowhere near it and a bar that drifts would go unnoticed otherwise.
//
//   node --test Tools/visual-regression/first-frame-guard.spec.mjs

import assert from "node:assert/strict";
import test from "node:test";

import {
  FIRST_FRAME_MAX_RESETTLES,
  FIRST_FRAME_MIN_NON_BLACK_PCT,
  decideFirstFrame,
  guardFirstFrame,
} from "./lib/first-frame-guard.mjs";
import { PROBE_EXIT_CODES, ProbeRefusal } from "./lib/probe-refusal.mjs";

/** A 100-pixel frame with `lit` pixels above the black threshold. */
function frame(lit) {
  const data = new Uint8Array(100 * 4);
  for (let i = 0; i < 100; i++) {
    data[i * 4 + 3] = 255;
    if (i < lit) data[i * 4] = 200;
  }
  return { width: 10, height: 10, data };
}

/** Scripted captures: the n-th call returns frames[n] (the last repeats). */
function script(frames) {
  const calls = { capture: [], resettle: [] };
  return {
    calls,
    capture: async (attempt) => {
      calls.capture.push(attempt);
      const lit = frames[Math.min(attempt, frames.length - 1)];
      return { name: `shot-${attempt}`, image: frame(lit) };
    },
    resettle: async (attempt) => {
      calls.resettle.push(attempt);
      return { settled: attempt };
    },
  };
}

test("decideFirstFrame: accepts at the bar, resettles under it while rounds remain, refuses once they are spent", () => {
  assert.equal(FIRST_FRAME_MIN_NON_BLACK_PCT, 1);
  assert.deepEqual(decideFirstFrame(100, 0), {
    action: "accept",
    black: false,
  });
  assert.deepEqual(decideFirstFrame(1, 0), { action: "accept", black: false });
  assert.deepEqual(decideFirstFrame(0.99, 0), {
    action: "resettle",
    black: true,
  });
  assert.deepEqual(decideFirstFrame(0, FIRST_FRAME_MAX_RESETTLES - 1), {
    action: "resettle",
    black: true,
  });
  assert.deepEqual(decideFirstFrame(0, FIRST_FRAME_MAX_RESETTLES), {
    action: "refuse",
    black: true,
  });
});

test("decideFirstFrame: a measurement that is not a number is black, never accepted", () => {
  for (const bad of [NaN, undefined, null]) {
    assert.equal(decideFirstFrame(bad, 0).black, true, String(bad));
  }
  assert.equal(decideFirstFrame(NaN, 0).action, "resettle");
});

test("decideFirstFrame: the config overrides the bar and the number of rounds", () => {
  assert.equal(
    decideFirstFrame(40, 0, { minNonBlackPct: 50, maxResettles: 0 }).action,
    "refuse",
  );
  assert.equal(
    decideFirstFrame(40, 0, { minNonBlackPct: 30, maxResettles: 0 }).action,
    "accept",
  );
});

test("guardFirstFrame: a drawn first frame is accepted with no re-settle", async () => {
  const s = script([100]);
  const out = await guardFirstFrame(s);
  assert.equal(out.accepted.name, "shot-0");
  assert.deepEqual(s.calls.capture, [0]);
  assert.deepEqual(s.calls.resettle, []);
  assert.equal(out.attempts.length, 1);
  assert.equal(out.attempts[0].nonBlackPct, 100);
  assert.equal(out.attempts[0].black, false);
  assert.equal(out.attempts[0].resettleBefore, null);
});

test("guardFirstFrame: a black first frame is re-settled and the recapture is the one returned, with what each attempt saw", async () => {
  const s = script([0, 100]);
  const out = await guardFirstFrame(s);
  assert.equal(out.accepted.name, "shot-1");
  assert.deepEqual(s.calls.capture, [0, 1]);
  assert.deepEqual(s.calls.resettle, [1]);
  assert.deepEqual(
    out.attempts.map((a) => [a.attempt, a.name, a.nonBlackPct, a.black]),
    [
      [0, "shot-0", 0, true],
      [1, "shot-1", 100, false],
    ],
  );
  assert.equal(out.attempts[0].resettleBefore, null);
  assert.deepEqual(out.attempts[1].resettleBefore, { settled: 1 });
  assert.equal(out.minNonBlackPct, FIRST_FRAME_MIN_NON_BLACK_PCT);
  assert.equal(out.maxResettles, FIRST_FRAME_MAX_RESETTLES);
});

test("guardFirstFrame: black on every attempt is a first-frame-black refusal (exit 3) after exactly the bounded re-settles, carrying every measurement", async () => {
  const s = script([0]);
  await assert.rejects(guardFirstFrame(s), (error) => {
    assert.ok(error instanceof ProbeRefusal);
    assert.equal(error.reason, "first-frame-black");
    assert.equal(error.exitCode, PROBE_EXIT_CODES.REFUSAL);
    assert.equal(error.details.attempts.length, FIRST_FRAME_MAX_RESETTLES + 1);
    assert.ok(error.details.attempts.every((a) => a.nonBlackPct === 0));
    assert.match(error.message, /0\.000, 0\.000, 0\.000/);
    return true;
  });
  assert.equal(s.calls.capture.length, FIRST_FRAME_MAX_RESETTLES + 1);
  assert.equal(s.calls.resettle.length, FIRST_FRAME_MAX_RESETTLES);
});

test("guardFirstFrame: the bar is exactly 1 % of pixels (1 lit of 100 accepts, 0 refuses)", async () => {
  assert.equal((await guardFirstFrame(script([1]))).accepted.name, "shot-0");
  await assert.rejects(
    guardFirstFrame({ ...script([0]), maxResettles: 0 }),
    (error) => error.reason === "first-frame-black",
  );
});

test("guardFirstFrame: maxResettles 0 refuses a black first frame without re-settling", async () => {
  const s = script([0]);
  await assert.rejects(
    guardFirstFrame({ ...s, maxResettles: 0 }),
    (error) => error.reason === "first-frame-black",
  );
  assert.deepEqual(s.calls.resettle, []);
});

test("guardFirstFrame: a dim but drawn frame (5 % lit) is a measurement, not a refusal", async () => {
  const out = await guardFirstFrame(script([5]));
  assert.equal(out.accepted.name, "shot-0");
  assert.equal(out.attempts[0].nonBlackPct, 5);
});
