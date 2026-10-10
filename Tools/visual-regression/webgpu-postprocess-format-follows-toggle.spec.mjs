// webgpu-postprocess-format-follows-toggle.spec.mjs — browser-free contract that
// after a runtime HDR toggle the WebGPU post-process chain only encodes passes
// whose render pipeline was built for the format of the attachment the pass
// writes, and that every stage enabled before the toggle still encodes its
// pass. Pure Node: no browser, no GPU, no build.
//
// @purpose Drives the real post-process bridge against the real WebGPUPostProcessPipeline under a fake device that records every render pipeline's colour-target format and every encoded pass, and pins that after a useHDRCanvasOutput toggle, a highDynamicRange toggle and a pipeline replacement each pass uses a pipeline built for its own attachment, with a plain resize compiling nothing.
// @status ACTIVE
//
// ── WHAT THIS IS ABOUT ──────────────────────────────────────────────────────
//
// A render pipeline bakes its colour-target format in. The single-pass stages
// (Tonemap, ColorGrading, FXAA) write a ping/pong texture whose format is the
// pipeline's intermediate format, which is `rgba16float` under
// `highDynamicRange` and the canvas format otherwise; the identity blit writes
// the canvas itself. Both formats can change for the life of objects that are
// created only once, and a pass whose pipeline disagrees with its attachment
// fails WebGPU validation and draws nothing.
//
// The earlier effect-survival spec (webgpu-postprocess-effect-survives-
// recreate.spec.mjs) records no formats, so it cannot see this class.
//
// ── WHAT IS ASSERTED ────────────────────────────────────────────────────────
//
// The observable is the encoded pass list of the frame after a toggle: for each
// render pass, the format of the colour attachment it writes and the format its
// pipeline was built for. The device is a recording fake. `createTexture` keeps
// the descriptor's format on the texture and on every view of it, so an
// attachment knows its own format; `createRenderPipeline` keeps
// `fragment.targets[0].format` on the pipeline it returns; the command encoder
// logs, per pass, the attachment view and the pipeline passed to `setPipeline`.
// Nothing is read from the pipeline's private fields.
//
//   1. useHDRCanvasOutput toggle, either direction, in HDR and in SDR. The
//      post-process pipeline is NOT recreated or re-initialised by this
//      toggle in production; the per-frame `canvasFormat` argument of the
//      configure call is the only carrier of the new format, so this group
//      never calls `initialize` itself after set-up.
//   2. highDynamicRange toggle on the same pipeline object (the class
//      contract): Tonemap (when the scene is HDR), ColorGrading and FXAA are
//      all encoded at the current intermediate format; toggling back restores
//      the original formats.
//   3. highDynamicRange toggle as production performs it: the resource
//      allocator destroys the pipeline and builds a new one while the
//      collection and its cache persist. The new pipeline's first frame must
//      encode a ColorGrading pass.
//   4. A plain resize compiles no Tonemap, ColorGrading, FXAA or IdentityBlit
//      pipeline and keeps the same blit pipeline object.
//   5. The effects a useHDRCanvasOutput toggle drops are back on the toggle
//      frame. Following the new canvas format re-initialises the pipeline,
//      which drops every lazily-added effect; with TAA and bloom on, both
//      must be live again when that frame's configure call returns, as fresh
//      objects (so the toggle really dropped them). Effects are stubbed, so
//      this group runs only the update and configure pair, never `execute`.
//
// The scene/collection gate state is not hand-written: the REAL
// `updateWebGPUPostProcessStages` and `configureWebGPUPostProcessPipeline`
// derive it from a collection shaped the way `PostProcessStageCollection`
// shapes it, so the spec cannot certify its own harness.
//
// ── MUTANTS ─────────────────────────────────────────────────────────────────
//
// Each group re-imports through a source mutation that makes the fix
// UNREACHABLE (`if (false && ...)`, or the pre-fix condition restored) and
// requires the group's assertion to fail. Every mutation runs through
// `mutateOrFail`, which fails loudly if its anchor has moved. Group 4 has no
// fix of its own; its mutant makes the blit rebuild fire on every call, which
// proves the group is not vacuous.
//
// HARNESS: `WebGPUPostProcessFormatPipelines` MUST stay in `real`. The stub
// bundler replaces every module not named there with a Proxy, and a stubbed
// builder returns Proxies, so no format would ever be recorded. The
// non-vacuity checks below fail loudly if that happens.
//
// CRLF: mutation anchors are written with LF. They match because the bundler
// normalises every file it loads before handing it to a `mutate` callback.
//
// Run: node --test Tools/visual-regression/webgpu-postprocess-format-follows-toggle.spec.mjs

