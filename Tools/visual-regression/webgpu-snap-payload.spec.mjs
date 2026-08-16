// webgpu-snap-payload.spec.mjs — browser-free contract for C11-212 /
// UP144-SNAP-WEBGPU, the WebGPU implementation of upstream v1.144's
// experimental `Scene.snap` snap-to-geometry picking.
// @purpose Contract for WebGPU Scene.snap payload: one encoding home (WebGPUSnapPayload.ts), rg32uint format agreement, spiral decode, naga validation.
// @status ACTIVE
//
// WHY THIS EXISTS
// ---------------
// The v1.144 merge (65a194d24e) landed `Scene.snap` WebGL-only. On WebGPU it was
// a structural no-op: `SceneRenderer.executeCommand`'s alternate-renderer
// early-return precedes the snap branch, `Scene.updateDerivedCommands` returns
// early for WebGPU commands, and `Scene.snap()` resolved `undefined` against an
// empty framebuffer. The WebGPU twin has to reproduce upstream's SEMANTICS
// across four modules that never see each other at runtime:
//
//   1. `ModelPBRComplete.wgsl` `fragmentSnapMain` WRITES the payload.
//   2. `WebGPUModelPipelineCache.createSnapPipeline` stamps the payload FORMAT
//      as the pipeline's color target.
//   3. `WebGPUSnapFramebuffer` allocates the ATTACHMENT and reads it back.
//   4. `Snapping.js` / `Scene.snap` consume the decoded hits.
//
// Two of those couplings fail SILENTLY-then-catastrophically rather than
// loudly. WebGPU validates a pipeline's color-target formats against the render
// pass at DRAW time, not at pipeline creation: a format drift between (2) and
// (3) does not throw when the pipeline is built — it invalidates the entire snap
// command buffer at the first draw, which is the FORK-34 failure shape (every
// query silently returns nothing). And a word-layout drift between (1) and (3)
// produces plausible-looking numbers: a pick key read out of the depth word
// still resolves to *some* registry slot often enough to look like a flaky bug
// rather than a wiring error.
//
// So the encoding gets ONE enforceable home — `WebGPUSnapPayload.ts`, which owns
// the format constant plus the two pure decode functions and has no GPU, shader,
// or Cesium-class dependency — and this spec pins both the home and the four
// consumers, in plain Node, with no device.
//
// WHAT IT PINS
// ------------
//   A. ENCODING — the WGSL writer preserves the GLSL original's decoded
//      key/edge/depth semantics while packing them into two exact uint32 words.
//      The uint32 repack helper is asserted against upstream's own
//      `PickingPipelineStage.snapIdFromPickId` and `DerivedCommand` source. A5
//      additionally NAGA-VALIDATES the composed
//      module (clustered-lighting chunk + shader, preprocessed) in both
//      pick-fleet log states — the only device-free proof that the new fragment
//      entry actually compiles.
//   B. DECODE — `decodeSnapHits` walks upstream's outward spiral, in upstream's
//      order, and lifts isEdge/depth out of the words the writer wrote them
//      into. Driven live with synthetic payloads and a stub registry.
//   C. READBACK GEOMETRY — `unpackSnapPixels` strips the 256-byte row padding
//      and zero-fills the part of a query that lies outside the attachment, so
//      an edge-of-canvas snap keeps the cursor at the spiral's center instead of
//      shifting the whole query inward.
//   D. FORMAT AGREEMENT — the pipeline target and the framebuffer attachment
//      both read the SAME constant, and that constant is exact `rg32uint`.
//      Includes a MUTATION check: break the agreement in a source copy and the
//      assertion must fail, or the clean result is unfalsifiable.
//   E. TARGET LIFECYCLE — three attachments (occluder / payload / depth), only
//      the payload is COPY_SRC, and the device-generation discipline
//      (`_attachmentDevice` + `_attachmentGeneration` + cache invalidation on
//      destroy) matches `WebGPUPickFramebuffer`'s.
//   F. VARIANT DISTINCTNESS — a snap pipeline's descriptor name can never alias
//      a pick pipeline's for the same material identity: it carries BOTH the
//      payload-format axis and the pick-fleet log-depth axis. This is the
//      `pipeline-key-aliasing.spec.mjs` convention applied to a new family. The
//      snap pipeline map is also cleared at EVERY site the pick map is, so a
//      device/format/log flip cannot leave a stale snap pipeline behind.
//   G. PASS ROUTING — the payload phase dispatches ONLY resolved snap variants;
//      a command without one is skipped rather than falling through to its pick
//      or base command (whose pipeline targets an incompatible attachment). The
//      occluder phase keeps selecting ordinary pick variants, which write the
//      depth the payload phase tests against. Before a nearer payload phase,
//      one query-scissored zero draw uses that depth to erase any stale farther
//      payload where the nearer winner is snapless.
//   H. SCENE DISPATCH — `Scene.snap` reaches the WebGPU path through the
//      backend-agnostic context factory (CLAUDE.md §2), not an `isWebGPU`
//      branch, and `passes.snap` is plumbed to both the model renderer and the
//      pass executor.
//   I. FEATURE PRESERVATION — the WebGL snap path is untouched: upstream's
//      `SnapFramebuffer`, the snap derived command, and the hit arbitration are
//      unmodified, and every non-snap `selectCommandVariant` caller keeps the
//      pre-C11-212 3-argument form (the snap axis defaults off).
//
// Run: node --test Tools/visual-regression/webgpu-snap-payload.spec.mjs

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
const engineRenderer = resolve(repoRoot, "packages/engine/Source/Renderer");
const engineScene = resolve(repoRoot, "packages/engine/Source/Scene");
const engineShadersWGPU = resolve(
  repoRoot,
  "packages/engine/Source/Shaders/WebGPU",
);

enableEngineTsResolution();

const {
  SNAP_PAYLOAD_FORMAT,
  SNAP_CHANNELS,
  SNAP_BYTES_PER_PIXEL,
  SNAP_DEPTH_BITS,
  SNAP_EDGE_BIT,
  COPY_BYTES_PER_ROW_ALIGNMENT,
  alignedSnapBytesPerRow,
  decodeSnapHits,
  packSnapDepthAndEdge,
  unpackSnapDepth,
  unpackSnapIsEdge,
  unpackSnapPixels,
} = await import(
  pathToFileURL(resolve(engineWebGPU, "WebGPUSnapPayload.ts")).href
);

// Normalize CRLF: the repo checks out with Windows line endings, and several
// assertions below are exact multi-line substrings.
const read = (path) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

const snapPayloadSrc = read(resolve(engineWebGPU, "WebGPUSnapPayload.ts"));
const snapFramebufferSrc = read(
  resolve(engineWebGPU, "WebGPUSnapFramebuffer.ts"),
);
const pickFramebufferSrc = read(
  resolve(engineWebGPU, "WebGPUPickFramebuffer.ts"),
);
const modelPipelineCacheSrc = read(
  resolve(engineWebGPU, "WebGPUModelPipelineCache.ts"),
);
const modelRendererSrc = read(resolve(engineWebGPU, "WebGPUModelRenderer.ts"));
const sceneRendererSrc = read(resolve(engineWebGPU, "WebGPUSceneRenderer.ts"));
const pickPassSrc = read(
  resolve(engineWebGPU, "WebGPUSceneRendererPickPass.ts"),
);
const pickHelpersSrc = read(
  resolve(engineWebGPU, "WebGPUPickCommandHelpers.ts"),
);
const webgpuContextSrc = read(resolve(engineWebGPU, "WebGPUContext.ts"));
const graphicsContextSrc = read(resolve(engineRenderer, "GraphicsContext.ts"));
const pickingSrc = read(resolve(engineScene, "Picking.js"));
const snappingSrc = read(resolve(engineScene, "Snapping.js"));
const snapFramebufferJsSrc = read(resolve(engineScene, "SnapFramebuffer.js"));
const derivedCommandSrc = read(resolve(engineScene, "DerivedCommand.js"));
const pickingStageSrc = read(
  resolve(engineScene, "Model/PickingPipelineStage.js"),
);
const modelWgsl = read(
  resolve(engineShadersWGPU, "Model/ModelPBRComplete.wgsl"),
);

