// globe-ocean-wave-clock.spec.mjs — the globe water-mask ocean's wave phase
// belongs to the scene clock, and both backends read the same one.
//
// @purpose Executes the globe water-mask ocean's wave-clock law, the WebGPU packer's own phase expression and the GLSL twin's, pinning that scene seconds drive both dialects at the historical rate and that the frame counter cannot reach either.
// @status ACTIVE
//
// Run: node --test Tools/visual-regression/globe-ocean-wave-clock.spec.mjs
//
// WHAT THIS SPEC IS FOR. The water the globe draws from its terrain water mask
// used to advance on the render-loop counter, on BOTH backends by deliberate
// mirror: GLSL read `czm_frameNumber`, and the WebGPU tile uniform buffer
// multiplied `frameState.frameNumber`. Three consequences followed. The wave
// rate was whatever the frame rate happened to be. A paused clock still churned
// the sea. And — because the two counters have unrelated origins, and the
// WebGPU modulus only re-aligns with a whole frame every 320 000 of them — a
// same-settings A/B on this ocean had no byte-identical form at all, so every
// off/on capture over water had to be frame-locked and read as a signed mean
// against a matched floor rather than as a difference.
//
// The phase is now elapsed SCENE seconds, resolved once per rendered frame,
// above the point where the two backends diverge, by the same law the FFT ocean
// surface already uses.
//
// HOW IT AVOIDS CERTIFYING ITSELF. Nothing below transcribes the law and then
// asserts the transcription. Group A calls the shipped clock. Group B lifts the
// WebGPU packer's phase block out of the TypeScript that ships and EVALUATES
// it, with its constants read from the same file. Group C lifts the GLSL
// expressions out of the shader that ships and evaluates those, so the
// cross-dialect claim is a measurement of two texts rather than of one belief
// held twice. Group E rebuilds each of them from mutated text and requires the
// verdict to move; its control mutates a comment and requires it not to.
//
// WHAT IT DELIBERATELY DOES NOT PROVE. Nothing here compiles a shader or draws
// a pixel. That a pinned clock makes two globe-ocean captures sixty frames
// apart byte-identical is a browser leg; this spec's contribution to it is that
// the number each backend's shader is handed does not change while the clock
// does not, and that the number is the same on both.
//
// CRLF: this repo checks out with `core.autocrlf=true`; every reader below
// normalises line endings before matching.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import JulianDate from "../../packages/engine/Source/Core/JulianDate.js";
import {
  OCEAN_WAVE_NOMINAL_FPS,
  advanceGlobeOceanWaveClock,
  createGlobeOceanWaveClock,
} from "../../packages/engine/Source/Scene/GlobeOceanWaveClock.js";
import {
  evaluate,
  parseExpression,
  readConstants,
  tokenize,
} from "./lib/wgsl-mini-eval.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const ENGINE = path.join(ROOT, "packages/engine/Source");

const CLOCK_REL = "packages/engine/Source/Scene/GlobeOceanWaveClock.js";
const TILE_UB_REL =
  "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceTileUB.ts";
const GLSL_REL = "packages/engine/Source/Shaders/GlobeFS.glsl";
const WGSL_REL =
  "packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl";
const GLOBE_REL = "packages/engine/Source/Scene/Globe.js";
const RENDERING_REL =
  "packages/engine/Source/Scene/GlobeSurfaceTileProviderRendering.js";
const PROVIDER_REL = "packages/engine/Source/Scene/GlobeSurfaceTileProvider.js";
const WATER_REL = "packages/engine/Source/Scene/GlobeWater.js";
const BUILD_REL = "scripts/build.js";

/**
 * Read a tracked source file with its line endings normalised to LF.
 *
 * @param {string} relativePath Repository-relative path.
 * @returns {string} The source.
 */
function read(relativePath) {
  return fs
    .readFileSync(path.join(ROOT, relativePath), "utf8")
    .replace(/\r\n/g, "\n");
}

const clockJs = read(CLOCK_REL);
const tileUbTs = read(TILE_UB_REL);
const glsl = read(GLSL_REL);
const wgsl = read(WGSL_REL);
const globeJs = read(GLOBE_REL);
const renderingJs = read(RENDERING_REL);
const providerJs = read(PROVIDER_REL);
const waterJs = read(WATER_REL);
const buildJs = read(BUILD_REL);

const EPOCH = JulianDate.fromIso8601("2026-08-29T00:00:00Z");

/**
 * A frame-state stand-in whose `time` is ONE object, rewritten in place, and
 * whose frame counter advances independently of it.
 *
 * The engine sets the frame time as `frameState.time = JulianDate.clone(time,
 * frameState.time)`, so every frame mutates the same instance rather than
 * publishing a new one. A harness that handed out a fresh date per frame would
 * supply an immutability the runtime never provides, and a law that stored the
 * caller's reference instead of copying it would pass unnoticed. The counter is
 * separate on purpose: holding the clock while it runs is exactly the state the
 * old law could not represent.
 *
 * @returns {{state: object, at: (seconds: number) => object, tick: () => object}}
 *   A frame state, a way to move its clock, and a way to advance only its
 *   counter.
 */
function sceneClock() {
  const state = { time: JulianDate.clone(EPOCH), frameNumber: 0 };
  return {
    state,
    at(seconds) {
      JulianDate.addSeconds(EPOCH, seconds, state.time);
      state.frameNumber += 1;
      return state;
    },
    tick() {
      state.frameNumber += 1;
      return state;
    },
  };
}

