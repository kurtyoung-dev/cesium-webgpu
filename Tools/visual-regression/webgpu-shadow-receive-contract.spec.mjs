/**
 * NEW-WEBGPU-GLOBE-SUN-SHADOW-RECEIVE-DEAD — WebGPU sun-shadow cast/receive
 * contract spec.
 * @purpose Pins the sun-shadow fix: single cast-dispatch site + same-frame wipe guard, receive matrix reproduces the cast texel, naga-validated shaders.
 * @status ACTIVE
 *
 * Pure Node (`node --test`). The defect had two independent links, and this
 * spec pins both plus the parity corrections that ride with them:
 *
 *  1. CAST TARGET LIFECYCLE. `WebGPUContext.executeShadowMapCastCommands` was
 *     entered twice per frame — once from the backend-neutral
 *     `SceneRenderer.executeShadowMapCastCommands` (the only site that fills
 *     `ShadowMap.passes[j].commandList`) and again from
 *     `WebGPUSceneRenderer.executeCommands`. The context empties those lists
 *     when it finishes, so the second entry always saw zero casters; once
 *     Batch 775 gave the caster-less branch a transition clear, that entry wiped
 *     the depth the first had just written. Sections A and B pin the single
 *     dispatch site AND the same-frame guard that makes the wipe impossible to
 *     reintroduce.
 *
 *  2. RECEIVE TRANSFORM. `ShadowMap._shadowMapMatrix` already lands in shadow
 *     TEXTURE space (`getViewProjection` folds in the NDC-to-texture scale/bias);
 *     every WebGPU single-map receiver then re-applied the FULL NDC-to-UV remap
 *     on top of it, squeezing every lookup into `u in [0.5, 1]`, `v in [0, 0.5]`.
 *     Section C proves, against the real `Matrix4` / `OrthographicOffCenterFrustum`
 *     / `ClipSpaceConvention` modules, that the shipped
 *     `toWebGPUShadowReceiveMatrix` reproduces the texel the CAST pass wrote —
 *     and that the old double-biased expression does NOT.
 *
 *  3. Sections D/E pin the shader sites and the two WebGL-parity corrections
 *     landed alongside (faded `_darkness`, `outOfView` receive gate).
 *  4. Section F is naga validation of every shader this row touched.
 *
 * Every mutation test re-introduces the exact historical defect and asserts the
 * check REJECTS it, so a check that can only ever pass is caught here.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import Cartesian3 from "../../packages/engine/Source/Core/Cartesian3.js";
import Cartesian4 from "../../packages/engine/Source/Core/Cartesian4.js";
import ClipSpaceConvention from "../../packages/engine/Source/Core/ClipSpaceConvention.js";
import Matrix4 from "../../packages/engine/Source/Core/Matrix4.js";
import OrthographicOffCenterFrustum from "../../packages/engine/Source/Core/OrthographicOffCenterFrustum.js";
import { shouldClearShadowCastTarget } from "../../packages/engine/Source/Renderer/WebGPU/WebGPUShadowCastTargetState.ts";
import { toWebGPUShadowReceiveMatrix } from "../../packages/engine/Source/Renderer/WebGPU/WebGPUShadowReceiveTransform.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

function read(relative) {
  return fs.readFileSync(path.join(root, relative), "utf8");
}

const ENGINE = "packages/engine/Source";
const shadowMapSource = read(`${ENGINE}/Scene/ShadowMap.js`);
const sceneRendererSource = read(`${ENGINE}/Scene/SceneRenderer.js`);
const webgpuSceneRendererSource = read(
  `${ENGINE}/Renderer/WebGPU/WebGPUSceneRenderer.ts`,
);
const webgpuContextSource = read(`${ENGINE}/Renderer/WebGPU/WebGPUContext.ts`);
const shadowMapRendererSource = read(
  `${ENGINE}/Renderer/WebGPU/WebGPUShadowMapRenderer.js`,
);
const csmCastPassSource = read(
  `${ENGINE}/Renderer/WebGPU/WebGPUCSMCastPass.ts`,
);
const effectsBindGroupSource = read(
  `${ENGINE}/Renderer/WebGPU/WebGPUEffectsBindGroup.js`,
);
const globeSurfaceRendererSource = read(
  `${ENGINE}/Renderer/WebGPU/WebGPUGlobeSurfaceRenderer.ts`,
);

const RECEIVER_SHADERS = {
  "Globe/GlobeTerrain.wgsl": read(
    `${ENGINE}/Shaders/WebGPU/Globe/GlobeTerrain.wgsl`,
  ),
  "Model/ModelPBRComplete.wgsl": read(
    `${ENGINE}/Shaders/WebGPU/Model/ModelPBRComplete.wgsl`,
  ),
  "Primitive/PrimitivePhongColor.wgsl": read(
    `${ENGINE}/Shaders/WebGPU/Primitive/PrimitivePhongColor.wgsl`,
  ),
  "Primitive/PrimitivePhongTexturedColor.wgsl": read(
    `${ENGINE}/Shaders/WebGPU/Primitive/PrimitivePhongTexturedColor.wgsl`,
  ),
};

// ─── A. cast-target lifecycle ────────────────────────────────────────────────

// One table, three consumers: the shipped predicate, the pre-fix behavior, and
// a "guard dropped" mutant. Keeping them on one table is what makes the
// mutation test meaningful — the mutant is scored by the SAME rows.
const CLEAR_TABLE = [
  {
    name: "never rendered, no casters -> must clear once",
    state: "uninitialized",
    contentFrame: undefined,
    frame: 12,
    expected: true,
  },
  {
    name: "populated on an EARLIER frame, casters went away -> clears",
    state: "casters",
    contentFrame: 11,
    frame: 12,
    expected: true,
  },
  {
    name: "populated on THIS frame, caster-less re-entry -> must NOT clear",
    state: "casters",
    contentFrame: 12,
    frame: 12,
    expected: false,
  },
  {
    name: "already empty -> never re-clears",
    state: "empty",
    contentFrame: 4,
    frame: 12,
    expected: false,
  },
  {
    name: "already empty and never populated -> never clears",
    state: "empty",
    contentFrame: undefined,
    frame: 12,
    expected: false,
  },
  {
    name: "no frame identity -> falls back to the pre-guard transition clear",
    state: "casters",
    contentFrame: 12,
    frame: undefined,
    expected: true,
  },
];

test("A1: the cast target clears on a real transition and only then", () => {
  for (const row of CLEAR_TABLE) {
    assert.equal(
      shouldClearShadowCastTarget(row.state, row.contentFrame, row.frame),
      row.expected,
      row.name,
    );
  }
});

test("A2 MUTATION: dropping the same-frame guard is rejected by the table", () => {
  // The exact pre-fix predicate: `contentState === "empty"` and nothing else.
  const preFix = (state) => state !== "empty";
  const disagreements = CLEAR_TABLE.filter(
    (row) => preFix(row.state) !== row.expected,
  );
  assert.ok(
    disagreements.length > 0,
    "the table must be able to fail: the pre-fix predicate has to disagree somewhere",
  );
  assert.deepEqual(
    disagreements.map((row) => row.name),
    ["populated on THIS frame, caster-less re-entry -> must NOT clear"],
    "the same-frame re-entry row is the one the pre-fix predicate got wrong — " +
      "if this list grows, the guard changed behavior beyond the defect",
  );
});

test("A3: both cast paths route their caster-less branch through the guard and stamp the frame", () => {
  for (const [label, source] of [
    ["WebGPUShadowMapRenderer.js", shadowMapRendererSource],
    ["WebGPUCSMCastPass.ts", csmCastPassSource],
  ]) {
    assert.match(
      source,
      /shouldClearShadowCastTarget\(/,
      `${label} must consult the shared guard, not an inline state test`,
    );
    assert.doesNotMatch(
      source,
      /(?:cache|host)\._?[Ss]hadowContentState === "empty"/,
      `${label} must not keep a private copy of the clear rule`,
    );
    assert.match(
      source,
      /_?[Ss]hadowContentFrame = frameState\?\.frameNumber/,
      `${label} must stamp the frame it rendered casters on, or the guard is inert`,
    );
  }
});

// ─── B. one dispatch site ────────────────────────────────────────────────────

test("B1: the WebGPU scene renderer no longer dispatches the shadow cast pass", () => {
  assert.doesNotMatch(
    webgpuSceneRendererSource.replace(/\/\/[^\n]*/g, ""),
    /executeShadowMapCastCommands/,
    "a second dispatch collects zero casters (the context empties the per-pass " +
      "lists) and would take the transition-clear branch",
  );
});