/** The full text of `selectCommandVariant`, declaration through closing brace. */
function selectCommandVariantBody() {
  const start = sceneRendererSrc.indexOf(
    "export function selectCommandVariant(",
  );
  assert.notEqual(start, -1, "selectCommandVariant not found");
  const open = sceneRendererSrc.indexOf("): CesiumAnyDrawCommand {", start);
  assert.notEqual(open, -1, "selectCommandVariant signature changed");
  let depth = 0;
  for (
    let i = sceneRendererSrc.indexOf("{", open);
    i < sceneRendererSrc.length;
    i++
  ) {
    if (sceneRendererSrc[i] === "{") depth++;
    else if (sceneRendererSrc[i] === "}") {
      depth--;
      if (depth === 0) {
        return sceneRendererSrc.slice(start, i + 1);
      }
    }
  }
  assert.fail("selectCommandVariant never closed");
}

/** Remove line and block comments so an assertion checks CODE, not prose. */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** Collapse whitespace so a source assertion survives reformatting. */
function squash(text) {
  return text.replace(/\s+/g, " ").trim();
}

/** Extract the body of a named WGSL function or entry point. */
function wgslBlock(source, header) {
  const start = source.indexOf(header);
  assert.notEqual(start, -1, `WGSL block not found: ${header}`);
  const open = source.indexOf("{", start);
  assert.notEqual(open, -1, `WGSL block has no body: ${header}`);
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
  assert.fail(`WGSL block never closed: ${header}`);
}

// ─── A. ENCODING ─────────────────────────────────────────────────────────────

