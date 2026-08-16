// webgpu-snap-edge-payload.spec.mjs — browser-free contract for
// UP144-SNAP-WEBGPU-EDGES (the C11-212 edge tier of Scene.snap on WebGPU).
// @purpose Contract for the edge tier of WebGPU Scene.snap: edge-flag payload encode, pick-color plumb into the edge UB, pipeline variant, strict admission.
// @status ACTIVE
//
// WHY THIS EXISTS
// ---------------
// On WebGL an edge snap candidate comes from a SECOND model draw of the same
// shader program with `u_isEdgePass = true`, so its snap-derived command writes
// isEdge into the payload. On WebGPU a model's edges are rasterized by
// `WebGPUEdgeVisibilityEmitter`'s own line pipeline, which historically carried
// no pick ID at all — every WebGPU snap hit decoded `isEdge:false` and
// `Snapping.selectBestHit`'s edge-over-surface preference was inert.
//
// The closure has four far-apart halves that never see each other at runtime:
//
//   1. The emitter's `fragmentSnapMain` WRITES the RG32Uint payload with the
//      edge flag SET, through the pick color carried in the edge UB.
//   2. `WebGPUModelRenderer` PLUMBS the primitive's ensurePickId color and the
//      pick-fleet log-depth encode into that UB, and rides the snap variant on
//      `derivedCommands.snapping.snapCommand`.
//   3. `ensureEdgeEmitterSnapPipeline` stamps the payload FORMAT + log axis
//      onto the pipeline (draw-time attachment validation — the FORK-34
//      failure shape — makes a drift here silently fatal).
//   4. `WebGPUSceneRendererPickPass` dispatches the two edge passes in the
//      payload phase WITHOUT loosening the strict resolved-snap-variant
//      admission.
//
// This spec pins all four in plain Node, with no device, plus the accepted
// reviewer-B sub-pixel fix in `Snapping.captureSnapView`.
//
// WHAT IT PINS
// ------------
//   A. ENCODING — the edge flag is set unconditionally and survives the
//      sign-bit pack round-trip through the REAL `WebGPUSnapPayload` encode /
//      decode, the uint32 repack helper is byte-identical to the model's, the
//      depth varying is camera-relative (the RTE law), and the composed WGSL
//      NAGA-VALIDATES in both pick-fleet log states — the only device-free
//      proof the new fragment entry compiles.
//   B. PICK-COLOR PLUMB — `writeEdgeEmitterUniforms` is driven LIVE against a
//      stub device to pin the six new UB floats, and the model renderer is
//      pinned to reuse `ensurePickId`'s per-primitive color rather than
//      minting a parallel ID.
//   C. PIPELINE VARIANT — `ensureEdgeEmitterSnapPipeline` is driven LIVE
//      against a stub device: payload format from the ONE home, both
//      descriptor-name axes, log-variant rebuild + cache hit, and invalidation
//      from the base ensure and from teardown.
//   D. ADMISSION — the strict resolved-snap-variant guard is unchanged, the
//      two edge passes join at the TAIL of the payload phase and nowhere in
//      the occluder phase, and a live oracle shows that either way of
//      loosening the guard invalidates the whole snap command buffer (FORK-34)
//      and loses the real edge hit too.
//   E. ARBITRATION + SUB-PIXEL — `selectBestHit`, `captureSnapView`, and
//      `snapHitToScreenPosition` are lifted verbatim out of `Snapping.js` and
//      EXECUTED (the module itself cannot be imported in plain Node: its
//      transitive `View.js` → `GlobeDepth.js` chain reaches build-generated
//      shader leaves). Mutations re-introduce the two defects — a dead isEdge
//      preference, and the dropped half-pixel term.
//
// Every section carries at least one MUTATION test, so no clean result here is
// unfalsifiable.
//
// Run: node --test Tools/visual-regression/webgpu-snap-edge-payload.spec.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { enableEngineTsResolution } from "./lib/engine-ts-resolver.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(directory, "../..");
const engineWebGPU = resolve(
  repoRoot,
  "packages/engine/Source/Renderer/WebGPU",
);
const engineScene = resolve(repoRoot, "packages/engine/Source/Scene");
const engineShadersWGPU = resolve(
  repoRoot,
  "packages/engine/Source/Shaders/WebGPU",
);

enableEngineTsResolution();

const {
  SNAP_PAYLOAD_FORMAT,
  SNAP_EDGE_BIT,
  SNAP_DEPTH_BITS,
  decodeSnapHits,
  packSnapDepthAndEdge,
  unpackSnapDepth,
  unpackSnapIsEdge,
} = await import(
  pathToFileURL(resolve(engineWebGPU, "WebGPUSnapPayload.ts")).href
);
const emitter = await import(
  pathToFileURL(resolve(engineWebGPU, "WebGPUEdgeVisibilityEmitter.ts")).href
);
const { ShaderDefine } = await import(
  pathToFileURL(resolve(engineWebGPU, "WebGPUShaderDefines.ts")).href
);
const { preprocess } = await import(
  pathToFileURL(resolve(engineWebGPU, "WebGPUShaderPreprocessor.ts")).href
);