test("B2 MUTATION: re-adding the second dispatch fails the B1 check", () => {
  const insertionAnchor = "    const opaqueFrustumNearOffset: number =";
  const mutant = webgpuSceneRendererSource.replace(
    insertionAnchor,
    "if (!config.picking) { context.executeShadowMapCastCommands(scene); }\n" +
      insertionAnchor,
  );
  assert.notEqual(mutant, webgpuSceneRendererSource, "the mutation must apply");
  assert.match(
    mutant.replace(/\/\/[^\n]*/g, ""),
    /executeShadowMapCastCommands/,
    "the B1 check must be able to see a reintroduced dispatch",
  );
});

test("B3: the neutral site fills the per-pass lists BEFORE delegating", () => {
  const populate = sceneRendererSource.indexOf(
    "insertShadowCastCommands(scene, casters, shadowMap)",
  );
  const delegate = sceneRendererSource.indexOf(
    "context.executeShadowMapCastCommands(scene)",
  );
  assert.ok(populate > 0 && delegate > 0);
  assert.ok(
    populate < delegate,
    "the population loop must precede the backend delegate, or WebGPU casts nothing",
  );
});

test("B4: the context still empties the per-pass lists — which is WHY a second dispatch sees nothing", () => {
  assert.match(
    webgpuContextSource,
    /passes\[j\]\.commandList\.length = 0;/,
    "this cleanup is the mechanism behind the defect; if it ever goes away the " +
      "single-dispatch rule needs re-deriving rather than silently relaxing",
  );
});

