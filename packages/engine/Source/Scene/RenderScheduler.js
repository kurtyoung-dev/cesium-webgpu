import defined from "../Core/defined.js";
import mergeSort from "../Core/mergeSort.js";
import MaterialSortIdAllocator from "./MaterialSortIdAllocator.js";
import OcclusionCulling from "./OcclusionCulling.js";
import RenderLayerCollection from "./RenderLayerCollection.js";
import SceneOctree from "./SceneOctree.js";
import SortMode from "./SortMode.js";

/**
 * The overarching sort management system for CesiumJS. Sits above the 5 existing
 * sorting mechanisms (Pass binning, distance sort, sortKey, zIndex, PrimitiveCollection
 * order) and unifies them into a predictive, layered, material-batched sort.
 *
 * The RenderScheduler:
 * - Manages a {@link RenderLayerCollection} with default and user-defined layers
 * - Bins commands into layers based on command.sortLayer or Pass-to-layer mapping
 * - Applies per-layer sort strategies (material batching, distance, manual, custom)
 * - Auto-populates materialSortId for shader batching via {@link MaterialSortIdAllocator}
 * - Supports explicit transparent & transmissive ordering
 * - Provides auto depth clear per layer with optional manual override
 * - Enables per-entity sort overrides via sortPriority
 * - Supports custom sort callbacks per layer
 * - Offers predictive sort position queries for integrators
 *
 * @param {object} [options] Configuration options.
 * @param {boolean} [options.enabled=true] Whether the scheduler is active. When false,
 *   falls back to the legacy CesiumJS sorting behavior.
 *
 * @alias RenderScheduler
 * @constructor
 *
 * @see RenderLayer
 * @see RenderLayerCollection
 * @see SortMode
 * @see MaterialSortIdAllocator
 */
function RenderScheduler(options) {
  options = options ?? {};

  /**
   * Whether the scheduler is active. When false, Scene.js uses legacy sorting.
   * @type {boolean}
   * @default true
   */
  this.enabled = options.enabled ?? true;

  /**
   * The render layer collection managed by this scheduler.
   * @type {RenderLayerCollection}
   * @readonly
   */
  this.layers = new RenderLayerCollection();

  /**
   * Material sort ID allocator for shader batching.
   * @type {MaterialSortIdAllocator}
   * @readonly
   * @private
   */
  this._materialAllocator = new MaterialSortIdAllocator();

  /**
   * Per-frame statistics for debugging.
   * @private
   * @type {object}
   */
  this._stats = {
    commandsBinned: 0,
    layersRendered: 0,
    depthClears: 0,
    materialBatches: 0,
  };

  /**
   * Scene octree for spatial acceleration of culling and sorting.
   * Opt-in via `scene.renderScheduler.octree.enabled = true`.
   * @type {SceneOctree}
   * @readonly
   */
  this.octree = new SceneOctree();

  /**
   * Hi-Z occlusion culling manager (WebGPU only).
   * Opt-in via `scene.renderScheduler.occlusionCulling.enabled = true`.
   * @type {OcclusionCulling}
   * @readonly
   */
  this.occlusionCulling = new OcclusionCulling();
}

Object.defineProperties(RenderScheduler.prototype, {
  /**
   * Per-frame rendering statistics. Useful for performance profiling.
   * @memberof RenderScheduler.prototype
   * @type {object}
   * @readonly
   */
  stats: {
    get: function () {
      return this._stats;
    },
  },

  /**
   * The material sort ID allocator.
   * @memberof RenderScheduler.prototype
   * @type {MaterialSortIdAllocator}
   * @readonly
   */
  materialAllocator: {
    get: function () {
      return this._materialAllocator;
    },
  },
});

// ====================================================================
// MULTI-LEVEL SORT COMPARATORS
// These are the heart of the system. Each comparator implements a
// multi-level sort that evaluates fields in priority order:
//   Layer → Priority → Material → Distance
// ====================================================================

/**
 * Multi-level opaque sort: sortKey → materialSortId → distance (front-to-back).
 * Used when SortMode is MATERIAL_MESH.
 *
 * Sort order rationale for opaque geometry:
 * 1. sortKey (legacy) — backward compat, overrides everything
 * 2. sortPriority — user-controlled explicit ordering
 * 3. materialSortId — groups same shader together (minimize state changes)
 * 4. distance front-to-back — early-Z rejection within same material
 *
 * @private
 */
