// primitive-texture-bindgroup-probe-gates.spec.mjs — negative controls for the
// Edge probe's verdict logic. Pure Node: no browser, no GPU, no build.
//
// @purpose Proves every gate in probe-primitive-texture-bindgroup's verdict can actually fail, including the "nothing drew" canary that replaced an unfireable nonBlackPct check.
// @status ACTIVE
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
//
// A gate that cannot fire lets an acceptance pass vacuously, and this
// repository has paid for that instrument defect more than once. The probe next
// to this file IS the acceptance for rows `AR-834`/`AR-832`, so every one of its
// gates needs a negative control the way the structural guard next to it does.
//
// The specific defect this file was written for: the probe's original
// "nothing drew" gate read `frameStats().nonBlackPct < 1`. The scene's ground is
// `BACKGROUND_COLOR` = (13, 15, 23) in 8-bit, and `frameStats` counts a pixel
// non-black when ANY channel exceeds 12 — so a canvas showing nothing but the
// background already reads 100 %, and the gate could not fire on any leg, ever.
// `frustum-flat` was still covered by the WebGL pixel diff, but the three
// WebGPU-only clause-3 scenes have no diff: they would have been gated on
// errors alone, and "frames counting, nothing drawn" is precisely the shape of
// the bug under repair (an invalidated command buffer). The canary is now
// `distinctCoarseColors`, and B1/B2 below pin both halves of that argument.
//
// ── HOW IT AVOIDS CERTIFYING ITSELF ─────────────────────────────────────────
//
// The two constants the argument turns on are read from the code that owns
// them, never retyped here: `BACKGROUND_COLOR` is imported from the probe, and
// the pixel statistics come from the real `frameStats` in
// `Tools/lib/png-decode.mjs` — the same function the probe calls on its real
// captures. B1's claim is therefore a measurement of the shipped helper against
// the shipped colour, not an assertion about a copy of either.
//
// Run: node --test Tools/visual-regression/primitive-texture-bindgroup-probe-gates.spec.mjs

import assert from "node:assert/strict";
import test from "node:test";

import { frameStats } from "../lib/png-decode.mjs";
import {
  BACKGROUND_COLOR,
  decideSceneVerdict,
  highContrastAdjacentPct,
} from "./probe-primitive-texture-bindgroup.mjs";

/** A solid image in the probe's own background colour. */
function backgroundOnlyImage(width = 32, height = 24) {
  const data = new Uint8Array(width * height * 4);
  const channel = (value) => Math.round(value * 255);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = channel(BACKGROUND_COLOR[0]);
    data[i * 4 + 1] = channel(BACKGROUND_COLOR[1]);
    data[i * 4 + 2] = channel(BACKGROUND_COLOR[2]);
    data[i * 4 + 3] = 255;
  }
  return { width, height, data };
}

/** The same image with a block of a second colour drawn into it. */
function imageWithSomethingDrawn() {
  const image = backgroundOnlyImage();
  for (let y = 4; y < 16; y++) {
    for (let x = 4; x < 20; x++) {
      const o = (y * image.width + x) * 4;
      image.data[o] = 200;
      image.data[o + 1] = 20;
      image.data[o + 2] = 20;
    }
  }
  return image;
}

/** A leg record shaped like the probe's, defaulting to a clean pass. */
function leg(overrides = {}) {
  const drawn = frameStats(imageWithSomethingDrawn());
  return {
    renderer: "webgpu",
    errors: [],
    deviceLost: null,
    nonBlackPct: drawn.nonBlackPct,
    distinctCoarseColors: drawn.distinctCoarseColors,
    highContrastAdjacentPct: 1.0,
    ...overrides,
  };
}

const SCENE = { id: "frustum-flat", claim: "under test" };

test("B1 the retired nonBlackPct gate was unfireable — the background alone pins it at 100%", () => {
  const stats = frameStats(backgroundOnlyImage());
  assert.equal(
    stats.nonBlackPct,
    100,
    "a canvas showing only the probe's background must read 100% non-black — " +
      "this is why `nonBlackPct < 1` could never fire and is not the canary",
  );
  assert.equal(
    stats.distinctCoarseColors,
    1,
    "one flat colour must bin to exactly one coarse colour",
  );
  assert.ok(
    frameStats(imageWithSomethingDrawn()).distinctCoarseColors >= 2,
    "anything drawn over the background must raise the coarse-colour count",
  );
});

