#!/usr/bin/env node
/**
 * C11-210 — WebGPU compute-command/list integration acceptance probe.
 * @purpose Acceptance that a real WebGPU compute command appended to Scene's commandList executes inside the product frame encoder across normal/pick/2D lanes
 * @status ACTIVE
 *
 * The probe constructs the real native command through the context-private
 * `_computeCommandClass` factory and lets a custom primitive append it to the
 * Scene command list. Three product lanes are exercised:
 *
 *   1. a normal Scene frame;
 *   2. a synchronous pick mini-frame; and
 *   3. a real wrapped SCENE2D frame with a secondary encoder segment.
 *
 * Every command atomically increments its own storage-buffer counter and writes
 * a sentinel. Native API instrumentation proves that the subject compute pass
 * belongs to the expected frame encoder, that no `ComputeEncoder_*` private
 * encoder/submit appears, and that postExecute settles only after the exact
 * product encoder reaches native queue.submit. The final storage-buffer copy is
 * deliberately isolated in `C11-210 Harness Readback Encoder` and excluded
 * from every product submission count.
 *
 * Usage (with the repository dev server already running):
 *   node Tools/visual-regression/probe-c11-210-compute-command-list.mjs
 *
 * Environment:
 *   PROBE_BASE=http://localhost:8080
 *   PROBE_HEADED=1
 *
 * Exit codes: 0 = pass, 1 = decided product gate failed, 2 = probe/runtime
 * exception, 3 = instrumentation/subject structurally absent.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import {
  armWebGPUDevices,
  attachConsoleErrorGate,
  collectGateErrors,
  errorGateInit,
} from "../lib/webgpu-error-gate.mjs";

const toolDirectory = path.dirname(fileURLToPath(import.meta.url));
const outputPath = path.join(
  toolDirectory,
  "output",
  "performance",
  "c11-210-compute-command-list.json",
);
const baseUrl = process.env.PROBE_BASE || "http://localhost:8080";
const headed = process.env.PROBE_HEADED === "1";
const watchdogMilliseconds = 240_000;
const sentinel = 0x11210ace;
const subjectPassLabelPrefix = "ComputePass_C11-210";
const harnessEncoderLabel = "C11-210 Harness Readback Encoder";

const watchdog = setTimeout(() => {
  console.error(`ERROR: C11-210 probe exceeded ${watchdogMilliseconds} ms`);
  process.exit(2);
}, watchdogMilliseconds);

/** Runs before application code and wraps native WebGPU API boundaries. */
function installNativeAudit() {
  if (globalThis.__c11210NativeAudit) {
    return;
  }

  const encoderRecords = new WeakMap();
  const commandBufferRecords = new WeakMap();
  const passRecords = new WeakMap();
  const pipelineLabels = new WeakMap();
  let nextEncoderId = 1;
  let nextPassId = 1;
  let nextSubmitId = 1;

  const audit = {
    currentLane: "boot",
    lanes: Object.create(null),
    instrumentation: {
      installed: [],
      failures: [],
      required: [
        "GPUDevice.createCommandEncoder",
        "GPUDevice.createComputePipeline",
        "GPUCommandEncoder.beginComputePass",
        "GPUCommandEncoder.finish",
        "GPUComputePassEncoder.setPipeline",
        "GPUComputePassEncoder.dispatchWorkgroups",
        "GPUQueue.submit",
      ],
    },
    beginLane(name) {
      this.currentLane = name;
      this.lanes[name] = {
        name,
        encoders: [],
        passes: [],
        submits: [],
      };
    },
    endLane() {
      this.currentLane = "idle";
    },
  };
  audit.beginLane("boot");
  globalThis.__c11210NativeAudit = audit;

  function laneRecord(name = audit.currentLane) {
    if (!audit.lanes[name]) {
      audit.lanes[name] = {
        name,
        encoders: [],
        passes: [],
        submits: [],
      };
    }
    return audit.lanes[name];
  }

  function snapshotHooks() {
    const hooks = globalThis.__c11210HookState ?? {};
    return Object.fromEntries(
      Object.entries(hooks).map(([name, value]) => [
        name,
        {
          pre: value?.pre ?? 0,
          post: value?.post ?? 0,
          cancel: value?.cancel ?? 0,
        },
      ]),
    );
  }

  function patch(prototype, name, label, wrap) {
    if (!prototype || typeof prototype[name] !== "function") {
      audit.instrumentation.failures.push(`${label}: unavailable`);
      return;
    }
    try {
      const original = prototype[name];
      const wrapped = wrap(original);
      prototype[name] = wrapped;
      if (prototype[name] !== wrapped) {
        throw new Error("prototype assignment did not stick");
      }
      audit.instrumentation.installed.push(label);
    } catch (error) {
      audit.instrumentation.failures.push(`${label}: ${String(error)}`);
    }
  }

  const devicePrototype = globalThis.GPUDevice?.prototype;
  const encoderPrototype = globalThis.GPUCommandEncoder?.prototype;
  const computePassPrototype = globalThis.GPUComputePassEncoder?.prototype;
  const queuePrototype = globalThis.GPUQueue?.prototype;

  patch(
    devicePrototype,
    "createCommandEncoder",
    "GPUDevice.createCommandEncoder",
    (original) =>
      function (descriptor = {}) {
        const encoder = original.call(this, descriptor);
        const record = {
          id: nextEncoderId++,
          lane: audit.currentLane,
          label: String(descriptor?.label ?? encoder?.label ?? ""),
          passes: [],
          finishCount: 0,
          submitCount: 0,
          harness:
            String(descriptor?.label ?? encoder?.label ?? "") ===
            "C11-210 Harness Readback Encoder",
        };
        encoderRecords.set(encoder, record);
        laneRecord(record.lane).encoders.push(record);
        return encoder;
      },
  );

  patch(
    devicePrototype,
    "createComputePipeline",
    "GPUDevice.createComputePipeline",
    (original) =>
      function (descriptor) {
        const pipeline = original.call(this, descriptor);
        pipelineLabels.set(
          pipeline,
          String(descriptor?.label ?? pipeline?.label ?? ""),
        );
        return pipeline;
      },
  );

  patch(
    encoderPrototype,
    "beginComputePass",
    "GPUCommandEncoder.beginComputePass",
    (original) =>
      function (descriptor = {}) {
        const pass = original.call(this, descriptor);
        const encoder = encoderRecords.get(this);
        const record = {
          id: nextPassId++,
          lane: audit.currentLane,
          encoderId: encoder?.id ?? null,
          encoderLabel: encoder?.label ?? "(untracked)",
          descriptorLabel: String(descriptor?.label ?? pass?.label ?? ""),
          pipelineLabel: "",
          dispatches: [],
        };
        passRecords.set(pass, record);
        encoder?.passes.push(record);
        laneRecord().passes.push(record);
        return pass;
      },
  );

  patch(
    computePassPrototype,
    "setPipeline",
    "GPUComputePassEncoder.setPipeline",
    (original) =>
      function (pipeline) {
        const pass = passRecords.get(this);
        if (pass) {
          pass.pipelineLabel = String(
            pipelineLabels.get(pipeline) ?? pipeline?.label ?? "",
          );
        }
        return original.call(this, pipeline);
      },
  );

  patch(
    computePassPrototype,
    "dispatchWorkgroups",
    "GPUComputePassEncoder.dispatchWorkgroups",
    (original) =>
      function (x, y = 1, z = 1) {
        passRecords.get(this)?.dispatches.push({ x, y, z });
        return original.call(this, x, y, z);
      },
  );

  patch(
    encoderPrototype,
    "finish",
    "GPUCommandEncoder.finish",
    (original) =>
      function (...args) {
        const commandBuffer = original.apply(this, args);
        const encoder = encoderRecords.get(this);
        if (encoder) {
          encoder.finishCount++;
          commandBufferRecords.set(commandBuffer, encoder);
        }
        return commandBuffer;
      },
  );

  patch(
    queuePrototype,
    "submit",
    "GPUQueue.submit",
    (original) =>
      function (commandBuffers) {
        const buffers = Array.from(commandBuffers ?? []);
        const encoders = buffers
          .map((buffer) => commandBufferRecords.get(buffer))
          .filter(Boolean);
        const record = {
          id: nextSubmitId++,
          lane: audit.currentLane,
          commandBufferCount: buffers.length,
          encoderIds: encoders.map((encoder) => encoder.id),
          encoderLabels: encoders.map((encoder) => encoder.label),
          harness: encoders.some((encoder) => encoder.harness),
          hooksBeforeNativeSubmit: snapshotHooks(),
          hooksAfterNativeSubmit: null,
          submitThrew: null,
        };
        laneRecord().submits.push(record);
        try {
          const result = original.call(this, commandBuffers);
          for (const encoder of encoders) {
            encoder.submitCount++;
          }
          record.hooksAfterNativeSubmit = snapshotHooks();
          return result;
        } catch (error) {
          record.submitThrew = String(error);
          record.hooksAfterNativeSubmit = snapshotHooks();
          throw error;
        }
      },
  );
}

