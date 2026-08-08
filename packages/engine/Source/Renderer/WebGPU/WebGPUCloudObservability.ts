/**
 * Cloud CPU and GPU observability, and temporal-cost counters.
 *
 * The byte-inert `timestampWrites` on the cloud render passes and on the
 * environment Sky Fill let `CesiumDebug.gpuPassCost()` attribute GPU time to
 * the cloud march. That is GPU-timer wiring, not an observability surface: it
 * says nothing about how many pixels the march dispatched, how much of the
 * frame the cloud lane occupied, whether the temporal history accepted or
 * reset, what the weather cache did, or what the CPU spent scheduling any of
 * it. This module is the pure, allocation-bounded half that answers those:
 *
 *   1. {@link CloudFrameCounters} — one mutable record, created once per
 *      context and reset in place at the top of every cloud execute. The reset
 *      is a `for` over a fixed field list, so a culled or early-returned frame
 *      reports zeros rather than the previous frame's numbers, and no frame
 *      allocates.
 *   2. {@link CloudCpuStageAccumulator} — fixed-slot `Float64Array` timing for
 *      the named CPU stages, disabled by default. `beginStage` and `endStage`
 *      return on one boolean read, so the shipped path pays no
 *      `performance.now()` and the render result cannot depend on the
 *      instrumentation.
 *   3. {@link summarizeCloudGpuCoverage} — the cloud-scoped unique-sample fold.
 *
 * The third is why this file consumes `WebGPUTimestampAccounting` rather than
 * summing pass times. Adding per-pass durations double-counts every nanosecond
 * two passes share, and clamping the resulting ratio to 1 hides the
 * double-count instead of reporting it. A cloud lane is exactly where that
 * bites: the shadow map, the cascade atlas and the half-res march are separate
 * passes a driver may overlap. The cloud total is therefore the union of the
 * cloud passes' intervals, folded by the same `summarizeFrameCoverage` the
 * whole-frame ledger uses, and the excess of the sum over the union is surfaced
 * as `overlapMs`. A cloud GPU claim built on the naive sum is not falsifiable;
 * one built on the union is.
 *
 * The eight pass names below are the render-pass descriptor labels, because
 * that is the key `WebGPUPerformanceManager.withRenderPassTimestamps` records
 * timings under. They are data, not a re-derivation:
 * `cloud-observability-counters.spec.mjs` reads the renderer source and fails
 * if a label here has no `timedCloudPass` site, or if a site's label is absent
 * from this list.
 *
 * Nothing here touches WGSL. Register allocation is static, so a runtime-gated
 * shader counter would still cost occupancy on the default path. Every counter
 * is CPU-side bookkeeping over numbers the renderer already computes, and the
 * sample-count fields are therefore bounded proxies — dispatched pixels times
 * the resolved step budget — rather than true sample counts.
 *
 * @module WebGPUCloudObservability
 */

import type { DebugStatsObject } from "../GraphicsContext.js";
import { summarizeFrameCoverage } from "./WebGPUTimestampAccounting.js";
import type { TimedPassSample } from "./WebGPUTimestampAccounting.js";
// The attachment contract is published alongside the counters so a reader of
// the debug surface can see what each target is for without opening the
// renderer. Pure data: this module still touches no WGSL and no device.
import { CLOUD_RECONSTRUCTION_ATTACHMENTS } from "./WebGPUCloudReconstructionAttachments.js";

/**
 * Render-pass labels of the cloud passes, in encode order. Keys into the
 * timestamp profiler's per-pass results and into the frame's raw samples.
 */
export const CLOUD_TIMED_PASS_NAMES: readonly string[] = Object.freeze([
  "CloudShadow map pass",
  "CloudShadow cascade atlas pass",
  "ProceduralClouds half-res pass",
  // The reconstruction attachment producer, encoded between the raymarch and
  // the resolve so the set can be read inside the resolve. Present only when
  // the opt-in attachment set is enabled; entries may be added to this
  // registry but never removed, so absence from a frame is reported through
  // `missingPassNames` rather than by shrinking the table.
  "CloudReconstructionAttachments pass",
  "CloudTemporalResolve pass",
  "CloudUpscale composite pass",
  "ProceduralClouds pass",
  "ProceduralClouds transmittance-mask pass",
]);