import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { bundle, mutateOrFail } from "./lib/engine-stub-bundler.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const engineWebGPU = resolve(
  directory,
  "../../packages/engine/Source/Renderer/WebGPU",
);
const BRIDGE_PATH = resolve(
  engineWebGPU,
  "WebGPUPostProcessStageCollection.ts",
);
const PIPELINE_PATH = resolve(engineWebGPU, "WebGPUPostProcessPipeline.ts");
const FORMAT_PATH = resolve(
  engineWebGPU,
  "WebGPUPostProcessFormatPipelines.ts",
);

globalThis.GPUBufferUsage ??= {
  UNIFORM: 0x40,
  COPY_DST: 0x08,
  STORAGE: 0x80,
  COPY_SRC: 0x04,
  MAP_READ: 0x01,
};
globalThis.GPUTextureUsage ??= {
  TEXTURE_BINDING: 0x04,
  RENDER_ATTACHMENT: 0x10,
  COPY_DST: 0x08,
  COPY_SRC: 0x01,
  STORAGE_BINDING: 0x80,
};
globalThis.GPUShaderStage ??= { VERTEX: 0x1, FRAGMENT: 0x2, COMPUTE: 0x4 };

const SDR = "bgra8unorm";
const HDR = "rgba16float";
const BLIT = "PostProcess-IdentityBlit";
const TONEMAP = "PostProcess-Tonemap-Pass";
const GRADING = "PostProcess-ColorGrading-Pass";
const FXAA = "PostProcess-FXAA-Pass";

/**
 * A fake `GPUDevice` that records the target format of every render pipeline
 * and the format of every texture and view, and counts creations.
 *
 * @returns {object} The device and its logs.
 */
function makeRecordingDevice() {
  const log = { pipelines: [], textures: [] };
  const token = (label) => ({
    label,
    createView: () => ({ label }),
    destroy() {},
  });
  const device = {
    features: new Set(),
    limits: {},
    createBuffer: ({ label, size }) => ({ label, size, destroy() {} }),
    createTexture(descriptor) {
      const { label, format, size } = descriptor;
      log.textures.push({ label, format, size });
      return {
        label,
        format,
        createView: () => ({ label: `${label}-View`, format }),
        destroy() {},
      };
    },
    createShaderModule({ label }) {
      return {
        label,
        getCompilationInfo: () => Promise.resolve({ messages: [] }),
      };
    },
    createPipelineLayout: ({ label }) => token(label),
    createRenderPipeline(descriptor) {
      const pipeline = {
        label: descriptor.label,
        format: descriptor.fragment?.targets?.[0]?.format,
        getBindGroupLayout: () => token(`${descriptor.label}-BGL`),
      };
      log.pipelines.push(pipeline);
      return pipeline;
    },
    createComputePipeline: ({ label }) => ({
      label,
      getBindGroupLayout: () => token(`${label}-BGL`),
    }),
    createBindGroupLayout: ({ label }) => token(label),
    createBindGroup: ({ label }) => token(label),
    createSampler: ({ label } = {}) => token(label ?? "sampler"),
    pushErrorScope() {},
    popErrorScope: () => Promise.resolve(null),
    queue: {
      writeBuffer() {},
      writeTexture() {},
      submit() {},
      onSubmittedWorkDone: () => Promise.resolve(),
    },
  };
  return { device, log };
}

/**
 * A command encoder whose render passes are logged as
 * `{label, viewFormat, isCanvas, pipelineFormat, pipeline}`.
 *
 * @param {object[]} passes The array the encoder appends to.
 * @returns {object} The encoder.
 */