test("B2 NEGATIVE CONTROL — a leg that drew nothing over the background FAILS", () => {
  const empty = frameStats(backgroundOnlyImage());
  const verdict = decideSceneVerdict(SCENE, {
    webgpu: leg({
      nonBlackPct: empty.nonBlackPct,
      distinctCoarseColors: empty.distinctCoarseColors,
    }),
  });
  assert.equal(verdict.pass, false);
  assert.match(verdict.reasons.join(" | "), /nothing drew over the background/);
});

test("B3 a clean leg passes, so the gates above are not failing everything", () => {
  const verdict = decideSceneVerdict(SCENE, { webgpu: leg() });
  assert.deepEqual(verdict.reasons, []);
  assert.equal(verdict.pass, true);
});

test("B4 NEGATIVE CONTROL — each receipt message fails the verdict by name", () => {
  const entryCount = decideSceneVerdict(SCENE, {
    webgpu: leg({
      errors: [
        'console.warning: Number of entries (2) did not match the expected number of entries (3) for [BindGroupLayoutInternal "Texture BGL"].',
      ],
    }),
  });
  assert.equal(entryCount.pass, false);
  assert.match(
    entryCount.reasons.join(" | "),
    /bind-group entry-count mismatch on Texture BGL/,
  );

  const invalid = decideSceneVerdict(SCENE, {
    webgpu: leg({
      errors: [
        "console.error: [Invalid BindGroup (unlabeled)] is invalid due to a previous error. - While encoding [RenderPassEncoder].SetBindGroup(2, [Invalid BindGroup (unlabeled)], 0, ...).",
      ],
    }),
  });
  assert.equal(invalid.pass, false);
  assert.match(
    invalid.reasons.join(" | "),
    /invalid bind group at SetBindGroup\(2/,
  );

  const lost = decideSceneVerdict(SCENE, {
    webgpu: leg({ deviceLost: "device lost: destroyed" }),
  });
  assert.equal(lost.pass, false);
  assert.match(lost.reasons.join(" | "), /device lost/);

  const missing = decideSceneVerdict(SCENE, {});
  assert.equal(missing.pass, false);
  assert.match(missing.reasons.join(" | "), /no webgpu leg/);
});

test("B5 NEGATIVE CONTROL — the clause-2 pixel gates fail past their bounds and pass inside them", () => {
  const webgl = leg({ renderer: "webgl" });

  const tooDifferent = decideSceneVerdict(SCENE, {
    webgl,
    webgpu: leg({
      diff: { comparable: true, mismatchPct: 41.7 },
    }),
  });
  assert.equal(tooDifferent.pass, false);
  assert.match(tooDifferent.reasons.join(" | "), /41\.70% of pixels/);

  // A checkerboard's signature: the same diff budget, but a far higher density
  // of high-contrast neighbours than the WebGL leg carries.
  const checkerboardish = decideSceneVerdict(SCENE, {
    webgl,
    webgpu: leg({
      diff: { comparable: true, mismatchPct: 0.1 },
      highContrastAdjacentPct: webgl.highContrastAdjacentPct + 9.5,
    }),
  });
  assert.equal(checkerboardish.pass, false);
  assert.match(
    checkerboardish.reasons.join(" | "),
    /more high-contrast adjacent pixels than webgl/,
  );

  const incomparable = decideSceneVerdict(SCENE, {
    webgl,
    webgpu: leg({ diff: { comparable: false, reason: "size mismatch" } }),
  });
  assert.equal(incomparable.pass, false);
  assert.match(
    incomparable.reasons.join(" | "),
    /not comparable: size mismatch/,
  );

  const clean = decideSceneVerdict(SCENE, {
    webgl,
    webgpu: leg({ diff: { comparable: true, mismatchPct: 0.4 } }),
  });
  assert.deepEqual(clean.reasons, []);
  assert.equal(clean.pass, true);
});

test("B6 highContrastAdjacentPct separates a flat fill from a tiled pattern", () => {
  assert.equal(
    highContrastAdjacentPct(backgroundOnlyImage()),
    0,
    "a flat fill has no high-contrast neighbours",
  );
  // An 8-pixel-block grey checkerboard, the exact placeholder this row removed.
  const width = 64;
  const height = 16;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const light = (Math.floor(x / 8) + Math.floor(y / 8)) % 2 === 0;
      const value = light ? 230 : 80;
      const o = (y * width + x) * 4;
      data[o] = value;
      data[o + 1] = value;
      data[o + 2] = value;
      data[o + 3] = 255;
    }
  }
  assert.ok(
    highContrastAdjacentPct({ width, height, data }) > 5,
    "a tiled checkerboard must raise the statistic well past the 2pp gate",
  );
});
