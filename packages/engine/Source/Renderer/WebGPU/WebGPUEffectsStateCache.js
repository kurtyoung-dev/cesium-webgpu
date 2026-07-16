import defined from "../../Core/defined.js";

/**
 * Bounded cache for effects bindings whose GPU resource tuple is stable while
 * uniform bytes change with the camera/view. A group owns only as many slots
 * as it needs distinct byte variants in one frame. Across frames, old slots
 * are rewritten instead of minting camera-position keys.
 *
 * @private
 */
class WebGPUEffectsStateCache {
  constructor(options) {
    options = options ?? {};
    this._groups = new Map();
    this._maxGroups = options.maxGroups ?? 256;
    this._clock = 0;
    this._hits = 0;
    this._misses = 0;
    this._bufferWrites = 0;
    this._skippedWrites = 0;
    this._evictions = 0;
    this._lastPruneFrame = -1;
  }

  /**
   * Acquire a slot for one stable owner/resource group and exact uniform
   * payload. Repeated identical calls in a frame share the same slot; changed
   * payloads reuse a slot not referenced by the current frame.
   *
   * @param {string} groupKey
   * @param {Uint32Array} uniformBits
   * @param {number} frameNumber
   * @param {Function} createSlot
   * @param {Function} writeSlot
   * @param {Function} retireSlots
   * @returns {object}
   */
  acquire(
    groupKey,
    uniformBits,
    frameNumber,
    createSlot,
    writeSlot,
    retireSlots,
  ) {
    let group = this._groups.get(groupKey);
    if (!defined(group)) {
      group = { slots: [], lastUsed: 0 };
      this._groups.set(groupKey, group);
    }

    const clock = ++this._clock;
    group.lastUsed = clock;

    let slot;
    for (let i = 0; i < group.slots.length; i++) {
      const candidate = group.slots[i];
      if (bitsEqual(candidate.uniformBits, uniformBits)) {
        slot = candidate;
        break;
      }
    }

    if (defined(slot)) {
      this._hits++;
      this._skippedWrites++;
    } else {
      for (let i = 0; i < group.slots.length; i++) {
        const candidate = group.slots[i];
        if (candidate.lastUsedFrame !== frameNumber) {
          slot = candidate;
          break;
        }
      }

      if (!defined(slot)) {
        slot = {
          resource: createSlot(),
          uniformBits: new Uint32Array(uniformBits.length),
          lastUsedFrame: -1,
          lastUsed: 0,
        };
        group.slots.push(slot);
        this._misses++;
      } else {
        this._hits++;
      }

      writeSlot(slot.resource, uniformBits);
      slot.uniformBits.set(uniformBits);
      this._bufferWrites++;
    }

    slot.lastUsedFrame = frameNumber;
    slot.lastUsed = clock;
    if (
      this._groups.size > this._maxGroups &&
      this._lastPruneFrame !== frameNumber
    ) {
      this._lastPruneFrame = frameNumber;
      this._prune(frameNumber, retireSlots);
    }
    return slot.resource;
  }

  _prune(frameNumber, retireSlots) {
    if (this._groups.size <= this._maxGroups) {
      return;
    }

    const candidates = [];
    for (const [key, group] of this._groups) {
      let recentlyUsed = false;
      for (let i = 0; i < group.slots.length; i++) {
        // Keep the current and immediately preceding frame resident. Besides
        // avoiding active-working-set thrash, this guarantees retirement is
        // only requested for buffers whose last encoder has already submitted.
        if (group.slots[i].lastUsedFrame >= frameNumber - 1) {
          recentlyUsed = true;
          break;
        }
      }
      if (!recentlyUsed) {
        candidates.push({ key, group });
      }
    }
    candidates.sort(
      (left, right) => left.group.lastUsed - right.group.lastUsed,
    );

    const retired = [];
    for (
      let i = 0;
      i < candidates.length && this._groups.size > this._maxGroups;
      i++
    ) {
      const candidate = candidates[i];
      if (!this._groups.delete(candidate.key)) {
        continue;
      }
      for (let j = 0; j < candidate.group.slots.length; j++) {
        retired.push(candidate.group.slots[j].resource);
      }
      this._evictions++;
    }

    if (retired.length > 0) {
      retireSlots(retired);
    }
  }

  /**
   * Removes every cached slot. The caller owns the retirement policy; final
   * device teardown can destroy immediately, while live-device eviction may
   * defer destruction behind its shared submission fence.
   *
   * @param {Function} retireSlots
   */
  drain(retireSlots) {
    const retired = [];
    for (const group of this._groups.values()) {
      for (let i = 0; i < group.slots.length; i++) {
        retired.push(group.slots[i].resource);
      }
    }
    this._groups.clear();
    if (retired.length > 0) {
      retireSlots(retired);
    }
  }

  getDiagnostics(bytesPerSlot) {
    let slotCount = 0;
    for (const group of this._groups.values()) {
      slotCount += group.slots.length;
    }
    return Object.freeze({
      groupCount: this._groups.size,
      slotCount,
      liveBytes: slotCount * bytesPerSlot,
      hits: this._hits,
      misses: this._misses,
      bufferWrites: this._bufferWrites,
      skippedWrites: this._skippedWrites,
      evictions: this._evictions,
      maxGroups: this._maxGroups,
    });
  }
}

function bitsEqual(left, right) {
  if (!defined(left) || left.length !== right.length) {
    return false;
  }
  for (let i = 0; i < right.length; i++) {
    if (left[i] !== right[i]) {
      return false;
    }
  }
  return true;
}

export { bitsEqual };
export default WebGPUEffectsStateCache;
