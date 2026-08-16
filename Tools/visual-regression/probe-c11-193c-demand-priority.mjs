#!/usr/bin/env node
/**
 * C11-193C real Edge/WebGPU demand-priority and bounded-drain acceptance.
 * @purpose Acceptance for dynamic-IBL demand priority: HIGH-before-NORMAL admission, bounded lossless deferral, budget semantics, late 2D promotion.
 * @status ACTIVE
 *
 * Two independent real DynamicEnvironmentMapManagers are driven by ordered
 * Scene primitives. The probe proves same-frame HIGH-before-NORMAL admission,
 * bounded lossless deferral, MANDATORY-plus-one-deferrable budget semantics,
 * and late split-2D demand promotion on the active continuation encoder.
 *
 * Do not treat this as a timing or FPS probe. It observes exact native pass,
 * encoder, command-buffer, submit, demand, and scheduler shapes.
 *
 * Run only after the matching source/build is frozen and reviewed:
 *   node Tools/visual-regression/probe-c11-193c-demand-priority.mjs
 */

import fs from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { chromium } from "playwright";
import {
  armWebGPUDevices,
  attachConsoleErrorGate,
  collectGateErrors,
  errorGateInit,
} from "../lib/webgpu-error-gate.mjs";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const HEADED = process.env.PROBE_HEADED === "1";
const OUTPUT = path.resolve(
  "Tools/visual-regression/output/performance/c11-193c-dynamic-ibl-demand-priority.json",
);
const FIRST_RED = path.resolve(
  "Tools/visual-regression/output/performance/c11-193c-dynamic-ibl-demand-priority.first-red.json",
);
const MAXIMUM_WARM_FRAMES = 360;
const IDLE_WARM_FRAMES_REQUIRED = 4;
const MAX_DEFERRAL_FRAMES = 3;
const WATCHDOG_MS = 300_000;
const EXPECTED_PASS_SEQUENCE = Object.freeze([
  "DynEnvMap Sky Pipeline",
  ...Array(6).fill("IBL-Irradiance"),
  ...Array(36).fill("IBL-Radiance"),
  "DynEnvMap SH Pipeline",
]);
const DYNAMIC_PIPELINE_LABELS = new Set(EXPECTED_PASS_SEQUENCE);