// ───────── A. the shared clock law, executed ────────────────────────────────

test("A1 a running clock advances the phase by exactly the elapsed seconds", () => {
  const clock = createGlobeOceanWaveClock();
  const frames = sceneClock();
  for (let i = 0; i < 10; i += 1) {
    const seconds = advanceGlobeOceanWaveClock(clock, frames.at(i), undefined);
    assert.ok(
      Math.abs(seconds - i) < 1e-9,
      `frame ${i} reported ${seconds} seconds, expected ${i}`,
    );
  }
});

test("A2 a held clock holds the sea while the render loop keeps running", () => {
  const clock = createGlobeOceanWaveClock();
  const frames = sceneClock();
  // An unpinned clock measures from the first frame that carries a time, so
  // this one starts its own origin here and the phase is zero by construction.
  const first = advanceGlobeOceanWaveClock(clock, frames.at(42), undefined);
  assert.equal(first, 0, "an adopted origin starts the phase at zero");
  for (let i = 0; i < 10; i += 1) {
    assert.equal(
      advanceGlobeOceanWaveClock(clock, frames.tick(), undefined),
      first,
      `frame ${frames.state.frameNumber} moved the phase without the clock`,
    );
  }
  // And it is the clock, not the render loop, that is authoritative: the very
  // next timed frame reports the second that actually elapsed, not the eleven
  // frames that went by.
  assert.equal(advanceGlobeOceanWaveClock(clock, frames.at(43), undefined), 1);
});

test("A3 a clockless frame CONTINUES the phase, it does not jump", () => {
  const clock = createGlobeOceanWaveClock();
  const frames = sceneClock();
  advanceGlobeOceanWaveClock(clock, frames.at(0), undefined);
  advanceGlobeOceanWaveClock(clock, frames.at(100), undefined);
  const clockless = advanceGlobeOceanWaveClock(clock, {}, undefined);
  assert.ok(
    Math.abs(clockless - (100 + 1 / OCEAN_WAVE_NOMINAL_FPS)) < 1e-9,
    `a clockless frame must continue from 100 s, got ${clockless}`,
  );
  // Emphatically not an origin of its own: the counter stands at five here, and
  // a fallback that reached for it would land near 5/60 rather than near 100.
  assert.ok(
    Math.abs(clockless - frames.state.frameNumber / OCEAN_WAVE_NOMINAL_FPS) > 1,
    "the render-loop counter must not be able to set the phase",
  );
  assert.equal(
    advanceGlobeOceanWaveClock(clock, frames.at(500), undefined),
    500,
    "the clock is authoritative the moment it returns",
  );
});

test("A4 sixty clockless frames are one second, the rate the sea always ran at", () => {
  const clock = createGlobeOceanWaveClock();
  for (let i = 0; i < OCEAN_WAVE_NOMINAL_FPS; i += 1) {
    advanceGlobeOceanWaveClock(clock, {}, undefined);
  }
  assert.ok(
    Math.abs(clock.seconds - 1) < 1e-9,
    `sixty clockless frames must be one second, got ${clock.seconds}`,
  );
});

test("A5 a pinned epoch is copied, so the caller cannot move it afterwards", () => {
  const caller = JulianDate.clone(EPOCH);
  const clock = createGlobeOceanWaveClock();
  const frames = sceneClock();
  assert.equal(advanceGlobeOceanWaveClock(clock, frames.at(10), caller), 10);
  // The engine rewrites `clock.currentTime` and `frameState.time` in place, and
  // those are the two instants a caller reaches for when pinning.
  JulianDate.addSeconds(EPOCH, 3600, caller);
  assert.equal(
    advanceGlobeOceanWaveClock(clock, frames.at(10), caller),
    10,
    "the pin must survive the caller mutating the date it handed over",
  );
});

test("A6 two viewers with the same pin at the same instant draw the same sea", () => {
  const pin = JulianDate.fromIso8601("2026-09-21T20:00:00Z");
  const busy = createGlobeOceanWaveClock();
  const fresh = createGlobeOceanWaveClock();
  const busyFrames = sceneClock();
  const freshFrames = sceneClock();
  // One page has been rendering for a while; the other has just opened.
  for (let i = 0; i < 745; i += 1) {
    advanceGlobeOceanWaveClock(busy, busyFrames.at(i * 0.017), pin);
  }
  assert.equal(
    advanceGlobeOceanWaveClock(busy, busyFrames.at(120), pin),
    advanceGlobeOceanWaveClock(fresh, freshFrames.at(120), pin),
    "unequal frame counts must not be able to produce unequal seas",
  );
  // Clearing the pin re-adopts, which is the documented way back to a
  // per-viewer origin.
  advanceGlobeOceanWaveClock(fresh, freshFrames.at(200), undefined);
  assert.equal(
    advanceGlobeOceanWaveClock(fresh, freshFrames.at(210), undefined),
    10,
  );
});

