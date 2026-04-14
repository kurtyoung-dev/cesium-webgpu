import defined from "../Core/defined.js";
import DeveloperError from "../Core/DeveloperError.js";
import Cesium3DTilesInvalidationFeedAdapter from "./Cesium3DTilesInvalidationFeedAdapter.js";

/* ============================================================================
 * Producer "listener invalidations" v2.0 adapter
 * ----------------------------------------------------------------------------
 * Parses the real producer feed (e.g. listener_invalidations_25.2.txt) into
 * an array of normalized InvalidationSet objects — one per logical block.
 *
 * FORMAT (v2.0)
 * -------------
 * Append-only log. Each block is a JSON object preceded by a literal
 *   new invalidation:
 * header line. The file is NOT itself a single JSON document. A typical
 * block looks like:
 *
 *   new invalidation:
 *   {
 *     "extents" : [ { "lat": [...], "layer": "terrain/", "lon": [...] } ],
 *     "resources" : [
 *       "terrain/tileset.json",
 *       "terrain/5/0/1/3/2/1/1/3/0/0/1/2/3/1.*",
 *       "terrain/5/0/1/3/2/1/1/3/0/0/1/2/3/1/2*"
 *     ],
 *     "version" : "2.0"
 *   }
 *
 * RESOURCE SEMANTICS
 * ------------------
 *   "<layer>/tileset.json"   Re-fetch the tileset root. Phase 1 logs +
 *                            skips (tilesetJson: true); Phase 2 will do the
 *                            actual HTTP re-fetch.
 *
 * Wildcard suffixes live on the LAST segment of the resource, never alone:
 *   ".*"    Exact-LOD invalidation of the trailing node only. Strip ".*".
 *   "*"     Subtree invalidation of the trailing node + descendants. Strip "*".
 *   (none)  Exact-LOD on the final node.
 *
 * ENCODING-AGNOSTIC
 * -----------------
 * This adapter is PURE parsing. It does not parse tile paths into integer
 * segments — that is the job of the per-feed TilePathResolver selected by
 * {@link Cesium3DTilesInvalidationFeed}'s pathEncoding option. Different
 * tilesets in the same scene can use different encodings.
 *
 * ID / GENERATED-AT SYNTHESIS (Option C)
 * --------------------------------------
 *   id          Prefer JSON-supplied `id`. Otherwise compute an FNV-1a 64-bit
 *               hash over the canonicalized (sorted-keys) JSON of the block
 *               and prefix with "sha:".
 *   generatedAt Prefer JSON-supplied `generatedAt` | `generated` | `timestamp`.
 *               Otherwise: "file:<sourceMtime>+<blockIndex>" when an mtime is
 *               known, else the current ISO-8601 timestamp.
 * ============================================================================
 */

const FORMAT_ID = "producer-listener-v2.0";
const SUPPORTED_VERSION = "2.0";

/**
 * @param {object} [options]
 * @param {boolean} [options.lenient=true] When true, malformed blocks are
 *   logged and skipped instead of throwing. Defaults to true because
 *   producer files in the wild have edge cases.
 * @param {(string|number)} [options.sourceMtime] Optional mtime stamp mixed
 *   into synthesized generatedAt tags when the JSON has no timestamp.
 * @param {string} [options.sourceUrl] Optional diagnostic label.
 * @constructor
 * @extends Cesium3DTilesInvalidationFeedAdapter
 * @private
 */
class ProducerListenerAdapter {
  constructor(options) {
    options = options ?? {};
    this._lenient = options.lenient !== false; // default true
    this._sourceMtime = options.sourceMtime;
    this._sourceUrl = options.sourceUrl;
  }

