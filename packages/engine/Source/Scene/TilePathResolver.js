import defined from "../Core/defined.js";
import DeveloperError from "../Core/DeveloperError.js";
import TilePathEncoding from "./TilePathEncoding.js";

/** @import Cesium3DTile from "./Cesium3DTile.js"; */

/* ============================================================================
 * TilePathResolver — pluggable path parsing + in-memory tree walking for the
 * 3D Tiles live invalidation feed.
 *
 * A TilePathResolver owns two responsibilities:
 *   1. parsePath(rawPath)  — parse a producer-specific path string into a
 *                            normalized ParsedTilePath (indices or level+xy).
 *   2. resolve(root, parsed, kind) — walk the in-memory Cesium3DTile tree
 *                            from `root` to find tiles matching the parsed
 *                            path. kind="exact" returns a single node (or
 *                            empty if the walk fails). kind="subtree" returns
 *                            the node plus every in-memory descendant.
 *
 * Four encodings ship in the box. Add more by subclassing and returning them
 * from createTilePathResolver.
 *
 *   CHILD_INDEX  "5/0/1/3/2"           slash-separated child indices, one per
 *                                      level. This is the DEFAULT — it is the
 *                                      exact format the producer fixture
 *                                      (listener_invalidations_*.txt) emits.
 *   QUADKEY      "01321133"            Bing-style base-4 single string; each
 *                                      character is a child index (0..3).
 *   MORTON       "13/38"               level/morton-int where the morton
 *                                      integer interleaves x/y bits (even
 *                                      bits = x, odd bits = y).
 *   LEVEL_XY     "13/5119/2734"        TMS / OGC implicit tiling quadtree.
 *                "13/5119/2734/100"    Same, with optional z for octree.
 *
 * Layer prefixes ("terrain/", "objects/", ...) and wildcard suffixes
 * ("*", ".*") are stripped by the feed adapter BEFORE rawPath reaches the
 * resolver — resolvers only see the tile identifier itself.
 * ============================================================================
 */

/**
 * @typedef {object} ParsedTilePath
 * @property {string} encoding One of {@link TilePathEncoding} values.
 * @property {number[]} [indices] Child-index path (CHILD_INDEX, QUADKEY).
 * @property {number} [level]
 * @property {number} [x]
 * @property {number} [y]
 * @property {number} [z] Only set for octree LEVEL_XY.
 */

/**
 * Abstract base. Concrete subclasses live in this same file.
 * @constructor
 * @private
 */
function TilePathResolver() {}

Object.defineProperties(TilePathResolver.prototype, {
  encoding: {
    get: function () {
      throw new DeveloperError(
        "TilePathResolver.encoding must be implemented by a subclass.",
      );
    },
  },
});

/**
 * Parse a raw path string (with layer prefix and wildcard already stripped)
 * into a normalized {@link ParsedTilePath}.
 * @param {string} rawPath
 * @returns {ParsedTilePath}
 */
TilePathResolver.prototype.parsePath = function (rawPath) {
  throw new DeveloperError(
    "TilePathResolver.parsePath must be implemented by a subclass.",
  );
};

/**
 * Walk the in-memory tile tree from {@link rootTile} to find matching tiles.
 * @param {Cesium3DTile} rootTile
 * @param {ParsedTilePath} parsedPath
 * @param {("exact"|"subtree")} kind
 * @returns {Cesium3DTile[]}
 */
TilePathResolver.prototype.resolve = function (rootTile, parsedPath, kind) {
  throw new DeveloperError(
    "TilePathResolver.resolve must be implemented by a subclass.",
  );
};

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Walk from root down a child-index array. Returns the matched tile, or
 * undefined if any step falls off the in-memory tree (producer/consumer lag
 * is expected and non-fatal).
 * @private
 */
function walkByIndices(rootTile, indices) {
  if (!defined(rootTile)) {
    return undefined;
  }
  if (!defined(indices) || indices.length === 0) {
    return rootTile;
  }
  let node = rootTile;
  for (let i = 0; i < indices.length; ++i) {
    const children = node.children;
    if (!defined(children) || children.length === 0) {
      return undefined;
    }
    const idx = indices[i];
    if (idx < 0 || idx >= children.length) {
      return undefined;
    }
    node = children[idx];
    if (!defined(node)) {
      return undefined;
    }
  }
  return node;
}

/**
 * Collect {@link target} plus every in-memory descendant via iterative DFS.
 * @private
 */
function collectSubtree(target) {
  const out = [];
  if (!defined(target)) {
    return out;
  }
  const stack = [target];
  while (stack.length > 0) {
    const node = stack.pop();
    out.push(node);
    const children = node.children;
    if (defined(children)) {
      for (let i = 0; i < children.length; ++i) {
        stack.push(children[i]);
      }
    }
  }
  return out;
}

/**
 * Resolve helper shared by every encoding once it has produced an indices
 * array. Centralizes the walk + subtree expansion.
 * @private
 */