// Normalize CRLF: the repo checks out with Windows line endings, and several
// assertions below are exact multi-line substrings.
const read = (path) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

const emitterSrc = read(
  resolve(engineWebGPU, "WebGPUEdgeVisibilityEmitter.ts"),
);
const modelRendererSrc = read(resolve(engineWebGPU, "WebGPUModelRenderer.ts"));
const pickPassSrc = read(
  resolve(engineWebGPU, "WebGPUSceneRendererPickPass.ts"),
);
const sceneRendererSrc = read(resolve(engineWebGPU, "WebGPUSceneRenderer.ts"));
const snappingSrc = read(resolve(engineScene, "Snapping.js"));
const modelWgsl = read(
  resolve(engineShadersWGPU, "Model/ModelPBRComplete.wgsl"),
);

/** Collapse whitespace so a source assertion survives reformatting. */
function squash(text) {
  return text.replace(/\s+/g, " ").trim();
}

/** Extract the emitter's embedded WGSL (raw, pre-preprocess). */
function emitterWgsl(source) {
  const marker = "const EDGE_EMITTER_WGSL = /* wgsl */ `";
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, "EDGE_EMITTER_WGSL literal not found");
  const open = start + marker.length;
  const close = source.indexOf("\n`;", open);
  assert.notEqual(close, -1, "EDGE_EMITTER_WGSL literal never closed");
  return source.slice(open, close);
}

/** Extract the body of a named WGSL or TS function/block by brace matching. */
function block(source, header) {
  const start = source.indexOf(header);
  assert.notEqual(start, -1, `block not found: ${header}`);
  const open = source.indexOf("{", start);
  assert.notEqual(open, -1, `block has no body: ${header}`);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) {
        return source.slice(start, i + 1);
      }
    }
  }
  assert.fail(`block never closed: ${header}`);
}

/**
 * The A-family validator, shared with the mutation test so its clean result is
 * falsifiable: the edge snap entry must write the pick key and the
 * edge-flagged depth word with exactly the shared constants' bit values.
 */
function validateEdgeSnapEncode(source) {
  const wgsl = emitterWgsl(source);
  const snap = squash(block(wgsl, "fn fragmentSnapMain("));
  assert.match(
    snap,
    /let depthBits = bitcast<u32>\(input\.eyeDepth\) & 0x7fffffffu;/,
    "the depth word must carry the eye depth's f32 bits with the sign bit cleared",
  );
  assert.match(
    snap,
    /out\.payload = vec2<u32>\( rgba8UnormToUint32\(edge\.pickColor\), depthBits \| 0x80000000u, \);/,
    "the edge flag must be SET unconditionally — every fragment of this pipeline IS an edge",
  );
}

// ─── A. ENCODING ─────────────────────────────────────────────────────────────

test("A1: the emitter snap entry writes the edge-flagged two-word payload", () => {
  validateEdgeSnapEncode(emitterSrc);
  // The WGSL hex masks are the SAME bits the TS decode home exports.
  assert.equal(SNAP_EDGE_BIT, 0x80000000);
  assert.equal(SNAP_DEPTH_BITS, 0x7fffffff);
});

test("A2: the emitter's uint32 repack helper is byte-parallel to the model's", () => {
  const emitterHelper = squash(
    block(emitterWgsl(emitterSrc), "fn rgba8UnormToUint32("),
  );
  const modelHelper = squash(block(modelWgsl, "fn rgba8UnormToUint32("));
  assert.equal(
    emitterHelper,
    modelHelper,
    "two copies of the pick-key repack must not drift — both must match the GLSL snapHelperSource byte math",
  );
});

test("A3: fragmentSnapMain keeps fragmentMain's dash-gap discard semantics", () => {
  const wgsl = emitterWgsl(emitterSrc);
  const grabDiscard = (entry) => {
    const body = block(wgsl, entry);
    const start = body.indexOf("let pattern = u32(edge.params.w);");
    assert.notEqual(start, -1, `${entry} lost the dash-pattern gate`);
    const end = body.indexOf("}", body.indexOf("discard;", start));
    return squash(body.slice(start, end));
  };
  // A dash-gap pixel is not an edge candidate, exactly as it is not an edge
  // color fragment. (The silhouette discard needs no per-entry twin: it lives
  // in the shared vertexMain as the w = 0 clip-reject.)
  assert.equal(
    grabDiscard("fn fragmentSnapMain("),
    grabDiscard("fn fragmentMain("),
  );
  assert.match(
    block(wgsl, "fn vertexMain("),
    /out\.position = vec4<f32>\(0\.0, 0\.0, 0\.0, 0\.0\);/,
    "the shared silhouette clip-reject must still exist",
  );
});

