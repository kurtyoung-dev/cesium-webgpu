// ocean-simulation-clock.spec.mjs — the FFT ocean's wave phase belongs to the
// scene clock, not to the render loop.
//
// @purpose Executes the FFT surface's simulation-clock law and the renderer's own time expression out of the shipped source, pinning that a held clock freezes the sea and a running one advances it at real rate.
// @status ACTIVE
//
// Run: node --test Tools/visual-regression/ocean-simulation-clock.spec.mjs
//
// WHAT THIS SPEC IS FOR. The surface used to advance on a render-loop counter
// divided by an assumed sixty hertz. Three consequences followed, and the third
// is what surfaced it: the sea ran at the frame rate rather than at the clock's
// rate; a paused clock did not pause it; and any capture that was not
// frame-locked compared two pages that had rendered different numbers of frames
// and were therefore showing different seas. A pixel comparison in that state
// moves as much under a same-settings control as under the treatment, which is
// exactly what an Edge tranche measured before this landed.
//
// HOW IT AVOIDS CERTIFYING ITSELF. The law is not transcribed. Group A imports
// and calls the shipped `resolveOceanSimulationSeconds`. Group B extracts the
// renderer's own `time` expression out of the TypeScript source and EVALUATES
// it, so the rate and the fallback are properties of the text that ships.
// Group D rebuilds the law from mutated source text and requires the verdict to
// move; its control changes a comment and requires the verdict not to.
//
// WHAT IT DELIBERATELY DOES NOT PROVE. Nothing here renders. That a frozen
// clock produces a byte-identical canvas is a browser leg; this spec's
// contribution to it is that the number the shader is handed does not change
// while the clock does not.
//
// CRLF: this repo checks out with `core.autocrlf=true`; every reader below
// normalises line endings before matching.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import JulianDate from "../../packages/engine/Source/Core/JulianDate.js";
import defined from "../../packages/engine/Source/Core/defined.js";
import OceanSurfacePrimitive, {
  cloneSimulationEpoch,
  resolveOceanSimulationSeconds,
} from "../../packages/engine/Source/Scene/OceanSurfacePrimitive.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");

const PRIMITIVE_PATH = path.join(
  ROOT,
  "packages/engine/Source/Scene/OceanSurfacePrimitive.js",
);
const RENDERER_PATH = path.join(
  ROOT,
  "packages/engine/Source/Renderer/WebGPU/WebGPUOceanRenderer.ts",
);
const FACADE_PATH = path.join(
  ROOT,
  "packages/engine/Source/Scene/GlobeWaterOcean.js",
);

/**
 * Read a source file with its line endings normalised to LF.
 *
 * @param {string} file Absolute path.
 * @returns {string} The source.
 */
function read(file) {
  return fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
}

const primitiveJs = read(PRIMITIVE_PATH);
const rendererTs = read(RENDERER_PATH);
const facadeJs = read(FACADE_PATH);

const EPOCH = JulianDate.fromIso8601("2026-08-29T00:00:00Z");

/**
 * A frame-state stand-in whose `time` is ONE object, rewritten in place.
 *
 * This is what the engine does, and it matters. `SceneUtilities` sets the
 * frame time as `frameState.time = JulianDate.clone(time, frameState.time)`,
 * so every frame mutates the same instance rather than publishing a new one.
 * A harness that hands out a fresh date per frame quietly supplies an
 * immutability the runtime never provides, and any law that stored the
 * caller's reference instead of copying it would pass — the aliasing would be
 * unreachable from the test. D5 is that mutant, and it survives against a
 * per-frame allocation.
 *
 * @returns {{advanceTo: (seconds: number) => object, state: object}} A frame
 *   state and a way to move its clock.
 */
function sceneClock() {
  const state = { time: JulianDate.clone(EPOCH) };
  return {
    state,
    advanceTo(seconds) {
      JulianDate.addSeconds(EPOCH, seconds, state.time);
      return state;
    },
  };
}

// ───────── A. the clock law, executed ───────────────────────────────────────