/**
 * The environment pass the cloud deck feeds but does not own. Kept apart from
 * the list above and reported as its own scope: folding it into the cloud
 * union would attribute the whole sky bake to the cloud lane.
 */
export const CLOUD_ENVIRONMENT_TIMED_PASS_NAMES: readonly string[] =
  Object.freeze(["DynEnvMap Sky Fill"]);

/** Named CPU stages, in execute order. Index = slot in the accumulator. */
export const CLOUD_CPU_STAGE_NAMES: readonly string[] = Object.freeze([
  "total",
  "pack",
  "shadow",
  "temporal",
  "composite",
]);

/** Slot indices for {@link CLOUD_CPU_STAGE_NAMES}. */
export const CloudCpuStage = Object.freeze({
  TOTAL: 0,
  PACK: 1,
  SHADOW: 2,
  TEMPORAL: 3,
  COMPOSITE: 4,
});

/** Number of CPU stages, i.e. the accumulator's slot count. */
export const CLOUD_CPU_STAGE_COUNT = CLOUD_CPU_STAGE_NAMES.length;

/**
 * Per-frame cloud counters. Every field is a plain number so the record can be
 * reset by index without allocating and published without a cast.
 *
 * "Per frame" means "for the most recent cloud execute". Cumulative history
 * lives on the cloud cache (`temporalHistoryResetCount` and friends) and is
 * folded in at snapshot time, not duplicated here.
 */
export interface CloudFrameCounters {
  /** Cloud executes entered since the context was created. */
  frames: number;
  /** Executes that returned before encoding any pass (frustum cull, no device). */
  culledFrames: number;

  /** Raymarch colour target width in pixels (half-res target when active). */
  marchWidth: number;
  /** Raymarch colour target height in pixels. */
  marchHeight: number;
  /** `marchWidth * marchHeight` — pixels the march pass dispatched. */
  marchPixels: number;
  /** True when the raymarch ran into the reduced-resolution target. */
  halfResActive: number;

  /** Temporal history (current/history resolve) target width. */
  resolveWidth: number;
  /** Temporal history target height. */
  resolveHeight: number;
  /** Pixels the temporal resolve pass wrote this frame; 0 when temporal is off. */
  resolvePixels: number;
  /** Pixels the bilateral upscale composited; 0 on the full-res path. */
  upscalePixels: number;

  /** Resolved primary-march step budget (`CloudUniforms.maxSteps`). */
  maxSteps: number;
  /** Resolved light-march step budget (`CloudUniforms.lightSteps`). */
  lightSteps: number;
  /**
   * Bounded proxy: `marchPixels * maxSteps`. An upper bound, never a sample
   * count.
   */
  primarySampleBudget: number;
  /** Bounded proxy: `marchPixels * maxSteps * lightSteps`. */
  lightSampleBudget: number;

  /** 1 when the temporal resolve accepted the reprojected history this frame. */
  historyAccepted: number;
  /** 1 when the classifier rejected it for any reason this frame. */
  historyRejected: number;
  /** 1 when the rejection started a new history generation. */
  historyReset: number;
  /** Reset-reason bitmask observed this frame (0 when accepted). */
  historyResetReasons: number;

  // The reconstruction attachment set is opt-in and default off, so all of the
  // fields below read 0 on the shipped path. That zero is evidence rather than
  // an absence: it is how the default path reports that the producer encoded
  // nothing and allocated nothing.
  /** Reconstruction attachment width; 0 when the set was not produced. */
  attachmentWidth: number;
  /** Reconstruction attachment height; 0 when the set was not produced. */
  attachmentHeight: number;
  /** Pixels the attachment producer dispatched this frame. */
  attachmentPixels: number;
  /** Owned attachments written this frame (the MRT target count). */
  attachmentCount: number;
  /**
   * Generation the producer used this frame; 0 when it did not run. Advances
   * on every (re)allocation, so a resize or device swap is visible here rather
   * than inferred from a size change.
   */
  attachmentGeneration: number;