function makeRecordingEncoder(passes) {
  return {
    beginRenderPass(descriptor) {
      const view = descriptor.colorAttachments[0].view;
      const record = {
        label: descriptor.label,
        viewFormat: view.format,
        isCanvas: view.isCanvas === true,
        pipelineFormat: undefined,
        pipeline: null,
      };
      passes.push(record);
      return {
        setPipeline(pipeline) {
          record.pipeline = pipeline;
          record.pipelineFormat = pipeline?.format;
        },
        setBindGroup() {},
        setVertexBuffer() {},
        draw() {},
        end() {},
      };
    },
    beginComputePass: () => ({
      setPipeline() {},
      setBindGroup() {},
      dispatchWorkgroups() {},
      end() {},
    }),
    finish: () => ({}),
  };
}

/**
 * The collection, shaped the way upstream `PostProcessStageCollection`
 * presents it, with FXAA on and bloom, AO and DoF off so `execute` touches
 * only the single-pass chain and the blit. No `_webgpuCache` is supplied: the
 * real `updateWebGPUPostProcessStages` creates and fills it.
 *
 * @returns {object} The collection.
 */
function makeCollection() {
  return {
    bloom: { enabled: false, uniforms: {} },
    ambientOcclusion: { enabled: false, uniforms: {} },
    fxaa: { enabled: true, uniforms: {} },
    _tonemapping: { enabled: true },
    _autoExposureEnabled: false,
    _stages: [],
    _activeStagesChanged: false,
    _stagesRemoved: false,
  };
}

/**
 * Bundles the real bridge, the real pipeline and the real format module.
 *
 * @param {object} [options] Options.
 * @param {Function} [options.mutateBridge] Rewrite applied to the bridge source.
 * @param {Function} [options.mutatePipeline] Rewrite applied to the pipeline source.
 * @param {string} [options.label] Name used in the did-it-change assertion.
 * @returns {Promise<object>} The module namespace.
 */
async function load({ mutateBridge, mutatePipeline, label = "mutation" } = {}) {
  const overrides = [];
  if (mutateBridge) {
    overrides.push({
      basename: "WebGPUPostProcessStageCollection.ts",
      mutate: mutateBridge,
      label,
    });
  }
  if (mutatePipeline) {
    overrides.push({
      basename: "WebGPUPostProcessPipeline.ts",
      mutate: mutatePipeline,
      label,
    });
  }
  return bundle({
    path: resolve(engineWebGPU, "__fw08-entry.ts"),
    source: [
      'export * from "./WebGPUPostProcessStageCollection.js";',
      'export { WebGPUPostProcessPipeline } from "./WebGPUPostProcessPipeline.js";',
    ].join("\n"),
    real: [
      "WebGPUPostProcessStageCollection",
      "WebGPUPostProcessPipeline",
      "WebGPUPostProcessConfigSync",
      "WebGPUPostProcessFormatPipelines",
    ],
    preseed: [BRIDGE_PATH, PIPELINE_PATH, FORMAT_PATH],
    overrides,
  });
}

/**
 * One rig: a recording device, a persistent collection and scene, and a frame
 * driver that runs the real update, the real configure and the real execute.
 *
 * @param {object} api The bundle namespace.
 * @param {object} sceneFlags Initial scene flags.
 * @returns {object} The rig.
 */
function makeRig(api, sceneFlags) {
  const { device, log } = makeRecordingDevice();
  const collection = makeCollection();
  const scene = {
    postProcessStages: collection,
    highDynamicRange: false,
    useHDRCanvasOutput: false,
    colorGradingEnabled: true,
    ...sceneFlags,
  };
  const frameState = { frameNumber: 1 };
  const sceneView = { label: "scene", format: HDR };

  /**
   * Builds a pipeline the way the resource allocator does.
   *
   * @param {number} width Width.
   * @param {number} height Height.
   * @param {string} canvasFormat Presentation format.
   * @param {boolean} hdr Scene highDynamicRange.
   * @returns {object} The pipeline.
   */
  function allocate(width, height, canvasFormat, hdr) {
    const pipeline = new api.WebGPUPostProcessPipeline();
    pipeline.initialize(device, width, height, canvasFormat, hdr);
    pipeline.addTonemapping(device, canvasFormat);
    pipeline.addFXAA(device, canvasFormat);
    return pipeline;
  }

  /**
   * One frame: the real update + configure pair, then `execute` into a
   * canvas view of `canvasFormat`.
   *
   * @param {object} pipeline The pipeline.
   * @param {string} canvasFormat The canvas format this frame.
   * @returns {object[]} The passes encoded.
   */
  function frame(pipeline, canvasFormat) {
    api.updateWebGPUPostProcessStages(collection, frameState);
    api.configureWebGPUPostProcessPipeline(
      pipeline,
      collection,
      device,
      canvasFormat,
      scene,
    );
    frameState.frameNumber++;
    const passes = [];
    const canvas = { label: "canvas", format: canvasFormat, isCanvas: true };
    pipeline.execute(makeRecordingEncoder(passes), sceneView, canvas);
    return passes;
  }

  return { device, log, collection, scene, allocate, frame };
}

