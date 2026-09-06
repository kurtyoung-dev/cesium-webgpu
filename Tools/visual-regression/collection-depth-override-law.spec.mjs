// collection-depth-override-law.spec.mjs — AR-001 / MAB-9 / MAB-7.
// @purpose Executes the real DISABLE_DEPTH_DISTANCE blocks of the WebGPU collection shaders and of BillboardCollectionVS.glsl over a clip-space grid, and requires one fragment outcome from both backends.
// @status ACTIVE
//
// THE LAW, STATED AS AN OUTCOME AND NOT AS A SHAPE. `disableDepthTestDistance`
// means "stop this primitive losing the depth test to whatever is in front of
// it". Both backends implement that by rewriting clip z before rasterization.
// The observable is not which expression they write; it is what the vertex
// then does:
//
//   - a vertex the API would clip stays clipped (nothing is drawn, nothing is
//     picked), and
//   - a vertex that survives lands on its API's NEAR plane.
//
// WebGL's near plane is NDC z = -1 (clip z = -w, range [-w, w]); WebGPU's is
// NDC z = 0 (clip z = 0, range [0, w]). This spec maps both into [0, 1] and
// requires the same number.
//
// WHAT WAS WRONG. `DEFERRED_WORK.md` recorded Bug 3 FIXED for the three colour
// shaders. The two PICK shaders kept the pre-fix `clipPos.z = clipPos.w` — the
// FAR plane — behind a comment asserting the split was deliberate ("the pick
// pass uses z = w to pass its far-cleared depth target without overriding
// nearer pick geometry"). WebGL has no such split to mirror: ONE vertex shader
// serves both passes, so its pick fragments carry the near-plane override too.
// And the WebGPU pick pass rasterizes globe terrain into the same depth target,
// so a far-plane pick fragment loses `less-equal` against terrain — the
// primitive is invisible to `pickAsync` at exactly the distances the property
// exists to cover.
//
// Separately, none of the five carried WebGL's clip guard
// (`BillboardCollectionVS.glsl:340-344`). The override is a WRITE, not a test:
// `clipPos.z = 0.0` PULLED a vertex whose z was outside [0, w] — nearer than
// the near plane, or past the far plane, at positive w — back INSIDE the clip
// volume, so the API drew a fragment WebGL leaves clipped. A w <= 0 vertex is
// clipped on both backends whatever z is written; C3 and D5 pin the difference.
//
// WHY IT IS EXECUTED AND NOT GREPPED. A spec that matched source text would go
// green on the edit and stay green under an `if (false && ...)` mutant, which
// is the failure mode WAVE_RULES Principle 10 names. So the blocks are parsed
// and RUN by `lib/shader-block-interpreter.mjs`: make any branch unreachable
// and the outcome grid moves, which is what section D proves for each of the
// five shaders individually, plus a GLSL-side mutant that proves this spec
// reads both files rather than comparing WGSL with a copy of itself.
//
// LINE ENDINGS: this repo checks out CRLF; every read is normalised to LF.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { executeBlock, parseBlock } from "./lib/shader-block-interpreter.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

/**
 * @param {string} relativePath Repository-relative path.
 * @returns {string} File contents, newlines normalised to LF.
 */
function read(relativePath) {
  return fs
    .readFileSync(path.join(root, relativePath), "utf8")
    .split("\r\n")
    .join("\n");
}

const COLLECTIONS = "packages/engine/Source/Shaders/WebGPU/Collections/";
const GLSL_PATH = "packages/engine/Source/Shaders/BillboardCollectionVS.glsl";

