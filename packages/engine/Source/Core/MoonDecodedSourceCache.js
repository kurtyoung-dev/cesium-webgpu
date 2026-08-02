import Resource from "./Resource.js";
import Request from "./Request.js";

/**
 * Default decoded Moon source entry budget. Active leases and pending loads
 * are always pinned, so a scene can temporarily exceed this limit without
 * losing a source that is in use.
 *
 * @private
 */
const DEFAULT_MOON_DECODED_SOURCE_MAX_ENTRIES = 4;

/**
 * Default decoded-byte budget for Moon sources (32 MiB). Active sources can
 * temporarily exceed it. The estimate is deliberately based on decoded RGBA
 * pixels rather than compressed network bytes, because the decoded backing
 * store is what remains resident.
 *
 * @private
 */
const DEFAULT_MOON_DECODED_SOURCE_MAX_BYTES = 32 * 1024 * 1024;

const DEFAULT_DECODE_OPTIONS = Object.freeze({
  imageOrientation: "from-image",
  colorSpaceConversion: "default",
  premultiplyAlpha: "default",
});

const VALID_IMAGE_ORIENTATIONS = new Set(["from-image", "flipY", "none"]);
const VALID_COLOR_SPACE_CONVERSIONS = new Set(["default", "none"]);
const VALID_PREMULTIPLY_ALPHA = new Set(["default", "none", "premultiply"]);