test("A4: the eye-depth source is the camera-relative VS varying", () => {
  const wgsl = emitterWgsl(emitterSrc);
  const vs = block(wgsl, "fn vertexMain(");
  assert.match(
    vs,
    /let curEye = \(camera\.modelView \* vec4<f32>\(input\.position, 1\.0\)\)\.xyz;/,
  );
  assert.match(
    vs,
    /out\.eyeDepth = -curEye\.z;/,
    "the payload depth must be positive linear eye-space depth (camera-relative — the RTE law), matching the model snap's -v_positionEC.z",
  );
  // The log frag_depth reconstruction rides fragCoord.w (clip.w), the fleet's
  // csm_vertexLogDepth axis, and only under the LOG_DEPTH define.
  const snap = block(wgsl, "fn fragmentSnapMain(");
  assert.match(
    squash(snap),
    /\/\/>>ifdef LOG_DEPTH[\s\S]*out\.depth = log2\(\(1\.0 \/ input\.position\.w - edge\.snapLogDepth\.y\) \+ 1\.0\) \* edge\.snapLogDepth\.x;[\s\S]*\/\/>>endif/,
  );
});

test("A5: the edge flag survives the sign-bit pack round-trip", () => {
  // The exact CPU twin of what the shader writes: positive eye depth bits,
  // sign bit forced on. Decode must recover BOTH fields intact.
  for (const depth of [0.0009765625, 1.0, 24.8, 6378137.0]) {
    const word = packSnapDepthAndEdge(depth, true);
    assert.equal(unpackSnapIsEdge(word), true);
    assert.equal(unpackSnapDepth(word), Math.fround(depth));
    assert.equal(
      (word ^ packSnapDepthAndEdge(depth, false)) >>> 0,
      SNAP_EDGE_BIT,
      "edge and surface words for one depth must differ in exactly the sign bit",
    );
  }
  // And through the full spiral decode, the way Snapping receives it.
  const registry = {
    getObjectByPickColor: (key) => (key > 0 ? { key } : undefined),
  };
  const pixels = new Uint32Array(2);
  pixels[0] = 7;
  pixels[1] = packSnapDepthAndEdge(24.8, true);
  const hits = decodeSnapHits(registry, pixels, 1, 1);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].isEdge, true);
  assert.equal(hits[0].depth, Math.fround(24.8));
});

test("A6 (mutation): clearing the edge OR must fail the encode validator", () => {
  const mutated = emitterSrc.replace(
    "depthBits | 0x80000000u,",
    "depthBits | 0u,",
  );
  assert.notEqual(mutated, emitterSrc, "mutation did not apply");
  assert.throws(
    () => validateEdgeSnapEncode(mutated),
    "an edge writer that drops the flag must be caught by A1's validator",
  );
});

test("A7: the emitter WGSL naga-validates in both pick-fleet log states", async () => {
  // The only device-free proof the new entry actually compiles. The emitter
  // shader is self-contained (no chunk composition), so preprocess + validate.
  const nagaDirectory = resolve(
    repoRoot,
    "Tools/shader-pipeline/naga-wasm-tools",
  );
  const naga = await import(
    pathToFileURL(resolve(nagaDirectory, "naga_wasm_tools.js")).href
  );
  await naga.default({
    module_or_path: readFileSync(
      resolve(nagaDirectory, "naga_wasm_tools_bg.wasm"),
    ),
  });

  const wgsl = emitterWgsl(emitterSrc);
  for (const [name, defines] of [
    ["defines=0 (pick-fleet log off)", 0],
    ["LOG_DEPTH (pick-fleet log on)", ShaderDefine.LOG_DEPTH],
  ]) {
    const processed = preprocess(wgsl, defines >>> 0);
    assert.ok(
      processed.includes("fn fragmentSnapMain("),
      `${name}: the snap entry must survive preprocessing`,
    );
    const hasFragDepth = processed.includes("@builtin(frag_depth)");
    assert.equal(
      hasFragDepth,
      defines !== 0,
      `${name}: frag_depth must exist exactly when LOG_DEPTH is active`,
    );
    assert.doesNotThrow(
      () => naga.validate_wgsl(processed),
      `${name}: emitter WGSL failed naga validation`,
    );
  }
});

// ─── B. PICK-COLOR PLUMB ─────────────────────────────────────────────────────

test("B1 (live): writeEdgeEmitterUniforms packs the snap lanes at floats 8..13", () => {
  const writes = new Map();
  const device = {
    queue: {
      writeBuffer(buffer, offset, data) {
        assert.equal(offset, 0);
        writes.set(buffer, Float32Array.from(data));
      },
    },
  };
  const cameraBuffer = { label: "camera" };
  const edgeBuffer = { label: "edge" };
  const resources = { cameraBuffer, edgeBuffer };
  const mvp = new Float32Array(16).fill(2);
  const mv = new Float32Array(16).fill(3);

  emitter.writeEdgeEmitterUniforms(
    device,
    resources,
    mvp,
    mv,
    { r: 0.1, g: 0.2, b: 0.3, a: 0.4 },
    800,
    600,
    2,
    0xffff,
    { red: 1, green: 0.5, blue: 0.25, alpha: 0.125 },
    0.0625,
    1.5,
  );
  const edgeData = writes.get(edgeBuffer);
  assert.equal(edgeData.length, 16, "EdgeUniforms is 4 vec4 = 16 floats");
  assert.deepEqual(
    Array.from(edgeData.subarray(8, 14)),
    [1, 0.5, 0.25, 0.125, 0.0625, 1.5],
    "floats 8..11 = pickColor RGBA, 12 = log factor, 13 = log near",
  );
  // Historical lanes are unchanged.
  assert.deepEqual(
    Array.from(edgeData.subarray(0, 8)).map((v) => Math.fround(v)),
    [0.1, 0.2, 0.3, 0.4, 800, 600, 2, 0xffff].map((v) => Math.fround(v)),
  );

  // No pick ID → zero pick color → decodes as pick key 0 = "no object", so an
  // ID-less edge can never claim a snap hit.
  emitter.writeEdgeEmitterUniforms(
    device,
    resources,
    mvp,
    mv,
    { r: 0, g: 0, b: 0, a: 1 },
    800,
    600,
    2,
    0xffff,
    null,
    0,
    0,
  );
  const nullData = writes.get(edgeBuffer);
  assert.deepEqual(Array.from(nullData.subarray(8, 12)), [0, 0, 0, 0]);
  const registry = {
    getObjectByPickColor: (key) => (key > 0 ? { key } : undefined),
  };
  const pixels = new Uint32Array([0, packSnapDepthAndEdge(10, true)]);
  assert.deepEqual(decodeSnapHits(registry, pixels, 1, 1), []);
});