test("A1 a running clock advances the phase by exactly the elapsed seconds", () => {
  const surface = {};
  const clock = sceneClock();
  for (let i = 0; i < 10; i += 1) {
    const elapsed = resolveOceanSimulationSeconds(surface, clock.advanceTo(i));
    assert.ok(
      Math.abs(elapsed - i) < 1e-9,
      `frame ${i} reported ${elapsed} seconds, expected ${i}`,
    );
  }
});

test("A2 a held clock does not advance the phase, over ten frames", () => {
  const surface = {};
  const clock = sceneClock();
  for (let i = 0; i < 10; i += 1) {
    assert.equal(
      resolveOceanSimulationSeconds(surface, clock.advanceTo(1234.5)),
      0,
      `frame ${i} moved under a held clock`,
    );
  }
});

test("A3 the epoch is adopted once, kept, and never aliases the frame clock", () => {
  const surface = {};
  const clock = sceneClock();
  resolveOceanSimulationSeconds(surface, clock.advanceTo(0));
  const adopted = surface._simulationEpoch;
  assert.ok(defined(adopted), "the first frame must adopt an epoch");
  for (let i = 1; i < 10; i += 1) {
    resolveOceanSimulationSeconds(surface, clock.advanceTo(i));
    assert.equal(
      surface._simulationEpoch,
      adopted,
      `frame ${i} replaced the epoch object`,
    );
  }
  // The adopted epoch must not BE the frame's clock. The engine rewrites that
  // instance every frame, so an epoch holding the reference would chase the
  // clock and the elapsed time would collapse to zero for ever.
  assert.notEqual(
    adopted,
    clock.state.time,
    "the epoch must be a copy, not the frame's own mutable date",
  );
});

test("A4 a pinned epoch makes two surfaces agree, whatever they rendered before", () => {
  // This is the property a capture depends on: the sea is a function of the
  // clock and the epoch, not of how many frames a page happens to have drawn.
  const busyClock = sceneClock();
  const busy = { _simulationEpoch: JulianDate.clone(EPOCH) };
  for (let i = 0; i < 100; i += 1) {
    resolveOceanSimulationSeconds(busy, busyClock.advanceTo(i * 0.37));
  }
  const freshClock = sceneClock();
  const fresh = { _simulationEpoch: JulianDate.clone(EPOCH) };
  assert.equal(
    resolveOceanSimulationSeconds(busy, busyClock.advanceTo(42)),
    resolveOceanSimulationSeconds(fresh, freshClock.advanceTo(42)),
    "the same clock and epoch must give the same sea",
  );
});

test("A5 clearing the epoch re-adopts on the next frame", () => {
  const surface = {};
  const clock = sceneClock();
  resolveOceanSimulationSeconds(surface, clock.advanceTo(0));
  assert.equal(resolveOceanSimulationSeconds(surface, clock.advanceTo(50)), 50);
  surface._simulationEpoch = undefined;
  assert.equal(
    resolveOceanSimulationSeconds(surface, clock.advanceTo(50)),
    0,
    "a cleared epoch must restart from the current time",
  );
});

test("A6 a frame with no time yields the fallback signal and adopts nothing", () => {
  const surface = {};
  assert.equal(resolveOceanSimulationSeconds(surface, {}), undefined);
  assert.equal(resolveOceanSimulationSeconds(surface, undefined), undefined);
  assert.ok(
    !defined(surface._simulationEpoch),
    "a timeless frame must not fabricate an epoch it would then be stuck with",
  );
});

test("A7 the clock is authoritative in both directions", () => {
  const surface = { _simulationEpoch: JulianDate.clone(EPOCH) };
  const clock = sceneClock();
  assert.ok(
    resolveOceanSimulationSeconds(surface, clock.advanceTo(-30)) < 0,
    "a clock run backwards must run the sea backwards, not clamp it",
  );
  // Sub-second resolution: the law is in seconds, not in frames.
  assert.ok(
    Math.abs(
      resolveOceanSimulationSeconds(surface, clock.advanceTo(0.5)) - 0.5,
    ) < 1e-9,
    "half a second of scene time must be half a second of wave phase",
  );
});

