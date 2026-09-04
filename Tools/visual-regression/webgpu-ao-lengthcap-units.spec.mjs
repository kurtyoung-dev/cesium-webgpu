// webgpu-ao-lengthcap-units.spec.mjs — the WebGPU HBAO sample radius is the
// eye-space metres the public uniform documents, at every depth, and the march
// and the falloff measure the same quantity.
//
// @purpose Executes the WebGPU HBAO march radius and distance falloff straight out of both shipped WGSL variants, pinning that lengthCap is eye-space metres in the march as well as in the falloff and that both texts still validate under Naga.
// @status ACTIVE
//
// Run: node --test Tools/visual-regression/webgpu-ao-lengthcap-units.spec.mjs
//
// THE DEFECT THIS PINS. `lengthCap` is documented as a length in metres
// (`packages/engine/Source/Scene/PostProcessStageLibrary.js`) and the bridge
// hands it to the shader unchanged. The WebGPU HBAO generation shader then
// spent it twice, as two different quantities inside one loop: the march stride
// was `lengthCap / stepDenominator` added to a PIXEL coordinate, while the
// distance falloff compared an eye-space METRES distance against the same
// number. The two only agree where one pixel happens to measure one metre.
// Everywhere else the march covered a radius the falloff was not written for —
// a few thousandths of a metre close up, and beyond one pixel per metre nothing
// at all, because every sample the march could reach already sat past the
// falloff's zero.
//
// WHAT IS ASSERTED, AND WHY IT IS NOT A GREP. Nothing below states the fixed
// expression and then checks the file contains it. Group A measures the
// reconstruction's own metres-per-pixel scale by evaluating `pixelToEye`'s
// return expression out of the shipped text. Groups B-G then resolve
// `sampleOffset`, `dist` and `distFactor` out of `fragmentMain` — every
// intermediate binding evaluated from its own shipped initializer, with only
// the uniform block, the noise draw, the loop counters and the depth fetch
// supplied — and assert properties of the NUMBERS that chain produces. Group F
// pairs the two variants; group G raises the noise dither the other groups hold
// at zero and measures where it lands. A shader that reaches the same numbers
// by different text passes; a shader that keeps this text and changes what it
// means fails.
//
// WHAT THE SPEC DELIBERATELY SUPPLIES. The depth fetch (`readDepth`) is stubbed
// to a constant, which makes the sampled neighbourhood a plane at that depth —
// the regime in which "the march radius" is defined at all. The two mutable
// `var` bindings that carry the executed sample counts are supplied rather than
// read, because their law belongs to `webgpu-ao-sample-pattern-parity.spec.mjs`
// and reading a `var` whose value depends on a branch would be the reader
// asserting a branch it did not execute. Every other name resolves from source,
// and a binding this reader cannot evaluate throws instead of being skipped.
//
// WHAT IT DOES NOT PROVE. Nothing here compiles a pipeline or reads a pixel.
// Naga validation (its own test) proves both variants are still accepted WGSL;
// the visible consequence is a browser leg.
//
// CRLF: this repository checks out with `core.autocrlf=true`; every read below
// normalises line endings before parsing.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  compileFunction,
  evaluate,
  extractFunction,
  parseExpression,
  readConstants,
  stripComments,
  tokenize,
  vec,
} from "./lib/wgsl-mini-eval.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");

const SHADER_DIR = "packages/engine/Source/Shaders/WebGPU/PostProcess";
const VARIANT_PATHS = {
  f32: `${SHADER_DIR}/AmbientOcclusionGenerate.wgsl`,
  f16: `${SHADER_DIR}/AmbientOcclusionGenerate_f16.wgsl`,
};

/**
 * Read a tracked source file with its line endings normalised to LF.
 *
 * @param {string} relativePath Repository-relative path.
 * @returns {string} The source text.
 */
function read(relativePath) {
  return fs
    .readFileSync(path.join(ROOT, relativePath), "utf8")
    .replace(/\r\n/g, "\n");
}

/**
 * Strip comments and normalise away the trailing commas the WGSL in this
 * repository writes before a closing parenthesis. The evaluator's argument
 * parser reads a comma as "another argument follows", so a trailing one makes
 * an otherwise readable call unreadable; dropping it changes no value.
 *
 * @param {string} source WGSL text.
 * @returns {string} Text ready for the reader below.
 */
function prepare(source) {
  return stripComments(source).replace(/,(\s*\))/g, "$1");
}

/**
 * Locate a `let` binding's initializer inside a function body and parse it.
 *
 * A `var` binding is refused rather than read: WGSL `var` is mutable, so its
 * initializer is not its value, and a reader that pretended otherwise would
 * report a number the shader never uses.
 *
 * @param {string} body The function body text.
 * @param {string} name The binding name.
 * @returns {object} The parsed initializer node.
 */
