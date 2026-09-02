/// <reference types="@webgpu/types" />
/**
 * WebGPU Pick Framebuffer — Renders pick-color pass and reads back pixel data
 *
 * Equivalent of PickFramebuffer.js for WebGPU. Creates an offscreen render
 * target (rgba8unorm + depth24plus-stencil8), renders the scene's pick pass
 * into it, then uses copyTextureToBuffer + mapAsync for GPU readback.
 *
 * Because WebGPU readback is inherently async, synchronous `end()` uses a
 * pre-mapped staging buffer that was mapped in a previous frame. The first
 * call may return empty results. `endAsync()` always works correctly.
 *
 * @private
 */

import BoundingRectangle from "../../Core/BoundingRectangle.js";
import Color from "../../Core/Color.js";
import defined from "../../Core/defined.js";
import {
  WebGPUFeatureIdTexture,
  type FeatureIdResolveResult,
} from "./WebGPUFeatureIdTexture.js";
import { WebGPUPickTransientReadbackPool } from "./WebGPUPickTransientReadback.js";

// No more than this many pick passes may elapse before a typed center-pixel
// result expires. Coordinates and logical rectangles match exactly because a
// nearby pixel can represent a different voxel or metadata value.
const CENTER_PIXEL_MAX_STALE_FRAMES = 4;
// Distinct typed queries that may converge concurrently. A multi-property
// `pickMetadata` sweep arms one readback per property inside a single task, so a
// single-slot cache let only the last-armed identity ever publish and starved
// every earlier one forever. Small and LRU-evicted: the working set is the
// number of properties a caller reads per pick, not a pixel history.
const CENTER_PIXEL_CACHE_CAPACITY = 8;
// In-flight readbacks. Bounded so a device that stops resolving `mapAsync`
// cannot grow the list without limit; an evicted request simply declines to
// publish, which is the same outcome a superseded request already had.
const CENTER_PIXEL_PENDING_CAPACITY = 16;
// 256-byte minimum mapping alignment for a 1x1 RGBA8 copy.
const CENTER_STAGING_BUFFER_SIZE = 256;
const VOXEL_CENTER_PIXEL_CLEAR_VALUE: GPUColorDict = Object.freeze({
  r: 1.0,
  g: 1.0,
  b: 1.0,
  a: 1.0,
});

type CenterPixelPassDomain = "metadata" | "voxel";

interface CenterPixelReadbackIdentity {
  domain: CenterPixelPassDomain;
  queryIdentityA: unknown;
  queryIdentityB: unknown;
  queryIdentityC: unknown;
  queryVersion: unknown;
  viewProvenance: unknown;
  logicalOriginX: number;
  logicalOriginTopY: number;
  logicalWidth: number;
  logicalHeight: number;
  pixelX: number;
  pixelY: number;
  device: GPUDevice;
  resourceGeneration: number;
  attachmentGeneration: number;
  colorTexture: GPUTexture;
}

interface CenterPixelCacheEntry extends CenterPixelReadbackIdentity {
  value: Uint8Array;
  stamp: number;
  requestSequence: number;
}

interface CenterPixelPendingRequest {
  identity: CenterPixelReadbackIdentity;
  requestSequence: number;
}

/**
 * The pick color attachment MUST use the same format the pick PIPELINES target
 * (`context.pickPipelineFormat`), otherwise WebGPU drops every
 * pick draw with "Attachment state of [RenderPipeline] is not compatible with
 * [RenderPassEncoder Pick render pass]" and the pick FBO stays empty — the
 * actual cause of every pick returning undefined. Only 8-bit unorm
 * formats support the byte-readback path below; an HDR/float scene format
 * therefore uses an LDR rgba8unorm pick attachment and matching pipelines.
 * @private
 */
export function getWebGPUPickColorFormat(
  context: CesiumGraphicsContext,
): GPUTextureFormat {
  const typedContext = context as unknown as {
    pickPipelineFormat?: GPUTextureFormat;
    scenePipelineFormat?: GPUTextureFormat;
  };
  const canonical = typedContext.pickPipelineFormat;
  if (canonical) {
    return canonical;
  }
  const f = typedContext.scenePipelineFormat;
  return f === "bgra8unorm" || f === "rgba8unorm" ? f : "rgba8unorm";
}

function getPickResourceGeneration(context: CesiumGraphicsContext): number {
  return "resourceGeneration" in context &&
    typeof context.resourceGeneration === "number"
    ? context.resourceGeneration
    : 0;
}

/**
 * Spiral search pattern for finding picked objects from center outward.
 * `bgra` swaps R/B because `bgra8unorm` stores bytes as [B,G,R,A] while the
 * pickId color comparison is in [R,G,B,A].
 */
function pickObjectsFromPixels(
  context: CesiumGraphicsContext,
  pixels: Uint8Array,
  width: number,
  height: number,
  limit: number = 1,
  bgra: boolean = false,
): CesiumOpaqueObject[] {
  const max = Math.max(width, height);
  const length = max * max;
  const halfWidth = Math.floor(width * 0.5);
  const halfHeight = Math.floor(height * 0.5);

  let x = 0;
  let y = 0;
  let dx = 0;
  let dy = -1;

  const objects = new Set<CesiumOpaqueObject>();
  for (let i = 0; i < length; ++i) {
    if (
      -halfWidth <= x &&
      x <= halfWidth &&
      -halfHeight <= y &&
      y <= halfHeight
    ) {
      const index = 4 * ((halfHeight - y) * width + x + halfWidth);
      const r = bgra ? pixels[index + 2] : pixels[index];
      const g = pixels[index + 1];
      const b = bgra ? pixels[index] : pixels[index + 2];
      const a = pixels[index + 3];

      // A pick hit is any pixel whose reconstructed key (RGBA, little-endian)
      // is nonzero. Pick-ID colors come from `Color.fromRgba(key)`, which
      // packs the incrementing integer key into the bytes low-to-high on a
      // little-endian host: red = key & 0xff, green = (key >> 8) & 0xff,
      // blue = (key >> 16) & 0xff, ALPHA = (key >> 24) & 0xff. So every pick
      // id below 2^24 (i.e. essentially all of them) has alpha 0. The old
      // `a > 0` gate therefore rejected virtually every real pick — the true
      // cause of the residual pick failure once the pass was fixed. The cleared
      // pick FBO is (0,0,0,0) → key 0, which `getObjectByPickColor` maps to
      // undefined (pick ids start at 1). Include alpha in the gate so valid
      // keys above 0x00ffffff remain decodable; this also prepares the path
      // for contiguous PickId ranges without changing ordinary low-key IDs.
      if (r !== 0 || g !== 0 || b !== 0 || a !== 0) {
        const pickColor = Color.bytesToRgba(r, g, b, a);
        const object = context.getObjectByPickColor(pickColor);
        if (defined(object)) {
          objects.add(object);
          if (objects.size >= limit) {
            break;
          }
        }
      }
    }

    // Spiral direction changes
    if (x === y || (x < 0 && -x === y) || (x > 0 && x === 1 - y)) {
      const temp = dx;
      dx = -dy;
      dy = temp;
    }

    x += dx;
    y += dy;
  }
  return [...objects];
}

interface PickReadbackRegion {
  logicalOriginX: number;
  logicalOriginTopY: number;
  logicalWidth: number;
  logicalHeight: number;
  copyOriginX: number;
  copyOriginTopY: number;
  copyWidth: number;
  copyHeight: number;
  copyOffsetX: number;
  copyOffsetY: number;
  resourceGeneration: number;
  attachmentGeneration: number;
  viewProvenance: unknown;
  // Pick-clock value when this readback was captured. Read only by the
  // instrumentation; deliberately absent from _readbackRegionsEqual so a
  // region that differs only in age still matches exactly as before.
  armStamp: number;
}

/**
 * Expand a clipped, row-padded GPU copy back into the caller's logical pick
 * rectangle. Pixels outside the attachment are intentionally left zero. This
 * keeps the requested cursor at the logical center instead of shifting the
 * entire query inward at canvas edges.
 */
function unpackPickPixels(
  mappedData: Uint8Array,
  bytesPerRow: number,
  region: PickReadbackRegion,
): Uint8Array {
  const pixels = new Uint8Array(region.logicalWidth * region.logicalHeight * 4);
  const copyRowBytes = region.copyWidth * 4;
  for (let row = 0; row < region.copyHeight; row++) {
    const srcOffset = row * bytesPerRow;
    const dstOffset =
      ((region.copyOffsetY + row) * region.logicalWidth + region.copyOffsetX) *
      4;
    pixels.set(
      mappedData.subarray(srcOffset, srcOffset + copyRowBytes),
      dstOffset,
    );
  }
  return pixels;
}

/**
 * Why a synchronous pick returned nothing is not knowable from the outside.
 * WebGPU cannot read the pick attachment back synchronously, so every
 * `end()` is served from a readback armed by an EARLIER pick, or declined.
 * Nothing in this subsystem recorded which of those happened, how old a served
 * result was, or which gate declined it, so a report of "picking is broken"
 * could not be separated from "picking is one pick behind" or "the cache gate
 * fail-closed because the camera moved". These counters make that distinction
 * observable BEFORE any gate is changed.
 *
 * Cost judgement, per the logging rules: every counter below is a monotonic
 * increment, or a min/max over a number the caller already computed, on a path
 * that runs at most once per pick and already pays for a texture copy plus a
 * spiral search over the pick rectangle. Stripping them would make a shipped
 * build unmeasurable while saving arithmetic that does not register against
 * that surrounding work, so they are NOT pragma-wrapped. The one member that
 * costs real work is `recentDeclines`: it allocates a record per decline and
 * its only consumer is a developer reading a console dump, so its maintenance
 * IS pragma-wrapped and a production build reports an empty list.
 * @private
 */
export type PickServeDeclineReason =
  | "no-device"
  | "no-attachment"
  | "no-cached-readback"
  | "resource-generation-changed"
  | "attachment-generation-changed"
  | "view-provenance-changed"
  | "center-outside-cached-region"
  | "no-region-overlap";