test("A7 the clock imports the shared law and never sees a frame counter", () => {
  assert.match(
    clockJs,
    /import \{\n\s*cloneSimulationEpoch,\n\s*resolveOceanSimulationSeconds,\n\} from "\.\/OceanSurfacePrimitive\.js";/,
    "the law must be imported, not copied",
  );
  assert.equal(
    (clockJs.match(/resolveOceanSimulationSeconds\(/g) ?? []).length,
    1,
    "one call site; the law is not re-derived in this module",
  );
  assert.ok(
    !stripJsComments(clockJs).includes("frameNumber"),
    "the render-loop counter must not appear anywhere in the clock",
  );
});

// ───────── B. the WebGPU packer's own expression, executed ──────────────────

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
 * runs under in the engine, with any dependency resolved out of the engine
 * itself rather than re-implemented here.
 *
 * @param {string} body The module body, which must default-export something.
 * @returns {Promise<Function>} The default export.
 */
async function evaluateModule(body) {
  const source = `${body}\n`;
  const url = `data:text/javascript,${encodeURIComponent(source)}`;
  return (await import(url)).default;
}

/** JavaScript and TypeScript comment strip, for absence checks. */
function stripJsComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** GLSL comment strip, for the same reason. */
function stripGlslComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, "");
}

/**
 * Lift one `const NAME = <expr>;` initialiser out of shipped source.
 *
 * @param {string} source The source.
 * @param {string} name The constant.
 * @returns {string} The initialiser text.
 */
function initialiserOf(source, name) {
  const m = new RegExp(`const ${name} =\\s*([^;]+);`).exec(source);
  assert.ok(m !== null, `${name} must be a named constant`);
  return m[1].trim();
}

/**
 * The packer's phase block, anchored on the assignment rather than on where the
 * value comes from — a mutant that changes the SOURCE of the phase must still be
 * extractable, or E3 would grade the extractor instead of the packer.
 */
const PHASE_BLOCK_RE =
  /\n {2}(const oceanWaveSeconds =[\s\S]*?const waveTime =[\s\S]*?;)\n/;

/**
 * The packer's DELIVERY block: the phase block plus the write that hands the
 * phase to the shader. Anchored on the slot, not on what is written into it, so
 * a mutant that severs the write still extracts.
 */
const DELIVERY_BLOCK_RE =
  /\n {2}(const oceanWaveSeconds =[\s\S]*?data\[TIME_OFFSET\] = [^;]*;)\n/;

/**
 * Build a callable from the packer's shipped PHASE BLOCK.
 *
 * The whole block is lifted, not just the multiplication: the block's first
 * line is where the phase chooses its source, which is the half this row
 * exists to change, and an extractor that started at the arithmetic would grade
 * only the half that cannot be wrong. The three constants are read out of the
 * same file, and the one number they rest on is imported from the shared law,
 * so nothing in this spec is a second copy of the rate.
 *
 * @param {string} source The packer source.
 * @returns {Promise<Function>} The block, as (tileProvider, frameState).
 */
function phaseBlockFrom(source) {
  const block = PHASE_BLOCK_RE.exec(source);
  assert.ok(block !== null, "the packer must compute the phase in one block");
  return evaluateModule(
    `import { OCEAN_WAVE_NOMINAL_FPS } from ${JSON.stringify(
      pathToFileURL(path.join(ENGINE, "Scene/GlobeOceanWaveClock.js")).href,
    )};` +
      `\nconst OCEAN_WAVE_FRAME_SPEED = ${initialiserOf(source, "OCEAN_WAVE_FRAME_SPEED")};` +
      `\nconst OCEAN_WAVE_TIME_PERIOD = ${initialiserOf(source, "OCEAN_WAVE_TIME_PERIOD")};` +
      `\nconst OCEAN_WAVE_SECOND_SPEED = ${initialiserOf(source, "OCEAN_WAVE_SECOND_SPEED")};` +
      `\nexport default function (tileProvider, frameState) {\n${block[1]}\nreturn waveTime;\n}`,
  );
}

/**
 * Build a callable from the packer's shipped DELIVERY block.
 *
 * Computing the right number and HANDING IT TO THE SHADER are two claims, and
 * only the first was executed before: severing `data[TIME_OFFSET] = waveTime`
 * to a constant left every other assertion in this file green while freezing
 * the WebGPU ocean permanently. This runs the write and reads the slot back.
 *
 * @param {string} source The packer source.
 * @returns {Promise<Function>} The block, as (tileProvider, data, TIME_OFFSET).
 */
function deliveryBlockFrom(source) {
  const block = DELIVERY_BLOCK_RE.exec(source);
  assert.ok(block !== null, "the packer must deliver the phase in one block");
  return evaluateModule(
    `import { OCEAN_WAVE_NOMINAL_FPS } from ${JSON.stringify(
      pathToFileURL(path.join(ENGINE, "Scene/GlobeOceanWaveClock.js")).href,
    )};` +
      `
const OCEAN_WAVE_FRAME_SPEED = ${initialiserOf(source, "OCEAN_WAVE_FRAME_SPEED")};` +
      `
const OCEAN_WAVE_TIME_PERIOD = ${initialiserOf(source, "OCEAN_WAVE_TIME_PERIOD")};` +
      `
const OCEAN_WAVE_SECOND_SPEED = ${initialiserOf(source, "OCEAN_WAVE_SECOND_SPEED")};` +
      `
export default function (tileProvider, data, TIME_OFFSET) {
${block[1]}
return data[TIME_OFFSET];
}`,
  );
}