function opaqueMaterialMeshSort(a, b, position) {
  // Level 1: Legacy sortKey (backward compat — if non-zero, it overrides)
  const sortKeyA = a.sortKey ?? 0;
  const sortKeyB = b.sortKey ?? 0;
  if (sortKeyA !== sortKeyB) {
    return sortKeyA - sortKeyB;
  }

  // Level 2: User priority (lower renders first)
  const priorityA = a.sortPriority ?? 0;
  const priorityB = b.sortPriority ?? 0;
  if (priorityA !== priorityB) {
    return priorityA - priorityB;
  }

  // Level 3: Material batching (group same shader/pipeline)
  const matA = a.materialSortId ?? 0;
  const matB = b.materialSortId ?? 0;
  if (matA !== matB) {
    return matA - matB;
  }

  // Level 4: Distance front-to-back (early-Z benefit)
  return (
    a.boundingVolume.distanceSquaredTo(position) -
    b.boundingVolume.distanceSquaredTo(position)
  );
}

/**
 * Multi-level opaque sort: sortKey → distance (front-to-back).
 * Used when SortMode is FRONT_TO_BACK (no material batching).
 * @private
 */
function opaqueFrontToBackSort(a, b, position) {
  const sortKeyA = a.sortKey ?? 0;
  const sortKeyB = b.sortKey ?? 0;
  if (sortKeyA !== sortKeyB) {
    return sortKeyA - sortKeyB;
  }

  const priorityA = a.sortPriority ?? 0;
  const priorityB = b.sortPriority ?? 0;
  if (priorityA !== priorityB) {
    return priorityA - priorityB;
  }

  return (
    a.boundingVolume.distanceSquaredTo(position) -
    b.boundingVolume.distanceSquaredTo(position)
  );
}

/**
 * Multi-level transparent sort: sortKey → priority → distance (back-to-front).
 * NO material batching — correct blending order is more important than state changes.
 * @private
 */
function transparentBackToFrontSort(a, b, position) {
  const sortKeyA = a.sortKey ?? 0;
  const sortKeyB = b.sortKey ?? 0;
  if (sortKeyA !== sortKeyB) {
    return sortKeyA - sortKeyB;
  }

  const priorityA = a.sortPriority ?? 0;
  const priorityB = b.sortPriority ?? 0;
  if (priorityA !== priorityB) {
    return priorityA - priorityB;
  }

  // Back-to-front: farther objects render first
  return (
    b.boundingVolume.distanceSquaredTo(position) -
    a.boundingVolume.distanceSquaredTo(position)
  );
}

/**
 * Manual sort: sortKey → priority only. No distance component.
 * Used for UI, labels, annotations where explicit order matters.
 * @private
 */
function manualSort(a, b) {
  const sortKeyA = a.sortKey ?? 0;
  const sortKeyB = b.sortKey ?? 0;
  if (sortKeyA !== sortKeyB) {
    return sortKeyA - sortKeyB;
  }

  return (a.sortPriority ?? 0) - (b.sortPriority ?? 0);
}

/**
 * Returns the appropriate comparator function for a given sort mode.
 * @private
 * @param {SortMode} mode The sort mode.
 * @param {RenderLayer} layer The layer (for custom sort callbacks).
 * @param {boolean} isTransparent Whether this is for transparent commands.
 * @returns {Function|undefined} The comparator, or undefined for NONE.
 */
function getComparator(mode, layer, isTransparent) {
  switch (mode) {
    case SortMode.NONE:
      return undefined;
    case SortMode.MANUAL:
      return manualSort;
    case SortMode.MATERIAL_MESH:
      return isTransparent
        ? transparentBackToFrontSort
        : opaqueMaterialMeshSort;
    case SortMode.FRONT_TO_BACK:
      return opaqueFrontToBackSort;
    case SortMode.BACK_TO_FRONT:
      return transparentBackToFrontSort;
    case SortMode.CUSTOM:
      return isTransparent
        ? layer.customTransparentSort
        : layer.customOpaqueSort;
    default:
      return isTransparent
        ? transparentBackToFrontSort
        : opaqueMaterialMeshSort;
  }
}

// ====================================================================
// PER-FRAME OPERATIONS
// ====================================================================

/**
 * Prepares the scheduler for a new frame. Resets all layer command buckets
 * and per-frame statistics. Called at the start of Scene.render().
 */
