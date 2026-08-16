#!/usr/bin/env node
/**
 * C11-193B Phase 2 — dynamic-IBL frame-encoder/shared-submit acceptance.
 * @purpose Acceptance that dynamic-IBL refreshes ride the shared scene encoder/submit: no private submits, exact 44-pass contribution per manager.
 * @status ACTIVE
 *
 * This is a real WebGPU/Edge probe. It installs observation-only wrappers at
 * native WebGPU API boundaries before the viewer boots, warms two independent
 * model-owned DynamicEnvironmentMapManagers, and then drives a pinned manual
 * render loop through three lanes:
 *
 *   1. no-refresh control;
 *   2. two same-topology refreshes in one frame; and
 *   3. one accepted topology replacement plus its requested follow-up frame.
 *
 * The queue wrapper snapshots manager state immediately before and after the
 * native `GPUQueue.submit` call. Cesium's exact-segment callbacks run only
 * after that wrapper returns, so those snapshots prove that pending refreshes,
 * dirty bookkeeping, parameter leases, and provisional output graphs remain
 * unsettled through the native submit boundary. The post-render snapshot then
 * proves exact successful settlement.
 *
 * Gates:
 *   - offline=true, local glTF assets, one pinned manual render driver;
 *   - zero private "Dynamic Environment Map Refresh" encoders/submits;
 *   - each manager contributes exactly 44 ordered dynamic-IBL compute passes
 *     (sky + 6 irradiance + 36 radiance + SH) to the same scene encoder;
 *   - refresh and topology frames retain the control frame's one-submit shape;
 *   - same-topology output/view/arena identities stay stable, while managers
 *     retain distinct writable arenas and output graphs;
 *   - pending/needsUpdate state settles only after the exact frame submit;
 *   - topology replacement keeps the raw cube alias fail-closed at submit,
 *     publishes the complete replacement afterward, and requests one follow-up;
 *   - zero browser, WebGPU validation, out-of-memory, or device-loss errors.
 *
 * Usage (with the repository dev server already running):
 *   node Tools/visual-regression/probe-c11-193b-shared-submit.mjs
 *
 * Environment:
 *   PROBE_BASE=http://localhost:8080
 *   PROBE_HEADED=1
 *
 * Exit codes: 0 = pass, 1 = decided product gate failed, 2 = probe/runtime
 * exception, 3 = native instrumentation or subject was structurally absent.
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
  "c11-193b-dynamic-ibl-shared-submit.json",
);
const baseUrl = process.env.PROBE_BASE || "http://localhost:8080";
const headed = process.env.PROBE_HEADED === "1";
const modelUrl =
  "/Apps/SampleData/models/TestKHRExtensions/TestKhrSpecular.gltf";
const maximumWarmFrames = 360;
const idleWarmFramesRequired = 4;
const watchdogMilliseconds = 300_000;

const watchdog = setTimeout(() => {
  console.error(
    `STRUCTURAL: C11-193B probe exceeded ${watchdogMilliseconds} ms`,
  );
  process.exit(2);
}, watchdogMilliseconds);

/** Runs in the page before any application script. */
function installNativeAudit() {
  if (globalThis.__c11193bNativeAudit) {
    return;
  }

  const dynamicPipelineLabels = new Set([
    "DynEnvMap Sky Pipeline",
    "IBL-Irradiance",
    "IBL-Radiance",
    "DynEnvMap SH Pipeline",
  ]);
  const privateEncoderLabel = "Dynamic Environment Map Refresh";
  const objectIds = new WeakMap();
  const encoderRecords = new WeakMap();
  const commandBufferRecords = new WeakMap();
  const passRecords = new WeakMap();
  const pipelineLabels = new WeakMap();
  let nextObjectId = 1;
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
        "GPUCommandEncoder.beginComputePass",
        "GPUCommandEncoder.finish",
        "GPUComputePassEncoder.setPipeline",
        "GPUQueue.submit",
        "GPUDevice.createComputePipeline",
      ],
    },
    privateEncodersCreated: [],
    privateEncoderSubmits: [],
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
  globalThis.__c11193bNativeAudit = audit;

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

  function objectId(value) {
    if (
      value === null ||
      value === undefined ||
      (typeof value !== "object" && typeof value !== "function")
    ) {
      return null;
    }
    let id = objectIds.get(value);
    if (id === undefined) {
      id = nextObjectId++;
      objectIds.set(value, id);
    }
    return id;
  }

  function encoderId(encoder) {
    return encoderRecords.get(encoder)?.id ?? objectId(encoder);
  }

  function managerState(entry) {
    const manager = entry?.manager;
    const cache = manager?._webgpuCache;
    const iblCache = cache?.iblCache;
    const arena = iblCache?.persistentParameterArena;
    const pending = cache?.pendingRefresh;
    const raw = manager?._radianceMap;
    return {
      name: entry?.name ?? "unknown",
      managerId: objectId(manager),
      cacheId: objectId(cache),
      pendingId: objectId(pending),
      pendingEncoderId: encoderId(pending?.encoder),
      pendingScopeId: objectId(pending?.scope),
      pendingScopeOwnsEncoder: pending?.scope?.ownsEncoder ?? null,
      pendingCommitReady: pending != null && pending.commitState !== null,
      pendingEncodingFailed: pending?.encodingFailed ?? null,
      needsUpdate: cache?.needsUpdate ?? null,
      cacheSize: cache?.size ?? null,
      cacheMipmapLevels: cache?.mipmapLevels ?? null,
      cacheCubemapTextureId: objectId(cache?.cubemapTexture),
      cacheCubemapViewId: objectId(cache?.cubemapTextureView),
      rawMapId: objectId(raw),
      publicRawTextureId: objectId(raw?._webgpuTexture),
      publicRawViewId: objectId(raw?._webgpuTextureView),
      iblCacheId: objectId(iblCache),
      irradianceTextureId: objectId(iblCache?.irradianceTexture),
      irradianceViewId: objectId(iblCache?.irradianceView),
      radianceTextureId: objectId(iblCache?.radianceTexture),
      radianceViewId: objectId(iblCache?.radianceView),
      publicDiffuseViewId: objectId(manager?._webgpuIBLDiffuseView),
      publicSpecularViewId: objectId(manager?._webgpuIBLSpecularView),
      shBufferId: objectId(cache?.shBuffer),
      publicSHBufferId: objectId(manager?._webgpuSHBuffer),
      parameterArenaId: objectId(arena),
      parameterBufferId: objectId(arena?.parameterBuffer),
      parameterArenaInUse: arena?.inUse ?? null,
      pendingOutputTransactionId: objectId(iblCache?.pendingOutputTransaction),
      outputTopologyKey: iblCache?.outputTopologyKey ?? null,
      activeOutputTopologyKey: iblCache?.activeOutputTopologyKey ?? null,
    };
  }

  function snapshotManagers() {
    const entries = globalThis.__c11193bManagers;
    return Array.isArray(entries) ? entries.map(managerState) : [];
  }

  audit.snapshotManagers = snapshotManagers;
  audit.objectId = objectId;

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
          finished: false,
        };
        encoderRecords.set(encoder, record);
        laneRecord(record.lane).encoders.push(record);
        if (record.label === privateEncoderLabel) {
          audit.privateEncodersCreated.push({
            id: record.id,
            lane: record.lane,
            label: record.label,
          });
        }
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
          encoderId: encoder?.id ?? objectId(this),
          encoderLabel: encoder?.label ?? "(untracked)",
          descriptorLabel: String(descriptor?.label ?? pass?.label ?? ""),
          pipelineLabel: "",
        };
        passRecords.set(pass, record);
        if (encoder) {
          encoder.passes.push(record);
          laneRecord(encoder.lane).passes.push(record);
        } else {
          laneRecord().passes.push(record);
        }
        return pass;
      },
  );

  patch(
    computePassPrototype,
    "setPipeline",
    "GPUComputePassEncoder.setPipeline",
    (original) =>
      function (pipeline) {
        const record = passRecords.get(this);
        if (record) {
          record.pipelineLabel = String(
            pipelineLabels.get(pipeline) ?? pipeline?.label ?? "",
          );
        }
        return original.call(this, pipeline);
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
          encoder.finished = true;
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
        const dynamicPasses = encoders.flatMap((encoder) =>
          encoder.passes.filter((pass) =>
            dynamicPipelineLabels.has(pass.pipelineLabel),
          ),
        );
        const privateEncoderIds = encoders
          .filter((encoder) => encoder.label === privateEncoderLabel)
          .map((encoder) => encoder.id);
        const record = {
          id: nextSubmitId++,
          lane: audit.currentLane,
          commandBufferCount: buffers.length,
          encoderIds: encoders.map((encoder) => encoder.id),
          encoderLabels: encoders.map((encoder) => encoder.label),
          dynamicPassCount: dynamicPasses.length,
          dynamicPasses: dynamicPasses.map((pass) => ({ ...pass })),
          privateEncoderIds,
          managersBeforeNativeSubmit:
            dynamicPasses.length > 0 ? snapshotManagers() : [],
          managersAfterNativeSubmit: [],
          submitThrew: null,
        };
        laneRecord().submits.push(record);
        if (privateEncoderIds.length > 0) {
          audit.privateEncoderSubmits.push({
            lane: record.lane,
            submitId: record.id,
            encoderIds: privateEncoderIds,
          });
        }
        try {
          const result = original.call(this, commandBuffers);
          if (dynamicPasses.length > 0) {
            record.managersAfterNativeSubmit = snapshotManagers();
          }
          return result;
        } catch (error) {
          record.submitThrew = String(error);
          if (dynamicPasses.length > 0) {
            record.managersAfterNativeSubmit = snapshotManagers();
          }
          throw error;
        }
      },
  );
}