function bindingNode(body, name) {
  const immutable = new RegExp(
    String.raw`(?:^|\n)[ \t]*let[ \t]+${name}[ \t]*(?::[^=]+)?=`,
  );
  const mutable = new RegExp(
    String.raw`(?:^|\n)[ \t]*var[ \t]+${name}[ \t]*(?::[^=]+)?=`,
  );
  const found = body.match(immutable);
  if (found === null) {
    if (mutable.test(body)) {
      throw new Error(
        `${name} is a mutable binding; the caller must supply its value`,
      );
    }
    throw new Error(`no let binding named ${name}`);
  }
  const rest = body.slice(found.index + found[0].length);
  // A WGSL initializer ends at its statement terminator, and the tokenizer is
  // eager over whatever it is handed, so hand it only the initializer.
  const terminator = rest.indexOf(";");
  if (terminator < 0) {
    throw new Error(`binding ${name} has no statement terminator`);
  }
  return parseExpression(tokenize(rest.slice(0, terminator)), 0).node;
}

/**
 * Collect every free identifier a parsed node reads.
 *
 * @param {object} node The node.
 * @param {Set<string>} out Accumulator.
 * @returns {Set<string>} The accumulator.
 */
function freeReferences(node, out = new Set()) {
  switch (node.type) {
    case "ref":
      out.add(node.name);
      break;
    case "member":
      freeReferences(node.object, out);
      break;
    case "neg":
      freeReferences(node.operand, out);
      break;
    case "bin":
      freeReferences(node.left, out);
      freeReferences(node.right, out);
      break;
    case "cond":
      freeReferences(node.test, out);
      freeReferences(node.consequent, out);
      freeReferences(node.alternate, out);
      break;
    case "call":
      for (const argument of node.args) {
        freeReferences(argument, out);
      }
      break;
    default:
      break;
  }
  return out;
}

/**
 * Walk a function's `let` bindings and return its parsed return expression
 * together with the environment those bindings produced.
 *
 * @param {string} prepared Prepared WGSL text.
 * @param {string} name The function name.
 * @param {Array} args Positional argument values.
 * @param {object} globals Seed bindings, including `__functions`.
 * @returns {{env: object, returnNode: object}} The environment and return node.
 */
function walkFunction(prepared, name, args, globals) {
  const { params, body } = extractFunction(prepared, name);
  const env = Object.create(null);
  Object.assign(env, globals);
  params.forEach((parameter, index) => {
    env[parameter] = args[index];
  });

  const tokens = tokenize(body);
  let pos = 0;
  while (pos < tokens.length) {
    const token = tokens[pos];
    if (token.text === "let") {
      const identifier = tokens[pos + 1];
      let cursor = pos + 2;
      if (tokens[cursor]?.text === ":") {
        while (tokens[cursor].text !== "=") {
          cursor += 1;
        }
      }
      const parsed = parseExpression(tokens, cursor + 1);
      env[identifier.text] = evaluate(parsed.node, env);
      pos = parsed.next + 1;
      continue;
    }
    if (token.text === "return") {
      return { env, returnNode: parseExpression(tokens, pos + 1).node };
    }
    throw new Error(`${name} grew a statement this reader cannot evaluate`);
  }
  throw new Error(`${name} has no return`);
}

/**
 * Build the shader's own eye-space reconstruction as a callable, by evaluating
 * `pixelToEye`'s return expression out of the shipped text with the depth fetch
 * stubbed to a constant plane.
 *
 * @param {string} prepared Prepared WGSL text.
 * @param {object} scene The uniform block and the plane depth.
 * @returns {(screen: object) => object} Screen pixel to eye-space position.
 */
function makeReconstruction(prepared, scene) {
  return function reconstruct(screen) {
    const globals = {
      uniforms: scene.uniforms,
      __functions: { readDepth: () => scene.depth },
    };
    const { env, returnNode } = walkFunction(
      prepared,
      "pixelToEye",
      [screen],
      globals,
    );
    assert.equal(
      returnNode.type,
      "call",
      "pixelToEye must return a constructed position",
    );
    assert.equal(returnNode.args.length, 2, "pixelToEye return arity changed");
    const lateral = evaluate(returnNode.args[0], env);
    const axial = evaluate(returnNode.args[1], env);
    return vec(lateral.x, lateral.y, axial);
  };
}

/**
 * Build the uniform block the generation pass writes, in the lane order the
 * effect packs it.
 *
 * @param {object} config The AO configuration.
 * @returns {object} The uniform block.
 */