// ─── C. receive transform, against the real engine math ──────────────────────

// Pinned from `Scene/ShadowMap.js`. `getViewProjection` multiplies this into
// the light view-projection, so a receiver is handed texture space, not NDC.
const SCALE_BIAS_ZERO_TO_ONE = new Matrix4(
  0.5,
  0.0,
  0.0,
  0.5,
  0.0,
  0.5,
  0.0,
  0.5,
  0.0,
  0.0,
  1.0,
  0.0,
  0.0,
  0.0,
  0.0,
  1.0,
);

test("C0: the pinned scale/bias is the one ShadowMap actually applies", () => {
  const declaration = shadowMapSource.slice(
    shadowMapSource.indexOf("const scaleBiasZeroToOneMatrix = new Matrix4("),
  );
  const numbers = declaration
    .slice(0, declaration.indexOf(");"))
    .match(/-?\d+\.\d+/g)
    .map(Number);
  assert.equal(numbers.length, 16);
  for (let i = 0; i < 16; i++) {
    // Cesium's Matrix4 constructor takes ROW-major arguments.
    const row = Math.floor(i / 4);
    const column = i % 4;
    assert.equal(
      numbers[i],
      SCALE_BIAS_ZERO_TO_ONE[column * 4 + row],
      `scaleBiasZeroToOneMatrix element ${i} drifted from the pin`,
    );
  }
  assert.match(
    shadowMapSource,
    /depthRangeZeroToOne\s*\?\s*scaleBiasZeroToOneMatrix/,
    "the WebGPU convention must still select the zero-to-one scale/bias",
  );
});

function orthonormalBasis(directionRaw, upHint) {
  const direction = Cartesian3.normalize(directionRaw, new Cartesian3());
  const right = Cartesian3.normalize(
    Cartesian3.cross(direction, upHint, new Cartesian3()),
    new Cartesian3(),
  );
  const up = Cartesian3.cross(right, direction, new Cartesian3());
  return { direction, right, up };
}

