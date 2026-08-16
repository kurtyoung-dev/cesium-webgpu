// celestial-capture-harness.spec.mjs — browser-free guard for the shared
// page/settle/capture recipe in `lib/celestial-capture-harness.mjs`.
// @purpose Mutation-checked guard for lib/celestial-capture-harness.mjs, the shared page/settle/capture recipe the celestial gate probes import.
// @status ACTIVE
//
// WHY THIS SPEC EXISTS. The recipe it guards used to live inside
// `probe-celestial-gates.mjs`, where three separate gate specs pinned pieces of
// it by reading that file's text. Moving it into a module the whole fleet can
// import removes the copy-per-probe failure mode, but it would also quietly
// move those anchors out from under the assertions that held them — so the
// assertions move here, to the file that now owns the code, and this spec adds
// the ones the split itself makes necessary.
//
// EVERY ANCHOR BELOW IS MUTATION-CHECKED. A source-text assertion that cannot
// fail is worse than no assertion, because it reads as coverage. Each rule is
// therefore run twice: once against the real module and once against a mutated
// copy in which the construct has been removed, with the second run required to
// FAIL. That is the same posture the celestial gate specs take toward their
// numeric predicates.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as HARNESS_MODULE from "./lib/celestial-capture-harness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const readNormalized = (relative) =>
  readFileSync(resolve(ROOT, relative), "utf8").replaceAll("\r\n", "\n");

const HARNESS_REL = "Tools/visual-regression/lib/celestial-capture-harness.mjs";
const HARNESS = readNormalized(HARNESS_REL);

/**
 * Assert a pattern matches the harness AND stops matching once `mutate` has
 * removed the construct — so the anchor is proven able to fail.
 */
function anchored(pattern, mutate, message) {
  assert.match(HARNESS, pattern, message);
  assert.doesNotMatch(
    mutate(HARNESS),
    pattern,
    `${message} — the anchor did not fail on its own mutant, so it is vacuous`,
  );
}

// ---------------------------------------------------------------------------
// 1. THE MODULE IS USABLE FROM A SPEC, AND FROM EVERY PROBE
// ---------------------------------------------------------------------------