function countBy(values, key) {
  const counts = {};
  for (const value of values) {
    const name = value[key] || "(unlabeled)";
    counts[name] = (counts[name] || 0) + 1;
  }
  return counts;
}

const expectedManagerPassSequence = [
  "DynEnvMap Sky Pipeline",
  ...Array(6).fill("IBL-Irradiance"),
  ...Array(36).fill("IBL-Radiance"),
  "DynEnvMap SH Pipeline",
];

function dynamicPasses(lane) {
  return lane.passes.filter((pass) =>
    expectedManagerPassSequence.includes(pass.pipelineLabel),
  );
}

function splitManagerSequences(lane) {
  const passes = dynamicPasses(lane);
  const sequences = [];
  let current = [];
  for (const pass of passes) {
    if (pass.pipelineLabel === "DynEnvMap Sky Pipeline" && current.length > 0) {
      sequences.push(current);
      current = [];
    }
    current.push(pass.pipelineLabel);
    if (pass.pipelineLabel === "DynEnvMap SH Pipeline") {
      sequences.push(current);
      current = [];
    }
  }
  if (current.length > 0) {
    sequences.push(current);
  }
  return sequences;
}

function sameArray(left, right) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function managerByName(states, name) {
  return states.find((state) => state.name === name);
}

const stableIdentityFields = [
  "cacheId",
  "cacheCubemapTextureId",
  "cacheCubemapViewId",
  "rawMapId",
  "publicRawTextureId",
  "publicRawViewId",
  "iblCacheId",
  "irradianceTextureId",
  "irradianceViewId",
  "radianceTextureId",
  "radianceViewId",
  "publicDiffuseViewId",
  "publicSpecularViewId",
  "shBufferId",
  "publicSHBufferId",
  "parameterArenaId",
  "parameterBufferId",
];

