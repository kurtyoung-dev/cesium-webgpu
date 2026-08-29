// q131-edge-pipeline-matches-pass.spec.mjs — pure Node: no browser, no GPU.
//
// @purpose Guards the edge-emitter invariant that broke styled-gltf-lines-dev and multifrustum-snapping-dev: the pipeline a tile-edges command binds must declare the colour targets of the pass it executes in.
// @status ACTIVE
//
// WHAT WENT WRONG. Both demos reported, reproducibly, on WebGPU:
//
//   Attachment state of [RenderPipeline "EdgeEmitter-Pipeline-SingleTarget"]
//   is not compatible with [RenderPassEncoder "EdgeFramebuffer tile-edges
//   pass (4x)"]
//
// raised as `[WebGPU:GlobePass] GPU VALIDATION ERROR`. The scene-framebuffer
// pipeline had been bound inside the three-attachment edge framebuffer pass.
//
// WHY. Producer and consumer read different facts, in this order, inside one
// frame of `ViewportExecutor.executeCommandsInViewport`:
//
//   1. `updateAndRenderPrimitives` runs `scene._primitives.update`, and
//      `WebGPUModelRenderer` builds the edge command. It chose its pipeline
//      from `scene._enableEdgeVisibility`, which is still false.
//   2. Immediately after that traversal the same function flips
//      `_enableEdgeVisibility` to true, because a primitive requested edges.
//   3. `executeCommands` runs `_ensureResources`, which allocates the edge
//      framebuffer synchronously, so `edgeFB.isReady` is now true.
//   4. `WebGPUSceneRenderer3DTilePasses` opens the three-attachment pass
//      because the framebuffer is ready — and runs the command from step 1.
//
// So the producer's choice is a guess about a decision the consumer has not
// made yet, and on the FIRST frame any model with `edgeDisplayMode =
// SURFACES_AND_EDGES` renders, the guess is wrong. Both failing demos set that
// mode at construction. `webgpu-edge-visibility` does not (the Model default is
// SURFACES_ONLY), emits no edge command, and is clean — which is why the sweep
// saw the error on exactly two ids.
//
// THE FIX THIS GUARDS. The command now carries both attachment variants and
// the dispatcher binds the one matching the pass it just opened. The invariant
// is therefore checkable without a GPU: whatever the producer guessed, after
// `bindEdgePipelinesForPass` the bound pipeline's target list must equal the
// pass's attachment list.
//
// HOW THE PIPELINES ARE OBTAINED. `ensureEdgeEmitterPipeline` is run against a
// recording fake device, so the descriptors asserted here are the ones the
// engine would hand `createRenderPipeline` — not a transcription of them.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const WEBGPU = path.join(root, "packages/engine/Source/Renderer/WebGPU");

async function loadModule(relative) {
  const result = await build({
    entryPoints: [path.join(WEBGPU, relative)],
    bundle: true,
    format: "esm",
    write: false,
    platform: "node",
    target: "es2022",
    logLevel: "silent",
  });
  const code = result.outputFiles[0].text;
  return import(
    `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`
  );
}

// The emitter reads the WebGPU stage-visibility constants, which are browser
// globals. The values are fixed by the specification, so declaring them here is
// a transcription of the standard, not of the engine.
globalThis.GPUShaderStage ??= Object.freeze({
  VERTEX: 0x1,
  FRAGMENT: 0x2,
  COMPUTE: 0x4,
});

const emitter = await loadModule("WebGPUEdgeVisibilityEmitter.ts");
const {
  bindEdgePipelinesForPass,
  ensureEdgeEmitterPipeline,
  createEdgeEmitterCache,
} = emitter;

// ── A recording device: every descriptor the emitter builds is kept ─────────

function recordingDevice() {
  const created = [];
  const device = {
    createShaderModule: (descriptor) => ({ __module: descriptor.label }),
    createBindGroupLayout: (descriptor) => ({ __bgl: descriptor.label }),
    createPipelineLayout: (descriptor) => ({ __layout: descriptor.label }),
    createRenderPipeline: (descriptor) => {
      created.push(descriptor);
      return { __pipeline: descriptor.label, __descriptor: descriptor };
    },
  };
  return { device, created };
}

// The edge framebuffer's own attachment formats, read from the allocator that
// creates them rather than restated here.
function edgeFramebufferFormats(sceneColorFormat) {
  const source = fs.readFileSync(
    path.join(WEBGPU, "WebGPUEdgeFramebuffer.ts"),
    "utf8",
  );
  const block = /const formats[^=]*=\s*\[([\s\S]*?)\]/.exec(source);
  assert.ok(block, "could not read the edge framebuffer's format list");
  const formats = [...block[1].matchAll(/"([a-z0-9-]+)"|(colorFormat)/g)].map(
    (match) => match[1] ?? sceneColorFormat,
  );
  assert.equal(
    formats.length,
    3,
    `expected three edge attachments, read ${JSON.stringify(formats)}`,
  );
  return formats;
}