RenderScheduler.prototype.beginFrame = function () {
  this.layers.resetAllBuckets();
  this._stats.commandsBinned = 0;
  this._stats.layersRendered = 0;
  this._stats.depthClears = 0;
  this._stats.materialBatches = 0;
};

/**
 * Bins a single command into the appropriate render layer.
 * Auto-populates materialSortId if not set. Handles pass-to-layer mapping
 * for commands that haven't been assigned a sortLayer.
 *
 * @param {object} command A DrawCommand or WebGPUDrawCommand.
 * @param {boolean} isTranslucent Whether the command is translucent.
 */
RenderScheduler.prototype.binCommand = function (command, isTranslucent) {
  // Auto-populate materialSortId from shader program
  this._materialAllocator.ensureMaterialSortId(command);

  // Resolve which layer this command belongs to
  const layerOrder = command.sortLayer ?? 50;
  let layer = this.layers.getByOrder(layerOrder);

  // Fallback: if no matching layer, use Pass-to-layer mapping
  if (!defined(layer)) {
    const mappedOrder = RenderLayerCollection.passToLayerOrder(
      command._pass ?? command.pass ?? 8,
    );
    layer = this.layers.getByOrder(mappedOrder);
  }

  // Final fallback: World layer
  if (!defined(layer)) {
    layer = this.layers.getByName("World");
  }

  if (defined(layer) && layer.enabled) {
    layer.pushCommand(command, isTranslucent, command.isTransmissive);
  }

  this._stats.commandsBinned++;
};

/**
 * Sorts all commands within each layer according to the layer's configured
 * sort mode. Call this after all commands have been binned.
 *
 * @param {object} cameraPosition The camera position in world coordinates
 *   (Cartesian3). Used for distance-based sorting.
 */
RenderScheduler.prototype.sortAllLayers = function (cameraPosition) {
  this.layers._ensureSorted();

  const layers = this.layers._layers;
  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i];
    if (!layer.enabled) {
      continue;
    }

    sortLayerBucket(
      layer,
      layer._opaqueCommands,
      layer._opaqueCount,
      layer.opaqueSortMode,
      false,
      cameraPosition,
    );

    sortLayerBucket(
      layer,
      layer._transmissiveCommands,
      layer._transmissiveCount,
      layer.transmissiveSortMode,
      true,
      cameraPosition,
    );

    sortLayerBucket(
      layer,
      layer._transparentCommands,
      layer._transparentCount,
      layer.transparentSortMode,
      true,
      cameraPosition,
    );
  }
};

/**
 * Sorts a single bucket (opaque, transparent, or transmissive) within a layer.
 * @private
 */
function sortLayerBucket(
  layer,
  commands,
  count,
  sortMode,
  isTransparent,
  cameraPosition,
) {
  if (count <= 1) {
    return;
  }

  const comparator = getComparator(sortMode, layer, isTransparent);
  if (!defined(comparator)) {
    return; // SortMode.NONE
  }

  // mergeSort is stable (preserves insertion order for equal elements).
  // We sort only the active portion [0, count).
  // Create a view of just the active commands.
  if (count < commands.length) {
    // Temporarily truncate for sort, then restore
    const savedLength = commands.length;
    commands.length = count;
    mergeSort(commands, comparator, cameraPosition);
    commands.length = savedLength;
  } else {
    mergeSort(commands, comparator, cameraPosition);
  }
}

// ====================================================================
// LAYER ITERATION (for Scene.js integration)
// ====================================================================

/**
 * Returns the sorted array of enabled layers. Each layer contains its
 * sorted command buckets (opaque, transmissive, transparent).
 *
 * Scene.js iterates these layers and for each:
 * 1. Optionally clears depth/stencil if layer.clearDepth/clearStencil
 * 2. Executes opaque commands
 * 3. Executes transmissive commands
 * 4. Executes transparent commands
 *
 * @returns {RenderLayer[]} The sorted array of enabled layers.
 */
RenderScheduler.prototype.getEnabledLayers = function () {
  this.layers._ensureSorted();
  return this.layers._layers;
};

// ====================================================================
// PREDICTIVE SORT QUERIES
// ====================================================================