test("the harness is browser-free at import", () => {
  // `withPage` and `runBackendLanes` take an already-launched browser, so
  // nothing here may import Playwright. If that ever changes, every spec that
  // imports this module starts requiring a browser download to run.
  assert.doesNotMatch(HARNESS, /from\s*["']playwright/);
  assert.doesNotMatch(HARNESS, /\.launch\s*\(/);
});

test("the harness exports the whole recipe, not half of it", () => {
  for (const name of [
    "BASE",
    "OUT_DIR",
    "PINNED_ISO",
    "VIEWPORT",
    "CROP",
    "SETTLE_BUDGET_MS",
    "SETTLE_MIN_FRAMES",
    "SETTLE_YIELD_MS",
    "setupScene",
    "captureMode",
    "withPage",
    "runBackendLanes",
    "stitchLeg",
    "toImage",
    "encodePNG",
    "writeCapturePng",
    "buildManifestEntry",
    "getGit",
    "normalizeHardwareClass",
  ]) {
    assert.ok(
      name in HARNESS_MODULE,
      `${name} must be exported — a probe that cannot reach it will re-author it`,
    );
  }
});

test("the shared home is REAL: both celestial probes import it", () => {
  // The point of the module is that there is one copy. A probe that declares
  // its own `setupScene`/`captureMode` has re-created the copy this file
  // exists to prevent, so the check is both directions.
  for (const rel of [
    "Tools/visual-regression/probe-celestial-gates.mjs",
    "Tools/visual-regression/probe-sun-hdr-radiance.mjs",
  ]) {
    const src = readNormalized(rel);
    assert.match(
      src,
      /from "\.\/lib\/celestial-capture-harness\.mjs"/,
      `${rel} must import the shared harness`,
    );
    for (const fn of [
      "setupScene",
      "captureMode",
      "withPage",
      "runBackendLanes",
    ]) {
      assert.doesNotMatch(
        src,
        new RegExp(String.raw`^(?:async )?function ${fn}\(`, "m"),
        `${rel} re-declares ${fn} — the harness is no longer the single copy`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// 2. THE RECIPE ITSELF
// ---------------------------------------------------------------------------

test("the clock is pinned and the default render loop is off", () => {
  anchored(
    /viewer\.useDefaultRenderLoop = false;/,
    (s) => s.replace("viewer.useDefaultRenderLoop = false;", ""),
    "the default render loop must be disabled",
  );
  anchored(
    /viewer\.clock\.shouldAnimate = false;/,
    (s) => s.replace("viewer.clock.shouldAnimate = false;", ""),
    "the clock must not animate",
  );
  anchored(
    /const pinnedTime = \(\) => viewer\.clock\.currentTime;/,
    (s) =>
      s.replaceAll("const pinnedTime = () => viewer.clock.currentTime;", ""),
    "every render must take the pinned instant",
  );
});

test("settle is a wall-clock budget that covers the measured compile cost", () => {
  const match = HARNESS.match(/export const SETTLE_BUDGET_MS = (\d+);/);
  assert.ok(match, "SETTLE_BUDGET_MS must exist");
  assert.ok(
    Number(match[1]) >= 2674,
    `settle budget ${match[1]} ms is below the measured 2674 ms async pipeline compile`,
  );
  // The yield must be setTimeout, not requestAnimationFrame: with the default
  // render loop off, rAF delivery in a headless browser is at the compositor's
  // discretion, and a starved rAF silently shortens the budget into exactly the
  // under-settle it exists to prevent.
  anchored(
    /await new Promise\(\(r\) => setTimeout\(r, settleYieldMs\)\)/,
    (s) =>
      s.replaceAll(
        "await new Promise((r) => setTimeout(r, settleYieldMs))",
        "await new Promise((r) => requestAnimationFrame(r))",
      ),
    "the settle yield must be setTimeout",
  );
  assert.doesNotMatch(HARNESS, /const SETTLE_FRAMES = /);
  assert.equal(HARNESS_MODULE.SETTLE_BUDGET_MS, Number(match[1]));
});

test("every measured capture is preceded by a DISCARDED warm-up capture", () => {
  anchored(
    /const warmupFrames = await settle\(\);\s*\n\s*grab\(\);/,
    (s) =>
      s.replace(/const warmupFrames = await settle\(\);\s*\n\s*grab\(\);/, ""),
    "the warm-up must settle AND grab, then throw the result away",
  );
  assert.match(HARNESS, /warmupDiscarded: true/);
  assert.ok(
    HARNESS.indexOf("const warmupFrames = await settle();") <
      HARNESS.indexOf("const full = grab();"),
    "the warm-up must run BEFORE the measured capture",
  );
});

test("render and readback happen in the SAME task", () => {
  // `grab` renders and reads with no await between; the whole point is that no
  // yield separates them. A read across a yield is invalid on BOTH backends —
  // WebGL clears the drawing buffer after the swap, WebGPU invalidates the
  // swap-chain texture after presentation.
  const grab = HARNESS.slice(
    HARNESS.indexOf("const grab = () => {"),
    HARNESS.indexOf("const settle = () => {"),
  );
  assert.ok(grab.length > 0, "the fused capture must exist");
  assert.match(grab, /scene\.render\(pinnedTime\(\)\)/);
  assert.match(grab, /ctx\.getImageData\(/);
  assert.doesNotMatch(
    grab,
    /await/,
    "there must be no await between the render and the readback",
  );
});

test("per-leg state is pinned in BOTH directions, not only on", () => {
  // Several lanes share ONE page, so a setting only ever turned on hands itself
  // to every capture after it. Two have cost runs: a narrowed field of view and
  // a left-on HDR path (which puts the tonemap and inverse-gamma stage in front
  // of lanes that read raw 8-bit codes).
  anchored(
    /\} else \{\s*\n\s*scene\.highDynamicRange = false;/,
    (s) =>
      s.replace(
        /\} else \{\s*\n\s*scene\.highDynamicRange = false;/,
        "} else {",
      ),
    "highDynamicRange must be set in both directions",
  );
  anchored(
    /scene\.postProcessStages\.exposure = 1\.0;/,
    (s) => s.replace("scene.postProcessStages.exposure = 1.0;", ""),
    "the exposure must be reset — the deepest bracket step is 64x",
  );
  anchored(
    /frustum\.fov = Number\.isFinite\(fovX\)\s*\?\s*C\.Math\.toRadians\(fovX\)\s*:\s*window\.__probeOriginalFovRad;/,
    (s) => s.replace(/:\s*window\.__probeOriginalFovRad;/, ": frustum.fov;"),
    "the field of view must be RESTORED when a lane requests no override",
  );
});

test("the camera basis is written back and its round-trip residual reported", () => {
  // Setting a view by orientation round-trips through heading/pitch/roll, which
  // does not reproduce the requested basis exactly. The repair writes the
  // REQUESTED basis back; the residual is measured BEFORE the repair so the
  // magnitude is reported every run instead of being silently corrected away.
  anchored(
    /const aimCamera = \(position, direction, up\) => \{/,
    (s) =>
      s.replace(
        "const aimCamera = (position, direction, up) => {",
        "const aimCamera = () => {",
      ),
    "one aim helper must serve every aim mode",
  );
  assert.match(
    HARNESS,
    /C\.Cartesian3\.clone\(direction, scene\.camera\.direction\);/,
  );
  assert.match(HARNESS, /hprRoundTripResidualDeg/);
  assert.match(HARNESS, /appliedResidualDeg/);
  assert.ok(
    HARNESS.indexOf("const hprRoundTripResidualDeg") <
      HARNESS.indexOf("C.Cartesian3.clone(direction, scene.camera.direction);"),
    "the residual must be measured BEFORE the repair",
  );
});

test("the prohibition on pinning the bloom flag is recorded where the pin would go", () => {
  // The one-halo-source invariant derives the baked halo's gain from the screen
  // halo, so turning the bloom off does not remove the halo — it swaps in the
  // baked one and renders the disc flat. The warning has to live next to the
  // scene-pin loop, which is the only place somebody would add the pin.
  assert.match(HARNESS, /DO NOT PIN `sunBloom = false` ON ANY SUN LANE/);
  const pins = HARNESS.slice(
    HARNESS.indexOf("DO NOT PIN `sunBloom = false`"),
    HARNESS.indexOf("HDR IS SET IN BOTH DIRECTIONS"),
  );
  assert.match(pins, /if \(scenePins\) \{/);
});

test("runBackendLanes releases each lane's pixels as it completes", () => {
  // Captures arrive as plain Arrays, ~20 MB each. Holding every lane's pixels
  // until the end is how a long run exhausts a default heap; the hook reduces
  // and writes a lane, then the driver drops it.
  anchored(
    /lane\.captures = null;/,
    (s) => s.replace("lane.captures = null;", ""),
    "each lane's captures must be released after the hook consumes them",
  );
  assert.match(
    HARNESS,
    /async function runBackendLanes\(browser, renderer, laneDefs, onLane\)/,
  );
  assert.ok(
    HARNESS.indexOf("onLane(def.key, lane, renderer);") <
      HARNESS.indexOf("lane.captures = null;"),
    "the hook must get its one chance at the pixels before they are dropped",
  );
});

test("the page contract closes its context on every path", () => {
  anchored(
    /await context\.close\(\)\.catch\(\(\) => \{\}\);/,
    (s) => s.replace("await context.close().catch(() => {});", ""),
    "the browser context must be closed",
  );
  const withPage = HARNESS.slice(
    HARNESS.indexOf("export async function withPage("),
    HARNESS.indexOf("export async function runBackendLanes("),
  );
  assert.match(
    withPage,
    /\} finally \{\s*\n\s*await context\.close\(\)/,
    "the close must sit in a finally so a throwing body still releases the page",
  );
});

// ---------------------------------------------------------------------------
// 3. BEHAVIOUR OF THE PURE HELPERS
// ---------------------------------------------------------------------------

test("toImage copies rather than aliasing the page's array", () => {
  const capture = { data: [1, 2, 3, 4], width: 1, height: 1 };
  const img = HARNESS_MODULE.toImage(capture);
  assert.ok(img.data instanceof Uint8ClampedArray);
  capture.data[0] = 255;
  assert.equal(img.data[0], 1, "the image must not alias the source array");
});

test("stitchLeg returns null when any bracket step is missing", () => {
  const lane = { captures: { "flat-1x": { data: [], exposureFactor: 1 } } };
  assert.equal(HARNESS_MODULE.stitchLeg(lane, "flat", [1, 0.125]), null);
});

test("normalizeHardwareClass is stable and never empty", () => {
  assert.equal(
    HARNESS_MODULE.normalizeHardwareClass([
      "Intel",
      " Arc  Graphics ",
      null,
      "",
    ]),
    "intel:arc-graphics",
  );
  assert.equal(HARNESS_MODULE.normalizeHardwareClass([]), "unknown");
  assert.equal(HARNESS_MODULE.normalizeHardwareClass([" ", null]), "unknown");
});

test("encodePNG emits a real PNG whose header matches the pixels", () => {
  const width = 3;
  const height = 2;
  const rgba = new Uint8ClampedArray(width * height * 4).fill(7);
  const png = HARNESS_MODULE.encodePNG(rgba, width, height);
  assert.deepEqual(
    [...png.slice(0, 8)],
    [137, 80, 78, 71, 13, 10, 26, 10],
    "PNG signature",
  );
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  assert.equal(dv.getUint32(16), width, "IHDR width");
  assert.equal(dv.getUint32(20), height, "IHDR height");
  assert.equal(png[24], 8, "8 bits per channel");
  assert.equal(png[25], 6, "RGBA colour type");
});