const SCENE_COLOR_FORMAT = "bgra8unorm";

function buildBothVariants({ sampleCount = 4 } = {}) {
  const { device, created } = recordingDevice();
  const cache = createEdgeEmitterCache();
  ensureEdgeEmitterPipeline(cache, device, SCENE_COLOR_FORMAT, sampleCount);
  const byLabel = new Map(created.map((d) => [d.label, d]));
  return { cache, created, byLabel };
}

// ── Group A — the two variants, as the engine actually declares them ────────

test("A1: both attachment variants are created together", () => {
  const { cache, byLabel } = buildBothVariants();
  assert.ok(cache.pipeline, "MRT variant missing");
  assert.ok(cache.pipelineSingleTarget, "scene-FB variant missing");
  assert.ok(byLabel.has("EdgeEmitter-Pipeline"));
  assert.ok(byLabel.has("EdgeEmitter-Pipeline-SingleTarget"));
});

test("A2: the MRT variant's targets equal the edge framebuffer's attachments", () => {
  const { byLabel } = buildBothVariants();
  const mrt = byLabel.get("EdgeEmitter-Pipeline");
  const declared = mrt.fragment.targets.map((target) => target.format);
  assert.deepEqual(declared, edgeFramebufferFormats(SCENE_COLOR_FORMAT));
});

test("A3: the scene-FB variant does NOT match the edge pass — the bug's whole shape", () => {
  const { byLabel } = buildBothVariants();
  const single = byLabel.get("EdgeEmitter-Pipeline-SingleTarget");
  const declared = single.fragment.targets.map((target) => target.format);
  const edgePass = edgeFramebufferFormats(SCENE_COLOR_FORMAT);
  assert.notDeepEqual(
    declared,
    edgePass,
    "if these ever match, this spec has stopped discriminating",
  );
  assert.notEqual(declared.length, edgePass.length);
});

test("A4: both variants agree on sample count with the pass they target", () => {
  for (const sampleCount of [1, 4]) {
    const { byLabel } = buildBothVariants({ sampleCount });
    for (const label of [
      "EdgeEmitter-Pipeline",
      "EdgeEmitter-Pipeline-SingleTarget",
    ]) {
      const descriptor = byLabel.get(label);
      const declared = descriptor.multisample?.count ?? 1;
      assert.equal(declared, sampleCount, `${label} at ${sampleCount}x`);
    }
  }
});

// ── Group B — the binder is what makes the pipeline follow the pass ─────────

function fakeEdgeCommand(cache, guessed) {
  return {
    pipeline: guessed,
    _edgeMrtPipeline: cache.pipeline,
    _edgeSceneFBPipeline: cache.pipelineSingleTarget,
  };
}

test("B1: a command that guessed scene-FB is retargeted for the MRT pass", () => {
  const { cache } = buildBothVariants();
  const commands = [fakeEdgeCommand(cache, cache.pipelineSingleTarget)];
  const retargeted = bindEdgePipelinesForPass(commands, 1, true);
  assert.equal(retargeted, 1);
  assert.equal(commands[0].pipeline, cache.pipeline);
  assert.deepEqual(
    commands[0].pipeline.__descriptor.fragment.targets.map((t) => t.format),
    edgeFramebufferFormats(SCENE_COLOR_FORMAT),
  );
});

test("B2: a command that guessed MRT is retargeted for the scene-FB pass", () => {
  const { cache } = buildBothVariants();
  const commands = [fakeEdgeCommand(cache, cache.pipeline)];
  assert.equal(bindEdgePipelinesForPass(commands, 1, false), 1);
  assert.equal(commands[0].pipeline, cache.pipelineSingleTarget);
});

test("B3: only the live head of the command array is touched", () => {
  const { cache } = buildBothVariants();
  const stale = fakeEdgeCommand(cache, cache.pipelineSingleTarget);
  const commands = [fakeEdgeCommand(cache, cache.pipelineSingleTarget), stale];
  bindEdgePipelinesForPass(commands, 1, true);
  assert.equal(commands[0].pipeline, cache.pipeline);
  assert.equal(
    stale.pipeline,
    cache.pipelineSingleTarget,
    "a command past the live count must not be rewritten",
  );
});

test("B4: commands with no variants — and empty slots — are left alone", () => {
  const { cache } = buildBothVariants();
  const foreign = { pipeline: { __pipeline: "SomeOtherRenderer" } };
  const commands = [foreign, undefined, fakeEdgeCommand(cache, cache.pipeline)];
  const retargeted = bindEdgePipelinesForPass(commands, 3, false);
  assert.equal(retargeted, 1);
  assert.equal(foreign.pipeline.__pipeline, "SomeOtherRenderer");
});