  /** Frames the weather texture was already current, so nothing uploaded. */
  weatherCacheHits: number;
  /** Frames the resident version differed from the requested one. */
  weatherCacheMisses: number;
  /** `queue.writeTexture` calls into the weather texture this frame. */
  weatherUploads: number;
  /** Bytes written into the weather texture this frame. */
  weatherUploadBytes: number;
  /** Bytes the weather texture currently occupies (0 before allocation). */
  weatherLiveBytes: number;

  /**
   * Bytes the owned reconstruction attachments currently occupy. Like
   * `weatherLiveBytes` this describes a resident resource, so it survives the
   * per-frame reset — zeroing it would report the set as freed on every
   * quiescent frame. The shared half-res colour target is excluded: it is not
   * cost the attachment set added, and reporting it here would overstate the
   * set's footprint.
   */
  attachmentLiveBytes: number;

  // The four fields below are what distinguishes a frame that requested the
  // march-emitted reconstruction variant from one that actually ran it, which
  // is the distinction a half-built pipeline would otherwise hide.
  /**
   * Resident: 1 when `reconstructionEnabled` is set on the cache, published
   * every execute. A `requested` of 1 beside an `emitted` of 0 is the honest
   * report of a frame that asked for the variant and fell back — a
   * full-resolution tier, an orthographic or morph frame, or a pipeline that
   * could not build.
   */
  reconstructionRequested: number;
  /** 1 when the emitting march pipeline encoded this frame. */
  reconstructionEmitted: number;
  /** 1 when the consuming temporal resolve encoded this frame. */
  reconstructionConsumed: number;
  /**
   * Colour targets the producer pass wrote this frame: 3 on the estimator path
   * and 2 when the march emitted contract slot 1 itself. It is not derivable
   * from `attachmentCount`, which is the contract size and does not change,
   * and it is the counter that proves ownership of the depth slot moved rather
   * than the set quietly being written twice.
   */
  reconstructionProducerTargets: number;

  /** Cloud shadow passes encoded this frame (single map + cascade atlas). */
  shadowPassCount: number;
  /** Single beer-shadow-map edge length; 0 when cast shadows are off. */
  shadowSize: number;
  /** Cascade atlas tile edge length; 0 when the cascade atlas is off. */
  shadowCascadeSize: number;
  /** Cascade tiles rendered this frame. */
  shadowCascadeCount: number;

  /** Total cloud render passes encoded this frame. */
  passCount: number;
  /** Per-pass encode counts, parallel to {@link CLOUD_TIMED_PASS_NAMES}. */
  passCounts: number[];
}

/**
 * The scalar fields of {@link CloudFrameCounters} that {@link
 * resetCloudFrameCounters} zeroes each frame. `frames` and `culledFrames` are
 * absent: they are lifetime counters, and resetting them would erase the only
 * evidence that the lane ran at all.
 */
const RESET_FIELDS: readonly (keyof CloudFrameCounters)[] = Object.freeze([
  "marchWidth",
  "marchHeight",
  "marchPixels",
  "halfResActive",
  "resolveWidth",
  "resolveHeight",
  "resolvePixels",
  "upscalePixels",
  "maxSteps",
  "lightSteps",
  "primarySampleBudget",
  "lightSampleBudget",
  "historyAccepted",
  "historyRejected",
  "historyReset",
  "historyResetReasons",
  "attachmentWidth",
  "attachmentHeight",
  "attachmentPixels",
  "attachmentCount",
  "attachmentGeneration",
  // Per-frame verdicts. `reconstructionRequested` is absent for the same
  // reason `attachmentLiveBytes` is: it describes the resident request, and
  // zeroing it every frame would report the variant as un-asked-for on any
  // frame that fell back.
  "reconstructionEmitted",
  "reconstructionConsumed",
  "reconstructionProducerTargets",
  "weatherCacheHits",
  "weatherCacheMisses",
  "weatherUploads",
  "weatherUploadBytes",
  "shadowPassCount",
  "shadowSize",
  "shadowCascadeSize",
  "shadowCascadeCount",
  "passCount",
]);