function buildScene() {
  const lightPosition = new Cartesian3(1200.0, -800.0, 2600.0);
  const lightBasis = orthonormalBasis(
    new Cartesian3(-0.4, 0.3, -1.0),
    Cartesian3.UNIT_Z,
  );
  const lightView = Matrix4.computeView(
    lightPosition,
    lightBasis.direction,
    lightBasis.up,
    lightBasis.right,
    new Matrix4(),
  );

  const frustum = new OrthographicOffCenterFrustum({
    left: -640.0,
    right: 640.0,
    bottom: -480.0,
    top: 480.0,
    near: 1.0,
    far: 6000.0,
  });
  const projection = Matrix4.clone(
    frustum.getProjectionMatrix(ClipSpaceConvention.WEBGPU),
    new Matrix4(),
  );

  const cameraPosition = new Cartesian3(-300.0, 500.0, 3100.0);
  const cameraBasis = orthonormalBasis(
    new Cartesian3(0.1, -0.2, -1.0),
    Cartesian3.UNIT_Y,
  );
  const sceneView = Matrix4.computeView(
    cameraPosition,
    cameraBasis.direction,
    cameraBasis.up,
    cameraBasis.right,
    new Matrix4(),
  );

  // Exactly what `ShadowMap.update` publishes:
  //   _shadowMapMatrix = scaleBias * projection * lightView * inverse(sceneView)
  const lightViewProjection = Matrix4.multiply(
    projection,
    lightView,
    new Matrix4(),
  );
  const biased = Matrix4.multiply(
    SCALE_BIAS_ZERO_TO_ONE,
    lightViewProjection,
    new Matrix4(),
  );
  const shadowMapMatrix = Matrix4.multiply(
    biased,
    Matrix4.inverse(sceneView, new Matrix4()),
    new Matrix4(),
  );

  return { projection, lightView, sceneView, shadowMapMatrix };
}

function project(matrix, point) {
  const clip = Matrix4.multiplyByVector(
    matrix,
    new Cartesian4(point.x, point.y, point.z, 1.0),
    new Cartesian4(),
  );
  return { x: clip.x / clip.w, y: clip.y / clip.w, z: clip.z / clip.w };
}

// Points chosen in LIGHT VIEW space so every sample is inside the light
// frustum, then pushed out to world and into eye space.
const LIGHT_VIEW_SAMPLES = [
  { x: 0.0, y: 0.0, z: -2000.0 },
  { x: -600.0, y: 440.0, z: -300.0 },
  { x: 600.0, y: -440.0, z: -5500.0 },
  { x: 250.0, y: 120.0, z: -1200.0 },
  { x: -430.0, y: -300.0, z: -4000.0 },
];

function sampleTable() {
  const { projection, lightView, sceneView, shadowMapMatrix } = buildScene();
  const inverseLightView = Matrix4.inverse(lightView, new Matrix4());
  const flipped = toWebGPUShadowReceiveMatrix(shadowMapMatrix, new Matrix4());

  return LIGHT_VIEW_SAMPLES.map((viewPoint) => {
    // What the CAST pass writes: raw clip -> WebGPU viewport -> texel.
    const ndc = project(projection, viewPoint);
    const castTexel = {
      u: ndc.x * 0.5 + 0.5,
      v: 0.5 - ndc.y * 0.5, // WebGPU: NDC +y is framebuffer row 0, i.e. v = 0
      depth: ndc.z,
    };

    const world = Matrix4.multiplyByPoint(
      inverseLightView,
      new Cartesian3(viewPoint.x, viewPoint.y, viewPoint.z),
      new Cartesian3(),
    );
    const eye = Matrix4.multiplyByPoint(sceneView, world, new Cartesian3());

    return {
      castTexel,
      preFlip: project(shadowMapMatrix, eye),
      shipped: project(flipped, eye),
    };
  });
}

test("C1: the shipped receive matrix reproduces the texel the cast pass wrote", () => {
  for (const sample of sampleTable()) {
    // Sanity: the sample really is inside the map, so a disagreement below is
    // about the transform and not about an out-of-bounds point.
    assert.ok(
      sample.castTexel.u >= 0 &&
        sample.castTexel.u <= 1 &&
        sample.castTexel.v >= 0 &&
        sample.castTexel.v <= 1 &&
        sample.castTexel.depth >= 0 &&
        sample.castTexel.depth <= 1,
      "sample must land inside the shadow map",
    );
    assert.ok(
      Math.abs(sample.shipped.x - sample.castTexel.u) < 1e-9,
      `u ${sample.shipped.x} != ${sample.castTexel.u}`,
    );
    assert.ok(
      Math.abs(sample.shipped.y - sample.castTexel.v) < 1e-9,
      `v ${sample.shipped.y} != ${sample.castTexel.v}`,
    );
    assert.ok(
      Math.abs(sample.shipped.z - sample.castTexel.depth) < 1e-9,
      `depth ${sample.shipped.z} != ${sample.castTexel.depth}`,
    );
  }
});