// ───────── B. the renderer's own expression, executed ───────────────────────

const ENGINE = path.join(ROOT, "packages/engine/Source");
const DEFINED_URL = pathToFileURL(path.join(ENGINE, "Core/defined.js")).href;
const JULIAN_URL = pathToFileURL(path.join(ENGINE, "Core/JulianDate.js")).href;
const OCEAN_URL = pathToFileURL(
  path.join(ENGINE, "Scene/OceanSurfacePrimitive.js"),
).href;

/**
 * Evaluate a fragment of shipped source as a real ES module.
 *
 * The alternative, the Function constructor, is eval by another name and this
 * repo's lint rejects it. A data: URL is a module: node parses and links it
 * exactly as it would a file, so the fragment runs under the same semantics it
 * runs under in the engine, with its two dependencies resolved out of the
 * engine itself rather than re-implemented here.
 *
 * @param {string} body The module body, which must default-export something.
 * @returns {Promise<Function>} The default export.
 */
async function evaluateModule(body) {
  const source =
    `import defined from ${JSON.stringify(DEFINED_URL)};\n` +
    `import JulianDate from ${JSON.stringify(JULIAN_URL)};\n` +
    `void defined;\nvoid JulianDate;\n` +
    body;
  const url = `data:text/javascript,${encodeURIComponent(source)}`;
  return (await import(url)).default;
}

/**
 * Build a callable from the renderer's shipped PHASE BLOCK.
 *
 * The whole block is lifted, not just its final expression. The continuity
 * contract lives in the assignment to cache.simulationSeconds above that
 * expression, so an extractor that stopped at the multiplication would grade
 * only the half that cannot be wrong. The block's two free names are resolved
 * out of the engine itself, the law by import and the fallback step by
 * extraction, so neither is a second copy living in this file.
 *
 * @param {string} source The renderer source.
 * @returns {Promise<Function>} The block, as (primitive, frameState, cache).
 */
function phaseBlockFrom(source) {
  const block =
    /\n {2}(const elapsedSeconds = resolveOceanSimulationSeconds[\s\S]*?const time = [^;]*;)\n/.exec(
      source,
    );
  assert.ok(block !== null, "the renderer must compute the phase in one block");
  const step = /const FALLBACK_FRAME_SECONDS = ([^;]+);/.exec(source);
  assert.ok(step !== null, "the fallback step must be a named constant");
  return evaluateModule(
    `import { resolveOceanSimulationSeconds } from ${JSON.stringify(OCEAN_URL)};` +
      `\nconst FALLBACK_FRAME_SECONDS = ${step[1]};` +
      `\nexport default function (p, frameState, cache) {${block[1]}\nreturn time;}`,
  );
}

test("B1 with a clock, the phase IS the clock and the frame counter is inert", async () => {
  const phase = await phaseBlockFrom(rendererTs);
  const clock = sceneClock();
  const busy = { _timeSpeed: 1.0 };
  const idle = { _timeSpeed: 1.0 };
  const busyCache = { frameNumber: 1e6, simulationSeconds: 0 };
  const idleCache = { frameNumber: 0, simulationSeconds: 0 };
  phase(busy, clock.advanceTo(0), busyCache);
  phase(idle, clock.advanceTo(0), idleCache);
  assert.equal(
    phase(busy, clock.advanceTo(10), busyCache),
    phase(idle, clock.advanceTo(10), idleCache),
    "the same scene time must give the same sea, whatever either render loop has been doing",
  );
  assert.equal(phase(idle, clock.advanceTo(10), idleCache), 10);
  const fast = { _timeSpeed: 2.0 };
  const fastCache = { frameNumber: 0, simulationSeconds: 0 };
  phase(fast, clock.advanceTo(0), fastCache);
  assert.equal(phase(fast, clock.advanceTo(10), fastCache), 20);
});

