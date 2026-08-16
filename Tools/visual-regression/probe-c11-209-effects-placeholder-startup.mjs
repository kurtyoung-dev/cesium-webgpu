#!/usr/bin/env node
/**
 * C11-209 real Edge/WebGPU startup acceptance for the effects depth
 * placeholders. Native wrappers are installed before Cesium requests a device
 * and attribute only the exact initialization encoder/command buffer.
 * @purpose Startup acceptance that the effects depth-placeholder init encoder creates exactly the expected textures/views/passes, via native WebGPU API wrappers
 * @status ACTIVE
 *
 * Run with the repository dev server already listening on localhost:8080:
 *   node Tools/visual-regression/probe-c11-209-effects-placeholder-startup.mjs
 */

import fs from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { chromium } from "playwright";
import sharp from "sharp";
import {
  armWebGPUDevices,
  attachConsoleErrorGate,
  collectGateErrors,
  errorGateInit,
} from "../lib/webgpu-error-gate.mjs";
import {
  C11_209_RUNTIME_PATH,
  collectC11209SourceBuildProvenance,
  evaluateC11209Provenance,
  fingerprintBytes,
} from "./lib/c11-209-effects-placeholder-provenance.mjs";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const HEADED = process.env.PROBE_HEADED === "1";
const OUTPUT = path.resolve(
  "Tools/visual-regression/output/performance/c11-209-effects-placeholder-startup.json",
);
const FIRST_RED = path.resolve(
  "Tools/visual-regression/output/performance/c11-209-effects-placeholder-startup.first-red.json",
);
const TARGET_ENCODER = "Initialize effects depth placeholders";
const STEADY_FRAMES = 24;
const WATCHDOG_MS = 240_000;
const EXPECTED_TARGET_COUNTS = Object.freeze({
  textures: 3,
  views: 13,
  encoders: 1,
  passes: 11,
  finishes: 1,
  commandBuffers: 1,
  submits: 1,
});
const TARGET_TEXTURE_LABELS = Object.freeze([
  "Placeholder shadow depth 1x1",
  "Placeholder CSM cascade array 1x1x4",
  "Placeholder point-light cube depth 1x1x6",
]);