/**
 * The five shaders in AR-001's scope.
 *
 * The polyline family is NOT here, and the reason is not the one an earlier
 * draft of this comment gave. It is NOT that the polyline define is raised only
 * per-instance — `WebGPUPolylineRenderer.js:882-888` raises
 * `DISABLE_DEPTH_DISTANCE` from `frameState.minimumDisableDepthTestDistance`
 * too, exactly as the billboard and point renderers do, so the block's third
 * branch is reachable with the fork property absent.
 *
 * The reason is that there is no WebGL law for a polyline to match. WebGL's
 * polyline shaders have NO `DISABLE_DEPTH_DISTANCE` block at all:
 * `czm_minimumDisableDepthTestDistance` has exactly two GLSL consumers,
 * `BillboardCollectionVS.glsl` and `PointPrimitiveCollectionVS.glsl`, and
 * `PolylineVS.glsl` is not one of them. The whole WebGPU polyline block —
 * per-instance branches AND frame-wide branch — is fork-added, driven by
 * `Polyline.disableDepthTestDistance`, the property `AR-D09` rules on; the
 * decision's own text names "the WebGPU consumer branch that maps `z == w` to
 * the log far plane" as going with a DELETE. Its correct value is therefore not
 * decidable here, and the 18 sites are held as one unit (see the packet's
 * AR-D09 list) rather than split three ways inside one shader whose LOG_DEPTH
 * tail keys on `output.position.z == output.position.w`.
 *
 * Billboards, labels and points read UPSTREAM `disableDepthTestDistance`
 * properties, their renderers raise the define from the upstream frame-wide
 * setting (`WebGPUBillboardRenderer.js:830-836`), and `BillboardCollectionVS.glsl`
 * gives all three a WebGL law to be checked against. None depends on the ruling.
 */
const SHADERS = [
  { file: "BillboardCollection.wgsl", flags: "input.perInstanceFlags.x" },
  { file: "BillboardCollectionSDF.wgsl", flags: "input.perInstanceFlags.x" },
  { file: "PointPrimitiveColor.wgsl", flags: "perInstanceFlags.x" },
  { file: "BillboardCollectionPick.wgsl", flags: "input.perInstanceFlags.x" },
  { file: "PointPrimitivePick.wgsl", flags: "perInstanceFlags.x" },
];

const WGSL_OPEN = /^\s*\/\/>>if/;
const WGSL_CLOSE = /^\s*\/\/>>endif/;
const WGSL_WANTED = /^\s*\/\/>>ifdef DISABLE_DEPTH_DISTANCE\s*$/;
const GLSL_OPEN = /^\s*#\s*(?:if|ifdef|ifndef)\b/;
const GLSL_CLOSE = /^\s*#\s*endif\b/;
const GLSL_WANTED = /^\s*#\s*ifdef DISABLE_DEPTH_DISTANCE\s*$/;

/**
 * Extracts the body a conditional-compilation directive pair delimits, tracking
 * NESTING. `BillboardCollectionVS.glsl`'s block wraps an inner
 * `#ifdef LOG_DEPTH`; a naive first-`#endif` scan stops there and returns a
 * body with an unbalanced brace, which is how this extractor first read the
 * WebGL reference as unparseable rather than as a mismatch.
 *
 * @param {string} source File contents.
 * @param {RegExp} openPattern Matches any opening directive line.
 * @param {RegExp} closePattern Matches any closing directive line.
 * @param {RegExp} wantedPattern Matches the specific opening directive wanted.
 * @param {number} [occurrence] Which matching opening directive, 0-based.
 * @returns {string} The delimited body, directives excluded.
 */
function extractRegion(
  source,
  openPattern,
  closePattern,
  wantedPattern,
  occurrence = 0,
) {
  const lines = source.split("\n");
  let seen = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!wantedPattern.test(lines[i])) {
      continue;
    }
    seen += 1;
    if (seen !== occurrence) {
      continue;
    }
    let depth = 1;
    for (let j = i + 1; j < lines.length; j++) {
      if (openPattern.test(lines[j])) {
        depth += 1;
      } else if (closePattern.test(lines[j])) {
        depth -= 1;
        if (depth === 0) {
          return lines.slice(i + 1, j).join("\n");
        }
      }
    }
    throw new Error("unterminated directive region");
  }
  throw new Error(`directive occurrence ${occurrence} not found`);
}

/**
 * @param {string} wgsl Shader source.
 * @returns {string} The DISABLE_DEPTH_DISTANCE block body.
 */