/**
 * Predicts the sort position of a hypothetical command without actually
 * adding it. Returns a human-readable description of where the command
 * would render in the current frame's sort order.
 *
 * @param {object} options Query options.
 * @param {number} [options.sortLayer=50] The render layer order value.
 * @param {number} [options.sortPriority=0] The sort priority.
 * @param {number} [options.materialSortId=0] The material sort ID.
 * @param {boolean} [options.isTranslucent=false] Whether the command is translucent.
 * @param {boolean} [options.isTransmissive=false] Whether the command is transmissive.
 * @returns {object} Prediction result with layer name, bucket, and relative position.
 */
RenderScheduler.prototype.predictSortPosition = function (options) {
  options = options ?? {};
  const layerOrder = options.sortLayer ?? 50;
  const layer = this.layers.getByOrder(layerOrder);
  const layerName = defined(layer) ? layer.name : "Unknown";

  let bucket = "opaque";
  let sortMode;
  if (options.isTransmissive) {
    bucket = "transmissive";
    sortMode = defined(layer)
      ? layer.transmissiveSortMode
      : SortMode.BACK_TO_FRONT;
  } else if (options.isTranslucent) {
    bucket = "transparent";
    sortMode = defined(layer)
      ? layer.transparentSortMode
      : SortMode.BACK_TO_FRONT;
  } else {
    sortMode = defined(layer) ? layer.opaqueSortMode : SortMode.MATERIAL_MESH;
  }

  return {
    layerName: layerName,
    layerOrder: layerOrder,
    bucket: bucket,
    sortMode: sortMode,
    sortModeName: getSortModeName(sortMode),
    sortPriority: options.sortPriority ?? 0,
    materialSortId: options.materialSortId ?? 0,
    clearDepthBefore: defined(layer) ? layer.clearDepth : false,
    summary:
      `Layer "${layerName}" (${layerOrder}), ${bucket} bucket, ` +
      `${getSortModeName(sortMode)} sort, priority=${options.sortPriority ?? 0}`,
  };
};

/**
 * Explains why entity A renders before/after entity B. Produces a
 * human-readable diagnostic string.
 *
 * @param {object} commandA A DrawCommand or WebGPUDrawCommand.
 * @param {object} commandB A DrawCommand or WebGPUDrawCommand.
 * @param {object} cameraPosition The camera position for distance calculation.
 * @returns {string} A multi-line explanation.
 */
RenderScheduler.prototype.explainRenderOrder = function (
  commandA,
  commandB,
  cameraPosition,
) {
  const lines = [];

  const layerA = commandA.sortLayer ?? 50;
  const layerB = commandB.sortLayer ?? 50;
  const nameA = this.layers.getByOrder(layerA);
  const nameB = this.layers.getByOrder(layerB);

  lines.push(
    `Command A: layer=${defined(nameA) ? nameA.name : layerA}(${layerA}), ` +
      `priority=${commandA.sortPriority ?? 0}, material=${commandA.materialSortId ?? 0}`,
  );
  lines.push(
    `Command B: layer=${defined(nameB) ? nameB.name : layerB}(${layerB}), ` +
      `priority=${commandB.sortPriority ?? 0}, material=${commandB.materialSortId ?? 0}`,
  );

  if (layerA !== layerB) {
    const first = layerA < layerB ? "A" : "B";
    lines.push(
      `Result: ${first} renders FIRST (behind) because it is in a lower layer.`,
    );
    const higherLayer = layerA > layerB ? nameA : nameB;
    if (defined(higherLayer) && higherLayer.clearDepth) {
      const second = first === "A" ? "B" : "A";
      lines.push(
        `  Note: ${second}'s layer has clearDepth=true, so it renders ON TOP regardless of depth.`,
      );
    }
    return lines.join("\n");
  }

  const priA = commandA.sortPriority ?? 0;
  const priB = commandB.sortPriority ?? 0;
  if (priA !== priB) {
    const first = priA < priB ? "A" : "B";
    lines.push(
      `Result: ${first} renders FIRST because it has lower sortPriority (${Math.min(priA, priB)} < ${Math.max(priA, priB)}).`,
    );
    return lines.join("\n");
  }

  const matA = commandA.materialSortId ?? 0;
  const matB = commandB.materialSortId ?? 0;
  if (matA !== matB) {
    lines.push(
      `Result: Sorted by material ID (${matA} vs ${matB}) for shader batching.`,
    );
    return lines.join("\n");
  }

  if (
    defined(cameraPosition) &&
    defined(commandA.boundingVolume) &&
    defined(commandB.boundingVolume)
  ) {
    const distA = commandA.boundingVolume.distanceSquaredTo(cameraPosition);
    const distB = commandB.boundingVolume.distanceSquaredTo(cameraPosition);
    const closerLabel = distA < distB ? "A" : "B";
    lines.push(
      `Result: Same layer, priority, and material. Sorted by distance. ` +
        `${closerLabel} is closer (${Math.sqrt(Math.min(distA, distB)).toFixed(1)}m vs ${Math.sqrt(Math.max(distA, distB)).toFixed(1)}m).`,
    );
  } else {
    lines.push(
      "Result: Same layer, priority, and material. Distance comparison unavailable.",
    );
  }

  return lines.join("\n");
};