function uniformBlock(config) {
  return {
    params0: {
      x: config.intensity ?? 3.0,
      y: config.bias ?? 0.1,
      z: config.lengthCap,
      w: config.stepCount,
    },
    params1: {
      x: config.directionCount,
      y: 1 / config.width,
      z: 1 / config.height,
      w: 4.0,
    },
    frustum: { x: 1.0, y: 1.0e7, z: 0.0, w: 0.0 },
    _pad: { x: config.fullSamplePattern ? 1.0 : 0.0, y: 0.0, z: 0.0, w: 0.0 },
  };
}

/**
 * Resolve a named binding inside `fragmentMain` by evaluating its own shipped
 * initializer, recursively resolving whatever that initializer reads.
 *
 * @param {string} prepared Prepared WGSL text.
 * @param {object} config The AO configuration and sample position.
 * @param {string} name The binding to resolve.
 * @returns {number|object} The value.
 */
function resolveInFragment(prepared, config, name) {
  const { body } = extractFunction(prepared, "fragmentMain");
  const uniforms = uniformBlock(config);
  const reconstruct = makeReconstruction(prepared, {
    uniforms,
    depth: config.depth,
  });

  const env = Object.create(null);
  // Module-scope constants the fragment reads, from the same text.
  Object.assign(env, readConstants(prepared));
  env.uniforms = uniforms;
  env.screenCoord = vec(config.screenX, config.screenY, 0);
  env.randomVal = vec(config.randomX, config.randomY, 0);
  env.s = config.step;
  env.d = config.direction;
  // Supplied, not read: both are `var` bindings whose value depends on a
  // branch, and their law is pinned by the sample-pattern spec.
  env.executedStepCount = config.executedStepCount;
  env.executedDirectionCount = config.executedDirectionCount;
  if (config.forcedDistance !== undefined) {
    // The falloff's input is a distance; supplying one turns the shipped
    // expression into a function this spec can sample.
    env.dist = config.forcedDistance;
  }
  env.__functions = {
    f32: (value) => value,
    i32: (value) => Math.trunc(value),
    cos: (value) => Math.cos(value),
    sin: (value) => Math.sin(value),
    pixelToEye: reconstruct,
  };
  // Every other module-scope function is compiled from the same text, so a
  // helper the march calls is executed rather than named by this spec. The
  // evaluator compiles lazily: one that reads a texture only fails if reached.
  for (const [, fnName] of prepared.matchAll(/\bfn\s+([A-Za-z_]\w*)\s*\(/g)) {
    if (fnName in env.__functions || fnName.endsWith("Main")) {
      continue;
    }
    env.__functions[fnName] = compileFunction(prepared, fnName, env);
  }

  const pending = new Set();
  const resolve = (identifier) => {
    if (identifier in env) {
      return env[identifier];
    }
    if (pending.has(identifier)) {
      throw new Error(`cyclic binding ${identifier}`);
    }
    pending.add(identifier);
    const node = bindingNode(body, identifier);
    for (const reference of freeReferences(node)) {
      resolve(reference);
    }
    env[identifier] = evaluate(node, env);
    pending.delete(identifier);
    return env[identifier];
  };

  return resolve(name);
}

/**
 * Measure the march out of one shipped variant at one configuration.
 *
 * @param {string} prepared Prepared WGSL text.
 * @param {object} config The AO configuration.
 * @returns {object} Measured metres-per-pixel, stride, reach and falloff.
 */
function measure(prepared, config) {
  const uniforms = uniformBlock(config);
  const reconstruct = makeReconstruction(prepared, {
    uniforms,
    depth: config.depth,
  });
  const originX = reconstruct(vec(config.screenX, config.screenY, 0)).x;
  const nextX = reconstruct(vec(config.screenX + 1, config.screenY, 0)).x;
  const metersPerPixel = nextX - originX;

  const at = (step) => resolveInFragment(prepared, { ...config, step }, "dist");
  const offsetAt = (step) =>
    resolveInFragment(prepared, { ...config, step }, "sampleOffset");

  const firstOffset = offsetAt(1);
  const stridePixels = Math.hypot(firstOffset.x, firstOffset.y);

  return {
    metersPerPixel,
    stridePixels: stridePixels,
    firstDistance: at(1),
    lastDistance: at(config.executedStepCount),
    falloffAt: (distance) =>
      resolveInFragment(
        prepared,
        { ...config, step: 1, forcedDistance: distance },
        "distFactor",
      ),
  };
}

const VARIANTS = Object.fromEntries(
  Object.entries(VARIANT_PATHS).map(([label, relative]) => [
    label,
    { label, relative, raw: read(relative), prepared: prepare(read(relative)) },
  ]),
);

const BASE = {
  width: 1280,
  height: 720,
  screenX: 640.5,
  screenY: 360.5,
  randomX: 0.0,
  randomY: 0.0,
  direction: 0,
  directionCount: 8,
  fullSamplePattern: true,
};

/**
 * Build one configuration.
 *
 * @param {object} overrides Fields to override on the base configuration.
 * @returns {object} The configuration.
 */
function config(overrides) {
  const merged = { ...BASE, ...overrides };
  merged.executedStepCount = merged.stepCount;
  merged.executedDirectionCount = merged.directionCount;
  merged.step = merged.step ?? 1;
  return merged;
}

const CAPS = [0.26, 1.0, 4.0, 25.0];
const DEPTHS = [2, 10, 50, 166, 500, 8000];
const STEP_COUNTS = [4, 16, 32];

test("WebGPU HBAO spends lengthCap as eye-space metres", async (t) => {
  await t.test(
    "A. the reconstruction places one pixel at 2 * texelWidth * depth metres",
    () => {
      for (const variant of Object.values(VARIANTS)) {
        for (const depth of DEPTHS) {
          for (const width of [640, 1280, 3840]) {
            const cfg = config({ lengthCap: 1.0, stepCount: 16, depth, width });
            const { metersPerPixel } = measure(variant.prepared, cfg);
            assert.ok(
              Math.abs(metersPerPixel - (2 * depth) / width) < 1e-9,
              `${variant.label}: metres per pixel at depth ${depth}, width ${width} read ${metersPerPixel}`,
            );
          }
        }
      }
    },
  );

  await t.test(
    "B. the march covers lengthCap metres wherever a step spans a pixel",
    () => {
      let supported = 0;
      for (const variant of Object.values(VARIANTS)) {
        for (const lengthCap of CAPS) {
          for (const stepCount of STEP_COUNTS) {
            for (const depth of DEPTHS) {
              const cfg = config({ lengthCap, stepCount, depth });
              const m = measure(variant.prepared, cfg);
              const unflooredStride = lengthCap / m.metersPerPixel / stepCount;
              if (unflooredStride < 1) {
                continue;
              }
              supported += 1;
              assert.ok(
                Math.abs(m.lastDistance - lengthCap) < 1e-6 * lengthCap,
                `${variant.label}: cap ${lengthCap} m at depth ${depth}, ${stepCount} steps reached ${m.lastDistance} m`,
              );
            }
          }
        }
      }
      assert.ok(supported >= 20, `only ${supported} supported configurations`);
    },
  );

  await t.test(
    "C. below one pixel per step the stride is exactly one pixel",
    () => {
      let floored = 0;
      for (const variant of Object.values(VARIANTS)) {
        for (const lengthCap of CAPS) {
          for (const stepCount of STEP_COUNTS) {
            for (const depth of DEPTHS) {
              const cfg = config({ lengthCap, stepCount, depth });
              const m = measure(variant.prepared, cfg);
              const unflooredStride = lengthCap / m.metersPerPixel / stepCount;
              assert.ok(
                m.stridePixels >= 1 - 1e-9,
                `${variant.label}: stride ${m.stridePixels} px fell below one pixel`,
              );
              if (unflooredStride >= 1) {
                continue;
              }
              floored += 1;
              assert.ok(
                Math.abs(m.stridePixels - 1) < 1e-9,
                `${variant.label}: floored stride read ${m.stridePixels} px`,
              );
            }
          }
        }
      }
      assert.ok(floored >= 10, `only ${floored} floored configurations`);
    },
  );

  await t.test("D. the pixel stride tracks 1 / depth, not a constant", () => {
    for (const variant of Object.values(VARIANTS)) {
      const near = measure(
        variant.prepared,
        config({ lengthCap: 25.0, stepCount: 4, depth: 100 }),
      );
      const far = measure(
        variant.prepared,
        config({ lengthCap: 25.0, stepCount: 4, depth: 200 }),
      );
      assert.ok(
        near.stridePixels > 2 && far.stridePixels > 2,
        `${variant.label}: the depth pair must sit above the one-pixel floor`,
      );
      assert.ok(
        Math.abs(near.stridePixels / far.stridePixels - 2) < 1e-6,
        `${variant.label}: doubling depth changed the stride by ${near.stridePixels / far.stridePixels}x`,
      );
    }
  });

  await t.test(
    "E. the falloff still measures metres against the same cap",
    () => {
      for (const variant of Object.values(VARIANTS)) {
        for (const lengthCap of CAPS) {
          const depth = 20;
          const cfg = config({ lengthCap, stepCount: 4, depth });
          const m = measure(variant.prepared, cfg);
          // The falloff reaches zero at exactly one cap of eye-space distance,
          // and the march's last sample sits there — the two quantities the
          // defect had disagreeing.
          assert.ok(
            Math.abs(m.falloffAt(0) - 1) < 1e-9,
            `${variant.label}: falloff at zero distance read ${m.falloffAt(0)}`,
          );
          assert.ok(
            Math.abs(m.falloffAt(lengthCap / 2) - 0.5) < 1e-9,
            `${variant.label}: falloff at half a cap read ${m.falloffAt(lengthCap / 2)}`,
          );
          assert.equal(
            m.falloffAt(lengthCap * 1.0001),
            0,
            `${variant.label}: falloff past the cap must be zero`,
          );
          const unflooredStride = lengthCap / m.metersPerPixel / 4;
          if (unflooredStride >= 1) {
            assert.ok(
              m.falloffAt(m.lastDistance) < 1e-6,
              `${variant.label}: the last sample must land on the falloff's zero`,
            );
            assert.ok(
              m.falloffAt(m.firstDistance) > 0,
              `${variant.label}: the first sample must land inside the falloff`,
            );
          }
        }
      }
    },
  );

  await t.test("F. the f16 variant marches the f32 variant's radius", () => {
    for (const lengthCap of CAPS) {
      for (const stepCount of STEP_COUNTS) {
        for (const depth of DEPTHS) {
          const cfg = config({ lengthCap, stepCount, depth });
          const a = measure(VARIANTS.f32.prepared, cfg);
          const b = measure(VARIANTS.f16.prepared, cfg);
          assert.equal(
            b.stridePixels,
            a.stridePixels,
            `f16 stride diverged at cap ${lengthCap} m, depth ${depth}`,
          );
          assert.equal(
            b.lastDistance,
            a.lastDistance,
            `f16 reach diverged at cap ${lengthCap} m, depth ${depth}`,
          );
        }
      }
    }
  });

  await t.test(
    "G. the noise dither still reaches the offset, once per sample",
    () => {
      // Groups B-F hold the noise draw at zero so the march's own numbers are
      // readable. The dither is a separate invariant of the same loop and is
      // measured here: it must still be added to the offset, added once rather
      // than once per step, and — the property the metres conversion changed —
      // it must be no larger than the stride it dithers. The noise texture is
      // 8-bit unorm, so one dither is at most one pixel; while the stride was a
      // fraction of a pixel that one pixel WAS the march.
      const NOISE_CEILING_PIXELS = 1.0;
      const JITTERS = [0.125, 0.9];
      let measured = 0;
      for (const variant of Object.values(VARIANTS)) {
        for (const lengthCap of [0.26, 4.0]) {
          for (const stepCount of [4, 32]) {
            for (const depth of [2, 50, 8000]) {
              const base = config({ lengthCap, stepCount, depth });
              // Direction 0 at randomX 0 points the march along +x, so the
              // offset's magnitude is the scalar the dither is added to and the
              // dither reads directly off it.
              const magnitude = (randomY, step) => {
                const offset = resolveInFragment(
                  variant.prepared,
                  { ...base, randomY, step },
                  "sampleOffset",
                );
                return Math.hypot(offset.x, offset.y);
              };
              for (const jitter of JITTERS) {
                for (const step of [1, 2, stepCount]) {
                  const moved = magnitude(jitter, step) - magnitude(0, step);
                  assert.ok(
                    Math.abs(moved - jitter) < 1e-9,
                    `${variant.label}: a ${jitter} px dither moved sample ${step} by ${moved} px at cap ${lengthCap} m, depth ${depth}`,
                  );
                  measured += 1;
                }
              }
              const stride = magnitude(0, 1);
              assert.ok(
                stride >= NOISE_CEILING_PIXELS - 1e-9,
                `${variant.label}: a ${stride} px stride is shorter than the ${NOISE_CEILING_PIXELS} px dither it carries, at cap ${lengthCap} m, depth ${depth}`,
              );
            }
          }
        }
      }
      assert.ok(measured >= 100, `only ${measured} dither measurements`);
    },
  );
});

/**
 * Locate the march's off-screen guard and return its parsed condition.
 *
 * The guard is found by structure, not by text: the statement immediately
 * before the march's depth fetch must be an `if` whose body is a bare `break`.
 * A guard that stops guarding — condition intact, `break` removed — makes this
 * throw, which is the one part of the claim below that control flow, not
 * arithmetic, has to carry.
 *
 * @param {string} prepared Prepared WGSL text.
 * @returns {object} The parsed condition node.
 */
function guardCondition(prepared) {
  const { body } = extractFunction(prepared, "fragmentMain");
  const fetchAt = body.indexOf("let samplePos = pixelToEye(sampleCoord);");
  if (fetchAt < 0) {
    throw new Error("the march's depth fetch moved");
  }
  const before = body.slice(0, fetchAt);
  const open = before.lastIndexOf("if (");
  if (open < 0) {
    throw new Error("no guard precedes the march's depth fetch");
  }
  let depth = 0;
  let end = -1;
  for (let i = open + 3; i < before.length; i += 1) {
    if (before[i] === "(") {
      depth += 1;
    } else if (before[i] === ")") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) {
    throw new Error("the guard's condition is unbalanced");
  }
  const tail = before.slice(end + 1).replace(/\s+/g, "");
  if (tail !== "{break;}") {
    throw new Error(`the guard's body is ${JSON.stringify(tail)}, not a break`);
  }
  return parseExpression(tokenize(before.slice(open + 4, end)), 0).node;
}

/**
 * Execute the shipped guard at one sample and report whether it fires.
 *
 * WGSL's `!=` over vectors yields a vector of booleans and `any` folds it; the
 * shared evaluator reads scalars, so those two semantics — and the
 * component-wise `clamp` between them — are supplied here. Every operand,
 * including both bounds, is evaluated out of the shipped text.
 *
 * @param {string} prepared Prepared WGSL text.
 * @param {object} cfg The AO configuration and sample position.
 * @returns {boolean} Whether the march breaks at this sample.
 */
function guardTripped(prepared, cfg) {
  const node = guardCondition(prepared);
  if (node.type !== "call" || node.name !== "any" || node.args.length !== 1) {
    throw new Error("the guard is not a single-argument any(...)");
  }
  const comparison = node.args[0];
  if (comparison.type !== "bin" || comparison.op !== "!=") {
    throw new Error("the guard does not fold a component-wise !=");
  }
  const env = Object.create(null);
  env.__functions = {
    clamp: (v, lo, hi) =>
      vec(
        Math.min(Math.max(v.x, lo.x), hi.x),
        Math.min(Math.max(v.y, lo.y), hi.y),
        Math.min(Math.max(v.z, lo.z), hi.z),
      ),
  };
  const referenced = freeReferences(comparison.left);
  freeReferences(comparison.right, referenced);
  for (const name of referenced) {
    env[name] = resolveInFragment(prepared, cfg, name);
  }
  const left = evaluate(comparison.left, env);
  const right = evaluate(comparison.right, env);
  // Both operands are vec2. The shared evaluator carries every vector as three
  // components with a zero filler, and that filler is not a value the shader
  // has: dividing it out of the viewport expression yields NaN. Fold the two
  // components WGSL actually compares.
  return left.x !== right.x || left.y !== right.y;
}

/**
 * The first step index along one direction at which the march breaks.
 *
 * @param {string} prepared Prepared WGSL text.
 * @param {object} cfg The AO configuration.
 * @returns {number} The step index, or 0 if the whole march stays on screen.
 */
function firstTrippedStep(prepared, cfg) {
  for (let step = 1; step <= cfg.executedStepCount; step += 1) {
    if (guardTripped(prepared, { ...cfg, step })) {
      return step;
    }
  }
  return 0;
}

test("the WebGPU HBAO march stops at the screen edge", async (t) => {
  // Real pixels are what made this reachable. Before the unit fix the whole
  // march spanned `lengthCap` PIXELS — 0.26 px at the shipped default, inside
  // one texel — so only the sub-pixel noise dither could leave the frame.
  // Spending the cap in metres makes the march span `lengthCap /
  // metresPerPixel` px instead, tens of pixels at close range, and the depth
  // texture is read through a sampler that declares no address mode and so
  // clamps to edge: an unguarded off-screen step returns the border texel's
  // depth at a lateral position reconstructed from the unclamped coordinate.
  // The WebGL stage this shader mirrors breaks out of the direction instead
  // ("Exit if we stepped off the screen", in
  // packages/engine/Source/Shaders/PostProcessStages/AmbientOcclusionGenerate.glsl).
  // Both WebGPU variants now do the same.
  const EDGE = {
    lengthCap: 0.26,
    stepCount: 32,
    depth: 2,
    directionCount: 8,
  };

  await t.test("both shipped variants guard in lockstep", () => {
    const shapes = Object.values(VARIANTS).map((variant) =>
      JSON.stringify(guardCondition(variant.prepared)),
    );
    assert.equal(shapes.length, 2, "a variant went missing");
    assert.equal(
      new Set(shapes).size,
      1,
      "the two variants guard the march differently",
    );
  });

  await t.test(
    "the exposure the guard answers is real at the shipped default",
    () => {
      for (const variant of Object.values(VARIANTS)) {
        const cfg = config({ ...EDGE, screenX: 640.5 });
        const reach =
          measure(variant.prepared, cfg).stridePixels * cfg.executedStepCount;
        assert.ok(
          reach > 80,
          `${variant.label}: the march reaches ${reach} px, not tens of pixels`,
        );
        // The pre-fix march spanned `lengthCap` pixels at every depth, so the
        // same border crossing needed a cap above one pixel to happen at all.
        assert.ok(
          cfg.lengthCap < 1,
          `the pre-fix span was ${cfg.lengthCap} px, which is not sub-pixel`,
        );
      }
    },
  );

  await t.test("a march that stays on screen is never cut", () => {
    for (const variant of Object.values(VARIANTS)) {
      // 360 px of clearance in y and 640 px in x, against an 83 px reach.
      const cfg = config({ ...EDGE, screenX: 640.5, screenY: 360.5 });
      for (let direction = 0; direction < cfg.directionCount; direction += 1) {
        assert.equal(
          firstTrippedStep(variant.prepared, { ...cfg, direction }),
          0,
          `${variant.label}: direction ${direction} was cut at frame centre`,
        );
      }
    }
  });

  await t.test(
    "a march that leaves the screen is cut at the border, and only there",
    () => {
      // Direction 0 walks +x, so the right edge stops it; direction 6 walks -x
      // and +y, so the low bound does. A guard that bounded only one side, or
      // bounded the wrong quantity, moves these step indices.
      const cases = [
        { direction: 0, edge: "right", clearance: 0.5 },
        { direction: 0, edge: "right", clearance: 5 },
        { direction: 0, edge: "right", clearance: 20 },
        { direction: 0, edge: "right", clearance: 60 },
        { direction: 0, edge: "right", clearance: 200 },
        { direction: 6, edge: "left", clearance: 0.5 },
        { direction: 6, edge: "left", clearance: 12 },
        { direction: 6, edge: "left", clearance: 40 },
        { direction: 6, edge: "left", clearance: 200 },
      ];
      let measured = 0;
      for (const variant of Object.values(VARIANTS)) {
        for (const testCase of cases) {
          const cfg = config({
            ...EDGE,
            direction: testCase.direction,
            screenX:
              testCase.edge === "right"
                ? BASE.width - testCase.clearance
                : testCase.clearance,
          });
          // Both quantities are shipped numbers: the per-step advance comes
          // out of the march's own `sampleOffset`, and the border is the canvas
          // width the uniform block encodes as 1 / texelSize.x.
          const offset = resolveInFragment(
            variant.prepared,
            { ...cfg, step: 1 },
            "sampleOffset",
          );
          const advance = Math.abs(offset.x);
          assert.ok(advance > 0, "this case does not move in x");
          const crossingStep = Math.floor(testCase.clearance / advance) + 1;
          const expected =
            crossingStep > cfg.executedStepCount ? 0 : crossingStep;
          assert.equal(
            firstTrippedStep(variant.prepared, cfg),
            expected,
            `${variant.label}: ${testCase.edge} edge, ${testCase.clearance} px clearance, ${advance} px per step`,
          );
          measured += 1;
        }
      }
      assert.ok(measured >= 18, `only ${measured} edge measurements`);
    },
  );

  await t.test("inert mutant: the guard evaluates but no longer breaks", () => {
    for (const variant of Object.values(VARIANTS)) {
      const mutated = variant.raw.replace(
        "        break;\n      }\n      let samplePos = pixelToEye(sampleCoord);",
        "        let unused = 0.0;\n      }\n      let samplePos = pixelToEye(sampleCoord);",
      );
      assert.notEqual(mutated, variant.raw, "inert mutant was not applied");
      assert.ok(
        mutated.includes("sampleCoord != clamp("),
        "the mutant must leave the condition in place, merely toothless",
      );
      assert.throws(
        () => firstTrippedStep(prepare(mutated), config(EDGE)),
        /not a break/,
        `${variant.label}: a guard that stopped breaking still read as a guard`,
      );
    }
  });

  await t.test("bound mutant: clamping to the wrong box moves the cut", () => {
    for (const variant of Object.values(VARIANTS)) {
      const mutated = variant.raw.replace(
        "vec2<f32>(0.0), viewportSize)",
        "vec2<f32>(0.0), viewportSize * 2.0)",
      );
      assert.notEqual(mutated, variant.raw, "bound mutant was not applied");
      const cfg = config({ ...EDGE, direction: 0, screenX: BASE.width - 5 });
      assert.notEqual(
        firstTrippedStep(prepare(mutated), cfg),
        firstTrippedStep(variant.prepared, cfg),
        `${variant.label}: doubling the bound cut the march at the same step`,
      );
    }
  });
});

test("both shipped variants still validate under Naga", async () => {
  const nagaDirectory = path.join(
    ROOT,
    "Tools/shader-pipeline/naga-wasm-tools",
  );
  const naga = await import(
    pathToFileURL(path.join(nagaDirectory, "naga_wasm_tools.js")).href
  );
  await naga.default({
    module_or_path: fs.readFileSync(
      path.join(nagaDirectory, "naga_wasm_tools_bg.wasm"),
    ),
  });
  for (const variant of Object.values(VARIANTS)) {
    assert.doesNotThrow(
      () => naga.validate_wgsl(variant.raw),
      `${variant.label} no longer validates`,
    );
  }
});

test("the conversion is load bearing, and the reader can see it move", async (t) => {
  const LIVE_CALL = `let stepLen = marchStepPixels(
    lengthCap,
    -posEC.z,
    texelSize.x,
    f32(stepLenDenominator),
  );`;

  await t.test(
    "inert mutant: the helper survives but the march stops calling it",
    () => {
      for (const variant of Object.values(VARIANTS)) {
        const mutated = variant.raw.replace(
          LIVE_CALL,
          "let stepLen = lengthCap / f32(stepLenDenominator);",
        );
        assert.notEqual(mutated, variant.raw, "inert mutant was not applied");
        assert.ok(
          mutated.includes("fn marchStepPixels"),
          "the mutant must leave the helper in place, merely unreached",
        );
        const prepared = prepare(mutated);
        const near = config({ lengthCap: 4.0, stepCount: 4, depth: 20 });
        const far = config({ lengthCap: 4.0, stepCount: 4, depth: 40 });
        // Measured, not thrown: the reverted text still reads. What it reports
        // is a march whose eye-space reach is proportional to depth, because
        // the cap is being spent as a pixel count — the defect, in one number.
        const revertedNear = measure(prepared, near).lastDistance;
        const revertedFar = measure(prepared, far).lastDistance;
        assert.ok(
          Math.abs(revertedFar / revertedNear - 2) < 1e-9,
          `${variant.label}: reverted reach went ${revertedNear} m to ${revertedFar} m across a doubled depth`,
        );
        assert.ok(
          revertedNear < 0.1 * near.lengthCap,
          `${variant.label}: the reverted march reached ${revertedNear} m of a ${near.lengthCap} m cap`,
        );
        // The shipped text, over the same pair, holds the cap.
        const shippedNear = measure(variant.prepared, near).lastDistance;
        const shippedFar = measure(variant.prepared, far).lastDistance;
        assert.ok(
          Math.abs(shippedNear - near.lengthCap) < 1e-6 &&
            Math.abs(shippedFar - far.lengthCap) < 1e-6,
          `${variant.label}: shipped reach read ${shippedNear} m and ${shippedFar} m`,
        );
        assert.throws(
          () =>
            assert.ok(
              Math.abs(revertedNear - near.lengthCap) < 1e-6 * near.lengthCap,
            ),
          assert.AssertionError,
          `${variant.label}: group B must fail on the reverted text`,
        );
      }
    },
  );

  await t.test(
    "unit mutant: dropping the pixel-width scale breaks the reach",
    () => {
      for (const variant of Object.values(VARIANTS)) {
        const mutated = variant.raw.replace(
          "let metersPerPixel = 2.0 * texelWidth * max(eyeDepth, 0.01);",
          "let metersPerPixel = texelWidth * max(eyeDepth, 0.01);",
        );
        assert.notEqual(mutated, variant.raw, "unit mutant was not applied");
        const cfg = config({ lengthCap: 4.0, stepCount: 4, depth: 20 });
        const m = measure(prepare(mutated), cfg);
        assert.ok(
          Math.abs(m.lastDistance - cfg.lengthCap) > 1e-3 * cfg.lengthCap,
          `${variant.label}: halving the pixel scale left the reach at ${m.lastDistance} m`,
        );
      }
    },
  );

  await t.test(
    "depth mutant: a depth-blind stride stops tracking 1 / depth",
    () => {
      for (const variant of Object.values(VARIANTS)) {
        const mutated = variant.raw.replace(
          "let metersPerPixel = 2.0 * texelWidth * max(eyeDepth, 0.01);",
          "let metersPerPixel = 2.0 * texelWidth;",
        );
        assert.notEqual(mutated, variant.raw, "depth mutant was not applied");
        const prepared = prepare(mutated);
        const near = measure(
          prepared,
          config({ lengthCap: 25.0, stepCount: 4, depth: 100 }),
        );
        const far = measure(
          prepared,
          config({ lengthCap: 25.0, stepCount: 4, depth: 200 }),
        );
        assert.ok(
          Math.abs(near.stridePixels / far.stridePixels - 2) > 1e-3,
          `${variant.label}: a depth-blind stride still halved with depth`,
        );
      }
    },
  );

  await t.test(
    "control mutant: a comment-only edit changes no measurement",
    () => {
      for (const variant of Object.values(VARIANTS)) {
        const mutated = variant.raw.replace(
          "// the fetch returns no depth the march has not already read and the step",
          "// the fetch returns no depth the march has not already seen and the step",
        );
        assert.notEqual(mutated, variant.raw, "control mutant was not applied");
        const cfg = config({ lengthCap: 4.0, stepCount: 4, depth: 20 });
        const before = measure(variant.prepared, cfg);
        const after = measure(prepare(mutated), cfg);
        assert.equal(after.stridePixels, before.stridePixels);
        assert.equal(after.lastDistance, before.lastDistance);
      }
    },
  );
});