/**
 * Allocates the per-context counter record. Called once from
 * `ensureCloudCache`; never on the per-frame path.
 */
export function createCloudFrameCounters(): CloudFrameCounters {
  return {
    frames: 0,
    culledFrames: 0,
    marchWidth: 0,
    marchHeight: 0,
    marchPixels: 0,
    halfResActive: 0,
    resolveWidth: 0,
    resolveHeight: 0,
    resolvePixels: 0,
    upscalePixels: 0,
    maxSteps: 0,
    lightSteps: 0,
    primarySampleBudget: 0,
    lightSampleBudget: 0,
    historyAccepted: 0,
    historyRejected: 0,
    historyReset: 0,
    historyResetReasons: 0,
    attachmentWidth: 0,
    attachmentHeight: 0,
    attachmentPixels: 0,
    attachmentCount: 0,
    attachmentGeneration: 0,
    attachmentLiveBytes: 0,
    reconstructionRequested: 0,
    reconstructionEmitted: 0,
    reconstructionConsumed: 0,
    reconstructionProducerTargets: 0,
    weatherCacheHits: 0,
    weatherCacheMisses: 0,
    weatherUploads: 0,
    weatherUploadBytes: 0,
    weatherLiveBytes: 0,
    shadowPassCount: 0,
    shadowSize: 0,
    shadowCascadeSize: 0,
    shadowCascadeCount: 0,
    passCount: 0,
    passCounts: new Array<number>(CLOUD_TIMED_PASS_NAMES.length).fill(0),
  };
}

/**
 * Zeroes the per-frame fields in place. No allocation, and `weatherLiveBytes`
 * and `attachmentLiveBytes` survive because they describe resident resources
 * rather than this frame's work — zeroing them would report the textures as
 * freed on every quiescent frame.
 *
 * @param counters The record to reset.
 * @param culled True when the execute is about to return without encoding.
 */
export function resetCloudFrameCounters(
  counters: CloudFrameCounters,
  culled: boolean = false,
): void {
  for (let i = 0; i < RESET_FIELDS.length; i++) {
    (counters as unknown as Record<string, number>)[RESET_FIELDS[i] as string] =
      0;
  }
  const passCounts = counters.passCounts;
  for (let i = 0; i < passCounts.length; i++) {
    passCounts[i] = 0;
  }
  counters.frames++;
  if (culled) {
    counters.culledFrames++;
  }
}

/**
 * Records one encoded cloud render pass by its descriptor label.
 *
 * Called from the single `timedCloudPass` helper every cloud pass already
 * routes through, so the count cannot drift from the encode sites the way
 * hand-placed increments could. An unrecognised label increments `passCount`
 * only — a new pass shows up in the total immediately and in the per-pass
 * breakdown once it is registered above, which is a visible gap rather than a
 * silent omission.
 *
 * @param counters The per-frame record, or undefined before the cache exists.
 * @param label The render-pass descriptor label.
 */
export function recordCloudPass(
  counters: CloudFrameCounters | undefined,
  label: string | undefined,
): void {
  if (counters === undefined) {
    return;
  }
  counters.passCount++;
  if (label === undefined) {
    return;
  }
  const index = CLOUD_TIMED_PASS_NAMES.indexOf(label);
  if (index >= 0) {
    counters.passCounts[index]++;
  }
}

/**
 * Fixed-slot CPU stage timing.
 *
 * Disabled by default, which is a correctness property rather than a
 * performance one: the instrumentation has to be removable without changing
 * the render result, and a `performance.now()` pair straddling the pack stage
 * is observable work on the shipped path. Enabled, each stage costs two clock
 * reads per frame.
 *
 * Re-entrant begins are not merged: a second `beginStage` for a slot that is
 * already open overwrites the open timestamp and increments `reentries`, which
 * is reported. Silently nesting would make the stage's total meaningless.
 */