function resolveFromIndices(rootTile, indices, kind) {
  const target = walkByIndices(rootTile, indices);
  if (!defined(target)) {
    return [];
  }
  if (kind === "subtree") {
    return collectSubtree(target);
  }
  return [target];
}

// ---------------------------------------------------------------------------
// CHILD_INDEX — "5/0/1/3/2"
// ---------------------------------------------------------------------------

function ChildIndexTilePathResolver() {}
ChildIndexTilePathResolver.prototype = Object.create(
  TilePathResolver.prototype,
);
ChildIndexTilePathResolver.prototype.constructor = ChildIndexTilePathResolver;

Object.defineProperties(ChildIndexTilePathResolver.prototype, {
  encoding: {
    get: function () {
      return TilePathEncoding.CHILD_INDEX;
    },
  },
});

ChildIndexTilePathResolver.prototype.parsePath = function (rawPath) {
  const indices = [];
  if (!defined(rawPath) || rawPath.length === 0) {
    return { encoding: TilePathEncoding.CHILD_INDEX, indices: indices };
  }
  const parts = rawPath.split("/");
  for (let i = 0; i < parts.length; ++i) {
    const seg = parts[i];
    if (seg.length === 0) {
      // Tolerate leading/trailing/duplicate slashes.
      continue;
    }
    if (!/^\d+$/.test(seg)) {
      throw new DeveloperError(
        `ChildIndexTilePathResolver: non-integer path segment "${seg}" in "${rawPath}".`,
      );
    }
    indices.push(Number(seg));
  }
  return { encoding: TilePathEncoding.CHILD_INDEX, indices: indices };
};

ChildIndexTilePathResolver.prototype.resolve = function (
  rootTile,
  parsed,
  kind,
) {
  return resolveFromIndices(rootTile, parsed.indices, kind);
};

// ---------------------------------------------------------------------------
// QUADKEY — "01321133" (Bing-style base-4 single string)
// ---------------------------------------------------------------------------

function QuadkeyTilePathResolver() {}
QuadkeyTilePathResolver.prototype = Object.create(TilePathResolver.prototype);
QuadkeyTilePathResolver.prototype.constructor = QuadkeyTilePathResolver;

Object.defineProperties(QuadkeyTilePathResolver.prototype, {
  encoding: {
    get: function () {
      return TilePathEncoding.QUADKEY;
    },
  },
});

QuadkeyTilePathResolver.prototype.parsePath = function (rawPath) {
  const indices = [];
  if (!defined(rawPath) || rawPath.length === 0) {
    return { encoding: TilePathEncoding.QUADKEY, indices: indices };
  }
  for (let i = 0; i < rawPath.length; ++i) {
    const c = rawPath.charCodeAt(i);
    // '0'..'3' → 48..51
    if (c < 48 || c > 51) {
      throw new DeveloperError(
        `QuadkeyTilePathResolver: bad quadkey digit "${rawPath.charAt(i)}" in "${rawPath}".`,
      );
    }
    indices.push(c - 48);
  }
  return { encoding: TilePathEncoding.QUADKEY, indices: indices };
};

QuadkeyTilePathResolver.prototype.resolve = function (rootTile, parsed, kind) {
  return resolveFromIndices(rootTile, parsed.indices, kind);
};

// ---------------------------------------------------------------------------
// MORTON — "level/morton-int" where morton interleaves x (even bits) / y (odd bits)
// ---------------------------------------------------------------------------

function MortonTilePathResolver() {}
MortonTilePathResolver.prototype = Object.create(TilePathResolver.prototype);
MortonTilePathResolver.prototype.constructor = MortonTilePathResolver;

Object.defineProperties(MortonTilePathResolver.prototype, {
  encoding: {
    get: function () {
      return TilePathEncoding.MORTON;
    },
  },
});

/**
 * Deinterleave a 2D morton integer: even bits → x, odd bits → y.
 *   bit0→x0, bit1→y0, bit2→x1, bit3→y1, ...
 * 32-bit safe (we use | 0 to keep operations in int32).
 * @param {number} m
 * @returns {{x: number, y: number}}
 * @private
 */
function deinterleaveMorton2D(m) {
  let x = 0;
  let y = 0;
  for (let i = 0; i < 16; ++i) {
    x |= ((m >> (2 * i)) & 1) << i;
    y |= ((m >> (2 * i + 1)) & 1) << i;
  }
  return { x: x | 0, y: y | 0 };
}

MortonTilePathResolver.prototype.parsePath = function (rawPath) {
  if (!defined(rawPath) || rawPath.length === 0) {
    throw new DeveloperError("MortonTilePathResolver: empty path.");
  }
  const parts = rawPath.split("/").filter((s) => s.length > 0);
  if (parts.length !== 2) {
    throw new DeveloperError(
      `MortonTilePathResolver: expected "level/morton", got "${rawPath}".`,
    );
  }
  if (!/^\d+$/.test(parts[0]) || !/^\d+$/.test(parts[1])) {
    throw new DeveloperError(
      `MortonTilePathResolver: non-integer component in "${rawPath}".`,
    );
  }
  const level = Number(parts[0]);
  const morton = Number(parts[1]);
  const { x, y } = deinterleaveMorton2D(morton);
  return { encoding: TilePathEncoding.MORTON, level: level, x: x, y: y };
};