const PACK_PHASE = await phaseBlockFrom(tileUbTs);
const PACK_DELIVER = await deliveryBlockFrom(tileUbTs);
const WAVE_FRAME_SPEED = Number(
  initialiserOf(tileUbTs, "OCEAN_WAVE_FRAME_SPEED"),
);
const WAVE_TIME_PERIOD = Number(
  initialiserOf(tileUbTs, "OCEAN_WAVE_TIME_PERIOD"),
);

test("B1 the packer's phase is the clock, and the frame counter is inert", () => {
  const clock = createGlobeOceanWaveClock();
  const frames = sceneClock();
  // Establish the origin, then move the clock, so the held phase under test is
  // a real one rather than the zero every first frame reports.
  advanceGlobeOceanWaveClock(clock, frames.at(0), undefined);
  const seconds = advanceGlobeOceanWaveClock(clock, frames.at(37), undefined);
  const first = PACK_PHASE({ oceanWaveSeconds: seconds }, frames.state);
  for (let i = 0; i < 10; i += 1) {
    const held = advanceGlobeOceanWaveClock(clock, frames.tick(), undefined);
    assert.equal(
      PACK_PHASE({ oceanWaveSeconds: held }, frames.state),
      first,
      `frame ${frames.state.frameNumber} moved the packed phase`,
    );
  }
  assert.ok(first > 0, "the held phase must not be a vacuous zero");
});

test("B2 one second of scene time is what sixty frames used to be", () => {
  const before = PACK_PHASE({ oceanWaveSeconds: 12 }, {});
  const after = PACK_PHASE({ oceanWaveSeconds: 13 }, {});
  assert.ok(
    Math.abs(after - before - OCEAN_WAVE_NOMINAL_FPS * WAVE_FRAME_SPEED) < 1e-9,
    `one second advanced the phase by ${after - before}, expected ${
      OCEAN_WAVE_NOMINAL_FPS * WAVE_FRAME_SPEED
    }`,
  );
  // The historical law at sixty frames, restated from the shipped constant.
  assert.ok(Math.abs(after - before - 9.0) < 1e-9);
});

test("B3 the packer takes its seconds from the provider and nothing else", () => {
  const block = PHASE_BLOCK_RE.exec(stripJsComments(tileUbTs));
  assert.ok(
    block !== null,
    "the phase block must be findable without comments",
  );
  assert.ok(
    !block[1].includes("frameNumber"),
    "an origin unrelated to the clock must not reach the wave phase",
  );
  assert.ok(
    !stripJsComments(tileUbTs).includes("frameState?.frameNumber"),
    "the packer must no longer read the render-loop counter at all",
  );
  // The seconds arrive on the same per-frame provider mirror the WebGL uniform
  // reads, which is what makes the two backends one clock rather than two.
  assert.match(
    tileUbTs,
    /const oceanWaveSeconds = tileProvider\?\.oceanWaveSeconds \?\? 0\.0;/,
  );
});

test("B4 the wrap still lands on the same texture phase", () => {
  // The advection velocities come out of the shipped WGSL, not out of a list
  // kept here: a shader edit that broke commensurability would otherwise pass.
  const constants = readConstants(stripWgslComments(wgsl));
  const components = ["OCEAN_ADVECT_1", "OCEAN_ADVECT_2", "OCEAN_ADVECT_3"]
    .map((name) => {
      assert.ok(constants[name] !== undefined, `${name} must exist`);
      return constants[name];
    })
    .flatMap((v) => [v.x, v.y]);
  assert.equal(components.length, 6);
  for (const rate of components) {
    const cycles = WAVE_TIME_PERIOD * rate;
    assert.ok(
      Math.abs(cycles - Math.round(cycles)) < 1e-9,
      `period ${WAVE_TIME_PERIOD} is not commensurate with advection ${rate}`,
    );
  }
  // And the wrap is now reachable at an exact instant rather than only at a
  // whole frame: the seconds are continuous, so the phase either side of it
  // differs by the elapsed time alone.
  const wrapSeconds =
    WAVE_TIME_PERIOD / (OCEAN_WAVE_NOMINAL_FPS * WAVE_FRAME_SPEED);
  assert.ok(Math.abs(PACK_PHASE({ oceanWaveSeconds: wrapSeconds }, {})) < 1e-9);
});

/** WGSL has only line comments. Absence checks must never run on raw text. */
function stripWgslComments(source) {
  return source.replace(/^[ \t]*\/\/[^\n]*$/gm, "").replace(/\/\/[^\n]*/g, "");
}

test("B5 the packer WRITES the resolved phase into the slot the shader reads", () => {
  // Computing the phase and delivering it are separate claims. This executes
  // the delivery: the shipped block runs against a real array, and the slot is
  // read back.
  const SLOT = 3;
  const data = new Float32Array(8);
  const at = (seconds) => {
    data.fill(0);
    return PACK_DELIVER({ oceanWaveSeconds: seconds }, data, SLOT);
  };
  assert.equal(
    at(37),
    PACK_PHASE({ oceanWaveSeconds: 37 }, {}),
    "the slot must receive the phase the packer computed, not a constant",
  );
  assert.notEqual(at(37), 0, "a delivered phase of zero would be vacuous");
  assert.notEqual(
    at(38),
    at(37),
    "the delivered value must move when the clock does",
  );
  assert.equal(
    at(37),
    Math.fround(37 * OCEAN_WAVE_NOMINAL_FPS * WAVE_FRAME_SPEED),
    "and it must be the seconds taken at the shared nominal rate",
  );
  // Exactly one production write; the second is the pragma-stripped debug
  // sentinel, which must stay separate from it.
  const code = stripJsComments(tileUbTs);
  assert.equal(
    (code.match(/data\[TIME_OFFSET\] = waveTime;/g) ?? []).length,
    1,
    "one production write of the wave clock into the slot",
  );
  assert.equal(
    (code.match(/data\[TIME_OFFSET\] = /g) ?? []).length,
    2,
    "the only other writer is the debug sentinel",
  );
});