test("B2: the WGSL UB layout matches the packed floats", () => {
  const wgsl = emitterWgsl(emitterSrc);
  const struct = squash(block(wgsl, "struct EdgeUniforms"));
  // Field ORDER pins the byte offsets (color 0, params 16, pickColor 32,
  // snapLogDepth 48) that B1's float indices 0/4/8/12 write to.
  assert.match(
    struct,
    /color: vec4<f32>,[\s\S]*params: vec4<f32>,[\s\S]*pickColor: vec4<f32>,[\s\S]*snapLogDepth: vec4<f32>, \}/,
  );
  // The buffer allocation matches the 64-byte struct.
  assert.match(
    squash(emitterSrc),
    /label: "EdgeEmitter-EdgeUniforms", size: 64,/,
  );
  // And the snap entry reads the pick color through the shared repack helper.
  assert.match(
    block(wgsl, "fn fragmentSnapMain("),
    /rgba8UnormToUint32\(edge\.pickColor\)/,
  );
});

test("B3: the model renderer reuses ensurePickId — no parallel ID path", () => {
  const squashed = squash(modelRendererSrc);
  // The pick color fed to the edge UB is the SAME per-glTF-primitive pick ID
  // the surface pick/snap draws use (Batch 819 native caching, keyed
  // nodeIdx_primIdx via `idKey: primKey`).
  assert.match(squashed, /const pickColor = modelPickId\?\.color;/);
  assert.match(squashed, /idKey: primKey,/);
  assert.match(
    squashed,
    /linePattern, pickColor \?\? null, snapLogFactor, snapLogNear, \);/,
    "writeEdgeEmitterUniforms must receive the primitive's pick color",
  );
  // The snap log lanes come from the ONE derivation home.
  assert.match(
    squashed,
    /packCameraLogDepthLanes\(scratchEdgeLogLanes, 0, us\); const snapLogFactor = scratchEdgeLogLanes\[CAMERA_LOG_FACTOR_FLOAT\]; const snapLogNear = scratchEdgeLogLanes\[CAMERA_LOG_NEAR_FLOAT\];/,
  );
  // The edge block must not MINT its own pick ID — it may only NAME the
  // shared allocator in prose, so strip line comments before the check
  // (the block's own rationale comment cites `ensurePickId` by name).
  const edgeBlockStart = modelRendererSrc.indexOf(
    "const edgeGltfPrimitive = rp.primitive || rp._primitive;",
  );
  assert.ok(edgeBlockStart > 0, "edge block anchor not found");
  const edgeBlock = modelRendererSrc
    .slice(
      edgeBlockStart,
      modelRendererSrc.indexOf(
        "attachSnapToColorCommand(edgeCmd, edgeSnapCmd);",
      ),
    )
    .replace(/\/\/[^\n]*/g, "");
  assert.ok(
    edgeBlock.includes("writeEdgeEmitterUniforms("),
    "the stripped edge block must still contain the code under test",
  );
  assert.doesNotMatch(edgeBlock, /\b(createPickId|ensurePickId)\s*\(/);
});