function identitiesStable(before, after, fields = stableIdentityFields) {
  return fields.every(
    (field) => before?.[field] !== null && before?.[field] === after?.[field],
  );
}

function outputsPublished(state) {
  return Boolean(
    state &&
    state.pendingId === null &&
    state.needsUpdate === false &&
    state.parameterArenaInUse === false &&
    state.pendingOutputTransactionId === null &&
    state.cacheCubemapTextureId !== null &&
    state.cacheCubemapTextureId === state.publicRawTextureId &&
    state.cacheCubemapViewId === state.publicRawViewId &&
    state.irradianceViewId !== null &&
    state.irradianceViewId === state.publicDiffuseViewId &&
    state.radianceViewId !== null &&
    state.radianceViewId === state.publicSpecularViewId &&
    state.shBufferId !== null &&
    state.shBufferId === state.publicSHBufferId &&
    state.parameterArenaId !== null &&
    state.parameterBufferId !== null,
  );
}

function oneSceneSubmit(lane) {
  return (
    lane.submits.length === 1 &&
    lane.submits[0].commandBufferCount === 1 &&
    lane.submits[0].encoderLabels.length === 1 &&
    lane.submits[0].encoderLabels[0] === "Scene Frame Command Encoder"
  );
}

function sameSubmitShape(left, right) {
  return (
    left.submits.length === right.submits.length &&
    left.submits.every((submit, index) => {
      const other = right.submits[index];
      return (
        submit.commandBufferCount === other.commandBufferCount &&
        sameArray(submit.encoderLabels, other.encoderLabels)
      );
    })
  );
}