test("B2 a clockless frame CONTINUES the phase, it does not jump", async () => {
  // The defect this replaces: the fallback was a frame counter with an origin
  // of its own, so the first clockless frame teleported the sea by however far
  // the two origins had diverged, and the first clocked frame after it
  // teleported it back.
  const phase = await phaseBlockFrom(rendererTs);
  const clock = sceneClock();
  const surface = { _timeSpeed: 1.0 };
  const cache = { frameNumber: 0, simulationSeconds: 0 };
  phase(surface, clock.advanceTo(0), cache);
  for (let i = 1; i <= 100; i += 1) {
    phase(surface, clock.advanceTo(i), cache);
  }
  assert.equal(cache.simulationSeconds, 100);
  cache.frameNumber = 100;
  const clockless = phase(surface, {}, cache);
  assert.ok(
    Math.abs(clockless - (100 + 1 / 60)) < 1e-9,
    `a clockless frame must continue from 100 s, got ${clockless}`,
  );
  // And emphatically not the counter's own origin, which is what the law
  // this replaces would have produced at exactly this point.
  assert.ok(
    Math.abs(clockless - 100 / 60) > 1,
    "the frame counter must not be able to set the phase",
  );
});

test("B3 the clockless rate is the rate the surface always ran at", async () => {
  const phase = await phaseBlockFrom(rendererTs);
  const surface = { _timeSpeed: 1.0 };
  const cache = { frameNumber: 0, simulationSeconds: 0 };
  for (let i = 0; i < 60; i += 1) {
    phase(surface, {}, cache);
  }
  assert.ok(
    Math.abs(cache.simulationSeconds - 1) < 1e-9,
    `sixty clockless frames must be one second, got ${cache.simulationSeconds}`,
  );
});