// ====================================================================
// DIAGNOSTICS
// ====================================================================

/**
 * Returns a diagnostic summary of the current frame's sort state.
 * @returns {string} Multi-line diagnostic string.
 */
RenderScheduler.prototype.getDiagnostics = function () {
  const lines = [
    `=== RenderScheduler (${this.enabled ? "ENABLED" : "DISABLED"}) ===`,
    `Commands binned: ${this._stats.commandsBinned}`,
    `Materials tracked: ${this._materialAllocator.count}`,
    "",
    this.layers.getDiagnostics(),
  ];
  return lines.join("\n");
};

/**
 * Returns a summary of how an entity would sort, using the entity's
 * renderPriority if available. This is a convenience wrapper around
 * predictSortPosition for Entity API users.
 *
 * @param {object} entity An Entity with a renderPriority property.
 * @param {object} [options] Additional options.
 * @param {boolean} [options.isTranslucent=false] Whether the entity renders translucent.
 * @returns {object} Prediction result.
 */
RenderScheduler.prototype.predictEntitySortPosition = function (
  entity,
  options,
) {
  options = options ?? {};
  const renderPriority =
    defined(entity) && defined(entity._renderPriority)
      ? entity._renderPriority
      : 0;

  return this.predictSortPosition({
    sortLayer: options.sortLayer ?? 50,
    sortPriority: renderPriority,
    materialSortId: options.materialSortId ?? 0,
    isTranslucent: options.isTranslucent ?? false,
    isTransmissive: options.isTransmissive ?? false,
  });
};

/**
 * Returns an explanation of the complete sort order decision tree.
 * This is documentation the integrator can read to understand
 * how the sort system works.
 * @returns {string} Multi-line explanation.
 */
RenderScheduler.prototype.getSortOrderDocumentation = function () {
  return [
    "=== CesiumJS Sort Order Decision Tree ===",
    "",
    "When two objects overlap, which renders on top?",
    "",
    "1. Different render layers?",
    "   → Higher layer number renders on top (later)",
    "   → If the higher layer has clearDepth: true,",
    "     it ALWAYS renders on top regardless of depth",
    "",
    "2. Same layer, different renderPriority/sortPriority?",
    "   → Higher renderPriority renders on top",
    "",
    "3. Same layer, same priority, both opaque?",
    "   → Sorted by material (shader batching), then distance",
    "   → Closer objects render first (early-Z optimization)",
    "",
    "4. Same layer, same priority, both translucent?",
    "   → Farther objects render first, closer renders on top",
    "   → This is for correct alpha blending",
    "",
    "5. One opaque, one translucent?",
    "   → Opaque renders before translucent",
    "   → Translucent object appears on top",
    "",
    "6. Using OIT (Order-Independent Transparency)?",
    "   → Translucent objects don't need correct draw order",
    "",
    "=== API Quick Reference ===",
    "entity.renderPriority = 100;  // Higher = on top",
    "primitive.renderPriority = 50;",
    "primitive.renderLayer = 70;  // Annotations layer",
    "collection.renderPriority = 25;",
    "scene.renderScheduler.explainRenderOrder(cmdA, cmdB, camPos);",
  ].join("\n");
};

/**
 * Returns a sort mode's human-readable name.
 * @private
 */
function getSortModeName(mode) {
  switch (mode) {
    case SortMode.NONE:
      return "NONE";
    case SortMode.MANUAL:
      return "MANUAL";
    case SortMode.MATERIAL_MESH:
      return "MATERIAL_MESH";
    case SortMode.FRONT_TO_BACK:
      return "FRONT_TO_BACK";
    case SortMode.BACK_TO_FRONT:
      return "BACK_TO_FRONT";
    case SortMode.CUSTOM:
      return "CUSTOM";
    default:
      return "UNKNOWN";
  }
}

export default RenderScheduler;