test("B3b (mutation): minting a second pick ID inside the edge block must fail B3", () => {
  // The B3 comment-strip must not have turned the guard into a tautology.
  const mutated = modelRendererSrc.replace(
    "          writeEdgeEmitterUniforms(",
    "          const edgeOwnPickId = ensurePickId(context, model);\n          writeEdgeEmitterUniforms(",
  );
  assert.notEqual(mutated, modelRendererSrc, "mutation did not apply");
  const edgeBlockStart = mutated.indexOf(
    "const edgeGltfPrimitive = rp.primitive || rp._primitive;",
  );
  const edgeBlock = mutated
    .slice(
      edgeBlockStart,
      mutated.indexOf("attachSnapToColorCommand(edgeCmd, edgeSnapCmd);"),
    )
    .replace(/\/\/[^\n]*/g, "");
  assert.match(edgeBlock, /\b(createPickId|ensurePickId)\s*\(/);
});

test("B4: the edge snap command is snap-mini-frame-only and rides the snapping slot", () => {
  const squashed = squash(modelRendererSrc);
  assert.match(
    squashed,
    /if \(frameState\?\.passes\?\.snap === true && pickColor\) \{ const edgeSnapPipeline = ensureEdgeEmitterSnapPipeline\( cache\.edgeEmitterCache, device, isWebGPUPickLogDepthActive\(/,
    "materialization must be gated on the CURRENT snap pass AND a real pick ID",
  );
  assert.match(
    squashed,
    /pickOnly: true, \.\.\.nonColorShadowFlags, \}\); attachSnapToColorCommand\(edgeCmd, edgeSnapCmd\);/,
    "the edge snap variant must ride derivedCommands.snapping.snapCommand — the ONLY key the payload-phase admission resolves",
  );
});

test("B5 (mutation): severing the pick-color plumb must fail B3", () => {
  const mutated = modelRendererSrc.replace(
    "pickColor ?? null,\n            snapLogFactor,",
    "null,\n            snapLogFactor,",
  );
  assert.notEqual(mutated, modelRendererSrc, "mutation did not apply");
  assert.doesNotMatch(
    squash(mutated),
    /linePattern, pickColor \?\? null, snapLogFactor, snapLogNear, \);/,
  );
});

// ─── C. PIPELINE VARIANT ─────────────────────────────────────────────────────

test("C1 (live): the snap pipeline carries both axes and the shared format", () => {
  const captured = [];
  const device = {
    createShaderModule: (desc) => ({ label: desc.label, code: desc.code }),
    createRenderPipeline: (desc) => {
      captured.push(desc);
      return { label: desc.label };
    },
  };
  const cache = emitter.createEdgeEmitterCache();
  cache.device = device;
  cache.pipelineLayout = { label: "layout" };

  const base = emitter.ensureEdgeEmitterSnapPipeline(cache, device, false);
  assert.ok(base, "snap pipeline must build once the base ensure ran");
  const log = emitter.ensureEdgeEmitterSnapPipeline(cache, device, true);
  assert.equal(captured.length, 2, "a log-axis flip must rebuild");
  assert.equal(
    emitter.ensureEdgeEmitterSnapPipeline(cache, device, true),
    log,
    "same axis must be a cache hit",
  );

  const [baseDesc, logDesc] = captured;
  for (const desc of captured) {
    assert.deepEqual(desc.fragment.targets, [{ format: SNAP_PAYLOAD_FORMAT }]);
    assert.equal(desc.fragment.entryPoint, "fragmentSnapMain");
    assert.deepEqual(desc.depthStencil, {
      // WebGPUSnapFramebuffer's shared depth attachment. less-equal +
      // depth-write matches the model snap family, so an edge lying exactly
      // on its surface's silhouette wins the tie when drawn after it.
      format: "depth24plus-stencil8",
      depthWriteEnabled: true,
      depthCompare: "less-equal",
    });
    assert.equal(
      desc.multisample,
      undefined,
      "the payload pass is single-sample regardless of scene MSAA",
    );
    assert.ok(desc.label.includes(`[sf=${SNAP_PAYLOAD_FORMAT}]`));
  }
  assert.ok(!baseDesc.label.includes("[ld]"));
  assert.ok(logDesc.label.includes("[ld]"), "log axis must mark the label");
  // The log module really is the LOG_DEPTH-preprocessed variant.
  assert.ok(!baseDesc.fragment.module.code.includes("@builtin(frag_depth)"));
  assert.ok(logDesc.fragment.module.code.includes("@builtin(frag_depth)"));
  assert.notEqual(baseDesc.fragment.module, logDesc.fragment.module);
  // Vertex stage follows the module so inter-stage interfaces always agree.
  assert.equal(baseDesc.vertex.module, baseDesc.fragment.module);
  assert.equal(logDesc.vertex.module, logDesc.fragment.module);
});

test("C2: the emitter never spells the payload format literal", () => {
  assert.match(
    emitterSrc,
    /import \{ SNAP_PAYLOAD_FORMAT \} from "\.\/WebGPUSnapPayload\.js";/,
  );
  assert.ok(
    !emitterSrc.includes('"rg32uint"'),
    "the emitter must read the ONE format home, not restate it",
  );
  // Direct create hatch, never the central pipeline cache (name aliasing is
  // structurally impossible — same rule as the model snap family).
  const ensure = block(
    emitterSrc,
    "export function ensureEdgeEmitterSnapPipeline(",
  );
  assert.match(ensure, /device\.createRenderPipeline\(\{/);
  assert.doesNotMatch(ensure, /getPipeline(Sync)?\(|centralDesc/);
});

test("C3: base-pipeline rebuilds invalidate the snap variant", () => {
  const ensureBase = block(
    emitterSrc,
    "export function ensureEdgeEmitterPipeline(",
  );
  assert.match(
    ensureBase,
    /cache\.pipelineSnap = null;/,
    "a device/format/sampleCount rebuild must drop the snap pipeline too",
  );
  // And teardown clears it with the rest.
  const destroy = block(emitterSrc, "export function destroyEdgeEmitterCache(");
  assert.match(destroy, /cache\.pipelineSnap = null;/);
});

// ─── D. ADMISSION + PASS ROUTING ─────────────────────────────────────────────

test("D1: the strict resolved-snap-variant admission is unchanged", () => {
  const body = pickPassSrc.slice(
    pickPassSrc.indexOf("function executeSnapPayloadBatch("),
    pickPassSrc.indexOf("function executePickBatch("),
  );
  assert.match(body, /selectCommandVariant\(command, scene, true, true\)/);
  assert.match(
    squash(body),
    /if \(dispatched === command \|\| dispatched\.isWebGPUDrawCommand !== true\) \{ continue; \}/,
    "edges must join through the snapping slot, NOT through a loosened guard",
  );
  assert.doesNotMatch(body, /pickOnly/);
  assert.doesNotMatch(body, /_isPickCommand/);
});

test("D2: the payload phase visits both edge passes, last", () => {
  const phase = pickPassSrc.slice(
    pickPassSrc.indexOf("if (snapMode) {"),
    pickPassSrc.indexOf("completed = true;"),
  );
  const order = [
    "Pass.GLOBE",
    "Pass.CESIUM_3D_TILE,",
    "Pass.VOXELS",
    "Pass.OPAQUE",
    "Pass.GAUSSIAN_SPLATS",
    "Pass.TRANSLUCENT",
    "Pass.CESIUM_3D_TILE_EDGES,",
    "Pass.CESIUM_3D_TILE_EDGES_DIRECT,",
  ];
  let previous = -1;
  for (const pass of order) {
    const index = phase.indexOf(pass);
    assert.ok(index !== -1, `payload phase skips ${pass}`);
    assert.ok(
      index > previous,
      `${pass} out of order — edges must draw last so their less-equal tie against their own surface's depth stamps the edge-flagged payload`,
    );
    previous = index;
  }
  // The occluder phase must NOT visit the edge passes: edge color commands
  // carry no pick variant, and their pipelines target scene/MRT attachments.
  const occluder = pickPassSrc.slice(
    pickPassSrc.indexOf("// GLOBE pass"),
    pickPassSrc.indexOf("} finally {"),
  );
  assert.doesNotMatch(occluder, /CESIUM_3D_TILE_EDGES/);
});

test("D3: edges add no new selectCommandVariant call site", () => {
  // Mirrors the base spec's I2: exactly ONE 4-argument call site (the payload
  // batch executor) across the scene renderer and the pick pass. The edge
  // batches reuse executeSnapPayloadBatch rather than dispatching themselves.
  const callSites = [
    ...sceneRendererSrc.matchAll(/[^\w]selectCommandVariant\(([^)]*)\)/g),
    ...pickPassSrc.matchAll(/[^\w]selectCommandVariant\(([^)]*)\)/g),
  ]
    .filter((match) => !/:/.test(match[1]))
    .map((match) => match[1].split(",").length);
  assert.equal(callSites.filter((count) => count === 4).length, 1);
});

test("D4 (live + mutation): the admission oracle kills FORK-34 regressions", () => {
  // The predicate, re-derived from the source line D1 pinned. A dispatched
  // pipeline whose color-target format differs from the pass's attachment
  // invalidates the WHOLE command buffer at draw time — that is the oracle.
  const admit = (command, dispatched) =>
    !(dispatched === command || dispatched.isWebGPUDrawCommand !== true);

  const runPayloadPass = (admissionPredicate, commands) => {
    let invalidated = false;
    let edgeHits = 0;
    for (const command of commands) {
      const dispatched = command.derivedCommands?.snapping?.snapCommand
        ? command.derivedCommands.snapping.snapCommand
        : command;
      if (!admissionPredicate(command, dispatched)) {
        continue;
      }
      if (dispatched.targetFormat !== SNAP_PAYLOAD_FORMAT) {
        invalidated = true; // FORK-34: every draw in the buffer is discarded.
      }
      edgeHits++;
    }
    return { invalidated, edgeHits: invalidated ? 0 : edgeHits };
  };

  const edgeWithSnap = {
    targetFormat: "bgra8unorm",
    pickOnly: false,
    derivedCommands: {
      snapping: {
        snapCommand: {
          isWebGPUDrawCommand: true,
          targetFormat: SNAP_PAYLOAD_FORMAT,
        },
      },
    },
  };
  const edgeWithoutSnap = { targetFormat: "bgra8unorm", pickOnly: false };
  const legacyPickOnly = {
    targetFormat: "rgba8unorm",
    pickOnly: true,
    isWebGPUDrawCommand: false,
  };
  const commands = [edgeWithSnap, edgeWithoutSnap, legacyPickOnly];

  // Correct admission: exactly the resolved edge snap variant draws.
  assert.deepEqual(runPayloadPass(admit, commands), {
    invalidated: false,
    edgeHits: 1,
  });

  for (const [name, mutant] of [
    // Fall through to the base command (the pre-FORK-34 WebGL behavior).
    ["base fall-through", () => true],
    // Admit dedicated pick commands like the occluder batch does.
    [
      "pickOnly admission",
      (command, dispatched) =>
        command.pickOnly === true || admit(command, dispatched),
    ],
  ]) {
    const result = runPayloadPass(mutant, commands);
    assert.equal(
      result.invalidated,
      true,
      `${name}: dispatching a non-payload pipeline must invalidate the buffer`,
    );
    assert.equal(
      result.edgeHits,
      0,
      `${name}: the invalidated buffer loses the REAL edge hit too`,
    );
  }
});

// ─── E. ARBITRATION + SUB-PIXEL FIX ──────────────────────────────────────────

// `Snapping.js` cannot be imported in plain Node — its transitive `View.js` →
// `GlobeDepth.js` chain reaches build-generated `Source/Shaders/**.js` leaves
// that only exist after a gulp build (the same pre-existing TS2307 class the
// package tsc gate tolerates). The three functions this section covers are
// dependency-free arithmetic, so instead of RE-IMPLEMENTING them (the CPU-twin
// drift trap the resolver's own docstring warns about) the spec lifts their
// REAL source text out of the file and instantiates it with injected stubs.
// Every assertion below therefore runs the shipped code, and each mutation
// runs the shipped code with exactly one defect re-introduced.

/** Extract a top-level `const NAME = …;` declaration verbatim. */
function constLine(source, name) {
  const match = source.match(new RegExp(`^const ${name} = [^;]*;`, "m"));
  assert.ok(match, `const not found: ${name}`);
  return match[0];
}

/** Instantiate real Snapping.js source text with injected dependencies. */
function instantiate(sourceText, returnExpression, deps = {}) {
  const names = Object.keys(deps);
  // Compiling the SHIPPED function text is the point: a re-implementation here
  // would be the CPU twin that drifts. Same contract as
  // `mat-logdepth-encode-stash.spec.mjs`'s `compileTail`.
  // eslint-disable-next-line no-new-func
  const factory = new Function(
    ...names,
    `${sourceText}\nreturn ${returnExpression};`,
  );
  return factory(...names.map((name) => deps[name]));
}

/** The real arbitration policy, lifted whole from Snapping.js. */
function makeSelectBestHit(source) {
  return instantiate(
    [
      constLine(source, "SNAP_OCCLUDER_RADIUS_PIXELS"),
      constLine(source, "SNAP_OCCLUSION_TOLERANCE"),
      block(source, "function cursorDist(hit)"),
      block(source, "function selectBestHit(hits)"),
    ].join("\n"),
    "selectBestHit",
  );
}

/** The real capture + screen-position pair, lifted whole from Snapping.js. */
function makeCaptureSnapView(source) {
  class StubPerspectiveFrustum {}
  class StubPerspectiveOffCenterFrustum {}
  return instantiate(
    block(
      source,
      "function captureSnapView(scene, windowPosition, drawingBufferRectangle)",
    ),
    "captureSnapView",
    {
      defined: (value) => value !== undefined && value !== null,
      PerspectiveFrustum: StubPerspectiveFrustum,
      PerspectiveOffCenterFrustum: StubPerspectiveOffCenterFrustum,
      SceneMode: { SCENE2D: 2 },
      MapMode2D: { INFINITE_SCROLL: 1 },
    },
  );
}

/** A 300x200 CSS canvas over a 600x400 drawing buffer (DPR 2). */
function makeSnapScene() {
  return {
    camera: {
      positionWC: { x: 1, y: 2, z: 3 },
      directionWC: { x: 0, y: 0, z: -1 },
      rightWC: { x: 1, y: 0, z: 0 },
      upWC: { x: 0, y: 1, z: 0 },
      frustum: { aspectRatio: 2, fov: 1, fovy: 0.5, near: 0.25, far: 1000 },
      _maxCoord: { x: 10, y: 10, z: 0 },
    },
    canvas: { clientWidth: 300, clientHeight: 200 },
    drawingBufferWidth: 600,
    drawingBufferHeight: 400,
    defaultView: { viewport: { x: 4, y: 5, width: 600, height: 400 } },
    frameState: { frameNumber: 7 },
    mode: 3,
    mapMode2D: 1,
  };
}

test("E1 (live): the edge-over-surface preference the edge tier activates", () => {
  const selectBestHit = makeSelectBestHit(snappingSrc);
  const surface = { isEdge: false, depth: 10.0, x: 0, y: 0, object: "surface" };

  // A visible edge just behind the occluder (within the 10% tolerance)
  // outranks the surface the cursor is on. THIS is the behavior the WebGPU
  // edge tier makes reachable — before it, no WebGPU hit ever set isEdge.
  assert.equal(
    selectBestHit([surface, { isEdge: true, depth: 10.5, x: 2, y: 0 }]).isEdge,
    true,
  );
  // An edge past the tolerance is treated as occluded and loses.
  assert.equal(
    selectBestHit([surface, { isEdge: true, depth: 12.0, x: 2, y: 0 }]).object,
    "surface",
  );
  // Within the winning group, the hit closest to the crosshair wins.
  assert.equal(
    selectBestHit([
      surface,
      { isEdge: true, depth: 10.1, x: 5, y: 0, object: "far edge" },
      { isEdge: true, depth: 10.2, x: 1, y: 0, object: "near edge" },
    ]).object,
    "near edge",
  );
  // All-surface input (the pre-edge-tier WebGPU reality) still resolves.
  assert.equal(
    selectBestHit([surface, { isEdge: false, depth: 9.0, x: 4, y: 0 }]).object,
    "surface",
  );
});

test("E1b (mutation): killing the isEdge preference must change the winner", () => {
  // Re-introduces the pre-UP144-SNAP-WEBGPU-EDGES symptom — every hit reads as
  // a surface — inside the REAL arbitration source.
  const mutated = snappingSrc.replace(
    "const wantEdge = visible.some((hit) => hit.isEdge);",
    "const wantEdge = false;",
  );
  assert.notEqual(mutated, snappingSrc, "mutation did not apply");
  const hits = [
    { isEdge: false, depth: 10.0, x: 0, y: 0, object: "surface" },
    { isEdge: true, depth: 10.5, x: 2, y: 0, object: "edge" },
  ];
  assert.equal(makeSelectBestHit(snappingSrc)(hits).object, "edge");
  assert.equal(makeSelectBestHit(mutated)(hits).object, "surface");
});

test("E2 (live): captureSnapView converts integer sample centers at the pixel center", () => {
  const captureSnapView = makeCaptureSnapView(snappingSrc);
  const scene = makeSnapScene();
  // The default 25x25 query. Column index = floor(8.5) + floor(25*0.5) = 20;
  // top-row index = 400 - floor(347.5) - 25 + 12 = 40. The point the payload
  // sampled is each index's pixel CENTER, so CSS = (index + 0.5) * 0.5.
  const view = captureSnapView(
    scene,
    { x: 10.25, y: 20.25 },
    { x: 8.5, y: 347.5, width: 25.0, height: 25.0 },
  );
  assert.equal(view.sampleWindowX, 10.25);
  assert.equal(view.sampleWindowY, 20.25);
  // The unsampled provenance lanes are untouched by the fix.
  assert.equal(view.windowX, 10.25);
  assert.equal(view.drawingBufferWidth, 600);
  assert.equal(Object.isFrozen(view), true);

  // No rectangle → the raw window position, unchanged (the fix is scoped to
  // the drawing-buffer sample-center conversion).
  const noRect = captureSnapView(scene, { x: 50.0, y: 50.0 }, undefined);
  assert.equal(noRect.sampleWindowX, 50.0);
  assert.equal(noRect.sampleWindowY, 50.0);
});

test("E2b (mutation): dropping the half-pixel term reintroduces the up-left bias", () => {
  const mutated = snappingSrc
    .replace(
      "(sampleCenterX + 0.5) * (canvas.clientWidth / scene.drawingBufferWidth)",
      "sampleCenterX * (canvas.clientWidth / scene.drawingBufferWidth)",
    )
    .replace(
      "(sampleCenterTopY + 0.5) *\n      (canvas.clientHeight / scene.drawingBufferHeight)",
      "sampleCenterTopY * (canvas.clientHeight / scene.drawingBufferHeight)",
    );
  assert.notEqual(mutated, snappingSrc, "mutation did not apply");
  const scene = makeSnapScene();
  const rectangle = { x: 8.5, y: 347.5, width: 25.0, height: 25.0 };
  const biased = makeCaptureSnapView(mutated)(
    scene,
    { x: 10.25, y: 20.25 },
    rectangle,
  );
  // Exactly half a drawing-buffer pixel up-left of the sampled pixel's center.
  assert.equal(biased.sampleWindowX, 10.0);
  assert.equal(biased.sampleWindowY, 20.0);
});

test("E3 (live): ray and screenPosition share the fixed sample-center origin", () => {
  // `snapHitToScreenPosition` is the ONE conversion both consumers use —
  // `getSnapPickRay` (→ snapHitToWorld → SceneSnapResult.position) calls it,
  // and `Snapping.snap` calls it again for `screenPosition`. So pinning it
  // pins both halves of "consistently for ray + screenPosition".
  const snapHitToScreenPosition = instantiate(
    block(snappingSrc, "function snapHitToScreenPosition(view, hit, result)"),
    "snapHitToScreenPosition",
  );
  const view = makeCaptureSnapView(snappingSrc)(
    makeSnapScene(),
    { x: 10.25, y: 20.25 },
    { x: 8.5, y: 347.5, width: 25.0, height: 25.0 },
  );

  // The spiral's center hit (offset 0,0) reports exactly the sample center.
  const center = snapHitToScreenPosition(view, { x: 0, y: 0 }, {});
  assert.deepEqual(center, { x: 10.25, y: 20.25 });
  // An offset hit steps by whole drawing-buffer pixels scaled to CSS (0.5).
  assert.deepEqual(snapHitToScreenPosition(view, { x: 4, y: -2 }, {}), {
    x: 12.25,
    y: 19.25,
  });
  // Both consumers read `view.sampleWindowX/Y` — never a re-derived origin.
  assert.match(
    squash(block(snappingSrc, "function getSnapPickRay(view, hit, result)")),
    /const windowPosition = snapHitToScreenPosition\( view, hit, scratchSnapWindowPosition, \);/,
  );
  assert.match(
    squash(snappingSrc),
    /const screenPosition = snapHitToScreenPosition\(view, best, new Cartesian2\(\)\);/,
  );

  // A zero-area capture is rejected rather than reporting a bogus origin.
  assert.equal(
    snapHitToScreenPosition({ ...view, canvasWidth: 0 }, { x: 0, y: 0 }, {}),
    undefined,
  );
});