/**
 * The pass labels a frame must encode, from the documented gating: Tonemap
 * only for an HDR scene that is not presenting to an HDR canvas, then
 * ColorGrading and FXAA, then the blit.
 *
 * @param {boolean} hdr Scene highDynamicRange.
 * @param {boolean} hdrCanvas Scene useHDRCanvasOutput.
 * @returns {string[]} The labels.
 */
function expectedLabels(hdr, hdrCanvas) {
  const labels = [];
  if (hdr && !hdrCanvas) {
    labels.push(TONEMAP);
  }
  labels.push(GRADING, FXAA, BLIT);
  return labels;
}

/**
 * Asserts the format law on one frame: every pass writes an attachment of the
 * format its pipeline was built for; the blit writes the canvas; every other
 * pass writes a ping/pong view of the intermediate format.
 *
 * @param {object[]} passes The frame's passes.
 * @param {object} expectation Expected frame.
 * @param {string} expectation.canvasFormat This frame's canvas format.
 * @param {string} expectation.intermediate The current intermediate format.
 * @param {string[]} expectation.labels The pass labels in order.
 * @param {string} name Frame name for messages.
 */
function assertFrame(passes, expectation, name) {
  const { canvasFormat, intermediate, labels } = expectation;
  // Non-vacuity: formats must have been recorded as strings, or the module
  // that records them was stubbed and every comparison below is undefined
  // against undefined.
  assert.ok(passes.length > 0, `${name}: no pass was encoded`);
  for (const pass of passes) {
    assert.equal(
      typeof pass.pipelineFormat,
      "string",
      `${name}: pass ${pass.label} recorded no pipeline format (the format module is stubbed or the pass set no pipeline)`,
    );
    assert.equal(
      typeof pass.viewFormat,
      "string",
      `${name}: pass ${pass.label} recorded no attachment format`,
    );
  }
  assert.deepEqual(
    passes.map((pass) => pass.label),
    labels,
    `${name}: the encoded pass list`,
  );
  for (const pass of passes) {
    assert.equal(
      pass.pipelineFormat,
      pass.viewFormat,
      `${name}: pass ${pass.label} was built for ${pass.pipelineFormat} but writes a ${pass.viewFormat} attachment`,
    );
    if (pass.label === BLIT) {
      assert.ok(pass.isCanvas, `${name}: the blit must write the canvas`);
      assert.equal(
        pass.pipelineFormat,
        canvasFormat,
        `${name}: the blit pipeline format must be the canvas format`,
      );
    } else {
      assert.ok(
        !pass.isCanvas,
        `${name}: ${pass.label} must not write the canvas`,
      );
      assert.equal(
        pass.pipelineFormat,
        intermediate,
        `${name}: ${pass.label} must be built for the intermediate format`,
      );
    }
  }
}

/** A frame's comparable signature: label and pipeline format per pass. */
function signature(passes) {
  return passes.map((pass) => `${pass.label}@${pass.pipelineFormat}`);
}

/**
 * Group 1 scenario. Production reconfigures the canvas WITHOUT recreating or
 * re-initialising the pipeline, so `initialize` is called only at set-up.
 *
 * @param {object} api The bundle namespace.
 * @param {boolean} hdr Scene highDynamicRange.
 * @returns {object} The three frames' passes.
 */
function runCanvasToggle(api, hdr) {
  const rig = makeRig(api, { highDynamicRange: hdr });
  const pipeline = rig.allocate(800, 600, SDR, hdr);
  const first = rig.frame(pipeline, SDR);
  rig.scene.useHDRCanvasOutput = true;
  const toHdrCanvas = rig.frame(pipeline, HDR);
  rig.scene.useHDRCanvasOutput = false;
  const back = rig.frame(pipeline, SDR);
  return { first, toHdrCanvas, back };
}