/** Runs before application code and wraps the native WebGPU boundaries. */
function installNativeAudit() {
  if (globalThis.__c11209NativeAudit) {
    return;
  }

  const targetEncoderLabel = "Initialize effects depth placeholders";
  const targetTextureLabels = new Set([
    "Placeholder shadow depth 1x1",
    "Placeholder CSM cascade array 1x1x4",
    "Placeholder point-light cube depth 1x1x6",
  ]);
  const textureRecords = new WeakMap();
  const viewRecords = new WeakMap();
  const encoderRecords = new WeakMap();
  const passRecords = new WeakMap();
  const commandBufferRecords = new WeakMap();
  let nextObjectId = 1;

  const audit = {
    installedAt: "pre-navigation init script",
    sequence: [{ index: 0, event: "audit-installed" }],
    requestDeviceCalls: 0,
    requestDeviceHooksReady: [],
    textures: [],
    encoders: [],
    targetSubmits: [],
    instrumentation: {
      installed: [],
      failures: [],
      required: [
        "GPUAdapter.requestDevice",
        "GPUDevice.createTexture",
        "GPUTexture.createView",
        "GPUDevice.createCommandEncoder",
        "GPUCommandEncoder.beginRenderPass",
        "GPURenderPassEncoder.end",
        "GPUCommandEncoder.finish",
        "GPUQueue.submit",
      ],
    },
  };
  globalThis.__c11209NativeAudit = audit;

  function event(name, detail = undefined) {
    const entry = { index: audit.sequence.length, event: name };
    if (detail !== undefined) {
      entry.detail = detail;
    }
    audit.sequence.push(entry);
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

  function copySize(size) {
    if (Array.isArray(size) || ArrayBuffer.isView(size)) {
      return Array.from(size);
    }
    if (size && typeof size === "object") {
      return {
        width: size.width ?? null,
        height: size.height ?? 1,
        depthOrArrayLayers: size.depthOrArrayLayers ?? 1,
      };
    }
    return size ?? null;
  }

  function copyTextureDescriptor(descriptor = {}) {
    return {
      label: String(descriptor.label ?? ""),
      size: copySize(descriptor.size),
      format: descriptor.format ?? null,
      usage: descriptor.usage ?? null,
      dimension: descriptor.dimension ?? "2d",
      mipLevelCount: descriptor.mipLevelCount ?? 1,
      sampleCount: descriptor.sampleCount ?? 1,
    };
  }

  function copyViewDescriptor(descriptor) {
    if (descriptor === undefined) {
      return null;
    }
    return {
      label: descriptor.label ?? null,
      format: descriptor.format ?? null,
      dimension: descriptor.dimension ?? null,
      aspect: descriptor.aspect ?? "all",
      baseMipLevel: descriptor.baseMipLevel ?? 0,
      mipLevelCount: descriptor.mipLevelCount ?? null,
      baseArrayLayer: descriptor.baseArrayLayer ?? 0,
      arrayLayerCount: descriptor.arrayLayerCount ?? null,
    };
  }

  function publicSnapshot() {
    return JSON.parse(
      JSON.stringify({
        installedAt: audit.installedAt,
        sequence: audit.sequence,
        requestDeviceCalls: audit.requestDeviceCalls,
        requestDeviceHooksReady: audit.requestDeviceHooksReady,
        textures: audit.textures,
        encoders: audit.encoders,
        targetSubmits: audit.targetSubmits,
        instrumentation: audit.instrumentation,
      }),
    );
  }
  audit.snapshot = publicSnapshot;

  patch(
    globalThis.GPUDevice?.prototype,
    "createTexture",
    "GPUDevice.createTexture",
    (original) =>
      function (descriptor) {
        const texture = original.call(this, descriptor);
        const label = String(descriptor?.label ?? texture?.label ?? "");
        if (targetTextureLabels.has(label)) {
          const record = {
            id: nextObjectId++,
            label,
            descriptor: copyTextureDescriptor(descriptor),
            views: [],
          };
          textureRecords.set(texture, record);
          audit.textures.push(record);
          event("target-texture", { id: record.id, label });
        }
        return texture;
      },
  );

  patch(
    globalThis.GPUTexture?.prototype,
    "createView",
    "GPUTexture.createView",
    (original) =>
      function (...args) {
        const view = original.apply(this, args);
        const texture = textureRecords.get(this);
        if (texture) {
          const record = {
            id: nextObjectId++,
            textureId: texture.id,
            textureLabel: texture.label,
            descriptorProvided: args.length > 0,
            descriptor: copyViewDescriptor(args[0]),
          };
          texture.views.push(record);
          viewRecords.set(view, record);
        }
        return view;
      },
  );

  patch(
    globalThis.GPUDevice?.prototype,
    "createCommandEncoder",
    "GPUDevice.createCommandEncoder",
    (original) =>
      function (descriptor = {}) {
        const encoder = original.call(this, descriptor);
        const label = String(descriptor?.label ?? encoder?.label ?? "");
        if (label === targetEncoderLabel) {
          const record = {
            id: nextObjectId++,
            label,
            passes: [],
            finishCount: 0,
            commandBufferIds: [],
            submitCount: 0,
          };
          encoderRecords.set(encoder, record);
          audit.encoders.push(record);
          event("target-encoder", { id: record.id, label });
        }
        return encoder;
      },
  );

  patch(
    globalThis.GPUCommandEncoder?.prototype,
    "beginRenderPass",
    "GPUCommandEncoder.beginRenderPass",
    (original) =>
      function (descriptor) {
        const pass = original.call(this, descriptor);
        const encoder = encoderRecords.get(this);
        if (encoder) {
          const depth = descriptor?.depthStencilAttachment;
          const view = viewRecords.get(depth?.view);
          const record = {
            id: nextObjectId++,
            encoderId: encoder.id,
            colorAttachmentsIsArray: Array.isArray(
              descriptor?.colorAttachments,
            ),
            colorAttachmentCount: descriptor?.colorAttachments?.length ?? null,
            depth: {
              depthClearValue: depth?.depthClearValue ?? null,
              depthLoadOp: depth?.depthLoadOp ?? null,
              depthStoreOp: depth?.depthStoreOp ?? null,
              view: view ? { ...view } : null,
            },
            endCount: 0,
          };
          encoder.passes.push(record);
          passRecords.set(pass, record);
        }
        return pass;
      },
  );

  patch(
    globalThis.GPURenderPassEncoder?.prototype,
    "end",
    "GPURenderPassEncoder.end",
    (original) =>
      function (...args) {
        const result = original.apply(this, args);
        const pass = passRecords.get(this);
        if (pass) {
          pass.endCount++;
        }
        return result;
      },
  );

  patch(
    globalThis.GPUCommandEncoder?.prototype,
    "finish",
    "GPUCommandEncoder.finish",
    (original) =>
      function (...args) {
        const commandBuffer = original.apply(this, args);
        const encoder = encoderRecords.get(this);
        if (encoder) {
          const commandBufferId = nextObjectId++;
          encoder.finishCount++;
          encoder.commandBufferIds.push(commandBufferId);
          commandBufferRecords.set(commandBuffer, {
            id: commandBufferId,
            encoder,
          });
        }
        return commandBuffer;
      },
  );

  patch(
    globalThis.GPUQueue?.prototype,
    "submit",
    "GPUQueue.submit",
    (original) =>
      function (commandBuffers) {
        const buffers = Array.from(commandBuffers ?? []);
        const targetBuffers = buffers
          .map((buffer) => commandBufferRecords.get(buffer))
          .filter(Boolean);
        let record;
        if (targetBuffers.length > 0) {
          record = {
            id: nextObjectId++,
            commandBufferCount: buffers.length,
            targetCommandBufferIds: targetBuffers.map((item) => item.id),
            targetEncoderIds: targetBuffers.map((item) => item.encoder.id),
            threw: null,
          };
          audit.targetSubmits.push(record);
        }
        try {
          const result = original.call(this, commandBuffers);
          for (const item of targetBuffers) {
            item.encoder.submitCount++;
          }
          return result;
        } catch (error) {
          if (record) {
            record.threw = String(error);
          }
          throw error;
        }
      },
  );

  patch(
    globalThis.GPUAdapter?.prototype,
    "requestDevice",
    "GPUAdapter.requestDevice",
    (original) =>
      async function (...args) {
        audit.requestDeviceCalls++;
        const installed = new Set(audit.instrumentation.installed);
        const requiredBeforeDevice = audit.instrumentation.required.filter(
          (name) => name !== "GPUAdapter.requestDevice",
        );
        audit.requestDeviceHooksReady.push(
          requiredBeforeDevice.every((name) => installed.has(name)) &&
            audit.instrumentation.failures.length === 0,
        );
        event("request-device");
        const device = await original.apply(this, args);
        globalThis.__armWebGPUDevice?.(device, "c11-209-startup");
        return device;
      },
  );
}

function summarizeCounts(snapshot) {
  return {
    textures: snapshot?.textures?.length ?? 0,
    views:
      snapshot?.textures?.reduce(
        (sum, texture) => sum + texture.views.length,
        0,
      ) ?? 0,
    encoders: snapshot?.encoders?.length ?? 0,
    passes:
      snapshot?.encoders?.reduce(
        (sum, encoder) => sum + encoder.passes.length,
        0,
      ) ?? 0,
    finishes:
      snapshot?.encoders?.reduce(
        (sum, encoder) => sum + encoder.finishCount,
        0,
      ) ?? 0,
    commandBuffers:
      snapshot?.encoders?.reduce(
        (sum, encoder) => sum + encoder.commandBufferIds.length,
        0,
      ) ?? 0,
    submits: snapshot?.targetSubmits?.length ?? 0,
  };
}

function evaluateChecks(
  provenance,
  evidence,
  gate,
  pageErrors,
  consoleErrors,
  requests,
) {
  const checks = [];
  const add = (name, pass, detail, structural = false) => {
    checks.push({ name, pass: Boolean(pass), structural, detail });
  };
  const snapshot = evidence?.after;
  const instrumentation = snapshot?.instrumentation ?? {};
  const installed = new Set(instrumentation.installed ?? []);
  const required = instrumentation.required ?? [];
  const encoder = snapshot?.encoders?.[0];
  const passes = encoder?.passes ?? [];
  const textureList = snapshot?.textures ?? [];
  const textureLabelCounts = Object.fromEntries(
    TARGET_TEXTURE_LABELS.map((label) => [
      label,
      textureList.filter((texture) => texture.label === label).length,
    ]),
  );
  const textures = Object.fromEntries(
    textureList.map((texture) => [texture.label, texture]),
  );
  const base = textures["Placeholder shadow depth 1x1"];
  const csm = textures["Placeholder CSM cascade array 1x1x4"];
  const cube = textures["Placeholder point-light cube depth 1x1x6"];
  const passesFor = (texture) =>
    passes.filter((pass) => pass.depth.view?.textureId === texture?.id);
  const basePasses = passesFor(base);
  const csmPasses = passesFor(csm);
  const cubePasses = passesFor(cube);
  const exactTexture = (texture, label, size) =>
    texture?.label === label &&
    JSON.stringify(texture.descriptor?.size) === JSON.stringify(size) &&
    texture.descriptor?.format === "depth32float" &&
    texture.descriptor?.dimension === "2d";

  add(
    "source, built bundle, and served runtime identities are exact and stable",
    provenance?.ok === true,
    provenance,
    true,
  );

  add(
    "all required native hooks installed before the first device request",
    required.length === 8 &&
      required.every((name) => installed.has(name)) &&
      (instrumentation.failures?.length ?? 0) === 0 &&
      snapshot?.requestDeviceCalls >= 1 &&
      snapshot?.requestDeviceHooksReady?.every(Boolean),
    {
      installed: instrumentation.installed,
      required,
      failures: instrumentation.failures,
      requestDeviceCalls: snapshot?.requestDeviceCalls,
      requestDeviceHooksReady: snapshot?.requestDeviceHooksReady,
      sequence: snapshot?.sequence,
    },
    true,
  );
  add(
    "a real WebGPU scene and device are live",
    evidence?.isWebGPU === true && evidence?.deviceAvailable === true,
    {
      isWebGPU: evidence?.isWebGPU,
      rendererType: evidence?.rendererType,
      deviceAvailable: evidence?.deviceAvailable,
    },
    true,
  );
  add(
    "exactly one effects-placeholder encoder was created",
    snapshot?.encoders?.length === 1 && encoder?.label === TARGET_ENCODER,
    snapshot?.encoders,
    true,
  );
  add(
    "all three target texture labels occur exactly once",
    textureList.length === TARGET_TEXTURE_LABELS.length &&
      TARGET_TEXTURE_LABELS.every((label) => textureLabelCounts[label] === 1) &&
      textureList.every((texture) =>
        TARGET_TEXTURE_LABELS.includes(texture.label),
      ),
    { labels: textureList.map((texture) => texture.label), textureLabelCounts },
    true,
  );
  add(
    "the target encoder produced one finished command buffer",
    encoder?.finishCount === 1 && encoder?.commandBufferIds?.length === 1,
    {
      finishCount: encoder?.finishCount,
      commandBufferIds: encoder?.commandBufferIds,
    },
  );
  add(
    "the exact target command buffer was submitted once and alone",
    snapshot?.targetSubmits?.length === 1 &&
      encoder?.submitCount === 1 &&
      snapshot.targetSubmits[0].commandBufferCount === 1 &&
      snapshot.targetSubmits[0].targetCommandBufferIds?.length === 1 &&
      snapshot.targetSubmits[0].targetCommandBufferIds[0] ===
        encoder?.commandBufferIds?.[0] &&
      snapshot.targetSubmits[0].targetEncoderIds?.[0] === encoder?.id &&
      snapshot.targetSubmits[0].threw === null,
    { submitCount: encoder?.submitCount, submits: snapshot?.targetSubmits },
  );
  add(
    "exactly eleven depth-only clear/store passes ended once",
    passes.length === 11 &&
      passes.every(
        (pass) =>
          pass.colorAttachmentsIsArray === true &&
          pass.colorAttachmentCount === 0 &&
          pass.depth.depthClearValue === 1 &&
          pass.depth.depthLoadOp === "clear" &&
          pass.depth.depthStoreOp === "store" &&
          pass.depth.view !== null &&
          pass.endCount === 1,
      ),
    passes,
  );
  add(
    "base depth pass uses the exact default view of the 1x1x1 texture",
    exactTexture(base, "Placeholder shadow depth 1x1", [1, 1, 1]) &&
      base?.views?.length === 1 &&
      base.views[0].descriptorProvided === false &&
      base.views[0].descriptor === null &&
      basePasses.length === 1 &&
      basePasses[0].depth.view?.id === base.views[0].id,
    { texture: base, passes: basePasses },
  );
  add(
    "CSM passes cover exact layers 0..3 and retain the aggregate array view",
    exactTexture(csm, "Placeholder CSM cascade array 1x1x4", [1, 1, 4]) &&
      csmPasses.length === 4 &&
      JSON.stringify(
        csmPasses.map((pass) => pass.depth.view?.descriptor?.baseArrayLayer),
      ) === JSON.stringify([0, 1, 2, 3]) &&
      csmPasses.every(
        (pass) =>
          pass.depth.view?.descriptor?.dimension === "2d" &&
          pass.depth.view?.descriptor?.arrayLayerCount === 1,
      ) &&
      csm?.views?.length === 5 &&
      csm.views.some(
        (view) =>
          view.descriptor?.dimension === "2d-array" &&
          view.descriptor?.baseArrayLayer === 0 &&
          view.descriptor?.arrayLayerCount === 4,
      ),
    { texture: csm, passes: csmPasses },
  );
  add(
    "cube passes cover exact faces 0..5 and retain the aggregate cube view",
    exactTexture(cube, "Placeholder point-light cube depth 1x1x6", [1, 1, 6]) &&
      cubePasses.length === 6 &&
      JSON.stringify(
        cubePasses.map((pass) => pass.depth.view?.descriptor?.baseArrayLayer),
      ) === JSON.stringify([0, 1, 2, 3, 4, 5]) &&
      cubePasses.every(
        (pass) =>
          pass.depth.view?.descriptor?.dimension === "2d" &&
          pass.depth.view?.descriptor?.arrayLayerCount === 1 &&
          pass.depth.view?.descriptor?.aspect === "depth-only",
      ) &&
      cube?.views?.length === 7 &&
      cube.views.some(
        (view) =>
          view.descriptor?.dimension === "cube" &&
          view.descriptor?.aspect === "depth-only",
      ),
    { texture: cube, passes: cubePasses },
  );
  add(
    "the initialized target count vector is exact and non-vacuous",
    JSON.stringify(evidence?.steady?.targetCountsBefore) ===
      JSON.stringify(EXPECTED_TARGET_COUNTS),
    {
      expected: EXPECTED_TARGET_COUNTS,
      actual: evidence?.steady?.targetCountsBefore,
    },
    true,
  );
  const zeroDelta = Object.fromEntries(
    Object.keys(EXPECTED_TARGET_COUNTS).map((key) => [key, 0]),
  );
  add(
    "twenty-four cached steady frames create the exact zero-delta vector",
    evidence?.steady?.requestedFrames === STEADY_FRAMES &&
      evidence?.steady?.sceneFrameDelta >= STEADY_FRAMES &&
      JSON.stringify(evidence?.steady?.targetCountDelta) ===
        JSON.stringify(zeroDelta) &&
      JSON.stringify(evidence?.steady?.targetCountsAfter) ===
        JSON.stringify(EXPECTED_TARGET_COUNTS),
    { ...evidence?.steady, expectedZeroDelta: zeroDelta },
  );
  add(
    "the scored scene is visible and non-vacuous",
    evidence?.visible?.canvasWidth > 0 &&
      evidence?.visible?.canvasHeight > 0 &&
      evidence?.visible?.globeTilesToRender > 0 &&
      evidence?.visible?.screenshot?.nonBlackFraction > 0.05 &&
      evidence?.visible?.screenshot?.distinctQuantizedColors >= 8 &&
      evidence?.visible?.screenshot?.lumaStddev > 1,
    evidence?.visible,
    true,
  );
  add(
    "scene render-error gate is empty",
    (evidence?.renderErrors?.length ?? -1) === 0,
    evidence?.renderErrors,
  );
  add(
    "WebGPU validation/device-loss gate is armed and empty",
    gate.armedDevices > 0 && gate.errors.length === 0 && !gate.deviceLost,
    gate,
  );
  add(
    "page, console, and local-request error gates are empty",
    pageErrors.length === 0 &&
      consoleErrors.length === 0 &&
      requests.length === 0,
    { pageErrors, consoleErrors, localRequestFailures: requests },
  );
  return checks;
}

async function analyzeScreenshot(png) {
  const { data, info } = await sharp(png)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const colors = new Set();
  let nonBlack = 0;
  let sum = 0;
  let sumSquares = 0;
  const pixels = info.width * info.height;
  for (let index = 0; index < data.length; index += info.channels) {
    const red = data[index];
    const green = data[index + 1];
    const blue = data[index + 2];
    if (red + green + blue > 24) {
      nonBlack++;
    }
    const luma = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    sum += luma;
    sumSquares += luma * luma;
    colors.add(`${red >> 4},${green >> 4},${blue >> 4}`);
  }
  const mean = sum / pixels;
  return {
    width: info.width,
    height: info.height,
    pixels,
    nonBlackPixels: nonBlack,
    nonBlackFraction: nonBlack / pixels,
    distinctQuantizedColors: colors.size,
    meanLuma: mean,
    lumaStddev: Math.sqrt(Math.max(0, sumSquares / pixels - mean * mean)),
  };
}

const artifact = {
  schemaVersion: 2,
  runId: randomUUID(),
  campaignItem: "C11-209",
  startedAt: new Date().toISOString(),
  generatedAt: new Date().toISOString(),
  status: "RUNNING",
  pass: false,
  exitCode: 2,
  incomplete: true,
  base: BASE,
  browser: "msedge",
  diagnosticOnly: true,
  firstRed: {
    path: FIRST_RED,
    policy: "write-once",
    existedBefore: fs.existsSync(FIRST_RED),
    written: false,
    preserved: false,
  },
  checks: [],
  failures: [],
  provenance: {
    policy:
      "exact source-map embedding, stable source/build/probe/policy hashes, and served index.js hash equality",
    start: collectC11209SourceBuildProvenance(),
    end: null,
    servedRuntime: { path: C11_209_RUNTIME_PATH, responses: [] },
    verdict: null,
  },
  evidence: undefined,
};

class StructuralProbeError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = "StructuralProbeError";
    this.detail = detail;
  }
}

