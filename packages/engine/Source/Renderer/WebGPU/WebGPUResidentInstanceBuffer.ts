/**
 * @module WebGPUResidentInstanceBuffer
 *
 * Resident-instance partial-write manager for the WebGPU collection
 * renderers (Phase 1 of the Large Dynamic Objects roadmap —
 * NEW-RESIDENT-INSTANCE-BUFFER-MGR + NEW-PARTIAL-WRITE-COALESCING).
 *
 * Keeps a resident CPU `Float32Array` of packed per-instance data plus a
 * GPU vertex buffer between frames, so:
 *   - a STATIC collection uploads NOTHING per frame, and
 *   - a sparse change re-packs + uploads ONLY the changed instances'
 *     byte ranges (O(changed), not O(N)).
 *
 * The load-bearing invariant is the slot map: the GPU slot is the running
 * COMPACTED visible order (over `show` + `_clusterShow`), NOT the
 * primitive's dense `_index`. Hidden primitives get no slot. Any event
 * that can shift downstream slots — add / remove / show-toggle /
 * clusterShow change / length change — must force a FULL rebuild (whole
 * CPU re-pack + one writeBuffer + slot-map recompute). Only a property
 * edit on an already-visible instance whose slot is unchanged takes the
 * partial path. Getting this predicate wrong is exactly how the Batch 226
 * all-or-nothing gate shipped stale renders (see DEFERRED_WORK
 * NEW-COLLECTIONS-DIRTY-GATE).
 *
 * Velocity prev-mirror (TAA motion vectors): when `mirrorPrev` is set the
 * manager maintains a second GPU buffer holding LAST frame's data at the
 * SAME slots. On partial writes the prev slot is mirrored before the
 * current slot is overwritten, and slots written at frame N are caught up
 * at frame N+1 (so a one-frame move produces exactly one frame of
 * non-zero velocity, then settles). On full rebuilds prev = current
 * (zero velocity for the rebuild frame — slots may have shifted, so
 * mapping old slots forward would be wrong).
 *
 * What's shipped in this batch: the manager + billboard wiring
 * (NEW-PARTIAL-WRITE-WIRE-BPL, billboard half). Point + Label wiring is
 * the P1-T5 follow-up; folding into NEW-COLLECTION-RENDERER-BASE is
 * P1-T6.
 *
 * @private
 */

/// <reference types="@webgpu/types" />

import WebGPUBuffer from "./WebGPUBuffer.js";

/**
 * Minimal shape the manager needs from a collection primitive: the dense
 * array index (`Billboard._index` / `PointPrimitive._index` semantics —
 * reassigned only on collection compaction, which always arrives with a
 * forced full rebuild).
 */
export interface ResidentInstanceItem {
  _index: number;
}

/**
 * Per-frame sync inputs. `dirtyList[0..dirtyCount)` is the collection's
 * per-frame dirty list (e.g. `_billboardsToUpdate` /
 * `_billboardsToUpdateIndex`) and MUST be captured BEFORE the caller
 * consumes the collection's dirty state (`_consumeDirtyState`).
 */
export interface ResidentInstanceSyncOptions<T extends ResidentInstanceItem> {
  /** Dense primitive array (may contain holes pending compaction). */
  items: ArrayLike<T | undefined>;
  /** Collection length (`items.length` domain the slot map covers). */
  length: number;
  /** Per-frame dirty list; only `[0..dirtyCount)` is read. */
  dirtyList: ArrayLike<T | undefined>;
  /** Number of valid entries in `dirtyList`. */
  dirtyCount: number;
  /** Packs ONE instance at `floatOffset` floats into `out`. */
  packInstance: (out: Float32Array, floatOffset: number, item: T) => void;
  /** Visibility predicate (slot-presence rule). Must treat holes as hidden. */
  isVisible: (item: T | undefined) => item is T;
  floatsPerInstance: number;
  bytesPerInstance: number;
  /**
   * Caller-detected structural invalidation: `_createVertexArray`,
   * defines change, scene-mode change, atlas rotation, MORPHING, etc.
   */
  forceFullRebuild?: boolean;
  /** Maintain the slot-aligned prev buffer for velocity/TAA this frame. */
  mirrorPrev?: boolean;
}

export interface ResidentInstanceSyncResult {
  /** GPU vertex buffer with packed visible instances (null only when never built). */
  buffer: WebGPUBuffer | null;
  /** Slot-aligned previous-frame mirror; null unless `mirrorPrev` was set. */
  prevBuffer: WebGPUBuffer | null;
  /** Compacted visible-instance count (the instanced-draw instanceCount). */
  visibleCount: number;
  /** True when this sync took the full-rebuild path. */
  fullRebuild: boolean;
  /** Number of writeBuffer range calls issued on the partial path. */
  partialWrites: number;
}