/**
 * Group 1 assertions.
 *
 * @param {object} observed The scenario result.
 * @param {boolean} hdr Scene highDynamicRange.
 */
function checkCanvasToggle(observed, hdr) {
  const mode = hdr ? "hdr" : "sdr";
  const intermediate = (canvasFormat) => (hdr ? HDR : canvasFormat);
  assertFrame(
    observed.first,
    {
      canvasFormat: SDR,
      intermediate: intermediate(SDR),
      labels: expectedLabels(hdr, false),
    },
    `canvas toggle ${mode}: before the toggle`,
  );
  assertFrame(
    observed.toHdrCanvas,
    {
      canvasFormat: HDR,
      intermediate: intermediate(HDR),
      labels: expectedLabels(hdr, hdr),
    },
    `canvas toggle ${mode}: first frame on an rgba16float canvas`,
  );
  assertFrame(
    observed.back,
    {
      canvasFormat: SDR,
      intermediate: intermediate(SDR),
      labels: expectedLabels(hdr, false),
    },
    `canvas toggle ${mode}: first frame back on the original canvas`,
  );
  assert.deepEqual(
    signature(observed.back),
    signature(observed.first),
    `canvas toggle ${mode}: toggling back must restore the original formats`,
  );
}

/**
 * Group 2 scenario: the same pipeline object, `initialize` called with the
 * new `highDynamicRange`, as the class contract allows.
 *
 * @param {object} api The bundle namespace.
 * @returns {object} The three frames' passes.
 */
function runHdrToggleSamePipeline(api) {
  const rig = makeRig(api, { highDynamicRange: false });
  const pipeline = rig.allocate(800, 600, SDR, false);
  const sdr = rig.frame(pipeline, SDR);
  rig.scene.highDynamicRange = true;
  pipeline.initialize(rig.device, 800, 600, SDR, true);
  const hdr = rig.frame(pipeline, SDR);
  rig.scene.highDynamicRange = false;
  pipeline.initialize(rig.device, 800, 600, SDR, false);
  const back = rig.frame(pipeline, SDR);
  return { sdr, hdr, back };
}

/**
 * Group 2 assertions.
 *
 * @param {object} observed The scenario result.
 */
function checkHdrToggleSamePipeline(observed) {
  assertFrame(
    observed.sdr,
    {
      canvasFormat: SDR,
      intermediate: SDR,
      labels: expectedLabels(false, false),
    },
    "hdr toggle (same pipeline): SDR before",
  );
  assertFrame(
    observed.hdr,
    {
      canvasFormat: SDR,
      intermediate: HDR,
      labels: expectedLabels(true, false),
    },
    "hdr toggle (same pipeline): first HDR frame",
  );
  assertFrame(
    observed.back,
    {
      canvasFormat: SDR,
      intermediate: SDR,
      labels: expectedLabels(false, false),
    },
    "hdr toggle (same pipeline): first SDR frame after toggling back",
  );
  assert.deepEqual(
    signature(observed.back),
    signature(observed.sdr),
    "hdr toggle (same pipeline): toggling back must restore the original formats",
  );
}

/**
 * Group 3 scenario: the allocator destroys the pipeline and builds a new one
 * on a `highDynamicRange` toggle; the collection and its cache persist.
 *
 * @param {object} api The bundle namespace.
 * @returns {object} Each replacement's first frame.
 */
function runHdrToggleReplacedPipeline(api) {
  const rig = makeRig(api, { highDynamicRange: false });
  const a = rig.allocate(800, 600, SDR, false);
  const first = rig.frame(a, SDR);
  a.destroy();
  rig.scene.highDynamicRange = true;
  const b = rig.allocate(800, 600, SDR, true);
  const hdr = rig.frame(b, SDR);
  b.destroy();
  rig.scene.highDynamicRange = false;
  const c = rig.allocate(800, 600, SDR, false);
  const back = rig.frame(c, SDR);
  return { first, hdr, back, log: rig.log };
}

/**
 * Group 3 assertions.
 *
 * @param {object} observed The scenario result.
 */