  /**
   * Parse a producer listener-invalidations v2.0 payload.
   * @param {string|ArrayBuffer} payload
   * @param {object} [perCallOptions] Override sourceMtime / sourceUrl.
   * @returns {import("./Cesium3DTilesInvalidationFeedAdapter.js").InvalidationSet[]}
   */
  parse(payload, perCallOptions) {
    const text = decodePayload(payload);
    if (!defined(text) || text.length === 0) {
      return [];
    }
    const lenient = this._lenient;
    const sourceMtime =
      perCallOptions && defined(perCallOptions.sourceMtime)
        ? perCallOptions.sourceMtime
        : this._sourceMtime;
    const sourceUrl =
      perCallOptions && defined(perCallOptions.sourceUrl)
        ? perCallOptions.sourceUrl
        : this._sourceUrl;

    const chunks = splitBlocks(text);
    /** @type {import("./Cesium3DTilesInvalidationFeedAdapter.js").InvalidationSet[]} */
    const sets = [];

    for (let b = 0; b < chunks.length; ++b) {
      const chunk = chunks[b];
      let json;
      try {
        json = JSON.parse(chunk);
      } catch (err) {
        const msg = `[ProducerListenerAdapter] Block ${b} JSON parse failed${sourceUrl ? ` (${sourceUrl})` : ""}: ${err.message}`;
        if (lenient) {
          console.warn(msg);
          continue;
        }
        throw new DeveloperError(msg);
      }

      const version =
        typeof json.version === "string" ? json.version : undefined;
      if (!defined(version)) {
        const msg = `[ProducerListenerAdapter] Block ${b} missing version field.`;
        if (lenient) {
          console.warn(msg);
          continue;
        }
        throw new DeveloperError(msg);
      }
      if (version !== SUPPORTED_VERSION) {
        // Accept forward versions (2.1+) with an info note; record the string.
        console.info(
          `[ProducerListenerAdapter] Block ${b} has version "${version}" (expected ${SUPPORTED_VERSION}); accepting.`,
        );
      }

      const resources = Array.isArray(json.resources) ? json.resources : [];
      const layers = buildLayerMap(resources);

      const id =
        defined(json.id) && typeof json.id === "string"
          ? json.id
          : `sha:${fnv1a64Hex(canonicalize(json))}`;

      let generatedAt;
      if (typeof json.generatedAt === "string") {
        generatedAt = json.generatedAt;
      } else if (typeof json.generated === "string") {
        generatedAt = json.generated;
      } else if (typeof json.timestamp === "string") {
        generatedAt = json.timestamp;
      } else if (defined(sourceMtime)) {
        generatedAt = `file:${sourceMtime}+${b}`;
      } else {
        generatedAt = new Date().toISOString();
      }

      sets.push({
        id: id,
        generatedAt: generatedAt,
        version: version,
        layers: layers,
        sourceBlockIndex: b,
      });
    }

    return sets;
  }

  get formatId() {
    return FORMAT_ID;
  }
}

ProducerListenerAdapter.prototype = Object.create(
  Cesium3DTilesInvalidationFeedAdapter.prototype,
);
ProducerListenerAdapter.prototype.constructor = ProducerListenerAdapter;

/**
 * Split the raw text on block boundaries. The separator is a line containing
 * literally <code>new invalidation:</code>. Tolerant of CRLF line endings,
 * leading/trailing whitespace, and the very first header line in the file.
 * @private
 */
function splitBlocks(text) {
  // Normalize line endings, then split on any line equal to "new invalidation:"
  // (optionally surrounded by whitespace).
  const normalized = text.replace(/\r\n/g, "\n");
  const parts = normalized.split(
    /(?:^|\n)[ \t]*new invalidation:[ \t]*(?:\n|$)/,
  );
  const out = [];
  for (let i = 0; i < parts.length; ++i) {
    const t = parts[i].trim();
    if (t.length > 0) {
      out.push(t);
    }
  }
  return out;
}

/**
 * Turn a "resources" array into a Map<layerName, InvalidationLayer>.
 * Implements the tileset.json / wildcard rules described at the top of the
 * file. Does NOT parse tile-path segments — that's the resolver's job.
 * @private
 */