test("C2 MUTATION: the historical double-biased shader expression misses the texel", () => {
  let worstU = 0;
  let worstV = 0;
  for (const sample of sampleTable()) {
    // Exactly the removed WGSL:
    //   uv = vec2(coord.x * 0.5 + 0.5, 1.0 - (coord.y * 0.5 + 0.5))
    // applied to the pre-flip (already scale-biased) coordinate.
    const doubleBiased = {
      u: sample.preFlip.x * 0.5 + 0.5,
      v: 1.0 - (sample.preFlip.y * 0.5 + 0.5),
    };
    // The defect's signature: every lookup collapses into one quadrant.
    assert.ok(
      doubleBiased.u >= 0.5 - 1e-12 && doubleBiased.v <= 0.5 + 1e-12,
      "the double bias must land in u >= 0.5, v <= 0.5 — that IS the defect",
    );
    worstU = Math.max(worstU, Math.abs(doubleBiased.u - sample.castTexel.u));
    worstV = Math.max(worstV, Math.abs(doubleBiased.v - sample.castTexel.v));
  }
  assert.ok(
    worstU > 0.1 || worstV > 0.1,
    `the old expression must miss by a wide margin; got du=${worstU} dv=${worstV}`,
  );
});

test("C3 MUTATION: dropping the v flip (or flipping u instead) also misses", () => {
  const samples = sampleTable();
  let worstNoFlip = 0;
  for (const sample of samples) {
    worstNoFlip = Math.max(
      worstNoFlip,
      Math.abs(sample.preFlip.y - sample.castTexel.v),
    );
  }
  assert.ok(
    worstNoFlip > 0.1,
    `the flip is load-bearing, not cosmetic; got dv=${worstNoFlip}`,
  );
  // u must be untouched by the flip — a matrix that flipped the wrong axis
  // would still satisfy "something changed".
  for (const sample of samples) {
    assert.ok(Math.abs(sample.preFlip.x - sample.shipped.x) < 1e-12);
  }
});

test("C4: the conversion is cached per shadow map, not on one module scratch", () => {
  assert.match(
    shadowMapRendererSource,
    /cache\.webgpuReceiveMatrix \?\?= new Matrix4\(\)/,
    "a shared module-level scratch would alias between concurrent shadow maps",
  );
  assert.match(
    shadowMapRendererSource,
    /toWebGPUShadowReceiveMatrix\(\s*shadowMap\._shadowMapMatrix/,
  );
});

// ─── D. the four inlined receivers ───────────────────────────────────────────

test("D1: every single-shadow-map receiver samples the matrix output directly", () => {
  for (const [name, source] of Object.entries(RECEIVER_SHADERS)) {
    const index = source.indexOf("effects.shadowMatrix * vec4<f32>(");
    assert.ok(index > 0, `${name} must still have a single-map receive path`);
    const body = source.slice(index, index + 900);
    assert.match(
      body,
      /let uv = coord\.xy;/,
      `${name} must consume the CPU-converted texture coordinate`,
    );
    assert.doesNotMatch(
      body,
      /coord\.x \* 0\.5 \+ 0\.5/,
      `${name} must not re-apply the NDC-to-UV remap on an already-biased coord`,
    );
  }
});

test("D2 MUTATION: restoring the double bias in a receiver fails the D1 check", () => {
  const mutant = RECEIVER_SHADERS["Globe/GlobeTerrain.wgsl"].replace(
    "let uv = coord.xy;",
    "let uv = vec2<f32>(coord.x * 0.5 + 0.5, 1.0 - (coord.y * 0.5 + 0.5));",
  );
  const index = mutant.indexOf("effects.shadowMatrix * vec4<f32>(");
  const body = mutant.slice(index, index + 900);
  assert.doesNotMatch(body, /let uv = coord\.xy;/);
  assert.match(body, /coord\.x \* 0\.5 \+ 0\.5/);
});

// The chunk LIBRARY copy of the same receiver. `WebGPUShadowReceiveTransform.ts`
// claims the convention now lives "in one tested place ... and cannot drift" —
// but D1 only reads the four INLINED copies, and this is the fifth reader of
// `EffectsUniforms.shadowMatrix`. It is currently unreached (no `@chunk
// csm_effects` marker exists, so `injectChunks` never prepends it) and must NOT
// be deleted (Principle 7); the risk is that whoever wires it inherits the
// pre-Batch-849 double bias while the docstring promises drift is impossible.
const CSM_EFFECTS_CHUNK = `${ENGINE}/Shaders/WebGPU/chunks/functions/csm_effects.wgsl`;
const EFFECTS_UNIFORMS_CHUNK = `${ENGINE}/Shaders/WebGPU/chunks/structs/EffectsUniforms.wgsl`;

// The two statements that ARE the convention: the perspective divide and what
// the sampler is handed. Line endings are normalised because this repository
// checks these files out with CRLF on Windows; the assertion is about code
// shape, never about which terminator the working tree happens to carry.
function receiveConvention(rawSource, label) {
  const source = rawSource.replace(/\r\n/g, "\n");
  const anchor = source.indexOf("effects.shadowMatrix * vec4<f32>(");
  assert.ok(anchor > 0, `${label} must have a single-map receive path`);
  const statements = source
    .slice(source.indexOf("\n", anchor) + 1)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("//"))
    .slice(0, 2);
  assert.equal(statements.length, 2, `${label} receive body must be readable`);
  return statements;
}