export function wgslDepthOverrideBlock(wgsl) {
  return extractRegion(wgsl, WGSL_OPEN, WGSL_CLOSE, WGSL_WANTED);
}

/**
 * The GLSL reference block. `BillboardCollectionVS.glsl` opens
 * DISABLE_DEPTH_DISTANCE twice: the first computes the squared distance, the
 * second — taken here — is the one that rewrites `gl_Position`.
 *
 * @param {string} glsl Shader source.
 * @returns {string} The clip-rewriting block body.
 */
export function glslDepthOverrideBlock(glsl) {
  return extractRegion(glsl, GLSL_OPEN, GLSL_CLOSE, GLSL_WANTED, 1);
}

// ---------------------------------------------------------------------------
// A. The outcome model.
// ---------------------------------------------------------------------------

/**
 * What a rasterizer does with a clip-space position, in the terms a user can
 * observe: either no fragment at all, or a fragment at a depth in [0, 1].
 *
 * A vertex with `w <= 0` sits on or behind the eye plane and produces no
 * fragment on either API, so both report `clipped` without consulting z.
 *
 * @param {number} z Clip z after the block ran.
 * @param {number} w Clip w.
 * @param {string} convention Either "webgpu" ([0, w]) or "webgl" ([-w, w]).
 * @returns {{clipped: boolean, depth: number|null}} The outcome.
 */
export function fragmentOutcome(z, w, convention) {
  if (!(w > 0)) {
    return { clipped: true, depth: null };
  }
  const ndc = z / w;
  if (convention === "webgpu") {
    return ndc < 0 || ndc > 1
      ? { clipped: true, depth: null }
      : { clipped: false, depth: ndc };
  }
  return ndc < -1 || ndc > 1
    ? { clipped: true, depth: null }
    : { clipped: false, depth: (ndc + 1) / 2 };
}

/**
 * Samples are parameterised by the DEPTH THE VERTEX IS AT, not by raw clip z.
 *
 * The two APIs put the same geometric point at different clip z, because their
 * projection matrices differ: WebGL emits z in [-w, w], WebGPU in [0, w].
 * Feeding both the same raw z would compare a WebGL vertex at the near plane
 * with a WebGPU vertex half a volume behind it — an artefact of the
 * parameterisation, not a divergence. So the grid names a normalised depth in
 * [0, 1] (values outside it are the out-of-volume cases) and each backend's
 * clip z is derived from it below.
 *
 * Bounded: 9 x 7 = 63 positions per window case.
 */
const DEPTH_SAMPLES = [-1.5, -0.5, 0, 0.25, 0.5, 0.75, 1, 1.5, 3];
const W_SAMPLES = [-3, -1, 0, 0.5, 1, 2, 10];

/**
 * @param {number} depth Normalised depth in [0, 1] (outside = out of volume).
 * @param {number} w Clip w.
 * @param {string} convention Either "webgpu" or "webgl".
 * @returns {number} The clip z that convention would emit for that depth.
 */
function clipZFor(depth, w, convention) {
  return convention === "webgpu" ? depth * w : (2 * depth - 1) * w;
}

/**
 * The distance-window cases both blocks can be driven through identically.
 * `raw` is the WGSL per-instance value in metres; `squared` is the GLSL
 * attribute, which the WebGL shader receives already squared. `-1` is the
 * "always disable" sentinel in both.
 */
const WINDOW_CASES = [
  { id: "sentinel-infinity", raw: -1, squared: -1, distanceSq: 4.0e6 },
  { id: "inside-window", raw: 1000, squared: 1.0e6, distanceSq: 4.0e3 },
  { id: "outside-window", raw: 1000, squared: 1.0e6, distanceSq: 4.0e12 },
  { id: "property-unset", raw: 0, squared: 0, distanceSq: 4.0e6 },
];

const SAMPLE_COUNT =
  WINDOW_CASES.length * DEPTH_SAMPLES.length * W_SAMPLES.length;