function subjectPasses(lane) {
  return (lane?.passes ?? []).filter((pass) =>
    pass.descriptorLabel.startsWith(subjectPassLabelPrefix),
  );
}

function evaluateChecks(run, gate, browserErrors, localRequestFailures) {
  const checks = [];
  const add = (name, pass, detail, structural = false) => {
    checks.push({ name, pass: Boolean(pass), detail, structural });
  };

  const instrumentation = run?.instrumentation ?? {};
  const installed = new Set(instrumentation.installed ?? []);
  const required = instrumentation.required ?? [];
  add(
    "all required native WebGPU instrumentation installed",
    required.length > 0 &&
      required.every((name) => installed.has(name)) &&
      (instrumentation.failures?.length ?? 0) === 0,
    instrumentation,
    true,
  );
  add(
    "real context-private WebGPUComputeCommand factory is present",
    run?.commandFactoryAvailable === true &&
      run?.nativeCommandInstances === true,
    {
      commandFactoryAvailable: run?.commandFactoryAvailable,
      commandClassName: run?.commandClassName,
      nativeCommandInstances: run?.nativeCommandInstances,
    },
    true,
  );
  add(
    "WebGPU device and renderer are live",
    run?.isWebGPU === true && run?.deviceAvailable === true,
    { isWebGPU: run?.isWebGPU, deviceAvailable: run?.deviceAvailable },
    true,
  );
  add(
    "SCENE2D search produced a real secondary viewport segment",
    run?.splitSearch?.found === true,
    run?.splitSearch,
    true,
  );

  const expectedEncoderLabels = {
    normal: "Scene Frame Command Encoder",
    pick: "Pick Frame Command Encoder",
    scene2d: "Scene Frame Command Encoder",
  };
  for (const laneName of ["normal", "pick", "scene2d"]) {
    const lane = run?.lanes?.[laneName]?.audit;
    const passes = subjectPasses(lane);
    const hooks = run?.lanes?.[laneName]?.hooks;
    const readback = run?.readback?.[laneName];
    add(
      `${laneName}: exactly one native subject compute pass/dispatch`,
      passes.length === 1 &&
        passes[0].dispatches.length === 1 &&
        passes[0].dispatches[0].x === 1 &&
        passes[0].dispatches[0].y === 1 &&
        passes[0].dispatches[0].z === 1,
      passes,
    );
    add(
      `${laneName}: subject pass belongs to the expected frame encoder`,
      passes.length === 1 &&
        passes[0].encoderLabel === expectedEncoderLabels[laneName],
      passes,
    );
    add(
      `${laneName}: pre/post/cancel settle exactly 1/1/0`,
      hooks?.pre === 1 && hooks?.post === 1 && hooks?.cancel === 0,
      hooks,
    );
    add(
      `${laneName}: storage sentinel and atomic dispatch count are exact`,
      readback?.count === 1 && readback?.sentinel === sentinel,
      readback,
    );
    add(
      `${laneName}: no private per-command encoder exists`,
      !(lane?.encoders ?? []).some((encoder) =>
        encoder.label.startsWith("ComputeEncoder_"),
      ),
      lane?.encoders,
    );
  }

  const normalLane = run?.lanes?.normal?.audit;
  const pickLane = run?.lanes?.pick?.audit;
  const scene2dLane = run?.lanes?.scene2d?.audit;
  add(
    "normal frame retains one Scene-frame product submit",
    normalLane?.submits?.length === 1 &&
      normalLane.submits[0].encoderLabels.length === 1 &&
      normalLane.submits[0].encoderLabels[0] === "Scene Frame Command Encoder",
    normalLane?.submits,
  );
  add(
    "pick mini-frame retains one Pick-frame product submit",
    pickLane?.submits?.length === 1 &&
      pickLane.submits[0].encoderLabels.length === 1 &&
      pickLane.submits[0].encoderLabels[0] === "Pick Frame Command Encoder",
    pickLane?.submits,
  );
  add(
    "SCENE2D split submits first and continuation segments exactly once",
    scene2dLane?.submits?.length === 2 &&
      scene2dLane.submits[0].encoderLabels[0] ===
        "Scene Frame Command Encoder" &&
      scene2dLane.submits[1].encoderLabels[0] ===
        "Secondary Viewport Continuation Encoder",
    scene2dLane?.submits,
  );

  const normalSubmit = normalLane?.submits?.[0];
  const pickSubmit = pickLane?.submits?.[0];
  const first2DSubmit = scene2dLane?.submits?.[0];
  const second2DSubmit = scene2dLane?.submits?.[1];
  add(
    "normal postExecute remains pending through native submit",
    normalSubmit?.hooksBeforeNativeSubmit?.normal?.post === 0 &&
      normalSubmit?.hooksAfterNativeSubmit?.normal?.post === 0 &&
      run?.lanes?.normal?.hooks?.post === 1,
    {
      before: normalSubmit?.hooksBeforeNativeSubmit?.normal,
      afterNative: normalSubmit?.hooksAfterNativeSubmit?.normal,
      afterFrame: run?.lanes?.normal?.hooks,
    },
  );
  add(
    "pick postExecute remains pending through native submit",
    pickSubmit?.hooksBeforeNativeSubmit?.pick?.post === 0 &&
      pickSubmit?.hooksAfterNativeSubmit?.pick?.post === 0 &&
      run?.lanes?.pick?.hooks?.post === 1,
    {
      before: pickSubmit?.hooksBeforeNativeSubmit?.pick,
      afterNative: pickSubmit?.hooksAfterNativeSubmit?.pick,
      afterFrame: run?.lanes?.pick?.hooks,
    },
  );
  add(
    "SCENE2D post settles at first segment before continuation submit",
    first2DSubmit?.hooksBeforeNativeSubmit?.scene2d?.post === 0 &&
      first2DSubmit?.hooksAfterNativeSubmit?.scene2d?.post === 0 &&
      second2DSubmit?.hooksBeforeNativeSubmit?.scene2d?.post === 1 &&
      run?.lanes?.scene2d?.hooks?.post === 1,
    {
      firstBefore: first2DSubmit?.hooksBeforeNativeSubmit?.scene2d,
      firstAfterNative: first2DSubmit?.hooksAfterNativeSubmit?.scene2d,
      secondBefore: second2DSubmit?.hooksBeforeNativeSubmit?.scene2d,
      afterFrame: run?.lanes?.scene2d?.hooks,
    },
  );

  const productEncoders = [normalLane, pickLane, scene2dLane].flatMap(
    (lane) => lane?.encoders ?? [],
  );
  add(
    "every product encoder is finished and submitted exactly once",
    productEncoders.length === 4 &&
      productEncoders.every(
        (encoder) => encoder.finishCount === 1 && encoder.submitCount === 1,
      ),
    productEncoders,
  );
  add(
    "harness readback is explicit and excluded from product submit counts",
    run?.harnessReadback?.encoders?.length === 1 &&
      run.harnessReadback.encoders[0].label === harnessEncoderLabel &&
      run.harnessReadback.encoders[0].harness === true &&
      run.harnessReadback.submits?.length === 1 &&
      run.harnessReadback.submits[0].harness === true &&
      run?.productSubmitCount === 4 &&
      run?.allMeasuredSubmitCount === 5,
    {
      harnessReadback: run?.harnessReadback,
      productSubmitCount: run?.productSubmitCount,
      allMeasuredSubmitCount: run?.allMeasuredSubmitCount,
    },
  );
  add(
    "scene render errors are empty",
    (run?.renderErrors?.length ?? -1) === 0,
    run?.renderErrors,
  );
  add(
    "WebGPU error gate is armed and clean",
    gate.armedDevices > 0 && gate.errors.length === 0 && !gate.deviceLost,
    gate,
  );
  add(
    "browser and local-request error gates are clean",
    browserErrors.length === 0 && localRequestFailures.length === 0,
    { browserErrors, localRequestFailures },
  );
  return checks;
}