export class CloudCpuStageAccumulator {
  private _enabled = false;
  private readonly _open: Float64Array;
  private readonly _last: Float64Array;
  private readonly _sum: Float64Array;
  private readonly _max: Float64Array;
  private readonly _count: Float64Array;
  private _reentries = 0;
  private _unmatchedEnds = 0;

  constructor() {
    this._open = new Float64Array(CLOUD_CPU_STAGE_COUNT).fill(-1);
    this._last = new Float64Array(CLOUD_CPU_STAGE_COUNT);
    this._sum = new Float64Array(CLOUD_CPU_STAGE_COUNT);
    this._max = new Float64Array(CLOUD_CPU_STAGE_COUNT);
    this._count = new Float64Array(CLOUD_CPU_STAGE_COUNT);
  }

  /** Whether stage timing is currently collecting. */
  get enabled(): boolean {
    return this._enabled;
  }

  /**
   * Turns stage timing on or off. Turning it off clears the accumulated
   * statistics, so a later read cannot present numbers from an older,
   * differently-configured run as current.
   */
  setEnabled(enabled: boolean): void {
    if (this._enabled === enabled) {
      return;
    }
    this._enabled = enabled;
    this.reset();
  }

  /** Clears every slot and the anomaly counters. */
  reset(): void {
    this._open.fill(-1);
    this._last.fill(0);
    this._sum.fill(0);
    this._max.fill(0);
    this._count.fill(0);
    this._reentries = 0;
    this._unmatchedEnds = 0;
  }

  /**
   * Opens a stage. Returns immediately on one boolean read when disabled.
   *
   * @param stage A {@link CloudCpuStage} slot index.
   */
  beginStage(stage: number): void {
    if (!this._enabled || stage < 0 || stage >= CLOUD_CPU_STAGE_COUNT) {
      return;
    }
    if (this._open[stage] >= 0) {
      this._reentries++;
    }
    this._open[stage] = performance.now();
  }

  /**
   * Closes a stage and folds its duration. An end with no matching begin is
   * counted and discarded rather than folded as a bogus duration.
   *
   * @param stage A {@link CloudCpuStage} slot index.
   */
  endStage(stage: number): void {
    if (!this._enabled || stage < 0 || stage >= CLOUD_CPU_STAGE_COUNT) {
      return;
    }
    const openedAt = this._open[stage];
    if (openedAt < 0) {
      this._unmatchedEnds++;
      return;
    }
    const elapsed = performance.now() - openedAt;
    this._open[stage] = -1;
    this._last[stage] = elapsed;
    this._sum[stage] += elapsed;
    this._count[stage]++;
    if (elapsed > this._max[stage]) {
      this._max[stage] = elapsed;
    }
  }

  /** Allocation-bearing debug snapshot. Never called on the render path. */
  snapshot(): DebugStatsObject {
    const stages: { [name: string]: DebugStatsObject } = {};
    for (let i = 0; i < CLOUD_CPU_STAGE_COUNT; i++) {
      const count = this._count[i];
      stages[CLOUD_CPU_STAGE_NAMES[i]] = {
        lastMs: this._last[i],
        avgMs: count > 0 ? this._sum[i] / count : 0,
        maxMs: this._max[i],
        samples: count,
      };
    }
    return {
      enabled: this._enabled,
      reentries: this._reentries,
      unmatchedEnds: this._unmatchedEnds,
      stages,
    };
  }
}