/**
 * Runs one WGSL block for one sample.
 *
 * @param {Array<object>} statements Parsed block.
 * @param {string} flags The per-instance accessor this shader reads.
 * @param {object} sample Inputs.
 * @returns {{clipped: boolean, depth: number|null}} The outcome.
 */
function runWgsl(statements, flags, sample) {
  const state = executeBlock(statements, {
    "clipPos.z": clipZFor(sample.depth, sample.w, "webgpu"),
    "clipPos.w": sample.w,
    [flags]: sample.raw,
    camDistSq: sample.distanceSq,
    "camera.minimumDisableDepthTestDistance": 0,
  });
  return fragmentOutcome(state["clipPos.z"], sample.w, "webgpu");
}

/**
 * Runs the GLSL reference block for one sample.
 *
 * @param {Array<object>} statements Parsed block.
 * @param {object} sample Inputs.
 * @returns {{clipped: boolean, depth: number|null}} The outcome.
 */
function runGlsl(statements, sample) {
  const state = executeBlock(statements, {
    "gl_Position.z": clipZFor(sample.depth, sample.w, "webgl"),
    "gl_Position.w": sample.w,
    disableDepthTestDistanceSq: sample.squared,
    lengthSq: sample.distanceSq,
    v_depthFromNearPlusOne: 0,
  });
  return fragmentOutcome(state["gl_Position.z"], sample.w, "webgl");
}

/**
 * Sweeps every (window case x clip position) sample and reports disagreements.
 *
 * @param {string} wgslSource WGSL shader source.
 * @param {string} flags Per-instance accessor.
 * @param {string} glslSource GLSL reference source.
 * @returns {Array<string>} One line per disagreeing sample.
 */
export function outcomeDisagreements(wgslSource, flags, glslSource) {
  const wgsl = parseBlock(wgslDepthOverrideBlock(wgslSource));
  const glsl = parseBlock(glslDepthOverrideBlock(glslSource));
  const problems = [];
  for (const window of WINDOW_CASES) {
    for (const depth of DEPTH_SAMPLES) {
      for (const w of W_SAMPLES) {
        const sample = { ...window, depth, w };
        const gpu = runWgsl(wgsl, flags, sample);
        const gl = runGlsl(glsl, sample);
        if (gpu.clipped !== gl.clipped) {
          problems.push(
            `${window.id} depth=${depth} w=${w}: webgpu ${gpu.clipped ? "clipped" : "drawn"}, webgl ${gl.clipped ? "clipped" : "drawn"}`,
          );
          continue;
        }
        if (!gpu.clipped && Math.abs(gpu.depth - gl.depth) > 1e-9) {
          problems.push(
            `${window.id} depth=${depth} w=${w}: webgpu ${gpu.depth}, webgl ${gl.depth}`,
          );
        }
      }
    }
  }
  return problems;
}

const glslSource = read(GLSL_PATH);
const sources = new Map(
  SHADERS.map(({ file }) => [file, read(COLLECTIONS + file)]),
);

/**
 * The local-name suffix each shader gave its block, so a mutant can name the
 * real identifier rather than a guessed one.
 *
 * @param {string} file Shader file name.
 * @returns {string} The suffix.
 */
function suffixFor(file) {
  return file === "BillboardCollectionPick.wgsl" ? "DPick" : "DP";
}

// ---------------------------------------------------------------------------
// B. The blocks are extractable and executable at all.
// ---------------------------------------------------------------------------

test("B1: the GLSL reference block is the one that rewrites gl_Position", () => {
  const block = glslDepthOverrideBlock(glslSource);
  assert.ok(
    block.includes("gl_Position.z"),
    "took the wrong #ifdef occurrence — this one does not touch gl_Position",
  );
  assert.doesNotThrow(() => parseBlock(block));
});

for (const { file, flags } of SHADERS) {
  test(`B2 ${file}: the block parses and reads its per-instance accessor`, () => {
    const block = wgslDepthOverrideBlock(sources.get(file));
    assert.ok(
      block.includes(flags),
      `${file} no longer reads ${flags}; the spec's input names are stale`,
    );
    assert.doesNotThrow(() => parseBlock(block));
  });
}