function evaluateChecks(run, gate, browserErrors, localRequestFailures) {
  const checks = [];
  const add = (name, pass, detail, structural = false) => {
    checks.push({ name, pass: Boolean(pass), detail, structural });
  };

  const instrumentation = run.instrumentation;
  const missingInstrumentation = instrumentation.required.filter(
    (name) => !instrumentation.installed.includes(name),
  );
  add(
    "native instrumentation installed",
    instrumentation.failures.length === 0 &&
      missingInstrumentation.length === 0,
    { failures: instrumentation.failures, missingInstrumentation },
    true,
  );
  add(
    "resolved backend is WebGPU",
    run.rendererType === "webgpu" && run.isWebGPU === true,
    { rendererType: run.rendererType, isWebGPU: run.isWebGPU },
    true,
  );
  add(
    "two independent local-model managers warmed",
    run.warm.complete === true && run.managerIdentityDistinct === true,
    run.warm,
    true,
  );

  const control = run.lanes.control;
  const sameTopology = run.lanes.sameTopology;
  const topology = run.lanes.topology;
  const followUp = run.lanes.followUp;
  const sameSequences = splitManagerSequences(sameTopology.audit);
  const topologySequences = splitManagerSequences(topology.audit);
  const samePasses = dynamicPasses(sameTopology.audit);
  const topologyPasses = dynamicPasses(topology.audit);

  add(
    "control frame has no dynamic-IBL work",
    dynamicPasses(control.audit).length === 0,
    countBy(control.audit.passes, "pipelineLabel"),
  );
  add(
    "same-topology lane has two exact 44-pass manager sequences",
    sameSequences.length === 2 &&
      sameSequences.every((sequence) =>
        sameArray(sequence, expectedManagerPassSequence),
      ),
    {
      total: samePasses.length,
      sequences: sameSequences.map((sequence) => sequence.length),
      labels: countBy(samePasses, "pipelineLabel"),
    },
  );
  const sameEncoderIds = [...new Set(samePasses.map((pass) => pass.encoderId))];
  const sameDynamicSubmit = sameTopology.audit.submits.filter(
    (submit) => submit.dynamicPassCount > 0,
  );
  add(
    "both managers share the one scene frame encoder",
    sameEncoderIds.length === 1 &&
      sameDynamicSubmit.length === 1 &&
      sameDynamicSubmit[0].encoderIds.includes(sameEncoderIds[0]) &&
      sameDynamicSubmit[0].encoderLabels.includes(
        "Scene Frame Command Encoder",
      ),
    { sameEncoderIds, submits: sameDynamicSubmit },
  );
  add(
    "refresh keeps the control frame's one-submit shape",
    oneSceneSubmit(control.audit) &&
      oneSceneSubmit(sameTopology.audit) &&
      sameSubmitShape(control.audit, sameTopology.audit),
    {
      control: control.audit.submits,
      refresh: sameTopology.audit.submits,
    },
  );

  const sameA0 = managerByName(sameTopology.before, "model-a");
  const sameB0 = managerByName(sameTopology.before, "model-b");
  const sameA1 = managerByName(sameTopology.after, "model-a");
  const sameB1 = managerByName(sameTopology.after, "model-b");
  add(
    "same-topology identities remain stable per manager",
    identitiesStable(sameA0, sameA1) && identitiesStable(sameB0, sameB1),
    { before: sameTopology.before, after: sameTopology.after },
  );
  const distinctFields = [
    "cacheCubemapTextureId",
    "cacheCubemapViewId",
    "irradianceTextureId",
    "irradianceViewId",
    "radianceTextureId",
    "radianceViewId",
    "shBufferId",
    "parameterArenaId",
    "parameterBufferId",
  ];
  add(
    "manager arenas and writable outputs are distinct",
    distinctFields.every(
      (field) =>
        sameA1?.[field] !== null && sameA1?.[field] !== sameB1?.[field],
    ),
    Object.fromEntries(
      distinctFields.map((field) => [
        field,
        [sameA1?.[field] ?? null, sameB1?.[field] ?? null],
      ]),
    ),
  );

  const sameSubmit = sameDynamicSubmit[0];
  const submitA0 = managerByName(
    sameSubmit?.managersBeforeNativeSubmit ?? [],
    "model-a",
  );
  const submitB0 = managerByName(
    sameSubmit?.managersBeforeNativeSubmit ?? [],
    "model-b",
  );
  const submitA1 = managerByName(
    sameSubmit?.managersAfterNativeSubmit ?? [],
    "model-a",
  );
  const submitB1 = managerByName(
    sameSubmit?.managersAfterNativeSubmit ?? [],
    "model-b",
  );
  const pendingThroughNative = (state, encoderId) =>
    state?.pendingId !== null &&
    state?.pendingEncoderId === encoderId &&
    state?.pendingScopeOwnsEncoder === false &&
    state?.pendingCommitReady === true &&
    state?.pendingEncodingFailed === false &&
    state?.needsUpdate === true &&
    state?.parameterArenaInUse === true;
  add(
    "both refreshes remain pending through native submit",
    pendingThroughNative(submitA0, sameEncoderIds[0]) &&
      pendingThroughNative(submitB0, sameEncoderIds[0]) &&
      pendingThroughNative(submitA1, sameEncoderIds[0]) &&
      pendingThroughNative(submitB1, sameEncoderIds[0]) &&
      submitA0.pendingId === submitA1.pendingId &&
      submitB0.pendingId === submitB1.pendingId,
    {
      beforeNative: sameSubmit?.managersBeforeNativeSubmit,
      afterNative: sameSubmit?.managersAfterNativeSubmit,
    },
  );
  add(
    "exact submit clears pending and commits needsUpdate",
    outputsPublished(sameA1) && outputsPublished(sameB1),
    sameTopology.after,
  );

  const topologySequencePass =
    topologySequences.length === 1 &&
    sameArray(topologySequences[0], expectedManagerPassSequence);
  add(
    "topology lane has one exact 44-pass sequence on one scene submit",
    topologySequencePass &&
      topologyPasses.length === 44 &&
      oneSceneSubmit(topology.audit) &&
      sameSubmitShape(control.audit, topology.audit),
    {
      sequences: topologySequences.map((sequence) => sequence.length),
      labels: countBy(topologyPasses, "pipelineLabel"),
      submits: topology.audit.submits,
    },
  );

  const topologySubmit = topology.audit.submits.find(
    (submit) => submit.dynamicPassCount > 0,
  );
  const topologySubmitA0 = managerByName(
    topologySubmit?.managersBeforeNativeSubmit ?? [],
    "model-a",
  );
  const topologySubmitA1 = managerByName(
    topologySubmit?.managersAfterNativeSubmit ?? [],
    "model-a",
  );
  const topologyBeforeA = managerByName(topology.before, "model-a");
  const topologyAfterA = managerByName(topology.after, "model-a");
  const topologyBeforeB = managerByName(topology.before, "model-b");
  const topologyAfterB = managerByName(topology.after, "model-b");
  const failClosedAtSubmit = (state) =>
    state?.rawMapId === null &&
    state?.publicRawTextureId === null &&
    state?.publicRawViewId === null &&
    state?.pendingId !== null &&
    state?.needsUpdate === true &&
    state?.pendingScopeOwnsEncoder === false &&
    state?.pendingCommitReady === true &&
    state?.parameterArenaInUse === true &&
    state?.pendingOutputTransactionId !== null &&
    state?.cacheCubemapTextureId !== topologyBeforeA?.cacheCubemapTextureId &&
    state?.publicDiffuseViewId === topologyBeforeA?.publicDiffuseViewId &&
    state?.publicSpecularViewId === topologyBeforeA?.publicSpecularViewId;
  add(
    "topology raw alias stays fail-closed through native submit",
    failClosedAtSubmit(topologySubmitA0) &&
      failClosedAtSubmit(topologySubmitA1) &&
      topologySubmitA0.pendingId === topologySubmitA1.pendingId,
    {
      beforeNative: topologySubmitA0,
      afterNative: topologySubmitA1,
    },
  );
  const topologyReplacementPublished =
    outputsPublished(topologyAfterA) &&
    topologyAfterA.cacheSize === run.topologyReplacementSize &&
    topologyAfterA.cacheCubemapTextureId !==
      topologyBeforeA.cacheCubemapTextureId &&
    topologyAfterA.rawMapId !== topologyBeforeA.rawMapId &&
    topologyAfterA.irradianceTextureId !==
      topologyBeforeA.irradianceTextureId &&
    topologyAfterA.irradianceViewId !== topologyBeforeA.irradianceViewId &&
    topologyAfterA.radianceTextureId !== topologyBeforeA.radianceTextureId &&
    topologyAfterA.radianceViewId !== topologyBeforeA.radianceViewId &&
    topologyAfterA.parameterArenaId === topologyBeforeA.parameterArenaId &&
    topologyAfterA.parameterBufferId === topologyBeforeA.parameterBufferId;
  add(
    "accepted topology publishes complete replacement after submit",
    topologyReplacementPublished,
    { before: topologyBeforeA, after: topologyAfterA },
  );
  add(
    "unmodified manager remains isolated during topology replacement",
    identitiesStable(topologyBeforeB, topologyAfterB),
    { before: topologyBeforeB, after: topologyAfterB },
  );
  const followUpA = managerByName(followUp.after, "model-a");
  add(
    "topology publication requests and consumes one clean follow-up",
    topology.renderRequestedAfter === true &&
      followUp.didRender === true &&
      followUp.renderRequestedAfter === false &&
      dynamicPasses(followUp.audit).length === 0 &&
      identitiesStable(topologyAfterA, followUpA),
    {
      topologyRenderRequested: topology.renderRequestedAfter,
      followUpRendered: followUp.didRender,
      followUpRenderRequested: followUp.renderRequestedAfter,
      followUpPasses: countBy(followUp.audit.passes, "pipelineLabel"),
    },
  );

  add(
    "no private dynamic-environment encoders or submits",
    run.privateEncodersCreated.length === 0 &&
      run.privateEncoderSubmits.length === 0,
    {
      encoders: run.privateEncodersCreated,
      submits: run.privateEncoderSubmits,
    },
  );
  add(
    "WebGPU error gate armed and clean",
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
    async ({ modelUrl, maximumWarmFrames, idleWarmFramesRequired }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const viewer = globalThis.viewer;
      const scene = viewer.scene;
      const context = scene.context;
      const audit = globalThis.__c11193bNativeAudit;
      const fixedTime = C.JulianDate.fromIso8601("2026-06-21T19:00:00Z");
      const initialCubemapSize = 64;
      const topologyReplacementSize = 128;

      viewer.useDefaultRenderLoop = false;
      viewer.clock.shouldAnimate = false;
      viewer.clock.currentTime = C.JulianDate.clone(fixedTime);
      scene.requestRenderMode = true;
      scene.maximumRenderTimeChange = Infinity;
      scene.globe.show = false;
      scene.skyBox.show = false;
      if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
      if (scene.sun) scene.sun.show = false;
      if (scene.moon) scene.moon.show = false;
      scene.fog.enabled = false;
      scene.backgroundColor = C.Color.BLACK;

      context._options ??= {};
      context._options.webgpu = {
        ...(context._options.webgpu ?? {}),
        iblPrefilterQuality: "parity",
        envMapMultiScatter: false,
        sceneCaptureReflections: false,
        envMapTemporalAccumulation: false,
        cloudsInReflections: false,
      };

      const positions = [
        C.Cartesian3.fromDegrees(-75.0, 40.0, 0.0),
        C.Cartesian3.fromDegrees(-74.9995, 40.0, 0.0),
      ];
      scene.camera.setView({
        destination: C.Cartesian3.fromDegrees(-75.0, 40.0, 500.0),
        orientation: {
          heading: 0.0,
          pitch: C.Math.toRadians(-45.0),
          roll: 0.0,
        },
      });

      const models = [];
      for (let i = 0; i < positions.length; i++) {
        const model = await C.Model.fromGltfAsync({
          url: modelUrl,
          modelMatrix: C.Transforms.eastNorthUpToFixedFrame(positions[i]),
          scale: 12.0,
        });
        scene.primitives.add(model);
        models.push(model);
      }
      const managers = models.map((model, index) => {
        const manager = model.environmentMapManager;
        if (manager) {
          manager.enabled = true;
          manager.shouldUpdate = true;
          manager.position = positions[index];
          manager._cubemapSize = initialCubemapSize;
        }
        return manager;
      });
      globalThis.__c11193bManagers = managers.map((manager, index) => ({
        name: index === 0 ? "model-a" : "model-b",
        manager,
      }));

      function snapshotManagers() {
        return audit.snapshotManagers();
      }

      function exportLane(name) {
        return JSON.parse(JSON.stringify(audit.lanes[name]));
      }

      function dynamicPassCount(name) {
        const labels = new Set([
          "DynEnvMap Sky Pipeline",
          "IBL-Irradiance",
          "IBL-Radiance",
          "DynEnvMap SH Pipeline",
        ]);
        return (audit.lanes[name]?.passes ?? []).filter((pass) =>
          labels.has(pass.pipelineLabel),
        ).length;
      }

      async function yieldBrowser() {
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }

      function forceFrame(laneName) {
        audit.beginLane(laneName);
        scene._renderRequested = false;
        scene.forceRender(fixedTime);
        const result = {
          audit: exportLane(laneName),
          after: snapshotManagers(),
          renderRequestedAfter: scene._renderRequested === true,
          didRender: scene._frameState?.newFrame === true,
        };
        audit.endLane();
        return result;
      }

      function requestedFrame(laneName) {
        audit.beginLane(laneName);
        const requestedBefore = scene._renderRequested === true;
        const frameNumberBefore = scene._frameState?.frameNumber;
        scene.render(fixedTime);
        const frameNumberAfter = scene._frameState?.frameNumber;
        const result = {
          audit: exportLane(laneName),
          after: snapshotManagers(),
          requestedBefore,
          renderRequestedAfter: scene._renderRequested === true,
          didRender: frameNumberAfter !== frameNumberBefore,
        };
        audit.endLane();
        return result;
      }

      let idleFrames = 0;
      let warmFrames = 0;
      for (; warmFrames < maximumWarmFrames; warmFrames++) {
        const frame = forceFrame("warm-frame");
        const states = frame.after;
        const ready =
          models.every((model) => model.ready === true) &&
          managers.every(Boolean) &&
          states.length === 2 &&
          states.every(
            (state) =>
              state.pendingId === null &&
              state.needsUpdate === false &&
              state.parameterArenaInUse === false &&
              state.pendingOutputTransactionId === null &&
              state.cacheCubemapTextureId !== null &&
              state.cacheCubemapTextureId === state.publicRawTextureId &&
              state.irradianceViewId !== null &&
              state.irradianceViewId === state.publicDiffuseViewId &&
              state.radianceViewId !== null &&
              state.radianceViewId === state.publicSpecularViewId &&
              state.shBufferId !== null &&
              state.shBufferId === state.publicSHBufferId &&
              state.parameterArenaId !== null &&
              state.parameterBufferId !== null,
          );
        if (ready && dynamicPassCount("warm-frame") === 0) {
          idleFrames++;
        } else {
          idleFrames = 0;
        }
        if (idleFrames >= idleWarmFramesRequired) {
          break;
        }
        await yieldBrowser();
      }

      const warmStates = snapshotManagers();
      const warmComplete =
        warmFrames < maximumWarmFrames &&
        idleFrames >= idleWarmFramesRequired &&
        models.every((model) => model.ready === true) &&
        managers.every(Boolean);

      const controlBefore = snapshotManagers();
      const control = forceFrame("control");
      control.before = controlBefore;

      for (const manager of managers) {
        if (manager?._webgpuCache) {
          // Preserve topology and every published identity, but force the
          // complete level-triggered refresh. `needsUpdate` also makes both
          // requests mandatory, so the bounded drain cannot split this
          // two-manager acceptance case across frames.
          manager._webgpuCache.needsUpdate = true;
        }
      }
      const sameTopologyBefore = snapshotManagers();
      const sameTopology = forceFrame("same-topology");
      sameTopology.before = sameTopologyBefore;

      const topologyBefore = snapshotManagers();
      if (managers[0]) {
        managers[0]._cubemapSize = topologyReplacementSize;
      }
      const topology = forceFrame("topology");
      topology.before = topologyBefore;
      const followUp = requestedFrame("topology-follow-up");

      await context.device.queue.onSubmittedWorkDone();
      await new Promise((resolve) => setTimeout(resolve, 50));

      const managerIds = managers.map((manager) => audit.objectId(manager));
      return {
        rendererType: context.rendererType,
        isWebGPU: context.isWebGPU === true,
        fixedTime: "2026-06-21T19:00:00Z",
        localModelUrl: modelUrl,
        initialCubemapSize,
        topologyReplacementSize,
        iblPrefilterQuality: context.iblPrefilterQuality,
        optionalFeatures: {
          envMapMultiScatter: context.envMapMultiScatter,
          sceneCaptureReflections: context.sceneCaptureReflections,
          envMapTemporalAccumulation: context.envMapTemporalAccumulation,
          cloudsInReflections: context.cloudsInReflections,
        },
        managerIdentityDistinct:
          managerIds.length === 2 &&
          managerIds[0] !== null &&
          managerIds[0] !== managerIds[1],
        warm: {
          complete: warmComplete,
          frames: warmFrames + 1,
          idleFrames,
          modelReady: models.map((model) => model.ready === true),
          states: warmStates,
          lastFrameDynamicPasses: dynamicPassCount("warm-frame"),
        },
        instrumentation: JSON.parse(JSON.stringify(audit.instrumentation)),
        privateEncodersCreated: JSON.parse(
          JSON.stringify(audit.privateEncodersCreated),
        ),
        privateEncoderSubmits: JSON.parse(
          JSON.stringify(audit.privateEncoderSubmits),
        ),
        lanes: {
          control,
          sameTopology,
          topology,
          followUp: {
            ...followUp,
            audit: exportLane("topology-follow-up"),
          },
        },
      };
    },
    { modelUrl, maximumWarmFrames, idleWarmFramesRequired },
  );

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
  report = {
    probe: "C11-193B dynamic IBL shared submit",
    status: exitCode === 0 ? "PASS" : exitCode === 3 ? "STRUCTURAL" : "FAIL",
    exitCode,
    baseUrl,
    viewer: {
      renderer: "webgpu",
      offline: true,
      manualRenderLoop: true,
      localModelUrl: modelUrl,
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
  report = {
    probe: "C11-193B dynamic IBL shared submit",
    status: "ERROR",
    exitCode,
    baseUrl,
    error: String(error?.stack ?? error),
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