test("D4: the chunk-library receiver carries the SAME convention as the inlined ones", () => {
  const chunk = receiveConvention(read(CSM_EFFECTS_CHUNK), "csm_effects.wgsl");
  assert.deepEqual(
    chunk,
    ["let coord = shadowPos.xyz / shadowPos.w;", "let uv = coord.xy;"],
    "the chunk must consume the CPU-converted texture coordinate directly",
  );
  // Held against the inlined copies rather than against a literal alone, so the
  // day the convention legitimately changes this fails as ONE fact, not five.
  for (const [name, source] of Object.entries(RECEIVER_SHADERS)) {
    assert.deepEqual(
      chunk,
      receiveConvention(source, name),
      `csm_effects.wgsl drifted from ${name}`,
    );
  }
  // The struct comment beside it is part of the contract: a reader wiring the
  // chunk consults the field's own documentation before the transform module.
  assert.match(
    read(EFFECTS_UNIFORMS_CHUNK).replace(/\r\n/g, "\n"),
    /shadow-TEXTURE space, not NDC/,
    "EffectsUniforms.shadowMatrix must not still be documented as NDC",
  );
});

test("D5 MUTATION: restoring the chunk's double bias fails the D4 check", () => {
  const mutant = read(CSM_EFFECTS_CHUNK)
    .replace(/\r\n/g, "\n")
    .replace(
      "let coord = shadowPos.xyz / shadowPos.w;\n  let uv = coord.xy;",
      "let shadowCoord = shadowPos.xyz / shadowPos.w;\n" +
        "  let uv = shadowCoord.xy * 0.5 + 0.5;",
    );
  assert.notEqual(
    mutant,
    read(CSM_EFFECTS_CHUNK).replace(/\r\n/g, "\n"),
    "the mutation must actually apply",
  );
  const mutantConvention = receiveConvention(mutant, "csm_effects mutant");
  assert.throws(() =>
    assert.deepEqual(mutantConvention, [
      "let coord = shadowPos.xyz / shadowPos.w;",
      "let uv = coord.xy;",
    ]),
  );
  // And it must disagree with each shipped inlined receiver, which is the form
  // the check actually takes.
  for (const [name, source] of Object.entries(RECEIVER_SHADERS)) {
    assert.throws(
      () => assert.deepEqual(mutantConvention, receiveConvention(source, name)),
      `the D4 check must be able to see the double bias against ${name}`,
    );
  }
});

test("D3: the CASCADED path keeps its full remap — it is handed raw clip space", () => {
  const globe = RECEIVER_SHADERS["Globe/GlobeTerrain.wgsl"];
  const index = globe.indexOf("fn sampleOneCascade(");
  assert.ok(index > 0);
  const body = globe.slice(index, index + 1400);
  assert.match(
    body,
    /let uv = vec2<f32>\(ndc\.x \* 0\.5 \+ 0\.5, 1\.0 - \(ndc\.y \* 0\.5 \+ 0\.5\)\);/,
    "a blanket search-and-replace of the remap would silently break CSM, which " +
      "is the one WebGPU shadow path that measurably worked",
  );
});

// ─── E. the two parity corrections that ride along ───────────────────────────

