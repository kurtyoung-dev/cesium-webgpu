// @purpose Contracts over WebGPU point-cloud RTE history, shared layouts and the EDL state machinery (slot/stencil/pipeline-key correctness surface).
// @status ACTIVE

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";

import BoundingSphere from "../../packages/engine/Source/Core/BoundingSphere.js";
import Cartesian3 from "../../packages/engine/Source/Core/Cartesian3.js";
import Cartesian4 from "../../packages/engine/Source/Core/Cartesian4.js";
import EncodedCartesian3 from "../../packages/engine/Source/Core/EncodedCartesian3.js";
import Matrix3 from "../../packages/engine/Source/Core/Matrix3.js";
import Matrix4 from "../../packages/engine/Source/Core/Matrix4.js";
import {
  createPointCloudRteHistory,
  updatePointCloudRteHistory,
} from "../../packages/engine/Source/Renderer/WebGPU/WebGPUPointCloudRteHistory.js";
import { getWebGPUPointCloudSharedLayouts } from "../../packages/engine/Source/Renderer/WebGPU/WebGPUPointCloudSharedLayouts.js";
import {
  POINT_CLOUD_EDL_TILE_STENCIL_MASK,
  POINT_CLOUD_EDL_UNIFORM_SLOT_BYTES,
  acquireWebGPUPointCloudEDLUniformSlice,
  beginWebGPUPointCloudEDLCandidateFrame,
  beginWebGPUPointCloudEDLProcessorUpdate,
  createWebGPUPointCloudEDLCompositeDepthStencilState,
  findNextWebGPUPointCloudEDLProcessor,
  getWebGPUPointCloudEDLBlendPipelineKey,
  hasCurrentWebGPUPointCloudEDLCandidate,
  interceptWebGPUPointCloudEDLCommand,
  isWebGPUPointCloudEDLCacheCurrent,
  isWebGPUPointCloudEDLMetadataForSlice,
  markWebGPUPointCloudEDLCandidate,
  releaseWebGPUPointCloudEDLOwner,
  restoreWebGPUPointCloudEDLCommand,
  shouldReleaseWebGPUPointCloudEDLTargets,
  withWebGPUPointCloudEDLFailOpen,
} from "../../packages/engine/Source/Renderer/WebGPU/WebGPUPointCloudEDLState.js";
import { updatePointCloudLodLocalFrame } from "../../packages/engine/Source/Renderer/WebGPU/WebGPUPointCloudLodLocalFrame.js";
import { unpackPointCloudColor } from "../../packages/engine/Source/Scene/PointCloudAttributeUtils.js";

globalThis.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const read = (relativePath) =>
  readFileSync(path.join(ROOT, relativePath), "utf8");

// Lift the REAL WGSL selection functions out of a shader and execute them.
//
// Every operative token — the far-cull predicate, the ratio thresholds, the
// decimation masks and the keep guard — is transliterated from the shader text
// rather than restated here. A model written out a second time in JS keeps
// agreeing with the brief long after the shader has stopped agreeing with it,
// which is how an `if (false && …)` edit to the cull can leave a suite green.
// Because this reads the file, that edit changes what the oracle computes.
//
// Fails CLOSED: anything the rewrite rules cannot express is left as WGSL and
// then caught by the residue check, so an unhandled construct throws instead of
// quietly evaluating to something else.
const WGSL_RUNTIME = `
  const V3 = (a, b, c) => [a, b, c];
  const SUB = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const DOT = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const LEN = (v) => Math.hypot(v[0], v[1], v[2]);
`;

function extractWgslFn(source, name) {
  const start = source.indexOf(`fn ${name}(`);
  assert.ok(start >= 0, `fn ${name} is absent from the shader`);
  const open = source.indexOf("{", start);
  assert.ok(open > start, `fn ${name} has no body`);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0)
      return source.slice(start, i + 1);
  }
  throw new Error(`fn ${name} is unbalanced`);
}