test("B4 the clock is authoritative the moment it returns", async () => {
  const phase = await phaseBlockFrom(rendererTs);
  const clock = sceneClock();
  const surface = { _timeSpeed: 1.0 };
  const cache = { frameNumber: 0, simulationSeconds: 0 };
  phase(surface, clock.advanceTo(0), cache);
  phase(surface, {}, cache);
  phase(surface, {}, cache);
  assert.equal(
    phase(surface, clock.advanceTo(500), cache),
    500,
    "the sea is a function of the clock; resuming from it is a correction, not a jump",
  );
});
test("B5 the renderer asks the shared law, and asks it once", () => {
  assert.equal(
    (rendererTs.match(/resolveOceanSimulationSeconds\(/g) ?? []).length,
    1,
    "one call site; the law is not re-derived anywhere in the renderer",
  );
  assert.match(
    rendererTs,
    /import \{ resolveOceanSimulationSeconds \} from "\.\.\/\.\.\/Scene\/OceanSurfacePrimitive\.js";/,
    "the law must be imported, not copied",
  );
  // `cache.frameNumber` may still exist for its own bookkeeping, but it must
  // not appear anywhere in the phase block: an origin unrelated to the clock's
  // must not be able to reach the wave phase by any route.
  const block =
    /\n {2}(const elapsedSeconds = resolveOceanSimulationSeconds[\s\S]*?const time = [^;]*;)\n/.exec(
      rendererTs,
    );
  assert.ok(defined(block), "the phase block must be findable");
  assert.ok(
    !block[1].includes("frameNumber"),
    "the render-loop counter must not reach the wave phase",
  );
});

// ───────── C. the pin reaches the surface ──────────────────────────────────

// A caller pinning an epoch reaches for one of two instants: `viewer.clock
// .currentTime` or `frameState.time`. The engine rewrites BOTH in place, so a
// pin that kept the reference would advance with the clock, the elapsed time
// would stay at zero, and the surface would freeze — the same failure the
// adoption path clones to avoid, arriving through the door marked pinned.
// These tests measure the copy rather than reading for it.

/**
 * Does a pin survive the caller mutating the instant it was given?
 *
 * @param {Function} clone The copy under test.
 * @returns {boolean} Whether the pin held.
 */
function pinHolds(clone) {
  const caller = JulianDate.clone(EPOCH);
  const surface = { _simulationEpoch: clone(caller) };
  // The caller's instant now advances, exactly as the engine advances the two
  // instants a caller is most likely to have handed over.
  JulianDate.addSeconds(EPOCH, 3600, caller);
  const clock = sceneClock();
  return resolveOceanSimulationSeconds(surface, clock.advanceTo(10)) === 10;
}

test("C1 a pinned epoch is copied, so the caller cannot move it afterwards", () => {
  assert.ok(
    pinHolds(cloneSimulationEpoch),
    "the pin must survive the caller mutating the date it handed over",
  );
  // The copy is a different object, and an absent pin stays absent rather
  // than becoming an epoch of its own.
  const caller = JulianDate.clone(EPOCH);
  assert.notEqual(cloneSimulationEpoch(caller), caller);
  assert.equal(cloneSimulationEpoch(undefined), undefined);
});

test("C2 the surface copies an epoch handed to its constructor", () => {
  const caller = JulianDate.clone(EPOCH);
  const surface = new OceanSurfacePrimitive({ simulationEpoch: caller });
  assert.notEqual(
    surface._simulationEpoch,
    caller,
    "the constructor must not retain the caller's instance",
  );
  JulianDate.addSeconds(EPOCH, 3600, caller);
  const clock = sceneClock();
  assert.equal(
    resolveOceanSimulationSeconds(surface, clock.advanceTo(10)),
    10,
    "a constructed surface must measure from the instant it was given",
  );
});

test("C3 the facade forwards the pin, live and at construction", () => {
  assert.match(
    facadeJs,
    /simulationEpoch: \{\s*get: function \(\) \{\s*return this\._simulationEpoch;\s*\},\s*set: function \(v\) \{/,
    "the facade must expose the pin",
  );
  assert.equal(
    (facadeJs.match(/cloneSimulationEpoch\(v\)/g) ?? []).length,
    2,
    "both the facade's own copy and the live primitive's must be copies",
  );
  assert.match(
    facadeJs,
    /simulationEpoch: this\._simulationEpoch,/,
    "a surface created later must be born with the pin",
  );
});
// ───────── D. MUTANTS — the law rebuilt from substituted text ───────────────
//
// The law is JavaScript in a real module, so a mutant cannot be a string swap
// in a shader. It is rebuilt instead: the function's source text is lifted out
// of the file, mutated, and compiled with `defined` and `JulianDate` supplied,
// which is the same shape the shader specs' evaluator has. Nothing is written
// to disk; D7 checks it.

const LAW_SOURCE = (() => {
  const at = primitiveJs.indexOf("function resolveOceanSimulationSeconds(");
  assert.ok(at >= 0, "the law must exist");
  const open = primitiveJs.indexOf("{", at);
  let depth = 0;
  let i = open;
  for (; i < primitiveJs.length; i += 1) {
    if (primitiveJs[i] === "{") depth += 1;
    else if (primitiveJs[i] === "}") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return primitiveJs.slice(open + 1, i);
})();

/**
 * Compile the law's body into a callable.
 *
 * @param {string} body The (possibly mutated) body text.
 * @returns {Promise<Function>} The callable.
 */
function lawFrom(body) {
  return evaluateModule(
    `export default function (primitive, frameState) {${body}}`,
  );
}

/**
 * The clock contract as one predicate over the law.
 *
 * @param {Function} law The callable.
 * @returns {boolean} Whether the contract holds.
 */
function verdict(law) {
  try {
    // A running clock advances at real rate — over the ONE mutated time
    // object the engine actually publishes.
    const runningClock = sceneClock();
    const running = {};
    for (let i = 0; i < 5; i += 1) {
      if (Math.abs(law(running, runningClock.advanceTo(i)) - i) > 1e-9) {
        return false;
      }
    }
    // A held clock does not.
    const heldClock = sceneClock();
    const held = {};
    for (let i = 0; i < 5; i += 1) {
      if (law(held, heldClock.advanceTo(77)) !== 0) {
        return false;
      }
    }
    // The epoch is adopted once, and is a copy rather than the frame's date.
    const stableClock = sceneClock();
    const stable = {};
    law(stable, stableClock.advanceTo(0));
    const adopted = stable._simulationEpoch;
    law(stable, stableClock.advanceTo(1));
    if (stable._simulationEpoch !== adopted) {
      return false;
    }
    if (adopted === stableClock.state.time) {
      return false;
    }
    // A timeless frame signals the fallback and adopts nothing.
    const timeless = {};
    if (law(timeless, {}) !== undefined) {
      return false;
    }
    return !defined(timeless._simulationEpoch);
  } catch {
    return false;
  }
}

/**
 * Rebuild the law with one substitution and assert the verdict moves.
 *
 * @param {string} from The text to replace.
 * @param {string} to The replacement.
 * @param {boolean} expectation What the verdict must become.
 * @returns {Promise<void>}
 */
async function withMutation(from, to, expectation) {
  assert.ok(
    LAW_SOURCE.includes(from),
    `mutation precondition failed: "${from.slice(0, 60)}..."`,
  );
  assert.equal(
    verdict(await lawFrom(LAW_SOURCE.replace(from, to))),
    expectation,
    `the mutant did not move the verdict to ${expectation}`,
  );
}

test("D0 the verdict is TRUE on the shipped law", async () => {
  assert.equal(verdict(await lawFrom(LAW_SOURCE)), true);
  // And the imported function agrees with the rebuilt one, so the harness is
  // reading the law the module actually exports.
  assert.equal(verdict(resolveOceanSimulationSeconds), true);
});

test("D1 RE-ADOPTION — the epoch reset every frame", async () => {
  // The classic shape of this bug: the sea is always at phase zero, which
  // looks like a flat calm rather than like a broken clock.
  await withMutation("if (!defined(epoch)) {", "if (true) {", false);
});

test("D2 WRONG SIGN — the difference taken the other way", async () => {
  await withMutation(
    "return JulianDate.secondsDifference(now, epoch);",
    "return JulianDate.secondsDifference(epoch, now);",
    false,
  );
});

test("D3 INERTNESS — the elapsed time computed and discarded", async () => {
  await withMutation(
    "return JulianDate.secondsDifference(now, epoch);",
    "return JulianDate.secondsDifference(now, epoch) * 0.0;",
    false,
  );
});

test("D4 FABRICATED EPOCH — a timeless frame adopts one anyway", async () => {
  await withMutation(
    "  if (!defined(now)) {\n    return undefined;\n  }",
    "  if (!defined(now)) {\n    return 0.0;\n  }",
    false,
  );
});

test("D5 ALIASED EPOCH — the caller's time stored instead of a copy", async () => {
  // The engine rewrites `frameState.time` in place every frame
  // (SceneUtilities: `frameState.time = JulianDate.clone(time, frameState.time)`),
  // so an epoch that holds that reference chases the clock and the elapsed
  // time collapses to zero for ever. This mutant is the reason the harness
  // above reuses one date instead of allocating per frame: against a fresh
  // date per frame it survives, and the copy would look like defensive
  // decoration rather than the load-bearing line it is.
  await withMutation("epoch = JulianDate.clone(now);", "epoch = now;", false);
});

test("D7 ALIASED PIN — the caller's instant retained instead of copied", () => {
  // The adoption path's clone has its own mutant (D5). This is the other
  // door: a pin that keeps the reference re-creates the same freeze, and no
  // test that only reads the setter's source would notice.
  const identity = (epoch) => epoch;
  assert.equal(
    pinHolds(identity),
    false,
    `a pin that keeps the caller's instance must NOT hold; if this passes, the copy is unreachable`,
  );
  assert.equal(pinHolds(cloneSimulationEpoch), true);
});
test("D6 the mutants are discriminating, not merely destructive", async () => {
  await withMutation(
    "  const now = frameState?.time;",
    "  const now = frameState?.time; // the scene clock",
    true,
  );
});

test("D8 no source file was written — every mutation was a substitution", () => {
  assert.equal(read(PRIMITIVE_PATH), primitiveJs);
  assert.equal(read(RENDERER_PATH), rendererTs);
  assert.equal(read(FACADE_PATH), facadeJs);
});