function checkHdrToggleReplacedPipeline(observed) {
  assertFrame(
    observed.first,
    {
      canvasFormat: SDR,
      intermediate: SDR,
      labels: expectedLabels(false, false),
    },
    "hdr toggle (replaced pipeline): the original SDR pipeline",
  );
  assertFrame(
    observed.hdr,
    {
      canvasFormat: SDR,
      intermediate: HDR,
      labels: expectedLabels(true, false),
    },
    "hdr toggle (replaced pipeline): the replacement's first frame, HDR",
  );
  assertFrame(
    observed.back,
    {
      canvasFormat: SDR,
      intermediate: SDR,
      labels: expectedLabels(false, false),
    },
    "hdr toggle (replaced pipeline): the replacement's first frame, back to SDR",
  );
}

/**
 * Group 4 scenario: a plain resize on an HDR pipeline.
 *
 * @param {object} api The bundle namespace.
 * @returns {object} The resize observation.
 */
function runResize(api) {
  const rig = makeRig(api, { highDynamicRange: true });
  const pipeline = rig.allocate(800, 600, SDR, true);
  const before = rig.frame(pipeline, SDR);
  const pipelinesBefore = rig.log.pipelines.length;
  const texturesBefore = rig.log.textures.length;
  pipeline.resize(1024, 768);
  const after = rig.frame(pipeline, SDR);
  return {
    before,
    after,
    compiledDuring: rig.log.pipelines.slice(pipelinesBefore),
    texturesDuring: rig.log.textures.slice(texturesBefore),
  };
}

/**
 * Group 4 assertions.
 *
 * @param {object} observed The scenario result.
 */
function checkResize(observed) {
  // Non-vacuity: the resize really reallocated the chain at the new size.
  assert.ok(
    observed.texturesDuring.some((texture) => texture.size?.width === 1024),
    "resize: no 1024-wide texture was created, so the resize did not run",
  );
  const labels = expectedLabels(true, false);
  assertFrame(
    observed.before,
    { canvasFormat: SDR, intermediate: HDR, labels },
    "resize: before",
  );
  assertFrame(
    observed.after,
    { canvasFormat: SDR, intermediate: HDR, labels },
    "resize: after",
  );
  const rebuilt = observed.compiledDuring
    .map((pipeline) => pipeline.label)
    .filter((label) =>
      /PostProcess-(Tonemap|ColorGrading|FXAA|IdentityBlit)/.test(label),
    );
  assert.deepEqual(
    rebuilt,
    [],
    "resize: a plain resize must compile no stage or blit pipeline",
  );
  const blitBefore = observed.before.find((pass) => pass.label === BLIT);
  const blitAfter = observed.after.find((pass) => pass.label === BLIT);
  assert.ok(blitBefore.pipeline, "resize: the blit recorded no pipeline");
  assert.strictEqual(
    blitAfter.pipeline,
    blitBefore.pipeline,
    "resize: the blit pipeline object must be kept across a plain resize",
  );
}

/**
 * Group 5 scenario: a useHDRCanvasOutput toggle with TAA and bloom on. Only the
 * real update and configure pair runs each frame: the effect classes are
 * stubbed, so `execute` is not called. The effects are read back through the
 * pipeline's public getters after each configure call returns.
 *
 * @param {object} api The bundle namespace.
 * @returns {object} The live effect objects after each frame's configure.
 */
function runCanvasToggleEffects(api) {
  const rig = makeRig(api, { highDynamicRange: true, taaEnabled: true });
  rig.collection.bloom.enabled = true;
  const pipeline = rig.allocate(800, 600, SDR, true);
  const frameState = { frameNumber: 1 };
  const configure = (canvasFormat) => {
    api.updateWebGPUPostProcessStages(rig.collection, frameState);
    api.configureWebGPUPostProcessPipeline(
      pipeline,
      rig.collection,
      rig.device,
      canvasFormat,
      rig.scene,
    );
    frameState.frameNumber++;
    return { taa: pipeline.taaEffect, bloom: pipeline.bloomEffect };
  };
  const before = configure(SDR);
  rig.scene.useHDRCanvasOutput = true;
  const toHdrCanvas = configure(HDR);
  rig.scene.useHDRCanvasOutput = false;
  const back = configure(SDR);
  return { before, toHdrCanvas, back };
}

/**
 * Group 5 assertions.
 *
 * @param {object} observed The scenario result.
 */