test("E1: WebGPU receive reads the FADED darkness, as WebGL's uniform does", () => {
  assert.match(
    shadowMapSource,
    /shadowMap_normalOffsetScaleDistanceMaxDistanceAndDarkness[\s\S]{0,400}shadowMap\._darkness/,
    "WebGL's receive uniform is the oracle for this field",
  );
  for (const [label, source] of [
    ["WebGPUShadowMapRenderer.js", shadowMapRendererSource],
    ["WebGPUEffectsBindGroup.js", effectsBindGroupSource],
  ]) {
    assert.match(
      source,
      /darkness: shadowMap\._darkness \?\? shadowMap\.darkness \?\? 0\.3/,
      `${label} must prefer the faded value`,
    );
    assert.doesNotMatch(
      source,
      /darkness: shadowMap\.darkness \?\? 0\.3/,
      `${label} must not read the public unfaded property directly`,
    );
  }
});

test("E2: the globe receive gate honors outOfView, like the cast dispatch does", () => {
  assert.match(
    globeSurfaceRendererSource,
    /candidateShadowMap\.outOfView !== true/,
    "an out-of-view map is not cast this frame; sampling it darkens the night " +
      "side from a stale day-lit depth target",
  );
  assert.match(
    webgpuContextSource,
    /if \(shadowMap\.outOfView\) \{\s*continue;/,
    "the cast side's outOfView skip is the parity reference for the gate above",
  );
});

// ─── F. naga ─────────────────────────────────────────────────────────────────

test("F1: every shader this row touched passes naga validation", async () => {
  const nagaDirectory = path.join(
    root,
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

  // `WebGPUModelPipelineCache` prepends the clustered-lighting chunk (with the
  // effects group token resolved to 3) before compiling ModelPBRComplete, so
  // the compiled unit here is the same composition.
  const groupToken = read(
    `${ENGINE}/Renderer/WebGPU/WebGPUClusteredLightingBGL.ts`,
  ).match(/CLUSTERED_LIGHTING_GROUP_TOKEN = "([^"]+)"/)[1];
  const clusteredLightingChunk = read(
    `${ENGINE}/Shaders/WebGPU/chunks/structs/ClusteredLighting.wgsl`,
  )
    .split(groupToken)
    .join("3");

  // `WebGPUPrimitiveShaders.injectChunks` prepends a chunk when the shader
  // carries its `@chunk` marker comment; mirror that so the compiled unit here
  // is the one the renderer actually hands to the device.
  const markerChunks = [
    [
      /^\s*\/\/.*@chunk\s+csm_samplePointShadow\b/m,
      read(
        `${ENGINE}/Shaders/WebGPU/chunks/functions/csm_samplePointShadow.wgsl`,
      ),
    ],
  ];

  for (const [name, source] of Object.entries(RECEIVER_SHADERS)) {
    let unit = expandZeroDefines(source);
    for (const [marker, chunk] of markerChunks) {
      if (marker.test(unit)) {
        unit = `${chunk}\n${unit}`;
      }
    }
    // `WebGPUModelPipelineCache` / `WebGPUPrimitiveCommands` both prepend the
    // clustered-lighting chunk (with the effects group resolved to 3) to any
    // shader that calls into it.
    if (/evalClusteredLights\(/.test(unit)) {
      unit = `${clusteredLightingChunk}\n${unit}`;
    }
    assert.doesNotThrow(
      () => naga.validate_wgsl(unit),
      `${name} must validate at defines = 0`,
    );
  }

  // The chunk-library receiver (D4) is edited by this row too, and nothing
  // else compiles it — its struct companion plus the chunk is exactly the unit
  // an `injectChunks` wiring would produce.
  assert.doesNotThrow(
    () =>
      naga.validate_wgsl(
        `${read(EFFECTS_UNIFORMS_CHUNK)}\n${read(CSM_EFFECTS_CHUNK)}`,
      ),
    "csm_effects.wgsl must validate against its own EffectsUniforms struct",
  );
});

function expandZeroDefines(source) {
  const out = [];
  const stack = [];
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("//>>ifdef")) {
      stack.push({ emitting: false });
      continue;
    }
    if (trimmed === "//>>else") {
      stack[stack.length - 1].emitting = true;
      continue;
    }
    if (trimmed === "//>>endif") {
      stack.pop();
      continue;
    }
    if (stack.every((frame) => frame.emitting)) {
      out.push(line);
    }
  }
  return out.join("\n");
}