/**
 * Why a readback was not armed. The two `*-in-flight` reasons are the
 * `_readbackInFlight` suppressions: the first is the whole request skipped
 * because the previous map has not resolved, the second is a request whose
 * copy extent changed and so needs a differently-sized staging buffer that
 * cannot be swapped while the old one is mapping-pending.
 * @private
 */
export type PickArmDeclineReason =
  | "no-device"
  | "no-attachment"
  | "readback-in-flight"
  | "staging-buffer-in-flight"
  | "staging-buffer-unavailable"
  | "no-frame-encoder"
  | "frame-submit-rejected"
  | "frame-not-submitted";

/**
 * Why a completed readback's bytes were discarded instead of becoming the
 * cache. Anything other than `superseded-by-newer-sequence` means the bytes
 * were rendered against state that no longer exists.
 * @private
 */
export type PickPublishDeclineReason =
  | "destroyed"
  | "device-changed"
  | "resource-generation-changed"
  | "color-texture-replaced"
  | "attachment-generation-changed"
  | "view-provenance-changed"
  | "superseded-by-newer-sequence";

/**
 * Why a metadata/voxel center-pixel read returned `undefined`. `no-cache-entry`
 * is a genuinely cold typed query; `stale-beyond-max` means the value exists
 * but is older than CENTER_PIXEL_MAX_STALE_FRAMES picks.
 * @private
 */
export type PickCenterPixelDeclineReason =
  | "no-device"
  | "no-attachment"
  | "no-cache-entry"
  | "stale-beyond-max"
  | "identity-not-current"
  | "duplicate-in-flight";

type PickDeclineStage = "serve" | "arm" | "publish" | "centerPixel";

type PickDeclineReason =
  | PickServeDeclineReason
  | PickArmDeclineReason
  | PickPublishDeclineReason
  | PickCenterPixelDeclineReason;

interface PickDeclineRecord {
  stage: PickDeclineStage;
  reason: PickDeclineReason;
  updateCount: number;
}

const PICK_SERVE_DECLINE_REASONS: readonly PickServeDeclineReason[] = [
  "no-device",
  "no-attachment",
  "no-cached-readback",
  "resource-generation-changed",
  "attachment-generation-changed",
  "view-provenance-changed",
  "center-outside-cached-region",
  "no-region-overlap",
];

const PICK_ARM_DECLINE_REASONS: readonly PickArmDeclineReason[] = [
  "no-device",
  "no-attachment",
  "readback-in-flight",
  "staging-buffer-in-flight",
  "staging-buffer-unavailable",
  "no-frame-encoder",
  "frame-submit-rejected",
  "frame-not-submitted",
];

const PICK_PUBLISH_DECLINE_REASONS: readonly PickPublishDeclineReason[] = [
  "destroyed",
  "device-changed",
  "resource-generation-changed",
  "color-texture-replaced",
  "attachment-generation-changed",
  "view-provenance-changed",
  "superseded-by-newer-sequence",
];

const PICK_CENTER_PIXEL_DECLINE_REASONS: readonly PickCenterPixelDeclineReason[] =
  [
    "no-device",
    "no-attachment",
    "no-cache-entry",
    "stale-beyond-max",
    "identity-not-current",
    "duplicate-in-flight",
  ];

// Enough decline history to explain one interaction (a drag is a handful of
// picks) without becoming a log. Debug builds only.
const RECENT_DECLINE_CAPACITY = 32;

/**
 * Pre-seed every reason to zero so an increment is a write to an existing own
 * property rather than a hidden-class transition, and so a reader can tell
 * "this reason never fired" from "this build does not know that reason".
 */
function zeroedDeclineCounts<T extends string>(
  reasons: readonly T[],
): Record<T, number> {
  const counts = {} as Record<T, number>;
  for (const reason of reasons) {
    counts[reason] = 0;
  }
  return counts;
}

function copyDeclineCounts<T extends string>(
  counts: Record<T, number>,
): Record<T, number> {
  return { ...counts };
}

/**
 * Age of a served result, measured in PICK PASSES (the clock `_updateCount`
 * advances once per `begin()`), not in rendered frames: a paused scene that
 * picks twice reports an age of 1 however many frames elapsed, because pick
 * staleness is bounded by picks.
 * @private
 */
export interface PickAgeSummary {
  last: number | null;
  min: number | null;
  max: number | null;
  mean: number | null;
  samples: number;
}

class PickAgeTracker {
  private _last: number | null = null;
  private _min: number | null = null;
  private _max: number | null = null;
  private _sum: number = 0;
  private _samples: number = 0;

  add(age: number): void {
    // A negative or non-finite age means the arm stamp and the pick clock
    // disagree, which is a bookkeeping defect rather than a measurement.
    // Dropping it keeps min/max honest instead of poisoning them.
    if (!Number.isFinite(age) || age < 0) {
      return;
    }
    this._last = age;
    this._min = this._min === null ? age : Math.min(this._min, age);
    this._max = this._max === null ? age : Math.max(this._max, age);
    this._sum += age;
    this._samples++;
  }

  summarize(): PickAgeSummary {
    return {
      last: this._last,
      min: this._min,
      max: this._max,
      mean: this._samples > 0 ? this._sum / this._samples : null,
      samples: this._samples,
    };
  }

  reset(): void {
    this._last = null;
    this._min = null;
    this._max = null;
    this._sum = 0;
    this._samples = 0;
  }
}

/**
 * Immutable view of the pick counters. Every nested record is copied so a
 * caller holding a snapshot cannot mutate the live counters, and two snapshots
 * taken at different times can be diffed.
 * @private
 */
export interface PickFramebufferStatistics {
  endCalls: number;
  endAsyncCalls: number;
  servedFresh: number;
  servedCached: number;
  cold: number;
  serveDeclines: Record<PickServeDeclineReason, number>;
  readbacksArmed: number;
  readbacksPublished: number;
  readbacksUnresolved: number;
  readbackInFlightSuppressions: number;
  armDeclines: Record<PickArmDeclineReason, number>;
  publishDeclines: Record<PickPublishDeclineReason, number>;
  age: PickAgeSummary;
  centerPixel: {
    reads: number;
    served: number;
    armed: number;
    published: number;
    declines: Record<PickCenterPixelDeclineReason, number>;
    age: PickAgeSummary;
  };
  recentDeclines: PickDeclineRecord[];
}

/**
 * Counter block for one {@link WebGPUPickFramebuffer}. Exported so a spec can
 * drive the outcomes directly; runtime readers go through
 * `WebGPUPickFramebuffer.getStatistics()`.
 *
 * Invariants the recorders enforce structurally:
 *  - `endCalls === servedFresh + servedCached + cold`, because every `end()`
 *    increments exactly one of the three.
 *  - `cold === sum(serveDeclines)`, because `recordServeDecline` is the only
 *    thing that increments `cold`. An undifferentiated decline count therefore
 *    cannot drift away from its reasons.
 *  - `readbacksArmed >= readbacksPublished + sum(publishDeclines)`; the
 *    difference is `readbacksUnresolved` — readbacks whose map never came back
 *    at all, which no other counter would reveal.
 * @private
 */
export class WebGPUPickFramebufferStats {
  endCalls: number = 0;
  endAsyncCalls: number = 0;
  servedFresh: number = 0;
  servedCached: number = 0;
  cold: number = 0;
  readbacksArmed: number = 0;
  readbacksPublished: number = 0;
  centerPixelReads: number = 0;
  centerPixelServed: number = 0;
  centerPixelArmed: number = 0;
  centerPixelPublished: number = 0;

  readonly serveDeclines: Record<PickServeDeclineReason, number> =
    zeroedDeclineCounts(PICK_SERVE_DECLINE_REASONS);
  readonly armDeclines: Record<PickArmDeclineReason, number> =
    zeroedDeclineCounts(PICK_ARM_DECLINE_REASONS);
  readonly publishDeclines: Record<PickPublishDeclineReason, number> =
    zeroedDeclineCounts(PICK_PUBLISH_DECLINE_REASONS);
  readonly centerPixelDeclines: Record<PickCenterPixelDeclineReason, number> =
    zeroedDeclineCounts(PICK_CENTER_PIXEL_DECLINE_REASONS);

  private readonly _age = new PickAgeTracker();
  private readonly _centerPixelAge = new PickAgeTracker();
  private _recentDeclines: PickDeclineRecord[] = [];

  recordEnd(): void {
    this.endCalls++;
  }

  recordEndAsync(): void {
    this.endAsyncCalls++;
  }

  /** Exact-region cache hit: the served bytes cover precisely this query. */
  recordServedFresh(age: number): void {
    this.servedFresh++;
    this._age.add(age);
  }

  /** Widened-gate hit: bytes reprojected out of an overlapping earlier query. */
  recordServedCached(age: number): void {
    this.servedCached++;
    this._age.add(age);
  }

  recordServeDecline(
    reason: PickServeDeclineReason,
    updateCount: number,
  ): void {
    this.cold++;
    this.serveDeclines[reason]++;
    this._pushRecentDecline("serve", reason, updateCount);
  }

  recordReadbackArmed(): void {
    this.readbacksArmed++;
  }

  recordArmDecline(reason: PickArmDeclineReason, updateCount: number): void {
    this.armDeclines[reason]++;
    this._pushRecentDecline("arm", reason, updateCount);
  }

  recordReadbackPublished(): void {
    this.readbacksPublished++;
  }

  recordPublishDecline(
    reason: PickPublishDeclineReason,
    updateCount: number,
  ): void {
    this.publishDeclines[reason]++;
    this._pushRecentDecline("publish", reason, updateCount);
  }

  recordCenterPixelRead(): void {
    this.centerPixelReads++;
  }

  recordCenterPixelServed(age: number): void {
    this.centerPixelServed++;
    this._centerPixelAge.add(age);
  }

  recordCenterPixelArmed(): void {
    this.centerPixelArmed++;
  }

  recordCenterPixelPublished(): void {
    this.centerPixelPublished++;
  }