function checkCanvasToggleEffects(observed) {
  for (const effect of ["taa", "bloom"]) {
    assert.ok(
      observed.before[effect],
      `canvas toggle effects: ${effect} was never added before the toggle, so the group is vacuous`,
    );
    let previous = observed.before[effect];
    for (const frame of ["toHdrCanvas", "back"]) {
      const live = observed[frame][effect];
      assert.ok(
        live,
        `canvas toggle effects: ${effect} is not re-added on the toggle frame (${frame}); it is missing until a later frame`,
      );
      // Non-vacuity: the toggle re-initialised the pipeline and dropped the
      // effect, so the live one must be a fresh object.
      assert.notStrictEqual(
        live,
        previous,
        `canvas toggle effects: ${effect} is the same object across the toggle (${frame}), so the toggle dropped nothing`,
      );
      previous = live;
    }
  }
}

/**
 * Requires a check to fail with a format-law or pass-list assertion: the mutant
 * has made the fix unreachable. A red for any other reason (a harness fault, a
 * thrown TypeError) does not count, so a broken rig cannot pass as a kill.
 *
 * @param {Function} check The assertion to run.
 * @param {string} name What must go red.
 * @param {RegExp} reason The failure message the kill must carry.
 * @returns {string} The failure message, for the test's diagnostics.
 */
function expectRed(check, name, reason) {
  let failure = null;
  try {
    check();
  } catch (error) {
    failure = error;
  }
  assert.ok(failure, `${name} must go RED when the fix is unreachable`);
  assert.ok(
    failure instanceof assert.AssertionError,
    `${name} failed with a non-assertion error: ${failure}`,
  );
  assert.match(
    String(failure.message),
    reason,
    `${name} went RED for the wrong reason`,
  );
  return failure.message;
}

// ── Baseline: the contract on the real code ────────────────────────────────

test("group 1: the blit and every stage follow a useHDRCanvasOutput toggle", async () => {
  const api = await load();
  for (const hdr of [true, false]) {
    checkCanvasToggle(runCanvasToggle(api, hdr), hdr);
  }
});

test("group 2: a highDynamicRange toggle retargets Tonemap, ColorGrading and FXAA on the same pipeline", async () => {
  const api = await load();
  checkHdrToggleSamePipeline(runHdrToggleSamePipeline(api));
});

test("group 3: a replaced pipeline's first frame encodes ColorGrading at the new format", async () => {
  const api = await load();
  checkHdrToggleReplacedPipeline(runHdrToggleReplacedPipeline(api));
});

test("group 4: a plain resize compiles no stage or blit pipeline and keeps the blit", async () => {
  const api = await load();
  checkResize(runResize(api));
});

test("group 5: the effects a useHDRCanvasOutput toggle drops are re-added on the toggle frame", async () => {
  const api = await load();
  checkCanvasToggleEffects(runCanvasToggleEffects(api));
});

test("non-vacuity: the first frame compiled a pipeline per stage with a recorded format", async () => {
  const api = await load();
  const rig = makeRig(api, { highDynamicRange: true });
  const pipeline = rig.allocate(800, 600, SDR, true);
  rig.frame(pipeline, SDR);
  const labels = rig.log.pipelines.map((entry) => entry.label);
  for (const needle of ["Tonemap", "ColorGrading", "FXAA", "IdentityBlit"]) {
    assert.ok(
      labels.some((label) => label.includes(needle)),
      `no ${needle} pipeline was compiled; the format module is stubbed`,
    );
  }
  assert.ok(
    rig.log.pipelines.every((entry) => typeof entry.format === "string"),
  );
});

// ── Inertness mutants: one per assertion group ─────────────────────────────
//
// Each mutant must go RED for the reason its group asserts (a format
// disagreement, a missing pass, a recompiled pipeline), not merely throw.

const FORMAT_RED = /was built for|blit pipeline format|intermediate format/;

test("mutant G1a: the identity-blit rebuild unreachable turns group 1 RED", async (t) => {
  const api = await load({
    label: "G1a blit rebuild unreachable",
    mutatePipeline: (source) =>
      mutateOrFail(
        source,
        (text) =>
          text.replace("if (outputChanged) {", "if (false && outputChanged) {"),
        "G1a",
      ),
  });
  for (const hdr of [true, false]) {
    t.diagnostic(
      expectRed(
        () => checkCanvasToggle(runCanvasToggle(api, hdr), hdr),
        `group 1 (hdr=${hdr})`,
        FORMAT_RED,
      ),
    );
  }
});