// Merge dirty-slot ranges separated by at most this many untouched slots —
// one slightly-larger writeBuffer beats several queue submissions.
const COALESCE_MAX_GAP_SLOTS = 4;
// When more than this fraction of visible instances changed, a single
// whole-buffer write is cheaper than many ranged writes.
const WHOLE_BUFFER_FALLBACK_FRACTION = 0.4;

/**
 * Resident CPU instance array + GPU vertex buffer + stable _index→slot
 * map with a full-vs-partial sync predicate. One instance per
 * (collection, stream) — e.g. the billboard color instance stream.
 */
export class WebGPUResidentInstanceBuffer<T extends ResidentInstanceItem> {
  private _device: GPUDevice;
  private _label: string;

  private _cpu: Float32Array | null = null;
  private _buffer: WebGPUBuffer | null = null;
  private _prevBuffer: WebGPUBuffer | null = null;
  /** Slot per dense index; -1 = hidden (no slot). */
  private _slotByIndex: Int32Array | null = null;

  private _lastLength: number = -1;
  private _lastVisibleCount: number = 0;
  private _lastFloatsPerInstance: number = 0;
  /**
   * Whether `_prevBuffer` currently holds slot-aligned frame N-1 data.
   * Goes false whenever a frame syncs without `mirrorPrev` (TAA off) —
   * re-enabling does a full prev refresh instead of trusting stale data.
   */
  private _prevValid: boolean = false;
  /**
   * Slot ranges (flat [start0,end0,start1,end1,...]) written to the
   * CURRENT buffer last frame; the prev mirror must catch these up next
   * frame (their prev value becomes last frame's current value).
   */
  private _pendingPrevSlotRanges: number[] = [];

  // Debug-pragma instrumentation (probe-visible; stripped from release
  // builds, fields stay 0). Cumulative across the manager's lifetime.
  _fullRebuilds: number = 0;
  _partialWrites: number = 0;
  _prevMirrorWrites: number = 0;
  _bytesUploaded: number = 0;

  constructor(device: GPUDevice, label: string) {
    this._device = device;
    this._label = label;
  }

  get buffer(): WebGPUBuffer | null {
    return this._buffer;
  }

  get prevBuffer(): WebGPUBuffer | null {
    return this._prevBuffer;
  }

  get lastVisibleCount(): number {
    return this._lastVisibleCount;
  }

  /**
   * Per-frame entry point. Decides full-vs-partial, re-packs what
   * changed, and uploads the minimal byte ranges.
   */
  sync(options: ResidentInstanceSyncOptions<T>): ResidentInstanceSyncResult {
    if (this._needsFullRebuild(options)) {
      return this._syncFull(options);
    }
    return this._syncPartial(options);
  }

  /**
   * The full-vs-partial predicate. Anything that can shift a slot — or
   * that the caller flagged as structurally invalidating — forces full.
   */
  private _needsFullRebuild(options: ResidentInstanceSyncOptions<T>): boolean {
    if (options.forceFullRebuild === true) {
      return true;
    }
    if (
      this._cpu === null ||
      this._buffer === null ||
      this._slotByIndex === null
    ) {
      return true; // first build
    }
    if (
      options.length !== this._lastLength ||
      options.floatsPerInstance !== this._lastFloatsPerInstance ||
      options.length * options.floatsPerInstance > this._cpu.length
    ) {
      return true; // add/remove/removeAll or layout change
    }
    // Show / clusterShow compaction drift: any dirty item whose current
    // visibility disagrees with its slot-presence shifts every downstream
    // slot. (Visibility changes always arrive via the dirty list — the
    // `show` / `clusterShow` setters call makeDirty.)
    const dirtyList = options.dirtyList;
    const dirtyCount = options.dirtyCount;
    const isVisible = options.isVisible;
    const slotByIndex = this._slotByIndex;
    for (let i = 0; i < dirtyCount; i++) {
      const item = dirtyList[i];
      const index = item !== undefined ? item._index : -1;
      if (index < 0 || index >= this._lastLength) {
        return true; // defensive: stale/foreign dirty entry
      }
      const hasSlot = slotByIndex[index] >= 0;
      if (isVisible(item) !== hasSlot) {
        return true;
      }
    }
    return false;
  }