  recordCenterPixelDecline(
    reason: PickCenterPixelDeclineReason,
    updateCount: number,
  ): void {
    this.centerPixelDeclines[reason]++;
    this._pushRecentDecline("centerPixel", reason, updateCount);
  }

  /**
   * Both `_readbackInFlight` suppression shapes, summed: a skipped request and
   * a staging buffer that could not be resized while mapping-pending. A rising
   * value under continuous picking means the map is not keeping up with the
   * pick rate, which presents to a user as picks that never warm.
   */
  get readbackInFlightSuppressions(): number {
    return (
      this.armDeclines["readback-in-flight"] +
      this.armDeclines["staging-buffer-in-flight"]
    );
  }

  /**
   * Readbacks that were armed and then neither published nor explicitly
   * declined — the map rejected, or the framebuffer was torn down first.
   */
  get readbacksUnresolved(): number {
    let declined = 0;
    for (const reason of PICK_PUBLISH_DECLINE_REASONS) {
      declined += this.publishDeclines[reason];
    }
    return Math.max(
      0,
      this.readbacksArmed - this.readbacksPublished - declined,
    );
  }

  getStatistics(): PickFramebufferStatistics {
    return {
      endCalls: this.endCalls,
      endAsyncCalls: this.endAsyncCalls,
      servedFresh: this.servedFresh,
      servedCached: this.servedCached,
      cold: this.cold,
      serveDeclines: copyDeclineCounts(this.serveDeclines),
      readbacksArmed: this.readbacksArmed,
      readbacksPublished: this.readbacksPublished,
      readbacksUnresolved: this.readbacksUnresolved,
      readbackInFlightSuppressions: this.readbackInFlightSuppressions,
      armDeclines: copyDeclineCounts(this.armDeclines),
      publishDeclines: copyDeclineCounts(this.publishDeclines),
      age: this._age.summarize(),
      centerPixel: {
        reads: this.centerPixelReads,
        served: this.centerPixelServed,
        armed: this.centerPixelArmed,
        published: this.centerPixelPublished,
        declines: copyDeclineCounts(this.centerPixelDeclines),
        age: this._centerPixelAge.summarize(),
      },
      recentDeclines: this._recentDeclines.slice(),
    };
  }

  reset(): void {
    this.endCalls = 0;
    this.endAsyncCalls = 0;
    this.servedFresh = 0;
    this.servedCached = 0;
    this.cold = 0;
    this.readbacksArmed = 0;
    this.readbacksPublished = 0;
    this.centerPixelReads = 0;
    this.centerPixelServed = 0;
    this.centerPixelArmed = 0;
    this.centerPixelPublished = 0;
    for (const reason of PICK_SERVE_DECLINE_REASONS) {
      this.serveDeclines[reason] = 0;
    }
    for (const reason of PICK_ARM_DECLINE_REASONS) {
      this.armDeclines[reason] = 0;
    }
    for (const reason of PICK_PUBLISH_DECLINE_REASONS) {
      this.publishDeclines[reason] = 0;
    }
    for (const reason of PICK_CENTER_PIXEL_DECLINE_REASONS) {
      this.centerPixelDeclines[reason] = 0;
    }
    this._age.reset();
    this._centerPixelAge.reset();
    this._recentDeclines = [];
  }

  /**
   * Decline history. Allocating a record per decline is real per-pick work
   * whose only consumer is a console dump, so it is confined to debug builds;
   * the aggregate counters above stay live in production and remain sufficient
   * to answer "how often" without the "in what order".
   */
  private _pushRecentDecline(
    stage: PickDeclineStage,
    reason: PickDeclineReason,
    updateCount: number,
  ): void {
    //>>includeStart('debug', pragmas.debug);
    this._recentDeclines.push({ stage, reason, updateCount });
    if (this._recentDeclines.length > RECENT_DECLINE_CAPACITY) {
      this._recentDeclines.shift();
    }
    //>>includeEnd('debug');
  }
}

export class WebGPUPickFramebuffer {
  private _context: CesiumGraphicsContext;
  private _device: GPUDevice | null = null;
  private _colorTexture: GPUTexture | null = null;
  private _depthTexture: GPUTexture | null = null;
  private _width: number = 0;
  private _height: number = 0;
  // Pick color attachment format — must match context.pickPipelineFormat.
  private _colorFormat: GPUTextureFormat = "rgba8unorm";
  private _passState: CesiumPassState;
  private _isDestroyed: boolean = false;

  // Cached texture views — recreated only when textures are reallocated on
  // resize. begin() used to call createView() on every frame which leaked
  // ~60 view objects/sec under continuous picking.
  private _colorView: GPUTextureView | null = null;
  private _depthView: GPUTextureView | null = null;
  private _attachmentDevice: GPUDevice | null = null;
  private _attachmentResourceGeneration: number = -1;

  // Staging buffer for color readback
  private _stagingBuffer: GPUBuffer | null = null;
  private _stagingBufferSize: number = 0;
  private _stagingBufferDevice: GPUDevice | null = null;
  private _lastReadPixels: Uint8Array | null = null;
  private _lastReadRegion: PickReadbackRegion | null = null;
  // Monotonic request IDs prevent an older overlapping async completion from
  // overwriting the shared synchronous cache after a newer request finishes.
  private _nextReadbackSequence: number = 0;
  private _lastPublishedReadbackSequence: number = -1;

  // Limit the guidance diagnostic emitted when `end()` cannot serve an earlier
  // matching readback to once per framebuffer.
  private _coldPickWarned: boolean = false;
  // True between submit-of-copyTextureToBuffer and the unmap that follows
  // mapAsync's resolution. While true, we must not encode another copy to
  // the same staging buffer or the queue will reject the submit with
  // "Buffer used in submit while mapped" (the buffer transitions through
  // mapping-pending → mapped before unmap clears it). sampleHeight in
  // continuous CallbackProperty demos hits this every frame.
  private _readbackInFlight: boolean = false;
  // Overflow staging for the request the single persistent buffer cannot take.
  // See WebGPUPickTransientReadback for why a second concurrent readback is the
  // ordinary case and not an edge case.
  private readonly _transientReadbacks = new WebGPUPickTransientReadbackPool();

  // Logical top-down pick rectangle. Its origin may be outside the attachment
  // at canvas edges; keeping it unshifted preserves the caller's cursor at the
  // center of the spiral search. GPU rendering/copying uses the separately
  // clipped source rectangle below, then readback zero-pads the missing area.
  private _pickOriginX: number = 0;
  private _pickOriginTopY: number = 0;
  private _pickWidth: number = 1;
  private _pickHeight: number = 1;
  private _copyOriginX: number = 0;
  private _copyOriginTopY: number = 0;
  private _copyWidth: number = 1;
  private _copyHeight: number = 1;
  private _copyOffsetX: number = 0;
  private _copyOffsetY: number = 0;
  private _attachmentGeneration: number = 0;
  private _ordinaryPickViewProvenance: unknown = undefined;

  // Depth readback resources (separate depth32float target for copyable depth)
  private _readableDepthTexture: GPUTexture | null = null;
  private _readableDepthView: GPUTextureView | null = null;
  private _classificationDepthTexture: GPUTexture | null = null;
  private _classificationDepthView: GPUTextureView | null = null;
  private _classificationDepthPlaceholderTexture: GPUTexture | null = null;
  private _classificationDepthPlaceholderView: GPUTextureView | null = null;
  private _depthStagingBuffer: GPUBuffer | null = null;
  private _depthStagingBufferDevice: GPUDevice | null = null;

  // Lazily constructed helper that samples
  // `_colorTexture` (the unified, source-agnostic per-fragment feature-ID
  // G-buffer) inside a fullscreen post-process pass. Default-OFF: stays null
  // unless resolveFeatureIdRecolorAsync() is explicitly called.
  private _featureIdTexture: WebGPUFeatureIdTexture | null = null;

  // Metadata and voxel callers render their own pass, so they cannot consume
  // `_lastReadPixels` from an ordinary object-pick pass. readCenterPixel arms
  // a dedicated 1x1 readback and may synchronously serve a bounded previously
  // completed value only when its typed query, rectangle, view, device,
  // resource, attachment, and owner identity match. A cold query is undefined.
  //
  // Cache slots and in-flight requests use the same structural identity so
  // distinct concurrent queries complete independently.
  private _centerPixelCacheEntries: CenterPixelCacheEntry[] = [];
  private _centerPendingRequests: CenterPixelPendingRequest[] = [];
  private _nextCenterReadbackSequence: number = 0;
  // Staleness clock — advanced once per begin() (one metadata/voxel pick is
  // one begin → render → readCenterPixel cycle). Measured in picks, not wall
  // time, so a paused scene keeps a valid cache indefinitely.
  private _updateCount: number = 0;

  // Pick instrumentation. See WebGPUPickFramebufferStats for the cost
  // judgement behind which members survive the debug pragma.
  private readonly _stats = new WebGPUPickFramebufferStats();

  constructor(context: CesiumGraphicsContext) {
    this._context = context;
    this._device = context._device ?? null;

    // Create pass state with scissor/viewport
    this._passState = {
      context: context,
      framebuffer: undefined,
      blendingEnabled: false,
      scissorTest: {
        enabled: true,
        rectangle: new BoundingRectangle(),
      },
      viewport: new BoundingRectangle(),
    };
  }