test("mutant G1b: the per-frame canvas-format follow unreachable turns group 1 RED", async (t) => {
  const api = await load({
    label: "G1b canvas-format follow unreachable",
    mutateBridge: (source) =>
      mutateOrFail(
        source,
        (text) =>
          text.replace(
            "pipeline.setCanvasFormat(canvasFormat);",
            "if (false) pipeline.setCanvasFormat(canvasFormat);",
          ),
        "G1b",
      ),
  });
  for (const hdr of [true, false]) {
    t.diagnostic(
      expectRed(
        () => checkCanvasToggle(runCanvasToggle(api, hdr), hdr),
        `group 1 (hdr=${hdr})`,
        FORMAT_RED,
      ),
    );
  }
});

test("mutant G2a: the in-place stage retarget unreachable turns group 2 RED", async (t) => {
  const api = await load({
    label: "G2a retarget unreachable",
    mutatePipeline: (source) =>
      mutateOrFail(
        source,
        (text) =>
          text.replace("if (sameDevice) {", "if (false && sameDevice) {"),
        "G2a",
      ),
  });
  t.diagnostic(
    expectRed(
      () => checkHdrToggleSamePipeline(runHdrToggleSamePipeline(api)),
      "group 2",
      FORMAT_RED,
    ),
  );
});

for (const stage of ["_tonemapStage", "_colorGradingStage", "_fxaaStage"]) {
  test(`mutant G2: leaving ${stage} off the retarget list turns group 2 RED`, async (t) => {
    const api = await load({
      label: `G2 ${stage} off the retarget list`,
      mutatePipeline: (source) =>
        mutateOrFail(
          source,
          (text) =>
            text.replace(
              `          this.${stage},
`,
              "",
            ),
          `G2 ${stage}`,
        ),
    });
    t.diagnostic(
      expectRed(
        () => checkHdrToggleSamePipeline(runHdrToggleSamePipeline(api)),
        `group 2 without ${stage}`,
        FORMAT_RED,
      ),
    );
  });
}

test("mutant G3: the sticky ColorGrading latch restored turns group 3 RED", async (t) => {
  const api = await load({
    label: "G3 sticky latch restored",
    mutateBridge: (source) =>
      mutateOrFail(
        source,
        (text) =>
          text.replace(
            "if (cache.colorGradingEnabled && !pipeline.hasColorGradingStage) {",
            "if (cache.colorGradingEnabled && !cache.colorGradingInitialized) {",
          ),
        "G3",
      ),
  });
  t.diagnostic(
    expectRed(
      () => checkHdrToggleReplacedPipeline(runHdrToggleReplacedPipeline(api)),
      "group 3",
      /the encoded pass list/,
    ),
  );
});

test("mutant G4: rebuilding the blit on every initialize turns group 4 RED", async (t) => {
  const api = await load({
    label: "G4 blit rebuilt on every recreate",
    mutatePipeline: (source) =>
      mutateOrFail(
        source,
        (text) =>
          text.replace(
            "this._device !== device || this._canvasFormat !== canvasFormat;",
            "true;",
          ),
        "G4",
      ),
  });
  t.diagnostic(
    expectRed(
      () => checkResize(runResize(api)),
      "group 4",
      /compile no stage|blit pipeline object/,
    ),
  );
});

test("mutant G5: following the canvas format after the TAA gate turns group 5 RED", async (t) => {
  const follow = "  pipeline.setCanvasFormat(canvasFormat);\n";
  const anchor = "  pipeline.autoExposureEnabled =";
  const api = await load({
    label: "G5 canvas-format follow moved below the TAA gate",
    mutateBridge: (source) =>
      mutateOrFail(
        source,
        (text) => {
          // Both anchors must be present exactly once, or the move is not the
          // one this mutant names.
          if (
            text.split(follow).length !== 2 ||
            text.split(anchor).length !== 2
          ) {
            return text;
          }
          return text.replace(follow, "").replace(anchor, follow + anchor);
        },
        "G5",
      ),
  });
  t.diagnostic(
    expectRed(
      () => checkCanvasToggleEffects(runCanvasToggleEffects(api)),
      "group 5",
      /is not re-added on the toggle frame/,
    ),
  );
});