  private _syncFull(
    options: ResidentInstanceSyncOptions<T>,
  ): ResidentInstanceSyncResult {
    const items = options.items;
    const length = options.length;
    const floatsPerInstance = options.floatsPerInstance;
    const bytesPerInstance = options.bytesPerInstance;
    const packInstance = options.packInstance;
    const isVisible = options.isVisible;

    const capacityFloats = length * floatsPerInstance;
    if (this._cpu === null || this._cpu.length < capacityFloats) {
      this._cpu = new Float32Array(capacityFloats);
    }
    if (this._slotByIndex === null || this._slotByIndex.length < length) {
      this._slotByIndex = new Int32Array(length);
    }
    const cpu = this._cpu;
    const slotByIndex = this._slotByIndex;

    let visibleCount = 0;
    for (let i = 0; i < length; i++) {
      const item = items[i];
      if (!isVisible(item)) {
        slotByIndex[i] = -1;
        continue;
      }
      slotByIndex[i] = visibleCount;
      packInstance(cpu, visibleCount * floatsPerInstance, item);
      visibleCount++;
    }

    // Capacity is sized by LENGTH (not visibleCount) so a later
    // show-toggle full rebuild that raises visibleCount never reallocs.
    const capacityBytes = Math.max(length * bytesPerInstance, 4);
    if (this._buffer === null || this._buffer.size < capacityBytes) {
      if (this._buffer !== null) {
        this._buffer.destroy();
      }
      this._buffer = WebGPUBuffer.createVertexBuffer(
        this._device,
        capacityBytes,
        false,
        this._label,
      );
    }

    const payloadFloats = visibleCount * floatsPerInstance;
    if (payloadFloats > 0) {
      this._buffer.write(cpu.subarray(0, payloadFloats), 0);
    }

    //>>includeStart('debug', pragmas.debug);
    this._fullRebuilds++;
    this._bytesUploaded += visibleCount * bytesPerInstance;
    //>>includeEnd('debug');

    // Prev mirror: slots may have shifted, so mapping old data forward is
    // wrong — prev = current (zero velocity on the rebuild frame; "born
    // this frame" semantics for new slots).
    this._pendingPrevSlotRanges.length = 0;
    if (options.mirrorPrev === true) {
      this._ensurePrevBuffer(capacityBytes);
      if (payloadFloats > 0) {
        (this._prevBuffer as WebGPUBuffer).write(
          cpu.subarray(0, payloadFloats),
          0,
        );
        //>>includeStart('debug', pragmas.debug);
        this._prevMirrorWrites++;
        //>>includeEnd('debug');
      }
      this._prevValid = true;
    } else {
      this._prevValid = false;
    }

    this._lastLength = length;
    this._lastVisibleCount = visibleCount;
    this._lastFloatsPerInstance = floatsPerInstance;

    return {
      buffer: this._buffer,
      prevBuffer: options.mirrorPrev === true ? this._prevBuffer : null,
      visibleCount: visibleCount,
      fullRebuild: true,
      partialWrites: 0,
    };
  }