  /**
   * Begin a pick rendering pass.
   * Creates/resizes the offscreen render targets and returns a pass state.
   */
  begin(
    screenSpaceRectangle: CesiumBoundingRectangle,
    viewport: CesiumBoundingRectangle,
    centerPixelDomain?: CenterPixelPassDomain,
    viewProvenance?: unknown,
  ): CesiumPassState {
    // Start the off-screen frame before any pick commands are rebuilt.
    // Globe.updateForPick and other feature renderers allocate uniform-ring
    // slices during the scene update that follows this call; starting only in
    // executePickPass is too late and makes those commands reference the
    // previous normal frame's page. The renderer's later beginPickFrame call
    // remains a harmless idempotent guard.
    const pickFrameContext = this._context as CesiumGraphicsContext & {
      beginPickFrame?: () => void;
    };
    pickFrameContext.beginPickFrame?.();

    const device = this._context._device;
    if (!device) {
      return this._passState;
    }
    const deviceChanged = device !== this._attachmentDevice;
    const resourceGeneration = getPickResourceGeneration(this._context);
    const resourceGenerationChanged =
      resourceGeneration !== this._attachmentResourceGeneration;
    this._device = device;

    const rawWidth = viewport?.width;
    const rawHeight = viewport?.height;
    // Defensive guard — viewport.width/height arrive undefined/NaN during
    // teardown or if a caller passes a partially-initialized rect. Falling
    // through with NaN propagates to bytesPerRow/bufferSize and surfaces as
    // "createBuffer Failed to read 'size' property: Value is null".
    const width =
      typeof rawWidth === "number" && rawWidth > 0 ? Math.floor(rawWidth) : 1;
    const height =
      typeof rawHeight === "number" && rawHeight > 0
        ? Math.floor(rawHeight)
        : 1;

    // Advance the center-pixel staleness clock once per pick pass.
    this._updateCount++;
    if (centerPixelDomain === undefined) {
      this._ordinaryPickViewProvenance = viewProvenance;
    }

    BoundingRectangle.clone(
      screenSpaceRectangle,
      this._passState.scissorTest.rectangle,
    );

    // Resolve the caller's logical query and its clipped GPU source rectangle.
    // Cesium supplies a GL-style bottom-origin y; WebGPU render-pass scissors
    // and texture copies are top-origin. Do not shift the logical origin to
    // keep its full extent in bounds: doing so moves the cursor away from the
    // center pixel at a canvas edge. Instead copy only the intersection and
    // zero-pad it back into the logical rectangle during readback.
    const pickWidth = Math.max(
      1,
      Math.min(width, Math.floor(screenSpaceRectangle.width ?? 1)),
    );
    const pickHeight = Math.max(
      1,
      Math.min(height, Math.floor(screenSpaceRectangle.height ?? 1)),
    );
    const glOriginX = Math.floor(screenSpaceRectangle.x ?? 0);
    const glOriginY = Math.floor(screenSpaceRectangle.y ?? 0);
    this._pickOriginX = glOriginX;
    this._pickOriginTopY = height - glOriginY - pickHeight;
    this._pickWidth = pickWidth;
    this._pickHeight = pickHeight;

    const copyRight = Math.max(
      0,
      Math.min(width, this._pickOriginX + pickWidth),
    );
    const copyBottom = Math.max(
      0,
      Math.min(height, this._pickOriginTopY + pickHeight),
    );
    this._copyOriginX = Math.max(0, Math.min(width, this._pickOriginX));
    this._copyOriginTopY = Math.max(0, Math.min(height, this._pickOriginTopY));
    this._copyWidth = Math.max(0, copyRight - this._copyOriginX);
    this._copyHeight = Math.max(0, copyBottom - this._copyOriginTopY);
    this._copyOffsetX = this._copyOriginX - this._pickOriginX;
    this._copyOffsetY = this._copyOriginTopY - this._pickOriginTopY;

    // The pick color attachment MUST match the pick pipelines' canonical
    // target format or WebGPU drops every pick draw.
    const colorFormat = getWebGPUPickColorFormat(this._context);

    // Create or recreate render targets
    if (
      width !== this._width ||
      height !== this._height ||
      colorFormat !== this._colorFormat ||
      deviceChanged ||
      resourceGenerationChanged
    ) {
      this._destroyTextures();
      if (deviceChanged || resourceGenerationChanged) {
        if (this._depthStagingBuffer) {
          this._depthStagingBuffer.destroy();
          this._depthStagingBuffer = null;
        }
        this._depthStagingBufferDevice = null;
        if (this._featureIdTexture) {
          this._featureIdTexture.destroy();
          this._featureIdTexture = null;
        }
      }
      this._colorFormat = colorFormat;

      this._colorTexture = device.createTexture({
        label: "Pick color texture",
        size: [width, height],
        format: colorFormat,
        usage:
          GPUTextureUsage.RENDER_ATTACHMENT |
          GPUTextureUsage.COPY_SRC |
          GPUTextureUsage.TEXTURE_BINDING,
      });

      this._depthTexture = device.createTexture({
        label: "Pick depth texture",
        size: [width, height],
        format: "depth24plus-stencil8",
        usage:
          GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });

      this._width = width;
      this._height = height;
      this._attachmentDevice = device;
      this._attachmentResourceGeneration = resourceGeneration;
      this._attachmentGeneration++;

      // Cache texture views once per resize — see field comment above.
      this._colorView = this._colorTexture.createView();
      this._depthView = this._depthTexture.createView();

      // A 1x1 packed-depth sentinel lets classification renderers build their
      // commands before the pick executor knows whether this query contains
      // classification work. The full-viewport packed target remains lazy and
      // is allocated only by ensureClassificationDepth below.
      this._classificationDepthPlaceholderTexture = device.createTexture({
        label: "Pick classification depth placeholder",
        size: [1, 1],
        format: "rgba8unorm",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      this._classificationDepthPlaceholderView =
        this._classificationDepthPlaceholderTexture.createView();
      device.queue.writeTexture(
        { texture: this._classificationDepthPlaceholderTexture },
        new Uint8Array(4),
        { bytesPerRow: 4, rowsPerImage: 1 },
        [1, 1],
      );
    }

    const pickDepthContext = this._context as CesiumGraphicsContext & {
      _pickClassificationDepthView?: GPUTextureView | null;
    };
    pickDepthContext._pickClassificationDepthView =
      this._classificationDepthPlaceholderView;

    // Store the pick framebuffer info so the context can use it
    this._passState.framebuffer = {
      _isWebGPUPickFBO: true,
      colorTexture: this._colorTexture,
      depthTexture: this._depthTexture,
      colorView: this._colorView ?? undefined,
      depthView: this._depthView ?? undefined,
      width: this._width,
      height: this._height,
      pickScissor: {
        x: this._copyOriginX,
        y: this._copyOriginTopY,
        width: this._copyWidth,
        height: this._copyHeight,
      },
      // Voxel coordinate zero is valid. Clear its dedicated pass to a value
      // outside base-255's representable low-byte domain so a no-command or
      // no-fragment pass cannot masquerade as root tile / sample zero.
      pickClearValue:
        centerPixelDomain === "voxel"
          ? VOXEL_CENTER_PIXEL_CLEAR_VALUE
          : undefined,
      ensureClassificationDepth: this._ensureClassificationDepthTarget,
    } as CesiumOpaqueFramebuffer;

    this._passState.viewport.width = width;
    this._passState.viewport.height = height;

    return this._passState;
  }

  private _captureReadbackRegion(): PickReadbackRegion {
    return {
      logicalOriginX: this._pickOriginX,
      logicalOriginTopY: this._pickOriginTopY,
      logicalWidth: this._pickWidth,
      logicalHeight: this._pickHeight,
      copyOriginX: this._copyOriginX,
      copyOriginTopY: this._copyOriginTopY,
      copyWidth: this._copyWidth,
      copyHeight: this._copyHeight,
      copyOffsetX: this._copyOffsetX,
      copyOffsetY: this._copyOffsetY,
      resourceGeneration: this._attachmentResourceGeneration,
      attachmentGeneration: this._attachmentGeneration,
      viewProvenance: this._ordinaryPickViewProvenance,
      armStamp: this._updateCount,
    };
  }

  private _readbackRegionsEqual(
    left: PickReadbackRegion | null,
    right: PickReadbackRegion,
  ): boolean {
    return (
      left !== null &&
      left.logicalOriginX === right.logicalOriginX &&
      left.logicalOriginTopY === right.logicalOriginTopY &&
      left.logicalWidth === right.logicalWidth &&
      left.logicalHeight === right.logicalHeight &&
      left.copyOriginX === right.copyOriginX &&
      left.copyOriginTopY === right.copyOriginTopY &&
      left.copyWidth === right.copyWidth &&
      left.copyHeight === right.copyHeight &&
      left.copyOffsetX === right.copyOffsetX &&
      left.copyOffsetY === right.copyOffsetY &&
      left.resourceGeneration === right.resourceGeneration &&
      left.attachmentGeneration === right.attachmentGeneration &&
      left.viewProvenance === right.viewProvenance
    );
  }

  /**
   * Sync-pick cache gate, fail-closed on any view change. A cached readback is
   * reusable only when it carries the SAME view provenance as the current
   * query — the caller derives that string from the scene mode, morph time,
   * drawing-buffer size, near/far, view and projection matrices, and the pick
   * owner's model matrix and visibility. Any camera movement therefore mints a
   * fresh provenance and this gate declines, so synchronous `end()` returns
   * empty for the whole duration of a motion and only warms once the view is
   * exactly static again.
   *
   * The spatial reprojection below is what remains reachable under that gate:
   * with provenance equal, a cursor that moved WITHIN the previous readback's
   * region still decodes. The cached pixels are tightly packed rows of
   * `cached.logicalWidth` (unpackPickPixels already stripped the GPU copy's
   * 256-byte bytesPerRow padding), so both buffers are indexed in absolute
   * top-down attachment coordinates via their logical origins. Query pixels
   * outside the cached region stay zero, which decodes as no-hit —
   * conservative for the outer spiral taps while keeping the center pixel (the
   * actual cursor) exact.
   *
   * Whether picking SHOULD stay fail-closed through motion, or should instead
   * reuse a spatially-overlapping readback taken under a different view, is an
   * open maintainer decision. Do not relax the provenance comparison without
   * it: the exact gate is what guarantees a returned hit was rendered from the
   * view the caller is asking about.
   *
   * Returns null when the gate does not apply (caller falls through to the
   * cold-pick path).
   */
  private _extractPixelsFromCachedRegion(
    region: PickReadbackRegion,
  ): Uint8Array | null {
    const cached = this._lastReadRegion;
    const cachedPixels = this._lastReadPixels;
    // One combined test would answer "declined" without answering "why", and
    // the why is the whole point of the gate: a provenance decline is the
    // camera moving, a generation decline is the attachment being rebuilt.
    // Evaluated in the original order, so only the label is new.
    if (!cached || !cachedPixels) {
      this._stats.recordServeDecline("no-cached-readback", this._updateCount);
      return null;
    }
    if (cached.resourceGeneration !== region.resourceGeneration) {
      this._stats.recordServeDecline(
        "resource-generation-changed",
        this._updateCount,
      );
      return null;
    }
    if (cached.attachmentGeneration !== region.attachmentGeneration) {
      this._stats.recordServeDecline(
        "attachment-generation-changed",
        this._updateCount,
      );
      return null;
    }
    if (cached.viewProvenance !== region.viewProvenance) {
      this._stats.recordServeDecline(
        "view-provenance-changed",
        this._updateCount,
      );
      return null;
    }

    // Center pixel of the current query in absolute top-down coordinates —
    // matches pickObjectsFromPixels' spiral origin (floor(w/2), floor(h/2)).
    const centerX = region.logicalOriginX + Math.floor(region.logicalWidth / 2);
    const centerY =
      region.logicalOriginTopY + Math.floor(region.logicalHeight / 2);
    if (
      centerX < cached.logicalOriginX ||
      centerX >= cached.logicalOriginX + cached.logicalWidth ||
      centerY < cached.logicalOriginTopY ||
      centerY >= cached.logicalOriginTopY + cached.logicalHeight
    ) {
      this._stats.recordServeDecline(
        "center-outside-cached-region",
        this._updateCount,
      );
      return null;
    }

    const overlapLeft = Math.max(region.logicalOriginX, cached.logicalOriginX);
    const overlapRight = Math.min(
      region.logicalOriginX + region.logicalWidth,
      cached.logicalOriginX + cached.logicalWidth,
    );
    const overlapTop = Math.max(
      region.logicalOriginTopY,
      cached.logicalOriginTopY,
    );
    const overlapBottom = Math.min(
      region.logicalOriginTopY + region.logicalHeight,
      cached.logicalOriginTopY + cached.logicalHeight,
    );
    const overlapWidth = overlapRight - overlapLeft;
    if (overlapWidth <= 0 || overlapBottom <= overlapTop) {
      this._stats.recordServeDecline("no-region-overlap", this._updateCount);
      return null;
    }

    const pixels = new Uint8Array(
      region.logicalWidth * region.logicalHeight * 4,
    );
    for (let absY = overlapTop; absY < overlapBottom; absY++) {
      const srcOffset =
        ((absY - cached.logicalOriginTopY) * cached.logicalWidth +
          (overlapLeft - cached.logicalOriginX)) *
        4;
      const dstOffset =
        ((absY - region.logicalOriginTopY) * region.logicalWidth +
          (overlapLeft - region.logicalOriginX)) *
        4;
      pixels.set(
        cachedPixels.subarray(srcOffset, srcOffset + overlapWidth * 4),
        dstOffset,
      );
    }
    return pixels;
  }

  private _publishReadbackCache(
    pixels: Uint8Array,
    region: PickReadbackRegion,
    requestSequence: number,
    requestDevice: GPUDevice,
    colorTexture: GPUTexture,
  ): void {
    // Split by reason for the same purpose as the serve gate: a torn-down
    // framebuffer, a rebuilt attachment and a superseded request are three
    // different stories about why a completed readback never became the cache.
    const reason: PickPublishDeclineReason | undefined = this._isDestroyed
      ? "destroyed"
      : this._device !== requestDevice ||
          this._attachmentDevice !== requestDevice
        ? "device-changed"
        : this._attachmentResourceGeneration !== region.resourceGeneration
          ? "resource-generation-changed"
          : this._colorTexture !== colorTexture
            ? "color-texture-replaced"
            : this._attachmentGeneration !== region.attachmentGeneration
              ? "attachment-generation-changed"
              : this._ordinaryPickViewProvenance !== region.viewProvenance
                ? "view-provenance-changed"
                : requestSequence < this._lastPublishedReadbackSequence
                  ? "superseded-by-newer-sequence"
                  : undefined;
    if (reason !== undefined) {
      this._stats.recordPublishDecline(reason, this._updateCount);
      return;
    }

    this._lastReadPixels = pixels;
    this._lastReadRegion = region;
    this._lastPublishedReadbackSequence = requestSequence;
    this._stats.recordReadbackPublished();
  }

  /**
   * End the pick pass and synchronously read back picked objects.
   * Note: On WebGPU, synchronous readback may return empty results on the first call
   * because GPU readback is inherently async. Use endAsync() for reliable results.
   *
   * For practical use, this returns the result from the previous frame's readback
   * if available, while starting a new readback for the current frame.
   */
  end(
    screenSpaceRectangle: CesiumBoundingRectangle,
    limit: number = 1,
  ): CesiumOpaqueObject[] {
    const context = this._context;
    const device = this._device;

    this._stats.recordEnd();
    if (!device || !this._colorTexture) {
      this._stats.recordServeDecline(
        !device ? "no-device" : "no-attachment",
        this._updateCount,
      );
      return [];
    }

    const region = this._captureReadbackRegion();

    // Start async readback for the current frame
    this._startReadback(region);

    // Return a previous result for this exact logical query and attachment
    // generation (fast path — no copy needed).
    if (
      this._lastReadPixels &&
      this._readbackRegionsEqual(this._lastReadRegion, region)
    ) {
      this._stats.recordServedFresh(
        this._updateCount -
          (this._lastReadRegion?.armStamp ?? this._updateCount),
      );
      return pickObjectsFromPixels(
        context,
        this._lastReadPixels,
        region.logicalWidth,
        region.logicalHeight,
        limit,
        this._colorFormat === "bgra8unorm",
      );
    }

    // Widened cache gate — a moving cursor produces a slightly different
    // logical region every frame, so the exact-match path above would return
    // [] for every synchronous pick during cursor motion. When the current
    // query's center pixel lies inside the cached region (same attachment
    // generation), reproject the cached rows into the current query rectangle
    // and decode from that instead of returning empty. Result staleness is
    // identical to the exact-match path (one frame).
    const reprojected = this._extractPixelsFromCachedRegion(region);
    if (reprojected) {
      this._stats.recordServedCached(
        this._updateCount -
          (this._lastReadRegion?.armStamp ?? this._updateCount),
      );
      return pickObjectsFromPixels(
        context,
        reprojected,
        region.logicalWidth,
        region.logicalHeight,
        limit,
        this._colorFormat === "bgra8unorm",
      );
    }

    // Cold pick — no readback has completed yet. WebGPU can't read the pixels
    // back synchronously, so the very first sync pick returns nothing. Warn
    // once steering one-off callers to the async path. (Permanent, latched —
    // app developers NEED this to understand why a first sync pick came back
    // empty; it never repeats once the readback warms.)
    if (!this._coldPickWarned) {
      this._coldPickWarned = true;
      // lint-debug-pragmas-allow: this one-shot cold-pick warning explains an empty result
      console.warn(
        "[CesiumJS:WebGPU] scene.pick() returned no result on its first call " +
          "because WebGPU reads the pick buffer asynchronously (one-frame " +
          "stale). This is expected for a standalone pick at a fresh location. " +
          "Use scene.pickAsync() for one-off / click-driven picks; the " +
          "continuous-hover scene.pick() pattern warms up after the first frame.",
      );
    }

    return [];
  }

  /**
   * End the pick pass and asynchronously read back picked objects.
   * This is the recommended path for WebGPU — always returns correct results.
   */
  async endAsync(
    screenSpaceRectangle: CesiumBoundingRectangle,
    frameState: CesiumFrameState,
    limit: number = 1,
  ): Promise<object[]> {
    const context = this._context;
    const device = this._device;

    this._stats.recordEndAsync();
    if (!device || !this._colorTexture) {
      this._stats.recordArmDecline(
        !device ? "no-device" : "no-attachment",
        this._updateCount,
      );
      return [];
    }

    const region = this._captureReadbackRegion();
    const colorTexture = this._colorTexture;
    const requestDevice = device;
    const requestSequence = this._nextReadbackSequence++;
    const bgra = this._colorFormat === "bgra8unorm";

    // A query can be entirely outside the attachment at a canvas boundary.
    // Its logical result is still well-defined: every pixel is the clear key.
    if (region.copyWidth === 0 || region.copyHeight === 0) {
      const pixels = new Uint8Array(
        region.logicalWidth * region.logicalHeight * 4,
      );
      // No GPU copy, but a publish is still expected, so this counts as armed
      // to keep armed >= published + publishDeclines meaningful.
      this._stats.recordReadbackArmed();
      this._publishReadbackCache(
        pixels,
        region,
        requestSequence,
        requestDevice,
        colorTexture,
      );
      return pickObjectsFromPixels(
        context,
        pixels,
        region.logicalWidth,
        region.logicalHeight,
        limit,
        bgra,
      );
    }

    // Each async request owns its exact-size staging buffer. Sharing the sync
    // path's persistent buffer allowed overlapping end()/endAsync() calls to
    // encode into a buffer that was mapping-pending or already mapped.
    const bytesPerRow = Math.ceil((region.copyWidth * 4) / 256) * 256;
    const bufferSize = bytesPerRow * region.copyHeight;
    let stagingBuffer: GPUBuffer | null = null;
    let mapped = false;
    try {
      stagingBuffer = device.createBuffer({
        label: "Pick async staging buffer",
        size: bufferSize,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      const encoder = device.createCommandEncoder({
        label: "Pick readback encoder",
      });

      encoder.copyTextureToBuffer(
        {
          texture: colorTexture,
          // Read the clipped region computed by begin(); its top-down origin
          // already accounts for the caller's bottom-origin rectangle.
          origin: [region.copyOriginX, region.copyOriginTopY, 0],
        },
        {
          buffer: stagingBuffer,
          bytesPerRow,
          rowsPerImage: region.copyHeight,
        },
        [region.copyWidth, region.copyHeight],
      );
      device.queue.submit([encoder.finish()]);
      this._stats.recordReadbackArmed();

      await stagingBuffer.mapAsync(GPUMapMode.READ);
      mapped = true;
      if (this._isDestroyed) {
        return [];
      }
      const mappedData = new Uint8Array(stagingBuffer.getMappedRange());
      const pixels = unpackPickPixels(mappedData, bytesPerRow, region);
      this._publishReadbackCache(
        pixels,
        region,
        requestSequence,
        requestDevice,
        colorTexture,
      );

      return pickObjectsFromPixels(
        context,
        pixels,
        region.logicalWidth,
        region.logicalHeight,
        limit,
        bgra,
      );
    } finally {
      if (mapped) {
        stagingBuffer?.unmap();
      }
      stagingBuffer?.destroy();
    }
  }

  /**
   * Read the center pixel of the pick rectangle.
   * Used for voxel coordinate picking and metadata picking.
   *
   * Callers submit the metadata or voxel render pass before invoking this
   * method so the copy is ordered after the draw.
   *
   * Each call arms or refreshes a 1x1 asynchronous readback and synchronously
   * serves a previously completed value only when the full query identity and
   * maximum-age checks pass. Distinct typed identities may overlap. A cold or
   * expired query returns `undefined` while its readback is pending.
   */
  readCenterPixel(
    screenSpaceRectangle: CesiumBoundingRectangle,
    domain: CenterPixelPassDomain = "metadata",
    queryIdentityA?: unknown,
    queryIdentityB?: unknown,
    queryVersion?: unknown,
    queryIdentityC?: unknown,
    viewProvenance?: unknown,
  ): Uint8Array | undefined {
    const device = this._device;
    const colorTexture = this._colorTexture;
    this._stats.recordCenterPixelRead();
    if (!device || !colorTexture) {
      this._stats.recordCenterPixelDecline(
        !device ? "no-device" : "no-attachment",
        this._updateCount,
      );
      return undefined;
    }
    const width = this._pickWidth;
    const height = this._pickHeight;
    const halfWidth = Math.floor(width * 0.5);
    const halfHeight = Math.floor(height * 0.5);

    // Absolute center coordinate within the full-viewport `_colorTexture`.
    // begin() already normalized the rectangle to top-down texture space.
    const px = Math.max(
      0,
      Math.min(this._pickOriginX + halfWidth, this._width - 1),
    );
    const py = Math.max(
      0,
      Math.min(this._pickOriginTopY + halfHeight, this._height - 1),
    );

    const voxelLifecycle = queryIdentityB as
      { contentRevision?: unknown } | undefined;
    const resolvedQueryIdentityC =
      domain === "voxel" && queryIdentityC === undefined
        ? voxelLifecycle?.contentRevision
        : queryIdentityC;
    const identity: CenterPixelReadbackIdentity = {
      domain,
      queryIdentityA,
      queryIdentityB,
      queryIdentityC: resolvedQueryIdentityC,
      queryVersion,
      viewProvenance,
      logicalOriginX: this._pickOriginX,
      logicalOriginTopY: this._pickOriginTopY,
      logicalWidth: width,
      logicalHeight: height,
      pixelX: px,
      pixelY: py,
      device,
      resourceGeneration: getPickResourceGeneration(this._context),
      attachmentGeneration: this._attachmentGeneration,
      colorTexture,
    };

    // Arm/refresh the readback for this center pixel. The guard inside dedupes
    // overlapping requests and swallows teardown races.
    this._readCenterPixelAsync(identity);

    const cached = this._takeCenterPixelCacheEntry(identity);
    if (
      cached &&
      this._updateCount - cached.stamp >= 0 &&
      this._updateCount - cached.stamp <= CENTER_PIXEL_MAX_STALE_FRAMES
    ) {
      this._stats.recordCenterPixelServed(this._updateCount - cached.stamp);
      return cached.value.slice(0, 4);
    }
    // A present-but-too-old entry and a genuinely cold query both return
    // undefined to the caller; only the counters can tell them apart.
    this._stats.recordCenterPixelDecline(
      cached ? "stale-beyond-max" : "no-cache-entry",
      this._updateCount,
    );
    return undefined;
  }

  /**
   * Return this identity's cache entry and promote it to the head of the MRU
   * list. Lookup is a linear scan of at most CENTER_PIXEL_CACHE_CAPACITY
   * entries; a caller reading one identity hits on the first comparison.
   */
  private _takeCenterPixelCacheEntry(
    identity: CenterPixelReadbackIdentity,
  ): CenterPixelCacheEntry | undefined {
    const entries = this._centerPixelCacheEntries;
    for (let i = 0; i < entries.length; ++i) {
      const entry = entries[i];
      if (!this._centerPixelIdentitiesEqual(entry, identity)) {
        continue;
      }
      if (i > 0) {
        entries.splice(i, 1);
        entries.unshift(entry);
      }
      return entry;
    }
    return undefined;
  }

  /**
   * Publish a decoded pixel into this identity's slot, replacing any prior
   * value for the same identity and evicting the least recently used entry once
   * the bound is exceeded.
   */
  private _publishCenterPixelCacheEntry(entry: CenterPixelCacheEntry): void {
    const entries = this._centerPixelCacheEntries;
    for (let i = 0; i < entries.length; ++i) {
      if (this._centerPixelIdentitiesEqual(entries[i], entry)) {
        entries.splice(i, 1);
        break;
      }
    }
    entries.unshift(entry);
    if (entries.length > CENTER_PIXEL_CACHE_CAPACITY) {
      entries.length = CENTER_PIXEL_CACHE_CAPACITY;
    }
  }

  private _centerPixelIdentitiesEqual(
    left: CenterPixelReadbackIdentity,
    right: CenterPixelReadbackIdentity,
  ): boolean {
    return (
      left.domain === right.domain &&
      left.queryIdentityA === right.queryIdentityA &&
      left.queryIdentityB === right.queryIdentityB &&
      left.queryIdentityC === right.queryIdentityC &&
      left.queryVersion === right.queryVersion &&
      left.viewProvenance === right.viewProvenance &&
      left.logicalOriginX === right.logicalOriginX &&
      left.logicalOriginTopY === right.logicalOriginTopY &&
      left.logicalWidth === right.logicalWidth &&
      left.logicalHeight === right.logicalHeight &&
      left.pixelX === right.pixelX &&
      left.pixelY === right.pixelY &&
      left.device === right.device &&
      left.resourceGeneration === right.resourceGeneration &&
      left.attachmentGeneration === right.attachmentGeneration &&
      left.colorTexture === right.colorTexture
    );
  }

  private _centerPixelIdentityIsCurrent(
    identity: CenterPixelReadbackIdentity,
  ): boolean {
    if (
      this._isDestroyed ||
      this._context._device !== identity.device ||
      this._device !== identity.device ||
      this._attachmentDevice !== identity.device ||
      getPickResourceGeneration(this._context) !==
        identity.resourceGeneration ||
      this._attachmentResourceGeneration !== identity.resourceGeneration ||
      this._attachmentGeneration !== identity.attachmentGeneration ||
      this._colorTexture !== identity.colorTexture
    ) {
      return false;
    }
    if (identity.domain !== "voxel") {
      return true;
    }
    const lifecycle = identity.queryIdentityB as
      | {
          atlasReuseEpoch?: unknown;
          detached?: boolean;
          device?: unknown;
          resourceGeneration?: unknown;
          contentRevision?: unknown;
        }
      | undefined;
    return (
      identity.queryIdentityA !== undefined &&
      lifecycle !== undefined &&
      lifecycle?.detached !== true &&
      lifecycle.device === identity.device &&
      lifecycle.resourceGeneration === identity.resourceGeneration &&
      lifecycle.atlasReuseEpoch === identity.queryVersion &&
      lifecycle.contentRevision === identity.queryIdentityC
    );
  }

  /**
   * True only while `requestSequence` is still the newest armed readback for
   * its own identity. A newer request for a DIFFERENT identity no longer
   * cancels this one — that global "latest wins" rule is what starved every
   * identity but the last-armed one.
   */
  private _isLatestCenterPixelRequest(
    identity: CenterPixelReadbackIdentity,
    requestSequence: number,
  ): boolean {
    const pending = this._centerPendingRequests;
    for (let i = 0; i < pending.length; ++i) {
      if (this._centerPixelIdentitiesEqual(pending[i].identity, identity)) {
        return pending[i].requestSequence === requestSequence;
      }
    }
    return false;
  }

  private _finishCenterPixelRequest(requestSequence: number): void {
    const pending = this._centerPendingRequests;
    for (let i = 0; i < pending.length; ++i) {
      if (pending[i].requestSequence === requestSequence) {
        pending.splice(i, 1);
        return;
      }
    }
  }

  /**
   * Asynchronously read a single RGBA8 pixel from `_colorTexture` at the
   * given texture coordinate, caching it for the next synchronous
   * readCenterPixel() call.
   *
   * Uses a fresh staging buffer per readback (destroyed after unmap), so
   * different typed queries may overlap safely. A monotonic sequence per
   * identity prevents an older completion from replacing a newer result.
   */
  private _readCenterPixelAsync(identity: CenterPixelReadbackIdentity): void {
    if (!this._centerPixelIdentityIsCurrent(identity)) {
      this._stats.recordCenterPixelDecline(
        "identity-not-current",
        this._updateCount,
      );
      return;
    }
    // Dedupe per identity, not globally: a readback already in flight for THIS
    // identity is the one that will publish, while an unrelated identity's
    // in-flight readback must not suppress this one.
    for (const pending of this._centerPendingRequests) {
      if (this._centerPixelIdentitiesEqual(pending.identity, identity)) {
        this._stats.recordCenterPixelDecline(
          "duplicate-in-flight",
          this._updateCount,
        );
        return;
      }
    }

    // Stamp with the CURRENT pick count — the pixel decoded below corresponds
    // to the metadata/voxel pass that rendered into `_colorTexture` this pick.
    const requestStamp = this._updateCount;
    const bgra = this._colorFormat === "bgra8unorm";
    const requestSequence = this._nextCenterReadbackSequence++;
    this._centerPendingRequests.push({ identity, requestSequence });
    if (this._centerPendingRequests.length > CENTER_PIXEL_PENDING_CAPACITY) {
      this._centerPendingRequests.shift();
    }
    const { device, colorTexture } = identity;

    let stagingBuffer: GPUBuffer | null = null;
    try {
      stagingBuffer = device.createBuffer({
        label: "Pick center-pixel staging buffer",
        size: CENTER_STAGING_BUFFER_SIZE,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });

      const encoder = device.createCommandEncoder({
        label: "Pick center-pixel readback",
      });
      encoder.copyTextureToBuffer(
        {
          texture: colorTexture,
          origin: [identity.pixelX, identity.pixelY, 0],
        },
        {
          buffer: stagingBuffer,
          bytesPerRow: CENTER_STAGING_BUFFER_SIZE,
          rowsPerImage: 1,
        },
        [1, 1],
      );
      device.queue.submit([encoder.finish()]);
      this._stats.recordCenterPixelArmed();

      const buffer = stagingBuffer;
      buffer
        .mapAsync(GPUMapMode.READ, 0, 4)
        .then(() => {
          try {
            if (
              !this._isLatestCenterPixelRequest(identity, requestSequence) ||
              !this._centerPixelIdentityIsCurrent(identity)
            ) {
              return;
            }
            const data = new Uint8Array(buffer.getMappedRange(0, 4));
            // Normalize to [R,G,B,A] regardless of the texture's byte order so
            // downstream decoders see the same layout as WebGL readPixels.
            const value = bgra
              ? new Uint8Array([data[2], data[1], data[0], data[3]])
              : new Uint8Array([data[0], data[1], data[2], data[3]]);
            this._publishCenterPixelCacheEntry({
              ...identity,
              value,
              stamp: requestStamp,
              requestSequence,
            });
            this._stats.recordCenterPixelPublished();
          } finally {
            try {
              buffer.unmap();
            } catch {
              // Teardown may destroy a mapped buffer before this callback.
            }
            buffer.destroy();
            this._finishCenterPixelRequest(requestSequence);
          }
        })
        .catch(() => {
          buffer.destroy();
          this._finishCenterPixelRequest(requestSequence);
        });
    } catch {
      if (stagingBuffer) {
        stagingBuffer.destroy();
      }
      this._finishCenterPixelRequest(requestSequence);
    }
  }

  /**
   * Return the persistent staging buffer used only by synchronous end(). The
   * allocation follows the requested copy extent, never the viewport extent.
   * A mapping-pending buffer cannot be replaced; the current sync request is
   * skipped and the next one retries after the previous map completes.
   */
  private _ensureSyncStagingBuffer(bufferSize: number): GPUBuffer | null {
    const device = this._device;
    if (!device || !(bufferSize > 0)) {
      this._stats.recordArmDecline(
        "staging-buffer-unavailable",
        this._updateCount,
      );
      return null;
    }
    if (
      this._stagingBuffer &&
      this._stagingBufferDevice === device &&
      this._stagingBufferSize === bufferSize
    ) {
      return this._stagingBuffer;
    }
    if (this._readbackInFlight) {
      // A guard of last resort rather than a routine path: the only caller now
      // reaches this method with the persistent slot free, routing overflow
      // requests to their own buffer instead. It stays because swapping a
      // mapping-pending buffer is unrecoverable, and a future second caller
      // must hit the guard rather than the corruption.
      this._stats.recordArmDecline(
        "staging-buffer-in-flight",
        this._updateCount,
      );
      return null;
    }

    // Allocate first so a device/OOM failure leaves the existing usable slot
    // intact rather than retaining a pointer to an already-destroyed buffer.
    const replacement = device.createBuffer({
      label: "Pick sync staging buffer",
      size: bufferSize,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const previous = this._stagingBuffer;
    this._stagingBuffer = replacement;
    this._stagingBufferSize = bufferSize;
    this._stagingBufferDevice = device;
    previous?.destroy();
    return replacement;
  }

  /**
   * Start an async readback without waiting for the result.
   * The result will be available in the next frame via _lastReadPixels.
   */
  private _startReadback(region: PickReadbackRegion): void {
    const device = this._device;
    const colorTexture = this._colorTexture;
    if (!device || !colorTexture) {
      this._stats.recordArmDecline(
        !device ? "no-device" : "no-attachment",
        this._updateCount,
      );
      return;
    }
    const requestSequence = this._nextReadbackSequence++;
    if (region.copyWidth === 0 || region.copyHeight === 0) {
      this._stats.recordReadbackArmed();
      this._publishReadbackCache(
        new Uint8Array(region.logicalWidth * region.logicalHeight * 4),
        region,
        requestSequence,
        device,
        colorTexture,
      );
      return;
    }

    const bytesPerRow = Math.ceil((region.copyWidth * 4) / 256) * 256;
    const bufferSize = bytesPerRow * region.copyHeight;
    // The persistent buffer cannot take a copy while its own map is pending,
    // and the request that arrives in that window is the warm-up pick for a
    // position the caller is about to ask about. Declining it left that
    // position unwarmed forever, so overflow requests get their own buffer —
    // bounded, then declining exactly as before.
    const transientBuffer = this._readbackInFlight
      ? this._transientReadbacks.acquire(device, bufferSize)
      : null;
    if (this._readbackInFlight && !transientBuffer) {
      this._stats.recordArmDecline("readback-in-flight", this._updateCount);
      return;
    }
    const stagingBuffer =
      transientBuffer ?? this._ensureSyncStagingBuffer(bufferSize);
    if (!stagingBuffer) {
      // _ensureSyncStagingBuffer already attributed the reason.
      return;
    }
    const frameContext = this._context as CesiumGraphicsContext & {
      currentCommandEncoder?: GPUCommandEncoder | null;
      enqueueAfterFrameSubmit?: (
        callback: (submitted: boolean) => void,
      ) => boolean;
    };
    const encoder = frameContext.currentCommandEncoder;
    if (
      !encoder ||
      typeof frameContext.enqueueAfterFrameSubmit !== "function"
    ) {
      if (transientBuffer) {
        this._transientReadbacks.release(transientBuffer);
      }
      this._stats.recordArmDecline("no-frame-encoder", this._updateCount);
      return;
    }

    encoder.copyTextureToBuffer(
      {
        texture: colorTexture,
        // Copy the clipped region using the top-down origin computed by begin().
        origin: [region.copyOriginX, region.copyOriginTopY, 0],
      },
      {
        buffer: stagingBuffer,
        bytesPerRow,
        rowsPerImage: region.copyHeight,
      },
      [region.copyWidth, region.copyHeight],
    );

    // The copy belongs to the SAME encoder as the pick draw. Starting a
    // private submit here would run before Picking.completePickFrame submits
    // that encoder, copying the previous pass's bytes and falsely labelling
    // them with this request's view provenance. Map only after endFrame has
    // submitted the draw+copy command buffer in-order.
    // Frees whichever slot this request took. The persistent buffer is freed
    // by clearing the in-flight flag; an overflow buffer is freed by returning
    // it to the pool, which destroys it.
    const retire = () => {
      if (transientBuffer) {
        this._transientReadbacks.release(transientBuffer);
      } else {
        this._readbackInFlight = false;
      }
    };
    const accepted = frameContext.enqueueAfterFrameSubmit((submitted) => {
      if (!submitted) {
        this._stats.recordArmDecline("frame-not-submitted", this._updateCount);
        retire();
        return;
      }

      // Fire-and-forget async mapping — result will be used by a later
      // synchronous pick. The destroyed guard catches the tab-close /
      // viewer-teardown race between mapAsync and resolution.
      stagingBuffer
        .mapAsync(GPUMapMode.READ)
        .then(() => {
          try {
            if (
              this._isDestroyed ||
              (!transientBuffer &&
                (this._stagingBuffer !== stagingBuffer ||
                  this._stagingBufferDevice !== device)) ||
              this._device !== device ||
              this._colorTexture !== colorTexture
            ) {
              // The attachment/device generation changed while the copy was
              // in flight. Its bytes cannot warm the replacement target.
              return;
            }

            const mappedData = new Uint8Array(stagingBuffer.getMappedRange());
            const pixels = unpackPickPixels(mappedData, bytesPerRow, region);
            this._publishReadbackCache(
              pixels,
              region,
              requestSequence,
              device,
              colorTexture,
            );
          } finally {
            try {
              stagingBuffer.unmap();
            } catch {
              // A destroyed buffer cannot be unmapped; teardown already owns it.
            }
            retire();
          }
        })
        .catch(() => {
          // A map or unpack failure is non-authoritative for synchronous pick.
          // The `then` finally above already unmapped when mapping succeeded.
          retire();
        });
    });
    if (!transientBuffer) {
      this._readbackInFlight = accepted;
    } else if (!accepted) {
      this._transientReadbacks.release(transientBuffer);
    }
    if (accepted) {
      this._stats.recordReadbackArmed();
    } else {
      // The copy was encoded into the frame encoder but nothing will map it,
      // so no publish can follow. Counted as a decline, never as an arm.
      this._stats.recordArmDecline("frame-submit-rejected", this._updateCount);
    }
  }

  /**
   * Asynchronously read a single depth value from the pick framebuffer.
   * Uses the depth32float readable depth texture (not depth24plus-stencil8).
   *
   * @param x The x pixel coordinate.
   * @param y The y pixel coordinate.
   * @returns The depth value (0.0–1.0), or undefined if readback fails.
   */
  async readDepthPixelAsync(x: number, y: number): Promise<number | undefined> {
    const device = this._device;
    if (!device || !this._readableDepthTexture) {
      return undefined;
    }

    if (x < 0 || x >= this._width || y < 0 || y >= this._height) {
      return undefined;
    }

    // depth32float is 4 bytes per pixel; row must be 256-byte aligned
    const bytesPerPixel = 4;
    const bytesPerRow = 256; // minimum for a single-pixel copy
    const bufferSize = bytesPerRow;

    // Create or reuse depth staging buffer
    if (
      !this._depthStagingBuffer ||
      this._depthStagingBufferDevice !== device
    ) {
      this._depthStagingBuffer?.destroy();
      this._depthStagingBuffer = device.createBuffer({
        label: "Pick depth staging buffer",
        size: bufferSize,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      this._depthStagingBufferDevice = device;
    }

    const encoder = device.createCommandEncoder({
      label: "Pick depth readback encoder",
    });

    encoder.copyTextureToBuffer(
      {
        texture: this._readableDepthTexture,
        origin: [x, y, 0],
      },
      {
        buffer: this._depthStagingBuffer,
        bytesPerRow,
      },
      [1, 1],
    );

    device.queue.submit([encoder.finish()]);

    try {
      const depthStaging = this._depthStagingBuffer;
      await depthStaging.mapAsync(GPUMapMode.READ);
      if (this._isDestroyed || this._depthStagingBuffer !== depthStaging) {
        return undefined;
      }
      const mapped = new Float32Array(
        depthStaging.getMappedRange(0, bytesPerPixel),
      );
      const depth = mapped[0];
      depthStaging.unmap();
      return depth;
    } catch {
      // Buffer may already be mapped or destroyed
      return undefined;
    }
  }

  /**
   * Get the readable depth texture view for a dedicated copyable-depth pass.
   * WebGPU permits only one depth/stencil attachment per render pass, so a
   * consumer must populate this in its own pass before requesting readback.
   */
  get readableDepthView(): GPUTextureView | null {
    const device = this._device;
    if (
      !device ||
      device !== this._attachmentDevice ||
      this._width <= 0 ||
      this._height <= 0
    ) {
      return null;
    }
    if (!this._readableDepthTexture) {
      // This compatibility facility is intentionally on demand. The regular
      // ID pick pass uses depth24plus-stencil8 and never populates readable
      // depth, so eagerly allocating another full-viewport depth texture paid
      // substantial memory for every picker without making the API useful.
      // A depth consumer can request this view, attach it in its own pass, and
      // then use readDepthPixelAsync without burdening ordinary object picks.
      this._readableDepthTexture = device.createTexture({
        label: "Pick readable depth texture (depth32float)",
        size: [this._width, this._height],
        format: "depth32float",
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      });
      this._readableDepthView = this._readableDepthTexture.createView();
    }
    return this._readableDepthView;
  }

  private readonly _ensureClassificationDepthTarget = (): {
    texture: GPUTexture;
    view: GPUTextureView;
  } | null => {
    const device = this._device;
    if (
      !device ||
      device !== this._attachmentDevice ||
      this._width <= 0 ||
      this._height <= 0
    ) {
      return null;
    }
    if (!this._classificationDepthTexture) {
      this._classificationDepthTexture = device.createTexture({
        label: "Pick packed classification depth texture",
        size: [this._width, this._height],
        format: "rgba8unorm",
        usage:
          GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
      this._classificationDepthView =
        this._classificationDepthTexture.createView();
    }
    return {
      texture: this._classificationDepthTexture,
      view: this._classificationDepthView!,
    };
  };

  /**
   * The unified, source-agnostic per-fragment feature-ID texture — the pick
   * pass's color target, into which every source rasterizes its 24-bit
   * object/feature ID. `null` until the first `begin()` allocates it.
   *
   * Exposes the texture so post-process consumers can sample cross-source
   * feature IDs inside a shader without a CPU readback.
   */
  get featureIdTexture(): GPUTexture | null {
    return this._colorTexture;
  }

  /** Memory format of {@link featureIdTexture} (`rgba8unorm` / `bgra8unorm`). */
  get featureIdFormat(): GPUTextureFormat {
    return this._colorFormat;
  }

  /**
   * Resolve the unified feature-ID G-buffer
   * inside a fullscreen post-process pass and read the recolored result back.
   *
   * The most recent pick render (`scene.pick` / `scene.pickAsync`) must have
   * populated `_colorTexture`; this samples that shared, source-agnostic ID
   * target on the GPU, decodes each 24-bit key, and hashes it to a distinct
   * color. Each distinct ID yields a distinct color, so fragments from DIFFERENT
   * sources remain distinguishable for downstream cross-source attribute joins.
   *
   * Default-OFF: constructs the helper lazily, so this is a no-op cost until an
   * app/probe calls it. Returns `null` if no pick target exists yet.
   */
  async resolveFeatureIdRecolorAsync(): Promise<FeatureIdResolveResult | null> {
    const device = this._device;
    if (!device || !this._colorTexture || this._isDestroyed) {
      return null;
    }
    if (!this._featureIdTexture) {
      this._featureIdTexture = new WebGPUFeatureIdTexture(device);
    }
    return this._featureIdTexture.resolveAsync(
      this._colorTexture,
      this._width,
      this._height,
    );
  }

  /**
   * Record the feature-ID recolor pass into a caller-provided per-frame command
   * encoder, sampling the unified pick-ID G-buffer and writing the recolor into
   * the helper's persistent output texture. Unlike
   * {@link resolveFeatureIdRecolorAsync} this performs NO separate submit and NO
   * CPU readback — the recolor lives inside the caller's own command stream and
   * its result view ({@link featureIdRecolorView}) is immediately sample-able by a
   * downstream same-frame post-process stage, cross-source attribute join, or
   * feature-ID debug overlay.
   *
   * The most recent pick render (`scene.pick` / `scene.pickAsync`) must have
   * populated `_colorTexture`. Default-OFF: the helper is still lazily constructed,
   * so untouched scenes never allocate it and the standing pass is never recorded
   * unless a consumer explicitly calls this.
   *
   * @param encoder - The per-frame command encoder to record into (not submitted here).
   * @returns The persistent recolor output view, or `null` if no pick target exists yet.
   */
  recordFeatureIdResolve(encoder: GPUCommandEncoder): GPUTextureView | null {
    const device = this._device;
    if (!device || !this._colorTexture || this._isDestroyed) {
      return null;
    }
    if (!this._featureIdTexture) {
      this._featureIdTexture = new WebGPUFeatureIdTexture(device);
    }
    return this._featureIdTexture.record(
      encoder,
      this._colorTexture,
      this._width,
      this._height,
    );
  }

  /**
   * The persistent feature-ID recolor output texture written by
   * {@link recordFeatureIdResolve} / {@link resolveFeatureIdRecolorAsync}, or
   * `null` if the resolve helper has never been constructed (default-OFF state).
   */
  get featureIdRecolorTexture(): GPUTexture | null {
    return this._featureIdTexture?.outputTexture ?? null;
  }

  /** Sample-able view over {@link featureIdRecolorTexture}, or `null` when off. */
  get featureIdRecolorView(): GPUTextureView | null {
    return this._featureIdTexture?.outputView ?? null;
  }

  private _invalidateCenterPixelReadback(): void {
    this._centerPixelCacheEntries.length = 0;
    this._centerPendingRequests.length = 0;
    // Advance past every sequence an outstanding completion may have
    // captured. Older completions then fail the per-identity latest-request
    // check without touching state belonging to a replacement attachment.
    this._nextCenterReadbackSequence++;
  }

  private _destroyTextures(): void {
    this._invalidateCenterPixelReadback();
    if (this._colorTexture) {
      this._colorTexture.destroy();
      this._colorTexture = null;
    }
    if (this._depthTexture) {
      this._depthTexture.destroy();
      this._depthTexture = null;
    }
    if (this._readableDepthTexture) {
      this._readableDepthTexture.destroy();
      this._readableDepthTexture = null;
    }
    if (this._classificationDepthTexture) {
      this._classificationDepthTexture.destroy();
      this._classificationDepthTexture = null;
    }
    if (this._classificationDepthPlaceholderTexture) {
      this._classificationDepthPlaceholderTexture.destroy();
      this._classificationDepthPlaceholderTexture = null;
    }
    this._readableDepthView = null;
    this._classificationDepthView = null;
    this._classificationDepthPlaceholderView = null;
    this._attachmentDevice = null;
    this._attachmentResourceGeneration = -1;
    this._colorView = null;
    this._depthView = null;
    // Cached bytes belong to the destroyed color target/format and cannot be
    // decoded as the first result of the replacement target.
    this._lastReadPixels = null;
    this._lastReadRegion = null;
  }

  /**
   * Snapshot of the pick instrumentation counters. Surfaced through
   * `CesiumDebug.pick()` and intended for `Scene#getDebugSnapshot`.
   *
   * Reading is free of side effects and safe at any time; the returned record
   * is a copy, so two snapshots can be diffed across an interaction.
   */
  getStatistics(): PickFramebufferStatistics {
    return this._stats.getStatistics();
  }

  /**
   * Zero the pick counters. A probe calls this immediately before the
   * interaction it wants to measure so an earlier warm-up cannot be mistaken
   * for the measurement.
   */
  resetStatistics(): void {
    this._stats.reset();
  }

  isDestroyed(): boolean {
    return this._isDestroyed;
  }

  destroy(): void {
    this._isDestroyed = true;
    this._destroyTextures();
    const pickDepthContext = this._context as CesiumGraphicsContext & {
      _pickClassificationDepthView?: GPUTextureView | null;
    };
    pickDepthContext._pickClassificationDepthView = null;
    if (this._stagingBuffer) {
      this._stagingBuffer.destroy();
      this._stagingBuffer = null;
    }
    this._stagingBufferSize = 0;
    this._stagingBufferDevice = null;
    this._readbackInFlight = false;
    if (this._depthStagingBuffer) {
      this._depthStagingBuffer.destroy();
      this._depthStagingBuffer = null;
    }
    this._depthStagingBufferDevice = null;
    this._lastReadPixels = null;
    this._lastReadRegion = null;
    // Release the resolve helper's output
    // texture + pipeline if one was ever constructed.
    if (this._featureIdTexture) {
      this._featureIdTexture.destroy();
      this._featureIdTexture = null;
    }
  }
}

export default WebGPUPickFramebuffer;