function transliterateWgsl(wgsl) {
  let out = wgsl.replace(/\/\/[^\n]*/g, "");
  out = out.replace(
    /^fn\s+(\w+)\s*\(([^)]*)\)\s*->\s*[\w<>0-9]+\s*\{/m,
    (_match, name, args) =>
      `function ${name}(${args
        .split(",")
        .map((arg) => arg.trim())
        .filter(Boolean)
        .map((arg) => arg.split(":")[0].trim())
        .join(", ")}) {`,
  );
  out = out.replace(/vec3<f32>\s*\(/g, "V3(");
  out = out.replace(/\bparams\./g, "P.");
  out = out.replace(/\.xyz\b/g, ".slice(0, 3)");
  out = out.replace(/\blet\s+/g, "const ");
  out = out.replace(/\bvar\s+/g, "let ");
  out = out.replace(/\bdot\s*\(/g, "DOT(");
  out = out.replace(/\blength\s*\(/g, "LEN(");
  out = out.replace(/\bmax\s*\(/g, "Math.max(");
  out = out.replace(/\bmin\s*\(/g, "Math.min(");
  out = out.replace(/(\w+)\s*-\s*(P\.\w+)/g, "SUB($1, $2)");
  out = out.replace(/\b(\d+)u\b/g, "$1");
  out = out.replace(/([^=!<>])==([^=])/g, "$1===$2");
  out = out.replace(/!=([^=])/g, "!==$1");
  return out;
}

function assertNoWgslResidue(label, generated) {
  for (const residue of [
    /vec[234]</,
    /:\s*f32\b/,
    /:\s*u32\b/,
    /\bfn\s/,
    /\d+u\b/,
  ]) {
    assert.doesNotMatch(
      generated,
      residue,
      `${label}: the transliteration left WGSL the rules cannot express — extend them rather than trusting this oracle`,
    );
  }
}

function buildWgslLodOracle(label, source) {
  const bodies = [
    "worldCameraDistance",
    "projectedSpacing",
    "selectLOD",
    "shouldKeepAtLOD",
  ]
    .map((name) => transliterateWgsl(extractWgslFn(source, name)))
    .join("\n\n");

  // The keep guard is read out of the entry points, not restated, and every
  // entry point must agree — a per-site divergence is the defect that let far
  // points render through one dispatch path while the other culled them.
  const guards = [
    ...source.matchAll(/if \(([^)]*lodLevel[^)]*shouldKeepAtLOD\([^)]*\))\)/g),
  ].map((match) => transliterateWgsl(match[1]));
  assert.ok(guards.length > 0, `${label}: no keep guard found`);
  const distinctGuards = [...new Set(guards)];
  assert.equal(
    distinctGuards.length,
    1,
    `${label}: keep guards disagree between entry points: ${JSON.stringify(distinctGuards)}`,
  );

  const generated = `${bodies}\n${distinctGuards[0]}`;
  assertNoWgslResidue(label, generated);

  // `params` is a module-scope uniform in WGSL; mirror that binding.
  const context = { Math, globalThis: undefined };
  context.globalThis = context;
  runInNewContext(
    `${WGSL_RUNTIME}\nlet P;\n${bodies}\nglobalThis.__run = (uniforms, pos, pointIndex) => {\n  P = uniforms;\n  const lodLevel = selectLOD(pos);\n  return { lodLevel, keep: ${distinctGuards[0]} };\n};`,
    context,
  );
  return {
    run: context.__run,
    guardText: distinctGuards[0],
    guardSites: guards.length,
  };
}

// Identity model-linear rows, so a local delta IS the world delta and the
// distance the shader compares against `lodFarDistance` is the x coordinate.
const lodOracleUniforms = (lodFarDistance) => ({
  cameraPositionLocal: [0, 0, 0],
  projectionScale: 100,
  targetPixelSpacing: 1,
  geometricError: 2,
  lodFarDistance,
  modelLinear0: [1, 0, 0, 0],
  modelLinear1: [0, 1, 0, 0],
  modelLinear2: [0, 0, 1, 0],
});

test("point-cloud CPU descriptor decodes RGB, RGBA, RGB565, and CONSTANT_RGBA", () => {
  const result = new Float32Array(4);

  assert.equal(
    unpackPointCloudColor(
      {
        colors: new Uint8Array([255, 128, 0]),
        componentCount: 3,
        colorsAreBytes: true,
        isRGB565: false,
        constantColor: { red: 0, green: 0, blue: 0, alpha: 0 },
      },
      0,
      result,
    ),
    result,
    "the decoder must reuse caller storage rather than allocate per point",
  );
  assert.deepEqual(
    Array.from(result),
    Array.from(new Float32Array([1, 128 / 255, 0, 1])),
  );

  unpackPointCloudColor(
    {
      colors: new Uint8Array([10, 20, 30, 64]),
      componentCount: 4,
      colorsAreBytes: true,
      isRGB565: false,
      constantColor: { red: 0, green: 0, blue: 0, alpha: 0 },
    },
    0,
    result,
  );
  assert.deepEqual(
    Array.from(result),
    Array.from(new Float32Array([10 / 255, 20 / 255, 30 / 255, 64 / 255])),
  );

  unpackPointCloudColor(
    {
      colors: new Uint16Array([0xffff]),
      componentCount: 1,
      colorsAreBytes: false,
      isRGB565: true,
      constantColor: { red: 0, green: 0, blue: 0, alpha: 0 },
    },
    0,
    result,
  );
  assert.deepEqual(Array.from(result), [31 / 32, 63 / 64, 31 / 32, 1]);

  unpackPointCloudColor(
    {
      colors: undefined,
      componentCount: 4,
      colorsAreBytes: false,
      isRGB565: false,
      constantColor: { red: 0.1, green: 0.2, blue: 0.3, alpha: 0.4 },
    },
    0,
    result,
  );
  assert.deepEqual(
    Array.from(result),
    Array.from(new Float32Array([0.1, 0.2, 0.3, 0.4])),
  );
});

test("Draco decode is a shared CPU stage before point-cloud backend realization", () => {
  const source = read("packages/engine/Source/Scene/PointCloud.js");
  const updateStart = source.indexOf("update(frameState)");
  const decode = source.indexOf(
    "const decoding = decodeDraco(this);",
    updateStart,
  );
  const dispatch = source.indexOf(
    'const fr = readiness.kind === "ready"',
    updateStart,
  );
  assert.ok(updateStart >= 0 && decode > updateStart && dispatch > decode);
  assert.match(source, /isQuantized:\s*isQuantizedDraco/);
  assert.match(source, /componentCount:\s*defined\(decodedRgba\) \? 4 : 3/);
  assert.doesNotMatch(source, /decodeDraco\(this, context\)/);
});

test("WebGPU point-cloud alpha owns the fourth record lane and controls depth/pass", () => {
  const source = read(
    "packages/engine/Source/Renderer/WebGPU/WebGPUPointCloudRenderer.ts",
  );
  const edl = read(
    "packages/engine/Source/Shaders/WebGPU/PointCloud/PointCloudEDLDepth.wgsl",
  );

  assert.match(source, /data\[off \+ 9\] = decodedColor\[3\]/);
  const optionsDeclaration = source.indexOf("const colorDecodeOptions = {");
  const pointLoop = source.indexOf("for (let i = 0; i < pointCount; i++)");
  assert.ok(
    optionsDeclaration >= 0 && optionsDeclaration < pointLoop,
    "color decode options must be allocated once, outside the point loop",
  );
  assert.match(
    source,
    /unpackPointCloudColor\(colorDecodeOptions, i, decodedColor\)/,
  );
  assert.match(source, /var pointSize = u\.pointSizeMultiplier;/);
  assert.doesNotMatch(source, /data\[off \+ 9\].*_webgpuPointSize/);
  assert.equal(
    (source.match(/depthWriteEnabled:\s*!translucent/g) ?? []).length,
    2,
    "default and LOD pipelines must both gate depth writes on translucency",
  );
  assert.match(source, /Pass\.TRANSLUCENT/);
  assert.match(source, /cache\.translucent !== translucent/);
  assert.equal(
    (source.match(/translucent \? \{ translucent: true \} : \{\}/g) ?? [])
      .length,
    2,
    "default and LOD opaque pipelines must omit blend state",
  );
  assert.doesNotMatch(source, /blend:\s*\{/);
  assert.match(
    source,
    /cache\.command = null;[\s\S]*cache\.lodCommand = null;[\s\S]*cache\.lodPipeline = null;/,
    "opacity changes must rebuild both default and LOD commands/pipelines",
  );
  assert.match(source, /highlightColor:\s*vec4<f32>/);
  assert.match(edl, /colorAndAlpha:\s*vec4<f32>/);
  assert.match(
    edl,
    /output\.color = input\.colorAndAlpha \* u\.highlightColor/,
  );
});

test("unsupported style color does not silently change the WebGPU pass", () => {
  const pointCloud = read("packages/engine/Source/Scene/PointCloud.js");
  const renderer = read(
    "packages/engine/Source/Renderer/WebGPU/WebGPUPointCloudRenderer.ts",
  );

  assert.match(pointCloud, /const activeStyle = this\.style;/);
  assert.doesNotMatch(
    pointCloud,
    /const activeStyle = this\.style \?\? this\._style/,
  );
  assert.match(
    pointCloud,
    /if \(this\._style !== activeStyle \|\| this\.styleDirty\) \{[\s\S]*?this\._style = activeStyle;[\s\S]*?this\.styleDirty = false;/,
    "style assignment/clearing must still advance the public lifecycle",
  );
  assert.equal(
    (pointCloud.match(/activeStyle\.pointSize\.evaluate/g) ?? []).length,
    1,
    "constant pointSize evaluation must live only in the style dirty branch",
  );
  assert.match(
    pointCloud,
    /this\._webgpuStylePointSize = stylePointSize;[\s\S]*?this\._webgpuStylePointSizeActive = defined\(stylePointSize\)/,
  );
  assert.doesNotMatch(pointCloud, /function updateWebGPUStyleTranslucency/);
  assert.doesNotMatch(
    renderer,
    /_styleTranslucent/,
    "a style color this renderer does not realize must not alter pass/depth",
  );
});

test("point-cloud velocity uses frame-safe previous RTE snapshots at Earth scale", () => {
  const source = read(
    "packages/engine/Source/Renderer/WebGPU/WebGPUPointCloudRenderer.ts",
  );
  const buildStart = source.indexOf("function buildInstanceBuffer");
  const pointLoop = source.indexOf(
    "for (let i = 0; i < pointCount; i++)",
    buildStart,
  );
  const encode = source.indexOf(
    "EncodedCartesian3.fromCartesian(srcPosScratch, scratchEncoded)",
    pointLoop,
  );
  const localSoa = source.indexOf("localX[i] = sx", encode);
  assert.ok(
    buildStart >= 0 &&
      pointLoop > buildStart &&
      encode > pointLoop &&
      localSoa > encode,
    "draw records and immutable LOD SOA must use the same local coordinates",
  );
  const buildEnd = source.indexOf("function packUniforms", buildStart);
  assert.doesNotMatch(
    source.slice(buildStart, buildEnd),
    /Matrix4\.multiplyByPoint\(modelMatrix/,
    "model motion must never rebuild Earth-scale f32 point buffers",
  );
  assert.equal(
    (
      source.match(/u\.previousMvpRelativeToEye \* vec4<f32>\(prevPosRTE/g) ??
      []
    ).length,
    2,
    "default and LOD velocity shaders must consume the previous RTE snapshot",
  );
  assert.equal((source.match(/let prevPosRTE =/g) ?? []).length, 2);
  assert.doesNotMatch(
    source,
    /prevWorldPos|prevModelPos|u\.prevViewProjection|u\.modelMatrix \* prev/,
    "negative mutants must not reconstruct absolute f32 world positions or use the current model",
  );
  assert.match(source, /updatePointCloudRteHistory\(/);
  assert.match(source, /size: 304/);

  const projection = Matrix4.computePerspectiveFieldOfView(
    Math.PI / 3,
    1.25,
    0.1,
    1.0e7,
    new Matrix4(),
  );
  const makeModel = (angle, translation) =>
    Matrix4.fromRotationTranslation(
      Matrix3.fromRotationZ(angle, new Matrix3()),
      translation,
      new Matrix4(),
    );
  const makeView = (camera) =>
    Matrix4.fromTranslation(
      Cartesian3.negate(camera, new Cartesian3()),
      new Matrix4(),
    );
  const shaderClip = (snapshot, localPoint) => {
    const encoded = {
      high: new Cartesian3(),
      low: new Cartesian3(),
    };
    EncodedCartesian3.fromCartesian(localPoint, encoded);
    const component = (high, cameraHigh, low, cameraLow) =>
      Math.fround(
        Math.fround(high - cameraHigh) + Math.fround(low - cameraLow),
      );
    const relative = new Cartesian4(
      component(
        encoded.high.x,
        snapshot.encodedCameraHigh.x,
        encoded.low.x,
        snapshot.encodedCameraLow.x,
      ),
      component(
        encoded.high.y,
        snapshot.encodedCameraHigh.y,
        encoded.low.y,
        snapshot.encodedCameraLow.y,
      ),
      component(
        encoded.high.z,
        snapshot.encodedCameraHigh.z,
        encoded.low.z,
        snapshot.encodedCameraLow.z,
      ),
      1.0,
    );
    const gpuMatrix = Matrix4.clone(snapshot.mvpRelativeToEye, new Matrix4());
    for (let i = 0; i < 16; i++) {
      gpuMatrix[i] = Math.fround(gpuMatrix[i]);
    }
    return Matrix4.multiplyByVector(gpuMatrix, relative, new Cartesian4());
  };
  const referenceClip = (view, model, localPoint) => {
    const world = Matrix4.multiplyByPoint(model, localPoint, new Cartesian3());
    const eye = Matrix4.multiplyByVector(
      view,
      new Cartesian4(world.x, world.y, world.z, 1.0),
      new Cartesian4(),
    );
    return Matrix4.multiplyByVector(projection, eye, new Cartesian4());
  };
  const ndc = (clip) => [clip.x / clip.w, clip.y / clip.w];
  const assertNdcClose = (actualClip, expectedClip, epsilon = 2.0e-5) => {
    const actual = ndc(actualClip);
    const expected = ndc(expectedClip);
    assert.ok(Number.isFinite(actual[0]) && Number.isFinite(actual[1]));
    assert.ok(Math.abs(actual[0] - expected[0]) <= epsilon);
    assert.ok(Math.abs(actual[1] - expected[1]) <= epsilon);
  };

  const localPoint = new Cartesian3(20, -15, -500);
  const translation0 = new Cartesian3(6_378_137.25, 1_000_000.5, 2_000_000.75);
  const camera0 = Cartesian3.clone(translation0, new Cartesian3());
  const model0 = makeModel(0.37, translation0);
  const view0 = makeView(camera0);
  const history = createPointCloudRteHistory();
  const viewKey = {};
  updatePointCloudRteHistory(
    history,
    10,
    viewKey,
    view0,
    projection,
    camera0,
    model0,
  );

  // First frame seeds previous=current, so a static point emits zero.
  assert.deepEqual(
    ndc(shaderClip(history.current, localPoint)),
    ndc(shaderClip(history.previous, localPoint)),
  );

  updatePointCloudRteHistory(
    history,
    11,
    viewKey,
    view0,
    projection,
    camera0,
    model0,
  );
  assert.deepEqual(
    ndc(shaderClip(history.current, localPoint)),
    ndc(shaderClip(history.previous, localPoint)),
  );

  // Camera + model motion advances current while retaining frame 11 as the
  // previous snapshot. Both clips agree with an f64 absolute-world reference.
  const translation1 = new Cartesian3(6_378_140.25, 999_999.5, 2_000_002.75);
  const camera1 = new Cartesian3(6_378_138.25, 1_000_001.0, 2_000_000.75);
  const model1 = makeModel(0.39, translation1);
  const view1 = makeView(camera1);
  updatePointCloudRteHistory(
    history,
    12,
    viewKey,
    view1,
    projection,
    camera1,
    model1,
  );
  const currentClip = shaderClip(history.current, localPoint);
  const previousClip = shaderClip(history.previous, localPoint);
  const currentReference = referenceClip(view1, model1, localPoint);
  const previousReference = referenceClip(view0, model0, localPoint);
  assertNdcClose(currentClip, currentReference);
  assertNdcClose(previousClip, previousReference);
  const velocity = [
    currentClip.x / currentClip.w - previousClip.x / previousClip.w,
    currentClip.y / currentClip.w - previousClip.y / previousClip.w,
  ];
  const expectedVelocity = [
    currentReference.x / currentReference.w -
      previousReference.x / previousReference.w,
    currentReference.y / currentReference.w -
      previousReference.y / previousReference.w,
  ];
  assert.ok(velocity.every(Number.isFinite));
  assert.ok(Math.abs(velocity[0] - expectedVelocity[0]) <= 2.0e-5);
  assert.ok(Math.abs(velocity[1] - expectedVelocity[1]) <= 2.0e-5);

  // A view switch in the same frame reseeds history instead of borrowing the
  // old view's previous snapshot.
  updatePointCloudRteHistory(
    history,
    12,
    {},
    view1,
    projection,
    camera1,
    model1,
  );
  assert.deepEqual(
    ndc(shaderClip(history.current, localPoint)),
    ndc(shaderClip(history.previous, localPoint)),
  );

  // A TimeDynamic owner revisited after a global-frame gap seeds zero
  // velocity instead of using its stale last-visible camera/model snapshot.
  updatePointCloudRteHistory(
    history,
    20,
    history.viewKey,
    view1,
    projection,
    camera1,
    model1,
  );
  assert.deepEqual(
    ndc(shaderClip(history.current, localPoint)),
    ndc(shaderClip(history.previous, localPoint)),
  );
});

test("point-cloud RTE history resets stale camera state across frame gaps", () => {
  const viewKey = {};
  const identity = Matrix4.clone(Matrix4.IDENTITY, new Matrix4());
  const frame10Camera = new Cartesian3(1_000, 2_000, 3_000);
  const frame11Camera = new Cartesian3(4_000, 5_000, 6_000);
  const frame12Camera = new Cartesian3(7_000, 8_000, 9_000);
  const update = (history, frameNumber, camera) =>
    updatePointCloudRteHistory(
      history,
      frameNumber,
      viewKey,
      identity,
      identity,
      camera,
      identity,
    );
  const snapshotCamera = (snapshot) =>
    Cartesian3.add(
      snapshot.encodedCameraHigh,
      snapshot.encodedCameraLow,
      new Cartesian3(),
    );

  const consecutiveHistory = createPointCloudRteHistory();
  update(consecutiveHistory, 10, frame10Camera);
  update(consecutiveHistory, 11, frame11Camera);
  assert.deepEqual(snapshotCamera(consecutiveHistory.previous), frame10Camera);
  assert.deepEqual(snapshotCamera(consecutiveHistory.current), frame11Camera);

  const gappedHistory = createPointCloudRteHistory();
  update(gappedHistory, 10, frame10Camera);
  update(gappedHistory, 12, frame12Camera);
  assert.deepEqual(snapshotCamera(gappedHistory.previous), frame12Camera);
  assert.deepEqual(snapshotCamera(gappedHistory.current), frame12Camera);
});

test("point-cloud velocity ignores fully transparent points on default and LOD paths", () => {
  const source = read(
    "packages/engine/Source/Renderer/WebGPU/WebGPUPointCloudRenderer.ts",
  );
  assert.equal((source.match(/@location\(2\) alpha: f32/g) ?? []).length, 2);
  assert.match(
    source,
    /output\.alpha = input\.colorAndAlpha\.a \* u\.highlightColor\.a/,
  );
  assert.match(
    source,
    /output\.alpha = instanceData\[base \+ 9u\] \* u\.highlightColor\.a/,
  );
  assert.equal(
    (source.match(/if \(input\.alpha <= 0\.0\) \{\s*discard;/g) ?? []).length,
    2,
  );
});

test("GPU point-cloud LOD owns mutable streams and keeps model motion in small local params", () => {
  const renderer = read(
    "packages/engine/Source/Renderer/WebGPU/WebGPUPointCloudRenderer.ts",
  );
  const processor = read(
    "packages/engine/Source/Renderer/WebGPU/WebGPUPointCloudLODProcessor.ts",
  );

  assert.match(processor, /createOwnerStream\(/);
  assert.match(processor, /owner\._bindGroupLayout = this\._bindGroupLayout/);
  assert.match(processor, /owner\._pipelines = this\._pipelines/);
  assert.match(processor, /owner\._allocateOwnerBuffers\(\)/);
  assert.match(renderer, /lodProcessorPromise:/);
  assert.match(renderer, /ensurePointCloudLodOwnerStream\(/);
  assert.match(renderer, /template\.createOwnerStream\(label\)/);
  assert.match(renderer, /cache\.lodProcessor\?\.destroy\(\)/);
  assert.doesNotMatch(
    renderer,
    /tryAcquirePointCloudLodStream|pointCloudLodFrameClaims/,
    "additional clouds must not silently lose GPU LOD through an exclusive lease",
  );

  // false -> true rebuilds once with STORAGE/local SOA even at equal count.
  assert.match(
    renderer,
    /const needsStorageUpgrade = lodEligible && !cache\.instanceAllowsStorage/,
  );
  assert.match(renderer, /!cache\.instanceBuffer \|\|\s*needsStorageUpgrade/);

  // Model motion transforms only local camera/frustum/model-linear params.
  assert.doesNotMatch(renderer, /refreshPointCloudLodWorldPositions/);
  assert.doesNotMatch(renderer, /lodWorldModelMatrix/);
  assert.match(renderer, /updatePointCloudLodLocalParams\(/);
  assert.match(
    renderer,
    /localX\[i\] = sx;[\s\S]*localY!\[i\] = sy;[\s\S]*localZ!\[i\] = sz/,
  );
  const localFrame = read(
    "packages/engine/Source/Renderer/WebGPU/WebGPUPointCloudLodLocalFrame.js",
  );
  assert.match(localFrame, /scratchCameraLocal\.x - rtc\.x/);
  assert.match(localFrame, /w \+= x \* rtc\.x \+ y \* rtc\.y \+ z \* rtc\.z/);
  assert.match(processor, /cameraPositionLocal/);
  assert.match(processor, /modelLinear/);

  const rtc = new Cartesian3(6_378_137.25, -1_000_000.5, 2_000_000.75);
  const model = Matrix4.fromRotationTranslation(
    Matrix3.fromRotationZ(0.41, new Matrix3()),
    new Cartesian3(100, -40, 25),
    new Matrix4(),
  );
  const expectedCameraLocal = new Cartesian3(12.5, -3.25, 80);
  const cameraModel = Cartesian3.add(
    rtc,
    expectedCameraLocal,
    new Cartesian3(),
  );
  const cameraWorld = Matrix4.multiplyByPoint(
    model,
    cameraModel,
    new Cartesian3(),
  );
  const planes = Array.from(
    { length: 6 },
    () => new Cartesian4(0.3, -0.4, 0.5, -20),
  );
  const cameraLocal = [0, 0, 0];
  const localPlanes = new Float32Array(24);
  const linear = new Float32Array(12);
  updatePointCloudLodLocalFrame(
    model,
    cameraWorld,
    planes,
    rtc,
    cameraLocal,
    localPlanes,
    linear,
  );
  assert.ok(Math.abs(cameraLocal[0] - expectedCameraLocal.x) < 1e-8);
  assert.ok(Math.abs(cameraLocal[1] - expectedCameraLocal.y) < 1e-8);
  assert.ok(Math.abs(cameraLocal[2] - expectedCameraLocal.z) < 1e-8);
  const q = new Cartesian3(2.5, -4.0, 6.0);
  const world = Matrix4.multiplyByPoint(
    model,
    Cartesian3.add(rtc, q, new Cartesian3()),
    new Cartesian3(),
  );
  const worldPlaneValue =
    planes[0].x * world.x +
    planes[0].y * world.y +
    planes[0].z * world.z +
    planes[0].w;
  const localPlaneValue =
    localPlanes[0] * q.x +
    localPlanes[1] * q.y +
    localPlanes[2] * q.z +
    localPlanes[3];
  assert.equal(Math.sign(localPlaneValue), Math.sign(worldPlaneValue));

  // cull:false mirrors WebGL on the default command and bypasses the
  // culling-only GPU LOD path rather than dropping points.
  assert.match(renderer, /const cull = pointCloud\._cull !== false/);
  assert.match(
    renderer,
    /optIn &&[\s\S]*?cull &&[\s\S]*?!translucent &&[\s\S]*?perspectiveLodProjection &&[\s\S]*?pointCount >=/,
  );
  assert.match(renderer, /const lodPossible = lodEligible &&/);
  assert.match(renderer, /cache\.command\.cull = cull/);
  assert.match(
    renderer,
    /cache\.lodCommand\.cull = pointCloud\._cull !== false/,
  );

  const velocityAttachStart = renderer.indexOf(
    "function attachLODPointCloudVelocityCommand",
  );
  const nextFunction = renderer.indexOf(
    "function _buildLODPipelineDescriptor",
    velocityAttachStart,
  );
  const velocityAttach = renderer.slice(velocityAttachStart, nextFunction);
  assert.match(velocityAttach, /lodProcessor\.visibleIndicesBuffer/);
  assert.doesNotMatch(
    velocityAttach,
    /context\.pointCloudLOD/,
    "LOD velocity must bind the same owner stream as the color command",
  );

  const threshold = renderer.indexOf("const lodEligible =");
  const contextGetter = renderer.indexOf("context.pointCloudLOD", threshold);
  const ownerFork = renderer.indexOf(
    "ensurePointCloudLodOwnerStream",
    threshold,
  );
  assert.ok(
    threshold >= 0 && contextGetter > threshold && ownerFork > threshold,
  );
  assert.match(renderer, /const enqueuedLod = _runGPULODPath/);
  assert.match(renderer, /if \(enqueuedLod\) \{\s*return;/);
});

test("translucent point-cloud commands stay sortable and outside EDL", () => {
  const renderer = read(
    "packages/engine/Source/Renderer/WebGPU/WebGPUPointCloudRenderer.ts",
  );
  const edl = read(
    "packages/engine/Source/Renderer/WebGPU/WebGPUPointCloudEyeDomeLighting.ts",
  );
  const pointCloud = read("packages/engine/Source/Scene/PointCloud.js");

  assert.match(pointCloud, /_webgpuLocalBoundingSphere/);
  assert.match(
    renderer,
    /cache\.command = new WebGPUDrawCommand\(\{[\s\S]*?boundingVolume,/,
  );
  assert.match(
    renderer,
    /cache\.lodCommand = new WebGPUDrawCommand\(\{[\s\S]*?boundingVolume,/,
  );
  assert.match(renderer, /cache\.command\.boundingVolume = boundingVolume/);
  assert.match(renderer, /cache\.lodCommand\.boundingVolume = boundingVolume/);
  assert.match(edl, /import Pass from "\.\.\/Pass\.js"/);
  assert.match(edl, /command\.pass === Pass\.TRANSLUCENT/);
  assert.match(edl, /entryPoint: "vertexMainLOD"/);
  assert.match(
    edl,
    /passEncoder\.drawIndirect\(source\.drawIndirectBuffer, 0\)/,
  );
  assert.match(renderer, /lodEdlSource\.lodStorageBindGroup/);
});

test("point-cloud shared layouts remain stable across owners and effects layouts", () => {
  let nextId = 0;
  const device = {
    createBindGroupLayout(descriptor) {
      return { id: ++nextId, descriptor };
    },
    createPipelineLayout(descriptor) {
      return { id: ++nextId, descriptor };
    },
  };
  const effectsA = {};
  const effectsB = {};
  const a1 = getWebGPUPointCloudSharedLayouts(device, 4, effectsA);
  assert.equal(
    nextId,
    2,
    "default clouds must not eagerly create any LOD layout artifacts",
  );
  const lodLayout = a1.lodPipelineLayout;
  assert.equal(nextId, 4);
  assert.equal(a1.lodPipelineLayout, lodLayout);
  const b1 = getWebGPUPointCloudSharedLayouts(device, 4, effectsB);
  const a2 = getWebGPUPointCloudSharedLayouts(device, 4, effectsA);
  assert.equal(a1, a2, "interleaving another context must not thrash A");
  assert.notEqual(a1, b1);
  assert.equal(a1.uniformBindGroupLayout, a2.uniformBindGroupLayout);
  const aNextGeneration = getWebGPUPointCloudSharedLayouts(device, 5, effectsA);
  assert.equal(
    aNextGeneration,
    a1,
    "context-local generations must not invalidate live device layouts",
  );
  const allocationCount = nextId;
  for (let generation = 6; generation < 20; generation++) {
    assert.equal(
      getWebGPUPointCloudSharedLayouts(device, generation, effectsA),
      a1,
    );
    assert.equal(
      getWebGPUPointCloudSharedLayouts(device, 100 - generation, effectsB),
      b1,
    );
  }
  assert.equal(
    nextId,
    allocationCount,
    "pooled contexts alternating recovery epochs allocate no new layouts",
  );
});

test("WebGPU EDL replays effects and exact point depth into scene depth/stencil", () => {
  const renderer = read(
    "packages/engine/Source/Renderer/WebGPU/WebGPUPointCloudRenderer.ts",
  );
  const edl = read(
    "packages/engine/Source/Renderer/WebGPU/WebGPUPointCloudEyeDomeLighting.ts",
  );
  const depthShader = read(
    "packages/engine/Source/Shaders/WebGPU/PointCloud/PointCloudEDLDepth.wgsl",
  );
  const blendShader = read(
    "packages/engine/Source/Shaders/WebGPU/Advanced/PointCloudEDL.wgsl",
  );

  const state = createWebGPUPointCloudEDLCompositeDepthStencilState();
  assert.equal(state.depthCompare, "less-equal");
  assert.equal(state.depthWriteEnabled, true);
  assert.equal(
    POINT_CLOUD_EDL_TILE_STENCIL_MASK,
    0x80,
    "the EDL composite must write WebGL's Cesium 3D-Tile stencil bit",
  );
  assert.equal(state.stencilWriteMask, POINT_CLOUD_EDL_TILE_STENCIL_MASK);
  assert.equal(state.stencilReadMask, POINT_CLOUD_EDL_TILE_STENCIL_MASK);
  assert.equal(state.stencilFront.compare, "always");
  assert.equal(state.stencilFront.depthFailOp, "keep");
  assert.equal(state.stencilFront.passOp, "replace");
  assert.equal(state.stencilBack.passOp, "replace");

  const device = {};
  const cache = { device, resourceGeneration: 7 };
  assert.equal(isWebGPUPointCloudEDLCacheCurrent(cache, device, 7), true);
  assert.equal(isWebGPUPointCloudEDLCacheCurrent(cache, device, 8), false);
  assert.equal(isWebGPUPointCloudEDLCacheCurrent(cache, {}, 7), false);

  assert.match(renderer, /defaultEdlSource\.effectsBindGroup = effectsBG/);
  assert.match(renderer, /lodEdlSource\.effectsBindGroup = lodEffectsBG/);
  assert.match(edl, /setBindGroup\(1, source\.effectsBindGroup!\)/);
  assert.match(edl, /setStencilReference\(POINT_CLOUD_EDL_TILE_STENCIL_MASK\)/);
  assert.match(edl, /isWebGPUPointCloudEDLCacheCurrent/);
  assert.match(edl, /onDeviceInvalidated/);
  assert.match(depthShader, /effects\.atmosphereLutControl\.x > 0\.5/);
  assert.match(depthShader, /atmosphereTransmittanceLut/);
  assert.match(depthShader, /@builtin\(frag_depth\) depth: f32/);
  assert.match(depthShader, /vec2<f32>\(max\(input\.eyeDepth/);
  assert.match(blendShader, /centerDepthSample\.g/);
  assert.match(blendShader, /@builtin\(frag_depth\) depth: f32/);
  assert.match(blendShader, /discard;/);
});

test("WebGPU EDL scheduler isolates processors, frustums, and targets", () => {
  const state = {};
  const processorA = {};
  const processorB = {};
  assert.equal(
    beginWebGPUPointCloudEDLProcessorUpdate(state, processorA, 41),
    0,
  );
  assert.equal(
    beginWebGPUPointCloudEDLProcessorUpdate(state, processorB, 41),
    1,
  );
  assert.equal(
    beginWebGPUPointCloudEDLProcessorUpdate(state, processorA, 41),
    0,
    "a repeated update in one frame keeps its stable order",
  );

  const secondContextState = {};
  const secondContextProcessor = {};
  assert.equal(
    beginWebGPUPointCloudEDLProcessorUpdate(
      secondContextState,
      secondContextProcessor,
      41,
    ),
    0,
  );
  assert.equal(
    beginWebGPUPointCloudEDLProcessorUpdate(secondContextState, processorA, 41),
    1,
    "the same processor must receive a fresh order after same-frame context migration",
  );
  assert.equal(
    beginWebGPUPointCloudEDLProcessorUpdate(secondContextState, processorA, 41),
    1,
    "the migrated processor keeps its context-local stable order",
  );

  const sceneTarget = {};
  const invertTarget = {};
  const metadata = (
    processor,
    updateOrder,
    slice,
    targetKind,
    target,
    strength,
    radius,
  ) => ({
    processor,
    updateOrder,
    strength,
    radius,
    frameNumber: 41,
    pass: 5,
    interceptFrame: 41,
    interceptSlice: slice,
    targetKind,
    targetIdentity: target,
  });
  const commands = [
    {
      enabled: false,
      _webgpuPointCloudEDL: metadata(
        processorB,
        1,
        0,
        "scene",
        sceneTarget,
        2.0,
        1.25,
      ),
    },
    {
      enabled: false,
      _webgpuPointCloudEDL: metadata(
        processorA,
        0,
        0,
        "scene",
        sceneTarget,
        0.75,
        3.5,
      ),
    },
    {
      enabled: false,
      _webgpuPointCloudEDL: metadata(
        processorA,
        0,
        1,
        "scene",
        sceneTarget,
        0.75,
        3.5,
      ),
    },
    {
      enabled: false,
      _webgpuPointCloudEDL: metadata(
        processorB,
        1,
        0,
        "invert",
        invertTarget,
        2.0,
        1.25,
      ),
    },
  ];

  assert.deepEqual(
    findNextWebGPUPointCloudEDLProcessor(
      commands,
      commands.length,
      41,
      5,
      0,
      "scene",
      sceneTarget,
      -1,
    ),
    { processor: processorA, updateOrder: 0 },
    "bucket order cannot override processor update order",
  );
  assert.deepEqual(
    findNextWebGPUPointCloudEDLProcessor(
      commands,
      commands.length,
      41,
      5,
      0,
      "scene",
      sceneTarget,
      0,
    ),
    { processor: processorB, updateOrder: 1 },
  );
  assert.deepEqual(
    findNextWebGPUPointCloudEDLProcessor(
      commands,
      commands.length,
      41,
      5,
      1,
      "scene",
      sceneTarget,
      -1,
    ),
    { processor: processorA, updateOrder: 0 },
    "the second frustum sees only its own disabled slice",
  );
  assert.deepEqual(
    findNextWebGPUPointCloudEDLProcessor(
      commands,
      commands.length,
      41,
      5,
      0,
      "invert",
      invertTarget,
      -1,
    ),
    { processor: processorB, updateOrder: 1 },
    "invert and scene targets cannot cross-consume commands",
  );
  assert.equal(
    isWebGPUPointCloudEDLMetadataForSlice(
      commands[0]._webgpuPointCloudEDL,
      41,
      5,
      1,
      "scene",
      sceneTarget,
    ),
    false,
  );
  assert.deepEqual(
    [
      commands[1]._webgpuPointCloudEDL.strength,
      commands[1]._webgpuPointCloudEDL.radius,
    ],
    [0.75, 3.5],
  );
  assert.deepEqual(
    [
      commands[0]._webgpuPointCloudEDL.strength,
      commands[0]._webgpuPointCloudEDL.radius,
    ],
    [2.0, 1.25],
    "processor-local controls must not collapse to last-writer globals",
  );

  const sceneKey = getWebGPUPointCloudEDLBlendPipelineKey(
    "scene",
    "rgba16float",
    4,
    2,
  );
  assert.notEqual(
    sceneKey,
    getWebGPUPointCloudEDLBlendPipelineKey("invert", "rgba16float", 4, 1),
  );
  assert.notEqual(
    sceneKey,
    getWebGPUPointCloudEDLBlendPipelineKey("scene", "rgba16float", 1, 2),
  );

  const pendingCommand = { enabled: true };
  const pendingMetadata = {
    frameNumber: 41,
    pass: 5,
    interceptFrame: -1,
    interceptSlice: -1,
    targetKind: null,
    targetIdentity: null,
  };
  const stableMetadata = pendingMetadata;
  interceptWebGPUPointCloudEDLCommand(
    pendingCommand,
    pendingMetadata,
    41,
    0,
    "scene",
    sceneTarget,
  );
  assert.equal(pendingCommand.enabled, false);
  restoreWebGPUPointCloudEDLCommand(pendingCommand, pendingMetadata);
  assert.equal(pendingCommand.enabled, true, "pending replay fails open");
  assert.equal(pendingMetadata, stableMetadata, "metadata is reused in place");

  const owners = new Set([processorA, processorB]);
  assert.equal(releaseWebGPUPointCloudEDLOwner(owners, processorA), false);
  assert.equal(owners.has(processorB), true);
  assert.equal(releaseWebGPUPointCloudEDLOwner(owners, processorB), true);
  assert.equal(
    shouldReleaseWebGPUPointCloudEDLTargets(
      { lastActiveFrame: 40, colorTexture: {} },
      41,
    ),
    true,
    "toggle-off/inactive frames retire full-resolution targets",
  );
});

test("WebGPU EDL composite uniforms use distinct submit-owned arena slots", () => {
  const page = {};
  let cursor = 0;
  let allocationCalls = 0;
  const allocator = {
    allocateAndWrite(data, allocationSize) {
      allocationCalls++;
      assert.equal(allocationSize, POINT_CLOUD_EDL_UNIFORM_SLOT_BYTES);
      assert.equal(data.byteLength, 8 * 4);
      const allocation = { buffer: page, offset: cursor };
      cursor += allocationSize;
      return allocation;
    },
  };
  const uniforms = new Float32Array(8);
  const first = acquireWebGPUPointCloudEDLUniformSlice(allocator, uniforms);
  const second = acquireWebGPUPointCloudEDLUniformSlice(allocator, uniforms);
  const third = acquireWebGPUPointCloudEDLUniformSlice(allocator, uniforms);
  assert.deepEqual(
    [first.offset, second.offset, third.offset],
    [0, 256, 512],
    "multiple processors/frustums encoded before one submit cannot alias",
  );
  assert.equal(first.buffer, second.buffer, "one pooled page is reused");
  assert.equal(allocationCalls, 3);
  assert.equal(
    acquireWebGPUPointCloudEDLUniformSlice(
      { allocateAndWrite: () => ({ buffer: page, offset: 12 }) },
      uniforms,
    ),
    null,
    "a misaligned slot fails open instead of reaching setBindGroup",
  );
  assert.equal(
    acquireWebGPUPointCloudEDLUniformSlice(
      {
        allocateAndWrite() {
          throw new Error("bounded ring exhausted");
        },
      },
      uniforms,
    ),
    null,
  );

  const source = read(
    "packages/engine/Source/Renderer/WebGPU/WebGPUPointCloudEyeDomeLighting.ts",
  );
  assert.match(source, /hasDynamicOffset:\s*true/);
  assert.match(source, /minBindingSize:\s*BLEND_UNIFORM_FLOATS \* 4/);
  assert.match(source, /uniformAllocator/);
  assert.match(source, /blendDynamicOffsetScratch/);
  assert.doesNotMatch(source, /blendUniformBuffer:\s*GPUBuffer/);
  assert.ok(
    source.indexOf("acquireBlendUniformBinding(", source.indexOf("for (;;)")) <
      source.indexOf(
        "endCurrentRenderPass(context)",
        source.indexOf("for (;;)"),
      ),
    "bounded-arena failure must be discovered before the target pass is ended",
  );
});

test("WebGPU EDL exact-frame candidate gate skips inactive bucket scans", () => {
  const state = {};
  beginWebGPUPointCloudEDLCandidateFrame(state, 70);
  assert.equal(hasCurrentWebGPUPointCloudEDLCandidate(state, 70, 6), false);
  markWebGPUPointCloudEDLCandidate(state, 70, 6);
  assert.equal(hasCurrentWebGPUPointCloudEDLCandidate(state, 70, 6), true);
  assert.equal(hasCurrentWebGPUPointCloudEDLCandidate(state, 70, 9), false);
  assert.equal(
    hasCurrentWebGPUPointCloudEDLCandidate(state, 69, 6),
    false,
    "stale metadata cannot activate a later/earlier frame",
  );
  beginWebGPUPointCloudEDLCandidateFrame(state, 71);
  assert.equal(hasCurrentWebGPUPointCloudEDLCandidate(state, 71, 6), false);

  let bucketReads = 0;
  const commands = new Proxy([], {
    get(target, property, receiver) {
      if (property !== "length") bucketReads++;
      return Reflect.get(target, property, receiver);
    },
  });
  if (hasCurrentWebGPUPointCloudEDLCandidate(state, 71, 6)) {
    // This is the same scalar guard used at the head of prepare/render.
    void commands[0];
  }
  assert.equal(bucketReads, 0);

  const source = read(
    "packages/engine/Source/Renderer/WebGPU/WebGPUPointCloudEyeDomeLighting.ts",
  );
  const prepare = source.slice(
    source.indexOf("export function prepareWebGPUPointCloudEDLCommands"),
    source.indexOf("function matchesIntercept"),
  );
  assert.ok(
    prepare.indexOf("hasCurrentWebGPUPointCloudEDLCandidate") <
      prepare.indexOf("for (let i = 0; i < count; i++)"),
  );
  const render = source.slice(
    source.indexOf("export function renderWebGPUPointCloudEDLCommands"),
    source.indexOf("export function finalizeWebGPUPointCloudEDLFrame"),
  );
  assert.ok(
    render.indexOf("hasCurrentWebGPUPointCloudEDLCandidate") <
      render.indexOf("findNextProcessor"),
  );
});

test("point-cloud EDL ownership is released on destroy and context migration", () => {
  const edl = read(
    "packages/engine/Source/Renderer/WebGPU/WebGPUPointCloudEyeDomeLighting.ts",
  );
  const tileset = read("packages/engine/Source/Scene/Cesium3DTileset.js");
  const dynamic = read("packages/engine/Source/Scene/TimeDynamicPointCloud.js");
  const update = edl.slice(
    edl.indexOf("function updateWebGPUPointCloudEDL"),
    edl.indexOf("function isMetadataCandidate"),
  );
  assert.ok(
    update.indexOf("releaseProcessorContextOwnership") <
      update.indexOf("processor._webgpuEDLContext = context"),
  );
  assert.match(
    tileset.slice(tileset.indexOf("destroy()")),
    /_pointCloudEyeDomeLighting\.destroy\(\)/,
  );
  assert.match(
    dynamic.slice(dynamic.indexOf("destroy()")),
    /_pointCloudEyeDomeLighting\.destroy\(\)/,
  );
  assert.match(
    edl,
    /releaseWebGPUPointCloudEDLOwner\(cache\.owners, processor\)[\s\S]*?destroyEDLCache\(cache\)/,
    "the last owner must retire the shared cache and full-resolution targets",
  );
  assert.match(
    edl,
    /processor\._webgpuEDLUpdateContext = null/,
    "destroy must not retain the previous exact context through the processor",
  );
});

test("WebGPU EDL composites at pass-local hooks and remains fail-open", () => {
  const edl = read(
    "packages/engine/Source/Renderer/WebGPU/WebGPUPointCloudEyeDomeLighting.ts",
  );
  const frustum = read(
    "packages/engine/Source/Renderer/WebGPU/WebGPUSceneRendererFrustumLoop.ts",
  );
  const tiles = read(
    "packages/engine/Source/Renderer/WebGPU/WebGPUSceneRenderer3DTilePasses.ts",
  );
  const blendShader = read(
    "packages/engine/Source/Shaders/WebGPU/Advanced/PointCloudEDL.wgsl",
  );

  const thrown = { name: "SyntheticEDLFailure" };
  const reported = [];
  const restored = [];
  let recovered;
  assert.doesNotThrow(() => {
    recovered = withWebGPUPointCloudEDLFailOpen(
      () => {
        throw thrown;
      },
      {
        report: (error) => reported.push(error),
        restore: (error) => restored.push(error),
      },
    );
  });
  assert.equal(recovered, false);
  assert.deepEqual(reported, [thrown]);
  assert.deepEqual(restored, [thrown]);

  const success = { composite: "encoded" };
  let successReports = 0;
  let successRestores = 0;
  assert.equal(
    withWebGPUPointCloudEDLFailOpen(() => success, {
      report: () => successReports++,
      restore: () => successRestores++,
    }),
    success,
  );
  assert.equal(successReports, 0);
  assert.equal(successRestores, 0);
  assert.equal(
    (edl.match(/\bwithWebGPUPointCloudEDLFailOpen\(/g) ?? []).length,
    2,
    "both synchronous EDL recovery boundaries must use the tested helper",
  );

  const update = edl.slice(
    edl.indexOf("function updateWebGPUPointCloudEDL"),
    edl.indexOf("function isMetadataCandidate"),
  );
  assert.match(update, /if \(!metadata\) \{/);
  assert.doesNotMatch(
    update,
    /command\.enabled = false/,
    "traversal tagging must not hide a command before target preflight",
  );
  const prepare = edl.slice(
    edl.indexOf("export function prepareWebGPUPointCloudEDLCommands"),
    edl.indexOf("function matchesIntercept"),
  );
  assert.ok(
    prepare.indexOf("preflightSource") <
      prepare.indexOf("interceptWebGPUPointCloudEDLCommand"),
  );
  assert.match(edl, /restoreAllInterceptedCommands/);
  assert.match(edl, /restoreProcessorGroup/);
  assert.match(
    edl,
    /releaseWebGPUPointCloudEDLOwner\(cache\.owners, processor\)/,
  );
  assert.match(edl, /shouldReleaseWebGPUPointCloudEDLTargets/);

  const opaqueStart = frustum.indexOf("const opaqueCommands =");
  const opaqueDraw = frustum.indexOf("host._executeOpaquePass", opaqueStart);
  const opaqueComposite = frustum.indexOf(
    "renderWebGPUPointCloudEDLCommands",
    opaqueDraw,
  );
  const depthRepack = frustum.indexOf("DP-H45", opaqueComposite);
  assert.ok(opaqueStart < opaqueDraw && opaqueDraw < opaqueComposite);
  assert.ok(opaqueComposite < depthRepack);

  const invertStart = tiles.indexOf("const invertEDLCount");
  const invertTileDraw = tiles.indexOf("runPass(passIndex)", invertStart);
  const invertComposite = tiles.indexOf(
    "renderWebGPUPointCloudEDLCommands",
    invertTileDraw,
  );
  const depthPublication = tiles.indexOf(
    "if (hasTileMainCommands && onAfterTileMainPass)",
    invertComposite,
  );
  assert.ok(
    invertStart < invertTileDraw &&
      invertTileDraw < invertComposite &&
      invertComposite < depthPublication,
  );
  assert.match(tiles, /edlColor\.loadOp = "load"/);
  assert.match(
    tiles,
    /buildInvertClassificationDepthStencilAttachment\([\s\S]*?"load",[\s\S]*?"load"/,
  );

  assert.match(blendShader, /let radius0 = floor\(params\.radius\)/);
  assert.match(blendShader, /let radius1 = ceil\(params\.radius\)/);
  assert.match(blendShader, /mix\(depth0, depth1, fract\(params\.radius\)\)/);
  assert.doesNotMatch(edl, /_pointCloudEDLClouds|recordedClouds/);
});

test("WebGPU point-cloud EDL and LOD shaders pass Naga", async () => {
  const nagaDirectory = path.join(
    ROOT,
    "Tools/shader-pipeline/naga-wasm-tools",
  );
  const naga = await import(
    pathToFileURL(path.join(nagaDirectory, "naga_wasm_tools.js")).href
  );
  await naga.default({
    module_or_path: readFileSync(
      path.join(nagaDirectory, "naga_wasm_tools_bg.wasm"),
    ),
  });

  const expandDefines = (source, enabled) => {
    const output = [];
    const stack = [];
    let active = true;
    for (const line of source.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.startsWith("//>>ifdef ")) {
        const condition = enabled.has(
          trimmed.slice("//>>ifdef ".length).trim(),
        );
        stack.push({ parent: active, condition });
        active = active && condition;
      } else if (trimmed === "//>>else") {
        const top = stack.at(-1);
        active = top.parent && !top.condition;
      } else if (trimmed === "//>>endif") {
        active = stack.pop().parent;
      } else if (active) {
        output.push(line);
      }
    }
    assert.equal(stack.length, 0);
    return output.join("\n");
  };

  const depthShader = read(
    "packages/engine/Source/Shaders/WebGPU/PointCloud/PointCloudEDLDepth.wgsl",
  );
  const blendShader = read(
    "packages/engine/Source/Shaders/WebGPU/Advanced/PointCloudEDL.wgsl",
  );
  assert.doesNotThrow(() =>
    naga.validate_wgsl(
      expandDefines(depthShader, new Set(["POINT_CLOUD_EDL_DEPTH"])),
    ),
  );
  assert.doesNotThrow(() => naga.validate_wgsl(blendShader));
  const lodShader = read(
    "packages/engine/Source/Shaders/WebGPU/Compute/PointCloudLOD.wgsl",
  );
  const portableLodShader = lodShader.replace(
    /\/\/ __SUBGROUP_BLOCK_START__[\s\S]*?\/\/ __SUBGROUP_BLOCK_END__/,
    "// subgroup variant stripped for portable validation",
  );
  const scanShader = read(
    "packages/engine/Source/Shaders/WebGPU/Compute/PointCloudLODScanCompact.wgsl",
  );
  assert.doesNotThrow(() => naga.validate_wgsl(portableLodShader));
  assert.doesNotThrow(() => naga.validate_wgsl(scanShader));
});

test("GPU point-cloud LOD preserves orthographic output and scales geometric error", () => {
  const renderer = read(
    "packages/engine/Source/Renderer/WebGPU/WebGPUPointCloudRenderer.ts",
  );
  const eligibilityStart = renderer.indexOf("const perspectiveLodProjection");
  const eligibilityEnd = renderer.indexOf(
    "const lodTemplate",
    eligibilityStart,
  );
  const eligibility = renderer.slice(eligibilityStart, eligibilityEnd);
  assert.match(eligibility, /typeof lodSseDenominator === "number"/);
  assert.match(eligibility, /perspectiveLodProjection/);
  assert.match(eligibility, /pointCount >= POINT_COUNT_LOD_THRESHOLD/);
  assert.match(
    renderer,
    /\(configuredGeometricError > 0\.0[\s\S]*?: estimatedSpacing\) \* geometricErrorScale/,
  );
});

test("point-cloud readiness waits for usable current backend resources", () => {
  const pointCloud = read("packages/engine/Source/Scene/PointCloud.js");
  const renderer = read(
    "packages/engine/Source/Renderer/WebGPU/WebGPUPointCloudRenderer.ts",
  );
  const registry = read(
    "packages/engine/Source/Renderer/WebGPU/WebGPUFeatureRenderers.ts",
  );
  assert.match(pointCloud, /pointCloud\._webgpuReadyStatePrepared = true/);
  assert.doesNotMatch(
    pointCloud.slice(
      pointCloud.indexOf("function computeWebGPUReadyState"),
      pointCloud.indexOf("function computeApproximateBoundingSphere"),
    ),
    /pointCloud\._ready = true/,
  );
  assert.match(
    pointCloud,
    /typeof fr\.isReady === "function" &&\s*fr\.isReady\(this\)/,
  );
  assert.match(pointCloud, /frameState\.afterRender\.push/);
  assert.match(renderer, /function isWebGPUPointCloudReady/);
  assert.match(renderer, /!cache\.pipeline/);
  assert.match(registry, /isReady: mod\.isWebGPUPointCloudReady/);
});

test("quantized point-cloud ready bounds use exact volume corners without O(N) decode", () => {
  const source = read("packages/engine/Source/Scene/PointCloud.js");
  const start = source.indexOf("function computeWebGPUReadyState");
  const end = source.indexOf(
    "function computeApproximateBoundingSphereFromPositions",
    start,
  );
  const body = source.slice(start, end);
  assert.match(body, /offset\.x \+ scale\.x/);
  assert.match(
    body,
    /BoundingSphere\.fromCornerPoints\(scratchMin, scratchMax\)/,
  );
  assert.doesNotMatch(body, /new Float32Array\(typedArray\.length\)/);
  assert.doesNotMatch(body, /for \(let i = 0; i < pointsLength/);
  assert.match(body, /BoundingSphere\.fromVertices\(typedArray\)/);

  const positions = new Float64Array(63);
  positions[60] = 1_000_000;
  const sphere = BoundingSphere.fromVertices(positions);
  assert.ok(
    Cartesian3.distance(sphere.center, new Cartesian3(1_000_000, 0, 0)) <=
      sphere.radius,
    "an extreme final point must be inside the full-scan bound",
  );
});

test("projected-error LOD responds to camera distance and viewport scale", () => {
  const lodLevel = (distance, viewportScale, error = 2, target = 1) => {
    const ratio = (error * viewportScale) / Math.max(distance, 1e-4) / target;
    if (ratio >= 4) return 0;
    if (ratio >= 2) return 1;
    if (ratio >= 1) return 2;
    return 3;
  };
  assert.ok(lodLevel(100, 1000) < lodLevel(1000, 1000));
  assert.ok(lodLevel(1000, 2000) < lodLevel(1000, 500));
  const shader = read(
    "packages/engine/Source/Shaders/WebGPU/Compute/PointCloudLOD.wgsl",
  );
  assert.match(shader, /params\.geometricError \* params\.projectionScale/);
  assert.match(shader, /modelLinear0/);
  assert.doesNotMatch(shader, /lod0Distance2/);
});

test("projected-error LOD keeps the public far-cull toggle and packs its resolved value", () => {
  const renderer = read(
    "packages/engine/Source/Renderer/WebGPU/WebGPUPointCloudRenderer.ts",
  );
  const processor = read(
    "packages/engine/Source/Renderer/WebGPU/WebGPUPointCloudLODProcessor.ts",
  );
  const atomic = read(
    "packages/engine/Source/Shaders/WebGPU/Compute/PointCloudLOD.wgsl",
  );
  const scan = read(
    "packages/engine/Source/Shaders/WebGPU/Compute/PointCloudLODScanCompact.wgsl",
  );

  const farInitializer = renderer.match(
    /const lodFarDistance\s*=\s*([\s\S]*?);/,
  );
  assert.ok(farInitializer, "renderer far-distance initializer is absent");
  const resolveFarDistance = runInNewContext(
    `(pointCloud, frameState) => (${farInitializer[1]})`,
  );
  const resolved = [
    resolveFarDistance(
      { lodFarDistance: 128 },
      { camera: { frustum: { far: 2048 } } },
    ),
    resolveFarDistance({}, { camera: { frustum: { far: 2048 } } }),
    resolveFarDistance({}, {}),
  ];
  assert.deepEqual(resolved, [128, 2048, 1e7]);

  const slotAssignment = processor.match(/f\[7\]\s*=\s*([^;]+);/);
  assert.ok(slotAssignment, "LOD parameter slot 7 assignment is absent");
  const writeFarDistanceSlot = runInNewContext(
    `(f, p) => { f[7] = ${slotAssignment[1]}; return f[7]; }`,
  );
  for (const value of resolved) {
    const packed = new Float32Array(48);
    assert.equal(
      writeFarDistanceSlot(packed, { lodFarDistance: value }),
      value,
    );
    assert.equal(packed[7], value);
  }

  // Execute the shader's own selection logic rather than a second copy of it.
  for (const [label, shaderSource] of [
    ["PointCloudLOD.wgsl", atomic],
    ["PointCloudLODScanCompact.wgsl", scan],
  ]) {
    const { run, guardText } = buildWgslLodOracle(label, shaderSource);
    assert.equal(
      guardText,
      "lodLevel < 4 && shouldKeepAtLOD(pointIndex, lodLevel)",
      `${label}: the culled tier must gate the keep guard`,
    );
    const at = (distance, farDistance, pointIndex = 0) =>
      run(lodOracleUniforms(farDistance), [distance, 0, 0], pointIndex);

    // The far cull is LIVE, not merely present in the source text.
    assert.equal(
      at(150, 100).lodLevel,
      4,
      `${label}: beyond far selects the culled tier`,
    );
    assert.equal(
      at(150, 100).keep,
      false,
      `${label}: a point beyond far is not kept`,
    );
    assert.ok(
      at(50, 100).lodLevel < 4,
      `${label}: a point inside far selects a drawable tier`,
    );
    assert.equal(
      at(50, 100).keep,
      true,
      `${label}: a point inside far is kept`,
    );

    // The knob moves the boundary in BOTH directions.
    assert.equal(
      at(150, 200).keep,
      true,
      `${label}: raising the knob keeps the far point`,
    );
    assert.equal(
      at(50, 40).keep,
      false,
      `${label}: lowering the knob culls the near point`,
    );

    // The documented Float32-safe disable sentinel.
    assert.equal(at(1e6, 0).keep, true, `${label}: 0 disables the far cull`);

    // Non-vacuity: the culled tier removes a set that is otherwise REACHABLE.
    // Without this leg an empty kept-set would also be satisfied by a tier that
    // decimates everything away, which is not a cull.
    const survivors = (farDistance) =>
      Array.from({ length: 256 }, (_unused, index) => index).filter(
        (index) => at(150, farDistance, index).keep,
      );
    assert.deepEqual(
      survivors(100),
      [],
      `${label}: nothing survives beyond far`,
    );
    assert.ok(
      survivors(0).length > 0,
      `${label}: with the cull disabled those same points are reachable, so the empty set above is a cull and not an empty tier`,
    );

    // Strict `>`: exactly at the far distance is kept.
    assert.ok(
      at(100, 100).lodLevel < 4,
      `${label}: distance equal to far is kept`,
    );
    assert.equal(
      at(100.001, 100).lodLevel,
      4,
      `${label}: just beyond far is culled`,
    );

    // The renderer's OWN resolved values drive the same boundary, tying the JS
    // resolution chain above to the shader behaviour here.
    const [explicit, cameraFar] = resolved;
    assert.equal(
      at(explicit + 1, explicit).keep,
      false,
      `${label}: the explicit knob culls past itself`,
    );
    assert.ok(
      at(explicit - 1, explicit).lodLevel < 4,
      `${label}: the explicit knob keeps inside itself`,
    );
    assert.equal(
      at(cameraFar + 1, cameraFar).keep,
      false,
      `${label}: the camera-far fallback culls past itself`,
    );
  }

  for (const source of [atomic, scan]) {
    const selectionStart = source.indexOf("fn selectLOD(pos: vec3<f32>)");
    const selectionEnd = source.indexOf("fn shouldKeepAtLOD", selectionStart);
    assert.ok(selectionStart >= 0 && selectionEnd > selectionStart);
    const selection = source.slice(selectionStart, selectionEnd);
    assert.match(
      selection,
      /let cameraDistance = worldCameraDistance\(pos\);[\s\S]*?params\.lodFarDistance > 0\.0 && cameraDistance > params\.lodFarDistance[\s\S]*?return 4u;[\s\S]*?let ratio = projectedSpacing\(cameraDistance\)/,
    );
    assert.equal(
      (selection.match(/worldCameraDistance\(pos\)/g) ?? []).length,
      1,
      "each selection must compute world camera distance once",
    );
    assert.match(source, /geometricError: f32,\s*lodFarDistance: f32,/);
  }
  const keepGuard = /lodLevel < 4u && shouldKeepAtLOD\(pointIndex, lodLevel\)/g;
  assert.equal((atomic.match(keepGuard) ?? []).length, 2);
  assert.equal((scan.match(keepGuard) ?? []).length, 1);
  // LIVENESS. Everything above executes `selectLOD` in isolation, which cannot
  // see whether any entry point CALLS it. Binding `let lodLevel = 0u;` at an
  // entry point leaves every in-frustum point at LOD 0 — no far cull, no
  // decimation, no projected-error tiering — and the whole feature goes inert
  // with the assertions above still green. An assignment has no condition to
  // neuter, so counting the bindings is a sufficient liveness tooth, and it
  // mirrors the `worldCameraDistance(pos)` count above. The counts must equal
  // the keep-guard counts: a guarded entry point that does not bind its own
  // selection is the divergence this pins.
  const selectionBinding = /let lodLevel = selectLOD\(pos\);/g;
  for (const [label, source, expected] of [
    ["PointCloudLOD.wgsl", atomic, 2],
    ["PointCloudLODScanCompact.wgsl", scan, 1],
  ]) {
    const bindings = (source.match(selectionBinding) ?? []).length;
    assert.equal(
      bindings,
      expected,
      `${label}: every compute entry point must bind the projected-error selection`,
    );
    assert.equal(
      bindings,
      (source.match(keepGuard) ?? []).length,
      `${label}: a keep-guarded entry point that does not bind its own selection renders every point at LOD 0`,
    );
  }
  assert.match(processor, /const PARAMS_FLOATS = 48;/);
  assert.match(renderer, /geometricError,\s*lodFarDistance,\s*modelLinear:/);
});

test("GPU point-cloud LOD clamps indirect counts and handles 128-lane ballots", () => {
  const atomic = read(
    "packages/engine/Source/Shaders/WebGPU/Compute/PointCloudLOD.wgsl",
  );
  const scan = read(
    "packages/engine/Source/Shaders/WebGPU/Compute/PointCloudLODScanCompact.wgsl",
  );
  const processor = read(
    "packages/engine/Source/Renderer/WebGPU/WebGPUPointCloudLODProcessor.ts",
  );

  assert.match(atomic, /fn reserveVisibleRange\(requested: u32\)/);
  assert.match(atomic, /atomicCompareExchangeWeak\(&visibleCount/);
  assert.equal((atomic.match(/sharedGrantedCount/g) ?? []).length >= 5, true);
  assert.doesNotMatch(
    atomic,
    /atomicAdd\(&visibleCount/,
    "the published indirect count must never overshoot the budget",
  );
  assert.match(atomic, /countOneBits\(ballot\.z\)/);
  assert.match(atomic, /countOneBits\(ballot\.w\)/);
  assert.match(atomic, /ballot\.z & laneMask2/);
  assert.match(atomic, /ballot\.w & laneMask3/);

  // Executable mirror of the four-word rank law. Deliberately place visible
  // lanes in z/w so the old x/y-only mutant cannot pass.
  const visibleLanes = new Set([0, 31, 32, 63, 64, 71, 95, 96, 111, 127]);
  const ballot = [0, 0, 0, 0];
  for (const lane of visibleLanes) {
    ballot[lane >>> 5] |= 1 << (lane & 31);
  }
  const popcount = (value) => {
    let bits = value >>> 0;
    let count = 0;
    while (bits !== 0) {
      bits = (bits & (bits - 1)) >>> 0;
      count++;
    }
    return count;
  };
  const laneRank = (lane) => {
    const word = lane >>> 5;
    const laneInWord = lane & 31;
    const partial = laneInWord === 0 ? 0 : (2 ** laneInWord - 1) >>> 0;
    let rank = 0;
    for (let i = 0; i < 4; i++) {
      const mask = i < word ? 0xffffffff : i === word ? partial : 0;
      rank += popcount((ballot[i] & mask) >>> 0);
    }
    return rank;
  };
  for (let lane = 0; lane < 128; lane++) {
    const expected = [...visibleLanes].filter((value) => value < lane).length;
    assert.equal(laneRank(lane), expected, `rank mismatch at lane ${lane}`);
  }

  const reserve = (observed, requested, maximum) => {
    const desired = observed + Math.min(requested, maximum - observed);
    return { base: observed, granted: desired - observed, count: desired };
  };
  const firstRange = reserve(0, 256, 300);
  const secondRange = reserve(firstRange.count, 256, 300);
  assert.deepEqual(firstRange, { base: 0, granted: 256, count: 256 });
  assert.deepEqual(secondRange, { base: 256, granted: 44, count: 300 });

  assert.match(scan, /@binding\(7\).*visibleCount: atomic<u32>/);
  assert.match(
    scan,
    /atomicStore\(&visibleCount, min\(prefix\[pointIndex\], params\.maxVisiblePoints\)\)/,
  );
  const dispatchScan = processor.slice(
    processor.indexOf("private _dispatchScanPath"),
    processor.indexOf("private _writeParams"),
  );
  assert.doesNotMatch(dispatchScan, /copyBufferToBuffer/);
  assert.match(
    processor,
    /binding: 7, resource: \{ buffer: this\._visibleCount! \}/,
  );
  assert.match(
    processor,
    /u\[33\] = Math\.min\([\s\S]*?p\.maxVisiblePoints[\s\S]*?p\.pointCount[\s\S]*?this\._positionsCapacity/,
  );
});

test("point-cloud owner resources invalidate by device generation and fully destroy", () => {
  const source = read(
    "packages/engine/Source/Renderer/WebGPU/WebGPUPointCloudRenderer.ts",
  );
  assert.match(source, /existingCache\.device !== device/);
  assert.match(
    source,
    /existingCache\.resourceGeneration !== resourceGeneration/,
  );
  assert.match(
    source,
    /context,\s*device,\s*resourceGeneration,\s*sharedLayouts,[\s\S]*rteHistory: createPointCloudRteHistory\(\),[\s\S]*uniformBuffer: null/,
  );
  assert.match(source, /cache\.prevInstanceBuffer\?\.destroy\(\)/);
  assert.match(source, /cache\.lodPrevInstanceBuffer\?\.destroy\(\)/);
});

test("context point-cloud LOD initialization is recovery-token guarded", () => {
  const source = read(
    "packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts",
  );
  assert.match(source, /_pointCloudLODInitializationToken/);
  assert.match(
    source,
    /this\._pointCloudLODInitializationToken === initializationToken/,
  );
  assert.match(source, /private _detachPointCloudLOD\(\)/);
  assert.match(source, /this\._device !== device/);
  assert.match(
    source,
    /this\._deviceResourceGeneration !== resourceGeneration/,
  );
  assert.match(source, /processor\.destroy\(\);\s*throw error/);
  assert.match(source, /register\("pointCloudLOD", \(\) =>/);
  assert.match(source, /this\._detachPointCloudLOD\(\)\?\.destroy\(\)/);

  const declaredInitializationFields = [
    ...source.matchAll(
      /^\s*private\s+(?:readonly\s+)?(_pointCloudLODInitialization\w*)\s*:/gm,
    ),
  ].map((match) => match[1]);
  assert.ok(declaredInitializationFields.length > 0);
  const detachStart = source.indexOf("private _detachPointCloudLOD()");
  const detachEnd = source.indexOf("get pointCloudLOD()", detachStart);
  assert.ok(detachStart >= 0 && detachEnd > detachStart);
  const detach = source.slice(detachStart, detachEnd);
  const assignedInitializationFields = new Set(
    [
      ...detach.matchAll(
        /this\.(_pointCloudLODInitialization\w*)\s*(?:\+\+|--|(?:\?\?|\|\||&&|<<|>>>?|[+\-*/%&|^])?=)/g,
      ),
    ].map((match) => match[1]),
  );
  assert.deepEqual(
    declaredInitializationFields.filter(
      (field) => !assignedInitializationFields.has(field),
    ),
    [],
    "detach must reset every initialization token/error latch",
  );
});

test("point-cloud pipeline rejection surfaces once and cannot hot-loop retry", () => {
  const source = read(
    "packages/engine/Source/Renderer/WebGPU/WebGPUPointCloudRenderer.ts",
  );
  const resolverStart = source.indexOf("function tryResolvePointCloudPipeline");
  const resolverEnd = source.indexOf(
    "function throwUnreportedPointCloudPipelineError",
    resolverStart,
  );
  const resolver = source.slice(resolverStart, resolverEnd);
  const errorGuardAt = resolver.indexOf("if (entry.error)");
  assert.ok(errorGuardAt >= 0, "the terminal-error guard must exist");
  assert.ok(
    errorGuardAt < resolver.indexOf(".getPipeline(entry.descriptor)"),
    "the terminal-error guard must precede pipeline acquisition",
  );
  assert.match(resolver, /entry\.error = new Error/);
  assert.match(source, /entry\.errorReported = true;\s*throw entry\.error/);
  assert.match(source, /throwUnreportedPointCloudPipelineError\(cache\)/);
});

test("TAA-off point clouds retain resources but perform no velocity GPU work", () => {
  const source = read(
    "packages/engine/Source/Renderer/WebGPU/WebGPUPointCloudRenderer.ts",
  );
  const defaultStart = source.indexOf(
    "function attachPointCloudVelocityCommand",
  );
  const defaultEnd = source.indexOf("function _runGPULODPath", defaultStart);
  const lodStart = source.indexOf(
    "function attachLODPointCloudVelocityCommand",
    defaultEnd,
  );
  const defaultAttach = source.slice(defaultStart, defaultEnd);
  const lodEnd = source.indexOf(
    "function _buildLODPipelineDescriptor",
    lodStart,
  );
  const lodAttach = source.slice(lodStart, lodEnd);
  for (const attach of [defaultAttach, lodAttach]) {
    const offGate = attach.indexOf("if (!taaEnabledThisFrame)");
    const firstCopy = attach.indexOf("copyPointCloudBuffer(");
    const firstWrite = attach.indexOf("device.queue.writeBuffer(");
    assert.ok(offGate >= 0 && offGate < firstCopy && offGate < firstWrite);
  }
  assert.equal(
    (defaultAttach.match(/new WebGPUDrawCommand\(/g) ?? []).length,
    1,
  );
  assert.equal((lodAttach.match(/new WebGPUDrawCommand\(/g) ?? []).length, 1);
  assert.match(source, /uniformScratch: new Float32Array\(76\)/);
});

test("VoxelPrimitive publishes ready only from renderer-owned usable state", () => {
  const primitive = read("packages/engine/Source/Scene/VoxelPrimitive.js");
  const renderer = read(
    "packages/engine/Source/Renderer/WebGPU/WebGPUVoxelRenderer.ts",
  );
  const registry = read(
    "packages/engine/Source/Renderer/WebGPU/WebGPUFeatureRenderers.ts",
  );

  assert.match(primitive, /typeof fr\.isReady === "function"/);
  assert.match(primitive, /frameState\.afterRender\.push/);
  assert.match(renderer, /cache\.usingRealData/);
  assert.match(renderer, /cache\.dataUpload\?\.phase === "done"/);
  assert.match(
    renderer,
    /cache\.pipeline &&\s*cache\.pickPipeline &&\s*cache\.command/,
  );
  assert.match(registry, /isReady:\s*mod\.isWebGPUVoxelPrimitiveReady/);
});