  private _syncPartial(
    options: ResidentInstanceSyncOptions<T>,
  ): ResidentInstanceSyncResult {
    const floatsPerInstance = options.floatsPerInstance;
    const bytesPerInstance = options.bytesPerInstance;
    const cpu = this._cpu as Float32Array;
    const buffer = this._buffer as WebGPUBuffer;
    const slotByIndex = this._slotByIndex as Int32Array;
    const visibleCount = this._lastVisibleCount;

    // Collect (slot, item) pairs for dirty entries that own a slot. A
    // dirty entry with no slot is hidden-and-stays-hidden (a visibility
    // CHANGE would have forced a full rebuild) — nothing to upload.
    const dirtySlots: number[] = [];
    const dirtyItems: T[] = [];
    const dirtyList = options.dirtyList;
    const dirtyCount = options.dirtyCount;
    for (let i = 0; i < dirtyCount; i++) {
      const item = dirtyList[i];
      if (item === undefined) {
        continue;
      }
      const slot = slotByIndex[item._index];
      if (slot < 0) {
        continue;
      }
      dirtySlots.push(slot);
      dirtyItems.push(item);
    }

    // Coalesce → contiguous slot ranges; whole-buffer fallback when the
    // changed fraction is large enough that ranged writes lose.
    let ranges: number[];
    if (dirtySlots.length === 0) {
      ranges = [];
    } else if (
      dirtySlots.length >
      WHOLE_BUFFER_FALLBACK_FRACTION * visibleCount
    ) {
      ranges = [0, visibleCount];
    } else {
      ranges = coalesceSlots(dirtySlots, COALESCE_MAX_GAP_SLOTS);
    }

    // Prev-mirror maintenance — BEFORE re-packing, while the CPU array
    // still holds frame N-1 values:
    //   1. catch up slots written last frame (their prev becomes last
    //      frame's value), and
    //   2. snapshot this frame's dirty slots (their prev is the
    //      about-to-be-overwritten value).
    if (options.mirrorPrev === true) {
      if (this._prevBuffer === null || !this._prevValid) {
        // TAA just (re-)enabled — refresh the whole mirror from the
        // resident array: prev = current, zero velocity for one frame.
        this._ensurePrevBuffer(buffer.size);
        const payloadFloats = visibleCount * floatsPerInstance;
        if (payloadFloats > 0) {
          (this._prevBuffer as WebGPUBuffer).write(
            cpu.subarray(0, payloadFloats),
            0,
          );
          //>>includeStart('debug', pragmas.debug);
          this._prevMirrorWrites++;
          //>>includeEnd('debug');
        }
        this._prevValid = true;
        this._pendingPrevSlotRanges.length = 0;
      } else {
        this._writeRangesTo(
          this._prevBuffer,
          this._pendingPrevSlotRanges,
          floatsPerInstance,
          bytesPerInstance,
        );
        this._writeRangesTo(
          this._prevBuffer,
          ranges,
          floatsPerInstance,
          bytesPerInstance,
        );
      }
      this._pendingPrevSlotRanges = ranges.slice();
    } else {
      this._prevValid = false;
      this._pendingPrevSlotRanges.length = 0;
    }

    // Re-pack changed slots into the resident array, then upload the
    // coalesced ranges.
    const packInstance = options.packInstance;
    for (let i = 0; i < dirtyItems.length; i++) {
      packInstance(cpu, dirtySlots[i] * floatsPerInstance, dirtyItems[i]);
    }

    let partialWrites = 0;
    for (let r = 0; r < ranges.length; r += 2) {
      const start = ranges[r];
      const end = ranges[r + 1];
      buffer.write(
        cpu.subarray(start * floatsPerInstance, end * floatsPerInstance),
        start * bytesPerInstance,
      );
      partialWrites++;
      //>>includeStart('debug', pragmas.debug);
      this._bytesUploaded += (end - start) * bytesPerInstance;
      //>>includeEnd('debug');
    }
    //>>includeStart('debug', pragmas.debug);
    this._partialWrites += partialWrites;
    //>>includeEnd('debug');

    return {
      buffer: buffer,
      prevBuffer: options.mirrorPrev === true ? this._prevBuffer : null,
      visibleCount: visibleCount,
      fullRebuild: false,
      partialWrites: partialWrites,
    };
  }

  /** Allocate/grow the prev mirror to match the current buffer capacity. */
  private _ensurePrevBuffer(capacityBytes: number): void {
    if (this._prevBuffer !== null && this._prevBuffer.size >= capacityBytes) {
      return;
    }
    if (this._prevBuffer !== null) {
      this._prevBuffer.destroy();
    }
    this._prevBuffer = WebGPUBuffer.createVertexBuffer(
      this._device,
      capacityBytes,
      false,
      `${this._label} (prev mirror)`,
    );
    this._prevValid = false;
  }

  /** Copy the given slot ranges from the resident CPU array to `target`. */
  private _writeRangesTo(
    target: WebGPUBuffer,
    ranges: number[],
    floatsPerInstance: number,
    bytesPerInstance: number,
  ): void {
    const cpu = this._cpu as Float32Array;
    for (let r = 0; r < ranges.length; r += 2) {
      const start = ranges[r];
      const end = ranges[r + 1];
      target.write(
        cpu.subarray(start * floatsPerInstance, end * floatsPerInstance),
        start * bytesPerInstance,
      );
      //>>includeStart('debug', pragmas.debug);
      this._prevMirrorWrites++;
      //>>includeEnd('debug');
    }
  }

  destroy(): void {
    if (this._buffer !== null) {
      this._buffer.destroy();
      this._buffer = null;
    }
    if (this._prevBuffer !== null) {
      this._prevBuffer.destroy();
      this._prevBuffer = null;
    }
    this._cpu = null;
    this._slotByIndex = null;
    this._pendingPrevSlotRanges.length = 0;
    this._lastLength = -1;
    this._lastVisibleCount = 0;
    this._prevValid = false;
  }
}

/**
 * Sort + dedupe dirty slots and merge runs separated by at most `maxGap`
 * untouched slots into flat [start,end) range pairs.
 */
function coalesceSlots(slots: number[], maxGap: number): number[] {
  slots.sort((a, b) => a - b);
  const ranges: number[] = [];
  let start = slots[0];
  let end = slots[0] + 1;
  for (let i = 1; i < slots.length; i++) {
    const s = slots[i];
    if (s < end) {
      continue; // duplicate
    }
    if (s - end <= maxGap) {
      end = s + 1;
      continue;
    }
    ranges.push(start, end);
    start = s;
    end = s + 1;
  }
  ranges.push(start, end);
  return ranges;
}

export default WebGPUResidentInstanceBuffer;