/**
 * Convert (level, x, y) to a child-index path via standard quadtree descent.
 * At depth d (0-indexed from root), the child index is built from the d-th
 * most-significant bit of x and y:
 *   childIdx = (yBit << 1) | xBit
 * where bit i (counted from the MSB of an L-level key) is
 *   (coord >> (level - d - 1)) & 1
 * @private
 */
function quadtreeIndicesFromLevelXY(level, x, y) {
  const indices = new Array(level);
  for (let d = 0; d < level; ++d) {
    const shift = level - d - 1;
    const xBit = (x >> shift) & 1;
    const yBit = (y >> shift) & 1;
    indices[d] = (yBit << 1) | xBit;
  }
  return indices;
}

MortonTilePathResolver.prototype.resolve = function (rootTile, parsed, kind) {
  const indices = quadtreeIndicesFromLevelXY(parsed.level, parsed.x, parsed.y);
  return resolveFromIndices(rootTile, indices, kind);
};

// ---------------------------------------------------------------------------
// LEVEL_XY — "level/x/y" quadtree or "level/x/y/z" octree (OGC implicit tiling)
// ---------------------------------------------------------------------------

function LevelXyTilePathResolver() {}
LevelXyTilePathResolver.prototype = Object.create(TilePathResolver.prototype);
LevelXyTilePathResolver.prototype.constructor = LevelXyTilePathResolver;

Object.defineProperties(LevelXyTilePathResolver.prototype, {
  encoding: {
    get: function () {
      return TilePathEncoding.LEVEL_XY;
    },
  },
});

LevelXyTilePathResolver.prototype.parsePath = function (rawPath) {
  if (!defined(rawPath) || rawPath.length === 0) {
    throw new DeveloperError("LevelXyTilePathResolver: empty path.");
  }
  const parts = rawPath.split("/").filter((s) => s.length > 0);
  if (parts.length !== 3 && parts.length !== 4) {
    throw new DeveloperError(
      `LevelXyTilePathResolver: expected "level/x/y" or "level/x/y/z", got "${rawPath}".`,
    );
  }
  for (let i = 0; i < parts.length; ++i) {
    if (!/^\d+$/.test(parts[i])) {
      throw new DeveloperError(
        `LevelXyTilePathResolver: non-integer component "${parts[i]}" in "${rawPath}".`,
      );
    }
  }
  const result = {
    encoding: TilePathEncoding.LEVEL_XY,
    level: Number(parts[0]),
    x: Number(parts[1]),
    y: Number(parts[2]),
  };
  if (parts.length === 4) {
    result.z = Number(parts[3]);
  }
  return result;
};

/**
 * Octree variant of quadtree descent. Child index is
 *   (zBit << 2) | (yBit << 1) | xBit
 * @private
 */
function octreeIndicesFromLevelXYZ(level, x, y, z) {
  const indices = new Array(level);
  for (let d = 0; d < level; ++d) {
    const shift = level - d - 1;
    const xBit = (x >> shift) & 1;
    const yBit = (y >> shift) & 1;
    const zBit = (z >> shift) & 1;
    indices[d] = (zBit << 2) | (yBit << 1) | xBit;
  }
  return indices;
}

LevelXyTilePathResolver.prototype.resolve = function (rootTile, parsed, kind) {
  const indices = defined(parsed.z)
    ? octreeIndicesFromLevelXYZ(parsed.level, parsed.x, parsed.y, parsed.z)
    : quadtreeIndicesFromLevelXY(parsed.level, parsed.x, parsed.y);
  return resolveFromIndices(rootTile, indices, kind);
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Construct the resolver that matches the given encoding.
 * @param {string} encoding One of {@link TilePathEncoding} values.
 * @returns {TilePathResolver}
 * @private
 */
export function createTilePathResolver(encoding) {
  switch (encoding) {
    case TilePathEncoding.CHILD_INDEX:
      return new ChildIndexTilePathResolver();
    case TilePathEncoding.QUADKEY:
      return new QuadkeyTilePathResolver();
    case TilePathEncoding.MORTON:
      return new MortonTilePathResolver();
    case TilePathEncoding.LEVEL_XY:
      return new LevelXyTilePathResolver();
    default:
      throw new DeveloperError(`Unknown TilePathEncoding: ${encoding}`);
  }
}

export {
  TilePathResolver,
  ChildIndexTilePathResolver,
  QuadkeyTilePathResolver,
  MortonTilePathResolver,
  LevelXyTilePathResolver,
};
export default TilePathResolver;