test("B5: the binder is idempotent", () => {
  const { cache } = buildBothVariants();
  const commands = [fakeEdgeCommand(cache, cache.pipelineSingleTarget)];
  bindEdgePipelinesForPass(commands, 1, true);
  const once = commands[0].pipeline;
  bindEdgePipelinesForPass(commands, 1, true);
  assert.equal(commands[0].pipeline, once);
});

test("B6: MUTANT — a binder that ignores `useMrt` fails the invariant", () => {
  const { cache } = buildBothVariants();
  const inertBinder = (commands, count) => {
    for (let i = 0; i < count; ++i) {
      commands[i].pipeline = commands[i]._edgeSceneFBPipeline;
    }
  };
  const commands = [fakeEdgeCommand(cache, cache.pipelineSingleTarget)];
  inertBinder(commands, 1, true);
  assert.notDeepEqual(
    commands[0].pipeline.__descriptor.fragment.targets.map((t) => t.format),
    edgeFramebufferFormats(SCENE_COLOR_FORMAT),
    "the mutant must NOT satisfy the MRT pass",
  );
});

test("B7: MUTANT — dropping the variants from the command makes the binder inert", () => {
  const { cache } = buildBothVariants();
  const untagged = { pipeline: cache.pipelineSingleTarget };
  assert.equal(bindEdgePipelinesForPass([untagged], 1, true), 0);
  assert.equal(
    untagged.pipeline,
    cache.pipelineSingleTarget,
    "an untagged command keeps whatever the producer guessed — which is the pre-fix behaviour",
  );
});

// ── Group C — both dispatcher branches call the binder ──────────────────────

const DISPATCHER = fs.readFileSync(
  path.join(WEBGPU, "WebGPUSceneRenderer3DTilePasses.ts"),
  "utf8",
);

test("C1: the redirect branch binds the MRT variant before running the pass", () => {
  const openPass = DISPATCHER.indexOf("EdgeFramebuffer tile-edges pass");
  assert.ok(openPass > 0, "the edge pass label moved");
  const afterOpen = DISPATCHER.slice(openPass);
  const bindAt = afterOpen.indexOf("bindEdgePipelinesForPass(");
  const runAt = afterOpen.indexOf("runPass(Pass.CESIUM_3D_TILE_EDGES)");
  assert.ok(bindAt > 0, "the redirect branch does not bind");
  assert.ok(
    bindAt < runAt,
    "the bind must happen before the commands record draws",
  );
  assert.match(
    afterOpen.slice(bindAt, runAt),
    /\btrue,/,
    "the redirect branch must ask for the MRT variant",
  );
});

test("C2: the scene-FB fallback branch binds the single-target variant", () => {
  const fallback = DISPATCHER.indexOf(
    "// to the pre-Batch-44 path; no edge textures are populated.",
  );
  assert.ok(fallback > 0, "the fallback branch comment moved");
  const region = DISPATCHER.slice(fallback, fallback + 400);
  assert.match(region, /bindEdgePipelinesForPass\(/);
  assert.match(region, /\bfalse,/);
});

test("C3: both call sites pass the edges-pass command array and its live count", () => {
  const calls = [
    ...DISPATCHER.matchAll(/bindEdgePipelinesForPass\(\s*([\s\S]*?)\);/g),
  ].map((match) => match[1].replace(/\s+/g, " ").trim());
  assert.equal(calls.length, 2, `found ${calls.length} call sites`);
  for (const args of calls) {
    assert.match(
      args,
      /frustumCommands\.commands\[Pass\.CESIUM_3D_TILE_EDGES\]/,
    );
    assert.match(args, /edgeCommandCount/);
  }
});

// ── Group D — the producer still tags only the redirectable command ─────────

const PRODUCER = fs.readFileSync(
  path.join(WEBGPU, "WebGPUModelRenderer.ts"),
  "utf8",
);

test("D1: the producer stashes both variants on the slot-4 edge command", () => {
  assert.match(
    PRODUCER,
    /_edgeMrtPipeline = cache\.edgeEmitterCache\.pipeline/,
  );
  assert.match(
    PRODUCER,
    /_edgeSceneFBPipeline =\s*\r?\n?\s*cache\.edgeEmitterCache\.pipelineSingleTarget/,
  );
});

test("D2: EDGES_ONLY commands are NOT tagged — their pass is never redirected", () => {
  const tagAt = PRODUCER.indexOf("edgeCmd._edgeMrtPipeline");
  assert.ok(tagAt > 0);
  const preamble = PRODUCER.slice(Math.max(0, tagAt - 400), tagAt);
  assert.match(
    preamble,
    /if \(!edgesOnly\) \{/,
    "the tag must be gated on the command going to the redirectable pass",
  );
});