await mkdir(path.dirname(outputPath), { recursive: true });

let browser;
let report;
let exitCode;
try {
  browser = await chromium.launch({
    channel: "msedge",
    headless: !headed,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({
    viewport: { width: 1000, height: 720 },
  });
  const gpuConsoleFaults = attachConsoleErrorGate(page);
  const browserErrors = [];
  const localRequestFailures = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      browserErrors.push(`console.error: ${message.text()}`);
    }
  });
  page.on("requestfailed", (request) => {
    const requestUrl = request.url();
    if (requestUrl.startsWith(baseUrl)) {
      localRequestFailures.push(
        `${request.failure()?.errorText ?? "request failed"}: ${requestUrl}`,
      );
    }
  });

  await page.addInitScript(errorGateInit);
  await page.addInitScript(installNativeAudit);
  const viewerUrl = new URL("/Apps/CesiumViewer/index.html", baseUrl);
  viewerUrl.searchParams.set("renderer", "webgpu");
  viewerUrl.searchParams.set("offline", "true");
  await page.goto(viewerUrl.href, {
    waitUntil: "domcontentloaded",
    timeout: 90_000,
  });
  await page.waitForFunction(
    () =>
      Boolean(globalThis.viewer) &&
      globalThis.viewer?.scene?.context?.isWebGPU === true,
    undefined,
    { timeout: 90_000 },
  );
  const gateArm = await armWebGPUDevices(page);

  const run = await page.evaluate(
    async ({ sentinel, harnessEncoderLabel }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const viewer = globalThis.viewer;
      const scene = viewer.scene;
      const context = scene.context;
      const device = context.device;
      const audit = globalThis.__c11210NativeAudit;
      const CommandClass = context._computeCommandClass;
      const fixedTime = C.JulianDate.fromIso8601("2026-08-11T04:00:00Z");
      const laneNames = ["normal", "pick", "scene2d"];
      const renderErrors = [];
      scene.renderError.addEventListener((_scene, error) => {
        renderErrors.push(String(error?.stack ?? error?.message ?? error));
      });

      const structural = {
        commandFactoryAvailable: typeof CommandClass === "function",
        deviceAvailable: Boolean(device),
        isWebGPU: context.isWebGPU === true,
      };
      if (
        !structural.commandFactoryAvailable ||
        !structural.deviceAvailable ||
        !structural.isWebGPU
      ) {
        return {
          ...structural,
          commandClassName: CommandClass?.name ?? null,
          nativeCommandInstances: false,
          instrumentation: JSON.parse(
            JSON.stringify(audit?.instrumentation ?? {}),
          ),
          renderErrors,
        };
      }

      viewer.useDefaultRenderLoop = false;
      viewer.clock.shouldAnimate = false;
      viewer.clock.currentTime = C.JulianDate.clone(fixedTime);
      scene.requestRenderMode = true;
      scene.maximumRenderTimeChange = Infinity;
      scene.globe.show = false;
      if (scene.skyBox) scene.skyBox.show = false;
      if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
      if (scene.sun) scene.sun.show = false;
      if (scene.moon) scene.moon.show = false;
      scene.fog.enabled = false;
      scene.backgroundColor = C.Color.BLACK;

      globalThis.__c11210HookState = Object.fromEntries(
        laneNames.map((name) => [
          name,
          { pre: 0, post: 0, cancel: 0, events: [] },
        ]),
      );
      const hookState = globalThis.__c11210HookState;

      function clone(value) {
        return JSON.parse(JSON.stringify(value));
      }

      function exportLane(name) {
        return clone(audit.lanes[name]);
      }

      function noteHook(name, kind) {
        hookState[name][kind]++;
        hookState[name].events.push({
          kind,
          auditLane: audit.currentLane,
        });
      }

      const shaderSource = `
struct ProbeResult {
  count : atomic<u32>,
  sentinel : u32,
}

@group(0) @binding(0) var<storage, read_write> result : ProbeResult;

@compute @workgroup_size(1)
fn computeMain() {
  atomicAdd(&result.count, 1u);
  result.sentinel = ${sentinel}u;
}
`;
      const bindGroupLayout = device.createBindGroupLayout({
        label: "C11-210 Probe Bind Group Layout",
        entries: [
          {
            binding: 0,
            visibility: GPUShaderStage.COMPUTE,
            buffer: { type: "storage", minBindingSize: 8 },
          },
        ],
      });
      const outputBuffers = {};
      const commands = {};
      for (const name of laneNames) {
        const buffer = device.createBuffer({
          label: `C11-210 ${name} result`,
          size: 8,
          usage:
            GPUBufferUsage.STORAGE |
            GPUBufferUsage.COPY_SRC |
            GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(buffer, 0, new Uint32Array([0, 0]));
        const bindGroup = device.createBindGroup({
          label: `C11-210 ${name} bind group`,
          layout: bindGroupLayout,
          entries: [{ binding: 0, resource: { buffer } }],
        });
        outputBuffers[name] = buffer;
        commands[name] = new CommandClass({
          device,
          shaderSource,
          entryPoint: "computeMain",
          bindGroupLayouts: [bindGroupLayout],
          bindGroups: [{ index: 0, bindGroup }],
          workgroupCountX: 1,
          workgroupCountY: 1,
          workgroupCountZ: 1,
          persists: true,
          label: `C11-210 ${name} command`,
          preExecute: () => noteHook(name, "pre"),
          postExecute: () => noteHook(name, "post"),
          canceled: () => noteHook(name, "cancel"),
        });
      }

      let activeCommand = null;
      let producerDestroyed = false;
      const producer = {
        update(frameState) {
          if (activeCommand) {
            frameState.commandList.push(activeCommand);
          }
        },
        isDestroyed() {
          return producerDestroyed;
        },
        destroy() {
          producerDestroyed = true;
          return undefined;
        },
      };
      scene.primitives.add(producer);

      function forceFrame(name, command = null) {
        audit.beginLane(name);
        activeCommand = command;
        try {
          scene.forceRender(fixedTime);
        } finally {
          activeCommand = null;
        }
        const result = {
          audit: exportLane(name),
          hooks: clone(hookState[name] ?? null),
        };
        audit.endLane();
        return result;
      }

      // Stabilize the blank viewer before measuring product frame shape.
      for (let i = 0; i < 4; i++) {
        forceFrame("warm");
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }

      const lanes = {};
      lanes.normal = forceFrame("normal", commands.normal);

      audit.beginLane("pick");
      activeCommand = commands.pick;
      let pickResultDefined;
      try {
        const center = new C.Cartesian2(
          scene.canvas.clientWidth * 0.5,
          scene.canvas.clientHeight * 0.5,
        );
        pickResultDefined = scene.pick(center, 1, 1) !== undefined;
      } finally {
        activeCommand = null;
      }
      lanes.pick = {
        audit: exportLane("pick"),
        hooks: clone(hookState.pick),
        pickResultDefined,
      };
      audit.endLane();

      scene.morphTo2D(0);
      for (let i = 0; i < 5; i++) {
        forceFrame("scene2d-warm");
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }

      // Find and retain a point destination that produces the real wrapped
      // secondary-viewport path. The subject command stays inactive during the
      // search, so only the final `scene2d` lane contributes sentinel work.
      const splitCandidates = [179, 150, 90, 45, -179, -90];
      const splitAttempts = [];
      let selectedSplitCandidate = null;
      for (let i = 0; i < splitCandidates.length; i++) {
        const candidate = splitCandidates[i];
        viewer.camera.setView({
          destination: C.Cartesian3.fromDegrees(candidate, 20, 1_500_000),
        });
        const attempt = forceFrame(`scene2d-search-${i}`);
        const encoderLabels = attempt.audit.encoders.map(
          (encoder) => encoder.label,
        );
        const split = encoderLabels.includes(
          "Secondary Viewport Continuation Encoder",
        );
        splitAttempts.push({ longitude: candidate, split, encoderLabels });
        if (split) {
          selectedSplitCandidate = candidate;
          break;
        }
      }
      lanes.scene2d = forceFrame("scene2d", commands.scene2d);

      await device.queue.onSubmittedWorkDone();

      // Explicit harness-only readback. Its label/lane are persisted and every
      // product count above excludes this encoder and submission.
      const staging = device.createBuffer({
        label: "C11-210 Harness Readback Buffer",
        size: laneNames.length * 8,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      audit.beginLane("harness-readback");
      const readbackEncoder = device.createCommandEncoder({
        label: harnessEncoderLabel,
      });
      for (let i = 0; i < laneNames.length; i++) {
        readbackEncoder.copyBufferToBuffer(
          outputBuffers[laneNames[i]],
          0,
          staging,
          i * 8,
          8,
        );
      }
      device.queue.submit([readbackEncoder.finish()]);
      const harnessReadback = exportLane("harness-readback");
      audit.endLane();

      await staging.mapAsync(GPUMapMode.READ);
      const mapped = new Uint32Array(staging.getMappedRange()).slice();
      const readback = Object.fromEntries(
        laneNames.map((name, index) => [
          name,
          {
            count: mapped[index * 2],
            sentinel: mapped[index * 2 + 1],
          },
        ]),
      );
      staging.unmap();
      staging.destroy();
      for (const buffer of Object.values(outputBuffers)) {
        buffer.destroy();
      }
      scene.primitives.remove(producer);

      const productSubmitCount = laneNames.reduce(
        (sum, name) => sum + lanes[name].audit.submits.length,
        0,
      );
      const allMeasuredSubmitCount =
        productSubmitCount + harnessReadback.submits.length;
      return {
        ...structural,
        commandClassName: CommandClass.name,
        nativeCommandInstances: Object.values(commands).every(
          (command) =>
            command instanceof CommandClass &&
            command.isWebGPUComputeCommand === true,
        ),
        instrumentation: clone(audit.instrumentation),
        fixedTime: "2026-08-11T04:00:00Z",
        lanes,
        splitSearch: {
          found: selectedSplitCandidate !== null,
          selected: selectedSplitCandidate,
          attempts: splitAttempts,
        },
        readback,
        expectedSentinel: sentinel,
        harnessReadback,
        productSubmitCount,
        allMeasuredSubmitCount,
        renderErrors,
      };
    },
    { sentinel, harnessEncoderLabel },
  );

  await page.waitForTimeout(100);
  const gate = await collectGateErrors(page);
  const allBrowserErrors = [
    ...new Set([...browserErrors, ...gpuConsoleFaults]),
  ];
  const allLocalRequestFailures = [...new Set(localRequestFailures)];
  const checks = evaluateChecks(
    run,
    gate,
    allBrowserErrors,
    allLocalRequestFailures,
  );
  const failed = checks.filter((check) => !check.pass);
  const structural = failed.filter((check) => check.structural);
  exitCode = structural.length > 0 ? 3 : failed.length > 0 ? 1 : 0;
  const status =
    exitCode === 0 ? "PASS" : exitCode === 3 ? "STRUCTURAL" : "FAIL";
  report = {
    probe: "C11-210 WebGPU compute command-list integration",
    generatedAt: new Date().toISOString(),
    status,
    pass: status === "PASS",
    exitCode,
    failures: failed.map((check) => ({
      name: check.name,
      structural: check.structural,
      detail: check.detail,
    })),
    baseUrl,
    viewer: {
      renderer: "webgpu",
      offline: true,
      manualRenderLoop: true,
    },
    gateArm,
    checks,
    evidence: run,
    webgpuGate: gate,
    browserErrors: allBrowserErrors,
    localRequestFailures: allLocalRequestFailures,
  };
} catch (error) {
  exitCode = 2;
  const failure = String(error?.stack ?? error);
  report = {
    probe: "C11-210 WebGPU compute command-list integration",
    generatedAt: new Date().toISOString(),
    status: "ERROR",
    pass: false,
    exitCode,
    failures: [failure],
    checks: [],
    baseUrl,
    error: failure,
  };
} finally {
  if (browser) {
    await browser.close();
  }
  clearTimeout(watchdog);
}

await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
console.log(
  `${report.status}: wrote ${path.relative(process.cwd(), outputPath)}`,
);
process.exitCode = exitCode;