let exitCode = 2;
let browser;
fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
// Replace any stale final before work begins. An interrupted process therefore
// leaves an explicit incomplete record rather than yesterday's PASS.
fs.writeFileSync(OUTPUT, `${JSON.stringify(artifact, null, 2)}\n`);
const watchdog = setTimeout(() => {
  exitCode = 2;
  artifact.generatedAt = new Date().toISOString();
  artifact.status = "ERROR";
  artifact.pass = false;
  artifact.exitCode = exitCode;
  artifact.incomplete = false;
  artifact.failures = [
    {
      name: "watchdog",
      structural: true,
      detail: `C11-209 probe exceeded ${WATCHDOG_MS} ms`,
    },
  ];
  artifact.firstRed.preserved = artifact.firstRed.existedBefore;
  if (!artifact.firstRed.existedBefore) {
    artifact.firstRed.written = true;
  }
  const serialized = `${JSON.stringify(artifact, null, 2)}\n`;
  fs.writeFileSync(OUTPUT, serialized);
  if (artifact.firstRed.written) {
    fs.writeFileSync(FIRST_RED, serialized);
  }
  console.error(`ERROR: C11-209 probe exceeded ${WATCHDOG_MS} ms`);
  process.exit(exitCode);
}, WATCHDOG_MS);
try {
  if (artifact.provenance.start.ok !== true) {
    throw new StructuralProbeError(
      "C11-209 source/build provenance was invalid before browser launch",
      artifact.provenance.start,
    );
  }
  browser = await chromium.launch({
    channel: "msedge",
    headless: !HEADED,
    args: ["--enable-unsafe-webgpu"],
  });
  artifact.browserVersion = browser.version();
  const page = await browser.newPage({
    viewport: { width: 1000, height: 720 },
  });
  const gpuConsoleFaults = attachConsoleErrorGate(page);
  const pageErrors = [];
  const consoleErrors = [];
  const localRequestFailures = [];
  const servedRuntimeTasks = [];
  page.on("pageerror", (error) => {
    pageErrors.push(`pageerror: ${error.message}`);
  });
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(`console.error: ${message.text()}`);
    }
  });
  page.on("requestfailed", (request) => {
    if (request.url().startsWith(BASE)) {
      localRequestFailures.push(
        `${request.failure()?.errorText ?? "request failed"}: ${request.url()}`,
      );
    }
  });
  page.on("response", (response) => {
    let url;
    try {
      url = new URL(response.url());
    } catch {
      return;
    }
    if (
      url.origin !== new URL(BASE).origin ||
      url.pathname !== C11_209_RUNTIME_PATH
    ) {
      return;
    }
    servedRuntimeTasks.push(
      response
        .body()
        .then((body) => ({
          url: response.url(),
          status: response.status(),
          ok: response.ok(),
          ...fingerprintBytes(body),
        }))
        .catch((error) => ({
          url: response.url(),
          status: response.status(),
          ok: false,
          error: String(error?.message ?? error),
        })),
    );
  });

  // Ordering matters: the native requestDevice wrapper arms the shared gate
  // before it returns the device to Cesium, covering startup validation too.
  await page.addInitScript(errorGateInit);
  await page.addInitScript(installNativeAudit);
  const viewerUrl = new URL("/Apps/CesiumViewer/index.html", BASE);
  viewerUrl.searchParams.set("renderer", "webgpu");
  viewerUrl.searchParams.set("offline", "true");
  await page.goto(viewerUrl.href, {
    waitUntil: "domcontentloaded",
    timeout: 90_000,
  });
  await page.waitForFunction(
    () =>
      Boolean(globalThis.viewer?.scene) &&
      globalThis.viewer.scene.context?.isWebGPU === true,
    undefined,
    { timeout: 90_000 },
  );
  const gateArm = await armWebGPUDevices(page);

  const evidence = await page.evaluate(
    async ({ steadyFrames }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const viewer = globalThis.viewer;
      const scene = viewer.scene;
      const context = scene.context;
      const device = context?._device ?? context?.device;
      const audit = globalThis.__c11209NativeAudit;
      const renderErrors = [];
      scene.renderError.addEventListener((_scene, error) => {
        renderErrors.push(String(error?.stack ?? error?.message ?? error));
      });

      const result = {
        isWebGPU: context?.isWebGPU === true,
        rendererType: context?.rendererType ?? null,
        deviceAvailable: Boolean(device),
        fixedTime: "2026-08-11T16:00:00Z",
        manualRenderLoop: true,
        warmFrames: 0,
        readyStreak: 0,
        before: audit?.snapshot?.() ?? null,
        after: null,
        steady: null,
        visible: null,
        renderErrors,
      };
      if (
        !result.isWebGPU ||
        !device ||
        typeof audit?.snapshot !== "function"
      ) {
        return result;
      }

      viewer.useDefaultRenderLoop = false;
      viewer.clock.shouldAnimate = false;
      const fixedTime = C.JulianDate.fromIso8601(result.fixedTime);
      viewer.clock.currentTime = C.JulianDate.clone(fixedTime);
      scene.requestRenderMode = false;
      scene.rethrowRenderErrors = true;
      if (scene.globe) {
        scene.globe.show = true;
      }
      viewer.camera.setView({
        destination: C.Cartesian3.fromDegrees(-75, 35, 12_000_000),
        orientation: {
          heading: 0,
          pitch: -C.Math.PI_OVER_TWO,
          roll: 0,
        },
      });

      const renderFrame = () => {
        scene.requestRender();
        scene.render(fixedTime);
      };
      for (let index = 0; index < 90; index++) {
        renderFrame();
        result.warmFrames++;
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const snapshot = audit.snapshot();
        const globeTiles = scene.globe?._surface?._tilesToRender?.length ?? 0;
        if (snapshot.encoders.length >= 1 && globeTiles > 0) {
          result.readyStreak++;
        } else {
          result.readyStreak = 0;
        }
        if (result.readyStreak >= 3) {
          break;
        }
      }

      result.before = audit.snapshot();
      const frameNumberBefore =
        scene.frameState?.frameNumber ?? scene._frameState?.frameNumber ?? null;
      for (let index = 0; index < steadyFrames; index++) {
        renderFrame();
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      await device.queue.onSubmittedWorkDone();
      const frameNumberAfter =
        scene.frameState?.frameNumber ?? scene._frameState?.frameNumber ?? null;
      result.after = audit.snapshot();
      result.steady = {
        requestedFrames: steadyFrames,
        frameNumberBefore,
        frameNumberAfter,
        sceneFrameDelta:
          Number.isFinite(frameNumberBefore) &&
          Number.isFinite(frameNumberAfter)
            ? frameNumberAfter - frameNumberBefore
            : null,
      };
      result.visible = {
        canvasWidth: scene.canvas.width,
        canvasHeight: scene.canvas.height,
        globeTilesToRender: scene.globe?._surface?._tilesToRender?.length ?? 0,
        globeTilesLoaded: scene.globe?.tilesLoaded ?? null,
        commandListLength:
          scene.frameState?.commandList?.length ??
          scene._frameState?.commandList?.length ??
          null,
        pendingForegroundCount:
          context.asyncResources?.pendingForegroundCount ?? null,
      };
      return result;
    },
    { steadyFrames: STEADY_FRAMES },
  );

  const beforeCounts = summarizeCounts(evidence.before);
  const afterCounts = summarizeCounts(evidence.after);
  evidence.steady = {
    ...evidence.steady,
    targetCountsBefore: beforeCounts,
    targetCountsAfter: afterCounts,
    targetCountDelta: Object.fromEntries(
      Object.keys(afterCounts).map((key) => [
        key,
        afterCounts[key] - beforeCounts[key],
      ]),
    ),
  };
  const canvas = page.locator(".cesium-widget canvas").first();
  const screenshot = await canvas.screenshot({ timeout: 30_000 });
  evidence.visible = {
    ...evidence.visible,
    screenshot: await analyzeScreenshot(screenshot),
  };

  await page.waitForTimeout(150);
  const gate = await collectGateErrors(page);
  const allConsoleErrors = [
    ...new Set([...consoleErrors, ...gpuConsoleFaults]),
  ];
  const allPageErrors = [...new Set(pageErrors)];
  const allRequestFailures = [...new Set(localRequestFailures)];
  artifact.provenance.end = collectC11209SourceBuildProvenance();
  artifact.provenance.servedRuntime.responses =
    await Promise.all(servedRuntimeTasks);
  artifact.provenance.verdict = evaluateC11209Provenance({
    start: artifact.provenance.start,
    end: artifact.provenance.end,
    servedRuntime: artifact.provenance.servedRuntime,
  });
  const checks = evaluateChecks(
    artifact.provenance.verdict,
    evidence,
    gate,
    allPageErrors,
    allConsoleErrors,
    allRequestFailures,
  );
  const failed = checks.filter((check) => !check.pass);
  const structural = failed.filter((check) => check.structural);
  exitCode = structural.length > 0 ? 3 : failed.length > 0 ? 1 : 0;
  artifact.generatedAt = new Date().toISOString();
  artifact.status =
    exitCode === 0 ? "PASS" : exitCode === 3 ? "STRUCTURAL" : "FAIL";
  artifact.pass = exitCode === 0;
  artifact.exitCode = exitCode;
  artifact.incomplete = false;
  artifact.checks = checks;
  artifact.failures = failed.map((check) => ({
    name: check.name,
    structural: check.structural,
    detail: check.detail,
  }));
  artifact.viewer = {
    url: viewerUrl.href,
    renderer: "webgpu",
    offline: true,
    manualRenderLoop: true,
    steadyFrames: STEADY_FRAMES,
  };
  artifact.gateArm = gateArm;
  artifact.webgpuGate = gate;
  artifact.pageErrors = allPageErrors;
  artifact.consoleErrors = allConsoleErrors;
  artifact.localRequestFailures = allRequestFailures;
  artifact.evidence = evidence;
} catch (error) {
  const structural = error instanceof StructuralProbeError;
  exitCode = structural ? 3 : 2;
  const failure = String(error?.stack ?? error);
  artifact.generatedAt = new Date().toISOString();
  artifact.status = structural ? "STRUCTURAL" : "ERROR";
  artifact.pass = false;
  artifact.exitCode = exitCode;
  artifact.incomplete = false;
  artifact.checks = structural
    ? [
        {
          name: "source, built bundle, and served runtime identities are exact and stable",
          pass: false,
          structural: true,
          detail: error.detail,
        },
      ]
    : [];
  artifact.failures = [
    {
      name: structural ? "provenance" : "harness",
      structural: true,
      detail: structural ? error.detail : failure,
    },
  ];
  artifact.error = failure;
} finally {
  if (browser) {
    await browser.close().catch(() => {});
  }
  clearTimeout(watchdog);
  artifact.firstRed.preserved = artifact.firstRed.existedBefore;
  if (exitCode !== 0 && !artifact.firstRed.existedBefore) {
    artifact.firstRed.written = true;
  }
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  const serialized = `${JSON.stringify(artifact, null, 2)}\n`;
  fs.writeFileSync(OUTPUT, serialized);
  if (artifact.firstRed.written) {
    fs.writeFileSync(FIRST_RED, serialized);
  }
}

console.log(JSON.stringify(artifact, null, 2));
console.log(`Artifact: ${OUTPUT}`);
process.exitCode = exitCode;