/** Cloud-scoped unique-sample GPU coverage for one profiled frame. */
export interface CloudGpuCoverage extends DebugStatsObject {
  /** Cloud passes present in the frame's samples. */
  readonly matchedPassCount: number;
  /** Registered cloud pass names that produced no sample this frame. */
  readonly missingPassNames: readonly string[];
  /** Union of the cloud passes' GPU intervals — each nanosecond counted once. */
  readonly cloudCoveredMs: number;
  /** Naive sum of the cloud passes' durations. */
  readonly cloudSummedMs: number;
  /** `cloudSummedMs − cloudCoveredMs`. Non-zero means cloud passes overlapped. */
  readonly cloudOverlapMs: number;
  /** Span from the first cloud pass begin to the last cloud pass end. */
  readonly cloudSpanMs: number;
  /** GPU span of the entire frame, from the unscoped fold. */
  readonly frameSpanMs: number;
  /** `cloudCoveredMs / frameSpanMs`, or null for a degenerate frame span. */
  readonly cloudFrameFraction: number | null;
  /** Cloud passes whose end preceded their begin (driver residue). */
  readonly invertedSampleCount: number;
}

/**
 * Folds the cloud subset of one frame's timed passes into unique-sample
 * measures, and expresses the result as a fraction of the entire frame's span.
 *
 * The two folds are separate calls to the same pure function: the cloud fold
 * answers how much unique GPU time the cloud lane occupied, the unscoped fold
 * answers out of how much. Deriving the second from the first would make the
 * fraction a tautology.
 *
 * @param samples One frame's timed passes, relative to the frame origin.
 * @param names Cloud pass names to scope to. Defaults to every cloud pass.
 */
export function summarizeCloudGpuCoverage(
  samples: readonly TimedPassSample[],
  names: readonly string[] = CLOUD_TIMED_PASS_NAMES,
): CloudGpuCoverage {
  const scoped: TimedPassSample[] = [];
  const seen = new Set<string>();
  for (const sample of samples) {
    if (names.indexOf(sample.name) >= 0) {
      scoped.push(sample);
      seen.add(sample.name);
    }
  }
  const cloud = summarizeFrameCoverage(scoped);
  const whole = summarizeFrameCoverage(samples);
  const missingPassNames = names.filter((name) => !seen.has(name));
  return {
    matchedPassCount: seen.size,
    missingPassNames,
    cloudCoveredMs: cloud.coveredMs,
    cloudSummedMs: cloud.summedPassMs,
    cloudOverlapMs: cloud.overlapMs,
    cloudSpanMs: cloud.frameSpanMs,
    frameSpanMs: whole.frameSpanMs,
    cloudFrameFraction:
      whole.frameSpanMs > 0 ? cloud.coveredMs / whole.frameSpanMs : null,
    invertedSampleCount: cloud.invertedSampleCount,
  };
}

/** Cumulative temporal-history bookkeeping the cloud cache already maintains. */
export interface CloudTemporalLifetime {
  readonly generation: number;
  readonly resetCount: number;
  readonly acceptedFrames: number;
}

/** Everything {@link snapshotCloudObservability} needs, all already computed. */
export interface CloudObservabilityInputs {
  readonly counters: CloudFrameCounters;
  readonly cpu: CloudCpuStageAccumulator;
  readonly temporal: CloudTemporalLifetime;
  /** Latest profiled frame's raw samples, or null when timestamps are absent. */
  readonly samples: readonly TimedPassSample[] | null;
}

/**
 * Builds the debug snapshot published through
 * `WebGPUContext.getRendererStatistics().volumetricClouds` and
 * `CesiumDebug.cloudStats()`.
 *
 * Allocation-bearing by design; it is a read surface, not a render-path call.
 * `gpu` is `null` rather than a zero-filled object when the adapter has no
 * timestamp support, because a zeroed timing block is indistinguishable from a
 * genuinely idle lane.
 */