test("A1: the WGSL snap payload preserves upstream semantics in two exact words", () => {
  // Upstream's authority, read out of its own source rather than restated.
  const glslMatch = pickingStageSrc.match(
    /function snapIdFromPickId\(pickId\) \{\s*return `([^`]+)`;/,
  );
  assert.ok(glslMatch, "PickingPipelineStage.snapIdFromPickId not found");
  const glsl = squash(glslMatch[1]);
  assert.equal(
    glsl,
    "vec4(rgba8UnormToUint32(${pickId}), isEdge ? 1.0 : 0.0, -v_positionEC.z, 0.0)",
    "upstream's snap payload expression changed — re-derive the WGSL twin",
  );

  const wgsl = squash(wgslBlock(modelWgsl, "fn makeModelSnapOut("));
  // R: the repacked pick key stays uint32 rather than losing high bits through
  // upstream WebGL's implicit uint-to-f32 conversion.
  assert.match(
    wgsl,
    /out\.payload = vec2<u32>\( rgba8UnormToUint32\(pickColor\),/,
  );
  // G: the exact positive f32 eye-depth bits, with only the otherwise-clear
  // sign bit used for isEdge.
  assert.match(
    wgsl,
    /let depthBits = bitcast<u32>\(-positionEC\.z\) & 0x7fffffffu;/,
  );
  assert.match(wgsl, /depthBits \| select\(0u, 0x80000000u, isEdge\),/);
});

test("A2: the WGSL uint32 repack helper reproduces the GLSL helper's byte math", () => {
  const glslMatch = derivedCommandSrc.match(
    /const snapHelperSource = `([\s\S]*?)`;/,
  );
  assert.ok(glslMatch, "DerivedCommand.snapHelperSource not found");
  const glsl = squash(glslMatch[1]);
  assert.match(glsl, /uvec4 b = uvec4\(c \* 255\.0 \+ 0\.5\);/);
  assert.match(
    glsl,
    /return \(b\.r\) \| \(b\.g << 8u\) \| \(b\.b << 16u\) \| \(b\.a << 24u\);/,
  );

  const wgsl = squash(wgslBlock(modelWgsl, "fn rgba8UnormToUint32("));
  // Same rounding (* 255 + 0.5, truncating conversion) and same shift ladder.
  assert.match(wgsl, /let b = vec4<u32>\(c \* 255\.0 \+ 0\.5\);/);
  assert.match(
    wgsl,
    /return b\.r \| \(b\.g << 8u\) \| \(b\.b << 16u\) \| \(b\.a << 24u\);/,
  );
});

test("A3: fragmentSnapMain reproduces fragmentPickMain's discard chain", () => {
  const snap = wgslBlock(modelWgsl, "@fragment fn fragmentSnapMain(");
  const pick = wgslBlock(modelWgsl, "@fragment fn fragmentPickMain(");
  // A fragment the PICK pass discards must not become a snap candidate: a
  // clipped, split-away, alpha-masked, or batch-hidden surface is not
  // snappable. Each of these guards must appear in both entries.
  const guards = [
    /modelClipByPlanes\(input\.positionEC\) < 0\.0/,
    /modelClipByPolygon\(worldPos\)/,
    /FLAG_ALPHA_MODE_MASK[\s\S]*?baseColor\.a < material\.alphaCutoff/,
    /FLAG_ALPHA_MODE_BLEND[\s\S]*?baseColor\.a < 0\.004/,
    /batchColor\.a < 0\.004/,
    /material\._pad_end2 < 0\.0/,
  ];
  for (const guard of guards) {
    assert.match(pick, guard, `pick entry lost a guard: ${guard}`);
    assert.match(snap, guard, `snap entry is missing a pick guard: ${guard}`);
  }
  // Per-feature pick colors must win in BOTH entries, or a b3dm feature would
  // snap to its owning Model instead of the feature the pick resolves.
  assert.match(snap, /lookupFeaturePickColor\(fidInt\)/);
  assert.match(
    snap,
    /featurePickColor\.r > 0\.0 \|\| featurePickColor\.g > 0\.0 \|\| featurePickColor\.b > 0\.0/,
    "snap entry must use the RGB validity gate — pick keys below 2^24 have alpha 0",
  );
});

test("A4: the snap fragment output carries log frag_depth on the same axis as the pick output", () => {
  const snapStruct = modelWgsl.slice(
    modelWgsl.indexOf("struct SnapFragOutput"),
    modelWgsl.indexOf("struct SnapFragOutput") + 400,
  );
  // The payload pass shares the pick mini-frame's depth attachment, so the snap
  // entry must write the SAME encoding fragmentPickMain writes or the
  // less-equal test against the occluder phase's depth is incoherent.
  assert.match(snapStruct, /@location\(0\) payload: vec2<u32>,/);
  assert.match(
    snapStruct,
    /\/\/>>ifdef LOG_DEPTH\s*@builtin\(frag_depth\) depth: f32,\s*\/\/>>endif/,
  );

  const make = wgslBlock(modelWgsl, "fn makeModelSnapOut(");
  assert.match(
    make,
    /csm_writeLogDepth\(logDepth, camera\.logDepthFactor\)/,
    "snap must use the same log-depth encode as makeModelPickOut",
  );
  const pickMake = wgslBlock(modelWgsl, "fn makeModelPickOut(");
  assert.match(
    pickMake,
    /csm_writeLogDepth\(logDepth, camera\.logDepthFactor\)/,
  );
});

test("A5: the composed model shader still validates under naga in both log states", async () => {
  // The ONLY device-free proof that `fragmentSnapMain` actually compiles. It is
  // NOT enough to validate `ModelPBRComplete.wgsl` alone — the module the
  // pipeline cache builds is `substituteClusteredLightingGroup(chunk, 3)` +
  // the shader, then preprocessed; the bare file references `evalClusteredLights`
  // out of scope and fails. Reproduce that composition, then validate the two
  // variants the snap pipeline can actually request (LOG_DEPTH follows the
  // pick-fleet switch, so both states are reachable).
  const { preprocess } = await import(
    pathToFileURL(resolve(engineWebGPU, "WebGPUShaderPreprocessor.ts")).href
  );
  const { substituteClusteredLightingGroup } = await import(
    pathToFileURL(resolve(engineWebGPU, "WebGPUClusteredLightingBGL.ts")).href
  );
  const { ShaderDefine } = await import(
    pathToFileURL(resolve(engineWebGPU, "WebGPUShaderDefines.ts")).href
  );

  const clChunk = substituteClusteredLightingGroup(
    read(resolve(engineShadersWGPU, "chunks/structs/ClusteredLighting.wgsl")),
    3,
  );
  const fullSource = `${clChunk}\n${modelWgsl}`;

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

  for (const [name, defines] of [
    ["defines=0 (pick-fleet log off)", 0],
    ["LOG_DEPTH (pick-fleet log on)", ShaderDefine.LOG_DEPTH],
  ]) {
    const processed = preprocess(fullSource, defines >>> 0);
    assert.ok(
      processed.includes("fn fragmentSnapMain("),
      `${name}: the snap entry must survive preprocessing (it is ungated, like the pick entries)`,
    );
    assert.doesNotThrow(
      () => naga.validate_wgsl(processed),
      `${name}: composed model shader failed naga validation`,
    );
  }
});

// ─── B. DECODE ───────────────────────────────────────────────────────────────

/** Build a w×h RG32Uint payload; `write(x, y)` returns [key, isEdge, depth]. */
function buildPayload(width, height, write) {
  const pixels = new Uint32Array(width * height * SNAP_CHANNELS);
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const [key, isEdge, depth] = write(col, row) ?? [0, 0, 0];
      const i = SNAP_CHANNELS * (row * width + col);
      pixels[i] = key >>> 0;
      pixels[i + 1] = packSnapDepthAndEdge(depth, isEdge !== 0);
    }
  }
  return pixels;
}

/** Registry stub: key k > 0 resolves to a stable sentinel object. */
function registryStub() {
  const objects = new Map();
  return {
    getObjectByPickColor(key) {
      if (!(key > 0)) {
        return undefined;
      }
      if (!objects.has(key)) {
        objects.set(key, { key });
      }
      return objects.get(key);
    },
  };
}

test("B1: decodeSnapHits lifts key, isEdge, and depth out of the written words", () => {
  // 3x3; the center pixel (row 1, col 1) is an edge at 42 m carrying key 7.
  const pixels = buildPayload(3, 3, (x, y) =>
    x === 1 && y === 1 ? [7, 1, 42] : [0, 0, 0],
  );
  const hits = decodeSnapHits(registryStub(), pixels, 3, 3);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].object.key, 7);
  assert.equal(hits[0].isEdge, true);
  assert.equal(hits[0].depth, 42);
  assert.equal(hits[0].x, 0, "center pixel is offset (0,0) from the cursor");
  assert.equal(hits[0].y, 0);
});

test("B2: the packed sign bit carries edge without changing depth", () => {
  const surface = buildPayload(1, 1, () => [3, 0, 10]);
  const edge = buildPayload(1, 1, () => [3, 1, 10]);
  assert.equal(decodeSnapHits(registryStub(), surface, 1, 1)[0].isEdge, false);
  assert.equal(decodeSnapHits(registryStub(), edge, 1, 1)[0].isEdge, true);
});

test("B3: decodeSnapHits walks upstream's outward spiral in upstream's order", () => {
  // Every pixel is a distinct key so hit order == visit order.
  const w = 3;
  const h = 3;
  const pixels = buildPayload(w, h, (x, y) => [1 + y * w + x, 0, 1]);
  const hits = decodeSnapHits(registryStub(), pixels, w, h);
  assert.equal(
    hits.length,
    9,
    "every pixel in the region must be visited once",
  );

  // Re-derive the expected order from upstream's own algorithm
  // (Scene/SnapFramebuffer.js getSnapObjectsFromPixels), transcribed here as
  // the ORACLE — if the fork's copy diverges, this comparison fails.
  const expected = [];
  const halfWidth = Math.floor(w * 0.5);
  const halfHeight = Math.floor(h * 0.5);
  let x = 0;
  let y = 0;
  let dx = 0;
  let dy = -1;
  for (let i = 0; i < Math.max(w, h) ** 2; ++i) {
    if (
      -halfWidth <= x &&
      x <= halfWidth &&
      -halfHeight <= y &&
      y <= halfHeight
    ) {
      expected.push([x, y]);
    }
    if (x === y || (x < 0 && -x === y) || (x > 0 && x === 1 - y)) {
      const temp = dx;
      dx = -dy;
      dy = temp;
    }
    x += dx;
    y += dy;
  }
  assert.deepEqual(
    hits.map((hit) => [hit.x, hit.y]),
    expected,
  );
  assert.deepEqual(expected[0], [0, 0], "the spiral must start at the cursor");
});

test("B4: top-down WebGPU rows decode to CSS/window +y-down offsets", () => {
  const pixels = buildPayload(3, 3, (x, y) =>
    x === 1 && y === 0 ? [9, 0, 10] : [0, 0, 0],
  );
  const hits = decodeSnapHits(registryStub(), pixels, 3, 3);
  assert.equal(hits.length, 1);
  assert.deepEqual(
    [hits[0].x, hits[0].y],
    [0, -1],
    "the attachment's top row is one CSS/window pixel above the cursor",
  );
});

test("B5: a cleared payload decodes to no hits", () => {
  // Pick ids start at 1, so the cleared attachment's key 0 is 'no object'.
  const pixels = buildPayload(5, 5, () => [0, 0, 0]);
  assert.deepEqual(decodeSnapHits(registryStub(), pixels, 5, 5), []);
});

test("B6: adversarial uint32 keys and f32 depths round-trip exactly", () => {
  for (const key of [0x01000001, 0xffffffff]) {
    for (const [depth, isEdge] of [
      [0.0009765625, false],
      [6378137.0, true],
    ]) {
      const pixels = buildPayload(1, 1, () => [key, isEdge ? 1 : 0, depth]);
      const hits = decodeSnapHits(registryStub(), pixels, 1, 1);
      assert.equal(hits[0].object.key, key);
      assert.equal(hits[0].depth, Math.fround(depth));
      assert.equal(hits[0].isEdge, isEdge);
    }
  }
});

test("B7: CPU bit packing mirrors the WGSL masks", () => {
  assert.equal(SNAP_EDGE_BIT, 0x80000000);
  assert.equal(SNAP_DEPTH_BITS, 0x7fffffff);
  for (const depth of [0.0009765625, 1, 6378137.0]) {
    const surface = packSnapDepthAndEdge(depth, false);
    const edge = packSnapDepthAndEdge(depth, true);
    assert.equal(unpackSnapDepth(surface), Math.fround(depth));
    assert.equal(unpackSnapDepth(edge), Math.fround(depth));
    assert.equal(unpackSnapIsEdge(surface), false);
    assert.equal(unpackSnapIsEdge(edge), true);
    assert.equal((surface ^ edge) >>> 0, SNAP_EDGE_BIT);
  }
});

// ─── C. READBACK GEOMETRY ────────────────────────────────────────────────────

test("C1: alignedSnapBytesPerRow rounds up to WebGPU's copy alignment", () => {
  assert.equal(SNAP_CHANNELS, 2);
  assert.equal(SNAP_BYTES_PER_PIXEL, 8);
  assert.equal(COPY_BYTES_PER_ROW_ALIGNMENT, 256);
  assert.equal(alignedSnapBytesPerRow(1), 256);
  assert.equal(alignedSnapBytesPerRow(32), 256); // exactly 256 bytes
  assert.equal(alignedSnapBytesPerRow(33), 512);
  assert.equal(alignedSnapBytesPerRow(25), 256); // the default 25x25 query
});

test("C2: unpackSnapPixels strips the row padding a GPU copy adds", () => {
  const region = {
    logicalOriginX: 0,
    logicalOriginTopY: 0,
    logicalWidth: 2,
    logicalHeight: 2,
    copyOriginX: 0,
    copyOriginTopY: 0,
    copyWidth: 2,
    copyHeight: 2,
    copyOffsetX: 0,
    copyOffsetY: 0,
    attachmentGeneration: 0,
  };
  const bytesPerRow = alignedSnapBytesPerRow(2); // 256, padded from 16
  const wordsPerRow = bytesPerRow / 4;
  const mapped = new Uint32Array(wordsPerRow * 2);
  // Row 0: words 1..4; row 1: words 5..8 — everything after each row's
  // four real words is padding that must NOT survive.
  for (let i = 0; i < 4; i++) {
    mapped[i] = i + 1;
    mapped[wordsPerRow + i] = i + 5;
  }
  mapped[4] = 999; // padding sentinel
  const pixels = unpackSnapPixels(mapped, bytesPerRow, region);
  assert.equal(pixels.length, 8);
  assert.deepEqual(Array.from(pixels), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test("C3: a query clipped by a canvas edge keeps the cursor centered and zero-fills the rest", () => {
  // Logical 3x3 query whose left column and top row fall outside the
  // attachment: the copy is the bottom-right 2x2, landing at offset (1,1).
  const region = {
    logicalOriginX: -1,
    logicalOriginTopY: -1,
    logicalWidth: 3,
    logicalHeight: 3,
    copyOriginX: 0,
    copyOriginTopY: 0,
    copyWidth: 2,
    copyHeight: 2,
    copyOffsetX: 1,
    copyOffsetY: 1,
    attachmentGeneration: 0,
  };
  const bytesPerRow = alignedSnapBytesPerRow(2);
  const wordsPerRow = bytesPerRow / 4;
  const mapped = new Uint32Array(wordsPerRow * 2);
  // One hit, key 5, at the copy's top-left — logical (1,1), the query center.
  mapped[0] = 5;
  mapped[1] = packSnapDepthAndEdge(12, false);

  const pixels = unpackSnapPixels(mapped, bytesPerRow, region);
  assert.equal(pixels.length, 3 * 3 * SNAP_CHANNELS);
  // Logical row 0 and logical column 0 are outside the attachment → zero.
  for (let i = 0; i < 3 * SNAP_CHANNELS; i++) {
    assert.equal(pixels[i], 0, "clipped top row must be zero-filled");
  }
  // Logical (1,1) is the query CENTER and carries the copied hit.
  const center = SNAP_CHANNELS * (1 * 3 + 1);
  assert.equal(pixels[center], 5);
  assert.equal(unpackSnapDepth(pixels[center + 1]), 12);

  const hits = decodeSnapHits(registryStub(), pixels, 3, 3);
  assert.equal(hits.length, 1);
  assert.deepEqual([hits[0].x, hits[0].y], [0, 0], "hit is AT the cursor");
});

// ─── D. FORMAT AGREEMENT ─────────────────────────────────────────────────────

test("D1: the payload is a core exact integer format and cannot alias a pick format", () => {
  assert.equal(SNAP_PAYLOAD_FORMAT, "rg32uint");
  // The pick attachment authority clamps to 8-bit unorm; a snap payload in any
  // of those would destroy both the uint32 key and the metric depth.
  const pickFormats = ["rgba8unorm", "bgra8unorm"];
  assert.ok(!pickFormats.includes(SNAP_PAYLOAD_FORMAT));
  const clamp = pickFramebufferSrc.match(
    /return f === "bgra8unorm" \|\| f === "rgba8unorm" \? f : "rgba8unorm";/,
  );
  assert.ok(clamp, "pick format clamp changed — recheck the snap/pick split");
});

test("D2: the pipeline target and the framebuffer attachment read the same constant", () => {
  // One home.
  assert.match(
    snapPayloadSrc,
    /export const SNAP_PAYLOAD_FORMAT: GPUTextureFormat = "rg32uint";/,
  );
  // Consumer 1 — the pipeline color target.
  assert.match(
    modelPipelineCacheSrc,
    /import \{ SNAP_PAYLOAD_FORMAT \} from "\.\/WebGPUSnapPayload\.js";/,
  );
  assert.match(
    squash(modelPipelineCacheSrc),
    /this\._getOrCreatePipelineLayout\(md\), SNAP_PAYLOAD_FORMAT,/,
    "getSnapPipeline must pass the shared constant as the pipeline's snap format",
  );
  assert.match(
    squash(modelPipelineCacheSrc),
    /entryPoint: "fragmentSnapMain", targets: \[\{ format: snapFormat \}\],/,
  );
  // Consumer 2 — the attachment.
  assert.match(
    snapFramebufferSrc,
    /SNAP_PAYLOAD_FORMAT,/,
    "WebGPUSnapFramebuffer must import the shared constant",
  );
  assert.match(
    squash(snapFramebufferSrc),
    /label: "Snap payload texture", size: \[width, height\], format: SNAP_PAYLOAD_FORMAT,/,
  );
  // Neither consumer may spell the literal itself.
  assert.ok(
    !modelPipelineCacheSrc.includes('"rg32uint"'),
    "the pipeline cache must not hard-code the payload format",
  );
  assert.ok(
    !snapFramebufferSrc.includes('"rg32uint"'),
    "the framebuffer must not hard-code the payload format",
  );
});

test("D3 (mutation): breaking the format agreement must fail D2", () => {
  // Without this, D2's clean result is unfalsifiable. Simulate the exact drift
  // WebGPU would not catch until draw time: a hard-coded 16-bit target.
  const mutated = modelPipelineCacheSrc.replace(
    "SNAP_PAYLOAD_FORMAT,\n      this._depthFormat,",
    '"rgba16float",\n      this._depthFormat,',
  );
  assert.notEqual(mutated, modelPipelineCacheSrc, "mutation did not apply");
  assert.doesNotMatch(
    squash(mutated),
    /this\._getOrCreatePipelineLayout\(md\), SNAP_PAYLOAD_FORMAT,/,
  );
  assert.ok(mutated.includes('"rgba16float"'));
});

// ─── E. TARGET LIFECYCLE ─────────────────────────────────────────────────────

test("E1: the snap framebuffer allocates occluder, payload, and depth attachments", () => {
  const squashed = squash(snapFramebufferSrc);
  // Occluder — the pick fleet's own format, so the UNMODIFIED pick pipelines
  // are pass-compatible during phase 1.
  assert.match(
    squashed,
    /label: "Snap occluder color texture", size: \[width, height\], format: occluderFormat, usage: GPUTextureUsage\.RENDER_ATTACHMENT,/,
  );
  assert.match(
    snapFramebufferSrc,
    /const occluderFormat = getWebGPUPickColorFormat\(this\._context\);/,
    "the occluder attachment must use the shared pick-format authority",
  );
  // Payload — the only attachment that is read back, so the only COPY_SRC.
  assert.match(
    squashed,
    /label: "Snap payload texture",[^}]*usage: GPUTextureUsage\.RENDER_ATTACHMENT \| GPUTextureUsage\.COPY_SRC,/,
  );
  // Depth — shared by both phases; this is what carries occlusion across.
  assert.match(
    squashed,
    /label: "Snap depth texture", size: \[width, height\], format: "depth24plus-stencil8",/,
  );
});

test("E2: attachments follow the device-generation lifecycle", () => {
  // Reallocation trigger must include a device change, not just a resize:
  // a lost/replaced device invalidates every GPU object.
  assert.match(
    squash(snapFramebufferSrc),
    /const deviceChanged = device !== this\._attachmentDevice;/,
  );
  assert.match(
    squash(snapFramebufferSrc),
    /if \( width !== this\._width \|\| height !== this\._height \|\| occluderFormat !== this\._occluderFormat \|\| deviceChanged \)/,
  );
  assert.match(snapFramebufferSrc, /this\._attachmentGeneration\+\+;/);
  // An in-flight readback must not warm the cache for a replacement target.
  assert.match(
    squash(snapFramebufferSrc),
    /this\._attachmentGeneration !== region\.attachmentGeneration \|\|/,
  );
  // Destroying the textures must atomically drop pixels and their view
  // provenance with the decoded cache.
  const destroyTextures = snapFramebufferSrc.slice(
    snapFramebufferSrc.indexOf("private _destroyTextures()"),
  );
  assert.match(destroyTextures, /this\._lastReadback = null;/);
  assert.match(destroyTextures, /this\._attachmentDevice = null;/);
});

test("E2b: the coverage reset is lazy, exact-device, and records no pass", () => {
  const squashed = squash(snapFramebufferSrc);
  assert.match(
    squashed,
    /if \( this\._coverageResetPipeline === null \|\| this\._coverageResetDevice !== device \) \{/,
    "a replacement device must never reuse the old reset pipeline",
  );
  assert.match(
    squashed,
    /label: "Snap payload coverage reset pipeline", layout: "auto",/,
  );
  assert.match(squashed, /targets: \[\{ format: SNAP_PAYLOAD_FORMAT \}\],/);
  assert.match(
    squashed,
    /depthWriteEnabled: false, depthCompare: "not-equal",/,
  );
  assert.match(
    snapFramebufferSrc,
    /output\.position = vec4<f32>\(positions\[vertexIndex\], 1\.0, 1\.0\);/,
  );
  assert.match(snapFramebufferSrc, /return vec2<u32>\(0u\);/);
  const resetBody = snapFramebufferSrc.slice(
    snapFramebufferSrc.indexOf("private _resetAccumulatedPayloadCoverage("),
    snapFramebufferSrc.indexOf("private _captureReadbackRegion()"),
  );
  assert.match(squash(resetBody), /renderPass\.setPipeline\(/);
  assert.match(squash(resetBody), /renderPass\.draw\(3\);/);
  assert.doesNotMatch(resetBody, /beginRenderPass|createCommandEncoder|submit/);
});

test("E3: the snap framebuffer is allocated lazily, exactly once, by Scene.snap", () => {
  // View.js must not preallocate it — an app that never snaps pays nothing.
  const viewSrc = read(resolve(engineScene, "View.js"));
  assert.match(viewSrc, /this\.snapFramebuffer = undefined;/);
  assert.match(
    squash(viewSrc),
    /this\.snapFramebuffer = this\.snapFramebuffer && this\.snapFramebuffer\.destroy\(\);/,
    "View teardown must still destroy the snap framebuffer",
  );
  assert.match(
    snappingSrc,
    /if \(!defined\(defaultView\.snapFramebuffer\)\) \{/,
    "Snapping must keep the lazy-construction guard",
  );
});

test("E4: synchronous snap readback is ordered on the pick-frame encoder", () => {
  // The copy must be recorded after the snap render on the SAME mini-frame
  // encoder. Mapping starts only after endFrame has submitted that encoder.
  // A private submit here necessarily runs before pickEnd and reads stale data.
  const start = snapFramebufferSrc.indexOf("private _startReadback(");
  const finish = snapFramebufferSrc.indexOf(
    "private _destroyTextures()",
    start,
  );
  const body = snapFramebufferSrc.slice(start, finish);
  assert.match(body, /frameContext\.currentCommandEncoder/);
  assert.match(body, /encoder\.copyTextureToBuffer\(/);
  assert.match(body, /frameContext\.enqueueAfterFrameSubmit\(/);
  assert.ok(
    body.indexOf("encoder.copyTextureToBuffer(") <
      body.indexOf("frameContext.enqueueAfterFrameSubmit("),
    "copy must be encoded before the post-submit mapping callback is armed",
  );
  assert.match(body, /if \(!submitted\)/);
  assert.match(body, /stagingBuffer\s*\.mapAsync\(GPUMapMode\.READ\)/);
  assert.doesNotMatch(body, /createCommandEncoder\(/);
  assert.doesNotMatch(body, /queue\.submit\(/);
  assert.doesNotMatch(body, /encoder\.finish\(/);

  // endAsync records on that same active encoder as well. Its promise maps
  // only after the owning frame reports submission; it never privately submits.
  const asyncStart = snapFramebufferSrc.indexOf("async endAsync(");
  const normalizedAsyncStart =
    asyncStart === -1 ? snapFramebufferSrc.indexOf("endAsync(") : asyncStart;
  const asyncFinish = snapFramebufferSrc.indexOf(
    "private _ensureSyncStagingBuffer",
    normalizedAsyncStart,
  );
  const asyncBody = snapFramebufferSrc.slice(normalizedAsyncStart, asyncFinish);
  assert.match(asyncBody, /frameContext\.currentCommandEncoder/);
  assert.match(asyncBody, /encoder\.copyTextureToBuffer\(/);
  assert.match(asyncBody, /frameContext\.enqueueAfterFrameSubmit/);
  assert.match(asyncBody, /if \(!submitted\)/);
  assert.doesNotMatch(asyncBody, /device\.createCommandEncoder\(/);
  assert.doesNotMatch(asyncBody, /queue\.submit\(/);
  assert.doesNotMatch(asyncBody, /encoder\.finish\(/);

  assert.match(snapFramebufferSrc, /_readbackInFlight/);
  assert.match(
    snapFramebufferSrc,
    /requestSequence < \(this\._lastReadback\?\.requestSequence \?\? -1\)/,
    "the atomic cache record must be the out-of-order publish authority",
  );
  assert.match(
    snapFramebufferSrc,
    /if \(this\._readbackInFlight\) \{\s*return;/,
    "a mapping-pending staging buffer must never receive another copy",
  );
  assert.match(snapFramebufferSrc, /this\._coldSnapWarned = true;/);
  // The cold warning is permanent (not pragma-stripped): a developer whose
  // first snap returned undefined needs it in production.
  const warnIndex = snapFramebufferSrc.indexOf("_coldSnapWarned = true");
  const around = snapFramebufferSrc.slice(warnIndex - 400, warnIndex + 200);
  assert.doesNotMatch(around, /includeStart\('debug'/);
});

test("E5: pixels publish atomically with generation, sequence, and immutable view provenance", () => {
  assert.match(
    squash(snapFramebufferSrc),
    /this\._lastReadback = Object\.freeze\(\{ pixels, region, attachmentGeneration: region\.attachmentGeneration, requestSequence, querySequence, view, \}\);/,
  );
  assert.match(
    squash(snapFramebufferSrc),
    /const readback = this\._lastReadback;[\s\S]*?hits: this\._decodeForCurrentQuery\(readback, region\), view,/,
  );
  assert.match(snapFramebufferSrc, /readonly view: SnapViewProvenance;/);
});

test("E6: moving-cursor reuse is recent, overlapping, and view-coherent", () => {
  assert.match(snapFramebufferSrc, /const MAX_PRIOR_QUERY_AGE = 8;/);
  assert.match(snapFramebufferSrc, /const MAX_PRIOR_SCENE_FRAME_AGE = 8;/);
  assert.match(snapFramebufferSrc, /const MAX_PRIOR_CURSOR_DELTA_PIXELS = 2;/);
  assert.match(
    squash(snapFramebufferSrc),
    /currentQuerySequence - readback\.querySequence > MAX_PRIOR_QUERY_AGE/,
  );
  assert.match(
    squash(snapFramebufferSrc),
    /!this\._readbackViewsEquivalent\(readback\.view, currentView\)/,
    "camera/frustum motion must make every prior payload cold",
  );
  assert.match(
    squash(snapFramebufferSrc),
    /currentView\.sceneFrameNumber - readback\.view\.sceneFrameNumber > MAX_PRIOR_SCENE_FRAME_AGE/,
    "snap-call age alone must not preserve a payload across unbounded rendered frames",
  );
  assert.match(
    squash(snapFramebufferSrc),
    /Math\.abs\(priorCenterX - currentCenterX\) <= MAX_PRIOR_CURSOR_DELTA_PIXELS/,
    "a one-column overlap after a large cursor jump must not be treated as complete",
  );
  assert.match(
    squash(snapFramebufferSrc),
    /if \(this\._readbackRegionsEqual\(prior, currentRegion\)\) \{ return hits; \}/,
    "stationary hover must not remap and sort an already ordered exact-region payload",
  );
  const viewGateStart = snapFramebufferSrc.indexOf(
    "private _readbackViewsEquivalent(",
  );
  const viewGateEnd = snapFramebufferSrc.indexOf(
    "private _readbackIsRelevant(",
    viewGateStart,
  );
  const viewGate = snapFramebufferSrc.slice(viewGateStart, viewGateEnd);
  for (const field of [
    "drawingBufferWidth",
    "positionX",
    "directionX",
    "rightX",
    "upX",
    "perspective",
    "fovy",
    "aspectRatio",
    "near",
    "far",
    "sceneMode",
    "mapMode2D",
    "wrapLongitude",
  ]) {
    assert.match(viewGate, new RegExp(`left\\.${field} === right\\.${field}`));
  }
  assert.match(
    squash(snapFramebufferSrc),
    /prior\.logicalOriginX < currentRegion\.logicalOriginX \+ currentRegion\.logicalWidth/,
  );
  assert.match(
    squash(snapFramebufferSrc),
    /const deltaX = priorCenterX - currentCenterX; const deltaY = priorCenterY - currentCenterY;/,
    "prior offsets must be remapped around the current query center",
  );
  assert.match(
    squash(snapFramebufferSrc),
    /if \(hit\.x < minX \|\| hit\.x > maxX \|\| hit\.y < minY \|\| hit\.y > maxY\) \{ continue; \}/,
    "prior hits outside the current aperture must be rejected",
  );
  assert.match(
    squash(snapFramebufferSrc),
    /hits\.sort\(compareSnapSpiralRank\);/,
    "survivors must regain current-center spiral order",
  );
});

// ─── F. VARIANT DISTINCTNESS ─────────────────────────────────────────────────

/** Pull a pipeline descriptor label template out of a create* function. */
function labelTemplate(src, fnName) {
  const start = src.indexOf(`function ${fnName}(`);
  assert.notEqual(start, -1, `${fnName} not found`);
  const body = src.slice(start, start + 4000);
  const match = body.match(/const label = `([^`]+)`/);
  assert.ok(match, `${fnName} has no label template`);
  return match[1];
}

/** Render a label template for a concrete axis tuple. */
function renderLabel(template, { alphaMode, doubleSided, snapFormat, ld }) {
  return template
    .replace(/\$\{alphaMode\}/g, String(alphaMode))
    .replace(/\$\{doubleSided\}/g, String(doubleSided))
    .replace(/\$\{snapFormat\}/g, snapFormat)
    .replace(/\$\{\s*pickLogActive \? " \[ld\]" : ""\s*\}/g, ld ? " [ld]" : "");
}

test("F1: a snap pipeline label can never alias a pick pipeline label", () => {
  const pickTemplate = labelTemplate(
    modelPipelineCacheSrc,
    "createPickPipeline",
  );
  const snapTemplate = labelTemplate(
    modelPipelineCacheSrc,
    "createSnapPipeline",
  );

  const seen = new Set();
  for (const alphaMode of [0, 1, 2]) {
    for (const doubleSided of [false, true]) {
      for (const ld of [false, true]) {
        const axes = {
          alphaMode,
          doubleSided,
          ld,
          snapFormat: SNAP_PAYLOAD_FORMAT,
        };
        const pick = renderLabel(pickTemplate, axes);
        const snap = renderLabel(snapTemplate, axes);
        assert.notEqual(
          pick,
          snap,
          `snap/pick label collision at ${JSON.stringify(axes)}`,
        );
        for (const label of [pick, snap]) {
          assert.ok(
            !seen.has(label),
            `label collision across the axis product: ${label}`,
          );
          seen.add(label);
        }
      }
    }
  }
  // 3 alphaModes x 2 doubleSided x 2 log states x 2 families.
  assert.equal(seen.size, 24);
});

test("F2: the snap label carries BOTH distinguishing axes", () => {
  const snapTemplate = labelTemplate(
    modelPipelineCacheSrc,
    "createSnapPipeline",
  );
  // The payload-format axis — what separates it from the pick family.
  assert.match(snapTemplate, /\[sf=\$\{snapFormat\}\]/);
  // The pick-fleet log-depth axis — the `pipeline-key-aliasing.spec.mjs`
  // convention, because the MODULE (not just the descriptor) varies on it.
  assert.match(snapTemplate, /pickLogActive \? " \[ld\]" : ""/);
  // And the log module actually is what gets compiled in.
  assert.match(
    squash(modelPipelineCacheSrc),
    /getSnapPipeline\([\s\S]*?this\._getOrCreateShaderModule\(md, this\._pickLogDepthEnabled\),/,
  );
});

test("F3: the snap pipeline uses the direct create hatch, never the central cache", () => {
  // `pipeline-key-aliasing.spec.mjs` mechanism 5: a family that never consults
  // `generateCacheKey` cannot alias by name. Assert createSnapPipeline stays on
  // the direct hatch, like every model pipeline except the color one.
  const start = modelPipelineCacheSrc.indexOf("function createSnapPipeline(");
  const body = modelPipelineCacheSrc.slice(start, start + 3000);
  assert.match(body, /return device\.createRenderPipeline\(\{/);
  assert.doesNotMatch(body, /getPipeline(Sync)?\(/);
  assert.doesNotMatch(body, /centralDesc/);
});

test("F4: the snap pipeline map is invalidated everywhere the pick map is", () => {
  const pickClears = modelPipelineCacheSrc.match(
    /this\._pickPipelines\.clear\(\);/g,
  );
  const snapClears = modelPipelineCacheSrc.match(
    /this\._snapPipelines\.clear\(\);/g,
  );
  assert.ok(pickClears && pickClears.length > 0);
  assert.equal(
    snapClears?.length,
    pickClears.length,
    "every pick-pipeline invalidation (device, scene format, pick-format, " +
      "pick log-depth flip, teardown) must also drop snap pipelines",
  );
  // And they must be adjacent, so a new clear site cannot pick up one without
  // the other.
  const adjacent = modelPipelineCacheSrc.match(
    /this\._pickPipelines\.clear\(\);\s*\n\s*this\._snapPipelines\.clear\(\);/g,
  );
  assert.equal(adjacent?.length, pickClears.length);
});

test("F5: the snap pipeline depth state matches the pick pipeline's", () => {
  // The payload phase tests against depth the pick fleet wrote. A different
  // compare function or a different blend/depth-write rule would make a
  // model's own snap fragment fail against its own pick depth.
  const snapBody = modelPipelineCacheSrc.slice(
    modelPipelineCacheSrc.indexOf("function createSnapPipeline("),
    modelPipelineCacheSrc.indexOf("function createSnapPipeline(") + 3000,
  );
  assert.match(
    squash(snapBody),
    /depthWriteEnabled: !isBlend, depthCompare: "less-equal",/,
  );
  assert.match(snapBody, /const isBlend = alphaMode === 2;/);
  // rg32uint is not blendable in core WebGPU, and a snap payload must reach
  // the attachment byte-exact: no blend state may be requested.
  assert.doesNotMatch(snapBody, /blend:/);
});

// ─── G. PASS ROUTING ─────────────────────────────────────────────────────────

test("G1: the snap axis is a caller-supplied parameter that defaults OFF", () => {
  assert.match(
    squash(sceneRendererSrc),
    /export function selectCommandVariant\( command: CesiumAnyDrawCommand, scene: CesiumScene, isPickPass: boolean, [\s\S]*?snapVariant: boolean = false, \): CesiumAnyDrawCommand \{/,
    "the snap axis must default to false so every existing caller is unchanged",
  );
  // It must NOT be derived from frameState.passes.snap: a snapping mini-frame
  // runs two phases over the same frame state, and the occluder phase needs the
  // ordinary pick variants.
  const fnStart = sceneRendererSrc.indexOf(
    "export function selectCommandVariant(",
  );
  const fnBody = sceneRendererSrc.slice(fnStart, fnStart + 5000);
  assert.doesNotMatch(
    fnBody,
    /snapVariant\s*=\s*[^;]*passes\.snap/,
    "the snap axis must not be re-derived from passes.snap inside the selector",
  );
});

test("G2: the snap branch short-circuits ahead of the metadata and pick slots", () => {
  // Comment-stripped: the pre-existing prose in this function already NAMES
  // `derivedCommands.picking.pickCommand`, so an ordering check over raw text
  // would compare against a comment rather than against the branch.
  const fnBody = stripComments(selectCommandVariantBody());
  const snapIdx = fnBody.indexOf("if (snapVariant)");
  const metaIdx = fnBody.indexOf("frameState.pickingMetadata &&");
  const pickIdx = fnBody.indexOf("picking.pickCommand");
  assert.ok(snapIdx > 0, "snap branch not found");
  assert.ok(
    snapIdx < metaIdx && snapIdx < pickIdx,
    "the snap branch must precede the metadata/pick slots so a snapping pass " +
      "can never dispatch an RGBA8 pick pipeline into the RG32Uint payload pass",
  );
  assert.match(
    squash(fnBody.slice(snapIdx, metaIdx)),
    /const snapCommand = d\?\.snapping\?\.snapCommand; return snapCommand \?\? cmd;/,
    "a snapless command must be returned UNCHANGED so the executor skips it",
  );
});

test("G3: the payload phase draws only resolved snap variants", () => {
  const start = pickPassSrc.indexOf("function executeSnapPayloadBatch(");
  assert.notEqual(start, -1, "executeSnapPayloadBatch not found");
  const body = pickPassSrc.slice(
    start,
    pickPassSrc.indexOf("function executePickBatch("),
  );
  assert.match(
    body,
    /selectCommandVariant\(command, scene, true, true\)/,
    "the payload phase must request the snap axis",
  );
  assert.match(
    squash(body),
    /if \(dispatched === command \|\| dispatched\.isWebGPUDrawCommand !== true\) \{ continue; \}/,
    "an unresolved command must be skipped, not dispatched",
  );
  // Unlike the pick batch, `pickOnly` / `_isPickCommand` must NOT admit a
  // command here: those mark pipelines targeting the PICK attachment.
  assert.doesNotMatch(body, /pickOnly/);
  assert.doesNotMatch(body, /_isPickCommand/);
});

test("G4: the occluder phase is byte-identical to an ordinary pick pass", () => {
  const start = pickPassSrc.indexOf("function executePickBatch(");
  const body = pickPassSrc.slice(start);
  assert.match(
    body,
    /selectCommandVariant\(command, scene, true\)/,
    "the occluder phase must keep the 3-argument (snap-off) form — its pick " +
      "draws are what write the depth the payload phase tests against",
  );
});

test("G5: snap mode requires both the marker and a payload attachment", () => {
  assert.match(
    squash(pickPassSrc),
    /const snapMode = pickFBO\._isWebGPUSnapFBO === true && !!pickFBO\.snapColorView;/,
  );
});

test("G6: the occluder phase stores depth for the payload phase to load", () => {
  // Every point where the occluder phase can (re)open a render pass must store
  // depth in snap mode, or the payload phase loads garbage and every snap
  // fragment is either accepted or rejected wholesale.
  const squashed = squash(pickPassSrc);
  assert.match(
    squashed,
    /terrainCheckpoint \|\| clearGlobeDepth \|\| tileCheckpoint \|\| snapMode,/,
  );
  assert.match(squashed, /clearGlobeDepth \|\| tileCheckpoint \|\| snapMode,/);
  assert.match(squashed, /"clear", "load", tileCheckpoint \|\| snapMode,/);
  assert.match(
    squashed,
    /packDepthAndReopen\( `Pick 3D-tile classification frustum \$\{i\}`, snapMode, \)/,
  );
  // And the payload pass must LOAD, never clear, that depth.
  const beginSnap = pickPassSrc.slice(
    pickPassSrc.indexOf("function beginSnapPayloadRenderPass("),
    pickPassSrc.indexOf("function endPickRenderPass("),
  );
  assert.match(squash(beginSnap), /depthLoadOp: "load",/);
  assert.match(squash(beginSnap), /stencilLoadOp: "load",/);
  assert.match(
    squash(beginSnap),
    /view: snapFBO\.snapColorView as GPUTextureView,/,
  );
});

test("G7: accumulated payload is coverage-reset before a nearer slice draws", () => {
  // Slices are rendered far-to-near with non-comparable depth, so color loads
  // while depth clears. Loading alone is insufficient: a nearer snapless
  // occluder would leave a farther hit untouched. The query-scissored reset
  // therefore runs after the payload pass installs dynamic state and before
  // any current-slice snap draw. A second 2D viewport segment still loads the
  // first segment rather than clearing the whole attachment.
  assert.match(
    squash(pickPassSrc),
    /`Snap payload pass frustum \$\{i\}`, i === 0 && !config\.sceneFbLoad \? "clear" : "load",/,
  );
  const snapPhase = pickPassSrc.slice(
    pickPassSrc.indexOf("if (snapMode) {"),
    pickPassSrc.indexOf("completed = true;"),
  );
  assert.match(
    squash(snapPhase),
    /if \(i > 0 \|\| config\.sceneFbLoad\) \{ resetSnapPayloadCoverage!\(snapRenderPass\); \}/,
  );
  assert.ok(
    snapPhase.indexOf("resetSnapPayloadCoverage") <
      snapPhase.indexOf("executeSnapPayloadBatch"),
    "coverage reset must precede every current-slice payload draw",
  );
});

test("G6b: snap discards only unused occluder color; ordinary pick color stores", () => {
  const beginPick = pickPassSrc.slice(
    pickPassSrc.indexOf("function beginPickRenderPass("),
    pickPassSrc.indexOf("function beginSnapPayloadRenderPass("),
  );
  assert.match(
    squash(beginPick),
    /storeOp: pickFBO\._isWebGPUSnapFBO === true && !!pickFBO\.snapColorView \? "discard" : "store",/,
  );
  assert.match(
    squash(beginPick),
    /depthStoreOp: storeForContinuation \? "store" : "discard",/,
    "snap color discard must not weaken depth/stencil continuation",
  );
  const payloadPass = pickPassSrc.slice(
    pickPassSrc.indexOf("function beginSnapPayloadRenderPass("),
    pickPassSrc.indexOf("function endPickRenderPass("),
  );
  assert.match(
    squash(payloadPass),
    /view: snapFBO\.snapColorView as GPUTextureView,[\s\S]*?storeOp: "store",/,
    "the payload itself must remain stored for accumulation and readback",
  );
});

test("G7a: stale-payload oracle kills removal and depth-compare mutations", () => {
  const runCoveredPixel = (coverageResetPredicate) => {
    let payload = "far-hit";
    const resetTriangleDepth = 1.0;
    const nearerOccluderDepth = 0.25;
    if (coverageResetPredicate(resetTriangleDepth, nearerOccluderDepth)) {
      payload = undefined;
    }
    return payload;
  };
  const requireNoStalePayload = (coverageResetPredicate) => {
    assert.equal(runCoveredPixel(coverageResetPredicate), undefined);
  };

  requireNoStalePayload((sourceDepth, destinationDepth) => {
    return sourceDepth !== destinationDepth;
  });
  for (const mutant of [
    // Reset draw removed.
    () => false,
    // `depthCompare: "not-equal"` changed to `"equal"`.
    (sourceDepth, destinationDepth) => sourceDepth === destinationDepth,
  ]) {
    assert.throws(
      () => requireNoStalePayload(mutant),
      /Expected values to be strictly equal/,
      "removing or changing the coverage reset must fail the stale-payload oracle",
    );
    assert.equal(runCoveredPixel(mutant), "far-hit");
  }
});

test("G7b: loaded snap payloads require the reset callback", () => {
  const squashed = squash(pickPassSrc);
  assert.match(
    squashed,
    /snapMode && \(numFrustums > 1 \|\| config\.sceneFbLoad\) && typeof resetSnapPayloadCoverage !== "function"/,
  );
  assert.match(
    squashed,
    /throw new DeveloperError\( "A loaded WebGPU snap payload requires resetSnapPayloadCoverage\.", \);/,
  );
});

test("G8: the payload phase omits the classification checkpoints", () => {
  const start = pickPassSrc.indexOf("if (snapMode) {");
  const body = pickPassSrc.slice(
    start,
    pickPassSrc.indexOf("completed = true;"),
  );
  // Classification draws carry no snap payload, and their packed-depth reopen
  // would clear the depth the payload phase is reading.
  assert.doesNotMatch(body, /TERRAIN_CLASSIFICATION/);
  assert.doesNotMatch(body, /CESIUM_3D_TILE_CLASSIFICATION/);
  // Everything that CAN carry a payload is still visited.
  for (const pass of [
    "Pass.GLOBE",
    "Pass.CESIUM_3D_TILE",
    "Pass.VOXELS",
    "Pass.OPAQUE",
    "Pass.GAUSSIAN_SPLATS",
    "Pass.TRANSLUCENT",
  ]) {
    assert.ok(body.includes(pass), `payload phase skips ${pass}`);
  }
});

test("G9: the snap command rides its own derived slot, apart from the pick family", () => {
  assert.match(
    squash(pickHelpersSrc),
    /export function attachSnapToColorCommand<TSnap>\( colorCommand: DrawCommandWithDerivedSlot, snapCommand: TSnap, \): void \{/,
  );
  assert.match(
    squash(pickHelpersSrc),
    /derived\.snapping = \{ snapCommand \};/,
  );
  // Same key WebGL writes, so both dispatchers read one name.
  assert.match(
    derivedCommandSrc,
    /result\.snapCommand = DrawCommand\.shallowClone\(command, result\.snapCommand\);/,
  );
  assert.match(
    read(resolve(engineScene, "SceneRenderer.js")),
    /command\.derivedCommands\.snapping\.snapCommand/,
  );
});

test("G10: the model renderer materializes a snap command only in a snap mini-frame", () => {
  assert.match(
    squash(modelRendererSrc),
    /if \(frameState\?\.passes\?\.snap === true\) \{/,
  );
  assert.match(
    squash(modelRendererSrc),
    /primCache\.snapPipeline = pipelineCache\.getSnapPipeline\( matInfo\.alphaMode, matInfo\.isDoubleSided, primCache\.materialDefines \| 0, \);/,
  );
  // The snap draw must reuse the pick draw args verbatim — same geometry, same
  // bind groups, same dynamic offsets. Only the pipeline differs.
  assert.match(
    squash(modelRendererSrc),
    /const snapCmd = new WebGPUDrawCommand\(\{ \.\.\.sharedPickDrawArgs, pipeline: primCache\.snapPipeline, \}\); attachSnapToColorCommand\(webgpuCmd, snapCmd\);/,
  );
  // The diagnostic latch is still set by the framebuffer's constructor, while
  // pickBegin sets the current pass before model command production.
  assert.match(snapFramebufferSrc, /snapContext\._snapEnabled = true;/);
  assert.match(
    squash(pickingSrc),
    /frameState\.passes\.snap = options\?\.snap \?\? false;[\s\S]*scene\.updateAndExecuteCommands/,
  );
});

// ─── H. SCENE DISPATCH ───────────────────────────────────────────────────────

test("H1: Scene.snap reaches the WebGPU target through the context factory", () => {
  // CLAUDE.md §2 — Scene code must not import from Renderer/WebGPU/ or branch
  // on isWebGPU.
  assert.match(
    squash(snappingSrc),
    /defaultView\.snapFramebuffer = context\.createSnapFramebuffer\(\) \?\? new SnapFramebuffer\(context\);/,
  );
  assert.doesNotMatch(snappingSrc, /isWebGPU/);
  assert.doesNotMatch(snappingSrc, /Renderer\/WebGPU/);
  // Default is null so WebGL keeps upstream's SnapFramebuffer.
  assert.match(
    squash(graphicsContextSrc),
    /createSnapFramebuffer\(\): unknown \{ return null; \}/,
  );
  assert.match(
    squash(webgpuContextSrc),
    /override createSnapFramebuffer\(\): WebGPUSnapFramebuffer \{ return new WebGPUSnapFramebuffer\(this\); \}/,
  );
});

test("H2: passes.snap is plumbed end to end", () => {
  const pickingSrc = read(resolve(engineScene, "Picking.js"));
  // Set from Snapping's option, cleared in pickEnd.
  assert.match(
    pickingSrc,
    /frameState\.passes\.snap = options\?\.snap \?\? false;/,
  );
  assert.match(pickingSrc, /scene\.frameState\.passes\.snap = false;/);
  assert.match(
    squash(snappingSrc),
    /framebuffer: snapFramebuffer, snap: true,/,
  );
  // Declared on the ambient FrameState passes shape so TS consumers can read it.
  const ambient = read(resolve(engineWebGPU, "cesium-js-types.d.ts"));
  const passesBlock = ambient.slice(
    ambient.indexOf("interface CesiumFrameStatePasses"),
    ambient.indexOf("interface CesiumFrameStateFog"),
  );
  assert.match(passesBlock, /snap\?: boolean;/);
});

test("H3: the snap FBO is discoverable by the pass executor and the ambient type", () => {
  const ambient = read(resolve(engineWebGPU, "cesium-js-types.d.ts"));
  const fbBlock = ambient.slice(
    ambient.indexOf("type CesiumOpaqueFramebuffer"),
    ambient.indexOf("type CesiumOpaqueVertexArray"),
  );
  assert.match(fbBlock, /_isWebGPUSnapFBO\?: boolean;/);
  assert.match(fbBlock, /snapColorView\?: GPUTextureView;/);
  assert.match(fbBlock, /snapColorFormat\?: GPUTextureFormat;/);
  // A snap FBO must ALSO answer the pick marker: its occluder phase IS the
  // ordinary pick pass, and executePickPass's guard rejects anything else.
  assert.match(
    squash(snapFramebufferSrc),
    /_isWebGPUPickFBO: true, _isWebGPUSnapFBO: true,/,
  );
});

test("H4: both backends return one view-paired envelope to renderer-neutral Snapping", () => {
  assert.match(
    squash(snapFramebufferJsSrc),
    /SnapFramebuffer\.prototype\.end = function \(screenSpaceRectangle, view\) \{[\s\S]*?return \{ hits: getSnapObjectsFromPixels\(context, pixels, width, height\), view: view, \};/,
  );
  assert.match(
    squash(snappingSrc),
    /const currentView = captureSnapView\( scene, windowPosition, drawingBufferRectangle, \); readback = snapFramebuffer\.end\(drawingBufferRectangle, currentView\);/,
  );
  assert.match(
    squash(snappingSrc),
    /try \{ pickEnd\(scene\); \} catch \(error\) \{ cleanupError = error; hasCleanupError = true; \}/,
  );
  assert.match(snappingSrc, /const position = snapHitToWorld\(view, best\);/);
  assert.match(snappingSrc, /return Object\.freeze\(\{/);
  assert.doesNotMatch(
    snappingSrc.slice(
      snappingSrc.indexOf("return Object.freeze({"),
      snappingSrc.indexOf("function getSnapPickRay"),
    ),
    /camera\s*:|frustum\s*:|viewport\s*:/,
    "provenance must not retain mutable Camera, Frustum, or Viewport objects",
  );
});

test("H5: CSS/drawing-buffer scaling is frozen and shared by ray + screen output", () => {
  assert.match(snappingSrc, /drawingBufferWidth: scene\.drawingBufferWidth,/);
  assert.match(snappingSrc, /drawingBufferHeight: scene\.drawingBufferHeight,/);
  const helperStart = snappingSrc.indexOf("function snapHitToScreenPosition");
  const helperEnd = snappingSrc.indexOf("function getSnapPickRay", helperStart);
  const helper = snappingSrc.slice(helperStart, helperEnd);
  assert.match(
    squash(helper),
    /result\.x = sampleWindowX \+ hit\.x \* \(view\.canvasWidth \/ view\.drawingBufferWidth\);/,
  );
  assert.match(
    squash(helper),
    /result\.y = sampleWindowY \+ hit\.y \* \(view\.canvasHeight \/ view\.drawingBufferHeight\);/,
  );
  assert.match(
    squash(snappingSrc),
    /const windowPosition = snapHitToScreenPosition\( view, hit, scratchSnapWindowPosition, \);/,
  );
  assert.match(
    squash(snappingSrc),
    /const screenPosition = snapHitToScreenPosition\(\s*view,\s*best,\s*new Cartesian2\(\),?\s*\);/,
  );
});

// ─── I. FEATURE PRESERVATION ─────────────────────────────────────────────────

test("I1: the WebGL snap render/read path stays backend-neutral", () => {
  // The WebGL framebuffer, the derived command, and the hit arbitration must
  // carry no backend branch. Its only contract change is the shared result
  // envelope that pairs hits with their rendered view.
  for (const [name, src] of [
    ["SnapFramebuffer.js", snapFramebufferJsSrc],
    ["Snapping.js", snappingSrc],
  ]) {
    // No backend import and no backend branch. (Prose may name the backend —
    // what must not exist is a code path that differs by renderer.)
    const code = src
      .replace(/\/\/[^\n]*/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    assert.doesNotMatch(
      code,
      /Renderer\/WebGPU/,
      `${name} must not import backend code`,
    );
    assert.doesNotMatch(
      code,
      /\bisWebGPU\b|rendererType/,
      `${name} must not branch on the backend`,
    );
  }
  assert.match(
    snapFramebufferJsSrc,
    /pixelDatatype: PixelDatatype\.FLOAT,\s*pixelFormat: PixelFormat\.RGBA,/,
    "upstream's RGBA32F snap framebuffer must be untouched",
  );
  assert.match(
    derivedCommandSrc,
    /DerivedCommand\.createSnapDerivedCommand = function \(/,
  );
  // The arbitration is shared, so it must not have gained a backend branch.
  assert.match(snappingSrc, /Snapping\._selectBestHit = selectBestHit;/);
  assert.match(snappingSrc, /Snapping\._snapHitToWorld = snapHitToWorld;/);
});

test("I2: WebGPU pick / hover / precise routing is untouched when snapping is off", () => {
  const fnBody = selectCommandVariantBody();
  // The pre-existing routing rules must still be present and in order.
  for (const marker of [
    /if \(passes\.pickVoxel && picking\.pickVoxelCommand\)/,
    /if \(pickMode === "hover" && picking\.pickHoverCommand\)/,
    /if \(pickMode === "precise" && picking\.pickPrecisePass1Command\)/,
    /if \(picking\.pickCommand\)/,
  ]) {
    assert.match(fnBody, marker);
  }
  // Every in-repo CALL site that is not the payload phase must use the 3-arg
  // form, so the snap axis is off for them by construction. (The declaration
  // itself is excluded by requiring a leading `= ` / `(`-adjacent expression
  // context: `export function selectCommandVariant(` never matches.)
  const callSites = [
    ...sceneRendererSrc.matchAll(/[^\w]selectCommandVariant\(([^)]*)\)/g),
    ...pickPassSrc.matchAll(/[^\w]selectCommandVariant\(([^)]*)\)/g),
  ]
    .filter((match) => !/:/.test(match[1]))
    .map((match) => match[1].split(",").length);
  assert.ok(callSites.length >= 3, "expected at least three call sites");
  const fourArg = callSites.filter((count) => count === 4).length;
  assert.equal(
    fourArg,
    1,
    "exactly one call site (the snap payload phase) may pass the snap axis",
  );
});

test("I3: snapping allocates nothing until an app calls Scene.snap", () => {
  // The context latch starts false...
  assert.match(webgpuContextSrc, /_snapEnabled: boolean = false;/);
  // ...the pipeline map starts empty...
  assert.match(modelPipelineCacheSrc, /this\._snapPipelines = new Map\(\);/);
  // ...and derived-command materialization is gated on CURRENT pass demand,
  // so both never-used scenes and ordinary frames after a snap pay no command
  // allocation tax.
  const gate = modelRendererSrc.indexOf(
    "if (frameState?.passes?.snap === true)",
  );
  assert.ok(gate > 0);
  const gated = modelRendererSrc.slice(gate, gate + 900);
  assert.match(gated, /getSnapPipeline\(/);
  assert.match(gated, /attachSnapToColorCommand\(/);
  assert.doesNotMatch(gated, /_snapEnabled/);
});