// ---------------------------------------------------------------------------
// C. The law.
// ---------------------------------------------------------------------------

for (const { file, flags } of SHADERS) {
  test(`C1 ${file}: every sample's fragment outcome matches WebGL`, () => {
    const problems = outcomeDisagreements(sources.get(file), flags, glslSource);
    assert.deepEqual(
      problems,
      [],
      `${file} disagrees with BillboardCollectionVS.glsl on ${problems.length} of ${SAMPLE_COUNT} samples:\n${problems.slice(0, 8).join("\n")}`,
    );
  });
}

test("C2: an in-volume vertex with the sentinel lands on the near plane, not the far plane", () => {
  // The single sample the pick shaders got wrong. Stated as the depth a user
  // reads, so the "which plane is near" confusion cannot recur silently.
  for (const { file, flags } of SHADERS) {
    const statements = parseBlock(wgslDepthOverrideBlock(sources.get(file)));
    const outcome = runWgsl(statements, flags, {
      depth: 0.9,
      w: 1,
      raw: -1,
      distanceSq: 4.0e6,
    });
    assert.equal(outcome.clipped, false, `${file}: sample was clipped`);
    assert.equal(
      outcome.depth,
      0,
      `${file}: depth ${outcome.depth} — 1 is the far plane, which loses less-equal against terrain`,
    );
  }
});

test("C3: a vertex outside the clip volume is clipped, not pulled onto the near plane", () => {
  // The override is a WRITE, so without a guard `clipPos.z = 0.0` PULLS an
  // out-of-volume vertex back inside the volume and the API draws it. This case
  // asserts it stays clipped.
  //
  // Two groups, and they do NOT carry equal weight:
  //
  //  - w <= 0 (AR-001's literal clause). Non-discriminating BY CONSTRUCTION: a
  //    vertex on or behind the eye plane produces no fragment on either API
  //    whatever z the block writes, so `fragmentOutcome` answers `clipped`
  //    before reading the block's output. These rows pass with the guard made
  //    inert. They are kept because the clause is real behaviour worth pinning,
  //    NOT because they test the guard.
  //  - w > 0 with normalised depth outside [0, 1]. THIS is the guard's own
  //    ground, and it is what makes this case discriminating: with the guard
  //    inert these 16 rows per shader go red (they are 16 of the 32 samples C1
  //    counts, the other 16 being the same grid under the inside-window case).
  for (const { file, flags } of SHADERS) {
    const statements = parseBlock(wgslDepthOverrideBlock(sources.get(file)));
    const cases = [
      ...[-3, -1, 0].flatMap((w) =>
        [-0.5, 0, 0.5, 2].map((depth) => [w, depth]),
      ),
      ...[0.5, 1, 2, 10].flatMap((w) =>
        [-1.5, -0.5, 1.5, 3].map((depth) => [w, depth]),
      ),
    ];
    for (const [w, depth] of cases) {
      const outcome = runWgsl(statements, flags, {
        depth,
        w,
        raw: -1,
        distanceSq: 4.0e6,
      });
      assert.equal(
        outcome.clipped,
        true,
        `${file}: depth=${depth} w=${w} produced a fragment at ${outcome.depth}`,
      );
    }
  }
});

test("C4: the frame-wide minimum targets the same near plane as the per-instance value", () => {
  // The `camera.minimumDisableDepthTestDistance` branch has no counterpart
  // inside the extracted GLSL block (WebGL folds it into the attribute earlier
  // in the shader), so it is pinned directly rather than by comparison.
  for (const { file, flags } of SHADERS) {
    const statements = parseBlock(wgslDepthOverrideBlock(sources.get(file)));
    const state = executeBlock(statements, {
      "clipPos.z": 0.9,
      "clipPos.w": 1,
      [flags]: 0,
      camDistSq: 4.0e6,
      "camera.minimumDisableDepthTestDistance": 1.0e6,
    });
    assert.equal(
      fragmentOutcome(state["clipPos.z"], 1, "webgpu").depth,
      0,
      `${file}: the frame-wide branch does not reach the near plane`,
    );
  }
});