export function snapshotCloudObservability(
  inputs: CloudObservabilityInputs,
): DebugStatsObject {
  const c = inputs.counters;
  const passes: { [name: string]: number } = {};
  for (let i = 0; i < CLOUD_TIMED_PASS_NAMES.length; i++) {
    passes[CLOUD_TIMED_PASS_NAMES[i]] = c.passCounts[i];
  }
  const acceptance = c.historyAccepted + c.historyRejected;
  return {
    frames: c.frames,
    culledFrames: c.culledFrames,
    raymarch: {
      width: c.marchWidth,
      height: c.marchHeight,
      pixelsDispatched: c.marchPixels,
      halfResActive: c.halfResActive === 1,
      maxSteps: c.maxSteps,
      lightSteps: c.lightSteps,
      primarySampleBudget: c.primarySampleBudget,
      lightSampleBudget: c.lightSampleBudget,
    },
    reconstruction: {
      resolveWidth: c.resolveWidth,
      resolveHeight: c.resolveHeight,
      resolvePixels: c.resolvePixels,
      upscalePixels: c.upscalePixels,
      historyAccepted: c.historyAccepted,
      historyRejected: c.historyRejected,
      historyReset: c.historyReset,
      historyResetReasons: c.historyResetReasons,
      // Per-frame acceptance is 0 or 1, so this is the frame's own verdict.
      // The lifetime ratio lives under `lifetime`, where its denominator is
      // unambiguous.
      acceptanceThisFrame:
        acceptance > 0 ? c.historyAccepted / acceptance : null,
      // The attachment set. `produced` false with `liveBytes` above 0 is a real
      // and readable state: the targets are resident but this frame did not run
      // the producer, having been culled or on a full-resolution tier. The
      // contract is published alongside the numbers so a reader does not have
      // to open the source to learn what each channel means.
      attachments: {
        produced: c.attachmentPixels > 0,
        width: c.attachmentWidth,
        height: c.attachmentHeight,
        pixelsDispatched: c.attachmentPixels,
        targetCount: c.attachmentCount,
        generation: c.attachmentGeneration,
        liveBytes: c.attachmentLiveBytes,
        contract: CLOUD_RECONSTRUCTION_ATTACHMENTS.map((spec) => ({
          slot: spec.slot,
          key: spec.key,
          format: String(spec.format),
          bytesPerTexel: spec.bytesPerTexel,
          ownedHere: spec.ownedHere,
          producer: spec.producer,
          // Non-null only on the depth slot, whose ownership moves to the
          // march under the emission variant. Published so a reader of the
          // debug surface can tell which pass wrote the target they are
          // looking at without opening the renderer.
          variantProducer: spec.variantProducer ?? null,
          // The temporal resolve is the owned set's only consumer. Further
          // rejection work adds policy inside that same pass rather than a new
          // reader, so this list is expected to stay as it is.
          consumers: spec.consumers.slice(),
          channels: spec.channels,
        })),
      },
      // The emission and consumption verdicts, kept beside the attachment
      // block rather than inside it: the attachments are a resource, this is
      // what happened to them this frame. `requested` true with `emitted` false
      // is the honest report of a fallback, and `producerTargets` is what
      // proves ownership of the depth slot moved, going from 3 to 2, rather
      // than the set being written twice.
      emission: {
        requested: c.reconstructionRequested > 0,
        emitted: c.reconstructionEmitted > 0,
        consumed: c.reconstructionConsumed > 0,
        producerTargets: c.reconstructionProducerTargets,
      },
      lifetime: {
        generation: inputs.temporal.generation,
        resetCount: inputs.temporal.resetCount,
        acceptedFrames: inputs.temporal.acceptedFrames,
      },
    },
    weather: {
      cacheHits: c.weatherCacheHits,
      cacheMisses: c.weatherCacheMisses,
      uploads: c.weatherUploads,
      uploadBytes: c.weatherUploadBytes,
      liveBytes: c.weatherLiveBytes,
    },
    shadow: {
      passCount: c.shadowPassCount,
      size: c.shadowSize,
      cascadeSize: c.shadowCascadeSize,
      cascadeCount: c.shadowCascadeCount,
    },
    passCount: c.passCount,
    passes,
    cpu: inputs.cpu.snapshot(),
    gpu:
      inputs.samples === null
        ? null
        : {
            clouds: summarizeCloudGpuCoverage(inputs.samples),
            environment: summarizeCloudGpuCoverage(
              inputs.samples,
              CLOUD_ENVIRONMENT_TIMED_PASS_NAMES,
            ),
          },
  };
}