// ───────── C. the two dialects, evaluated against the same seconds ──────────

/**
 * Evaluate one GLSL expression lifted out of the shader that ships.
 *
 * @param {string} expression The expression text.
 * @param {object} env Name to value bindings.
 * @returns {number} The value.
 */
function evalGlsl(expression, env) {
  return evaluate(parseExpression(tokenize(expression), 0).node, env);
}

/**
 * Lift the GLSL wave-clock expressions out of `GlobeFS.glsl`.
 *
 * @param {string} source The shader source.
 * @returns {{frames: string, high: string, low: string, fps: number, speeds: object}}
 *   The three expressions plus the constants they read.
 */
function glslWaveClock(source) {
  const code = stripGlslComments(source);
  const frames = /float waveClockFrames = ([^;]+);/.exec(code);
  const high = /float time = ([^;]+);/.exec(code);
  const low = /\n\s*time = ([^;]+);/.exec(code);
  assert.ok(frames !== null, "the GLSL must name its wave clock");
  assert.ok(high !== null && low !== null, "both wave layers must be findable");
  const constant = (name) => {
    const m = new RegExp(`const float ${name} = ([^;]+);`).exec(code);
    assert.ok(m !== null, `${name} must be a named constant in the shader`);
    return evalGlsl(m[1], {});
  };
  return {
    frames: frames[1].trim(),
    high: high[1].trim(),
    low: low[1].trim(),
    fps: constant("oceanWaveNominalFramesPerSecond"),
    speeds: {
      oceanAnimationSpeedHighAltitude: constant(
        "oceanAnimationSpeedHighAltitude",
      ),
      oceanAnimationSpeedLowAltitude: constant(
        "oceanAnimationSpeedLowAltitude",
      ),
    },
  };
}

const GLSL_CLOCK = glslWaveClock(glsl);

/**
 * Nominal frames the GLSL derives from a number of scene seconds.
 *
 * @param {object} clockText The lifted expressions.
 * @param {number} seconds Scene seconds.
 * @returns {number} Nominal frames.
 */
function glslNominalFrames(clockText, seconds) {
  return evalGlsl(clockText.frames, {
    u_oceanWaveSeconds: seconds,
    oceanWaveNominalFramesPerSecond: clockText.fps,
  });
}

test("C1 the shader's nominal frame rate is the shared law's, not a second copy", () => {
  assert.equal(
    GLSL_CLOCK.fps,
    OCEAN_WAVE_NOMINAL_FPS,
    "GlobeFS.glsl and GlobeOceanWaveClock.js must agree on the nominal rate",
  );
});

test("C2 both dialects derive the same clock from the same seconds", () => {
  for (const seconds of [0, 1, 1 / 60, 0.5, 37, 123.456, 1500]) {
    const fromGlsl = glslNominalFrames(GLSL_CLOCK, seconds);
    // The WebGPU side's phase is the same nominal frame count taken at the
    // per-frame increment, so dividing it back out recovers the clock the
    // packer is marching on. Below the wrap the recovery is exact.
    const fromPacker =
      PACK_PHASE({ oceanWaveSeconds: seconds }, {}) / WAVE_FRAME_SPEED;
    assert.ok(
      Math.abs(fromGlsl - fromPacker) < 1e-6,
      `at ${seconds} s the dialects disagree: ${fromGlsl} vs ${fromPacker}`,
    );
    assert.ok(Math.abs(fromGlsl - seconds * OCEAN_WAVE_NOMINAL_FPS) < 1e-9);
  }
});

test("C3 the GLSL wave rate is unchanged: one second is sixty frames", () => {
  const { high, low, speeds } = GLSL_CLOCK;
  const at = (seconds, expression) =>
    evalGlsl(expression, {
      waveClockFrames: glslNominalFrames(GLSL_CLOCK, seconds),
      ...speeds,
    });
  for (const [expression, speed] of [
    [high, speeds.oceanAnimationSpeedHighAltitude],
    [low, speeds.oceanAnimationSpeedLowAltitude],
  ]) {
    const perSecond = at(1, expression) - at(0, expression);
    assert.ok(
      Math.abs(perSecond - OCEAN_WAVE_NOMINAL_FPS * speed) < 1e-12,
      `one second gave ${perSecond}, sixty frames gave ${OCEAN_WAVE_NOMINAL_FPS * speed}`,
    );
  }
  // Both layers read ONE clock, so they cannot drift apart.
  assert.equal(
    (stripGlslComments(glsl).match(/u_oceanWaveSeconds/g) ?? []).length,
    2,
    "the uniform is declared once and read once",
  );
});