// ---------------------------------------------------------------------------
// D. Mutants — one per shader, plus a reference-side control.
// ---------------------------------------------------------------------------

/**
 * Makes a condition unreachable the way an inertness mutant does, without
 * deleting it: the branch is still present, still parsed, and never taken.
 *
 * @param {string} source Shader source.
 * @param {string} condition The condition text to disarm.
 * @returns {string} The mutated source.
 */
function disarm(source, condition) {
  assert.ok(
    source.includes(`if (${condition})`),
    `mutant anchor "if (${condition})" not present — the mutant would prove nothing`,
  );
  return source.replace(`if (${condition})`, `if (false && ${condition})`);
}

for (const { file, flags } of SHADERS) {
  const suffix = suffixFor(file);

  test(`D1 ${file} mutant: an inert clip guard is detected`, () => {
    const mutated = disarm(
      sources.get(file),
      `zclip${suffix} >= 0.0 && zclip${suffix} <= 1.0`,
    );
    const problems = outcomeDisagreements(mutated, flags, glslSource);
    assert.ok(
      problems.length > 0,
      `${file}: the clip guard survived its own disarming — section C is not reading it`,
    );
  });

  test(`D2 ${file} mutant: an inert sentinel branch is detected`, () => {
    const mutated = disarm(sources.get(file), `disableRaw${suffix} < 0.0`);
    const problems = outcomeDisagreements(mutated, flags, glslSource);
    assert.ok(
      problems.length > 0,
      `${file}: the sentinel branch survived its own disarming`,
    );
  });

  test(`D5 ${file} mutant: a REMOVED clip guard is detected`, () => {
    // D1 disarms the guard's CONDITION, which makes the whole override block
    // unreachable — the override then never fires and an out-of-volume vertex
    // simply keeps its own z. That is not the mutation a careless refactor
    // produces. THIS one is: keep the override firing, drop the guard. The
    // override is a write, so it now pulls out-of-volume vertices back inside
    // the clip volume and they get drawn. This is the mutation C3's positive-w
    // rows exist to catch, and without it C3's discrimination is unproven.
    const source = sources.get(file);
    const condition = `zclip${suffix} >= 0.0 && zclip${suffix} <= 1.0`;
    assert.ok(
      source.includes(`if (${condition})`),
      `${file}: guard anchor "if (${condition})" not present`,
    );
    const mutated = source.replace(`if (${condition})`, "if (true)");
    const problems = outcomeDisagreements(mutated, flags, glslSource);
    assert.ok(
      problems.length > 0,
      `${file}: removing the clip guard produced no disagreement — the guard is not load-bearing`,
    );
  });

  test(`D3 ${file} mutant: the pre-fix far-plane target is detected`, () => {
    // The exact shape the two pick shaders shipped at 1429.
    const source = sources.get(file);
    const mutated = source
      .split("clipPos.z = 0.0;")
      .join("clipPos.z = clipPos.w;");
    assert.notEqual(mutated, source, `${file}: no near-plane write to mutate`);
    const problems = outcomeDisagreements(mutated, flags, glslSource);
    assert.ok(
      problems.length > 0,
      `${file}: writing the FAR plane produced no disagreement — the law is not being evaluated`,
    );
  });
}

test("D4 reference-side mutant: this spec reads the GLSL, not a copy of the WGSL", () => {
  // Move WebGL's near plane to its far plane. Every shader must now disagree;
  // if any still agrees, section C is comparing WGSL against itself.
  const mutatedGlsl = glslSource.replace(
    "gl_Position.z = -gl_Position.w;",
    "gl_Position.z = gl_Position.w;",
  );
  assert.notEqual(mutatedGlsl, glslSource, "GLSL mutant anchor not found");
  for (const { file, flags } of SHADERS) {
    const problems = outcomeDisagreements(
      sources.get(file),
      flags,
      mutatedGlsl,
    );
    assert.ok(
      problems.length > 0,
      `${file}: agreed with a WebGL reference that writes the far plane`,
    );
  }
});