/** Runs before Cesium/device startup and wraps observation-only native seams. */
function installNativeAudit() {
  if (globalThis.__c11193cNativeAudit) {
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
    activeManagerName: null,
    lanes: Object.create(null),
    requestDeviceCalls: 0,
    requestDeviceHooksReady: [],
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
        "GPUAdapter.requestDevice",
      ],
    },
    privateEncodersCreated: [],
    privateEncoderSubmits: [],
    beginLane(name) {
      this.currentLane = name;
      this.activeManagerName = null;
      this.lanes[name] = {
        name,
        encoders: [],
        passes: [],
        submits: [],
        producerEvents: [],
        admissions: [],
      };
    },
    endLane() {
      this.activeManagerName = null;
      this.currentLane = "idle";
    },
    setActiveManager(name) {
      this.activeManagerName = name ?? null;
    },
    recordProducerEvent(event) {
      laneRecord().producerEvents.push({ ...event });
    },
    recordAdmission(event) {
      laneRecord().admissions.push({ ...event });
    },
  };
  audit.beginLane("boot");
  globalThis.__c11193cNativeAudit = audit;

  function laneRecord(name = audit.currentLane) {
    if (!audit.lanes[name]) {
      audit.lanes[name] = {
        name,
        encoders: [],
        passes: [],
        submits: [],
        producerEvents: [],
        admissions: [],
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

  function nameForManager(manager) {
    const entries = globalThis.__c11193cManagers;
    return (
      entries?.find((entry) => entry.manager === manager)?.name ??
      "unregistered"
    );
  }

  function managerState(entry) {
    const manager = entry?.manager;
    const cache = manager?._webgpuCache;
    const iblCache = cache?.iblCache;
    const arena = iblCache?.persistentParameterArena;
    const pending = cache?.pendingRefresh;
    const raw = manager?._radianceMap;
    const context = globalThis.viewer?.scene?.context;
    return {
      name: entry?.name ?? "unknown",
      managerId: objectId(manager),
      cacheId: objectId(cache),
      pendingId: objectId(pending),
      pendingEncoderId: encoderId(pending?.encoder),
      pendingScopeId: objectId(pending?.scope),
      pendingScopeOwnsEncoder: pending?.scope?.ownsEncoder ?? null,
      pendingCommitId: objectId(pending?.commitState),
      pendingCommitReady: pending != null && pending.commitState !== null,
      pendingEncodingFailed: pending?.encodingFailed ?? null,
      needsUpdate: cache?.needsUpdate ?? null,
      cacheCubemapTextureId: objectId(cache?.cubemapTexture),
      cacheCubemapViewId: objectId(cache?.cubemapTextureView),
      rawMapId: objectId(raw),
      publicRawTextureId: objectId(raw?._webgpuTexture),
      publicRawViewId: objectId(raw?._webgpuTextureView),
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
      demandRecord:
        context?._environmentDemandRegistry?.getRecord?.(manager) ?? null,
      schedulerRecord:
        context?._environmentRefreshScheduler?.getRecord?.(manager) ?? null,
    };
  }

  function snapshotManagers() {
    const entries = globalThis.__c11193cManagers;
    return Array.isArray(entries) ? entries.map(managerState) : [];
  }

  audit.objectId = objectId;
  audit.encoderId = encoderId;
  audit.nameForManager = nameForManager;
  audit.snapshotManagers = snapshotManagers;

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

  patch(
    globalThis.GPUDevice?.prototype,
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
          commandBufferIds: [],
          submitCount: 0,
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
    globalThis.GPUDevice?.prototype,
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
    globalThis.GPUCommandEncoder?.prototype,
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
          managerName: audit.activeManagerName,
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
    globalThis.GPUComputePassEncoder?.prototype,
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
        const submitted = buffers
          .map((buffer) => commandBufferRecords.get(buffer))
          .filter(Boolean);
        const encoders = submitted.map((item) => item.encoder);
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
          commandBufferIds: submitted.map((item) => item.id),
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
          for (const item of submitted) {
            item.encoder.submitCount++;
          }
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

  patch(
    globalThis.GPUAdapter?.prototype,
    "requestDevice",
    "GPUAdapter.requestDevice",
    (original) =>
      async function (...args) {
        audit.requestDeviceCalls++;
        const installed = new Set(audit.instrumentation.installed);
        const beforeDevice = audit.instrumentation.required.filter(
          (name) => name !== "GPUAdapter.requestDevice",
        );
        audit.requestDeviceHooksReady.push(
          beforeDevice.every((name) => installed.has(name)) &&
            audit.instrumentation.failures.length === 0,
        );
        const device = await original.apply(this, args);
        globalThis.__armWebGPUDevice?.(device, "c11-193c-startup");
        return device;
      },
  );
}

function dynamicPasses(lane) {
  return (lane?.passes ?? []).filter((pass) =>
    DYNAMIC_PIPELINE_LABELS.has(pass.pipelineLabel),
  );
}

function managerPasses(lane, managerName) {
  return dynamicPasses(lane).filter((pass) => pass.managerName === managerName);
}

function exactManagerSequence(lane, managerName) {
  return (
    JSON.stringify(
      managerPasses(lane, managerName).map((pass) => pass.pipelineLabel),
    ) === JSON.stringify(EXPECTED_PASS_SEQUENCE)
  );
}

function managerByName(states, name) {
  return states?.find((state) => state.name === name);
}

const stableIdentityFields = [
  "cacheCubemapTextureId",
  "cacheCubemapViewId",
  "publicRawTextureId",
  "publicRawViewId",
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

function identitiesStable(before, after) {
  return stableIdentityFields.every(
    (field) => before?.[field] != null && before[field] === after?.[field],
  );
}

function outputsPublished(state) {
  return (
    state?.pendingId === null &&
    state?.needsUpdate === false &&
    state?.parameterArenaInUse === false &&
    state?.pendingOutputTransactionId === null &&
    state?.cacheCubemapTextureId != null &&
    state.cacheCubemapTextureId === state.publicRawTextureId &&
    state?.irradianceViewId != null &&
    state.irradianceViewId === state.publicDiffuseViewId &&
    state?.radianceViewId != null &&
    state.radianceViewId === state.publicSpecularViewId &&
    state?.shBufferId != null &&
    state.shBufferId === state.publicSHBufferId
  );
}

function pendingThroughNativeSubmit(state, encoderId) {
  return (
    state?.pendingId !== null &&
    state?.pendingEncoderId === encoderId &&
    state?.pendingScopeId !== null &&
    state?.pendingScopeOwnsEncoder === false &&
    state?.pendingCommitId !== null &&
    state?.pendingCommitReady === true &&
    state?.pendingEncodingFailed === false &&
    state?.parameterArenaId !== null &&
    state?.parameterBufferId !== null &&
    state?.parameterArenaInUse === true
  );
}

function samePendingTransaction(beforeNative, afterNative, encoderId) {
  return (
    pendingThroughNativeSubmit(beforeNative, encoderId) &&
    pendingThroughNativeSubmit(afterNative, encoderId) &&
    beforeNative.pendingId === afterNative.pendingId &&
    beforeNative.pendingScopeId === afterNative.pendingScopeId &&
    beforeNative.pendingCommitId === afterNative.pendingCommitId &&
    beforeNative.parameterArenaId === afterNative.parameterArenaId &&
    beforeNative.parameterBufferId === afterNative.parameterBufferId
  );
}

function pendingTransactionSettled(state) {
  return (
    state?.pendingId === null &&
    state?.pendingEncoderId === null &&
    state?.pendingScopeId === null &&
    state?.pendingCommitId === null &&
    state?.pendingCommitReady === false &&
    state?.pendingEncodingFailed === null &&
    state?.parameterArenaInUse === false
  );
}

function oneSceneSubmit(lane, dynamicPassCount) {
  return (
    lane?.submits?.length === 1 &&
    lane.submits[0].commandBufferCount === 1 &&
    lane.submits[0].encoderLabels?.length === 1 &&
    lane.submits[0].encoderLabels[0] === "Scene Frame Command Encoder" &&
    lane.submits[0].dynamicPassCount === dynamicPassCount &&
    lane.submits[0].submitThrew === null
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
    "all native hooks were installed before the first device request",
    required.length === 7 &&
      required.every((name) => installed.has(name)) &&
      (instrumentation.failures?.length ?? 0) === 0 &&
      run?.requestDeviceCalls >= 1 &&
      run?.requestDeviceHooksReady?.every(Boolean),
    {
      instrumentation,
      requestDeviceCalls: run?.requestDeviceCalls,
      requestDeviceHooksReady: run?.requestDeviceHooksReady,
    },
    true,
  );
  add(
    "real WebGPU coordinator/demand/scheduler seams are live",
    run?.isWebGPU === true &&
      run?.deviceAvailable === true &&
      run?.structural?.coordinator === true &&
      run?.structural?.demandRegistry === true &&
      run?.structural?.scheduler === true &&
      run?.structural?.contextMethods === true &&
      run?.schedulerBudget === 1,
    {
      isWebGPU: run?.isWebGPU,
      deviceAvailable: run?.deviceAvailable,
      structural: run?.structural,
      schedulerBudget: run?.schedulerBudget,
    },
    true,
  );
  add(
    "two independent managers warmed to complete isolated published graphs",
    run?.warm?.complete === true &&
      run?.warm?.states?.length === 2 &&
      run.warm.states.every(outputsPublished) &&
      run?.managerIdentityDistinct === true,
    run?.warm,
    true,
  );

  const priority = run?.lanes?.priority;
  const priorityAudit = priority?.audit;
  const priorityEvents = priorityAudit?.producerEvents ?? [];
  const priorityAdmissions = priorityAudit?.admissions ?? [];
  add(
    "priority lane enqueues NORMAL first and DEMANDED HIGH second in one frame",
    priorityEvents.length === 2 &&
      priorityEvents[0].managerName === "normal" &&
      priorityEvents[0].demand === "proven-none" &&
      priorityEvents[1].managerName === "high" &&
      priorityEvents[1].demand === "demanded" &&
      priorityEvents[0].frameNumber === priorityEvents[1].frameNumber &&
      priorityEvents[0].order < priorityEvents[1].order &&
      priorityEvents[0].coordinatorPendingBefore === 0 &&
      priorityEvents[0].coordinatorPendingAfter === 1 &&
      priorityEvents[1].coordinatorPendingBefore === 1 &&
      priorityEvents[1].coordinatorPendingAfter === 2,
    priorityEvents,
  );
  add(
    "same-frame coordinator invokes HIGH before NORMAL admission",
    priorityAdmissions.length === 2 &&
      priorityAdmissions[0].managerName === "high" &&
      priorityAdmissions[0].urgency === 1 &&
      priorityAdmissions[0].decision === "run" &&
      priorityAdmissions[1].managerName === "normal" &&
      priorityAdmissions[1].urgency === 2 &&
      priorityAdmissions[1].decision === "defer",
    priorityAdmissions,
  );
  add(
    "priority demand telemetry is exact and non-vacuous",
    priority?.demand?.registrations === 2 &&
      priority.demand.registeredConsumers === 1 &&
      priority.demand.uniqueManagers === 2 &&
      priority.demand.demanded === 1 &&
      priority.demand.provenNone === 1 &&
      priority.demand.unknown === 0 &&
      priority.demand.updateReads === 2 &&
      priority.demand.updateReadsDemanded === 1 &&
      priority.demand.updateReadsProvenNone === 1 &&
      priority?.coordinator?.pendingCount === 0 &&
      priority.coordinator.frameId === priority.demand.frameId &&
      priority.coordinator.frameId === priority?.scheduler?.frameId,
    { demand: priority?.demand, coordinator: priority?.coordinator },
  );
  add(
    "budget-one priority frame runs only HIGH's exact 44-pass sequence",
    exactManagerSequence(priorityAudit, "high") &&
      managerPasses(priorityAudit, "normal").length === 0 &&
      dynamicPasses(priorityAudit).length === 44 &&
      oneSceneSubmit(priorityAudit, 44),
    priorityAudit,
  );
  add(
    "priority scheduler grants one, defers one, and arms one lossless resume",
    priority?.scheduler?.budget === 1 &&
      priority.scheduler.requests === 2 &&
      priority.scheduler.granted === 1 &&
      priority.scheduler.deferrableGrants === 1 &&
      priority.scheduler.deferred === 1 &&
      priority.scheduler.mandatoryGrants === 0 &&
      priority.scheduler.escalatedGrants === 0 &&
      priority.scheduler.budgetDeferrals === 1 &&
      priority.scheduler.resumeRequests === 1 &&
      priority.scheduler.submissions === 1 &&
      priority.scheduler.pendingAtFrameEnd === 1 &&
      priority.renderRequestedAfter === true,
    {
      scheduler: priority?.scheduler,
      renderRequestedAfter: priority?.renderRequestedAfter,
    },
  );
  const priorityNormalAfter = managerByName(priority?.after, "normal");
  const priorityHighAfter = managerByName(priority?.after, "high");
  const priorityHighBeforeFrame = managerByName(priority?.before, "high");
  add(
    "deferred NORMAL stays pending while HIGH settles coherently",
    priorityNormalAfter?.schedulerRecord?.pending === true &&
      priorityNormalAfter.schedulerRecord.deferredFrames === 1 &&
      priorityHighAfter?.schedulerRecord?.pending === false &&
      outputsPublished(priorityHighAfter),
    { normal: priorityNormalAfter, high: priorityHighAfter },
  );
  const prioritySubmit = priorityAudit?.submits?.[0];
  const priorityEncoderId = prioritySubmit?.encoderIds?.[0];
  const priorityHighBeforeNative = managerByName(
    prioritySubmit?.managersBeforeNativeSubmit,
    "high",
  );
  const priorityHighAfterNative = managerByName(
    prioritySubmit?.managersAfterNativeSubmit,
    "high",
  );
  add(
    "HIGH remains transactionally pending through native submit, then settles",
    samePendingTransaction(
      priorityHighBeforeNative,
      priorityHighAfterNative,
      priorityEncoderId,
    ) &&
      priorityHighBeforeNative?.needsUpdate ===
        priorityHighAfterNative?.needsUpdate &&
      priorityHighBeforeNative?.schedulerRecord?.lastSubmitFrameId ===
        priorityHighAfterNative?.schedulerRecord?.lastSubmitFrameId &&
      priorityHighBeforeNative?.schedulerRecord?.lastSubmitFrameId ===
        priorityHighBeforeFrame?.schedulerRecord?.lastSubmitFrameId &&
      priorityHighBeforeNative?.schedulerRecord?.lastSubmitFrameId !==
        priority?.scheduler?.frameId &&
      priorityHighAfter?.schedulerRecord?.lastSubmitFrameId ===
        priority?.scheduler?.frameId &&
      pendingTransactionSettled(priorityHighAfter) &&
      outputsPublished(priorityHighAfter),
    {
      encoderId: priorityEncoderId,
      beforeNative: priorityHighBeforeNative,
      afterNative: priorityHighAfterNative,
      afterFrame: priorityHighAfter,
    },
  );

  const starvation = run?.lanes?.starvation;
  const starvationFrames = starvation?.frames ?? [];
  const starvationPasses = starvationFrames.reduce(
    (sum, frame) => sum + dynamicPasses(frame.audit).length,
    0,
  );
  const normalStarvationPasses = starvationFrames.reduce(
    (sum, frame) => sum + managerPasses(frame.audit, "normal").length,
    0,
  );
  const highStarvationPasses = starvationFrames.reduce(
    (sum, frame) => sum + managerPasses(frame.audit, "high").length,
    0,
  );
  const serviceFrame = starvationFrames.findIndex(
    (frame) => managerPasses(frame.audit, "normal").length === 44,
  );
  const serviceScheduler = starvationFrames[serviceFrame]?.scheduler;
  add(
    "deferred NORMAL is losslessly resumed for exact 44 passes by the scheduler bound",
    starvation?.served === true &&
      starvationFrames.length >= 1 &&
      starvationFrames.length <= MAX_DEFERRAL_FRAMES + 1 &&
      serviceFrame >= 0 &&
      serviceFrame < MAX_DEFERRAL_FRAMES + 1 &&
      starvationPasses === 44 &&
      normalStarvationPasses === 44 &&
      highStarvationPasses === 0 &&
      exactManagerSequence(starvationFrames[serviceFrame]?.audit, "normal") &&
      oneSceneSubmit(starvationFrames[serviceFrame]?.audit, 44) &&
      serviceScheduler?.budget === 1 &&
      serviceScheduler.requests === 1 &&
      serviceScheduler.granted === 1 &&
      serviceScheduler.deferrableGrants === 1 &&
      serviceScheduler.deferred === 0 &&
      serviceScheduler.submissions === 1 &&
      serviceScheduler.pendingAtFrameEnd === 0 &&
      starvationFrames.every(
        (frame, index) =>
          oneSceneSubmit(frame.audit, index === serviceFrame ? 44 : 0) &&
          frame?.coordinator?.pendingCount === 0 &&
          frame.coordinator.frameId === frame?.demand?.frameId &&
          frame.coordinator.frameId === frame?.scheduler?.frameId,
      ),
    {
      served: starvation?.served,
      frameCount: starvationFrames.length,
      serviceFrame,
      normalStarvationPasses,
      highStarvationPasses,
      serviceScheduler,
      frames: starvationFrames,
    },
  );
  const starvationFinalNormal = managerByName(starvation?.after, "normal");
  add(
    "resumed NORMAL clears pending state only after submission",
    starvationFinalNormal?.schedulerRecord?.pending === false &&
      starvationFinalNormal?.schedulerRecord?.maxDeferredFrames >= 1 &&
      starvationFinalNormal?.schedulerRecord?.maxDeferredFrames <=
        MAX_DEFERRAL_FRAMES &&
      starvationFinalNormal?.schedulerRecord?.lastSubmitFrameId ===
        starvationFinalNormal?.schedulerRecord?.lastGrantFrameId &&
      outputsPublished(starvationFinalNormal),
    starvationFinalNormal,
  );

  const repeat = run?.lanes?.repeat;
  add(
    "stable repeat has no refresh admissions or dynamic passes",
    dynamicPasses(repeat?.audit).length === 0 &&
      (repeat?.audit?.admissions?.length ?? -1) === 0 &&
      repeat?.scheduler?.requests === 0 &&
      repeat?.scheduler?.granted === 0 &&
      oneSceneSubmit(repeat?.audit, 0),
    repeat,
  );

  const mandatory = run?.lanes?.mandatoryHigh;
  const mandatoryAudit = mandatory?.audit;
  const mandatoryAdmissions = mandatoryAudit?.admissions ?? [];
  const mandatoryEvents = mandatoryAudit?.producerEvents ?? [];
  const deferrableGrants =
    (mandatory?.scheduler?.granted ?? 0) -
    (mandatory?.scheduler?.mandatoryGrants ?? 0) -
    (mandatory?.scheduler?.escalatedGrants ?? 0);
  add(
    "MANDATORY-plus-HIGH lane has two ordered UNKNOWN producers",
    mandatoryEvents.length === 2 &&
      mandatoryEvents[0].managerName === "normal" &&
      mandatoryEvents[0].demand === "unknown" &&
      mandatoryEvents[1].managerName === "high" &&
      mandatoryEvents[1].demand === "unknown" &&
      mandatoryEvents[0].frameNumber === mandatoryEvents[1].frameNumber &&
      mandatoryEvents[0].coordinatorPendingBefore === 0 &&
      mandatoryEvents[0].coordinatorPendingAfter === 1 &&
      mandatoryEvents[1].coordinatorPendingBefore === 1 &&
      mandatoryEvents[1].coordinatorPendingAfter === 2 &&
      mandatory?.demand?.registrations === 2 &&
      mandatory.demand.registeredConsumers === 2 &&
      mandatory.demand.uniqueManagers === 2 &&
      mandatory.demand.unknown === 2 &&
      mandatory.demand.updateReads === 2 &&
      mandatory.demand.updateReadsUnknown === 2 &&
      mandatory?.coordinator?.pendingCount === 0 &&
      mandatory.coordinator.frameId === mandatory.demand.frameId &&
      mandatory.coordinator.frameId === mandatory?.scheduler?.frameId,
    {
      producerEvents: mandatoryEvents,
      demand: mandatory?.demand,
      coordinator: mandatory?.coordinator,
    },
  );
  add(
    "MANDATORY then UNKNOWN-HIGH admission preserves one deferrable budget slot",
    mandatoryAdmissions.length === 2 &&
      mandatoryAdmissions[0].managerName === "normal" &&
      mandatoryAdmissions[0].urgency === 0 &&
      mandatoryAdmissions[0].decision === "run" &&
      mandatoryAdmissions[1].managerName === "high" &&
      mandatoryAdmissions[1].urgency === 1 &&
      mandatoryAdmissions[1].decision === "run" &&
      mandatory?.scheduler?.budget === 1 &&
      mandatory.scheduler.requests === 2 &&
      mandatory.scheduler.granted === 2 &&
      mandatory.scheduler.mandatoryGrants === 1 &&
      mandatory.scheduler.escalatedGrants === 0 &&
      mandatory.scheduler.deferrableGrants === 1 &&
      deferrableGrants === 1 &&
      mandatory.scheduler.deferred === 0 &&
      mandatory.scheduler.submissions === 2,
    {
      admissions: mandatoryAdmissions,
      scheduler: mandatory?.scheduler,
      derivedDeferrableGrants: deferrableGrants,
    },
  );
  const mandatoryPasses = dynamicPasses(mandatoryAudit);
  const mandatoryEncoderIds = new Set(
    mandatoryPasses.map((pass) => pass.encoderId),
  );
  add(
    "MANDATORY plus HIGH encode exact 88 passes on one Scene encoder/submit",
    exactManagerSequence(mandatoryAudit, "normal") &&
      exactManagerSequence(mandatoryAudit, "high") &&
      mandatoryPasses.length === 88 &&
      mandatoryEncoderIds.size === 1 &&
      oneSceneSubmit(mandatoryAudit, 88),
    { audit: mandatoryAudit, encoderIds: [...mandatoryEncoderIds] },
  );
  const mandatorySubmit = mandatoryAudit?.submits?.[0];
  const mandatoryEncoderId = mandatorySubmit?.encoderIds?.[0];
  const mandatoryBoundary = ["normal", "high"].map((name) => ({
    name,
    beforeFrame: managerByName(mandatory?.before, name),
    beforeNative: managerByName(
      mandatorySubmit?.managersBeforeNativeSubmit,
      name,
    ),
    afterNative: managerByName(
      mandatorySubmit?.managersAfterNativeSubmit,
      name,
    ),
    afterFrame: managerByName(mandatory?.after, name),
  }));
  add(
    "MANDATORY and HIGH remain pending through their shared native submit",
    mandatoryBoundary.length === 2 &&
      mandatoryBoundary.every(
        ({ beforeFrame, beforeNative, afterNative, afterFrame }) =>
          samePendingTransaction(
            beforeNative,
            afterNative,
            mandatoryEncoderId,
          ) &&
          beforeNative?.needsUpdate === afterNative?.needsUpdate &&
          beforeNative?.schedulerRecord?.lastSubmitFrameId ===
            afterNative?.schedulerRecord?.lastSubmitFrameId &&
          beforeNative?.schedulerRecord?.lastSubmitFrameId ===
            beforeFrame?.schedulerRecord?.lastSubmitFrameId &&
          beforeNative?.schedulerRecord?.lastSubmitFrameId !==
            mandatory?.scheduler?.frameId &&
          afterFrame?.schedulerRecord?.lastSubmitFrameId ===
            mandatory?.scheduler?.frameId &&
          pendingTransactionSettled(afterFrame) &&
          outputsPublished(afterFrame),
      ),
    { encoderId: mandatoryEncoderId, managers: mandatoryBoundary },
  );

  const mandatoryRepeat = run?.lanes?.mandatoryRepeat;
  add(
    "post-MANDATORY stable repeat performs zero refresh work",
    dynamicPasses(mandatoryRepeat?.audit).length === 0 &&
      (mandatoryRepeat?.audit?.admissions?.length ?? -1) === 0 &&
      mandatoryRepeat?.scheduler?.requests === 0 &&
      oneSceneSubmit(mandatoryRepeat?.audit, 0),
    mandatoryRepeat,
  );

  const split = run?.lanes?.split2D;
  const splitAudit = split?.audit;
  const splitEvents = splitAudit?.producerEvents ?? [];
  add(
    "search found and retained a real wrapped 2D two-segment frame",
    run?.splitSearch?.found === true &&
      splitAudit?.encoders?.some(
        (encoder) =>
          encoder.label === "Secondary Viewport Continuation Encoder",
      ),
    run?.splitSearch,
    true,
  );
  add(
    "split first half queues NORMAL and second half promotes it to DEMANDED",
    splitEvents.length === 2 &&
      splitEvents[0].managerName === "normal" &&
      splitEvents[0].demand === "proven-none" &&
      splitEvents[1].managerName === "normal" &&
      splitEvents[1].demand === "demanded" &&
      splitEvents[0].frameNumber === splitEvents[1].frameNumber &&
      splitEvents[0].viewportOrdinal === 1 &&
      splitEvents[1].viewportOrdinal === 2 &&
      splitEvents[0].coordinatorPendingBefore === 0 &&
      splitEvents[0].coordinatorPendingAfter === 1 &&
      splitEvents[1].coordinatorPendingBefore === 1 &&
      splitEvents[1].coordinatorPendingAfter === 1,
    splitEvents,
  );
  add(
    "split demand/scheduler telemetry sees one promoted HIGH update",
    split?.demand?.registrations === 2 &&
      split.demand.uniqueManagers === 1 &&
      split.demand.demanded === 1 &&
      split.demand.provenNone === 0 &&
      split.demand.updateReads === 1 &&
      split.demand.updateReadsDemanded === 1 &&
      split?.scheduler?.requests === 1 &&
      split.scheduler.granted === 1 &&
      split.scheduler.deferrableGrants === 1 &&
      split.scheduler.deferred === 0 &&
      split.scheduler.submissions === 1 &&
      split?.coordinator?.pendingCount === 0 &&
      split.coordinator.frameId === split.demand.frameId &&
      split.coordinator.frameId === split.scheduler.frameId &&
      splitAudit?.admissions?.length === 1 &&
      splitAudit.admissions[0].managerName === "normal" &&
      splitAudit.admissions[0].urgency === 1 &&
      splitAudit.admissions[0].decision === "run",
    {
      demand: split?.demand,
      scheduler: split?.scheduler,
      coordinator: split?.coordinator,
      admissions: splitAudit?.admissions,
    },
  );
  const splitPasses = dynamicPasses(splitAudit);
  const splitSubmits = splitAudit?.submits ?? [];
  add(
    "split promotion encodes exact 44 only on the continuation segment",
    exactManagerSequence(splitAudit, "normal") &&
      splitPasses.length === 44 &&
      splitPasses.every(
        (pass) =>
          pass.encoderLabel === "Secondary Viewport Continuation Encoder",
      ) &&
      splitSubmits.length === 2 &&
      splitSubmits[0].encoderLabels?.[0] === "Scene Frame Command Encoder" &&
      splitSubmits[0].dynamicPassCount === 0 &&
      splitSubmits[1].encoderLabels?.[0] ===
        "Secondary Viewport Continuation Encoder" &&
      splitSubmits[1].dynamicPassCount === 44 &&
      splitSubmits.every(
        (submit) =>
          submit.commandBufferCount === 1 && submit.submitThrew === null,
      ),
    { passes: splitPasses, submits: splitSubmits },
  );
  const splitDynamicSubmit = splitSubmits[1];
  const splitEncoderId = splitDynamicSubmit?.encoderIds?.[0];
  const splitBeforeNative = managerByName(
    splitDynamicSubmit?.managersBeforeNativeSubmit,
    "normal",
  );
  const splitAfterNative = managerByName(
    splitDynamicSubmit?.managersAfterNativeSubmit,
    "normal",
  );
  const splitBeforeFrame = managerByName(split?.before, "normal");
  const splitAfterFrame = managerByName(split?.after, "normal");
  add(
    "split refresh stays pending through the continuation submit, then settles",
    samePendingTransaction(
      splitBeforeNative,
      splitAfterNative,
      splitEncoderId,
    ) &&
      splitBeforeNative?.needsUpdate === splitAfterNative?.needsUpdate &&
      splitBeforeNative?.schedulerRecord?.lastSubmitFrameId ===
        splitAfterNative?.schedulerRecord?.lastSubmitFrameId &&
      splitBeforeNative?.schedulerRecord?.lastSubmitFrameId ===
        splitBeforeFrame?.schedulerRecord?.lastSubmitFrameId &&
      splitBeforeNative?.schedulerRecord?.lastSubmitFrameId !==
        split?.scheduler?.frameId &&
      splitAfterFrame?.schedulerRecord?.lastSubmitFrameId ===
        split?.scheduler?.frameId &&
      pendingTransactionSettled(splitAfterFrame) &&
      outputsPublished(splitAfterFrame),
    {
      encoderId: splitEncoderId,
      beforeNative: splitBeforeNative,
      afterNative: splitAfterNative,
      afterFrame: splitAfterFrame,
    },
  );
  const splitRepeat = run?.lanes?.splitRepeat;
  add(
    "stable split repeat retains two submits and zero dynamic work",
    dynamicPasses(splitRepeat?.audit).length === 0 &&
      (splitRepeat?.audit?.admissions?.length ?? -1) === 0 &&
      splitRepeat?.scheduler?.requests === 0 &&
      splitRepeat?.audit?.submits?.length === 2,
    splitRepeat,
  );

  const finalStates = splitRepeat?.after;
  const initialNormal = managerByName(run?.warm?.states, "normal");
  const initialHigh = managerByName(run?.warm?.states, "high");
  const finalNormal = managerByName(finalStates, "normal");
  const finalHigh = managerByName(finalStates, "high");
  add(
    "manager-local outputs and parameter arenas remain isolated and stable",
    outputsPublished(finalNormal) &&
      outputsPublished(finalHigh) &&
      identitiesStable(initialNormal, finalNormal) &&
      identitiesStable(initialHigh, finalHigh) &&
      stableIdentityFields.every(
        (field) => finalNormal?.[field] !== finalHigh?.[field],
      ),
    { initialNormal, initialHigh, finalNormal, finalHigh },
  );
  add(
    "no private dynamic-environment encoder or submission was created",
    (run?.privateEncodersCreated?.length ?? -1) === 0 &&
      (run?.privateEncoderSubmits?.length ?? -1) === 0,
    {
      privateEncodersCreated: run?.privateEncodersCreated,
      privateEncoderSubmits: run?.privateEncoderSubmits,
    },
  );
  add(
    "scene render-error gate is empty",
    (run?.renderErrors?.length ?? -1) === 0,
    run?.renderErrors,
  );
  add(
    "WebGPU validation/device-loss gate is armed and empty",
    gate.armedDevices > 0 && gate.errors.length === 0 && !gate.deviceLost,
    gate,
  );
  add(
    "browser and local-request error gates are empty",
    browserErrors.length === 0 && localRequestFailures.length === 0,
    { browserErrors, localRequestFailures },
  );
  return checks;
}

const artifact = {
  schemaVersion: 1,
  runId: randomUUID(),
  campaignItem: "C11-193C",
  startedAt: new Date().toISOString(),
  generatedAt: new Date().toISOString(),
  status: "RUNNING",
  pass: false,
  exitCode: 2,
  incomplete: true,
  diagnosticOnly: true,
  base: BASE,
  browser: "msedge",
  firstRed: {
    path: FIRST_RED,
    policy: "write-once",
    existedBefore: fs.existsSync(FIRST_RED),
    written: false,
    preserved: false,
  },
  checks: [],
  failures: [],
  evidence: undefined,
};

let browser;
let exitCode = 2;

fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
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
      detail: `C11-193C probe exceeded ${WATCHDOG_MS} ms`,
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
  console.error(`ERROR: C11-193C probe exceeded ${WATCHDOG_MS} ms`);
  process.exit(exitCode);
}, WATCHDOG_MS);

try {
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
  const browserErrors = [];
  const localRequestFailures = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      browserErrors.push(`console.error: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => {
    browserErrors.push(`pageerror: ${error.message}`);
  });
  page.on("requestfailed", (request) => {
    if (request.url().startsWith(BASE)) {
      localRequestFailures.push(
        `${request.failure()?.errorText ?? "request failed"}: ${request.url()}`,
      );
    }
  });

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

  const run = await page.evaluate(
    async ({
      maximumWarmFrames,
      idleWarmFramesRequired,
      maxDeferralFrames,
    }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const viewer = globalThis.viewer;
      const scene = viewer.scene;
      const context = scene.context;
      const device = context?._device ?? context?.device;
      const audit = globalThis.__c11193cNativeAudit;
      const fixedTime = C.JulianDate.fromIso8601("2026-06-21T19:00:00Z");
      const renderErrors = [];
      scene.renderError.addEventListener((_scene, error) => {
        renderErrors.push(String(error?.stack ?? error?.message ?? error));
      });

      const contextMethods = [
        "beginEnvironmentMapUpdateCollection",
        "endEnvironmentMapUpdateCollection",
        "queueEnvironmentMapUpdate",
        "drainEnvironmentMapUpdates",
        "recordEnvironmentMapDemand",
        "getEnvironmentMapDemandStats",
        "scheduleEnvironmentRefresh",
        "getEnvironmentRefreshStats",
      ];
      const structural = {
        coordinator:
          context?._environmentRefreshCoordinator != null &&
          typeof context._environmentRefreshCoordinator.pendingCount ===
            "number",
        demandRegistry:
          typeof context?._environmentDemandRegistry?.getRecord === "function",
        scheduler:
          typeof context?._environmentRefreshScheduler?.getRecord ===
          "function",
        contextMethods: contextMethods.every(
          (name) => typeof context?.[name] === "function",
        ),
      };
      const baseResult = {
        isWebGPU: context?.isWebGPU === true,
        rendererType: context?.rendererType ?? null,
        deviceAvailable: Boolean(device),
        structural,
        instrumentation: JSON.parse(
          JSON.stringify(audit?.instrumentation ?? {}),
        ),
        requestDeviceCalls: audit?.requestDeviceCalls ?? 0,
        requestDeviceHooksReady: [...(audit?.requestDeviceHooksReady ?? [])],
        renderErrors,
      };
      if (
        !baseResult.isWebGPU ||
        !device ||
        !audit ||
        !Object.values(structural).every(Boolean)
      ) {
        return baseResult;
      }

      viewer.useDefaultRenderLoop = false;
      viewer.clock.shouldAnimate = false;
      viewer.clock.currentTime = C.JulianDate.clone(fixedTime);
      scene.requestRenderMode = true;
      scene.maximumRenderTimeChange = Infinity;
      scene.rethrowRenderErrors = true;
      if (scene.skyBox) scene.skyBox.show = false;
      if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
      if (scene.sun) scene.sun.show = false;
      if (scene.moon) scene.moon.show = false;
      scene.fog.enabled = false;
      scene.backgroundColor = C.Color.BLACK;
      scene.globe.show = true;

      context._options ??= {};
      context._options.webgpu = {
        ...(context._options.webgpu ?? {}),
        iblPrefilterQuality: "parity",
        envMapMultiScatter: false,
        sceneCaptureReflections: false,
        envMapTemporalAccumulation: false,
        cloudsInReflections: false,
      };
      context._environmentRefreshScheduler.budget = 1;

      const positions = [
        C.Cartesian3.fromDegrees(-75.0, 40.0, 0.0),
        C.Cartesian3.fromDegrees(-74.9995, 40.0, 0.0),
      ];
      scene.camera.setView({
        destination: C.Cartesian3.fromDegrees(-75.0, 40.0, 2_000_000),
        orientation: {
          heading: 0,
          pitch: -C.Math.PI_OVER_TWO,
          roll: 0,
        },
      });

      const managers = positions.map((position) => {
        const manager = new C.DynamicEnvironmentMapManager({
          mipmapLevels: 7,
        });
        manager.enabled = true;
        manager.shouldUpdate = true;
        manager.position = position;
        manager._cubemapSize = 64;
        return manager;
      });
      globalThis.__c11193cManagers = [
        { name: "normal", manager: managers[0] },
        { name: "high", manager: managers[1] },
      ];

      const rawSchedule = context.scheduleEnvironmentRefresh;
      context.scheduleEnvironmentRefresh = function (manager, urgency) {
        const managerName = audit.nameForManager(manager);
        audit.setActiveManager(managerName);
        const before = this.getEnvironmentRefreshStats();
        const decision = rawSchedule.call(this, manager, urgency);
        const after = this.getEnvironmentRefreshStats();
        audit.recordAdmission({
          order: audit.lanes[audit.currentLane].admissions.length,
          managerName,
          urgency,
          decision,
          frameNumber: scene._frameState?.frameNumber ?? null,
          encoderId: audit.encoderId(this._currentCommandEncoder),
          demandRecord:
            this._environmentDemandRegistry?.getRecord?.(manager) ?? null,
          schedulerBefore: before,
          schedulerAfter: after,
        });
        return decision;
      };

      const producerState = {
        normal: { active: true, demand: "unknown", mode: "fixed" },
        high: { active: true, demand: "unknown", mode: "fixed" },
      };

      function makeProducer(managerName, manager) {
        let destroyed = false;
        let lastFrameNumber = -1;
        let viewportOrdinal = 0;
        return {
          update(frameState) {
            const state = producerState[managerName];
            if (!state.active) {
              return;
            }
            const frameNumber = frameState.frameNumber;
            if (frameNumber !== lastFrameNumber) {
              lastFrameNumber = frameNumber;
              viewportOrdinal = 0;
            }
            viewportOrdinal++;
            const demand =
              state.mode === "split-promotion"
                ? viewportOrdinal === 1
                  ? "proven-none"
                  : "demanded"
                : state.demand;
            const coordinator = context._environmentRefreshCoordinator;
            const pendingBefore = coordinator.pendingCount;
            context.recordEnvironmentMapDemand(
              manager,
              demand,
              "standalone-owner",
              demand === "proven-none" ? 0 : 1,
            );
            manager.update(frameState);
            audit.recordProducerEvent({
              order: audit.lanes[audit.currentLane].producerEvents.length,
              managerName,
              demand,
              frameNumber,
              viewportOrdinal,
              split: scene._is2DViewportSplit === true,
              encoderId: audit.encoderId(context._currentCommandEncoder),
              coordinatorPendingBefore: pendingBefore,
              coordinatorPendingAfter: coordinator.pendingCount,
              demandRecord:
                context._environmentDemandRegistry.getRecord(manager) ?? null,
            });
          },
          isDestroyed() {
            return destroyed;
          },
          destroy() {
            destroyed = true;
            return undefined;
          },
        };
      }

      const normalProducer = makeProducer("normal", managers[0]);
      const highProducer = makeProducer("high", managers[1]);
      scene.primitives.add(normalProducer);
      scene.primitives.add(highProducer);

      function clone(value) {
        return JSON.parse(JSON.stringify(value));
      }

      function snapshotManagers() {
        return audit.snapshotManagers();
      }

      function exportLane(name) {
        return clone(audit.lanes[name]);
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

      function coordinatorSnapshot() {
        const coordinator = context._environmentRefreshCoordinator;
        return {
          frameId: coordinator.frameId,
          pendingCount: coordinator.pendingCount,
        };
      }

      function laneResult(name, before, requestedBefore, didRender) {
        return {
          audit: exportLane(name),
          before,
          after: snapshotManagers(),
          demand: clone(context.getEnvironmentMapDemandStats()),
          scheduler: clone(context.getEnvironmentRefreshStats()),
          coordinator: coordinatorSnapshot(),
          requestedBefore,
          renderRequestedAfter: scene._renderRequested === true,
          didRender,
        };
      }

      function forceFrame(name) {
        audit.beginLane(name);
        const before = snapshotManagers();
        scene._renderRequested = false;
        const frameNumberBefore = scene._frameState?.frameNumber;
        scene.forceRender(fixedTime);
        const frameNumberAfter = scene._frameState?.frameNumber;
        const result = laneResult(
          name,
          before,
          false,
          frameNumberAfter !== frameNumberBefore,
        );
        audit.endLane();
        return result;
      }

      function requestedFrame(name) {
        audit.beginLane(name);
        const before = snapshotManagers();
        const requestedBefore = scene._renderRequested === true;
        const frameNumberBefore = scene._frameState?.frameNumber;
        scene.render(fixedTime);
        const frameNumberAfter = scene._frameState?.frameNumber;
        const result = laneResult(
          name,
          before,
          requestedBefore,
          frameNumberAfter !== frameNumberBefore,
        );
        audit.endLane();
        return result;
      }

      async function yieldBrowser() {
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }

      function managerReady(state) {
        return (
          state?.pendingId === null &&
          state?.needsUpdate === false &&
          state?.parameterArenaInUse === false &&
          state?.pendingOutputTransactionId === null &&
          state?.cacheCubemapTextureId != null &&
          state.cacheCubemapTextureId === state.publicRawTextureId &&
          state?.irradianceViewId != null &&
          state.irradianceViewId === state.publicDiffuseViewId &&
          state?.radianceViewId != null &&
          state.radianceViewId === state.publicSpecularViewId &&
          state?.shBufferId != null &&
          state.shBufferId === state.publicSHBufferId &&
          state?.parameterArenaId != null &&
          state?.parameterBufferId != null
        );
      }

      let idleFrames = 0;
      let warmFrames = 0;
      for (; warmFrames < maximumWarmFrames; warmFrames++) {
        const frame = forceFrame("warm-frame");
        if (
          frame.after.length === 2 &&
          frame.after.every(managerReady) &&
          dynamicPassCount("warm-frame") === 0
        ) {
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
      const warm = {
        complete:
          warmFrames < maximumWarmFrames &&
          idleFrames >= idleWarmFramesRequired &&
          warmStates.length === 2 &&
          warmStates.every(managerReady),
        frames: warmFrames + 1,
        idleFrames,
        states: warmStates,
        lastFrameDynamicPasses: dynamicPassCount("warm-frame"),
      };

      const control = forceFrame("control");

      function forceDeferrableDirty(manager) {
        if (!manager?._webgpuCache) {
          throw new Error("manager cache absent before dirty trigger");
        }
        manager._webgpuCache.lastSunDirX = Number.NaN;
      }

      producerState.normal = {
        active: true,
        demand: "proven-none",
        mode: "fixed",
      };
      producerState.high = {
        active: true,
        demand: "demanded",
        mode: "fixed",
      };
      forceDeferrableDirty(managers[0]);
      forceDeferrableDirty(managers[1]);
      const priority = forceFrame("priority");

      const starvationFrames = [];
      let starvationServed = false;
      for (let index = 0; index < maxDeferralFrames + 1; index++) {
        const frame = requestedFrame(`starvation-${index}`);
        starvationFrames.push(frame);
        const normalPasses = frame.audit.passes.filter(
          (pass) =>
            pass.managerName === "normal" &&
            [
              "DynEnvMap Sky Pipeline",
              "IBL-Irradiance",
              "IBL-Radiance",
              "DynEnvMap SH Pipeline",
            ].includes(pass.pipelineLabel),
        ).length;
        if (normalPasses === 44) {
          starvationServed = true;
          break;
        }
        if (!frame.didRender) {
          break;
        }
        await yieldBrowser();
      }
      const starvation = {
        served: starvationServed,
        frames: starvationFrames,
        after: snapshotManagers(),
      };
      const repeat = forceFrame("repeat");

      producerState.normal = {
        active: true,
        demand: "unknown",
        mode: "fixed",
      };
      producerState.high = {
        active: true,
        demand: "unknown",
        mode: "fixed",
      };
      managers[0]._webgpuCache.needsUpdate = true;
      forceDeferrableDirty(managers[1]);
      const mandatoryHigh = forceFrame("mandatory-high");
      const mandatoryRepeat = forceFrame("mandatory-repeat");

      scene.morphTo2D(0);
      producerState.normal = {
        active: true,
        demand: "proven-none",
        mode: "split-promotion",
      };
      producerState.high = {
        active: false,
        demand: "unknown",
        mode: "fixed",
      };
      for (let index = 0; index < 5; index++) {
        forceFrame("split-warm");
        await yieldBrowser();
      }
      const splitCandidates = [179, 150, 90, 45, -179, -90];
      const splitAttempts = [];
      let selectedSplitCandidate = null;
      for (let index = 0; index < splitCandidates.length; index++) {
        const longitude = splitCandidates[index];
        viewer.camera.setView({
          destination: C.Cartesian3.fromDegrees(longitude, 20, 1_500_000),
        });
        const attempt = forceFrame(`split-search-${index}`);
        const encoderLabels = attempt.audit.encoders.map(
          (encoder) => encoder.label,
        );
        const split = encoderLabels.includes(
          "Secondary Viewport Continuation Encoder",
        );
        splitAttempts.push({ longitude, split, encoderLabels });
        if (split) {
          selectedSplitCandidate = longitude;
          break;
        }
      }
      forceDeferrableDirty(managers[0]);
      const split2D = forceFrame("split-2d");
      const splitRepeat = forceFrame("split-repeat");

      await device.queue.onSubmittedWorkDone();
      await new Promise((resolve) => setTimeout(resolve, 50));
      const managerIds = managers.map((manager) => audit.objectId(manager));
      return {
        ...baseResult,
        fixedTime: "2026-06-21T19:00:00Z",
        schedulerBudget: context._environmentRefreshScheduler.budget,
        managerIdentityDistinct:
          managerIds.length === 2 &&
          managerIds[0] != null &&
          managerIds[0] !== managerIds[1],
        optionalFeatures: {
          iblPrefilterQuality: context.iblPrefilterQuality,
          envMapMultiScatter: context.envMapMultiScatter,
          sceneCaptureReflections: context.sceneCaptureReflections,
          envMapTemporalAccumulation: context.envMapTemporalAccumulation,
          cloudsInReflections: context.cloudsInReflections,
        },
        warm,
        splitSearch: {
          found: selectedSplitCandidate !== null,
          selected: selectedSplitCandidate,
          attempts: splitAttempts,
        },
        visibility: {
          canvasWidth: scene.canvas.width,
          canvasHeight: scene.canvas.height,
          globeTilesToRender:
            scene.globe?._surface?._tilesToRender?.length ?? 0,
        },
        instrumentation: clone(audit.instrumentation),
        requestDeviceCalls: audit.requestDeviceCalls,
        requestDeviceHooksReady: [...audit.requestDeviceHooksReady],
        privateEncodersCreated: clone(audit.privateEncodersCreated),
        privateEncoderSubmits: clone(audit.privateEncoderSubmits),
        lanes: {
          control,
          priority,
          starvation,
          repeat,
          mandatoryHigh,
          mandatoryRepeat,
          split2D,
          splitRepeat,
        },
        renderErrors,
      };
    },
    {
      maximumWarmFrames: MAXIMUM_WARM_FRAMES,
      idleWarmFramesRequired: IDLE_WARM_FRAMES_REQUIRED,
      maxDeferralFrames: MAX_DEFERRAL_FRAMES,
    },
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
  artifact.generatedAt = new Date().toISOString();
  artifact.status =
    exitCode === 0 ? "PASS" : exitCode === 3 ? "STRUCTURAL" : "FAIL";
  artifact.pass = exitCode === 0;
  artifact.exitCode = exitCode;
  artifact.incomplete = false;
  artifact.viewer = {
    url: viewerUrl.href,
    renderer: "webgpu",
    offline: true,
    manualRenderLoop: true,
  };
  artifact.gateArm = gateArm;
  artifact.checks = checks;
  artifact.failures = failed.map((check) => ({
    name: check.name,
    structural: check.structural,
    detail: check.detail,
  }));
  artifact.evidence = run;
  artifact.webgpuGate = gate;
  artifact.browserErrors = allBrowserErrors;
  artifact.localRequestFailures = allLocalRequestFailures;
} catch (error) {
  exitCode = 2;
  const failure = String(error?.stack ?? error);
  artifact.generatedAt = new Date().toISOString();
  artifact.status = "ERROR";
  artifact.pass = false;
  artifact.exitCode = exitCode;
  artifact.incomplete = false;
  artifact.failures = [{ name: "harness", structural: true, detail: failure }];
  artifact.error = failure;
} finally {
  await browser?.close().catch(() => {});
  clearTimeout(watchdog);
  artifact.firstRed.preserved = artifact.firstRed.existedBefore;
  if (exitCode !== 0 && !artifact.firstRed.existedBefore) {
    artifact.firstRed.written = true;
  }
  const serialized = `${JSON.stringify(artifact, null, 2)}\n`;
  fs.writeFileSync(OUTPUT, serialized);
  if (artifact.firstRed.written) {
    fs.writeFileSync(FIRST_RED, serialized);
  }
}

console.log(JSON.stringify(artifact, null, 2));
console.log(`Artifact: ${OUTPUT}`);

process.exitCode = exitCode;