/**
 * How the WGSL takes its clock from the tile uniform buffer and marches on it.
 *
 * The WGSL never named a counter — its clock arrives packed — so what it has to
 * keep doing is read that slot and advect all three octaves with it.
 *
 * @param {string} source The shader source.
 * @returns {{readsSlot: boolean, advecting: number}} What the shader does.
 */
function wgslClockConsumption(source) {
  const code = stripWgslComments(source);
  return {
    readsSlot: /let t = select\(tile\.time, 0\.0, tile\.time > 1\.0e9\);/.test(
      code,
    ),
    advecting: (code.match(/fract\(t \* OCEAN_ADVECT_\d\)/g) ?? []).length,
  };
}

test("C4 neither dialect can still reach the render-loop counter", () => {
  assert.ok(
    !stripGlslComments(glsl).includes("czm_frameNumber"),
    "GlobeFS.glsl must no longer sample the frame counter",
  );
  const consumption = wgslClockConsumption(wgsl);
  assert.ok(consumption.readsSlot, "the WGSL must read the packed clock slot");
  assert.equal(
    consumption.advecting,
    3,
    "all three octaves must advect on the packed clock",
  );
  // Both arms march on this one clock. `ENHANCED_OCEAN` is a preprocessor
  // define, so its directive is read from the RAW text — stripping comments
  // would take the directive with them — and it opens AFTER the wave block, in
  // the same function. A default globe compiles the classic arm, so a change
  // that reached only the enhanced one would be unreachable from a default
  // scene, which is the shape this feature's port had to be checked for before.
  const marchAt = wgsl.indexOf("let waveN = sampleOceanWaveNormals(");
  const enhancedAt = wgsl.indexOf("//>>ifdef ENHANCED_OCEAN", marchAt);
  assert.ok(marchAt > 0, "the wave march must be findable");
  assert.ok(enhancedAt > marchAt, "the march must precede the arm split");
  assert.equal(
    (wgsl.match(/sampleOceanWaveNormals\(/g) ?? []).length -
      (wgsl.match(/fn sampleOceanWaveNormals\(/g) ?? []).length,
    1,
    "one march, so the two arms cannot be given different clocks",
  );
});

/**
 * The time argument each `czm_getWaterNoise` call in the shader is given.
 *
 * The builtin's third parameter IS the wave clock: it is what the four sampling
 * directions are multiplied by. A call that passes a constant there draws a
 * frozen sea while every constant, uniform and expression around it still reads
 * correctly, so the argument has to be executed, not merely present.
 *
 * @param {string} source The shader source.
 * @returns {string[]} The third argument of each call, in source order.
 */
function glslWaterNoiseTimeArguments(source) {
  const calls = stripGlslComments(source).match(/czm_getWaterNoise\([^()]*\)/g);
  assert.ok(calls !== null, "the shader must sample the wave normal map");
  return calls.map((call) => {
    const args = call.slice("czm_getWaterNoise(".length, -1).split(",");
    assert.equal(args.length, 4, `unexpected argument count in ${call}`);
    return args[2].trim();
  });
}

test("C5 both GLSL wave layers are HANDED the clock, not a constant", () => {
  const args = glslWaterNoiseTimeArguments(glsl);
  assert.equal(args.length, 2, "one call per wave layer, and no others");
  // Executed, not matched: bind the layer time to a value the shader cannot
  // know and require each call to hand exactly that value on.
  const probe = 1234.5;
  for (const [i, argument] of args.entries()) {
    assert.equal(
      evalGlsl(argument, { time: probe }),
      probe,
      `wave layer ${i} does not pass its own clock to czm_getWaterNoise`,
    );
  }
  // C3 has already shown that `time` IS the wave clock at both layers, so the
  // two together are the chain: seconds -> waveClockFrames -> time -> the
  // sampler. This closes the last link.
});

// ───────── D. the plumbing is live on both backends ─────────────────────────

test("D1 the globe resolves the clock once, above the backend branch", () => {
  const code = stripJsComments(globeJs);
  assert.equal(
    (code.match(/advanceGlobeOceanWaveClock\(/g) ?? []).length,
    1,
    "one resolve per frame; two would be two clocks",
  );
  assert.match(
    code,
    /tileProvider\.oceanWaveSeconds = advanceGlobeOceanWaveClock\(\s*this\._oceanWaveClock,\s*frameState,\s*this\._water\?\.pinnedOceanSimulationEpoch,\s*\);/,
    "the resolved seconds must reach the shared per-frame provider mirror",
  );
  assert.match(code, /this\._oceanWaveClock = createGlobeOceanWaveClock\(\);/);
  assert.ok(
    !code.includes("isWebGPU") ||
      code.indexOf("advanceGlobeOceanWaveClock(") <
        code.indexOf("context.isWebGPU"),
    "the clock must be resolved before any backend branch",
  );
});

test("D2 the WebGL uniform is published from that same field", () => {
  const code = stripJsComments(renderingJs);
  assert.match(
    code,
    /u_oceanWaveSeconds: function \(\) \{\s*return this\.properties\.oceanWaveSeconds;\s*\},/,
  );
  assert.match(
    code,
    /uniformMapProperties\.oceanWaveSeconds =\s+tileProvider\.oceanWaveSeconds \?\? 0\.0;/,
  );
  assert.match(
    code,
    /oceanWaveSeconds: 0\.0,/,
    "the default must be the origin",
  );
  assert.match(
    stripJsComments(providerJs),
    /this\.oceanWaveSeconds = 0\.0;/,
    "the provider must carry the mirror with a defined default",
  );
});

test("D3 the pin is the FFT surface's, read without creating it", () => {
  const code = stripJsComments(waterJs);
  assert.match(
    code,
    /get pinnedOceanSimulationEpoch\(\) \{\s*return this\._ocean\?\.simulationEpoch;\s*\}/,
    "the peek must not go through the constructing accessor",
  );
  assert.ok(
    !/get pinnedOceanSimulationEpoch\(\) \{[\s\S]*new GlobeWaterOcean/.test(
      code,
    ),
    "reading the pin must not create the sub-facade",
  );
});

test("D4 the barrel generator skips the clock, which has no default export", () => {
  // `createCesiumJs` and `createIndexJs` both emit
  // `export { default as <basename> } from './<module>.js'` for every file the
  // engine glob matches, so a named-export-only module MUST be excluded there or
  // the bundle fails to build. Nothing else in this repository catches that: it
  // is invisible to tsc, to eslint and to every node spec, and only a full build
  // would reveal it. Two sibling helpers are already on the list for exactly this
  // reason.
  assert.ok(
    !/^export default/m.test(clockJs) && !/\bexport default\b/.test(clockJs),
    "this test is only meaningful while the clock has no default export",
  );
  assert.match(
    buildJs,
    /"!packages\/engine\/Source\/Scene\/GlobeOceanWaveClock\.js",/,
    "the clock must be excluded from the generated engine barrel",
  );
  // And the exclusion has to sit inside the engine workspace glob, not merely
  // somewhere in the file.
  const engineGlob = /engine: \[([\s\S]*?)\],/.exec(buildJs);
  assert.ok(engineGlob !== null, "the engine source glob must be findable");
  assert.ok(
    engineGlob[1].includes(
      '"!packages/engine/Source/Scene/GlobeOceanWaveClock.js"',
    ),
    "the exclusion must be in the engine workspace glob",
  );
});

// ───────── E. MUTANTS — each half rebuilt from substituted text ─────────────

const CLOCK_LAW_SOURCE = (() => {
  const at = clockJs.indexOf("function advanceGlobeOceanWaveClock(");
  assert.ok(at >= 0, "the law must exist");
  const open = clockJs.indexOf("{", at);
  let depth = 0;
  let i = open;
  for (; i < clockJs.length; i += 1) {
    if (clockJs[i] === "{") {
      depth += 1;
    } else if (clockJs[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        break;
      }
    }
  }
  return clockJs.slice(open + 1, i);
})();

/**
 * Compile the clock law's body into a callable, from possibly mutated text.
 *
 * @param {string} body The body text.
 * @returns {Promise<Function>} The callable.
 */
function compileClockLaw(body) {
  return evaluateModule(
    `import defined from ${JSON.stringify(DEFINED_URL)};` +
      `\nimport JulianDate from ${JSON.stringify(JULIAN_URL)};` +
      `\nimport { cloneSimulationEpoch, resolveOceanSimulationSeconds } from ${JSON.stringify(OCEAN_URL)};` +
      `\nvoid JulianDate;` +
      `\nconst CLOCKLESS_FRAME_SECONDS = ${1 / OCEAN_WAVE_NOMINAL_FPS};` +
      `\nexport default function (clock, frameState, pinnedEpoch) {${body}}`,
  );
}

/**
 * Does a pinned epoch survive the caller mutating the instant it handed over?
 *
 * @param {Function} law The law under test.
 * @returns {boolean} Whether the pin held.
 */
function pinHolds(law) {
  const caller = JulianDate.clone(EPOCH);
  const clock = createGlobeOceanWaveClock();
  const frames = sceneClock();
  law(clock, frames.at(10), caller);
  JulianDate.addSeconds(EPOCH, 3600, caller);
  return law(clock, frames.at(10), caller) === 10;
}

test("E1 the shipped clock law holds its pin; the ALIASED-EPOCH mutant does not", async () => {
  assert.ok(pinHolds(await compileClockLaw(CLOCK_LAW_SOURCE)));
  const aliased = CLOCK_LAW_SOURCE.replace(
    "cloneSimulationEpoch(pinnedEpoch)",
    "pinnedEpoch",
  );
  assert.notEqual(aliased, CLOCK_LAW_SOURCE, "the mutation must apply");
  assert.equal(
    pinHolds(await compileClockLaw(aliased)),
    false,
    "storing the caller's reference must be observable",
  );
});

test("E2 the INERT-CLOCK mutant of the clock law dies", async () => {
  // The phase stops moving with the clock while every name is still present.
  const inert = CLOCK_LAW_SOURCE.replace(
    "const elapsed = resolveOceanSimulationSeconds(clock, frameState);",
    "const elapsed = false && resolveOceanSimulationSeconds(clock, frameState);",
  );
  assert.notEqual(inert, CLOCK_LAW_SOURCE, "the mutation must apply");
  const law = await compileClockLaw(inert);
  const clock = createGlobeOceanWaveClock();
  const frames = sceneClock();
  law(clock, frames.at(0), undefined);
  assert.notEqual(
    law(clock, frames.at(10), undefined),
    10,
    "an unreachable resolver must not still report the clock",
  );
});

test("E3 the FRAME-COUNTER mutant of the packer dies", async () => {
  const mutated = tileUbTs.replace(
    "const oceanWaveSeconds = tileProvider?.oceanWaveSeconds ?? 0.0;",
    "const oceanWaveSeconds = (frameState?.frameNumber ?? 0) / 60.0;",
  );
  assert.notEqual(mutated, tileUbTs, "the mutation must apply");
  const phase = await phaseBlockFrom(mutated);
  const clock = createGlobeOceanWaveClock();
  const frames = sceneClock();
  advanceGlobeOceanWaveClock(clock, frames.at(0), undefined);
  const seconds = advanceGlobeOceanWaveClock(clock, frames.at(37), undefined);
  const first = phase({ oceanWaveSeconds: seconds }, frames.state);
  const held = advanceGlobeOceanWaveClock(clock, frames.tick(), undefined);
  assert.notEqual(
    phase({ oceanWaveSeconds: held }, frames.state),
    first,
    "a phase the frame counter can reach must fail the held-clock check",
  );
});

test("E4 the INERT-UNIFORM mutant of the GLSL dies", () => {
  const mutated = glsl.replace(
    "float waveClockFrames = u_oceanWaveSeconds * oceanWaveNominalFramesPerSecond;",
    "float waveClockFrames = 0.0 * u_oceanWaveSeconds * oceanWaveNominalFramesPerSecond;",
  );
  assert.notEqual(mutated, glsl, "the mutation must apply");
  const clockText = glslWaveClock(mutated);
  assert.equal(
    glslNominalFrames(clockText, 37),
    0,
    "the mutant must be inert, which is what makes it a mutant",
  );
  assert.notEqual(
    glslNominalFrames(clockText, 37),
    glslNominalFrames(GLSL_CLOCK, 37),
    "C2's cross-dialect equality must be able to see the difference",
  );
});

test("E5 the DRIFTED-RATE mutant of the GLSL dies", () => {
  const mutated = glsl.replace(
    "const float oceanWaveNominalFramesPerSecond = 60.0;",
    "const float oceanWaveNominalFramesPerSecond = 30.0;",
  );
  assert.notEqual(mutated, glsl, "the mutation must apply");
  assert.notEqual(
    glslWaveClock(mutated).fps,
    OCEAN_WAVE_NOMINAL_FPS,
    "a shader rate that drifted from the shared law must be visible",
  );
});

test("E6 CONTROL — a comment-only mutation moves no verdict", () => {
  const mutated = glsl.replace(
    "// high altitude wave settings",
    "// high altitude wave settings (comment-only control)",
  );
  assert.notEqual(mutated, glsl, "the control must apply");
  const clockText = glslWaveClock(mutated);
  assert.equal(clockText.fps, GLSL_CLOCK.fps);
  assert.equal(
    glslNominalFrames(clockText, 37),
    glslNominalFrames(GLSL_CLOCK, 37),
  );
});

test("E7 the INERT-PHASE mutant of the packer dies", async () => {
  // Every name stays, the arithmetic stays, and the clock stops reaching the
  // slot — the mutation a deletion-only mutant would miss.
  const mutated = tileUbTs.replace(
    "(oceanWaveSeconds * OCEAN_WAVE_SECOND_SPEED) % OCEAN_WAVE_TIME_PERIOD;",
    "(0.0 * oceanWaveSeconds * OCEAN_WAVE_SECOND_SPEED) % OCEAN_WAVE_TIME_PERIOD;",
  );
  assert.notEqual(mutated, tileUbTs, "the mutation must apply");
  const phase = await phaseBlockFrom(mutated);
  assert.equal(
    phase({ oceanWaveSeconds: 13 }, {}) - phase({ oceanWaveSeconds: 12 }, {}),
    0,
    "the mutant must be inert, which is what makes it a mutant",
  );
  assert.notEqual(
    phase({ oceanWaveSeconds: 13 }, {}) - phase({ oceanWaveSeconds: 12 }, {}),
    OCEAN_WAVE_NOMINAL_FPS * WAVE_FRAME_SPEED,
    "B2's rate check must be able to see the difference",
  );
});

test("E8 the INERT-CLOCK mutant of the WGSL march dies", () => {
  // The slot is still read and the octaves still sample; only the time stops
  // moving. C4's two readings must both notice.
  const frozen = wgsl.replace(
    "let t = select(tile.time, 0.0, tile.time > 1.0e9);",
    "let t = select(0.0, 0.0, tile.time > 1.0e9);",
  );
  assert.notEqual(frozen, wgsl, "the mutation must apply");
  assert.equal(wgslClockConsumption(frozen).readsSlot, false);
  const unadvected = wgsl.replace(
    "fract(t * OCEAN_ADVECT_1)",
    "fract(0.0 * t * OCEAN_ADVECT_1)",
  );
  assert.notEqual(unadvected, wgsl, "the mutation must apply");
  assert.equal(wgslClockConsumption(unadvected).advecting, 2);
  assert.equal(wgslClockConsumption(wgsl).advecting, 3);
});

test("E9 the mutants were never written to disk", () => {
  assert.equal(read(GLSL_REL), glsl);
  assert.equal(read(TILE_UB_REL), tileUbTs);
  assert.equal(read(CLOCK_REL), clockJs);
  assert.equal(read(WGSL_REL), wgsl);
});