function buildLayerMap(resources) {
  /** @type {Map<string, import("./Cesium3DTilesInvalidationFeedAdapter.js").InvalidationLayer>} */
  const layers = new Map();

  for (let i = 0; i < resources.length; ++i) {
    const resource = resources[i];
    if (typeof resource !== "string" || resource.length === 0) {
      continue;
    }

    // Split on first '/'
    const slash = resource.indexOf("/");
    if (slash < 0) {
      // No layer prefix — skip defensively.
      continue;
    }
    let layerPrefix = resource.slice(0, slash);
    const rest = resource.slice(slash + 1);
    // Strip any trailing slash from the layer prefix (defensive — the prefix
    // as produced by splitting on first '/' won't have one, but the
    // `extents[*].layer` form does, so we normalize uniformly).
    if (
      layerPrefix.length > 0 &&
      layerPrefix.charCodeAt(layerPrefix.length - 1) === 47 /* '/' */
    ) {
      layerPrefix = layerPrefix.slice(0, -1);
    }

    let layer = layers.get(layerPrefix);
    if (!defined(layer)) {
      layer = { name: layerPrefix, entries: [] };
      layers.set(layerPrefix, layer);
    }

    if (rest === "tileset.json") {
      layer.entries.push({ kind: "exact", rawPath: "", tilesetJson: true });
      continue;
    }

    // Wildcard suffix detection on the full `rest` (wildcard lives on the
    // last segment, but detection on the trailing characters is equivalent).
    let kind = "exact";
    let rawPath = rest;
    if (rawPath.endsWith(".*")) {
      kind = "exact";
      rawPath = rawPath.slice(0, -2);
    } else if (rawPath.endsWith("*")) {
      kind = "subtree";
      rawPath = rawPath.slice(0, -1);
    }

    layer.entries.push({
      kind: kind,
      rawPath: rawPath,
      tilesetJson: false,
    });
  }

  return layers;
}

// ---------------------------------------------------------------------------
// Canonicalization + FNV-1a 64-bit (inline, no deps)
// ---------------------------------------------------------------------------

/**
 * Deterministic JSON stringify with sorted object keys. Arrays preserve
 * order. Sufficient for stable hashing of producer blocks.
 * @private
 */
function canonicalize(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const items = value.map((v) => canonicalize(v));
    return `[${items.join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  const parts = keys.map(
    (k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`,
  );
  return `{${parts.join(",")}}`;
}

/**
 * FNV-1a 64-bit hash over a UTF-8 string, returned as a 16-char lowercase
 * hex string. Implemented with two 32-bit halves so it works cleanly in JS
 * without BigInt. The FNV-64 prime is 0x100000001b3 = 2^40 + 2^8 + 0xb3:
 *   lo = 0x000001b3
 *   hi = 0x00000100
 * which lets us multiply by (1 + (1<<8) + (1<<40)) mod 2^64.
 * @private
 */
function fnv1a64Hex(str) {
  // Start from FNV-64 offset basis 0xcbf29ce484222325
  let hi = 0xcbf29ce4 | 0;
  let lo = 0x84222325 | 0;

  for (let i = 0; i < str.length; ++i) {
    const c = str.charCodeAt(i) & 0xff;
    lo = lo ^ c;
    // 64-bit multiply by 0x100000001b3 via h' = h + (h<<8) + (h<<40)
    // Compute (hi:lo) << 8 and (hi:lo) << 40, then sum with (hi:lo).
    const origHi = hi;
    const origLo = lo;

    // shift left 8
    const sh8Hi = ((origHi << 8) | (origLo >>> 24)) >>> 0;
    const sh8Lo = (origLo << 8) >>> 0;
    // shift left 40 = shift lo-part up by 8 into hi, clear lo
    const sh40Hi = (origLo << 8) >>> 0;
    const sh40Lo = 0;

    // Sum: hi:lo + sh8 + sh40
    let sumLo = (origLo >>> 0) + (sh8Lo >>> 0);
    const carry = sumLo > 0xffffffff ? 1 : 0;
    sumLo = sumLo >>> 0;
    let sumHi = ((origHi >>> 0) + (sh8Hi >>> 0) + carry) >>> 0;

    sumLo = (sumLo + (sh40Lo >>> 0)) >>> 0; // sh40Lo is 0
    sumHi = (sumHi + (sh40Hi >>> 0)) >>> 0;

    hi = sumHi >>> 0;
    lo = sumLo >>> 0;
  }

  const hiHex = `00000000${hi.toString(16)}`.slice(-8);
  const loHex = `00000000${lo.toString(16)}`.slice(-8);
  return hiHex + loHex;
}

function decodePayload(payload) {
  if (typeof payload === "string") {
    return payload;
  }
  if (payload instanceof ArrayBuffer) {
    return new TextDecoder("utf-8").decode(new Uint8Array(payload));
  }
  if (ArrayBuffer.isView(payload)) {
    return new TextDecoder("utf-8").decode(payload);
  }
  return undefined;
}

export default ProducerListenerAdapter;