function requireLimit(name, value) {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a nonnegative integer.`);
  }
  return value;
}

function requireDecodeOption(name, value, allowed) {
  if (!allowed.has(value)) {
    throw new RangeError(
      `${name} must be one of: ${Array.from(allowed).join(", ")}.`,
    );
  }
  return value;
}

/**
 * Normalize the decode axes that affect the pixels a consumer observes.
 * Upload-only state such as WebGL/WebGPU `flipY` is intentionally absent; both
 * backends apply that after acquiring the same context-free decoded source.
 *
 * @param {object} [options]
 * @returns {object}
 * @private
 */
function normalizeMoonDecodedSourceOptions(options) {
  options = options ?? DEFAULT_DECODE_OPTIONS;
  return Object.freeze({
    imageOrientation: requireDecodeOption(
      "imageOrientation",
      options.imageOrientation ?? DEFAULT_DECODE_OPTIONS.imageOrientation,
      VALID_IMAGE_ORIENTATIONS,
    ),
    colorSpaceConversion: requireDecodeOption(
      "colorSpaceConversion",
      options.colorSpaceConversion ??
        DEFAULT_DECODE_OPTIONS.colorSpaceConversion,
      VALID_COLOR_SPACE_CONVERSIONS,
    ),
    premultiplyAlpha: requireDecodeOption(
      "premultiplyAlpha",
      options.premultiplyAlpha ?? DEFAULT_DECODE_OPTIONS.premultiplyAlpha,
      VALID_PREMULTIPLY_ALPHA,
    ),
  });
}

/**
 * Convert a Moon source URL to the exact URL Resource would request, including
 * query parameters. Moon's public URL fields are strings. Resource instances
 * are deliberately rejected: two Resources can share a URL while carrying
 * different headers, retry callbacks, or request state, which cannot safely
 * coalesce under this cache's URL-only identity.
 *
 * @param {string} url
 * @returns {string}
 * @private
 */
function canonicalizeMoonDecodedSourceUrl(url) {
  if (typeof url !== "string" || url.length === 0) {
    throw new TypeError("Moon decoded-source URL must be a nonempty string.");
  }
  return Resource.createIfNeeded(url).getUrlComponent(true, true);
}

/**
 * Build the collision-free cache key for one exact decoded pixel source.
 *
 * @param {string} url
 * @param {object} [decodeOptions]
 * @param {function} [canonicalizeUrl]
 * @returns {{key: string, exactUrl: string, decodeOptions: object}}
 * @private
 */
function createMoonDecodedSourceKey(
  url,
  decodeOptions,
  canonicalizeUrl = canonicalizeMoonDecodedSourceUrl,
) {
  const exactUrl = canonicalizeUrl(url);
  if (typeof exactUrl !== "string" || exactUrl.length === 0) {
    throw new TypeError(
      "Moon decoded-source canonicalizer must return a nonempty string.",
    );
  }
  const normalized = normalizeMoonDecodedSourceOptions(decodeOptions);
  return Object.freeze({
    key: `moon-decoded-v1|${JSON.stringify([
      exactUrl,
      normalized.imageOrientation,
      normalized.colorSpaceConversion,
      normalized.premultiplyAlpha,
    ])}`,
    exactUrl,
    decodeOptions: normalized,
  });
}

function sourceDimension(source, properties) {
  for (const property of properties) {
    const value = source?.[property];
    if (Number.isFinite(value) && value > 0) {
      return value;
    }
  }
  return 0;
}

function defaultEstimateDecodedBytes(source) {
  const width = sourceDimension(source, [
    "naturalWidth",
    "videoWidth",
    "codedWidth",
    "displayWidth",
    "width",
  ]);
  const height = sourceDimension(source, [
    "naturalHeight",
    "videoHeight",
    "codedHeight",
    "displayHeight",
    "height",
  ]);
  return width * height * 4;
}

function isImageBitmap(source) {
  return typeof ImageBitmap !== "undefined" && source instanceof ImageBitmap;
}

async function defaultDecodeSource(source, options) {
  if (isImageBitmap(source) || typeof createImageBitmap !== "function") {
    return source;
  }
  return createImageBitmap(source, {
    imageOrientation: options.imageOrientation,
    colorSpaceConversion: options.colorSpaceConversion,
    premultiplyAlpha: options.premultiplyAlpha,
  });
}

async function defaultFetchSource(exactUrl, _decodeOptions, signal) {
  const request = new Request();
  const resource = new Resource({
    url: exactUrl,
    request,
  });
  const cancelRequest = function () {
    request.cancel();
  };
  if (signal.aborted) {
    cancelRequest();
    throw createMoonDecodedSourceCancellationError();
  }
  signal.addEventListener("abort", cancelRequest, { once: true });
  // Fetch bytes when the browser can decode them directly into ImageBitmap.
  // This avoids first decoding an HTMLImageElement and then converting it to
  // the shared bitmap. The image-element path preserves compatibility where
  // createImageBitmap is unavailable.
  try {
    if (typeof createImageBitmap === "function") {
      return await resource.fetchBlob();
    }
    return await resource.fetchImage();
  } finally {
    signal.removeEventListener("abort", cancelRequest);
  }
}

function defaultCloseSource(source) {
  if (typeof source?.close === "function") {
    source.close();
  }
}

function createMoonDecodedSourceCancellationError() {
  const error = new Error("Moon decoded-source acquisition was cancelled.");
  error.name = "AbortError";
  return error;
}

/**
 * One unique reference to a decoded Moon source. Calling {@link release} more
 * than once is safe and has no effect after the first call.
 *
 * @private
 */
class MoonDecodedSourceLease {
  constructor(cache, entry) {
    this._cache = cache;
    this._entry = entry;
    this._source = undefined;
    this._released = false;
    this._readyState = "pending";
    this.key = entry.key;
    this.exactUrl = entry.exactUrl;
    this.decodeOptions = entry.decodeOptions;
    this.byteLength = 0;
    this.ready = new Promise((resolve, reject) => {
      this._resolveReadyPromise = resolve;
      this._rejectReadyPromise = reject;
    });
    // Releasing before readiness deliberately rejects `ready`. Install an
    // internal observer so correct fire-and-cancel use cannot create an
    // unhandled rejection when the caller no longer needs to await it.
    this.ready.catch(function () {});
  }

  get source() {
    return this._source;
  }

  get released() {
    return this._released;
  }

  _resolve(entry) {
    if (this._released || this._readyState !== "pending") {
      return;
    }
    this._readyState = "ready";
    this._source = entry.source;
    this.byteLength = entry.byteLength;
    const resolve = this._resolveReadyPromise;
    this._resolveReadyPromise = undefined;
    this._rejectReadyPromise = undefined;
    resolve(this);
  }

  _reject(error, released) {
    if (this._readyState !== "pending") {
      return;
    }
    this._readyState = released ? "released" : "failed";
    this._released = true;
    this._source = undefined;
    this._cache = undefined;
    this._entry = undefined;
    const reject = this._rejectReadyPromise;
    this._resolveReadyPromise = undefined;
    this._rejectReadyPromise = undefined;
    reject(error);
  }

  release() {
    if (this._released) {
      return false;
    }
    this._released = true;
    this._source = undefined;
    const cache = this._cache;
    const entry = this._entry;
    this._cache = undefined;
    this._entry = undefined;
    cache._release(entry, this);
    return true;
  }
}

/**
 * Bounded, renderer-neutral cache of decoded Moon image sources.
 *
 * Only decoded CPU/browser objects live here. WebGL Texture, GPUTexture,
 * context, device, bind-group, and resource-generation handles are forbidden.
 * Each backend acquires a lease, realizes its own GPU texture, and releases the
 * lease independently.
 *
 * @private
 */
class MoonDecodedSourceCache {
  constructor(options = {}) {
    this._maxEntries = requireLimit(
      "maxEntries",
      options.maxEntries ?? DEFAULT_MOON_DECODED_SOURCE_MAX_ENTRIES,
    );
    this._maxBytes = requireLimit(
      "maxBytes",
      options.maxBytes ?? DEFAULT_MOON_DECODED_SOURCE_MAX_BYTES,
    );
    this._canonicalizeUrl =
      options.canonicalizeUrl ?? canonicalizeMoonDecodedSourceUrl;
    this._fetchSource = options.fetchSource ?? defaultFetchSource;
    this._decodeSource = options.decodeSource ?? defaultDecodeSource;
    this._estimateBytes = options.estimateBytes ?? defaultEstimateDecodedBytes;
    this._closeSource = options.closeSource ?? defaultCloseSource;
    this._onCleanupError = options.onCleanupError;
    this._entries = new Map();
    this._clock = 0;
    this._totalBytes = 0;
    this._statistics = {
      acquisitions: 0,
      releases: 0,
      hits: 0,
      coalesced: 0,
      misses: 0,
      fetches: 0,
      decodes: 0,
      loads: 0,
      failures: 0,
      pendingLeaseCancellations: 0,
      abortedLoads: 0,
      cancelledSettlements: 0,
      evictions: 0,
      clearEvictions: 0,
      cleanupErrors: 0,
      clears: 0,
    };
  }

  get maxEntries() {
    return this._maxEntries;
  }

  get maxBytes() {
    return this._maxBytes;
  }

  /**
   * Acquire one decoded-source lease.
   *
   * The lease is returned immediately, so callers can release ownership before
   * asynchronous fetch/decode completes. Await `lease.ready` before reading
   * `lease.source`; it resolves to the same lease. Releasing a pending lease
   * rejects `ready` with an AbortError and removes that waiter. Releasing the
   * final pending waiter also removes and aborts the shared load.
   *
   * @param {string} url
   * @param {object} [decodeOptions]
   * @returns {MoonDecodedSourceLease}
   */
  acquire(url, decodeOptions) {
    const identity = createMoonDecodedSourceKey(
      url,
      decodeOptions,
      this._canonicalizeUrl,
    );
    this._statistics.acquisitions++;

    let entry = this._entries.get(identity.key);
    if (entry !== undefined) {
      entry.lastUsed = ++this._clock;
      const lease = new MoonDecodedSourceLease(this, entry);
      entry.leases.add(lease);
      if (entry.state === "ready") {
        this._statistics.hits++;
        lease._resolve(entry);
        return lease;
      }
      this._statistics.coalesced++;
      return lease;
    }

    this._statistics.misses++;
    entry = {
      key: identity.key,
      exactUrl: identity.exactUrl,
      decodeOptions: identity.decodeOptions,
      state: "pending",
      promise: undefined,
      source: undefined,
      byteLength: 0,
      leases: new Set(),
      lastUsed: ++this._clock,
      evictWhenUnused: false,
      removed: false,
      abortController: new AbortController(),
    };
    const lease = new MoonDecodedSourceLease(this, entry);
    entry.leases.add(lease);
    this._entries.set(entry.key, entry);
    entry.promise = this._load(entry);
    return lease;
  }

  async _load(entry) {
    let fetchedSource;
    let decodedSource;
    try {
      this._statistics.fetches++;
      fetchedSource = await this._fetchSource(
        entry.exactUrl,
        entry.decodeOptions,
        entry.abortController.signal,
      );
      if (!this._isPendingLoadCurrent(entry)) {
        this._finishCancelledLoad(entry, fetchedSource, undefined);
        return;
      }

      this._statistics.decodes++;
      decodedSource = await this._decodeSource(
        fetchedSource,
        entry.decodeOptions,
        entry.exactUrl,
        entry.abortController.signal,
      );
      if (!this._isPendingLoadCurrent(entry)) {
        this._finishCancelledLoad(entry, fetchedSource, decodedSource);
        return;
      }
      if (decodedSource === undefined || decodedSource === null) {
        throw new Error("Moon decoded-source factory returned no source.");
      }

      if (fetchedSource !== decodedSource) {
        this._closeContained(fetchedSource, entry, "decoded-input");
        fetchedSource = undefined;
      }
      if (!this._isPendingLoadCurrent(entry)) {
        this._finishCancelledLoad(entry, undefined, decodedSource);
        return;
      }

      const byteLength = this._estimateBytes(
        decodedSource,
        entry.decodeOptions,
        entry.exactUrl,
      );
      if (!Number.isFinite(byteLength) || byteLength < 0) {
        throw new RangeError(
          "Moon decoded-source byte estimate must be finite and nonnegative.",
        );
      }
      // Injected accounting and cleanup callbacks are allowed to be
      // reentrant. Revalidate after the final user hook so an old, cancelled
      // load cannot publish into a replacement entry for the same key.
      if (!this._isPendingLoadCurrent(entry)) {
        this._finishCancelledLoad(entry, undefined, decodedSource);
        return;
      }

      entry.source = decodedSource;
      entry.byteLength = Math.ceil(byteLength);
      entry.state = "ready";
      entry.abortController = undefined;
      entry.lastUsed = ++this._clock;
      this._totalBytes += entry.byteLength;
      this._statistics.loads++;
      for (const lease of entry.leases) {
        lease._resolve(entry);
      }
      this._trim();
    } catch (error) {
      if (!this._isPendingLoadCurrent(entry)) {
        this._finishCancelledLoad(entry, fetchedSource, decodedSource);
        return;
      }
      this._finishFailedLoad(entry, error, fetchedSource, decodedSource);
    }
  }

  _isPendingLoadCurrent(entry) {
    return (
      !entry.removed &&
      entry.state === "pending" &&
      entry.leases.size > 0 &&
      this._entries.get(entry.key) === entry &&
      !entry.abortController.signal.aborted
    );
  }

  _closeLoadSources(entry, fetchedSource, decodedSource, reason) {
    if (decodedSource !== undefined && decodedSource !== null) {
      this._closeContained(decodedSource, entry, `${reason}-decoded-source`);
    }
    if (
      fetchedSource !== undefined &&
      fetchedSource !== null &&
      fetchedSource !== decodedSource
    ) {
      this._closeContained(fetchedSource, entry, `${reason}-fetched-source`);
    }
  }

  _finishCancelledLoad(entry, fetchedSource, decodedSource) {
    this._closeLoadSources(entry, fetchedSource, decodedSource, "cancelled");
    entry.abortController = undefined;
    this._statistics.cancelledSettlements++;
  }

  _finishFailedLoad(entry, error, fetchedSource, decodedSource) {
    if (this._entries.get(entry.key) === entry) {
      this._entries.delete(entry.key);
    }
    entry.removed = true;
    entry.source = undefined;
    entry.byteLength = 0;
    entry.state = "failed";
    entry.abortController = undefined;
    this._statistics.failures++;
    const leases = Array.from(entry.leases);
    entry.leases.clear();
    for (const lease of leases) {
      lease._reject(error, false);
    }
    this._closeLoadSources(entry, fetchedSource, decodedSource, "failed");
  }

  _release(entry, lease) {
    if (!entry.leases.delete(lease)) {
      return;
    }
    entry.lastUsed = ++this._clock;
    this._statistics.releases++;
    if (entry.state === "pending") {
      this._statistics.pendingLeaseCancellations++;
      const error = createMoonDecodedSourceCancellationError();
      lease._reject(error, true);
      if (entry.leases.size === 0) {
        if (this._entries.get(entry.key) === entry) {
          this._entries.delete(entry.key);
        }
        entry.removed = true;
        entry.state = "cancelled";
        this._statistics.abortedLoads++;
        entry.abortController.abort(error);
      }
      return;
    }
    if (entry.removed || entry.leases.size !== 0) {
      return;
    }
    if (entry.evictWhenUnused) {
      this._evictEntry(entry, "clear");
      return;
    }
    this._trim();
  }

  _closeContained(source, entry, reason) {
    if (source === undefined || source === null) {
      return;
    }
    try {
      this._closeSource(source, {
        key: entry.key,
        exactUrl: entry.exactUrl,
        reason,
      });
    } catch (error) {
      this._statistics.cleanupErrors++;
      try {
        this._onCleanupError?.(error, {
          key: entry.key,
          exactUrl: entry.exactUrl,
          reason,
        });
      } catch (_ignored) {
        // Diagnostics cannot take ownership of source cleanup.
      }
    }
  }

  _evictEntry(entry, reason) {
    if (
      entry.removed ||
      entry.state !== "ready" ||
      entry.leases.size !== 0 ||
      this._entries.get(entry.key) !== entry
    ) {
      return false;
    }
    this._entries.delete(entry.key);
    entry.removed = true;
    this._totalBytes -= entry.byteLength;
    this._closeContained(entry.source, entry, reason);
    entry.source = undefined;
    entry.byteLength = 0;
    entry.state = "evicted";
    this._statistics.evictions++;
    if (reason === "clear") {
      this._statistics.clearEvictions++;
    }
    return true;
  }

  _trim() {
    while (
      this._entries.size > this._maxEntries ||
      this._totalBytes > this._maxBytes
    ) {
      let oldest;
      for (const candidate of this._entries.values()) {
        if (
          candidate.state !== "ready" ||
          candidate.leases.size !== 0 ||
          candidate.removed
        ) {
          continue;
        }
        if (oldest === undefined || candidate.lastUsed < oldest.lastUsed) {
          oldest = candidate;
        }
      }
      if (oldest === undefined) {
        break;
      }
      this._evictEntry(oldest, "budget");
    }
  }

  /**
   * Evict every inactive source now and mark active/pending entries for
   * eviction after their final lease releases. Marked entries remain
   * discoverable so a clear cannot create a second concurrent decode for a key
   * that is still in use.
   *
   * @returns {{evicted: number, deferred: number}}
   */
  clear() {
    this._statistics.clears++;
    let evicted = 0;
    let deferred = 0;
    for (const entry of Array.from(this._entries.values())) {
      if (entry.state === "ready" && entry.leases.size === 0) {
        if (this._evictEntry(entry, "clear")) {
          evicted++;
        }
      } else {
        entry.evictWhenUnused = true;
        deferred++;
      }
    }
    return Object.freeze({ evicted, deferred });
  }

  /**
   * Return a source-free, stable diagnostic snapshot.
   *
   * @returns {object}
   */
  getDiagnostics() {
    let pendingEntries = 0;
    let readyEntries = 0;
    let activeEntries = 0;
    let activeLeases = 0;
    let activePendingEntries = 0;
    let activeReadyEntries = 0;
    let pendingLeases = 0;
    let readyLeases = 0;
    let retainedEntries = 0;
    let retainedBytes = 0;
    const entries = [];
    for (const entry of this._entries.values()) {
      const refCount = entry.leases.size;
      if (entry.state === "pending") {
        pendingEntries++;
        pendingLeases += refCount;
      } else if (entry.state === "ready") {
        readyEntries++;
        readyLeases += refCount;
      }
      if (refCount > 0) {
        activeEntries++;
        activeLeases += refCount;
        if (entry.state === "pending") {
          activePendingEntries++;
        } else if (entry.state === "ready") {
          activeReadyEntries++;
        }
      } else if (entry.state === "ready") {
        retainedEntries++;
        retainedBytes += entry.byteLength;
      }
      entries.push(
        Object.freeze({
          key: entry.key,
          exactUrl: entry.exactUrl,
          state: entry.state,
          refCount,
          byteLength: entry.byteLength,
          evictWhenUnused: entry.evictWhenUnused,
        }),
      );
    }
    entries.sort((left, right) => {
      if (left.key < right.key) {
        return -1;
      }
      return left.key > right.key ? 1 : 0;
    });
    return Object.freeze({
      maxEntries: this._maxEntries,
      maxBytes: this._maxBytes,
      entryCount: this._entries.size,
      totalBytes: this._totalBytes,
      pendingEntries,
      readyEntries,
      activeEntries,
      activeLeases,
      activePendingEntries,
      activeReadyEntries,
      pendingLeases,
      readyLeases,
      retainedEntries,
      retainedBytes,
      overEntryBudget: this._entries.size > this._maxEntries,
      overByteBudget: this._totalBytes > this._maxBytes,
      ...this._statistics,
      entries: Object.freeze(entries),
    });
  }
}

let sharedMoonDecodedSourceCache;

/**
 * Return the one renderer-neutral decoded Moon source cache shared by all
 * Scenes in this JavaScript realm.
 *
 * @returns {MoonDecodedSourceCache}
 * @private
 */
function getSharedMoonDecodedSourceCache() {
  sharedMoonDecodedSourceCache ??= new MoonDecodedSourceCache();
  return sharedMoonDecodedSourceCache;
}

export {
  DEFAULT_MOON_DECODED_SOURCE_MAX_BYTES,
  DEFAULT_MOON_DECODED_SOURCE_MAX_ENTRIES,
  MoonDecodedSourceCache,
  MoonDecodedSourceLease,
  canonicalizeMoonDecodedSourceUrl,
  createMoonDecodedSourceKey,
  getSharedMoonDecodedSourceCache,
  normalizeMoonDecodedSourceOptions,
};

export default MoonDecodedSourceCache;
